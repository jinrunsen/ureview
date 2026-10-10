@layer:api
@story:review-collaboration
Feature: 评审中的讨论与通知
  As a 评审人
  I want 在发现问题的地方讨论并提醒同事
  So that 争议、补充证据和评审进展能在团队中持续跟进

  @level:bvt @spec:main
  Scenario: 回复和提醒产生每人独立的未读提示
    Given 库存预留评审中已有张伟和李娜两位团队成员
    When 张伟在库存越界问题下提醒李娜并重复提交同一条讨论
    And 李娜回复张伟的讨论
    Then 讨论串只有原文和回复两条记录
    And 张伟和李娜各有一条未读讨论
    When 张伟阅读自己的讨论提醒
    Then 张伟没有未读讨论而李娜仍有一条

  @level:l1 @spec:constraint
  Scenario: 不能把回复挂到另一条发现的问题下
    Given 库存预留评审中已有张伟和李娜两位团队成员
    And 张伟已经就库存越界问题发表讨论
    When 张伟尝试在订单金额问题下回复该讨论
    Then 工作台提示只能回复当前发现的问题
    And 订单金额问题下没有新增讨论

  @level:l1 @spec:normal
  Scenario: 团队能看到各自是否看完评审
    Given 库存预留评审中已有张伟和李娜两位团队成员
    When 张伟标记库存预留评审已经看完
    Then 李娜看到张伟已经看完而自己尚未看完
    When 张伟取消看完标记
    Then 张伟的参与记录保留为已查看

  @level:l1 @spec:exception
  Scenario: 平台历史讨论读取失败时仍保留站内讨论
    Given 库存预留评审中已有张伟和李娜两位团队成员
    And GitLab 已有人工库存讨论
    And 张伟已经就库存越界问题发表讨论
    When 张伟查看平台历史讨论
    Then 能看到 GitLab 人工讨论的作者正文和原文链接
    When GitLab 历史讨论暂时不可用
    Then 工作台明确提示历史讨论读取失败且站内讨论仍然存在
    And GitLab 没有被写入新讨论

  @level:l1 @spec:exception
  Scenario: 通知出口故障不阻止站内讨论
    Given 库存预留评审中已有张伟和李娜两位团队成员
    And 管理员已配置一个暂时不可用的通知出口
    When 张伟在库存越界问题下提醒李娜并重复提交同一条讨论
    Then 站内讨论已保存且李娜收到一条未读提示
    And 通知出口达到重试上限后显示失败
