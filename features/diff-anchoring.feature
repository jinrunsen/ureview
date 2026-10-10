@layer:api
Feature: 代码锚定与变更集获取
  As a 评审人
  I want finding 始终锚在正确的代码行上，大 PR 也能看到完整变更
  So that 我不会被锚错的结论误导，也不会因为 PR 大就看不成

  @level:bvt @spec:main
  @story:drill-finding-code
  Scenario: finding 锚定到具体的文件与代码行
    Given PR "修复订单超时未释放库存" 的评审产出了 finding "库存释放未加分布式锁"
    When 评审人 "张伟" 查看该 finding 的锚定信息
    Then 该 finding 锚定的文件为 "internal/inventory/release.go"
    And 该 finding 锚定的行范围为第 3 行至第 4 行
    And 代码锚的指纹对应本轮实际读取的代码
    And 本轮差异保留代码平台提供的原始片段

  @level:l1 @spec:normal @status:pending
  Scenario: 作者调整代码后 finding 重新锚定到新的行号
    Given PR "修复订单超时未释放库存" 的 finding "库存释放未加分布式锁" 锚定在 "internal/inventory/release.go" 第 48 行
    When 开发者 "李娜" 在该文件第 10 行处插入了 6 行代码并推送
    Then 该 finding 仍然锚定在同一段代码上
    And 该 finding 锚定的行号更新为第 54 行
    And 该 finding 的状态仍为 "Pending"

  @level:l1 @spec:normal @status:pending
  Scenario: 锚定的代码被改写后 finding 转为已过时而不是锚到错误的行
    Given PR "修复订单超时未释放库存" 的 finding "库存释放未加分布式锁" 锚定在 "internal/inventory/release.go" 第 48 行
    When 开发者 "李娜" 重写了该段代码并强制推送
    Then 该 finding 的状态变为 "Outdated"
    And 该 finding 不再锚定在任何代码行上

  @level:l1 @spec:exception @status:pending
  Scenario: 代码平台返回的变更集被截断时评审仍覆盖全部文件
    Given 开发者 "李娜" 提交的 PR "订单状态机重构" 改动了 1240 个文件
    And 代码平台因超出限制只返回了其中 300 个文件的变更
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审覆盖了全部 1240 个文件
    And 该评审不提示 "本次评审未能覆盖全部变更"

  @level:l1 @spec:constraint @status:pending
  Scenario: 变更量超出单次评审预算时评审仍覆盖全部文件
    Given 开发者 "李娜" 提交的 PR "订单状态机重构" 改动了 1240 个文件
    And 代码平台返回了全部变更，但变更量超出单次评审预算，拆分一层后可以覆盖
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审覆盖了全部 1240 个文件
    And 该评审不提示 "本次评审未能覆盖全部变更"

  @level:l2 @spec:constraint @status:pending
  Scenario: 变更量过大导致评审无法覆盖全部改动时明确提示
    Given 开发者 "李娜" 提交的 PR "订单状态机重构" 的变更量远超单次评审预算，拆分一层后仍然覆盖不下
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 该评审提示 "本次评审未能覆盖全部变更"
    And 提示中列出未被覆盖的文件

  @level:l1 @spec:normal @status:pending
  Scenario: 生成代码不产生 finding
    Given 开发者 "李娜" 提交的 PR "接入新版风控 SDK v2.3" 改动了 "api/risk/v2/risk.pb.go" 与 "internal/risk/client.go"
    And "api/risk/v2/risk.pb.go" 被识别为生成代码
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 代码文件树中不包含 "api/risk/v2/risk.pb.go"
    And 没有任何 finding 锚定在 "api/risk/v2/risk.pb.go" 上
