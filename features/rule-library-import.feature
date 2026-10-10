@layer:api @story:rule-library-import
Feature: 导入企业规范生成规范库
  As a 服务管理员
  I want 上传公司已有的编码规范文件，生成各团队可以应用的规范库
  So that 团队不用逐条手工录入公司规范

  @level:bvt @spec:main
  Scenario: 上传按语言分章的规范文件后生成多个规范集预览
    Given 服务管理员张伟准备了一份按 C&C++ 与 Go 分章的研发编程语言 checklist
    When 张伟上传该文件并等待导入完成
    Then 导入预览包含 C/C++ 与 Go 两个语言层规范集
    And 每个条目都有标题、摘要、检查什么、严重级别和指向原文章节的出处

  @level:l1 @spec:normal
  Scenario: 非规范文档与综述段落被跳过并说明理由
    Given 服务管理员张伟准备了一份研发编程语言 checklist 和一份 GitLab MCP 安装指南
    When 张伟同时上传两份文件并等待导入完成
    Then 安装指南没有生成规范集，预览列出它被跳过的理由
    And checklist 中的排版总则列为未生成条目的段落并写明理由

  @level:l1 @spec:exception
  Scenario: 单个片段生成失败时其余片段保留并可重试
    Given 服务管理员张伟上传了一份按 Java 与 Go 分章的研发安全编码 checklist
    And 生成 Go 章节时模型服务暂时不可用
    When 导入结束
    Then 导入显示部分失败，Java 规范集的条目可以预览，Go 章节列为失败片段
    When 模型服务恢复后张伟重试失败片段
    Then 导入变为待发布，预览包含 Go 规范集

  @level:l1 @spec:exception
  Scenario: 不支持的文件类型或超出大小限制时整次上传被拒绝
    Given 服务管理员张伟准备了一份研发编程经验 checklist
    When 张伟连同一份 PDF 文件一起上传
    Then 上传被拒绝并指出 PDF 文件的格式不受支持，导入列表没有新增导入
    When 张伟上传一份超过 1 MB 的 Markdown 文件
    Then 上传被拒绝并指出该文件超过大小限制

  @level:l1 @spec:normal
  Scenario: 发布前调整规范集属性并删除条目
    Given 张伟的导入已生成 C/C++ 规范集预览
    When 张伟把规范集改名为“数据面 C 编码规范”，适用语言只保留 C，并删除其中两条排版条目
    Then 预览中的规范集名称、语言和条目数随之更新
    When 服务管理员王芳用修改前的导入版本删除另一条条目
    Then 删除未生效并提示导入已被更新

  @level:l1 @spec:normal
  Scenario: 发布后其他团队可以浏览并应用导入的规范集
    Given 张伟发布了导入生成的 Go 规范集
    When 支付团队管理员李娜打开规范库并应用其中两条
    Then 规范库中该规范集标记为企业导入并显示来源文件
    And 支付团队得到两条已启用的 Go 规范并保留规范库关联

  @level:l1 @spec:normal
  Scenario: 删除已发布的导入规范集后已应用的团队规范保持不变
    Given 支付团队已应用导入的 Go 规范集中的两条规范
    When 张伟删除这个已发布的规范集
    Then 规范库不再显示该规范集
    And 支付团队的两条规范正文与规范库关联保持不变

  @level:l1 @spec:constraint
  Scenario: 团队管理员和成员不能导入企业规范
    Given 支付团队管理员李娜没有服务管理员权限
    When 李娜尝试上传研发编程语言 checklist
    Then 上传未生效且导入列表中没有新的导入
