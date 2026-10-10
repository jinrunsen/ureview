# dsh 会话查看器

独立 iframe 页面通过同源 `GET /api/agent-sessions/:id/events` 读取已授权的会话记录。构建产物位于 `dist/`，服务挂载到 `/agent-session-viewer/`。页面参数 `session` 是 uReview 的会话记录 ID。

## 官方 UI 接口

所有 dsh 客户端依赖固定为 `0.1.7-alpha.2`，与服务运行时版本一致。`official-modules.ts` 加载 npm 包公开的 `./client` 制品，遵循 `window.__ModuleLoader__.load({ id, factory })` 协议，向 `factory(require)` 提供同一份 React、Cordis、Store、Slots 和 UI primitives。原始制品和样式保持不变。模块协议见官方 [Client modules 文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/modules/README.md)。该组合使用固定模块表，没有宿主插件加载、HMR 或配置修改入口。

界面通过以下公开扩展点组合：

- [UI renderer / Slots](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-renderer/README.md)：`apply`、`uiRenderer.mount`、`slots.register` 和 `SessionProvider`。
- [UI conversation](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-conversation/README.md)：`UiConversation`、`ConversationBinding` 和 `conversation.view`。
- [UI chat](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/README.md)：官方 Chat、工具卡与滚动行为。另挂载官方 Trajectory 查看请求、上下文和工具原始数据。
- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/api/session-controller/README.md)：实现公开 `ISessions`、`SessionBinding`、`SessionEventSource` 读面，将 HTTP 追加页交给官方 Conversation assembler。

查看器不挂载消息输入框。官方 Chat 的 `turn-tail` 节点含派生会话操作，使用公开 keyed slot 覆盖该尾部节点；所有会话写方法也在适配器内拒绝。模型、工具、设置均没有远程写通道。官方工具槽位的独立中文文案通过 `locale.register` 提供。

对话布局由查看器自己的容器提供：正文居中、最大宽度 920px，桌面两侧各 32px、500px 以下各 16px 留白。原始轨迹使用完整可用宽度。官方已完成会话按用时和工作步骤折叠，展开步骤后显示工具名称与参数摘要，再展开工具卡查看输入和结果；页面提供展开提示。布局选择见[对话布局与工具展开](../../.agents/notes/implemented/bug-fix/2026-10-06-session-viewer-chat-layout.md)。

运行中每 1.5 秒读取增量；完成后每 10 秒核对权限。网络异常保留已读内容并重连；401、403、404 会立即清空正文。服务端负责每次读取的授权和敏感字段投影。Chat 与 Trajectory 中的图片引用目前只提示附件不可用，不开放宿主文件系统。

## 验证

`npm run build -w @ureview/session-viewer` 执行类型检查与构建；`npx vitest run packages/session-viewer/src/session-source.test.ts` 覆盖分页追加、权限拒绝和本地写操作拒绝。浏览器验证使用真实 uReview HTTP、PostgreSQL、dsh 记录，平台和 LLM 为协议样例。
