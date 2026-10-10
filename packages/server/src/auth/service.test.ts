import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import type { SessionView, TeamSummary } from "./service.js";
import { fixturePassword, fixtureRepository, IdentityScenario } from "./test-support.js";

let scenario: IdentityScenario;
beforeEach(async () => { scenario = new IdentityScenario(); await scenario.start(); });
afterEach(async () => { await scenario.stop(); });

describe("团队身份与数据库隔离", () => {
  it("初始化用户名必填，邮箱可省略，用户名归一化后用于登录", async () => {
    const input = { token: scenario.setupToken, name: "张伟", password: fixturePassword };
    expect((await scenario.request("/api/auth/setup", { ...input, email: "zhang.wei@example.test" })).status).toBe(400);
    const setup = await scenario.request<SessionView>("/api/auth/setup", { ...input, username: " Zhang.Wei " });
    expect(setup.status).toBe(200);
    expect(setup.body.user).toMatchObject({ username: "zhang.wei", email: null });
    expect((await scenario.request<SessionView>("/api/auth/login", { username: " ZHANG.WEI ", password: fixturePassword }, { cookie: "" })).body.user)
      .toMatchObject({ username: "zhang.wei", email: null, userId: setup.body.user?.userId });
  });

  it("成员必须提供有效且唯一的用户名，邮箱是可选资料", async () => {
    await scenario.setup();
    const input = { name: "李娜", password: fixturePassword, role: "member" };
    expect((await scenario.request("/api/admin/members", { ...input, email: "li.na@example.test" })).status).toBe(400);
    for (const username of ["", "   ", "li na", "li\tna", "li.na@example.test", "a".repeat(255)]) {
      expect((await scenario.request("/api/admin/members", { ...input, username })).status).toBe(400);
    }
    expect((await scenario.request("/api/admin/members", { ...input, username: "invalid-email", email: "invalid" })).status).toBe(400);
    const members = [
      { username: " LI.NA " },
      { username: "wang.fang", email: "" },
      { username: "chen.chen", email: "   " },
      { username: "liu.yang", email: null },
      { username: "zhao.min", email: " SHARED@example.test " },
      { username: "sun.lei", email: "shared@example.test" },
    ];
    for (const member of members) {
      expect((await scenario.request("/api/admin/members", { ...input, ...member })).status).toBe(201);
    }
    expect((await scenario.request("/api/admin/members", { ...input, username: "Li.Na", email: "another@example.test" })).status).toBe(409);
    const result = await scenario.request<{ members: Array<{ username: string; email: string | null }> }>("/api/team/members");
    expect(result.body.members).toEqual(expect.arrayContaining([
      ...["li.na", "wang.fang", "chen.chen", "liu.yang"].map((username) => expect.objectContaining({ username, email: null })),
      ...["zhao.min", "sun.lei"].map((username) => expect.objectContaining({ username, email: "shared@example.test" })),
    ]));
    expect((await scenario.request("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" })).status).toBe(200);
  });

  it("登录拒绝邮箱凭据，未知用户名和错误密码返回相同错误", async () => {
    await scenario.setup();
    expect((await scenario.request("/api/auth/login", { email: "zhang.wei@example.test", password: fixturePassword }, { cookie: "" })).status).toBe(400);
    expect((await scenario.request("/api/auth/login", { username: "zhang.wei@example.test", password: fixturePassword }, { cookie: "" })).status).toBe(400);
    for (const credentials of [{ username: "missing", password: fixturePassword }, { username: "zhang.wei", password: "incorrect" }]) {
      expect(await scenario.request("/api/auth/login", credentials, { cookie: "" }))
        .toMatchObject({ status: 401, body: { error: { code: "invalid_credentials", message: "用户名或密码不正确" } } });
    }
  });

  it("已有账号按用户名加入其他团队，邮箱不能用于关联", async () => {
    await scenario.setup();
    await scenario.request("/api/admin/members", { username: "li.na", name: "李娜", password: fixturePassword, role: "member" });
    const team = (await scenario.request<TeamSummary>("/api/admin/teams", { name: "支付研发" })).body;
    await scenario.request("/api/auth/team", { teamId: team.id });
    expect((await scenario.request("/api/admin/memberships", { email: "li.na@example.test", role: "member" })).status).toBe(400);
    expect((await scenario.request("/api/admin/memberships", { username: " LI.NA ", role: "member" })).status).toBe(201);
    expect((await scenario.request("/api/admin/memberships", { username: "li.na", role: "member" })).status).toBe(409);
    const session = await scenario.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
    expect(session.body.teams.map((entry) => entry.id)).toContain(team.id);
  });

  it("同一用户名的大小写与首尾空白共用登录尝试限制", async () => {
    await scenario.setup();
    for (let attempt = 0; attempt < 10; attempt++) {
      const username = attempt % 2 ? " ZHANG.WEI " : "zhang.wei";
      expect((await scenario.request("/api/auth/login", { username, password: "incorrect" }, { cookie: "" })).status).toBe(401);
    }
    expect((await scenario.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" })).status).toBe(429);
  });

  it("初始化需要私有初始化码，只成功一次，密码和会话均不以原文入库", async () => {
    expect((await scenario.request("/api/repositories")).status).toBe(401);
    expect((await scenario.request<SessionView>("/api/auth/session")).body).toEqual({ user: null, teams: [], setupRequired: true, sso: { enabled: false, buttonLabel: "使用企业账号登录", passwordLogin: "all" } });
    const input = { token: "wrong", username: "zhang.wei", email: "zhang.wei@example.test", name: "张伟", password: fixturePassword };
    expect((await scenario.request("/api/auth/setup", input)).status).toBe(403);
    const session = await scenario.setup();
    expect(session.user).toMatchObject({ name: "张伟", role: "admin", teamId: DEFAULT_TEAM_ID });
    expect((await scenario.request("/api/auth/setup", { ...input, token: scenario.setupToken })).status).toBe(409);
    const user = (await scenario.pool.query<{ password_hash: string }>("SELECT password_hash FROM auth_users")).rows[0];
    expect(user?.password_hash).toMatch(/^scrypt-v1:/);
    expect(user?.password_hash).not.toContain(fixturePassword);
    const token = (await scenario.pool.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions")).rows[0];
    expect(token?.token_hash).not.toBe(scenario.cookie.split("=")[1]);
  });

  it("管理员与成员的初始密码接受 6 和 32 字符，拒绝超出范围的密码", async () => {
    const input = { token: scenario.setupToken, username: "zhang.wei", email: "zhang.wei@example.test", name: "张伟" };
    for (const length of [5, 33]) {
      expect((await scenario.request("/api/auth/setup", { ...input, password: "a".repeat(length) })).status).toBe(400);
    }
    const setup = await scenario.request("/api/auth/setup", { ...input, password: "a".repeat(6) });
    expect(setup.status).toBe(200);
    scenario.cookie = setup.cookie;
    for (const length of [5, 6, 32, 33]) {
      const password = "b".repeat(length);
      const username = `member-${length}`;
      const email = `${username}@example.test`;
      const result = await scenario.request("/api/admin/members", { username, email, name: "李娜", password, role: "member" });
      expect(result.status).toBe(length === 6 || length === 32 ? 201 : 400);
      if (result.status === 201) {
        expect((await scenario.request("/api/auth/login", { username, password }, { cookie: "" })).status).toBe(200);
      }
    }
  });

  it("成员可读仓库和请求评审，但不能接入仓库或创建账号团队", async () => {
    await scenario.setup();
    expect((await scenario.request("/api/repositories", fixtureRepository)).status).toBe(201);
    expect((await scenario.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" })).status).toBe(201);
    const member = await scenario.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
    expect(member.status).toBe(200);
    scenario.cookie = member.cookie;
    expect((await scenario.request<{ repositories: unknown[] }>("/api/repositories")).body.repositories).toHaveLength(1);
    expect((await scenario.request("/api/repositories", fixtureRepository)).status).toBe(403);
    expect((await scenario.request("/api/admin/teams", { name: "支付团队" })).status).toBe(403);
    expect((await scenario.request("/api/admin/members", { username: "wang.fang", email: "wang.fang@example.test", name: "王芳", password: fixturePassword, role: "admin" })).status).toBe(403);
    // 未接入仓库返回业务错误，证明成员已通过发起评审权限边界。
    expect((await scenario.request("/api/reviews", { url: "https://gitlab.example.test/commerce/not-connected/-/merge_requests/1", requestId: randomUUID() })).status).toBe(422);
  });

  it("切换团队隔离仓库，相同平台仓库可以在两个团队分别接入", async () => {
    await scenario.setup();
    const connected = await scenario.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    const nextTeam = await scenario.request<TeamSummary>("/api/admin/teams", { name: "支付研发" });
    expect((await scenario.request("/api/auth/team", { teamId: nextTeam.body.id })).status).toBe(200);
    expect((await scenario.request<{ repositories: unknown[] }>("/api/repositories")).body.repositories).toHaveLength(0);
    expect((await scenario.request("/api/repositories", fixtureRepository)).status).toBe(201);
    const rows = await withTeam(nextTeam.body.id, () => scenario.pool.query("SELECT id FROM repositories WHERE id=$1", [connected.body.repository.id]));
    expect(rows.rowCount).toBe(0);
    expect((await scenario.request("/api/auth/team", { teamId: randomUUID() })).status).toBe(403);
    const identity = (await scenario.request<SessionView>("/api/auth/session")).body.user;
    expect(identity?.teamId).toBe(nextTeam.body.id);
  });

  it("两个团队并发与事务连接归还后，SQL 不能越队读取写入或建立外队引用", async () => {
    await scenario.setup();
    const original = await scenario.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    const team = (await scenario.request<TeamSummary>("/api/admin/teams", { name: "资金结算" })).body;
    await scenario.request("/api/auth/team", { teamId: team.id });
    await scenario.request("/api/repositories", fixtureRepository);
    const checks = Array.from({ length: 16 }, (_, index) => {
      const teamId = index % 2 ? DEFAULT_TEAM_ID : team.id;
      return withTeam(teamId, async () => {
        const client = await scenario.pool.connect();
        try {
          await client.query("BEGIN");
          const visible = await client.query<{ team_id: string }>("SELECT team_id FROM repositories");
          expect(visible.rows).toEqual([{ team_id: teamId }]);
          // 留下一笔事务，连接归还必须先回滚，再供别的团队复用。
        } finally { client.release(); }
      });
    });
    await Promise.all(checks);
    expect((await scenario.pool.query("SELECT id FROM repositories")).rows).toHaveLength(0);
    await expect(withTeam(team.id, () => scenario.pool.query(
      "INSERT INTO reviews (id,repository_id,event_id,iid,head_sha,title,author,round) VALUES ($1,$2,'isolation',1,'abc','库存预留','张伟',1)",
      [randomUUID(),original.body.repository.id],
    ))).rejects.toMatchObject({ code: "23503" });
    await expect(withTeam(team.id, () => scenario.pool.query(
      "INSERT INTO repositories (id,team_id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext) VALUES ($1,$2,'https://other.example.test',9,'inventory','commerce/inventory','https://other.example.test','https://other.example.test',decode('00','hex'))",
      [randomUUID(),DEFAULT_TEAM_ID],
    ))).rejects.toMatchObject({ code: "42501" });
    const policies = await scenario.pool.query<{ relname: string; relforcerowsecurity: boolean }>("SELECT relname,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)", [["repositories","reviews","review_findings","review_deliveries"]]);
    expect(policies.rows.every((row) => row.relforcerowsecurity)).toBe(true);
  });

  it("跨站与缺少请求头的状态变更被拒绝，退出令牌立即失效", async () => {
    await scenario.setup();
    expect((await scenario.request("/api/admin/teams", { name: "支付研发" }, { headers: { origin: "https://untrusted.example.test" } })).status).toBe(403);
    expect((await scenario.request("/api/auth/logout", {}, { headers: { "x-ureview-request": "" } })).status).toBe(403);
    const previous = scenario.cookie;
    expect((await scenario.request("/api/auth/logout", {})).status).toBe(200);
    expect((await scenario.request("/api/repositories", undefined, { cookie: previous })).status).toBe(401);
    const login = await scenario.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" });
    expect(login.status).toBe(200);
    expect(login.cookie).not.toBe(previous);
  });

  it("伪造身份请求头与请求体不会提升权限，过期会话不能读取业务数据", async () => {
    await scenario.setup();
    expect((await scenario.request("/api/repositories", undefined, { cookie: "", headers: { "x-user-id": randomUUID(), "x-team-id": DEFAULT_TEAM_ID, "x-user-role": "admin" } })).status).toBe(401);
    await scenario.pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");
    expect((await scenario.request("/api/repositories")).status).toBe(401);
  });
});
