@layer:api
Feature: 评审触发
  As a 评审人
  I want PR 的评审在我打开之前就已经跑完
  So that 我不必等待，也不会把"还没跑完"误读成"没有问题"

  @level:bvt @spec:main @story:review-new-pull-request
  Scenario: 输入已接入仓库的 PR 链接发起首次评审
    Given 仓库 "payment-gateway" 已接入
    And PR "修复订单超时未释放库存" 尚无评审记录
    When 评审人 "张伟" 输入该 PR 的链接开始评审
    Then 该评审状态为 "已完成"
    And 该 PR 的评审次数为 1
    And 该评审记录为手动发起且对应 PR 当前提交

  @level:l1 @spec:exception @story:review-new-pull-request
  Scenario: 输入未接入仓库的 PR 链接时提示先接入
    Given 仓库 "payment-gateway" 尚未接入评审工作台
    When 评审人 "张伟" 输入该 PR 的链接开始评审
    Then 工作台提示先接入该 PR 所属仓库
    And 没有产生评审记录

  @level:bvt @spec:main
  @story:review-new-pull-request
  Scenario: 新建 PR 后自动产生一次评审
    Given 仓库 "payment-gateway" 已接入
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    Then 评审列表中包含 PR "修复订单超时未释放库存"
    And 该 PR 的评审次数为 1

  @level:l1 @spec:normal
  @story:review-rounds
  Scenario: PR 有新提交后重新产生一次评审
    Given PR "修复订单超时未释放库存" 已完成一次评审
    When 开发者 "李娜" 向该 PR 推送了新的提交
    Then 该 PR 的评审次数为 2
    And 该 PR 的评审结果为最新一次评审的结果

  @level:l1 @spec:normal
  @story:review-rounds
  Scenario: 评审人手动重跑评审
    Given PR "修复订单超时未释放库存" 已完成一次评审
    And 仓库 "payment-gateway" 的规范在此之后新增了一条 "R-012 对外接口必须幂等"
    When 评审人 "张伟" 对该 PR 手动重跑评审
    Then 该 PR 的评审次数为 2
    And 最新一次评审的依据来源中注入的规范包含 "R-012"

  @level:l1 @spec:normal
  @story:review-new-pull-request
  Scenario: 评审尚未跑完时状态为进行中而不是空结论
    Given 开发者 "李娜" 刚新建了 PR "接入新版风控 SDK v2.3"
    And 该 PR 的评审尚未完成
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审状态为 "进行中"
    And 该评审不给出 "未发现问题" 的结论

  @level:l1 @spec:exception
  @story:review-new-pull-request
  Scenario: 代码平台重复推送同一次事件时不产生第二份评审
    Given 仓库 "payment-gateway" 已接入
    And 开发者 "李娜" 新建 PR "修复订单超时未释放库存" 后系统已为其产生一次评审
    When 代码平台因重试再次推送了同一次新建事件
    Then 该 PR 的评审次数为 1

  @level:l1 @spec:exception @story:review-new-pull-request
  Scenario: 新 PR 的差异尚未准备好时等待后再评审
    Given 仓库 "payment-gateway" 已接入
    And 新 PR 的代码差异尚未准备好
    When 开发者 "李娜" 新建 PR "修复订单超时未释放库存"
    Then 该评审提示 "代码平台尚未准备好本次提交的 diff，正在等待"
    And 该评审不给出 "未发现问题" 的结论
    When 代码平台准备好该次提交的完整差异
    Then 该评审状态为 "已完成"
    And 该 PR 的评审次数为 1

  @level:l1 @spec:exception @story:review-rounds
  Scenario: 重试同一次手动重跑操作只产生一轮评审
    Given PR "修复订单超时未释放库存" 已完成一次评审
    When 评审人 "张伟" 重试同一次手动重跑操作
    Then 该 PR 的评审次数为 2
    And 两次操作打开的是同一轮评审

  @level:l1 @spec:normal @story:review-rounds
  Scenario: 重跑后默认展示新一轮解读并保留上一轮内容
    Given PR "修复订单超时未释放库存" 已完成一次评审
    And 下一轮解读的概要为 "补充库存释放的幂等性审查"
    When 评审人 "张伟" 对该 PR 手动重跑评审
    Then 默认打开的解读概要为 "补充库存释放的幂等性审查"
    And 上一轮的解读、代码与追溯信息保持不变

  @level:l1 @spec:normal @story:review-rounds
  Scenario: 手动重跑进行中时仍能查看上一轮评审
    Given PR "修复订单超时未释放库存" 已完成一次评审
    And 后续评审的模型尚未结束
    When 评审人 "张伟" 对该 PR 手动重跑评审
    Then 该评审状态为 "进行中"
    And 列表显示新一轮正在评审，上一轮仍可查看
