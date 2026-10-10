# AGENTS.md

uReview 是一个开源的 AI code review 工作台：PR 进来，产出一份结构化评审，人在同一个地方读、下钻、处置、讨论。**对代码平台只读，一个写方法都没有。**

动 `packages/` 之前先读 [docs/architecture.md](docs/architecture.md)；写代码遵守 [CONTRIBUTING.md](CONTRIBUTING.md)；领域词汇以 [docs/glossary.md](docs/glossary.md) 为准；测试策略见 [docs/testing.md](docs/testing.md)。

## 仓库布局

```
packages/
  server/      TypeScript 服务：HTTP 接口、评审流水线、PostgreSQL
    src/         源码；*.test.ts 与源码同放
    migrations/  schema 迁移，按文件名升序执行
features/      中文 Gherkin 场景，分 @layer:api 与 @layer:e2e 两条接缝
requirements/  需求树：一条大需求一棵子树（图、决策票、story map、story），约定见 docs/agents/issue-tracker.md
.agents/
  notes/       Agent Notes：决策与提案，路径编码 {生命周期}/{类别}/日期-标题.md
  skills/      仓库自带的技能。`.claude/skills` 是指向这里的软链
docs/
  architecture.md    产品与架构，开工的权威来源
  testing.md         两条接缝、打桩边界、场景与工单的对应
  glossary.md        领域词汇
  research/          一手调研与真实产品素材
scripts/       闸门
.scratch/      在飞的工作与用完即弃的分析。确认之后的结论迁进上面的永久位置
```

## 命令

```sh
npm install
npm run typecheck   # 覆盖测试文件在内的全部源码
npm run build       # 只编译要发布的部分
npm test            # 单元测试，需要数据库开着
npm run check       # 仓库级闸门
docker compose up -d        # 起服务与数据库
docker compose up db -d     # 只起数据库，跑测试用
scripts/deploy/staging.sh     # 当前提交部署到预发
scripts/deploy/production.sh  # 预发验证过的提交部署到生产
```

测试连真 PostgreSQL。迁移器要处理事务、顺序与重复执行，打桩的执行器测不出来。

## 约定

- **代码一律英文，文档和注释用中文。** 判据是这个名字会不会离开代码库（[全文](CONTRIBUTING.md#语言)）。
- **只读代码平台，端口零写方法。** 不发评论、不改 PR 描述、不推合并状态。这条由 `features/read-only-boundary.feature` 锁住，改端口前先读它。
- **PostgreSQL 单库承载一切**，包括任务队列（`SKIP LOCKED`）。不引入 Redis。
- **代码工作副本必须挂真实卷**，不能是容器内临时层：代码检索会 spawn 外部进程直接读盘，绕过运行时自己的文件系统抽象。
- **只碰 dsh 文档列出的公开扩展点**，一行 patch 内部代码的事都不做。评审会话结束后释放；规范对话按[会话持久化边界](docs/architecture.md#会话持久化边界)保存和恢复。
- **`.feature` 不测 AI 判得准不准。** 测试里 LLM 是打桩的，场景测的是流水线接线、数据正确性、状态流转、降级路径。
- **两条接缝，分工不许重叠**：`@layer:api` 管数据正确性与状态流转，`@layer:e2e` 只管 API 层断言不了的交互与降级展示。一条场景如果 API 层断言得了，就不进 e2e。
- **finding 的五个状态里人只碰两个**：采纳（`Resolved`）、驳回（`Dismissed`，带理由）。`Pending` / `Ignored` / `Outdated` 由系统判定，不提供人工设置入口。
- **功能与修复先过预发，再上生产。** 工单改动了用户能看到或用到的行为，标为完成前部署到预发，从前端走一遍主流程，看样式与使用体验，记录写进工单；生产只部署预发验证过的提交。测试里的桩和小样本测不出真实规模与真实模型下的问题。做法与记录格式见[预发验证](docs/testing.md#预发验证)，`npm run check` 检查记录。
- **场景与工单一一对应。** 每条场景恰好被一张工单认领，`npm run check` 机械校验，不靠谁记得。
- **非平凡的改动必须在同一次提交里带一条 Agent Note**（[什么时候写](.agents/notes/README.md#什么时候写)）。归档的笔记是冻结的：不改、不当作现状的依据。
- **v1.0 之前不保证 schema 迁移，v1.0 起承诺** `docker compose pull` 加重启、数据不丢。
- 文案用朴素写法：陈述功能，不用对比句式和推销腔。

## 仓库自带的技能

八个，都在 [.agents/skills/](.agents/skills/)。**全部设为模型不可直接调用**，只有人显式调用才会加载——它们是工作流，不是背景知识，自动触发只会把不相干的长文塞进上下文。

| 技能 | 什么时候用 |
|---|---|
| `ureview-pre-push-checks` | 推送、改完一张工单、或者要说「检查都过了」之前 |
| `ureview-code-review` | 评审改动，需要先被定位到这个仓库的标准 |
| `ureview-archive-agent-notes` | 新增、审查、精简、归档 Agent Note |
| `ureview-doc` | 决定一份内容属于哪个位置，或从 `.scratch` 往外迁 |
| `ureview-prose-standard` | 写、评审、精简散文，判断哪里该写多少 |
| `ureview-trim-cot-leakage` | 清掉读起来像推理过程泄漏的散文 |
| `ureview-find-simplifications` | 找可以删掉的面积 |
| `ureview-test-reliability` | 设计或诊断会非确定性失败的测试 |

## .scratch 是什么

**在飞的工作与用完即弃的分析。** 里面现在有：wayfinder 的地图、26 张实现工单、9 张调研票、原型 HTML。

**它不是永久位置。** 一件事确认下来之后，结论迁进对应的永久位置——决策进 [.agents/notes/](.agents/notes/README.md)，架构进 [docs/architecture.md](docs/architecture.md)，一手材料进 [docs/research/](docs/research/)。工单做完，它期间做的非平凡决策写成 `implemented/` 的 Agent Note。

`.scratch` 里的东西可以被清掉；永久位置里的不行。所以**永久文档不该依赖 `.scratch` 里的路径**——目前只有少数几处指向原型 HTML 和一张未决的任务票，那些是已知的例外。

## 改这份文件

`CLAUDE.md` 是 `AGENTS.md` 的软链，改真身那份。每条规则要能独立成立，高层内容用链接指过去，不在这里展开。
