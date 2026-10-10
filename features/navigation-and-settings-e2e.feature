@layer:e2e @story:navigation-and-settings
Feature: 按权限使用工作台导航与设置
  As a 团队成员
  I want 从导航和账号菜单进入日常工作与管理设置
  So that 我可以找到自己需要使用的入口

  @level:bvt @spec:main
  Scenario: 侧栏按团队与服务权限显示管理入口
    Given 李娜是团队成员，张伟是团队管理员，陈晨是服务管理员
    When 李娜打开工作台导航
    Then 工作台显示我的待办、评审、仓库、团队规范与成员与团队
    And 导航不显示运行记录、团队设置与实例管理
    When 张伟打开工作台导航
    Then 导航显示团队概览、运行记录与团队设置
    When 陈晨打开工作台导航
    Then 导航显示实例管理

  @level:bvt @spec:main
  Scenario: 通过页头弹窗发起评审并进入结果页
    Given 张伟已登录接入支付网关仓库的工作台
    When 张伟点击页头的发起评审
    Then 页面显示输入合并请求链接的弹窗
    When 张伟提交支付网关的合并请求链接
    Then 页面进入该请求的评审页

  @level:bvt @spec:main
  Scenario: 通过账号菜单访问本人设置并兼容旧设置链接
    Given 李娜是团队成员，张伟是团队管理员，陈晨是服务管理员
    When 李娜从头像菜单进入我的账号
    Then 页面显示李娜的姓名、邮箱与修改密码入口
    And 头像菜单提供退出登录
    When 李娜、张伟和陈晨分别打开旧设置链接
    Then 李娜进入我的账号，张伟进入团队设置，陈晨进入实例管理
