@layer:api @story:round-comparison
Feature: 多轮评审对比
  As a 评审人
  I want 查看本轮 finding 相对上一轮的变化与处置参考
  So that 我能结合已有判断继续评审当前代码

  @level:bvt @spec:main
  Scenario: 新一轮标记新出现与上一轮也有并列出本轮未再出现的 finding
    Given 库存 PR 上一轮有三条中危 finding 且其中一条已被驳回
    When 新一轮保留相同代码问题和同规范同标题问题并新增一条问题
    Then 本轮两条 finding 标记为上一轮也有且新增一条标记为新出现
    And 上一轮驳回理由可供参考且本轮 finding 仍为待处理
    And 上一轮剩余的一条 finding 列入本轮未再出现
