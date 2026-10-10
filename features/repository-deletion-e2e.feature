@layer:e2e @story:repository-detail @repository-deletion
Feature: 在仓库详情中确认永久删除
  As a 团队管理员
  I want 查看影响并输入仓库路径确认删除
  So that 我可以确认正在删除的仓库

  @level:bvt @spec:main
  Scenario: 管理员查看影响并输入完整路径删除后回到仓库列表
    Given 张伟已作为管理员打开库存服务仓库详情
    When 张伟进入接入与事件标签底部的删除区域
    Then 页面显示各类影响数量及删除不可恢复的说明
    And 尚未输入完整仓库路径时确认按钮不可用
    When 张伟输入不同大小写或带空白的仓库路径
    Then 确认按钮仍然不可用
    When 张伟输入完全一致的仓库路径并确认删除
    Then 页面回到仓库列表且库存服务不再出现
