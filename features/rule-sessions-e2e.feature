@layer:e2e @story:rule-sessions-editor
Feature: 在规范面板中继续对话
  As a 团队管理员
  I want 同时查看对话与可编辑草稿
  So that 我可以提出修改要求并检查结果

  @level:bvt @spec:main
  Scenario: 刷新恢复对话并在保存后继续调整
    Given 张伟从团队规范打开生成新规则面板
    When 张伟描述金额规范并生成草稿
    Then 面板同时展示对话记录和可编辑的规范
    When 张伟刷新页面
    Then 原会话面板重新打开并可以继续输入修改要求
    When 张伟输入退款例外并发送
    Then 新一轮回复和草稿展示在同一面板中
    When 张伟保存草稿后关闭面板并从生成记录重新打开
    Then 面板显示保存信息并保留继续对话入口
