@layer:e2e @story:rule-discoverability
Feature: 发现规范层级与管理入口
  As a 团队管理员
  I want 看清规范层级并从当前页面进入添加流程
  So that 我可以维护团队与仓库的规范

  @level:bvt @spec:main
  Scenario: 团队规范始终展示四层并从概览筛选
    Given 张伟所在团队只有团队层规范
    When 张伟打开团队规范页
    Then 页面展示原则、通用、语言、团队的条数与四个层级分区
    And 空层级展示用途说明和添加入口
    When 张伟点击概览中的团队层
    Then 层级筛选显示团队且展示团队层规范

  @level:bvt @spec:main
  Scenario: 从空层级进入规范库并应用条目
    Given 张伟打开团队规范页且原则层没有规范
    When 张伟从原则层点击从规范库添加
    Then 页面打开规范库且层级筛选显示原则
    When 张伟展开设计原则并选择一条规范应用
    Then 条目标记为已应用
    And 张伟可以在提案中看到该规范等待审核

  @level:bvt @spec:main
  Scenario: 从仓库规范页生成并保存当前仓库规范
    Given 张伟打开支付仓库详情的规范标签
    Then 规范区域只展示规范与 Lint 两个视图
    And 页面提供在团队规范页管理的链接与生成新规则入口
    When 张伟生成扣款校验规范
    Then 编辑器的作用范围预选支付仓库
    When 张伟保存草稿后进入团队规范页并从生成记录重开会话
    Then 编辑器继续显示支付仓库的作用范围

  @level:l1 @spec:exception
  Scenario: 展开多个仓库的同步失败汇总
    Given 支付仓库与库存仓库的规范同步失败
    When 张伟打开团队规范页
    Then 页面只显示一条包含失败仓库数量的同步提示
    When 张伟展开同步失败详情
    Then 页面列出支付仓库与库存仓库各自的失败原因
