@layer:e2e @story:rule-detail-editor
Feature: 从评审维护规范
  As a 团队管理员
  I want 从命中规范查看执行记录并审核修订提案
  So that 我能结合评审反馈修改团队约定

  @level:bvt @spec:main
  Scenario: 从 finding 进入规范详情并审核驳回反馈修改正文
    Given 张伟已登录并打开有规范命中的库存评审
    When 张伟点击 finding 的命中规范
    Then 规范详情展示正文和执行记录入口
    When 张伟从执行记录打开对应 finding 的评审
    Then 工作台回到该 PR 的评审
    When 张伟进入提案并采纳一条驳回反馈
    Then 编辑器展示被反馈规范的当前正文
    When 张伟修改正文并保存审核
    Then 编辑器关闭且提案显示已采纳
