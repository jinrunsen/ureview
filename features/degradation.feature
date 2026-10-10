@layer:api
Feature: 异常与降级
  As a 评审人
  I want 系统出问题的时候明确地说自己出了问题
  So that 我不会把"没跑起来"当成"没有问题"

  @level:l1 @spec:exception
  @story:review-new-pull-request
  Scenario: 模型服务不可用时评审明确失败
    Given 仓库 "payment-gateway" 已接入
    And 模型服务当前不可用
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    Then 该评审状态为 "失败"
    And 该评审的失败原因为 "模型服务当前不可用，评审未能完成"
    And 该评审不给出 "未发现问题" 的结论

  @level:l1 @spec:exception
  @story:review-new-pull-request
  Scenario: 代码平台不可达时评审失败并说明原因
    Given 仓库 "payment-gateway" 已接入
    And 代码平台当前不可达
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    Then 该评审状态为 "失败"
    And 该评审的失败原因为 "无法访问代码平台，请检查网络或令牌"

  @level:l1 @spec:exception @status:pending
  Scenario: 评审超时后被标记为失败而不是停在进行中
    Given PR "订单状态机重构" 的评审已运行超过设定的超时上限
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审状态为 "失败"
    And 该评审的失败原因为 "评审超时"
    And 该评审状态不是 "进行中"

  @level:l1 @spec:normal @status:pending
  Scenario: 评审失败后重跑成功并覆盖原有失败结果
    Given PR "接入新版风控 SDK v2.3" 的上一次评审因 "模型服务调用超时" 失败
    And 模型服务已恢复
    When 评审人 "张伟" 对该 PR 手动重跑评审
    Then 该 PR 最新一次评审的状态为 "已完成"
    And 该 PR 的评审结果不再带有失败原因 "模型服务调用超时"
