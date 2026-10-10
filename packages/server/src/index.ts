import { loadConfig } from "./config.js";
import { startApplication } from "./application.js";
import { bootReviewHost } from "./runtime/host.js";

import { fileURLToPath } from "node:url";
import { assertTenantRole, createTenantPool, withTeam } from "./db/tenant.js";
import { runMigrations } from "./db/migrate.js";
import { loadCredentialCipher } from "./repositories/credentials.js";
import { ServiceSettings } from "./service-settings/service.js";
import { AgentSessionStore } from "./agent-sessions/store.js";

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createTenantPool(config.databaseUrl);
  try {
    await assertTenantRole(pool);
    await runMigrations(pool, fileURLToPath(new URL("../migrations/", import.meta.url)));
    let hasCredentials = Boolean((await pool.query("SELECT singleton FROM service_model_keys WHERE generator IS NOT NULL OR grader IS NOT NULL UNION ALL SELECT singleton FROM service_sso WHERE client_secret IS NOT NULL")).rowCount);
    for (const team of (await pool.query<{ id: string }>("SELECT id FROM teams")).rows) {
      hasCredentials ||= Boolean(await withTeam(team.id, async () => (await pool.query("SELECT id FROM repositories UNION ALL SELECT id FROM notification_endpoints LIMIT 1")).rowCount));
    }
    const settings = new ServiceSettings(pool, await loadCredentialCipher(config.credentialKeyFile, hasCredentials));
    const sessions = new AgentSessionStore(pool);
    for (const team of (await pool.query<{ id: string }>("SELECT id FROM teams")).rows) {
      await withTeam(team.id, async () => { await sessions.recoverInterrupted(); await sessions.importRuleHistory(); });
    }
    const models = await settings.models();
    const host = await bootReviewHost({
      homeDir: config.runtimeHome,
      ...(models ? { models } : {}),
      resolveModels: () => settings.models(),
      resolveCredential: (ref) => settings.resolve(ref),
      sessionRecorder: sessions,
      onReady: (runtime, ruleGenerator, importGenerator) => startApplication(config, runtime, ruleGenerator, settings, importGenerator),
    });
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        void host.dispose().then(() => pool.end()).then(() => process.exit(0), () => process.exit(1));
      });
    }
  } catch (error) { await pool.end(); throw error; }
}

start().catch(() => {
  console.error("启动失败，请检查数据库、模型配置与持久化目录");
  process.exitCode = 1;
});
