@layer:api @story:repository-detail @repository-deletion
Feature: 永久删除已接入的仓库
  As a 团队管理员
  I want 查看影响范围后删除仓库
  So that 工作台可以清除已停止使用的仓库及其关联记录

  @level:bvt @spec:main
  Scenario: 管理员按预览删除仓库及关联记录且保留其他仓库
    Given 库存服务已有评审、finding、讨论、会话、仓库规范和历史候选
    And 库存服务还有排队中的评审且结算服务已有独立评审
    When 张伟查看库存服务的删除影响
    Then 预览准确列出各类关联记录和受影响的工作台规范数量
    When 张伟输入完整仓库路径确认删除库存服务
    Then 删除结果的数量与预览一致且库存服务关联内容无法再查看
    And 仓库列表、评审列表、待办、团队概览和实例健康已移除库存服务的数据
    And 结算服务的评审与仓库记录保持不变
    And 预览和删除没有向代码平台发出请求

  @level:l1 @spec:exception
  Scenario: 进行中的评审阻止删除且保留仓库记录
    Given 库存服务有一轮进行中的评审
    When 张伟输入完整仓库路径确认删除库存服务
    Then 工作台提示等待评审结束且仓库与评审仍然存在

  @level:l1 @spec:constraint
  Scenario: 成员与其他团队管理员不能预览或删除仓库
    Given 库存服务已经接入且物流团队接入了同一项目
    When 李娜尝试预览和删除库存服务
    Then 两项操作均提示需要团队管理员权限
    When 张伟在物流团队中尝试预览和删除原团队的库存服务
    Then 两项操作均提示仓库不存在
    When 张伟在原团队输入完整仓库路径删除库存服务
    Then 物流团队同名项目的仓库记录仍然存在

  @level:l1 @spec:constraint
  Scenario: 确认路径必须与仓库路径完全一致
    Given 库存服务已经接入工作台
    When 张伟分别使用空路径、路径片段、不同大小写和带空白的路径确认删除
    Then 每次均提示仓库路径不匹配且保留原仓库

  @level:l1 @spec:normal
  Scenario: 删除后停止接收旧仓库事件且同一项目可以重新接入
    Given 库存服务已经接入工作台
    When 张伟输入完整仓库路径确认删除库存服务
    Then 旧仓库事件地址提示仓库不存在
    And 删除和旧地址接收事件没有向代码平台发出请求
    When 张伟重新接入同一个库存服务项目
    Then 新仓库具有不同的标识且没有原仓库的评审与事件

  @level:l1 @spec:normal
  Scenario: 删除清理仓库工作副本并保留工作台规范及其他作用范围
    Given 库存服务与结算服务各有遗留工作副本且共同应用一条工作台规范
    When 张伟输入完整仓库路径确认删除库存服务
    Then 库存服务的工作副本已清理且结算服务与目录外文件保持不变
    And 工作台规范保留且作用范围只剩结算服务
