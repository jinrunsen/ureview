@layer:api @story:rule-library
Feature: 浏览并应用经典规范库
  As a 团队管理员
  I want 查看规范来源并选择适合团队的条目
  So that 团队能直接使用已有的编码约定

  @level:bvt @spec:main
  Scenario: 按层级和语言浏览规范集及来源
    Given 团队管理员打开规范库
    When 管理员筛选语言层的 Go 规范
    Then 规范集包含条目、来源、收录理由与许可

  @level:l1 @spec:normal
  Scenario: 应用部分规范库条目直接启用且重复应用去重
    Given 团队管理员打开规范库
    When 管理员应用 Go 规范集的两条规范
    Then 团队得到两条语言层的 Go 生效规范并保留规范库关联
    When 管理员再次应用这两条规范
    Then 规范数量不变且规范库条目标记已应用

  @level:l1 @spec:constraint
  Scenario: 成员可以浏览但不能应用规范库
    Given 团队成员李娜打开规范库
    When 李娜尝试应用 Go 规范
    Then 应用未生效且团队没有新增规范

  @level:l1 @spec:normal
  Scenario: 规范库更新后重复应用保留团队规范
    Given 团队已应用并修改一条 Go 规范
    When 规范库发布该条目的新版本
    And 管理员再次应用已修改的 Go 规范
    Then 团队规范正文与版本保持不变

  @level:l1 @spec:normal
  Scenario: 规范库条目包含原文名称、检查建议与正反例
    Given 团队管理员打开规范库
    When 管理员查看规范库中的全部条目
    Then 每条规范都有原文名称、摘要、正文、检查什么、为什么、怎么改与正反例

  @level:l1 @spec:normal
  Scenario: 应用规范库条目保留完整正文和独立正反例
    Given 团队管理员打开规范库
    When 管理员应用 Go 规范集的两条规范
    Then 规范详情包含完整检查建议与各自的正反例

  @level:l1 @spec:normal
  Scenario: 规范库判断题应用后保留属性
    Given 团队管理员打开规范库
    When 管理员应用 Feature Envy 判断题条目
    Then 工作台规范与规范详情保留判断题属性和规范库关联

  @level:l1 @spec:normal
  Scenario: 规范库修改判断题属性后重复应用保留团队规范
    Given 团队已应用一条普通 Go 规范
    When 规范库新版仅把该条目标为判断题
    And 管理员再次应用这条普通 Go 规范
    Then 团队规范仍为普通规范且版本保持不变

  @level:l1 @spec:normal
  Scenario: 被拒绝的规范库草稿可以重新应用
    Given 团队有一条已拒绝的规范库草稿
    When 管理员查看该规范库条目
    Then 该条目标记为未应用
    When 管理员重新应用被拒绝的规范库条目
    Then 团队得到生效规范并保留原提案的拒绝记录
