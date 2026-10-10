@layer:api @story:onboarding-and-health
Feature: 首次使用引导与实例健康
  As a 私有部署的管理员
  I want 看到团队接入进度和实例运行情况
  So that 可以完成首次配置并定位评审失败

  @level:bvt @spec:main
  Scenario: 引导清单根据团队数据逐步完成
    Given 张伟是尚未配置模型和接入仓库的团队管理员
    When 张伟查看首次使用引导
    Then 引导的五个步骤均未完成
    When 张伟只保存生成模型的完整配置
    Then 引导的模型步骤仍未完成
    When 张伟补齐评分模型并接入库存服务仓库
    Then 引导仅完成模型和仓库两个步骤
    When 库存服务收到未通过鉴权的事件
    Then 引导的 webhook 步骤仍未完成
    When 库存服务收到通过鉴权的事件
    And 团队已有 lint 配置、一条规范草稿和一轮失败的评审
    Then 引导完成模型仓库和 webhook，规范与评审仍未完成
    When 团队启用库存规范并取得一轮完成的评审
    Then 引导五步全部完成并且不再需要展示

  @level:l1 @spec:normal
  Scenario: 环境变量中的完整模型配置计入引导进度
    Given 实例通过环境变量配置了生成模型和评分模型
    When 张伟查看首次使用引导
    Then 引导仅完成模型步骤

  @level:l1 @spec:constraint
  Scenario: 引导进度只计算当前团队的数据
    Given 默认团队已完成引导的全部五步
    When 张伟切换到尚未接入仓库的支付研发团队并查看引导
    Then 引导仅完成模型步骤

  @level:l1 @spec:constraint
  Scenario: 普通成员不能查看团队引导
    Given 李娜是默认团队的普通成员
    When 李娜尝试查看首次使用引导
    Then 工作台提示引导需要团队管理员权限

  @level:bvt @spec:main
  Scenario: 服务管理员看到与评审记录一致的实例健康
    Given 两个团队存在最近七天和更早的已完成失败及排队评审
    When 张伟查看实例健康
    Then 队列有两轮等待和一轮进行中且最早等待约两小时
    And 最近七天失败按错误码分为模型不可用两轮与评审产出无效一轮
    And 失败分组可以找到对应团队的具体评审轮次
    And 两个生成模型的完成率分别为百分之七十五和百分之零
    And 按生成与评分阶段计算的平均被拒提交次数与记录一致
    And 健康信息包含模型配置来源和应用运行时及迁移版本

  @level:l1 @spec:constraint
  Scenario: 实例健康只允许服务管理员查看
    Given 李娜是没有服务权限的团队管理员而陈晨是普通成员
    When 李娜和陈晨分别尝试查看实例健康
    Then 两人都被提示需要服务管理员权限
    And 未登录访问实例健康时需要先登录
    When 李娜查看首次使用引导
    Then 模型步骤提示请联系服务管理员
