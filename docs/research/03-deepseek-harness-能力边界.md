# DeepSeek Harness (dsh) 作为 Web Code Review 产品基座的能力边界

> # ⚠️ 本文多处结论已作废（2026-09-12）
>
> 本次调研读的是本地工作树的 `dsh-v0.1.1-rc.2`（2026-08-21）。后来发现**该工作树落后仓库 3225 个 commit**，最新 tag 是 `dsh-v0.1.5-rc.2`（2026-09-10）。二十天里改了 10455 个文件、删了 9 个包、新增 49 个。
>
> **以下三条核心结论已被 [dsh 嵌入形态](13-dsh-嵌入形态.md) 用最新 tag 的源码推翻：**
>
> | 本文的说法 | 最新真相 |
> |---|---|
> | 特权 RPC **永久钉死 loopback** | **已有认证**。0.1.5 新增启动令牌换 HMAC 签名 HttpOnly cookie，硬编码的特权方法集整个删除。但官方明说认证不等于支持网络部署、TLS、转发 header、反代——**多租户仍然 100% 自建**。 |
> | Slot 只能往 chat 页面里塞东西 | **可以整页扩展**。中栏从单席位的 `conversation` 换成了 keyed 且 root 作用域的 `main`，另有 `sidebar.panellist`。README 明说默认组合不注册示例面板，**这个席位就是留给第三方的，纯加法、零 dsh 改动**。 |
> | 会话日志格式版本 0，**明确不做迁移** | **有迁移了**。`SESSION_FORMAT_VERSION` 从 0 跳到 3，配套 5 个迁移包。 |
>
> 其余结论（agent 循环、工具系统、subagent、压缩、LLM 接入的机制描述）多数仍然成立，但**任何基于本文做的决策都应该对照那份新调研复核一遍**。
>
> 教训记在这里：**读一个高速迭代的仓库之前，先确认工作树是不是最新的。**


- 对应 ticket：[deepseek-harness 作为 agent runtime 的能力边界](03-deepseek-harness-能力边界.md)
- 调研时间：2026-09-11
- 被调研版本：`0.1.1-rc.2`（tag `dsh-v0.1.1-rc.2`），Developer Preview，README 明确声明未来会有破坏性变更
- 许可证：MIT
- 规模：`packages/` 下 227 个 leaf 包（其中 `packages/client/` 40 个浏览器端插件包）+ 2 个 app（`apps/cli`、`apps/web`）+ `vendor/`（vendored Cordis）+ `python/`（Python SDK）+ `native/landlock-run`

---

## 1. 整体架构

### 1.1 Monorepo 布局

`pnpm-workspace.yaml` 定义 workspace 成员：

| 目录 | 角色 |
|---|---|
| `vendor/*` | vendored 框架（cordis、cosmokit、schemastery），通过 `overrides` 强制 link 到本地源码 |
| `packages/*/*` | **两级目录**：`packages/<family>/<leaf>`，如 `packages/core/agent-loop`。family 层只有 README，不是包 |
| `apps/cli` | 拥有 `dsh` bin（`apps/cli/src/bin.ts`） |
| `apps/web` | Vite 构建的浏览器 SPA 入口，本身极薄（`apps/web/src/main.ts` 只有 8 行） |
| `examples` | 单个 workspace 成员，仅作依赖解析根；各 leaf 的 `cordis.yml` 是可运行组装，不是构建目标 |
| `website` | VitePress 文档站 |
| `python/sdk-runtime` | 单文件可执行体的部署根 |

关键包族：`core`（agent / agent-loop / session / tools / system-prompt / scope）、`llm`、`client`（40 个 UI 插件）、`host`（webserver / apiproxy / frontend-static / plugin-inventory / directory-picker）、`api`（gateway / remotes）、`bundle`（base / web-app / headless）、`boot`、`session`、`session-query`、`subagent`、`compaction`、`fs`、`shell`、`terminal`、`sandbox`、`storage`、`skill`、`workflow`、`goal`、`plan`、`jobs`、`schedule`、`mcp`、`hooks`、`acp`、`sdk`、`typert`、`e2b`、`experimental/agent-team`。

### 1.2 Cordis 模型的落地方式

参考 `docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/user/develop/framework/`。五条规则：

1. **插件 = 实现 Service 的对象**。函数（带可选 `inject` + `apply(ctx)`）、对象、或 `Service` 子类三种形态皆可。
2. **Context 是服务容器**。一个服务占一个稳定的 `ctx.<key>`（`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.agents`、`ctx.fs`、`ctx.shell`、`ctx.subagents`、`ctx.compaction`、`ctx.skills`、`ctx.jobs`、`ctx.storage` 等）。消费方按 key 查找，从不 import 具体实现。
3. **`inject` 声明依赖**。加载顺序由服务可用性驱动，没有手写启动序列。
4. **类型化事件**。通过 TS declaration merging 扩展 `Events`，四种分发模式 `emit` / `waterfall`（环绕中间件，监听器收 `(...args, next)`）/ `parallel` / `serial`。模式是公开约定，用 `@mode` JSDoc 标注，生成的目录会交叉校验。
5. **注册是可逆副作用**。每个 `ctx.effect()` / `ctx.on()` 都返回 disposer，reload / teardown 自动撤销。这是 HMR 能工作的根因。

**不存在特权内核**：模型适配器、工具注册表、会话日志、甚至 agent loop 本身都是插件，都能从配置替换。

### 1.3 Profile / Bundle / Patch 三层组装（最重要的机制）

这是 dsh 区别于普通 monorepo 的地方，也是二次开发的主入口。

- **组合包（bundle）** = npm 包 + 一个 `cordis.patch.yml`，`package.json` 里声明 `dsh.bundle.patch`。
- **profile** = `$DSH_HOME/profiles/<name>/` 目录，`package.json` 声明 `dsh.profile.bundles`（有序列表）加自己的 `cordis.patch.yml`。

叠加顺序（在空条目列表之上）：

```
profile 的 bundles 顺序 → profile 自己的 cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml → 每个 --patch overlay（argv 顺序）
```

patch 按 `id` 定位条目并**整体替换 config**（不是深合并），或 `insert` 新条目。

三个交付 bundle：

- `packages/bundle/base/cordis.patch.yml`，约 400 行，所有 profile 的第一层：LLM 适配器、工具、持久化、沙箱与审批、settings、credentials、遥测。
- `packages/bundle/web-app/cordis.patch.yml`，浏览器表层加 host 行加 40 个 client 插件名录，并把 agent 平面的行全部 disable，改由 agent preset 承载。
- `packages/bundle/headless/cordis.patch.yml`，一次性任务，不挂 server。

排查工具：`dsh --profile web --dump-config` 打印实际组装的整棵树，打印出的任何条目都能被自己的 patch 替换。

`!!js` 表达式节点（`@deepseek-ai/cordis-plugin-include`）让 config 可以读环境、读已注入的服务：

```yaml
- id: webserver
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
```

---

## 2. Agent 循环

### 2.1 主循环位置

| 包 | 职责 | ctx key |
|---|---|---|
| `packages/core/agent` | `Agent` 接口、活跃注册表、initiator scope、`agent/*` 事件词汇 | `ctx.agents` |
| `packages/core/agent-loop` | 唯一具体 driver 实现 | `ctx.agentLoop` |
| `packages/core/session` | 事件溯源日志加内存 store | `ctx.sessions` |
| `packages/core/system-prompt` | 提示词片段加工具 schema 组装 | `ctx.systemPrompt` |
| `packages/core/tools` | 作用域化工具注册表加执行流水线 | `ctx.tools` |
| `packages/core/scope` | 零依赖 scope 原语 | 库，无 ctx key |

主循环代码在 `packages/core/agent-loop/src/agent.ts`（515 行，`ReactLoopAgent` 类，私有方法 `turn()` / `step()` / `preStep()` / `buildRequest()`）和 `packages/core/agent-loop/src/index.ts`（713 行，`AgentLoop extends Service implements AgentFactory`，`static inject = ['agents','sessions','llm','tools','systemPrompt']`）。

**扩展插件只依赖 `dsh-agent`，从不依赖 `dsh-agent-loop`**，循环因此可整体替换。

### 2.2 轮次流程

```
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)      [waterfall]
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message   [waterfall]
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping              [serial]
turn/end
```

**step** 是一次模型请求加它调用的工具；**turn** 是零或多个 step。`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久会话事件，其余是三个事件域的实时扩展点。waterfall 事件有 `agent/pre-step`、`agent/request`、`agent/request-error`、`llm/stream`、三个 `tools/*`；serial 事件是 `agent/turn-stopping`。

### 2.3 会话与消息的数据结构

**唯一真源是仅追加的 `SessionEvent` 日志**（`packages/core/session/src/types.ts`，440 行）：

```ts
type SessionEvent<T> = {
  type: K; seq: number; time: number; data: SessionEventMap[K]
  ignorable?: true
} & (K extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
```

`SessionEventMap` 核心成员：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`（token 级回放保真）、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`。插件通过 declaration merging 扩展（compaction 加 `compaction/*`，hooks 加 `hook/*`，agent-presets 加 `agent-preset/selected`，subagent / goal / plan / schedule 各自加）。

**核心不变量：模型可见等价于已记录。** 任何抵达模型请求的东西都必须能从日志重建，并由运行时不变量断言。新增一项模型可见输入就必须新增一个会话事件。这对 code review 产品是好事（可审计、可回放），但也意味着不能偷偷往请求里塞东西。

**Surface 机制**：只有 `user/message`、`assistant/message`、`tool/result` 三种事件能上 surface（即产生 LLM 消息）。`surfaceOp` 为 `'append'` 或 `{ op: 'replace', start, end }`，后者正是压缩用来遮蔽历史的机制。`deriveMessages()` 从日志投影出模型历史，从不单独存储。

`SessionHeader`（日志之外的元数据）：`version`、`id`、`createdAt`、`cwd`、`parentSession`（fork 血统）、`seedLength`、`origin: 'subagent'`、`delegationDepth`、`agentPreset`。

`Agent` 句柄接口（`packages/core/agent/src/runtime-types.ts`）：

```ts
interface Agent {
  readonly id: SessionId; readonly options: AgentOptions
  readonly session: Session; readonly inbox: Inbox
  readonly status: 'idle' | 'running'; readonly ctx: Context   // agent 作用域上下文
  cancel(cause, options?); whenIdle(): Promise<void>; runMaintenance(task)
  send(message, target, wakeup); followup(message); steer(message); inject(message)
}
```

四种投递语义：`followup`（新轮次，唤醒）、`steer`（最近 step 边界消费）、`inject`（下一次 pre-step，不唤醒）、`send`（底层）。inbox 有 `next-turn` 和 `next-step` 两个有序列表，其变更也是持久事件 `agent/inbox/spliced`。

### 2.4 上下文压缩与截断

`packages/compaction/` 是一个 seam：

- `compaction/`，Service Definition，`ctx.compaction`，`compactIfNeeded(agent, trigger)` / `compactNow(agent)` / `compactRegion(...)`
- `compaction-basic/`，默认 provider，拥有阈值、保留尾部策略、溢出上限
- `compaction-tool-result-pruner/`，先剪枝超大工具结果（默认 `thresholdChars: 8192, headChars: 4096, tailChars: 1024`）再走整体压缩
- `command-compact/`，`/compact` 人工入口

机制：压力压缩跑在 serial `agent/pre-step`（请求派生之前）；溢出恢复跑在 `agent/request-error`。压缩写入 `compaction/start` → `compaction/summary` → `compaction/end`（日志锁），并通过一条带 `surfaceOp: {op:'replace'}` 的 `user/message` 替换 surface 范围。token 估算归单例 `ctx.tokenMeter`（`packages/llm/token-meter`）。区域边界保持 tool call 与 result 配对。

另有 `packages/spill/`（spill-local 加 spill-policy，默认 `maxInlineBytes: 50000`）把超大工具输出溢出到外部存储。

### 2.5 Subagent 与多 agent 编排

有，而且做得相当完整（`docs/subsystems/subagent.zh.md`）。

`ctx.subagents` 是**按名称注册的多 provider 注册表**（不同于单例 seam）：`subagent-spawn-in-process`（默认 `spawn`）、`subagent-fork-in-process`（默认 `fork`，一次性）、`subagent-acp` / `subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk`（**可以把一轮委派给外部产品**）。

两类子 agent：

- **一次性 `start()`**：受 `SubagentCapabilities`（`outputSchema` / `depthLimit` / `toolFilter` / `persona`）静态能力检查把关，不支持的能力显式拒绝而非静默降级。
- **可继续背景子 agent**：持久化 child Session 加至多一个进程内 Activation。`startContinuable()` / `followup()` / `interrupt()`。Agent inbox 是唯一队列，FIFO。`running` / `waiting` / `settled` 三态由 Agent 停稳状态加子级集合派生。

面向模型的工具：`subagent`（continuable）、`subagent_fork`（one-shot）、`send_message` / `interrupt_agent` / `list_agents`、`report`（child 作用域返回通道）。

**Agent Teams**（`packages/experimental/agent-team`，`ctx.agentTeams`）实验性、默认禁用。持久 roster 加任务板加 mailbox 加 10 个工具。

**工作流**：`packages/workflow/`（`ctx.workflowEngine` 加 worker-thread 引擎加 `workflow` 工具）和 `tool-ralph`（固定 Ralph 迭代，每 Round 起一个全新子级，默认 `maxRounds: 64`）。

---

## 3. 工具系统

### 3.1 定义与注册

源码 `packages/core/tools/src/index.ts`（1946 行）：

```ts
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition   // 强制：JSON Schema + render(args, value) → ContentBlock[]
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // 只返回 canonical lossless-JSON
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number                      // 由 tool-call-timeout-policy 强制，永不发给模型
  isConcurrencySafe?(args): boolean       // 并行组准入，默认排他
  presentCall?(args): ToolCallView         // UI 呈现（纯函数，回放安全）
  presentResult?(args, result): ToolResultView
}
```

注册用 `ctx.tools.register(definition)`，返回 disposer。第一方工具用类型化辅助 `defineTool`（见 `docs/cookbook/adding-a-tool.zh.md`）；`register()` 也直接接受原始 JSON Schema，MCP 工具就是这样进来的。

其他注册表 API：`restrict(filter)`（per-scope allow / deny 过滤，展示、查找、执行三者对齐）、`guard(guard)`（单调最终拒绝）、`schemas(scope)`、`presentAs(mode)`。

**作用域分层**：`ToolLayer` 按 scope 分层（agent → preset → global），近者遮蔽远者。这是 agent preset 能给不同会话不同工具集的底座。

**Code Mode**：`Config.mode: 'native' | 'code' | 'both'`。`code` 模式下只发一个保留的 `run_code` transport 加生成的 TS / Python SDK 提示词章节，子调用重新进入完整工具流水线并记录 `tool/code-dispatch-start` / `tool/code-dispatch`（log-only，不进模型上下文）。默认并发上限 `maxParallelSubCalls: 10`。

### 3.2 内置工具清单

生成的完整目录在 `docs/tool-catalog.zh.md`（90KB，`pnpm run gen-tool-catalog` 生成，CI 校验新鲜度）。

| 包 | 模型可见工具 |
|---|---|
| `dsh-tool-fs` | `read`、`write`、`edit`、`read_image` |
| `dsh-tool-fs-search` | `glob`、`grep`（内置 ripgrep 二进制，走 `ctx.subprocess`，不经 shell） |
| `dsh-tool-str-replace-editor` | `str_replace_editor` |
| `dsh-tool-bash` / `-pwsh` | `bash` / `pwsh`（支持 `run_in_background` 接 `ctx.jobs`） |
| `dsh-tool-bash-persistent` / `-pwsh-persistent` | 持久 PTY 版 |
| `dsh-tool-terminal` | `terminal_open/read/send/close/list/signal`（opt-in） |
| `dsh-tool-jobs` | `job_list`、`job_output`、`job_kill` |
| `dsh-tool-subagent` | `subagent`、`subagent_fork` |
| `dsh-tool-subagent-control` | `send_message`、`interrupt_agent`、`list_agents` |
| `dsh-tool-subagent-report` | `report` |
| `dsh-tool-todo` | `todo_write` |
| `dsh-tool-web` | `web_search`、`web_fetch`（fetch 默认关闭，SSRF 防护未做） |
| `dsh-tool-skill` | `skill` |
| `dsh-tool-goal` | `create_goal`、`get_goal`、`update_goal` |
| `dsh-tool-workflow` / `-ralph` | `workflow` / `ralph` |
| `dsh-tool-lsp` | `lsp`（需 `dsh-lsp-stdio` provider） |
| `dsh-tool-session-query` | `session_search`、`session_trace`、`session_event_*`（opt-in） |
| `dsh-tool-ask-user` | `ask_user_question` |
| `dsh-plan-mode` | `exit_plan_mode` |
| `dsh-tool-cordis` | `cordis_define/run/stop/undefine/inspect_*`（自指运行时，非默认） |
| `dsh-schedule` | `schedule_create/list/delete` |
| `dsh-experimental-tool-agent-team` | 10 个 team 工具 |

**没有 git、GitHub、GitLab 工具**（全仓 grep `gitlab` 只命中 badge 资产）。git 操作靠 `bash`。

### 3.3 权限模型：三条正交轴加一个预设层

1. **Sandbox（`ctx.sandbox`）** 是进程级文件效果边界。`sandbox-local`（macOS `sandbox-exec`、Linux Landlock，见 `native/landlock-run`）加 `sandbox-policy`（`read-only` / `workspace-write` / `danger-full-access`，默认 `workspace-write`，`workspaceRoot: process.cwd()`）加 `sandbox-windows-acl`。消费方在启动进程前包装 argv。
2. **Approval（`ctx.approval`）** 是 `packages/interaction/user-approval`。`ApprovalPolicy: 'ask' | 'never'`；`ApprovalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，**fail-closed**（缺应答者等于拒绝）。策略以 `approval/policy` 会话事件持久化，可回放。审计事件对是 `approval/asked` 与 `approval/decided`。
3. **工具流水线策略**：`tools/pre-execute` waterfall 返回 `PreToolDecision = allow | deny{reason} | ask{reason?}`；`ctx.tools.guard()` 单调拒绝（监听器顺序无法把拒绝变回许可）；`tools/post-execute` 返回 `PostToolDecision = accept | block{feedback}`（可附 `additionalContexts`）；`tools/result` 只读观察。
4. **Permission Presets（`ctx.permissionPresets`）** 把 sandbox 加 approval 捆成 UI 里的单个选择器。它本身不做强制执行，只写两个 knob 的规范 setter。

另外：`packages/fs/fs-observation-policy` 提供先读后写门禁；`packages/guard/timeout-policy` 包装 `tools/execute`；`packages/guard/repeat-tool-reminder` 做连续重复调用提醒（阈值 `[3,5,8]`）。

**外部 hook 协议桥**：`packages/hooks/hook-protocol` 加 `hooks-claude-code` 加 `hooks-codex`，兼容 Claude Code 与 Codex 的 `hooks.json` matcher group、退出码约定（exit 2 等于阻塞）、stdout JSON 决策；`mergeHookOutputs` 折叠优先级 deny 大于 ask 大于 allow。

---

## 4. Web UI 与 Server

### 4.1 `dsh web` 启动的是什么

`dsh web` 是 `--profile web` 的硬编码别名（`apps/cli/src/args.ts:156`）。启动的是 `dsh-base` 加 `dsh-web-app` 两层 bundle 组成的**单进程 Node 应用**，默认监听 `http://127.0.0.1:3080`，本机启动时自动开浏览器，SSH 启动只打印 URL，`--no-open` 关闭。

层次（`packages/bundle/web-app/cordis.patch.yml`）：

- 传输层：`dsh-host-webserver`（`ctx.webServer`，`node:http`）加 `dsh-host-frontend-static`（认领 fallback 席位，服务 SPA dist）
- API 层：`dsh-host-apiproxy`（`ctx.apiProxy`，传输无关的 RPC 分发）加 `dsh-api-gateway`（Typert Remote endpoint）加 `dsh-client-connection`（唯一 `/api` route 所有者加信任栅栏）
- 浏览器插件名录：`dsh-client-modules`（node 半侧扫描名录合成 `window.__DSH_BOOT__`，并服务 `/plugins/<id>/client.js`）加约 30 个 `dsh-client-ui-*` 行

### 4.2 前后端通信

双通道（`packages/client/connection/src/`）：

| 通道 | 协议 | 用途 |
|---|---|---|
| `POST /api/<ns>.<method>` | HTTP 加 JSON RPC envelope | 一元调用 |
| `/api/events.mux` | WebSocket，只下行 | 每会话事件流：`session/event`、`approval/requested`、`question/requested`、`session/jobs`、`session/projection` |
| `/api/events.host` | WebSocket，只下行 | 宿主级帧：`host/session-status`、`host/workspace-changed`、`host/archived-sessions-changed`、`host/remote-event` |

任一 socket 断开都会让当前 connection generation 失败并重建两条流；ready 要求两条 socket 打开加 `host.describe` HTTP 成功。普通 GET 这两个路径返回 426，**没有 SSE 回退**。

RPC 方法全集在 `packages/host/apiproxy/src/api/rpc-map.ts`（57 个方法）：`session.*`（12）、`subagent.*`（4）、`host.*`（5）、`workspace.*`（7）、`skill.list`、`agentPreset.*`（6）、`goal.*`（6）、`settings.*`（5）、`credentials.*`（3）、`llm.*`（3）。

**第二套 RPC：Typert API Gateway**（`docs/api-gateway.zh.md`）。Host 业务服务用 `@Remote` / `@RemoteScope` 装饰器标注方法，构建期（`tsdown --env.DSH_BUILD_FACE host`）由 `dsh-typert-generator` 从 `ts.Program` 严格分析并生成 Host 描述符加 Host-for-Client 的类型贡献。Client 侧挂成 `ctx.remote.<ns>.<method>` 和 `agentCtx.remote.<ns>.<method>` 的具体函数（不是 Proxy），走同一个 `/api`。Typert interceptor 先认领自己的 endpoint，未认领的回退到 API Proxy。**这是给新业务域加 RPC 的正规通道，不需要碰 apiproxy 的手写 map。**

### 4.3 单用户本地模式，没有鉴权层

证据链：

- `docs/subsystems/web-server.zh.md`：`host` 只接受 `127.0.0.1`（默认）和 `0.0.0.0`（刻意暴露）；原文「没有 TLS、认证或 origin 策略」。
- `packages/client/connection/README.zh.md`：`/api` 有一道**信任栅栏（reachability policy，不是认证）**，每个请求的 `Host` 头必须是 loopback 权威或匹配 `trustedHosts` 条目（DNS rebinding 防御加 Origin / Fetch-Metadata 校验）。原文「这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层」、「`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持」。CLI 在 startup provider 里直接拒绝 `--host 0.0.0.0`。
- 特权方法集（`host.pickDirectory`、`host.openPath`、`settings.*`、`credentials.*`、`agentPreset.read/copy/openDocument/remove`）以空信任表过栅栏，即**永久钉死在 loopback**。
- `packages/identity/anonymous-user-id` 只是给遥测用的随机 UUID，不是用户身份。
- 没有 user / tenant / org / role 概念，session 只按 `SessionId` 加 `workspace` 组织。

### 4.4 持久化

| 数据 | 后端 | 默认 |
|---|---|---|
| 会话事件日志 | `session-persistence-jsonl`（默认）或 `-sqlite` | `$DSH_HOME/sessions`，每会话一个 JSONL |
| 会话全文检索 | `session-query-sqlite` | **默认 `path: ':memory:'`、`openAt: never`**（关闭） |
| 非会话数据 | `ctx.storage` hub 加 `storage-json`（默认）或 `storage-sqlite` | `$DSH_HOME/storages` |
| 图片附件 | `attachment-local` | 内容寻址，在日志之外 |
| 用户设置 | `settings-file` | `$DSH_HOME/settings.yaml`（热重载） |
| 凭据 | `credentials-local` | `$DSH_HOME/.credentials.yaml`（只写，页面只拿脱敏描述符） |
| 遥测 | `session-telemetry-otel` | 默认禁用，OTLP / HTTP |

**没有关系型数据库、没有 ORM、没有 server 端 schema migration**。SQLite 走 `node:sqlite`。会话日志格式版本 `SESSION_FORMAT_VERSION = 0`，预发布阶段不做迁移，版本不符直接拒绝。

崩溃恢复：后端重载时发现未闭合 `turn/start` 会补一条合成 `turn/end { reason: { kind: 'interrupted' } }`，不截断日志。

### 4.5 UI 框架

React 18 加 Vite 加 Cordis（浏览器端也跑一棵 Cordis 树）。

- `packages/client/ui-primitives`，纯 React 原子组件（零 cordis），含 markdown（micromark / mdast）、katex、shiki 高亮、ANSI（anser）、JSON inspector
- `packages/client/ui-slots` 加 `ui-renderer`，**Slot 机制**：`ctx.slots.declare()` / `register()` / `inject(name, cb)`，声明式插槽，支持事务性注册与回滚
- `packages/client/runtime`，不依赖 React 的对象服务层（SessionRuntime / WorkspaceRuntime / SlotRegistry / ProjectionValueStore）
- `packages/client/ui-conversation`，Chat 主体，提供 `ConversationNodeDefinition` 加 keyed renderer 扩展点
- 其余约 30 个 `ui-*` 包各占一个产品面：sidebar、settings、tool、plan、goal、jobs、subagent、skill、reference、attachment、model-selection、permission-presets、workflow-run、deliverables、trajectory、user-questions、message-feedback、workspace、directory-picker、theme、locale、commands、input-trigger

热更新：`packages/client/hmr` 常驻，`pnpm run dev:web` 起 watcher 后即可无刷新重载客户端插件。

---

## 5. 模型接入

`packages/llm/llm`（`ctx.llm`，`LlmRuntime extends Service`）定义对话词汇（`ContentBlockMap`：`text` / `reasoning` / `image` / `tool-call` / `tool-result`，可 merge 扩展；`Message` 带 `id`、`role`、`source`、`AssistantProvenance`）、流式协议 `StreamChunk`、适配器抽象 `abstract class LlmAdapter { abstract stream(options): AsyncIterable<StreamChunk> }`，注册用 `ctx.llm.registerAdapter(providers: string[], adapter)`。一个适配器可以注册多条 provider 路由，请求用 `GenerateOptions.provider` 选路。

两个交付适配器：

- `packages/llm/llm-deepseek`，原生 DeepSeek 适配器。不内联 key 与 endpoint，二者每请求从 settings 段加凭据存解析。
- `packages/llm/llm-pi-ai`，**通用多 provider 适配器**，基于 `@earendil-works/pi-ai`。以路由为 key 的 profile 字典：既能继承 pi-ai 内置 catalog（OpenAI / Anthropic / Bedrock / Vertex / Azure / Codex 等）的 endpoint、协议、模型表并逐字段覆盖，也能整体手工声明一条路由（OpenAI 兼容网关、自建服务）。

`llm-pi-ai` 在 base bundle 中以休眠状态挂载：零路由，直到 `settings.yaml` 的 `llm-pi-ai:` 段提供 provider profile 才活起来，段清空则路由下线。**加 provider 是配置，不是改代码。**

并发与流式：

- 流式是一等公民，每个 chunk 作为 `assistant/chunk` 事件落盘（token 级回放保真），UI 直接从事件流渲染。
- 工具调用并发由 agent-loop 的 `maxParallelToolCalls` 控制，只有 `isConcurrencySafe(args) === true` 的调用才能重叠，排他调用形成 barrier。
- 多会话并发：单进程服务多个 session，每个 Agent 一个 scope，互不干扰。
- **单次对话内没有多模型并发投票或竞速机制**，需自建。
- 重试：`packages/llm/llm-retry`（默认 normal 模式最多 5 次，指数退避加 jitter），也可 per-profile 配置。
- 错误恢复：`agent/request-error` waterfall，监听器返回 `{ kind: 'retry' }` 接管。
- 模型选择三级解析：本进程内选择 大于 会话日志最新 `request/header` 大于 `ctx.agentDefaultModel`。
- 图片模态：手工录入的模型默认按纯文本对待，需显式声明 `input: [text, image]`。

---

## 6. 扩展点

### 6.1 官方扩展点映射

| 目标 | 机制 |
|---|---|
| 加模型 provider | `ctx.llm.registerAdapter()` |
| 加面向模型的能力 | `ctx.tools.register()`，schema 自动流入提示词组装 |
| **让某个会话拥有不同能力集** | **组装一个 agent preset**（服务行需 `isolate` realm） |
| 加 shell 后端 | 注册 `ctx.shell` |
| 加持久终端 | 注册 `ctx.terminals` 加 `dsh-tool-terminal` |
| 加用户命令（斜杠命令） | `ctx.commands.register()`，无需模型轮次即可分派 |
| 加后台工作 | `ctx.jobs.start()`，`job_*` 工具收集与停止 |
| 加文件系统访问或策略 | 注册 `ctx.fs` provider，或监听 `fs/*` |
| 限制进程 | `ctx.sandbox` 后端 |
| 拦截请求、工具、轮次 | 对应 `agent/*` 与 `tools/*` 事件 |
| 加模型可见上下文 | `agent.inject()` |
| 加 UI 或编辑器集成 | 驱动 `ctx.agents` 加从 `session/event` 渲染 |
| **加 Web Chat 业务节点** | 注册 `ConversationNodeDefinition` 加 keyed renderer |
| 加持久会话状态 | 扩展 `SessionEventMap` 加从日志渲染 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` provider |
| fork 会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 限定到单个 agent | 用 `agent.ctx` |
| **对外暴露新 RPC** | `@Remote` / `@RemoteScope` 加 Typert 生成管线 |

### 6.2 插件开发文档

相当完整，中英双语全覆盖。用户向教程在 `docs/user/develop/`；Cordis 教程在 `docs/cordis-tutorial/`（26 个文件）；Cookbook 在 `docs/cookbook/`；子系统页在 `docs/subsystems/`（47 个主题）；生成目录有 `docs/tool-catalog.zh.md`（90KB）、`docs/config-catalog.zh.md`（143KB）、`docs/module-graph.zh.md`（128KB）等，CI 校验新鲜度。根目录 `AGENTS.md`（16KB）加各目录 `AGENTS.md` 加 `.agents/notes/`（设计决策记录）加 `.agents/skills/`（11 个 skill，其中有一个 `dsh-code-review`）。

### 6.3 第三方插件安装

```sh
dsh plugin --profile <name> add ./my-plugin              # 本地 checkout
dsh plugin --profile <name> add my-plugin                # npm
dsh plugin --profile <name> add github:you/repo#<sha>    # git
```

`dsh plugin` 就是在 profile 目录里转发 pnpm，并根据 `dsh.bundle` 声明自动维护 `dsh.profile.bundles`。社区约定给插件仓库打 `dsh-plugin` GitHub topic。

### 6.4 examples 目录

| leaf | 内容 |
|---|---|
| `examples/headless-agent/` | 一次性 agent，最丰富：`cordis.yml` 加 12 个 snapshot 变体 |
| `examples/jsonrpc-agent/` | Python SDK 加 JSON-RPC 驱动的无人值守 coding agent |
| `examples/acp-agent/` | ACP 自动化服务器，63 个文件，支持会话、权限、取消 |
| `examples/web-cordis/` | 自指 agent：能检查并修改自己内存中的 Cordis 插件树 |
| `examples/web-schedule/` | 会话内持久提醒 overlay |
| `examples/mcp-memory/` | 第三方 MCP 记忆服务器 overlay |

每个 example 有两套 e2e：keyless（走真实 Loader 启动）和 with-key（真实模型，验证外部状态而非模型自述）。

---

## 7. 可复用与必须自建的边界

### 7.1 可以直接复用

| 能力 | 包 | 备注 |
|---|---|---|
| Agent 主循环 | `core/agent` 加 `core/agent-loop` | turn / step 编排、inbox、steering、取消、错误恢复，工业级完成度 |
| 事件溯源会话模型 | `core/session` | 仅追加日志加 surface 投影加 fork 加 replay。**对 code review 的审计需求天然契合** |
| 工具系统 | `core/tools` 加 20 多个 `dsh-tool-*` | 定义 DSL、schema 组装、并发调度、Code Mode、per-scope 过滤 |
| 文件、Shell、搜索工具 | `tool-fs`、`tool-fs-search`（内置 ripgrep）、`tool-bash`、`tool-lsp` | 读代码的主力，开箱可用 |
| LLM 多 provider 接入 | `llm/llm` 加 `llm-pi-ai` 加 `llm-deepseek` 加 `llm-retry` | 加 provider 是改 YAML |
| 上下文压缩、剪枝、spill | `compaction/*`、`spill/*`、`token-meter` | 大 diff review 必需 |
| Subagent 编排 | `subagent/*` | **「多个 reviewer 并行看不同文件」能直接落在这上面** |
| 沙箱、审批、工具策略 | `sandbox/*`、`user-approval`、`permission-presets` | 进程级隔离加 fail-closed 审批 |
| 持久化与崩溃恢复 | `session-persistence-*`、`storage/*` | |
| Web UI 框架 | `client/*`（40 包）加 `apps/web` | React 18 加 Slot 插件化加流式渲染加 markdown / 代码高亮加工具卡片加审批弹窗。**这一套 UI 自己写至少几人月** |
| 前后端 RPC | `host/apiproxy` 加 `client/connection` 加 `api/gateway` | `@Remote` 装饰器加新 RPC 全自动生成两侧类型 |
| Agent Preset | `preset/agent-presets` | **做 code review 专用 agent 的正规通道**：一个目录加一个 `agent.cordis.yml` |
| Skill 系统 | `skill/*` | 把 review checklist 与规范做成 skill，按需注入 |
| Slash 命令 | `interaction/commands` | `/review`、`/approve` 这类不走模型的直接动作 |
| Goal / Plan / Todo / Workflow / Ralph | `goal/*`、`plan-mode`、`tool-todo`、`workflow/*` | 多轮受控推进 |
| MCP 客户端 | `mcp/mcp-client` | **接 GitLab MCP server 是最短路径**：一个 YAML 条目，工具自动出现为 `mcp__gitlab__*` |
| 外部 hook 兼容 | `hooks/*` | 复用现有 Claude Code hooks 生态 |
| 程序化驱动（无 UI） | `sdk/*` 加 `python/` 加 `acp/acp` 加 `bundle/headless` | **把 dsh 当引擎进程跑在自己的服务后面，这条路是通的** |
| 远程执行环境 | `e2b/*` | 把 `ctx.fs` 加 `ctx.subprocess` 指向 E2B，Bash / PTY / LSP 一起搬走 |
| 遥测 | `session-telemetry-otel` | OTLP / HTTP，默认关 |

### 7.2 明确不提供，必须自建

| 缺口 | 证据 | 自建难度 |
|---|---|---|
| 鉴权、登录、会话管理 | 文档原文「没有 TLS、认证或 origin 策略」「这道栅栏是可达性策略，而不是认证」；`--host 0.0.0.0` 被 CLI 硬拒 | **高**。特权 RPC 永久钉死 loopback，多用户场景必须整体屏蔽或替换 |
| 多用户、多租户、数据隔离 | 无 user / tenant / org 模型；session 只有 `SessionId` 加 `cwd` 加 `workspace` | **高**。session 目录、storage、settings、credentials 全是 `$DSH_HOME` 单一进程全局 |
| RBAC 与权限矩阵 | 只有 sandbox 乘 approval 两个 knob，粒度是「这次工具调用能不能跑」，不是「这个人能不能看这个仓库」 | **高** |
| 任务队列与分布式调度 | `ctx.jobs` 是进程内后台任务注册表；`ctx.schedule` 是 session-local 提醒；Agent inbox 是单 agent FIFO | **高**。MR 事件触发、重试、削峰、水平扩容全要自建 |
| 关系型数据库、ORM、迁移 | 只有 JSONL 加 node:sqlite KV；`SESSION_FORMAT_VERSION = 0` 明确不提供迁移 | **中**。MR、评论、规则、统计必须放自己的 PG |
| GitLab 集成 | 全仓无任何 git 托管平台代码，无 git 工具 | **中**。最快路径是 MCP server 或自写 `dsh-tool-gitlab` 插件加 webhook 接收服务 |
| 长期知识库、向量检索、RAG | `session-query-sqlite` 是会话日志全文检索且默认关闭；无 embedding、无向量库、无跨仓库索引 | **高** |
| Diff 与 MR 领域模型 | 没有 patch / hunk / comment / thread / review-state 任何概念。UI 有 markdown 加代码高亮，但**没有 diff viewer、没有行级评论组件** | **高**。这是核心产品面，本来就该自建 |
| 横向扩容与无状态化 | Agent 注册表、preset 常驻挂载、jobs、subagent activation 全是进程内单例 | **高**。只能一进程一 worker 横向复制，会话亲和性自己做 |
| 计费、配额、成本归集 | `token-meter` 只做上下文估算；`assistant/message.usage` 有 token 账，但无聚合、无配额、无限流 | **中**。数据源有，聚合层自建 |
| 审计导出与合规 | 有 `session-log-export` 和 OTLP 遥测，但无企业审计日志、无保留策略、无 PII 脱敏（遥测文档明说「没有 redaction 规则，导出是原始副本」） | **中** |
| `web_fetch` | `tool-web` 的 `fetch: false` 默认关闭，原文「该 provider 推迟了 SSRF 防护且模型会选择请求目标」 | 低 |
| **API 稳定性** | Developer Preview，README 与每个 README 的「已知限制」段都在说会破坏兼容 | **这是最大的战略风险** |

### 7.3 推荐的落地形态

**把 dsh 当单会话执行引擎，不要当产品服务器。**

```
[自己的 Web 前端]  ←→  [自己的服务：认证 + 多租户 + PG + 队列 + GitLab webhook]
                              ↓ 每个 review 任务
                     [dsh 进程 / 容器]  ← JSON-RPC stdio (sdk/server)
                                          或 ACP (acp/acp)
                                          或 headless (dsh --profile headless)
                              ↓
                     [E2B / 容器内的 checkout]  ← fs-e2b + subprocess-e2b
```

具体扩展点选择：

1. **一个 bundle 包**（`dsh-code-review`，声明 `dsh.bundle.patch`），所有插件行都在这一个 patch 文件里，用户 `dsh plugin add` 就能装。
2. **一个 agent preset**（`agent.cordis.yml`），定义 review agent 的工具集（`tool-fs` 加 `tool-fs-search` 加 `tool-lsp` 加自写的 `tool-gitlab` 加 review skill），关掉 `bash` 写权限，persona 固化。preset id 会持久化进 `SessionHeader.agentPreset`，resume 与 fork 都能重建同一组装。
3. **GitLab 能力**优先用 MCP（一条 YAML），需要精细控制再写 `ctx.tools.register()` 工具。
4. **Review 领域状态**扩展 `SessionEventMap`（`review/finding`、`review/decision` 等）让它进日志、可回放、UI 能从 `session/event` 渲染。不要塞进工具结果的 `meta`。
5. **Web UI 扩展**用 `ConversationNodeDefinition` 加 keyed renderer 加 Chat 里的 finding 卡片；重的 diff viewer 走自己的前端页面，通过 Typert `@Remote` 拿数据。
6. **并行 review** 用可继续子 agent，按文件或模块分派，`report` 工具回收结论。
7. **门禁策略**用 `tools/pre-execute` waterfall 加 `ctx.tools.guard()` 做「review agent 不许写工作区」的单调拒绝。

### 7.4 三个需要提前决策的风险

1. **版本风险**：`0.1.1-rc.2`，会话日志格式版本 0 且明确不做迁移。长期保存 review 会话日志的话，升级 dsh 可能读不回旧日志，需要自己做一层归档。
2. **Host / Client 双 aggregate 的构建复杂度**：必须两个 `ts.Program`（两侧对 `Context` 做不同的 declaration merging）。第三方插件若同时有 Node 和 browser 面，要遵守 tsdown `DSH_BUILD_FACE` 约定，上手成本不低。
3. **单进程全局状态**：`ctx.subagents` provider 名、preset 常驻挂载、jobs 注册表都是进程单例。多租户共进程会直接撞车，只能一租户一进程或一容器。
