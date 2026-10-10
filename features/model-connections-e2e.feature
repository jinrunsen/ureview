@layer:e2e @story:model-connections
Feature: 模型配置页中的密钥显隐与验证反馈
  As a 服务管理员
  I want 在模型配置页查看密钥和调用反馈
  So that 我能检查配置并保留正在填写的内容

  @level:bvt @spec:main
  Scenario: 显示和隐藏密钥后验证当前输入
    Given 张伟打开已有模型配置的服务设置页
    Then 密钥输入框默认显示掩码
    When 张伟点击显示密钥再点击隐藏
    Then 密钥先显示明文再恢复掩码
    When 张伟填写新的密钥并验证调用
    Then 对应模型显示验证结果且保留尚未保存的输入
    When 张伟修改模型名称
    Then 旧验证结果被清除
