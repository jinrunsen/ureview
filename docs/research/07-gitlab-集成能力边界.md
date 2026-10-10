# GitLab MR 集成的 API 能力边界

- 对应 ticket：[GitLab MR 集成的 API 能力边界](07-gitlab-集成能力边界.md)
- 调研时间：2026-09-11
- 参考文档版本：docs.gitlab.com 的 `master` 分支源文档（`gitlab-org/gitlab` 仓库 `doc/` 目录），对应 `VERSION = 19.4.0-pre`。当日最新稳定版为 **19.3**（最新 tag `v19.3.2-ee`）。
- 结论里出现的「最低版本」一律以文档中的 `history` 块为准；文档没写引入版本的，明确标注「文档未标注」。
- 部分结论来自 GitLab 源码（文档没写全的地方），已单独标注「源码」。

> [!warning]
> 一个前置事实：docs.gitlab.com 只发布当前版本的文档。本文很多能力的最低版本落在 **17.4 / 18.4 / 19.0 / 19.2**。
> 企业自托管实例普遍滞后，接入前第一件事是问清对方实例的实际版本号（`GET /api/v4/version`），
> 否则本文一半的「做得到」会在对方实例上变成「做不到」。

---

## 0. 结论速查

| 能力 | 结论 | 最低版本 | 版次 |
|---|---|---|---|
| MR 事件 webhook | 有，action 枚举完整 | 长期存在 | Free |
| webhook HMAC 签名 | **19.0 才有**，之前只有明文 token 比对 | 19.0（19.1 GA） | Free |
| webhook 去重键 | `Idempotency-Key` 17.4+，`webhook-id` 19.0+ | 17.4 | Free |
| group 级 webhook | 要 Premium | — | **Premium** |
| diff 行内评论 | 有，`position` 六元组 | 长期存在 | Free |
| 多行评论 `line_range` | 有，但 `line_code` 要自己算 | 文档未标注 | Free |
| 程序化 resolve / unresolve | 有 | 长期存在 | Free |
| 谁 resolve 的 | 有 `resolved_by` / `resolved_at` | 长期存在 | Free |
| 评论是否 outdated | **REST / GraphQL 都读不到**，只有 webhook 载荷里有 | — | — |
| 草稿评论 + 批量发布 | 有（Draft Notes API） | 文档未标注 | Free |
| `/diffs` 分页取 diff | 有，按文件分页 | ~15.7 | Free |
| 超限标志 `collapsed` / `too_large` | 有 | **18.4** | Free |
| `/changes` 的 `overflow` | 有，但端点 15.7 已废弃 | — | Free |
| diff 版本列表 | 有 `/versions` | 长期存在 | Free |
| 完整文件内容 | 有 `/repository/files` | 长期存在 | Free |
| GitHub App 等价物 | **没有** | — | — |
| 细粒度 PAT | 有（最接近 App 的东西） | **19.2 GA**（18.10 beta） | Free |
| service account | 有 | **18.11 下放 Free**（此前 Premium） | Free (18.11+) |
| group / project access token | 自托管全版次可用 | 长期存在 | Free（自托管） |
| impersonation / `sudo` | 有，要 admin，实例可全局关闭 | 长期存在 | Free |
| 自托管 API 限流 | **默认关闭** | — | Free |
| note 创建限流 | **默认 300/min/user，默认开启** | — | Free |
| Code Quality 报告挂 MR | 有，但必须走 CI artifact | 长期存在 | Free（MR Reports 页） |
| Code Quality 行内标注 | 有 | — | **Ultimate** |
| external status check | 有 | — | **Ultimate** |
| commit status 打标 | 有 | 长期存在 | Free |

---

## 1. Webhook

文档：[Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)、[Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)

### 1.1 MR 事件的触发条件

`merge_request` 事件在以下情况触发（原文逐条）：

- 新建 MR
- 已有 MR 被更新、被（全部必需审批人）批准、取消批准、合并、关闭
- 某个用户单独添加或移除自己的审批
- 某个 reviewer 被重新请求评审
- MR 被设为自动合并，或自动合并被取消（19.2 引入）
- **源分支上新增了 commit**
- MR 上所有线程都被解决

> 文档原话："Merge request events can be triggered even if the `changes` field is empty. Webhook receivers should always inspect the content of the `changes` field for the actual changes."

`object_attributes.action` 的全部取值：`open` / `close` / `reopen` / `update` / `approval` / `approved` / `unapproval` / `unapproved` / `merge`。
注意**没有** `draft` / `undraft` / `push` 这类细分 action —— 全部塞进 `update`，要靠 `changes` 字段区分。

### 1.2 载荷里真正有用的字段

顶层：`object_kind` / `event_type` / `user` / `project` / `object_attributes` / `changes` / `assignees` / `reviewers` / `labels` / `repository`（已废弃，用 `project`）。

`object_attributes` 里对 review 有用的：

| 字段 | 用途 |
|---|---|
| `iid` | 调 API 用的 MR 内部 ID（不是 `id`） |
| `action` | 见上 |
| `actioned_at` | 动作发生时间，**18.10+** |
| `state` / `state_id` | `opened`/`closed`/`merged`/`locked`（1/2/3/4） |
| `draft` | 草稿 MR，用来跳过 |
| `last_commit` | 源分支最新 commit（id / message / timestamp / author） |
| `oldrev` | **只有 `update` 且确实有代码变更时才有**（push 新代码、应用了 suggestion） |
| `source_branch` / `target_branch` | — |
| `source_project_id` / `target_project_id` | fork MR 时两者不同 |
| `blocking_discussions_resolved` | 阻塞线程是否都已解决 |
| `detailed_merge_status` | 见 [merge status](https://docs.gitlab.com/api/merge_requests/#merge-status)，含 `preparing` / `checking` / `approvals_syncing` 等 |
| `prepared_at` | diff 创建、pipeline 创建、可合并性检查、LFS link、通知这五步都完成后**只填一次** |
| `head_pipeline_id` | 关联 pipeline |
| `target_branch_protected` | **19.2+** |
| `system` / `system_action` | 系统触发的事件（`approvals_reset_on_push` / `code_owner_approvals_reset_on_push`），只由 push 触发 |

`changes` 只包含本次真正变化的字段，格式 `{"字段": {"previous": ..., "current": ...}}`。可能出现的字段有固定清单（`assignees` / `blocking_discussions_resolved` / `description` / `draft` / `head_pipeline_id` / `labels` / `merge_status` / `reviewer_ids` / `reviewers` / `state_id` / `title` / `target_branch` / …）。

`reviewers[].state` 取值：`unreviewed` / `review_started` / `reviewed` / `requested_changes` / `approved` / `unapproved`。提交 review 时会以 `action: "update"` + `changes.reviewers` 两段数组的形式推送（**19.3+**）。

### 1.3 push 到源分支会不会触发 + 怎么判断要不要重跑 review

会触发，形态是 `action: "update"` 且 `object_attributes.oldrev` 存在。但这个判据不够（应用 suggestion 也会带 `oldrev`）。稳妥的判据是三选一或组合：

1. `action == "update" && oldrev != null`，再比较 `object_attributes.last_commit.id` 与上次处理过的 head。
2. 直接以 `GET /projects/:id/merge_requests/:iid/versions` 的第一条（最新版本）的 `head_commit_sha` 为准，与自己库里记录的比较。这条最可靠，因为**diff version 是按 push 生成的，不是按 commit**（[版本文档原文](https://docs.gitlab.com/user/project/merge_requests/versions/)：一次 push 含多个 commit 只产生一个 version）。
3. 用 `changes` 判断是否只是标题/标签/assignee 变动，是的话直接丢弃。

另外要注意**回环**：我们自己 resolve 线程会让「所有线程都解决」这一条触发新的 MR 事件；我们自己发评论会触发 Note 事件。必须按 `user.username`（或 `user.id`）过滤掉自己 bot 产生的事件。

### 1.4 重试、去重、防重放

**去重键**（[Delivery headers](https://docs.gitlab.com/user/project/integrations/webhooks/#delivery-headers)）：

| Header | 语义 | 版本 |
|---|---|---|
| `Idempotency-Key` | 跨重试保持一致的唯一 ID。文档说「因历史原因保留，优先用 `webhook-id`」 | **17.4+** |
| `webhook-id` | 同上，值与 `Idempotency-Key` 相等 | **19.0+** |
| `webhook-timestamp` | 请求生成时的 Unix 秒时间戳 | **19.0+** |
| `webhook-signature` | 空格分隔的 HMAC-SHA256 签名列表，格式 `v1,{base64}`。**仅在配置了 signing token 时发送** | **19.0+**（19.1 GA） |
| `X-Gitlab-Event-UUID` | **不是投递唯一 ID**。文档原文：非递归 webhook 的唯一 ID；由前一个 webhook 触发的递归 webhook 共享同一个值 | — |
| `X-Gitlab-Webhook-UUID` | 每个 webhook（配置项）的唯一 ID | — |
| `X-Gitlab-Event` | `"<EVENT> Hook"`，如 `Merge Request Hook` / `Note Hook` | — |
| `X-Gitlab-Instance` | 实例 hostname | — |
| `X-Gitlab-Token` | 明文 secret token，仅在配置了 secret token 时发送 | — |

**签名校验**（19.0+）：GitLab 遵循 [Standard Webhooks](https://www.standardwebhooks.com/) 规范。签名计算对象是字符串 `{webhook-id}.{webhook-timestamp}.{raw body}`；密钥是 signing token 去掉 `whsec_` 前缀后 base64 解码的结果；结果 base64 后加 `v1,` 前缀。文档给了 Ruby / Python 两段示例，明确要求常量时间比较。**signing token 永远不会被 API 返回**。secret token 和 signing token 可以同时配置，用于平滑迁移。

**防重放**：文档明确给法 —— 处理载荷前校验 `webhook-timestamp` 是否足够新。**19.0 之前没有这个头，做不了时间戳防重放**，只能靠自己维护 `Idempotency-Key`（17.4+）的去重表；17.4 之前连去重键都没有。

**重试**：官方文档**没有承诺任何重试策略**，只在「接收端要求」里写了 "Prepare for duplicate events if a webhook times out"。源码上，投递 worker `app/workers/web_hook_worker.rb` 带 `sidekiq_options retry: 4, dead: false`，即 job 层异常（如超时）会被 Sidekiq 重试最多 4 次。**所以要按「至少一次投递」设计接收端**，用 `webhook-id` / `Idempotency-Key` 做幂等。顺序保证：文档只字未提，按**无序**处理。

### 1.5 自动禁用与限额

- 连续失败 4 次 → **临时禁用**，初始 1 分钟，随后续失败延长至最多 24 小时，之后自动恢复。
- 连续失败 40 次 → **永久禁用**（17.11 改成 40 次；此前是永久禁用于 4 次）。恢复方式：在 UI 里发一次 test request，返回 2xx 即恢复。
- 失败的定义：4xx / 5xx 响应、连接超时、其他 HTTP 错误。
- **这套自动禁用在自托管的 project webhook 上由 feature flag `auto_disabling_web_hooks` 控制，15.10 起在自托管默认关闭**。group webhook 15.10 起有。所以自托管上不能依赖「被自动禁用」作为可观测信号。

其他硬限额（[instance limits](https://docs.gitlab.com/administration/instance_limits/)）：

- webhook 超时：`gitlab_rails['webhook_timeout']`，需要改 `gitlab.rb` 后 reconfigure。instance limits 页没写默认值；`config/gitlab.yml.example` 第 178 行注明 **默认 10 秒**。
- webhook 载荷上限 **25 MB**。
- 每项目最多 **100** 个 webhook，每 group **50** 个（Plan limits `project_hooks` / `group_hooks` 可改）。
- webhook 调用频率限制 `web_hook_calls`：**默认关闭（不限）**，按顶级 namespace 计，所有 project/group webhook 共享。
- push 事件：一次 push 超过 **3 个分支/tag**（`push_event_hooks_limit`）则**整个 push 事件一个 webhook 都不发**。
- 递归 webhook：一串由 webhook 触发的请求最多 100 次，超出后阻断并在 `auth.log` 记 `"Recursive webhook blocked from executing"`。

### 1.6 Note（评论）事件 —— 比 REST 给得多

`X-Gitlab-Event: Note Hook`，`object_kind: "note"`，`object_attributes.noteable_type: "MergeRequest"`，同时带一个 `merge_request` 对象。

文档给的示例载荷里 `object_attributes` 只列了 `note` / `line_code` / `action` 等少数字段，但**源码的白名单比文档多得多**（`lib/gitlab/hook_data/note_builder.rb`，`SAFE_HOOK_ATTRIBUTES`）：

```
attachment, author_id, change_position, commit_id, created_at, discussion_id,
id, internal, line_code, note, noteable_id, noteable_type, original_position,
position, project_id, resolved_at, resolved_by_id, resolved_by_push, st_diff,
system, type, updated_at, updated_by_id
```

其中三个字段**在 REST API 里根本拿不到**：

- `discussion_id` —— 用户回复了哪条线程，直接可用来做「人回复了 AI 的评论」这条交互。
- `original_position` 与 `change_position` —— `change_position` 非空即代表这条 diff note 已经 **outdated**（见 §3.4）。
- `resolved_by_push` —— 这条线程是被 push 自动解决的，不是人点的。

代价：这是源码事实，文档没列全，升级时要回归验证。

---

## 2. Discussions API：在 diff 上发行内评论

文档：[Discussions API](https://docs.gitlab.com/api/discussions/)（Tier: Free, Premium, Ultimate）

### 2.1 端点

| 操作 | 方法与路径 |
|---|---|
| 列出所有线程 | `GET /projects/:id/merge_requests/:iid/discussions` |
| 取单条线程 | `GET .../discussions/:discussion_id` |
| **新建线程** | `POST /projects/:id/merge_requests/:iid/discussions` |
| 线程内追加回复 | `POST .../discussions/:discussion_id/notes` |
| 改一条 note / 解决一条 note | `PUT .../discussions/:discussion_id/notes/:note_id` |
| **解决/重开整条线程** | `PUT .../discussions/:discussion_id` |
| 删除 note | `DELETE .../discussions/:discussion_id/notes/:note_id` |

### 2.2 position 参数

只要传了任何一个 `position*`，下面四个就**全部必填**：

| 参数 | 说明 |
|---|---|
| `position[base_sha]` | 源分支的 base commit SHA |
| `position[head_sha]` | 本 MR 的 HEAD SHA |
| `position[start_sha]` | 目标分支上的 commit SHA |
| `position[position_type]` | `text` / `image` / `file` |

`position_type=text` 时另外必填 `position[new_path]` 和 `position[old_path]`（**两个都要给**，分别是变更前后的路径；未改名时填同一个值）。

行号规则（文档逐条）：

- 新增行（绿色）：只给 `new_line`，**不要**给 `old_line`。
- 删除行（红色）：只给 `old_line`，**不要**给 `new_line`。
- 未变更的 context 行：`new_line` 和 `old_line` **都要给**，而且两者可能不相等（前面的改动会让行号漂移）。文档在这里挂了一个 [issue 325161](https://gitlab.com/gitlab-org/gitlab/-/issues/325161) 的链接，说「关于修复的讨论」——也就是说这块目前就是要调用方自己对齐。

三个 SHA 的来源，文档给的正规流程是先调 `GET /projects/:id/merge_requests/:iid/versions`，取返回数组第一条（最新版本）的 `base_commit_sha` / `head_commit_sha` / `start_commit_sha`。也可以用单个 MR 响应里的 `diff_refs.{base_sha, head_sha, start_sha}`，语义一致。

文档还留了一句警告：「如果 `base` / `head` / `start` / SHA 参数给错，可能撞上 [issue 296829](https://gitlab.com/gitlab-org/gitlab/-/issues/296829) 描述的 bug」。

### 2.3 多行评论（`line_range`）

支持。`position[line_range][start]` / `[end]` 各是一个 hash：

| 字段 | 必填 | 说明 |
|---|---|---|
| `line_code` | **是** | 见下 |
| `type` | **是** | 本次提交新增的行用 `new`，否则 `old` |
| `old_line` | 否 | — |
| `new_line` | 否 | — |

**`line_code` 必须自己算**，API 不提供计算接口。格式：`<SHA>_<old>_<new>`，例如 `adc83b19e793491b1c6ea0fd8b46cd9f32e292fc_5_5`。

- `<SHA>` 是**文件名的 SHA1**（源码 `lib/gitlab/diff/position.rb`：`Digest::SHA1.hexdigest(file_path)`，注意是路径字符串的哈希，不是文件内容的哈希）。
- `<old>` 变更前行号，`<new>` 变更后行号。
- 校验正则（源码 `app/validators/line_code_validator.rb`）：`/\A[a-z0-9]+_\d+_\d+\z/`。对新增行 old 位填什么、删除行 new 位填什么，文档没写死；实践上要与 GitLab 自己生成的 `line_code` 对齐，最稳的做法是**先读一条已有的 diff note，看 GitLab 自己生成的 `line_code` 长什么样**再照着拼。

文档未标注 `line_range` 的引入版本。

### 2.4 Suggestion（可一键应用的代码建议）

[Suggest Changes API](https://docs.gitlab.com/api/suggestions/)，Free 版次。创建方式不是独立接口，而是在 discussion 的 `body` 里写 fenced code block：

````
```suggestion:-3+0
example text
```
````

`-3+0` 表示从评论行往上 3 行、往下 0 行。应用：`PUT /suggestions/:id/apply`（需要 Developer+），可带 `commit_message`；批量应用有 `PUT /suggestions/batch_apply`。
discussion 列表响应里每条 note 带 `suggestions[]`（`id` / `from_line` / `to_line` / `applicable` / `applied` / `from_content` / `to_content`），可以用来判断建议有没有被采纳 —— **这是「AI 建议被接受率」这个指标唯一的一手数据源**。

### 2.5 Draft Notes：GitLab 版的「提交一次 review」

文档：[Draft Notes API](https://docs.gitlab.com/api/draft_notes/)（Free, 文档未标注引入版本）

发布前只有作者自己可见。端点：

- `GET/POST /projects/:id/merge_requests/:iid/draft_notes`
- `PUT/DELETE .../draft_notes/:draft_note_id`
- `PUT .../draft_notes/:draft_note_id/publish`
- **`POST .../draft_notes/bulk_publish`** —— 发布当前用户的全部草稿

创建草稿时除了与 discussions 一致的完整 `position`（含 `line_range`），还多两个关键参数：

- `in_reply_to_discussion_id` —— 草稿是对某条已有线程的回复
- `resolve_discussion` —— 发布时顺带把关联线程解决掉

`bulk_publish` 的参数：

- `note` —— 一条总结性评论（相当于 GitHub review 的 body）
- `internal` —— 总结是否为内部备注
- `reviewer_state` —— 发布后设置 review 状态。**文档明确写「Does not record a formal approval」**，可选值只有 `requested_changes` 和 `reviewed`，**不包含 approve**。

这是目前把「N 条行内评论 + 1 条总结 + 一个 review 状态」打成一次提交的唯一路径。注意草稿仍需**逐条创建**，N 条评论就是 N 次请求，会撞 note 创建限流（§6.2）。

---

## 3. 线程状态

### 3.1 resolve / unresolve

两个粒度，都能程序化：

- 线程级：`PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id`，参数 `resolved`（boolean，必填）。`true` 解决，`false` 重开。
- note 级：`PUT .../discussions/:discussion_id/notes/:note_id`，参数 `resolved`。文档注明 `body` 和 `resolved` **必须且只能传其一**。

**权限前提**（文档原文）：必须有 Developer / Maintainer / Owner 角色，或者是「被评审的这个变更的作者」。也就是说 bot 账号在项目里至少要 Developer。

源码层面还有一层保护：`resolve_note` helper 会先判断 `note.resolvable?`，不可解决时返回 `400 Bad request - Note is not resolvable`。

### 3.2 「已解决」和「已回复」能不能区分

能。每条 note 上有：

| 字段 | 含义 |
|---|---|
| `resolvable` | 这条 note 是否可被解决（非 DiffNote / 系统 note 通常为 false） |
| `resolved` | 是否已解决 |
| `resolved_by` | **谁解决的**（UserBasic 对象） |
| `resolved_at` | 何时解决 |
| `type` | `DiffNote`（行内） / `DiscussionNote`（普通线程） / `null`（单条评论） |
| `system` | 是否系统 note |

线程级还有 `individual_note`（true 表示这是一条孤立评论，不是线程）。

「已回复但未解决」＝ `notes.length > 1 && resolved == false`。这个判断要自己做，API 不给。

### 3.3 「是被人解决的还是被 push 自动解决的」

REST **读不到**。项目设置 `resolve_outdated_diff_discussions` 打开时，push 导致 diff note outdated 会自动 resolve（源码 `app/services/discussions/update_diff_position_service.rb`，走 `note.resolve_without_save(current_user, resolved_by_push: true)`）。这个 `resolved_by_push` 字段：

- **REST Note entity 不暴露**（见 `lib/api/entities/note.rb`）
- **GraphQL Note 类型也没有**
- **只有 Note webhook 载荷里有**（§1.6）

替代判据：GitLab 会写一条 system note（`SystemNoteService.diff_discussion_outdated`），可以从 discussions 列表里找 `system: true` 的 note 解析文本 —— 但那是解析人类可读文本，脆。

### 3.4 outdated：这是本节最大的坑

GitLab 内部对每条 DiffNote 维护三个位置：`original_position`（创建时的位置）、`position`（追踪到最新 diff 后的位置）、`change_position`（追踪失败时记录的新位置）。逻辑在 `Discussions::UpdateDiffPositionService`：

- 追踪成功 → 更新 `position`，清空 `change_position`。评论自动跟着代码移动，**不会 outdated**。
- 追踪失败 → `position` 保持不变，写入 `change_position`，并（如果项目开了 `resolve_outdated_diff_discussions`）自动 resolve + 写系统 note。

用户文档也印证了这点（[Discussions](https://docs.gitlab.com/user/discussions/)）：「When you add comments to a merge request diff, these comments persist, even when you: Force-push after a rebase. Amend a commit.」

**但是 REST 和 GraphQL 都没有 outdated / active 字段**：

- REST `Entities::Note` 只 expose 了 `position`，没有 `original_position`、没有 `change_position`、没有 `active?`。
- GraphQL `Note` 类型字段清单里没有任何 outdated / active（在 79443 行的 GraphQL reference 里全文搜 `outdated`，命中的全是 CI catalog、订阅、OWASP 分类，与 note 无关）。

能用的三条路（都不完美）：

1. **Webhook 载荷**里有 `change_position`（§1.6），但只在评论状态变化的那一刻推送。
2. **自己算**：把返回的 `position.head_sha` 与 MR 当前最新 `diff_refs.head_sha` 比较。追踪成功时 `position` 被改写成新位置，`head_sha` 会跟着更新；追踪失败时 `position` 停留在旧的 `head_sha`。**这是间接推断，文档没有承诺，升级要回归。**
3. **打开项目设置** `resolve_outdated_diff_discussions`（可通过 [Projects API](https://docs.gitlab.com/api/projects/) 的 `resolve_outdated_diff_discussions` 布尔字段设置），让 GitLab 自动 resolve —— 于是「outdated」塌缩成「resolved」，代价是丢失了「outdated」和「人工解决」的区分。

### 3.5 定位失败时 API 报什么错

创建 diff note 的服务端路径（源码 `lib/api/discussions.rb` → `lib/api/helpers/notes_helpers.rb#process_note_creation_result`）：

```ruby
elsif note.errors.present?
  bad_request!("Note #{note.errors.messages}")
```

也就是 **HTTP 400**，body 形如 `{"message": "400 Bad request - Note {错误 hash 的 Ruby inspect 串}"}`。没有结构化错误码，只有把 ActiveModel 错误 hash 直接 `to_s` 的结果。

`DiffNote` 的校验（源码 `app/models/diff_note.rb`）决定了你会看到哪几种：

| 校验 | 触发条件 | 错误内容 |
|---|---|---|
| `validates :line_code, presence: true, line_code: true` | 三个 SHA 或路径解析不出 diff file / diff line，导致 `line_code` 算不出来 | `{:line_code=>["can't be blank"]}`，格式非法时 `["must be a valid line code"]` |
| `validate :positions_complete` | `file_path` 空、行号组合不完整、或 `diff_refs` 不完整 | `{:position=>["is incomplete"]}` |
| `validate :verify_supported` | noteable 没有完整 diff refs | `{:noteable=>["doesn't support new-style diff notes"]}` |
| `validates :original_position/:position, presence: true` | position 完全缺失 | `{:position=>["can't be blank"]}` |

关键机制：`before_validation :set_line_code` 调 `position.line_code(repository)`，而它是 `diff_file(repository)&.line_code_for_position(self)` —— **拿不到 diff file 或那一行不在 diff 里，就返回 nil，然后 presence 校验失败**。所以「行号对不上」和「文件路径写错」和「SHA 过期」三种完全不同的原因，会收敛成同一个 `line_code can't be blank`。**错误信息无法区分根因，只能靠自己在发请求前校验。**

工程结论：**必须在客户端先把 diff 解析成「可评论行集合」**（file path + 该行的 old_line/new_line 组合），只在集合内的行上发评论。不要试图靠重试或读错误信息来定位。

---

## 4. 拉取变更

### 4.1 `/changes` 与 `/diffs` 的区别

文档：[Merge requests API](https://docs.gitlab.com/api/merge_requests/)

| | `GET .../merge_requests/:iid/changes` | `GET .../merge_requests/:iid/diffs` |
|---|---|---|
| 状态 | **15.7 已废弃**，计划在 API v5 移除 | 推荐 |
| 返回 | 完整 MR 对象 + `changes[]` 数组 + `overflow` 布尔 | **只有** diff 数组 |
| 分页 | 无 | 有，`page` / `per_page`（默认 20） |
| `unidiff` | 有 | 有 |
| `access_raw_diffs` | **有** | **没有** |
| 超限信号 | `overflow: true` | 每个文件上的 `collapsed` / `too_large`（**18.4+**） |

`/diffs` 的每个元素字段：`old_path` / `new_path` / `a_mode` / `b_mode` / `diff` / `new_file` / `renamed_file` / `deleted_file` / `generated_file`（标记为 generated 的文件）/ `collapsed` / `too_large`。

- `collapsed: true` —— 文档原文 "File diffs are excluded but can be fetched on request"。**但 `/diffs` 端点的参数表里并没有任何「展开」参数**（只有 `page` / `per_page` / `unidiff`），文档没说「on request」具体怎么请求。UI 走的是非 API 的 `diffs_batch` 内部路由。实际可用的替代是对该文件单独调 `/repository/files/:path/raw?ref=<head_sha>` 拿全文自己 diff。**这是一个文档与 API 表面不自洽的地方，接入前要实测。**
- `too_large: true` —— 文档原文 "File diffs are excluded and cannot be retrieved"。**取不到，没有补救。**

另有 `GET .../merge_requests/:iid/raw_diffs`，返回原始 `diff --git` 文本，**同样受 diff limits 约束**（文档在两个端点下都挂了同一条 note）。

### 4.2 大 MR 的截断行为

文档：[Diff limits administration](https://docs.gitlab.com/administration/diff_limits/)（Free，自托管可配，GitLab.com 不可配）

| 配置项 | 默认 | 上限 |
|---|---|---|
| Maximum diff patch size | **200 KB** | 500 KB |
| Maximum diff files | **1000** | 3000 |
| Maximum diff lines | **50,000** | 100,000 |
| Maximum diff versions | **1,000** | 无 |
| Maximum diff commits | **1,000,000** | 无 |

行为（原文）：达到前三项任一阈值的 **10%** 时，文件以折叠视图展示，带展开链接；**超过阈值则显示为 Too large，UI 里无法展开**。文档明确 "These limits apply to both the GitLab UI and API endpoints that return diff information."

diff version 上限 1000（17.10 引入 feature flag，**19.0 GA**）：达到后 **MR 无法再更新**，只能关掉重开一个新 MR。

相关的还有 `changes_count`：文档原文「当 MR 的变更多到无法展示和存储时，该值封顶为 1000 并返回字符串 `"1000+"`」。注意它是**字符串不是整数**，且新建 MR 时为空、异步填充。

**绕过截断的唯一 API 路径**是废弃的 `/changes?access_raw_diffs=true`：「通过 Gitaly 直接取 diff，不走数据库，因此不受数据库 diff 的大小限制；代价是更慢更吃资源，Gitaly 自身的限制仍然存在」。—— 也就是说，为了拿完整 diff，你要么用一个已废弃的端点，要么自己 clone 仓库本地 diff。

### 4.3 diff versions

`GET /projects/:id/merge_requests/:iid/versions` 返回数组（最新在前），每条：

```json
{
  "id": 110,
  "head_commit_sha": "33e2ee...",
  "base_commit_sha": "eeb57d...",
  "start_commit_sha": "eeb57d...",
  "created_at": "2016-07-26T14:44:48.926Z",
  "merge_request_id": 105,
  "state": "collected",
  "real_size": "1",
  "patch_id_sha": "d50441..."
}
```

三个 SHA 的语义（文档 "SHAs in the API response"）：

- `base_commit_sha` —— 源分支与目标分支的 **merge-base**
- `head_commit_sha` —— 源分支的 HEAD
- `start_commit_sha` —— 创建这个 diff version 时目标分支的 HEAD

`GET .../versions/:version_id` 返回该版本的完整 `commits[]` 和 `diffs[]`（`diffs[]` 同样带 18.4+ 的 `collapsed` / `too_large`，支持 `unidiff`）。

**可以在旧版本上定位评论**：`position` 的三个 SHA 不要求是最新版本的，传旧 version 的三个 SHA 即可把评论挂到那一版的 diff 上。文档只是「建议」用最新版，没有强制。但这么做出来的评论会立刻处于 outdated 状态（见 §3.4），而 §3.4 又说 outdated 读不到 —— 所以**在旧版本上评论，技术上可行，产品上不建议**。

### 4.4 拿完整文件内容

[Repository files API](https://docs.gitlab.com/api/repository_files/)：

- `GET /projects/:id/repository/files/:file_path?ref=<sha>` —— 返回 `file_name` / `file_path` / `size` / `encoding` / `content`（**base64**）/ `content_sha256` / `ref` / `blob_id` / `commit_id` / `last_commit_id` / `execute_filemode`
- `GET /projects/:id/repository/files/:file_path/raw?ref=<sha>` —— 原始字节，可选 `lfs=true` 取 LFS 实体而非 pointer
- 所需 scope：`api`（读写）、`read_api` 或 `read_repository`（只读）

`file_path` 必须 URL 编码（`/` → `%2F`）。`ref` 传 `position.head_sha` 就能拿到评审时那一刻的文件全文，这对「给 AI 补上下文」很关键。

限流见 §6.3。

### 4.5 顺带有用的端点

- `GET .../merge_requests/:iid/commits` —— MR 的 commit 列表
- `GET .../merge_requests/:iid/pipelines` —— 关联 pipeline
- `POST /projects/:id/merge_requests/:iid/approve` / `unapprove` —— **Free 版次可用**（[approvals API](https://docs.gitlab.com/api/merge_request_approvals/) 明确列出 approve / unapprove / reset_approvals / approval_state 四个端点在所有版次可用，其余需 Premium+）。`approve` 支持 `sha` 参数，与 MR HEAD 不符返回 **409 Conflict**，这是防竞态的正确姿势。
- approvals 文档里专门有一节 "Prevent approval resets in automated merge requests"：自动化流程要等到 `detailed_merge_status` 不再是 `checking` / `approvals_syncing`，且 diff version 的 `patch_id_sha` 非 NULL，再去 approve，否则会出现「bot 批准 → bot 推 commit → bot 的批准被自己重置」的尴尬序列。**同理适用于发评论**：MR 刚创建时 `diff_refs` 和 `changes_count` 都是空的，异步填充，此时发 diff note 必然失败。

---

## 5. 鉴权路线（多租户接入自托管 GitLab）

### 5.1 先说结论：GitLab 没有 GitHub App 的等价物

查遍 [REST API authentication](https://docs.gitlab.com/api/rest/authentication/) 和 [OAuth provider](https://docs.gitlab.com/integration/oauth_provider/)，GitLab 支持的认证方式只有：OAuth 2.0 token、personal access token、project access token、group access token、session cookie、CI/CD job token。

**不存在**「把应用安装到某个 group / project、以应用身份换取短期 installation token、按仓库粒度授权、应用自己有独立身份」这一整套。具体地：

- 没有 app 级身份 —— 评论永远以**某个 user** 的身份出现。
- 没有 installation token —— 没有「每小时轮换的、绑定到某次安装的短期凭据」。
- 没有 app 私钥签 JWT 换 token 的流程。
- OAuth 只有 authorization code（含 PKCE）和 device flow 两类，**没有 client credentials**，也就是说**没有办法脱离某个具体用户拿 token**。

最接近的替代组合见 §5.7。

### 5.2 OAuth 2.0 application

文档：[OAuth 2.0 identity provider API](https://docs.gitlab.com/api/oauth2/)、[Configure GitLab as an OAuth 2.0 provider](https://docs.gitlab.com/integration/oauth_provider/)

三种归属：

| 类型 | 创建者 | 掌控者 | 备注 |
|---|---|---|---|
| user-owned | 任意用户，`/user_settings/applications` | 该用户 | — |
| group-owned | group 的 Settings > Applications | group Owner | — |
| **instance-wide** | 管理员，Admin > Applications | 实例管理员 | **可标记为 trusted，自动跳过用户授权确认页** |

支持的 flow：authorization code、authorization code + PKCE、**device authorization grant（17.1+）**。OAuth 2.1 草案移除的 implicit 和 password 两种 GitLab 也不支持。

token 生命周期：

- access token **默认 2 小时（7200 秒）**。
- **19.1 起管理员可以在自托管上配置 token 生命周期**（此前写死）。
- refresh token 可在 access token 过期后继续使用；用 refresh token 换新 token 会同时失效旧的 access token 和 refresh token（轮换）。
- 删除 application 会连带删除其所有 grant 和 token。
- application secret 默认以哈希形式存库，**只在创建时能看到一次**。

scope 清单见 §5.6（与 access token 共用一张表）。

**能不能代表用户操作**：能，这正是 OAuth 的用途 —— 但必须每个用户走一遍浏览器授权，拿到的 token 权限等于该用户的权限，用户离职/被停用即失效。对「AI 自动 review」这种没有人在场的后台流程不适用。

### 5.3 Group access token

文档：[Group access tokens](https://docs.gitlab.com/user/group/settings/group_access_tokens/)

- **自托管：任何 license 都可用**（GitLab.com 才要 Premium+）。这点对自托管场景很关键。
- 创建者：group **Owner**。
- 创建时选一个 **role**（Guest/Reporter/Developer/Maintainer/Owner）和一组 **scope**。
- 有效期：**必填**；不填则默认为 **365 天后**；默认最长 365 天（17.6 起有 feature flag `buffered_token_expiration_limit` 可放宽到 400 天，默认关闭）。管理员配置 max lifetime 需要 **Ultimate**。
- 背后自动创建一个 **bot user**：
  - 权限对应 token 的 role 和 scope
  - 是 group 成员，继承到子组和项目，**不能被单独加到别的 group/project**
  - **non-billable，不占 license 席位**
  - 贡献归属该 bot 账号；删除后贡献转给 ghost user
- **警告**（文档原文）：group access token 被视为 internal user。如果创建者是 internal user，该 token 能访问所有可见性为 Internal 的项目 —— 这是一个越权面，多租户场景要留意。
- 撤销：group Settings > Access tokens，或 [Group access tokens API](https://docs.gitlab.com/api/group_access_tokens/)。
- 轮换：Rotate 生成新 token，旧 token **立即失效**，两个版本都保留供审计。
- 顶级 group Owner 可以在 Settings > General > Permissions 里**整体禁止**本组内创建 group/project access token（GitLab.com 上这项要 Premium+）。
- 过期邮件：到期前 7 天通知 Owner；17.6+ 增加 30 天和 60 天；17.7+ 可配置是否通知继承成员。

### 5.4 Project access token

文档：[Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)

与 group access token 同构，差别：

- 创建者：project **Maintainer 或 Owner**。
- 作用域限于单个项目，**不能访问其他项目**。
- 自托管同样任何 license 可用；GitLab.com 要 Premium+。
- 同样有 bot user、同样 non-billable、同样 365 天默认上限、同样支持 rotate。

### 5.5 个人 PAT 与细粒度 PAT

普通 PAT（[文档](https://docs.gitlab.com/user/profile/personal_access_tokens/)）：

- 可访问该用户能访问的**全部** group 和 project —— 权限面最大，多租户场景最不该用。
- 有效期必填，不填默认 365 天；**管理员配置 max lifetime 要 Ultimate**。
- 撤销在用户自己手里（也可由 admin 撤销）。可通过 `POST /user/personal_access_tokens`（有限）和 `DELETE /personal_access_tokens/:id` 程序化管理。
- service account 的 PAT **可以设为永不过期**。

**细粒度 PAT**（[Fine-grained personal access tokens](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/)）—— 18.10 beta，**19.2 GA**：

- 按「资源（resource）× 权限（CRUD）」授权，资源分 `Group and project` / `User` / `Global` 三个边界。
- 创建时可以限定「Group and project access」的范围。
- 管理员可以创建**带 sudo 能力**的细粒度 token，且**模拟时仍然强制执行 token 自身的权限**：只有「被模拟用户允许」且「token 有该权限」时动作才成立。文档明确指出这与传统 `sudo` scope 的 PAT 不同 —— 后者能以被模拟用户身份做任何事。
- 自托管管理员可以设一个 enforcement date，之后全实例只能创建细粒度 token（19.2 GA）。

**这是 GitLab 目前最接近 GitHub App 细粒度授权的东西**。代价是版本门槛高（19.2），2026 年 9 月的企业实例大概率没有。

### 5.6 scope 清单

文档：[Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)（Free）

对 code review 相关的：

| scope | 可用于 | 给什么 |
|---|---|---|
| `api` | Personal, group, project | 该 token 作用域内 API 的**完整读写**，含 container registry / dependency proxy / package registry |
| `read_api` | Personal, group, project | 该作用域内 API 的**只读** |
| `read_repository` | Personal, group, project | 仓库只读（Git-over-HTTP 或 repository files API） |
| `write_repository` | Personal, group, project | 仓库读写（Git-over-HTTP）。**不支持 API 认证** |
| `self_rotate` | Personal, group, project | 只能轮换自己（17.9+） |
| `ai_features` | Personal, group, project | GitLab Duo / Code Suggestions API |
| `sudo` | **Personal only** | 以管理员身份、以任意用户身份执行 API 动作 |
| `admin_mode` | **Personal only** | Admin Mode 开启时执行管理 API |
| `read_user` | **Personal only** | 读 `/user` 和 `/users` 只读端点 |

**发评论必须 `api`**。这是本文最重要的一条限制之一：**GitLab 没有「只能写评论」的细粒度 scope**（细粒度 PAT 除外）。给 bot 发评论的能力，就等于给了它在其作用域内删项目、改 CI 变量的能力 —— 只能靠 **role**（给 Developer 而非 Maintainer/Owner）来收窄，而不是靠 scope。

认证头：`PRIVATE-TOKEN: <token>`（推荐）或 `Authorization: Bearer <token>`；OAuth token 也可用 `Authorization: Bearer` 或 `access_token` 查询参数；job token 用 `JOB-TOKEN`。认证失败统一 `401 {"message": "401 Unauthorized"}`。

### 5.7 评论以谁的身份发出

四个选项：

**A. Service account（推荐默认）** —— [文档](https://docs.gitlab.com/user/profile/service_accounts/)

- **18.11 起在 Free 可用**（18.10 带 flag，18.11 GA 并移除 flag）。此前需要 Premium+。
- 三种层级：instance（需 admin）、group、project（subgroup / project 级 18.10 引入，**18.11 GA**）。
- 特征：不占席位、非 billable、**始终标记为 external user**、**不能通过 UI 登录**、不能被 LDAP 管理、在成员列表里显式标为 service account。
- 用 PAT 认证，且**service account 的 PAT 可以设为永不过期**。
- 配额：Premium/Ultimate 无限；**Free 版自托管全实例最多 100 个**。
- 可通过 [service accounts API](https://docs.gitlab.com/api/service_accounts/) 程序化创建。

**B. Group access token 的 bot user** —— 零额外配置，自托管全版次可用，最省事。缺点是身份名字是 `group_NNN_bot_xxx` 这种，产品上不好看；且 internal user 越权面（§5.3）。

**C. 真人 PAT** —— 只适合单团队试点。权限面最大、随人离职失效、评论以真人身份出现会引起误解。多租户不要用。

**D. Impersonation token / `sudo`** —— 让评论以「被评审者本人」或任意指定用户的身份出现。

impersonation 的细节（[REST authentication](https://docs.gitlab.com/api/rest/authentication/)）：

- impersonation token 是 PAT 的一种，**只有管理员能创建**（`POST /users/:user_id/impersonation_tokens`，见 [User tokens API](https://docs.gitlab.com/api/user_tokens/)）。用法与普通 PAT 完全一样，能做 API 调用也能做 Git 读写。
- **文档原文：「These tokens are not visible to the associated user on their profile settings page.」** —— 被模拟的用户在自己的设置页**看不到**这个以他名义存在的 token，也就无从撤销。这在合规审查里是个明确的红旗。
- `Sudo` header：需要一个**管理员的、带 `sudo` scope 的** OAuth 或 PAT。传 `Sudo: <user id 或 username>`，请求以被模拟用户的权限执行。
- 错误码：非管理员 token → `403 {"message":"403 Forbidden - Must be admin to use sudo"}`；token 无 `sudo` scope → `403 {"error":"insufficient_scope", ...}`；用户不存在 → `404`。
- **实例可以整体关闭 impersonation**：`gitlab_rails['impersonation_enabled'] = false`。企业安全团队大概率会关。

风险评估：impersonation 要求你的平台长期持有一个**实例管理员级别的 token**。一旦泄露即等于整个 GitLab 实例失守。对一个多租户 SaaS 型内部平台，这是不可接受的爆炸半径。**结论：不要走 impersonation**，除非细粒度 PAT（19.2+）可用 —— 它的 sudo 至少还受 token 自身权限约束。

### 5.8 CI/CD job token 不适用

[CI/CD job token](https://docs.gitlab.com/ci/jobs/ci_job_token/) 只在 job 运行期间有效，且只能访问**特定白名单端点**。外部常驻服务用不上。

### 5.9 多租户接入的推荐路线

按优先级：

1. **每个租户（顶级 group）一个 group-level service account + 一个长期 PAT（`api` scope，role = Developer）**，由租户的 group Owner 创建后交给平台保管。
   - 租户完全掌控：Owner 随时能在 group 成员页看到它、移除它、撤销它的 token。
   - 不占席位。
   - 权限天然限定在该 group 及其子组/项目内。
   - 版本门槛：service account 在 Free 需要 **18.11+**；低于此版本退化到方案 2。
2. **每个租户一个 group access token**（role = Developer，scope = `api`）。自托管全版次可用，版本门槛最低。缺点：bot 用户名不好看、有 internal user 越权面、最长 365 天需要轮换。
3. **实例统一一个 instance-level service account**，由平台管理员维护，逐个被邀请进各租户 group。省事但撤销权不在租户手里，多租户隔离靠自觉，不推荐。
4. **OAuth（instance-wide + trusted）** 只用于**用户登录你自己的平台**（拿 identity、判断这个人在 GitLab 里能看哪些项目），**不用来发评论**。这是一个很自然的分工：OAuth 管「人看什么」，service account 管「机器写什么」。

无论哪条路，都要在自己的库里把「租户 → token → 到期时间」建模，并在到期前 30/60 天主动提醒（GitLab 自己的过期邮件只发给 group Owner，发不到你的平台）。token 轮换用 rotate 接口，旧 token 立即失效，要做好切换窗口。

---

## 6. 限流

文档：[Rate limits](https://docs.gitlab.com/rate_limits/)（Tier: Free+，Offering: **GitLab Self-Managed, GitLab Dedicated**）

### 6.1 通用 API 限流：自托管默认**关闭**

[User and IP rate limits](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/) 文档原文：以下四项**默认关闭**：

- Unauthenticated API requests（按 IP）
- Unauthenticated web requests（按 IP）
- Authenticated API requests（按 user）
- Authenticated web requests（按 user）

开启后的默认值：

| 限流项 | 默认额度 | 默认周期 |
|---|---|---|
| Unauthenticated API（per IP） | 3600 | 3600 秒 |
| Unauthenticated web（per IP） | 3600 | 3600 秒 |
| **Authenticated API（per user）** | **7200** | **3600 秒** |
| Authenticated web（per user） | 7200 | 3600 秒 |

也就是说**开启后是每用户每小时 7200 次 API 请求，约合 120 次/分钟**。注意计数维度是 **user**，不是 token —— 同一个 bot 账号的所有 token 共享配额。

配置位置：Admin > Settings > Network > User and IP rate limits。

响应头（每次请求都带）：`RateLimit-Limit` / `RateLimit-Name`（如 `throttle_authenticated_api`）/ `RateLimit-Observed` / `RateLimit-Remaining` / `RateLimit-Reset`（Unix 时间）。
**被限流时（429）额外带**：`RateLimit-ResetTime`（RFC2616 日期）和 **`Retry-After`（秒）**。默认响应体是纯文本 `Retry later`，可自定义。

两个自托管专属逃生口：

- **Bypass header**：在 LB 上给内部流量打一个头（名字自定，如 `Gitlab-Bypass-Rate-Limiting: 1`），并设环境变量 `GITLAB_THROTTLE_BYPASS_HEADER`。绕过的请求在 `production_json.log` 里标 `"throttle_safelist":"throttle_bypass_header"`。**前提是 LB 必须清洗外部传入的该头**。
- **User allowlist**：环境变量 `GITLAB_THROTTLE_USER_ALLOWLIST=1,53,217`（用户 ID 逗号分隔），只对认证请求生效。标记为 `"throttle_safelist":"throttle_user_allowlist"`。

**把 AI review 的 bot 账号加进 user allowlist，是自托管场景最直接的解法。**

### 6.2 note 创建限流：默认**开启**，300/min/user

[Content creation rate limits](https://docs.gitlab.com/rate_limits/content_creation/)（Tier: Free+，Offering: GitLab Self-Managed）

Note 创建：

- **默认 300 次/分钟**
- **按 user 独立计算，不按 IP**
- Admin > Settings > Network > Notes rate limit
- **有一个「Users to exclude from the rate limit」的排除名单** —— 把 bot 账号加进去即可
- 超限请求记入 `auth.log`，超限后需等 1 分钟

这是对「一个 MR 发 50 条行内评论」这类操作最直接的约束。300/min 在单 MR 上够用，但如果做全仓扫描或批量回填，会撞。

Issue/epic 创建限流默认关闭，与我们无关。

### 6.3 其他相关限流

不可配置的（[Non-configurable rate limits](https://docs.gitlab.com/rate_limits/non_configurable/)）：

| 限制 | 额度 | 说明 |
|---|---|---|
| **Repository blob / file 访问** | **5 次/分钟/对象/项目** | 仅针对 **>10 MB** 的文件，18.1 引入 |
| Repository archives | 5 次/分钟/用户 | 下载仓库归档 |
| Commit diff files | 6 次/分钟 | 展开的 commit diff files 页 |
| Changelog 生成 | 5 次/分钟/用户/项目 | — |

Commits / Files API（18.7 引入，[instance limits](https://docs.gitlab.com/administration/instance_limits/#commits-and-files-api-limits)）：

- 最大请求体 **300 MB**（`GITLAB_COMMITS_MAX_REQUEST_SIZE_BYTES` 可改），超出返回 `413`
- **>20 MB 的请求：30 秒内最多 3 次**

只影响写接口（create commit / create file / update file），读 diff 不受此限。

其他硬上限：

- **单个 issue / MR / commit 最多 5,000 条评论**。到达后系统 note 仍能写，用户评论会失败。
- **单条评论正文约 100 万字符 / ~1 MB**（Notes API 也写明 `body` 限 1,000,000 字符）。
- offset 分页的最大 offset 默认 **50,000**（`offset_pagination_limit`），只对同时支持 keyset 的端点生效。
- 查询结果超过 **10,000** 条时，**不返回** `x-total` / `x-total-pages` / `rel="last"` link。

### 6.4 会不会被封

[Abuse and failed authentication bans](https://docs.gitlab.com/rate_limits/abuse_bans/)：
认证失败封禁只作用于 **Git 请求和 container registry (`/jwt/auth`)**，不作用于 REST API，且**默认关闭**。默认阈值：1 分钟内 10 次失败 → 403 持续 1 小时；封禁期间**即使凭据正确也返回 403**（先查封禁再查凭据），**且不返回任何响应头**。

结论：正常调 REST API 不会被「封号」，最坏是 429。但如果你的 token 过期后还在重试 Git clone，会撞上这条。

### 6.5 GitLab.com 的数值（仅作参考锚点）

我们只做自托管，但 GitLab.com 的公开限额能说明「GitLab 自己认为什么量级是合理的」（[Rate limits on GitLab.com](https://docs.gitlab.com/user/gitlab_com/#rate-limits-on-gitlabcom)）：

| 项 | GitLab.com | 自托管默认 |
|---|---|---|
| 认证 API（per user） | **2,000 / 分钟** | 关闭（开启后 7,200 / 小时 ≈ 120 / 分钟） |
| 未认证流量（per IP） | 500 / 分钟 | 关闭（开启后 3,600 / 小时） |
| **issue 与 MR 上的 note 创建** | **60 / 分钟** | **300 / 分钟** |
| repository files | 500 / 分钟 | 见 §6.3 的非可配项 |
| raw endpoint（per project/commit/path） | 300 / 分钟 | 可配 |
| pipeline 创建 | 25 / 分钟 | 可配 |

注意 GitLab.com 的 note 创建限额是 **60/分钟**，比自托管默认严格 5 倍。把它当作「一个 MR 一次最多发多少条评论」的保守设计上界比较稳妥。另外文档特别注明：Projects / Groups / Users API 的限流响应**不带信息性响应头**。

### 6.6 退避做法

官方给的唯一明确建议在 abuse_bans 页：「为失败的认证尝试配置指数退避与重试」，并链到 AWS 的 retry-backoff 模式文档。API 限流这边官方没给建议，但给足了信号，实践上：

1. 读 `RateLimit-Remaining`，低于阈值（比如 10%）时主动降速，不要等 429。
2. 收到 429 严格遵守 `Retry-After`，不要自己拍脑袋。
3. 按 **user 维度**做客户端限流器（因为服务端就是按 user 计的），不要按 token 或按项目。
4. 评论发布走队列串行化，天然把峰值削平，顺便解决 note 300/min 的问题。
5. 把 bot 加入 `GITLAB_THROTTLE_USER_ALLOWLIST` 和 notes 排除名单 —— 这是要写进部署文档、让客户 DBA 执行的一步。

---

## 7. CI 集成

### 7.1 Code Quality report：轻量呈现方案，但有两个硬门槛

文档：[Code Quality](https://docs.gitlab.com/ci/testing/code_quality/)

**版次矩阵（文档原表）**：

| 能力 | Free | Premium | Ultimate |
|---|:---:|:---:|:---:|
| 从 CI job 导入 Code Quality 结果 | ✅ | ✅ | ✅ |
| CodeClimate 内建扫描（**已废弃**） | ✅ | ✅ | ✅ |
| **MR Reports 标签页看到结果** | ✅ | ✅ | ✅ |
| Pipeline 详情页看到结果 | ❌ | ✅ | ✅ |
| **MR Changes（diff）视图行内标注** | ❌ | ❌ | **✅** |
| 项目质量总览页 | ❌ | ❌ | ✅ |

**报告格式**（CodeClimate 格式的子集），文件必须是单个 JSON 数组，每个元素至少包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | String | 人类可读的描述 |
| `check_name` | String | 规则名 |
| `fingerprint` | String | 唯一指纹（如内容哈希）。**相同 fingerprint 的多条发现在 MR 上合并为一条** |
| `location.path` | String | 仓库内相对路径，**不要加 `./` 前缀** |
| `location.lines.begin` 或 `location.positions.begin.line` | Integer | 行号 |
| `severity` | String | `info` / `minor` / `major` / `critical` / `blocker` |

合规示例：

```json
[
  {
    "description": "'unused' is assigned a value but never used.",
    "check_name": "no-unused-vars",
    "fingerprint": "7815696ecbf1c96e6894b779456d330e",
    "severity": "minor",
    "location": { "path": "lib/index.js", "lines": { "begin": 42 } }
  }
]
```

坑：GitLab 的解析器**不接受文件开头的 UTF-8 BOM**（文档甚至给了一段去 BOM 的 shell）。

**能不能不用 GitLab 的 codequality 镜像？能。** 文档明确说 Code Quality 是 "an open system that supports importing results from many scanning tools"，推荐做法就是自己跑工具、输出符合格式的 JSON、声明 `artifacts:reports:codequality`。内建的 CodeClimate 模板反而**已被标记为 deprecated**。

**但是必须走 CI job artifact。** 唯一的挂载方式是 [`artifacts:reports:codequality`](https://docs.gitlab.com/ci/yaml/artifacts_reports/#artifactsreportscodequality)。**没有任何 REST API 可以从外部直接提交一份 code quality report**。工件的 `expire_in` 被强制设为 `1 week`。

源码佐证：`config/routes/merge_requests.rb` 里与 code quality 相关的只有两条路由，且都是 `get`：

```ruby
get :codequality_reports
get :codequality_mr_diff_reports
```

它们是 Rails 前端内部路由（不在 `/api/v4` 下），**只读**，供 MR 页面渲染用。没有任何 `post` 对应物。

对我们的含义：想用 code quality report 呈现 AI finding，架构必须变成「平台把 finding 写到某处 → MR 的 pipeline 里有一个 job 去取回来 → 输出 JSON → 声明 artifact」。这引入了对客户 `.gitlab-ci.yml` 的侵入，以及「pipeline 必须跑完 AI 才有结果」的时序耦合。

**而且行内标注要 Ultimate。** Free 和 Premium 下 finding 只出现在 MR 的 Reports 标签页，不会出现在 diff 旁边。**「比发评论更轻的呈现方式」这个设想，在 Free/Premium 实例上并不成立** —— 它比评论更重（要改 CI）且更不可见（不在 diff 上）。

### 7.2 SAST report

[`artifacts:reports:sast`](https://docs.gitlab.com/ci/yaml/artifacts_reports/) 同理，必须来自 CI job。MR 安全 widget 及漏洞管理属于 Ultimate 能力域。对我们不构成一个比评论更轻的路径，不展开。

### 7.3 从外部拉 CI 产物作为证据

- [Job artifacts API](https://docs.gitlab.com/api/job_artifacts/)（**Free**）：按 job ID 下载整包、下载包内单个文件、按 ref + job name 下载最新产物。19.4 给「按 job ID 下载」加了 `file_type` 参数。
- [Pipelines API](https://docs.gitlab.com/api/pipelines/) / [Jobs API](https://docs.gitlab.com/api/jobs/)：拿 job 列表、job trace（日志）。
- `GET /projects/:id/merge_requests/:iid/pipelines`：从 MR 找到关联 pipeline。

这条路是通的，且是 Free。**把「lint / test / 已有扫描器的结果」作为 AI 调查的证据来源，比把 AI 结果塞回 CI 更划算。**

artifact 过期是要注意的点：Code Quality 报告固定 1 周过期，普通 artifact 按项目配置。想长期留存要自己抓下来存。

### 7.4 给 MR 打「通过 / 不通过」

两条路：

| | External status checks | Commit status |
|---|---|---|
| 文档 | [Status checks API](https://docs.gitlab.com/api/status_checks/) | [Commits API](https://docs.gitlab.com/api/commits/#set-commit-pipeline-status) |
| 版次 | **Ultimate** | **Free** |
| 端点 | `GET/POST /projects/:id/external_status_checks` 等 | `POST /projects/:id/statuses/:sha` |
| 能否阻塞合并 | 是（`status_checks_must_pass` 会出现在 `detailed_merge_status`） | 通过「pipeline 必须成功才能合并」间接阻塞 |

Commit status 的参数：`state`（`pending`/`running`/`success`/`failed`/`canceled`/`skipped`）、`name` 或 `context`（区分不同系统的标签）、`target_url`（点进去看详情）、`description`（≤255 字符）、`ref`、`pipeline_id`、`coverage`。

行为细节（文档原文）：设置 commit status 时，GitLab 先找已有 pipeline 追加 job；找不到就**新建一个 `CI_PIPELINE_SOURCE: external` 的 pipeline**。同一 SHA 有重复 pipeline 时归属会有歧义。同一个 SHA/ref 上有并发更新时返回 **409**，需重试。

**结论：在 Free/Premium 实例上，`POST /projects/:id/statuses/:sha` 是「让 AI review 的结论出现在 MR 头部、并可选地阻塞合并」的唯一 Free 路径**，比 code quality report 轻得多（一次 HTTP 调用，不碰 CI 配置）。这个发现比 code quality 那条更有价值。

---

## 8. CE / EE 与版本差异汇总

对 AI code review 平台真正会卡住的项：

| 能力 | 版次门槛 | 版本门槛 |
|---|---|---|
| Discussions / Notes / Draft Notes / Suggestions | **Free** | 长期存在（`line_range` 未标注） |
| MR approve / unapprove / approval_state | **Free** | 长期存在 |
| 审批规则（approval rules、code owner 规则） | **Premium+** | — |
| Project webhook | **Free** | — |
| **Group webhook** | **Premium+** | — |
| System hook | Free（仅 admin） | — |
| Webhook HMAC 签名 | Free | **19.0**（19.1 GA） |
| Webhook `Idempotency-Key` | Free | **17.4** |
| `/diffs` 的 `collapsed` / `too_large` | Free | **18.4** |
| diff version 上限 1000 | Free | 17.10 flag / **19.0 GA** |
| MR webhook `actioned_at` | Free | **18.10** |
| MR webhook `merged_at` | Free | **19.1** |
| MR webhook `target_branch_protected` | Free | **19.2** |
| MR webhook 自动合并事件 | Free | **19.2** |
| MR webhook submit-review 事件 | Free | **19.3** |
| Group / project access token（自托管） | **Free** | 长期存在 |
| Service accounts | **Free（18.11 起）**，此前 Premium+ | **18.11** |
| Project / subgroup 级 service account | Free | **18.11** |
| 细粒度 PAT | Free | 18.10 beta / **19.2 GA** |
| OAuth device flow | Free | **17.1** |
| OAuth token 生命周期可配（自托管） | Free | **19.1** |
| Token max lifetime 管理员配置 | **Ultimate** | 17.6（400 天扩展带 flag） |
| Code Quality —— MR Reports 页 | **Free** | — |
| Code Quality —— pipeline 详情页 | **Premium+** | — |
| **Code Quality —— MR diff 行内标注** | **Ultimate** | — |
| **External status checks** | **Ultimate** | — |
| Commit status API | **Free** | 长期存在 |
| Job artifacts / pipelines / jobs API | **Free** | — |

**一个保守的版本基线建议**：把产品的最低支持版本定在 **GitLab 17.4**（有 `Idempotency-Key` 可做去重），并把 **18.4**（`too_large` / `collapsed`）和 **19.0**（webhook 签名）作为「增强能力」分档降级。低于 17.4 的实例，webhook 去重只能靠自己按 `(project_id, mr_iid, action, updated_at)` 做弱幂等，且没有任何签名校验手段（只有明文 token 比对）。

---

## 9. 做不到的事（API 层面的硬限制）

> 这一节按「对设计决策的杀伤力」排序。

### 9.1 没有应用身份，评论必须挂在一个「人」上

GitLab 不存在 GitHub App。没有 installation token、没有 client credentials flow、没有 app 级 actor。任何一条评论、任何一次 resolve，在 GitLab 数据模型里都归属于一个 `User` 记录。

**推论**：产品必须接受「AI 以一个机器人账号的名义说话」。以及 —— 这个账号必须被每个租户主动接纳进自己的 group（加成员、给角色）。**接入流程里无法避免「让客户的 group Owner 做几步手工配置」这一环。** 没有 GitHub App 那种「一次点击安装、自动获得全组织权限」的体验，这直接影响 onboarding 成本和销售话术。

### 9.2 没有「只写评论」的权限粒度

[Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/) 这张表里，与写评论相关的只有 `api` 一个 —— 而 `api` 的定义是「Grants complete read and write access to the API for the token's scope」。**没有 `write_notes`、没有 `write_discussions` 这一类细分 scope。**

实际权限 = `api` scope ∩ token 的 role。把 role 压到 Developer 能挡住删项目、改 CI/CD 变量、改保护分支规则这些 Maintainer/Owner 动作，但 Developer 仍然能：推送非保护分支（含 force push）、创建和关闭 issue、增删改 wiki、取消和重试 pipeline、创建 MR。

细粒度 PAT（19.2+）是唯一真正的解，但版本门槛太高，2026 年的企业实例大概率用不上。

**推论**：安全评审时你会被问「为什么这个机器人需要我整个 group 的读写权限」，而你只能回答「GitLab 的 scope 模型不支持更细」。要提前准备补偿措施：token 只存 KMS、按租户隔离、对自己的全部出站调用做审计日志、并提供一个「只读模式」（`read_api` + 结论只推到自己的 Web 界面、不回写 GitLab）作为高安全客户的降级方案。

### 9.3 无法通过 API 判断一条行内评论是否 outdated

REST 的 `Entities::Note` 只暴露 `position`；`original_position`、`change_position`、`active?` 一律不暴露。GraphQL 的 `Note` 类型同样没有任何 outdated / active 字段。

**推论（这条最伤）**：

- 做不了「把已失效的 AI 评论自动收起来 / 撤回」这个功能，除非靠 §3.4 的间接推断（对比 `position.head_sha` 与最新 `diff_refs.head_sha`），而那是未文档化的行为。
- 做不了准确的「AI 评论采纳率」统计 —— 无法区分「开发者改了代码所以评论失效」和「开发者无视了评论」。
- 唯一可靠的信号在 **Note webhook 载荷**里（`change_position`、`resolved_by_push`），意味着**必须持久化每一个 Note 事件**，不能只在需要时去 REST 拉。这是一个架构约束：**评论状态必须是事件溯源的，不能是查询式的。**

### 9.4 定位失败的错误信息无法区分根因

三种完全不同的失败 —— SHA 过期、路径写错、行号不在 diff 里 —— 全部收敛成 `400 Bad request - Note {:line_code=>["can't be blank"]}`。没有错误码，没有结构化字段，错误内容是 Ruby hash 的 `to_s`。

**推论**：不能靠「发了再说，失败了重试/降级」的策略。必须在客户端**先把 diff 解析成可评论行的白名单**（每个文件的 hunk 里哪些 (old_line, new_line) 组合是合法的），只在白名单内发评论。这意味着 diff 解析器是这个产品的**必需组件而不是优化项**，且它的正确性直接决定评论成功率。

### 9.5 只能在 diff 覆盖的行上评论

`line_code` 要靠 `diff_file.line_code_for_position` 算出来，而 diff file 只包含 hunk 内的行（变更行 + context 行）。**文件里没被 diff 覆盖到的部分无法发行内评论。**

**推论**：「AI 发现这个改动会影响到 300 行之外的一个函数」这类跨行发现，**没法评论在那个函数上**。只能：(a) 评论在最近的可评论行上并在正文里说明，(b) 用 `position_type: file` 做整文件级评论，(c) 退回 MR 概览评论。这限制了 AI 能表达的发现类型 —— **深度上下文分析的价值在呈现层被砍掉一截**。

### 9.6 多行评论的 `line_code` 必须自己拼，且规则未完整文档化

文档只给了 `<文件名 SHA1>_<old>_<new>` 的格式和一个例子，没说新增行的 old 位该填什么、删除行的 new 位该填什么。校验正则宽松（`[a-z0-9]+_\d+_\d+`），格式对但语义错的 line_code 会通过格式校验、在后续失败。

**推论**：多行评论的实现成本远高于单行，且**需要先在目标实例上做一次「读回 GitLab 自己生成的 line_code」的探测**。第一版应该只做单行评论。

### 9.7 大 MR 的完整 diff 只有两条路，都不好

- `/diffs` 和 `/raw_diffs` 都受 diff limits 约束（默认 200 KB patch / 1000 文件 / 50000 行），超限文件返回 `too_large: true` 且 `diff` 为空，**取不到**。
- 唯一的绕过参数 `access_raw_diffs` 只存在于 **15.7 已废弃的 `/changes` 端点**上，且文档承认它更慢更吃资源。
- 剩下的只有自己 clone 仓库。

**推论**：「大 PR 的递归拆分」那条 ticket 的前提被这里卡住 —— **在最大的那些 MR 上，你从 API 根本拿不到完整变更**。要么让客户调高 diff limits（要 admin 权限、会影响实例性能、文档明确警告「谨慎调整并监控」），要么产品必须内建一条 clone-and-diff 的路径。这是个需要提前决策的架构分叉，不是能事后补的优化。

另外 `/diffs` 是**按文件分页**的，不是按 hunk 分页 —— 单个超大文件仍然是一个不可分割的单元，分页救不了它。

### 9.8 没有原子的「提交一次 review」

Draft Notes + `bulk_publish` 是最接近的，但：

- 草稿仍需**逐条 POST** 创建，N 条评论 = N 次请求 = N 次撞 note 限流的机会。
- `bulk_publish` 只发布**当前 token 用户自己的**草稿。
- `reviewer_state` 只接受 `requested_changes` / `reviewed`，**文档明确写「Does not record a formal approval」**。要 approve 得另外调 `/approve`。
- 创建到发布之间如果 MR 被 push 了新代码，草稿的 position 会失效，行为文档未说明。

**推论**：做不到「要么全发要么全不发」。N 条评论发到一半失败，MR 上就留着半截 review。需要自己做补偿（记录已发的 note id，失败时回滚删除），而删除评论本身又会在 MR 活动流里留痕。

### 9.9 Webhook 的可靠性承诺很弱

- 文档**没有承诺任何重试策略**，只让你「准备好处理重复」。
- **没有顺序保证**（文档只字未提）。
- 19.0 之前**没有 HMAC 签名**，只有明文 `X-Gitlab-Token` 比对 —— 无法防篡改，只能防「不知道 token 的人乱发」。
- 19.0 之前**没有 `webhook-timestamp`**，无法做时间戳防重放。
- 17.4 之前**连去重键都没有**。
- 自托管上 project webhook 的自动禁用**默认关闭**，所以「我的接收端挂了 GitLab 会告诉我吗」的答案是：不会。
- **一次 push 涉及超过 3 个分支/tag 时，整个 push 事件一个 webhook 都不发**（`push_event_hooks_limit`）。

**推论**：webhook 只能当「有事发生了，去拉一下」的提示信号，**绝不能当数据源**。收到事件后必须回头调 API 拉当前状态。同时必须有一条**定时对账**的路径（定期扫描活跃 MR，比对自己库里的状态），因为漏事件是常态不是异常。

### 9.10 版次门槛把两个「轻量呈现」方案都堵死了

- **Code Quality 的 MR diff 行内标注要 Ultimate**。Free/Premium 上 finding 只在 Reports 标签页，还得改客户的 `.gitlab-ci.yml`。
- **External status checks 要 Ultimate**。

**推论**：把「AI finding 以 code quality report 形式呈现」当作比评论更轻的路径，这个假设**在大多数自托管实例上不成立**。Free 版可用的轻量路径只剩 `POST /projects/:id/statuses/:sha`（commit status）—— 它能在 MR 头部显示一个带链接的状态项，一次 HTTP 调用，不碰 CI 配置。**这应该是「轻量模式」的默认实现，而不是 code quality report。**

### 9.11 其他会在某天咬人的上限

- 单 MR **最多 5000 条评论**，超出后用户评论创建失败（系统 note 仍可写）。全仓回填场景要留意。
- 单条评论正文 **~1 MB / 1,000,000 字符**。
- **diff version 上限 1000**（19.0 GA），达到后 **MR 无法再更新，只能关掉重开**。长寿命 MR + 频繁 push 会撞。
- 查询超过 **10,000** 条时不返回 `x-total` —— 分页 UI 显示不了总数。
- **MR 列表和 discussions 列表都只有 offset 分页。** [REST API 文档的 keyset 支持资源表](https://docs.gitlab.com/api/rest/#supported-resources)里逐条列出了支持 keyset 的资源（group / project / user / jobs / audit events / project issues / repository tree / registry tags / runner jobs），**没有 merge requests，也没有 discussions**。discussions 默认 20 条/页。评论极多的 MR 拉取代价高，且受 offset 上限约束。
- Repository files API 对 **>10 MB 的文件限 5 次/分钟/对象**，大文件的上下文补全会被卡。
- 新建 MR 后 `diff_refs` / `changes_count` **异步填充**，此时发 diff note 必然失败。必须等 `prepared_at` 非空，或轮询 `detailed_merge_status` 直到不是 `preparing` / `checking` / `approvals_syncing`。

---

## 10. 对产品形态的直接推论

把上面的边界折算成决策：

1. **行内评论可以做，是第一等公民。** position 六元组齐全、Free 版次、有 resolve、有 suggestion 可一键应用。这条路是通的。
2. **但必须自建 diff 解析器**，用来生成「可评论行白名单」。这不是优化项，是能不能发出评论的前提（§9.4、§9.5）。
3. **评论状态必须事件溯源。** outdated / resolved_by_push 只在 webhook 载荷里，REST 拉不到。所有 Note 事件都要落库（§9.3）。
4. **Webhook 当信号，不当数据源**，并且必须有定时对账兜底（§9.9）。
5. **鉴权走 group-level service account（18.11+）或 group access token（全版本）**，每租户一套，由租户 Owner 掌控和撤销。OAuth 只用于人登录，不用于机器写。绝不走 impersonation（§5.7、§5.9）。
6. **轻量模式用 commit status，不用 code quality report**（§9.10）。
7. **大 MR 需要一条 clone-and-diff 的备用路径**，因为 API 拿不到超限 diff。这条要在架构上预留，不能事后补（§9.7）。
8. **第一版不做多行评论**，`line_code` 的拼装规则风险大于收益（§9.6）。
9. **部署文档里必须包含两条要客户执行的限流配置**：把 bot 加入 notes rate limit 排除名单，以及（如果实例开了 API 限流）加入 `GITLAB_THROTTLE_USER_ALLOWLIST`（§6.6）。
10. **接入前先探测版本**（`GET /api/v4/version`），按 17.4 / 18.4 / 19.0 / 19.2 分档降级功能。

---

## 附录：本文引用的一手来源

API 文档：

- [Discussions API](https://docs.gitlab.com/api/discussions/)
- [Notes API](https://docs.gitlab.com/api/notes/)
- [Draft Notes API](https://docs.gitlab.com/api/draft_notes/)
- [Suggest Changes API](https://docs.gitlab.com/api/suggestions/)
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [Merge request approvals API](https://docs.gitlab.com/api/merge_request_approvals/)
- [Repository files API](https://docs.gitlab.com/api/repository_files/)
- [Commits API](https://docs.gitlab.com/api/commits/)
- [Job Artifacts API](https://docs.gitlab.com/api/job_artifacts/)
- [External Status Checks API](https://docs.gitlab.com/api/status_checks/)
- [Projects API](https://docs.gitlab.com/api/projects/)
- [REST API](https://docs.gitlab.com/api/rest/) / [REST API authentication](https://docs.gitlab.com/api/rest/authentication/)
- [OAuth 2.0 identity provider API](https://docs.gitlab.com/api/oauth2/)

用户与管理文档：

- [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/) / [Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)
- [Merge request diff versions](https://docs.gitlab.com/user/project/merge_requests/versions/)
- [Discussions](https://docs.gitlab.com/user/discussions/)
- [Code Quality](https://docs.gitlab.com/ci/testing/code_quality/) / [`artifacts:reports`](https://docs.gitlab.com/ci/yaml/artifacts_reports/)
- [Diff limits administration](https://docs.gitlab.com/administration/diff_limits/)
- [GitLab application limits](https://docs.gitlab.com/administration/instance_limits/)
- [Rate limits](https://docs.gitlab.com/rate_limits/) / [Content creation](https://docs.gitlab.com/rate_limits/content_creation/) / [Non-configurable](https://docs.gitlab.com/rate_limits/non_configurable/) / [Abuse bans](https://docs.gitlab.com/rate_limits/abuse_bans/)
- [User and IP rate limits](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/)
- [Access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [Group access tokens](https://docs.gitlab.com/user/group/settings/group_access_tokens/)
- [Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [Service accounts](https://docs.gitlab.com/user/profile/service_accounts/)
- [Fine-grained personal access tokens](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/)
- [Configure GitLab as an OAuth 2.0 provider](https://docs.gitlab.com/integration/oauth_provider/)
- [GraphQL API reference](https://docs.gitlab.com/api/graphql/reference/)

源码（`gitlab-org/gitlab` master，文档未覆盖的部分）：

- `app/models/diff_note.rb` —— DiffNote 的校验与错误信息
- `app/validators/line_code_validator.rb` —— line_code 格式正则
- `lib/gitlab/diff/position.rb` —— `line_code` / `complete?` / `file_hash` 的计算
- `lib/api/discussions.rb`、`lib/api/helpers/notes_helpers.rb` —— 创建 diff note 的错误返回路径
- `lib/api/entities/note.rb` —— REST 实际暴露的 note 字段
- `app/services/discussions/update_diff_position_service.rb` —— outdated 追踪与自动 resolve
- `lib/gitlab/hook_data/note_builder.rb` —— Note webhook 载荷的完整字段白名单
- `app/workers/web_hook_worker.rb` —— webhook 投递的重试配置
