@layer:e2e @story:rule-proposals-batch
Feature: 在提案列表批量审核
  As a 团队管理员
  I want 选择多条提案并统一审核
  So that 我能集中处理团队规范

  @level:bvt @spec:main
  Scenario: 全选仅覆盖当前结果且需修改的反馈保留逐条编辑入口
    Given 张伟已打开包含待审核草稿和工作台反馈的提案列表
    When 张伟筛选规范库来源并全选当前结果
    Then 选择数量与当前可见的待审核提案一致
    When 张伟更改提案搜索条件
    Then 原有提案选择已清空
    When 张伟清除筛选并选择草稿和工作台反馈提案
    Then 批量采纳显示可直接采纳数量并提示反馈需逐条修改
    When 张伟确认批量采纳
    Then 页面显示采纳结果并保留需修改反馈的选择
    When 张伟打开待修改反馈并采纳
    Then 规范编辑器展示当前正文

  @level:l1 @spec:exception
  Scenario: 批量拒绝部分失败后可以保留理由重试
    Given 张伟已选中多条待审核提案
    When 张伟打开批量拒绝
    Then 未填写拒绝理由时无法确认
    When 张伟填写统一理由并确认拒绝且其中一条暂时无法保存
    Then 页面分别显示成功与失败数量及失败原因
    And 仍待审核的失败项与拒绝理由保留供重试
    When 张伟重试失败的提案
    Then 页面显示重试结果且重试范围仅包含仍待审核的失败项
