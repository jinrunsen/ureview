@layer:api
Feature: 评审结果的入口
  As a 评审人
  I want 在看代码之前先看到文件分组、问题计数和评审依据
  So that 我有一个判断的锚，不必从第一个文件第一行开始读

  @level:l1 @spec:normal @status:pending
  Scenario: 代码文件树按语义分组并为每个文件给出一句话主题
    Given PR "修复订单超时未释放库存" 改动了以下文件
      | 文件路径                         |
      | internal/order/timeout.go      |
      | internal/order/timeout_test.go |
      | internal/inventory/release.go  |
      | docs/order-timeout.md          |
    When 评审人 "张伟" 查看代码文件树
    Then 这些文件被分到若干个有名字的语义分组中
    And 每个文件都配有一句话主题

  @level:l1 @spec:normal @status:pending
  Scenario: 结论栏给出四类问题的计数
    Given PR "修复订单超时未释放库存" 的评审产出了 2 条缺陷类、1 条规范违规类 finding
    When 评审人 "张伟" 查看该 PR 的评审结果
    Then 结论栏给出计数 "缺陷 2"
    And 结论栏给出计数 "规范违规 1"
    And 结论栏给出计数 "跨仓冲突 0"
    And 结论栏给出计数 "skill 洞察 0"

  @level:l1 @spec:normal @status:pending
  Scenario: 评审档位按变更行数定档
    Given 仓库 "payment-gateway" 中有以下已完成评审的 PR
      | PR 标题            | 变更行数 |
      | 结算金额改用整数分      | 120   |
      | 修复订单超时未释放库存   | 320   |
      | 订单状态机重构         | 4800  |
    When 评审人 "张伟" 查看这三个 PR 的依据来源
    Then "结算金额改用整数分" 的评审档位为 "快速"
    And "修复订单超时未释放库存" 的评审档位为 "标准"
    And "订单状态机重构" 的评审档位为 "深度"

  @level:l1 @spec:normal @status:pending
  Scenario: 评审给出这次用了哪些依据
    Given 仓库 "payment-gateway" 在本次评审中被注入了 6 条规范
    And 这 6 条规范中有 4 条来自全局、2 条来自仓库
    And 本次评审的档位为 "标准"，定档理由为 "变更规模 320 行，在标准档位区间内"
    When 评审人 "张伟" 查看该评审的依据来源
    Then 该评审的依据来源中注入规范数为 6
    And 该评审的依据来源中全局规范 4 条、仓库规范 2 条
    And 该评审的依据来源中列出了本次启用的 skill
    And 该评审的依据来源中跨仓上下文为 "未启用"
    And 该评审的依据来源中评审档位为 "标准"
    And 该评审的依据来源中定档理由为 "变更规模 320 行，在标准档位区间内"

  @level:l1 @spec:normal @status:pending
  Scenario: 作者查看自己 PR 的解读
    Given 开发者 "李娜" 提交的 PR "修复订单超时未释放库存" 已完成评审
    When "李娜" 查看该 PR 的评审结果
    Then "李娜" 得到的解读与评审人 "张伟" 得到的完全一致
