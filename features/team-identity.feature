@layer:api @story:team-identity
Feature: 登录并在所属团队内协作
  As a 团队成员
  I want 使用自己的账号进入所属团队
  So that 评审资料只在团队内部共享

  @level:bvt @spec:main
  Scenario: 首次管理员初始化后可以使用用户名密码登录
    Given 工作台尚未创建任何账号
    When 张伟使用服务器初始化码创建管理员账号
    Then 张伟成为默认团队的管理员
    When 张伟退出后使用正确的用户名密码登录
    Then 张伟重新进入默认团队

  @level:l1 @spec:constraint
  Scenario: 普通成员能阅读仓库但不能修改接入配置
    Given 张伟已接入库存服务仓库并添加普通成员李娜
    When 李娜登录并查看仓库
    Then 李娜可以看到库存服务仓库
    When 李娜尝试接入仓库和创建团队
    Then 工作台提示这些操作需要管理员权限

  @level:l1 @spec:constraint
  Scenario: 切换团队隔离资料且不能进入未加入的团队
    Given 张伟管理默认团队和支付研发团队且李娜只属于默认团队
    And 默认团队已接入库存服务仓库
    When 张伟切换到支付研发团队
    Then 张伟看不到默认团队的库存服务仓库
    When 李娜尝试切换到支付研发团队
    Then 李娜被拒绝并仍然处于默认团队

  @level:l1 @spec:normal
  Scenario: 退出账号后原会话不能继续查看仓库
    Given 张伟已登录评审工作台
    When 张伟退出账号后继续访问仓库列表
    Then 工作台要求张伟重新登录

  @level:l1 @spec:constraint
  Scenario: 管理员创建成员时用户名必填且邮箱可选
    Given 张伟已登录评审工作台
    When 张伟添加没有用户名的成员
    Then 工作台要求填写用户名
    When 张伟以用户名 "li.na" 添加不填写邮箱的普通成员李娜
    Then 李娜可以使用用户名和密码登录且邮箱未填写
