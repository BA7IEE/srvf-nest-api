# 贡献影子映射登记（代码候选，生产 NO-GO）

本文件不授权现场执行。当前只在 `app_test_w98` 做回滚式角色／ACL验证；真实31类映射仍全部 hold。
第135条尚未定稿签字，未部署、未配置生产角色、未登记真实映射，也未启用 shadow 或 Gate。

## 入口与责任

- `scripts/sql/contribution-shadow-registration-roles.sql`：维护者使用受控运维身份执行的独立 ACL 脚本，不进入自动 migration。
- `scripts/register-contribution-shadow-mapping.ts`：执行人完整 Human 认证和显式 GLOBAL 权限验证，使用指定登记连接，不回落到应用 owner 连接。
- 默认只校验清单格式和摘要。退出成功不代表清单已获批准、执行人已认证或数据已登记。
- 真实清单、精确摘要、执行人、数据库与单轮登记凭据均须另行批准；SQL 3b、目录／审计4b和现场运维授权各自独立。
- DB owner／superuser属于可信运维边界，不声称能够抵抗其修改函数或关闭守卫。

## ACL 生命周期

脚本读取事务局部 `srvf.shadow_acl_database` 和 `srvf.shadow_acl_action`；数据库必须精确匹配当前连接。
只能取 `bootstrap`、`bind`、`close`。应由维护者在显式事务中执行，任何错误整笔回滚。

`bootstrap` 仅初次准备三角色及函数／批准表属主，不登记业务数据。任何同名角色已存在立即拒绝，不能用重跑隐式覆盖。
三角色均 NOLOGIN、非superuser、无CREATEDB／CREATEROLE／REPLICATION／BYPASSRLS；不生成密码、不发登录凭据。
生产名为 `srvf_shadow_registration_owner`、`srvf_shadow_registrar`、`srvf_shadow_runtime`；w98使用固定测试名，测试结束事务回滚。
函数owner不可登录，登记／运行角色不可切换到owner或相互切换；PUBLIC不能执行登记或信任根函数。
owner的旧表UPDATE(id)权限仅满足PG行锁要求，登记函数没有业务UPDATE。登记角色只有当前身份／GLOBAL RBAC必要列的读取能力，不能读passwordHash或通用业务写入。
`bootstrap`另安装独立运行身份的字面量根，仅含精确数据库及三角色名，不携带manifest批准；
向运行角色开放应用证明及Attempt／Comparison／Terminal表INSERT／SELECT，只读冻结来源元组及映射批准；写入仍由SECURITY DEFINER守卫核验实际来源、批准、
E1不可变选择项、政策摘要及数据库复算。普通GUC不能替换身份根；PUBLIC／登记角色不可调用私有身份根或守卫。
函数owner按Activity→Session→Position锁序重读，拒绝事后选择版本、缺失／inherit引用、
跨岗位／版本及任意伪造分数、时长、解释码或同链字段。默认migration身份根NULL，未执行独立ACL准备时仍拒写。
运行角色没有旧考勤写权、来源写权或原始AuditLog读取权。D1 attempt／terminal守卫正文不变，固定search_path的NOLOGIN函数owner持有必要读锁权限；比较守卫只在已有真实不可变应用证明且当前会话为隔离runtime时接受可比较结果，不允许owner／registrar冒充。PUBLIC及runtime不能直接执行私有守卫或身份根。
具名角色的SQL整链及真实Prisma集合写者已用w98回滚式会话身份验证，不等于实际LOGIN或整套业务连接已配置；应用层当前请求的权限复核、事务后调用／重放与全链性能仍需完成。

`bind` 读取事务局部 `srvf.shadow_registration_authority` 的精确JSON，逐项核对键集：
`databaseName`、`manifestHash`、`actorUserId`、`approvalReference`、`ownerRole`、`registrarRole`、`runtimeRole`、`manifest`。
数据库、固定角色名、完整清单／摘要／出处必须一致，当前Human必须已有真实有效GLOBAL授权。
受控DDL将该值安全引用为信任根函数的字面量，再单独开放本轮登记EXECUTE。普通进程设置同名GUC不是批准，不能修改函数或执行ACL脚本。
维护者逐项批准清单才是业务授权；格式检查、算出相同hash或脚本成功不能替代批准。

`close` 撤回登记EXECUTE、恢复登记角色NOLOGIN、清空信任根，不删除批准／审计／收据。
此处清空的是单轮登记信任根，不是独立运行身份根；已登记历史批准不因登记操作结束而失效。
运行角色的登录开通、连接管理、shadow启用及关闭仍是另外的现场授权，本轮未执行。
现场还须由维护者确认登记进程结束、连接回收及无在途事务；脚本不擅自终止其它业务连接。
撤回后如需合法重放，重新批准并绑定同一精确清单，不得改载荷复用命令键。

## CLI

仅格式核对（不连接数据库，不读取凭据）：

```bash
pnpm exec tsx scripts/register-contribution-shadow-mapping.ts --manifest <已准备清单文件> --expected-manifest-hash <完整SHA256>
```

现场执行必须另获授权后才增加 `--execute`。凭据仅从非回显管道的标准输入进入，JSON恰有
`registrarDatabaseUrl`、`accessToken` 两键；禁止作为命令参数传入，禁止粘贴到聊天、日志或审计。
JWT配置复用受控运行环境中的既有配置，不新增配置源、JWT载荷或登录行为；不使用其它action的step-up proof。
本轮未创建登录凭据，未执行CLI的真实登记模式；其完整登录连接验收仍是后续独立现场边界。

登记service在命令锁前、命令锁后及SQL返回后重新验签、查询当前用户及显式GLOBAL授权。
数据库还在引用锁后独立复验身份／真实授权、清单、角色隔离和真实引用。
批准、审计、收据同事务写入；任一失败回滚，不重试。同命令同内容返回原收据，不增加审计或批准。
stdout仅给状态、manifest摘要及条数；错误不打印凭据、连接URL、原清单或provider异常。

## 验收分层

本地w98证明：脚本原文参与隔离角色创建、绑定、关闭及ACL正反例，测试配置不是另一套手写实现。
CLI默认模式实际子进程验证；Human凭据过期／权限撤回和登记事务编排有定向单测。
这不代替真实登录凭据验收、生产ACL、PR CI、SQL／权限重签，也不代表D2比较链或T0整体完成。
原7秒旧业务预算不变，旧业务成功后的比较5秒预算仍须完整实现和验证。

回退是关闭登记和shadow入口，保留永久证据；不删除、回填或重算业务数据，不回改历史migration。
