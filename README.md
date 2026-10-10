# uReview

一个开源的 AI code review 工作台。

PR 进来，系统产出一份评审：一份解读讲清这个 PR 改了什么、改动前后怎么工作，一组 finding 按严重度排列。人从解读读起，需要时下钻到 diff，对每条结论标注采纳或驳回。处置被记录下来，用于计算评审覆盖率与采纳率。

对代码平台只读：不回写评论，不推送合并状态。

- 架构：[`docs/architecture.md`](docs/architecture.md)
- 测试策略：[`docs/testing.md`](docs/testing.md)
- 安装、升级与备份恢复：[`docs/operations.md`](docs/operations.md)
- 领域词汇：[`docs/glossary.md`](docs/glossary.md)
- 决策记录：[`.agents/notes/`](.agents/notes/README.md)
- 交付计划与实现工单：[`requirements/01-v1-qodo-reproduction/story-map.md`](requirements/01-v1-qodo-reproduction/story-map.md)
- 行为场景：[`features/`](features)

当前支持 GitLab 仓库接入、输入 PR 链接发起评审、自动评审与手动重跑、Git 规范参与评审、PR 解读、finding 下钻到代码，以及历史轮次和筛选分页列表。支持用户名账号、团队隔离、finding 讨论与未读提醒、规范目录和历史候选。finding 处置属于后续交付。

## 起

```
docker compose up -d
```

一条命令起两个容器：PostgreSQL 和服务本身。服务会等数据库健康之后再启动，启动时自动执行待执行的 schema 迁移。

首次打开 http://localhost:3000，使用服务器的初始化码创建管理员账号：

```sh
docker compose exec server cat /srv/blobs/setup-token
```

初始化码只在尚无账号时有效。登录后可在右上角姓名入口管理成员和团队；成员只能看到所属团队的数据。通过反向代理或其他主机名访问时，将 `UREVIEW_PUBLIC_ORIGIN` 设为浏览器实际访问的来源（例如 `https://review.example.com`）。

工作台侧栏提供概览、评审、仓库、团队规范、成员与团队、设置六个入口。概览展示团队的评审总数、近期评审与规范概况；页头可切换团队、打开未读讨论或手动发起评审。

管理员在「仓库 → 接入仓库」中填写 GitLab 实例地址、项目路径或数字 ID，以及只勾选 `read_api`、`read_repository` 的个人访问令牌（PAT，含服务账号 PAT）。服务验证 API 与 Git 读取后保存仓库；重复接入保留已有凭据。

确认服务健康：

```
curl http://localhost:3000/health
```

连得上数据库时返回 `{"status":"ok","database":"ok"}`；连不上时返回 503 并把 `database` 标成 `error`。健康检查会真的查一次库，不是无脑返回 200。

看日志：

```
docker compose logs -f server
```

## 停

```
docker compose down
```

这样停不会动数据，下次 `up` 起来还是原样。

要连数据一起清掉：

```
docker compose down -v
```

## 数据落在哪

三个具名卷，都不是容器内临时层：

| 卷 | 挂在 | 装什么 |
|---|---|---|
| `ureview_pgdata` | `/var/lib/postgresql/data` | PostgreSQL 的全部数据，包括评审队列 |
| `ureview_worktrees` | `/srv/worktrees` | 代码工作副本 |
| `ureview_blobs` | `/srv/blobs` | 对象存储与凭据密钥文件 `credentials.key` |

`ureview_worktrees` 必须是真实卷：代码检索会 spawn 外部进程直接读盘，绕过运行时自己的文件系统抽象，挂成容器内临时层就检索不了。

令牌加密存入 PostgreSQL，密钥首次启动生成并留在 `ureview_blobs` 卷。备份需要同时保留数据库与密钥；已有凭据时密钥丢失或损坏会阻止启动。

队列也在 PostgreSQL 里，不引入 Redis。

## 开发

建议使用 Node 24；最低支持 Node 22.19。还需要 Git。

```
npm install
npm run typecheck
npm run build
```

跑测试**需要数据库开着**——迁移器的测试连的是真 PostgreSQL，每个用例建一个一次性数据库、用完就丢。打桩的执行器测不出事务和顺序问题。

```
docker compose up db -d
npm test
npm run test:api
```

测试默认连 `postgres://ureview:ureview@localhost:5432/postgres`，可以用 `TEST_DATABASE_URL` 换掉。

### 已有单人版数据库升级

等待正在运行的评审结束，再把现有表的所有权交给受 RLS 约束的应用角色。此脚本保留表与记录：

```sh
docker compose stop server
docker compose exec -T db sh < scripts/init-application-db.sh
docker compose up -d --build --no-deps server
```

新安装由 PostgreSQL 初始化脚本创建 `ureview_app`；服务与迁移共用这个非超级用户、无 `BYPASSRLS` 的角色。旧仓库和评审归入默认团队。测试继续使用能建立临时数据库的开发账号。

### 迁移

迁移是 `packages/server/migrations/` 下的 `.sql` 文件，按文件名升序执行。一个文件加它的执行记录是一笔事务，失败就整笔回滚，报错会点名是哪个文件。已执行的记在 `schema_migrations` 表里，不会重复执行。

一个文件加它的执行记录之外，整个迁移过程持有一把 PostgreSQL 咨询锁——后面会有 worker 进程和服务同时启动，没有锁的话同一个文件会被执行两遍。

服务启动时自动迁移。也可以单独跑：

```
npm run migrate
```

v1.0 之前不保证迁移的向后兼容；v1.0 起承诺 `docker compose pull` 加重启、数据不丢。

### 配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | 非超级用户、无 BYPASSRLS 的 PostgreSQL 连接串 |
| `UREVIEW_PUBLIC_ORIGIN` | 否 | 浏览器访问来源，默认 `http://localhost:3000`；HTTPS 来源启用 Secure Cookie |
| `UREVIEW_DATABASE_PASSWORD` | 否 | Compose 应用角色口令；自定义时使用 URL 安全字符，并在角色初始化时设置相同值 |
| `UREVIEW_WORKTREE_DIR` | 是 | 代码工作副本目录 |
| `UREVIEW_BLOB_DIR` | 否 | 对象存储目录，默认 `/srv/blobs` |
| `UREVIEW_CREDENTIAL_KEY_FILE` | 否 | 凭据密钥路径，默认 `<UREVIEW_BLOB_DIR>/credentials.key` |
| `UREVIEW_RUNTIME_HOME` | 否 | dsh profile 目录，默认 `<UREVIEW_BLOB_DIR>/runtime` |
| `UREVIEW_WEBHOOK_TOKEN` | 自动评审时 | 与 GitLab webhook Secret token 相同 |
| `UREVIEW_GLOBAL_RULES_REPOSITORY_ID` | 否 | 全局规范所在的已接入仓库 ID，读取默认分支的 `.ureview/global-rules.json` |
| `PORT` | 否 | HTTP 端口，默认 3000 |

必填项缺失或配置无效时，服务启动失败。模型配置全部缺省时仍可接入仓库；执行评审需要完成以下配置。

Generator 与 Grader 各配置一组环境变量，分别将下表的 `{PHASE}` 替换为 `GENERATOR` 和 `GRADER`。Compose 从运行环境或项目的本地 `.env` 接收这些值，不要将密钥提交进 Git。

| 变量 | 内容 |
|---|---|
| `UREVIEW_{PHASE}_VENDOR` | 真实模型厂商，默认要求两组不同 |
| `UREVIEW_{PHASE}_PROVIDER` | 自定义路由名称，两组使用不同名称 |
| `UREVIEW_{PHASE}_MODEL` | 服务商提供的模型 ID |
| `UREVIEW_{PHASE}_API` | `anthropic-messages`、`openai-completions` 或 `openai-responses` |
| `UREVIEW_{PHASE}_BASE_URL` | 模型服务 API 基址 |
| `UREVIEW_{PHASE}_API_KEY` | 模型服务密钥 |

同厂商部署需显式设置 `UREVIEW_ALLOW_SAME_VENDOR=true`，例如用 DeepSeek Flash 产出、DeepSeek Pro 评分。两个 `VENDOR` 均填写 `deepseek`，`PROVIDER` 仍使用不同名称。该设置接受同厂商评分可能产生的偏好，默认关闭。

配置后运行 `docker compose up -d --build server`。在首页或评审列表的「发起评审」中粘贴已接入仓库的 GitLab MR 链接，例如 `https://gitlab.com/group/project/-/merge_requests/1`，点击「开始评审」。服务读取 PR 当前提交并打开新一轮评审；首次评审也可以从这里发起，无需先配置 webhook。未接入的仓库会提示先接入。

需要自动评审时，在仓库评审列表找到 webhook URL，由 GitLab 管理员添加到项目 Webhooks，勾选 Merge request events，并填写部署时设置的 Secret token。uReview 不自动修改 GitLab 配置。

GitLab diff 尚未准备好时会等待；多次读取后仍不可用则标为失败。截断、二进制、只有重命名或文件模式变化而无文本 patch 的差异暂不支持，会明确报错。当前没有任务崩溃恢复。

### 阅读与重跑

导航中的评审列表展示每个 PR 最新一轮，支持按仓库、评审状态筛选和翻页。“还没人看过”在有人打开已完成结果后更新；计数包括被默认五条上限折叠的中高危 finding。

评审页先展示解读，再展示按严重度分组的结论。点击高危 finding 的代码入口可查看本轮保存的 diff 与行内结论，返回后保留阅读位置。中危在问题列表中阅读，低危不展示。页面可以切换历史轮次，也可以手动重跑；新的轮次重新读取当前 PR 与规范，旧结果保留。

### 评审规范

在「团队规范 → 生成新规则」中描述意图，AI 会起草名称、正文、正确与错误示例。管理员可编辑分类、严重级别和作用范围，选择「保存草稿」或「保存并启用」。规则保存在数据库；支持当前团队全部仓库，或多个指定仓库及各自的路径模式。路径留空表示整个仓库。已保存规则可继续编辑或停用。

规则严重级别决定违规结论的处理优先级：错误对应高危，警告对应中危，建议对应低危。低危默认不展示；其他结论仍需通过质量评分。启用或修改影响后续评审，历史评审保留原规则版本。代码平台仍为只读。


仓库规范放在 PR 对应提交中的 `.agents/rules/**/*.md`。例如 `.agents/rules/payment.md`：

```markdown
---
name: 金额格式
paths:
  - internal/payment/**/*.go
---
金额禁止使用浮点数，一律用整数分。
```

模型成功读取文件或检索到代码行后，服务从该文件所在目录向仓库根逐层查找 `.agents/rules/`，按 `paths` 注入适用正文。子目录可以放自己的规则目录；glob 相对于该层目录。`paths` 缺失或为空时不自动注入，`name`、`description` 可选。仓库规范格式有误会告警并跳过，评审继续执行。仓根的 `.sase-rule-inject.json` 可配置规则目录、注入预算与刷新窗口。

仓库 lint 与规则分目录存放，布局与 `sase-dev` 的规则注入和 `sase-core` 的 lint 注册机制一致：

```text
.agents/rules/**/*.md   # 语义规则，按 paths 注入
.agents/lints/*.mjs     # lint 注册文件，只扫描直属文件
```

子包也可放置这两个目录，路径条件相对该子包。例如 `.agents/lints/no-debug.mjs`：

```js
export const meta = {
  name: 'no-debug',
  description: '生产代码限制调试日志',
  paths: ['src/**/*.ts'],
  script: '../../scripts/no-debug.mjs',
  args: ['--check'],
};
```

`meta` 必须是纯字面量；`script` 相对注册文件，省略时指向自身。在「团队规范 → Lint」查看同步结果、路径条件、脚本与来源提交。uReview 只读取检查配置，不执行仓库 lint，也不将脚本计入已注入规范或检查结果。无效注册文件会在同步记录中显示告警。

全局规范使用 JSON。先接入存放全局规范的 GitLab 仓库，将其 uReview 仓库 ID（仓库评审页地址中的 `repository` 参数）填入 `UREVIEW_GLOBAL_RULES_REPOSITORY_ID`，在该仓库默认分支提交 `.ureview/global-rules.json`，再重启服务：

```json
{
  "groups": [{
    "languages": ["go"],
    "paths": ["internal/payment/**"],
    "rules": [{
      "id": "G-001",
      "body": "金额禁止使用浮点数，一律用整数分。",
      "source": { "kind": "manual" }
    }]
  }]
}
```

全局规范在评审前按变更文件的语言和路径筛选，提供给产出与评分模型。全局文件读取失败、格式错误或重复 ID 会使评审失败。仓库规范的 ID 由文件路径生成，例如 `repository:.agents/rules/payment.md`。

没有适用规范时可以运行通用代码评审。每轮保存实际注入规范的完整正文、提交来源与匹配路径；预算不足而只展示索引的规则不能作为 finding 的规范依据。旧评审保留旧版本。完整格式与筛选规则见 [Story 03 规格](requirements/01-v1-qodo-reproduction/03-review-with-repository-rules/spec.md)。

### 场景

`features/` 下是行为场景，用中文 Gherkin 写。改动前先看 [`.claude/rules/feature-writing.md`](.claude/rules/feature-writing.md)。校验结构：

```
sh .claude/hooks/lint-feature.sh features/findings.feature
```

`npm run test:api` 运行已实现 story 的 API 场景。接入场景使用真实 HTTP 和独立 PostgreSQL，接入适配器打桩；评审场景还运行正式 dsh profile、真实 Git 工作副本和文件工具，只打桩 GitLab 协议与模型 HTTP 响应。浏览器下钻交互独立验收，其余场景按后续范围实现。

## 团队协作与规范

每条 finding 下可发起讨论、回复和 @ 团队成员。被提及和被回复的人通过页头未读提示回到对应讨论；已完成评审可标记「这次评审我看完了」。GitLab 历史人工讨论只读展示，失败时仍可使用站内讨论。管理员在「设置 → 通知」中配置公网 HTTPS 通知出口；投递失败最多尝试四次，不影响评论保存。

「规范」页汇总已启用的数据库规则与从 Git 默认分支同步的目录；「待启用」页包含数据库草稿与历史候选。Git 规则展示命中、采纳、被无视统计。目录每五分钟刷新，新仓库会启动历史扫描；候选首轮最多十条，随后每十四天最多新增五条。候选须在至少两个 PR 重现，并有作者落实结构化建议的代码证据；缺少公开作者邮箱或精确前后代码时跳过。候选可复制为 Markdown，手工提交到 Git 后重新同步可显示生效。工作台不编辑或提交规范文件。
