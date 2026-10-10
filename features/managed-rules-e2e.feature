@layer:e2e @story:managed-rules-editor
Feature: 编辑生成的团队规范
  As a 团队管理员
  I want 在规则生成面板中配置规则并回到目录
  So that 我可以确认规则内容和适用范围

  @level:bvt @spec:main
  Scenario: 生成后选择多个仓库和路径并查看已保存规则
    Given 张伟已在工作台登录并接入支付和库存仓库
    When 张伟从团队规范打开生成新规则面板
    And 张伟输入规则意图并生成草稿
    Then 面板展示可编辑的正文、正反例、分类和严重级别
    When 张伟选择指定仓库并分别填写支付与库存路径
    And 张伟保存并启用规范
    Then 面板显示已保存状态并保留所选仓库和路径
    And 返回列表后仍可搜索到这条规范
