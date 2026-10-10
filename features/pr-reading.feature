@layer:api @story:reading-explains-implementation
Feature: 解读讲清 PR 的实现
  As a 阅读库存变更的评审人
  I want 在 finding 之外读到一份只讲实现的解读
  So that 我能先弄清改了什么、改动前后怎么工作，再看问题

  @level:bvt @spec:main
  Scenario: 评审同时产出解读与 finding 且解读只讲实现
    Given 库存变更具有描述、提交信息与关联需求
    When 李娜发起库存变更评审并等待解读完成
    Then 解读与 finding 由两个会话同时生成且写作会话的输入不含 finding
    And 解读包含概要、背景、改动范围、方案与行为变化和代码导读
    And 方案与行为变化包含改前与改后的对比图
    And 解读的代码摘录与需求原文引用由宿主从本轮内容截取
    And 生成解读与审读解读的原始会话可以单独查看

  @level:l1 @spec:exception
  Scenario: 引用未读代码或改写需求原文的提交被拒绝后修正成功
    Given 写作会话先引用未读代码并改写需求原文，再补读代码并改正引用
    When 李娜发起库存变更评审并等待解读完成
    Then 张伟读到的解读只包含修正后的内容
    And 解读的提交记录保留未读代码与原文不符两类拒绝原因

  @level:l1 @spec:exception
  Scenario: 一节中的多处格式问题在一次拒绝中全部列出
    Given 写作会话提交的一节同时有不允许的组件属性、空的组件正文和无法解析的流程图
    When 李娜发起库存变更评审并等待解读完成
    Then 这次提交被拒绝且拒绝原因同时列出三处问题
    And 修正后的这一节被接受

  @level:l1 @spec:normal
  Scenario: 审读意见促成一轮修订
    Given 审读人对第一稿提出照抄缩写与越界评价两条意见
    When 李娜发起库存变更评审并等待解读完成
    Then 解读记录这两条审读意见和被重写的章节
    And 被重写章节的内容为修订后的版本

  @level:l1 @spec:exception
  Scenario: 审读失败时解读照常完成
    Given 本轮审读解读时模型不可用
    When 李娜发起库存变更评审并等待解读完成
    Then 解读已完成且内容为第一稿
    And 解读记录审读失败的原因

  @level:l1 @spec:exception
  Scenario: 解读失败不影响 finding
    Given 本轮生成解读时模型不可用
    When 李娜发起库存变更评审并等待完成
    Then 解读显示失败原因且本轮库存问题仍有评审结论

  @level:l1 @spec:exception
  Scenario: finding 失败不影响解读
    Given 本轮生成评审结论时模型不可用
    When 李娜发起库存变更评审并等待解读完成
    Then 评审失败且张伟仍能读取已完成的解读及代码摘录

  @level:l1 @spec:normal
  Scenario: 评审完成后重新生成解读
    Given 库存变更的本轮评审与解读已完成
    When 张伟请求重新生成本轮解读
    And 在新解读生成期间再次请求重新生成
    Then 第二次请求被拒绝并说明已有解读正在生成
    And 本轮保留两份解读且新的一份已完成

  @level:l1 @spec:normal
  Scenario: 多个 PR 的评审在并发上限内同时执行
    Given 实例允许同时进行 2 个评审
    And 李娜、王芳、陈刚各自提交的 PR 都在等待评审
    When 评审开始处理
    Then 两个 PR 的评审同时进行且第三个仍为待评审
    And 其中一个评审结束后第三个 PR 开始评审

  @level:l1 @spec:constraint
  Scenario: 生成解读时读取提交与关联需求保持代码平台只读
    Given 仓库 "payment-gateway" 已接入
    When 李娜发起库存变更评审并等待解读完成
    Then 本轮读取了该变更的提交信息与关闭的需求
    And 代码平台上该 PR 没有新增任何评论
    And 代码平台上该 PR 的描述没有被修改
    And 代码平台上该 PR 没有被写入任何合并状态

  @level:l1 @spec:normal
  Scenario: Generator 只提交 finding 与文件分组
    Given 库存变更具有描述、提交信息与关联需求
    When 李娜发起库存变更评审并等待完成
    Then 评审详情不包含综述
    And 代码文件树按 Generator 提交的语义分组排列全部变更文件
