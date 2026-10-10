@layer:api
Feature: 评审列表
  As a 评审人
  I want 一眼看清有哪些 PR 待评审、哪些还没人看过
  So that 我能决定先看哪一个，也不会和同事重复劳动

  @level:bvt @spec:main
  @story:review-list
  Scenario: 评审人查看待评审的 PR 列表
    Given 仓库 "payment-gateway" 中的 PR "修复订单超时未释放库存" 由 "lina" 提交且已完成评审
    And 该评审产出了 2 条高危 finding 与 1 条中危 finding
    When 评审人 "张伟" 查看评审列表
    Then 列表中包含 "修复订单超时未释放库存"
    And 这一条的状态为 "已完成"
    And 这一条的仓库为 "commerce/payment-gateway"
    And 这一条的作者为 "lina"
    And 这一条的高危 finding 数为 2
    And 这一条的中危 finding 数为 1

  @level:l1 @spec:normal
  @story:review-list
  Scenario: 评审人按仓库与状态筛选列表
    Given 评审列表中有以下 PR
      | 仓库              | PR 标题                  | 状态   |
      | payment-gateway | 修复订单超时未释放库存         | 已完成 |
      | payment-gateway | 结算金额改用整数分            | 进行中 |
      | order-service   | 订单状态机重构               | 已完成 |
    When 评审人 "张伟" 筛选仓库 "payment-gateway" 且状态 "已完成"
    Then 列表中只包含 "修复订单超时未释放库存"

  @level:l1 @spec:normal
  @story:review-list
  Scenario: 还没有任何人看过的 PR 被单独标出
    Given PR "修复订单超时未释放库存" 已完成评审且没有任何人查看过它的评审
    And PR "结算金额改用整数分" 已完成评审且评审人 "张伟" 查看过它的评审
    When 评审人 "陈静" 查看评审列表
    Then "修复订单超时未释放库存" 被标记为 "还没人看过"
    And "结算金额改用整数分" 不带 "还没人看过" 标记

  @level:l1 @spec:normal @status:pending
  Scenario: 评审人在列表上看到自己在每个 PR 上的处置进度
    Given PR "修复订单超时未释放库存" 的评审产出了 5 条 finding
    And 评审人 "张伟" 已处置其中 2 条
    When "张伟" 查看评审列表
    Then "修复订单超时未释放库存" 这一条的处置进度为 "2 / 5"

  @level:l1 @spec:normal @story:review-list
  Scenario: 分页查看列表时所有 PR 都恰好出现一次
    Given 评审列表中有以下 PR
      | 仓库              | PR 标题               | 状态   |
      | payment-gateway | 修复订单超时未释放库存      | 已完成 |
      | payment-gateway | 结算金额改用整数分         | 已完成 |
      | order-service   | 订单状态机重构            | 已完成 |
    When 评审人 "张伟" 逐页查看每页 2 条的评审列表
    Then 所有 PR 恰好出现一次且总数为 3

  @level:l1 @spec:normal @story:review-list
  Scenario: 已看过的 PR 再次评审后新一轮仍标为未查看
    Given PR "修复订单超时未释放库存" 已完成评审且评审人 "张伟" 查看过它的评审
    When PR "修复订单超时未释放库存" 完成新一轮评审
    And 评审人 "张伟" 查看评审列表
    Then 列表中只包含 "修复订单超时未释放库存"
    And "修复订单超时未释放库存" 被标记为 "还没人看过"
