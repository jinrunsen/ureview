@layer:e2e @story:enterprise-sso
Feature: 在浏览器中使用企业账号登录
  As a 企业员工
  I want 从登录页跳转到公司统一认证并回到原来的页面
  So that 打开同事发来的链接时登录完就能接着看

  @level:l1 @spec:main
  Scenario: 从登录页跳转统一认证后回到原来要访问的页面
    Given 服务管理员已按 OIDC 对接公司统一认证
    And 员工赵磊未登录时打开了团队规范页的链接
    When 赵磊在登录页点击使用企业账号登录并在统一认证页完成登录
    Then 浏览器回到团队规范页并显示赵磊已登录
