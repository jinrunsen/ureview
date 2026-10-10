import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../http.js";
import { withTeam } from "../db/tenant.js";
import { GitLabPlatform } from "../platform/gitlab.js";
import { ManagedRuleScenario } from "../rules/managed/test-support.js";
import type { RepositorySummary } from "./service.js";
import type { RepositoryWebhookService, WebhookCheck } from "./webhooks.js";

const token = "repository-detail-webhook-fixture";
const headSha = "a".repeat(40);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "仓库详情测试资源清理失败");
});
type Events = Awaited<ReturnType<RepositoryWebhookService["list"]>>;
type Repository = { repository: RepositorySummary };

async function fixture(options: { tokenConfigured?: boolean } = {}) {
  const requests: Array<{ method: string; path: string }> = [];
  const upstream = { hooks: [] as Array<{ url: string; merge_requests_events: boolean }>, status: 200 };
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "", path: url.pathname });
    if (upstream.status !== 200) { response.writeHead(upstream.status).end("PRIVATE_UPSTREAM_RESPONSE"); return; }
    response.setHeader("content-type", "application/json");
    response.setHeader("x-next-page", "");
    response.end(JSON.stringify(url.pathname.endsWith("/hooks") ? upstream.hooks : {
      iid: 7, project_id: 42, target_project_id: 42, title: "检查金额计算", description: "", author: { username: "li-na" },
      sha: headSha, source_branch: "fix-amount", target_branch: "main", web_url: `${origin}/commerce/inventory-service/-/merge_requests/7`,
      diff_refs: { head_sha: headSha, base_sha: "b".repeat(40), start_sha: "b".repeat(40) },
    }));
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试平台监听地址无效");
  origin = `http://127.0.0.1:${address.port}`;
  const app = new ManagedRuleScenario();
  cleanups.push(() => app.stop());
  await app.start({ platforms: (repository) => new GitLabPlatform(repository), connector: { verify: async (input) => ({
    instanceUrl: origin, projectId: 42, name: "inventory-service", pathWithNamespace: input.projectPath,
    webUrl: `${origin}/${input.projectPath}`, httpUrlToRepo: `${origin}/${input.projectPath}.git`,
  }) } });
  await app.app!.close();
  app.app = buildApp({ pool: app.pool, auth: app.identity.auth, repositories: app.repositories, reviews: app.reviews,
    publicOrigin: "http://identity.example.test", ...(options.tokenConfigured === false ? {} : { webhookToken: token }) });
  app.baseUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });
  const route = `/api/repositories/${app.repositoryId}`;
  const payload = (iid = 7) => ({ object_kind: "merge_request", project: { id: 42 }, user: { username: "li-na" },
    object_attributes: { action: "open", target_project_id: 42, iid, title: "检查金额计算", last_commit: { id: headSha } },
    private_payload: "PRIVATE_WEBHOOK_PAYLOAD" });
  const send = (data = payload(), headers: Record<string, string> = {}) => app.request<{ reviewId: string; created: boolean }>(
    `${route}/events/gitlab`, data, { cookie: "", headers: { "x-gitlab-token": token, "x-gitlab-event": "Merge Request Hook",
      "webhook-id": randomUUID(), ...headers } });
  const events = () => app.request<Events>(`${route}/events`);
  return { app, route, origin, upstream, requests, payload, send, events };
}

describe("仓库详情与 webhook", () => {
  it("未配置密钥时只显示配置状态，拒绝投递且不写鉴权失败或事件", async () => {
    const { send, events } = await fixture({ tokenConfigured: false });
    expect((await events()).body).toMatchObject({ webhook: { tokenConfigured: false, lastAuthenticationFailureAt: null }, events: [] });
    expect(await send()).toMatchObject({ status: 503, body: { error: { code: "webhook_unconfigured" } } });
    const result = (await events()).body;
    expect(result).toMatchObject({ webhook: { tokenConfigured: false, lastAuthenticationFailureAt: null }, events: [] });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("自动评审默认开启，按版本更新，成员与其他团队不能修改或越界读取", async () => {
    const { app, route } = await fixture();
    expect(await app.request<Repository>(route)).toMatchObject({ status: 200, body: { repository: {
      automaticReviewEnabled: true, automaticReviewVersion: 1, lastAuthenticationFailureAt: null,
    } } });
    const results = await Promise.all([false, true].map((enabled) => app.request<Repository>(`${route}/automatic-review`,
      { enabled, version: 1 }, { method: "PUT" })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    expect((await app.request<Repository>(route)).body).toEqual(winner.body);
    expect((await app.request(route, undefined, { cookie: app.memberCookie })).status).toBe(200);
    expect((await app.request(`${route}/automatic-review`, { enabled: false, version: 2 }, { method: "PUT", cookie: app.memberCookie })).status).toBe(403);
    const other = await app.otherTeam();
    for (const path of [route, `${route}/events`]) expect((await app.request(path, undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await app.request(`${route}/automatic-review`, { enabled: false, version: 2 }, { method: "PUT", cookie: other.cookie })).status).toBe(404);
    expect((await app.request(`${route}/webhook-check`, {}, { cookie: other.cookie })).status).toBe(404);
    expect((await app.request(route, undefined, { cookie: "" })).status).toBe(401);
    expect((await app.request(`${route}/automatic-review`, { enabled: false, version: 0 }, { method: "PUT" })).status).toBe(400);
  });

  it("关闭自动评审记录忽略且不入队，成员仍能手动发起与重跑", async () => {
    const { app, route, origin, send, events } = await fixture();
    expect((await app.request(`${route}/automatic-review`, { enabled: false, version: 1 }, { method: "PUT" })).status).toBe(200);
    expect(await send()).toMatchObject({ status: 202, body: { ignored: true } });
    expect((await events()).body.events).toMatchObject([{ result: "ignored", reason: "自动评审已关闭", reviewId: null, reviewRound: null }]);
    expect((await app.request<{ reviews: unknown[] }>(`${route}/reviews`)).body.reviews).toEqual([]);
    const manual = await app.request<{ id: string }>("/api/reviews", { url: `${origin}/commerce/inventory-service/-/merge_requests/7`,
      requestId: randomUUID() }, { cookie: app.memberCookie });
    expect(manual.status).toBe(202);
    expect((await app.request(`/api/reviews/${manual.body.id}/rerun`, { requestId: randomUUID() }, { cookie: app.memberCookie })).status).toBe(202);
    expect((await app.request<{ reviews: unknown[] }>(`${route}/reviews`)).body.reviews).toHaveLength(2);
  });

  it.each(["webhook-id", "idempotency-key"])("优先使用现代投递头 %s，重试保持同一投递", async (header) => {
    const { app, route, payload } = await fixture();
    const headers = { "x-gitlab-token": token, "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-event-uuid": "legacy-event-chain", [header]: "modern-delivery" };
    const send = () => app.request(`${route}/events/gitlab`, payload(), { cookie: "", headers });
    expect(await send()).toMatchObject({ status: 202 });
    expect(await send()).toMatchObject({ status: 200 });
    await withTeam(app.teamId, async () => {
      expect((await app.pool.query("SELECT event_id FROM review_deliveries WHERE repository_id=$1", [app.repositoryId])).rows)
        .toEqual([{ event_id: "modern-delivery" }]);
    });
  });

  it("旧版 GitLab 事件标识可接收并去重，同一事件链的不同 PR 仍入队", async () => {
    const { app, route, payload } = await fixture();
    const send = (data = payload()) => app.request(`${route}/events/gitlab`, data, { cookie: "", headers: {
      "x-gitlab-token": token, "x-gitlab-event": "Merge Request Hook", "x-gitlab-event-uuid": "legacy-event-chain",
    } });
    const first = await send();
    expect(first).toMatchObject({ status: 202, body: { created: true } });
    expect(await send()).toMatchObject({ status: 200, body: { created: false } });
    const changed = payload(8);
    expect(await send(changed)).toMatchObject({ status: 202, body: { created: true } });
  });

  it("记录入队、重复、忽略与处理失败，只保存字段并关联轮次", async () => {
    const { app, route, payload, send, events, upstream } = await fixture();
    const delivery = randomUUID();
    const queued = await send(payload(), { "webhook-id": delivery });
    expect(queued.status).toBe(202);
    expect((await send(payload(), { "webhook-id": delivery })).status).toBe(200);
    expect((await send(payload(), { "x-gitlab-event": "Push Hook" })).status).toBe(202);
    expect((await send(payload(), { "webhook-id": "" })).status).toBe(400);
    expect((await send({ ...payload(), project: { id: 999 } })).status).toBe(400);
    upstream.status = 500;
    const update = payload(); update.object_attributes.last_commit.id = "c".repeat(40);
    expect((await send(update)).status).toBe(502);
    const snapshot = (await events()).body;
    expect(snapshot.events.map((event) => event.result)).toEqual(["failed", "failed", "failed", "ignored", "duplicate", "queued"]);
    expect(snapshot.events.slice(-2)).toMatchObject([{ reviewId: queued.body.reviewId, reviewRound: 1 }, { reviewId: queued.body.reviewId, reviewRound: 1 }]);
    expect(snapshot.events[0]).toMatchObject({ eventType: "Merge Request Hook", action: "open", iid: 7 });
    await withTeam(app.teamId, async () => {
      const rows = (await app.pool.query("SELECT * FROM repository_webhook_events")).rows;
      expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_UPSTREAM_RESPONSE|private_payload/);
      expect(rows).toHaveLength(6);
    });
    expect(snapshot.webhook).toEqual({ url: `http://identity.example.test${route}/events/gitlab`, tokenConfigured: true, lastAuthenticationFailureAt: null });
  });

  it("鉴权成功后的无效 JSON 和超大载荷也记录失败，鉴权失败仅更新时间", async () => {
    const { app, route, events } = await fixture();
    for (const body of ["{", JSON.stringify({ content: "x".repeat(1_048_576) })]) {
      const response = await fetch(`${app.baseUrl}${route}/events/gitlab`, { method: "POST", body,
        headers: { "x-gitlab-token": token, "x-gitlab-event": "Merge Request Hook", "content-type": "application/json" } });
      expect([400, 413]).toContain(response.status);
      await response.arrayBuffer();
    }
    expect((await events()).body.events.map((event) => event.result)).toEqual(["failed", "failed"]);
    const rejected = await fetch(`${app.baseUrl}${route}/events/gitlab`, { method: "POST", body: "{",
      headers: { "x-gitlab-token": "incorrect-secret", "content-type": "application/json" } });
    expect(rejected.status).toBe(401); await rejected.arrayBuffer();
    const after = (await events()).body;
    expect(after.events).toHaveLength(2);
    expect(after.webhook.lastAuthenticationFailureAt).toEqual(expect.any(String));
    expect((await app.request<Repository>(route)).body.repository.lastAuthenticationFailureAt).toBe(after.webhook.lastAuthenticationFailureAt);
  });

  it("并发收到超过一百条事件后仅保留最近一百条，事件记录按团队隔离", async () => {
    const { app, send, payload, events } = await fixture();
    const other = await app.otherTeam();
    for (let index = 1; index <= 5; index++) expect((await send(payload(index), { "x-gitlab-event": "Push Hook" })).status).toBe(202);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => send(payload(index + 6), { "x-gitlab-event": "Push Hook" })));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const retained = (await events()).body.events;
    expect(retained).toHaveLength(100);
    expect(retained.every((event) => event.iid! >= 6)).toBe(true);
    const timestamps = retained.map((event) => event.receivedAt);
    expect(timestamps).toEqual([...timestamps].sort().reverse());
    expect((await app.pool.query("SELECT id FROM repository_webhook_events")).rows).toEqual([]);
    await withTeam(other.teamId, async () => {
      expect((await app.pool.query("SELECT id FROM repository_webhook_events")).rows).toEqual([]);
      await expect(app.pool.query(`INSERT INTO repository_webhook_events(repository_id,received_at,event_type,result)
        VALUES($1,now(),'Push Hook','ignored')`, [app.repositoryId])).rejects.toMatchObject({ code: "23503" });
    });
    expect(await withTeam(app.teamId, () => app.pool.query("SELECT count(*)::int AS count FROM repository_webhook_events"))).toMatchObject({ rows: [{ count: 100 }] });
  });

  it("仅管理员通过 GET 检测配置，区分未配置、未勾选、可用、权限不足与连接失败", async () => {
    const { app, route, events, upstream, requests } = await fixture();
    const check = () => app.request<{ check: WebhookCheck }>(`${route}/webhook-check`, {});
    expect((await check()).body.check.status).toBe("missing");
    upstream.hooks = [{ url: (await events()).body.webhook.url, merge_requests_events: false }];
    expect((await check()).body.check.status).toBe("merge_request_events_disabled");
    upstream.hooks[0]!.merge_requests_events = true;
    expect((await check()).body.check.status).toBe("configured");
    for (const status of [401, 403, 404]) {
      upstream.status = status;
      expect((await check()).body.check).toMatchObject({ status: "unreadable", message: expect.stringContaining("无法读取 webhook 配置") });
    }
    upstream.status = 500;
    expect((await check()).body.check.status).toBe("unavailable");
    expect((await app.request(`${route}/webhook-check`, {}, { cookie: app.memberCookie })).status).toBe(403);
    expect(requests).toHaveLength(7);
    expect(requests.every((request) => request.method === "GET" && request.path === "/api/v4/projects/42/hooks")).toBe(true);
    expect((await events()).body.events).toEqual([]);
  });
});
