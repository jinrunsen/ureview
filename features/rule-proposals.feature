@layer:api @story:rule-proposals
Feature: 统一审核规范提案
  As a 团队管理员
  I want 在同一入口审核新增与修订规范
  So that 团队约定可以持续维护

  @level:bvt @spec:main @case:rule-feedback
  Scenario: 同一规范与理由的驳回反馈合并为一条待审核提案
    Given 库存评审有两条命中同一规范的 finding
    When 张伟以规范有误驳回这两条 finding
    Then 仅有一条待审核驳回反馈提案并记录两次反馈及来源

  @level:l1 @spec:normal @case:rule-feedback
  Scenario: 修改处置会撤回待审核反馈并保留已审核反馈
    Given 库存评审有两条命中同一规范的 finding
    When 张伟以规范有误驳回这两条 finding
    And 张伟将第一条 finding 改回待处理
    Then 原提案仍待审核且仅保留第二条 finding 的反馈
    When 张伟采纳第二条 finding
    Then 原提案已撤回且没有反馈和待审核项
    When 张伟再次以规范不适用驳回第一条 finding
    Then 新的待审核提案仅记录第一条 finding 的反馈
    When 张伟将第一条 finding 的驳回理由改为误报
    Then 原提案已撤回且没有反馈和待审核项
    When 张伟以规范有误驳回这两条 finding
    And 管理员审核拒绝这条反馈提案
    And 张伟将第一条 finding 改回待处理
    And 张伟采纳第二条 finding
    Then 已拒绝提案保留审核时的两条反馈和审核记录

  @level:l1 @spec:normal @case:proposal-approval
  Scenario: 管理员采纳生成与规范库提案并启用对应草稿
    Given 团队有规则生成草稿和规范库草稿
    When 管理员采纳这两条规范提案
    Then 两条规范均已启用且提案记录审核人和时间
    When 管理员不填写理由拒绝另一条提案
    Then 提案仍待审核并提示填写拒绝理由
    When 管理员填写拒绝理由后拒绝该提案
    Then 提案记录拒绝理由、审核人和时间

  @level:l1 @spec:constraint @case:proposal-approval
  Scenario: 成员可以查看但不能审核规范提案
    Given 团队有一条待审核的规范库提案
    When 李娜查看提案并尝试采纳
    Then 提案仍待审核且规范仍为草稿

  @level:l1 @spec:normal @case:proposal-history
  Scenario: 历史候选在同仓库其他路径正文相同时识别为生效
    Given 支付仓库有历史挖掘的待审核提案
    When 管理员采纳后将候选正文保存到其他规范文件并同步
    Then 历史候选显示已生效且保留采纳审核记录
