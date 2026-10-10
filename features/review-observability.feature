@layer:api @story:review-observability
Feature: 评审编排的观测与基线
  As a 维护评审质量的工程师
  I want 知道每个会话的上下文怎么装配、用了多少、读过哪些改动
  So that 后续的编排改动可以和基线比较

  @level:bvt @spec:main @status:pending
  Scenario: 生成代码、锁文件与只改空白的文件不进入评审并列为已跳过
    Given 库存变更另外改动了一个 pb.go 文件、go.sum 和一个只改了缩进的文件
    And 库存变更还新增了一个首行带生成标记的 Go 文件
    When 李娜发起库存变更评审并等待评审完成
    Then Generator 与写作会话收到的变更文件不含这四个文件
    And 评审结果列出四个已跳过的文件及各自的原因
    And 主位置在已跳过文件上的 finding 被拒绝并写明该文件已跳过

  @level:l1 @spec:exception @status:pending
  Scenario: 全部变更文件都被跳过时不调用模型
    Given 一个 PR 只改动了 go.sum 和一个 pb.go 文件
    When 李娜发起这个 PR 的评审
    Then 评审不调用模型并标为跳过
    And 评审状态说明写明全部变更文件已被跳过及原因

  @level:bvt @spec:main @status:pending
  Scenario: 每个评审会话保存装配清单与累计用量
    Given 模型桩在每一步返回输入、缓存命中与输出 token
    And 写作会话在第二步之后发生一次上下文压缩
    When 李娜发起库存变更评审并等待解读完成
    Then Generator、Grader、写作与审读会话各有一份装配清单
    And 装配清单的窗口取自该模型声明的上下文窗口
    And 装配清单列出首轮的系统提示、工具定义、团队规范、任务说明、需求来源与 PR diff 的字符数与估算 token
    And 装配清单的累计 token 等于各步用量之和且写作会话的压缩次数为 1

  @level:l1 @spec:exception @status:pending
  Scenario: 早于装配清单的会话在首次查看时补算
    Given 一个已结束的 Generator 会话没有装配清单且任务消息是单个文本块
    When 张伟查看这个会话
    Then 返回的装配清单从任务消息中切出 PR diff 与需求来源
    And 张伟再次查看时看到同一份装配清单

  @level:bvt @spec:main @status:pending
  Scenario: Generator 与解读写作会话记录 diff 的曝光与主动读取
    Given 库存变更有三个文件共五个 hunk，其中一个 hunk 只删除代码
    And Generator 只读取了两个文件中各一个 hunk 的部分行
    And 写作会话读取了全部三个文件
    When 李娜发起库存变更评审并等待解读完成
    Then Generator 的装配清单记录四个 hunk 全部曝光、两个 hunk 被主动读取、三个文件中两个被主动读取
    And Generator 没读过的文件列表只有第三个文件
    And 写作会话的装配清单记录三个文件全部被主动读取
