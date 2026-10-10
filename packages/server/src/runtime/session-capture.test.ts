import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentTeamId, withTeam } from "../db/tenant.js";
import { ReviewError } from "../reviews/types.js";
import { captureSession, type SessionRecorder, type SessionRecordingInput } from "./session-capture.js";

const firstTeam = "00000000-0000-4000-8000-000000000001";
const secondTeam = "00000000-0000-4000-8000-000000000002";
const input: SessionRecordingInput = { dshSessionId: "ureview-rule-recording", ruleSessionId: "00000000-0000-4000-8000-000000000003",
  kind: "rule_generation", provider: "fixture", model: "fixture-flash" };
const start = (seq = 0): SessionEvent => ({ seq: SessionSeq(seq), time: seq + 1000, type: "turn/start", data: { turn: 1 } });
const end = (seq: number): SessionEvent => ({ seq: SessionSeq(seq), time: seq + 1000, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
const boundary = (seq: number): SessionEvent => ({ seq: SessionSeq(seq), time: seq + 1000, type: "session/end-seed", data: {} });
let context: Context;
beforeEach(() => { context = new Context(); });
afterEach(async () => { await context.fiber.dispose(); });

function recordingStore() {
  const operations: Array<{ action: string; id: string; teamId: string | undefined }> = [];
  return {
    operations,
    begin: vi.fn(async (value: SessionRecordingInput & { id: string }) => { operations.push({ action: "begin", id: value.id, teamId: currentTeamId() }); }),
    append: vi.fn(async (id: string, _event: SessionEvent) => { operations.push({ action: "append", id, teamId: currentTeamId() }); }),
    finish: vi.fn(async (id: string, _status: "completed" | "failed", _errorCode?: string) => { operations.push({ action: "finish", id, teamId: currentTeamId() }); }),
  } satisfies SessionRecorder & { operations: Array<{ action: string; id: string; teamId: string | undefined }> };
}
function emit(event: SessionEvent, id = input.dshSessionId): void {
  context.emit("session/event", Session.create(SessionId(id)), event);
}

describe("dsh 会话捕获的完成与失败边界", () => {
  it("模型正常结束后仍保留宿主故障的具体错误码", async () => {
    const store = recordingStore();
    const capture = await withTeam(firstTeam, () => captureSession(context, store, input));
    emit(start()); emit(end(1));
    await capture!.close(new ReviewError("finding_write_failed", "评审结论保存失败"));
    expect(store.finish.mock.calls).toEqual([[store.begin.mock.calls[0]![0].id, "failed", "finding_write_failed"]]);
  });

  it("历史播种写入失败时结束已创建的记录，不留下运行中的记录或事件监听", async () => {
    const store = recordingStore(), failure = new Error("历史记录写入失败");
    store.append.mockRejectedValueOnce(failure);
    await expect(withTeam(firstTeam, () => captureSession(context, store, input, [start()]))).rejects.toBe(failure);
    const id = store.begin.mock.calls[0]![0].id;
    expect(store.finish.mock.calls).toEqual([[id, "failed", "recording_failed"]]);
    emit(end(1));
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.operations.every((entry) => entry.teamId === firstTeam)).toBe(true);
  });

  it("从公开检查点补齐恢复事件缺口，关闭前补齐未广播的尾部事件", async () => {
    const store = recordingStore();
    let persisted: SessionEvent[] = [start()];
    const capture = await withTeam(firstTeam, () => captureSession(context, store, input, persisted, () => persisted));
    const step: SessionEvent = { seq: SessionSeq(2), time: 1002, type: "step/start", data: { turn: 1, step: 1 } };
    persisted = [...persisted, boundary(1), step, end(3)];
    emit(step);
    emit(end(3));
    persisted = [...persisted, boundary(4)];
    await capture!.close();
    expect(store.append.mock.calls.map(([, event]) => event)).toEqual(persisted);
    expect(store.finish.mock.calls).toEqual([[store.begin.mock.calls[0]![0].id, "completed", undefined]]);
    emit(start(5));
    expect(store.append).toHaveBeenCalledTimes(5);
  });

  it.each(["event", "close"] as const)("%s 阶段读取公开历史失败会统一保存记录失败并抛给调用方", async (stage) => {
    const store = recordingStore(), failure = new Error("检查点不可读");
    const capture = await withTeam(firstTeam, () => captureSession(context, store, input, [start()], () => { throw failure; }));
    if (stage === "event") expect(() => emit(end(2))).not.toThrow();
    await expect(capture!.close()).rejects.toBe(failure);
    expect(store.finish.mock.calls).toEqual([[store.begin.mock.calls[0]![0].id, "failed", "recording_failed"]]);
    expect(store.append).toHaveBeenCalledTimes(1);
  });

  it("实时写入失败时，即使模型随后完成，也不能把缺失记录标记为完成", async () => {
    const store = recordingStore(), failure = new Error("事件写入失败");
    const capture = await withTeam(firstTeam, () => captureSession(context, store, input));
    store.append.mockRejectedValueOnce(failure);
    emit(start());
    emit(end(1));
    await expect(capture!.close()).rejects.toBe(failure);
    expect(store.finish.mock.calls).toEqual([[store.begin.mock.calls[0]![0].id, "failed", "recording_failed"]]);
    expect(store.append).toHaveBeenCalledTimes(1);
  });

  it("并发会话固定使用创建任务时的团队，与事件触发及关闭时的异步上下文无关", async () => {
    const store = recordingStore(), otherInput = { ...input, dshSessionId: "ureview-rule-other" };
    const first = await withTeam(firstTeam, () => captureSession(context, store, input));
    const second = await withTeam(secondTeam, () => captureSession(context, store, otherInput));
    withTeam(secondTeam, () => { emit(start()); emit(end(1)); });
    emit(start(), otherInput.dshSessionId);
    emit(end(1), otherInput.dshSessionId);
    emit(start(), "unrelated-agent");
    await Promise.all([first!.close(), second!.close()]);
    const firstId = store.begin.mock.calls[0]![0].id, secondId = store.begin.mock.calls[1]![0].id;
    expect(firstId).not.toBe(secondId);
    expect(store.operations.filter((entry) => entry.id === firstId).map((entry) => entry.teamId)).toEqual(Array(4).fill(firstTeam));
    expect(store.operations.filter((entry) => entry.id === secondId).map((entry) => entry.teamId)).toEqual(Array(4).fill(secondTeam));
    expect(store.append.mock.calls.map(([, event]) => event.seq).sort()).toEqual([0, 0, 1, 1]);
    expect(store.finish.mock.calls).toHaveLength(2);
  });

  it("业务校验失败覆盖模型正常结束的状态，且缺少团队时不能创建记录", async () => {
    const store = recordingStore();
    await expect(captureSession(context, store, input)).rejects.toThrow("缺少团队上下文");
    expect(store.begin).not.toHaveBeenCalled();
    const capture = await withTeam(firstTeam, () => captureSession(context, store, input));
    emit(start()); emit(end(1));
    await capture!.close(new Error("报告尚未完成"));
    expect(store.finish.mock.calls).toEqual([[store.begin.mock.calls[0]![0].id, "failed", "operation_failed"]]);
  });
});
