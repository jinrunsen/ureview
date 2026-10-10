@layer:e2e @story:workspace-navigation
Feature: 在工作台中查找评审与规范
  As a 团队管理员
  I want 从统一导航进入仓库、规范和团队管理
  So that 日常评审和管理操作有清楚的入口

  @level:bvt @spec:main
  Scenario: 从概览进入仓库规范并展开候选证据
    Given 张伟已作为管理员登录接入库存服务仓库的团队
    When 张伟从概览进入仓库并打开库存服务的详情
    And 张伟进入规范标签并搜索金额校验
    Then 页面保留库存服务仓库筛选并显示匹配的规范
    When 张伟打开规范详情再关闭
    And 张伟切换历史候选并刷新页面
    Then 页面仍在该仓库的历史候选页
    When 张伟打开候选并复制规范内容
    Then 详情同时展示复制成功提示和原评论的代码证据

  @level:bvt @spec:main
  Scenario: 窄屏中通过侧栏进入成员和通知设置
    Given 张伟以管理员身份在手机宽度的工作台中登录
    When 张伟打开导航并进入成员与团队
    Then 页面显示成员搜索入口且导航已经收起
    And 表格在自己的区域内滚动而不会撑宽页面
    When 张伟重新打开导航并进入团队设置
    Then 页面显示通知出口表单且导航已经收起
