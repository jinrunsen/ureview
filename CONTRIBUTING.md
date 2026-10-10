# 约定

## 语言

**代码一律英文,文档和注释用中文。**

「代码」指所有会被解析器读到的名字：变量、函数、类型、接口、字段、常量、文件名、数据库表名与列名。

「文档和注释」指所有给人读的散文：注释、README、提交信息、以及测试名和 `.feature` 场景描述这类描述性字符串。面向用户的输出（错误提示、日志）也用中文，产品本身是中文的。

| | 例子 |
|---|---|
| 代码，英文 | `loadConfig`、`migrationsDir`、`schema_migrations.filename` |
| 注释与文档，中文 | `// 写错的端口要当场报出来` |
| 测试名，中文 | `it("端口不是个数时，启动就失败而不是悄悄退回默认值")` |
| 用户可见的输出，中文 | `throw new Error(\`缺少必填配置 ${name}\`)` |

这条界线不是风格偏好。标识符会离开代码库——数据库列名进 pg_dump、CSV 导出、ORM 映射和第三方工具，每一层的编码与引号处理都是一次赌博；导出的类型名会出现在依赖方的代码里。而注释和测试名不会离开，它们的读者只有维护这个仓库的人。

文案用朴素写法：陈述功能，不用对比句式和推销腔。

## 场景文件

`features/` 下的 `.feature` 有自己的一套铁律，改动前先读 [`.claude/rules/feature-writing.md`](.claude/rules/feature-writing.md)。保存时会自动跑结构校验，也可以手动跑：

```
sh .claude/hooks/lint-feature.sh features/findings.feature
```

## 提交前

```
npm run typecheck
npm test
```

测试需要数据库开着（`docker compose up db -d`）。`typecheck` 覆盖测试文件在内的全部源码，`build` 只编译要发布的部分。
