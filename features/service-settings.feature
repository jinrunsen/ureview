@layer:api @story:service-settings
Feature: 服务管理员配置模型密钥
  As a 服务管理员
  I want 在工作台管理模型密钥和服务权限
  So that 所有团队可以使用已配置的评审模型

  @level:bvt @spec:main
  Scenario: 服务管理员更新生成与评分模型的密钥
    Given 张伟是工作台的服务管理员
    When 张伟分别保存生成模型和评分模型的密钥
    Then 工作台显示两个模型的密钥均已配置但不展示密钥内容

  @level:l1 @spec:normal
  Scenario: 服务管理员修改模型名称和接口地址
    Given 张伟是工作台的服务管理员
    When 张伟设置生成与评分模型的名称和接口地址
    Then 工作台保留保存的模型名称和接口地址

  @level:l1 @spec:constraint
  Scenario: 团队管理员不能修改整个实例的模型密钥
    Given 张伟是工作台的服务管理员
    And 李娜是团队管理员但没有服务权限
    When 李娜尝试查看和修改服务配置
    Then 工作台提示需要服务管理员权限

  @level:l1 @spec:normal
  Scenario: 服务管理员授权其他用户并保留至少一名管理员
    Given 张伟是工作台的服务管理员
    And 李娜是团队管理员但没有服务权限
    When 张伟尝试取消自己的唯一服务管理员权限
    Then 工作台提示至少保留一名服务管理员
    When 张伟授权李娜为服务管理员
    Then 李娜可以管理服务配置
