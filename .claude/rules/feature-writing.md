---
paths: ["features/**/*.feature"]
---

# Feature 文件编写准则

改动 `features/` 下任何 `.feature` 前，先遵守以下铁律。语义级修改（改行为、改场景）优先走主流程（wayfinder 对齐 → to-spec 重生成，同名场景整体替换）；直接手改必须自行满足全部规则——保存后 lint hook 会自动校验，违规会被喂回修复。

1. **中文业务语言**：内容全中文——Feature 标题、场景名、Given/When/Then 步骤、As a / I want / So that 头部。Gherkin 关键字一律英文原生（`Feature:` `Scenario:` `Given` `When` `Then` `And` `But`），禁止 `# language: zh-CN` 与方言关键字（功能:/场景:/假如/当/那么）。标签与表格中的技术标识符（字段名、路径、URL）保持英文。
2. **V3 标签**：每个场景的有效标签（Feature 级 ∪ 场景级）必须恰好各含一个 `@layer:`(api|ui|e2e|config)、`@level:`(bvt|l1|l2|l3)、`@spec:`(main|normal|exception|constraint)。`api` 指模块最外层接口——服务仓库为 HTTP 接口，Go 模块仓库为导出 API。标签行必须紧邻 `Scenario:`/`Feature:` 的上一行（可多行堆叠）；放在关键字之后是非法 Gherkin（behave ParserError）。`@level:`/`@spec:` 禁止上提到 Feature 级（标签是并集继承）；只有全场景一致的 `@layer:` 可上提，上提后场景级不得重复声明。
3. **真实样例数据**：禁止 A/B/C、user1、组1、Foo/Bar、测试部门、xxx公司、11111、lorem ipsum 等占位符；使用真实领域词汇（华东区、市场办公中心、上海市、张伟、李娜、业务合理的金额量级）。
4. **业务视角**：后端校验类场景（数量上限、权限、字段校验等）从用户视角描述；禁止"服务端收到请求""服务端应拒绝""返回响应"、HTTP 方法/路径/状态码、数据库操作等技术语言。口诀：Given 用户所处的业务状态，When 用户的操作意图，Then 用户能看到的结果。
5. **状态标签归属**：`@status:pending` = 已评审、待实现，场景级声明；场景经 scenario-loop（场景循环）通过审查与回归后由循环移除该标签——不要手工翻转。

```gherkin
# ✅ 正确形态
@layer:api
Feature: 用户登录
  As a 注册用户
  I want 使用邮箱密码登录系统
  So that 我可以访问个人数据

  @level:bvt @spec:main @status:pending
  Scenario: 使用正确的邮箱和密码成功登录
    Given 用户 "张伟" 已注册，密码为 "Secure123!"
    When "张伟" 使用密码 "Secure123!" 登录
    Then 应该看到 "欢迎回来，张伟"
```
