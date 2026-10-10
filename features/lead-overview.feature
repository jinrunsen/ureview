@layer:api @story:lead-overview
Feature: 负责人查看团队评审概览
  As a 团队管理员
  I want 查看最近四周的评审与处置
  So that 我能了解评审使用情况与规范的驳回原因

  @level:bvt @spec:main
  Scenario: 团队概览按当前处置计算采纳率与驳回分布
    Given 库存团队的一轮评审展示三条高危和两条中危 finding
    And 张伟采纳其中两条并以误报和规范不适用分别驳回一条
    When 张伟查看团队概览
    Then 最近四周有一轮评审、三条展示的高危和两条展示的中危
    And 采纳率为百分之五十，误报和规范不适用各有一条
    And 被驳回最多的规范包含库存释放约定且驳回一次
    When 张伟撤回被误报驳回的 finding 并再次查看团队概览
    Then 采纳率按两条采纳与一条驳回计算，误报的驳回数为零
