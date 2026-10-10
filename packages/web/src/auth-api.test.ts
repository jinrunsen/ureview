import { afterEach, describe, expect, it, vi } from "vitest";
import { addMembership, createMember, getMembers, getSession, login, setup, type Session } from "./auth-api";

const session: Session = {
  user: { userId: "member-wei", username: "zhang.wei", email: null, name: "张伟", teamId: "team-payments", teamName: "支付团队", role: "admin" },
  teams: [{ id: "team-payments", name: "支付团队", role: "admin" }],
  setupRequired: false,
};
const member = { id: "member-na", username: "li.na", email: null, name: "李娜", role: "member" };

afterEach(() => vi.restoreAllMocks());

describe("用户名账号接口", () => {
  it("登录提交用户名并接受未填写邮箱的会话", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(session)));
    expect((await login({ username: "zhang.wei", password: "team-password" })).user).toEqual(session.user);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/auth/login");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ username: "zhang.wei", password: "team-password" });
  });

  it("初始化账号可以省略邮箱，添加成员可以传空邮箱", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify(member)));
    await setup({ token: "setup-token", username: "zhang.wei", name: "张伟", password: "team-password" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ token: "setup-token", username: "zhang.wei", name: "张伟", password: "team-password" });
    await createMember({ username: "li.na", email: null, name: "李娜", password: "member-password", role: "member" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ username: "li.na", email: null, name: "李娜", password: "member-password", role: "member" });
  });

  it("将已有账号加入团队时提交用户名", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(member)));
    await addMembership({ username: "li.na", role: "member" });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/admin/memberships");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ username: "li.na", role: "member" });
  });

  it("成员列表同时接受有邮箱和无邮箱的账号", async () => {
    const members = [member, { ...member, id: "member-wei", username: "zhang.wei", email: "zhang.wei@example.com" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ members })));
    expect((await getMembers()).members).toEqual(members);
  });

  it("拒绝缺失用户名或邮箱字段类型错误的账号数据", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ ...session, user: { ...session.user, username: undefined } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ ...member, email: 42 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ ...member, username: undefined }] })));
    await expect(getSession()).rejects.toThrow("数据不完整");
    await expect(getMembers()).rejects.toThrow("数据不完整");
    await expect(getMembers()).rejects.toThrow("数据不完整");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
