@layer:api
Feature: 仓库接入
  As a 管理员
  I want 把团队的代码仓库接进 uReview 并确认连通
  So that 这些仓库的 PR 能被自动评审

  @level:bvt @spec:main @story:repository-onboarding
  Scenario: 管理员接入仓库后连通状态为已连通
    Given 管理员 "王强" 拥有 GitLab 仓库 "payment-gateway" 的只读访问令牌
    When "王强" 使用该令牌接入仓库 "payment-gateway"
    Then 仓库列表中出现 "payment-gateway"
    And 该仓库的连通状态为 "已连通"

  @level:l1 @spec:normal @story:repository-onboarding
  Scenario: 接入仓库时系统声明自己不会向代码平台写入
    Given 管理员 "王强" 拥有 GitLab 仓库 "order-service" 的只读访问令牌
    When "王强" 使用该令牌接入仓库 "order-service"
    Then 仓库 "order-service" 接入成功
    And 该仓库的权限说明为 "只读接入，不会向 GitLab 写入任何内容"

  @level:l1 @spec:normal @status:pending
  Scenario: 管理员查看仓库的连通状态与最近一次事件时间
    Given 仓库 "payment-gateway" 已接入
    And 该仓库最近一次收到代码平台事件的时间为 "2026-09-17 10:24"
    When 管理员 "王强" 查看仓库列表
    Then 仓库 "payment-gateway" 的连通状态为 "已连通"
    And 该仓库最近一次事件时间为 "2026-09-17 10:24"

  @level:l1 @spec:normal @status:pending
  Scenario: 管理员关闭仓库的评审开关后新建的 PR 不再产生评审
    Given 仓库 "risk-sdk" 已接入且评审开关为开启
    When 管理员 "王强" 关闭仓库 "risk-sdk" 的评审开关
    And 开发者 "李娜" 在仓库 "risk-sdk" 中新建 PR "接入新版风控 SDK v2.3"
    Then 评审列表中不包含 PR "接入新版风控 SDK v2.3"

  @level:l1 @spec:exception @status:pending
  Scenario: 超过 24 小时没有收到事件的仓库被标为可能异常
    Given 仓库 "risk-sdk" 已接入且评审开关为开启
    And 该仓库最近一次收到代码平台事件的时间距今已超过 24 小时
    When 管理员 "王强" 查看仓库列表
    Then 仓库 "risk-sdk" 的连通状态为 "可能异常"

  @level:l1 @spec:normal @status:pending
  Scenario: 管理员手动探测以确认仓库是真的断了还是确实没有新 PR
    Given 仓库 "risk-sdk" 的连通状态为 "可能异常"
    When 管理员 "王强" 对该仓库发起一次连通探测
    And 代码平台正常回应了该探测
    Then 仓库 "risk-sdk" 的连通状态为 "已连通"

  @level:l1 @spec:constraint @story:repository-onboarding
  Scenario: 管理员使用没有读取权限的令牌接入时收到明确提示
    Given 管理员 "王强" 持有一个对仓库 "billing-core" 没有读取权限的令牌
    When "王强" 使用该令牌接入仓库 "billing-core"
    Then 接入失败
    And 系统提示 "令牌无法读取该仓库，请确认令牌范围包含此仓库的只读权限"
    And 仓库列表中不出现 "billing-core"
