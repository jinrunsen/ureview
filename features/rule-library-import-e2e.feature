@layer:e2e @story:rule-library-import
Feature: 在页面上导入企业规范
  As a 服务管理员
  I want 在规范库页面上传规范文件并跟随生成进度
  So that 我能核对生成结果后再发布给各团队

  @level:l1 @spec:main
  Scenario: 服务管理员上传文件后跟随进度预览并发布规范集
    Given 服务管理员张伟打开规范页的规范库标签
    When 张伟通过导入规范上传研发编程语言 checklist
    Then 页面显示规划与生成进度，完成后展示按文件分组的规范集预览
    When 张伟勾选 Go 规范集并发布
    Then 规范库标签中出现标记为企业导入的 Go 规范集

  @level:l1 @spec:constraint
  Scenario: 上千条条目的导入在预览、发布和规范库浏览时保持可操作
    Given 服务管理员张伟的导入已生成 20 个规范集、共 1400 条条目
    When 张伟打开导入预览，全选规范集并发布
    Then 页面在操作期间保持响应，发布后提示已发布 20 个规范集
    And 导入结束后页面不再定时刷新
    When 团队管理员李娜打开规范库标签并展开其中一个导入规范集
    Then 规范库只渲染展开的规范集条目，条目展开后才显示代码示例
