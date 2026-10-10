@layer:api @story:enterprise-sso
Feature: 使用企业账号登录
  As a 企业员工
  I want 用公司统一认证的账号登录 uReview
  So that 不用再单独记一套账号密码

  @level:bvt @spec:main
  Scenario: 首次使用企业账号登录时自动建号并加入默认团队
    Given 服务管理员已按 OIDC 对接公司统一认证，新账号加入“数据面团队”
    And 员工赵磊在 uReview 中还没有账号
    When 赵磊使用企业账号登录
    Then 赵磊进入 uReview，账号以成员身份属于数据面团队
    When 赵磊退出后再次使用企业账号登录
    Then 赵磊进入的仍是同一个账号

  @level:l1 @spec:normal
  Scenario: 已有本地账号按用户名关联企业账号
    Given 服务管理员已按 OIDC 对接公司统一认证，按用户名关联已有账号
    And 支付团队管理员李娜已有用户名为“lina”的本地账号
    When 李娜使用企业账号登录，统一认证返回的用户名为“lina”
    Then 李娜进入原有账号，仍是支付团队管理员
    And 李娜仍可以用原密码登录

  @level:l1 @spec:normal
  Scenario: 对接自研统一认证时按配置的字段识别用户
    Given 服务管理员已按 OAuth2 对接自研统一认证，唯一标识字段为“data.userid”
    When 员工王芳使用企业账号登录，统一认证返回工号“10086”与姓名“王芳”
    Then 王芳进入 uReview，账号姓名为王芳并绑定工号 10086

  @level:l1 @spec:constraint
  Scenario: 服务管理员的本地账号不会被企业账号自动关联
    Given 服务管理员已按 OIDC 对接公司统一认证，按用户名关联已有账号
    And 服务管理员张伟的本地账号用户名为“zhangwei”
    When 员工使用企业账号登录，统一认证返回的用户名为“zhangwei”
    Then 员工进入的是新建的成员账号，不具有服务管理员权限
    And 张伟仍可以用原密码登录并保留服务管理员权限

  @level:l1 @spec:exception
  Scenario: 登录回调与发起登录的浏览器不一致时拒绝登录
    Given 服务管理员已按 OIDC 对接公司统一认证
    When 赵磊在另一个浏览器中打开别人发起登录后得到的回调链接
    Then 登录失败并提示重新登录，赵磊没有进入 uReview
    When 发起登录的浏览器再次打开已经用过的回调链接
    Then 登录仍然失败

  @level:l1 @spec:exception
  Scenario: 统一认证没有返回唯一标识时拒绝登录
    Given 服务管理员已按 OAuth2 对接自研统一认证，唯一标识字段为“data.userid”
    When 员工孙悦使用企业账号登录，统一认证返回的用户信息缺少工号
    Then 登录失败并提示统一认证未返回用户标识，没有新建账号

  @level:l1 @spec:exception
  Scenario: 统一认证不可达时登录页给出明确提示
    Given 服务管理员已按 OIDC 对接公司统一认证
    And 统一认证的令牌服务暂时无法访问
    When 赵磊使用企业账号登录
    Then 登录页提示无法连接统一认证，赵磊没有进入 uReview

  @level:l1 @spec:normal
  Scenario: 未启用企业登录时登录页不显示企业登录入口
    Given 服务管理员尚未启用企业账号登录
    When 访客打开登录页
    Then 登录页只提供用户名密码登录
    When 访客直接打开企业登录入口
    Then 回到登录页并提示企业登录未启用

  @level:l2 @spec:exception
  Scenario: 账号被移出全部团队后企业登录提示联系管理员
    Given 赵磊已通过企业账号登录并属于数据面团队
    And 数据面团队管理员把赵磊移出团队
    When 赵磊使用企业账号登录
    Then 登录失败并提示账号尚未加入团队，请联系管理员

  @level:l1 @spec:constraint
  Scenario: 企业登录新建的账号不能使用密码登录
    Given 赵磊通过企业账号登录建立了账号
    When 赵磊用自己的用户名和一个密码登录
    Then 登录失败并提示该账号使用企业账号登录

  @level:l1 @spec:constraint
  Scenario: 仅服务管理员可用密码登录时其他账号必须使用企业账号
    Given 服务管理员张伟把密码登录设为仅服务管理员可用
    When 支付团队管理员李娜用正确的密码登录
    Then 登录失败并提示请使用企业账号登录
    When 张伟用正确的密码登录
    Then 张伟进入 uReview

  @level:l1 @spec:normal
  Scenario: 保存企业登录配置时密钥不回显且留空不覆盖
    Given 服务管理员张伟已保存 OIDC 配置和 Client Secret
    When 张伟只把登录按钮文案改为“使用公司统一认证登录”并保存
    Then 配置显示 Client Secret 已配置但不显示明文
    And 赵磊仍可以使用企业账号登录

  @level:l1 @spec:constraint
  Scenario: 非服务管理员不能查看或修改企业登录配置
    Given 支付团队管理员李娜不是服务管理员
    When 李娜尝试查看和修改企业登录配置
    Then 李娜看不到配置内容，配置保持不变

  @level:l1 @spec:normal
  Scenario: 测试连接只校验身份源可达，不保存配置
    Given 服务管理员张伟正在填写 OIDC 配置
    When 张伟用填写的 Issuer 测试连接
    Then 页面显示身份源可达以及读到的授权与令牌端点
    And 已保存的配置保持不变
