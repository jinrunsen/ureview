@layer:api @story:rule-catalog
Feature: 团队规范与历史候选
  As a 团队负责人
  I want 阅读团队规范并查看有采纳依据的候选
  So that 我能维护团队约定并识别空转的规范

  @level:bvt @spec:main
  Scenario: 规范表展示继承规则、惰性文档和真实命中统计
    Given 支付仓库继承全局金额规范并有仓库路径规则和惰性文档
    And 金额校验规范有未处置、采纳、被无视和驳回各一条结论
    When 团队负责人同步并查看支付仓库规范
    Then 规范表包含全局金额规范、仓库金额规范和惰性文档
    And 仓库金额规范的命中、采纳和被无视分别为 4、1 和 0
    And 全局规范显示已启用并保留数据库版本

  @level:l1 @spec:constraint
  Scenario: 重复采纳的历史建议按首批与两周额度产出候选
    Given 支付仓库有二十条在两个历史 PR 的后续提交中落实的重复建议
    When 管理员首次挖掘支付仓库候选
    Then 负责人看到 10 条候选且每条都有两个 PR 的原评论和代码采纳证据
    When 管理员在同一天再次挖掘候选
    Then 候选仍为 10 条
    When 两周后管理员再次挖掘候选
    Then 候选总数为 15 条

  @level:l1 @spec:constraint
  Scenario: 单个 PR 与没有真实代码采纳的评论不成为候选
    Given 支付仓库的重复建议只在一个 PR 的后续提交中落实
    When 管理员首次挖掘支付仓库候选
    Then 负责人看不到规范候选
    When 另一个仓库的重复讨论都已解决但代码保持原样
    And 管理员挖掘另一个仓库候选
    Then 负责人仍然看不到规范候选

  @level:l1 @spec:normal
  Scenario: 候选复制进 Git 后显示为生效规范
    Given 支付仓库已有带两个 PR 采纳证据的候选
    When 负责人把候选内容提交到建议的仓库规范文件
    And 管理员重新同步支付仓库规范
    Then 该候选显示已在 Git 中生效且规范表包含完整正文

  @level:l1 @spec:exception
  Scenario: 规范同步失败时保留上一次完整目录
    Given 支付仓库已成功同步完整规范目录
    When 仓库规范暂时无法读取时管理员重新同步
    Then 负责人看到同步失败提示
    And 仍可读取上一次完整规范正文与同步时间

  @level:l1 @spec:normal
  Scenario: 同步仓库时分别展示规则和 lint 配置
    Given 支付仓库同时维护金额规则和根目录与结算子包的 lint 检查
    When 团队负责人同步并查看支付仓库规范
    Then 规则目录仍然包含金额规则和惰性文档
    And lint 目录展示检查名称、路径条件、执行脚本及来源提交
    And 子包检查的路径条件以结算子包为基准
    And 放在规则目录或 lint 子目录内的脚本不进入 lint 目录
