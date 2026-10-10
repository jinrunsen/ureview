# Uber uReview 架构拆解：Generator → Grader → Filter → Dedup → Evaluation

- 对应 ticket：`../issues/04-uber-ureview-公开架构的可复刻细节.md`
- 调研时间：2026-09-11
- 调研方式：以 Uber 官方工程博客和 Uber 工程师的公开演讲为一手来源，逐句核对；博客配图单独下载后逐图读取（配图里有正文没写的信息）；演讲取到完整转录后逐段核对。二手解读仅用于找线索，不作为结论依据。

---

## 0. 来源清单

| 编号 | 类型 | 来源 | 说明 |
|---|---|---|---|
| **S1** | 一手 | [uReview: Scalable, Trustworthy GenAI for Code Review at Uber](https://www.uber.com/us/en/blog/ureview/)，2025-08-12，作者 Shauvik Roy Choudhary / Sonal Mahajan / Joseph Wang / Akshay Utture / Will Bond | **2025 年架构**。精度控制链路的主来源 |
| **S1-F1** | 一手（配图） | [Figure 1 原图](https://tb-static.uber.com/prod/udam-assets/a898698b-6e21-5e5e-ad71-b2d55fa5013c.png) | Phabricator 上的真实评论截图。含正文未提及的反馈控件细节 |
| **S1-F2** | 一手（配图） | [Figure 2 原图：uReview pipeline](https://tb-static.uber.com/prod/udam-assets/b4413453-80e2-5d89-8aca-bec46d4c4841.png) | 流水线图。**框名与正文不一致**，且标注了各阶段是否走 LLM |
| **S2** | 一手 | [Running a Software Factory Efficiently at Uber Scale](https://www.uber.com/us/en/blog/efficient-software-factory/)，2026-08-27，作者 Uday Kiran Medisetty | benchmark 构造方法、成本/F1 散点 |
| **S2-F3** | 一手（配图） | [Figure 3 原图](https://tb-static.uber.com/prod/udam-assets/6f6a2f9d-8e70-45a8-9637-9ffa118aa23b.png) | uReview 在 Uber agent 分层里的定位与计量单位 |
| **S2-F5** | 一手（配图） | [Figure 5 原图](https://tb-static.uber.com/prod/udam-assets/a3b68d79-4d1f-47d5-9524-5c0c404bdbd2.png) | 10 组配置的 cost × F1 散点。**唯一公开的 F1 绝对值来源** |
| **S3** | 一手（演讲，已取得完整转录） | **"Building uReview, Uber's Multi-Agent Code Review Engine"**，Will Bond & Ameya Ketkar（Uber），AI Engineer World's Fair 2026。[YouTube](https://www.youtube.com/watch?v=EL123UNokkI)（15:07，2026-08-28 上传）· [AIE 页面](https://ai.engineer/talks/EL123UNokkI-building-ureview-ubers-multi-agent-code-review) | **2026 年架构**。含 2025 博客完全没有的演进史、v1 形态、生产数字、inner/outer loop 论述。本文引用标 `[时:分]` 为转录时间戳 |
| **S4** | 一手（演讲，已取得完整转录） | **"Agentic SDLC at Uber — Building Blocks for Uber's Software Factory"**，Uday Kiran Medisetty & Adam Huda（Uber），同场。[YouTube](https://www.youtube.com/watch?v=17-YSUHo6Lk) | 仅 3 处提到 code review，但其中 1 处是重要的分层结论 |
| **S5** | 一手（佐证） | [Uber Go Style Guide](https://github.com/uber-go/guide/blob/master/style.md) | 用于核对 S1 里「time 库」那个 linter vs LLM 的例子 |
| **S6** | 二手（编辑评注） | AIE 官方为 S3 撰写的图文版（同 S3 页面） | 仅用于引用其对演讲数据缺口的明确评注，已注明出处 |
| **S7** | 二手（付费墙） | [The Pragmatic Engineer: How Uber uses AI for development](https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development) | 免费段只有一句「uReview for high-signal AI code review comments」，无技术信息。列出仅为说明已核查 |

**标注约定**：`【U】`= Uber 明确说了的（可回溯到原文/配图/转录）；`【推】`= 我从一手材料推出来的；`【空】`= Uber 没说、需要我们自己设计。

**一个关键提醒**：S1（2025-08）和 S3（2026 年中）描述的是**两代不同的系统**。二手中文解读几乎全部只看了 S1。下文凡有演进的地方都会并列标出年份。

---

## 1. 先说结论

Ticket 的判断——「uReview 最值得学的是 Evaluation 和 Grader，不是 Reviewer」——在一手材料上**成立，而且比预想的更成立**，但有两处必须修正。

### 支撑这个判断的硬证据

1. 【U】Uber 自己把话说死了（S1）：「Prompt design helped, but **system architecture, and post-processing were even more critical**.」
2. 【U】演讲里给出了更狠的一句，这是整份材料里最值得记住的一句话（S3 [6:35]，Ameya Ketkar）：

   > "One of the biggest learnings in this process was like **the model doesn't know that it's wrong. It always confidently says 100% sure** that yeah, this is the review for your code. Go ahead."

   这一句就是外置 grader 存在的全部理由——模型的自评信号不可用，置信度必须由**另一个调用**给出。
3. 【U】模型选型是 **Generator × Grader 成对**比 F1，不是只调 generator。同一个 generator 换 grader，F1 差 **4.5 个点**（S1）。
4. 【U】2026 年的团队把大半个演讲时间用来讲 observability 和 evaluation 的演进（S3 [4:24–7:20]），而不是讲怎么写 review prompt。Ameya 的原话是：写 skill 很容易，难的是**大规模稳定低成本地跑**（S3 [9:44]）：

   > "writing the skill was very easy… teams just very quickly wrote a skill by asking Claude to write one… **But the hard part was how to run these skills at scale with consistent quality and low cost.**"

### 要修正的第一处：Grader 不是「多维评分器」

Ticket 假设 grader 判「正确性、重要性、可操作性、重复」四维。核对结果：

- 【U】Uber 只说 grader「evaluates each comment's quality and assigns a **confidence score**」——**一个质量分，没有维度分解**（S1）。
- 【U】「重复」是**下游独立的一级**（Duplicate comment Filter）；「类别价值」是**再下游独立的一级**（Comment Category Filter）（S1-F2）。
- 【U】S6（AIE 编辑对 S3 的评注）明确指出：「the talk **does not specify the scoring thresholds or deduplication algorithm**」。演讲也没补上这块。

所以 Uber 的链路是**三次独立的窄判断**串行，不是一次宽判断吐多维 JSON。理由 S1 写了：prompt-chaining 是为了让每个子任务「evolve independently」。

### 要修正的第二处：别高估这类系统的绝对水平

- 【U】**生产配置 F1 = 0.50**（S2-F5，口径是 "F1 vs. human reviewers"）。
- 【U】**只有 10% 的评论能拿到任何反馈**（S3 [10:21]）。那么 S1 的「75% useful」是在这 10% 上算的。

这两个数应该直接写进我们的预期管理材料。

---

## 2. 流水线：三个版本

### 2.1 v1（S3 [4:33] 回溯，2025 博客之前）

【U】Ameya 回顾的起点，原话：

> "uReview had a very humble beginning. Basically, it was **a single prompt that you should do logic checks per file, a simple agent which used to do thorough review. And we had a dispatcher to decide** whether to go which generator to choose."

即：**逐文件单 prompt + 一个粗糙的深度 review agent + 一个 dispatcher 二选一**。没有 grader、没有去重、没有类别过滤。

【U】v1 的可观测性同样简陋：「We used to collect cost. We used to run an **NPS survey**, have **Google Forms** being filled, **Slack support**.」结果是「our **quality to cost ratio was like all over the place**」（S3 [4:48–5:08]）。

【推】这一段对我们价值极大：**Uber 的起点比我们想象的低**。他们不是一开始就有 grader 和三维阈值，是被「质量成本比到处飞」逼出来的。我们不必一上来就复刻终态。

### 2.2 v2（S1，2025-08）——精度控制链路成型

【U】正文说拆成四个子任务：**comment generation、filtering、validation、deduplication**。

【U】S1-F2 配图画的框（从左到右）：

```
Piece of code to review
  → Pre-processor
      →（"Files that need a review"）
  → Pluggable Comment Assistants ┬ General Defect Assistant   [LLM]
                                 ├ Best Practices Assistant   [LLM]
                                 └ …                          [LLM]
  → Review grader            [LLM]  "Filter low confidence (grade) comments"
  → Duplicate comment Filter [LLM]  "Merge similar comments into one."
  → Comment Category Filter  [LLM]  "Prune low-value or poorly performing comment categories"
  → High quality Code review comments
```

三处正文与配图不一致，都记一下：

1. 【U】配图叫 **General Defect Assistant**，正文叫 **Standard Assistant**。
2. 【U】配图第三个 assistant 是 `…`，正文里明确是 **AppSec Assistant**。【推】配图画得比正文早，或画的是框架示意。
3. 【U】正文的四子任务命名（filtering / validation / deduplication）与配图的三个后处理框对不上号。【推】正文 "validation" ≈ 配图 Review grader，"filtering" ≈ Comment Category Filter。

**配图里最有价值、正文完全没写的一条**：Review grader、Duplicate comment Filter、Comment Category Filter **三个框都画了 LLM 图标**（与 assistant 框同一个图标）。

【推】由此：

- 语义去重**是一次 LLM 调用**，不是 embedding 余弦相似度 + 阈值。
- 类别分类器**也是 LLM**，不是训练出来的判别式分类器。
- **一条评论从生成到发出至少经过 4 次 LLM 调用**（1 生成 + 3 后处理）。这解释了 S2-F5 里 $0.47/review 的量级。

证据强度：配图是 Uber 官方画的，LLM 图标在图内自洽（只有需要模型的框才标）。但正文未确认，故标 `【推】`。

### 2.3 v3（S3 [2:57–4:20]，2026）——多入口 + 路由

【U】Will Bond 描述的 2026 架构：

- **顶部三个 review 入口**：**GitHub、Phabricator、以及 agent loop**（内环）。三者都喂进 uReview service。
- uReview service 做三件事：接收 review 请求、**接收用户反馈**、**做路由（routes it）**。
- 【U】"We have a number of different **generators**. Now, these generators are **tuned for different performance and cost avenues**."
- 【U】还能**挂第三方 code review 系统**：「We also have the ability to **plug into third-party code review systems so that we can compare ourselves** to what's available more broadly.」
- 【U】后处理的四个动词与 2025 一致：「we both **rate, categorize, filter, and deduplicate** comments so that our engineers get only the highest confidence comments that are actionable」。
- 【U】去重的动机被明说了：「with all these different generators, we might be duplicating comments, and we can actually create quite a **high volume** of comments」。

【推】v2 → v3 的结构变化是：**assistant 的分类维度从「问题类别」换成了「作用范围 / 定制程度」**（见 §3.2），并在前面加了一层 **router**。后处理链路本身没变。

**注意**：尽管演讲标题写着 "Multi-Agent"，**S3 和 S4 都没有描述任何 agent 之间的协作、交接或编排**。可核实的「agent 性」只有两处：按团队定制的 custom agent（带知识库和历史 PR），以及 agent trajectory 采集。【推】"Multi-Agent" 在这里约等于「多个并行的 generator」。

---

## 3. Generator 层

### 3.1 框架形态（2025）

【U】"uReview uses a **pluggable assistant framework**, where each assistant focuses on a specific class of issues. This pluggable framework allows each assistant to be **developed and evaluated independently**, and use **customized prompts and context**."（S1）

三个要点：每个 assistant 只管一类问题（不是一个大 prompt 塞多份 checklist）；独立开发独立评估（【推】benchmark 也按 assistant 切分）；prompt 和 context 都是 per-assistant 的。

### 3.2 两代 generator 分类法（重要变化）

**2025 版（S1）——按问题类别分：**

| Assistant | Uber 原文职责 | 解读 |
|---|---|---|
| **Standard**（配图：General Defect） | "detects bugs, incorrect exception handling, or logic flaws" | exception handling 被单列，说明它在 Uber 是高频高价值品类 |
| **Best Practices** | "enforces Uber-specific coding conventions by referencing **a shared registry of style rules**" | 唯一有**外部知识源**的 assistant |
| **AppSec** | "targets **application-level** security vulnerabilities" | 限定 application-level，不是依赖/供应链安全 |

【U】"uReview currently has three assistants in operation, but is actively expanding the list."（S1，2025-08）

**2026 版（S3 [7:37–8:41]）——按作用范围和定制程度分，四层：**

| 层 | Uber 原话 | 解读 |
|---|---|---|
| **1. Single-file reviewer** | "a general purpose 'Hey, find me all logic bugs per file' kind of a review" | 通用逐文件缺陷扫描。就是 v1 那个单 prompt 的后代 |
| **2. Multi-file / deep agent review** | "we have like six mono repos. So, all these mono repos have their own **anti-pattern style guides and all baked into this agent review** which does have a nice multi-file review" | 跨文件 agent review，**每个 monorepo 的反模式与风格指南烘焙进 agent** |
| **3. AI linters** | "few shot… system where developers can basically kind of **deterministically get more context and then run rules with that context and like a file** and find some **systematic and mechanical** issues" | **确定性取上下文 + few-shot 规则**的混合体。介于 linter 和 LLM 之间 |
| **4. Custom agents** | "teams could basically **define their own custom agent, link it to like a knowledge base, link it to their past PRs, have like a skill to do the review**" | 团队自定义。**这是唯一会用到历史 PR 的路径** |

【推】这个变化对我们的产品形态有直接启发：**2025 的分类（Standard/BestPractices/AppSec）是平台方定义的固定品类；2026 的分类是按「谁来定义规则、看多大范围」组织的**。后者才是能让几百个团队各自演进的结构。我们做企业内平台，应该直接对着 2026 版设计，而不是对着 2025 版。

【U】注意第 4 层出现后，「uReview 看不到历史 PR」这个 2025 年的限制（见 §3.3）**在 custom agent 路径上被打破了**。

### 3.3 输入上下文怎么构造

【U】S1 关于 context 的**全部**原文：

> "the system builds a structured prompt that includes surrounding code context such as **nearby functions, class definitions, and import statements**."

只有三样东西，加 diff 本身。这是**文件级局部上下文**，不是 RAG，不是调用图。

【U】而且 S1 在 Lessons Learned 里明确划了边界：

> "uReview today only has access to the code, and **not to other artifacts like past PRs, feature flag configurations, database schemas, technical documentation**, and so on, because of which **it can't correctly assess overall correctness and review the system design**. It's much better at catching bugs that are evident from analyzing the source code alone. However, we foresee that this may change in the future with **MCP servers** being built to access these other resources."

【推】这条对我们是重要的边界确认——**「AI 做架构评审」在 Uber 这个投入量级下 2025 年还没做到**。不应放进第一版目标。到 2026 年，custom agent 可挂知识库和历史 PR（§3.2），算是部分兑现了那句 "may change in the future"。

【U】2026 年补了一条**反向的**上下文要求（S3 [6:46–7:19]）：

> "it actually needs a lot of guidance from the teams because **each team has its own style guide, its own patterns or like anti-patterns** that they want to look for. So that all should be like baked into the agent. And we also realized that we need to have **guardrails for the agent. So we need to tell the agent what NOT to waste turns doing.** Like code review is something that has to happen in like a **specific time span**. And then if it starts spending time doing things that it should not be doing, leads to a bad quality code review."

【U】两条独立结论：①团队级的风格/反模式必须烘焙进 agent；②**必须显式告诉 agent 什么不值得花轮次去查**——因为 review 有固定时间预算，浪费的轮次直接换成质量下降。第②条在公开的 AI code review 材料里很少见，值得单独记。

【空】context 窗口多大、邻近函数取几层、大文件怎么截断、多 hunk 是合成一个 prompt 还是拆开——都没有。

### 3.4 文件过滤规则

【U】"uReview first determines which files are eligible for automated review. It filters out low-signal targets such as **configuration files, generated code, and experimental directories**."（S1）

三类，且是举例（"such as"），不是完整规则。

【U】旁证：S1 影响力章节说 "processes over 10,000 commits per week, **excluding configuration files**"——配置文件排除是记进统计口径的正式规则。

【U】2026 年多了一条**动态**过滤原则（S3 [2:25–2:42]）：

> "we need the ability to take factors like the **risk profile and the complexity of a code change** and factor that in when deciding how we're going to run a code review. **Not all code gets the exact same review.**"

【推】即：2025 是二值的「审 / 不审」，2026 变成了「按风险和复杂度决定审多深」——对应 §3.2 那四层 reviewer 的选择。这正是 §2.3 里 router 的职责。

【空】规则语法、生成代码怎么识别、「实验目录」怎么定义、risk profile 怎么算——全没有。

### 3.5 并行性

【推】S1-F2 里 Pre-processor 三条箭头同时扇出到三个 assistant，再汇聚到同一个 Review grader。据此判断 assistant **并行执行、结果汇合后统一进 grader**。正文无 "parallel" 一词，属读图推断，但图示语义明确。S3 [3:43] 「with all these different generators, we might be duplicating comments」也印证了多 generator 的输出会汇合。

---

## 4. Grader 层

### 4.1 Uber 到底说了什么

【U】S1 原文，一句半：

> "A **secondary prompt** evaluates **each comment's** quality and assigns a **confidence score**. The prompt is **customized for each assistant type**, and confidence thresholds for pruning are set at a **fine-grained level (per assistant, per language, and comment category)** based on developer feedback and evaluations."

【U】S1-F2 配图：框名 **"Review grader"**，框下 **"Filter low confidence (grade) comments"**，框上 **LLM 图标**。

【U】S3 [4:00] 只把它列为后处理四动词之一（"rate"），未展开。

能确定的：

| 问题 | 答案 | 依据 |
|---|---|---|
| 输出是分数还是标签？ | **分数**（confidence score），连续量——下游要与阈值比较 | S1 |
| 单次还是多次调用？ | **对每条评论一次**（"evaluates **each comment's** quality"），不是对整个 diff 一次 | S1 措辞 |
| prompt 共用吗？ | **不共用**，按 assistant 类型定制 | S1 |
| 用哪个模型？ | 与 generator **不同的模型**，独立选型 | S1 模型评测章节把两者分列（§7） |

### 4.2 评分维度：Uber 没有公开

- 【U】**Uber 从未公开 grader 的评分维度**。原文只有 "quality" 一个词。
- 【U】「重复」不在 grader 里，是下游独立一级；「类别价值」也是再下游独立一级（S1-F2）。
- 【U】S6（AIE 编辑评注）明确：「the talk does not specify the **scoring thresholds** or deduplication algorithm」。

【推】不过「正确性 vs 重要性」这个二分在 Uber 的**问题定义**里是明确存在的。S1 开篇：

> "The main challenge of AI code review is false positives from **two sources**: **LLM hallucinations that generate incorrect comments** and **issues that are generally valid but not important in that specific scenario** (like a performance issue in code that isn't performance sensitive)."

Uber 把误报明确拆成两类：**幻觉型**（说错了）和**无关型**（说对了但不重要）。grader 既然只输出一个分，它必须同时压住两者。【推】要么 grader prompt 内部要求模型分别考虑再合成一个分，要么两类被分摊到不同阶段（幻觉归 grader，无关型归 category filter）。**Uber 没说是哪种**——这是复刻时必须自己决定的核心设计点。

### 4.3 我们的设计建议（非 Uber 结论）

Uber 只留了「一个质量分」的轮廓。我倾向于让 grader **显式输出两个判断**：「这条评论陈述的事实是否成立」与「在本处上下文里是否值得提」，再合成一个分。理由：这两类误报的修复手段完全不同——幻觉型要改 generator 的 context，无关型要改 category 权重——不分开就无法定位问题来源。

这条**明确标注为我们的设计选择**，Uber 公开材料不支持也不反对。

### 4.4 空白清单

【空】grader prompt 全文、评分值域（0-1 / 0-10 / 0-100）、是否输出 reasoning、是否用 logprobs、是否多次采样取平均、grader 本身的准确率如何验证。一概没有。

---

## 5. 阈值策略

### 5.1 Uber 说了什么

【U】唯一的原文（S1）：

> "confidence thresholds for pruning are set at a fine-grained level (**per assistant, per language, and comment category**) based on developer feedback and evaluations."

【U】阈值空间三维：`assistant × language × category`。

【推】按 S1 公开规模估算：3 assistant × 6 语言 × N category。即便 category 只有 10 个量级，也是数百个格子。这不是人工维护得过来的规模——【推】要么大量格子共用默认值，要么有自动化拟合。Uber 没说是哪种。

### 5.2 阈值怎么定出来

【U】"based on developer feedback and evaluations"——七个词，没有算法。

【U】能佐证的是**调整机制**，不是初始化机制：

- "Feedback from both methods informs adjustments to **confidence thresholds, prompts, and filtering logic**."（S1）——自动评估 + 人工 benchmark 两路都回流到阈值。
- "we A/B-tested candidate fixes, **tuned thresholds**, and shipped improvements **within a day**."（S1）——走 A/B，一天内可上线。
- 灰度时每阶段挂三类看板：「**precision-recall dashboards, comment-address-rate logs, and user-reported false-positive counts**」（S1）。

### 5.3 目标函数

【U】"We aim to maintain a usefulness rate **above 75%** as the system expands to cover more languages and services."（S1）

【推】这是本节最可操作的一条：**Uber 把 75% usefulness 当 SLO，阈值是守住这个 SLO 的旋钮**。扩语言、扩服务时不降这个数，靠调阈值。阈值不是一次性调优出的最优值，而是**被反馈持续拉住的控制变量**。

【推】三维分格的动机随之清楚：不同 assistant / 语言 / category 的 usefulness 天然不同，全局单阈值必然「牺牲好格子救坏格子」。分格后坏格子可单独收紧甚至关掉，不拖累好格子。

### 5.4 2026 年多了一层：确定性路由

【U】S3 [9:06] 把阈值之外的另一个旋钮说清楚了：

> "We had to implement a **smart deterministic routing** so that we could route **which team gets what kind of review, with which model, what kind of generators**."

【U】三个维度：**团队 → review 类型 / 模型 / generator 组合**。且强调是 **deterministic**（确定性），不是模型决定的。

【推】这是 2025 那套 `assistant × language × category` 阈值的上游补充：先用确定性路由决定「跑哪些 generator、用什么模型」，再用阈值决定「跑出来的哪些评论能发」。两级共同构成噪声控制。

### 5.5 空白清单

【空】阈值初始值、冷启动、新语言/新 category 上线时取多少、是否自动重标定、稀疏格子怎么处理、A/B 判定指标和样本量、路由规则的具体表达形式。全部没有。

---

## 6. 去重与类别过滤

### 6.1 Duplicate comment Filter

【U】S1 正文：「a **semantic similarity filter merges** overlapping suggestions.」
【U】S1-F2 框下：「**Merge similar comments into one.**」框上：**LLM 图标**。
【U】S3 [3:43] 动机：「with all these different generators, **we might be duplicating comments**, and we can actually create quite a high volume of comments.」

要点：

1. 【U】动作是 **merge（合并）**，不是 drop。合并意味着输出一条覆盖多处的新评论，而不是保留其中一条。
2. 【推】实现是 **LLM 调用**（配图标了 LLM 图标），不是向量相似度。这直接回答了 ticket 的「语义去重用什么手段」——**Uber 用的是模型判断，不是 embedding**。
3. 【U】**跨 generator 的重复在同一级处理**：S1-F2 里所有 assistant 输出汇聚到 grader 再到唯一一个 Duplicate comment Filter；S3 [3:43] 明说重复来自「all these different generators」。跨 assistant 去重与同 assistant 内去重是同一个组件、同一次处理。
4. 【U】位置在 **grader 之后**。【推】这个顺序有成本考虑：先用 grader 砍掉低分评论，剩下的才两两比较，去重输入规模小得多。反过来则要对更多评论做 O(n²) 比较。

【U】合并结果长什么样，S1-F1 截图有实物证据。那条评论正文末尾带了一句：

> "(also applies to other locations in this diff.)"

即**同一问题在 diff 内多处出现时被折叠成一条**，且会显式声明「本条还适用于别处」，而不是静默丢弃其余位置。

【U】S6（AIE 编辑）明确：演讲**没有**给出去重算法。

【空】相似度判定粒度（同文件同行？同问题跨文件？）、合并后挂哪一行、合并时保留哪条的 confidence、是否有合并上限。

### 6.2 Comment Category Filter

【U】"a category classifier **tags each comment** (for example, **`correctness:null-check`** or **`readability:naming`**) and **suppresses those from categories with historically low developer value**."（S1）

- 【U】分类体系是 **`domain:subtype` 两级**（Uber 只给了这两个实例）。
- 【U】配图标 **LLM 图标**，分类器也是模型。
- 【U】压制依据是「historically low developer value」——**历史反馈数据**，不是先验规则。

【U】闭环写得很清楚：

> "by assigning a predicted category to each comment, comment-category filters can **automatically eliminate** categories that have historically attracted negative feedback within Uber."（S1）

注意 "automatically"。【推】这是整条链路里唯一一处 Uber 明说「自动」的调参——**category 级开关是数据驱动自动翻的**，而 §5 的阈值更像人工 + A/B 调。

【U】哪些 category 实测低价值，S1 在 Lessons Learned 里点了名：

> "**Readability nits, minor logging tweaks, low-impact performance optimizations, and stylistic issues** consistently received poor ratings. In contrast, **correctness bugs, missing error handling, and coding best-practice violations—especially when paired with examples or links to internal docs**—scored well."

四类差 / 三类好，可以直接拿来做我们第一版 category 黑白名单。

【U】**2026 年新增了一个正交维度：severity**。S3 [10:34] 单独统计了 "high severity issues" 的 addressal rate（见 §9）。【推】说明 2026 年的分类至少是 `category × severity` 两个轴，而不只是 2025 的单轴 category。

【空】完整 category 表、类目数量、分类器 prompt、能否多标签、"low value" 的量化门槛、severity 分几档及判定方式。

---

## 7. 模型选型：benchmark 与 Generator × Grader 组合

两份博客里信息量最大、最能直接照抄的一节。

### 7.1 2025 年的做法（S1）

【U】"we conducted benchmark tests on a curated suite of commits containing **annotated ground-truth issues (that is, a golden comments dataset)**. The evaluation compares uReview's identified issues against the ground-truth and computes standard metrics: **precision, recall, and F-score**."

【U】结果：

| 配置 | 结果 |
|---|---|
| **Claude-4-Sonnet（generator）+ o4-mini-high（grader）** | **最高 F1，生产采用** |
| Claude-4-Sonnet（generator）+ GPT-4.1（grader） | 第二，比最优**低 4.5 个点** |
| 被击败：GPT-4.1、O3、O1、Llama-4、DeepSeek R1 | — |

【U】"We periodically evaluate newer models using this approach and **use the model combination with the highest F1 score**."

**最值得抄的是方法论而非结论**：

1. 【U】选型单位是 **(generator, grader) 组合**，不是单个模型。同 generator 换 grader 差 4.5 个 F1 点——**grader 选型的影响是量级可观的**，这是 ticket 那个判断最硬的证据。
2. 【U】评的是**流水线端到端输出**对比 ground truth，不是 generator 的裸输出。grader 的贡献被算进同一个指标。
3. 【U】是**周期性重跑**的常设流程，不是一次性选型。

### 7.2 2026 年的做法（S2）——benchmark 构造细节在这里

【U】S2 把 benchmark 构造讲清楚了（S1 只说 "curated suite"）：

> "we use uReview, which handles AI code review for all pull requests. We built its benchmark from **real pull requests with known bugs** and **graded them easy, medium, and hard**. We score **precision, recall, and F1 against those bugs, plus cost per review, latency, timeouts, and noise**."

拆开：

- 【U】**样本来源：真实 PR，且是已知含 bug 的 PR**。不是合成数据，不是注入 bug。
- 【U】**难度分层：easy / medium / hard 三档**。S1 没有这条，也是最该抄的一条——不分层则模型在简单样本上刷分会掩盖难样本上的退化。
- 【U】**评分维度扩到 7 个**：precision、recall、F1、cost per review、latency、**timeouts**、noise。后四个 S1 没有。注意 **timeouts 被单列为质量指标**——生产规模下模型超时是真实问题。

【U】通用选型流程（S2 原文写 "four steps" 但**只列了三条** bullet，是 Uber 自己的编辑疏漏）：

> 1. Build a benchmark out of the agent's real work.
> 2. Run the agent on **a harness that serves any model, frontier or open-weight, behind one interface**.
> 3. Move to whatever is Pareto optimal, and keep moving. **The frontier shifts every few weeks.**

【U】第 2 条是架构约束：**要有统一 harness，前沿模型与开源模型走同一接口**，否则既无法公平对比也无法快速切换。

【U】另有一个更大的 **Uber SWE Benchmark**：「Using **thousands of real-world PRs** across our large monorepos… runs frontier and open-weight models across different task types. We use it to inform model selection across all our SDLC-managed agents.」——**两层 benchmark 结构**：通用的 SWE Benchmark + 每个 agent 专用的 benchmark。

### 7.3 S2-F5：唯一公开的 F1 绝对值

图标题：**"COST VS. QUALITY: 10 CONFIGURATIONS ON THE uREVIEW BENCHMARK"**
- Y 轴：**"F1 vs. human reviewers"**（0.25–0.55）
- X 轴：**"Cost per review, log scale · cheaper →"**（约 $2.42 → $0.06）
- 虚线为 Pareto frontier。【U】"Everything below and left of it is beaten by something cheaper or better."

图上**带文字标注**的点（这些是图里印出来的字，不是我从坐标估的）：

| 配置 | Cost/review | F1 | 备注 |
|---|---|---|---|
| **Frontier Model C** | **$0.47** | **0.50** | **"(what we run)" — 生产配置** |
| Frontier Model A | $2.42 | 0.483 | 最贵，F1 反而更低 |
| Frontier Model B（两个 harness） | $2.22 / $0.94 | ≈0.476 / ≈0.468 | **同模型不同 harness，成本差 2.4 倍，F1 几乎不动** |
| Open-Weight Model A | $0.28 | 0.48 | 在 Pareto 前沿上 |
| Open-Weight Model C | $0.06 | 0.31 | 最便宜，质量断崖 |

（另有若干无文字标注的点，含 Open-Weight Model B 的两个点 F1 ≈0.458，以及一个 F1 ≈0.394 的闭源点；这些是我按坐标读的，标 ≈。Frontier Model B 那两点我放大原图核对过：红色虚线确实连接两个 F1 几乎相同的点，不是连到那个 0.394 的点。）

【U】**2026 年的博客把模型名匿名化了**（Frontier A/B/C、Open-Weight A/B/C），不像 2025 年直接点名。**当前生产用的是哪个模型，公开信息里查不到。**

几条对我们有直接价值的读数：

1. 【U】**生产配置 F1 = 0.50**。这是 uReview 对标人类 reviewer 的绝对水平。
2. 【U】**最贵的不是最好的**：$2.42 的 Frontier A（F1 0.483）被 $0.47 的 Frontier C（F1 0.50）在两个维度上同时打败。成本与质量不单调。
3. 【U】**开源模型 A 以 $0.28 拿到 F1 0.48**，仅比生产配置低 0.02，成本低 40%。**对自托管场景这是很强的信号。**
4. 【U】**同一模型换 harness 省 58% 成本而 F1 几乎不动**（$2.22 → $0.94）。**harness/prompt 工程的成本空间与换模型同量级。**
5. 【U】S2：「switching models improved our F1 **while** dramatically reducing cost/PR」——切模型同时改善了两头，不是权衡。

---

## 8. 评估闭环

这是 ticket 的重点，也是材料最扎实的一块。分三层：**上线前的 benchmark**、**上线后的自动判定**、**开发者反馈的回流**。

### 8.1 自动评估：五次重跑法（全篇最可照抄的机制）

【U】S1 原文：

> "It automatically evaluates if a given posted comment has been addressed by **re-running uReview five times on the final commit**. Because LLM is stochastic, a single rerun might skip a lingering issue or revive one that is already fixed, so we invoke it **five times—the minimal count that virtually eliminates missed detections while keeping cost and latency low**. A comment is considered **addressed if none of the re-runs reproduce a semantically similar comment** (with adjustments for cases when code referenced in the comment is deleted)."

逐条拆：

| 要素 | Uber 的做法 |
|---|---|
| 触发点 | 在 **final commit**（合入版本）上重跑 |
| 次数 | **5 次**，理由是「virtually eliminates missed detections 的最小次数」 |
| 判定 | 5 次里**没有任何一次**重新产生语义相似评论 → addressed |
| 边界处理 | 评论引用的代码被删除时**另有调整**（怎么调没说） |
| 规模 | "runs on **thousands of commits in production daily**" |

【推】这个设计的巧妙之处：它把「开发者有没有改」这个无法直接观测的量，转换成「问题还在不在」这个**可以用同一个系统观测**的量。**不需要开发者做任何事**，也不依赖代码平台的任何状态字段——所以它在 GitLab 上可以原样实现。

【推】「5 次全不复现才算 addressed」是**保守判定**，偏向判 not addressed。所以 65%/67% 这个数字是下界性质的。

【U】自动评估的定位：「The advantage of automatic feedback is that it **runs on thousands of commits in production daily**.」——规模优势。

### 8.2 人工评估：golden benchmark

【U】"Manually, a curated benchmark of commits with known issues is used to evaluate comment **precision, recall, and F1** scores against **human-labeled annotations**."（S1）

【U】定位：「allows us to **evaluate and iterate on uReview locally before deploying** a new feature.」

两套评估分工明确：**benchmark 管上线前，重跑法管上线后**。

### 8.3 可观测性的演进阶梯（S3，2026 年新增，最有价值的新材料）

【U】Ameya 按时间顺序讲了四级，这是 2025 博客完全没有的（S3 [4:48–6:34]）：

| 阶段 | 采集什么 | 结果 |
|---|---|---|
| **v1** | cost、**NPS 问卷**、**Google Forms**、**Slack 支持** | 「our **quality to cost ratio was like all over the place**」。目标是象限图左上角，实际散得到处都是 |
| **v2** | **对开发者回复做情感分类**——"we started collecting the **sentiments of the replies** that were made to the uReview comment… we categorized them into **positive, negative**. We classified them into **various categories**" | 「we found **a lot of classes of bugs and issues** that we could actually solve」→「able to move a **large number of PRs to a high quality to cost ratio**」 |
| **v3** | **addressal rate**——"when a uReview comment is made, **does the developer go and actually address the comment**?" | 补上了「有没有真的被采纳」这一维 |
| **v4** | **agent trajectory**（运行时剖析）——"**what tool calls it made**… **what thinking process it had**" | 「with that insight, we were able to actually **tune our runtime, tune our performance** such that the agent could very quickly give us high-quality results at a low cost」 |

【推】这条阶梯对我们是最实用的路线图。三点值得单独拎出来：

1. **v1 → v2 的跃迁不是换模型，是换信号**。从「问开发者满不满意」（NPS/表单，低响应率、滞后、粗粒度）换成「分析开发者本来就会写的回复」（零打扰、高覆盖、可分类）。**这是被动信号取代主动信号**。
2. **回复情感分类产出的不是一个满意度分，而是「一批可解的 bug 类别」**。Uber 用它做**根因归类**，不是做打分。
3. **agent trajectory 是拿来调性能和成本的，不是调质量的**。它回答「agent 把轮次花在哪了」——与 §3.3 那条「告诉 agent 什么不要浪费轮次去做」是同一件事的两面：先用 trajectory 观测浪费，再用 guardrail 消除浪费。

### 8.4 开发者反馈怎么回流（ticket 重点问的）

**采集形式**：

【U】S1 正文：「Developers can rate each comment as **'Useful' or 'Not Useful'** and optionally add a note.」

**但配图 S1-F1 里的实物控件不是二元的。** 截图上评论底部写的是：

> "uReview GenAI comment. Please rate the usefulness of this comment: **0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10**"

【U】这是 Uber 自己的截图，**实际上线的是 0–10 的 11 档量表**，正文写成 Useful/Not Useful 是简化表述。【推】那么「75% marked useful」很可能是**在 0–10 上取某个阈值折算的**，阈值多少没说。这直接影响数字怎么解读——我们自己做时要么用同样量表并公开阈值，要么用二元避免歧义。

【U】此外 2026 年还有**第三种反馈来源**：开发者在评论下的**自然语言回复**，经情感分类后使用（§8.3 v2）。这个不需要开发者点任何按钮。

**数据链路**：

【U】"All comments, along with their associated metadata—including **assistant origin, category, confidence score, and developer feedback**—are streamed to **Apache Hive via Apache Kafka**."（S1）

四维元数据全量落仓，正好对应 §5 的三维阈值空间加分数本身。【推】阈值调参所需的全部数据就是这张表。

**回流路径（Uber 明说的有三条）**：

1. 【U】**个体级 → 负例回归集**：

   > "files that contain negative comments provide **clear benchmark cases that future versions of uReview should avoid reproducing**."（S1）

   即：**被差评的评论所在文件，进入一个「不该再产生这条评论」的负例回归集**。注意这是**负例集**，约束「不要再犯」，而不是「应该发现什么」。它与 §7 的 golden comments 正例集是两套互补数据。

2. 【U】**类别级 → 自动关停**：

   > "by assigning a predicted category to each comment, comment-category filters can **automatically eliminate** categories that have historically attracted negative feedback within Uber."（S1）

3. 【U】**维度交叉 → 定向改进**：

   > "By linking feedback to metadata like **language, comment category, and assistant variant**, we uncovered granular patterns and made targeted improvements, including **better prompting, better model selection, and pruning underperforming comment types**."（S1）

【U】**2026 年多了第四条：反馈回流给规则作者**（S3 [9:16]）：

> "we had to actually **surface all of this observability… like the agent trajectory, addressal rate, sentiment analysis back to the teams**. So that the teams could actually understand that '**Oh, I wrote this rule, but maybe not a lot of developers are liking it in my team, so let me go and update it.**'"

【推】这是从「平台团队调参」变成「**规则作者自己看自己规则的表现**」。对几百个团队各自写规则的场景，这是唯一可扩展的运营方式，也是我们做企业内平台必须抄的一条。

### 8.5 一个相邻的闭环（S4）

【U】S4 [16:49]，讲的是维护型 agent，但机制可迁移：

> "when that skill runs and makes those diffs, **those diffs will get comments and either get landed or not landed. That's all good labeled data that we can use to improve the skill itself.**"

【推】即：**agent 产出的 diff 是否被合入 + 收到什么评论 = 免费的标注数据**。这与 §8.1 的五次重跑法是同一思路——**把生产流程本身当成标注管道**。

---

## 9. 生产数据全表（含统计口径与矛盾点）

所有公开数字，以及**每个数字的口径**。口径比数字本身重要——这几个数被中文二手解读普遍引错。

### 9.1 2025 年数字（S1）

| # | 数字 | 原文口径 | 注意事项 |
|---|---|---|---|
| 1 | **>90%** | "analyzes over 90% of the weekly ~65,000 diffs (equivalent of pull requests) **landed** at Uber" | 分母是**已合入**的 diff |
| 2 | **~65,000 diffs/周** | 同上 | **⚠️ 与 #10 矛盾** |
| 3 | **75% useful** | "**Engineers who interact with the tool** mark 75% of its comments as useful" | **⚠️ 分母是被评分的评论，不是全部评论。** 2026 年的 #14 证实只有 **10%** 的评论会拿到反馈 → 这个 75% 是在约 1/10 的样本上算的，且评分自愿，存在选择偏差。另：实际控件是 0–10（§8.4），75% 是折算值 |
| 4 | **>65% addressed** | "65% of comments being addressed **in the same changeset**" | 由 §8.1 五次重跑法**自动判定**，非人工确认 |
| 5 | **51%（人类基线）** | "**Internal audits** show that only 51% of **human-written** comments are considered as bugs by the author and addressed in the same changeset" | **⚠️ 口径与 #4 不同**：51% 来自 internal audits，65% 来自自动重跑。**不是同一把尺**，「AI 超过人类」这个对比要打折看 |
| 6 | **中位 4 分钟** | "reviews every commit as part of our **CI process** within a **median** of 4 minutes" | 中位数，非 P95 |
| 7 | **>10,000 commits/周** | "processes over 10,000 commits, **excluding configuration files**" | **⚠️ 与 #2 的 65,000/周差 6 倍**。口径不同（diffs analyzed vs commits processed excl. config），Uber 未解释差异 |
| 8 | **10 分钟/commit** | "Internal benchmarks indicate that having a second human reviewer look for the kinds of issues identified by uReview **would require** 10 minutes per commit" | **假设值，非实测**。是 #9 的输入 |
| 9 | **~1,500 小时/周、~39 人年/年** | 由 #7 × #8 推导 | **⚠️ 推导值，非测量值**。核算：10,000 × 10min ≈ 1,667h/周；1,500 × 52 ÷ 2,000 = 39 人年（即 1 人年 = 2,000 小时）。整条链依赖 #8 那个 10 分钟假设 |
| 10 | **65,000 per month** | "given the scale of diffs at Uber (**65,000 per month**)" | **⚠️ 与 #2 直接矛盾（同一篇文章内）**。#2 说 weekly，#10 说 per month |
| 11 | **低一个数量级** | "the AI-related costs of running uReview are an **order of magnitude less** than what typical third-party tools **charge**" | 对比对象是第三方工具**报价**，不是其成本 |
| 12 | **6 个 monorepo** | Go, Java, Android, iOS, TypeScript, Python | — |
| 13 | **4.5 个 F1 点** | 次优 generator×grader 组合与最优的差距 | 绝对点数差，非相对百分比 |

**关于 #2 / #7 / #10 这组矛盾**：一篇博客里同时出现「65,000 diffs 每周」「65,000 每月」「每周处理 10,000+ commits」。【推】最自洽的解释是 #10 的 "per month" 是笔误（#2 出现在开篇核心数据句，且 #9 的推导链用的是 #7）。但这只是推测，**引用时应标注不确定性**，不要单独引 65,000 而不说口径。

### 9.2 2026 年数字（S2 / S3）

| # | 数字 | 原文口径 | 来源 | 注意事项 |
|---|---|---|---|---|
| 14 | **~25,000 评论/周；10% 获得反馈；4% 的 PR 收到负面反馈** | "uReview does like around **25,000 comments a week**. And we get **10% of them actually get some feedback**. And only **4% of the PRs actually get some negative feedback**" | S3 [10:13] | **这三个数是一组，必须一起看。** 10% 反馈率是 #3 那个 75% 的真实分母。**4% 是按 PR 算的，不是按评论算的**——【推】这其实是比 useful rate 更诚实的噪声指标，因为分母是全部 PR |
| 15 | **addressal rate ~67%** | "the overall **addressal rate** was around 67%" | S3 [10:31] | 与 #4 的 65% 同口径（自动重跑判定），一年后略升 |
| 16 | **高严重度问题约 75% 被处理** | "**almost three quarters of the high severity issues** were usually addressed by the developers" | S3 [10:34] | **新增 severity 维度**（§6.2）。这个数比总体 addressal rate 更有说服力 |
| 17 | **成本 -60%、质量与准确率 +~70%** | "against like a **very naive implementation**, our **costs were down by 60%** and our **quality and our accuracy was up by around 70%**" | S3 [10:47] | **⚠️ 基线是「朴素实现」，不是上一版生产系统。** 且 S6（AIE 编辑）明确评注：「The presentation **does not define the quality and accuracy measures**, specify the measurement window or **clarify whether the 70% figure is relative improvement or a percentage-point change**.」**这个数不可复现，引用需极度小心** |
| 18 | **首次 review 等待：3 小时（2024）→ 9 小时（2026）** | "Back in 2024… engineers would get their first review within **3 hours**. Now in **2026**, that has grown to **9 hours**" | S3 [1:04] | **这是最好用的立项论据**：AI 让写代码变快，review 变成瓶颈，等待时间 3 倍化 |
| 19 | **F1 0.50 / $0.47 per review** | 生产配置在 uReview benchmark 上，"F1 vs. human reviewers" | S2-F5 | **最重要的一个数**。模型名已匿名 |
| 20 | **$0.06 → F1 0.31；$2.42 → F1 0.483** | 同 benchmark 的成本-质量两端 | S2-F5 | — |
| 21 | **>70% 的 PR 出自 agent** | "More than 70% of pull requests are attributed to local or cloud agents" | S2 | **全公司口径，与 uReview 无关**。但说明 review 侧压力来源 |
| 22 | **cost/1000 requests -34%、cost/session -52%** | 固定模型，2 月→7 月 | S2 | **⚠️ 全公司 AI 支出口径，不是 uReview 的降本。** 中文解读常错安到 uReview 头上 |

### 9.3 几个可以自己算出来的比值（均为【推】）

- **每周评论密度**：25,000 评论（#14，2026）÷ >10,000 commits（#7，2025）≈ **每个 commit 2 条多一点**。⚠️ **这两个数来自不同年份，只能当数量级参考**，不能当精确比值——2026 年的 commit 量大概率高于 2025，所以真实密度应低于 2.5。即便如此，量级结论成立：**uReview 的评论密度是「每个改动个位数条」，非常克制**，可作为我们的初始目标。
- **实际拿到反馈的评论量**：25,000 × 10% = **约 2,500 条/周**。这就是 §5 三维阈值调参的真实样本供给量——摊到 3 assistant × 6 语言 × N category 的格子里，**大量格子每周只有个位数样本**。这解释了为什么阈值不可能靠纯自动拟合，也是我们设计时要正面处理的稀疏性问题。
- **2025 → 2026 的 addressal rate**：65% → 67%，**基本持平**。【推】一年的工程投入主要换来的是**规模扩张和成本下降**（#17 的 -60%），不是 addressal rate 的提升。这对预期管理很重要：**这类系统的采纳率有天花板**。

---

## 10. 静态检查的边界：Uber 怎么划线

### 10.1 原文

【U】S1 有专门一节 "Enforcing Best Practices Using GenAI Versus Linters"：

> "Traditionally, linters (or static analysis tools) have been used to enforce certain best practices. **For simple or syntactic patterns, linters are accurate, reliable, and cheap—we should continue using them.** However, some properties are hard to check with linters. For example, the Uber Go style guide recommends using the time library for time-related operations. Here, **one needs some semantic code understanding to know that a certain integer variable represents time**, and LLMs perform far better in these cases. So, **best practices that aren't checkable by linters are often a great fit for LLMs**."

### 10.2 这条线划在哪

【U】判据是**语法 vs 语义**，不是「简单 vs 复杂」：

- **语法/结构模式可判定** → linter。理由三个词：accurate、reliable、cheap。
- **需要推断「某个值代表什么」** → LLM。

那个 time 库的例子是精确的：linter 能查 `time.Duration` 用得对不对（类型层面，语法可判），但查不出「这个 `int` 变量其实是个毫秒数」（需要语义理解）。

【U】我核对了 Uber Go Style Guide（S5）确认该规则存在：

> "Always use the `"time"` package when dealing with time because it helps deal with these incorrect assumptions in a safer, more accurate manner."

且指南明确要求：用 `time.Time` 表示时刻、`time.Duration` 表示时长；确实必须用整数与外部系统交互时，**必须把单位写进字段名**。后者正是 linter 查不了、LLM 能查的那类约定。

### 10.3 2026 年这条线变模糊了：AI linter

【U】S3 [8:04] 出现了一个中间形态（§3.2 第 3 层）：

> "**AI linters**. These are basically **few shot** system where developers can basically kind of **deterministically get more context and then run rules with that context and like a file** and find some **systematic and mechanical** issues."

【推】这是把「确定性地取上下文」和「用 LLM 判规则」缝在一起：**取证靠确定性程序（这是 linter 擅长的），判定靠 few-shot 模型（这是 LLM 擅长的）**。适用于「规则本身机械、但判定需要的上下文散落在别处」的场景——纯 linter 取不到上下文，纯 LLM 取上下文不可靠。

【推】所以 2026 年的边界是**三分**而不是二分：

| 形态 | 取上下文 | 判定 | 适用 |
|---|---|---|---|
| 传统 linter | 确定性 | 确定性 | 语法/结构模式 |
| **AI linter** | **确定性** | **模型（few-shot）** | 机械但需跨处上下文的规则 |
| Agent review | 模型自己找 | 模型 | 需要理解语义、跨文件推理 |

### 10.4 第二条闸：预处理过滤

【推】除能力边界外，uReview 还有一条**成本/噪声边界**：预处理阶段把 config、生成代码、实验目录**整个排除**在 LLM 之外（§3.4）。这不是「linter 能做所以不用 LLM」，而是「这里根本不值得 review」。

所以实际上是**两道闸**：①值不值得 review（预处理过滤 + 2026 的 risk/complexity 路由）；②值得的里面，语法可判交 linter，需语义推断交 LLM（中间地带交 AI linter）。

【空】Uber 没说的**衔接方式**：linter 结果会不会喂给 LLM 当上下文？同一问题 linter 和 LLM 都报了怎么办？"shared registry of style rules" 是不是 linter 和 Best Practices Assistant 共用的那份？这三个问题都无答案，而对我们的设计很关键。

---

## 11. Fixer、代码平台，以及对 GitLab 落地的影响

### 11.1 Fixer：公开信息只有一句话

【U】S1 全文关于 Fixer 的**全部**内容：

> "Building on this, **Fixer proposes actual code changes in response to comments, whether those comments come from humans or AI**. In this blog, we'll focus on Commenter and refer to it simply as uReview."

只能确定两点：
1. 【U】产出是**代码改动建议**（措辞是 propose，不是 apply）。
2. 【U】**输入同时接受人类评论和 AI 评论**。这点挺重要——Fixer 不是 Commenter 的附属后端，是一个独立的「评论 → 补丁」服务。

【U】S2、S3、S4 **均未提及 Fixer**。

【空】其余全部空白：接受率、是否自动提交、是否走 CI 验证、失败怎么回退、是否与 Commenter 共用模型。**ticket 问「Fixer 做到什么程度」的答案是：公开信息只够确认它存在、输入是评论、输出是代码改动建议。**

【推】不过 S4 描述的 **self-healing CI** 和 **inner-loop 修复**（[15:05–15:30]）在功能上与 Fixer 重叠。到 2026 年，「根据评论改代码」这件事可能已经被并进了 agent 的内环，而不再是一个叫 Fixer 的独立组件。**这是推测，无证据。**

### 11.2 代码平台：Phabricator → GitHub 迁移中（2026 已确认）

【U】S1（2025）：

> "most third-party AI code-review tools require code to be hosted on GitHub. **Uber currently uses Phabricator instead of GitHub as its primary code review platform.** This architectural constraint limits our ability to deploy many off-the-shelf AI code review solutions."

【U】S3 [1:34]（2026）**明确说了迁移**：

> "One of those is we **currently use Phabricator and have for a long time and are in the process of migrating to GitHub**. Most of the solutions do not provide support for Phabricator."

【U】而 S3 [3:07] 的架构图顶部同时列了**三个入口：GitHub、Phabricator、agent loop**。

【推】**这对我们是个意外的好消息**：Uber 自己正处在多代码平台并存的状态，因此他们被迫把 uReview 做成了**平台无关的服务 + 多个薄适配层**。这正是我们需要的形状——我们要接 GitLab，等于复用他们已经被迫做出的抽象。

【U】自研的其他理由（S1 + S3）：第三方工具在 Uber 代码上**误报多、低价值真阳性多、无法接入内部系统**；成本高一个数量级；【U】S3 补充两条 2025 没有的：**要让内环 agent 和人类拿到同一套 review 规则**（[1:46]）；**几百个团队无法集中管理规则，必须挂到已有的 ownership 系统上分发**（[2:04]）。

【U】S1-F1 截图证实 2025 年是 Phabricator 形态的行内评论：机器人账号名 **`ureview`**，评论带 **Done / Not Done** 状态下拉。

### 11.3 CI 时机而非 IDE

【U】S1 专门论证过：

> "Even though some IDEs (or extensions) offer code reviews, we still want AI reviews on the code review platform (**CI time**) because **we have less control over what the developer does locally. They may not use the AI code-review features or may ignore its warnings.** This is analogous to running build and test at CI time in addition to making them available locally."

【推】这条对企业内部平台是直接可用的论据：**强制性来自位置，不来自说服。** 放 IDE 里是可选的，放 CI 里是必经的。

【U】但 2026 年**补了一层而不是推翻它**（S4 [15:16]，Adam Huda）：

> "We've **moved parts of code review to happen in the inner loop**. The **outer loop code review can have a powerful model, use reasoning, a skill to do a deeper review**, and **in the inner loop, we can have a smaller model that runs faster**."

【U】即：**同一套规则，两个执行点，不同模型档位**。内环用小模型快速跑，外环（CI）用强模型 + reasoning 做深审。这与 S3 [1:46] 的「内环 agent 和人类要拿到同一套 review」是一回事。

### 11.4 Inner loop vs outer loop：对精度要求的反直觉结论

【U】S3 [11:11–12:46]，Will Bond。这段对我们设计阈值策略很关键：

> "with the **inner loop, our accuracy needs actually need to go up**, or else we can result in dealing with **cavitation of an agent** where it **fixes something, goes back, gets another code review, and has to kind of like fix backwards** because the quality of the comment was low."

> "agents are **more than happy to go through and fix 100 nits** on a pull request where your **engineers really get frustrated** in situations like that."

【U】两条正交的结论：

| 维度 | 内环（agent 消费） | 外环（人类消费） |
|---|---|---|
| **精度要求** | **更高**。低质量评论会让 agent 来回改、反复抖动（"cavitation"） | 相对低。人能自己判断并忽略 |
| **数量容忍度** | **高**。agent 乐意改 100 个 nit | **低**。人会烦 |

【推】这直接推翻了「面向 agent 的 review 可以糙一点」的朴素直觉。含义是：**阈值不能只按 assistant×language×category 分，还要按「谁消费这条评论」分**。同一条评论，发给人和发给 agent，该用不同阈值——而且**发给 agent 的那个阈值要更严**。这是 §5 那个三维阈值空间应该加上的第四维。

【U】Uber 还点了一个他们**没有解决**的开放问题（S3 [12:47–13:35]）：人类反馈是整个调参系统的信号源；当人类退出 review 环，**信号就没了**。他们给的答案是「不是杀死外环，而是把外环上移」——人从实现细节移到架构、领域知识和产品判断。【推】这是方向性的表态，不是机制。**对我们而言，短期内人类仍在环内，这个问题可以先不解决，但反馈管道的设计不应该假设人类永远在。**

### 11.5 对我们迁到 GitLab 的实际影响

以下是我的分析，**不是 Uber 的结论**：

| uReview 的依赖 | Uber 侧形态 | GitLab 对应 | 迁移代价 |
|---|---|---|---|
| 行内评论投放 | Phabricator inline comment / GitHub review comment | MR Discussion（`POST /projects/:id/merge_requests/:iid/discussions`，带 `position`） | **低**。GitLab 支持行级 discussion |
| 评论状态跟踪 | Done / Not Done 下拉 | Discussion 的 resolved / unresolved | **低**，语义几乎对等 |
| 0–10 评分控件 | 自定义渲染在评论正文里 | GitLab 无原生评分控件 | **中**。可选：① emoji award 反应（粒度粗）② 评论内嵌 11 个带 token 的链接指向我们自己的服务——**这正是 Uber 的做法**（S1-F1 里那排 0–10 就是渲染出来的链接） |
| **回复情感分类**（§8.3 v2） | 分析开发者在评论下的自然语言回复 | GitLab Discussion 的 notes 全量可读 | **低**。**这是性价比最高的一条**：不需要任何 UI 改动，开发者本来就会回复 |
| CI 触发 | Phabricator/GitHub + CI | GitLab CI `merge_request_event` 或 webhook | **低** |
| 五次重跑评估（§8.1） | 与平台无关 | 与平台无关 | **零**。最值得优先抄，因为不依赖任何平台特性 |
| 元数据落仓（Kafka→Hive） | Uber 内部栈 | 我们自己的栈 | **中**，但 schema 可照抄：assistant 来源 / category / confidence / 反馈 |
| **挂到 ownership 系统分发规则**（S3 [2:04]） | Uber 内部 ownership | GitLab 的 group/project 层级 + CODEOWNERS | **中**。GitLab 的原生层级其实比较好用 |
| 多入口抽象（GitHub/Phabricator/agent loop） | Uber 已做 | 我们只需 GitLab + agent loop 两个 | **低**（我们比 Uber 少一个平台） |
| 「接入内部系统」的能力 | Uber 内部 | 需自建 | **高**，但这也正是自建的价值所在 |

【推】**结论：uReview 的精度控制链路与代码平台几乎正交。** Generator / Grader / Dedup / Category Filter / 五次重跑评估，没有一个依赖 Phabricator 或 GitHub。平台相关的只有「评论怎么贴」「反馈怎么收」两个薄适配层。而且因为 Uber 自己在做 Phabricator→GitHub 迁移、还要同时服务 agent loop，**他们公开的架构已经是多平台抽象过的形态**，对我们接 GitLab 反而更友好。

---

## 12. 未能取得或无法验证的内容

如实说明：

- **Grader 的评分维度 / rubric / prompt 结构**：三份一手材料都没有。S6（AIE 编辑）也明确指出演讲未涉及。
- **任何具体的阈值数值**：只公开了粒度（assistant × language × category）和调参输入，没有任何数值。
- **去重算法**：只有 "semantic similarity filter" 这一个词组。无相似度度量、无阈值、无模型。
- **Fixer 内部**：仅 S1 一句话，其余三份材料均未提及。
- **S2-F5 里的真实模型名**：2026 年起已匿名化为 Frontier / Open-Weight A/B/C，查不到。
- **S3 里「质量与准确率 +70%」的定义**：S6 明确评注其未定义度量、未说明测量窗口、未澄清是相对提升还是百分点变化。**不可复现，本文已标注风险。**
- **"Multi-Agent" 是否有实质的 agent 编排**：S3 标题如此，但 S3 和 S4 都**没有**描述 agent 间协作、交接或编排。【推】此处 "Multi-Agent" 约等于「多个并行 generator + 后处理链」。
- **"shared registry of style rules" 的形态**：五个词，无 schema、无检索方式、无与 linter 的关系。
- **无 uReview 相关学术论文**：核查了 Sonal Mahajan 个人主页（最新公开论文为 2022 年，与 uReview 无关）及其 MSR 2025 记录（仅有一篇 CI 相关的 ICSE 2025 SEIP 论文）。Uber 未就 uReview 发表论文。
- **AI Engineer World's Fair 2025 无 uReview 演讲**：AIE 的 Uber 组织页仅列 3 场演讲，2026 年这两场加一场与 code review 无关的。
- **The Pragmatic Engineer 那篇有付费墙**，免费段仅一句提及，无技术内容。

---

## 13. 可复刻性评估

按「能不能直接照做」分三档。

### A 档：细节足够，可以直接照做

| 项 | 为什么够 |
|---|---|
| **五次重跑的 addressed 自动评估**（§8.1） | 触发点、次数、次数的选择理由、判定规则、边界情况全都写了。且不依赖任何平台特性。**全篇最高性价比的一条** |
| **Generator × Grader 成对做 benchmark 选型**（§7） | 方法完整：样本来源（真实含 bug 的 PR）、**难度分层 easy/medium/hard**、指标集（precision/recall/F1 + cost/latency/timeouts/noise）、Pareto 前沿选点、周期性重跑、统一 harness 的架构要求。照着能搭 |
| **可观测性演进阶梯**（§8.3） | 四级路线图，每级采集什么、解决了什么都有原话。**这是路线图级别的可复刻内容**，比架构图更实用 |
| **回复情感分类作为被动反馈信号**（§8.3 v2） | 机制清楚（对开发者回复分 positive/negative 再分类），价值明确（产出可解的 bug 类别），且在 GitLab 上零 UI 成本 |
| **四阶段串行后处理的整体形态**（§2.2） | 有官方流水线图，框和顺序明确，且知道哪几步走 LLM |
| **元数据落仓 schema**（§8.4） | assistant 来源 / category / confidence / 开发者反馈，四个字段。够用 |
| **负反馈 → 负例回归集**（§8.4） | 机制说清楚了：被差评评论所在文件成为「不该复现」的回归用例 |
| **低价值 category 的初始名单**（§6.2） | 差：readability nits、minor logging tweaks、low-impact perf、stylistic。好：correctness bugs、missing error handling、best-practice violations。可直接当第一版黑白名单 |
| **linter / AI linter / agent review 三分法**（§10） | 判据清晰（取上下文靠谁、判定靠谁），且有具体例子佐证 |
| **CI 时机而非 IDE + 内外环双执行点**（§11.3） | 论据完整，且 2026 年补的「同规则、两执行点、不同模型档位」可直接采用 |
| **内环精度要求高于外环**（§11.4） | 结论明确，原因（agent cavitation）说清楚了，可直接作为阈值分层的依据 |

### B 档：有轮廓和约束，参数要我们自己定

| 项 | 有什么 | 缺什么 |
|---|---|---|
| **Grader**（§4） | 一条评论一次调用、输出单一 confidence score、prompt 按 assistant 定制、用独立于 generator 的模型；以及误报的二分类问题定义 | prompt 结构、**评分维度**、值域、是否输出 reasoning、是否多次采样。**评分维度这个核心问题没有答案** |
| **三维阈值**（§5） | `assistant × language × category` 三维分格、目标是守住 75% usefulness、靠 A/B 调、一天内可上线；2026 年补了上游的确定性路由（团队→review 类型/模型/generator） | 初始值、冷启动、自动重标定、**稀疏格子处理**（§9.3 算出每周仅约 2,500 条带反馈样本，格子必然稀疏）、A/B 判定标准 |
| **语义去重**（§6.1） | LLM 实现（非 embedding）、动作是 merge 非 drop、位置在 grader 之后、跨 generator 统一处理、输出会声明「也适用于别处」 | 相似度判定粒度、合并后挂哪行、合并上限、保留哪条的 confidence |
| **Category 分类器**（§6.2） | LLM 实现、`domain:subtype` 两级、两个实例、自动关停低价值类；2026 年新增 severity 维度 | 完整分类表、类目数量、多标签与否、"low value" 量化门槛、severity 分档 |
| **Generator 分层**（§3.2） | 2026 四层（single-file / multi-file agent / AI linter / custom agent）各自职责与适用范围清楚 | 每层的 prompt、AI linter 的 few-shot 组织方式、custom agent 的 skill 规范、路由到哪层的判据 |
| **上下文构造**（§3.3） | 邻近函数 + 类定义 + import + diff；明确不含 PR 历史 / schema / 文档；2026 年补了「团队反模式烘焙进 agent」和「告诉 agent 什么不要做」两条 | 窗口大小、取几层、截断策略、多 hunk 处理、guardrail 的具体写法 |
| **文件过滤 / 风险路由**（§3.4） | 三类排除（config / 生成代码 / 实验目录）；2026 年的「按 risk profile 和 complexity 决定审多深」 | 规则语法、生成代码识别方式、「实验目录」定义、risk profile 怎么算 |

### C 档：只有一句话或更少，等于全部自己设计

| 项 | 公开信息量 |
|---|---|
| **Fixer**（§11.1） | 一句话。只知道存在、吃人类和 AI 两种评论、产出代码改动建议 |
| **style rules registry**（§3.2） | 五个词。存储形式、schema、检索方式、与 linter 的关系，全空 |
| **grader 的评分维度**（§4.2） | 零。只有 "quality" 一个词 |
| **阈值冷启动**（§5.5） | 零 |
| **当前生产模型**（§7.3） | 2026 年起已匿名化 |
| **人类退出后的反馈信号替代方案**（§11.4） | Uber 自己承认没解决 |

### 落地建议

**先做 A 档里的两件事：五次重跑的 addressed 评估 + benchmark/Pareto 选型。** 理由：这两件都不依赖 Generator 做得好不好，却是后面所有调参的**度量基础**——没有它们，Grader 和阈值根本无从调起。

**第三件事做回复情感分类**（§8.3 v2）。它在 GitLab 上零 UI 成本（读 discussion notes 即可），却是 Uber 从「质量成本比到处飞」走出来的那一步。

Grader 本身（B 档）可以先用最朴素的「单分 + 全局阈值」上线，等三维数据攒够了再分格。这也正是 Uber 的顺序：**先有 dashboard 和反馈管道，再谈 fine-grained threshold**——他们的 v1 连 grader 都没有（§2.1）。

最后一条提醒：§9.3 算出来的「每周约 2,500 条带反馈评论」是个硬约束。**我们的规模只会比 Uber 小**，所以阈值分格的稀疏性问题会比 Uber 更严重。**分格粒度应该从粗到细逐步细化，而不是一上来就照抄三维。**

---

## 附：原文定位索引

便于后续直接引用。S1/S2 为博客正文（无锚点，按小节定位），S3/S4 为演讲转录时间戳。

| 小节 | 出处 |
|---|---|
| 流水线四子任务 | S1 "How It Works" 开头 |
| 文件过滤 / 上下文构造 | S1 "Ingestion and Preprocessing" |
| 三类 assistant | S1 "Comment Generation by Specialized Assistants" |
| grader / 阈值 / 去重 / category filter | S1 "Post-Processing and Quality Filtering" |
| 0–10 评分控件 | S1-F1 配图 |
| 反馈链路 / 负例回归集 | S1 "Comment Delivery and Feedback Collection" |
| 五次重跑 / golden benchmark | S1 "Evaluation and Continuous Improvement" |
| 2025 生产数字 | S1 "Impact and Evaluation" 及三个子节 |
| Phabricator / 自研理由 / 成本 | S1 "Third-Party Tools" |
| 低价值 category / 上下文边界 / 灰度 / IDE vs CI / linter 边界 | S1 "Lessons Learned" 六个子节 |
| Fixer | S1 "Introduction" 第二段 |
| benchmark 构造 / 选型流程 / Uber SWE Benchmark | S2 "Benchmark-Driven Model Selection" |
| uReview 分层定位与计量单位 | S2-F3 配图 |
| 成本×F1 散点 | S2-F5 配图 |
| 组织规模 / 首次 review 等待 3h→9h | S3 [0:33]–[1:21] |
| 自研五个理由 / Phabricator→GitHub 迁移 | S3 [1:21]–[2:57] |
| 2026 架构（三入口 / 路由 / 多 generator / 后处理四动词） | S3 [2:57]–[4:20] |
| v1 形态 / 可观测性四级演进 / 「模型不知道自己错了」/ guardrail | S3 [4:24]–[7:20] |
| 四层 reviewer 栈 / ownership 分发 / 确定性路由 / 反馈回流给规则作者 | S3 [7:20]–[10:12] |
| 2026 生产数字 | S3 [10:13]–[11:02] |
| 内环 vs 外环 / cavitation / 反馈信号消失 | S3 [11:11]–[14:47] |
| 内外环双执行点、不同模型档位 | S4 [15:16] |
| diff 是否合入 = 免费标注数据 | S4 [16:49] |
