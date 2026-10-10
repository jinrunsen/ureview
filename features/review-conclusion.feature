@layer:api
Feature: 按展示问题推出评审结论
  As a 评审人
  I want 根据本轮展示的问题了解评审结论
  So that 我能决定接下来需要检查哪些代码

  @level:bvt @spec:main @story:review-conclusion
  Scenario: 展示高危 finding 时建议修改并保留处置后的问题条数
    Given 库存评审展示一条高危和一条中危 finding
    And 评审人采纳了库存高危 finding 并驳回中危 finding
    When 评审人查看库存评审结论
    Then 库存评审结论为 "建议修改"
    And 库存评审结论包含高危 1 条、中危 1 条、已处置 2 条

  @level:l1 @spec:normal @story:review-conclusion
  Scenario: 仅展示中危 finding 时需要人工判断
    Given 库存评审展示五条中危 finding 并折叠一条高危 finding
    When 评审人查看库存评审结论
    Then 库存评审结论为 "需要人工判断"
    And 库存评审结论包含高危 0 条、中危 5 条、已处置 0 条

  @level:l1 @spec:normal @story:review-conclusion
  Scenario: 没有展示高中危 finding 时明确未发现高中危问题
    Given 库存评审仅发现低危 finding
    When 评审人查看库存评审结论
    Then 库存评审结论为 "未发现高中危问题"
    And 库存评审结论包含高危 0 条、中危 0 条、已处置 0 条
