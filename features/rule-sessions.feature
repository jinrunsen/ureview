@layer:api @story:rule-sessions
Feature: 在保留的会话中调整规范
  As a 团队管理员
  I want 继续之前的对话来调整规范草稿
  So that 我可以逐轮确认规则内容后再启用

  @level:bvt @spec:main
  Scenario: 服务重启后继续对话并更新同一条规范
    Given 张伟通过对话生成了金额规范草稿
    And 张伟将该规范保存为草稿
    When 工作台重启后张伟重新打开生成会话
    And 张伟要求增加退款时允许零金额的例外
    Then 会话保留前一次要求和两轮生成结果
    And 已保存的规范仍保持调整前的内容
    When 张伟确认保存并启用调整后的规范
    Then 原规范更新为包含退款例外的已启用版本

  @level:l1 @spec:exception
  Scenario: 微调失败后保留草稿并能继续对话
    Given 张伟通过对话生成了金额规范草稿
    When 张伟要求微调时模型暂时不可用
    Then 会话显示失败原因并保留上一份草稿
    When 模型恢复后张伟再次要求增加退款例外
    Then 会话显示调整后的草稿且规范尚未启用

  @level:l1 @spec:constraint
  Scenario: 规范会话遵守团队与管理员权限
    Given 张伟通过对话生成了金额规范草稿
    When 李娜作为普通成员打开该会话并尝试微调
    Then 李娜可以阅读对话但不能改变草稿
    When 张伟切换到物流研发团队查找该会话
    Then 物流研发团队看不到该会话或草稿
