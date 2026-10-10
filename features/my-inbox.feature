@layer:api @story:my-inbox
Feature: 身份关联与我的待办
  As a 参与代码评审的团队成员
  I want 关联平台身份并查看与我有关的评审和讨论
  So that 每天可以找到需要我处理的事项

  @level:bvt @spec:main
  Scenario: 关联身份后按评审人与指派人和作者显示最新开放轮次
    Given 张伟已关联支付网关所在实例的 GitLab 用户名
    And 支付网关中存在指派张伟评审和由张伟提交的多轮评审
    When 张伟查看我的待办
    Then 待我评审包含评审人或指派人为张伟的最新开放轮次
    And 我提交的只包含张伟作为作者的最新开放轮次
    And 每条待办包含规则结论解读首句和当前未处置数

  @level:l1 @spec:constraint
  Scenario: 同一实例的 GitLab 用户名只能关联一个账号
    Given 张伟已关联支付网关所在实例的 GitLab 用户名
    When 管理员尝试让李娜关联同一实例的相同用户名
    Then 工作台提示用户名已被关联且保留两人的原身份

  @level:l1 @spec:normal
  Scenario: 未关联平台身份的成员仍可阅读提及和回复并标记已读
    Given 尚未关联 GitLab 的李娜收到了库存问题的提及和回复
    When 李娜查看我的待办并标记其中一条提醒已读
    Then 未读提醒排在已读提醒之前且保留原评审和问题链接
    And 张伟不能把李娜的提醒标记已读
