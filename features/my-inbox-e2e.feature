@layer:e2e @story:my-inbox
Feature: 从个人待办进入评审
  As a 参与代码评审的团队成员
  I want 从我的账号关联身份后进入待办评审
  So that 可以从个人入口继续阅读代码评审

  @level:bvt @spec:main
  Scenario: 关联 GitLab 身份后从首页进入待我评审
    Given 张伟在首页看到关联 GitLab 用户名的提示
    When 张伟进入我的账号并关联团队实例中的 GitLab 用户名
    And 张伟返回我的待办并点击待我评审中的库存评审
    Then 工作台打开所选评审并显示解读和问题入口
