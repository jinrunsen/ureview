@layer:e2e @story:repository-detail
Feature: 在仓库详情中查看评审与管理配置
  As a 团队管理员
  I want 在仓库详情中查看评审、规范与接入事件
  So that 我可以维护当前仓库的评审范围与触发配置

  @level:bvt @spec:main
  Scenario: 从仓库详情调整评审设置并查看接入事件
    Given 张伟已作为团队管理员登录接入支付网关仓库的工作台
    And 支付网关已有评审与接入事件
    When 张伟从仓库列表打开支付网关
    Then 页面提供评审、规范、评审设置、接入与事件四个标签
    When 张伟在评审设置中关闭自动评审并保存排除目录
    Then 页面显示自动评审已关闭与评审范围已保存
    When 张伟进入接入与事件标签
    Then 页面显示仓库的接入说明与最近收到的事件
    And 已入队的事件可以打开关联的评审轮次
