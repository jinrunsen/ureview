import type { ImportGenerator } from "./runtime/import-generator.js";
import { SsoConfiguration } from "./auth/sso-config.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { assertTenantRole, createTenantPool, withTeam } from "./db/tenant.js";
import { AuthService } from "./auth/service.js";
import { startTeamWorker } from "./auth/team-worker.js";
import { buildApp } from "./http.js";
import { GitLabPlatform } from "./platform/gitlab.js";
import { loadCredentialCipher } from "./repositories/credentials.js";
import { GitLabConnector } from "./repositories/gitlab.js";
import { RepositoryService } from "./repositories/service.js";
import { JobSlots, ReviewService } from "./reviews/service.js";
import { ReviewStore } from "./reviews/store.js";
import { ReadingDocumentStore } from "./reviews/reading-document-store.js";
import type { ReviewRuntime } from "./reviews/types.js";
import { CollaborationService } from "./collaboration/service.js";
import { RuleCatalogService } from "./rules/catalog.js";
import { ManagedRuleService } from "./rules/managed.js";
import type { RuleDraftGenerator } from "./runtime/rule-generator.js";
import { ReviewSettingsService } from "./reviews/settings.js";

import type { ServiceSettings } from "./service-settings/service.js";

export async function startApplication(config: Config, runtime: ReviewRuntime, ruleGenerator?: RuleDraftGenerator, serviceSettings?: ServiceSettings, importGenerator?: ImportGenerator): Promise<() => Promise<void>> {
  // 并发任务各自读写会话记录，连接池随并发上限放大。
  const pool = createTenantPool(config.databaseUrl, 10 + 2 * config.reviewConcurrency);
  let app: ReturnType<typeof buildApp> | undefined;
  let reviews: ReviewService | undefined;
  let stopWorker: (() => Promise<void>) | undefined;
  let stopCatalog: (() => Promise<void>) | undefined;
  let collaboration: CollaborationService | undefined;
  const teamReviews = new Map<string, ReviewService>();
  try {
    await mkdir(config.worktreeDir, { recursive: true });
    await mkdir(config.blobDir, { recursive: true });
    await assertTenantRole(pool);
    await runMigrations(pool, fileURLToPath(new URL("../migrations/", import.meta.url)));
    const auth = await AuthService.create(pool, join(config.blobDir, "setup-token"));
    let hasEncryptedData = Boolean((await pool.query("SELECT singleton FROM service_sso WHERE client_secret IS NOT NULL")).rowCount);
    for (const teamId of await auth.allTeamIds()) {
      const { rows } = await withTeam(teamId, () => pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT id FROM repositories UNION ALL SELECT id FROM notification_endpoints)"));
      hasEncryptedData ||= rows[0]?.exists ?? false;
    }
    const cipher = await loadCredentialCipher(config.credentialKeyFile, hasEncryptedData);
    const repositories = new RepositoryService(pool, new GitLabConnector(), cipher);
    const managedRules = new ManagedRuleService(pool);
    const reviewSettings = new ReviewSettingsService(pool);
    for (const teamId of await auth.allTeamIds()) await withTeam(teamId, () => repositories.assertCredentialsReadable());
    const slots = new JobSlots(config.reviewConcurrency);
    const documents = new ReadingDocumentStore(pool);
    reviews = new ReviewService(new ReviewStore(pool), repositories, (repo) => new GitLabPlatform(repo), runtime, config.worktreeDir,
      { excludedDirectories: async (repositoryId) => (await reviewSettings.get(repositoryId)).excludedDirectories });
    const catalog = new RuleCatalogService(pool, repositories);
    collaboration = new CollaborationService(pool, { history: catalog.history, cipher, publicOrigin: config.publicOrigin });
    await collaboration.migrateLegacySettings();
    app = buildApp({
      ...(serviceSettings ? { serviceSettings } : {}),
      ssoConfiguration: new SsoConfiguration(pool, cipher, config.publicOrigin),
      pool, repositories, reviews, auth, collaboration, catalog, managedRules, worktreeDir: config.worktreeDir, publicOrigin: config.publicOrigin,
      readingDocuments: documents, startImportWorker: true,
      ...(importGenerator ? { importGenerator } : {}),
      ...(ruleGenerator ? { ruleGenerator: ruleGenerator.generate.bind(ruleGenerator), ruleConversationGenerator: ruleGenerator } : {}),
      ...(config.webhookToken ? { webhookToken: config.webhookToken } : {}),
      webDir: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
      sessionViewerDir: fileURLToPath(new URL("../../session-viewer/dist/", import.meta.url)),
    });
    await app.listen({ host: "0.0.0.0", port: config.port });
    collaboration.start();
    stopCatalog = startTeamWorker(() => auth.allTeamIds(), () => catalog.syncDue(), 60_000);
    stopWorker = startTeamWorker(() => auth.allTeamIds(), async (teamId) => {
      let worker = teamReviews.get(teamId);
      if (!worker) {
        worker = new ReviewService(new ReviewStore(pool), repositories, (repo) => new GitLabPlatform(repo), runtime, config.worktreeDir,
          { managedRules: () => managedRules.list(), slots, documents,
            excludedDirectories: async (repositoryId) => (await reviewSettings.get(repositoryId)).excludedDirectories });
        teamReviews.set(teamId, worker);
      }
      await worker.dispatch();
    });
    if (await auth.setupRequired()) console.log(`首次登录请使用 ${join(config.blobDir, "setup-token")} 中的管理员初始化码`);
    console.log(`uReview 已启动，监听 ${config.port}`);
  } catch (error) {
    await stopCatalog?.();
    await collaboration?.stop();
    await stopWorker?.();
    await app?.close();
    await reviews?.stop();
    await pool.end();
    throw error;
  }
  const runningApp = app;
  const runningReviews = reviews;
  return async () => {
    await runningApp.close();
    await stopCatalog?.();
    await collaboration?.stop();
    await stopWorker?.();
    await runningReviews.stop();
    for (const worker of teamReviews.values()) await worker.stop();
    await pool.end();
  };
}
