@layer:api @story:repository-rules
Feature: 规范参与评审
  As a 评审人
  I want 评审使用团队全局规范和仓库规范并保留依据
  So that 我能确认规范结论来自哪条约定

  @level:bvt @spec:main
  Scenario: 数据库全局规范与仓库规范共同参与评审
    Given 仓库 "payment-gateway" 已接入
    And 团队已启用全局规范且仓库有针对 Go、TypeScript 和不同目录的规范
    When 开发者 "李娜" 新建 PR "统一库存释放与结算页面"
    Then 本轮选用规范恰好为 "G-001,R-007"
    And 产出模型和评分模型都收到这两条规范的正文
    And 未匹配规范没有进入模型的规范上下文

  @level:l1 @spec:normal
  Scenario: 修改全局规范后新 PR 使用新内容而旧评审保留原文
    Given 全局规范 "G-001" 的正文为 "释放库存前获取订单级锁"
    And PR "修复订单超时未释放库存" 已按该规范完成评审
    When 全局规范 "G-001" 的正文改为 "释放库存前获取订单级锁，并设置锁超时"
    And 开发者 "李娜" 新建另一个 PR "补齐库存锁的超时处理"
    Then 新评审选用规范 "G-001" 的正文为 "释放库存前获取订单级锁，并设置锁超时"
    And 旧评审选用规范 "G-001" 的正文仍为 "释放库存前获取订单级锁"
    And 两次评审的规范来源分别保留对应的数据库版本

  @level:l1 @spec:normal
  Scenario: 未配置全局规范时仍可完成评审
    Given 仓库 "payment-gateway" 已接入
    And 团队没有启用任何全局规范
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    Then 该评审状态为 "已完成"
    And 本轮没有注入全局规范
