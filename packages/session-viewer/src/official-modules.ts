import * as React from "react";
import * as ReactJsx from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as Cordis from "@deepseek-ai/cordis";
import * as Store from "@deepseek-ai/dsh-client-store";
import * as Slots from "@deepseek-ai/dsh-client-ui-slots";
import * as Primitives from "@deepseek-ai/dsh-client-ui-primitives";
import rendererUrl from "@deepseek-ai/dsh-client-ui-renderer/client?url";
import sessionUrl from "@deepseek-ai/dsh-client-ui-session/client?url";
import conversationUrl from "@deepseek-ai/dsh-client-ui-conversation/client?url";
import chatUrl from "@deepseek-ai/dsh-client-ui-chat/client?url";
import trajectoryUrl from "@deepseek-ai/dsh-client-ui-trajectory/client?url";
import toolUrl from "@deepseek-ai/dsh-client-ui-tool/client?url";
import localeUrl from "@deepseek-ai/dsh-client-locale/client?url";
import themeUrl from "@deepseek-ai/dsh-client-ui-theme/client?url";

interface OfficialModules {
  renderer: typeof import("@deepseek-ai/dsh-client-ui-renderer/client");
  session: typeof import("@deepseek-ai/dsh-client-ui-session/client");
  conversation: typeof import("@deepseek-ai/dsh-client-ui-conversation/client");
  chat: typeof import("@deepseek-ai/dsh-client-ui-chat/client");
  trajectory: typeof import("@deepseek-ai/dsh-client-ui-trajectory/client");
  tool: typeof import("@deepseek-ai/dsh-client-ui-tool/client");
  locale: typeof import("@deepseek-ai/dsh-client-locale/client");
  theme: typeof import("@deepseek-ai/dsh-client-ui-theme/client");
}

interface ClientRegistration {
  id: string;
  factory(require: (id: string) => unknown): unknown;
}

const artifacts = {
  renderer: ["dsh-client-ui-renderer", rendererUrl],
  session: ["dsh-client-ui-session", sessionUrl],
  conversation: ["dsh-client-ui-conversation", conversationUrl],
  chat: ["dsh-client-ui-chat", chatUrl],
  trajectory: ["dsh-client-ui-trajectory", trajectoryUrl],
  tool: ["dsh-client-ui-tool", toolUrl],
  locale: ["dsh-client-locale", localeUrl],
  theme: ["dsh-client-ui-theme", themeUrl],
} as const;

/** 通过官方发布的 closure-factory 契约加载原始 UI，制品保持不变。 */
export async function loadOfficialModules(): Promise<OfficialModules> {
  const table = new Map<string, unknown>([
    ["react", React], ["react/jsx-runtime", ReactJsx],
    ["react-dom", ReactDom], ["react-dom/client", ReactDomClient],
    ["@deepseek-ai/cordis", Cordis],
    ["@deepseek-ai/dsh-client-store", Store],
    ["@deepseek-ai/dsh-client-ui-slots", Slots],
    ["@deepseek-ai/dsh-client-ui-primitives", Primitives],
  ]);
  const host = window as unknown as {
    __ModuleLoader__: { load(registration: ClientRegistration): void };
  };
  host.__ModuleLoader__ = {
    load({ id, factory }) {
      if (table.has(id)) throw new Error("duplicate_official_module");
      table.set(id, factory((dependency) => {
        if (!table.has(dependency)) throw new Error(`unavailable_official_module:${dependency}`);
        return table.get(dependency);
      }));
    },
  };
  await Promise.all(Object.values(artifacts).map(([, url]) => new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("official_module_load_failed"));
    document.head.append(script);
  })));
  return Object.fromEntries(Object.entries(artifacts).map(([key, [name]]) => {
    const value = table.get(`@deepseek-ai/${name}`);
    if (!value) throw new Error("official_module_missing");
    return [key, value];
  })) as unknown as OfficialModules;
}
