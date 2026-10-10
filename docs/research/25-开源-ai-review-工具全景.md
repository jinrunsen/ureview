# 开源 AI code review 工具全景

- **调研时间**：2026-09-12
- **对应 ticket**：[`../issues/25-开源定位-相对-pr-agent-与-openreview-的差异化.md`](../../.agents/notes/proposed/feature/2026-09-12-open-source-positioning.md)
- **数据抓取时间**：2026-09-11 17:35 – 18:30 UTC（北京时间 2026-09-12 01:35 – 02:30），全部通过 `gh api` 实时取数
- **方法优先级**：`gh api`（star / contributor / commit 时间 / issue 统计 / 源码文件树 / 代码搜索）> 仓库内 README 与源码 > 官方文档 > 营销页（本文凡引用营销页处都标注了「营销页」）

> 关于数据可得性的一处说明：本环境下 GitHub 的 stargazers 列表接口（REST 与 GraphQL 的 `stargazers.edges`）对所有仓库均返回 404 / 空，**逐星标时间戳的增长曲线取不到**。因此「近一年 star 增长」改用三个可取到的客观代理指标刻画：仓库 `created_at`（决定了增长只能发生在多长的窗口里）、`stats/participation` 的 52 周周提交曲线、以及 release 节奏。这三个指标合起来足以判断一个项目是在涨还是在死，但给不出精确的 star 曲线，下文凡涉及增长处都写明了是代理指标。

---

## 0. 三句话结论

1. **ticket 里的竞品设定已经过期了。** PR-Agent 在 2026 年 2 月被 Qodo **捐给了社区**，现在是 `The-PR-Agent/pr-agent`，近三月 464 次提交、122 位不同作者，是它历史上最活跃的时期——它不再是那个「被商业公司放着不管的引流壳」。顺带一个很能说明问题的细节：这 122 个人七个月里加了 `AGENTS.md` 注入、跨轮次 finding 状态、skills 加载、评论去重，**但没有一个人去填 `best_practices` 那个硬编码的空串**。OpenReview 那边则连 license 都没有，从来就不是一个产品。
2. **赛道里出现了一个 ticket 完全没提到的头号玩家**：`alibaba/open-code-review`，2026-05-18 才开源，四个月 22312 star、154 位贡献者、Apache-2.0，而且它的架构（确定性工程 × Agent 混合、文件成组分治、规则模板匹配、独立定位与反思模块、精度优先于召回、自带 1505 条标注的 benchmark）**几乎逐条命中了 uReview 打算做的差异化**。这是本次调研最重要的发现。
3. **「规范管理」在开源侧确实是空白，但在商业侧已经被占满了**：CodeRabbit 的 `@coderabbitai emit path instructions` 已经能把学到的规则自动开 PR 并回配置文件，Cursor BugBot 有 `@cursor remember` 行内教学与 learned rules，GitHub Copilot 有 `.github/instructions/**/*.instructions.md` 路径定向指令（公开仓库里带 `applyTo` 的此类文件已有 **56064** 个）。空位存在，但窗口在收窄，而且不在「有没有规则」这一层，在「规则的生命周期」这一层。

---

## 一、已知两家的真实健康度

### 1.1 PR-Agent：它已经不是 Qodo 的项目了

`Codium-ai/pr-agent` 与 `qodo-ai/pr-agent` 现在都 301 重定向到 **`The-PR-Agent/pr-agent`**。这不是简单改名。README 末尾的「Big News for PR-Agent」原文：

> After years of building this tool alongside the community, Qodo has donated PR-Agent to the open-source community... The project now lives in the PR-Agent org on GitHub, is fully community-owned, and is open for contributions and additional maintainers.
>
> The project now has its first external maintainer, Naor ([@naorpeled](https://github.com/naorpeled)), and is currently in the process of being donated to an open-source foundation.

时间线（全部来自 API）：

| 时间 | 事件 | 依据 |
|---|---|---|
| 2024-08-12 | Qodo 核心 `okotek` 最后一次提交 | `commits?author=okotek` |
| 2025-06-21 → 2025-11-06 | **近五个月没有任何 release**（v0.30 → v0.31） | releases 列表 |
| 2025-09-17 | Qodo 首席 `mrT23`（2735 次提交，历史第一）最后一次提交 | `commits?author=mrT23` |
| 2025-12-10 | Qodo 的 `hussam789` 最后一次提交 | 同上 |
| **2026-02-26** | **`The-PR-Agent` 组织创建** | `orgs/The-PR-Agent.created_at` |
| 2026-02-22 起 | release 节奏恢复：7 个月发了 14 个版本 | releases 列表 |
| 2026-09-05 | v0.45.0 | 同上 |
| 2026-09-11 | 最近一次提交（`binyangzhu000-sudo`，docs） | `commits?per_page=1` |

**周提交曲线（`stats/participation`，最后一个数是本周）**：

```
16 6 0 4 24 21 4 8 1 8 3 1 1 8 0 2 17 2 4 2 3 4 2 18 1 8 7 9 3 0 2 11 0 17 19 3 4 22 8 4 20 10 19 3 6 25 15 9 32 76 92 134
```

前 40 周基本在个位数到二十几之间摇摆，最后四周是 **32 / 76 / 92 / 134**。这不是一个衰退的项目，是一个刚被交到社区手里、正在被集中改造的项目。

**健康度实测**：

| 指标 | 数值 |
|---|---|
| star / fork / watch | 12949 / 1837 / 61 |
| 许可证 / 语言 | MIT / Python |
| 贡献者总数 | 329 |
| 近六月提交 / 不同作者 | 569 / **141** |
| 近三月提交 / 不同作者 | 464 / **122** |
| 近三月新建 issue / 关闭 issue | 318 / 368（关闭多于新建） |
| 近三月新建 PR / 合并 PR | 536 / 457 |
| open issue | 48（其中创建超 30 天的 9 个，零评论 16 个） |
| open PR | 38（创建超 30 天的 7 个，**超 30 天未更新的只有 1 个**） |
| issue 首次他人响应（40 个近三月样本） | 25 个有回复，**中位数 6.6h**，均值 9.7h，p75 16.1h；15 个至今无人回复 |
| 最近一次 release | v0.45.0 @ 2026-09-05 |

近三月提交量最大的四个人是 `dwin-gharibi`(55)、`PeterDaveHello`(49)、`naorpeled`(29)、`junnhwan`(28)——**没有一个是 Qodo 的人**。历史第一贡献者 `mrT23` 的 2735 次提交已经是上一个时代的存量。

**fork 情况**：1837 个 fork，取最新的 203 个，其中 200 个近三月有推送，但**没有任何一个 fork 的 star 数 ≥ 3**。交叉对照近三月的提交作者名单（`oleksii-tumanov`、`MostafaHassanzadeh`、`junnhwan`、`binyangzhu000-sudo` 都同时出现在 fork 列表和提交列表里），可以确认这些 fork 是「为了提 PR 而 fork」，**不存在有影响力的硬分叉**。没人在自己另起炉灶。

**真实采用量（代理指标，GitHub 代码搜索）**：公开仓库的 `.github/workflows` 里

- 引用新名 `the-pr-agent/pr-agent@`：**252** 个文件
- 引用旧名 `Codium-ai/pr-agent@`：**461** 个文件

合计约 713 个公开仓库把它接进了 CI。对 12949 star 而言，star → 真实接入的转化率约 **5.5%**。旧名引用还多于新名，说明迁移刚开始。

#### 架构层面：ticket 里记的硬伤，大部分今天仍然成立

逐条用源码核对（截至 2026-09-11 的 `main`）：

**（a）没有 agent loop —— 成立，且被官方写在配置注释里。** `pr_agent/tools/` 下 15 个文件全是「一条命令 = 一次 LLM 调用」的工具，全仓搜不到 tool-call / agent loop 的任何痕迹。`configuration.toml` 的 `[skills]` 段注释直说：

> PR-Agent supports text-only skills: `scripts/` and `assets/` subdirectories are skipped because **PR-Agent uses a single-shot model call (no tool-use loop)** and cannot execute scripts or load binary assets on demand.

**（a2）压缩仍是「装不下就整个跳过」—— 成立。** `pr_agent/algo/pr_processing.py` 里 `_pack_pr_multi_diffs` 的逻辑：单个 patch 超预算时看 `config.large_patch_policy`，**默认值是 `"skip"`**，直接 `continue` 丢掉整个文件，只在日志里 warn 一句；设成 `"clip"` 才会截断，截断后还超就仍然丢。丢掉的文件最后只以文件名形式出现在 `"Additional modified files (insufficient token budget to process):"` 这个列表里。**PR 越大，模型拿到的实际代码越少，方向确实是反的。**

**（b）`best_practices` 是空壳 —— 成立，而且比想象的更彻底。** 全仓代码搜索 `relevant_best_practices`，`total_count = 1`，唯一一处在 `pr_agent/tools/pr_code_suggestions.py`：

```python
"relevant_best_practices": "",
```

硬编码空串。`configuration.toml` 里的 `[best_practices]`（`content` / `organization_name` / `max_lines_allowed = 800` / `enable_global_best_practices`）和 `[auto_best_practices]`（`max_patterns = 5`）两个配置段**完整存在，但没有任何代码读取它们**。这两段是商业版 Qodo Merge 的配置在开源版里留下的空壳。捐赠给社区之后也没人来填。

**（c）社区新加了 skills，但仍是一坨文本。** `pr_agent/algo/skills_loader.py`（359 行）扫描配置路径下的 `*/SKILL.md`，把正文连同同目录的 `*.md` 资源一起拼成一个 `skills_context` 块注入 prompt，预算 8000 token，`enabled = false` 默认关闭。**没有路径定向，没有渐进加载，没有按文件类型选取**——全量塞进去，超预算就截断。这是「规范即文本」的最朴素实现。

**（c2）社区加了 `AGENTS.md` 支持，而且是默认开的。** `configuration.toml` 第 33 行：

```toml
repo_context_files = ["AGENTS.md"]   # 默认值
repo_context_from_default_branch = true
repo_context_max_lines = 500
```

`pr_agent/algo/repo_context.py`（310 行，社区新增）从仓库默认分支读这些文件，渲染成一段带说明的 markdown 注入 prompt（「You are being given instruction files. Follow them as project-specific guidance when reviewing code.」），带 LRU 缓存（256 项 / 15 分钟 TTL）和 500 行的渲染预算。**但仍然是全量文本注入：没有路径定向，没有按文件类型选取，超预算就按行截断。**

**（c3）社区还加了跨轮次的 finding 状态。** `pr_agent/algo/review_finding_state.py`（"Persist review finding state across runs"）给每条 key issue 算指纹，把状态（`ACTIVE` / `RESOLVED`）以 `<!-- pr-agent-review-state:v1 ... -->` 的 HTML 注释形式埋进评论里，带 schema 版本号，默认保留 20 条已解决的 finding。配合 `inline_comment_dedup.py` 做去重。**这是一个真的 finding 结构化层，ticket 里「PR-Agent 没有 finding 结构化」的记录需要更新——不过它结构化的只有状态，没有严重度、类别、置信度。**

值得记一笔的是**社区七个月里选择做什么**：加了 AGENTS.md 注入、加了跨轮次 finding 状态、加了 skills 加载、加了模型路由、加了评论去重——**但没有人去填 `best_practices` 那个空串**。122 位贡献者路过它而不动，说明在社区的优先级里，「规范管理」不是一个痒点。

**（d）根目录多了个 `pr_compliance_checklist.yaml`。** 5 条通用条目（命名一致性、无死代码、健壮错误处理、函数单一职责、优先早返回），字段是 `title / objective / success_criteria / failure_criteria`。它服务的是 `/compliance` 工具，检查的是「PR 是否符合关联 ticket 的要求」，不是编码规范的治理。另有 `qodo-ai/pr-compliance-templates`（14 star，最后推送 2025-09-14，无 license）提供 17 种语言/技术栈的 `pr_compliance_checklist.yaml` 模板——**这是整个 Qodo 生态里最像「规范库」的东西，但它已经一年没动，且服务的是商业版**。

**（e）默认输出不是行内评论。** `configuration.toml` 里 `pr_reviewer.persistent_comment = true`、`pr_code_suggestions.persistent_comment = true`、而 `pr_reviewer.inline_key_issues = false`。默认形态是**每条命令一条 sticky 汇总评论**，行内评论是可选项。这一点需要修正 ticket 里「PR-Agent、OpenReview、Qodo 全都是行内评论为主」的判断——PR-Agent 开源版本身就不是。

**平台支持**：GitHub、GitLab、Bitbucket、Azure DevOps、Gitea；部署形态 CLI / GitHub Action / Docker / 自托管 webhook。

---

### 1.2 OpenReview：不是「停更」，是从来没打算维护

ticket 里写它是「MIT，已停更」。**MIT 这一条是错的。**

| 事实 | 依据 |
|---|---|
| **没有任何 license** | 仓库根目录列表里无 LICENSE 文件；`package.json` 里 `"private": true`；GitHub API `license: null` |
| 有人提过，无人回 | issue #15「Missing License」，开于 2026-08-13，正文「Repo mentions OSS but there's no license file present.」，**至今零条评论** |

没有 license 意味着默认「保留所有权利」。**任何人拿它的代码去改、去商用，法律上都是没有授权的。** 这比「停更」严重：一个停更的 MIT 项目还能 fork 接管，一个无 license 的项目不能。

其余健康度：

| 指标 | 数值 |
|---|---|
| star / fork / watch | 1677 / 115 / 6 |
| 创建 / 最后一次提交 | 2026-03-02 / **2026-03-06T16:44**（`haydenbleasel`，"Update globals.css"） |
| 贡献者 | **1 人**，77 次提交 |
| release / tag | **0 / 0** |
| 52 周周提交曲线 | 只有第 27、28 周有值（59、18），**其余 50 周全 0** |
| issue + PR 总量 | 16 条（8 open issue、4 open PR、1 closed issue、3 closed PR） |
| 最老的 open issue | #1「Feature Request: GitLab Support」，2026-03-05 开，至今未处理 |
| 挂了半年的 open PR | #7（2026-03-15）、#9（2026-03-27，`docs: add CONTRIBUTING.md`） |
| open 条目中零评论 | 3 条 |
| fork 活跃度 | 117 个 fork，近三月有推送的只有 **11** 个，**无一有 star** |

README 自己交代了性质：

> It was built as an internal project to help the Vercel team test their technologies together. Expect rough edges and breaking changes.

它是 Vercel 用来串联自家技术（Vercel Sandbox、Vercel Workflow、AI SDK、Chat SDK、Streamdown）的演示项目。1677 star 买的是 Vercel 的品牌和那张 mermaid 时序图，不是一个产品承诺。

**上手成本（README 的 Setup 一节，4 步）**：

1. 把这个 Next.js 应用部署到 Vercel
2. 创建 GitHub App：配 webhook URL、4 类 repository 权限（Contents 读写、Issues 读写、Pull requests 读写、Metadata 只读）、订阅 2 类事件、生成私钥与 webhook secret
3. 配 5 个环境变量（`ANTHROPIC_API_KEY`、`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_WEBHOOK_SECRET`），Redis 可选
4. 在目标仓库安装这个 GitHub App

而且**装完还不会自动评审**——必须在 PR 里 `@openreview` 才触发。从零到第一条评论：一次部署 + 一个 GitHub App + 5 个密钥 + 一次手动 @。这是本次调研里上手最重的形态之一。

**输出形态**：行内评论 + GitHub suggestion 块，可以直接改代码并 push 到 PR 分支；用 👍/❤️ 反应来批准建议。**它确实是行内评论为主。**

**平台**：仅 GitHub，且强绑定 Vercel Sandbox + Vercel Workflow。

---

## 二、还有哪些开源的 AI code review 项目

### 2.0 先看赛道的规模与形状

GitHub topic 搜索的原始计数（2026-09-11 抓取）：

| 查询 | 命中 |
|---|---|
| `topic:ai-code-review` | **706** |
| `topic:ai-code-review created:>2026-01-01` | **643（占 91%）** |
| `topic:ai-code-review stars:>=100` | **20** |
| `topic:ai-code-review stars:>=1000` | **4** |
| `topic:code-review topic:ai` | 1481 |
| `topic:code-review topic:llm` | 1688 |
| `topic:code-review topic:ai pushed:<2026-03-12`（半年没动） | 202 |

形状很清楚：**按仓库数算极度拥挤，按有牵引力的项目数算非常稀薄。** 706 个项目里只有 20 个过百星，4 个过千星，而且九成是今年才建的。这个 topic 本身是 2026 年的产物。

（注意 topic 是个不可靠的索引：`The-PR-Agent/pr-agent` 和 `alibaba/open-code-review` 都没打 `ai-code-review` 这个 tag，所以上面的「4 个过千星」并不包含这两个最大的。下文的项目清单是多路搜索合并去重的结果，不依赖单一 topic。）

---

### 2.1 房间里的大象：`alibaba/open-code-review`

**这是 ticket 完全没提到、但必须优先处理的一个。**

| 指标 | 数值 |
|---|---|
| 许可证 / 语言 | **Apache-2.0** / Go |
| star / fork | **22312** / 1663 |
| 创建时间 | **2026-05-18**（不到 4 个月） |
| 最近 release | v1.11.9 @ 2026-09-11（当天） |
| 贡献者总数 | **154** |
| 近三月提交 / 不同作者 | **563 / 149** |
| 头号作者占比 | `lizhengfeng101` 180 / 563 = 32%，长尾很长 |
| 近三月关闭 issue / 合并 PR | 276 / **470** |
| open issue / open PR | 74 / 83（39 条超 30 天，23 条零评论） |
| issue 首次他人响应（40 样本） | 23 个有回复，**中位数 1.3h** |
| 周提交曲线（近 18 周） | 稳定在 20–60 之间，没有断档 |
| 治理 | 有 `GOVERNANCE.md`、五语 `CONTRIBUTING.md`、**OpenSSF Best Practices Gold** 徽章 |

来历（README 自述）：阿里集团内部的官方 AI code review 助手，两年、数万开发者、数百万缺陷，之后孵化开源。

#### 它的核心做法：确定性工程 × Agent 混合

README 里那一节值得逐条抄下来，因为**它和 uReview 打算押的注高度重合**：

> **确定性侧（硬约束，不交给模型）**
> - **精确文件选择** —— 工程逻辑决定哪些文件要评、哪些过滤，保证不漏。
> - **智能文件成组** —— 把相关文件（例如 `message_en.properties` 与 `message_zh.properties`）打成一个 review unit，**每组一个 sub-agent、独立上下文**，分治，在超大变更集上稳定且天然并发。
> - **细粒度规则匹配** —— 按文件特征把评审规则匹配上去，从源头消除信息噪声；明确说「基于模板引擎的规则匹配比纯语言驱动的规则引导更稳定、更可预测」。
> - **外置的定位模块与反思模块** —— 独立的 comment-positioning 与 comment-reflection，系统性提升定位准确率和内容准确率。
>
> **Agent 侧（动态决策）**
> - 场景调优的 prompt 模板与工具集，工具集是从生产环境的 tool-call trace（调用频次分布、单工具重复率、新工具对调用链的影响）里蒸馏出来的。

对照 ticket 里 uReview 的差异化候选清单：

| uReview 的候选 | OCR 的状态 |
|---|---|
| 3. 大变更集的递归拆分 | **已做**（智能文件成组 + sub-agent 隔离上下文 + 并发） |
| 3. 动态规范选取 | **已做**（细粒度规则匹配，按文件特征定向） |
| 2. Generator + Grader | **已做**（外置 reflection 模块 + positioning 模块） |
| 2. 精度控制 / 沉默优于噪声 | **已做且写进 README**：「Recall 低于通用 agent，是刻意的取舍，宁可精度高也不要噪声」 |
| 5. 多轮 agent loop | **已做**（agent + 场景化工具集） |
| 评估基线 benchmark | **已做且公开**：AACR-Bench，50 个热门开源仓库、200 个真实 PR、10 种语言、80+ 资深工程师交叉验证、**1505 条标注 ground truth**，数据集挂在 HuggingFace（`Alibaba-Aone/aacr-bench`） |
| 0. 评审高度 / 非行内评论主形态 | **部分已做**（CLI 为主，见下） |
| 1. 规范体系（冷启动 + 演进） | **没做**（见下） |

#### 它的规则系统：匹配做得很深，生命周期完全没做

源码实测（`internal/config/rules/`）：

- **四层解析**，first-match-wins：`--rule` 指定的自定义文件 > 项目级 `.opencodereview/rule.json` > 全局 `~/.opencodereview/rule.json` > 内置 system 层。`RuleDetail` 结构体带 `Source`（`custom`/`project`/`global`/`system`）和 `Pattern`（命中的 glob）。
- **glob 定向**，支持 `**` 递归与 `*.{go,py}` 花括号展开（`expandBraces`）。
- **内容嗅探**：system 层被 `sniffer` 包了一层，`.m` 文件按内容判定是 Objective-C 还是 MATLAB。
- **内置 system 规则**：`internal/config/rules/rule_docs/` 下 **50+ 个** markdown，覆盖 go / java / python / rust / kotlin / swift / php / solidity / verilog / terraform 等语言，以及 `pom_xml` / `package_json` / `cargo_toml` / `github_workflows` / `dockerfile` / `mapper_dao_xml` 等文件类型。
- **可调试**：`ocr rules check <file-path>` 直接打印某个文件命中哪条规则、来自哪一层、匹配的是哪个 pattern。
- **可复现**：`CanonicalConfig()` 把「default 规则 + 有序的 pattern 规则」序列化成稳定字段列表，哈希成 `rule_config_sha256` 写进 run manifest。

项目自己的 `.opencodereview/rule.json` 就是个好样本——给 `internal/llm/providers.go` 单文件写了一条规则，要求字段顺序、命名约定、文档同步、测试覆盖，并带 `merge_system_rule: true`。

**但是：**

- `cmd/opencodereview/` 下 28 个命令文件里，**没有任何 init / generate / bootstrap 命令**。规则全靠手写 JSON。
- 没有规范演进机制。没有「这条规则被触发了几次、被采纳了几次」的统计。
- 没有冲突检测。first-match-wins 意味着后写的规则可能永远匹配不上，但工具不会告诉你。
- 规则内容是自由文本，没有结构化的严重度、类别、生效范围以外的元数据。

一句话：**OCR 把「规则怎么被选中、怎么被喂给模型」做到了工业级，把「规则从哪来、怎么变、有没有用」完全留白。**

#### 输出形态：开源世界里唯一一个不以行内评论为主的大项目

- **主形态是 CLI 终端**：`ocr review`（工作区改动 / `--from A --to B` 的 merge-base 区间 / `--commit`）、`ocr scan`（不依赖 diff 的整文件扫描）、`ocr session list` + `--resume`（断点续评）。
- `--format json --output result.json`（README 明确说「recommended for AI host agents」）。
- **SARIF 输出**（`cmd/opencodereview/sarif.go`）——可以直接进 GitHub Code Scanning 这类通道。
- **session viewer**（`ocr viewer`）：浏览器里回放评审过程，把 comment 标记为 fixed / ignored 并隐藏。
- **GitHub Action 侧才是行内评论**：`action.yml` 描述为「inline comments, sticky summary, and incremental non-destructive posting」。

也就是说 uReview 想押的「不以行内评论为主交互」这一条，**OCR 已经通过 CLI-first 事实上占住了**，而且它的 delegate 模式把这件事推得更远（见第四节）。

#### 平台与 CI

`examples/` 下六套现成集成：`github_actions`、`gitlab_ci`、`bitbucket_pipelines`、`gerrit_ci`（Jenkinsfile）、`gitflic_ci`、`codeup_ci`。GitHub 侧是 reusable action；GitLab / Gerrit / Bitbucket / GitFlic / Codeup 侧是「一份 CI 配置 + 一个 `post_review.py` 回帖脚本」的手工拼装（每套都带 `post_review_test.py`）。

**真实采用量（代理指标）**：公开仓库 `.github/workflows` 里引用 `alibaba/open-code-review@` 的文件 **56** 个。开源四个月、22312 star，CI 接入 56 个——**star 和真实接入之间差了两个数量级**。这是本次调研里最典型的「star 高但接入少」样本，原因下面第四节讲。

---

### 2.2 商业产品的 open core：`kodustech/kodus-ai`

**开源世界里唯一一个把「团队规范管理」当正经模块做的项目，但关键的一半被收费墙挡住了。**

| 指标 | 数值 |
|---|---|
| 许可证 | **AGPLv3**，另有 `license_ee.md`（企业版），典型 open core |
| star / fork | 1369 / 150 |
| 语言 | TypeScript（NestJS 单体，`apps/api`） |
| 近三月提交 / 作者 | 1703 / 21，但前 4 人（`Wellington01` 898、`sartorijr92` 264、`malinosqui` 253、`jairo-litman` 143）占 **91%**，都是公司员工 |
| 贡献者总数 | 25 |

它有的东西：

- **Kody Rules**：自然语言写评审规则，可按 **organization / repository / path / review scope** 四个维度定向。README 原话：「helping enforce architecture decisions, security expectations, testing practices, and repository-specific conventions without relying on reviewers to repeat the same feedback manually」。
- **Cockpit**：度量「评审有效性、**Kody Rule health**、仓库健康度、交付指标」。
- **Kody Learnings and Memory**。
- **Kody Issues**：追踪已关闭 PR 里没被实施的建议，按状态/严重度/类别/仓库管理，将来某个 PR 修了就自动关掉。

它的收费墙（README 里的 Community / Teams / Enterprise 对照表，Teams 是 $10/dev/月）：

| 能力 | Community（自托管，免费） | Teams |
|---|---|---|
| Kody Rules | **上限 10 条** | 无限 |
| Active plugins | 上限 3 个 | 无限 |
| **Engineering Metrics / Cockpit** | **❌** | ✅ |
| Kody Learnings and Memory | ✅ | ✅ |

对照 ticket 里第 25 号调研记的「真实组织的规则库会涨到 1805 条」——**Community 版给 10 条**。而衡量规则有效性的 Cockpit 直接不给。这就是「open core 把规范治理的后半段变现」的标准做法。

上手：`git clone` + docker compose 起编排器（自托管指南是「generic VM」），或者用 Kodus Cloud。属于最重的一档。

---

### 2.3 其余仍在动的开源项目

近三月有实质提交的，按 star 排（数据同一批抓取）：

| 项目 | 许可 | star | 近三月 commits / 作者 | 说明 |
|---|---|---|---|---|
| `mattzcarey/shippie` | MIT | 2502 | 17 / 2 | 老牌（前身 code-review-gpt），已明显放缓 |
| `anc95/ChatGPT-CodeReview` | ISC | 4463 | **6 / 2** | 第一代 Probot bot，基本只剩维护性提交 |
| `HexmosTech/git-lrc` | NOASSERTION | 1463 | 149 / 5 | 全是 Hexmos 员工；**评的是 git commit 不是 PR**，形态不同 |
| `Nikita-Filonov/ai-review` | Apache-2.0 | 571 | 29 / 4 | **平台覆盖最广**：GitHub/GitLab/Bitbucket Cloud+Server/Azure DevOps/Gitea |
| `Nayjest/Gito` | MIT | 430 | 90 / 6 | 主打「high-confidence, high-impact」，即降噪 |
| `spencermarx/open-code-review` | Apache-2.0 | 356 | 83 / **1** | 多 agent 模拟一支工程师团队；单人项目 |
| `miracodeai/mira` | Apache-2.0 | 293 | 412 / 11 | 自托管，带索引、walkthrough、依赖图；前两位占 65% |
| `tmseidel/ai-git-bot` | MIT | 159 | 383 / 11 | Java/Spring Boot，自托管，多平台；作者本人占 320/383 |
| `Juror-AI/juror` | MIT | 123 | 102 / 5 | 自称 Greptile 的便宜替代，跑在用户自己的 Actions 上；90/102 来自一人 |
| `devarshishimpi/codra` | AGPL-3.0 | 104 | 110 / 2 | 建在 Cloudflare Workers 上 |
| `aryanbrite/openrabbit` | Apache-2.0 | 61 | 22 / 3 | 「完全跑在 GitHub Actions 里，无需托管」 |
| `Thinkode/thinkreview-*` | AGPL-3.0 | 35 | 117 / 2 | 浏览器插件形态，覆盖 GitLab/GitHub/Azure/Bitbucket |
| `Audi-dask/Overseer` | AGPL-3.0 | 14 | 21 / 1 | 中文，企业自托管，GitLab MR + Push，回填总评与行内 discussion |
| `Agent-Field/pr-af` | **无 license** | 622 | 24 / 5 | Go，自称「#1 open-source code reviewer on Code-Review-Bench」，但**仓库根目录没有任何 LICENSE 文件** |

补一条相邻项目：`baz-scm/awesome-reviewers`（Apache-2.0，145 star，近三月 50 commits / 3 作者）——「Ready-to-use system prompts for Agentic Code Review」，是一个评审 prompt 的集合，不是工具本体。它是目前最接近「规范集市」形态的东西，但内容是 prompt 不是规则，且没有和任何评审引擎绑定。

---

### 2.4 坟场：近三月零提交的

| 项目 | 许可 | star | 最后推送 | 备注 |
|---|---|---|---|---|
| `sweepai/sweep` | NOASSERTION | 7710 | 2025-09-18 | 已转型 JetBrains 编码助手，**754 个 open issue** |
| `villesau/ai-codereviewer` | MIT | 1036 | 2024-08-19 | **854 个 fork**，最后 release 2023-12；典型「被 fork 光了然后作者走了」 |
| `sturdy-dev/codereview.gpt` | MIT | 609 | 2024-08-12 | Chrome 插件 |
| `kxxt/chatgpt-action` | MIT | 592 | 2023-09-09 | **已 archived** |
| `imbue-ai/vet` | AGPL-3.0 | 534 | 2026-06-10 | 52 周 236 次提交，但近三月 0 |
| `fjb040911/ai-rules` | **无 license** | 516 | 2026-06-02 | 「规则编译器」，把规范编成 Rule IR + 证据 + 修复提示；**方向和 uReview 的规范可执行性谱系最像，三个月就停了** |
| `sturdy-dev/codeball-action` | Apache-2.0 | 325 | 2023-04-06 | 最后 release 2022-09（即 ticket 里提到的 Codeball） |
| `truongnh1992/gemini-ai-code-reviewer` | MIT | 253 | 2025-12-16 | 1 个贡献者 |
| `presubmit/ai-reviewer` | MIT | 187 | 2026-02-12 | CI 接入 25 个仓库 |
| `Addepar/RedFlag` | MIT | 163 | 2026-05-22 | 最后 release 2024-11 |
| `gitbito/CodeReviewAgent` | MIT | 67 | 2025-11-13 | 闭源 Bito CLI 的 shell 包装 |
| `feiskyer/ChatGPT-Reviewer` | Apache-2.0 | 77 | 2024-01-31 | |
| `Usagi-org/ai-code-review-helper` | Apache-2.0 | 90 | 2025-07-01 | 中文，webhook 型 |
| `MatterAIOrg/matter-ai` | MIT | 54 | 2025-06-29 | **已 archived** |
| `monto-fe/code-review` | 无 license | 33 | 2026-02-11 | 中文，GitLab + DeepSeek |
| `eersnington/diff0` | MIT | 22 | 2026-02-26 | 自述「OSS Coderabbit and Greptile」 |
| `numberly/reviewate` | AGPL-3.0 | 13 | 2026-08-05 | **41 个 open issue / 13 star** |

中文社区还有一批 2023 年前后的 GitLab + ChatGPT 脚本（`Kento-Sec/chatGPT-CodeReview` 350 star、`buxuku/ai-code-reviewer` 89、`zixingtangmouren/mr-agent` 89、`peng-yw/ChatGPT-Gitlab-CodeReview` 17 等），全部停在 2023–2025 年，绝大多数无 license。

---

### 2.5 商业产品的开源壳：确认没有可用的开源核心

| 厂商 | 开源仓库实况 |
|---|---|
| **CodeRabbit** | `coderabbitai` 组织 22 个仓库，**没有评审核心**。有的是：`git-worktree-runner`（1772 star，bash 工具）、`awesome-coderabbit`（资源清单）、`skills`（172 star）、`ast-grep-essentials`（150 star，社区规则集）、`bitbucket`（API 客户端）、VSCode/Cursor 插件的 issue 仓库 |
| **Greptile** | 只有 `greptile-vscode`（MIT，98 star，插件壳）和 `akupara`（on-prem 的 helm chart，16 star） |
| **Sourcery** | `sourcery-ai/sourcery` 挂着 MIT、1862 star，但**仓库里只有 README、issue 模板、pre-commit hook 和 pyproject，一行产品源码都没有**。这是「MIT 徽章 + 零源码」的极端例子 |
| **Ellipsis** | `ellipsis-dev/cli`（3 star）、`sdk`（只读镜像）、安装器 |
| **Bito** | `gitbito/CodeReviewAgent`（67 star，shell 包装闭源 CLI）、`bitoai`（299 star，无源码） |
| **Sweep** | 已放弃 PR 评审方向，转 JetBrains 助手 |
| **Codemod** | `codemod-com` 组织已不存在（搜索 total=0） |
| **Qodo** | pr-agent 已捐出；留下的 `qodo-cover`（5642 star，AGPL-3.0，最后推送 2026-04-05）、`open-aware`（503 star，2025-10）、`agents`（121 star，2026-04）都在减速 |

结论：**这一格里没有值得对标的开源实现，只有营销资产。**

---

## 三、赛道判断

### 3.1 真正活跃的到底有几个

定「真正活跃」为两条同时满足：**近三月有实质提交**（≥20 次，排除只有 bot 和 README 改动的）**且有外部贡献者**（近三月不同作者 ≥3，且头号作者占比 < 90%）。

| 项目 | 近三月 commits | 近三月作者 | 头号作者占比 | 判定 |
|---|---|---|---|---|
| `alibaba/open-code-review` | 563 | 149 | 32% | **✅ 强活跃** |
| `The-PR-Agent/pr-agent` | 464 | 122 | 12% | **✅ 强活跃** |
| `miracodeai/mira` | 412 | 11 | 46% | ✅ 活跃（双核心 + 长尾） |
| `tmseidel/ai-git-bot` | 383 | 11 | 84% | ⚠️ 勉强（本质单人 + 少量外部） |
| `HexmosTech/git-lrc` | 149 | 5 | 60% | ⚠️ 单公司项目，无外部贡献 |
| `kodustech/kodus-ai` | 1703 | 21 | 53% | ⚠️ 商业公司项目（前 4 人占 91%） |
| `devarshishimpi/codra` | 110 | 2 | — | ❌ 单人 |
| `Juror-AI/juror` | 102 | 5 | 88% | ❌ 实质单人 |
| `Nayjest/Gito` | 90 | 6 | — | ✅ 勉强活跃 |
| `spencermarx/open-code-review` | 83 | 1 | 100% | ❌ 单人 |
| `Nikita-Filonov/ai-review` | 29 | 4 | — | ⚠️ 小而稳 |
| `Agent-Field/pr-af` | 24 | 5 | — | ⚠️ 小，且无 license |
| `mattzcarey/shippie` | 17 | 2 | — | ❌ 放缓 |
| `anc95/ChatGPT-CodeReview` | 6 | 2 | — | ❌ 几乎停 |

**答案：真正意义上「社区活跃」的只有两个** —— `alibaba/open-code-review` 和 `The-PR-Agent/pr-agent`。第三梯队（mira、Gito、ai-review）是能用但规模很小的项目。其余全是单人项目、公司项目或已死。

这个结论需要跟 2.0 节的 706 个仓库放在一起看：**赛道的拥挤是数量上的拥挤，不是竞争力上的拥挤。** 700 个项目里有两个真的在长，剩下的是噪声。

### 3.2 有没有哪一个在认真做「团队编码规范的管理与演进」

逐项核对（这是 uReview 的第二条主线，必须查清）：

| 项目 | 能写规范？ | 能按路径定向？ | **能生成（冷启动）？** | **能演进？** | **有有效性统计？** | 有冲突检测？ |
|---|---|---|---|---|---|---|
| `alibaba/open-code-review` | ✅ 四层 JSON | ✅ glob + 内容嗅探 | ❌ | ❌ | ❌ | ❌ |
| `kodustech/kodus-ai` | ✅ 自然语言 | ✅ org/repo/path/scope | ❌ | 部分（Learnings & Memory） | **✅ Cockpit，但 Teams 版起** | ❌ |
| `The-PR-Agent/pr-agent` | 部分：默认读 `AGENTS.md`（500 行全量注入）；`best_practices` 仍硬编码为 `""` | ❌ 无路径定向，skills 也是全量注入 | ❌ | ❌ | ❌ | ❌ |
| `vercel-labs/openreview` | 部分（`.agents/skills/`） | ❌ | ❌ | ❌ | ❌ | ❌ |
| 其余开源项目 | 基本是「一个 prompt 文件 / 一段 extra_instructions」 | 少数支持 glob | ❌ | ❌ | ❌ | ❌ |
| `fjb040911/ai-rules`（已死） | ✅ Rule IR + 证据 + 修复提示 | ✅ | ❌ | ❌ | ❌ | ❌ |

**开源侧的结论：没有任何一个项目在做规范的生命周期。** 最好的两个（OCR 和 Kodus）也只做到「规则的定向与注入」，而且：

- OCR 把**匹配**做到了工业级（四层、glob、内容嗅探、`rules check` 调试、配置哈希进 manifest），但规则从哪来、怎么变、有没有用，一律不管。
- Kodus 是唯一做了有效性度量（Cockpit 的 Rule health）的，但**它在 Community 版被关掉了，并且规则上限 10 条**。

另一个佐证：全 GitHub 搜 `coding standards enforce LLM review in:name,description stars:>20`，`total_count = 0`。`topic:coding-standards stars:>100` 的 27 个仓库全是 PHP_CodeSniffer 这类确定性 linter 和 `github/codeql-coding-standards`——**规范治理的世界和 LLM 评审的世界目前还是两拨人，没有开源项目把它们接起来。**

### 3.3 有没有哪一个不是以行内评论为主要输出形态

有，而且是最大的那个。

| 项目 | 主输出形态 |
|---|---|
| `alibaba/open-code-review` | **CLI 终端** + JSON + **SARIF** + 浏览器 session viewer；行内评论只在 GitHub Action 那条路径上 |
| `The-PR-Agent/pr-agent` | **一条 sticky 汇总评论**（`persistent_comment = true`，`inline_key_issues = false`），行内是可选 |
| `vercel-labs/openreview` | 行内评论 + suggestion 块（真·行内为主） |
| `kodustech/kodus-ai` | 行内评论 + web 控制台（Cockpit / Kody Issues） |
| `HexmosTech/git-lrc` | **git commit 钩子**，根本不在 PR 这一层 |
| `Thinkode/thinkreview` | 浏览器插件，在页面上叠加 |
| `sturdy-dev/codereview.gpt`（死） | Chrome 插件 |

需要修正 ticket 里的判断：**「PR-Agent、OpenReview、Qodo 全都是行内评论为主」只对 OpenReview 成立。** PR-Agent 开源版默认就是汇总评论；OCR 是 CLI-first；Qodo 商业版按 finding 分组（见 25 号 Qodo 调研）。「不以行内评论为主」这一条不再是空位——它已经是这一代工具的常态。

真正还空着的不是「输出到哪」，而是 **「评审的高度」** ——即便都是汇总评论，PR-Agent 的汇总是「把 N 条行内级别的发现堆成一个表格」，OCR 的 CLI 输出也是「按文件列出的行级 finding」。**没有任何一个项目的主输出是「这个改动该不该这么做」级别的判断。** 这一条 ticket 里押的注仍然成立，但它的对立面不是「行内评论」这个载体，是「行级发现」这个粒度。

### 3.4 有没有互相挤死的迹象

有，而且非常明显。

**证据一：形态高度同质。** 把长尾里的几十个项目的一句话描述放在一起，基本是同一句话的排列组合——「AI-powered code review for GitHub pull requests / self-hosted / runs in GitHub Actions / supports OpenAI + Claude + Gemini + Ollama」。`aryanbrite/openrabbit`、`Juror-AI/juror`、`presubmit/ai-reviewer`、`vuphongle/oss-pr-reviewer`、`truongnh1992/gemini-ai-code-reviewer`、`tarmojussila/{zai,minimax,xai}-code-review`（同一个人换三个模型发了三个仓库）在功能上互相之间没有可辨识的差别。

**证据二：死亡率。** `topic:code-review topic:ai` 的 1481 个仓库里，202 个半年以上没动。`topic:ai-code-review` 的 706 个里只有 20 个过百星。**做一个「调 LLM 评 diff 的 GitHub Action」的边际价值已经是零**，因为它二十行代码就能写完，而且已经有二十个人写过了。

**证据三：接入量极低。** CI 接入数（代码搜索 `.github/workflows`）：`presubmit/ai-reviewer` 25 个、`villesau/ai-codereviewer` 14 个（1036 star）。star 和使用之间差两个数量级，说明这些项目拿到的是「收藏待看」而不是「装上用了」。

**但头部没有互相挤死。** OCR 和 PR-Agent 是两种不同的东西：一个是 Go 写的 CLI 工具（本地/CI 都能跑，delegate 模式甚至不要 key），一个是 Python 写的多平台 PR 机器人（GitLab/Bitbucket/Azure DevOps 覆盖完整，命令式交互）。两者的用户可以不重叠。真正被挤死的是中间层——2500 star 的 shippie 近三月只有 17 次提交，4463 star 的 ChatGPT-CodeReview 只有 6 次。

### 3.5 商业产品对开源空间的挤压

| 产品 | 价格 | 对开源项目的压力 |
|---|---|---|
| **CodeRabbit** | $24 / $48 / $72 每开发者每月（营销页：[coderabbit.ai/pricing](https://coderabbit.ai/pricing)） | **公共仓库永久免费**（营销页原文「free reviews forever for public repositories」）。开源项目——也就是开源评审工具最自然的早期用户——**用 CodeRabbit 的成本是零**。这是对开源工具最直接的挤压 |
| **GitHub Copilot code review** | 随 Copilot；企业管理员可为**没有 Copilot license 的组织成员**开启（官方文档） | 零安装，就在 PR 界面里。而且**规范能力已经内建**：`.github/copilot-instructions.md`、`AGENTS.md`、`.github/instructions/**/*.instructions.md`（路径定向）、`CLAUDE.md`/`GEMINI.md`/`REVIEW.md`，severity 分 High/Medium/Low，支持 agent skills 与 MCP |
| **Cursor BugBot** | usage-based（官方文档 cursor.com/docs/bugbot） | 平台覆盖 GitHub（含 Enterprise Server）/ GitLab（含自托管）/ Bitbucket（含 Data Center）/ Azure DevOps。规则体系：team rules（组织级）+ repository rules（含 learned rules）+ `.cursor/BUGBOT.md` + **`@cursor remember <fact>` 行内教学**，多层合并上限 10 万字符 |
| **Greptile** | Starter 免费（1 个活跃开发者、50 credits/月）；Pro $30/seat/月；**MIT/Apache 的非商业开源项目可申请免费**；Enterprise 可自托管（营销页 greptile.com/pricing） | 免费档 + OSS 计划，再次覆盖同一批早期用户 |
| **Qodo** | Pro Team $30/月（≤30 人），无永久免费层，开源项目可申请（营销页 qodo.ai/pricing） | Qodo Merge Pro 在 GitHub Marketplace 显示 12.9K 次安装 |
| **Amazon CodeGuru Reviewer** | — | **已实质退场**：AWS 官方文档首行「As of November 7, 2025, you can't create new repository associations in Amazon CodeGuru Reviewer.」 |

**最要命的一条不是价格，是「规范槽位已经被 GitHub 占了」。** 代码搜索实测公开仓库：

| 配置形态 | 命中文件数 |
|---|---|
| `.github/instructions` 下含 `applyTo`（Copilot 路径定向指令） | **56064** |
| `.github/workflows` 里提到 `AGENTS.md` | 18400 |
| YAML 里含 `tone_instructions` 或 `path_instructions`（CodeRabbit 配置） | 2112 |
| 任何开源评审工具自有的规则文件格式 | 搜不出有意义的量 |

也就是说：**当团队想「把自己的编码规范告诉 AI」时，他们今天已经在写 `.github/instructions/*.instructions.md` 和 `AGENTS.md` 了，写了五万多份。** 任何新工具如果要求团队再学一种规则格式、再写一遍规范，起步就先欠了五万份文件的债。

---

## 四、开源工具的采用摩擦

### 4.1 从零到第一条评论要几步

按 README 里给出的**最省的那条路**统计。「步」定义为「用户必须动手做的一件事」（写一个文件、配一个密钥、点一次安装、跑一条命令各算一步）。

| 路径 | 步数 | 前置依赖 | 备注 |
|---|---|---|---|
| **OCR `delegate` 模式** | **2** | **无 LLM key、无 CI、无部署** | 装 Claude Code / Codex / Cursor / OpenCode 插件 → 在已有 agent 里跑。评审用的是用户**已经在付费的那个 agent 的额度**。输出在终端，不进 PR |
| **PR-Agent GitHub Action** | **2** | 1 个 LLM key | 加 8 行 `.github/workflows/pr-agent.yml`（`uses: the-pr-agent/pr-agent@main`）+ 配 `OPENAI_KEY`。`GITHUB_TOKEN` 自带 |
| **shippie GitHub Action** | **2** | 1 个 provider key | `npx shippie init` 脚手架生成 workflow，再配一个 secret |
| **OCR GitHub Action** | **2** | 4 个配置项 | 加 workflow（`uses: alibaba/open-code-review@main`）+ 2 个 secret（`OCR_LLM_URL`、`OCR_LLM_AUTH_TOKEN`）+ 2 个 variable（`OCR_LLM_MODEL`、`OCR_LLM_USE_ANTHROPIC`）。OCR **不内置默认 provider**，所以比 pr-agent 多配三项 |
| **OCR 本地 CLI** | **3** | 1 个 LLM key | `npm i -g @alibaba-group/open-code-review` → `ocr config provider` + `ocr config model`（交互式向导，自动测连通性）→ `ocr review` |
| **OCR GitLab CI** | **4** | LLM key + GitLab token + 往仓库里放脚本 | 复制 `.gitlab-ci.yml` **和一个 `post_review.py`** + 配 3 个 CI 变量（+ 可选 `GITLAB_API_TOKEN`，否则回落 `CI_JOB_TOKEN`）。GitLab 没有 reusable action，所以只能手工拼 |
| **PR-Agent GitLab** | 4+ | LLM key + 自建服务 | 需要跑一个常驻服务（docker）并注册 webhook |
| **OpenReview** | **5 + 一次部署** | LLM key、GitHub App、5 个环境变量、可选 Redis、Vercel 账号 | 部署 Next.js 到 Vercel → 建 GitHub App（配 webhook URL、4 类权限、2 类事件、生成私钥与 secret）→ 配 5 个环境变量 → 安装 App → **还得手动 `@openreview` 才触发** |
| **kodus 自托管** | 最重 | LLM key、Docker、数据库、web 控制台 | `git clone` + docker compose 起 NestJS 编排器 + 在控制台里配组织/仓库/规则 |

### 4.2 做到「加一个 CI 步骤就能用」的有哪些，怎么做到的

做到了的：**PR-Agent、alibaba/open-code-review、shippie、openrabbit、presubmit/ai-reviewer、villesau/ai-codereviewer、truongnh1992/gemini-ai-code-reviewer、Juror**。

共同的三个手法：

1. **打包成 GitHub Action**（`action.yml` 放在仓库根），用户一行 `uses:` 就引进来，不需要 npm install、不需要 Dockerfile、不需要知道它是什么语言写的。OCR 是 Go 写的，用户完全不需要装 Go。
2. **用 `GITHUB_TOKEN` 做平台鉴权**。这是关键的一步：GitHub Actions 自动注入 `secrets.GITHUB_TOKEN`，配上 `permissions: pull-requests: write` 就能发评论。**因此不需要注册 GitHub App、不需要 webhook、不需要公网可达的服务。** OpenReview 之所以要 5 步，正是因为它选了 GitHub App + webhook 这条路。
3. **无状态**。评审的输入是 PR diff，输出是评论，中间不留东西。没有数据库、没有向量库、没有索引服务。OCR 的 session/resume 靠本地文件，`miracodeai/mira` 那种带索引和依赖图的做法就必须自托管。

这三条合起来的代价：**这条路只在 GitHub 上成立。** GitLab / Gerrit / Bitbucket 都没有等价的「reusable action + 自动 token」机制，所以 OCR 在这些平台上退化成「一份 CI 配置 + 一个回帖脚本」，PR-Agent 退化成「跑个常驻服务 + 注册 webhook」。**「一个 CI 步骤就能用」目前是 GitHub 独享的福利。**

OCR 还多走了一步，值得单独记：**`delegate` 模式把 LLM key 这个前置也去掉了。** `ocr delegate preview` / `ocr delegate rule <files>` 只做文件选择和规则解析，把实际的评审交给用户本地已经在跑的 coding agent（Claude Code / Codex / Cursor / OpenCode 都有官方插件）。用户不需要申请任何 key、不需要在 CI 里存任何密钥、不需要为 token 付第二份钱。**这是目前整个赛道里上手摩擦最低的形态**，代价是输出留在本地终端里，不进 PR。

### 4.3 star 高但没人真用的共同特征

用「公开仓库 `.github/workflows` 里的引用数 ÷ star 数」做转化率的粗代理（代码搜索，2026-09-11）：

| 项目 | star | CI 引用数 | 转化率 |
|---|---|---|---|
| `truongnh1992/gemini-ai-code-reviewer` | 253 | 59 | **23%** |
| `aryanbrite/openrabbit` | 61 | 10 | 16% |
| `anc95/ChatGPT-CodeReview` | 4463 | 428 | 9.6% |
| `The-PR-Agent/pr-agent` | 12949 | 252 新名 + 461 旧名 = 713 | 5.5% |
| `presubmit/ai-reviewer` | 187 | 25 | 13% |
| `mattzcarey/shippie` | 2502 | 4 新名 + 36 旧名 = 40 | **1.6%** |
| `villesau/ai-codereviewer` | 1036 | 14 | **1.4%** |
| `alibaba/open-code-review` | 22312 | 56 | **0.25%** |
| `Juror-AI/juror` | 123 | 1 | 0.8% |

（这个指标只覆盖公开仓库的 GitHub Actions 一条路径，会系统性低估 CLI 工具、私有仓库、GitLab 用户和 App 型产品。作为绝对值不可信，**作为同类之间的横向对比有意义**。）

看下来，高星低用的共同特征有五条：

1. **它不是一个 Action，是一个框架/CLI/平台。** OCR 转化率 0.25% 的主要原因是它根本不主打 CI——它主打的是 `npm i -g` 之后在本地跑，而本地安装量是搜不到的。这类项目的 star 里有很大一部分是「工具箱收藏」而不是「流水线接入」。
2. **star 来自一次传播事件，不是来自使用。** OpenReview 的 1677 star 买的是 Vercel 的品牌和一张时序图；OCR 的 22312 star 里有相当部分来自 Trendshift 榜单和「阿里开源」这个标签。传播事件带来的 star 和实际装机量之间没有必然联系。
3. **改过名。** shippie（前 code-review-gpt）和 pr-agent（前 Codium-ai / qodo-ai）的引用都被打散在新旧两个名字上，旧名引用还更多。改名会直接拉低任何单点统计。
4. **需要自建或部署。** 凡是「先部署一个服务」的（OpenReview、kodus、mira、大部分 webhook 型的中文项目），装机量都极低。
5. **license 不明。** `Agent-Field/pr-af`（622 star）、`fjb040911/ai-rules`（516 star）、`vercel-labs/openreview`（1677 star）都**没有 LICENSE 文件**；`HexmosTech/git-lrc`（1463 star）、`kodustech/kodus-ai` 是 `NOASSERTION`。任何有法务流程的公司都过不了这一关，所以这些 star 转化不成企业采用。

反过来，转化率最高的几个（`truongnh1992` 23%、`openrabbit` 16%、`presubmit` 13%）的共同点非常单调：**它就是一个 Action，README 里有一段可以直接复制的 YAML，配一个 key，完。** 其中两个还已经停更了——**上手足够简单的话，停更都不影响别人接着用。** 这条对开源工具的启示比任何功能都硬。

---

## 五、全景对照表

数据抓取时间 2026-09-11 17:35–18:30 UTC。「近三月活跃」＝ 2026-06-12 起的提交数 / 不同作者数。「上手步数」取 README 里最省的那条路。

| 项目 | 许可证 | star | 近三月活跃 | 平台支持 | 核心做法 | 规范管理 | 主输出形态 | 上手步数 |
|---|---|---|---|---|---|---|---|---|
| **alibaba/open-code-review** | Apache-2.0 | **22312** | **563 / 149** ✅ | GitHub, GitLab, Bitbucket, Gerrit, GitFlic, Codeup | **确定性工程 × agent 混合**：文件选择+成组分治、模板引擎规则匹配、独立定位与反思模块 | **路径定向，四层解析**；无生成/演进/度量/冲突检测 | **CLI 终端** + JSON + SARIF + session viewer；Action 侧才是行内评论 | 2（Action）/ 3（CLI）/ **2 且无 key**（delegate） |
| **The-PR-Agent/pr-agent** | MIT | 12949 | **464 / 122** ✅ | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea | **单次 prompt pipeline**，一条命令一次 LLM 调用，无 tool-use loop（官方注释确认） | **只有读，没有管**：默认注入 `AGENTS.md`（500 行，无定向）；skills 为 8k token 全量注入且默认关闭；`relevant_best_practices` 全仓仅一处且硬编码 `""` | **sticky 汇总评论**（`persistent_comment=true`，行内默认关） | **2**（GitHub Action）/ 4+（GitLab 需自建服务） |
| **kodustech/kodus-ai** | AGPLv3 + EE | 1369 | 1703 / 21 ⚠️公司项目 | GitHub, GitLab, Bitbucket, Azure DevOps | agent + 插件体系（NestJS 单体） | **最完整但被收费墙切半**：Kody Rules 按 org/repo/path/scope 定向，Community **上限 10 条**；Rule health 度量在 Cockpit，**Community 不给** | 行内评论 + web 控制台（Cockpit / Kody Issues） | 最重（clone + docker compose + 控制台配置） |
| **vercel-labs/openreview** | **无 license** | 1677 | **0 / 0** ❌ | 仅 GitHub（绑 Vercel） | agent loop（沙箱内可跑 linter/测试，可改代码并 push） | `.agents/skills/`，无定向、无管理 | **行内评论 + suggestion 块** | **5 + 一次部署**，且需手动 `@openreview` 触发 |
| mattzcarey/shippie | MIT | 2502 | 17 / 2 ❌ | GitHub | agent + MCP 扩展 | `CUSTOM_INSTRUCTIONS` 单项 | 行内评论 | 2 |
| anc95/ChatGPT-CodeReview | ISC | 4463 | 6 / 2 ❌ | GitHub（Probot） | 单次 prompt | 无 | 行内评论 | 2 |
| HexmosTech/git-lrc | NOASSERTION | 1463 | 149 / 5 ⚠️单公司 | 本地 git + VSCode | commit 级微评审 | 无 | **git commit 钩子**（不在 PR 层） | 2 |
| Nikita-Filonov/ai-review | Apache-2.0 | 571 | 29 / 4 ⚠️ | **GitHub, GitLab, Bitbucket Cloud+Server, Azure DevOps, Gitea**（覆盖最广） | prompt pipeline，prompt 可外置 | 可换 prompt 文件 | 行内评论 + 汇总 | 3 |
| Agent-Field/pr-af | **无 license** | 622 | 24 / 5 ⚠️ | GitHub | agent（自称 Code-Review-Bench 第一） | 未提供 | 行内评论 | 需 docker compose |
| Nayjest/Gito | MIT | 430 | 90 / 6 ✅ | GitHub | prompt pipeline + 高置信度过滤 | 自定义 prompt | 汇总评论 + CLI | 2–3 |
| spencermarx/open-code-review | Apache-2.0 | 356 | 83 / **1** ❌ | GitHub / Claude Code 插件 | 多 agent 模拟工程师团队 | 可配角色 | 行内 + 汇总 | 2–3 |
| miracodeai/mira | Apache-2.0 | 293 | 412 / 11 ✅ | GitHub | 索引 + agent，带依赖图 | 未提供生命周期 | 行内评论 + walkthrough | 自托管（重） |
| tmseidel/ai-git-bot | MIT | 159 | 383 / 11 ⚠️实质单人 | GitHub, GitLab, Bitbucket, Gitea | 工作流平台（Spring Boot） | 未提供 | 行内评论 | 自托管 |
| Juror-AI/juror | MIT | 123 | 102 / 5 ⚠️实质单人 | GitHub Actions | agent + MCP | 未提供 | 行内评论 | 2 |
| devarshishimpi/codra | AGPL-3.0 | 104 | 110 / 2 ❌ | GitHub | Cloudflare Workers 上的服务 | 未提供 | 行内评论 | 需部署 Workers + KV + 队列 |
| aryanbrite/openrabbit | Apache-2.0 | 61 | 22 / 3 ⚠️ | GitHub Actions | agent | 未提供 | 行内评论 | **2** |
| Audi-dask/Overseer | AGPL-3.0 | 14 | 21 / 1 ❌ | GitLab | prompt pipeline | 无 | 总评 + 行内 discussion | 自托管 |
| *sourcery-ai/sourcery* | MIT（壳） | 1862 | 2 / 1 | — | **仓库内无源码** | — | — | — |
| *villesau/ai-codereviewer* | MIT | 1036 | **0 / 0** ❌死 | GitHub | 单次 prompt | 无 | 行内评论 | 2 |
| *sweepai/sweep* | NOASSERTION | 7710 | **0 / 0** ❌死 | — | 已转型 | — | — | — |
| *imbue-ai/vet* | AGPL-3.0 | 534 | **0 / 0** ❌死 | GitHub | — | — | CLI | — |
| *presubmit/ai-reviewer* | MIT | 187 | **0 / 0** ❌死 | GitHub Actions | 单次 prompt | 无 | 行内 + 摘要 | 2 |
| *sturdy-dev/codeball-action* | Apache-2.0 | 325 | **0 / 0** ❌死 | GitHub Actions | 分类模型 | 无 | 标签/状态 | 2 |

**商业对照（非开源，仅列对赛道的压力点）**

| 产品 | 定价 | 规范能力 | 对开源的挤压点 |
|---|---|---|---|
| CodeRabbit | $24/$48/$72 每人每月 | `.coderabbit.yaml` path instructions（minimatch glob）、自动发现 `AGENTS.md`/`.cursorrules`、custom checks（pass/fail）、**`@coderabbitai emit path instructions` 把 7 天内学到的规则自动开 PR 并回配置** | **公共仓库永久免费** |
| GitHub Copilot code review | 随 Copilot；企业可为无 license 成员开启 | `.github/instructions/**/*.instructions.md` 路径定向、`copilot-instructions.md`、`AGENTS.md`、`CLAUDE.md`；severity 三级；支持 agent skills 与 MCP | 零安装，在 PR 界面内；**存量 56064 份 `applyTo` 指令文件** |
| Cursor BugBot | usage-based | team rules / repository rules（含 learned rules）/ `.cursor/BUGBOT.md` / **`@cursor remember`** 行内教学，合并上限 10 万字符 | 平台覆盖含 GitLab 自托管、Bitbucket DC、Azure DevOps |
| Greptile | Starter 免费（1 人）、Pro $30/seat | — | **MIT/Apache 非商业开源项目免费**；Enterprise 可自托管 |
| Qodo | Pro Team $30/月，无永久免费层 | 商业版有 best practices / compliance checklist | Qodo Merge Pro 在 Marketplace 显示 12.9K 安装 |
| Amazon CodeGuru Reviewer | — | — | **2025-11-07 起不能创建新仓库关联，已退场** |

---

## 六、空位在哪

### 6.1 先把「拥挤」这个词拆开

数量上：`topic:ai-code-review` 706 个仓库，九成是 2026 年建的。竞争力上：真正社区活跃（近三月有实质提交 + 有外部贡献者 + 头号作者不占九成）的只有 **2 个**，`alibaba/open-code-review` 和 `The-PR-Agent/pr-agent`。

所以「赛道拥挤」这句话，对不同的问题有不同的答案：

- 问「再写一个调 LLM 评 diff 的 GitHub Action 有没有意义」——**没有**，已经有二十个，边际价值是零。
- 问「再做一个想成为头部的通用评审工具有没有位置」——**这才是要认真回答的问题**。

### 6.2 逐条重估 ticket 里的差异化候选

ticket 里列候选的时候 `alibaba/open-code-review` 还没进入视野。把它放进来之后，原来的排序要重排：

| 候选 | ticket 里的判断 | 实测之后的判断 |
|---|---|---|
| **5. 多轮 agent loop** | PR-Agent 结构上做不到，是空位 | **已失效**。OCR 有，OpenReview 有，shippie 有，juror 有。PR-Agent 做不到只说明 PR-Agent 老，不说明这是空位 |
| **3. 大变更集递归拆分 + 动态规范路由** | 原型已验证，是空位 | **已失效**。OCR 的「智能文件成组 + 每组一个 sub-agent 独立上下文 + 天然并发」就是这件事，而且已经在阿里内部跑了两年 |
| **2. 精度控制（Generator + Grader + 去重 + 阈值）** | 两家都没有 grader，是空位 | **已失效**。OCR 有独立的 positioning 模块和 reflection 模块，并且把「precision 优先于 recall」写进了 README 的取舍声明，还拿 1505 条标注的 AACR-Bench 做了论证 |
| **0. 评审高度（ticket 已改押注：高度是理解程度的函数，护城河在上下文积累）** | 可能最硬 | **改押之后仍然成立，而且实测支持这个改押**。两点：其一，「不以行内评论为主要输出」已经不是空位（PR-Agent 默认是汇总评论，OCR 是 CLI-first），**还空着的是粒度不是载体**——所有工具的最小单元都是「某文件某行有个问题」，堆成汇总也还是行级发现的集合。其二，「上下文积累」这个说法要和「上下文检索」分开，因为**几乎所有项目做的都是后者**，见下 |
| **1. 规范体系（冷启动 + 演进 + 可执行性分层）** | 两家都没做，第二大空白 | **在开源侧成立，在商业侧不成立**。见下 |
| **4. 跨仓库需求级** | 两家都只处理单仓单 PR | **完全成立，全场没有一个项目碰**。但它和「上手摩擦是生死线」直接冲突 |

**关于「上下文积累 vs 上下文检索」的实测补充。** ticket 改押之后，护城河落在「对代码库理解得足够深」上，那就必须查清楚别人的上下文是怎么来的。实测结果是：**绝大多数项目做的是「评审当次的按需检索」，不是「跨次积累的理解」**。

- `alibaba/open-code-review`：仓库 topic 里明确挂了 `repository-level-context`，README 也说 agent「can read full file contents, search the codebase, inspect other changed files for context」。但看源码，它的 agent 工具集只有 **6 个**（`internal/tool/definitions.go`）：`file_read`、`file_find`、`file_read_diff`、`code_search`、`code_comment`、`task_done`，外加 MCP 动态发现的工具。**全仓没有索引、没有向量库、没有跨次记忆**（唯一带 memory 字样的是 `memory_compression_task` 的 prompt 模板，那是单次长 agent 运行内的上下文压缩，不是跨运行的记忆）。也就是说它的「仓库级上下文」是每次评审现查现用，评完就扔。
- `miracodeai/mira`：是少数做了持久化的（自述带 indexed PR reviews 和 dependency graphs），代价是必须自托管。
- `kodustech/kodus-ai`：有 Kody Learnings and Memory，Community 版也给。
- `The-PR-Agent/pr-agent`：社区新加的 `review_finding_state.py` 把 finding 状态（ACTIVE/RESOLVED）以 HTML 注释埋进 PR 评论里，**跨轮次可读回**。这是「积累」的一个极小但可用的形态——**状态存在 PR 评论里，不需要任何外部存储**。零摩擦和积累在这个尺度上是可以共存的，值得抄这个思路。
- **跨仓库的上下文：一个都没有。**

这条对 uReview 的含义是正面的：**「积累」这个词还没被认领。** 头部项目在「单次检索得多深」上已经卷到很深（OCR 的 6 个工具是从生产环境的 tool-call trace 里蒸馏出来的），但「这次评审学到的东西下次还在不在」几乎是空白。代价也很明确——积累必须落盘，落盘就要状态，要状态就和第四节的零摩擦结论冲突，所以它只能是可选的增量层，不能是默认路径。

**这一表的含义要说得直白一点：ticket 里排前三的技术性差异化（多轮 loop、大 PR 拆分、精度控制），在 2026-05 之后已经不能作为「别人为什么用我们」的答案了。** 不是说不该做——不做就是不合格——而是做了也只能达到及格线，打动不了任何人。

### 6.3 还空着的三块，以及各自的问题

**（a）规范的生命周期 —— 开源侧确实是零，但窗口在关**

「有没有哪一个在认真做团队编码规范的管理与演进」，实测答案：

- 开源侧：**没有**。OCR 把规则的**匹配**做到了工业级（四层解析、glob、内容嗅探、`rules check` 调试、规则集哈希进 manifest），但规则从哪来、怎么变、有没有用，一律不管；`cmd/` 下 28 个命令里没有 init/generate。PR-Agent 的 `best_practices` 是硬编码的空串。Kodus 是唯一做了 Rule health 度量的，**但 Community 版把 Cockpit 关掉、规则上限 10 条**。
- 商业侧：**已经被占满了**。CodeRabbit 的 `@coderabbitai emit path instructions` 会汇总过去 7 天的建议、自动开一个 PR 把学到的规则并回 `.coderabbit.yaml`——**这就是规范演进，已经上线**。Cursor BugBot 有 `@cursor remember` 行内教学 + learned rules。GitHub Copilot 有 `.github/instructions/**/*.instructions.md` 路径定向。

两个必须正视的数字：

1. 公开仓库里 `.github/instructions` 下带 `applyTo` 的文件已有 **56064** 份。**团队已经在写规范了，而且写的是 GitHub 的格式。** 任何要求团队再学一种规则 DSL、再写一遍规范的产品，起步就欠着这 5.6 万份文件的债。
2. 全 GitHub 搜「coding standards + LLM review」类的项目，`total_count = 0`；`topic:coding-standards` 过百星的 27 个全是 PHP_CodeSniffer 这类确定性 linter。**规范治理的世界和 LLM 评审的世界还没被任何开源项目接起来**——这是真空位；但 `fjb040911/ai-rules`（把规范编译成 Rule IR + 证据 + 修复提示，方向最接近）拿了 516 star 之后三个月就停了，说明这个方向不容易做成。

所以这块的空位是成立的，但它**不在「让团队写规则」这一层**（这一层已经饱和），而在下面这三件没人做的事上：

- **冷启动**：从现有代码库和历史 review 里产出第一版规范，而不是让团队对着空文件发呆。今天所有工具都假设规范已经存在。
- **有效性**：每条规则被触发了几次、被采纳了几次、被无视了几次。哪条在空转，哪条在被绕过。Kodus 做了并且收费，其余全无。
- **冲突与冗余**：first-match-wins 的规则集会静默地让后写的规则永远不生效，OCR 的实现有这个问题且不报警。规则涨到几百上千条之后这是刚需。

**（b）评审粒度 —— 真空位，但很难证明价值**

所有项目的最小单元都是「file:line 有个问题」。汇总评论只是把行级发现装进一张表，OCR 的 CLI 输出也是按文件列出的行级 finding。「这个改动该不该这么做 / 这个抽象是不是错的 / 这个改动会不会让另一处假设失效」这个高度，全场空着。

问题是：**它很难用现有的 benchmark 论证。** OCR 已经用 AACR-Bench（1505 条标注 ground truth）把「评审质量」这个论证位占住了，而那个 benchmark 衡量的恰恰是行级发现的 precision/recall。一个主打更高粒度的工具在这个 benchmark 上会显得 recall 很差，而它真正的价值——「拦下了一个不该合的设计」——没有对应的度量。要么自己造一套评估，要么接受「无法证明」。

**（c）跨仓库 / 需求级 —— 真空位，但和零摩擦冲突**

所有开源项目都是单仓单 PR。这是唯一一块没人碰的地方。但第四节的数据很硬：转化率最高的项目（23% / 16% / 13%）都是「一个 Action + 一段 YAML + 一个 key」，转化率最低的都是要部署的。跨仓需要依赖图、多仓授权、某种知识库——**天然站在上手摩擦的反面**。这块只能做成可选的增量层，不能做成默认路径。

### 6.4 诚实的结论

**如果 uReview 的价值主张是「一个评审做得更好的开源 AI code review 工具」，那么现在没有位置，不必再做一个。**

理由有四条，都是实测数据：

1. **「评审做得更好」这个论证位已经被占了。** OCR 用 50 个仓库 / 200 个真实 PR / 10 种语言 / 80+ 资深工程师交叉验证 / 1505 条标注的公开 benchmark 占住了它，数据集挂在 HuggingFace 上任人复现。要在这个位子上赢，得先赢那个数据集。
2. **供给端的体量不对等。** OCR 四个月：154 位贡献者、近三月 563 次提交 149 位作者、issue 首次响应中位数 1.3 小时、OpenSSF Gold、有 GOVERNANCE.md、五种语言的 CONTRIBUTING。PR-Agent 近三月 464 次提交 122 位作者，正在捐给开源基金会。这两个项目的吞吐量不是一个小项目能对抗的。
3. **技术性差异化的前三条已经失效**（见 6.2）。
4. **免费档已经把最自然的早期用户覆盖了。** CodeRabbit 公共仓库永久免费、Greptile 对 MIT/Apache 非商业项目免费、Copilot 在 PR 界面里内建。一个新的开源评审工具在开源社区里拿不到「因为免费所以用你」这张牌。

**如果位置存在，只可能在一个方向上：不把自己做成评审工具。**

把 6.3 的三块空位串起来看，它们指向同一个东西——**规范是产品，评审是规范的执行器和反馈通道**，而不是反过来。

这一条和 ticket 里改押后的候选 0（「评审高度是理解程度的函数，护城河在上下文积累」）是同一件事的两个说法：规范库正是「上下文积累」里唯一一种**可以被人读懂、被人争论、被人贡献**的形态。依赖图和代码索引积累的是机器读的上下文，团队规范积累的是人读的上下文——后者才有可能变成社区资产（ticket 里提的「规范集市」），前者不会有人来贡献。**所以如果要押上下文积累，规范这一支是唯一能同时兼顾护城河和社区性的。**

这个定位下：

- 竞品关系变了。OCR 的四层规则解析和 delegate 模式本质上是**一个规则消费端**；PR-Agent 是 MIT、社区所有、正在招 maintainer，它的 git provider 抽象（GitHub / GitLab / Bitbucket / Azure DevOps / Gitea 五平台，还带 webhook、轮询、增量评审、评论去重）是现成可复用的。**和它们竞争「谁评得准」是必输的仗，把它们当执行后端是可行的。**
- 差异化的问题从「你比 PR-Agent 强在哪」变成「**离开你，团队的规范会退回到一个没人维护的 markdown 文件**」。这个问题 OCR 答不了，因为它不管规则从哪来；CodeRabbit 答得了一半（emit path instructions），但它是闭源 SaaS，公司代码要出网；Kodus 答得了一半但收费且上限 10 条。
- 这个方向上有一件必须先做的事：**接受 `.github/instructions/*.instructions.md` 和 `AGENTS.md` 作为一等输入格式**。那 56064 份文件是存量资产不是障碍。需要注意的是**这一步 PR-Agent 已经走了**——它现在默认就读 `AGENTS.md`（500 行全量注入）。所以「能读」不是差异化，只是入场券；**产品的增量在「读进来之后怎么管」：按路径定向、按有效性排序、发现冲突、在被无视时提醒、在被证明有效时固化。**

**还有一条硬约束不能绕：无论做什么，必须存在一档「加一个 CI 步骤 / 或者交给用户已有的 agent」的零配置形态。** 第四节的数据里，转化率前三名有两个已经停更，但因为足够简单，别人还在接着用。而所有要求部署的项目，装机量都极低。上手摩擦对开源工具的杀伤力大于任何功能差距。OCR 的 delegate 模式（不要 LLM key，把评审交给用户已经在付费的 coding agent）是目前摩擦最低的形态，值得直接抄。

**最后一点提醒，涉及可信度：** 本次调研里有四个项目（OpenReview 1677 star、pr-af 622 star、ai-rules 516 star、加上 NOASSERTION 的 git-lrc 1463 star）**没有明确的开源许可**。任何有法务流程的公司都不能用它们。这是免费送的一个差异化点——**在 README 第一屏放一个清楚的许可证**，成本为零。

### 6.5 顺带记下的两条

- **和 PR-Agent 是竞争还是互补**：互补的条件比之前好得多。它已经是社区所有、正在捐给基金会、公开招 maintainer、近三月接了 122 个人的提交。它的 git provider 抽象是 MIT 的，五平台覆盖比任何其他开源项目都全（OCR 在 GitLab/Gerrit 上还是「CI 配置 + 回帖脚本」的手工形态）。**复用它的 provider 层、而不是重写一遍**，是当前证据下更划算的选择。
- **开源项目的成功标准**：从本次数据看，star 是最不可信的指标（`sourcery-ai/sourcery` 1862 star 零源码，`sweepai/sweep` 7710 star 已弃坑，OCR 22312 star 但 CI 接入 56 个）。更可信的三个是：**CI/配置文件的实际引用数**（可被第三方独立核实）、**近三月的不同提交作者数**（社区是否真的接住了项目）、**issue 首次响应中位数**（维护者是否还在）。如果要给 uReview 设指标，建议直接用这三个，并且把「有多少个外部仓库贡献了规范条目」作为第四个——因为那正好是产品主张成立与否的直接证据。

---

## 附：数据来源与可复现性

- 全部 GitHub 数据通过 `gh api` 于 2026-09-11 17:35–18:30 UTC 抓取，涉及接口：`repos/{r}`、`repos/{r}/commits`（带 `since` 与 `--paginate`）、`repos/{r}/contributors`、`repos/{r}/releases`、`repos/{r}/issues`、`repos/{r}/forks`、`repos/{r}/stats/participation`、`repos/{r}/git/trees/HEAD?recursive=1`、`repos/{r}/contents/*`、`search/repositories`、`search/issues`、`search/code`。
- 首次响应时间为 40 个近三月 issue 的抽样统计：取每个 issue 的第一条非作者、非 Bot 评论与创建时间之差。
- **stargazers 接口在本环境下对所有仓库返回 404**（REST 与 GraphQL 均是），所以没有逐星标时间戳的增长曲线；增长趋势一律用 `created_at` + 52 周提交曲线 + release 节奏三个代理指标表述，文中已逐处标注。
- 代码搜索的计数只覆盖公开仓库、且 GitHub 的代码索引不完整，仅用于同类横向比较，不作绝对值使用。
- 引用营销页的地方（CodeRabbit / Greptile / Qodo 的价格与免费政策）已在正文中标注「营销页」；GitHub Copilot、Cursor BugBot、Amazon CodeGuru 的结论来自各自的官方文档。
