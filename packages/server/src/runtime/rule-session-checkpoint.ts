import type { Context } from "@deepseek-ai/cordis";
import { SessionLogOffset, type SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import {
  SessionPersistence, SessionPersistenceRevision, SessionAlreadyExistsError, SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError, SessionHandleClosedError, SessionReadOnlyError,
  assertContiguous, assertStoredId, assertVersion, materializeAppendBatch, materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions,
} from "@deepseek-ai/dsh-session-persistence";

export interface RuleSessionCheckpoint {
  header: SessionHeader;
  inheritedEventCount: number;
  events: readonly SessionEvent[];
}

interface SessionRecord {
  checkpoint?: RuleSessionCheckpoint;
  retained: boolean;
  writer?: SessionHandle;
  failure?: unknown;
}

// dsh 通过全局服务获取句柄；只有调用方认领的规范会话会导出给领域层持久化。
export class RuleSessionCheckpointStore extends SessionPersistence {
  private readonly records = new Map<SessionId, SessionRecord>();

  constructor(ctx: Context) {
    super(ctx);
    ctx.on("session/event", (session, event) => {
      const record = this.records.get(session.id);
      if (!record?.writer) return;
      try { this.append(session.id, [event]); } catch (error) { record.failure ??= error; }
    }, { global: true });
    ctx.on("session/flush", async (session) => {
      const record = this.records.get(session.id);
      if (record?.failure) throw record.failure;
    }, { global: true });
  }

  get activeSessionCount(): number { return this.records.size; }

  acquire(id: SessionId, checkpoint?: unknown): void {
    if (this.records.has(id)) throw new SessionAlreadyOwnedError(id);
    this.records.set(id, { retained: true, ...(checkpoint === undefined ? {} : { checkpoint: readCheckpoint(id, checkpoint) }) });
  }

  release(id: SessionId): void {
    const record = this.records.get(id);
    if (record?.writer) throw new SessionAlreadyOwnedError(id);
    this.records.delete(id);
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const existing = this.records.get(header.id);
    if (existing?.checkpoint) throw new SessionAlreadyExistsError(header.id);
    const inheritedEventCount = options?.inheritedEventCount ?? 0;
    if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || (!header.isSeeded && inheritedEventCount !== 0)) {
      throw new Error("会话继承事件数量无效");
    }
    const checkpoint = { header: materializeCreateHeader(header), inheritedEventCount, events: [] };
    this.records.set(header.id, { ...existing, retained: existing?.retained ?? false, checkpoint });
    return this.open(header.id, "write");
  }

  async open(id: SessionId, access: SessionAccess, options?: { signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const record = this.requireRecord(id);
    const checkpoint = record.checkpoint!;
    if (access === "write" && record.writer) throw new SessionAlreadyOwnedError(id);
    let closed = false;
    const check = (operation: string, writing = false) => {
      if (closed) throw new SessionHandleClosedError(id, operation);
      if (writing && access !== "write") throw new SessionReadOnlyError(id, operation);
      if (record.failure) throw record.failure;
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      if (record.writer === handle) {
        delete record.writer;
        if (!record.retained) this.records.delete(id);
      }
      if (record.failure) throw record.failure;
    };
    const handle: SessionHandle = {
      id, header: checkpoint.header, inheritedEventCount: SessionLogOffset(checkpoint.inheritedEventCount), access,
      read: async (offset = 0, length, readOptions) => {
        readOptions?.signal?.throwIfAborted();
        check("read");
        if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
          throw new Error("会话读取范围无效");
        }
        return { eventState: "detached", events: structuredClone(record.checkpoint!.events.slice(offset, length === undefined ? undefined : offset + length)) };
      },
      append: async (events, appendOptions) => { appendOptions?.signal?.throwIfAborted(); check("append", true); this.append(id, events); },
      flush: async (flushOptions) => { flushOptions?.signal?.throwIfAborted(); check("flush", true); },
      close,
      [Symbol.asyncDispose]: close,
    };
    if (access === "write") record.writer = handle;
    return handle;
  }

  async flush(): Promise<void> {
    const failures = [...this.records.values()].flatMap((record) => record.failure ? [record.failure] : []);
    if (failures.length) throw new AggregateError(failures, "会话检查点写入失败");
  }

  async stat(id: SessionId) {
    const checkpoint = this.records.get(id)?.checkpoint;
    return checkpoint ? { header: structuredClone(checkpoint.header), revision: SessionPersistenceRevision(`${id}:${checkpoint.events.length}`), eventCount: checkpoint.events.length } : undefined;
  }

  async list() {
    const snapshots = await Promise.all([...this.records.keys()].map((id) => this.stat(id)));
    return snapshots.filter((value) => value !== undefined);
  }

  exportCheckpoint(id: SessionId): RuleSessionCheckpoint {
    const record = this.requireRecord(id);
    if (record.failure) throw record.failure;
    return structuredClone(record.checkpoint!);
  }

  private requireRecord(id: SessionId): SessionRecord {
    const record = this.records.get(id);
    if (!record?.checkpoint) throw new SessionPersistenceNotFoundError(id);
    return record;
  }

  private append(id: SessionId, events: readonly SessionEvent[]): void {
    const checkpoint = this.requireRecord(id).checkpoint!;
    const batch = materializeAppendBatch(events);
    assertContiguous(id, batch, checkpoint.events.length);
    checkpoint.events = [...checkpoint.events, ...batch];
  }
}

function readCheckpoint(id: SessionId, value: unknown): RuleSessionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话检查点无效");
  const record = value as Record<string, unknown>;
  if (!record["header"] || typeof record["header"] !== "object" || !Array.isArray(record["events"]) ||
      !Number.isSafeInteger(record["inheritedEventCount"]) || Number(record["inheritedEventCount"]) < 0) throw new Error("会话检查点无效");
  // dsh 的公开存储校验负责 header、事件词汇与 JSON 形状；不重新实现会话协议。
  const header = materializeCreateHeader(record["header"] as SessionHeader);
  assertStoredId(id, header);
  assertVersion(header);
  const inheritedEventCount = Number(record["inheritedEventCount"]);
  if (inheritedEventCount > record["events"].length || (!header.isSeeded && inheritedEventCount !== 0)) throw new Error("会话继承事件数量无效");
  const events = validateStoredEvents(header, structuredClone(record["events"]) as SessionEvent[]);
  assertContiguous(id, events, 0);
  return { header, inheritedEventCount, events };
}
