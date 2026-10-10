import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";
import { readEvents, ReadOnlySessionSource, SessionAccessError } from "./session-source";

const metadata = {
  id: "c5d17e5c-90d8-4c32-a73f-61e99132872f", title: "扣款金额校验",
  status: "running", updatedAt: "2026-10-05T10:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("只读官方会话数据源", () => {
  it("将分页记录追加到同一官方事件窗口，完成时保留历史", () => {
    const source = new ReadOnlySessionSource(new Context(), metadata);
    source.append({ session: metadata, nextAfter: 0, hasMore: false, events: [
      { type: "turn/start", data: { turn: 1 }, seq: SessionSeq(0), time: 1 },
    ] });
    source.append({ session: { ...metadata, status: "completed" }, nextAfter: 1, hasMore: false, events: [
      { type: "step/start", data: { turn: 1, step: 1 }, seq: SessionSeq(1), time: 2 },
    ] });
    expect(source.events.getSnapshot().entries.map(entry => entry.event.seq)).toEqual([0, 1]);
    expect(source.events.getSnapshot().change.kind).toBe("append");
    expect(source.state.getSnapshot().running).toBe(false);
    source.clear();
    expect(source.events.getSnapshot().entries).toEqual([]);
    expect(source.events.getSnapshot().change.kind).toBe("replace");
  });

  it("发送、取消、命令、改名和派生会话均在本地拒绝", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const source = new ReadOnlySessionSource(new Context(), metadata);
    const session = source.binding.session;
    const operations = [
      () => session.prompt([], "queue"), () => session.cancel(),
      () => session.rename("改名"), () => session.command("/compact"),
      () => source.sessions.create(), () => source.sessions.fork({ sessionId: source.id }),
    ];
    for (const operation of operations) expect(operation).toThrow("session_viewer_read_only");
    expect(request).not.toHaveBeenCalled();
  });

  it("读取只发送携带同源登录态的 GET，拒绝继续显示越权响应", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", request);
    await expect(readEvents(metadata.id, 12, new AbortController().signal)).rejects.toBeInstanceOf(SessionAccessError);
    expect(request).toHaveBeenCalledWith(`/api/agent-sessions/${metadata.id}/events?after=12&limit=200`, expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store",
    }));
  });
});
