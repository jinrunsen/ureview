# 仓库机制

这个仓库的约束与文档机制**复用 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的那一套**，包括目录名与文件名。下面逐项列出每个位置装什么、由什么管。

dsh 有而这里没有的，在最后一节，带没有的理由。

## 给 agent 的指令

| 路径 | 装什么 |
|---|---|
| `AGENTS.md` | 入口。布局、命令、约定、决策记在哪。每条规则独立成立，高层内容用链接指出去 |
| `CLAUDE.md` | → `AGENTS.md` 的软链。改真身那份 |
| `docs/AGENTS.md` + `docs/CLAUDE.md` | 文档树的四条规则：一件事一个家、写现状不写过程、存量事实带 `source:`、`research/` 只增不改 |
| `.agents/notes/AGENTS.md` + `CLAUDE.md` | 笔记树的三条：`archived/` 冻结、类别是闭集、互相引用用相对链接 |
| `.claude/rules/feature-writing.md` | 按路径自动加载：改 `.feature` 时生效的四条铁律 |
| `.agents/skills/` | 八个仓库自带的技能，**全部模型不可直接调用**。`.claude/skills` 是指向这里的软链 |
| `.claude/hooks/lint-feature.sh` | 场景文件的结构校验，`pre-commit` 与手动都能跑 |

## 决策记录

| 路径 | 装什么 |
|---|---|
| `.agents/notes/README.md` | 放在哪、什么时候写、格式是什么、怎么归档 |
| `.agents/notes/proposed/{类别}/` | 决策已做出、还没建成。**现有 16 条** |
| `.agents/notes/implemented/{类别}/` | 决策已落地，与实际建成的东西保持一致 |
| `.agents/notes/rejected/{类别}/` | 考虑过并否掉的。**现有 6 条** |
| `.agents/notes/archived/{类别}/` | 冻结树。移进去就不许改、不许当作现状的依据 |

路径编码 `{生命周期}/{类别}/yyyy-mm-dd-topic-title.md`。类别是闭集：`feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`，定义在 `scripts/agent-note-tree.ts`。

**不建集中式 `INDEX.md`**——目录树本身就是清单，多一份索引就多一处会漂移的东西。

> 2026-09-21 从 wayfinder 迁过来的 22 条，把「考虑过什么、为什么否掉」写在 `## Decision` 段里，没有单独分节。那是它们原本的形态，迁移时没拆以免改坏内容。新写的笔记三段齐全。

## 文档

| 路径 | 装什么 |
|---|---|
| `docs/architecture.md` | 产品与架构，开工的权威来源。动 `packages/` 之前读它 |
| `docs/testing.md` | 两条接缝、打桩边界、场景与工单的对应、装不进 `.feature` 的验收判据 |
| `docs/glossary.md` | 领域词汇。规格、场景、工单、代码共用一套词 |
| `CONTEXT.md` | → `docs/glossary.md` 的软链。`/tdd` 按这个名字找上下文 |
| `docs/research/` | 一手调研与真实产品素材，**只增不改**。它们是被引用的证据，结论属于引用它们的文档 |
| `docs/repo-mechanisms.md` | 这份文件 |
| `README.md` | 起停、数据落在哪、怎么开发 |
| `CONTRIBUTING.md` | 语言约定与判据、场景文件的铁律入口、提交前跑什么 |

## 闸门

| 路径 | 查什么 |
|---|---|
| `scripts/agent-note-tree.ts` | 类别与生命周期的闭集，闸门认这个常量 |
| `scripts/verify-agent-notes.ts` | 路径编码与文件头：目录合法、文件名格式、`Status:` 与所在目录一致、归档的带 `Archived:` |
| `scripts/verify-scenario-coverage.ts` | 每条场景恰好被一张工单认领：不缺、不重、不错名 |
| `lefthook.yml` | `pre-commit` 跑场景结构、笔记校验、行尾空白；`pre-push` 跑类型检查与仓库闸门 |

`npm run check` 串起两个闸门。**场景认领那个闸门的失败路径验过两条**：往被「全部场景」认领的 feature 里偷加一条会被场景数比对抓到；工单里写错场景名会被点名。第一版只查认领关系，偷加场景检测不出来——那个选择器会自动吸收新场景，等于在最可能发生的漂移上静默放行。

## 构建与工具

| 路径 | 作用 |
|---|---|
| `package.json` | npm workspaces。这台机器上 pnpm 的 corepack 缓存是坏的 |
| `tsconfig.base.json` | 共享的编译选项，`strict` 加 `noUnusedLocals` / `noUnusedParameters` |
| `packages/server/tsconfig.json` | typecheck 用，**覆盖测试文件** |
| `packages/server/tsconfig.build.json` | build 用，排除测试文件 |
| `vitest.config.ts` | 单元测试。场景测试走 cucumber，是另一套（工单 02） |
| `.editorconfig` / `.gitattributes` | 缩进与行尾，避免 diff 里全是噪声 |
| `docker-compose.yml` / `packages/server/Dockerfile` | 一条命令起服务与数据库 |

两份 tsconfig 分开是有代价换来的：合成一份时 typecheck 把测试文件排除在外，等于一半代码从没被检查过。

## .scratch/

**在飞的工作与用完即弃的分析。不是永久位置，里面的东西可以被清掉。**

| 路径 | 装什么 |
|---|---|
| `.scratch/ureview/map.md` | wayfinder 地图 |
| `.scratch/ureview/tickets/` | 26 张实现工单，带阻塞边构成 DAG |
| `.scratch/ureview/issues/` | 9 张调研票（产出已进 `docs/research/`）、1 张未决任务票、2 个探测脚本 |
| `.scratch/ureview/assets/` | 原型 HTML。按定义就是用完即弃的 |

一件事确认下来之后，结论迁进永久位置：决策进 `.agents/notes/`，架构进 `docs/architecture.md`，一手材料进 `docs/research/`。工单做完，它期间做的非平凡决策写成 `implemented/` 的 Agent Note。

**永久文档不该依赖 `.scratch` 里的路径。** 目前只剩少数几处指向原型 HTML 和一张未决的任务票，是已知的例外。

## dsh 有而这里没有的

| dsh | 为什么这里没有 |
|---|---|
| `README.zh.md` / `*.i18n.yaml` 双语三件套 | 这里是中文单语。翻译是持续成本 |
| `vendor/` | 依赖 dsh 的方式是**跑完即抛的 ACP 会话**，不 vendor 它的源码。这是架构上刻意的解耦 |
| `.github/workflows/`、`pull_request_template.md`、`dependabot.yml` | **还没有远端。** 工单 02 的验收里留了口子：「有一条命令能对 `features/` 全量跑一遍」，那条命令就是将来 CI 的内容 |
| `docs/cookbook/`、`docs/postmortem/`、`docs/subsystems/` | 还没有可供照抄的既有实现，也还没出过需要复盘的事 |
| `docs/defensive-patterns.md` | 还没有生命周期、并发、子进程、拆卸这些代码。接 dsh（工单 04）与队列（工单 06）之后会有 |
| `.oxlintrc.json`、`.jscpd.json` | 见下 |
| `LICENSE`、`THIRD_PARTY_NOTICES.md`、`SAFETY.md` | 见下 |
| `BENCHMARK.md` | 评估基线是第二批工作（[评估基线](../.agents/notes/proposed/testing/2026-09-12-evaluation-baseline-benchmark.md)）。建的时候名字沿用 |
| `native/`、`python/`、`apps/`、`website/` | 没有原生扩展、Python SDK、多应用或文档站 |

## 两件待定

**`LICENSE` 还没有。** 这是开源产品，没有 LICENSE 意味着默认保留所有权利——别人不能合法使用、修改或分发它。选哪个是产品决定不是技术决定。参照：同赛道的 OpenReview 至今没有 LICENSE 且 `"private": true`，等于不是真开源。

**要不要加 linter。** 现在靠 `strict` 加 `noUnusedLocals` / `noUnusedParameters`。它们抓得到没用到的变量，抓不到**没 await 的 Promise**——在一个到处是数据库和子进程调用的服务里，漏掉的 await 是真会出事的。oxlint 一个配置文件就能跑。
