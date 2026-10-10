@layer:api @story:agent-sessions
Feature: 查看有权限的 Agent 会话
  As a 团队成员
  I want 查看业务关联的原始会话过程
  So that 我能追溯评审与规范生成的过程

  @level:bvt @spec:main
  Scenario: 评审生成和核验会话在重启后仍可回看
    Given 张伟已接入库存服务并登录工作台
    When 张伟发起库存服务的评审并等待完成
    Then 张伟能分别查看生成评审与核验评分的原始会话
    When 工作台服务重新启动
    Then 张伟仍能查看相同的会话内容

  @level:l1 @spec:normal
  Scenario: 运行中的会话支持从已读位置补齐后续记录
    Given 张伟已接入库存服务并登录工作台
    When 张伟在模型等待期间查看评审会话
    Then 张伟可以先看到已提交的评审要求
    When 模型完成评审
    Then 张伟从已读位置取得后续记录且没有重复

  @level:l1 @spec:exception
  Scenario: 规范调整失败的会话在再次调整后仍被保留
    Given 张伟已接入库存服务并登录工作台
    When 张伟生成金额校验规范后遇到一次调整失败并再次调整成功
    Then 张伟能查看三次运行记录且失败过程没有被覆盖

  @level:l1 @spec:constraint
  Scenario: 服务管理员切换团队后只看到当前团队的会话
    Given 张伟已接入库存服务并登录工作台
    And 张伟发起库存服务的评审并等待完成
    When 张伟切换到独立的结算团队查看会话
    Then 原团队会话不会出现且直接查看也被拒绝

  @level:l1 @spec:constraint
  Scenario: 查看会话不能修改或继续运行原始会话
    Given 张伟已接入库存服务并登录工作台
    And 张伟发起库存服务的评审并等待完成
    When 张伟尝试从会话查看入口继续对话或删除会话
    Then 工作台拒绝会话修改且原始记录保持完整
