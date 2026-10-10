import { Context } from "@deepseek-ai/cordis";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConversationViewRequest } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { loadOfficialModules } from "./official-modules";
import { readEvents, ReadOnlySessionSource, SessionAccessError } from "./session-source";
import { toolLocale } from "./tool-locale";
import "./style.css";

const connection = createSnapshotStore({ error: "", denied: false, loading: true });

/** 官方展示偏好只存在当前 iframe 内，不访问宿主配置或写接口。 */
function presentationPreferences() {
  const values = new Map<string, ReturnType<typeof createSnapshotStore>>();
  const defaults: Record<string, object> = {
    locale: { preference: "zh" },
    "ui-theme": { preference: "light", fontSize: 14 },
    "ui-chat": { transcriptView: "expanded", performanceUsage: "detailed", linkOpening: "new-tab" },
  };
  return {
    get(namespace: string) {
      let store = values.get(namespace);
      if (!store) {
        store = createSnapshotStore({
          status: "ready", value: defaults[namespace] ?? {}, base: {}, user: {},
          revision: 0, writable: false, mode: "memory",
        });
        values.set(namespace, store);
      }
      return { getSnapshot: store.getSnapshot, subscribe: store.subscribe,
        set: async () => false, unset: async () => false, mutate: async () => false };
    },
  };
}

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const id = query.get("session");
  if (!id || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new SessionAccessError("未指定可查看的会话。");
  const embedded = query.get("embedded") === "1" && window.parent !== window;
  const initialView = query.get("view") === "trajectory" ? "trajectory" : "chat";
  const abort = new AbortController();
  const [official, firstPage] = await Promise.all([
    loadOfficialModules(), readEvents(id, -1, abort.signal),
  ]);
  const ctx = new Context();
  const source = new ReadOnlySessionSource(ctx, firstPage.session);
  ctx.provide("sessions", source.sessions);
  ctx.provide("remote", {
    $host: { platform: "linux", home: "", cwd: "" },
    $on: () => () => {},
  } as unknown as Context["remote"]);
  ctx.provide("configForms", presentationPreferences());
  ctx.provide("uiWorkspace", { openSession() {} });
  ctx.provide("sidebarRight", {
    openResource() { throw new Error("当前仅提供已保存的会话内容。"); },
  });

  await official.renderer.apply(ctx);
  await official.locale.apply(ctx);
  ctx.locale.register("conversation", "zh", toolLocale);
  ctx.locale.register("conversation", "en", toolLocale);
  official.theme.apply(ctx);
  official.session.apply(ctx);
  const conversation = new official.conversation.UiConversation(ctx, source.sessions);
  ctx.uiSession.provide({
    hooks: ["conversation"],
    resolve: binding => ({ hooks: { conversation: conversation.binding(binding).snapshot } }),
  });

  function Viewer({ SessionProvider, renderSlot }: PropsRenderSlots<"conversation.view">) {
    const [view, setView] = useState(initialView);
    const [request, setRequest] = useState<ConversationViewRequest | null>(null);
    const network = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
    const openView = useCallback((next: string, focus?: string) => {
      if (next !== "chat" && next !== "trajectory") return;
      conversation.binding(source.id).activate(next);
      setView(next);
      setRequest(focus ? { view: next, focus } : null);
    }, []);
    useEffect(() => {
      if (!embedded) return;
      const receiveView = (event: MessageEvent<unknown>) => {
        if (event.origin !== window.location.origin || event.source !== window.parent) return;
        const message = event.data;
        if (typeof message !== "object" || message === null || !("type" in message) ||
          message.type !== "ureview:agent-session-view" || !("view" in message) ||
          (message.view !== "chat" && message.view !== "trajectory")) return;
        openView(message.view);
      };
      window.addEventListener("message", receiveView);
      window.parent.postMessage({ type: "ureview:agent-session-ready" }, window.location.origin);
      return () => window.removeEventListener("message", receiveView);
    }, [openView]);
    useEffect(() => {
      if (embedded) window.parent.postMessage({ type: "ureview:agent-session-view", view }, window.location.origin);
    }, [view]);
    if (network.denied) return <p className="access-error" role="alert">{network.error}</p>;
    return <main className="viewer">
      {!embedded && <header className="viewer-toolbar">
        <nav aria-label="会话视图">
          <button aria-pressed={view === "chat"} onClick={() => openView("chat")}
            title="展开用时、工作步骤和工具调用，可查看工具名称、参数和结果。">对话</button>
          <button aria-pressed={view === "trajectory"} onClick={() => openView("trajectory")}>原始轨迹</button>
        </nav>
        <span className="readonly-label">dsh · 只读</span>
      </header>}
      {network.error && <p className="connection-error" role="status">{network.error}</p>}
      {network.loading && <p className="loading-hint" role="status">正在读取会话记录…</p>}
      <section className="official-view" data-view={view} aria-label="dsh 原始会话">
        <SessionProvider session={source.reference}>
          {renderSlot("conversation.view", {
            inspectCall: callId => {
              const focus = conversation.views.entries().find(entry => entry.target === "trajectory")?.toolCallFocus?.(callId);
              openView("trajectory", focus);
            },
            viewRequest: request, openView,
            completeViewRequest: () => setRequest(null),
          }, { only: view })}
        </SessionProvider>
      </section>
    </main>;
  }

  ctx.slots.register({ name: "root", children: { "conversation.view": { kind: "list", scope: "session" } } }, Viewer);
  official.chat.apply(ctx);
  official.trajectory.apply(ctx);
  official.tool.apply(ctx);
  // 分支操作属于官方尾部节点；通过公开 keyed slot 替换该节点，保留官方正文与工具渲染。
  ctx.slots.register({ name: "conversation.chat.node", key: "turn-tail", priority: -100 }, () => null);
  conversation.binding(source.id).activate(initialView);
  source.append(firstPage);
  const container = document.getElementById("root");
  if (!container) throw new Error("viewer_container_missing");
  const unmount = ctx.uiRenderer.mount(container);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = firstPage.nextAfter;

  async function poll(): Promise<void> {
    try {
      let page = await readEvents(id!, cursor, abort.signal);
      do {
        if (page.nextAfter < cursor || (page.hasMore && page.nextAfter === cursor)) throw new Error("invalid_event_cursor");
        source.append(page);
        cursor = page.nextAfter;
        if (!page.hasMore) break;
        page = await readEvents(id!, cursor, abort.signal);
      } while (!abort.signal.aborted);
      connection.set({ loading: false, denied: false, error: "" });
      timer = setTimeout(() => { void poll(); }, page.session.status === "running" ? 1500 : 10000);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof SessionAccessError) {
        source.clear();
        connection.set({ loading: false, denied: true, error: error.message });
        return;
      }
      connection.set({ loading: false, denied: false, error: "连接暂时中断，正在重新连接；已加载的记录仍可查看。" });
      timer = setTimeout(() => { void poll(); }, 3000);
    }
  }

  window.addEventListener("pagehide", () => {
    abort.abort();
    clearTimeout(timer);
    unmount();
    ctx.fiber.dispose();
  }, { once: true });
  await poll();
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  // 官方弹层先处理本次 Escape；关闭宿主抽屉留给没有弹层的下一次按键。
  const popup = [...document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open]',
  )].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  if (popup) return;
  setTimeout(() => {
    if (!event.defaultPrevented) {
      window.parent.postMessage({ type: "ureview:agent-session-close" }, window.location.origin);
    }
  }, 0);
}, true);

void start().catch((error: unknown) => {
  const root = document.getElementById("root");
  if (!root) return;
  const message = document.createElement("p");
  message.className = "access-error";
  message.setAttribute("role", "alert");
  message.textContent = error instanceof SessionAccessError ? error.message : "会话页面暂时无法加载，请关闭后重试。";
  root.replaceChildren(message);
  console.error("session_viewer_initialization_failed", error);
});
