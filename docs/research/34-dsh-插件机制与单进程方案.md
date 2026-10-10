# dsh 的插件机制、单进程方案与 dsh web

- 对应工单：[原型必要性](../../requirements/01-v1-qodo-reproduction/issues/04-原型必要性.md)（spike 前的调研）
- 调研时间：2026-09-23
- 前置调研：[dsh 嵌入形态](13-dsh-嵌入形态.md)（基于 `0.1.5-rc.2`）、[deepseek-harness 能力边界](03-deepseek-harness-能力边界.md)
- 被调研版本：`git fetch` 后仓库最新标签 **`dsh-v0.1.7-alpha.2`**（commit `00102833df`，2026-09-22）。任务给的 `dsh-v0.1.7-alpha.1` 已不是最新。npm 上 `@deepseek-ai/dsh` 的 `latest` 是 `0.1.5-rc.3`，`alpha` 是 `0.1.7-alpha.2`（`npm view @deepseek-ai/dsh dist-tags`）。下文 dsh 出处都读自 `git show dsh-v0.1.7-alpha.2:<path>`，路径相对 dsh 仓库根。
- 第三方项目的出处是 2026-09-23 克隆的提交，写作 `仓库@短 SHA:路径:行号`。

## 结论

**问题一：其它项目怎么做。** 第三方项目是有的。GitHub 和 npm 的搜索计数只能说明有多少仓库或包打了 dsh 相关的标签、提到了 dsh，说明不了有多少真正用了 dsh 的插件机制，所以真实规模**未能确认**（查询和原始返回见 1.1 末尾）。读过源码的 7 个评审类项目里，4 个是跑在 dsh 进程里的插件或 bundle，3 个是独立进程（Python SDK、`boot()` 自起、ACP 服务器）。进程内的写法相同：`ctx.agents.create({ setup })`，在 `setup` 里挂 preset、往 agent 自己的 scope 注册工具，`agent.inject` 或 `followup` 送上下文，最后用一个只记录参数的上报工具拿回结构化 finding。第一方包 `schedule`、`webhook`、`goal` 用的是同一套 API。`chenxiachan/thoughtdag` 本体是不依赖 dsh 的独立应用，它的 `dsh/` 子目录是一个 web profile 插件：挂在 dsh 自己的 WebServer 上，通过 `sessionController` 建会话、`agent.inject` 注入、订阅 `session/event` 收文本流，只返回文本，没有结构化结果（1.3）。按下文的分类它属于 C（同进程插件）；它把驱动接口开放成了 HTTP，照搬这种做法就是「对 spike 的影响」里的形态 E。

**问题二：单进程方案。** 有条件可行，而且已经有人这样做：`ddtcorex/dsh-maestro-review` 把 GitLab webhook 挂在 dsh 的 WebServer 上，在进程内创建会话、挂 preset、注册 agent 私有的工具，用闭包收 finding。代价有这些：我们的服务端必须是 Node（`^22.19.0 || >=24.0.0`）；和 dsh 的插件 API 同进程、同版本；没有官方 Docker 镜像，profile 目录启动时要写；dsh 的 Web 认证只认一个 operator，我们的 HTTP 面和认证要自己挂；SAFETY.md 明说不能当生产软件用。`packages/sdk` 不是进程内的路：它的 TS 客户端也是 spawn `dsh --profile sdk` 子进程。进程内的入口只有 `@deepseek-ai/dsh-app-boot` 的 `boot()`。

**问题三：dsh web。** `dsh web` 就是 `dsh --profile web`。HTTP 服务器（`dsh-host-webserver`，基于 `node:http`）和 agent 运行时在同一个 Node 进程、同一棵 Cordis 插件树里。`apps/web` 只是 Vite 构建出的前端静态资源。它的 `/api` 是给自带前端用的 Typert RPC，没有面向外部程序的稳定文档。认证只有一种：启动时打印的 launch token 换一个 cookie，不接受 `Authorization` 头。插件可以用 `ctx.webServer.register` 挂路由，也可以用 Slot 席位挂页面。

**对 spike 最要紧的一条**：ACP 的 `session/new` 能按会话挂 HTTP MCP 服务器，还能带 header。所以「我们的服务提供一个 MCP 端点」可以不写 dsh 插件，就在一次 ACP 会话里同时提供评审工具、用 server instructions 注入规范，并直接在我们进程里收到 finding。另外，经 ACP 挂进 profile 的插件也做得到这三件事：`agent/created` 是串行、要 await 的事件，插件可以在里面给 ACP 刚建的 agent 注册工具、调 `agent.inject`，工具参数也会以 `tool_call.rawInput` 转发给 ACP 客户端。

---

## 一、其它基于 dsh 插件机制的项目

### 1.1 第三方项目（读过源码的七个评审类项目）

| 项目 | 形态 | 工具注册 | 上下文注入 | 结构化结果 | 自带 HTTP | 依赖的 dsh 版本 |
|---|---|---|---|---|---|---|
| [ddtcorex/dsh-maestro-review](https://github.com/ddtcorex/dsh-maestro-review) | bundle，4 行插件（`cordis.patch.yml`），另带 `profiles/reviewer-ci` 给 CI 无头跑 | 在 `setup` 里用 `agentCtx.plugin(ReviewFindingsTool, …)` 等挂 agent 私有的工具（`@957a2f2:src/host/orchestrator.ts:1124-1152`） | `agentPresets.mount(agentCtx, 'dsh-maestro-reviewer')`（`:344`），然后 `followup`（`:1168`） | `report_review_findings` 工具的 `execute` 调用配置里传入的 `onReport` 闭包（`src/host/review-findings-tool.ts:27,53-55`） | 挂在 dsh 自己的 WebServer 上：`webServer.register({ kind: 'exact', path: '/hooks/gitlab-mr' })`（`src/host/providers/gitlab.ts:160`） | `0.1.7-alpha.2`（`package.json:49-57`） |
| [chaojixinren/dsh-reviewer-bot](https://github.com/chaojixinren/dsh-reviewer-bot) | bundle（`bundle/cordis.patch.yml`），同一套插件也能被 `runtime-bootstrap` 用 `new Context()` 手工装配，给 Action 和 CLI 用（`@90e1906:packages/core/runtime-bootstrap/src/index.ts:126-147`） | `tool-review` 包里的 `report_finding`、`read_diff_shard` 等 | `handle.agent.inject(createUserMessage(…))` 送 diff 与规则，再 `followup` 下任务（`packages/core/review-runtime/src/index.ts:3049-3053`） | 两条路：在 `setup` 里订阅 `agentCtx.on('session/event')`，截取 `report_finding` 的 `tool/call` 参数（`:3028-3030`）；分片时 `ctx.subagents.start(provider, { outputSchema })`，读 `result.structured`（`:3144-3156`） | `driver-webhook` 自己用 `node:http` 的 `createServer`（`packages/drivers/driver-webhook/src/index.ts:994`） | `0.1.0-rc.6`（旧） |
| [MichengAI/dsh-code-review](https://github.com/MichengAI/dsh-code-review) | 插件，`package.json` 里声明 `dsh.bundle` | `ctx.tools.register` 注册 `code_review`（`@5c31362:src/index.ts:79`），命令 `/review`（`:43`） | 监听 `agent/created`，给子 agent 加 `systemPrompt.section`、`tools.restrict`（`src/runtime.ts:31-58`），子 agent 用 `ctx.subagents.start('spawn', …)` 起 | 子 agent 输出 JSON 文本，由 `parseReport` 解析（`src/report.ts:27`） | 无 | `0.1.6-alpha.2` |
| [addozhang/dsh-discord](https://github.com/addozhang/dsh-discord)（不是评审项目，接入形态可参考） | 插件，挂在 `dsh web` profile 上，README 原话「No extra process」（`@831d4d0:README.md:13`） | — | 通过 `sessionController` 创建会话（`src/features/session-creation.ts:55`） | — | `webServer.register` 挂前缀路由（`src/features/adapter-status.ts:340`） | `0.1.7-alpha.1` |
| [nexpeakcore/deepseek-harness-pr-review](https://github.com/nexpeakcore/deepseek-harness-pr-review) | 独立进程：Python SDK `DeepSeekHarness(...)` 驱动（`@79b0441:src/verify.py:343`） | 不注册自定义工具 | persona 与 prompt | agent 在工作区写 `findings.json`，宿主读文件后校验 | 自带 FastAPI 看板（`web/server.py`） | — |
| [Lixiaoyiao/deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action) | 独立进程：`@deepseek-ai/dsh-app-boot` 的 `loadProfile` 加 `boot` 起 headless profile（`@d92cd61:assets/dsh/action-launcher.mjs:1,33,74`） | 未细读 | 未细读 | 读 worker 的 stdout，用 zod schema 校验（`src/dsh/schema.ts`） | 无 | — |
| [ALwith-ai/dsh-agent](https://github.com/ALwith-ai/dsh-agent) | 独立进程：自己 `new Context()`，逐个挂官方插件，对外是 ACP 服务器（`@eff3638:src/compose.ts:75`，`src/main.ts:122`） | — | — | Bridge 订阅会话事件 | 无 | — |

这 7 个里，maestro、reviewer-bot、nexpeak、action 都会往代码平台写评论（例如 maestro 的 `src/host/gitlab-client.ts:220,287,322` 发 POST），和 uReview 的只读约束不同，能参考的只有注入与回收这两部分写法。

计数复核（2026-09-23，下列数字都是接口原样返回的 `total_count` 或 `total`）：

| 查询 | 返回 | 说明 |
|---|---|---|
| `gh api 'search/repositories?q=topic:dsh-plugin'` | 15918 | 前五条（按 stars）：`deepseek-ai/deepseek-harness`（2026-08-13 创建，234001 stars）、`nexu-io/open-design`、`ruvnet/ruflo`（2025-06 创建）、`tt-a1i/archify`、`reactive-resume/reactive-resume`（2020-03 创建，简历生成器）。最后两类是给已有项目补打了 topic，不代表基于 dsh |
| 同上，加 `created:>2026-07-01` | 15630 | 前五条都是 dsh 相关项目（官方仓库、两个桌面端、`awesome-dsh-plugin/awesome-dsh-plugin`、`zhu1090093659/dsh-web`） |
| `gh api -X GET search/code -f q='filename:cordis.patch.yml'` | 6632 | `cordis.patch.yml` 是 dsh 的 patch 层文件名；抽样前三条是 `cocofhu/anime-find`、`Anionex/dsh-vision-toolkit`、`d-dev0101/open-sea-skin` |
| `gh api -X GET search/code -f q='"@deepseek-ai/dsh" filename:package.json'` | 24512 | 统计的是命中文件数，不是仓库数 |
| npm registry `/-/v1/search?text=keywords:dsh-plugin` | 5981 | 按 keyword 精确匹配 |
| 前一版写的「npm 约 1278 个包」 | — | 来自 `npm search` 若干查询的并集，而每个查询最多只返回 250 条，这个数不可靠，已删去 |

官方仓库本身有 234001 stars、28116 forks（`gh api repos/deepseek-ai/deepseek-harness`），所以上面的量级和它的热度对得上。但这些计数统计的是「打了标签」或「提到了 dsh」，有多少真正实现了 dsh 插件，**未能确认**。本节能确认的只有读过源码的项目。官方 README 只让作者给仓库加 `dsh-plugin` topic（`README.md:46`，`CONTRIBUTING.md:15`），仓库里没有第三方插件列表，`examples/` 与 `packages/examples` 都不存在。

### 1.2 第一方包的写法

dsh 在代码上不分「插件」和「bundle」：插件是一个 Cordis 模块；bundle 是 `package.json` 里多声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包；profile 是 `$DSH_HOME/profiles/<name>/` 目录（`docs/user/develop/basic/publish.md:13-16,33-44,66-73`）。工具注册在哪一层，看插件挂在哪：挂在 host 行，工具就是全局的；写进某个 preset 的 `plugins:`，只对那个 preset 的 agent 可见；通过 `agent.ctx` 注册，只对那一个 agent 可见，agent 销毁时自动撤销（`packages/core/scope/README.md:27`）。

| 包 | 工具 | 注入 | 结构化产出 | HTTP / RPC | 建会话 |
|---|---|---|---|---|---|
| `webhook` + `webhook-github` | 无 | 对新会话 `followup`，扩展 `MessageSourceMap.webhook`（`packages/webhook/webhook/src/session.ts:153-164`，`types.ts:71-84`） | 无，README：「No completion result」（`packages/webhook/webhook/README.md:73`） | `ctx.webServer.register` 挂 exact 路由（`webhook-github/src/index.ts:47-61`），样例放在 `isolate: { webServer: true }` 的第二个 WebServer 里（`apps/cli/config/examples/github-review/cordis.yml:17-35`） | 能，并能指定 preset：`agents.create({ meta: { cwd, agentPreset }, setup: agentCtx => agentPresets.mount(agentCtx, id) })`（`session.ts:134-143`）；规则返回值必填 `workspacePath`、`agentPreset`、`permissionPreset`（`types.ts:38-51`） |
| `schedule` | 在 `agent/created` 里对 root agent 调 `registerScheduleTools(ctx, agent.ctx, …)`，只注册到 agent scope（`packages/schedule/schedule/src/index.ts:115-119`）；`AGENTS.md:8` 写明不注册全局工具 | 到期时 `followup`（`runtime.ts:270-290`） | `SessionEventMap['schedule/change']` 加会话投影（`types.ts:13-28`，`index.ts:69-71`） | 无 | 不建 |
| `goal` | `tool-goal` 注册 3 个工具（`tool-goal/src/index.ts:201,213,240`） | 提示段 `tool:goal`（`:195-199`），`goal-round-driver` 做 `followup` | `SessionEventMap['goal/change']`（`goal/src/domain.ts:61-68`） | `@Remote` 方法（`goal/src/index.ts:276` 起） | 不建 |
| `jobs` | `tool-jobs` 3 个工具（`tool-jobs/src/index.ts:310,353,373`） | 结算时 owner 空闲就 `followup`，否则 `inject`（`:271-307`） | `ctx.jobs.events` 事件流 | 在 `api/job-controller` 里 | 不建 |
| `mcp-client` | 注册为 `mcp__<server>__<tool>`（`packages/mcp/mcp-client/src/tools.ts:150`） | server instructions 注册成提示段 `mcp:<server>`（`src/server-context.ts:28-39`） | 无 | 无 | 不建 |
| `subagent-in-process-driver` | 结构化子 agent 会得到一个 `structured_output` 工具 | 子 agent 的委派说明提示段 | `attachStructuredRuntime(childCtx, schema)`：校验、暂存、成功后提交（`README.md:66-68`）；ACP、SDK 两种子 agent 后端都拒绝 `outputSchema`（`subagent-acp/README.md:32`） | `@Remote` | 建子会话，preset 跟随父会话（`child-agent.ts:139-157,205`） |

自定义会话事件：`SessionEventMap` 可以用 declaration merging 扩展（`packages/core/session/src/types.ts:276-281`），用 `session.append(type, data)` 写入（`src/index.ts:720-723`）。但持久化读回时，不在生成的 `KNOWN_SESSION_EVENT_TYPES` 里、又没有 `ignorable: true` 的事件会被拒绝（`packages/session/session-persistence/src/storage-contract.ts:55-58`；`known-event-types.ts:15-16` 原文「Downstream (out-of-repo) plugin events are outside this list by construction」）。公开的 `append` 签名里没有 `ignorable` 参数，外部插件要怎么设这个标记，**未查到**。所以仓库外的插件写的自定义事件，在 resume 或重读日志时可能被拒。

### 1.3 chenxiachan/thoughtdag

仓库：<https://github.com/chenxiachan/thoughtdag>（克隆于提交 `f742a80`，2026-09-23）。下文路径相对该仓库根。

- **和 dsh 的关系**：ThoughtDAG 本身是一个独立应用，由 Vite SPA、`server.mjs`、Electron 壳（`desktop/`）和 CLI（`cli/`）组成，不依赖 dsh。仓库里的 `dsh/` 目录是它给 dsh 写的插件，npm 包名 `dsh-thoughtdag`，版本 0.4.18（`dsh/package.json:2-3`；`npm view dsh-thoughtdag version`）。dsh 相关的部分只有这个目录。
- **形态**：bundle 加 web profile 插件，分 host 和 client 两半。`package.json` 里声明了 `dsh.bundle.patch` 和 `dsh.client`（`dsh/package.json:35-49`）。patch 只插入一行 `name: dsh-thoughtdag`，行内原注释是「extends the Web profile: it reuses the existing DSH server」（`dsh/cordis.patch.yml:1-16`）。安装命令是 `dsh plugin --profile web add dsh-thoughtdag`（`README.md` 的「New · DeepSeek Harness Available!」一节）。
- **依赖的 dsh 版本与包**：全部写成可选的 peerDependencies，范围是 `>=0.1.2-rc.1`，包括 `dsh-session`、`dsh-api-session-controller`、`dsh-agent`、`dsh-llm`、`dsh-attachment`、`dsh-web`、`dsh-host-webserver`、`dsh-client-modules`、`dsh-client-connection`（`dsh/package.json:65-76`）。声明兼容的版本只有 `0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`（`:50-56`），**没有声明 0.1.6 / 0.1.7**。它用到的 `sessionController.create / fork / prompt / selectModel` 在 alpha.2 上都还在（dsh `packages/api/session-controller/src/index.ts:272,282,396,407`），但插件在 alpha.2 上能不能跑，**未验证**。host 半边的 `inject` 是 `webServer`、`sessions`、`sessionController`、`agents`、`llm`、`attachments`、`web`、`tools`、`commands`、`systemPrompt`、`approval`（`dsh/lib/index.js:79`）。`sessionController` 只在 `web-app` bundle 里挂载（dsh `packages/bundle/web-app/cordis.patch.yml:102-103`），所以这个插件离不开 web profile。
- **工具注册**：用 `ctx.tools.register` 在 host 行上注册 `why_check`、`why_file`、`why_find`、`why_recall` 四个全局工具，`execute` 按会话 cwd 解析路径（`dsh/lib/index.js:877-887`），另外注册了 `/why` 命令（`:890-901`）。
- **上下文注入**：两种方式。一是全局提示段 `thoughtdag-why`（`dsh/lib/index.js:903`）。二是 `agent.inject(...)`，`source` 为 `{ kind: 'plugin', plugin: 'dsh-thoughtdag' }`（`:421`），调用点有两个：HTTP 端点 `POST /thoughtdag/api/sessions/<id>/inject`（`:1100-1104`），以及「从画布发问」流程里先 inject 画布上下文、再 `sessionController.prompt`（`:780-787`）。
- **会话创建**：用 `sessionController.create({ cwd })` 新建会话，或者 `sessionController.fork({ sessionId, atSeq })` 从某个已结束的轮次分叉（`dsh/lib/index.js:696-708`）。调用时没有传 `agentPreset`。在 alpha.2 上，`sessionController.create` 的请求可以带 `agentPreset`（dsh `packages/api/session-controller/src/index.ts:266-273`，`src/agent.ts:382-391`）。
- **拿回结果**：没有结构化结果。`runAgentTurn` 订阅 `ctx.on('session/event')`，用 prompt 的 `requestId`（写在 `user/message` 的 `source.rpcId` 上）认出自己发起的那一轮，把 `assistant/chunk` 文本、`tool/call` 名称和参数转成 SSE 帧，收到 `turn/end` 就结束，返回值是 `{ sessionId, text }`（`dsh/lib/index.js:682,736-794`）。另外它用 `approval/request` waterfall 把审批转给画布来答（`:646-660`）。
- **HTTP 接口**：有，但没有另起服务器。它在 dsh 已有的 WebServer 上注册 `/thoughtdag`（exact，302 跳转）、`/thoughtdag/api`（prefix）和 `/thoughtdag`（prefix，静态资源）（`dsh/lib/index.js:1136-1138`）。README 原话「no second process, no second port」（`dsh/README.md:12-13`）。`/thoughtdag/api` 下有读会话日志、fork、inject、followup、流式问答、模型列表等端点（`dsh/README.md:29-43`）。
- **认证**：`/api` 只校验 Host 头，放行 `localhost`、`127.0.0.1` 和配置里的 `trustedHosts`，没有调用 `ctx.connection.admit`，也不校验 cookie（`dsh/lib/index.js:911-916`；`dsh/README.md:49`）。所以同一台机器上的任何进程都能通过它创建会话、inject、prompt。
- **进程**：与 dsh 运行时同一个进程。client 半边是浏览器模块，往 Slot `conversation.session.header.actions` 注册「对话 | 思维图」切换按钮，用同源 iframe 打开 `/thoughtdag/`（`dsh/lib/client.js:1-30`）。

它和 1.1 那些项目的区别在于：它把「建会话、inject、prompt、流式收事件」包成了一组插件自定义的 HTTP 端点，进程外的调用方（它自己的 SPA）通过这组端点驱动 dsh 会话。

按「对 spike 的影响」里的分类，它属于 **C（同进程插件）**。区别是它把驱动接口开放成了 HTTP，给进程外的调用方用，表里单列为 E。

## 二、以 dsh 为主进程的单进程方案

### 2.1 逐项核实

| 要做的事 | 能否做到 | 出处 |
|---|---|---|
| 插件起自己的 HTTP 服务 | 能。插件就是 Node 代码，可以直接 `node:http`（reviewer-bot）；也可以用 `ctx.webServer.register / registerUpgrade`（exact 优先，其次最长前缀，最后 fallback；同 kind 同 path 重复注册会抛错）挂到已有的 WebServer | `packages/host/webserver/src/index.ts:42-56,166-199`，`README.md:45` |
| 挂在 dsh WebServer 上的路由有没有认证 | WebServer 本身没有认证。路由要么自己调 `ctx.connection.admit(req)` 套用 cookie 认证，要么自己做认证 | `webserver/README.md:113`；`docs/subsystems/web-server.md:83-91` |
| 对外监听 `0.0.0.0` | `dsh web --host 0.0.0.0` 被 CLI 拒绝（`packages/bundle/web-app/src/startup.ts:74-75`）；webserver 插件的 schema 允许 `0.0.0.0`（`webserver/src/index.ts:127`），但 README 写明「Binding a non-loopback address still exposes unprotected routes」。webhook 官方示例的做法是绑 `127.0.0.1`，外面再套 TLS 反代 | `webhook-github/README.md:72` |
| 创建会话、指定 preset | 能，写法和 `webhook` 的 `createWebhookSession` 一样。`agentPresets.mount` 的注释要求在 `setup` 回调里、agent 发布前调用 | `packages/preset/agent-preset-registry/src/index.ts:238-243` |
| 注入上下文 | `agent.inject(message)`：把上下文排进下一次 pre-step，不唤醒 driver。agent 空闲时，它要等下一次 `followup` 或 steer 才会生效 | `packages/core/agent/src/runtime-types.ts:230-241` |
| 注册评审工具 | 在 `setup` 里用 `agentCtx.plugin(...)`，或 `agent.ctx.tools.register`，只对这个 agent 可见 | `packages/core/agent/README.md:63` |
| 拿结构化结果 | 进程内有三条路：上报工具的 `execute` 直接写我们的 PG；订阅 `session/event` 读 `tool/call` 参数；`ctx.subagents.start(…, { outputSchema })` | 见 1.1、1.2 |
| 一个进程跑多个评审会话 | 能。`ctx.agents` 按 SessionId 建键 | [research/13 §3.6](13-dsh-嵌入形态.md) |
| 沙箱根是不是进程级 | **不是**。`resolve()` 用的是 `session?.header.cwd ?? this.workspaceRoot`，构造函数里的 `process.cwd()` 只是兜底（`packages/sandbox/sandbox-policy/src/index.ts:131,168`，`README.md:48`）。`0.1.5-rc.2` 同一位置（`:167`）也是这样，research/13 §3.6「同进程只有一个文件沙箱边界」这条读错了 | 同左 |
| 仍是进程单例的东西 | jobs 注册表（`packages/jobs/jobs-local/README.md:77`）、会话投影单元表（`packages/session/session-projection/README.md:131`）、subagents 服务；没有按会话的 CPU 或内存配额（research/13 §3.6） | 同左 |

### 2.2 打包与安装

- profile 目录是 `$DSH_HOME/profiles/<name>/`，里面有 `package.json`（pnpm 管理的依赖加 `dsh.profile.bundles` 的有序列表）和 `cordis.patch.yml`（`publish.md:66-101`）。层的叠加顺序：各 bundle → profile 的 patch → `$DSH_HOME/cordis.patch.yml` → `--patch`；patch 会整体替换一行的 `config`（`publish.md:118-132`）。
- 安装：`dsh plugin --profile <name> add <npm 包 | ./目录 | tarball | git>`，这个命令把参数原样转发给 profile 目录里的 pnpm（`apps/cli/src/plugin.ts:12-24`）。patch 里也可以直接写相对路径的 `.mjs`（`github-review/cordis.yml:8-9`）。
- 内置模板有 `web`、`acp`、`headless`、`sdk`、`sdk-minimal`（`packages/boot/app-boot/src/profile.ts:155-172`）。`acp-app` 就是 `dsh-base` 加上 `acp` 这一行，没有 `agent-preset-registry`（`packages/bundle/acp-app/cordis.patch.yml`）。
- app-boot README 的定位：「Product features belong in profile bundles instead of new application bins」；直接调用 `boot()` 只留给「lower-level embedders and tests」（`packages/boot/app-boot/README.md:12,32`）。`boot()` 的签名和 0.1.5 相同（`src/index.ts:954-960`）。

### 2.3 部署成 Docker 镜像的代价

- 仓库里没有 Dockerfile，也没有官方镜像（`git ls-tree` 里没有 docker 或 containerfile 相关文件）。SAFETY.md:7 原文：「must not be treated as secure or production-ready」。
- profile 目录要可写：CLI 启动时会重写 profile 里的 `cordis.yml`（`apps/cli/src/profile-boot.ts:80-84,169,202`）；插件依赖由 pnpm 装进 profile 的 `node_modules`（`nodeLinker: hoisted`，`profile.ts:198-207`）。镜像里可以在构建阶段先 `dsh plugin add` 装好。运行时会不会再改 `node_modules`，**未查到**。
- Node 版本要求 `^22.19.0 || >=24.0.0`（根 `package.json:8-10`）。我们的服务端代码和 dsh 同一个 Node、同一份 Cordis。
- 版本漂移的实例：maestro 在同一个 `package.json` 里同时依赖 `dsh-agent-presets@0.1.6-alpha.2` 和其余 `0.1.7-alpha.2` 的包，而 alpha.2 里这个包已改名为 `dsh-agent-preset-registry`（`packages/acp/acp/src/index.ts` 注释中的包名变化）。

### 2.4 判断

**有条件可行。** 能做到的依据：maestro 在 `0.1.7-alpha.2` 上已经把 GitLab webhook、进程内建会话、挂 preset、agent 私有工具、收 finding 串成了一条链（1.1）；第一方的 `webhook` 包也是同样形状（1.2）。条件如下：

1. 服务端必须是 Node，版本与 dsh 对齐。
2. HTTP 面、认证、多租户都由我们自己挂：dsh 的认证是单 operator、单 launch token 的模型（`packages/client/connection/README.md:37-45`）。
3. 接受同进程：一个会话跑飞会拖累 HTTP 与队列；jobs、会话投影、subagents 这些进程单例是共享的。
4. 接触面从「ACP 方法表」扩大到 `ctx.agents`、`agentPresets`、`agent/created`、`SessionEvent`、webserver 这些插件 API。`docs/architecture.md` 的铁律一列出的扩展点都在其中，但这些 API 在每个 alpha 版本都可能变化（例如 `agent/created` 在 0.1.7 从 emit 改成了 serial，`agent/session-start` 被删除，见 `.agents/notes/implemented/architecture/2026-09-09-awaited-agent-creation.md`）。

### 2.5 `packages/sdk` 是不是另一条进程内的路

不是。`@deepseek-ai/dsh-sdk-client` 的原文是「spawn the same-version `dsh --profile sdk` runtime as a subprocess」（`packages/sdk/client/src/index.ts:1-9`）。协议和 0.1.5 一样，只有 3 个请求加 4 个通知（`packages/sdk/protocol/README.md:36-46`）。`InitializeParams` 里没有 preset 字段（`protocol/src/types.ts:16-26`）；没有取消，原文「a client abandons a turn by closing the runtime process」（`protocol/README.md:114`）；也没有结构化结果（`types.ts:56-58`）。进程内的入口只有 `boot()` 加 `ctx.agents.create`。

## 三、dsh 的 web 是什么

- **组成**：
  - `apps/web` 是 `@deepseek-ai/dsh-web-frontend`，一个 Vite 构建，「dist/ served by apps/cli's dsh web」（`apps/web/package.json:2-3`），不能独立运行（`packages/bundle/web-app/src/index.ts:144`）。
  - `packages/web/*` 与 Web UI 无关，是给模型用的联网搜索和抓取（`packages/web/README.md:12`）。
  - `packages/host/webserver` 是 HTTP 服务器。
  - `packages/bundle/web-app` 是 `web` profile 的 patch 层加一个胶水插件。
- **进程**：同一个进程。`dsh web` 会被展开成 `--profile web`（`apps/cli/src/args.ts:92,201-202`），`runProfile` 在当前进程里挂载 `dsh-base` 加 `dsh-web-app` 的整棵树（`apps/cli/src/bin.ts:35-44`；`packages/boot/app-boot/src/profile.ts:160-161`）。桌面版也是这样：`apps/desktop-host` 用同一个 `runProfile` 起 `desktop` profile，监听 19387 端口（`apps/desktop-host/src/index.ts:24-30`）。
- **启动**：`dsh web [--port N] [--host H] [--trusted-host A] [--no-open]`，默认 `127.0.0.1:3080`（`web-app/cordis.patch.yml:154-155`），会打印带 token 的 URL。
- **接口**：
  - 单次调用：`POST /api/<namespace>/<method>`，请求体是 JSON 信封（`packages/client/connection/src/client/rpc.ts:40-56`，服务端在 `rpc-host.ts:229-262`）。
  - 流式调用：WebSocket `/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts:7`）。
  - 面向外部调用方的线协议稳定文档：**未查到**。`docs/api-gateway.md` 讲的是内部的 `@Remote` 编程模型。官方给程序化调用的路是 ACP、SDK 和 Python SDK。
- **认证**：先过 Host/Origin 栅栏（失败返回 403），再校验 launch token 换来的 cookie（失败返回 401）。原文「The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token」（`packages/client/connection/README.md:39`）。外部程序能调，但必须先 `GET /?token=` 换 cookie，dsh 自己的 e2e 测试就是这么做的（`apps/cli/tests/web-auth.e2e.ts:173-183`）。token 只出现在 stdout，每次重启都会换。所有请求都算作同一个 operator（`README.md:45`）。
- **插件挂路由与页面**：
  - 路由：用 2.1 那几个 `ctx.webServer` 方法。`/api` 前缀归 Connection 所有，fallback 席位在 web profile 里已被 `frontend-static` 占用（`docs/subsystems/web-server.md:27`）。
  - 页面：在 `sidebar.panellist` 放入口图标，在 `main` 用同一个 id 注册整页（`packages/client/ui-sidebar/README.md:36`）。第三方的 client 插件在 `package.json` 声明 `dsh.client`，并导出 `./client` 的打包产物（`docs/subsystems/client-modules.md:80-88`）。

## 对 spike 的影响

下表只列事实，不做取舍。「注入」指把本次适用的规范送进模型上下文；「工具」指评审专用工具；「回收」指结构化 finding 回到我们的服务。

| 形态 | 注入 | 工具 | 回收 | 已知代价 |
|---|---|---|---|---|
| **A. ACP 加 profile 插件**（现决策 B1） | 能。插件监听 `agent/created`（串行，创建完成前会 await 它），调 `agent.inject`，第一方 `hooks-claude-code` 就这么做（`packages/hooks/hooks-claude-code/src/index.ts:209-220`）；或者注册提示段。也可以把规范直接放进第一条 `session/prompt` | 能。在 `agent/created` 里 `agent.ctx.tools.register`，写法同 `schedule`（1.2）；或者作为 host 行全局注册 | 能。ACP 把每次工具调用的参数以 `tool_call.rawInput` 转给客户端（`packages/acp/acp/src/updates.ts:52-60`），我们的服务从 ACP 流里读上报工具的参数；插件也可以在 `execute` 里自己写库。自定义 `SessionEvent` **不会**经 ACP 转发（`README.md:92`） | ACP 的 `session/new` 只带 `cwd` 和 `mcpServers`，不读 `_meta`，没有 preset 字段（`index.ts:195-203`，`session.ts:128-137`）。插件要知道「这是哪次评审、该注入哪些规范」，只能从 cwd、prompt 或外部查询推出来。`agentPresets.mount` 要求在 `setup` 里调用，ACP 的 `setup` 不归插件管，所以插件在 `agent/created` 里挂 preset 这条路**未验证**。插件要进 profile 依赖图 |
| **B. ACP 会话挂 MCP 服务器**（我们的服务提供 HTTP MCP 端点） | 能。MCP server instructions 会被注册成 `mcp:<server>` 提示段（`packages/mcp/mcp-client/src/server-context.ts:28-39`，上限 32768 字节，`src/index.ts:73`）；也可以把规范放进 prompt | 能。`session/new` 的 `mcpServers` 支持 `type: 'http'`，还能带 header，挂在 agent scope 上（`packages/acp/acp/src/mcp.ts:26-32,60-70`）。工具名是 `mcp__<server>__<tool>` | 能。上报工具就在我们自己的进程里执行，finding 直接落库；header 可以带评审 id 或一次性凭证 | 不写 dsh 插件，也不改 dsh profile。dsh 进程要能通过 HTTP 连到我们的服务。instructions 提示段在 agent scope 下能否送到模型，只读了源码，**未实测**。按会话的 preset 同样没有 |
| **C. 单进程 host 插件**（我们的服务作为 dsh 插件，或以 `boot()` 起 dsh） | 能。`agent.inject`，或在 `setup` 里挂 preset | 能。在 `setup` 里用 `agentCtx.plugin` / `tools.register` | 能。工具的 `execute` 直接写 PG；或订阅 `session/event`；或用 `subagents.start` 加 `outputSchema` | 见 2.4 的四个条件。唯一能按会话选 preset 和 permission preset 的形态（webhook、maestro 的写法）。thoughtdag 属于 C 的一个变体：同进程，但把驱动接口开放成 HTTP，见 E。没有官方镜像，profile 要可写 |
| **D. SDK（`--profile sdk`）** | 只能放在 prompt 里 | 只能用 profile 里带的工具（需要另写插件） | 没有；结果要从会话事件里自己拼 | 没有取消、没有 preset，cwd 是进程级的（2.5）。只是换了协议的进程外路径，不是进程内嵌入 |
| **E. thoughtdag 式 HTTP 桥**（web profile 插件在 dsh 的 WebServer 上开一组 HTTP 端点，我们的服务在进程外调用） | 能。端点内部调 `agent.inject`（thoughtdag `dsh/lib/index.js:1100-1104`） | 能。插件 host 行上注册全局工具（thoughtdag `:877-887`）；也可以在 `agent/created` 里按 agent 注册 | 能。端点可以把上报工具的 `tool/call` 参数经 SSE 转出，thoughtdag 转出的是工具名和参数（`:772-774`）；插件也可以直接写库 | 可以按会话选 preset：`sessionController.create` 接受 `agentPreset`（1.3），这是 ACP 做不到的。代价：必须跑 web profile，整套 UI 平面、`sessionController` 都要带上；HTTP 协议要我们自己设计、自己维护；thoughtdag 的端点只校验 Host 头，任何本机进程都能调用，放进容器网络时 Host 要进 `trustedHosts`，认证要另加（例如调用 `ctx.connection.admit` 或自带 token）；它声明兼容的最高版本是 0.1.5-rc.2，在 alpha.2 上**未验证**。照搬时能直接用的是它的写法：用 `requestId` 认出自己发起的那一轮、订阅 `session/event`、用 `approval/request` 接管审批。它的读日志、画布、多 agent 目录等功能和评审无关 |

几条跨形态的事实：

- 任何一条经 ACP 或 SDK 建的会话都不加入 preset，工具、提示段、skill 读的是 host 全局层（`packages/acp/acp/src/index.ts:199-202`；`packages/sdk/server/src/server.ts:277-291`）。`acp` profile 基于 `dsh-base`，全局层里有 bash、fs、skill 等工具（`packages/bundle/base/cordis.patch.yml:266-304`），所以 ACP 建出的 agent 不是空的。这一点修正了 architecture.md 里「全空且不报错」的说法：那句话适用于 `web` 那种把工具行都挪进 preset 的组合。
- ACP 没有按会话设 permission preset 的入口。沙箱模式的默认值取自环境变量 `DSH_PERMISSION_MODE`，未设时是 `workspace-write`（`packages/bundle/base/cordis.patch.yml:229-232`）；插件可以调 `permissionPresets.set(session, name)` 改单个会话（`packages/interaction/permission-presets/src/index.ts:392`）。审批请求会以 `session/request_permission` 发给客户端（`packages/acp/acp/src/index.ts:152-172`）。
- 进程内一等的结构化输出机制只有子 agent 的 `structured_output`（1.2），根会话没有。几种形态里「回收」实际走的都是「上报工具的参数」这一条。
