@layer:api
Feature: 评审度量
  As a 团队里的一名成员
  I want 看到评审覆盖率与采纳率这些数字
  So that 团队自己能看见约定有没有被执行，而不需要谁来罚

  @level:l1 @spec:normal @status:pending
  Scenario: 评审人查看本月未经评审就合并的 PR 数量
    Given 仓库 "payment-gateway" 在 2026 年 9 月合并了 12 个 PR
    And 其中 3 个在合并前没有任何人查看过它的评审
    When 评审人 "陈静" 查看仓库 "payment-gateway" 在 2026 年 9 月的评审覆盖情况
    Then "未经评审就合并" 的 PR 数为 3
    And 评审覆盖率为 "75%"

  @level:l1 @spec:normal @status:pending
  Scenario: 采纳率的分母区分被驳回与被无视
    Given PR "修复订单超时未释放库存" 合并后的 finding 处置结果如下
      | finding 标题            | 状态       |
      | 库存释放未加分布式锁         | Resolved  |
      | 超时时间硬编码为 30 秒       | Dismissed |
      | 错误日志缺少订单号           | Ignored   |
      | 重试次数未设上限            | Ignored   |
    When 评审人 "陈静" 查看该 PR 的处置统计
    Then 统计结果为采纳 1 条、驳回 1 条、被无视 2 条
    And 采纳率为 "25%"
