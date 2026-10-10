@layer:e2e @story:onboarding-and-health
Feature: 从引导清单接入第一个仓库
  As a 首次使用工作台的团队管理员
  I want 从我的待办中的引导进入仓库接入
  So that 可以完成接入并继续下一步配置

  @level:bvt @spec:main
  Scenario: 从引导接入仓库后返回待办看到该步完成
    Given 张伟在我的待办顶部看到首次使用引导清单
    When 张伟从接入仓库步骤打开仓库接入表单
    And 张伟填写库存服务的 GitLab 地址路径和只读令牌并接入
    And 张伟返回我的待办
    Then 接入仓库步骤显示已完成并保留后续步骤的操作入口
