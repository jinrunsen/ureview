@layer:api @story:model-connections
Feature: 查看模型密钥并验证调用连接
  As a 服务管理员
  I want 查看已保存密钥并验证当前模型连接
  So that 我可以确认模型能够调用后再保存配置

  @level:bvt @spec:main
  Scenario: 服务管理员按需查看已保存的密钥
    Given 张伟已保存生成与评分模型的连接配置
    When 张伟请求查看生成模型的密钥
    Then 展示已保存的生成密钥且常规配置摘要不包含密钥

  @level:l1 @spec:normal
  Scenario: 验证尚未保存的连接而保留现有配置
    Given 张伟已保存生成与评分模型的连接配置
    When 张伟验证当前填写的新模型地址和密钥
    Then 验证使用新连接完成模型调用并保留已保存的配置
    When 张伟验证已保存的生成模型连接
    Then 验证使用已保存的密钥完成模型调用

  @level:l1 @spec:exception
  Scenario: 密钥不能调用时显示安全的失败原因
    Given 张伟已保存生成与评分模型的连接配置
    When 张伟验证一个被模型服务拒绝的密钥
    Then 工作台提示认证失败且不暴露密钥或上游错误正文

  @level:l1 @spec:constraint
  Scenario: 团队管理员不能查看模型密钥或验证实例连接
    Given 张伟已保存生成与评分模型的连接配置
    And 李娜只有团队管理员权限
    When 李娜尝试查看模型密钥和验证调用
    Then 两项操作都被拒绝且没有发起模型调用
