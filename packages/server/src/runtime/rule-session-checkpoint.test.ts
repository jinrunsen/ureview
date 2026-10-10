import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { RuleSessionCheckpointStore } from "./rule-session-checkpoint.js";

let context: Context | undefined;
afterEach(async () => { await context?.fiber.dispose(); });
function setup() {
  context = new Context();
  return new RuleSessionCheckpointStore(context);
}
function event(seq = 0): SessionEvent {
  return { seq: SessionSeq(seq), time: 1, type: "turn/start", data: { turn: 1 } };
}

describe("规范会话的公开 dsh 检查点适配器", () => {
  it("非规范评审会话使用临时句柄，关闭后立即清掉事件", async () => {
    const store = setup();
    const id = SessionId("ureview-review-temporary");
    const handle = await store.create(Session.create(id).header);
    await handle.append([event()]);
    expect(store.activeSessionCount).toBe(1);
    expect((await handle.read()).events).toHaveLength(1);
    await handle.close();
    await handle.close();
    expect(store.activeSessionCount).toBe(0);
    expect(await store.stat(id)).toBeUndefined();
    await expect(handle.read()).rejects.toMatchObject({ name: "SessionHandleClosedError" });
  });

  it("不同会话并行独立，规范检查点在释放前保留且导出值不能改写原记录", async () => {
    const store = setup();
    const a = SessionId("ureview-rule-a");
    const b = SessionId("ureview-review-b");
    store.acquire(a);
    const [first, second] = await Promise.all([store.create(Session.create(a).header), store.create(Session.create(b).header)]);
    await Promise.all([first.append([event()]), second.append([event()])]);
    await Promise.all([first.close(), second.close()]);
    expect(store.activeSessionCount).toBe(1);
    const exported = store.exportCheckpoint(a);
    expect(exported.events).toHaveLength(1);
    exported.events = [];
    expect(store.exportCheckpoint(a).events).toHaveLength(1);
    store.release(a);
    expect(store.activeSessionCount).toBe(0);
  });

  it("拒绝双写者和跳号写入，读句柄不能追加或刷新", async () => {
    const store = setup();
    const id = SessionId("ureview-rule-owned");
    store.acquire(id);
    expect(() => store.acquire(id)).toThrow();
    const writer = await store.create(Session.create(id).header);
    await expect(store.open(id, "write")).rejects.toThrow();
    const reader = await store.open(id, "read");
    await expect(reader.append([event()])).rejects.toThrow();
    await expect(reader.flush()).rejects.toThrow();
    await expect(writer.append([event(1)])).rejects.toThrow();
    await writer.append([event()]);
    expect((await reader.read()).events).toHaveLength(1);
    await reader.close();
    await writer.close();
    store.release(id);
  });

  it("实时事件写入失败会经 awaited flush 明确失败，关闭仍释放写所有权", async () => {
    const store = setup();
    const id = SessionId("ureview-rule-failed");
    store.acquire(id);
    const session = Session.create(id);
    const writer = await store.create(session.header);
    context!.emit("session/event", session, event(1));
    await expect(context!.parallel("session/flush", session)).rejects.toThrow();
    await expect(store.flush()).rejects.toThrow();
    await expect(writer.close()).rejects.toThrow();
    store.release(id);
    expect(store.activeSessionCount).toBe(0);
  });
});
