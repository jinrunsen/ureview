# 私有化部署运维

适用于单实例部署。**v1.0 之前不承诺 schema 迁移兼容**；升级前保留数据库、持久卷和所用代码或镜像版本。v1.0 起承诺拉取镜像并重启后保留数据。（source: [部署与健康决定](../.agents/notes/implemented/feature/2026-10-06-onboarding-and-instance-health.md)）

## 安装

准备 Docker Compose，在仓库根目录创建不入库的 `.env`：

```dotenv
UREVIEW_PUBLIC_ORIGIN=https://review.example.com
UREVIEW_DATABASE_PASSWORD=replace_with_a_url_safe_password
UREVIEW_WEBHOOK_TOKEN=replace_with_a_random_secret
```

`UREVIEW_PUBLIC_ORIGIN` 填浏览器访问的来源地址，不带路径或末尾斜线；使用 HTTPS 时会话 Cookie 带 Secure 属性。应用角色口令在首次数据库初始化时生效；已有卷修改口令时，需要同时修改 PostgreSQL 角色口令。自动接收 GitLab 事件时，将 `UREVIEW_WEBHOOK_TOKEN` 同时填入 GitLab Webhook 的 Secret token。

同时执行的评审任务默认 5 个，由 `UREVIEW_REVIEW_CONCURRENCY` 调整，取值 1 到 20。每个评审同时运行 Generator、Grader、解读写作与审读几个模型会话，调高上限前先确认模型服务的并发与限流。（source: [评审任务并发执行](../.agents/notes/implemented/architecture/2026-10-08-concurrent-review-jobs.md)）

仓库自带 Compose 从源码构建服务，首次安装执行：

```sh
docker compose up -d --build
docker compose exec server cat /srv/blobs/setup-token
```

通过配置的地址打开工作台，用初始化码、用户名和密码创建首个账号，邮箱选填。该账号同时是团队管理员和服务管理员。服务管理员在「实例管理」配置 Generator 与 Grader；团队管理员在「我的待办」按引导接入仓库、收到 webhook 事件、启用规范并取得完成的评审。模型厂商、路由和协议通过部署环境配置；在启动前按 [README 配置](../README.md#配置) 填齐两阶段的厂商、路由、模型名、协议与 Base URL，密钥可在登录后保存。数据库中保存的密钥、模型名与 Base URL 优先于对应环境变量。完全未配置模型时，服务仍可启动并接入仓库。

Compose 将服务端口映射到宿主机 3000，数据库端口仅绑定 127.0.0.1:5432。对外访问可由反向代理提供 HTTPS；浏览器来源需与上述配置一致。数据库应用连接必须使用非超级用户且无 `BYPASSRLS` 的角色；Compose 初始化脚本创建 `ureview_app`。首次启动自动运行迁移。（source: [团队隔离](../.agents/notes/implemented/architecture/2026-10-04-team-identity-and-rls.md)）

### 持久化与环境变量

| Compose 卷 | 容器目录 | 内容 |
|---|---|---|
| `pgdata` | `/var/lib/postgresql/data` | 账号、配置、评审、会话与队列 |
| `worktrees` | `/srv/worktrees` | Git 代码工作副本 |
| `blobs` | `/srv/blobs` | 凭据加密密钥、运行时配置及对象文件 |

Docker 中的实际卷名带 Compose 项目名前缀，默认是部署目录名，例如在 `ureview` 目录部署时为 `ureview_pgdata`。用 `docker volume ls` 查看实际名称。

工作副本必须挂真实卷，代码检索的外部进程会直接读盘。数据库中的令牌依赖 `credentials.key` 解密；备份和恢复必须包含匹配的 blobs 卷。已有凭据而密钥文件缺失或长度不正确时，服务拒绝启动。恢复须使用原密钥。

直接运行 Node 时需设置 `DATABASE_URL` 和 `UREVIEW_WORKTREE_DIR`；`UREVIEW_BLOB_DIR` 默认 `/srv/blobs`，`UREVIEW_CREDENTIAL_KEY_FILE` 默认该目录中的 `credentials.key`，`UREVIEW_RUNTIME_HOME` 默认该目录中的 `runtime`，`PORT` 默认 3000。Compose 已配置这些目录及挂载。源码运行需要 Node 22.19 或 Node 24 及以上版本、Git，并先执行 `npm install` 与 `npm run build`。（source: [部署与健康决定](../.agents/notes/implemented/feature/2026-10-06-onboarding-and-instance-health.md)）

## 升级与回滚

升级前等待进行中的评审结束，停止服务并按下一节备份。迁移按文件名升序在服务启动时自动执行，每个文件与执行记录处于同一事务。失败会回滚该文件，已完成的前序迁移仍保留。

源码部署先切到要部署的代码版本，再执行：

```sh
docker compose pull db
docker compose build --pull server
docker compose up -d --no-deps server
docker compose logs --tail=100 server
curl --fail http://localhost:3000/health
```

使用预构建镜像的部署，在本地 `compose.image.yaml` 指定要部署的镜像：

```yaml
services:
  server:
    image: ${UREVIEW_IMAGE:?请设置已发布的镜像地址与版本}
```

设置 `UREVIEW_IMAGE` 为部署方提供的固定版本，升级时使用同一 Compose 文件组合：

```sh
docker compose -f docker-compose.yml -f compose.image.yaml pull server
docker compose -f docker-compose.yml -f compose.image.yaml up -d --no-deps --no-build server
```

仓库的默认 Compose 没有指定远端服务镜像；源码部署使用上面的构建命令。PostgreSQL 大版本升级需要单独制定数据迁移步骤。

用户名登录升级会把原邮箱的 `@` 前部分填入用户名，原密码和会话保留。若前缀重名，迁移为后续账号附加数字后缀；团队管理员可在成员列表查看迁移后的用户名。登录使用用户名。（source: [用户名登录](../.agents/notes/implemented/feature/2026-10-06-username-login.md)）

启动后 `/health` 应返回数据库正常，再以服务管理员进入「实例管理 → 实例健康」核对应用、dsh 和数据库迁移版本。迁移已经执行后，旧服务镜像可能无法读取新 schema；回滚应恢复升级前的数据库与配套卷，并运行当时的服务版本。不要直接用旧镜像接入已经升级的数据库。（source: [部署与健康决定](../.agents/notes/implemented/feature/2026-10-06-onboarding-and-instance-health.md)）

## 备份与恢复

在仓库根目录执行。以下示例暂停服务以取得一致的数据库、工作副本和密钥；数据库保持运行。备份目录含凭据与代码，应只允许运维人员访问。

```sh
mkdir -p backup
chmod 700 backup
docker compose stop server
docker compose exec -T db pg_dump -U ureview -d ureview -Fc > backup/database.dump
docker compose run --rm --no-deps -T --entrypoint tar server -C /srv/worktrees -czf - . > backup/worktrees.tar.gz
docker compose run --rm --no-deps -T --entrypoint tar server -C /srv/blobs -czf - . > backup/blobs.tar.gz
docker compose images > backup/images.txt
docker compose start server
```

同时保存该部署使用的代码版本、Compose 覆盖文件与 `.env`。镜像部署的所有 Compose 命令需追加同样的 `-f` 参数。确认备份文件非空，并在独立恢复环境验证可用后再按保留策略轮换。

恢复到空数据库和空工作副本、blobs 卷；下面命令会清理目标数据库中的同名对象。目标环境需先按安装步骤初始化 `ureview_app`，使用备份对应的口令与服务版本。

```sh
docker compose stop server
docker compose exec -T db pg_restore -U ureview -d ureview --clean --if-exists --exit-on-error < backup/database.dump
docker compose run --rm --no-deps -T --entrypoint tar server -C /srv/worktrees -xzf - < backup/worktrees.tar.gz
docker compose run --rm --no-deps -T --entrypoint tar server -C /srv/blobs -xzf - < backup/blobs.tar.gz
docker compose up -d --no-deps server
curl --fail http://localhost:3000/health
```

使用数据库管理员进行备份与恢复，可覆盖所有团队行；应用连接仍使用 `ureview_app`。恢复后核对登录、历史评审、仓库读取及实例健康，确认密钥与数据库匹配。停止服务前等待评审结束，可避免备份遗留进行中的任务；当前队列没有任务崩溃恢复。（source: [部署与健康决定](../.agents/notes/implemented/feature/2026-10-06-onboarding-and-instance-health.md)）

## 日志与日常排查

服务日志写入标准输出和标准错误，由 Docker 日志驱动保存。运行记录与可回看的评审会话保存在 PostgreSQL。查看服务及数据库日志：

```sh
docker compose logs --since=1h --tail=200 server
docker compose logs --since=1h --tail=200 db
docker compose logs -f server
```

HTTP 日志包含请求标识、方法、路由模板、状态码与耗时；模型故障仅输出安全分类。日志保留和轮换按部署环境的 Docker 日志配置设置。直接运行 Node 时，由启动终端或进程管理器收集标准输出与标准错误。

服务管理员从实例健康查看模型状态、排队时长、最近七天按错误码分组的失败及模型完成率。完成率以时间窗内已结束轮次为分母；平均被拒提交次数来自该轮对应阶段的提交记录。模型尚无记录时显示暂无记录；没有已结束轮次时显示暂无评审。实例健康供人工排查，本期不提供告警推送或指标导出。（source: [部署与健康决定](../.agents/notes/implemented/feature/2026-10-06-onboarding-and-instance-health.md)）

## 企业账号登录

服务管理员在「实例管理 → 企业账号登录」配置一个 OIDC 或 OAuth2 身份源。保存后立即生效。先确认 `UREVIEW_PUBLIC_ORIGIN` 是员工实际访问的公开地址，再把页面显示的完整回调地址登记到身份源的应用中：`{UREVIEW_PUBLIC_ORIGIN}/api/auth/sso/callback`。生产地址使用 HTTPS，本机调试允许 localhost、127.0.0.1 和 ::1 的 HTTP。

OIDC 填 Issuer；OAuth2 分别填授权、令牌和用户信息端点。Client ID 与 Client Secret 使用身份源登记的应用凭据。Secret 加密保存，页面只显示是否已配置，留空保存保留原值。scope 决定身份源允许读取的资料；OIDC 默认 `openid profile email`。令牌端点认证方式按身份源配置选择 basic 或 post，分别默认于 OIDC 和 OAuth2。

唯一标识、用户名、姓名、邮箱字段使用点号路径。默认按用户名关联本地账号，也可选邮箱或不关联。邮箱多人共用或 OIDC 明确标记未验证时不自动关联。服务管理员账号不参与自动关联。服务管理员要用企业账号登录时，在实例管理中给企业登录建立的账号授予服务管理员权限。已有账号的姓名和邮箱保持原值；新账号没有密码，以成员角色进入所选默认团队。账号被移出所有团队后需要管理员重新添加，企业登录不会自动把它加回。

「测试连接」只用当前表单地址检查可达性，不保存配置，也不验证 Client Secret。无法访问时检查地址和网络；discovery 内容无效时检查 JSON 格式及端点；Issuer 不一致时按页面显示的身份源返回值逐字核对，留意末尾斜杠。保存提示版本冲突时，保留当前输入供核对，刷新读取其他管理员的最新配置后重新填写。

### Keycloak 示例

Issuer 填 `https://sso.example.com/realms/company`，应用开启授权码流程，登记页面提供的回调地址。使用应用自己的 Client ID 与 Secret，scope 填 `openid profile email`；字段映射为 `sub`、`preferred_username`、`name`、`email`。端点通过该 realm 的 discovery 文档读取。参见 [Keycloak OIDC 端点说明](https://www.keycloak.org/securing-apps/oidc-layers)。

### Microsoft Entra ID 示例

为 Web 应用登记回调地址，Issuer 填 `https://login.microsoftonline.com/{租户ID}/v2.0`，Client ID 使用应用程序 ID，Client Secret 填客户端密码的值。选定具体租户，不能填 `common` 或 `organizations`：工作台要求 discovery 和令牌中的 issuer 与配置精确相同。scope 与字段映射采用 OIDC 默认值；按邮箱关联前，确认身份源实际提供邮箱声明。参见 [Microsoft OIDC 文档](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)。

### 自研 OAuth2 示例

分别填写公司的 `/oauth2/authorize`、`/oauth2/token`、`/oauth2/get_user_info` 完整 HTTPS 地址，令牌认证方式默认 `client_secret_post`。当用户信息为 `{"code":0,"data":{"userid":10086,"username":"wangfang","name":"王芳","email":"wangfang@example.com"}}` 时，四个映射分别填 `data.userid`、`data.username`、`data.name`、`data.email`。员工唯一标识必须稳定。数字只接受 JavaScript 安全整数（绝对值不超过 9007199254740991），再转为字符串保存；更大的编号由身份源以字符串返回。

### 密码登录与排障

建议确认企业登录成功后再把密码登录范围设为「仅服务管理员」。有密码的服务管理员始终可用密码登录，用于身份源不可用时修复配置。实例至少保留一名这样的管理员；只有企业身份、没有密码的账号即使获得服务管理权限，也仍通过企业账号登录。停用企业登录保留配置与绑定；密码登录范围独立生效，需要时一并改回「全部账号」。

- 登录已过期或来源不一致：从同一浏览器重新发起登录，十分钟内完成，不复用回调链接；配置修改也会使旧登录失效。
- 身份源拒绝登录：核对应用启用状态、员工访问资格，以及登记的回调地址是否逐字一致。
- 无法连接统一认证：检查端点、Client 凭据、令牌认证方式与网络。OIDC 还需核对身份源的系统时间，过期 `id_token` 会被拒绝。
- 未返回用户标识：检查 scope、身份源实际返回的资料结构与唯一标识字段路径。
- 账号尚未加入团队：请团队管理员按用户名添加已有成员。

更换 Issuer 或 OAuth2 令牌端点会建立新的身份源命名空间。关联方式仍适用；不希望与旧账号关联时选择「不关联」。退出工作台只撤销工作台会话，不会退出企业身份源。

（source: [企业账号登录规格](../requirements/01-v1-qodo-reproduction/26-enterprise-sso-login/spec.md)、[认证与账号边界](../.agents/notes/implemented/feature/2026-10-09-enterprise-sso-login.md)）
