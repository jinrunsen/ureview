@layer:api @story:rule-detail
Feature: 规范详情与执行记录
  As a 团队负责人
  I want 读取规范的实际命中及处置记录
  So that 我能判断规范的执行情况

  @level:bvt @spec:main
  Scenario: 工作台与 Git 规范统一展示执行记录及处置统计
    Given 库存评审分别命中工作台规范与 Git 规范各两次
    When 张伟分别采纳和驳回两种来源规范的 finding
    Then 两种规范详情均展示两条执行记录及各一次采纳和驳回
    And 执行记录包含 PR、轮次、严重度、处置人和驳回理由
