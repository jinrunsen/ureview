# Issue tracker: Workspace 需求树

<!-- 由 /feature-brainstorm 开张需求树时写入 workspace 仓库的 docs/agents/issue-tracker.md。
     wayfinder、to-spec、to-tickets、triage 等 skill 按本文档决定产物落点——
     它们读的是 tracker 配置，不需要认识需求树。树的完整约定见 feature-brainstorm 的 requirements-tree.md。 -->

本仓库是 workspace 仓库：issues 与 specs 以 markdown 文件住在 `requirements/` 需求树里。

## Effort 目录：两层

所有图、票、spec 都落在**当前 effort 的目录**内。effort 目录按正在为哪一层工作来定：

| 正在做什么 | effort 目录 |
|---|---|
| 为一条大需求勾轮廓、建图（feature-brainstorm） | `requirements/NN-<feature-slug>/` |
| 详析一条拆解后的 story（建图或对谈） | `requirements/NN-<feature-slug>/NN-<story-slug>/` |

story 目录由 `/to-story` 拆分时建出，里面已有 `story.md` 卡片——详析哪条 story，effort 目录就是它。与需求树无关的独立 effort 才退回 `.scratch/<effort>/`。

## Conventions

- story 的 spec 是 `<effort>/spec.md`
- 实现工单一票一文件：`<effort>/tickets/<NN>-<slug>.md`，从 `01` 起编号——绝不合并成单个文件
- `tickets/` 与 `issues/` 刻意分开：`issues/` 装决策票（wayfinder 的图、回流票），`tickets/` 装实现工单。两者都从 `01` 编号，同目录会撞号；而且「还有几张票没解」与「还有几个工单没做」是两个不同的问题
- 其它 skill 的产物同落 effort 目录（如 to-design 的 `design.md`，就在 `spec.md` 旁边）
- Triage 状态记在文件顶部的 `Status:` 行（角色词见 `triage-labels.md`）
- 评论与对话历史追加到文件底部 `## Comments` 之下

## When a skill says "publish to the issue tracker"

在当前 effort 目录内落文件：spec 落 `spec.md`，实现工单落 `tickets/`，wayfinder 的决策票落 `issues/`。目录不存在时不要自己建——大需求目录由 feature-brainstorm 开张，story 目录由 to-story 拆分建出；都找不到说明走错了层，先回上游。

## When a skill says "fetch the relevant ticket"

按引用路径读文件。用户通常直接给路径或编号。

## Wayfinding operations

Used by the `wayfinder` skill. The **map** is a file with one **child** file per ticket.

- **Map**: `<effort>/map.md` —— Notes / Decisions-so-far / Fog 正文。
- **Child ticket**: `<effort>/issues/NN-<slug>.md`，从 `01` 起编号，正文即问题。`Type:` 行记票型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记 `claimed`/`resolved`。
- **Blocking**: 文件顶部 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 即解除阻塞。
- **Frontier**: 扫 `<effort>/issues/` 里开放、无阻塞、未认领的文件；编号最小者优先。
- **Claim**: 动手前先置 `Status: claimed` 并保存。
- **Resolve**: 答案追加在 `## Answer` 之下，置 `Status: resolved`，再把一行摘要与链接追加到 `map.md` 的 Decisions-so-far。
