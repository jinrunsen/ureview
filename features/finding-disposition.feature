@layer:api
Feature: finding 处置
  As a 评审人
  I want 对每条结论明确表态并留下理由
  So that 后来的人知道这里为什么被判为问题或不是问题，采纳率的分母也是诚实的

  @level:bvt @spec:main @story:finding-disposition
  Scenario: 评审人采纳一条 finding
    Given PR "修复订单超时未释放库存" 的 finding "库存释放未加分布式锁" 状态为 "Pending"
    When 评审人 "张伟" 采纳该 finding
    Then 该 finding 的状态变为 "Resolved"
    When 评审人 "张伟" 将该 finding 改回待处理
    Then 该 finding 的状态变为 "Pending"

  @level:bvt @spec:main @story:finding-disposition
  Scenario: 评审人驳回一条 finding 并留下理由
    Given PR "修复订单超时未释放库存" 的 finding "超时时间硬编码为 30 秒" 状态为 "Pending"
    When 评审人 "张伟" 驳回该 finding，理由类别为 "误报"，说明为 "这个值由上游配置中心统一下发，此处是兜底默认值"
    Then 该 finding 的状态变为 "Dismissed"
    And 该 finding 的驳回理由为 "这个值由上游配置中心统一下发，此处是兜底默认值"
    And 该 finding 的驳回理由类别为 "误报"

  @level:l1 @spec:constraint @story:finding-disposition
  Scenario: 驳回时未填写理由无法提交
    Given PR "修复订单超时未释放库存" 的 finding "超时时间硬编码为 30 秒" 状态为 "Pending"
    When 评审人 "张伟" 在不填写理由的情况下尝试驳回该 finding
    Then 驳回未生效
    And 处置提示 "驳回需要选择理由类别"
    And 该 finding 的状态仍为 "Pending"
    When 评审人 "张伟" 选择 "其他" 但未填写说明而尝试驳回该 finding
    Then 驳回未生效
    And 处置提示 "选择其他理由时需要填写说明"
    And 该 finding 的状态仍为 "Pending"

  @level:l1 @spec:normal @story:finding-disposition
  Scenario: 处置记录包含操作人与操作时间
    Given PR "修复订单超时未释放库存" 的 finding "库存释放未加分布式锁" 状态为 "Pending"
    When 评审人 "张伟" 采纳该 finding
    Then 该 finding 的处置记录中操作人为 "张伟"
    And 该 finding 的处置记录中操作时间处于本次操作期间
    And 该 finding 的处置记录记载从 "Pending" 变为 "Resolved"

  @level:l1 @spec:normal @status:pending
  Scenario: PR 合并时没有人处置的 finding 转为被无视
    Given PR "修复订单超时未释放库存" 有以下 finding
      | finding 标题            | 状态       |
      | 库存释放未加分布式锁         | Resolved  |
      | 超时时间硬编码为 30 秒       | Pending   |
      | 错误日志缺少订单号           | Pending   |
    When 开发者 "李娜" 将该 PR 合并
    Then finding "库存释放未加分布式锁" 的状态仍为 "Resolved"
    And finding "超时时间硬编码为 30 秒" 的状态变为 "Ignored"
    And finding "错误日志缺少订单号" 的状态变为 "Ignored"

  @level:l1 @spec:normal @story:finding-disposition
  Scenario: 作者查看评审人对自己 PR 的处置结果
    Given 开发者 "李娜" 提交的 PR "修复订单超时未释放库存" 有 2 条 finding
    And 评审人 "张伟" 采纳了 "库存释放未加分布式锁"
    And 评审人 "张伟" 驳回了 "超时时间硬编码为 30 秒"，理由为 "这个值由上游配置中心统一下发，此处是兜底默认值"
    When "李娜" 查看该 PR 的评审结果
    Then finding "库存释放未加分布式锁" 的状态为 "Resolved"，处置人为 "张伟"
    And finding "超时时间硬编码为 30 秒" 的状态为 "Dismissed"，处置人为 "张伟"
    And finding "超时时间硬编码为 30 秒" 的驳回理由为 "这个值由上游配置中心统一下发，此处是兜底默认值"

  @level:l1 @spec:constraint @story:finding-disposition
  Scenario: 处置被并发修改时旧版本的提交被拒绝
    Given 张伟和李娜打开了同一条待处理 finding
    When 评审人 "张伟" 采纳该 finding
    And 李娜使用打开时的版本驳回该 finding
    Then 李娜看到处置已被更新的提示
    And 该 finding 仍由张伟采纳且只有一条处置记录

  @level:l1 @spec:normal @story:finding-disposition
  Scenario: 用户处置完本轮全部 finding 后记录该用户看完
    Given 库存评审展示五条 finding 并折叠一条
    When 张伟采纳其中四条 finding
    Then 张伟和李娜均未被记录为本轮看完
    When 李娜驳回最后一条展示的 finding
    Then 本轮只有李娜被记录为看完

  @level:l1 @spec:normal @story:finding-disposition
  Scenario: 规范目录的采纳数按已采纳的 finding 计数
    Given 库存释放规范命中了三条待处理 finding
    When 张伟采纳一条并驳回另一条 finding
    Then 库存释放规范的命中数为 3、采纳数为 1、被无视数为 0
    When 张伟将已采纳的规范 finding 改回待处理
    Then 库存释放规范的命中数为 3、采纳数为 0、被无视数为 0
