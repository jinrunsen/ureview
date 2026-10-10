@layer:api
Feature: 只读边界
  As a 要过企业安全评审的管理员
  I want 这套工具对代码平台只读、一个写方法都没有
  So that 即使它被攻破或出故障，也造不成任何破坏，更不会卡住任何人的合并

  @level:bvt @spec:main
  @story:review-new-pull-request
  Scenario: 自动评审不向代码平台写入任何内容
    Given 仓库 "payment-gateway" 已接入
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    And 该 PR 的评审已完成
    Then 代码平台上该 PR 没有新增任何评论
    And 代码平台上该 PR 的描述没有被修改
    And 代码平台上该 PR 没有被写入任何合并状态

  @level:l1 @spec:constraint @status:pending
  Scenario: 处置 finding 不向代码平台写入任何内容
    Given PR "修复订单超时未释放库存" 已完成一次评审
    When 评审人 "张伟" 采纳了 finding "库存释放未加分布式锁"
    And 评审人 "张伟" 驳回了 finding "超时时间硬编码为 30 秒"，理由为 "这个值由上游配置中心统一下发，此处是兜底默认值"
    Then 代码平台上该 PR 没有新增任何评论
    And 代码平台上该 PR 的描述没有被修改
    And 代码平台上该 PR 没有被写入任何合并状态
