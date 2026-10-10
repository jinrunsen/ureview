@layer:e2e @story:review-collaboration-ui
Feature: 从未读提醒回到评审讨论
  As a 团队成员
  I want 从提醒直接打开同事提到的问题并回复
  So that 讨论和评审始终保持在同一个上下文

  @level:bvt @spec:main
  Scenario: 成员从未读提示打开讨论并在当前 finding 下回复
    Given 张伟在库存预留评审的库存不足问题下提醒了李娜
    When 李娜登录工作台并点击未读讨论提示
    Then 页面打开库存不足问题的讨论区
    And 李娜能看到张伟的原文和回复入口
    When 李娜点击回复并填写库存不足应该拒绝预留后发送
    Then 页面在同一讨论区显示李娜的回复和引用的原文
    And 李娜仍在库存预留评审页
