@layer:api @story:im-push
Feature: 即时通讯推送
  As a 团队成员
  I want 在团队即时通讯群中收到评审与讨论提醒
  So that 我可以及时打开工作台处理评审

  @level:bvt @spec:main
  Scenario: 评审完成后通过三种机器人提醒关联成员
    Given 库存团队已配置企业微信飞书和钉钉群机器人并关联张伟的即时通讯身份
    When 库存预留评审完成
    Then 三个群都收到包含结论解读概述和评审链接的消息并提醒张伟
    And 飞书和钉钉消息的签名可以验证

  @level:l2 @spec:exception
  Scenario: 机器人业务错误达到四次后显示投递失败
    Given 库存团队的企业微信机器人持续返回业务错误
    When 库存预留评审完成
    Then 机器人尝试四次后团队设置显示投递失败
    And 评审产出仍可阅读

  @level:l2 @spec:constraint
  Scenario: 同一机器人出口的连续提醒至少间隔三秒
    Given 库存团队已配置企业微信机器人
    When 两轮库存预留评审先后完成
    Then 群内两次评审提醒至少间隔三秒
