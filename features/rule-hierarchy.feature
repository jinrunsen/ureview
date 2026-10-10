@layer:api @story:rule-hierarchy
Feature: 规范分层、适用语言与效力
  As a 团队管理员
  I want 维护规范的层级、适用语言、覆盖关系和仓库豁免
  So that 每轮评审使用适用于当前文件的规范并保留依据

  @level:bvt @spec:main
  Scenario: SQL 规范只参与包含 SQL 文件的评审
    Given 张伟已启用 SQL 事务规范和适用全部语言的通用规范
    When 李娜发起只修改 C 文件的评审
    Then 两个评审模型只收到通用规范且本轮依据没有 SQL 规范
    When 李娜为同一仓库发起包含 SQL 文件的评审
    Then 两个评审模型收到 SQL 事务规范且本轮依据记录 SQL 语言

  @level:l2 @spec:constraint
  Scenario: 规范的路径与语言必须在同一变更文件上同时匹配
    Given 张伟已启用仅适用于数据库目录中 Go 文件的规范
    When 李娜评审数据库目录的 SQL 文件和库存目录的 Go 文件
    Then 这条规范没有进入本轮依据或任一评审模型

  @level:l1 @spec:constraint
  Scenario: 原则指导评审但不能成为 finding 命中的规范
    Given 张伟已启用原则、通用、语言和团队四个层级的规范
    And 本轮模型先引用原则报告结论再引用团队规范报告结论
    When 李娜评审库存释放变更
    Then 原则引用被拒绝且仅保留命中团队规范的结论
    And 两个评审模型按原则、通用、语言和团队顺序收到规范

  @level:l2 @spec:normal
  Scenario: 未声明层级和语言的工作台规范保持团队层和全部语言
    Given 张伟保存了一条未声明层级和适用语言的工作台规范
    When 李娜评审库存释放变更
    Then 规范详情和本轮依据均显示团队层及全部语言

  @level:l1 @spec:normal
  Scenario: Git 规范同步层级与语言并提示非法声明
    Given 支付仓库的 Git 规范包含 Go 语言规范、SQL 规范和非法层级声明
    When 张伟同步规范目录并由李娜评审库存释放变更
    Then 目录保留合法层级和语言且非法声明产生告警
    And 两个评审模型收到 Go 规范且没有收到 SQL 规范

  @level:l2 @spec:normal
  Scenario: 生成的规范草稿保留层级与语言并允许管理员调整
    Given 张伟准备生成一条 Go 并发规范
    When 张伟生成语言层草稿并改为团队层保存
    Then 保存的规范保留调整后的层级和 Go 适用语言

  @level:bvt @spec:main
  Scenario: 团队规范覆盖同一文件的语言规范并保留覆盖依据
    Given 张伟已启用适用于库存释放文件的 Go 规范及覆盖它的团队规范
    When 李娜评审库存释放变更
    Then 两个评审模型只收到覆盖方正文
    And 本轮依据记录语言规范被团队规范覆盖的文件

  @level:l1 @spec:constraint
  Scenario: 管理员不能保存原则覆盖、缺失目标或循环覆盖关系
    Given 张伟已保存原则、通用和语言层规范及一条合法覆盖关系
    When 张伟分别尝试覆盖原则、引用缺失规范和形成循环覆盖
    Then 三次保存均被拒绝且原有规范内容与覆盖关系保持不变

  @level:l1 @spec:main
  Scenario: 仓库豁免保留理由与操作记录且撤销后恢复规范
    Given 张伟管理支付和结算两个仓库且已启用一条全局库存规范
    When 张伟填写理由豁免支付仓库并分别评审两个仓库
    Then 支付仓库依据记录豁免理由且模型没有收到该规范
    And 结算仓库仍使用该规范
    When 张伟撤销支付仓库的豁免并重新评审
    Then 支付仓库恢复规范且原评审仍保留豁免依据
    And 豁免历史保留设置和撤销的操作人与时间

  @level:l2 @spec:exception
  Scenario: Git 覆盖关系同步生效并告警忽略无效关系
    Given 支付仓库的 Git 团队规范覆盖 Go 规范并包含缺失目标及原则覆盖声明
    When 张伟同步规范目录并由李娜评审库存释放变更
    Then 目录保留合法覆盖关系并告警忽略缺失目标及原则覆盖
    And 本轮仅注入 Git 覆盖方并在依据中记录被覆盖规范

  @level:bvt @spec:main
  Scenario: 判断题规范拒绝高危结论并接受修正后的中危结论
    Given 张伟启用判断题规范和普通团队规范
    And 本轮模型先以高危命中判断题再改为中危并报告普通规范高危结论
    When 李娜评审库存释放变更
    Then 判断题高危提交留下纠错记录且最终只保留中危判断题和普通高危结论
    And 解读和两个评审模型收到判断题的表述与团队优先说明
    When 张伟把判断题规范改为普通规范
    Then 规范详情显示普通规范且原评审保留判断题依据

  @level:l1 @spec:normal
  Scenario: Git 判断题声明在目录和评审中生效
    Given 支付仓库的 Git 规范声明判断题属性
    When 张伟同步规范目录并由李娜评审库存释放变更
    Then Git 判断题属性保留在目录和评审依据且高危结论纠正为中危
    And 解读和两个评审模型收到判断题的表述与团队优先说明
