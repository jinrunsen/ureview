# 测试策略

两条接缝、打桩边界、场景与工单的对应关系，以及装不进 `.feature` 的验收判据。架构在 [architecture.md](architecture.md)。

**一条硬边界：`.feature` 不测 AI 判得准不准。** 测试里 LLM 是打桩的，场景测的是流水线接线、数据正确性、状态流转、降级路径。AI 质量由另一套机制管——二值标注 benchmark 加重跑稳定性（[评估基线](../.agents/notes/proposed/testing/2026-09-12-evaluation-baseline-benchmark.md)）。两套机制混在一起两边都测不准。

## Testing Decisions

### 什么算好测试

只断言外部可观察的行为，不断言实现细节。具体到这个产品，有一条特别的边界要守住：

**`.feature` 不测 AI 判得准不准。** 场景测的是流水线接线、数据正确性、状态流转、降级路径。AI 质量由另一套机制管——二值标注（「你会不会动手改」）加七个埋点字段的 benchmark，以及重跑稳定性。（source: issues/14-评估基线-benchmark-构造与重跑稳定性.md）两套机制不该混，混了两边都测不准。

### 两条接缝

**接缝 A：uReview 服务的 HTTP API**（`@layer:api`）

真跑：服务、PG（含队列）、**dsh（同进程，服务作为 host 插件）**、真实 volume（ripgrep 绕过 `ctx.fs`，工作副本必须落真盘）。
打桩：**代码平台 provider**、**LLM**。

- 接入测试使用官方协议构造的人工样本，本地 Git HTTP 后端验证实际读取；当前没有真实 GitLab 输入。现有 [Qodo 素材](research/qodo-real-comments/)只有评论与局部定位信息，不能代替 GitLab 项目、完整 diff 或 webhook 载荷。真实实例可用后补联调和采集。（source: [接入决定](../.agents/notes/implemented/architecture/2026-10-02-gitlab-repository-onboarding.md)）
- LLM 打桩之后 dsh 变成确定的编排器，**测它就是在测服务与 dsh 同进程接线这条最大的风险**，以及规范 `agent.inject()`、工具返回值裁剪这两处最容易被 dsh 上游变更打到的地方。
- 不打在流水线函数上：那样绕过队列、持久化和锚定重算，而**锚定失效看起来是前端问题、实际是数据模型问题**，必须跨持久化才测得到。

**接缝 B：浏览器端到端**（`@layer:e2e`）

给「评审在这里完成」这条品类定义配可执行的验收。

**两条接缝的分工必须划死，否则双写必然漂移：**

| | 管什么 | 不管什么 |
|---|---|---|
| **A（API）** | 触发与幂等、流水线产出、finding 字段与追溯、状态流转、处置落库、锚定重算、规范硬过滤与继承、统计口径、降级路径 | 任何渲染与交互 |
| **B（E2E）** | 综述到 finding 到 diff 的**下钻路径**、行内处置、讨论串与未读、`Outdated` 的**降级展示**、「还有 N 条已折叠」的展开 | **不重复断言任何数据正确性**——那是 A 的事 |

判据：一条场景如果 API 层断言得了，就不进 E2E。

### 场景分两批

`npm run test:api` 选择 Story 01–04、Story 06–20、Story 22–26 的 179 条 API 场景；Story 05 的综述场景已随 Story 24 退役。每条使用独立 PostgreSQL 数据库与随机 HTTP 端口；仓库接入使用接入适配器桩，其余场景运行真实服务、正式 dsh profile、Git 工作副本和只读文件工具，GitLab 与模型使用本地协议桩。规范变更通过真实 Git 提交验证。场景是否已验收以执行记录与 `@status:pending` 为准。

场景循环使用 Cucumber：核对场景与步骤、聚焦执行、独立只读审查、整批回归后，依据执行结果逐条移除通过场景的 `@status:pending`。下钻、返回与代码高亮使用浏览器接缝；API 通过不改变未实测浏览器场景的状态。

| Story | 场景标签 | API 场景数 |
|---|---|---|
| [01 仓库接入](../requirements/01-v1-qodo-reproduction/01-connect-gitlab-repository/spec.md) | `@story:repository-onboarding` | 3 |
| [02 新 PR 评审](../requirements/01-v1-qodo-reproduction/02-review-new-pull-request/spec.md) | `@story:review-new-pull-request` | 11 |
| 02 仓库评审排除目录 | `@story:review-exclusions` | 3 |
| [03 规范参与评审](../requirements/01-v1-qodo-reproduction/03-review-with-repository-rules/spec.md) | `@story:repository-rules` | 5 |
| [04 代码锚](../requirements/01-v1-qodo-reproduction/04-drill-into-finding-code/spec.md) | `@story:drill-finding-code` | 1 |
| [06 展示策略](../requirements/01-v1-qodo-reproduction/06-prioritize-review-findings/spec.md) | `@story:prioritize-findings` | 5 |
| [07 历史轮次](../requirements/01-v1-qodo-reproduction/07-rerun-and-read-review-rounds/spec.md) | `@story:review-rounds` | 5 |
| [08 评审列表](../requirements/01-v1-qodo-reproduction/08-find-reviews-in-list/spec.md) | `@story:review-list` | 5 |
| [09 身份与团队](../requirements/01-v1-qodo-reproduction/09-team-identity/spec.md) | `@story:team-identity` | 5 |
| [10 讨论与通知](../requirements/01-v1-qodo-reproduction/10-review-collaboration/spec.md) | `@story:review-collaboration` | 5 |
| [11 规范目录与候选](../requirements/01-v1-qodo-reproduction/11-rule-catalog-and-mining/spec.md) | `@story:rule-catalog` | 6 |
| 11 数据库规范 | `@story:managed-rules` | 9 |
| 11 规范持久会话 | `@story:rule-sessions` | 3 |
| [12 服务配置](../requirements/01-v1-qodo-reproduction/12-service-settings/spec.md) | `@story:service-settings` | 4 |
| 12 模型密钥显隐与验证 | `@story:model-connections` | 4 |
| [13 通用会话查看器](../requirements/01-v1-qodo-reproduction/13-agent-session-viewer/spec.md) | `@story:agent-sessions` | 5 |
| [15 规范分层与效力](../requirements/01-v1-qodo-reproduction/15-rule-hierarchy/spec.md) | `@story:rule-hierarchy` | 12 |
| 16 规范库浏览与应用 | `@story:rule-library` | 9 |
| 19 规范详情 | `@story:rule-detail` | 1 |
| 19 规范提案 | `@story:rule-proposals` | 5 |
| 17 逐条处置 | `@story:finding-disposition` | 8 |
| 17 多轮对比 | `@story:round-comparison` | 1 |
| 17 规则结论 | `@story:review-conclusion` | 3 |
| 18 身份与待办 | `@story:my-inbox` | 3 |
| 18 负责人概览 | `@story:lead-overview` | 1 |
| 18 即时通讯推送 | `@story:im-push` | 3 |
| [20 仓库详情](../requirements/01-v1-qodo-reproduction/20-repository-detail/spec.md) | `@story:repository-detail` | 11 |
| [22 引导与实例健康](../requirements/01-v1-qodo-reproduction/22-private-deployment-onboarding/spec.md) | `@story:onboarding-and-health` | 6 |
| [23 保留评审结果](../requirements/01-v1-qodo-reproduction/23-keep-review-results/spec.md) | `@story:keep-review-results` | 3 |
| [24 解读讲清实现](../requirements/01-v1-qodo-reproduction/24-reading-explains-implementation/spec.md) | `@story:reading-explains-implementation` | 11 |
| [25 导入企业规范](../requirements/01-v1-qodo-reproduction/25-import-enterprise-rule-library/spec.md) | `@story:rule-library-import` | 8 |
| [26 企业账号登录](../requirements/01-v1-qodo-reproduction/26-enterprise-sso-login/spec.md) | `@story:enterprise-sso` | 14 |

2026-10-03：独立审查与问题修复复核通过；`npm test` 的 16 个文件、185 项测试，`npm run test:api` 的 34 条场景、254 个执行步骤（含 68 个前后置步骤），以及根目录类型检查、前后端构建均通过。按 Cucumber JSON 逐条核对所有步骤和前后置步骤后，移除本轮 22 条 API 场景的 pending，另 12 条已验收 API 场景保持原状态。

浏览器使用用户授权的 agent-browser CLI 0.25.4 与系统 Chrome 154，操作构建后的 Web 和真实 HTTP 服务。Story 04 的唯一在期 E2E 场景按原步骤执行、独立审查、最终重跑通过后移除 pending：高危 finding 下钻到正确新侧代码行，行内卡片与语法高亮可见，返回按钮和浏览器后退恢复滚动、展开与焦点。其余五条延后 E2E 场景保留 pending。

2026-10-03：八个 story 的本期交付已完成。浏览器补充验收覆盖接入、规范来源、Mermaid 绘制及源码降级、旧锚与片段外位置、五条上限、重跑与历史、筛选分页及查看标记。主链路经真实 PostgreSQL、Git 工作副本和正式 dsh 生成；UI 边界使用独立数据库中的明确构造记录，不作为 API 数据正确性的证据。GitLab 和模型均为人工协议样本；真实 GitLab 网页、实例联调与模型评审质量未由本轮验收证明。Mermaid 显示修复后，前端 18 项测试、类型检查、构建和浏览器主路径再次通过。

仓库规则注入的单元测试覆盖 Markdown 路由、多层目录、glob、预算、去重刷新、UTF-8 与路径边界。运行时测试覆盖成功 `read` / `grep` 后的注入、两阶段独立账本、规则快照与引用约束；仅展示索引不能取得规范引用资格。API 场景验证数据库全局规范与仓库规范的共同注入、数据库版本快照，以及未启用全局规范时仍可完成评审。

2026-10-04：仓库 Markdown 注入与手动 PR 链接入口完成后，255 项单元测试及 36 条 API 场景、268 个执行步骤通过。两条手动入口场景经独立审查和聚焦回归后移除 pending。模型仍由协议桩提供，这些结果验证流水线与数据约束，不代表真实模型的评审质量。

2026-10-04：R22–R24 的实现经独立审查，22 个文件、285 项测试及 50 条 API 场景、372 个执行步骤整批通过。随后新增正式 dsh 与强制 RLS 数据库的集成回归，所在运行时测试文件 31 项聚焦通过。验证 Generator finding 回调、两阶段规范回调的实时持久化、认证 HTTP 读取与无团队上下文时的隔离；测试总数为 286。类型检查、构建、Agent Note 与场景认领检查通过。

团队协作浏览器验收使用 agent-browser CLI、构建后的 Web、真实 HTTP 与独立 PostgreSQL 数据库。首次初始化、登录、成员管理、团队切换、规范目录、候选证据和复制操作均实测通过；未读提示到 finding 讨论、滚动与焦点定位、发送带引用的回复及保留评审上下文的 E2E 场景经独立审查和最终复跑通过。14 条新增 API 与该 E2E 场景移除 pending，其他延后场景保持原状。GitLab、模型和通知出口使用本地协议样本，未向真实第三方发送通知。

2026-10-04：浅色工作台的两条导航 E2E 场景经独立审查和 agent-browser 最终复验通过，移除 pending。验证仓库到规范的筛选保留、搜索、详情、候选刷新与复制反馈，以及 390px 窄屏导航、成员表格独立滚动和通知表单入口。另行实测详情关闭后恢复焦点、侧栏 Tab 循环与 Escape 返回、评审页内定位、代码下钻返回和未读讨论回复。前端 3 个文件、19 项测试，根目录类型检查、前端构建与 Docker 镜像构建通过。浏览器使用构建后的 Web、真实 HTTP 和独立 PostgreSQL 数据库，GitLab 为本地协议桩，评审展示记录为预置样本；未发起模型评审，未重复运行整批 API 场景。

2026-10-04：数据库规则生成、草稿保存、启用与编辑经独立审查通过。全量单元测试 25 个文件、307 项及 56 条 API 场景、418 个执行步骤通过，类型检查、前后端和 Docker 构建通过。新增 6 条 API 场景使用真实 dsh、非特权 PostgreSQL 与 Git 工作副本，仅桩模型和平台协议；覆盖生成失败不落库、属性持久化、权限隔离、版本冲突、作用范围匹配、严重级别映射和停用后的历史快照。

规则编辑浏览器验收使用 agent-browser CLI，覆盖生成与编辑、多仓库路径、保存启用后详情和搜索、移除当前筛选仓库后的定位、冲突后保留编辑并核对最新版本、手机宽度及成员只读。新增 1 条 E2E 场景完成独立审查与浏览器复验。另使用部署配置中的真实 Generator 执行一次规则草稿生成，返回的正文、示例、分类和严重级别通过结构校验；该冒烟只证明模型连接与生成协议，不证明规则或示例的判断质量。

2026-10-04：仓库 lint 目录经独立审查通过。静态元数据解析 40 项、目录与数据库 14 项、仓库规则与数据库规则及前端回归 56 项通过；规范相关 17 条 API 场景、132 个步骤通过。类型检查、构建和仓库检查通过。agent-browser 验证 Lint 列表、搜索、仓库筛选、重新同步、来源详情、空态、切回规范及 390px 窄屏详情；使用真实 HTTP 与独立 PostgreSQL，GitLab 为协议样本。扫描不运行 lint 脚本，未验证实际 lint 执行。

2026-10-04：规范持久对话经独立审查与修复复核通过。28 个文件的 373 项单元测试、60 条 API 场景与 450 个步骤通过；跨宿主恢复场景另外核对第二轮首个模型请求含第一轮完整工具调用与配对结果。类型检查、前后端构建、Docker 镜像构建和仓库检查通过。API 使用真实 HTTP、非特权 PostgreSQL 与正式 dsh，模型为协议桩。

规范会话浏览器使用 agent-browser 验证刷新恢复、多轮微调、历史打开、保存后继续对话、多仓库路径与 390px 窄屏；补充慢网保存时继续输入后关闭、生成中关闭再恢复指定仓库范围，以及空稿并发冲突后核对并继续生成。真实 DeepSeek Generator 两轮冒烟返回有效草稿，第二轮包含追加要求；该验证证明连接与多轮协议，不代表规范判断质量。服务已更新，数据库和健康检查正常。

2026-10-04：评审排除目录经独立代码与步骤审查通过，419 项单元测试、63 条 API 场景与 473 个步骤，以及类型检查、镜像构建和仓库检查通过。新增 3 条场景使用真实 HTTP、非特权 PostgreSQL、Git 工作副本和正式 dsh，模型与平台为协议桩；验证两个模型的上下文没有排除代码、全部排除时零模型请求，以及重跑与历史范围。运行时回归另覆盖符号链接、排除目录中的规范及重命名两侧。

排除配置的 agent-browser 验证覆盖保存与刷新、版本冲突后保留输入并核对、成员只读、390px 窄屏，以及全排除的列表和详情提示。浏览器使用真实 HTTP 和独立 PostgreSQL，评审展示为预置样本，数据正确性由上述 API 场景验证。

2026-10-05：通用会话查看器通过 37 个文件、445 项单元测试及 72 条 API 场景、527 个步骤，类型检查、构建与仓库检查通过。新增 5 条 API 场景使用正式 dsh、真实 HTTP 和非特权 PostgreSQL，验证两阶段事件及工具结果、宿主重建后历史不变、运行中增量、规范失败后重试保留记录、团队隔离和只读接口。存储测试另覆盖越权读取、登录撤销、敏感数据投影与旧规范检查点导入。

agent-browser 验证 PR 与全局列表打开同一会话、Generator/Grader 切换、官方工具参数与结果、对话和原始轨迹、全屏及关闭后的滚动与焦点恢复；规范编辑器嵌套查看与 390px 全屏布局通过。iframe 内 Escape 返回入口，官方工具弹层先关闭自身并保留父抽屉。增量与断连样例验证追加展示、503 后保留正文并重连、403 后清空正文。平台与模型使用协议样例；这些结果不证明真实模型回答质量。

ainative 部署 `ureview:20261005-agent-sessions`，执行迁移 `0014-agent-sessions.sql`。健康检查、工作台及查看器静态资源、未登录会话 API 拒绝访问均通过；已导入 1 个规范会话、35 条历史事件。

2026-10-05：模型密钥显隐与验证通过 40 个文件、474 项单元测试，以及 76 条 API 场景、550 个步骤；类型检查、构建和仓库检查通过。真实 dsh 适配器连接本地协议服务，覆盖三种模型协议、正式归属头、独立凭据、认证失败、网关插件要求、超时取消、思考模型的小预算终止与无效响应。新接口通过真实 HTTP、非特权 PostgreSQL 验证权限、版本冲突、按需显密、环境回退及验证不保存配置。

agent-browser 验证默认掩码、显示和隐藏、替换密钥、两阶段独立反馈、错误脱敏、保存及刷新后的回显、修改输入后丢弃旧结果、390px 布局，以及收到失权响应后清除密钥表单。新增 4 条 API 和 1 条 E2E 经独立审查和回归通过后移除 pending。

ainative 部署 `ureview:20261005-model-key-checks`，健康检查、页面静态资源和未登录密钥接口拒绝访问均通过。使用部署中保存的配置，经正式 dsh 适配器验证 Generator 与 Grader，两个模型均返回调用成功；验证未修改配置。

本机 `http://localhost:3000` 部署 `ureview:local-20261005-model-keys`，保留原有账号和数据并完成 14 项迁移。agent-browser 复用已有登录，验证两个阶段默认掩码、按需显示、隐藏后清空，以及真实连接验证按钮；Generator 与 Grader 均调用成功。未保存或替换模型配置，容器与数据库健康检查通过。

2026-10-06：仓库级评审排除目录通过 40 个文件、479 项单元测试，以及 76 条 API 场景、554 个步骤；类型检查、构建和仓库检查通过。排除目录保持 3 条 API 场景，认领由 Story 02 工单 08 承接，场景总数仍为 117。主场景增加同团队两仓实际评审，验证新仓默认空配置及模型上下文隔离；迁移测试验证团队配置删除与历史快照保留。agent-browser 在本地 3103 端口与独立数据库验证仓库编辑、并发冲突核对、成员只读、390px 窄屏和设置页入口。平台与模型使用协议桩，浏览器仓库为构造样本。

- **第一批（核心闭环）**：A 接入与触发、B 评审列表、C 综述、D finding、E diff 下钻、F 处置、J 异常与降级。
- **第二批**：G 讨论与通知、H 规范与挖掘、I 度量。
- 注意顺序上的一条硬要求：**I 的埋点字段要随第一批的 schema 落地**，场景可以在第二批，字段不能等。

2026-10-06：Story 23 保留评审结果通过最终全量 41 个文件、508 项单元测试，79 条 API 场景、574 个步骤，以及类型检查、构建和仓库检查。新增 3 条 API 场景使用真实 HTTP、非特权 PostgreSQL 和正式 dsh，验证拒绝后修正、放弃无效 finding 后保留综述、综述无法保留时的失败与提交历史；零 finding 和失败轮次均可关联模型身份。正式运行时回归覆盖真实 checkpoint 压缩后读取证据持续有效，以及并行报告故障后保留此前回执。

Story 23 的 agent-browser 验证覆盖拒绝原因展开、刷新、失败轮次、旧记录和 390px 布局，桌面与窄屏均使用真实指针展开与收起。浏览器使用人工展示样本、正式 HTTP 与独立 PostgreSQL；内网原始轮次未重放，模型判断质量不在本次验证范围。

2026-10-06：会话查看器对话布局与工具展开提示通过类型检查、完整构建、2 个文件 7 项相关单元测试和 76 条 API 场景、550 个步骤。新增浏览器场景经独立复核与 agent-browser 复跑，验证官方工具名称、参数摘要、展开输入与结果，以及全屏最大正文宽 920px、390px 窄屏留白和只读入口。全局、PR 与规范入口、运行中样本和原始轨迹另行实测通过。服务使用本地 3101 端口与独立 PostgreSQL；模型为协议桩，长正文和运行中状态使用展示样本。

2026-10-06：Story 14 解读生成通过 45 个文件、559 项单元测试，以及 86 条 API 场景、620 个步骤；类型检查、构建和仓库检查通过。新增 7 条 API 场景使用真实 HTTP、非特权 PostgreSQL、正式 dsh 和 Git 工作副本，验证分步报告、已读引用与摘录、补读重试、需求来源快照、双向失败隔离、finding 进行中读取解读及平台只读请求。模型和 GitLab 使用协议桩，未验证模型判断质量。迁移回归验证旧记录保留、独立解读会话与重复执行。

已有 Agent 会话查看器补充「生成解读」阶段。agent-browser 在本地 3107 和独立数据库验证阶段切换、工具展开、全局列表筛选和 390px 窄屏；本次进程与临时数据库已清理。解读正文与导出页面由 Story 14 工单 02 承接。

2026-10-06：Story 17 逐条处置与多轮对比通过 46 个文件、553 项单元测试，类型检查、完整构建与仓库检查通过。新增与接手的 9 条 API 场景经 69 步聚焦执行、独立只读审查及整批 88 条场景、647 步回归后移除 pending。迁移与服务测试使用非特权 PostgreSQL 验证历史状态和指纹回填、强制 RLS、版本并发、审计回滚及自动看完的事务一致性；API 使用正式 dsh、真实 Git 工作副本和平台、模型协议桩。最终页面版本合并回归另跑 38 项通过。

agent-browser 在本地 3106 与独立数据库 `ureview_b2` 验证卡片和 diff 行内采纳、驳回、撤回、其他说明必填、版本冲突后草稿保留及刷新、自动看完、规范采纳计数、多轮标记与历史理由，以及 390px 窄屏。浏览器展示数据为人工样本，未使用真实模型判断或内网部署。工单 03 的完整布局和对应 E2E 场景继续按原范围交付。

2026-10-06：Story 21 导航与设置、Story 20 仓库详情完成。最终类型检查、完整构建、45 个文件的 533 项单元测试、84 条 API 场景与 613 个步骤、仓库闸门全部通过。新增 5 条 API 场景验证自动开关、事件结果与保留上限、鉴权失败时间、GET-only 检测和成员权限。服务端回归另覆盖坏 JSON、超大载荷、并发裁剪、RLS、版本冲突与旧仓迁移。

agent-browser 在本地 3108、独立数据库 `ureview_c1` 实测三角色侧栏、头像菜单、本人改密、旧链接、发起评审弹窗、仓库四标签、排除目录、事件下钻、只读检测及 390px 布局；4 条新增 E2E 经独立审查和实测后移除 pending。提交中的弹窗保持打开，慢请求及失败后关闭均已验证。平台与模型为本地协议桩，规范与 lint 展示为构造目录，未验证真实 GitLab 权限或模型判断质量。

同一工单可以用多条 `**Scenarios:**` 行认领不同 feature，每行指定一个文件及其场景选择，检查器逐行校验唯一归属。

2026-10-06：Story 20、21 与 Story 14 解读生成、Story 17 处置及多轮对比合并回归通过。`npm install`、`npm run typecheck`、`npm run build` 完成；`npm test` 的 52 个文件、615 项测试，`npm run test:api` 的 100 条场景、724 个步骤全部通过。`npm run check` 确认 141 条场景全部被唯一认领；两边原有迁移与 GitLab 测试完整保留，冲突标记扫描与 `git diff --check` 通过。

agent-browser 在本地 3110、独立非特权数据库 `ureview_m1` 验证团队规范页与仓库规范标签的来源、命中/采纳/被无视三列、Git 统计排序、正文详情、仓库只读嵌入、Lint 子标签和三角色导航权限，团队管理员的旧设置链接进入团队设置。390px 视口中页面宽度为 390px，表格在各自容器内横向滚动。两类规范的展示样本均为命中 2、采纳 1、被无视 0，采纳经正式处置接口写入；平台与模型使用本地协议桩，未联调真实 GitLab 或验证模型判断质量。

2026-10-06：Story 17 评审页新版面、Story 14 解读阅读与导出通过 55 个文件、639 项单元测试，103 条 API 场景与 743 个步骤，以及类型检查、完整构建和 147 条场景认领闸门。新增 3 条规则结论 API 场景和 3 条 E2E，接手 1 条就地处置 E2E，既有下钻场景适配新布局。处置审计及 webhook 时间断言统一使用 PostgreSQL 时钟，消除与 Node 时钟的偏移。

agent-browser 在本地 3105、独立数据库 `ureview_b3` 验证默认解读、目录与引用下钻、返回位置与焦点、浏览器前进后退、行内注释开关、高危与问题联动、处置后保留选中文件、多轮参考、复制提示词、进行中与失败状态、依据追溯及 390px 布局。导出文档经断网打开验证图示、代码、六条逐行注释与全部摘录，未产生脚本或网络资源加载。页面使用人工展示样本与真实 HTTP、PostgreSQL；未联调真实平台或验证模型判断质量。

2026-10-06：Story 15 规范分层与效力通过 56 个文件、680 项单元测试，以及 110 条 API 场景、785 个步骤；类型检查、完整构建和仓库检查通过。新增 10 条 API 场景验证语言与作用域交集、原则引用拒绝、生成草稿、Git 元数据、显式覆盖和仓库豁免；单元测试补充旧数据迁移、团队隔离、并发更新、非法语言声明及跨评审阶段快照合并。agent-browser 在本地 3110 与独立数据库 `ureview_d1` 验证规范分组筛选、编辑保存、生成草稿恢复、覆盖关系、豁免理由与撤销历史及 390px 窄屏。模型和代码平台使用协议桩，评审接口提供规范层级，评审页展示按协作约定由后续工作接入。

2026-10-06：Story 18 身份关联、我的待办、团队概览与即时通讯推送通过 62 个文件、702 项单元测试，110 条 API 场景、789 个步骤，以及类型检查、完整构建和仓库检查。新增 7 条 API 场景与 1 条 E2E，场景总数为 155。API 使用真实 HTTP、非特权 PostgreSQL、正式评审流水线及本地 GitLab、模型与机器人协议桩，验证身份唯一与分区、处置统计、三家机器人格式与签名、业务错误重试及三秒发送间隔。评审场景清理等待连接实际断开后再删库，整批回归通过。（source: [数据库清理决定](../.agents/notes/implemented/testing/2026-10-06-review-scenario-database-cleanup.md)）

agent-browser 在本地 3109、独立数据库 `ureview_c2` 验证未关联提示、本人及管理员填写身份、三个待办分区、进入评审、讨论定位、标记已读及刷新保留、团队概览权限、三种机器人配置掩码与 390px 布局，共保存 11 张截图。浏览器使用构造展示记录与真实 HTTP、PostgreSQL；未向真实即时通讯平台发送消息，未联调真实 GitLab 或验证模型判断质量。验收后停止本任务启动的服务。

2026-10-06：Story 16 规范库浏览与应用、Story 19 规范详情与统一提案通过 63 个文件、734 项单元测试，122 条 API 场景、858 个步骤，以及类型检查、完整构建和仓库检查。新增 9 条 API 场景验证库应用去重、版本差异采用、统一处置统计、四来源提案、反馈合并、审核权限与异路径候选生效；迁移回归覆盖旧草稿、历史候选及重复执行。统计回归覆盖折叠 finding、未完成评审、跨仓规范身份和 Git 目录缺失时的快照详情。

agent-browser 在本地 3111、独立非特权数据库 `ureview_d3` 验证规范库筛选与应用、提案审核、更新差异、成员只读，以及 finding 到详情和执行记录的往返。新增 E2E 验证反馈编辑保存后提案已采纳，实测后移除 pending。桌面及 390px 详情页无页面横向溢出。浏览器评审使用展示样本；API 使用真实 HTTP、PostgreSQL、正式 dsh 与代码平台、模型协议桩，未验证模型判断质量。

2026-10-06：Story 22 引导与实例健康通过 67 个文件、743 项单元测试，以及 126 条 API 场景、899 个步骤；类型检查、完整构建和仓库闸门通过。新增 6 条 API 验证五步数据判定、模型环境回退、Lint 排除、团队与服务权限、跨团队队列及七天失败和模型统计；迁移测试验证强制 RLS 下的旧失败回填，模型记录测试验证脱敏错误分类。

agent-browser 在本地 3112 和独立数据库 `ureview_e1` 完成 1 条接入引导 E2E，并验证收起持久化、成员隐藏与管理员提示、实例健康空态、失败展开及下钻、版本和 390px 表格内部滚动。GitLab 为本地协议样本，健康展示记录为构造数据；未验证真实模型质量，未执行部署升级或备份恢复演练。验收后停止本任务启动的服务。

2026-10-06：迭代 4 合并版本集成走查通过 71 个文件、789 项单元测试，以及 136 条 API 场景、970 个步骤；类型检查和完整构建通过。新增回归覆盖非 UUID 的规范标识处置与提案、仓库快照详情及执行记录隔离、引导排除停用和惰性 Git 规范。既有 `.feature` 场景与认领保持 183 条。

agent-browser 在本地 3120、独立非特权数据库 `ureview_q1` 验证首次使用、成员待办、两轮解读与 finding 处置、规范执行记录与提案审核、规范库、仓库四标签、webhook 忽略、三家机器人投递、身份与实例健康，以及成员权限和 390px 评审页与待办。浏览器使用构造评审快照和本地平台、机器人协议桩；通知使用正式 worker，三家各一次成功，飞书和钉钉签名复算通过。未验证真实模型质量或真实平台联调。修复边界见 [集成决定](../.agents/notes/implemented/bug-fix/2026-10-06-iteration-4-integration-boundaries.md)。

2026-10-06：Story 20 删除仓库通过 72 个文件、800 项单元测试，以及 142 条 API 场景、1014 个步骤（含 284 个前后置步骤）；类型检查、完整构建与仓库闸门通过。新增 6 条 API 验证预览、关联数据清理、权限与团队隔离、路径确认、旧 webhook 与重新接入、规范范围和遗留工作副本边界。单元测试补充逐表清理、事务回滚、共享反馈、清理失败及真实 PostgreSQL 并发锁顺序。

agent-browser 在本地 3114、独立非特权数据库 `ureview_r45` 实测 1 条删除确认 E2E，以及成员入口隐藏、进行中阻止、预览后的状态变化、刷新恢复和 390px 布局。API 运行正式 dsh 与平台、模型协议桩；浏览器采用构造记录，未验证真实模型质量或真实平台联调。截图保存在指定的 `iteration-4/shots/r45/` 目录，浏览器和任务服务已停止。

2026-10-06：Story 13 会话外壳通过 3 个文件的 11 项相关单元测试、136 条 API 场景与 970 个步骤，以及类型检查、完整构建与仓库闸门。新增 3 条 E2E 经独立代码审查及 agent-browser 最终复验通过，场景总数为 186。浏览器在本地 3115、独立数据库 `ureview_s4` 验证单行头部、三阶段切换、拖动与键盘调宽、按用户的布局记忆、独立标签页、390px 菜单、拒绝与失败记录全屏直达，以及关闭后的滚动和焦点恢复。1440×900 下头部 48px，官方内容容器 852px，占抽屉 94.7%；扣除宿主上下留白后可用 804px，占 89.3%。模型与代码平台使用协议桩，会话和拒绝记录由正式 dsh 生成。官方组件与内部样式未改动；未验证模型质量或真实平台联调。

2026-10-06：Story 15 规范入口通过全量 73 个文件的 815 项单元测试、142 条 API 场景与 1014 个步骤，以及类型检查、完整构建与仓库闸门。新增 4 条 E2E 由工单 03 认领；agent-browser 在本地 3116、独立数据库 `ureview_s5` 验证四层概览与空态、按层进入规范库并应用条目、仓库生成范围预填与重开、同步失败汇总、首次使用入口、成员只读及 390px 布局，共 28 项检查通过。模型和代码平台使用本地协议桩，生成运行正式 dsh；未验证真实模型质量与真实 GitLab 联调。任务服务与浏览器已停止，11 张截图已保存到指定目录。

2026-10-06：Story 16 工单 03 完成 8 集 105 条规范库内容修订，105 条独立可读性验收通过。全量 74 个文件、850 项单元测试与 144 条 API 场景、1024 个步骤通过；类型检查、完整构建、仓库闸门与含新文件的空白检查通过。新增 2 条 API 验证解释字段与正反例映射，2 条 E2E 验证展开、应用后详情与更新预览；场景总数为 201。

agent-browser 在本地 3117、独立数据库 `ureview_s6` 验证摘要、检查建议、代码高亮、旧 ID 更新提示、显式采用及 390px 详情布局。5 张截图保存到指定的 `iteration-4/shots/s6/` 目录。浏览器使用真实 HTTP 与 PostgreSQL，旧版本关联为构造记录；未调用真实模型或代码平台。浏览器与任务服务已停止。

2026-10-06：Story 16 工单 03 的读者意见修订完成，52 条修改覆盖报告全部意见，8 集 105 条统一为 `2026.10.2`。两个设计原则旧 ID 的更新与去重新增参数化回归；全量 74 个文件、852 项单元测试及 144 条 API 场景、1024 个步骤通过。类型检查、完整构建、规范库校验、仓库闸门和包含新增文件的空白检查通过。Gherkin 场景保持 201 条，认领不变。

agent-browser 在本地 3117、独立数据库 `ureview_s6_reader` 抽查修改条目的正文与代码高亮，并验证旧 ID 的更新预览、显式采用和 390px 展示。8 张截图保存在指定的 `iteration-4/shots/s6/` 目录。未调用真实模型或代码平台；浏览器、任务服务及本次数据库已清理。

2026-10-06：Story 15 判断题规范通过 77 个文件、890 项单元测试，149 条 API 场景与 1058 个步骤，以及类型检查、完整构建、仓库闸门和包含新文件的空白检查。新增 4 条 API 经独立只读审查与回归，覆盖高危拒绝和中危重试、三个评审阶段提示、Git 属性、普通规范兼容、快照保留及规范库应用与属性更新。迁移和会话回归验证旧数据默认值。完整回归通过 PATH 直接调用同版本 Apple Git，避免系统启动代理的额外开销。

agent-browser 在本地 3118、独立数据库 `ureview_s7` 验证判断题编辑保存、规范列表与详情、库应用与更新，以及 finding 标签和 390px 布局，共保存 9 张截图到指定 `iteration-4/shots/s7/` 目录。评审由正式 dsh 生成，模型和平台为本地协议桩，旧规范库关联为构造样本；未验证真实模型判断质量或真实平台联调。浏览器、任务服务、数据库与角色已清理。

2026-10-09：Story 26 企业账号登录通过 83 个文件、925 项单元测试，170 条 API 场景、1190 步，以及类型检查、仓库闸门与构建。企业登录专项为 13 条 API、80 步和 1 条 E2E、6 步；全部移除 pending。agent-browser 使用构建后的 Web、独立数据库、随机端口和 localhost/127.0.0.1 跨站身份源，验证 Strict 会话在回调后的首次页面生效、返回原路径，以及无密码账号隐藏改密表单。身份源使用本地协议桩，未联调真实企业服务。

2026-10-09：Story 26 审核修订通过 84 个文件、930 项单元测试和 171 条 API 场景、1197 步，以及类型检查、仓库闸门与构建。新增服务管理员不自动关联场景通过并移除 pending；企业登录专项为 14 条 API、87 步和 1 条 E2E、6 步。浏览器步骤等待页面内容后断言，保留首次页面的一次会话请求与 Strict Cookie 检查；连接测试的三类失败提示经本地协议桩与 Chrome 验证。

### 场景路径（248 条场景）

场景含原有 70 条行为基线、团队能力扩展的 14 条 API 和 1 条 E2E，工作台导航的 2 条 E2E，以及规则生成的 6 条 API 与 1 条 E2E，以及 lint 目录的 1 条 API。持久规范会话补充 3 条 API 与 1 条 E2E，评审排除目录补充 3 条 API，服务配置补充 4 条 API，通用会话查看器补充 5 条 API 与 2 条 E2E。模型连接验证补充 4 条 API 与 1 条 E2E。Story 23 补充 3 条 API。Story 14 补充 7 条 API 与 2 条解读 E2E。Story 17 补充 3 条处置 API 与 1 条多轮对比 API，并接手 5 条原有的处置场景。评审页补充 3 条结论 API 与 1 条结论下钻 E2E，接手 1 条就地处置 E2E。Story 20 补充 5 条 API 与 1 条 E2E，Story 21 补充 3 条 E2E。Story 15 补充 10 条规范效力 API 和 4 条判断题 API。Story 18 补充身份待办、概览与推送的 7 条 API 和 1 条 E2E。Story 16 与 Story 19 补充 9 条规范库、详情与提案 API，以及 1 条详情与修订 E2E。Story 22 补充 6 条引导与健康 API 和 1 条 E2E。驳回反馈撤回补充 1 条 API。删除仓库补充 6 条 API 与 1 条 E2E。会话查看器外壳补充 3 条 E2E。用户名必填、邮箱选填补充 1 条 API。提案批量审核补充 2 条 E2E。规范页可发现性补充 4 条 E2E。规范库条目阅读补充 2 条 API 与 2 条 E2E。Story 01–23 共认领 140 条 API 与 30 条 E2E；未验收的场景保留 pending。Story 24 新增 11 条 API 与 3 条 E2E，退役 Story 14 的 7 条解读 API 与 2 条解读 E2E，删除 2 条综述场景，并把 10 条提到综述的场景改成文件分组、结论栏或解读的说法。Story 17 工单 05 把中危锚场景改为中危带锚，补充 1 条证据代码 API 与 2 条问题目录、证据定位 E2E。Story 25 新增 8 条导入企业规范 API 与 2 条 E2E。Story 26 新增 14 条企业账号登录 API 与 1 条 E2E。Story 27 新增 5 条评审观测 API。

| 文件 | 对应 story | 场景数 | 层 |
|---|---|---|---|
| `features/repository-onboarding.feature` | 1–4 | 7 | `api` |
| `features/review-trigger.feature` | 5–8 | 11 | `api` |
| `features/review-exclusions.feature` | Story 02 仓库评审排除目录（工单 08） | 3 | `api` |
| `features/review-list.feature` | 10–13 | 6 | `api` |
| `features/pr-summary.feature` | 15–24 | 5 | `api` |
| `features/repository-rules.feature` | Story 03 规范参与评审 | 3 | `api` |
| `features/findings.feature` | 25–32 与 Story 17 工单 05 | 10 | `api` |
| `features/diff-anchoring.feature` | 33–39 | 7 | `api` |
| `features/finding-disposition.feature` | Story 17 逐条处置；合并后被无视由旧工单 19 认领 | 9 | `api` |
| `features/round-comparison.feature` | Story 17 多轮对比 | 1 | `api` |
| `features/review-metrics.feature` | 14、43 | 2 | `api` |
| `features/degradation.feature` | 9、64–65 | 4 | `api` |
| `features/read-only-boundary.feature` | 贯穿全局的只读不变量 | 2 | `api` |
| `features/review-workbench-e2e.feature` | 33、36、37、38 与 Story 17 的交互侧 | 9 | `e2e` |
| `features/agent-sessions.feature` | Story 13 通用会话读取 | 5 | `api` |
| `features/review-conclusion.feature` | Story 17 规则结论 | 3 | `api` |
| `features/pr-reading.feature` | Story 24 解读讲清实现 | 11 | `api` |
| `features/pr-reading-e2e.feature` | Story 24 解读页面 | 3 | `e2e` |
| `features/keep-review-results.feature` | Story 23 保留评审结果 | 3 | `api` |
| `features/agent-sessions-e2e.feature` | Story 13 官方会话查看器 | 5 | `e2e` |
| `features/model-connections.feature` | Story 12 密钥与调用验证 | 4 | `api` |
| `features/model-connections-e2e.feature` | Story 12 显隐与验证交互 | 1 | `e2e` |
| `features/onboarding-and-health.feature` | Story 22 引导与实例健康 | 6 | `api` |
| `features/onboarding-and-health-e2e.feature` | Story 22 接入引导 | 1 | `e2e` |
| `features/service-settings.feature` | Story 12 服务配置与实例权限 | 4 | `api` |
| `features/my-inbox.feature` | Story 18 身份与待办 | 3 | `api` |
| `features/my-inbox-e2e.feature` | Story 18 身份关联到待办评审 | 1 | `e2e` |
| `features/lead-overview.feature` | Story 18 负责人概览 | 1 | `api` |
| `features/im-push.feature` | Story 18 即时通讯推送 | 3 | `api` |
| `features/team-identity.feature` | Story 09 登录与团队隔离 | 5 | `api` |
| `features/review-collaboration.feature` | Story 10 讨论与通知 | 5 | `api` |
| `features/rule-catalog.feature` | Story 11 规范、lint 与候选 | 6 | `api` |
| `features/team-workbench-e2e.feature` | Story 10 未读提示到讨论区 | 1 | `e2e` |
| `features/navigation-and-settings-e2e.feature` | Story 21 导航与设置 | 3 | `e2e` |
| `features/repository-detail.feature` | Story 20 仓库配置与 webhook 事件 | 5 | `api` |
| `features/repository-detail-e2e.feature` | Story 20 仓库详情交互 | 1 | `e2e` |
| `features/repository-deletion.feature` | Story 20 删除仓库（工单 02） | 6 | `api` |
| `features/repository-deletion-e2e.feature` | Story 20 删除确认交互（工单 02） | 1 | `e2e` |
| `features/workspace-navigation-e2e.feature` | Story 09 工作台导航与详情面板 | 2 | `e2e` |
| `features/managed-rules.feature` | Story 11 数据库规则生成、应用与删除 | 9 | `api` |
| `features/managed-rules-e2e.feature` | Story 11 规则编辑与多仓库范围 | 1 | `e2e` |
| `features/rule-sessions.feature` | Story 11 规范持久会话 | 3 | `api` |
| `features/rule-hierarchy.feature` | Story 15 规范层级、语言与效力 | 12 | `api` |
| `features/rule-discoverability-e2e.feature` | Story 15 规范层级与添加入口（工单 03） | 4 | `e2e` |
| `features/rule-library.feature` | Story 16 规范库浏览与应用 | 9 | `api` |
| `features/rule-library-e2e.feature` | Story 16 规范条目阅读 | 2 | `e2e` |
| `features/rule-detail.feature` | Story 19 规范详情与执行记录 | 1 | `api` |
| `features/rule-proposals.feature` | Story 19 统一提案入口 | 5 | `api` |
| `features/rule-proposals-e2e.feature` | Story 19 批量审核交互 | 2 | `e2e` |
| `features/rule-detail-e2e.feature` | Story 19 从评审维护规范 | 1 | `e2e` |
| `features/rule-sessions-e2e.feature` | Story 11 规范对话面板 | 1 | `e2e` |
| `features/rule-library-import.feature` | Story 25 导入企业规范 | 8 | `api` |
| `features/rule-library-import-e2e.feature` | Story 25 导入企业规范 | 2 | `e2e` |
| `features/enterprise-sso.feature` | Story 26 企业账号登录 | 14 | `api` |
| `features/enterprise-sso-e2e.feature` | Story 26 企业账号登录 | 1 | `e2e` |
| `features/review-observability.feature` | Story 27 评审编排的观测与基线 | 5 | `api` |

团队身份、讨论通知、规范目录与候选已分别落为 Story 09–11。合并后的被无视判定与其余度量场景继续按对应范围交付。

### 不进场景的规则

| 规则 | 为什么不写成场景 |
|---|---|
| **拆分只做一层不递归** | 用户只观察得到「覆盖全」或「明说覆盖不全」两种结果，递归与否不可观察。规则由本文档的 Implementation Decisions 约束，由单元测试锁住 |
| **规范走 `agent.inject()` 而非工具调用** | 同上，用户只观察得到「注入了几条、来自哪一级」，已由 `pr-summary.feature` 的依据来源场景锁住 |
| **三个 agent 的中文要求固定在系统提示词末段且唯一** | 提示词顺序属于运行时接线，由正式 dsh 的模型请求体回归及公开注册表测试验证；语言遵循程度属于模型质量 |

### 两个保留的英文术语

`skill`（dsh 的机制名）与 `diff`（开发者通用词，前端组件即 `@git-diff-view/react`）按技术标识符保留，不译。与 `finding` 及五个状态名同类。

---

## 预发验证

测试里模型、GitLab、统一认证都是协议桩，数据是十几条的样本。功能和修复第一次在真实环境里用，常会暴露这些测试碰不到的问题：Story 25 的导入面板在 1359 条条目下每 0.5 秒全量刷新，发布请求发不出去；本地 E2E 用十几条条目，一直是通过的。所以工单完成前，先在预发环境从前端走一遍。

### 环境

- 预发是一套独立部署，有真实模型配置与积累的评审数据，不配置即时通讯推送。预发数据可以写：上传、发布、应用、改配置都可以做。
- 地址、部署目录与账号在本机 `~/.config/ureview/staging.env`，不进仓库。没有这个文件时向维护者要，不要猜。
- `scripts/deploy/staging.sh` 把当前提交部署到预发：构建，打包编译产物，以生产当前镜像为基础构建镜像，备份预发数据库，替换镜像，等待健康检查，失败自动恢复。依赖有变化时脚本停下。
- `scripts/deploy/production.sh` 只接受预发正在运行的同一个提交，部署前检查没有进行中的任务并备份。合入 main 用快进，保持与预发验证过的提交相同；产生合并提交时要重新部署预发并验证。

### 什么时候做

- 工单改动了用户能看到或用到的行为（页面、接口、后台任务、部署配置），标为 `completed` 之前做。
- 纯文档、纯测试、纯工具脚本的工单不做，记录里写「不适用」和理由。
- 同一批合入的工单可以一起部署、一起验证，各工单的记录指向同一次验证。

### 检查什么

以预发账号登录，用 agent-browser 或人工按工单的可观察结果走一遍主流程，并检查：

1. **功能**：主流程走通，结果与规格一致；失败路径有明确提示。
2. **数据量与加载**：用接近真实的规模操作，例如真实文档导入、上百条条目、几十条评审。记录每个改动页面的首屏时间和最大的接口响应体积（`performance.getEntriesByType("resource")` 的 `duration` 与 `transferSize`）；首屏超过 3 秒或单个接口超过 1 MB 记为问题。预发与使用者之间的链路较慢，体积直接决定等待时间。
3. **样式**：按钮、表单、间距、标题层级与相邻页面一致；没有溢出、遮挡、错位；1440 与 390 两种宽度下可读。
4. **体验**：入口好找；空、加载、错误三种状态都有；操作后有结果反馈；只锁住正在操作的部分；次要内容默认收起。
5. **文案**：中文、朴素，与界面其他文字一致，不出现内部编号或英文报错。
6. **浏览器**：控制台没有错误；页面空闲时，除全局未读提醒的定时检查外没有持续发出的请求。

### 记录

工单末尾写一节，格式固定，`npm run check` 按行首标签检查：

```markdown
## 预发验证（2026-10-10）

- 版本：`7710671`，镜像 `ureview:staging-7710671`
- 账号角色：服务管理员
- 流程：上传三份 checklist → 等待生成 → 预览展开规范集 → 全选发布 → 规范库应用 → 规范详情
- 截图：`.scratch/staging/25-04/`，01-upload.png、02-preview.png、03-library.png
- 问题：
  - 阻塞：（无）
  - 应改：发布成功提示在页面底部，滚动后看不到；留给工单 05
  - 建议：（无）
- 结论：通过
```

- 截图保存在 `.scratch/staging/` 下，不提交。
- agent-browser 在预发的工作台页面上可能出现点击与鼠标事件不生效（登录页正常）。改用页面内 DOM 事件完成的步骤，在「流程」里逐条注明；这类步骤测不出遮挡与点不到，审核时由人复核。
- 阻塞问题修完并重新验证才能写「通过」；应改与建议写明去向。
- 不适用时只写一行：`- 结论：不适用，<理由>`。
- 同一工单可以有多次验证，以最后一节为准。

`npm run check` 要求 Story 25 起标为 `completed` 的工单有这一节，且最后一节的结论为「通过」或「不适用」。闸门只证明记录存在；审核时看截图，并到预发抽查。

## 验收判据

行为类验收由上面 Testing Decisions 引用的场景承载，不在这里重写。这一节只记装不进 `.feature` 的：

### 可度量指标

- **误报率 ≤ 10%**，口径按 Google 的尺子：**按开发者有没有动手算，不按我们判断对错算**。一条技术上正确但没人改的，算误报。（source: issues/02-成功指标与沉默优于噪声的判据.md）
- **采纳率起步 ≥ 20%、目标 30%。** 依据是实测：Qodo 自家文档截图里是 20.6%–23.8%（source: research/25-qodo-产品形态.md）；Uber 生产配置的 F1 只有 0.50（source: research/04-uber-ureview-架构拆解.md）。**别承诺八成，那个数在这个行业里不存在。**
- **每个 PR 最多 5 条 finding**，超出按置信度截断并明说折叠了 N 条。
- **首轮规范候选 ≤ 10 条，之后每两周 ≤ 5 条。** 依据：ESLint 在规则涨到 300 条时公开承认「规则互不冲突」已不可能，并一次性废弃 77 条格式化规则。（source: research/09-规范表达形式谱系.md）
- **重跑稳定性**：同一个 PR 连跑两次，finding 集合的差异需在可接受范围内——具体阈值由基线扫出来定。（source: issues/14-评估基线-benchmark-构造与重跑稳定性.md）

### 需要人工核对的项

- **对照三条真实 Qodo 评论核内容结构**（source: assets/qodo-real-comments/）——PR Summary 的骨架（一句话描述、类型与时长标签、三条要点、mermaid 图、N 个替代方案各带正负号、推荐意见、按语义分组的文件清单加每文件一句话主题）、finding 的字段集、Context sources 四项、四个计数 chips。**对照的是内容结构，不是 markdown 版式。**
- **冷启动基线**：用自己的 20 个 PR 人工标注，成本约半天。不用历史 MR 评论当弱标注——**那些评论的分布和 AI 会报的东西不一样，标出来的基线会偏。**

### 反指标（出现就说明在帮倒忙）

（source: issues/02-成功指标与沉默优于噪声的判据.md）

| 现象 | 说明什么 |
|---|---|
| 采纳率持续下降 | 评审人开始无视 AI 结论 |
| **「未经评审就合并」比例上升** | **人在绕开我们，约定失效。这条最要命——它同时打掉北极星和品类论证** |
| 讨论串没人回 | 协作没发生 |
| 规范条数涨但命中率不涨 | 规范在空转 |
| 作者为了过检写规避代码 | 最难测但最该警惕 |

---
