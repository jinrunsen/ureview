# OpenReview 的 agent runtime 与 skills 渐进加载 —— 源码拆解

- 对应 ticket：[`../issues/06-openreview-的-agent-runtime-与-skills-渐进加载.md`](06-openreview-runtime-拆解.md)
- 调研时间：2026-09-11
- 调研对象：`vercel-labs/openreview`，commit `672deb21e70e471e0536d5ad7a67c14b8359e97e`（2026-03-06，仓库 HEAD）
- 辅助源码：`vercel/workflow` 的 `packages/ai/src/agent/durable-agent.ts`、`packages/ai/src/agent/stream-text-iterator.ts`（默认分支）
- 官方文档：`vercel.com/kb/guide/vercel-agent-code-review`、`vercel.com/docs/agent/pr-review`、`vercel.com/docs/sandbox`、`vercel.com/docs/sandbox/pricing`

下文所有源码路径都相对 openreview 仓库根。行号以上述 commit 为准。

---

## 0. 一页结论

OpenReview 的整体代码量很小：`lib/` 7 个 + `lib/tools/` 5 个 + `workflow/` 1 个入口和 13 个 step，核心逻辑合计 1303 行。它的「做法」可以概括成一句话：

> **不做 review engine，只做 agent runtime。把 PR 语境塞进一个装了仓库和 `gh` CLI 的沙箱，给 agent 四把工具，让它自己去 diff、自己去查、自己调 GitHub API 发评论。**

具体的：

| 维度 | OpenReview 的做法 | 我们能不能照抄 |
| --- | --- | --- |
| 触发 | 只在 PR 评论里 `@openreview` 时触发，不自动跑 | 可抄，但我们要自动触发 |
| Sandbox | Vercel Sandbox（Firecracker microVM），`depth:1` clone PR 分支，5 min + 3 min 续期，`finally` 里停 | 做法可抄，实现要换 |
| 工具面 | 只有 4 把：`bash` / `readFile` / `writeFile` / `reply`，外加 `loadSkill` | **工具面比想象中窄**，值得抄 |
| diff 获取 | 不预取，让 agent 自己跑 `gh pr diff` | 有意为之（commit `3882f41`），值得想清楚 |
| finding 结构化 | **完全没有**。没有 schema、没有 finding 对象、没有行号定位逻辑 | 不能抄，这是它最大的短板 |
| inline comment | agent 自己拼 `gh api .../pulls/N/comments -f line=N` | 不能抄 |
| 改代码 | `writeFile` + bash，跑完 `git add -A && git commit --no-verify && git push` | 护栏要补 |
| 精度控制 | 只有 prompt 里一句 "Don't nitpick style or formatting" | **没有 Grader**，这正是我们要补的 |
| skills | `.agents/skills/*/SKILL.md`，目录只进 name+description，`loadSkill` 按需取正文 | **机制可抄，但它的实现有三处断点**（见 §4.6） |

对「动态规范」最直接的一句话：**skills 的三层渐进加载在设计上是对的，但 OpenReview 只实现了两层半，第三层（`rules/*.md`，102 个规则文件）在它自己的运行环境里读不到**。详见 §11。

---

## 1. 整体链路

```
PR 评论 @openreview
  → app/api/webhooks/route.ts（Next.js Route Handler）
  → lib/bot.ts   Chat SDK 的 GitHub adapter，校验 webhook 签名 + 识别 mention
  → botWorkflow（workflow/index.ts:31）  "use workflow"，Vercel Workflow 持久化执行
      ├─ checkPushAccess       前置权限闸门
      ├─ getGitHubToken        installation token
      ├─ createSandbox         clone PR 分支
      ├─ installDependencies   装 gh CLI + 项目依赖
      ├─ configureGit          改 remote、禁 hooks、设 bot 身份、gh auth login
      ├─ extendSandbox         +3 min
      ├─ runAgent              ← agent loop 在这里
      ├─ hasUncommittedChanges
      ├─ commitAndPush         有改动才走
      └─ stopSandbox           finally
```

几个入口细节：

**触发只有两条路径**（`lib/bot.ts:113-153`）：

- `onNewMention` / `onSubscribedMessage`：评论里 `@<app-slug>` → `handleMention`（`lib/bot.ts:44`）。
- `onReaction([👍, ❤️])`：对 **bot 自己发的** 评论点赞 → 重新起一遍 **完整 workflow**（`lib/bot.ts:123-143`）。

  注意这里没有「哪条建议被点赞了」这种结构化关联。它的做法是把整个 thread 的消息重新收集一遍（`collectMessages`，`lib/bot.ts:16-29`）当作 `messages` 传进去，指望模型从上下文里自己推断「用户认可了刚才那条建议，去执行它」。**这是一个纯靠上下文的隐式协议，没有任何 ID 级别的绑定。**
- 👎 / 😕 只回一句话，不起 workflow（`lib/bot.ts:145-153`）。

**thread 全量回灌**：`collectMessages` 把 thread 里所有消息（含 bot 自己发过的，标成 `role: "assistant"`）当作对话历史。这也是它唯一的「去重」机制——agent 能看到自己上一轮说过什么，所以理论上不会重复提同一个问题。但这是软约束，没有任何硬性去重。

**没有自动触发**：issue #4 就是在要这个。目前 PR 打开、push 新 commit 都不会触发 review。

---

## 2. Sandbox

### 2.1 怎么起、怎么 clone

`workflow/steps/create-sandbox.ts:15-25`：

```ts
const sandbox = await Sandbox.create({
  source: {
    depth: 1,                                // 浅克隆
    password: token,                         // installation token
    revision: branch,                        // 直接 checkout PR 分支
    type: "git",
    url: `https://github.com/${repoFullName}.git`,
    username: "x-access-token",
  },
  timeout: FIVE_MINUTES_MS,                  // 第 5 行：5 * 60 * 1000
});
```

值得注意的：**clone 是 Sandbox SDK 做的，不是自己跑 `git clone`**。`source: {type: "git"}` 是 Vercel Sandbox 的原生能力，token 走 `username`/`password` 而不是 URL，所以 token 不会进 shell history。

`depth: 1` 且只 fetch PR 分支 —— 这意味着 **base 分支不在本地**。早期版本有个 `workflow/steps/get-diff.ts`，会 `git fetch origin <base> --depth=1` 然后 `git diff origin/base...HEAD` 预取 diff 塞进 system prompt。commit `3882f41`（"Defer diffing to agent"）把这一整个 step 删掉了，改成在 prompt 里写：

```
## Getting Started
- Start by running `gh pr diff {{PR_NUMBER}}` to see what changed in this PR
```

（`lib/agent.ts:61-62`）

**这个改动值得单独记一笔**：把 diff 从「预取塞 prompt」改成「让 agent 自己调 API 取」。好处是 agent 可以按需分批取（`gh pr view --json files` 先看文件列表，再针对性 `gh pr diff`），大 PR 不会一次性撑爆 prompt；坏处是多花一轮 tool call，而且 diff 内容会作为 tool result 落进对话历史，同样吃 context（还会被 §5 的 10 KB 截断切掉）。对我们的「大 PR 压缩」ticket（12 号）来说，OpenReview 的做法是 **不压缩，把取多少的决定权交给模型**。

### 2.2 生命周期与超时

- 创建时 `timeout: 5 min`（`create-sandbox.ts:5`）
- agent 跑之前 `extendTimeout(3 min)`（`workflow/steps/extend-sandbox.ts:5,22`）
- **总窗口 = 8 分钟**，而且 `extendSandbox` 只调一次，agent loop 中途没有续期逻辑
- `stopSandbox` 在 `finally` 里（`workflow/index.ts:106-108`），无论成败都停

超时怎么处理？**没处理。** 沙箱到点被平台回收，之后任何 `Sandbox.get({sandboxId})` 都会抛，`runBashStep` 抛出的错误会冒泡到 `runAgent` 的 catch（`workflow/steps/run-agent.ts:95-100`），返回 `{success:false}`，workflow 抛 `FatalError`，然后在 PR 上贴一条 `## Error` 评论（`workflow/index.ts:86-105`）。对用户来说就是「review 挂了」，没有部分结果保留 —— 除非 agent 在挂之前已经调过 `reply` 或 `gh api` 发过评论（这些是立即生效的副作用）。

**这是个设计后果值得注意**：因为 agent 是「边跑边发评论」而不是「跑完统一发」，超时的时候会留下半截 review。

### 2.3 隔离与成本

来自 `vercel.com/docs/sandbox` 和 `/docs/sandbox/pricing`：

- 隔离级别：每个 sandbox 一个 **Firecracker microVM**，独立文件系统和网络，可以跑 root、跑 Docker、跑 FUSE
- 默认镜像 `vercel/sandbox/universal`（Node LTS + Python 3.14 + 常见工具）
- 默认 2 vCPU / 4 GB，Pro 上限 8 vCPU / 16 GB，磁盘 64 GB
- 默认 timeout 5 min；单 session 最长 Hobby 45 min / Pro 24 h
- 并发：Hobby 10，Pro 10,000
- 计费四个维度：Active CPU $0.128/h（等 I/O 不计费）、Provisioned Memory $0.0212/GB-h（最小 1 min 计）、Creations $0.60/M、出站流量 $0.15/GB（**下载免费**，所以 `npm install`、`git clone` 不花流量钱）
- 官方给的参照：「AI code validation，5 min，2 vCPU，4 GB」≈ **$0.03**

也就是说 **单次 review 的沙箱成本大约 3 分钱，可以忽略**。成本大头完全在 token 上（§5.3）。

对我们的启示：沙箱这一层不用纠结成本，该纠结的是 **并发上限** 和 **冷启动时长**。OpenReview 每次 review 都重新 clone + `npm install`，这部分时间全在 8 分钟窗口里烧。Vercel Sandbox 有 snapshot / persistent sandbox 能跳过依赖安装，OpenReview 没用。如果我们自建（K8s Job / Firecracker / gVisor），**「按仓库缓存一个装好依赖的基础镜像或快照」是第一个该做的优化**。

### 2.4 环境准备

`workflow/steps/install-dependencies.ts`：

1. 装 gh CLI（`:52-60`）：`command -v gh || (curl 下载 v2.62.0 tar.gz → 解到 ~/.local/bin)`。**版本写死**，失败就抛。
2. 探测包管理器（`:5-34`）：按 `bun.lock` → `pnpm-lock.yaml` → `yarn.lock` 顺序 `test -f`，都没有就 `npm install`。全部用 `--frozen-lockfile`。
3. 非 npm 的话先 `npm install -g <cmd>` 再装依赖。

**这是纯 JS 生态的假设**。没有 Python / Go / Java / Maven / Gradle 的分支。issue #2 抱怨的「不够框架无关」其实从这里就开始了。

`workflow/steps/configure-git.ts:10-35`：

```ts
git remote set-url origin https://x-access-token:<token>@github.com/<repo>.git
git config --local core.hooksPath /dev/null   // ← 关键：禁掉仓库自带的 git hooks
git config user.name  "openreview[bot]"
git config user.email "openreview[bot]@users.noreply.github.com"
echo "<token>" | gh auth login --with-token
```

`core.hooksPath=/dev/null` 值得抄：**被 review 的仓库是不可信输入，它的 `.husky/pre-commit` 不该在你的沙箱里跑**。（不过后面 `commit-and-push.ts` 又加了 `--no-verify`，属于双保险。）

有一处安全瑕疵：token 通过 `bash -c "echo \"${token}\" | gh auth login"` 传（`configure-git.ts:32-35`），拼进了 shell 命令串。同时 `git remote set-url` 把 token 写进了 `.git/config` —— **agent 有 `bash` 工具，可以 `cat .git/config` 直接读到 installation token**。这个 token 对整个 installation 的所有仓库有 contents:write 权限。在我们的场景里这是必须堵的口子。

---

## 3. 工具面

一共 5 个工具（`lib/agent.ts:84-90`）：

| 工具 | 文件 | 边界 | 超时 | 失败处理 |
| --- | --- | --- | --- | --- |
| `bash` | `lib/tools/bash.ts` | **无白名单、无黑名单**，任意命令 | **无** | 返回 `{exitCode, stdout, stderr}`，非 0 不抛，交给模型判断 |
| `readFile` | `lib/tools/read-file.ts` | 任意路径，`/` 开头当绝对路径 | 无 | 文件不存在 → `throw`，冒泡终止整个 agent |
| `writeFile` | `lib/tools/write-file.ts` | 任意路径 | 无 | **参数错位，见 §9.1** |
| `reply` | `lib/tools/reply.ts` | 发一条 PR 顶层评论 | 无 | 失败冒泡 |
| `loadSkill` | `lib/tools/load-skill.ts` | 纯内存查表 | 无 | 找不到返回 `{error, 可用列表}`，**不抛** |

### 3.1 没有 grep / test / lint 专用工具

这是最值得注意的一点：**`bash` 就是全部**。没有 `grep` 工具、没有 `runTests` 工具、没有 `lint` 工具。lint 是靠 system prompt 教的（`lib/agent.ts:40-44`）：

```
## Linting & Formatting
- Run the project's linter and/or formatter when asked
- Check package.json scripts for lint/format commands (e.g. "check", "fix", "lint", "format")
- If no project-specific commands exist, fall back to `npx ultracite check` or `npx ultracite fix`
```

grep 也是靠 `bash` 工具的 description 教的（`lib/tools/bash.ts:31-36`，写在 tool description 里的「Common operations」小抄）。

**取舍分析**：单一 `bash` 的好处是工具面小、模型不用学一堆 schema、任何项目工具链都能用。坏处是：

- 没法对单个操作设超时。`bash.ts` 里 `sandbox.runCommand` 没有任何超时参数，一个 `npm test` 跑死就吃掉整个 8 分钟窗口。
- 没法做结构化输出。lint 结果是一坨 stdout，模型要自己解析。
- 没法审计。事后没法回答「这次 review 读了哪些文件、跑了哪些命令」，除非去扒 workflow 的 step 日志。
- 安全上没有任何约束（见 §2.4 的 token 泄露）。

对我们的建议：**保留 `bash` 作为兜底，但把高频、需要结构化结果的操作提升成一等工具**（`grep` 返回 `{file, line, text}[]`，`runLint` 返回 parse 过的 diagnostics）。既能给模型更干净的输入，也能让每个工具带自己的超时和审计。

### 3.2 `bash` 的执行包装

```ts
const fullCommand = `export PATH="$HOME/.local/bin:$PATH" && cd "${SANDBOX_CWD}" && ${command}`;
await sandbox.runCommand("bash", ["-c", fullCommand]);
```

（`lib/tools/bash.ts:14-15`，`SANDBOX_CWD = "."`）

每次都重新 `cd .` —— **没有会话状态**，`cd` 到别的目录在下一次调用不会保留。这其实是对的（无状态更好 replay），但 tool description 里没说清楚，模型容易踩。

### 3.3 `"use step"` 的意义

每个工具的执行体都标了 `"use step"`（`bash.ts:11`、`read-file.ts:10`、`write-file.ts:12`、`reply.ts:10`）。这是 Vercel Workflow 的编译指令：把这个函数注册成一个持久化 step，结果写进 workflow 的日志。带来的后果：

- **重放安全**：workflow 因为部署/崩溃中断后重启，已经执行过的 tool call 直接从日志读结果，不会重复执行。对 `reply`（会真的发评论）和 `writeFile`（会真的改文件）这种有副作用的工具，这是刚需。
- **代价**：每个 tool result 都要能序列化。所以 `loadSkill` 的 `content` 必须是纯字符串（见 §4.6）。

我们用 dsh 的话没有这套编译期魔法，需要自己想清楚「agent 中途挂了怎么办」：要么幂等重跑，要么自己记 tool call 日志。**至少 `reply` / `postComment` 这类外部副作用必须做幂等键**，否则重试会刷屏。

---

## 4. Skills 渐进加载（重点）

### 4.1 目录结构与文件格式

```
.agents/skills/
├── next-best-practices/
│   ├── SKILL.md              ← 唯一被 runtime 读取的文件
│   ├── file-conventions.md   ← 19 个同级参考文件
│   ├── rsc-boundaries.md
│   └── ...
├── vercel-react-best-practices/
│   ├── SKILL.md
│   ├── AGENTS.md             ← 全量编译版（83 KB）
│   ├── README.md
│   └── rules/                ← 58 个规则文件，一规则一文件
│       ├── async-parallel.md
│       ├── bundle-barrel-imports.md
│       └── ...
└── ...（共 7 个 skill）
```

`SKILL.md` 格式（YAML frontmatter + markdown 正文）：

```markdown
---
name: my-custom-skill
description: When to use this skill — the agent reads this to decide whether to load it.
---

# My Custom Skill
...
```

只有 `name` 和 `description` 是必需的，缺任何一个直接 `throw`（`lib/skills.ts:20-22`）。其他字段（`license`、`metadata`、`user-invocable`、`argument-hint`）出现在实际 skill 里，但 **OpenReview 完全不解析**。

还有一个 `skills-lock.json`（仓库根），记录每个 skill 的 `source`（`vercel-labs/next-skills` / `vercel-labs/agent-skills`）+ `computedHash`。这是 skills.sh 生态的 CLI 产物，**OpenReview 运行时完全不读它**，纯粹是给 `npx skills` 同步用的。

### 4.2 发现：`discoverSkills`

`workflow/steps/discover-skills.ts:7-53`：

```ts
export const discoverSkills = async (directories: string[]): Promise<SkillMetadata[]> => {
  "use step";
  for (const dir of directories) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { continue; }                              // ← 目录不存在，静默跳过
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;            // ← 只扫一层子目录，不递归
      const skillFile = join(dir, entry.name, "SKILL.md");
      try {
        const raw = await readFile(skillFile, "utf8");
        const { body, description, name } = parseFrontmatter(raw);
        if (seenNames.has(name)) continue;           // ← 按 name 去重，先到先得
        seenNames.add(name);
        skills.push({ content: body, description, name });   // ← 正文全量读进内存
      } catch { continue; }                          // ← 解析失败，静默跳过
    }
  }
  return skills;
};
```

调用点是 `workflow/steps/run-agent.ts:26`：

```ts
const skills = await discoverSkills([".agents/skills"]);
```

**这里有一个必须说清楚的事实**：这是 `node:fs`，相对路径，跑在 **OpenReview 自己的 Vercel 部署进程里**，读的是 **OpenReview 这个仓库自己的 `.agents/skills/`**。它 **不是** 从沙箱里读、**不是** 从被 review 的仓库里读。

早期版本写得更明白（`10da8d7:workflow/steps/run-agent.ts`）：

```ts
const skills = await discoverSkills([join(process.cwd(), ".agents/skills")]);
```

后来 commit `f16f19d` 把 `process.cwd()` 去掉了，但语义没变。

**后果**：

1. README 说「supports custom skills via `.agents/skills/`」，但要加自定义 skill，你得 **fork OpenReview 本身并重新部署**。被 review 的业务仓库里放 `.agents/skills/` 是没用的。
2. 一套部署 = 一套 skills。**做不到「按仓库/按团队分发不同规范」**。这对企业内部多团队场景是硬伤。
3. `readdir` 失败静默 `continue` + 返回空数组 → `buildSkillsPrompt` 返回 `""`（`lib/skills.ts:36-38`）→ system prompt 里连 `## Skills` 段都没有 → agent 完全不知道有 skills 这回事，**且没有任何日志或告警**。考虑到 Next.js 的 serverless 打包默认只 trace 被 import 的文件，`.agents/skills/` 这种纯运行时 `fs` 读取的目录很可能压根没被打进函数包（`next.config.ts` 里没有 `outputFileTracingIncludes`）。**这个静默失败路径在生产环境是真实存在的风险。**

### 4.3 注入：agent 初始看到什么

`lib/skills.ts:34-49`：

```ts
export const buildSkillsPrompt = (skills: SkillMetadata[]): string => {
  if (skills.length === 0) return "";
  const skillsList = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return `## Skills

Use the \`loadSkill\` tool to load a skill when the user's request would benefit from specialized instructions. Only the skill names and descriptions are shown here — load a skill to get the full instructions.

Available skills:
${skillsList}`;
};
```

拼到主 instructions 后面（`lib/agent.ts:71-79`）。就这么简单：**一个扁平的 markdown 列表，没有分类、没有分组、没有优先级、没有触发条件**。

实测这 7 个 skill 生成的目录正文只有 **1207 字节 ≈ 300 tokens**。

### 4.4 加载：`loadSkill`

`lib/tools/load-skill.ts:6-26`：

```ts
export const createLoadSkillTool = (skills: SkillMetadata[]) =>
  tool({
    description: "Load a skill to get specialized review instructions. Use this when the user's request matches an available skill.",
    execute: ({ name }) => {
      const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!skill) {
        return { error: `Skill '${name}' not found. Available: ${skills.map((s) => s.name).join(", ")}` };
      }
      return { content: skill.content };
    },
    inputSchema: z.object({ name: z.string().describe("The skill name to load") }),
  });
```

**逐条回答 ticket 里的问题**：

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| 什么触发加载？ | **纯靠模型自主决定**。没有关键字匹配、没有文件类型路由、没有 embedding 检索。模型看 description 列表，自己决定调不调 `loadSkill` | `lib/tools/load-skill.ts` 全文；prompt 里只有一句 "when the user's request would benefit from" |
| 加载后怎么进上下文？ | 作为一条普通的 **tool result** 追加到对话历史。`{content: "<SKILL.md 正文>"}`，经 `JSON.stringify` 序列化 | `stream-text-iterator.ts` 把 tool result push 进 `conversationPrompt` |
| 一次能加载几个？ | **无限制**。没有计数、没有 token 预算、没有互斥。模型可以在一个 step 里并行发 7 个 `loadSkill` 调用，或者分 7 个 step 逐个加载 | 代码里没有任何限制逻辑 |
| 有没有卸载？ | **没有**。加载过的正文永久留在 `conversationPrompt` 里，直到 agent 结束 | 同上 |
| 名字匹配方式 | 精确匹配（忽略大小写）。**没有模糊匹配、没有别名**。写错名字返回 error + 完整可用列表，模型可以自我纠正 | `load-skill.ts:11-19` |
| 找不到会中断吗？ | 不会，返回 error 对象而非 throw。这点做得对 | `load-skill.ts:15-19` |

**一个隐藏的硬上限**：`run-agent.ts:47-78` 的 `prepareStep` 会把任何超过 10,000 字符的 tool result 截断。`loadSkill` 的返回值也走这条路径。实测：

| skill | 正文字节 | `JSON.stringify({content})` 后 | 距 10 KB 阈值 |
| --- | --- | --- | --- |
| next-cache-components | 9,224 | **9,643** | **96.4%，一步之遥** |
| vercel-react-best-practices | 5,988 | 6,131 | 61% |
| next-best-practices | 3,768 | 3,927 | 39% |
| 其余 4 个 | < 4,100 | < 4,200 | < 42% |

也就是说 **单个 SKILL.md 正文一旦超过约 9.7 KB，就会被静默从中间切断**，后半段规则直接消失，模型看到的是 `... (truncated N chars)`。这是一个未被文档化、也未被作者意识到的硬天花板。

### 4.5 实际的 skill 语料规模

```
7 个 skill
├─ 目录（name + description）        1,207 B  ≈    300 tokens   ← 常驻 system prompt
├─ SKILL.md 正文合计                30,365 B  ≈  7,600 tokens   ← loadSkill 能拿到的
├─ rules/*.md（102 个文件）        178,529 B  ≈ 44,600 tokens   ← 拿不到（见 §4.6）
├─ 同级参考 md（19 个文件）         76,578 B  ≈ 19,100 tokens   ← 拿不到
├─ AGENTS.md（3 个全量编译副本）   180,068 B  ≈ 45,000 tokens   ← 拿不到
└─ 全部 md 合计                    476,113 B  ≈ 119,000 tokens
```

对比：单次 review 的 token 预算是 **200,000**（`run-agent.ts:88`）。

**压缩比 1207 : 476113 ≈ 1 : 394。** 这就是渐进加载的全部价值主张：常驻成本 300 tokens，撬动 119K tokens 的语料库。数字本身是站得住的。

### 4.6 三层结构，以及它在 OpenReview 里断在哪

标准的 Agent Skills 渐进加载是三层：

| 层 | 内容 | 什么时候进上下文 |
| --- | --- | --- |
| L1 | `name` + `description` | 始终 |
| L2 | `SKILL.md` 正文（索引/总纲） | 模型调 `loadSkill` 时 |
| L3 | `rules/*.md`、`references/*.md` 等 | 模型读到 L2 里的引用后，用文件工具去读 |

`vercel-react-best-practices/SKILL.md` 就是标准的 L2 索引写法 —— 一张「优先级 × 类别 × 前缀」表 + 58 条规则的 slug 清单，末尾明确写：

```
## How to Use
Read individual rule files for detailed explanations and code examples:
    rules/async-parallel.md
    rules/bundle-barrel-imports.md
```

**但在 OpenReview 里 L3 读不到。** 三处断点：

1. **`loadSkill` 只返回正文，不返回路径。** 早期版本（`10da8d7:lib/tools/load-skill.ts`）是返回 `{content, skillDirectory: skill.path}` 的，还在执行时才 `readFile`。commit `f16f19d` 把它改成了纯内存查表 —— 因为 `discoverSkills` 被标了 `"use step"`，跨 step 传递的必须是可序列化数据，索性在发现阶段就把正文全读进来。**`skillDirectory` 在这次重构里被删掉了。**
2. **就算给了路径也没用。** skills 在 OpenReview 部署的文件系统上，而 `readFile` / `bash` 工具操作的是 **沙箱**（被 review 的仓库）。两个文件系统之间没有任何桥。模型调 `readFile(".agents/skills/vercel-react-best-practices/rules/async-parallel.md")` 会 throw「File not found」，而 `read-file.ts:18` 的 throw 会 **冒泡终止整个 agent**（不像 `loadSkill` 那样优雅返回 error）。
3. **`next-best-practices/SKILL.md` 整篇都是 L3 引用。** 19 个 `See [xxx.md](xxx.md) for:` 条目，正文本身只是一张目录。模型加载它之后拿到的是一张 **全是死链的目录**。`web-design-guidelines/SKILL.md` 更极端 —— 它要求 "Use WebFetch to retrieve the latest rules"，而 agent **根本没有 WebFetch 工具**（只能靠 `bash` 里 curl，prompt 没教）。

**结论：OpenReview 的 skills 实际只有 L1 + L2 两层，L2 里 30 KB 的正文就是全部能进上下文的内容，其中还有相当比例是指向不存在文件的目录。** 那 446 KB 的 L3 语料在这个 runtime 里是死的。

### 4.7 skill 数量多了怎么办？—— 它没有答案

ticket 问的「有没有分类、检索、路由」，逐个回答：

- **分类**：没有。`buildSkillsPrompt` 是扁平 `- **name**: description` 列表。
- **检索**：没有。没有 embedding、没有 BM25、没有关键字索引。
- **路由**：没有。不按改动文件的语言/路径做预筛。一个纯 Go 仓库的 PR 照样会被展示这 7 个 React/Next 的 skill。
- **优先级**：没有。列表顺序就是 `readdir` 的返回顺序（大致字典序）。
- **冲突处理**：只有一条「同名先到先得」（`discover-skills.ts:36-40`）。

所以 **唯一的路由机制就是 description 文本本身 + 模型的判断力**。这在 7 个 skill 时勉强能用，在 100 个时会怎样，OpenReview 没给答案。

而且它连 7 个都没做好 —— 见下。

### 4.8 一个真实 bug：折叠式 YAML description 被截断

`lib/skills.ts:18` 用正则解析 description：

```ts
const [, description] = frontmatter.match(/^description:\s*(.+)$/m) ?? [];
```

`\s*` 在 JS 正则里能吃掉换行，`(.+)` 只匹配非换行字符，`$` 在 `/m` 下停在行尾。所以对这种 **折叠式（多行）YAML**：

```yaml
description:
  React composition patterns that scale. Use when refactoring components with
  boolean prop proliferation, building flexible component libraries, or
  designing reusable APIs. Triggers on tasks involving compound components,
  render props, context providers, or component architecture.
```

**只会捕获到第二行**，后面全丢。我实际跑了一遍 `parseFrontmatter` + `buildSkillsPrompt`，模型看到的目录长这样：

```
- **next-best-practices**: Next.js best practices - file conventions, RSC boundaries, data patterns, async APIs, metadata, error handling, route handlers, image/font optimization, bundling
- **next-cache-components**: Next.js 16 Cache Components - PPR, use cache directive, cacheLife, cacheTag, updateTag
- **next-upgrade**: Upgrade Next.js to the latest version following official migration guides and codemods
- **vercel-composition-patterns**: React composition patterns that scale. Use when refactoring components with     ← 断在这
- **vercel-react-best-practices**: React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements.
- **vercel-react-native-skills**: React Native and Expo best practices for building performant mobile apps. Use     ← 断在这
- **web-design-guidelines**: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
```

7 个里有 2 个（`vercel-composition-patterns`、`vercel-react-native-skills`）的 description 被切在句子中间，**恰好把 "Triggers on tasks involving..." 这些路由关键词全丢了**。

这直接解释了 issue #2 的抱怨：

> Right now it will basically always invoke Next skill. In the frontmatter `description` field it doesn't say `use (only) when reviewing Next.js code`, it says `Next.js best practices - file conventions, RSC boundaries, ...`
>
> 评论补刀：`Tool always triggers Next.js skill / Description too generic / Skills too broad / Need smaller specific skills`

两个原因叠加：Next 系的 description 是单行的、完整保留；而写了完整触发条件的两个 skill 反而被截断了。**路由完全靠 description 文本时，description 的解析正确性就是路由正确性。**

---

## 5. Agent loop

### 5.1 循环怎么组织

`lib/agent.ts:81-91` 构造 `DurableAgent`（`@workflow/ai`，本质是 AI SDK 的 tool loop 加了持久化），`workflow/steps/run-agent.ts:36-92` 驱动：

```ts
await agent.stream({
  maxSteps: 20,
  messages: threadMessages,
  onStepFinish: (step) => console.log(`[agent] step: ${in} in / ${out} out`),
  prepareStep: ({ messages }) => { /* 10 KB 截断，见下 */ },
  stopWhen: [({ steps }) => totalTokens(steps) > 200_000],
  writable: getWritable<UIMessageChunk>(),
});
```

循环体在 `vercel/workflow` 的 `packages/ai/src/agent/stream-text-iterator.ts`：

```ts
const effectiveMaxSteps = maxSteps ?? Infinity;   // :149
while (!done) {
  if (stepNumber >= effectiveMaxSteps) break;     // :160-163
  if (abortSignal?.aborted) break;                // :165-168
  if (prepareStep) { ... }                        // :169-240
  // ... 调模型 ...
  if (finishReason === 'tool-calls' || toolCalls.length > 0) {
    // 执行工具，push tool result
    if (stopConditions) {                         // :409-416
      if (stopConditionList.some((test) => test({ steps }))) done = true;
    }
  } else if (finishReason === 'stop') { done = true; }   // :417-430
  // length / content-filter / error / other / unknown 都 done = true，不抛
}
```

### 5.2 终止条件（四条，按实际触发顺序）

1. **模型自然停止**：`finishReason === 'stop'`，即模型这一步没发工具调用。这是正常路径。
2. **步数上限**：`maxSteps: 20`。硬中断，`break` 出循环，**没有任何「快结束了，赶紧总结」的提示**，也不会补发评论。如果 agent 在第 20 步还在探索，这次 review 就什么都没留下（除非中途调过 `reply`）。
3. **token 预算**：`stopWhen` 累加所有 step 的 `inputTokens + outputTokens`，超过 200,000 就停。
   **注意 `stopWhen` 的判定位置**（`stream-text-iterator.ts:409`）：它只在 **「这一步以 tool-calls 结尾」** 的分支里检查。如果模型在纯文本输出那一步爆了预算，走的是 `finishReason === 'stop'` 分支，本来也会停，所以没实际差别 —— 但意味着 **`stopWhen` 无法在文本生成中途打断**。
   另外这个累加方式很粗：`inputTokens` 是每一步的完整 prompt token，而 prompt 是随对话增长的，所以是 **平方级累加**。20 步、每步 30K 上下文的 review，累加值 ≈ 600K，会在第 8 步左右就撞线。**实际的有效步数远低于 20。**
4. **异常**：任何工具抛错（`readFile` 文件不存在、沙箱超时）→ 冒泡到 `runAgent` 的 catch → `{success:false}` → workflow 抛 `FatalError` + 贴 Error 评论。

### 5.3 怎么防止无限探索

三层：`maxSteps: 20` + token 预算 200K + 沙箱 8 分钟墙钟。三者取先到的。

还有第四层，是最有意思的一个：**`prepareStep` 里的 tool result 截断**（`run-agent.ts:47-78`）：

```ts
prepareStep: ({ messages }) => {
  const trimmed = messages.map((msg) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    return { ...msg, content: msg.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const text = JSON.stringify(part.output);
      if (text.length <= 10_000) return part;
      return { ...part, output: { type: "text",
        value: `${text.slice(0, 10_000)}\n\n... (truncated ${text.length - 10_000} chars)` } };
    })};
  });
  return { messages: trimmed };
}
```

每个 tool result 上限 10,000 字符。一次 `gh pr diff` 拉回 50 KB 的 diff，模型只能看到前 10 KB。

**而且这个截断是永久的**：`stream-text-iterator.ts:183-185` 是

```ts
if (prepareResult.messages !== undefined) {
  conversationPrompt = [...prepareResult.messages];
}
```

—— 直接替换掉了 `conversationPrompt`，不是只影响这一次调用。一旦被切，后续所有步骤看到的都是切过的版本。

**这是 OpenReview 唯一的 context 管理机制。** 没有摘要、没有压缩、没有选择性遗忘，就一刀切。

对我们的启示：这条「每个 tool result 设硬上限」的做法简单粗暴但有效，值得作为第一版实现。但 **10 KB 对 diff 来说太小了**，而且一刀切会把 diff 的后半截直接丢掉而模型毫无察觉（它只看到 `truncated`，不知道丢的是什么）。更好的做法是 **在工具层做分页**（`readFile(path, offset, limit)`、`prDiff(files[])`），让模型显式地控制读什么，而不是在框架层盲切。

---

## 6. 从自由输出到结构化 finding

### 6.1 结论先说：它没有这一层

**OpenReview 没有 finding 数据结构，没有 schema，没有验证，没有行号定位逻辑。** grep 整个仓库找不到任何 `interface Finding` / `severity` / `confidence` / `line` 字段定义。

它的做法是：**让模型直接调 GitHub API**。

### 6.2 两条输出路径

**路径 A：顶层评论 —— `reply` 工具**

`lib/tools/reply.ts` → `addPRComment(threadId, body)` → Chat SDK 的 `adapter.postMessage(threadId, {markdown: body})`。就是往 PR 的 issue comment 里贴一段 markdown。

prompt 对格式的全部要求（`lib/agent.ts:54-59`）：

```
## Replying
- Use the reply tool to post your response to the pull request
- Always reply at least once with your findings or actions taken
- Format replies as markdown
- Be concise and actionable
- End every reply with a line break, a horizontal rule, then: *Powered by [OpenReview](...)*
```

**路径 B：行级评论 —— 模型自己拼 `gh api` 命令**

prompt 里直接给了命令模板（`lib/agent.ts:31`）：

```bash
gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/comments \
  -f body="..." -f path="..." -f line=N \
  -f commit_id="$(gh pr view {{PR_NUMBER}} --json headRefOid -q .headRefOid)"
```

以及 suggestion 语法（`lib/agent.ts:32-35`）：

````
- To suggest a code fix in an inline comment, use GitHub suggestion syntax:
  ```suggestion
  corrected code here
  ```
````

### 6.3 行号怎么定位

**靠模型自己数。** 没有任何辅助。模型要：

1. 跑 `gh pr diff N` 拿到 unified diff（还可能被 10 KB 截断）
2. 从 `@@ -a,b +c,d @@` hunk header 里推算目标行在新文件中的绝对行号
3. 把这个数字填进 `-f line=N`
4. 另起一个子 shell 调 `gh pr view --json headRefOid` 拿 commit SHA

**从 diff hunk header 心算绝对行号，是 LLM 已知的弱项。** 这个链路没有任何校验。

### 6.4 定位失败怎么办

**没有处理。** 靠 GitHub API 自己报错 + 模型自己看懂。

GitHub 的 `POST /repos/{o}/{r}/pulls/{n}/comments` 对不在 diff 范围内的 `line` 会返回 **422 Unprocessable Entity**，body 里是 `"pull_request_review_thread.line must be part of the diff"`。这个响应会作为 `bash` 工具的 stdout/stderr 回给模型（`bash.ts:21` 返回 `{exitCode, stderr, stdout}`，非 0 退出码不抛错）。

于是「定位失败的处理」就是：**模型看到 422，自己决定要不要重试、怎么改行号，或者放弃改发顶层评论。** 每次重试烧掉一个 step（20 步预算里的 1/20）和一轮 token。

**这是我们绝对不能抄的部分。** 我们必须有：

- 结构化 finding（`{file, line, severity, rule_id, message, suggestion}`）由模型用 **工具调用的 schema** 产出，而不是拼 shell
- 一个 **行号校验 + 重定位** 层：拿 finding 里的 `file` + 代码片段，在 diff 的新增行里做定位（fuzzy match 代码文本比信任模型报的行号可靠得多）
- 定位失败的降级策略：文件级评论 → 顶层评论汇总，而不是丢弃或让模型盲试

对照 Vercel 自家的 hosted 产品（`vercel.com/docs/agent/pr-review`），它的做法完全不同：**「generates patches, runs them in secure sandboxes, executes your real builds, tests, and linters. Only validated suggestions that pass these checks appear in your PR.」** —— 先生成 patch，在沙箱里跑真实的 build/test/lint，**验证通过的才展示**。行号问题被 patch 这个表示形式绕过去了（patch 自带上下文，apply 不上就是 apply 不上）。**这个思路值得认真考虑：用 patch 而不是 (file, line) 作为 finding 的载体。**

---

## 7. 修改代码能力与护栏

### 7.1 链路

```
1. checkPushAccess（workflow/index.ts:43）            ← 唯一的前置闸门
2. configureGit（禁 hooks、设 bot 身份、认证 remote）
3. agent 用 writeFile 或 bash 改文件
4. hasUncommittedChanges（workflow/index.ts:81）      ← git diff --name-only
5. commitAndPush（:84）                               ← 有改动才走
```

### 7.2 前置闸门：`checkPushAccess`

`workflow/steps/check-push-access.ts` 做三项检查：

1. 仓库是否 archived（`:11-26`）
2. installation 的 `contents` 权限是不是 write（`:28-46`）
3. 目标分支的 branch protection 里，push restrictions 是否允许 `openreview` 这个 app（`:55-74`）

任一不过就贴一条「## Skipped」评论并抛 `FatalError`，**整个 review 都不跑**（`workflow/index.ts:45-59`）。

**这是个值得商榷的设计**：不能 push ≠ 不能 review。OpenReview 把「写权限」当成了 review 的前置条件，意味着 fork PR（head 在别人仓库）、受保护分支、只读 installation 全都 **完全无法使用**。对我们来说，「只读 review」必须是一等公民，写权限应该是可选增强。

第 64 行还硬编码了 app slug `"openreview"`：

```ts
const isAppAllowed = allowedApps.some((app) => app.slug === "openreview");
```

自部署时 app slug 是自己起的，这个检查必然失配 —— 不过 `:66` 的 `&& allowedApps.length > 0` 让它只在「确实配置了 app 白名单」时才拦，所以大部分情况下蒙混过关。（issue #8 里用户踩的是另一个相关的 slug 坑：mention 要用自己的 app slug，不是 `@openreview`。）

### 7.3 提交

`workflow/steps/commit-and-push.ts:16-47`：

```ts
await sandbox.runCommand("git", ["add", "-A"]);
await sandbox.runCommand("git", ["commit", "--no-verify", "-m", message]);
await sandbox.runCommand("git", branchName ? ["push", "origin", branchName] : ["push"]);
```

commit message 固定是 `"openreview: apply changes"`（`workflow/index.ts:84`）。

### 7.4 护栏清单（以及缺的）

**有的：**

| 护栏 | 位置 |
| --- | --- |
| push 权限前置校验 | `check-push-access.ts` |
| git hooks 禁用（`core.hooksPath=/dev/null`） | `configure-git.ts:17-22` |
| commit 跳过 hooks（`--no-verify`） | `commit-and-push.ts:22` |
| bot 身份而非用户身份 | `configure-git.ts:24-30` |
| 只 push 到 PR 分支（显式 `origin <prBranch>`） | `commit-and-push.ts:38` |
| 无改动不提交 | `workflow/index.ts:81-85` |
| 沙箱隔离 + 用完即停 | `create-sandbox.ts` / `stop-sandbox.ts` |

**缺的：**

| 缺口 | 后果 |
| --- | --- |
| **无文件白名单 / 路径限制** | agent 可以改 `.github/workflows/*.yml`、`package.json` 的 scripts、`.git/hooks/`。改完 push 到 PR 分支 → 如果 CI 是 `pull_request_target` 触发，就是一条 **供应链注入路径** |
| **无改动规模上限** | 没有「改动不得超过 N 行 / N 个文件」的检查 |
| **无 diff 复核** | commit 之前没有任何人或程序看过这个 diff |
| **`git add -A` 太宽** | 会把 agent 误创建的任何文件一起提交。结合 §9.1 的 `writeFile` bug，会提交文件名是整段代码内容的垃圾文件 |
| **改动与「本次 review 目标」无关联** | 没有「只允许修改本 PR 涉及的文件」这类约束 |
| **`hasUncommittedChanges` 用 `git diff --name-only`** | 只看 **已跟踪文件的修改**，看不到新增的未跟踪文件。所以「只创建了新文件」的一轮不会触发提交；但只要同时改了一个已跟踪文件，`git add -A` 就会把所有新文件一起扫进去。**判定口径和提交口径不一致** |
| **token 在沙箱里裸奔** | `.git/config` 里有 installation token，agent 有 `bash`，可以直接读走（§2.4） |

我们要做企业内部平台，**至少要补：路径白名单、改动规模上限、以及「agent 不能碰 CI 配置和构建脚本」这条硬规则**。

---

## 8. 精度控制

### 8.1 它靠什么控噪声？—— 基本上只有一句 prompt

搜遍全仓，抑制噪声的约束只有 system prompt 里这几条（`lib/agent.ts:23-38`）：

```
## Code Review
- Review the PR diff for bugs, security vulnerabilities, performance issues,
  code quality, missing error handling, and race conditions
- ...
- Be specific and reference file paths and line numbers
- For each issue, explain what the problem is, why it matters, and how to fix it
- Don't nitpick style or formatting          ← 唯一一条明确的降噪约束
```

加上 `## Replying` 段的 `- Be concise and actionable`。

**没有的东西**（逐项确认）：

- 没有 severity / confidence 字段，因此 **没有阈值过滤**
- 没有第二遍验证（no revalidate / no self-critique / no judge）
- 没有「每次最多提 N 条」的数量上限
- 没有「只评论本次改动新增的行」的范围约束（虽然 `## Getting Started` 引导它先看 diff，但没有硬约束）
- 没有「不确定就别说」的表述要求
- 没有噪声反馈回流：👎 只回一句「Got it, skipping that」（`lib/bot.ts:145-153`），**不写状态、不影响下一次 review**
- 没有读被 review 仓库的 `AGENTS.md` / `CLAUDE.md`（prompt 里完全没提；agent 理论上能用 bash 读到，但没人告诉它去读）

### 8.2 对比：Vercel 自己的另外两个产品都补了这一层

**Vercel Agent Code Review**（hosted，`vercel.com/docs/agent/pr-review`）：

- 生成 patch → 在 Sandbox 里跑 **真实的 build / test / lint** → **只有通过验证的建议才出现在 PR 上**。这就是它的 Grader：**用可执行的验证代替模型的自评**。
- 自动识别仓库的 `AGENTS.md` / `CLAUDE.md` / `.cursor/rules/*.mdc` / `.windsurfrules` / `.clinerules` 等 14 种规范文件，**按目录层级继承**（根目录的管全局，`src/components/CLAUDE.md` 叠加到该子树），**作用域限定**（`src/` 的规范不影响 `lib/`），支持 `@import "file.md"` 和相对链接自动带入。
- **规范总量上限 50 KB。**
- 明确写了：「Guidelines are treated as **context, not instructions**. The reviewer's core behavior (identifying bugs, security issues, and performance problems) **takes precedence over any conflicting guideline content**.」

**deepsec**（Vercel 的安全扫描 agent，`vercel.com/blog/introducing-deepsec-...`）：

- 先 regex 全量扫描定位敏感区域 → agent 逐文件调查 → **第二个 agent run 做 revalidate，剔除 false positive 并重新定级** → 用 git metadata 做归属 enrichment
- 公开的数字：**false positive rate 约 10–20%**；从初始 finding 到最终「真的要修的东西」有 **约 95% 的收敛**

**这两个对比说明一件事**：Vercel 自己也很清楚单遍 agent review 噪声控不住。OpenReview 没有 Grader 不是因为不需要，而是因为它是一个「把我们几个技术栈串起来跑通」的内部 demo（README 原话：「built as an internal project to help the Vercel team test their technologies together」）。

### 8.3 社区反馈里的实际噪声表现

翻了仓库全部 16 个 issue、7 个 PR，以及 HN 讨论（`news.ycombinator.com/item?id=47413785`）：

**结论：没有人系统性反馈过噪声率。** HN 帖子下面唯一一条实质性评论是在吐槽名字撞了 OpenReview.net。

能找到的、跟精度相关的一手反馈只有一条，但很准：

> **issue #2「Open to other frameworks?」**
> 「Right now it will basically always invoke Next skill.」
> 评论补充：`Tool always triggers Next.js skill` / `Description too generic` / `Not framework agnostic` / `Skills too broad — Need smaller specific skills`

这是 **skill 路由的噪声**，不是 finding 的噪声 —— 但它对我们更有价值，因为它正是「动态规范」会踩的第一个坑（§11.3）。

其余 issue 集中在别处：#1/#10 要 GitLab/TFS 支持，#3/#5/#16 要换模型/网关（issue #16 里有人算过账：「`runAgent` budgets **200K tokens per review**，agent 是刻意 exploratory 的」），#4 要自动触发，#15 要 LICENSE 文件。

**代码活跃度提示**：最后一次代码提交是 2026-03-06，而 issue 一直开到 2026-08。**这个项目基本处于停更状态，issue 和 PR（包括 #7 修 mention bug、#17 加模型配置）都没人合。** 把它当参考实现读可以，当上游依赖不行。

---

## 9. 读源码发现的缺陷（供我们自己避坑）

### 9.1 `writeFile` 工具参数错位 —— 改代码能力实际是坏的

`lib/tools/write-file.ts`：

```ts
const writeFileStep = async (
  sandboxId: string,
  path: string,        // 第 2 个形参是 path
  content: string      // 第 3 个形参是 content
): Promise<{ success: boolean }> => { ... };

export const createWriteFileTool = (sandboxId: string) =>
  tool({
    execute: ({ content, path }) => writeFileStep(sandboxId, content, path),
    //                                            ^^^^^^^^^^^^^^^^^^^^ 反了
  });
```

实参传的是 `(sandboxId, content, path)`。于是：

- `resolvedPath` = `./` + **整段文件内容**
- 写入的 buffer = **目标路径字符串**

结果是往一个「文件名是整段代码」的路径写入一个「内容是路径」的文件。实际会因为文件名带 `/` 或超长（ENAMETOOLONG）而失败或创建出奇怪的嵌套目录。

用 `git log --follow` 确认：这个 bug 从 `writeFile` 工具被引入的那个 commit（`e0b3e8b` "Fix tools"）起就存在，到 HEAD 都没修。

**后果**：README 宣称的「Code changes — Can directly fix formatting, lint errors, and simple bugs」这条能力，走 `writeFile` 是不通的。实际能改代码只能靠 `bash`（`sed -i`、heredoc 重写），而 prompt 里恰恰是教它用 `writeFile` 的（`lib/agent.ts:50-52`：「edit files directly using writeFile」）。

有点讽刺：一个 AI code review 工具，自己仓库里有个一眼可见的参数顺序 bug 活了半年。**这本身就是对「单遍 agent review 精度」最好的注脚。**

### 9.2 `description` 折叠 YAML 截断

见 §4.8。7 个 skill 里 2 个的路由描述被切在句子中间。

### 9.3 `readFile` 失败会终止整个 agent

`lib/tools/read-file.ts:17-19`：文件不存在直接 `throw`。这个异常冒泡穿过 agent loop，被 `runAgent` 的 catch 接住，返回 `{success:false}`，整个 review 失败。

模型探索代码库时猜错路径是家常便饭。**一个猜错的路径 = 整次 review 挂掉。** 对比 `loadSkill` 的处理（返回 error 对象 + 可用列表，让模型自我纠正）—— 同一个仓库里两种做法，后者是对的。

**我们的工具必须一律「返回错误而不是抛」**，除非是真的不可恢复的基础设施故障。

### 9.4 skills 静默失活

`discoverSkills` 两处 `catch { continue }` + 空数组时 `buildSkillsPrompt` 返回 `""`。如果 `.agents/skills/` 没被打进 serverless 函数包（`next.config.ts` 里没有 `outputFileTracingIncludes`），整个 skills 系统会 **悄无声息地完全不工作**，日志里一个字都没有。

**我们的规范加载必须有可观测性**：加载了几条、命中了哪些、加载失败的是哪个，都要能在一次 review 的 trace 里看到。

---

## 10. 值得抄 / 不值得抄

| 做法 | 评价 |
| --- | --- |
| 沙箱里 clone 真实仓库，给 agent 完整代码上下文 | **抄**。这是它相对「只给 diff」的最大优势 |
| `gh` CLI 认证好放进沙箱，GitHub 交互交给 agent | **部分抄**。CLI 方便，但 **发评论必须走结构化工具，不能让模型拼 shell** |
| 不预取 diff，让 agent 自己按需取 | **抄思路**。但要包装成带分页的工具，不是裸 `gh pr diff` |
| `core.hooksPath=/dev/null` + `--no-verify` | **抄**。被 review 的仓库是不可信输入 |
| 每个 tool result 硬上限截断 | **抄，但要改**。10 KB 太小，且盲切不如工具层分页 |
| `"use step"` 让有副作用的工具可重放 | **抄思路**。dsh 没有编译期支持，要自己做幂等键 |
| 工具面只有 bash + 读写 + 回复 | **部分抄**。保留 bash 兜底，但高频操作提升成一等工具（带超时、带审计、带结构化返回） |
| skills L1/L2 渐进加载 | **抄机制，重写实现**。见 §11 |
| 让模型自己拼 `gh api -f line=N` 发 inline comment | **绝不抄** |
| 没有 finding schema | **绝不抄** |
| 没有 Grader | **绝不抄**。参考 deepsec 的 revalidate 或 Vercel Agent 的 sandbox 验证 |
| 「不能 push 就不 review」 | **绝不抄**。只读 review 必须是一等公民 |
| `git add -A` + 无路径白名单 | **绝不抄** |
| 沙箱里存明文 token | **绝不抄** |

---

## 11. 对动态规范的启示

这一节专门回答：**skills 机制能不能承载上百条编码规范？卡在哪？**

### 11.1 token 账是算得过来的

先把数字摆清楚。用 OpenReview 自己的 skill 语料反推「上百条规范」的规模：

| 层 | 内容 | 体量 | tokens |
| --- | --- | --- | --- |
| L1 目录 | 7 个 `name: description` | 1.2 KB | ~300 |
| L2 正文 | 7 个 SKILL.md（其中 `vercel-react-best-practices` 是 58 条规则的索引，`vercel-react-native-skills` 是 38 条） | 30 KB | ~7.6K |
| L3 明细 | 102 个 `rules/*.md` + 19 个同级参考 md | 255 KB | ~64K |

按这个密度外推到 **100 条规范**：

- **L1 每条规范一个 entry**（`name: description`，约 80–120 tokens/条）→ **8K–12K tokens 常驻**。对 200K 预算来说占 4–6%，能接受，但已经不算便宜了。
- **L1 按领域聚合**（10 个 skill，每个管 10 条规范）→ **约 1K tokens 常驻**。这才是 OpenReview 那套结构的正确用法。
- **L2 一个领域的索引**（10 条规范的 slug + 一句话）→ 约 500–1500 tokens/次
- **L3 单条规范明细**（正例/反例/为什么）→ 平均 2.5 KB ≈ **620 tokens/条**

**结论：上百条规范在 token 上完全装得下，前提是三层都真的能用，而且 L3 是按条加载的。** 一次 review 典型命中 5–15 条规范 → L1 1K + L2 1.5K + L3 10 条 × 620 ≈ **8.7K tokens**。这个量级对 200K 预算毫无压力。

**真正的成本不在 token，在路由准确率。**

### 11.2 OpenReview 的机制卡在哪（四条）

**卡点 1：L3 在它的 runtime 里根本读不到。**

这是最致命的。skills 语料在 OpenReview 部署的文件系统上，而 agent 的文件工具指向沙箱。`loadSkill` 在重构中丢掉了 `skillDirectory`（§4.6）。结果是：`vercel-react-best-practices` 的 58 条规则，agent 只能看到 slug 清单，永远读不到任何一条的正文。

> **对我们的直接要求**：规范的「索引」和「明细」必须在 **同一个可寻址空间** 里。要么都进沙箱（在沙箱里 mount 一份规范库），要么都走同一个工具（`loadRule(rule_id)` 和 `loadSkill(name)` 走同一条内存/DB 路径）。**绝不能让 agent 需要跨两个文件系统。**

**卡点 2：路由完全靠 description 文本 + 模型判断，且没有任何兜底。**

没有分类、没有检索、没有按改动文件类型的预筛、没有优先级。7 个 skill 就已经出现了「永远只触发 Next skill」的实际投诉（issue #2）。100 条规范的扁平列表，模型的选择会退化成「挑列表里最靠前 / 描述最长 / 看起来最通用的那几个」。

> **对我们的直接要求**：路由不能只有一层。至少要做到
> - **硬路由（确定性）**：按改动文件的语言、路径、框架做预筛。Go 文件的 PR 不该看到 React 规范。这一层用元数据过滤，零成本、零幻觉。
> - **软路由（模型）**：在预筛后的候选集里，让模型按 description 挑。候选集从 100 缩到 10–20，模型的判断质量会显著不同。
> - **兜底**：`loadRule` 找不到时返回可用列表（OpenReview 这点做对了），以及「本次 review 一条规范都没加载」时的告警。

**卡点 3：description 是路由的唯一信号，但它的解析有 bug，而且格式没有约束。**

§4.8 的折叠 YAML 截断问题。更普遍的问题是：**description 既要说「这是什么」又要说「什么时候用」，两个职责混在一个自由文本字段里**，写得好不好全看规范作者。issue #2 的原话就是在要求 description 写成「use (only) when reviewing Next.js code」而不是「Next.js best practices - ...」。

> **对我们的直接要求**：把 description 拆成 **结构化的触发条件** + **自由文本的说明**。
> ```yaml
> id: go-err-wrap
> title: 错误必须带上下文包装
> applies_to:
>   languages: [go]
>   paths: ["**/*.go"]
>   not_paths: ["**/*_test.go", "vendor/**"]
> triggers: ["fmt.Errorf", "errors.New", "return err"]
> summary: 向上返回错误时必须用 %w 包装并补充调用点信息
> ```
> `applies_to` 和 `triggers` 给硬路由用（可以直接 grep 改动内容匹配），`summary` 给软路由和 L1 目录用。**这是 OpenReview 完全没有、而我们必须有的东西。**

**卡点 4：加载是单向的，没有卸载、没有预算。**

模型可以无限制地连续 `loadSkill`，每次都往上下文里永久追加。7 个 skill 全加载 = 7.6K tokens，还好；100 条规范如果模型「谨慎起见全加载」= 60K+ tokens，直接吃掉三分之一预算，而且一步也退不回来。

叠加 §4.4 发现的 10 KB tool result 截断 —— 单条规范超过 9.7 KB 会被静默切断 —— 就是「既没有下限保护，也没有上限控制」。

> **对我们的直接要求**：
> - `loadRule` 支持 **批量**（`loadRules(ids: string[])`），一次调用返回多条，省 step。
> - 加一个 **规范加载预算**（比如「本次 review 最多加载 20 条明细 / 15K tokens」），超了就返回「预算已满，已加载：[...]，如需替换请先 unload」。
> - 提供 **`unloadRule`**，或者更简单：在 `prepareStep` 里把「N 步之前加载、但之后从未被引用的规范正文」降级成一行 summary。OpenReview 的一刀切截断可以借鉴成这个思路的原始版本。
> - 单条规范正文设明确字数上限（比如 1500 字），超了在 **规范入库时** 就报错，而不是在运行时静默截断。

### 11.3 一个 OpenReview 没做、但我们绕不开的问题：规范该在哪

OpenReview 的 skills 在 **bot 部署的仓库里**，导致「一套部署 = 一套规范」，改规范要重新部署（§4.2）。

Vercel 的 hosted 产品走了另一个极端：规范在 **被 review 的仓库里**（`AGENTS.md` / `CLAUDE.md` / `.cursor/rules/*.mdc`），按目录层级继承、按子树限定作用域、支持 `@import` 展开，**总量上限 50 KB 全量注入，不做渐进加载**。

我们要做企业内部平台，两个都不够：

- **规范是组织资产，不是仓库资产。** 大部分条目应该来自中心规范库（跨仓库共享、有生命周期、有版本），只有少量项目特例放在仓库里。
- **50 KB 全量注入的模式在 100+ 条时会撑不住**（50 KB ≈ 12.5K tokens，勉强能塞下 20 条带例子的规范）。所以渐进加载不是可选优化，是必须。
- **规范的分发必须能按仓库/团队/语言切片。** 这正是 OpenReview 架构上做不到的事。

所以我们的形态大概是：**中心规范库（DB/Git）→ 按 PR 元数据硬路由出候选集 → L1 目录注入（候选集的 id + summary）→ 模型软路由 `loadRules` → L3 明细按条返回**，中间每一步都可观测、可审计、有预算。

### 11.4 一句话收尾

OpenReview 的 skills 机制证明了 **「目录常驻 + 正文按需」这个模式的 token 账是成立的（压缩比约 1:400）**，但它自己的实现只跑通了两层，路由退化成「模型看着一个扁平列表猜」，7 个 skill 就已经猜错了。

**我们要抄的是这个模式，要补的是它没做的三件事：确定性预筛、结构化触发条件、加载预算与可观测性。**

---

## 附：关键源码索引

| 关注点 | 位置 |
| --- | --- |
| 主流程 | `workflow/index.ts:31-108` |
| system prompt 全文 | `lib/agent.ts:11-62` |
| agent 构造 | `lib/agent.ts:64-92` |
| agent loop 驱动（maxSteps / stopWhen / prepareStep） | `workflow/steps/run-agent.ts:36-92` |
| 循环体实现 | `vercel/workflow` → `packages/ai/src/agent/stream-text-iterator.ts:147-167, 409-455` |
| skills 发现 | `workflow/steps/discover-skills.ts:7-53` |
| frontmatter 解析（含 §4.8 的 bug） | `lib/skills.ts:7-32` |
| skills 目录拼装 | `lib/skills.ts:34-49` |
| `loadSkill` | `lib/tools/load-skill.ts:6-26` |
| bash 工具 | `lib/tools/bash.ts:7-42` |
| readFile（失败会终止 agent） | `lib/tools/read-file.ts:7-31` |
| writeFile（参数错位 bug） | `lib/tools/write-file.ts:7-33` |
| reply | `lib/tools/reply.ts:6-25` |
| 沙箱创建 | `workflow/steps/create-sandbox.ts:5-33` |
| 沙箱续期 / 停止 | `workflow/steps/extend-sandbox.ts:5,22` / `workflow/steps/stop-sandbox.ts:20` |
| 依赖与 gh CLI 安装 | `workflow/steps/install-dependencies.ts:5-84` |
| git 配置（含 token 落盘） | `workflow/steps/configure-git.ts:5-61` |
| push 权限闸门 | `workflow/steps/check-push-access.ts:11-138` |
| 提交推送 | `workflow/steps/commit-and-push.ts:16-59` |
| 改动检测（口径不一致） | `workflow/steps/has-uncommitted-changes.ts:21-31` |
| webhook 入口与 reaction 处理 | `lib/bot.ts:44-158` |
| skills 来源锁文件（运行时不读） | `skills-lock.json` |
| 「Defer diffing to agent」设计变更 | commit `3882f41` |
| 「Fix workflow」丢掉 skillDirectory | commit `f16f19d` |
