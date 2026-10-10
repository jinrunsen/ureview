@layer:api @story:review-exclusions
Feature: 按仓库配置排除评审目录
  As a 团队管理员
  I want 为每个仓库单独配置评审排除目录
  So that 评审与模型上下文只包含需要检查的代码

  @level:bvt @spec:main
  Scenario: 仓库排除测试目录后同团队其他仓库仍评审该目录
    Given 张伟管理的库存仓库同时修改了业务代码和测试步骤
    When 张伟将 features/steps 设置为库存仓库的评审排除目录
    And 李娜发起该库存变更的评审
    Then 本轮只展示业务文件的差异并记录排除了一个测试文件
    And 生成与评分模型的上下文均不包含测试代码
    And 两阶段都无法读取被排除的测试文件
    When 张伟接入同团队的订单仓库，其中也修改了业务代码和测试步骤
    And 李娜发起该订单变更的评审
    Then 订单仓库默认不排除目录且本轮包含测试步骤的差异与模型上下文
    And 库存仓库的排除配置保持不变

  @level:l1 @spec:exception
  Scenario: 全部变更被排除时明确说明没有执行模型评审
    Given 张伟管理的库存仓库只修改了测试步骤
    When 张伟将 features/steps 设置为库存仓库的评审排除目录
    And 李娜发起该库存变更的评审
    Then 评审明确说明全部变更已排除且没有评审结论
    And 本轮没有向任何模型发起请求

  @level:l1 @spec:constraint
  Scenario: 调整仓库排除配置后重跑不改变历史评审范围
    Given 张伟管理的库存仓库同时修改了业务代码和测试步骤
    And 张伟将 features/steps 设置为库存仓库的评审排除目录
    And 李娜发起该库存变更的评审
    When 张伟清空库存仓库的排除目录后重新评审该变更
    Then 新评审包含测试步骤的差异且记录未排除文件
    And 原评审仍保留当时的排除目录及业务文件差异
