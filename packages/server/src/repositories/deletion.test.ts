import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { CredentialCipher } from "./credentials.js";
import { CollaborationService } from "../collaboration/service.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../http.js";
import { withTeam } from "../db/tenant.js";
import { fixtureRepository } from "../auth/test-support.js";
import { ManagedRuleScenario } from "../rules/managed/test-support.js";
import { cleanupRepositoryWorkspaces, type RepositoryDeletionPreview } from "./deletion.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "仓库删除测试清理失败");
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ureview-deletion-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const worktreeDir = join(directory, "worktrees");
  await mkdir(worktreeDir);
  const app = new ManagedRuleScenario();
  cleanups.push(() => app.stop());
  await app.start({ worktreeDir });
  await app.app!.close();
  app.app = buildApp({ pool: app.pool, repositories: app.repositories, auth: app.identity.auth, reviews: app.reviews,
    worktreeDir, managedRules: app.managed, collaboration: new CollaborationService(app.pool, { cipher: new CredentialCipher(randomBytes(32)) }), publicOrigin: "http://identity.example.test", webhookToken: "fixture-webhook" });
  app.baseUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });
  const route = `/api/repositories/${app.repositoryId}`;
  return { app, directory, worktreeDir, route,
    preview: () => app.request<{ preview: RepositoryDeletionPreview }>(`${route}/deletion-preview`),
    remove: (pathWithNamespace = fixtureRepository.projectPath) => app.request<{ deleted: boolean; preview: RepositoryDeletionPreview }>(
      route, { pathWithNamespace }, { method: "DELETE" }) };
}

const removedTables = ["reviews", "review_findings", "finding_disposition_events", "discussion_comments", "discussion_notifications",
  "notification_deliveries", "review_participants", "agent_sessions", "agent_session_events", "review_deliveries", "repository_webhook_events",
  "repository_review_settings", "rule_catalog", "rule_sync_state", "rule_candidates", "managed_rule_waivers", "managed_rule_repositories",
  "rule_proposals", "rule_proposal_feedback"];

async function seed(app: ManagedRuleScenario, repositoryId: string) {
  const review = randomUUID(), finding = randomUUID(), comment = randomUUID(), session = randomUUID(), rule = randomUUID();
  const candidate = randomUUID(), proposal = randomUUID(), ruleSession = randomUUID();
  await withTeam(app.teamId, async () => {
    await app.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,requirement_sources)
      VALUES($1::uuid,$2,$1::text,7,'head','金额计算','li-na',1,'completed','[{"kind":"commit","title":"校验金额"}]')`, [review, repositoryId]);
    await app.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,'{}')", [finding, review]);
    await app.pool.query(`INSERT INTO finding_disposition_events(id,review_id,finding_id,actor_id,actor_name,previous_status,status,version)
      VALUES($1,$2,$3,$4,'张伟','Pending','Resolved',1)`, [randomUUID(), review, finding, app.userId]);
    await app.pool.query(`INSERT INTO discussion_comments(id,review_id,finding_id,author_id,request_id,body)
      VALUES($1,$2,$3,$4,$5,'请核对边界')`, [comment, review, finding, app.userId, randomUUID()]);
    await app.pool.query(`INSERT INTO discussion_comments(id,review_id,finding_id,author_id,request_id,parent_id,body)
      VALUES($1,$2,$3,$4,$5,$6,'已补充说明')`, [randomUUID(), review, finding, app.userId, randomUUID(), comment]);
    await app.pool.query("INSERT INTO discussion_notifications(id,comment_id,recipient_id,kind) VALUES($1,$2,$3,'reply')", [randomUUID(), comment, app.userId]);
    await app.pool.query("INSERT INTO notification_deliveries(id,comment_id,payload) VALUES($1,$2,'{}')", [randomUUID(), comment]);
    await app.pool.query("INSERT INTO notification_deliveries(id,review_id,payload) VALUES($1,$2,'{}')", [randomUUID(), review]);
    await app.pool.query("INSERT INTO review_participants(review_id,user_id) VALUES($1,$2)", [review, app.userId]);
    await app.pool.query(`INSERT INTO agent_sessions(id,dsh_session_id,kind,review_id,model,provider,status,completed_at)
      VALUES($1::uuid,$1::text,'review_generator',$2,'fixture','fixture','completed',now())`, [session, review]);
    await app.pool.query("INSERT INTO agent_session_events(session_id,seq,event) VALUES($1,0,'{}')", [session]);
    await app.pool.query("INSERT INTO review_deliveries(repository_id,event_id,trigger,iid,review_id) VALUES($1,$2::text,'automatic',7,$2::uuid)", [repositoryId, review]);
    await app.pool.query(`INSERT INTO repository_webhook_events(repository_id,received_at,event_type,result,review_id)
      VALUES($1,now(),'Merge Request Hook','queued',$2)`, [repositoryId, review]);
    await app.pool.query("INSERT INTO repository_review_settings(repository_id) VALUES($1)", [repositoryId]);
    await app.pool.query(`INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,'rule:amount','{}'),($1,'lint:amount','{"kind":"lint"}')`, [repositoryId]);
    await app.pool.query("INSERT INTO rule_sync_state(repository_id) VALUES($1)", [repositoryId]);
    await app.pool.query("INSERT INTO rule_candidates(id,repository_id,candidate_key,payload) VALUES($1,$2,'amount','{}')", [candidate, repositoryId]);
    await app.pool.query(`INSERT INTO managed_rules(id,name,body,good_example,bad_example,category,severity,scope,status,created_by,updated_by)
      VALUES($1,'金额使用整数分','金额使用整数分','','','correctness','error','repositories','active',$2,$2)`, [rule, app.userId]);
    await app.pool.query("INSERT INTO managed_rule_repositories(rule_id,repository_id,paths) VALUES($1,$2,'[]')", [rule, repositoryId]);
    await app.pool.query("INSERT INTO managed_rule_waivers(id,rule_id,repository_id,reason,created_by) VALUES($1,$2,$3,'仓库另有约定',$4)", [randomUUID(), rule, repositoryId, app.userId]);
    await app.pool.query(`INSERT INTO managed_rule_sessions(id,title,rule_id,rule_version,created_by,updated_by)
      VALUES($1,'金额规范',$2,1,$3,$3)`, [ruleSession, rule, app.userId]);
    await app.pool.query(`INSERT INTO rule_proposals(id,source,candidate_id,repository_id,name,body)
      VALUES($1,'mining',$2,$3,'金额规范','金额使用整数分')`, [proposal, candidate, repositoryId]);
    await app.pool.query(`INSERT INTO rule_proposal_feedback(proposal_id,finding_id,review_id,disposition_version,title)
      VALUES($1,$2,$3,1,'金额检查')`, [proposal, finding, review]);
  });
  return { review, finding, session, rule, ruleSession, proposal };
}

async function tableCounts(app: ManagedRuleScenario) {
  return withTeam(app.teamId, async () => {
    const counts: Record<string, number> = {};
    for (const table of removedTables) counts[table] = (await app.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count;
    return counts;
  });
}

async function connection(app: ManagedRuleScenario) {
  const client = new pg.Client({ connectionString: app.pool.options.connectionString, statement_timeout: 5000 });
  await client.connect();
  cleanups.push(() => client.end());
  await client.query("SELECT set_config('app.team_id',$1,false)", [app.teamId]);
  return client;
}

async function waitForQuery(client: pg.Client, pattern: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await client.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND state='active' AND wait_event_type='Lock' AND query LIKE $1`, [pattern]);
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("并发操作没有进入预期的数据库等待状态");
}

describe("仓库删除", () => {
  it("显式清除所有关联表，保留其他仓库、规范与会话，并记录真实数量", async () => {
    const { app, remove, preview, worktreeDir, directory } = await fixture();
    const target = await seed(app, app.repositoryId);
    const second = await app.request<{ repository: { id: string } }>("/api/repositories", { ...fixtureRepository, projectPath: "commerce/payment-service" });
    const other = await seed(app, second.body.repository.id);
    const counts = await tableCounts(app);
    const snapshot = (await preview()).body.preview;
    expect(snapshot).toMatchObject({ runningReviews: 0, counts: { reviews: 1, findings: 1, discussionComments: 2,
      agentSessions: 1, webhookEvents: 1, repositoryRules: 2, historicalCandidates: 1, managedRules: 1 } });
    const external = join(directory, "external");
    await mkdir(external); await writeFile(join(external, "keep.txt"), "保留");
    await symlink(external, join(worktreeDir, target.review));
    await mkdir(join(worktreeDir, other.review)); await writeFile(join(worktreeDir, other.review, "keep.txt"), "保留");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await remove()).toMatchObject({ status: 200, body: { deleted: true, preview: snapshot } });
    const remaining = await tableCounts(app);
    for (const table of removedTables) expect(remaining[table], table).toBe(counts[table]! / 2);
    await withTeam(app.teamId, async () => {
      expect((await app.pool.query("SELECT id FROM repositories")).rows).toEqual([{ id: second.body.repository.id }]);
      expect((await app.pool.query("SELECT id,version,scope FROM managed_rules WHERE id=$1", [target.rule])).rows)
        .toEqual([{ id: target.rule, version: 2, scope: "repositories" }]);
      expect((await app.pool.query("SELECT id,version FROM managed_rules WHERE id=$1", [other.rule])).rows).toEqual([{ id: other.rule, version: 1 }]);
      expect((await app.pool.query("SELECT id FROM managed_rule_sessions WHERE id=$1", [target.ruleSession])).rows).toEqual([{ id: target.ruleSession }]);
    });
    expect(await readdir(worktreeDir)).toEqual([other.review]);
    expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("保留");
    expect(await readFile(join(worktreeDir, other.review, "keep.txt"), "utf8")).toBe("保留");
    const records = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toContainEqual(expect.objectContaining({ event: "repository.deleted", actorId: app.userId,
      repositoryId: app.repositoryId, pathWithNamespace: fixtureRepository.projectPath, ...snapshot.counts,
      rule_proposal_feedback: 1, notification_deliveries: 2, agent_session_events: 1 }));
    expect(JSON.stringify(records)).not.toContain(fixtureRepository.token);
  });

  it("共享反馈提案保留其他仓反馈，失去全部反馈的全局提案撤回", async () => {
    const { app, remove } = await fixture();
    const target = await seed(app, app.repositoryId);
    const second = await app.request<{ repository: { id: string } }>("/api/repositories", { ...fixtureRepository, projectPath: "commerce/payments" });
    const other = await seed(app, second.body.repository.id);
    const shared = randomUUID(), orphan = randomUUID();
    await withTeam(app.teamId, async () => {
      for (const id of [shared, orphan]) {
        await app.pool.query(`INSERT INTO rule_proposals(id,source,rule_id,name,body,reason_category)
          VALUES($1::uuid,'feedback',$1::text,'金额规范','金额使用整数分','rule_incorrect')`, [id]);
        await app.pool.query(`INSERT INTO rule_proposal_feedback(proposal_id,finding_id,review_id,disposition_version,title)
          VALUES($1,$2,$3,1,'金额检查')`, [id, target.finding, target.review]);
      }
      await app.pool.query(`INSERT INTO rule_proposal_feedback(proposal_id,finding_id,review_id,disposition_version,title)
        VALUES($1,$2,$3,1,'金额检查')`, [shared, other.finding, other.review]);
    });
    expect((await remove()).status).toBe(200);
    await withTeam(app.teamId, async () => {
      expect((await app.pool.query("SELECT status FROM rule_proposals WHERE id=$1", [shared])).rows).toEqual([{ status: "pending" }]);
      expect((await app.pool.query("SELECT status FROM rule_proposals WHERE id=$1", [orphan])).rows).toEqual([{ status: "withdrawn" }]);
      expect((await app.pool.query("SELECT finding_id FROM rule_proposal_feedback WHERE proposal_id=$1", [shared])).rows).toEqual([{ finding_id: other.finding }]);
    });
  });

  it("领取与删除共用仓库锁，进行中评审拒绝删除，排队任务随删除安全消失", async () => {
    const { app, remove, preview } = await fixture();
    const target = await seed(app, app.repositoryId);
    await withTeam(app.teamId, () => app.pool.query("UPDATE reviews SET status='queued' WHERE id=$1", [target.review]));
    const locker = await withTeam(app.teamId, () => app.pool.connect());
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM repositories WHERE id=$1 FOR UPDATE", [app.repositoryId]);
      expect(await withTeam(app.teamId, () => app.reviews.store.claim())).toBeNull();
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    const job = await withTeam(app.teamId, () => app.reviews.store.claim());
    expect(job?.id).toBe(target.review);
    expect((await preview()).body.preview.runningReviews).toBe(1);
    expect(await remove()).toMatchObject({ status: 409, body: { error: { code: "repository_review_running", message: expect.stringContaining("等待评审结束") } } });
    await withTeam(app.teamId, () => app.pool.query("UPDATE reviews SET status='queued' WHERE id=$1", [target.review]));
    expect((await remove()).status).toBe(200);
    expect(await withTeam(app.teamId, () => app.reviews.store.claim())).toBeNull();
    const claim = vi.spyOn(app.reviews.store, "claim").mockResolvedValueOnce(job);
    await expect(withTeam(app.teamId, () => app.reviews.runOnce())).resolves.toBe(true);
    claim.mockRestore();
    await expect(withTeam(app.teamId, () => app.reviews.runOnce())).resolves.toBe(false);
    await expect(withTeam(app.teamId, () => app.reviews.store.enqueue(app.repositoryId, randomUUID(), {
      projectId: 41, iid: 8, headSha: "head", title: "金额校验", author: "li-na",
    }, "manual"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("规范编辑持有团队锁时删除等待，仓库锁顺序不会反转", async () => {
    const { app, remove } = await fixture();
    const target = await seed(app, app.repositoryId);
    const writer = await connection(app), observer = await connection(app);
    await writer.query("BEGIN");
    let pending: ReturnType<typeof remove> | undefined;
    try {
      await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-hierarchy:${app.teamId}`]);
      await writer.query("SELECT id FROM managed_rules WHERE id=$1 FOR UPDATE", [target.rule]);
      pending = remove();
      await waitForQuery(observer, "SELECT pg_advisory_xact_lock%");
      await writer.query("SELECT id FROM repositories WHERE id=$1 FOR KEY SHARE", [app.repositoryId]);
      await writer.query("UPDATE managed_rules SET version=version+1 WHERE id=$1", [target.rule]);
      await writer.query("COMMIT");
      expect((await pending).status).toBe(200);
      expect(await withTeam(app.teamId, () => app.pool.query("SELECT version FROM managed_rules WHERE id=$1", [target.rule])))
        .toMatchObject({ rows: [{ version: 3 }] });
    } finally {
      await writer.query("ROLLBACK");
      await pending?.catch(() => undefined);
    }
  });

  it("评论带通知入队时与删除按评审到 finding 的顺序加锁", async () => {
    const { app, remove } = await fixture();
    const target = await seed(app, app.repositoryId);
    await withTeam(app.teamId, () => app.pool.query(`INSERT INTO notification_endpoints(id,name,kind,endpoint_ciphertext)
      VALUES($1,'团队通知','webhook','test')`, [randomUUID()]));
    const blocker = await connection(app), observer = await connection(app);
    await blocker.query("BEGIN");
    let commenting: ReturnType<ManagedRuleScenario["request"]> | undefined;
    let deleting: ReturnType<typeof remove> | undefined;
    try {
      await blocker.query("SELECT id FROM review_findings WHERE id=$1 FOR UPDATE", [target.finding]);
      commenting = app.request(`/api/reviews/${target.review}/findings/${target.finding}/comments`, {
        requestId: randomUUID(), body: "请核对金额", mentions: [app.userId],
      }, { cookie: app.memberCookie });
      await waitForQuery(observer, "INSERT INTO discussion_comments%");
      deleting = remove();
      await waitForQuery(observer, "SELECT id,status FROM reviews%FOR UPDATE");
      await blocker.query("COMMIT");
      expect((await commenting).status).toBe(201);
      expect((await deleting).status).toBe(200);
      expect(await withTeam(app.teamId, () => app.pool.query("SELECT id FROM notification_deliveries"))).toMatchObject({ rows: [] });
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled([commenting, deleting]);
    }
  });

  it("路径必须逐字一致，成员和其他团队不能预览或删除", async () => {
    const { app, route, remove } = await fixture();
    for (const path of [fixtureRepository.projectPath.toUpperCase(), `${fixtureRepository.projectPath} `]) {
      expect(await remove(path)).toMatchObject({ status: 400, body: { error: { code: "repository_path_mismatch" } } });
    }
    const other = await app.otherTeam();
    for (const [cookie, status] of [[app.memberCookie, 403], [other.cookie, 404]] as const) {
      expect((await app.request(`${route}/deletion-preview`, undefined, { cookie })).status).toBe(status);
      expect((await app.request(route, { pathWithNamespace: fixtureRepository.projectPath }, { method: "DELETE", cookie })).status).toBe(status);
    }
    expect((await app.request(route)).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect((await app.request(`/api/repositories/${other.repositoryId}`, undefined, { cookie: other.cookie })).status).toBe(200);
  });

  it("事务失败保留全部数据与工作副本，清理失败只记录日志", async () => {
    const { app, remove, preview, worktreeDir } = await fixture();
    const target = await seed(app, app.repositoryId);
    await mkdir(join(worktreeDir, target.review));
    const before = await tableCounts(app);
    await app.pool.query(`CREATE FUNCTION reject_repository_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '测试删除失败'; END $$`);
    await app.pool.query("CREATE TRIGGER reject_repository_delete BEFORE DELETE ON repositories FOR EACH ROW EXECUTE FUNCTION reject_repository_delete()");
    expect((await remove()).status).toBe(500);
    expect(await tableCounts(app)).toEqual(before);
    expect((await preview()).body.preview.counts.reviews).toBe(1);
    expect(await readdir(worktreeDir)).toEqual([target.review]);
    await app.pool.query("DROP TRIGGER reject_repository_delete ON repositories");
    await rm(worktreeDir, { recursive: true });
    await writeFile(worktreeDir, "工作副本根路径不可用");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await remove()).status).toBe(200);
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({
      event: "repository.workspace_cleanup_failed", repositoryId: app.repositoryId, reviewId: target.review,
    }));
    expect((await preview()).status).toBe(404);
  });

  it("清理函数拒绝越出工作副本根目录的标识", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ureview-deletion-boundary-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, "worktrees");
    await mkdir(root); await writeFile(join(directory, "keep.txt"), "保留");
    await cleanupRepositoryWorkspaces(root, randomUUID(), ["../keep.txt", directory]);
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("保留");
  });
});
