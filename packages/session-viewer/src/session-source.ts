import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  AgentContext, ISessions, SessionBinding, SessionEventLikeEntry, SessionEventWindow,
  SessionFace, SessionListState, SessionReference, SessionRetainInfo, SessionSnapshot,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session/types";

export interface SessionMetadata {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface EventsPage {
  session: SessionMetadata;
  events: SessionEvent[];
  nextAfter: number;
  hasMore: boolean;
}

function readOnly(): never {
  throw new Error("session_viewer_read_only");
}

/** 仅实现官方会话读面；所有写操作在网络请求之前拒绝。 */
export class ReadOnlySessionSource {
  readonly id: SessionId;
  readonly events: SnapshotStore<SessionEventWindow> = createSnapshotStore({
    entries: [], revision: 0, hasMore: false, change: { kind: "replace", entries: [] },
  });
  readonly state: SnapshotStore<SessionSnapshot>;
  readonly list: SnapshotStore<SessionListState>;
  readonly binding: SessionBinding;
  readonly reference: SessionReference;
  readonly sessions: ISessions;

  constructor(ctx: Context, metadata: SessionMetadata) {
    this.id = metadata.id as SessionId;
    this.state = createSnapshotStore<SessionSnapshot>({
      sessionId: this.id, pendingSubmissions: [], running: metadata.status === "running",
      subagent: null, removed: false, openState: "loading", openError: null,
      hasMore: false, loadingOlder: false, promptError: null, blank: false,
      lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
    });
    this.list = createSnapshotStore<SessionListState>({
      ids: [this.id], byId: {}, phase: "ready", projectionsBySession: {},
    });
    const absent = createSnapshotStore(undefined);
    const retained = createSnapshotStore<SessionRetainInfo>({
      referenceCount: 1, retainedBy: { mainView: 1 },
    });
    const session: SessionFace = {
      sessionId: this.id,
      getSnapshot: this.state.getSnapshot,
      subscribe: this.state.subscribe,
      projections: { faceOf: () => absent },
      loadOlder: async () => {},
      loadThrough: async () => {},
      readAttachment: async () => { throw new Error("该会话未保存图片附件。"); },
      beginSubmission: readOnly, prompt: readOnly, updateQueue: readOnly,
      cancel: readOnly, rename: readOnly, command: readOnly,
    };
    this.binding = {
      sessionId: this.id, session, eventSource: this.events, ctx: ctx as AgentContext,
    };
    this.reference = {
      sessionId: this.id, binding: this.binding, ready: Promise.resolve(this.binding),
      release() {}, [Symbol.dispose]() {},
    };
    this.sessions = {
      list: this.list,
      retain: (target) => {
        if (target !== this.id) throw new Error("session_not_available");
        return this.reference;
      },
      using: async (target, options, operation) => {
        const reference = this.sessions.retain(target, options);
        try { return await operation(reference); } finally { reference.release(); }
      },
      retainInfo: () => retained,
      searchResultLimit: 0, create: readOnly, subagentAddress: () => undefined,
      refreshProjections: async () => {}, refresh: async () => {},
      search: readOnly, fork: readOnly,
      scope: (id) => id === this.id ? this.binding.ctx : undefined,
      scopeOf: (scope) => scope === ctx ? this.id : undefined,
      sessionOf: (scope) => scope === ctx ? session : undefined,
      binding: (id) => id === this.id ? this.binding : undefined,
    };
    this.updateMetadata(metadata);
  }

  append(page: EventsPage): void {
    const current = this.events.getSnapshot();
    const entries: SessionEventLikeEntry[] = page.events.map((event) => ({ type: "event", event }));
    if (entries.length > 0) {
      this.events.set({
        entries: [...current.entries, ...entries], revision: current.revision + 1,
        hasMore: false, change: { kind: "append", entries },
      });
    }
    this.state.set({ ...this.state.getSnapshot(), openState: "open" });
    this.updateMetadata(page.session);
  }

  clear(): void {
    const previous = this.events.getSnapshot();
    this.events.set({
      entries: [], hasMore: false, revision: previous.revision + 1,
      change: { kind: "replace", entries: [] },
    });
  }

  private updateMetadata(metadata: SessionMetadata): void {
    const running = metadata.status === "running";
    this.state.set({ ...this.state.getSnapshot(), running });
    this.list.set({
      ids: [this.id], phase: "ready", projectionsBySession: {},
      byId: { [this.id]: {
        id: this.id, displayTitle: metadata.title, title: metadata.title,
        running, retainedBy: { mainView: 1 }, blank: false,
        updatedAt: new Date(metadata.updatedAt).getTime(),
      } },
    });
  }
}

export class SessionAccessError extends Error {}

export async function readEvents(id: string, after: number, signal: AbortSignal): Promise<EventsPage> {
  const response = await fetch(`/api/agent-sessions/${encodeURIComponent(id)}/events?after=${after}&limit=200`, {
    method: "GET", credentials: "same-origin", cache: "no-store", signal,
  });
  if ([401, 403, 404].includes(response.status)) throw new SessionAccessError("会话不存在或你已无权查看。请返回工作台。");
  if (!response.ok) throw new Error("session_events_unavailable");
  return await response.json() as EventsPage;
}
