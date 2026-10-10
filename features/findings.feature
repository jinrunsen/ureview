@layer:api
Feature: 评审 finding
  As a 评审人
  I want 每条 finding 都说清楚问题、证据和怎么改，并且数量有上限
  So that 我能快速判断它成不成立，而这个工具不会变成新的噪声源

  @level:bvt @spec:main
  @story:prioritize-findings
  Scenario: finding 按严重度分组给出
    Given PR "修复订单超时未释放库存" 的评审产出了以下 finding
      | 标题                        | 严重度 |
      | 库存释放未加分布式锁            | 高危  |
      | 超时时间硬编码为 30 秒          | 高危  |
      | 错误日志缺少订单号              | 中危  |
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 评审结果中 finding 按严重度分为 "高危" 与 "中危" 两组
    And 评审结果中 "高危" 组排在 "中危" 组之前
    And 评审结果的 "高危" 组中包含 "库存释放未加分布式锁" 与 "超时时间硬编码为 30 秒"

  @level:bvt @spec:main
  @story:review-new-pull-request
  Scenario: 每条 finding 都包含描述、代码位置、证据链接与修复提示词
    Given PR "修复订单超时未释放库存" 的评审产出了 finding "库存释放未加分布式锁"
    When 评审人 "张伟" 查看该 finding 的详情
    Then 该 finding 带有问题描述
    And 该 finding 锚定的文件为 "internal/inventory/release.go"
    And 该 finding 带有一张证据链接表，列出这条结论参考过的文件
    And 该 finding 带有一段可直接交给编码助手的修复提示词
    And 该 finding 展示涉及的代码片段
    And 该 finding 未命中任何规范

  @level:l1 @spec:normal @status:pending
  @story:review-new-pull-request
  Scenario: 证据带有评审时读取的代码
    Given PR "修复订单超时未释放库存" 的评审产出了 finding "库存释放未加分布式锁"
    When 评审人 "张伟" 查看该 finding 的详情
    Then 该 finding 的每条证据都带有评审时读取的那几行代码
    And 本次没有改动的 "internal/inventory/lock.go" 上的证据也带有代码

  @level:l1 @spec:constraint
  @story:prioritize-findings
  Scenario: 一个 PR 的 finding 超过五条时截断并说明折叠了多少条
    Given PR "订单状态机重构" 的评审共产出了 9 条中高危 finding
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审给出 5 条 finding
    And 该评审提示 "还有 4 条已折叠"
    And 展示的五条 finding 恰好是评分最高的五条

  @level:l1 @spec:normal
  @story:prioritize-findings
  Scenario: 低危 finding 不出现在评审结果中
    Given PR "修复订单超时未释放库存" 的评审内部产出了 2 条高危与 3 条低危结论
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审给出 2 条 finding
    And 该评审不包含任何低危 finding

  @level:l1 @spec:normal
  @story:prioritize-findings
  Scenario: 高危 finding 展示并带有代码锚
    Given PR "修复订单超时未释放库存" 的评审产出了高危 finding "库存释放未加分布式锁"
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 评审结果展示 "库存释放未加分布式锁"
    And "库存释放未加分布式锁" 锚定在具体的代码行上

  @level:l1 @spec:normal
  @story:prioritize-findings
  Scenario: 中危 finding 展示并带有代码锚
    Given PR "修复订单超时未释放库存" 的评审产出了中危 finding "错误日志缺少订单号"
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 评审结果展示 "错误日志缺少订单号"
    And "错误日志缺少订单号" 锚定在具体的代码行上

  @level:l1 @spec:normal
  @story:repository-rules
  Scenario: 规范违规类 finding 标出它命中了哪条规范
    Given 仓库 "payment-gateway" 生效规范中包含 "R-007 金额禁止使用浮点数，一律用整数分"
    And PR "结算金额改用整数分" 的评审产出了一条命中 "R-007" 的 finding
    When 评审人 "张伟" 查看该 finding 的详情
    Then 该 finding 命中规范 "R-007"
    And 该 finding 带有指向规范 "R-007" 的引用
    And 命中规范的正文为 "金额禁止使用浮点数，一律用整数分"
    And 命中规范的来源指向本次评审的仓库提交

  @level:l1 @spec:normal
  @story:repository-rules
  Scenario: 同一条规范在不同代码位置被判为不同严重度
    Given 仓库 "payment-gateway" 生效规范中包含 "R-007 金额禁止使用浮点数，一律用整数分"
    And PR "结算金额改用整数分" 中 "internal/payment/settle.go" 与 "internal/payment/settle_test.go" 都违反了 "R-007"
    When 评审人 "张伟" 查看这两条 finding
    Then "internal/payment/settle.go" 上的 finding 严重度为 "高危"
    And "internal/payment/settle_test.go" 上的 finding 严重度为 "中危"

  @level:l1 @spec:normal
  @story:review-new-pull-request
  Scenario: finding 带有可追溯的评分与模型信息
    Given PR "修复订单超时未释放库存" 的评审产出了 finding "库存释放未加分布式锁"
    When 评审人 "张伟" 查看该 finding 的来源信息
    Then 该 finding 带有质量评分
    And 该 finding 记录了产出它所用的模型
    And 该 finding 记录了对它评分所用的模型
    And 评分所用的模型与产出所用的模型不是同一家
    And 该 finding 记录了实际读过的文件与行
    And 该 finding 记录了产出时间
    When 评审人 "张伟" 重新打开该 finding 的详情
    Then 该 finding 的内容与追溯信息保持一致
