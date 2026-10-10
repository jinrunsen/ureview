@layer:e2e @story:rule-library-reading
Feature: 阅读规范库条目与应用后的规范
  As a 团队管理员
  I want 展开规范的解释和代码示例并选择应用
  So that 我能理解规范并决定如何应用到团队

  @level:bvt @spec:main
  Scenario: 展开规范库条目并在应用后阅读代码示例
    Given 张伟已登录并打开规范库
    When 张伟展开 C 陷阱与缺陷的条目和 getchar 的正反例
    Then 页面展示原文名称、摘要、正文、检查什么、为什么和怎么改
    And 反例与正确示例按 C 语言高亮
    When 张伟选择 getchar 条目应用并打开已应用的规范
    Then 规范详情展示完整说明及高亮的正反例

  @level:l1 @spec:normal
  Scenario: 已应用的规范可再次选择且没有规范库更新入口
    Given 张伟所在团队已应用旧版的 getchar 规范
    When 张伟打开规范库并展开该条目
    Then 该条目可以勾选且整套应用按钮可用
    And 页面提供已应用规范的详情链接且没有规范库更新入口
    When 张伟再次应用该条目
    Then 页面提示已有规范已跳过
