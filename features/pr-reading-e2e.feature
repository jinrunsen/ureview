@layer:e2e @story:reading-explains-implementation
Feature: 在评审页阅读解读
  As a 评审人
  I want 按章节阅读解读并从引用跳到代码
  So that 我能先读懂实现，再回到 diff 核对

  @level:bvt @spec:main
  Scenario: 从解读目录下钻到代码并返回阅读位置
    Given 评审人 "张伟" 打开了 PR "修复订单超时未释放库存" 的评审页
    And 本轮解读已完成并包含代码引用
    Then 首屏显示解读的概要和目录
    When "张伟" 通过目录跳转到 "方案与行为变化"
    Then 页面定位到方案与行为变化一节
    When "张伟" 点击本轮 diff 内的代码引用
    Then 代码与问题视图定位到引用的代码行
    When "张伟" 返回解读
    Then 页面恢复到方案与行为变化一节的阅读位置

  @level:l1 @spec:exception
  Scenario: 解读生成失败时说明原因并可重新生成
    Given 评审人 "张伟" 打开了 PR "修复订单超时未释放库存" 的评审页
    And 本轮解读生成失败
    Then 解读标签说明失败原因并提供 Agent 会话入口
    When "张伟" 点击重新生成
    Then 解读标签显示生成进度，完成后显示新的解读

  @level:l1 @spec:normal
  Scenario: 导出的解读可在离线时完整阅读
    Given 评审人 "张伟" 正在阅读已完成的解读
    And 解读包含对比图、流程图、代码导读和术语表
    When "张伟" 导出当前解读
    And 在断网的浏览器中打开导出的 HTML 文件
    Then 可以阅读全部章节、图和带注释的代码摘录
