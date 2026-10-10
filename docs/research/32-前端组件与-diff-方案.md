# 前端组件与 diff 方案：2026 年 9 月的现状核实

- **对应 ticket**：[前端组件选型与 diff 视图](../../.agents/notes/proposed/architecture/2026-09-12-frontend-stack-and-diff-view.md)
- **调研时间**：2026-09-12
- **前置调研**：[Qodo 产品形态](25-qodo-产品形态.md)（八个控制台页面的形态来源）、[dsh 嵌入形态](13-dsh-嵌入形态.md)（只复用 4 个底层包的决定）
- **dsh 被调研版本**：工作树 HEAD `c291e7961a`（2026-09-10，`Merge pull request #3977 ... release-0.1.5-sync-master`），包版本 `0.1.5-rc.2`

## 这份文档的证据等级

本文按三档标注，不混用：

| 标记 | 含义 |
| --- | --- |
| （无标记） | **实测**。本次调研里用 `npm view` / `npm pack` 解包读 `.d.ts` / `gh api` / `WebFetch` 官方文档 / 直接读 dsh 源码得到的事实 |
| **〔推断〕** | 从实测事实推出来的判断，没有实跑验证 |
| **〔未核实〕** | 没能从一手来源确认。写出来是因为它影响判断，但**不能当依据用** |

凡是我凭印象知道、但这次没核实的，一律不写。本次 WebSearch 配额在调研中途耗尽，后半程改用 `npm view`、`npm pack` 解包读类型定义、`gh api`、`WebFetch` 官方文档——**这几种反而比搜索更硬**，所以结论的证据质量没有下降，但"社区口碑/踩坑帖"这一类软信息基本没有覆盖。

## 来源清单

| 编号 | 来源 | 获取方式 | 用在哪 |
| --- | --- | --- | --- |
| N1 | npm registry：`antd` / `@mui/material` / `@mantine/core` / `@chakra-ui/react` / `@base-ui/react` / `@tanstack/react-table` / `@tanstack/table-core` / `react-diff-view` / `diff2html` / `@git-diff-view/react` / `@codemirror/merge` / `monaco-editor` / `tailwindcss` / `shadcn` 等 30+ 个包 | `npm view <pkg> version time license peerDependencies dependencies dist-tags dist.unpackedSize --json` | 全文的版本/许可证/发布时间/依赖 |
| N2 | 上述包的 **tarball 解包读 `.d.ts` / `lib/index.js`** | `npm pack <pkg> && tar xzf` | 2.2、2.3、3.2、4.2 的 API 级结论 |
| G1 | GitHub API：各仓库的 star / open issues / pushed_at / commits / releases | `gh api repos/<owner>/<repo>`、`gh api repos/.../commits?since=...` | 1.2、3.2 的活跃度 |
| G2 | **[`gitlabhq/gitlabhq`](https://github.com/gitlabhq/gitlabhq) 的 `app/assets/javascripts/rapid_diffs/`** —— `adapters/line_discussions.js`、`utils/line_utils.js`、`streaming/render_html_streams.js` | `gh api repos/gitlabhq/gitlabhq/contents/...` 读 base64 源码 | 3.4 GitLab 的行锚定实现 |
| D1 | **dsh 工作树 `/Users/jinrunsen/Projects/github/deepseek-harness`**，HEAD `c291e7961a` | 直接读 `packages/client/{ui-primitives,ui-slots,ui-dockkit,store,ui-theme,ui-chat,ui-renderer,web}` 与 `tsdown.client.ts` | 第四节全部 |
| D2 | dsh 四个包的 **npm tarball**（`@next` = `0.1.5-rc.2`） | `npm pack @deepseek-ai/dsh-client-*@next` | 4.2 的产物形态与依赖声明 |
| W1 | [Tailwind Preflight 文档](https://tailwindcss.com/docs/preflight) | WebFetch | 4.3、4.4 |
| W2 | [shadcn data-table 指南](https://ui.shadcn.com/docs/components/data-table) 与 registry（`ui.shadcn.com/r/styles/new-york/{sheet,drawer}.json`） | WebFetch + `curl` | 1.3、1.5、2.5 |
| W3 | [antd v6 迁移文档](https://ant.design/docs/react/migration-v6)、[antd Table 文档](https://ant.design/components/table) | WebFetch | 1.5、2.5 |
| W4 | [MUI X licensing](https://mui.com/x/introduction/licensing/)、[MUI pricing](https://mui.com/pricing/) | WebFetch | 1.5 |
| W5 | [Chakra v3 迁移文档](https://www.chakra-ui.com/docs/get-started/migration) | WebFetch | 1.5 |
| W6 | [CodeMirror merge 的 Forgejo 仓库](https://code.haverbeke.berlin/codemirror/merge) | WebFetch | 3.2 |
| Q1 | [Qodo 产品形态调研](25-qodo-产品形态.md)（本项目前置调研，95 张截图逐张还原） | 本地文件 | 第五节的八页清单与规模数字 |

各库官网备查：[shadcn/ui](https://ui.shadcn.com) · [Ant Design](https://ant.design) · [MUI](https://mui.com/material-ui/) · [Mantine](https://mantine.dev/) · [Chakra UI](https://chakra-ui.com/) · [Base UI](https://base-ui.com/) · [Ark UI](https://ark-ui.com/) · [TanStack Table](https://tanstack.com/table) · [Tailwind CSS](https://tailwindcss.com/)

## 章节

| 节 | 问题 | 一句话答案 |
| --- | --- | --- |
| [一](#一后台控制台组件库的现状) | 组件库选哪个 | **shadcn/ui**（base 选 Radix）。Mantine 因 React 19 门槛出局，MUI 因**列固定在 Pro 档**出局 |
| [二](#二表格方案) | 表格用什么 | **TanStack Table v9**，但它 **2026-08-04 才 GA**，这是唯一的风险点 |
| [三](#三diff-视图) | diff 视图用什么 | **@git-diff-view/react**。Monaco / CodeMirror 吃的是**两份文档**而不是 patch，形状不对 |
| [四](#四两套设计系统共存) | 两套设计系统代价多大 | **比预想的小**——dsh 那 4 个包零全局 CSS；但逃生舱不止这 4 个包 |
| [五](#五工作量的粗估) | 八个页面多少量级 | 表格页很便宜，**Configurations 页和 diff 视图是两个数量级** |
| [六](#六推荐组合) | 一套具体选型 | 见末节 |

-----

## 一、后台控制台组件库的现状

### 1.1 版本与许可证（`npm view` 实测，2026-09-12）

| 包 | 最新版本 | 最后发布 | 许可证 | React peer | unpackedSize |
| --- | --- | --- | --- | --- | --- |
| `antd` | **6.6.3** | 2026-09-07 | MIT | `>=18.0.0` | 48.9 MB |
| `@mui/material` | **9.4.0** | 2026-08-27 | MIT | `^17 \|\| ^18 \|\| ^19` | 5.7 MB |
| `@mantine/core` | **9.6.1** | 2026-09-09 | MIT | **`^19.2.0`** | 9.2 MB |
| `@chakra-ui/react` | **3.37.0** | 2026-08-28 | MIT | `>=18` | 2.7 MB |
| **`@base-ui/react`** | **1.8.0** | 2026-09-04 | MIT | `^17 \|\| ^18 \|\| ^19` | — |
| ~~`@base-ui-components/react`~~（旧包名，已冻结） | 1.0.0-rc.0 | 2026-07-15 | MIT | `^17 \|\| ^18 \|\| ^19` | — |
| `@ark-ui/react` | 5.39.1 | 2026-08-28 | MIT | — | — |
| `@radix-ui/themes` | 3.3.0 | **2026-01-31** | MIT | — | — |
| `@radix-ui/react-dialog` | 1.1.23 | 2026-07-31 | MIT | — | — |
| `shadcn`（CLI） | 4.21.0 | 2026-09-04 | MIT | — | — |
| `tailwindcss` | **4.3.3** | 2026-09-08 | MIT | — | — |
| `@mui/x-data-grid` | 9.13.0 | 2026-09-04 | **MIT** | — | — |
| `@mui/x-data-grid-pro` | 9.13.0 | 2026-09-04 | **商业**（`SEE LICENSE IN LICENSE`） | — | — |
| `ag-grid-community` | 36.1.0 | 2026-08-05 | MIT | — | — |
| `ag-grid-enterprise` | 36.1.0 | 2026-08-05 | **Commercial** | — | — |
| `@tremor/react` | 3.18.7 | **2025-01-13** | — | — | — |

> `unpackedSize` 是 npm 上发布的**未压缩包体积**，不是打进 bundle 的体积——antd 的 48.9 MB 里绝大部分是多入口产物和类型。它不能直接当 bundle 预算用，只能当"这个包有多大"的量级参照。实际 bundle 体积**〔未核实〕**（本次没跑打包实验）。

### 1.2 GitHub 活跃度（`gh api repos/...` 实测，2026-09-12）

| 仓库 | star | open issues | 最后 push |
| --- | --- | --- | --- |
| `shadcn-ui/ui` | 123,615 | **1,976** | 2026-09-11 |
| `ant-design/ant-design` | 99,487 | 1,075 | 2026-09-12 |
| `mui/material-ui` | 99,030 | 1,463 | 2026-09-11 |
| `chakra-ui/chakra-ui` | 40,642 | **31** | 2026-09-11 |
| `mantinedev/mantine` | 31,702 | **54** | 2026-09-11 |

五个都在 2026-09-11/12 有推送，**没有一个处于停更状态**。open issue 数差异更多反映治理风格（shadcn 是复制粘贴模式，issue 天然堆积），不宜直接当健康度读。

### 1.3 逐个看

#### shadcn/ui（Radix + Tailwind，复制粘贴）

- 不是 npm 依赖，是一个 CLI 把组件源码**复制进你的仓库**。运行时依赖是 Radix 各个 `@radix-ui/react-*` 包 + Tailwind + `class-variance-authority`（0.7.1）+ `lucide-react`（1.45.0，2026-09-11）。
- **它的 data-table 文档已经改写成 TanStack Table v9**（WebFetch 实测，原文："This guide uses TanStack Table v9"，安装命令 `pnpm add @tanstack/react-table`）。这一条很关键：它意味着 shadcn 生态已经跟上 v9，我们不用在 v8 和 v9 之间赌。
- 文档里明说不提供 data-table 组件，只提供"怎么自己搭"的指南：`<DataTable />` 壳、列定义、各 feature 的 state 都要自己写。
- **坑一**：shadcn 常用到的几个外围包已经久未更新——`cmdk` 1.1.1 停在 2025-08-27，**`vaul`（抽屉）1.1.2 停在 2024-12-14**，快两年没动。

  但右侧抽屉这件事有干净的出路：拉 shadcn registry 实测（`curl ui.shadcn.com/r/styles/new-york/{sheet,drawer}.json`），**`sheet` 的 dependencies 只有 `["@radix-ui/react-dialog"]`，`drawer` 才是 `["vaul", "@radix-ui/react-dialog"]`**。我们要的是 `sheet`（桌面端右侧抽屉），**不碰 vaul**。
- **坑二**：`@radix-ui/themes` 3.3.0 停在 2026-01-31，快八个月没发版。那是另一条产品线（Radix 自己的成品主题），和我们用的 `@radix-ui/react-*` primitives 不是一回事，别混。
- **坑三**：复制粘贴意味着**升级靠自己**。Radix 出安全修复时你得手动同步。对一个开源项目而言这反而是可控的，因为你的组件代码进了 git 历史，是可审计的。

#### Ant Design（antd 6）

- `antd` 6.6.3，peer 是 `react >=18.0.0` / `react-dom >=18.0.0`——**antd 6 仍然兼容 React 18**，这一点和 Mantine 相反。
- antd 5 分支还在维护：dist-tag `latest-5` = `5.29.3`，另有 `conch-v5` = `5.29.1`、`conch-v6` = `6.6.1`（内部灰度 tag）。**antd 同时维护 2/3/4/5/6 五条线的 dist-tag**（`latest-2`=2.13.14、`latest-4`=4.24.16），这是它的一贯风格。
- antd 6 的具体 breaking change 清单见 1.5 节，Table 的部分见 2.5 节。
- **坑**：主题定制走 CSS-in-JS（antd 5 起的 `cssinjs`），和 Tailwind 是两套哲学。同时用 antd 和 Tailwind 是常见做法但要处理层叠顺序。**〔推断〕** 如果主界面选 antd，就别再上 Tailwind，直接用 antd 的 token 系统，否则等于给自己叠了第三套设计系统。

#### MUI

- `@mui/material` 9.4.0，peer 覆盖 React 17/18/19。peerDependencies 里出现了 `@mui/material-pigment-css: ^9.4.0` 以及 `@emotion/react` / `@emotion/styled`。
- **表格是分档收费的**：`@mui/x-data-grid` 9.13.0 是 MIT，`@mui/x-data-grid-pro` 9.13.0 是商业许可（`SEE LICENSE IN LICENSE`）。功能分界线见 1.5 节。
- **对一个开源项目，任何"关键功能在 Pro 档"的组件都是硬伤**——我们的用户要能自己部署，不能要求他们买 license。这条基本排除了 MUI X DataGrid 的 Pro 功能，也排除了 AG Grid Enterprise。

#### Mantine —— **直接出局**

- `@mantine/core` 9.6.1 的 peerDependencies 是 **`react: "^19.2.0"`**，不是 `>=18`，不是 `^18 || ^19`。**Mantine 9 硬性要求 React 19.2+**。
- 对比：Mantine 8 的最后一版是 8.3.18，peer 是 `^18.x || ^19.x`。
- 我们的约束是 React 18。要用 Mantine 就得**要么锁在 Mantine 8**（一个已经不再演进的大版本），**要么把整个项目升到 React 19**。两条都不是这个 ticket 该承担的成本。**Mantine 出局，理由是版本门槛，不是质量。**

#### Chakra UI

- `@chakra-ui/react` 3.37.0，peer `react >=18`，还要 `@emotion/react >=11`。仓库只有 31 个 open issue，是五家里最干净的。
- 详见 1.5 节。

#### 2025–2026 有没有新出的后台专用方案

- **Base UI —— 这里有一个容易踩的坑，改了包名。** `@base-ui-components/react` 的 `latest` 停在 `1.0.0-rc.0`（2026-07-15），**光看这个包会误判成"还是 RC，别用"**。实际上项目已经迁到新包名 **`@base-ui/react`**：`1.0.0` 发布于 **2025-12-11**，当前 **1.8.0**（2026-09-04），一共 12 个版本，MIT，peer 覆盖 React 17/18/19（另有 `date-fns ^4` 和 `@date-fns/tz ^1.2` 两个 peer）。**Base UI 已经 GA 且在月度迭代**，是本节唯一一个真正算"新势力"的。
- **Ark UI** 5.39.1（2026-08-28）：Chakra 团队的跨框架 headless 层，活跃。它是 Chakra v3 的底座。
- **Tremor**（`@tremor/react`）：停在 3.18.7，**2025-01-13**——一年八个月没发版。而且它是图表库，和"整个产品只有一个柱状图"的需求本来就不搭。**排除。**
- **Radix Themes** 3.3.0（2026-01-31）：近八个月未发版。它是 Radix 自己的成品主题产品线，不是我们要用的 `@radix-ui/react-*` primitives。**不建议作为主力样式库。**
- **origin-ui：npm 上那个 `origin-ui` 包是抢注的。** 实测 `npm view origin-ui description` 返回的是「这是一个UI框架」，和官网 originui.com 对不上。真正的 Origin UI 走 shadcn registry 复制源码的路子，**不要 `npm install origin-ui`**。
- **kibo-ui**：npm 包关联 `github.com/shadcnblocks/kibo`，和官网对得上，可信。是 shadcn 生态的 block 集合，同样是"复制源码"而非 npm 依赖。

其余细节见 1.5 节。

### 1.4 判断：「十列可排序表格 + 批量操作条 + 右侧抽屉 + 多态徽章」谁最省事

这个形态拆开是四件事，四件事的难度分布很不均匀：

| 部件 | 难度 | 谁能帮上忙 |
| --- | --- | --- |
| 多态徽章（Badge/Pill） | **最低**。十几行 CSS + 一个 variant map | 谁都行，甚至不用库 |
| 右侧抽屉（Drawer/Sheet） | 低。焦点陷阱、ESC、滚动锁、动画 | Radix Dialog / antd Drawer / MUI Drawer 都开箱 |
| 批量操作条 | 低。它是"选中行数 > 0 时浮出的一条工具栏"，本质是条件渲染 | 没有库专门做这个，**都得自己拼** |
| **十列可排序表格** | **最高**，而且是唯一真正分胜负的地方 | 见第二节 |

所以"哪个库最省事"这个问题，**在徽章/抽屉/操作条这三件上根本分不出胜负**——它们是整个前端生态里最商品化的东西，ticket 里的判断是对的。**分胜负的只有表格**，而表格这件事上组件库的取舍在第二节展开。

排序（省事程度，只看这个形态）：

1. **antd** —— Table 开箱即用程度最高，`rowSelection` / `sorter` / `fixed` / `filters` 都是 prop，抽屉、徽章（Tag/Badge）、分页器都自带。代价是整套设计语言绑定。
2. **shadcn/ui + TanStack Table** —— 表格要自己画 DOM（约 350–500 行的一次性投入，2.5 节），但其余部件 Radix/Base UI 全覆盖，且**样式完全是你自己的**，长期可控。
3. **Chakra** —— 组件齐，但没有自带表格逻辑，等于 shadcn 的路子换一套样式方案。
4. **MUI** —— 组件最全，但**列固定和跨页选择都在 Pro 档**（1.5 节），对开源产品是硬伤。
5. **Mantine** —— 出局（React 版本门槛）。

注意第 1 名和第 2 名的差距**只在表格这一件事上**，而且是一次性的：抽屉、徽章、批量条三件上 antd 并不占便宜（批量操作条 antd 也不提供）。

### 1.5 补充核实

#### antd 6 的 breaking changes（来源：[官方迁移文档](https://ant.design/docs/react/migration-v6)）

- 不再支持 React 17 及以下（`react >=18.0.0`）；**原生支持 React 19，不再需要 `@ant-design/v5-patch-for-react-19` 补丁包**。
- `@ant-design/icons@6` 变为强制依赖，且与 antd 5 不兼容——两者必须同步升级。
- **CSS-in-JS 方案换了**：v6 默认启用 **CSS 变量**，不再是纯运行时生成 class。代价是不再支持 IE。
- 全局命名规范迁移：`xxxStyle` → `styles.xxx`、`xxxClassName` → `classNames.xxx`；`children` → `items`（主要影响 Menu / Breadcrumb / Anchor）。
- 100+ API 标记弃用，计划 v7 移除。
- **Table 的具体变化见 2.5 节**（是弃用/改名级别，不是能力削减）。
- **〔未核实〕** antd 6 相对 5 的实际 bundle 体积变化——官方没给量化数据。

#### MUI X DataGrid 的许可证分界线（来源：[licensing](https://mui.com/x/introduction/licensing/) / [pricing](https://mui.com/pricing/)）

| 档 | 包 | 许可证 | 关键能力 | 价格 |
| --- | --- | --- | --- | --- |
| Community | `@mui/x-data-grid` | MIT | 基础排序、筛选、分页、行选择、**行虚拟滚动** | 免费 |
| **Pro** | `@mui/x-data-grid-pro` | 商业 | 多重筛选、多重排序、列宽调整、**列固定（column pinning）**、**跨页选择保持（`keepNonExistentRowsSelected` / exclude model）** | **$299 / 年 / 开发者** |
| Premium | `@mui/x-data-grid-premium` | 商业 | 行分组、Excel 导出 + Pro 全部 | **$599 / 年 / 开发者** |

价格是我自己 WebFetch `mui.com/pricing` 拿到的原文（"$299 / year / dev"、"$599 / year / dev"）。企业档 $1399/年/开发者起——**〔未核实〕**（没在抓到的页面里看到）。

**这张表对我们是决定性的**：我们要的**列固定**在 Pro 档，**服务端分页下的跨页选择**也在 Pro 档。一个要求用户自己部署的开源产品不能把关键功能压在付费 license 上。**MUI X DataGrid 排除。**（AG Grid 同理：Community MIT 覆盖排序/筛选/分页/行选择/列固定，Enterprise 的行分组/聚合/Excel 导出是 Commercial。）

#### Chakra UI v3 的现状（来源：[官方迁移文档](https://www.chakra-ui.com/docs/get-started/migration)）

- v2 → v3 是**架构性重写**，不是小改。API 大量重命名：`isOpen`→`open`、`isDisabled`→`disabled`、`colorScheme`→`colorPalette`、`spacing`→`gap`、`noOfLines`→`lineClamp`；30+ 组件改成命名空间 compound 写法。
- 基于 **Ark UI** 构建（同一作者），token 设计借鉴 Panda CSS 但不强制装 Panda。
- 官方提供 codemod，但自定义主题仍要手工重构——官方自己配了"两场迁移直播 + 逐组件指南"，侧面说明迁移量不小。
- 发版节奏近半年基本月更（3.34.0 3/3 → 3.35.0 4/22 → 3.36.0 6/10 → 3.36.1 7/19 → 3.37.0 8/28），3.37.0 还新发了 `@chakra-ui/charts`。
- **〔未核实〕** 社区实际迁移进度（还有多少项目卡在 v2）。

#### shadcn/ui 的当前形态

- CLI 包 `shadcn` 最新 **4.21.0**（2026-09-04），8/31–9/4 之间连发四版，节奏很密。
- **一个 2026 年才有的新事实**：registry（`ui.shadcn.com/r/index.json`）里每个组件现在同时提供**三种底层实现——Radix / Base UI / React Aria**，装的时候选 base。这意味着「选 shadcn」和「选 Radix」已经解耦了，将来想换 Base UI 不必推翻整套。
- 组件清单 63 个，有 `sheet`、`drawer`、`badge`、`table`（基础表格，无排序筛选），**没有官方的 `data-table` 组件，也没有 `toolbar`（批量操作条）**——这两样只有文档指南，没有成品代码。
- **"代码自己维护"的实际代价**：官方后续的 bug fix / a11y 修复**不会自动同步**，要自己跟上游 diff。表格、批量条这类复合组件官方不给参考实现，只能自己拼或抄社区模板。

-----

## 二、表格方案

### 2.1 TanStack Table 的当前状态：v9 是 2026-08-04 才 GA 的新东西

这是本节最重要的一条事实，也是最容易踩的坑。

`npm view @tanstack/react-table` 实测的时间线：

| 版本 | 日期 |
| --- | --- |
| `8.21.3`（v8 最后一版） | **2025-04-14** |
| `9.0.0-alpha.0` | 2024-05-21 |
| `9.0.0-alpha.11`（alpha 重启） | 2026-02-09 |
| **`9.0.0`（GA）** | **2026-08-04** |
| `9.1.0` | 2026-08-07 |
| `9.2.4`（当前 latest） | 2026-08-28 |

- dist-tags：`latest` = 9.2.4，`beta` = 9.0.0-beta.80，`alpha` = 9.0.0-alpha.54。
- 依赖：`@tanstack/table-core@9.2.4` + **`@tanstack/react-store@^0.11.1`**，peer `react >=18`。
- 仓库 `TanStack/table` 28,422 star / 64 open issue / 最后 push 2026-09-10。
- v8 已经**停更 17 个月**（8.21.3 → 2025-04-14）。

**也就是说：v9 GA 到今天只有 5 周。** 这是选型上的真实风险——好消息是 shadcn 的 data-table 指南已经改写成 v9（1.3 节实测），说明生态里最大的那个下游已经跟上了。

### 2.2 v9 相对 v8 改了什么（解包读 `.d.ts` 实测）

`npm pack @tanstack/react-table@9.2.4` 解包后读 `dist/*.d.ts`，架构变化一目了然：

1. **入口 hook 换了**：`useReactTable(options)` → `useTable(options, selector?)`。第二个参数是 state selector，返回值挂在 `table.state` 上。
2. **feature 变成显式组合**。v9 不再自动带上所有能力，要自己拼：
   ```tsx
   const features = tableFeatures({
     columnFilteringFeature,
     rowSortingFeature,
     rowPaginationFeature,
     filteredRowModel: createFilteredRowModel(),
     sortedRowModel: createSortedRowModel(),
     paginatedRowModel: createPaginatedRowModel(),
     filterFns,
     sortFns,
   })
   const table = useTable({ features, columns, data })
   ```
   （这段是 `useLegacyTable.d.ts` 的 JSDoc 里官方给的迁移示例，逐字抄的。）
3. **row model 工厂改名并进了 feature slot**：`getFilteredRowModel()` → `createFilteredRowModel()`，`getSortedRowModel()` → `createSortedRowModel()`，依此类推。**`getCoreRowModel()` 直接取消**——v9 里 core row model 永远自动创建。
4. **状态搬到 TanStack Store atoms**：`table.getState()` → `table.state`；底层是 `table.store` / `table.atoms.<slice>`；新增 `<table.Subscribe>` HOC 做细粒度订阅：
   ```tsx
   <table.Subscribe source={table.atoms.rowSelection} selector={(s) => s?.[row.id]}>
     {() => <tr key={row.id}>...</tr>}
   </table.Subscribe>
   ```
   `table.store` 本身被标了 `@deprecated`，官方推荐读 `table.state`。
5. **所有类型的第一个泛型参数变成 `TFeatures`**：`Column<TFeatures, TData, TValue>`、`ColumnDef<TFeatures, TData, TValue>`、`Row<TFeatures, TData>`……**v8 代码里每一处类型标注都要改**。这是迁移工作量的大头。
6. **有 v8 兼容层**：`useLegacyTable` + `@tanstack/react-table/legacy` 子路径，把 `getFilteredRowModel()` 这些当成 marker 函数，整套标了 `@deprecated`。可以用它过渡，但它不是长久之计。
7. **新增的东西**：`table.FlexRender`（替代手工调 `flexRender`）、`createTableHook`（把 features 预绑成应用级 hook，省掉每处都写泛型）、`@tanstack/react-table/static-functions`（可 tree-shake 的独立函数）、`@tanstack/react-table/experimental-worker-plugin`（把计算挪进 Worker）。

**对我们的意义**：因为我们是**新项目**，不存在 v8 迁移成本——上面 1–5 条全是"一开始就这么写"，不是"要改"。v9 的显式组合反而是优点：我们只开用得到的 feature，bundle 里不会有排序以外的死代码。

### 2.3 headless 模式下，哪些内置、哪些要自己写

`@tanstack/table-core@9.2.4` 解包，`dist/features/` 下实际存在的 **17 个 feature**：

```
cellSelectionFeature      cellSpanningFeature      columnFacetingFeature
columnFilteringFeature    columnGroupingFeature    columnOrderingFeature
columnPinningFeature      columnResizingFeature    columnSizingFeature
columnVisibilityFeature   globalFilteringFeature   rowAggregationFeature
rowExpandingFeature       rowPaginationFeature     rowPinningFeature
rowSelectionFeature       rowSortingFeature
```

外加 8 个 row-model 工厂：`createExpandedRowModel`、`createFacetedMinMaxValues`、`createFacetedRowModel`、`createFacetedUniqueValues`、`createFilteredRowModel`、`createGroupedRowModel`、`createPaginatedRowModel`、`createSortedRowModel`。

对照我们要的能力：

| 能力 | TanStack v9 | 说明 |
| --- | --- | --- |
| 排序（含多列） | **内置** `rowSortingFeature` + `createSortedRowModel` | 逻辑内置，**表头的箭头图标和点击区自己画** |
| 列筛选 / 全局筛选 | **内置** `columnFilteringFeature` / `globalFilteringFeature` | 逻辑内置，**筛选 UI（下拉、多选、日期范围）全部自己写** |
| 分页 | **内置** `rowPaginationFeature` + `createPaginatedRowModel`（客户端）；服务端分页是 `manualPagination` 模式 | **分页器 UI 自己画** |
| 行选择 | **内置** `rowSelectionFeature` | checkbox 自己画；跨页语义见 2.4 |
| 批量操作条 | **完全没有** | 它不是表格的概念。自己写：`table.state.rowSelection` 非空时渲染一条工具栏 |
| 列固定 | **内置** `columnPinningFeature` | 它只给你 `column.getIsPinned()` 和位移量，**`position: sticky` 的 CSS 自己写** |
| 列宽调整 | **内置** `columnResizingFeature` + `columnSizingFeature` | 拖拽手柄自己画 |
| 列显示隐藏 | **内置** `columnVisibilityFeature` | 下拉菜单自己画 |
| 行展开 / 子行 | **内置** `rowExpandingFeature` + `createExpandedRowModel` | — |
| **虚拟滚动** | **没有**（`dist/` 里搜不到任何 virtual 相关实现） | 要配 `@tanstack/react-virtual`（当前版本见 2.5，peer 覆盖 React 16–19，unpackedSize 56.5 KB） |
| 单元格选择 / 单元格跨列合并 | 内置 `cellSelectionFeature` / `cellSpanningFeature` | 我们用不上 |

**一句话概括 headless 的边界**：TanStack 管的是**从 `data` 数组算出"这一页该显示哪些行、按什么顺序"**，以及每个 header/cell 的状态查询方法。**`<table>` / `<thead>` / `<tr>` / `<td>`、每一个 class、每一个 aria 属性、所有的图标和交互控件，都是你的。**

具体"自己写多少行"见 2.5 节。

### 2.4 规模判断：1800 条规则要不要虚拟滚动

Qodo 的真实规则库是 **1805 条 / 129 页**（[Qodo 产品形态调研](25-qodo-产品形态.md)），Findings 页更夸张，表头写着 `Findings (47647)`、分页器是 `‹ 1 2 3 4 5 … 137 ›`。

**结论：不需要虚拟滚动。理由是分页的语义已经决定了这件事。**

拆开看：

- Qodo 自己就是**服务端分页**——129 页、137 页这种分页器不可能是前端切的。1805 条规则每条带 10 个字段（含名称、描述、来源、三个统计数），一次性拉到前端是几 MB 的 JSON，而且 `Passed` / `Detected` / `Merged` 三列是跨评审累计的统计值，本来就得后端算。
- 服务端分页下，**前端任意时刻手上只有一页 20–50 行**。20 行的表格用虚拟滚动是负优化——它引入绝对定位、行高测量、滚动容器，把一堆本来不存在的 bug 请进来。
- 虚拟滚动真正的阈值在**"一屏之内要渲染的 DOM 节点数"**，不在数据总量。10 列 × 50 行 = 500 个 `<td>`，每个 `<td>` 里还有徽章/链接，算下来一两千个节点——这个量级现代浏览器毫无压力。**〔推断〕** 要到几千行同屏（比如一个不分页的日志流）才值得上虚拟化。

**所以：v1 不做虚拟滚动。** 真要做，也是留给"diff 视图里的超长文件"，不是留给表格。

**但服务端分页带来一个真问题：跨页全选 + 批量操作。**

Qodo 的 Review Standards 页有"行首多选 + 底部批量条（Activate / Deactivate / Define scope）"。在服务端分页下，"全选"有两种语义，必须在**产品层**先定死：

1. **选中当前页**——`rowSelection` 里存这一页的 20 个 id，批量操作发 20 个 id。简单、无歧义。
2. **选中全部匹配当前筛选的行**——前端手上没有那 1805 个 id，只能存"一个筛选条件 + 一组排除项"，批量操作发的是**筛选条件**而不是 id 列表，由后端展开。

第二种才是 Qodo 那种 1805 条规则表真正需要的（"把所有 Severity=Recommendation 的规则停用"），但它是**后端 API 的形状问题**——批量接口的入参得是 `{filter, excludeIds}` 而不是 `{ids}`。TanStack 的 `rowSelection` 只是一个 `Record<rowId, boolean>`，它帮不了你。

> 这正好印证 ticket 里那句"看起来像前端工作的，很多其实是数据工作"。**跨页批量操作是一个后端 API 设计题，不是表格组件选型题。**

### 2.5 「自己写多少行」的实测，以及 antd Table 的取舍

#### 自己写多少行：约 225–250 行只够一半

把 [shadcn 官方 data-table 指南](https://ui.shadcn.com/docs/components/data-table) 的代码块逐块统计（实测，不是估算）：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `columns.tsx` | ~80 | 列定义 + 可排序表头 + 选择列 + 行尾操作菜单 |
| `data-table.tsx` | ~125 | `useTable` + 表格结构 + 排序状态 + 分页控件 + 筛选输入 + 列可见性下拉 + 行选择状态 |
| `page.tsx` | ~15 | 组装 |
| **合计** | **~225–250** | |

**但官方示例里没有列固定，也没有批量操作条**——这两样恰好是我们要的。**〔推断〕** 补上列固定的 sticky CSS、批量操作条、服务端分页接线之后，一个满足 Qodo 形态的 `<DataTable>` 壳在 **350–500 行**量级。

这个数字的意义：**它是一次性的**。写完这一个壳，Findings 页、Repositories 页、Review Standards 页各自只要写列定义（每页 ~80 行）。这就是 5.1 节把它单列成"最值钱的一次性投入"的原因。

#### 虚拟化怎么接（官方 v9 写法）

`@tanstack/react-table@9.2.4` 的 npm 包里随附了官方的 `with-tanstack-virtual` 材料，对应文档 `docs/framework/react/guide/virtualization.md` 和三个官方 example（`virtualized-rows` / `virtualized-columns` / `virtualized-infinite-scrolling`）。核心模式：

```tsx
const rows = table.getRowModel().rows           // 先拿 table 算好的 rows
const virtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 36,
  getItemKey: (index) => rows[index].id,
  overscan: 5,
})
```

官方标了两个 HIGH 级别的常见错误：**不要把 virtual 注册成 table feature**（它是渲染层组合，不是 Table 的 feature）；**不要虚拟化原始 `data`，要虚拟化 `table.getRowModel().rows`**（否则绕过排序/筛选/分页）。这套写法是 v9 专属的（用了 `table.FlexRender`），照搬 v8 教程会错。

我们 v1 用不上（2.4 节），但把这条记下来，省得将来做 diff 视图的超长文件时重新翻。

#### antd 6 的 Table

- **`virtual` 属性还在**（antd 5.9.0 引入，v6 沿用，没被移除或改名）。
- 开箱即用的能力：`rowSelection`（受控 `selectedRowKeys`，跨页靠自己维护）、`fixed`（列固定）、`sticky`（粘性表头，4.6.0+）、`filters` / `filterDropdown`、`sorter`（支持多列）、`expandable`——**全部是 prop 直传，不用拼装**。
- **底层换包了**：antd 6.6.3 依赖 **`@rc-component/table ~1.11.1`**（实测 `npm view antd@6.6.3 dependencies`），不再是独立的 `rc-table`——那个包停在 7.55.1（2025-10-09）。antd 团队把几十个 rc-* 组件统一迁到了 `@rc-component/*` 命名空间。**是包重组，不是引擎换代**，底层还是同一套血统。`@rc-component/table` 当前 1.12.0（2026-08-18）。
- antd 6 相对 5 的 Table breaking change（[迁移文档](https://ant.design/docs/react/migration-v6)，都是弃用/改名级别）：
  - `pagination.position` → `pagination.placement`
  - `onSelectInvert` / `onSelectMultiple` / `onSelectAll` / `onSelectNone` 收敛到 `onChange`
  - `filterDropdownOpen` → `filterDropdownProps.open`，`onFilterDropdownOpenChange` → `filterDropdownProps.onOpenChange`
  - `filterCheckall` → `locale.filterCheckAll`
  - `size` 的 `"middle"` → `"medium"`
- **〔未核实〕** 迁移文档提到"针对组件内部 DOM 的自定义样式需要检查调整"，但没有专门针对 Table 的清单。

#### 取舍：什么时候选哪个

**一句话**：**要快，选 antd Table；要样式主权和长期可控，选 TanStack 自己画。**

展开：

| 维度 | antd Table | TanStack v9 + 自建 |
| --- | --- | --- |
| 到第一个可用表格的距离 | 半天 | **350–500 行的一次性投入** |
| 十列 + 排序 + 筛选 + 行选择 + 列固定 | prop 直传 | 逻辑内置，**DOM 和 CSS 全自己写** |
| 批量操作条 | 也得自己写 | 也得自己写（**两边打平**） |
| 样式定制 | 受 antd token 体系和内部 DOM 结构约束 | 完全自己的 |
| 和 Tailwind 共存 | CSS 变量（v6）+ 工具类，**能共存但要处理层叠** | 天然一体 |
| bundle | 整包重，按需引入靠 tree-shaking | 表格逻辑 134 KB unpacked |
| 长期风险 | 跟 antd 大版本走（v6 已在弃用 100+ API，v7 会移除） | v9 刚 GA 5 周（2.1 节） |

**跨页全选这件事两边都不帮忙**——TanStack 的 `rowSelectionFeature` 是 `{rowId: boolean}` map、antd 的 `rowSelection` 也只认已加载的行。两边都得按 2.4 节说的 `{filter, excludeIds}` 模式自己搭，**工作量一样**。（MUI X DataGrid 有原生实现 `keepNonExistentRowsSelected`，但在 Pro 档。）

我们选后者，理由在 6.2 节。

-----

## 三、diff 视图

### 3.1 判据

ticket 说得很准：diff 视图是唯一真正难的组件，而难点不在"显示 diff"，在**在具体行上锚定 finding**。

所以核实的第一判据是：**能不能把一个自定义 React 组件挂在 diff 的某一行下面**（GitHub 行内评论那种整行展开的卡片）。这条不满足，别的都不用谈。

先确认 ticket 的前提：**dsh 确实一行 diff viewer 都没有**。读 `packages/client/ui-primitives/src/DiffBlock.tsx`（实测）：

```ts
export interface DiffHunk {
  path: string
  oldText: string | null   // 整块旧内容
  newText: string          // 整块新内容
}
```

它的 `buildRows()` 把 `oldText` 的每一行标成 `del`、`newText` 的每一行标成 `add`，**顺序拼接**——先全部旧行，再全部新行。没有 unified diff 解析、没有 hunk header、没有行号、没有左右对齐、没有任何逐行锚定的接口。它是一张"文件被改过"的展示卡片，不是 diff viewer。**ticket 的说法成立。**

### 3.2 逐个核实

#### react-diff-view 3.3.3

| 项 | 结论 |
| --- | --- |
| npm | 3.3.3，2026-03-30 |
| 许可证 | MIT |
| 仓库 | [otakustay/react-diff-view](https://github.com/otakustay/react-diff-view)，1,013 star，11 open issue，最后 push 2026-03-30 |
| **维护活跃度** | **近一年只有 2 个 commit**：2026-02-23 `fix: multiply markWord calls`、2026-03-30 `chore(release): 3.3.3`。再往前是 2025-07-24。 |
| **逐行挂 widget** | **原生支持，是一等公民 API** |
| split + unified | 都有：`viewType?: 'unified' \| 'split'` |
| 语法高亮 | 自己不带，靠 `tokens?: HunkTokens` 外部喂；**可以进 Web Worker**（`useTokenizeWorker(worker, payload, options)`） |
| React peer | `>=16.14.0` |

逐行锚定的证据（解包读 `types/Diff/index.d.ts`，第 13 行）：

```ts
export interface DiffProps {
    diffType: DiffType;
    hunks: HunkData[];
    viewType?: ViewType;                                    // 'unified' | 'split'
    generateAnchorID?: (change: ChangeData) => string | undefined;
    selectedChanges?: string[];
    widgets?: Record<string, ReactNode>;                    // ← 这一行
    renderGutter?: RenderGutter;
    gutterEvents?: EventMap;                                // 逐行事件
    codeEvents?: EventMap;
    renderToken?: RenderToken;
    tokens?: HunkTokens | null;
    ...
}
```

`widgets` 的 key 是 `getChangeKey(change)`（从 `types/utils/index.d.ts` 实测导出），value 是任意 `ReactNode`，渲染成该行下方的整行区域。**这就是我们要的"把 finding 挂在行上"。**

配套的还有：
- `renderGutter?: (options: GutterOptions) => ReactNode`，`GutterOptions` 带 `{change, side, inHoverState, renderDefault, wrapInAnchor}`——**hover 时在行号槽里画一个"+"按钮**这件事直接支持。
- `codeEvents` / `gutterEvents`：`Partial<{[K in 'onClick'|'onMouseEnter'|...]: (args: {side, change}, event) => void}>`，逐行事件带 change 上下文。
- `useMinCollapsedLines(minLinesExclusive, hunks, oldSource)`：把超过 N 行的未改动段折起来（GitHub 那种"展开 20 行"）。
- `expandCollapsedBlockBy` / `expandFromRawCode` / `insertHunk`：展开折叠段的工具函数。

**坑**：
- `dependencies` 里有**全量 `lodash@^4.17.21`**，还有 `diff-match-patch`、`gitdiff-parser`。lodash 全量进 bundle 是个体积问题（**〔推断〕** tree-shaking 能否生效取决于它内部是 `import {x} from 'lodash'` 还是 `import x from 'lodash/x'`，本次没核实）。
- **维护速度是真正的风险**：一年 2 个 commit。它没死（2026 年还在修 bug、还在发版），但它也不会为你解决新问题。1,013 star / 11 open issue 说明用户不多但没积压。

#### @git-diff-view/react 0.1.7

| 项 | 结论 |
| --- | --- |
| npm | 0.1.7，2026-07-13 |
| 许可证 | MIT |
| 仓库 | [MrWangJustToDo/git-diff-view](https://github.com/MrWangJustToDo/git-diff-view)，738 star，15 open issue，最后 push 2026-08-13 |
| **维护活跃度** | **近一年 ≥100 个 commit**（`gh api` 单页上限 100 即被截断），2026-08-13 仍在合 PR |
| **逐行挂 widget** | **有专门为此设计的 API**——比 react-diff-view 还对口 |
| split + unified | `DiffModeEnum = { SplitGitHub: 1, SplitGitLab: 2, Split: 3, Unified: 4 }`——**四种模式，且明确区分 GitHub 风格和 GitLab 风格的 split** |
| 语法高亮 | 自带 `lowlight` + `highlight.js`；`registerHighlighter` 可换成 refractor / starry-night / **shiki** |
| 虚拟滚动 | **没有**（`.d.ts` 里没有任何 virtual 相关 prop） |
| React peer | `^16.8 \|\| ^17 \|\| ^18 \|\| ^19` |

逐行锚定的证据（解包读 `index.d.ts`，`DiffViewProps<T>`）：

```ts
export type DiffViewProps<T> = {
  data?: { oldFile?: {...}, newFile?: {...}, hunks: string[] };
  extendData?: {
    oldFile?: Record<string, { data: T }>;      // key 是行号
    newFile?: Record<string, { data: T }>;
  };
  diffViewMode?: DiffModeEnum;
  diffViewWrap?: boolean;
  diffViewTheme?: "light" | "dark";
  diffViewFontSize?: number;
  diffViewHighlight?: boolean;
  diffViewAddWidget?: boolean;
  registerHighlighter?: Omit<DiffHighlighter, "getHighlighterEngine">;
  renderWidgetLine?: (p: { lineNumber, side, diffFile, onClose }) => ReactNode;
  renderExtendLine?: (p: { lineNumber, side, data: T, diffFile, onUpdate }) => ReactNode;
  onAddWidgetClick?: (lineNumber: number, side: SplitSide) => void;
  onCreateUseWidgetHook?: (hook: ...) => void;
};
```

这套 API 的形状和我们的需求**一一对应**：

| 我们要的 | 它的 API |
| --- | --- |
| 把 finding 挂在第 N 行（持久展示） | `extendData.newFile["N"] = { data: finding }` + `renderExtendLine` 渲染 |
| 行号槽的 "+" 按钮 | `diffViewAddWidget: true` + `onAddWidgetClick(lineNumber, side)` |
| 点了 "+" 之后弹出的临时输入框 | `renderWidgetLine`（带 `onClose`） |
| 泛型透传 finding 类型 | `DiffViewProps<T>` 的 `T` 就是你的 finding 类型 |

另外有 `extendDataToPreselectedLines<T>(extendData)` 工具函数，和 `maxLineToIgnoreSyntax`（超过 N 行就跳过语法高亮的**大文件保护开关**）。

**坑**：
- **版本号是 `0.1.7`**。作者自己把它标在 0.x，语义上随时可能破坏兼容。
- 738 star，是本节里生态最小的一个。出问题基本只能自己读源码。
- 依赖里有 `reactivity-store@^0.4.0`（作者自己的另一个库）——**多一层作者个人技术栈的耦合**。
- 没有虚拟滚动，几千行的 diff 全量渲染 DOM。有 `maxLineToIgnoreSyntax` 兜住高亮开销，但节点数还在。**〔未核实〕** 实际几千行的帧率表现。

#### Monaco Editor 的 diff editor（0.56.0）

| 项 | 结论 |
| --- | --- |
| npm | `monaco-editor` 0.56.0，2026-07-20；`@monaco-editor/react` 4.7.0，**2025-11-21** |
| 许可证 | MIT |
| 仓库 | [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor) 46,719 star / **858 open issue** / push 2026-09-10；[suren-atoyan/monaco-react](https://github.com/suren-atoyan/monaco-react) 4,742 star / push 2026-04-20 |
| **逐行挂 widget** | **能，但要绕一圈**：`diffEditor.getModifiedEditor()` 拿到 `ICodeEditor`，再 `changeViewZones(accessor => accessor.addZone(zone))` |
| split + unified | `renderSideBySide?: boolean`；还有 `renderSideBySideInlineBreakpoint` + `useInlineViewWhenSpaceIsLimited`（窄屏自动切 inline） |
| 大文件 | 有专门的保护：`maxComputationTime`、`maxFileSize`、`hideUnchangedRegions`、`diffAlgorithm: 'legacy' \| 'advanced' \| 'advanced-external' \| 'advanced-wasm'` |
| 体积 | `unpackedSize` **97.9 MB**（含全部语言的 worker） |

从 `monaco-editor@0.56.0/esm/vs/editor/editor.api.d.ts` 实测：
- `IDiffEditor.getOriginalEditor(): ICodeEditor` / `getModifiedEditor(): ICodeEditor`（第 6490、6494 行）
- `ICodeEditor.changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): void`（第 6400 行），紧挨着的注释原文：**"View zones are lost when a new model is attached to the editor."**
- `IViewZone`（第 5466 行）接受一个 `domNode`，所以 React 内容要用 `createPortal` 打进去。

**坑**：
- **体积**。97.9 MB 的包，就算按需加载也是一个数量级更重的东西。它本质是一个完整 IDE 编辑器内核，我们只要只读 diff。
- `@monaco-editor/react` 已经**快一年没发版**（4.7.0，2025-11-21），仓库最后 push 2026-04-20。不是死了，但明显慢。
- view zone 在换 model 时会丢——挂在上面的 finding 要自己重建。
- 858 个 open issue（这是 Monaco 的常态，不必过度解读）。

**它真正的优势**：如果 v1 之后要做**可编辑**的 diff（在 diff 里直接改代码、应用 suggestion），Monaco 是唯一现成的。我们 v1 只要只读展示，用不上。

#### CodeMirror 6 merge view（`@codemirror/merge` 6.12.2）

| 项 | 结论 |
| --- | --- |
| npm | 6.12.2，2026-06-09；`@codemirror/view` 6.43.11 |
| 许可证 | MIT |
| **仓库位置变了** | **GitHub 上的 `codemirror/dev` 和 `codemirror/merge` 已经 archived**（2026-04-15），开发迁到 Marijn Haverbeke 自建的 Forgejo：`https://code.haverbeke.berlin/codemirror/merge` |
| 维护活跃度 | **仍在维护**：6.12.2 于 2026-06-09 打 tag，2026-05-30 修 "cleanup of collapsed ranges affecting changed chunks"、2026-03-11 修 "prevention of chunk deletion after the last updated range" |
| 体积 | `@codemirror/merge` unpackedSize 183 KB（不含 `@codemirror/view` 等 peer） |

**仓库搬家这件事值得单独提**：npm 上 `@codemirror/merge` 的 `repository.url` 已经是 `git+https://code.haverbeke.berlin/codemirror/merge.git`，GitHub 那份是 archived 镜像。**如果按老习惯去 GitHub 提 issue 或读源码，会误判成"这个项目死了"**——它没死，只是不在 GitHub 了。

**逐行挂 widget：能，而且机制很干净。** 解包 `@codemirror/merge` 读 `dist/index.d.ts`（实测）：

- `unifiedMergeView(config)` 的返回类型是 **`(Extension | StateField<DecorationSet>)[]`**——它就是一组普通的 CodeMirror extension，你把它组合进一个普通 `EditorView`。**于是 CodeMirror 全套 `Decoration.widget` / `WidgetType` / block widget 在同一个 view 上原样可用。**
- `MergeView` 把两个编辑器**公开暴露**为 `a: EditorView` 和 `b: EditorView`，往哪一侧加装饰都行。

也就是说 CodeMirror 这条路**没有"diff 视图是个黑盒"的问题**——它不是一个封装组件，它是一组加在编辑器上的扩展。这是它相对 react-diff-view / @git-diff-view 的结构性优势。

代价是 **widget 是 DOM 不是 React**：`WidgetType.toDOM()` 返回一个 `HTMLElement`，React 内容要 `createPortal` 打进去，并自己管生命周期。和 Monaco 的 view zone 是同一类桥接工作。

其余实测到的配置（都在 `MergeConfig` / `UnifiedMergeConfig` 里）：

| 选项 | 作用 |
| --- | --- |
| `collapseUnchanged?: {margin?, minSize?}` | 折叠未改动段（默认前后留 3 行、至少 4 行才折） |
| `diffConfig.scanLimit` | **merge view 默认设成 500**——大文件保护 |
| `syntaxHighlightDeletionsMaxLength` | 删除块超过 3000 就不高亮 |
| `allowInlineDiffs` | 只有行内改动的 chunk 内联显示，而不是拆成删除行+插入行 |
| `gutter` / `highlightChanges` / `mergeControls` / `revertControls` | 变更标记、行内高亮、接受/拒绝按钮 |
| `getChunks(state)` / `goToNextChunk` / `acceptChunk` / `rejectChunk` | chunk 级导航与操作 |

文档里还有一条容易踩的：**"By default, views are not scrollable. Style them (`.cm-mergeView`) with a height and `overflow: auto`."**

**但它有一个和我们的数据形状不匹配的地方，见 3.3 节。**

#### diff2html 3.4.56

| 项 | 结论 |
| --- | --- |
| npm | 3.4.56，2026-01-31 |
| 许可证 | MIT |
| 仓库 | [rtfpessoa/diff2html](https://github.com/rtfpessoa/diff2html)，3,407 star，34 open issue，push 2026-05-08，**近一年 9 个 commit** |
| **逐行挂 widget** | **架构上不行**——它是 diff → HTML **字符串**的生成器 |
| npm 上没有声明 peerDependencies | 它不是 React 库 |

它把 unified diff 渲染成一坨 HTML 字符串，你 `innerHTML` 进去。**要在行上挂 React 组件，只能在生成的 DOM 里找到行元素，再 `createPortal` 打进去**——那等于在别人的 HTML 上做 DOM 手术，行号到 DOM 节点的映射要自己维护，重渲染时全部失效。

**对我们的需求：不合适。** 它适合"生成一份静态 diff 报告"，不适合"交互式的、行上挂业务对象"的场景。

### 3.3 一条被忽略的分界线：patch-native vs document-native

把五个方案按**"它吃什么数据"**分类，会冒出一条比"能不能挂 widget"更早的筛子：

| 方案 | 输入 | 类别 |
| --- | --- | --- |
| react-diff-view | `parseDiff(unifiedDiffText)` → `hunks` | **patch-native** |
| @git-diff-view/react | `{oldFile, newFile, hunks: string[]}` | **patch-native**（可选带全文） |
| diff2html | unified diff 文本 | patch-native |
| **Monaco diff editor** | 两个 `ITextModel`（两份完整文档），**自己重新算 diff** | **document-native** |
| **CodeMirror merge** | 两份完整文档（`a`/`b` 或 `original`），**自己重新算 diff** | **document-native** |

**我们的数据来自 GitLab MR API，拿到的是 patch。** 选 document-native 的方案意味着：

1. 要额外把**两个完整版本的文件内容**都取回来（更多 API 调用，大文件更贵）；
2. 前端重算的 diff **可能和 GitLab 页面上显示的 diff 不一样**——分块边界、移动检测、空白处理都可能不同。而我们的 finding 是后端基于 GitLab 的 patch 产出的，**两边对不上，行号就锚错了**；
3. CodeMirror 的 `diffConfig.scanLimit` 默认 500、Monaco 的 `maxComputationTime` / `maxFileSize`，都是在说"大文件时我会放弃或降级"——放弃的时候 finding 挂哪儿？

**这一条基本上把 Monaco 和 CodeMirror 排到了后面**，不是因为它们不行，而是因为它们解决的是"比较两份文档"，而我们的问题是"渲染一份已经算好的 patch，并在它的行上挂东西"。

> 反过来说：如果哪天要做**「在 diff 里直接改代码」**（应用 suggestion、行内编辑），document-native 才是对的形状，那时候 Monaco/CodeMirror 才变成正解。**v1 只读展示，用不上。**

### 3.4 GitHub / GitLab 自己用什么

- **GitHub**：设计系统 [primer/react](https://github.com/primer/react) 是开源的（3,899 star，MIT，push 2026-09-11），但**它是通用组件库，不含 diff 视图**。GitHub 的 diff 渲染没有开源部分可参考。
- **GitLab：开源，而且正好是我们要的那个参考实现。** 通过 `gh api` 读 `gitlabhq/gitlabhq` 的 `app/assets/javascripts/rapid_diffs/` 实测（GitLab 是我们的首发平台，见 [代码平台抽象与首发平台](../../.agents/notes/proposed/architecture/2026-09-15-platform-port-and-first-provider.md)）。

**它的架构和前端 diff 库完全不是一回事，值得单独说：**

1. **diff HTML 是服务端渲染、流式推给浏览器的**，不是前端算的。入口 `streaming/render_html_streams.js`，每个文件是一个 **Web Component**（`web_components/diff_file.js`）。
2. **行为用 adapter 模式逐个挂上去**（`adapters/` 下十几个文件）：`line_discussions.js`（行内讨论）、`expand_lines.js`（展开未改动行）、`line_highlighting.js`、`line_link.js`、`toggle_file.js`、`load_file.js`、`line_coverage.js`。
3. **store 里有 `code_quality.js` 和 `test_coverage.js`** —— 也就是说 **GitLab 自己就在往 diff 行上挂"代码质量"和"覆盖率"标注**，和我们要挂 finding 是同一类需求。

**行锚定是怎么做的**（读 `adapters/line_discussions.js` + `utils/line_utils.js`，实测）：

```js
// line_discussions.js：在目标行的 <tr> 后面插一个兄弟行，再把 Vue 组件挂进去
if (lineRow.nextElementSibling?.dataset.discussionRow === 'true') return;   // 防重复挂载
const [rowOldLine, rowNewLine] = getLineNumbers(lineRow);
const placeholder = lineRow.closest('tbody').insertRow(lineRow.sectionRowIndex + 1);
new Vue({ el: placeholder, ... })
```

```js
// line_utils.js：锚的标识
export function getLineCode({ id, row, oldLine, newLine }) {
  const left  = oldLine ?? getClosestLineNumber(row, 'old');
  const right = newLine ?? getClosestLineNumber(row, 'new');
  return `${id}_${left}_${right}`;              // <file_id>_<旧行号>_<新行号>
}
export function getLinePosition(row, side) {
  return {
    old_line: !side || side === 'old' ? oldLine : null,
    new_line: !side || side === 'new' ? newLine : null,
  };
}
```

**两条可以直接抄的结论：**

- **"在行下面插一个兄弟行"就是行业标准做法**——GitLab 手工 `insertRow` 干的事，`@git-diff-view/react` 的 `renderExtendLine` 和 react-diff-view 的 `widgets` 是同一件事的封装版。我们不需要发明什么。
- **锚不是一个行号，是一个三元组 `{old_line, new_line, type}` 加上 `diffRefs`**（`line_discussions.js` 里 `diffRefs` 是一路透传的 provide）。GitLab 的 MR discussion `position` 对象就是这个形状。**如果我们的 finding 锚定结构对齐 GitLab 的 `position`，将来把 finding 发成 GitLab 行内评论时就是零转换**——这条直接支持 6.3 节的建议。

**〔未核实〕** GitLab 超大 diff 的分片/折叠阈值（`expand_lines` 的具体策略、服务端一次流多少文件），以及 force-push 之后 `position` 怎么重定位。这两件要读 Ruby 侧（`lib/gitlab/diff/`），本次只看了前端。

### 3.5 判断

| 方案 | 吃什么数据 | 逐行挂 widget | 维护 | 体积 | split+unified | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **@git-diff-view/react** | **patch** | **专门设计的 API**（`extendData` + `renderExtendLine`） | 活跃（年 ≥100 commit） | 1.3 MB | 4 种模式 | **首选** |
| react-diff-view | **patch** | 一等公民（`widgets`） | **年 2 commit** | 1.5 MB（含全量 lodash） | 都有 | **备选**，API 最成熟 |
| CodeMirror merge | 两份文档 | 能，而且最干净（返回的就是普通 extension，全套 Decoration 可用）；但 widget 是 DOM，要 portal | 活跃（已搬离 GitHub） | 183 KB | `MergeView` / `unifiedMergeView` | **数据形状不匹配**（3.3 节） |
| Monaco diff | 两份文档 | 能，`getModifiedEditor().changeViewZones()` + portal；换 model 会丢 | 活跃 | **97.9 MB** | `renderSideBySide` | 数据形状不匹配 + **过重** |
| diff2html | patch | **架构上不行**（输出 HTML 字符串） | 年 9 commit | 2.0 MB | 都有 | 排除 |

**首选 `@git-diff-view/react`，备选 `react-diff-view`。**

理由：这两个都能满足硬判据，差别在**风险的形状不同**：

- `@git-diff-view/react` 的风险是**版本号 0.x + 生态小**（738 star）——API 可能变，出问题得自己读源码。
- `react-diff-view` 的风险是**作者基本不动了**（年 2 commit）——API 不会变，但也不会有新东西；遇到 bug 只能自己 fork。

选前者，是因为它的 API 是**为我们这个场景设计的**（`extendData` 的泛型 `T` 直接就是 finding 类型，`onAddWidgetClick` 直接就是行号槽的 "+"），用它写出来的代码量明显更少；而且它还在动，提 issue 有人应。

**〔推断〕** 两者的数据契约都是 unified diff 文本（`hunks: string[]` / `parseDiff(diffText)`），所以**如果要换，换的是渲染层，解析和 finding 锚定的数据结构不用动**。这让"先用 A，不行再换 B"成为一个可接受的赌注——前提是我们自己把「finding 锚到 `(文件, 侧, 行号)`」这层抽象捏在手里，不要直接把组件的 props 形状当成领域模型。**这一条是本节最重要的工程建议。**

-----

## 四、两套设计系统共存

这一节全部是**读 dsh 源码的实测**，工作树 `c291e7961a` / 包版本 `0.1.5-rc.2`。

### 4.1 先说结论

**代价比预想的小，但小的原因和预想的不一样。**

预想的风险是"dsh 有全局 CSS，会和 Tailwind 打架"。实测结果是：**我们要复用的那 4 个包，全局 CSS 一行都没有。** 真正的成本在另外三个地方——**CSS 变量的供给**、**Tailwind preflight 反过来污染 dsh**、以及**逃生舱其实不止这 4 个包**。

### 4.2 那 4 个包的样式是怎么组织的

#### 它们是一个特殊的构建通道

读 `packages/client/tsdown.client.ts` 和各包的 `tsdown.config.ts`（实测）：整个 `packages/client/` 下 50 多个包里，**只有 5 个走 `staticLinked()` 这个构建预设**——`ui-primitives`、`ui-slots`、`ui-dockkit`、`store`，加上 `web`（应用壳自己）。

**这 4 个包正好就是我们要复用的 4 个。** 这不是巧合：`staticLinked` 的定义注释里写着它是"编译壳静态链接的客户端库"通道，四条产物约定是：

1. 所有裸 specifier 保持为 `import`（不内联依赖）
2. `esm` + `platform: 'browser'`
3. sourcemap 链回源码
4. **样式随包发布**：相对 `.css` import 保持为相对外部引用，样式表按 `src` 相对路径发到 `lib/` 下，**"让 vite 成为 class 哈希的唯一所有者"**

相比之下，其余的 `ui-*` 包走 `clientBundle()`，产出的是调用 `window.__ModuleLoader__.load({id, factory})` 的**插件加载器产物**，而且 CSS 是在 factory 执行时**运行时注入 `<style data-plugin-css>` 到 `document.head`**。

**这个区别是整节的关键。** 我们选的 4 个包恰好是被设计成"给别人的 Vite 直接打包"的那一档，**不需要 dsh 的插件加载器**。

实测验证（`npm pack @deepseek-ai/dsh-client-ui-primitives@next` 解包）——`lib/index.js` 开头就是普通 ESM：

```js
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import clsx from "clsx";
import css from "./StateDot.module.css";
import css$1 from "./DisclosureRow.module.css";
...
```

包里随附 **26 个 `.module.css` 文件**（合计约 50 KB），`lib/index.js` 本身 431 KB 未压缩。**没有 `window.__ModuleLoader__`，没有运行时 style 注入。** 消费方的 Vite 按 CSS Modules 处理它们，class 名由我们的构建哈希。

#### 全局 CSS：这 4 个包一行都没有

实测：

```
$ find ui-primitives ui-slots ui-dockkit store -name "*.css" -not -name "*.module.css"
（空）

$ grep -rn ":root|^html|^body|^\* " ui-primitives ui-dockkit --include="*.css"
（空）
```

**全部是 `*.module.css`，没有一个 `:root` / `html` / `body` / `*` 选择器。**

`:global(...)` 一共出现 9 处，其中 8 处都嵌在本地 class 之下（`.markdown :global(.katex-display)`、`.answer > :global(div)`……），作用域没有外溢。**唯一一处例外**：

```css
/* ui-primitives/src/JsonTree.module.css:20 */
:global(body[data-ds-dark-theme]) .root { ... }
```

这是**从 `<body>` 读暗色标记**，不是往外写。影响范围：一个组件（JsonTree）的暗色配色。

`!important` 一共 5 处（MarkdownText 3 处、CodeBlock 2 处），都在自己的 module 作用域里。

**结论：这 4 个包的样式泄漏面 ≈ 0。** CSS Modules 的哈希 class 和 Tailwind 的工具类不可能撞名。

#### 真正的成本：108 个 CSS 变量得有人供给

这 4 个包的 CSS 全靠设计 token 取色，实测**引用了 108 个不同的 CSS 变量**（`--dsw-*` 全局 token、`--dsl-*` 组件级、`--dsh-*` 布局级、`--ds-*` 基础）。用量前几名：

```
36  --dsw-alias-label-primary
32  --dsw-alias-label-tertiary
26  --dsw-alias-label-secondary
22  --dsw-alias-state-error-primary
15  --dsw-alias-state-success-primary
13  --dsw-alias-interactive-bg-hover
...
```

这些变量**不在这 4 个包里**，它们定义在 `ui-theme`——而 `ui-theme` 不是我们要复用的包。`ui-theme/src/styles/` 下 6 张表一共定义 381 个变量（去重后）：

| 文件 | 行数 | 变量声明数 |
| --- | --- | --- |
| `design-platform.css` | 340 | 326 |
| `gradient-shadow-text.css` | 269 | 197 |
| `shiki.css` | 31 | 20 |
| `base.css` | 15 | 6 |
| `scrollbar.css` | 95 | 5 |
| `corner-shape.css` | 26 | 1 |

差集算出来：4 个包用到的 108 个变量里，只有 5 个在 `ui-theme` 里也找不到定义（`--dsh-file-type-icon-color`、`--dsh-toast-hold`、`--dsl-code-block-line-number-width`、`--dsl-code-block-line-white-space`、`--dsl-terminal-output-max-height`）——**〔推断〕** 这几个应该是靠内联 style 或 `var(x, fallback)` 兜底，本次没逐个追。

**好消息是这些变量的定义位置**。实测 `design-platform.css` 的顶层选择器只有四个：

```
4:    body {
80:   body[data-ds-dark-theme] {
156:  body {
249:  body[data-ds-dark-theme] {
```

**全部挂在 `body` 上，不是 `:root`。** 这意味着把 `body` 换成 `.dsh-scope`、`body[data-ds-dark-theme]` 换成 `.dsh-scope[data-dark]`，整套 token 就被限制在一个容器里了——因为**自定义属性只向下继承**。`ui-primitives` 的 README 也明说了这个设计意图（实测原文）：

> 它们只经 React 渲染，并从主题取得 `--dsw-*` 设计 token，因此**无需导入主题或 slot 系统即可适配任意插件**。

**所以供给 token 是一个"抄一张表、改一个选择器"的活，不是一个架构问题。**

#### 如果把 `ui-theme` 整个拖进来，才真的会漏

`ui-theme` 的样式是通过 `installThemeStyles(ctx)` 把 6 张表 `?inline` 成字符串、运行时 `document.head.appendChild(<style>)` 注入的（实测 `ui-theme/src/client/styles.ts`）。这 6 张表里有**两条真正的全局规则**：

```css
/* scrollbar.css：不加任何作用域，改的是整个文档的滚动条 */
::-webkit-scrollbar { width: var(--dsh-scrollbar-width); height: var(--dsh-scrollbar-width); }
::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb); ... }
```

```css
/* corner-shape.css：通配选择器，改的是页面上每一个元素和伪元素的圆角几何 */
@supports (corner-shape: superellipse(1.5)) {
  :root { --dsw-corner-shape: superellipse(1.5); }
  *, *::before, *::after { corner-shape: var(--dsw-corner-shape); }
}
```

还有一条 `gradient-shadow-text.css` 里的 `body, body *`（给每个元素声明 `--dsw-elevation-*`，只是变量，无直接视觉，但是个通配选择器）。

**这两条会改掉我们自己 UI 的滚动条外观和所有圆角形状。** 所以：**不要引入 `ui-theme`，自己抄 token 表。**

#### 另外几个包装层面的坑（都是实测）

**坑 A：npm 的 `latest` dist-tag 指向的是三个月前的第一个版本。**

```
@deepseek-ai/dsh-client-ui-primitives
  latest = 0.0.1-rc.1   （2026-08-10，首发）
  alpha  = 0.1.5-alpha.2
  next   = 0.1.5-rc.2   （2026-09-10，对应工作树）
```

`npm install @deepseek-ai/dsh-client-ui-primitives` 装到的是 **0.0.1-rc.1**，不是当前代码。而且 0.0.1-rc.1 的 **license 是 BSD-3-Clause**，0.1.5-rc.2 才是 MIT。**必须显式装 `@next` 或钉死版本号。**

`ui-dockkit` 和 `store` 的 `latest` 同样落后（分别是 0.1.5-alpha.1 和 0.1.2-alpha.2）。

**坑 B：这 4 个包的 `dependencies` 全是空的。**

解包 `@next` 版看 `package.json`：四个包的 `dependencies` 都是 `undefined`，`peerDependencies` 只有 `{"@deepseek-ai/cordis": "^4.0.2"}`。

但 `ui-primitives/lib/index.js` 实际 import 了 **21 个裸 specifier**：

```
react  react-dom  react/jsx-runtime  clsx  anser  katex
shiki/core  shiki/engine/javascript
@shikijs/langs/json  @shikijs/langs/shellscript  @shikijs/langs/typescript
mdast-util-from-markdown  mdast-util-gfm  mdast-util-math
micromark-core-commonmark  micromark-extension-gfm  micromark-extension-math
micromark-factory-space  micromark-util-character  micromark-util-classify-character
micromark-util-sanitize-uri  micromark-util-symbol
```

这不是 bug，是它有意的设计——`ui-primitives/README.zh.md` 原文：**"静态 ESM 为 Vite 保留第三方导入和样式；独立消费方自行提供开发依赖。"**

代价是：**这 21 个包的版本由我们负责，而且要跟着 dsh 的 `devDependencies` 走**（dsh 工作树里写的是 `shiki ^4.3.1`、`katex ^0.16.47`、`clsx ^2.0.0`；npm 上当前分别是 shiki 4.4.3、katex 0.18.7、clsx 2.1.1——katex 已经跨了一个 minor 大版本）。**版本漂移要自己盯。**

`store` 包只需要 `immer` + `zustand`，但它 import 的是 `zustand/vanilla` 的 `createStore`、`zustand/middleware` 的 `subscribeWithSelector`、`zustand/shallow` 的 `shallow`；dsh 工作树钉的是 `zustand ~4.4.7`，npm 上当前是 **5.0.15**。**〔推断〕** 这三个 API 在 zustand 5 里都还在，应该能跑，但没实跑验证。

**坑 C：`ui-dockkit` 自己的 README 说它不是稳定 API。** 原文实测：

> **内部引擎。** 本包之所以发布，是因为 Sidebar 以静态链接方式使用它，而非作为稳定 API：它的导出——`LayoutState`、`LayoutOp`、各 planner、`DockIntents`、`DockLabels`、`DockMode`——在任何版本都可能变化。

而且 **Qodo 那种形态根本用不上 dockkit**——它是"可拖拽分栏 + 标签页 + 浮窗"的停靠布局引擎（`applyOp` 返回逆操作、`Sequencer` 维护线性历史），适合 IDE，不适合"左侧固定导航 + 表格 + 抽屉"的控制台。**建议把 4 个包砍成 3 个：`ui-primitives` + `ui-slots` + `store`，`ui-dockkit` 不要。**

**坑 D：发版节奏。** `ui-primitives` 在 2026-08-10 到 2026-09-10 的 **31 天里发了 22 个版本**。这印证了 [dsh 嵌入形态调研](13-dsh-嵌入形态.md) 里那句"跟着走的成本比拍板时估的高"。

### 4.3 反方向的冲突：Tailwind preflight 会污染 dsh

dsh 不往外漏，但 **Tailwind 会往里漏**。这是被忽略的那一半。

Tailwind v4（当前 4.3.3）的 Preflight 规则（WebFetch 官方文档实测）：

```css
*, ::after, ::before, ::backdrop, ::file-selector-button {
  margin: 0; padding: 0;
  box-sizing: border-box; border: 0 solid;
}
h1,h2,h3,h4,h5,h6 { font-size: inherit; font-weight: inherit; }
ol, ul, menu { list-style: none; }
img, svg, video, canvas, audio, iframe, embed, object { display: block; vertical-align: middle; }
```

对照 dsh 的假设，有两处实打实的冲突：

**冲突一：`box-sizing`。** 实测全 `packages/client/` 下 `box-sizing` 只在十几个具体组件里单独声明，**没有任何全局 `* { box-sizing: border-box }`**。也就是说 **dsh 的组件是按浏览器默认的 `content-box` 写的**。例如 `Input.module.css`：

```css
.wrap { height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); }
```

`content-box` 下这是 33px 高，`border-box` 下是 32px。Tailwind preflight 把 `*` 改成 `border-box` 后，**dsh 所有带 border 的控件尺寸都会差一点**。不会崩，但会"看起来不太对"。

**冲突二：`ol, ul, menu { list-style: none }`。** `MarkdownText.module.css` 实测只写了：

```css
.markdown :where(ul, ol) { margin: 16px 0; padding-left: 18px; }
.markdown li::marker { line-height: 24px; color: var(--dsw-alias-label-secondary); }
```

**它从没设过 `list-style-type`，靠的是浏览器默认的圆点和数字。** `.markdown :where(ul, ol)` 的特异度是 (0,1,0)，压得住 preflight 的 `ol,ul,menu`（0,0,1），所以 margin 和 padding 保得住——但 `list-style: none` 没有对应的反向声明，**markdown 列表的圆点和序号会消失**。

> 这是一个很好的例子：两套设计系统的冲突，往往不在"两边都定义了同一个东西"，而在"**一边依赖浏览器默认，另一边把浏览器默认清掉了**"。这类冲突肉眼很难预判，只能逐组件看。

### 4.4 怎么隔离得干干净净

按**逃生舱的深度**分两种情况，代价差一个数量级。

#### 情况 A：只用那 3 个包（ui-primitives + ui-slots + store）

这种情况下 dsh 只是"一套别人的 React 组件"，不是"一个运行中的 dsh 客户端"。三步就能隔离干净：

**第一步，关掉 Tailwind 的 Preflight。** Tailwind v4 的官方做法（文档实测）——不写 `@import "tailwindcss"`，改成手动只引 theme 和 utilities：

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
/* 不引 tailwindcss/preflight.css */
```

然后把 reset 写成**只作用于自己那棵树**：

```css
.app-root, .app-root *, .app-root *::before, .app-root *::after { box-sizing: border-box; }
```

官方文档明确说了 **Preflight 无法被作用域限制**（原文：*"The documentation does not provide a method for scoping Preflight to a specific container. It applies globally."*），所以"关掉 + 自己写一个有作用域的"是唯一干净的路，不是绕路。

**第二步，把 dsh 的 token 表搬到容器上。** 抄 `ui-theme/src/styles/design-platform.css` + `gradient-shadow-text.css` + `base.css`（三张表覆盖绝大多数变量），把 `body` 全局替换成 `.dsh-scope`、`body[data-ds-dark-theme]` 换成 `.dsh-scope[data-dark]`。**不要抄 `scrollbar.css` 和 `corner-shape.css`**——那两张是真正的全局污染源。

**第三步，处理那一个读 `body` 的组件。** `JsonTree.module.css` 的 `:global(body[data-ds-dark-theme])` 是硬编码的。三个选择：不用 JsonTree（最省事）；或者真的在 `<body>` 上打这个属性（会让 dsh 的暗色和我们的暗色绑定）；或者 fork 那一个 module.css。

**〔推断〕** 这三步加起来是**一天以内的活**，不是一个架构负担。但它没有实跑验证——"抄一张 340 行的 token 表、批量替换选择器、跑一遍看有没有漏"这件事实际做起来大概率会冒出几个我现在看不见的细节。

Shadow DOM 这条路**不建议**：dsh 的 CSS Modules 是以独立 `.css` 文件发布、由 Vite 注入到 `document.head` 的，Shadow root 拿不到；要让它生效得自己截住 Vite 的 CSS 注入再塞进 shadow root，那是和构建工具较劲。

#### 情况 B：真的要一个"和 AI 聊一处代码"的 dsh 席位

**这种情况的代价完全不是一个量级，而且和 4 个包无关。**

实测依据：

1. `ui-slots` 是**纯类型/注册表核心，零运行时依赖**。它自己的 README 原文：*"引擎产物与渲染器宿主约定携带裸快照 source，绝不携带 React 钩子——钩子绑定属于渲染机制。"* 真正把 slot 渲染出来的是 **`ui-renderer`**。
2. `ui-renderer` 走的是 `clientBundle()` 通道——**需要 `window.__ModuleLoader__`**，也就是 dsh 自己那套插件加载器。
3. 聊天界面是 `ui-chat`，它的 `dsh.client.inject` 列出 **11 个前置插件**（实测 `ui-chat/package.json`）：
   ```
   dsh-api-session-controller, dsh-api-workspace-controller, dsh-client-locale,
   dsh-client-ui-conversation, dsh-client-ui-input-trigger, dsh-client-ui-layout,
   dsh-client-ui-renderer, dsh-client-ui-session, dsh-client-ui-settings,
   dsh-client-ui-sidebar-right, dsh-client-ui-workspace
   ```
4. 这些包里就包含 `ui-theme`（它的 `dsh.client.immediately = true`），于是 4.2 节说的 `::-webkit-scrollbar` 和 `*{corner-shape}` 会被注入到 `document.head`——**污染全页，而且没有容器可以挡。**

**所以逃生舱的真实形态是"在我们的应用里跑起半个 dsh web 客户端"，不是"复用 4 个包"。**

在这种情况下，唯一干净的隔离是 **iframe**：dsh 客户端在自己的文档里跑，全局 CSS 爱怎么注入怎么注入，通过 `postMessage` 和主界面通信。代价是跨 frame 的状态同步、尺寸联动、主题同步、以及一份独立的资源加载。

**判断**：逃生舱**值得留，但要按 iframe 规划，不要按"内嵌一个组件"规划**。如果按内嵌规划，会在"为什么我的表格圆角变形了"这种问题上耗掉比 iframe 更多的时间。

> 补一句：这一条也回答了 ticket 里"逃生舱留不留"的问题——**留，但它不是 v1 的东西**。它的成本不在样式，在"跑起半个 dsh 客户端"这件事本身，而那需要 dsh 的 host 层就位（见 [dsh 嵌入形态调研](13-dsh-嵌入形态.md)）。

-----

## 五、工作量的粗估

只给相对量级和排序，不给人日。基准单位设为 **1 = 一个标准表格页**（数字卡 + 筛选条 + 十列可排序表 + 行选择 + 批量条 + 分页 + 右侧只读抽屉），假设组件库和表格骨架已经搭好。

### 5.1 一次性投入（在任何页面之前）

| 项 | 量级 | 说明 |
| --- | --- | --- |
| 应用骨架（路由、左侧导航、顶栏、Background activity 面板） | **1.5** | 八个页面共用，一次投入 |
| **`<DataTable>` 通用壳**（排序头、选择列、列固定、分页器、空态、加载态、批量条插槽） | **2** | **约 350–500 行**（2.5 节实测推算）。这是最值钱的一次性投入——**做完之后每个表格页才是 1**，各页只写 ~80 行列定义 |
| 设计 token + 徽章/状态体系（5 种健康态 + 8 种索引态 + 5 种 finding 态 + 3 档 severity） | **1** | 枚举本身是领域建模，UI 只是映射表 |
| 右侧抽屉通用壳 | **0.3** | Radix Dialog 加位移 |
| dsh 样式隔离（4.4 节情况 A 的三步） | **0.5** | 只有在 v1 就要用 dsh 组件时才付 |

一次性投入合计约 **5**。

### 5.2 八个页面，从贵到便宜

| 排名 | 页面 | 量级 | 为什么 |
| --- | --- | --- | --- |
| 1 | **Configurations** | **4–6** | **最贵，而且贵得离谱**。六个 Tab；Display Tab 内部九个设置组；**两个矩阵控件**（行 High/Med/Low × 列 None/1/3/5/All，和行 × Inline/Summary/Both/Drop）；**5 节展开状态的三态控件**；Presets 四档与"改任一项自动切 Custom"的联动；组织级/仓库级两层覆盖语义；Save/Reset/Dismiss(N) 的脏状态管理；**外加一个并排的 Live Preview 窗格——它要实时渲染 markdown 评论在目标平台的样子，等于把 PR 评论渲染器搬进控制台**。这一页的控件没有一个是标准件。 |
| 2 | **diff 视图**（不是八页之一，但要算） | **3–4** | 组件本身接起来不贵（`@git-diff-view/react` 的 `extendData` + `renderExtendLine` 是现成的）。贵在周边：文件树/文件切换、大 diff 的折叠与"展开 N 行"、finding 到 `(文件, 侧, 行号)` 的锚定层、行号在 diff 更新后的漂移处理、评论态与只读态、跳转/深链。**最贵的一条是行锚定在 rebase/force-push 后失效怎么办**——那是数据问题，不是组件问题。 |
| 3 | **Review Standards（规则表）** | **2.5** | 表格本身是 1，但它额外背着：**规则编辑抽屉表单**（7 个字段，含 Scope 的 Global/Org/Repo 三选一 + 路径模式）、**Generate 四步向导**（含"Related rules check"的冲突/重复/作用域重叠检测）、**Define scope 的确认弹窗**（上限 25 实体、每仓路径模式、不可撤销警告）、三个 Tab、导出 CSV。 |
| 4 | **Home** | **1.5** | 三块内容各不相同：活动流、suggested actions、Connections 面板（含接入向导入口和无权限置灰）。没有一块能复用表格壳。 |
| 5 | **Repositories** | **1.3** | 标准表格 + 每行一个 toggle + 两套状态徽章 + 行尾菜单 + 四节抽屉 + 三个 Tab。比基准略贵在 Tab 和抽屉分节。 |
| 6 | **账号管理**（Users/Teams/Roles/API keys/SSO） | **1.2 × N** | 每个子页都是标准表格 + 表单。**便宜但个数多**——按 5 个子页算总量不小，但每个都是复用。 |
| 7 | **Findings** | **1** | **最标准的一页**：三张指标卡 + 六个下拉筛选 + 搜索 + 八列表 + 分页 + 只读详情抽屉。**做完通用 DataTable 之后，这一页几乎是填空。** |
| 8 | **Analytics / Billing** | **0.8** | 整个产品只有一个柱状图（在计费页）。两视图切换 + 日期范围选择器 + 一张流水表。**最便宜的一页。** |
| — | Integrations | **0.5** | 卡片网格 + 连接状态，没有表格。 |

### 5.3 三条会误判的地方

**一、最贵的不是看起来最复杂的。** 直觉会说 diff 视图最贵，实际 **Configurations 页更贵**——因为 diff 视图有现成组件扛住 80%，而 Configurations 页的矩阵控件、三态控件、Live Preview 一个现成的都没有。

**二、表格页之间的成本差异远小于表格页和非表格页的差异。** Findings、Repositories、Review Standards 三个表格页的 UI 成本是 1、1.3、2.5，而 Configurations 一个页顶四到六个。**通用 DataTable 壳的投入回报极高**——它把三到四个页面从"各写一遍"压成"填列定义"。

**三、ticket 里那句提醒是对的，而且比想象的更严重。** 规则表最有价值的 `Passed` / `Detected` / `Merged` 三列**在前端是三个数字**，在后端是一条跨多次评审累计每条规范命中与被无视的统计流水线，依赖 [评估基线](../../.agents/notes/proposed/testing/2026-09-12-evaluation-baseline-benchmark.md) 和结构化 finding 的追溯字段。Repositories 页的 5 种健康态 + 8 种索引态、Findings 页的 5 种 state（尤其 `Ignored` = "开发者没解决就把 PR 合了"），**全都是领域建模，不是组件问题**。

**按这份估算，v1 的最小集应该是：应用骨架 + 通用 DataTable + Findings 页 + Review Standards 页（先不含向导）。** 这四项覆盖了差异化最强的部分，量级约 5–6，而且 Findings 和 Review Standards 正好是 ticket 里点名的两个核心页。**Configurations 用配置文件代替、Analytics 押后**——它们分别是最贵的和最便宜的，都不适合在 v1 里做。

-----

## 六、推荐组合

### 6.1 选型

| 层 | 选择 | 版本（2026-09-12） |
| --- | --- | --- |
| **组件库** | **shadcn/ui**（CLI 生成，base 选 Radix；Tailwind CSS 4） | `shadcn` 4.21.0、`@radix-ui/react-*` 1.1.x、`tailwindcss` 4.3.3 |
| **表格** | **TanStack Table v9** + 自建 `<DataTable>` 壳 | `@tanstack/react-table` 9.2.4 |
| **diff 视图** | **@git-diff-view/react**（备选 react-diff-view） | `@git-diff-view/react` 0.1.7 |
| 虚拟滚动 | **v1 不做**。真要做时才引 | `@tanstack/react-virtual` |
| dsh 复用 | **3 个包，不是 4 个**：`ui-primitives` + `ui-slots` + `store`，**砍掉 `ui-dockkit`** | 全部钉 `0.1.5-rc.2`，**装 `@next` 不要装 `latest`** |
| 逃生舱 | **iframe**，不是内嵌。且不是 v1 | — |

### 6.2 取舍理由

**为什么是 shadcn 而不是 antd。** antd 在"十列可排序表格"这个形态上确实最省事——`sorter` / `rowSelection` / `fixed` 都是 prop。但有三条压过去了：

1. **我们是开源产品，样式是要被人改的。** antd 的整套设计语言会成为下游的既成事实；shadcn 的组件代码在我们仓库里，是可读可改的普通 React。
2. **diff 视图和 dsh 席位这两块本来就不在 antd 的体系里**，选 antd 等于三套设计系统而不是两套。
3. **antd 的 CSS-in-JS 和我们隔离 dsh 用的那套 Tailwind layer 手法是两条不同的路**——同时用会让 4.4 节的隔离方案失效，得重新设计。

代价明确：**表格的 DOM 和样式全部自己写**，约 350–500 行、折合 2 个单位的一次性投入（2.5 / 5.1 节）。这笔投入是一次性的，且它产出的是我们自己的资产。

**base 选 Radix，但这个选择现在是可逆的。** shadcn 的 registry 已经为每个组件同时提供 Radix / Base UI / React Aria 三种底层（1.5 节）。Radix 仍是最成熟、被验证最多的一档；而 Base UI 在 2025-12-11 GA、当前 1.8.0 月度迭代（1.3 节），**是一年后值得重新评估的选项**。因为 shadcn 已经把这层解耦了，将来换 base 不用推翻整套。

**为什么是 TanStack v9 而不是 v8。** v9 GA 只有 5 周，正常情况下应该等——但我们是新项目，v8 的"稳定"对我们没有价值（我们没有存量代码），而 v8 已经停更 17 个月。决定性的一条是**shadcn 的 data-table 指南已经写成 v9**：生态里最大的下游已经过去了，我们跟着它走不会孤立。

**为什么是 @git-diff-view/react 而不是 react-diff-view。** 两个都过了硬判据（逐行挂 widget）。选前者是因为它的 API 形状和需求一一对应（`extendData<T>` 的 `T` 就是 finding 类型、`onAddWidgetClick` 就是行号槽的 "+"），写出来代码量明显少；而且它在动（年 ≥100 commit），react-diff-view 一年只有 2 个 commit。

**为什么砍掉 ui-dockkit。** 它自己的 README 说它是内部引擎、导出随时会变；而且 Qodo 那种"固定左导航 + 表格 + 抽屉"的形态根本不需要停靠布局引擎。留着它只增加版本跟随成本。

**为什么 v1 不做虚拟滚动。** 1805 条规则是**服务端分页**的 1805 条，前端任何时刻只有一页。虚拟滚动解决的是"一屏内 DOM 节点过多"，不是"数据总量大"。（2.4 节）

### 6.3 最大的那个坑

**不是组件选型，是 finding 到代码行的锚定在代码变了之后会失效。**

这件事的形状是：

- 我们把 finding 挂在 `(文件路径, 侧, 行号)` 上，`@git-diff-view/react` 的 `extendData` 就是按行号做 key 的（`Record<string, {data: T}>`，key 是行号字符串）。
- 但 PR 会追加 commit、会 rebase、会 force-push。**行号会漂，文件会改名，那一行甚至会消失。**
- 这时 finding 该显示在哪？Qodo 给了答案——它有一个 `Outdated` 状态（"底层代码变了，finding 不再相关"），还有 `Previous reviews` 折叠区保留历史轮次。**也就是说 Qodo 也没解决行锚定失效，它是用状态机把这个问题产品化掉了。**

**为什么这是"最大的坑"**：因为它**看起来是前端问题，实际是数据模型问题，而且它会倒逼组件接口**。如果一开始直接把 `extendData` 的形状当成 finding 的存储形状，等到要处理 rebase 时就得把渲染层和数据层一起改。

**防御措施**（现在就要做的一件事）：

在 diff 组件之上加一层我们自己的锚定抽象。**这一层的形状照抄 GitLab 的 `position` 对象**（3.4 节实测）：`{old_path, new_path, old_line, new_line, type, diff_refs: {base_sha, start_sha, head_sha}}`，再补上**代码内容指纹 + 上下文**（`lineContent`、`contextBefore`、`contextAfter`）用于重定位。渲染时才把它**解算**成当前 diff 里的行号。

这样得到三件事：

- **换 diff 组件**（`@git-diff-view/react` → `react-diff-view`）只改解算层的输出格式，领域模型不动；
- **代码变了**，解算层返回"找不到"，finding 自动进 `Outdated` 态（Qodo 的那个状态），而不是挂在一个错误的行上；
- **发成 GitLab 行内评论时零转换**——因为存的本来就是 GitLab 的 `position` 形状。

`extendData` 始终是**渲染时临时算出来的**，不是持久化的东西。

这一层大概几百行，但它决定了 diff 视图是"能用"还是"三个月后要重写"。

**第二个坑（量级小一档，但更容易被忘）**：dsh 那 4 个包的 `dependencies` 是空的、`latest` dist-tag 指向三个月前的 BSD-3 版本、31 天发了 22 个版本。**装依赖这件事必须用 lockfile 钉死到具体版本，并且写一条 CI 检查确认装到的是 `0.1.5-rc.2` 而不是 `0.0.1-rc.1`。** 这不是什么深刻的问题，但它会在某个周一早上让一个新同事的环境跑不起来。
