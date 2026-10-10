@layer:e2e
Feature: 评审工作台的下钻与就地处置
  As a 评审人
  I want 从解读和结论一路读到具体代码行，并在看到代码的地方直接表态
  So that 整场评审在这里完成，不必在几个页面之间来回跳

  @level:bvt @spec:main
  @story:drill-finding-code
  Scenario: 评审人从结论栏下钻到 finding 再下钻到代码行
    Given 评审人 "张伟" 打开了 PR "修复订单超时未释放库存" 的评审页
    And 该评审产出了 finding "库存释放未加分布式锁"
    When "张伟" 打开代码与问题并在问题目录中点击 finding "库存释放未加分布式锁"
    Then 视图定位到该 finding 锚定的代码位置
    And finding "库存释放未加分布式锁" 展开显示在这几行代码下方
    And 变更代码显示语法高亮
    When "张伟" 点击该 finding 的一条证据位置
    Then 页面在评审页内定位到这条证据的代码
    When "张伟" 返回刚才阅读的位置
    Then 页面恢复到刚才阅读的 finding

  @level:bvt @spec:main
  Scenario: 评审人在 diff 视图中直接处置 finding
    Given 评审人 "张伟" 正在 PR "修复订单超时未释放库存" 的 diff 视图中
    And finding "库存释放未加分布式锁" 标记在第 48 行旁边
    And 该 finding 的卡片在这行代码下方显示处置控件
    When "张伟" 在该 finding 上点击采纳
    Then 该 finding 在当前视图中标记为已采纳
    And "张伟" 仍停留在 diff 视图中

  @level:l1 @spec:normal @status:pending
  Scenario: 评审人展开被折叠的 finding
    Given 评审人 "张伟" 打开了 PR "订单状态机重构" 的评审页
    And 页面展示了 5 条 finding 并提示 "还有 4 条已折叠"
    When "张伟" 点击展开被折叠的 finding
    Then 页面展示出原先被折叠的 finding
    And 页面不再显示折叠提示

  @level:l1 @spec:normal @status:pending
  Scenario: 已过时的 finding 在 diff 视图中显示为已过时而不锚到代码行上
    Given PR "修复订单超时未释放库存" 的 finding "库存释放未加分布式锁" 状态为 "Outdated"
    When 评审人 "张伟" 打开该 PR 的 diff 视图
    Then 该 finding 显示在一个 "已过时" 分区中
    And 代码区的任何一行旁边都不显示该 finding

  @level:l1 @spec:normal @status:pending
  Scenario: 超大 PR 的 diff 按语义分组折叠
    Given PR "订单状态机重构" 改动了 1240 个文件
    And Generator 把这些文件分成了 6 个语义分组
    When 评审人 "张伟" 下钻到该 PR 的 diff 视图
    Then 6 个语义分组默认全部折叠
    And 每个分组显示它包含的文件数

  @level:l1 @spec:normal @status:pending
  Scenario: 评审人展开一个语义分组查看其中的文件 diff
    Given 评审人 "张伟" 正在 PR "订单状态机重构" 的 diff 视图中
    And 语义分组 "订单状态机核心" 处于折叠状态
    When "张伟" 展开该分组
    Then 该分组下的文件 diff 逐个展开
    And 其余分组仍保持折叠

  @level:bvt @spec:main
  Scenario: 从结论栏跳到第一条高危
    Given 评审人 "张伟" 打开了 PR "修复订单超时未释放库存" 的评审页
    And 结论栏显示有高危 finding
    When "张伟" 点击 "跳到第一条高危"
    Then 页面切换到代码与问题
    And diff 定位到第一条高危 finding 的代码行
    And 该代码行旁显示对应的 finding

  @level:l1 @spec:normal @status:pending
  Scenario: 评审人按问题目录逐条查看中危 finding
    Given 评审人 "张伟" 打开了 PR "订单超时释放库存改为由超时处理器驱动" 的代码与问题
    And 该评审有 1 条高危和 3 条中危 finding，分布在 4 个文件中
    When "张伟" 在问题目录中点击 "下一条"
    Then 代码切换到第 2 条 finding 所在的文件并定位到它指向的代码行
    And 第 2 条 finding 展开显示在这几行代码下方
    And 问题目录标出当前是第 2 条，共 4 条

  @level:l1 @spec:normal @status:pending
  Scenario: 证据位置不在本轮差异中时在评审页内显示评审时读取的代码
    Given 评审人 "张伟" 正在查看 finding "库存释放未加分布式锁"
    And 该 finding 的一条证据位于本次没有改动的文件 "internal/inventory/lock.go"
    When "张伟" 点击这条证据的位置
    Then "张伟" 仍停留在评审页
    And 页面显示 "internal/inventory/lock.go" 中这条证据的代码
    When "张伟" 返回刚才阅读的位置
    Then 页面恢复到 finding "库存释放未加分布式锁"
