# dsh 的嵌入形态：Slot、host 层、进程隔离、程序化驱动

- 对应 ticket：[服务端技术栈与 dsh 的嵌入形态](../../.agents/notes/proposed/architecture/2026-09-11-server-stack-and-dsh-embedding.md)
- 调研时间：2026-09-12
- 前置调研：[deepseek-harness 能力边界](03-deepseek-harness-能力边界.md)（2026-09-11，基于 `0.1.1-rc.2`）
- 被调研版本：**仓库内最新 tag `dsh-v0.1.5-rc.2`（commit `fb2c4b9e69`，2026-09-10）**。本地工作树 HEAD 停在 `b150a551`（tag `dsh-v0.1.1-rc.2`，2026-08-21），落后 3225 个 commit；下文凡未注明的，都是 `0.1.5-rc.2` 的事实，读法是 `git show dsh-v0.1.5-rc.2:<path>`。

## 章节

| 节 | 问题 | 一句话答案 |
|---|---|---|
| [0](#0-先说三条推翻前一次调研的事实) | 前一次调研哪几条过时了 | 三条，都在 20 天内被改掉 |
| [一](#一slot-体系能不能承载非-chat-的整页界面) | Slot 能不能承载整页 | **能整页**，纯加法，零 dsh 改动（0.1.5 新增的 `main` 席位） |
| [二](#二host-层能不能被替换而不是包裹) | host 层能不能替换 | 既不替换也不包裹——**在 isolate realm 里旁挂第二个 WebServer** |
| [三](#三多进程隔离的真实边界) | 多进程隔离边界 | 五个进程级单例不能按租户隔离；一租户一进程干净 |
| [四](#四程序化驱动的三条路其实是四条) | 三条驱动路的接口面 | SDK 最小、**ACP 最全**、headless 纯文本，外加第四条进程内 |
| [五](#五dsh-能不能当库-in-process-嵌入) | 能不能当库 in-process 嵌入 | **A：可以**，`boot()` 是公开无副作用入口 |
| [六](#六agent-loop-依不依赖真实文件系统) | loop 依不依赖真实 fs | loop 不依赖，但 **ripgrep 依赖，沙箱也依赖** |
| [七](#七自定义工具的实际约束) | 自定义工具的约束 | 写起来很轻；**规范清单走 `agent.inject()` 而不是工具** |
| [八](#八破坏性变更的实际节奏) | 破坏性变更节奏 | 24 天 16 个版本，20 天删 9 个包、新增 49 个 |
| [九](#九复用-ui-的真实收益) | UI 复用的真实收益 | 脱离 Slot 只能复用 **4 个包**；用 Slot 约 20 个 |
| [十](#十三选一) | 三选一 | **B**（自己的服务包裹 dsh、只借底层组件），先 B1 后 B2 |

五、六、七 三节是 2026-09-12 追加的问题，比原 ticket 的第四题更靠近落地决策。

---

## 0. 先说三条推翻前一次调研的事实

前一次调研（2026-09-11）读的是 `0.1.1-rc.2`。这 20 天里 dsh 改掉了其中三条关键结论。

**(1) 「特权 RPC 永久钉死 loopback」已经作废。** `0.1.5-rc.2` 新增 `packages/client/connection/src/browser-auth.ts`，用启动令牌换 HMAC 签名 cookie 做了全量认证，`PRIVILEGED_METHODS` 那个硬编码 Set 被整个删掉。`packages/client/connection/README.zh.md` 原话：

> 每个 Host RPC 方法和 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层。

**(2) 「Slot 只能往 chat 页面塞东西」已经作废。** `0.1.5-rc.2` 把中栏从 `conversation`（single slot）换成了 `main`（**keyed slot、root 作用域**），配一个 `sidebar.panellist` 做左栏图标入口。两次 `register()` 就能加一个与 chat 平级的整页面板，且**默认组合一个示例面板都没注册**——这个席位就是为第三方留的。

**(3) 「以 dsh 为内核」的升级代价有了第一方数据。** 新增的 `apps/desktop` 是官方自己写的「壳包裹 dsh」，它在 README 里把代价写死了（`apps/desktop/README.zh.md`，「关键技术决策」表）：

> Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。

这三条都改变了嵌入形态的选择面，所以本文重新算了一遍。

---

## 一、Slot 体系能不能承载非 chat 的整页界面

### 1.1 结论：能整页，且是纯加法，不用改 renderer、不用改 dsh 源码

三选一里选「**能整页**」。但要说清楚「整页」在 dsh 里的确切含义：**不是路由，是面板注册表**。

### 1.2 渲染树只有一个 ctx 级插槽

`packages/client/ui-renderer/src/client/app.tsx`（tip 全文只有 22 行）：

```ts
/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  return () => ctx.slots.renderSlot('root', {})
}
```

`root` 由 SlotCore 构造时预置（`packages/client/runtime/src/client/slots.ts:26-43` @0.1.1；tip 移到 `ui-renderer`），是 `kind: 'single'`，被 `ui-layout` 的 `AppFrame` 占住。整棵 UI 树从这一个洞往下长。

### 1.3 没有路由，从前端到后端都没有

- 全 `packages/client/` grep `pushState` / `popstate` / `window.location` / `react-router` / `hashchange`：@0.1.1 零命中；@tip 只命中 `ui-chat/src/client/chat/AssistantMarkdown.tsx:57` 的 `window.location.protocol/origin`（判断外链协议用的）。
- 服务端也没有 SPA history fallback。`packages/host/frontend-static/src/index.ts:1-12` 的模块注释：「serves the built frontend directory with explicit index entry points. **A readable index renders at the dist root and configured index path; missing paths return 404**」。所以 `/specs` 这种 URL 硬刷新会 404。
- Settings 不是页面，是 1080×700 的居中 modal：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:1-12`「the sidebar-foot trigger row plus the **centered modal panel** (figma 501:29947, 1080x700)」，开关状态是组件 local state。

**所以：dsh 的 UI 是单页面、无 URL 状态的。** 想要「评审导航 / 规范表 / 看板」有可分享的 URL，这一层要自己加，dsh 不提供，也没有任何包能复用。

### 1.4 `main` + `sidebar.panellist`：0.1.5 新增的整页席位

`packages/client/ui-layout/src/client/index.ts:46-92` @tip，`root` 的四个子插槽：

| 插槽 | kind | scope | 含义 |
|---|---|---|---|
| `sidebar` | single | root | 整个左栏 |
| `main` | **keyed** | **root** | 中央面板，按 sidebar 条目 id 选择 |
| `rightbar` | single | root | 右栏（可全屏覆盖） |
| `shell.overlay` | list | root | 全框浮层，可点透，加法 |

`main` 的原文注释：

> Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding.**

配套的左栏入口在 `packages/client/ui-sidebar/src/client/contract/slots.ts:32`：

```ts
'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
```

`packages/client/ui-sidebar/README.zh.md:36` 把用法写得很直白：

> 插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或随语言变化的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。……**默认组合不注册示例面板。**

选中态由 `ctx.layout.selectPanel(id)` 驱动，`activePanelId` 落在 layout store（`packages/client/ui-layout/src/client/service.ts:16-34`、`stores.ts:19/59/94`），跨刷新持久。

**chat 自己也是走这条路进来的**（`packages/client/ui-conversation/src/client/apply.ts:388-394` @tip）：

```ts
slots.inject('main', function* () {
  yield slots.register({
    name: 'main',
    key: 'conversation',
    children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
  }, ConversationPanel)
  ...
})
```

注意它用的是 `slots.inject('main', ...)` 而不是裸 `register`——意味着加一个 `key: 'review-nav'` 的面板是**纯加法**，不需要 `disabled: true` 掉任何 dsh 条目，chat 还能留着。

一个「规范表」页 = 一个第三方 client 插件包 + 两次 `register()`：

```ts
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'specs', order: 10, label: () => t('specs') }, SpecsIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'specs' }, SpecsPage))
```

（这个写法就是 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2223` 里官方给的 example，只是把 slot 名换掉。）

### 1.5 @0.1.1 的旧形态，以及为什么说这是「最近才可能的」

@0.1.1-rc.2 时中栏是 `'conversation': { kind: 'single'; scope: 'session-maybe' }`（`packages/client/ui-layout/src/client/index.ts:62`），注释写「registering here **replaces the entire conversation surface**」。要做一个非 chat 整页，只能：

- 抢 `conversation` 这个 single slot → chat 整个没了；
- 或抢 `root` → 连 sidebar/details 一起没了，而且 `packages/client/runtime/src/client/slots.ts:33-40` 明文「**DO NOT register here**」；
- 或挂 `shell.overlay`（root 作用域 list，可点透浮层）——能做浮层，做不了主界面。

也就是说，这个能力是 **2026-08-21 到 09-10 之间才加上的**。它解决了我们的问题，但同时也是「dsh 在高速重构」的证据。

### 1.6 现有的非 chat 完整页面先例

| 先例 | 位置 | 形态 | 能不能照抄 |
|---|---|---|---|
| **Trajectory 表** | `packages/client/ui-trajectory`（7901 行 @0.1.1） | 虚拟滚动表格 + 时间线 + 工具栏 + 搜索索引，占满中栏 | **最接近「规范表」**。用 `@tanstack/react-virtual` + 自建 `trajectory-search-index.ts`。但它挂在 `conversation.view`（**session 作用域**），不是 root |
| Settings | `ui-settings-general` + 4 个 `ui-settings-*` | modal 面板 + 左侧 nav rail + `settings.section` list 席位 | 是「多页容器」的现成范式，但整体是弹窗，不是主界面 |
| 右栏文件树 + 文档预览 | `ui-sidebar-right` / `ui-sidebar-files` / `ui-sidebar-documentpreview`（tip 新增） | 停靠面 + tab 类型注册表 `ctx.sidebarRightTabs`，预览支持 markdown / 高亮代码 / 图片 / PDF / HTML / 纯文本 | **对 review 产品价值很高**：文件树 + 单文件代码查看器现成 |
| Cordis 面板 | `packages/extensions/ui-cordis` | 挂 `sidebar.footer.action` 的弹出面板 | 第三方插件包的完整范式（`dsh.client.inject` 声明 + `exports["./client"]`） |

`conversation.view` 是 session 作用域的 list slot，一条 entry 一个 tab（`ViewTab { id, label }`，`packages/client/ui-conversation/src/client/contract/views.ts:9-13`）。**如果「规范表」是挂在一次评审会话下的，用 `conversation.view`；如果是租户/仓库级别的，用 `main` + `sidebar.panellist`。** 两个都不用改 dsh。

### 1.7 第三方 client 插件怎么进来

不用 fork。一个普通 npm 包，`package.json` 里声明（抄 `packages/extensions/ui-cordis/package.json:29-42`）：

```json
"exports": { "./client": { "default": "./lib/client.js" } },
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-layout", "..."], "platform": "web" } }
```

然后在自己的 `cordis.patch.yml` 里 `- insert: [{ id: ui-specs, name: '@ureview/client-ui-specs' }]`。`dsh-client-modules` 的 node 半侧会扫描**已启用的 Loader 条目**，把 bundle 合成 `window.__DSH_BOOT__` 并从 `/plugins/<id>/client.js` 提供（`packages/client/modules/README.zh.md`）。

**免费拿到的共享模块**（`packages/client/web/src/platform.ts:8-14` @tip，`PLATFORM_MODULES`）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis,
@deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

这 5 个 dsh 包（含 React）由外壳静态播种进模块表，第三方 bundle 不会重复打包。@0.1.1 时只有 3 个（`store` 和 `ui-dockkit` 是 tip 新增）。其他包要在 `dsh.client.external` 里显式请求，由对应的 package row 回答。

### 1.8 `ui-primitives` 够不够做 diff viewer 的底子

**不够。** 逐个看：

| 组件 | 路径 | 能力 | 对 diff viewer |
|---|---|---|---|
| `MarkdownText` / `MessageText` | `ui-primitives/src/markdown/` | micromark + mdast + GFM + math(katex) + 增量解析 | 够用，直接复用 |
| `CodeBlock` | `ui-primitives/src/markdown/CodeBlock.tsx` | shiki 同步核心（JS 正则引擎，无 oniguruma WASM），3 个语法 boot + 23 个懒加载 | 够用 |
| `ReadBlock` | `ui-primitives/src/ReadBlock.tsx` | **带行号槽 + 逐行高亮 + 头尾折叠**，行号保留文件原始编号 | 单文件查看器的好底子 |
| `DiffBlock` | `ui-primitives/src/DiffBlock.tsx`（206 行 @tip） | **整块旧内容 + 整块新内容**，不是逐行对齐；`DiffHunk = { path, oldText: string｜null, newText }` | **不是 diff viewer**。没有行号、没有对齐、没有 hunk header、没有语法高亮、没有行级评论锚点、没有虚拟化、没有 unified/split 切换 |
| `SearchBlock` / `TerminalBlock` / `WebBlock` / `JsonTree` | 同目录 | 工具结果卡片 | 无关 |
| tip 新增 | `FileTypeIcon` / `CodeFileIcon` / `Switch` / `Tag` / `FoldToggle` / `relative-time` / `file-size` | 文件类型图标、开关、标签 | 文件树和列表能用 |

`DiffBlock` 的模块注释自己承认了（@0.1.1 版本的注释更直白）：「**Unlike the TUI's exact changed-row comparison, this block renders the old and new sides in full.**」

全仓唯一一处真正的 unified diff 是 `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:1246-1292`，用 `structuredPatch('', '', before, after, undefined, undefined, { context: 3 })` 渲染 system prompt 的变化——约 60 行的内部 helper，**没有导出**，没有行号、没有高亮。

**结论：diff viewer 100% 自建。** 能借的是 `ReadBlock` 的行号+高亮做法、`highlight.ts` 的 shiki 配置（懒加载语法的那套）、`ui-dockkit` 的分栏引擎、`ui-sidebar-documentpreview` 的文件预览注册表，以及 `--dsw-*` 设计 token（`ui-theme/src/styles/`，共约 476 行 CSS，163 个 token）。

### 1.9 三选一的答案

**能整页。** 前提是用 `dsh-v0.1.5-rc.2` 或更新，走 `main`（keyed, root）+ `sidebar.panellist` 这一对。代价清单：

- 不用改 `ui-renderer`、不用改 `ui-layout`、不用 `disabled` 掉任何 dsh 条目；
- 但**没有 URL 路由**，深链接、浏览器前进后退、刷新回到原页面，全要自己在面板内实现，而且服务端 `frontend-static` 不做 history fallback，真做 URL 路由还要自己占一个 `webServer` route；
- 整页组件的 props 必须走 Slot 的四 share 类型链（`PropsRuntime & PropsRenderSlots & PropsStore & I`，`packages/client/ui-slots/README.zh.md`），这套类型体操的学习成本不低，而且它在 20 天里改过（`ui-slots/src/index.ts` +89 行、`store.ts` 大改、`renderer.ts` 改 129 行）。

---

## 二、host 层能不能被替换而不是包裹

### 2.1 结论

**既不用替换也不用包裹——旁挂。** dsh 有一个一等机制：在 `isolate` realm 里挂第二个 WebServer，自己的 HTTP 面和 dsh 的 UI 面互不可见。官方自己就是这么做 GitHub 评审 webhook 的。

### 2.2 这几个包是不是普通插件

是。全部是 `cordis.patch.yml` 里的普通条目，按 id 可替换、可 `disabled`。`packages/bundle/web-app/cordis.patch.yml`（@0.1.1，tip 结构相同）：

| id | 包 | ctx key | inject |
|---|---|---|---|
| `webserver` | `@deepseek-ai/dsh-host-webserver` | `ctx.webServer` | `[webStartup]` |
| `api-gateway` | `@deepseek-ai/dsh-host-apiproxy` | `ctx.apiProxy` | — |
| `connection` | `@deepseek-ai/dsh-client-connection` | `ctx.connection` | `[webRuntime]`；config 只有 `trustedHosts` + `maxRequestBodyBytes` |
| `api-remotes` | `@deepseek-ai/dsh-api-remotes` | Typert Remote 注册 | — |
| `web-runtime` | `@deepseek-ai/dsh-web-app` | `webRuntime` | `[webStartup]` |

`webserver` 的 config 是纯粹的监听参数（`docs/subsystems/web-server.zh.md`）：

```ts
interface Config {
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  compression?: 'none' | 'gzip'
  ...
}
```

**注意：`dsh-host-webserver` 本身接受 `0.0.0.0`。** 拒绝 `--host 0.0.0.0` 的是 `dsh web` 这个 CLI 命令，不是插件。同一份文档写得很清楚：

> 随附的 `dsh web` 命令选择 loopback 并拒绝 `--host 0.0.0.0`；其 Connection 插件为每个 Host API route 与 stream 提供 Host/Origin 校验和浏览器会话认证。**其他组合自行拥有绑定与路由认证策略。**

### 2.3 路由 API 与「能不能插中间件」

`packages/host/webserver/src/index.ts`，三个注册方法：

```ts
register(route: WebRoute): () => void          // kind: 'exact' | 'prefix'，重复 (kind,path) 抛错
registerUpgrade(route: WebUpgradeRoute): () => void   // WebSocket，重复 path 抛错
registerFallback(handler): () => void          // 唯一席位，第二次注册抛错
```

匹配顺序：exact 表 → 最长前缀 → fallback。**没有中间件链、没有 interceptor、没有优先级。**

所以「在 `/api` 前面插一层认证」这条路走不通：`/api` 是 `dsh-client-connection` 用 `kind: 'prefix'` 注册的唯一所有者（`packages/client/connection/src/index.ts:161-172` @0.1.1），`API_PATH = '/api'` 是常量（`packages/client/connection/src/api-path.ts:8`），不可配置，重复注册直接抛错。想拦它只能整包替换。

### 2.4 信任栅栏与认证：0.1.5 已经重写过一遍

**@0.1.1-rc.2（旧）**：两层。
- 栅栏 `packages/client/connection/src/api-request-trust.ts`（123 行）：`isTrustedApiRequest(request, trustedHosts)`（第 96 行）校验 `Host` 是 loopback 权威或匹配 `trustedHosts`（带端口精确匹配、不带端口匹配任意端口，WHATWG 归一化，防 DNS rebinding）；带 `Origin` 时必须与 Host 一致；`sec-fetch-site: cross-site` 一律拒。`assertTrustedAuthority(entry)`（第 54 行）在插件加载期校验配置。
- 特权钉死：`packages/client/connection/src/index.ts:89-119` 一个硬编码 `PRIVILEGED_METHODS` Set（15 个方法：`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`、`settings.describe/openDocument/update/replace/mutate`、`credentials.describe/set/unset`、`llm.discoverModels`），在第 146-149 行用 `isTrustedApiRequest(request, [])`（**空信任表**）再过一次，即只放行 loopback。

**@0.1.5-rc.2（新）**：栅栏保留，特权集合删除，改成全量浏览器会话认证。新增 `packages/client/connection/src/browser-auth.ts`：

- 每进程生成随机启动令牌（`randomBytes(32)`，`PROCESS_LAUNCH_TOKENS` WeakMap，第 20/52-58 行），`dsh-web-app` 打印并打开带 `?token=` 的根 URL；
- `frontend-static` 把根路径交给 `ctx.connection.authorizeIndex`，只在 `GET /` 接受该令牌，写一个 HMAC-SHA256 签名的 cookie 再重定向到干净的 `/`；
- cookie：`HttpOnly; SameSite=Strict; Path=/`，host-only，名字是 `dsh-auth-<sha256(authority)>`，payload 绑定规范化 hostname+port 与绝对有效期，`cookieMaxAgeDays` 默认 30，**刻意不设 `Secure`**（随附服务器走 loopback HTTP，第 122 行）；
- HMAC 密钥是 `ctx.credentials` 里 `client-connection/browser-session` 的 grant 记录，落 `$DSH_HOME/.credentials.yaml`；
- 失败语义：Host/Origin 栅栏失败 **403**，Host 可信但未认证 **401**；静态资产（非 index）保持公开。

决策记录 `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md`（Status: implemented）。

### 2.5 官方对多用户 / 网络部署的态度

直接引原文，都出自上面那份 note：

> 随附 CLI 继续拒绝 `--host 0.0.0.0`。**认证不代表支持网络部署、TLS、转发 header 解释或代理配置。**

> 这里**没有 logout 操作或反向代理专用处理**。

> 持有浏览器 cookie 就能调用完整的工具型 Host API，这与 Web 应用在创建 Session 后暴露的 authority 一致。

「曾考虑的替代方案」里被明确否决的一条：

> **增加 logout、TLS 代理和转发 header 配置。** loopback Web 应用与已报告认证缺口都不需要这些能力；加入它们会在没有当前 consumer 时定义部署约定。

`packages/client/connection/README.zh.md`（tip）也复述了一遍：「`dsh web --host 0.0.0.0` **仍不受支持**」。

**读法**：dsh 现在有的是**单主体、机器本地**的认证（Jupyter / code-server 那种 launch-token 模型），不是多用户。没有 user / tenant / role 概念，cookie 一旦拿到就是完整 Host API 权限。**多租户仍然 100% 自建**，这条结论没变。变的是：它现在至少不再有「特权方法永久钉死 loopback」这条硬阻塞。

### 2.6 三条路的可行性（基于 tip）

**(i) 反向代理包裹 —— 能跑但官方不支持，会一路踩坑。**

- `Host` 头：代理必须让 dsh 看到的 `Host` 落进 `trustedHosts`（`connection` 行的 config，`!!js ctx.webRuntime.trustedHosts`，patch 里就带了「A deployment adding authorities keeps this expression and concatenates its literals」的注释）。
- cookie authority 绑定：cookie 名与签名 payload 都含规范化 hostname+port，所以代理后的对外域名必须和 dsh 看到的 `Host` **一致**，否则 401。
- 令牌交换：`GET /?token=` 必须能穿过代理，且 dsh 只在**进程生命周期内**认这个令牌（不持久化，每次重启换）。多副本部署时每个副本一个令牌，没有共享 session 的概念。
- 明确无支持：note 原文「没有反向代理专用处理」「不解释转发 header」。`X-Forwarded-*` 不被读取。
- **结论：能做出 demo，不适合当产品长期形态。**

**(ii) 替换 `dsh-client-connection` —— 代价比 0.1.1 时大得多。**

tip 的 `packages/client/connection/src/` 有 16 个文件：`api-path.ts`、`api-request-trust.ts`、`browser-auth.ts`、`http-bridge.ts`、`rpc.ts`、`rpc-host.ts`、`rpc-schema.ts`、`loopback-hostname.ts`、`recovery-config.ts`、`index.ts` 加 `client/` 6 个。要自己实现的是：栅栏 + cookie 认证 + RPC 注册表 + 精确 Fetch 路由 + WebSocket upgrade + connection generation 生命周期 + 重连策略。而且这个包在 20 天里 `index.ts` 就改了 203 行。**不建议。**

**(iii) 旁挂第二个 WebServer（推荐）—— 官方已有先例，零 dsh 改动。**

`apps/cli/config/examples/github-review/cordis.yml`，35 行，注释第一句：

```yaml
# Opt-in GitHub webhook overlay over the shipped Web composition. The second
# WebServer lives in an isolated realm so exposing it never exposes the UI API.

- id: github-webhook-ingress
  name: cordis:group
  group: true
  isolate:
    webServer: true
  config:
    - id: github-webhook-server
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: '127.0.0.1'
        port: !!js Number(process.env.DSH_GITHUB_WEBHOOK_PORT ?? 3081)
    - id: github-webhook-adapter
      name: '@deepseek-ai/dsh-webhook-github'
      config: { source: primary-github, path: /github, secretEnv: DSH_GITHUB_WEBHOOK_SECRET, maxBodyBytes: 1048576 }
```

机制在 `vendor/loader/src/config/isolate.ts`：`isolate: { webServer: true }` 让该条目子树把服务 key `webServer` 解析成一个后缀 `#<entry-id>` 的**不同 Symbol**（`LocalRealm.suffix`，第 54-57 行），于是 realm 内外是两个独立实例；写成 `isolate: { webServer: 'label' }` 则是按 label 共享的 `GlobalRealm`（第 59 行起）。**任意 ctx 服务 key 都能这么隔离。**

于是我们的形态可以是：

```
             ┌─ realm A（我们的）───────────────────────┐
             │  webserver(0.0.0.0:8080)                │
外网 ───────▶│  + 我们的认证/租户中间层 route          │
             │  + 我们的 SPA fallback                  │
             │  + 我们的 WebSocket                     │
             └─────────────────────────────────────────┘
                              │ 进程内 ctx 调用
             ┌─ 默认 realm（dsh 的）────────────────────┐
             │  webserver(127.0.0.1:3080) + /api + UI  │  ← 可整体 disabled
             │  ctx.agents / ctx.sessions / ctx.tools  │
             └─────────────────────────────────────────┘
```

要动 dsh 的代码：**零**。要写的是自己的 cordis 插件（可以就是一个相对路径的 `.mjs`，见 2.7）。

### 2.7 顺带：`packages/webhook` 是 0.1.5 新增的，形状正好

`docs/user/guide/github-review.zh.md` + `packages/webhook/`（`webhook` + `webhook-github` 两个包）。`ctx.webhookRuntime.register({ id, kind, run(delivery, signal) })`，`run` 返回 `null` 或一个 Session 请求：

```js
return {
  workspacePath: config.workspacePath,
  agentPreset: config.agentPreset,        // 'standard'
  permissionPreset: config.permissionPreset,  // 'read-only'
  title: `Review ${repo}#${number}`,
  prompt: [...],
}
```

规则文件是**一个相对路径的裸 `.mjs` cordis 插件**（patch 里 `name: './github-ready-review-rule.mjs'`），不需要发 npm 包。文档还专门演示了在 `run()` 里 `fetch('https://policy.internal/pr-review')` 查内部策略服务再决定是否评审。

边界写得很老实（`packages/webhook/README.zh.md`）：

> 分发仅存在于进程内并采用 fire-and-forget，**不拥有交付数据库、队列、重试、去重或 Agent 完成状态**。

HTTP 语义也说清了：`202` 只表示签名和 JSON 被接受、规则调用已在内存中调度，**不表示规则匹配、不表示 Session 已创建**。

**对我们的意义**：GitLab webhook → 创建 review Session 这条链，dsh 提供了骨架和一个 GitHub 实现可以照抄；队列、重试、去重、结果回写仍然在我们自己的服务里。

## 三、多进程隔离的真实边界

### 3.1 判定标准，dsh 自己写下来了

`.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.zh.md`（Status: implemented）在讨论 `token-meter` 该归谁时立了一条通则：

> 当一个单元的空值与真实值无法区分时，**只要它注册进的那张表是进程级的，它就不能是逐组装的**。

这条规则原本是给 agent preset 用的，但它同样是「什么东西不能按租户隔离」的判据：**凡是注册进进程级扁平表的服务，同进程多租户一定撞车。**

同一份 note 举了一个具体的翻车例子——`sessionProjections` 是「一张进程级、没有作用域分层的表」，于是从某个 preset 内部注册的投影单元会替**所有**会话作答：

> 一个 `minimal` 会话是否显示 context meter，取决于本次启动以来有没有**别的**会话挂过 `standard`。

### 3.2 隔离机制：symbol realm

`vendor/loader/src/config/isolate.ts`。条目上写 `isolate: { <serviceKey>: true }`，该条目子树把这个服务 key 解析成一个带后缀的**不同 Symbol**：

```ts
export class LocalRealm extends Realm {
  constructor(private entry: Entry) { super() }
  get suffix() { return '#' + this.entry.options.id }
}
```

`access(key, create)` 用 `this.store[key] ??= Symbol(`${key}${this.suffix}`)` 造这个符号（第 31-37 行）。写成 `isolate: { webServer: 'label' }` 则是按 label 共享的 `GlobalRealm`（第 59 行起）。

**这是 dsh 里唯一的进程内隔离原语**，agent preset 和第二个 WebServer 用的都是它。理论上任意 ctx 服务 key 都能这么隔离。

但 realm 隔离有一个硬性后果：**realm 内的服务对 realm 外的 `ctx.get()` 不可见**。`packages/bundle/web-app/cordis.patch.yml` 有一大段注释就是在逐条解释哪些服务因此**必须**留在 host plane：

- `jobs` 注册表：「Its producers … are preset rows that resolve it with `ctx.get`，而 entry-local realm 对 realm 外的兄弟行不可见，所以 `run_in_background` 会答 background jobs unavailable」
- `goals`：「Gateway 把 goal 域当 Remote endpoint 服务，Remote 方法从生成的描述符里挑接收者 Service——它在 host 上解析 `goals`，逐会话 realm 会让每个浏览器调用都答 `service-unavailable`」
- `subagents`：「`subagents` 是一个**进程单例**，带跨会话查询面（`listChildren`、`followup`），而 provider 是按全局唯一名字注册的，逐会话拷贝既会饿死 host 行，又会在第二个会话上撞名」
- `tokenMeter`：见上

**结论：`jobs`、`goals`、`subagents`、`tokenMeter`、`sessionProjections` 这五个是明确不能按租户隔离的。** 它们要么被跨 realm 的 `ctx.get` 解析，要么注册进进程级扁平表。

### 3.3 具体的进程内单例

| 单例 | 位置 | 状态字段 | 同进程多租户会怎样 |
|---|---|---|---|
| `ctx.agents` | `packages/core/agent/src/index.ts:245-249` | `private store = new Map<SessionId, AgentEntry>()`，外加两个 `AsyncLocalStorage`（initiator / initiatorRun） | key **只有 SessionId，没有租户维度**。SessionId 唯一就不会串数据，但 `list` 类接口会返回全进程所有 agent |
| `ctx.jobs` | `packages/jobs/jobs/src/index.ts:62` `JobRegistry extends Service` | 按 owning agent 建键 | 同上：注册表全局，按 agent 分桶 |
| `ctx.subagents` | `packages/subagent/` | **provider 按全局唯一名字注册** | 第二份同名 provider 直接抛错。租户级自定义 subagent provider 不可能 |
| `sessionProjections` | `packages/session/session-projection` | 进程级扁平表，无作用域分层 | 投影单元互相覆盖（note 里的实锤例子） |
| agent preset | `packages/preset/agent-presets` | 常驻挂载，每个 preset 一个 realm | note 提到一个已知限制：「**被替代的常驻代际永不回收**，而设置页的编写流程把它变成每次保存的代价」——即 preset 热改会泄漏代际 |
| `ctx.tokenMeter` | `packages/llm/token-meter` | host plane 单例 | 明确不可 per-preset |

### 3.4 `$DSH_HOME`：单根，可以整体换

`packages/util/home-paths/src/index.ts:87-91`：

```ts
export function resolveDshHome(configured?: string, env = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}
```

优先级：显式 config > `$DSH_HOME` > `~/.dsh`。文档注释写明「**The harness keeps all user data under one root**」。空白 `$DSH_HOME` 视为未设，不会退化成 cwd。

各存储行的 root 在 patch 里都是 `!!js dshHomePath('...')` 表达式（例：`packages/bundle/web-app/cordis.patch.yml:57` 的 `storage-json` config `root: !!js dshHomePath('storages')`），**所以既能整体换 `$DSH_HOME`，也能逐行指向别处。**

`sessions` / `storages` / `settings.yaml` / `.credentials.yaml` / `attachments/v1` / `profiles` 全部挂在这一个根下。

**一租户一进程 + 一个 `$DSH_HOME`，隔离是干净的。**

### 3.5 跨进程共享的东西（`$DSH_HOME` 隔离不掉的）

`process.env.DSH_*` 在 tip 全仓的读取点有 70+ 个 key，路径相关的只有两个：

| 变量 | 读取点 | 说明 |
|---|---|---|
| `DSH_HOME` | 44 处 | 主根 |
| `DSH_AGENTS_HOME` | 12 处，如 `packages/skill/skill-filesystem/src/index.ts:164`：`resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))` | **skill 目录默认在 `~/.agents`，不在 `$DSH_HOME` 下**，必须单独设 |

其余直接读 `os.homedir()` 的点（`packages/llm/llm-pi-ai/src/auth.ts:218` 的 `~` 展开、`packages/host/open-in-app/src/resolver.ts:136`、`packages/host/directory-picker-browse/src/index.ts:218`、`packages/api/remotes/src/index.ts:41` 的 `{ home: homedir() }`）都是把 OS home 当展示或解析基准，不写数据，但它们**泄漏宿主机路径**——多租户下 `open-in-app` 和 `directory-picker-browse` 应当直接 `disabled`。

另外真正共享的是 **profile 的 `node_modules` 与 pnpm store**：`apps/desktop/README.zh.md` 专门为此加了进程单实例锁，理由是「共享可执行依赖图会让 CLI 与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile」。**一租户一进程如果共用同一个 profile 目录，会在插件安装/升级时互相打架。**

### 3.6 同租户内多会话并发

**可以。** dsh 的 Web 表层本来就是单进程多会话：`ctx.agents` 按 SessionId 建键，每个 Agent 有自己的 scope（`agent.ctx`），`packages/core/scope` 是零依赖 scope 原语，`tools` / `system-prompt` / `skill` 三个注册表按 scope 链分层解析（host → preset → agent，近者遮蔽远者）。

隔离靠三条：

1. **scope 链**：一个 agent 看到的工具/提示段/skill 由它的 scope 父链决定。上面那份 note 还记了一个坑：**没有加入任何 preset 的 agent，三张表都解析到空的全局层，模型什么也收不到，不报错**——「ACP 桥、SDK server 与 headless bundle 都会创建一个」这样的裸 agent。
2. **cwd 是每会话的**：`SessionHeader.cwd`，SDK 那条路是 `InitializeParams.cwd`「recorded on every SDK-created session's header」，ACP 那条路是 `session/new` 的绝对工作区（发布前校验）。
3. **sandbox 的 mode 是每会话的，workspaceRoot 是进程级的**。`packages/sandbox/sandbox-policy/src/index.ts:130`：

   ```ts
   this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
   ```

   在构造函数里定一次。`resolve(request)`（第 163 行）每次工具执行都调，但它解析的是**mode**（从会话日志里最近一条 `sandbox` 覆盖，第 98 行）——`workspaceRoot` 只有插件级那一个值。

   **所以同进程内多个不同工作目录的会话，文件沙箱边界只有一个。** 这是同进程多会话最大的实际风险。跨仓库评审要么一仓一进程，要么「只读」这个约束靠 `permissionPreset: read-only` 加 `tools/pre-execute` 门禁来兜，不能指望 sandbox。

**跑飞的会话**：`ctx.jobs` 是进程内注册表，工具超时由 `packages/guard/timeout-policy` 包 `tools/execute`，但**没有 per-session 的 CPU / 内存配额**。一个会话吃满 CPU 会拖垮同进程所有会话。

---

## 四、程序化驱动的三条路（其实是四条）

### 4.1 `sdk/server` 的 JSON-RPC —— 比想象中小得多

`packages/sdk/protocol/README.zh.md` + `src/types.ts`。按换行分帧的 JSON-RPC 2.0 over stdio。**全部方法只有 3 请求 + 4 通知**：

| 方向 | 方法 | 载荷 |
|---|---|---|
| client→server | `initialize` | `InitializeParams { cwd, provider, model, reasoningEffort?, maxTokens? }` → `{ serverInfo }` |
| client→server | `session/prompt` | `{ sessionId, contentBlocks }` → `{ messageId }` |
| client→server | `shutdown` | 无参 → `{}` |
| server→client | `session.event` | `{ sessionId, event: SessionEvent }`，**运行时内每个会话，不过滤** |
| server→client | `session.status` | `{ sessionId, status: 'idle' \| 'running' }` |
| server→client | `subagent.started` | `{ parentSessionId, childSessionId }` |
| server→client | `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status, stopReason, lastAssistantMessage? }`，**仅进程内运行** |

逐条回答：

- **创建会话**：有，但是隐式的。`SessionPromptParams.sessionId` 的注释：「an unknown id lazily creates the agent+session pair」。会话 id 由客户端选。**一个进程可以跑多个会话。**
- **指定 agent preset**：**不能**。`cwd` / `provider` / `model` 是 `initialize` 时定的**进程级**值。README 原话：「profile 组合拥有每个根 agent 的工具」——工具集来自 profile，不是来自请求。
- **注入上下文**：只有 `session/prompt` 一种投递。没有 `steer` / `inject` / `followup` 的区分。
- **流式收事件**：有，`session.event` 是完整 `SessionEvent` 信封，token 级 `assistant/chunk` 都在。
- **取消**：**没有。** 协议里就 3 个方法，只能杀进程或 `shutdown`。
- **resume 已有会话**：**没有。**
- **结构化结果**：**没有。** 而且 README 明说：「它不会把某条助手消息或 `turn/end` 归属于某个提示词」——**提示词与结果的对应关系要自己从 `session.status` 的 idle 转换 + 会话事件里拼**。
- **认证**：无。stdio。「Stdout 只承载 JSON-RPC 帧」，日志必须走 stderr。

启动：`dsh --profile sdk`（bundle `packages/bundle/sdk-app`，tip 新增；另有 `sdk-minimal`）。

### 4.2 `acp/acp` —— 三条里接口面最完整的

`packages/acp/acp/README.zh.md`。标准 [Agent Client Protocol](https://agentclientprotocol.com) **v1**，stdio，`pnpm dsh --profile acp`（bundle `packages/bundle/acp-app`，tip 新增）。

> 一个连接可以同时运行多个会话，彼此独立。

| 调用 | 有没有 |
|---|---|
| `initialize` | 稳定 ACP v1 + `session/list`/`resume`/`close` + Streamable HTTP MCP |
| `authenticate` | **立即成功；服务器不需要身份验证** |
| `session/new` | ✔ 全新持久 agent，绝对工作区 + stdio/HTTP MCP 服务器发布前校验 |
| `session/list` | ✔ 分页、新到旧、可按绝对 `cwd` 筛 |
| `session/resume` | ✔ **跨进程重启恢复**已持久且非活跃的会话 |
| `session/close` | ✔ 停稳式取消 + drain + 后代释放 + 持久化 flush |
| `session/set_config_option` | ✔ `model` / `reasoning_effort` |
| `session/prompt` | ✔ **「Agent 空闲且有序更新交付后才结算」——提示词与结果天然对应** |
| `session/cancel` / `$/cancel_request` | ✔ |
| `session/update` | ✔ assistant 消息与 thought、通用工具生命周期、配置变化、上下文用量，按会话串行 |
| `session/request_permission` | ✔ 一次性允许/拒绝，**客户端可以自动回答** |

明确不支持：`session/load`、删除、fork、附加目录、SSE、mode、命令、**计划、todo、终端**、客户端文件系统操作、elicitation。也**不能按会话选 agent preset**（`provider`/`model` 在插件 config 里）。

README 自己的定位：

> 当自动化应拥有交互时选择它：管理持久会话、工具、模型选择与权限的进程外 subagent、测试运行器或脚本化控制器。

### 4.3 `bundle/headless` —— 一次性、纯文本

`packages/bundle/headless/cordis.patch.yml`（31 行）：不挂 Host、不挂 HTTP server、不挂 Web runtime、不挂任何浏览器插件。

```sh
dsh --profile headless "run the tests"
```

输出格式（`packages/bundle/headless/README.zh.md`）：

- **stdout**：最终答案，纯文本。没有 JSON，没有 `--output-format`。
- **stderr**：每个非空推理增量写进 `dsh: reasoning:` 段；错误写 `dsh: <code>: <message>`。成功且无推理时 stderr 为空。
- **退出码**：完成 0，中止或出错 1。
- 任务文本是唯一的 `task` 配置项，来自命令行位置参数。

> 主要边界：每次调用只运行一个任务，没有交互式后续。

### 4.4 第四条：进程内驱动（tip 新增的 `webhook` 走的就是这条）

不走任何 IPC，直接在自己的 Node 进程里持有 dsh 的 cordis 树，用 `ctx.agents` / `ctx.sessions` 驱动。

- `packages/webhook/webhook` 的 `ctx.webhookRuntime` 就是这么创建根 Session 的（`src/session.ts`），规则 `run()` 返回 `{ workspacePath, agentPreset, permissionPreset, title, prompt }`。**这是唯一一条能按请求指定 agent preset 和 permission preset 的路。**
- `apps/desktop-host` 也是这条：Electron 壳不开端口，用 `dsh-app://` + 分帧字节管道承载 Fetch。
- 代价：和 dsh 同进程、同 Node 版本、同 `$DSH_HOME`，版本锁死（见 0. 那条 Desktop 引文）。

### 4.5 横向对比

| 维度 | SDK JSON-RPC | ACP | headless | 进程内 |
|---|---|---|---|---|
| 进程生命周期 | 常驻 | 常驻 | 一次性 | 常驻 |
| 一进程多会话 | ✔（隐式创建） | ✔（显式 `session/new`） | ✘ | ✔ |
| 跨进程重启恢复 | ✘ | **✔ `session/resume`** | ✘ | ✔ |
| 取消 | **✘** | **✔** | 杀进程 | ✔（`agent.cancel`） |
| 提示词↔结果对应 | **✘ 要自己拼** | **✔ prompt 结算即完成** | ✔（就一个结果） | ✔ |
| 事件粒度 | 完整 `SessionEvent`（含 token 级 chunk） | ACP 语义更新（assistant/thought/工具生命周期/用量），**不是 dsh 原生事件** | 无 | 完整，且可扩展 `SessionEventMap` |
| 审批请求 | ✘ | **✔ `session/request_permission`，可自动回答** | ✘ | ✔ |
| 指定 agent preset | ✘ | ✘ | ✘ | **✔** |
| 指定 per-session cwd | ✘（进程级） | **✔** | ✔（进程 cwd） | ✔ |
| 结构化结果 | ✘ | ✘ | ✘ | ✔（自己扩展 `SessionEventMap`） |
| 认证 | 无（stdio） | 无（`authenticate` 立即成功） | 无 | 无 |

**「由一个常驻 web 服务按需发起 review、流式收进度、最后收结构化结果、支持取消」——两个答案，取决于是不是同进程：**

- **如果 dsh 跑在独立进程/容器里**：选 **ACP**。它是三条 IPC 路里唯一同时具备「多会话 + 取消 + 提示词结算语义 + 跨重启恢复 + 权限回调」的。SDK JSON-RPC 没有取消、没有 resume、结果对应要自己拼，短板是硬伤。
- **如果接受同进程**：选**进程内驱动**。它是唯一能按 review 任务指定 agent preset / permission preset 的，也是唯一能扩展 `SessionEventMap` 拿到真正结构化 finding 的（`review/finding`、`review/decision` 这种自定义持久事件）。

四条路**都没有认证**。无论选哪条，认证层都在我们自己的服务里。

---

## 五、dsh 能不能当「库」in-process 嵌入

### 5.1 结论：**A，可以直接 in-process 嵌入**，而且官方承认这是一条受支持的低层路径

判断依据是四条硬证据，不是推测。

### 5.2 `Context` 是一个无参构造函数，没有全局单例

`vendor/cordis/src/context.ts:71`：

```ts
/** Create the root context and install the built-in services. */
constructor() {
  this[symbols.isolate] = Object.create(null)
  this[symbols.intercept] = Object.create(null)
  const self = new Proxy<this>(this, ReflectService.handler)
  this.root = self
  this.baseUrl = undefined
  this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
  this.reflect = new ReflectService(self)
  this.registry = new RegistryService(self)
  this.events = new EventsService(self)
  this.logger = new LoggerService(self)
  ...
}
```

每个 `new Context()` 自带独立的 registry / events / logger / fiber。全仓 `vendor/cordis/src/` 里 `globalThis` 只出现 1 次，还是个类型引用（`registry.ts:142`）。

而且 `Context.is` 的注释明说它是为多实例设计的：

> Works across realms and **across multiple copies of cordis**, because the brand is keyed by a global symbol rather than by `instanceof`.

**一个进程里多个互相隔离的 Context 没有任何结构性阻碍。**

### 5.3 `boot()` 是导出的、无进程副作用的嵌入入口

`packages/boot/app-boot/src/index.ts:787`：

```ts
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  ctx.provide('dshHomePath', dshHomePath)
  await ctx.plugin(Loader)
  await prepare?.(ctx)
  await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
  await ctx.get('loader')?.await()
  await assertEntriesActivated(ctx, binName)
  return ctx
}
```

三个关键点：

- **`boot()` 本身不碰任何进程全局**：不装信号处理器、不调 `process.exit`、不 `chdir`。那些在**另一个**导出 `installFailLoud()` 里（`src/index.ts:639`），嵌入方不调它就行。
- **`prepare?: (ctx) => ...` 是官方的宿主注入缝**：注释写「optional host setup run after Loader installation and **before any config-tree entry mounts**」。我们的认证、租户上下文、自定义服务都从这里 `ctx.provide()` 进去。
- **`bareModuleBaseUrl?`**：注释写「use it when **the host, rather than the configuration project, owns the complete plugin set**」——直接就是为嵌入方准备的参数。

`app-boot` 的 README 自己定位：

> 在实现共享 `dsh` launcher **或嵌入其低层启动 helper** 时使用它。……直接配置 helper 只保留给**低层嵌入方**与测试。

### 5.4 `bundle/headless` 本质就是「一段把 Agent 驱起来的插件代码」

`packages/bundle/headless` 只有两样东西：一个 31 行的 `cordis.patch.yml`，和一个 228 行的普通 cordis 插件 `src/index.ts`。整个驱动逻辑是（`src/index.ts:169-212`，已删注释）：

```ts
await ctx.get('loader')?.await()          // 等插件树装完再建 agent
const agents = ctx.get('agents')
const sessions = ctx.get('sessions')
const selection = ctx.get('agentDefaultModel').currentSelection()

const { agent } = await agents.create({
  sessionId: brandString<SessionId>(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
})
await agent.whenIdle()
const firstSeq = agent.session.seq
agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
await agent.whenIdle()
await sessions.flush(agent.session)
// 然后从 agent.session.eventAt(seq) 遍历持久日志取结果
```

**这就是完整的 in-process 驱动 API。** 我们要写的 review runner 就是同形状的一个插件，区别只在于：用 `agents.create()` 时 join 一个 agent preset（headless 里那段注释专门提醒了这点，见 `src/index.ts:180-183`：「This bundle composes no preset roster … A deployment that DOES configure one **has to join it here first**」），并用扩展的会话事件取结构化结果。

绕过 CLI 直接调它：可以。`boot()` 是公开导出，`headless` 的插件也是公开包（`@deepseek-ai/dsh-headless`，`publishConfig.access: public`）。

### 5.5 既有的 in-process 嵌入先例

`boot()` 在 tip 有三个真实调用方：

| 调用方 | 形态 |
|---|---|
| `apps/cli/src/profile-boot.ts:336` | 正常 CLI |
| `apps/desktop-host/src/index.ts:289` | Electron 壳，**不开监听端口**，`dsh-app://` + 分帧字节管道承载 Fetch |
| `packages/experimental/webworker-runtime/src/worker-host.ts:222` | **整棵 harness 插件树跑在浏览器 Web Worker 里**，内存 VFS + postMessage 隧道 |

第三条是最强的证据：dsh 能在一个连 Node 都没有的宿主里被当库启动。`packages/experimental/webworker-runtime/README.zh.md`：

> 整棵 harness 插件树跑在一个 dedicated Web Worker 里……worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。

0.1.5 里 `examples/` 顶层目录已经不存在了（原来的 `examples/jsonrpc-agent`、`acp-agent` 等在 `packages/examples/` 短暂存在后于 `0.1.5` 前被删除），所以没有一个「最小 in-process 嵌入示例」可以照抄——只能照 `bundle/headless` 和 `apps/desktop-host`。

### 5.6 嵌入的真实约束（四条）

1. **裸包 specifier 需要 Loader 的原生辅助组件。** `app-boot` README「已知限制」原文：

   > 生产 bin 需要 Loader 的可选原生辅助组件；**没有该辅助组件的进程内调用方必须使用可解析的相对／file specifier，或提供自己的模块解析钩子。**

   解法就是 `boot()` 的第 5 个参数 `bareModuleBaseUrl`。

2. **`$DSH_HOME` 是进程级的。** `resolveDshHome()` 每次都读 `process.env`，`boot()` 在第 31 行 `ctx.provide('dshHomePath', dshHomePath)` 把这个函数注进 ctx。所以**同一进程里的两个 Context 默认共享同一个 `$DSH_HOME`**。要按 Context 分家，只能在各自的 patch 里把每个存储行的 root 写成字面量（`sessions` / `storages` / `settings` / `credentials` / `attachments` 都是 `!!js dshHomePath(...)` 表达式，逐行覆盖是可行的，但要一条不漏）。

3. **别挂会写 stdout 的插件。** `sdk-jsonrpc-server`（「Stdout 只承载 JSON-RPC 帧」）、`headless-runner`（往 `process.stdout` 写最终答案并调 `appExit`）、`acp` 都假定独占进程 stdio。嵌入时这三个都不挂。`headless-runner` 还硬性要求宿主先 `ctx.provide('appExit', ...)`（`src/index.ts:222-225`）。

4. **`process.cwd()` 仍有隐性读取点。** 最要命的是 `sandbox-policy` 的 `workspaceRoot ?? process.cwd()`（见 3.6）。多 Context 共进程时，每个 Context 的 sandbox 根要显式配置，不能靠默认值。

### 5.7 对架构选择的直接影响

**「一个 Node 进程里跑一切」技术上成立，但不建议按租户共进程。** 理由在 3.1–3.3：`jobs` / `goals` / `subagents` / `tokenMeter` / `sessionProjections` 是进程级扁平表，`subagents` 的 provider 还是全局唯一名——这些在**同一个 Context 内**无解；多 Context 能绕开（每个 Context 一套注册表），但 `$DSH_HOME`、`process.cwd()`、stdout、CPU/内存配额仍然是进程级的。

实际可行的形态是三选一：

| 形态 | 说明 | 适用 |
|---|---|---|
| **一进程一 Context，一租户一进程** | 最干净。`$DSH_HOME` 按进程分，sandbox 根按进程分 | 推荐 |
| 一进程多 Context，一租户一 Context | 省内存，但要逐行覆盖存储 root、逐 Context 配 sandbox 根，且 CPU 不隔离 | 谨慎 |
| 一进程一 Context，多租户共用 | 撞车（3.3 那张表） | 不可 |

---

## 六、agent loop 依不依赖真实文件系统

### 6.1 loop 本身不依赖，但「不落盘」的代价比想象中大

`packages/core/agent-loop/src/index.ts:360`：

```ts
static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
```

**没有 `fs`。** `packages/core/` 全目录 grep `process.cwd()` / `process.env`：**零命中**。核心循环是纯内存的。

而且 dsh 自己证明了这一点：`packages/experimental/webworker-runtime` 把整棵树跑在浏览器 Worker 的**内存 VFS** 上。

但那个 README 的「已知限制」同时说明了代价——它不是「不需要文件系统」，而是「**需要一个 `node:fs` 兼容的文件系统**」，为此他们实现了：VFS watcher（callback / polling / promise 三种）、跨 rename/unlink 保持身份的 file descriptor、`FileHandle.stat({bigint:true})` 的 device/inode 一致性、`FileHandle.chmod()`、`readable-stream` 文件流（给 Chokidar / readdirp 用）。

### 6.2 ripgrep 走的是 `ctx.subprocess`，不是 `ctx.fs` —— 这条是硬的

`packages/fs/tool-fs-search/src/glob.ts:4` 与 `src/grep.ts:2-5` 的模块注释：

> Execution spawns the **packaged ripgrep binary (`@vscode/ripgrep`) directly through the subprocess seam** with a plain argv vector using a fixed line-oriented `rg --json` command

README 也确认「搜索**无需宿主安装 `rg`**」——二进制是打包进来的。

**含义：`glob` / `grep` 完全绕过 `ctx.fs` provider。** 它们看到的是 `ctx.subprocess` 所在环境的真实文件系统。所以：

- 换掉 `ctx.fs` 指向内存/远程，`read`/`write`/`edit` 会跟着走，**但 `grep`/`glob` 不会**——它们会在原地的真实盘上搜，结果和 `read` 看到的内容对不上。
- `packages/e2b` 之所以同时提供 `fs-e2b` **和** `subprocess-e2b`，就是这个原因：两条缝必须一起搬。
- Worker 那条路里，`child_process` 被**实现**成了「命令跑进另一个 Worker」，命令表只有 coreutils——README 明说「**没有 `git`，没有网络工具**」。ripgrep 这种 native 二进制在那里跑不了。

**结论：要代码检索（`grep`/`glob`）就必须有一个真实的、`ctx.subprocess` 能触达的文件系统。** 这条是硬的。对我们意味着：review 时的仓库 checkout 必须落在某个 dsh 进程（或它的 E2B / 容器沙箱）能用真实路径访问的地方。

### 6.3 不落盘 = 沙箱失效

`sandbox-local` 是基于路径和内核机制的：macOS `sandbox-exec`（seatbelt）、Linux `bwrap` / Landlock（`packages/sandbox/sandbox-local/src/index.ts:69/86` 的探测，`:363-374` 的 `--workspace` argv 与 Windows ACL SID）。

Worker README 把这一点写得最直白：

> **Worker confinement 是 VFS 边界，不是内核 Landlock。** …… `full` 仅覆盖 Worker 命令表和已挂载 VFS，不表示能够执行任意 native 进程，也不表示 Linux 内核隔离。

**所以：不落到真实盘上，`ctx.sandbox` 这一层就只剩「你的 fs provider 自己愿意拒绝什么」。** 安全边界要从别处来，按强度排：

1. 容器 / microVM（把整个 dsh 进程关进去）——最可靠，也是多租户下唯一说得过去的；
2. `ctx.tools.guard()` 的单调拒绝 + `tools/pre-execute` 的 allow/deny/ask（`docs/cookbook/adding-a-tool.zh.md`「执行策略与观测」一节）；
3. `permissionPreset: read-only`（`agent-presets` 那条，webhook 示例里用的就是它）；
4. `ctx.tools.restrict(filter)` 直接不给写类工具。

对一个只读评审产品，2+3+4 组合是主力，sandbox 只是纵深防御的一层，且**只在真实盘上才有效**。

### 6.4 `$DSH_HOME` 下那几样必须有真实目录吗

逐个看 tip 的 provider 清单：

| 数据 | provider | 还有别的实现吗 | 能不能不落盘 |
|---|---|---|---|
| 会话日志 | `session-persistence-jsonl` | **没有**（`session-persistence-sqlite` 在 `4553c9d957` 被删） | 可以**不挂持久化行**——`ctx.sessions` 本身带内存 store，持久化是独立的 seam。代价是崩溃/重启全丢 |
| 非会话数据 | `storage-json` / `storage-sqlite` | 两个，都落盘 | 要自建 provider |
| 设置 | `settings-file`（`$DSH_HOME/settings.yaml`，热重载） | **只有这一个** | 要自建 provider，或把配置全写进 patch |
| 凭据 | `credentials-local`（`$DSH_HOME/.credentials.yaml`） | **只有这一个** | 要自建。注意 0.1.5 的浏览器认证密钥也存在这里 |
| 附件 | `attachment-local`（`$DSH_HOME/attachments/v1`，内容寻址） | 只有这一个 | 要自建 |
| 文件系统 | `fs-local`（+ `fs-sandbox` 包装、`fs-observation-policy` 门禁） | 只有这一个；`packages/e2b/fs-e2b` 是远程实现 | 要自建或用 e2b |
| skill 目录 | `skill-filesystem`，默认 `~/.agents`（`DSH_AGENTS_HOME`） | 只有这一个 | 要自建 |
| 代码检索 | `tool-fs-search` → `ctx.subprocess` → ripgrep | — | **不行**（见 6.2） |

**「全部指到内存或我们自己的存储」技术上做得到，但要自己写 5～6 个 provider，而且换不掉 ripgrep。** 不值得。务实的做法是：给每个 dsh 进程一个真实的、临时的 `$DSH_HOME`（容器里的 tmpfs 或 emptyDir 就够），review 结束后把需要长期保存的结构化结果写进我们自己的 PG，会话日志当短期产物。这也正好回答了 ticket 里「版本风险怎么兜」那条。

---

## 七、自定义工具的实际约束

### 7.1 `ToolDefinition` 写起来的样子

权威文档是 `docs/cookbook/adding-a-tool.zh.md`（「工具编写参考」），它给的最小完整形态：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // 模型看到的就是这句
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // 默认可选
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args 从 schema 推出类型：{ path: string; limit?: number }
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

就这些。`output.schema` 的根可以是对象、数组、标量或 null（不强制对象）。注册是副作用，dispose 插件 fiber 就注销，schema 自动流进系统提示词组装。

要点（都出自同一份 cookbook）：

- **参数已经替你校验完了**：`defineTool` 在 `execute` 前按 `ParameterSchemaSpec` 校验模型给的 `arguments`（类型、必填、字面量、联合恰好匹配一支、嵌套值）。schema 表达不了的（非空字符串、正数、跨字段规则）自己查。**直接注册原始 JSON Schema 的工具要自己做输入校验**（MCP 工具就是这条路进来的）。
- **`execute` 只返回规范无损 JSON**，不返回内容块。注册表快照 → 校验 → 冻结 → 再交给 `output.render(args, value)`。
- **抛异常或返回不合 schema 的值 = `isError`**。基础设施故障抛异常；「进程非零退出」这种领域结果要写成合法的规范值，由渲染器解释。
- **`output.presentationMeta(args, value)`**（可选）把可回放的卡片数据持久化在 `tool/result` 上——`write`/`edit` 的已应用 hunk、`grep` 的 `truncated`/`total` 都走这个。
- **`presentCall` / `presentResult` 必须是纯函数**，因为它们在实时流和**日志回放**时都会跑。cookbook 的原话：「如果你发现自己想在 `presentCall` 内获取文件旧内容或工作目录，请停下」。
- **PTC / Code mode 自动覆盖你的工具**：每个可见工具都能 `await tools.<name>(args)`，`ToolArgsMap` / `ToolOutputMap` 从同一组 schema 派生。所以 cookbook 要求「把 `output.schema` 设计成实用的程序化 API：直接返回句柄与字段」，把给人看的解释放 `output.render`。

第一方参考实现：`packages/shell/tool-bash`（三包结构，terminal 卡片）、`packages/fs/tool-fs`（generic + diff 卡片）、`packages/fs/tool-fs-search`（search 卡片 + 自有上限 + spill）。

### 7.2 结果过大：两套机制，作用点完全不同

**(1) `spill-policy` —— 在工具结果边界上，立刻生效。**

`packages/spill/spill-policy/README.zh.md`：

> 超过 `maxInlineBytes` 的结果会变成**有界的首尾预览，并附带定位信息与取回指引**；完整文本仍可通过已配置的 spill 后端访问。**spill 失败时原始结果仍然可见**，省略 `maxInlineBytes` 则会禁用该策略。

- 单位是 **UTF-8 字节**，**默认是「省略 = 关闭」**；`base` bundle 里配的是 `50000`。
- 同一上限也约束 `run_code` 子调用的持久日志副本，**但不改变程序拿到的值**。
- 后端 `spill-local` 把全文写成会话级私有文件；服务是 `ctx.spillStore`。

**(2) `compaction-tool-result-pruner` —— 只在压缩压力触发时，回溯历史。**

`packages/compaction/compaction-tool-result-pruner/README.zh.md`：

> 压缩触发条件满足后，它会把超出预算的文本替换为长度受限的头部、简短的「middle pruned」标记与长度受限的尾部；低于压力的对话保持不变。**完整原始结果仍保留在会话日志中，可供精确回放与检查。**

默认值在 `src/config.ts:11-13`：`thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`。只接受这三个键。字符预算只是 token 的近似，是否缓解由 `tokenMeter` 判定。

**被截断时模型看到什么**：spill 那条看到「首尾预览 + locator + 取回指引」（即模型知道有更多、也知道怎么取）；pruner 那条看到「头 4096 字符 + `middle pruned` 标记 + 尾 1024 字符」。两条都**不会**让模型误以为结果是完整的。

**(3) 「工具能不能自己声明我的结果很大、请分页」——不能，但有更好的做法。**

`ToolDefinition` 没有这样的声明位。spill 和 pruner 都是**部署策略**，不是工具属性。

第一方的做法是**工具自己拥有上限并如实上报**——`tool-fs-search` 就是范本：README 说「可配置上限约束内联输出；挂载可选 spill 存储后，达到上限的结果仍可完整恢复」，同时它的 search 卡片带 `truncated` / `total`，cookbook 明说这是「使 UI 永不把被截断的结果当作完整结果呈现」。

所以我们的 `gitlab_mr_diff`、`spec_lookup` 这类工具应该：`output.schema` 里带 `{ items, total, truncated, cursor? }`，`execute` 自己截断并如实填写，让模型（和 PTC 代码）能自己翻页。**别指望平台替你分页。**

另外注意 cookbook 的一句话：PTC mode 下「**中间值只存在于执行期间，不会被持久化或按提示词上限截断，也不设字节上限**」——在 `run_code` 里串起来的中间结果不受 spill 约束，只有外层 `run_code` 的日志/结果受约束。这对「取一个大 diff、在代码里过滤、只把结论交出来」是个真实的便利。

### 7.3 「模型可见等价于已记录」对自定义工具意味着什么

这条不变量在 tip 被执行得更严了——连系统提示词都成了会话事件（`docs/subsystems/session.zh.md:57`，`'system/message'`）。

对自定义工具的**具体**约束有三条：

1. **`execute` 的返回值必须是无损 JSON。** `packages/core/session/README.zh.md:104`：追加时用 `snapshotJsonValue()` 对每个嵌套值只读取、校验、复制一次，「因此有状态的 getter 无法给校验提供一个值、给存储提供另一个值」。BigInt、循环引用、稀疏数组、`-0`、特殊原型**在追加位置就被拒**。Date、Map、Set、类实例都要自己序列化。
2. **不能偷偷往模型请求里塞东西。** 任何抵达模型的输入都必须能从日志重建。想加一项模型可见输入，就得有一个对应的会话事件。
3. **展示投影必须可回放**：`presentCall`/`presentResult` 是 `args`（+result）的纯函数，需要结果期事实就走 `output.presentationMeta` 持久化，不能现取。

### 7.4 「注入本次适用的规范清单」：工具调用 还是 `agent.inject()`？

**答案是 `agent.inject()`，而且它根本不需要扩展 `SessionEventMap`。**

tip 的 `docs/subsystems/session.zh.md:48-55` 把 `user/message` 的三种来源写死了：

> A user-role message on the model-visible surface: a direct human prompt (the queued message claimed for this turn), **a synthetic `agent.inject()` context (file-change notices, subdir AGENTS.md, skill content, cron notifications, …)**, or an entered goal continuation round. All three project their `content` verbatim; `source` tells them apart.

也就是说 **`agent.inject()` 已经是一等公民**：它产生一条普通的 `user/message` 事件，靠 `source` 与人类输入区分，内容逐字进入 surface。cookbook 给的调用形式（`adding-a-tool.zh.md`，`execute` 约定那一节）：

```ts
exec.agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })
```

> 追加持久化上下文，**下一次模型请求会看到它——这不是唤醒**（空闲的 agent 保持空闲）。请防范已 dispose 的 agent（try/catch）。

**两者的差别，逐条：**

| | 做成工具调用（`spec_lookup`） | 走 `agent.inject()` |
|---|---|---|
| 谁决定要不要 | **模型**。它得先想到去查 | **我们**。确定性，不依赖模型自觉 |
| 消耗 | 一个额外的 step（一次模型请求 + 一次工具执行） | 零额外请求 |
| 时机 | 模型想查的时候 | 下一次 pre-step，或轮次开始前 |
| 会话事件 | `tool/call` + `tool/result` 一对 | 一条 `user/message`，`source.kind: 'plugin'` |
| 结果大小治理 | 受 spill / pruner 约束 | **不受**——inject 的内容是 `user/message`，只会被整体压缩遮蔽 |
| 模型能不能重复取 | 能，随时再调一次 | 不能，除非我们再 inject 一次 |
| 唤醒空闲 agent | 不适用 | **不唤醒** |

**对「本次适用的规范清单」的具体建议：**

- **清单本体走 `agent.inject()`**：一次评审要遵守哪几条规范是我们的编排决策（ticket 12「动态规范选取」就是干这个的），不该赌模型会去查。在 `agents.create()` 之后、发第一条 `followup` 之前 inject 一次即可，成本是零额外请求。
- **规范全文走工具**：清单里每条规范的完整正文按需拉取，做成 `spec_get(id)` 工具，这样受 spill 约束、不会一次撑爆上下文，模型也能自己决定深挖哪几条。
- **`SessionEventMap` 扩展留给「产出」而不是「输入」**：`review/finding`、`review/decision` 这类**我们要结构化读回**的东西才值得扩展会话事件——因为那是我们从日志里投影出结构化结果的唯一干净通道（也是 4.5 表里「进程内驱动」那一栏唯一打勾的原因）。规范清单是输入，`user/message` 已经承载得很好，不用再造事件类型。

这也顺带解释了为什么 skill 系统走的是同一条路：cookbook 那句枚举里 **`skill content` 就在 `agent.inject()` 的括号里**。规范清单和 skill 是同一类东西，用同一个机制是对的。

---

## 八、破坏性变更的实际节奏

### 8.1 版本节奏：24 天 16 个 tag

没有 CHANGELOG（全仓 find 无命中）。用 tag 和 git 统计：

| tag | 日期 | 距上个 tag 的 commit | 文件变更 | 插入 | 删除 |
|---|---|---|---|---|---|
| dsh-v0.1.0-rc.7 | 2026-08-17 | — | — | — | — |
| dsh-v0.1.0-rc.8 | 2026-08-19 | 536 | 1604 | 54064 | 10533 |
| dsh-v0.1.1-rc.1 | 2026-08-21 | 172 | 2368 | 23679 | 11723 |
| dsh-v0.1.1-rc.2 | 2026-08-21 | 35 | 431 | 8101 | 2039 |
| dsh-v0.1.2-alpha.1 | 2026-08-28 | **1079** | **6421** | **323745** | **126827** |
| dsh-v0.1.2-alpha.2 | 2026-08-30 | 234 | 1604 | 27862 | 14050 |
| dsh-v0.1.2-alpha.3 | 2026-08-31 | 117 | 1034 | 11034 | 11047 |
| dsh-v0.1.2-alpha.4 | 2026-09-01 | 297 | 2371 | 28958 | 21093 |
| dsh-v0.1.2-alpha.5 | 2026-09-02 | 6 | 280 | 1752 | 305 |
| dsh-v0.1.2-rc.1 | 2026-09-03 | 2 | 252 | 252 | 252 |
| dsh-v0.1.3-alpha.1 | 2026-09-04 | 328 | 2051 | 60491 | 27277 |
| dsh-v0.1.3-alpha.2 | 2026-09-07 | 316 | 3790 | 46421 | 15866 |
| dsh-v0.1.5-alpha.1 | 2026-09-08 | 563 | 2552 | 78538 | 12512 |
| dsh-v0.1.5-alpha.2 | 2026-09-09 | 262 | 1471 | 30992 | 11202 |
| dsh-v0.1.5-rc.1 | 2026-09-10 | 17 | 373 | 1209 | 722 |
| dsh-v0.1.5-rc.2 | 2026-09-10 | 4 | 334 | 1050 | 1050 |

**16 个 tag / 24 天 = 平均 1.6 天一个版本。** 仓库首个 commit 2026-06-10，至 tip 共 13147 个 commit。

**标了 breaking 的有几次？** 没有 CHANGELOG（全仓 `git ls-tree` 无 changelog / release-notes 文件），commit message 里也没有一条含 `BREAKING CHANGE`。有的是 7 条 conventional-commit 的 `!` 标记（`0.1.1-rc.2..0.1.5-rc.2` 区间）：

| commit | 日期 | 标题 |
|---|---|---|
| `fd7f2065b2` | 08-27 | `refactor(apiproxy)!: remove settings and credentials RPCs` |
| `6e4087626d` | 08-27 | `refactor(apiproxy)!: remove directory-picker RPCs` |
| `bec6805d6a` | 08-28 | `refactor(session-persistence)!: handle-based seam with a lifecycle-owned write path` |
| `f99b06eaed` | 09-01 | `feat(session)!: embed assistant streams in format v2` |
| `d1521ea783` | 08-31 | `feat(session)!: add released format migration` |
| `27bf1039db` | 08-31 | `refactor(session)!: distinguish event seqs from log offsets` |
| `4553c9d957` | 08-31 | `refactor(session)!: remove SQLite persistence backend` |

七条全部集中在 session 持久化和 apiproxy 两处。**但 8.2 和 8.3 里那些真正会打到我们的变更——`client/runtime` 整包删除、Slot 插槽表删两个、`ui-primitives` props 加必填参数、包形态改变——一条 `!` 标记都没有。** 所以这 7 条不能当成破坏性变更的清单，只能当成「作者在 session 域比较自觉」的证据。没有 deprecation 周期。

### 8.2 包的增删：最硬的指标

`packages/<family>/<leaf>` 的目录集合逐 tag 比：

| tag | 包总数 | 新增 | 消失 |
|---|---|---|---|
| dsh-v0.1.0-rc.7 | 219 | — | — |
| dsh-v0.1.0-rc.8 | 226 | 9 | 2 |
| dsh-v0.1.1-rc.1 | 227 | 1 | 0 |
| dsh-v0.1.1-rc.2 | 227 | 0 | 0 |
| dsh-v0.1.2-alpha.1 | 247 | **25** | **5** |
| dsh-v0.1.2-alpha.2 | 251 | 4 | 0 |
| dsh-v0.1.2-alpha.3 | 250 | 1 | 2 |
| dsh-v0.1.2-alpha.4 | 249 | 1 | 2 |
| dsh-v0.1.3-alpha.1 | 255 | 6 | 0 |
| dsh-v0.1.3-alpha.2 | 258 | 3 | 0 |
| dsh-v0.1.5-alpha.1 | 265 | 7 | 0 |
| dsh-v0.1.5-alpha.2 | 267 | 3 | 1 |
| dsh-v0.1.5-rc.2 | 267 | 0 | 0 |

**24 天里新增 60 个包、删除 12 个包。**

只看我们关心的那次升级（`0.1.1-rc.2` → `0.1.5-rc.2`，20 天，3225 commit，10455 文件，+568227/−198126）：**新增 49 个包，删除 9 个包**。删掉的是：

```
packages/client/runtime                    ← 40 个 client 包里 30 多个依赖它
packages/host/apiproxy                     ← 整个 /api RPC map（57 个方法）
packages/session/session-persistence-sqlite
packages/subagent/tool-subagent-report
packages/code-runtime/code-runtime-python
packages/examples/{acp-demo,agent-spine-demo,jsonrpc-demo}
packages/test-support/acp-snapshot
```

`packages/client/runtime` 拆成了 `client/resources` + `client/store`；`packages/host/apiproxy` 换成了 `packages/api/{session-controller,settings-controller,workspace-controller,workspace-files}` 四个 Typert Remote 控制器。**手写 RPC map 被整体删掉换成生成式 Remote，这是最大的一次面变更。**

### 8.3 三样东西各自变过几次

**(1) `SESSION_FORMAT_VERSION`：0 → 3，20 天里 3 次。**

`packages/core/session/src/types.ts:88` @tip：`export const SESSION_FORMAT_VERSION = 3`（@0.1.1-rc.2 是 `0`）。

**但同时新增了 5 个迁移包**：`session/session-format`、`session-format-catalog`、`session-format-v0-to-v1`、`session-format-v1-to-v2`、`session-format-v2-to-v3`。`packages/session/session-format/README.zh.md`：「纯函数式相邻 Session 格式规划……在只消费一次物理行的同时组合唯一的相邻迁移序列」。

**这条是好消息**：前一次调研说「`SESSION_FORMAT_VERSION = 0`，预发布阶段不做迁移，版本不符直接拒绝」——dsh 现在有了完整的相邻迁移链。ticket 里「长期保存 review 会话日志升级后读不回」这个风险，dsh 自己补上了。不过 `packages/core/session/src/index.ts:100-101` 仍然是版本不符直接抛错，迁移要显式走 catalog。

**(2) config 格式：结构没变，条目大改。**

`cordis.patch.yml` 的顶层语法（按 id 替换 config、`insert`、`disabled`、`!!js`、`cordis:group` + `isolate`）在两个 tag 之间是稳定的。变的是**条目内容**：`web-app` bundle 里被删掉的 `api-gateway`（指向已删除的 `dsh-host-apiproxy`）、新增的一批行。**自己的 patch 文件里凡是按 id 引用 dsh 条目的，每次升级都要核对 id 还在不在。**

**(3) 插件 API：公开面在 20 天里至少 6 处破坏性变更。**

| 面 | 变化 |
|---|---|
| Slot 插槽表 | 48 → 61 个。`conversation`（single）和 `details` 被**删除**，`main`（keyed）与 `rightbar` 新增——一个公开插槽被删、语义被换 |
| `ui-slots` 核心 | `src/index.ts` +89 行、`store.ts` 大改、`renderer.ts` 改 129 行 |
| `ui-renderer` | `session-provider.tsx` 整个删除（160 行），新增 `bindings.tsx` / `registry.ts` |
| `PLATFORM_MODULES` | 3 个 dsh 包 → 5 个（新增 `dsh-client-store`、`dsh-client-ui-dockkit`） |
| `ui-primitives` 组件 props | 普遍新增**必填** `labels`（`DiffBlockProps.labels: DiffBlockLabels` 等）——每个调用点都要改 |
| `ui-primitives` 包形态 | 19 个 runtime dependency → `dependencies` 为空、全部打进 bundle |
| `/api` RPC | `host/apiproxy` 整包删除，`PRIVILEGED_METHODS` Set 删除 |

### 8.4 一句话结论

> **以 dsh 为内核，平均每 1.6 天一个新版本；跨 4 个小版本、20 天的一次真实升级里，它删掉了 9 个包（含我们会依赖的 `client/runtime` 和 `host/apiproxy`）、新增 49 个、改动 10455 个文件，Slot 插槽表删了 2 个公开插槽、会话日志格式跳了 3 版、组件 props 普遍加了必填参数——而这一切没有 CHANGELOG、没有 breaking 标记、没有 deprecation 周期。** 官方自己给出的应对方式写在 `apps/desktop/README.zh.md` 里：**版本精确锁死，dsh 升级就重新发布整个产品**。

---

## 九、复用 UI 的真实收益

### 9.1 两个数字

先说结论：

- **只借底层组件、不用 Slot 体系：能复用 4 个包**（`ui-primitives`、`ui-slots`、`ui-store`、`ui-dockkit`），外加 `ui-theme` 的 token CSS 文件（不是包，是抄 4 个 css 文件）。
- **用 Slot 体系整页扩展：直接有用的约 12 个，间接受益（作为运行时依赖必须装、但不是我们的产品面）约 20 个，明确无用或必须 `disabled` 的约 20 个。**

「4 个」这个数字不是估的：它就是 `PLATFORM_MODULES` 里的 dsh 包集合（`packages/client/web/src/platform.ts:8-14`），也正好是设计上被定义为「无运行时身份、可静态链接」的那一批。

### 9.2 为什么「只借组件」只有 4 个

`ui-primitives` @tip 的 `package.json`：`dependencies` **为空**，`peerDependencies` 只有 `@deepseek-ai/cordis`（还只被 type-only 的 `/invariant` 子路径用到），shiki / micromark / katex / anser / clsx 全在 `devDependencies` 里被打进 `lib/index.js`。MIT，`publishConfig.access: public`。

也就是说 `npm i @deepseek-ai/dsh-client-ui-primitives` 进任何 React 18 应用是通的，代价只是把 `ui-theme/src/styles/*.css` 的 token 抄过去。`ui-slots`（1563 行，零 React 运行时、零 cordis）、`ui-dockkit`（分栏 / 停靠引擎 + React 组件，描述里自己写 zero cordis）、`store`（React-free observable + zustand/immer）同理。

**除这 4 个之外的所有 `dsh-client-*` 包都不能脱离 dsh 运行时用。** 证据：@tip 它们的 `dependencies` 几乎全空、`peerDependencies` 只有 cordis——因为跨包引用改成了由 `dsh.client.external` 在模块图里解析（`packages/client/tsdown.client.ts`、`packages/client/modules/README.zh.md`）。@0.1.1 时它们还有真实的 workspace 依赖表；现在没了，意味着**脱离 dsh 的模块加载器它们连 import 都解析不了**。

### 9.3 逐包判定（以 `dsh-v0.1.5-rc.2` 的 52 个包为准）

「评审导航 + 规范表 + 统计看板 + diff 视图」这个产品面下：

**A. 有用，直接复用（可脱离 dsh 用）——4 个**

| 包 | 用途 |
|---|---|
| `ui-primitives` | markdown、shiki 高亮、`ReadBlock` 行号视图、按钮/菜单/Modal/Toast/Tooltip、文件类型图标、JSON inspector |
| `ui-slots` | 只在走 Slot 体系时需要；单独用意义不大 |
| `ui-dockkit` | 分栏 / 停靠 / tab 引擎。**diff 视图左右分栏、评审导航多面板，这个是现成的** |
| `store` | zustand/immer 的 observable 约定；用不用无所谓，可换 |

**B. 有用，但必须在 Slot 体系内（走路线 A 才算数）——8 个**

| 包 | 对本产品的价值 |
|---|---|
| `ui-layout` | 提供 `main` / `sidebar` / `rightbar` / `shell.overlay` 四个席位——**整页扩展的地基** |
| `ui-sidebar` | 提供 `sidebar.panellist`（面板入口）和 `sidebar.footer.action` |
| `ui-renderer` | Slot → React 的绑定与 app root |
| `ui-sidebar-right` | 右栏停靠面 + `ctx.sidebarRightTabs` tab 类型注册表——**「在 diff 旁边开一个规范 tab」的现成机制** |
| `ui-sidebar-files` | 工作区文件树（走 `workspaceFiles` Remote，懒加载目录） |
| `ui-sidebar-documentpreview` | 文件预览注册表：markdown / 高亮代码 / 图片 / PDF / HTML / 纯文本，**可扩展**（能把 diff 注册成一种预览类型） |
| `ui-theme` | `--dsw-*` token + 亮暗 + 字号设置行 |
| `locale` | 中英字典 + Host 侧偏好持久化 |

**C. 要改才有用 / 只在保留 chat 时有用——约 20 个**

`connection`、`resources`、`modules`、`web`、`ui-conversation`、`ui-chat`、`ui-session`、`ui-tool`、`ui-approval`、`ui-commands`、`ui-input-trigger`、`ui-reference`、`ui-user-questions`、`ui-attachment`、`ui-file-upload`、`ui-workspace`、`ui-settings` 系 5 个。

这些是「保留 chat 就必须留着」的运行时底座。其中 `ui-trajectory`（虚拟表格 + 搜索索引）是**唯一值得为了它的实现而读源码的**——规范表的虚拟滚动大表可以照着写，但不能直接复用（它绑死在 session 作用域的会话事件上）。

**D. 明确无用，建议 `disabled: true`——约 20 个**

`ui-goal`、`ui-plan`、`ui-jobs`、`ui-skill`、`ui-subagent`、`ui-workflow-run`、`ui-schedule`、`ui-agent-preset`、`ui-permission-presets`、`ui-model-selection`、`ui-message-feedback`、`ui-deliverables`、`ui-brand-official`、`ui-open-in-app`、`ui-directory-picker-native`、`ui-directory-picker-browse`、`ui-settings-plugins`、`ui-settings-plugin-inventory`、`ui-settings-models`、`hmr`、`extensions/ui-cordis`。

其中 `ui-directory-picker-*`、`ui-open-in-app`、`ui-settings-models`（管本机凭据）在多租户下不只是无用，是**必须关掉**：它们驱动的是运行 dsh 进程那台机器的桌面和配置，暴露给租户就是提权。

### 9.4 「几人月」这个估算要打折

前一次调研写「这一套 UI 自己写至少几人月」。精确一点：

- 真正省掉的是 **chat 的流式渲染 + 工具卡片 + 审批弹窗 + markdown/高亮**，这部分确实是几人月，但**只在保留 chat 交互时才省**。
- **评审导航、规范表、统计看板、diff 视图这四块，dsh 一行都没有。** 能借的是组件库层（4 个包）和两三个可以照着写的实现（trajectory 虚拟表、documentpreview 注册表）。
- 如果产品主界面不是 chat，「复用 dsh 的 40 个 UI 包」的实际收益 ≈ **一套设计 token + 一个组件库 + 一个分栏引擎 + 一个 markdown/高亮实现**，也就是省掉 1～2 人月，不是几人月。

---

## 十、三选一

### 候选 A：完全在 dsh 的插件体系内建整个产品

形态：我们的产品 = 一个 profile + 若干 bundle。左栏加面板入口，中栏加评审导航 / 规范表 / 看板三个 `main` 面板，diff 视图自己写成一个面板或右栏 tab；后端能力写成 host 插件（GitLab 适配、PG 访问、队列）；认证与多租户用 `isolate` realm 里的第二个 WebServer 接管对外流量，dsh 的 `/api` 与自带 UI 要么钉死 loopback 要么整体 `disabled`。

**要动 dsh 的部分：零。** 全部是 patch 条目 + 自己的插件包（甚至可以是相对路径的 `.mjs`）。

**能复用**：Slot 整页体系（`main` / `sidebar.panellist` / `rightbar` / `shell.overlay`）、`ui-layout` 三栏框架、`ui-sidebar-right` 的 tab 注册表、`ui-sidebar-files` 文件树、`ui-sidebar-documentpreview` 预览注册表、`ui-theme` token、`locale`、`connection` 的整条前后端 RPC 管线（Typert `@Remote` 加新 RPC 自动生成两侧类型）、`ui-primitives`、`ui-dockkit`、chat（如果保留）、`webhook` 骨架、agent preset、`ctx.agents` 全接口。粗算 **20 个包直接或间接复用**。

**升级时会疼在哪**：疼在全部。`client/runtime` 这种「30 多个包都依赖」的底座说没就没；Slot 类型链体操 + `PropsRuntime<K>` 的类型来自 SlotMap declaration merging，dsh 改一个插槽名我们编译不过；`PLATFORM_MODULES` 变了要重打包；组件 props 加必填参数每个调用点都要改。等于**把产品的 UI 层和 RPC 层的生命周期绑死在一个每 1.6 天发一版、无 CHANGELOG 的 Developer Preview 上**，官方自己的结论是版本锁死、跟着发版。

### 候选 B：自己的服务包裹 dsh，只借它的 UI 底层组件

形态：自己的 web 服务（认证 / 多租户 / PG / 队列 / GitLab）+ 自己的 React 前端；前端 `npm i` dsh 的 4 个平台包当组件库用；dsh 作为 worker，走 ACP 或一租户一进程的进程内驱动。

**要动 dsh 的部分：零**（只是 npm 依赖）。

**能复用**：`ui-primitives`（markdown / shiki / ReadBlock / 控件 / 图标）、`ui-dockkit`（分栏停靠）、`store`、`ui-slots`（可不要），加 `ui-theme` 的 476 行 token CSS。**4 个包。** 外加可以照着写（不是复用）的 `ui-trajectory` 虚拟表、`ui-sidebar-documentpreview` 预览注册表、`highlight.ts` 的 shiki 懒加载配置。

**升级时会疼在哪**：疼面很小，但不是零。`ui-primitives` 的 props 在 20 天里加了必填 `labels`，包形态从「19 个 runtime deps」变成「全量 bundle」——这两个都是会让 `npm update` 后编译不过的变更。好处是**疼的范围可以被一次 `pnpm outdated` 圈住**，而且可以选择不升级（组件库锁在某个版本几个月完全可行，内核 dsh 另行升级）。

### 候选 C：自己的服务包裹 dsh，UI 完全自建

形态：同 B，但组件库也自己选（比如 shadcn + CodeMirror/Monaco + react-diff-view）。

**要动 dsh 的部分：零。**

**能复用**：0 个 UI 包。只用 dsh 的引擎侧（agent loop、tools、session、LLM、compaction、subagent、sandbox、skill、preset、webhook）。

**升级时会疼在哪**：只疼在驱动接口（ACP 的方法表、或进程内的 `ctx.agents` / `SessionEvent`）和 `SESSION_FORMAT_VERSION`。前者是三条路里最稳的（ACP 是外部标准协议，dsh 只是实现方），后者现在有迁移链。**疼面最小。**

### 推荐：B，并且把 A 的一半能力留在手里

**选 B。** 理由三条，按权重排：

**(1) 产品面和 dsh 的 UI 面重叠得太少，不值得为它承担版本耦合。** 主界面是评审导航、规范表、统计看板、diff 视图——dsh 这四块一行都没有；能省的是组件库和 markdown/高亮，1～2 人月。而 A 的代价是把整个前端和 RPC 层绑在一个 24 天发 16 版、删了 9 个包、没有任何破坏性变更标注的仓库上。**用 1~2 人月的节省换一个持续的升级税，不划算。**

**(2) 真正值钱的复用在引擎侧，而引擎侧 B 和 A 拿到的一样多。** agent loop、事件溯源会话、工具系统、compaction、subagent 并行、sandbox、agent preset、skill、`webhook` 骨架——这些在 B 里一样能用（一租户一进程 + 进程内驱动，或 ACP）。Slot 体系不是引擎，是外观。

**(3) 部署硬指标站在 B 这边。** ticket 里那条「一条 docker compose 起来、不要求先有数据库和队列」在 A 下很难：A 意味着运行时要有一个可写的 profile 目录、pnpm store 和 `node_modules`（`apps/desktop` 为此专门做了离线 seed、事务式激活和 rollback profile），我们的产品插件还得进这个依赖图。B 下 dsh 就是镜像里一个固定版本的可执行体，我们的服务是另一个进程。

**但要留住 A 的两个口子**，因为它们成本低、价值高：

- **`main` + `sidebar.panellist` 这个整页席位留着不用，但保持可用**：如果将来要给「和 AI 讨论一处代码」这种 chat 交互一个入口，直接跑一个 dsh web 实例、把我们的评审面板注册进去，比在自己的前端里重写 chat 便宜得多。这是 B 的逃生舱。
- **`webhook` + `isolate` realm 第二个 WebServer 这套照抄**：GitLab webhook → 创建 review Session 这条链，dsh 给了骨架和一个 GitHub 实现。即使 UI 完全自建，这一层也值得走 dsh 的路子（前提是队列、重试、去重在我们自己的服务里，dsh 那层只做 fire-and-forget 派发——它自己的 README 就是这么划的界）。

### B 的内部还有一个选择：进程外驱动 还是 进程内嵌入

第五节的结论（**可以直接 in-process 嵌入**）把 B 劈成了两个变体，差别不小：

| | **B1 进程外**：我们的服务 ↔ dsh 进程（ACP） | **B2 进程内**：我们的 Node 服务自己 `boot()` 起 dsh 的 cordis 树 |
|---|---|---|
| 隔离 | 天然。崩溃、吃满 CPU、`process.exit` 都不影响我们的服务 | 无。dsh 的插件和我们的服务同生共死 |
| 按任务选 agent preset | **不能**（4.5 表） | **能**（`agents.create()` 时 join preset） |
| 结构化 finding | 只能从 ACP 语义更新里猜 | **能**（扩展 `SessionEventMap`，从日志投影） |
| 自定义工具 | 要进 dsh 的 profile 依赖图 | 一个 `ctx.tools.register()`，就在我们的代码里 |
| 取消 | `session/cancel` | `agent.cancel()` |
| 多租户 | 一租户一进程，干净 | 要么一租户一进程（等于 B1 的隔离但没它的好处），要么多 Context（`$DSH_HOME`、`process.cwd()`、CPU 都还是进程级，见 5.6/5.7） |
| 版本耦合 | 只耦合 ACP 方法表（外部标准协议） | 耦合 `boot()`、`ctx.agents`、`SessionEvent`、cordis 的整个插件 API |
| 语言约束 | 无，服务端可以不是 Node | 服务端必须是 Node，且版本要和 dsh 对得上 |

**建议 B1 起步，把 B2 当明确的升级路径。** 先用 ACP 把「发起评审 / 流式进度 / 取消」跑通，结构化 finding 先用「让模型按固定 JSON schema 输出 + 我们解析」这种土办法兜着。等到这个土办法真的开始漏（模型不守格式、需要 per-repo preset、需要 finding 级别的审计回放），再切 B2——切换点是清晰的，因为 B2 的驱动代码就是 `bundle/headless/src/index.ts` 那 40 行的变体（5.4）。

**部署上有一条 6.2 带来的硬约束，两个变体都躲不掉**：`grep` / `glob` 走的是打包的 ripgrep 二进制 + `ctx.subprocess`，不走 `ctx.fs`。所以**被评审的仓库 checkout 必须落在一个真实的、dsh 进程能用真实路径访问的文件系统上**。docker compose 下这就是一个挂给 dsh 容器的 volume（或 tmpfs），不是一个可以用对象存储替掉的东西。同理，`$DSH_HOME` 也给每个 dsh 进程一个真实目录（容器内的 emptyDir/tmpfs 就够），会话日志当短期产物，结构化结果落我们自己的 PG。

**关于隔离**：一租户一进程，每进程独立 `$DSH_HOME` 和 `DSH_AGENTS_HOME`（后者别忘了，它默认在 `~/.agents`，不在 `$DSH_HOME` 下，见 3.5）。同租户内多会话可以共进程（`ctx.agents` 按 SessionId 分桶是安全的），但 sandbox `workspaceRoot` 是进程级的（3.6），**跨仓库评审要么一仓一进程，要么靠 `permissionPreset: read-only` + `ctx.tools.restrict()` + `ctx.tools.guard()` 三层兜底**——6.3 说清楚了为什么不能指望 sandbox。

**关于规范注入**（7.4 的结论，落到产品上）：本次评审适用的规范**清单**用 `agent.inject()` 在发第一条 prompt 之前推进去（确定性、零额外模型请求、和 skill 走同一条路）；每条规范的**全文**做成 `spec_get(id)` 工具按需拉（受 spill 约束，不会撑爆上下文）。我们自己的工具（`gitlab_mr_diff`、`spec_lookup`、跨仓关联查询）的 `output.schema` 要自带 `{ items, total, truncated, cursor? }`——平台不替你分页（7.2）。

**版本策略**：dsh 锁 tag，不跟 `latest`；组件库（那 4 个包）和内核 dsh 分开锁、分开升。升级前必做的检查有两条，都很便宜：

```sh
# 1) 包目录集合的增删——最硬的破坏性变更探针
diff <(git ls-tree -r -d --name-only <old> packages/ | awk -F/ 'NF==3') \
     <(git ls-tree -r -d --name-only <new> packages/ | awk -F/ 'NF==3')
# 2) 我们真正依赖的那几个面
git diff --stat <old> <new> -- packages/acp packages/core/session packages/core/tools \
                                packages/boot/app-boot packages/client/ui-primitives
```
