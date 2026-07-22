# Auth Session 全链线性化冻结评审稿（v0.60 remediation D-PR1）

> 状态：**FROZEN / 已拍板**  
> 拍板：维护者于 2026-07-22 对《v0.60.1 后端收口执行单》及只读核验简报回复“按推荐”。  
> 实施基线：`main@f9de8eaee2d1c7f91e33d4d9a71a2396f12252a4`。  
> 档位：D（Auth / refresh token 安全并发语义）。

## 1. 终态定义（DoD）

1. 全仓只有一个 per-user session serialization primitive；实现为 PostgreSQL `User` 行 `FOR UPDATE`，不存在进程锁、缓存、Redis 或 advisory-lock 第二轨。
2. 密码、SMS、WeChat 会话签发均在持有该锁后重读当前 User；只有 `ACTIVE + deletedAt=null` 且锁后 factor snapshot 与锁外已验证 snapshot 相同才允许创建 refresh token。
3. refresh rotation、replay family revoke、logout、logout-all 均先锁 User，再锁后重读 refresh row，最后 mutation + audit；rotation absolute expiration、错误码和 audit 字段零漂移。
4. 本人改密、短信找回、管理员重置、手机/微信绑定或清除、用户禁用/软删、队员账号禁用/重开/离队均在同一 User 锁内完成身份写入与 refresh 撤销。
5. 统一锁序：既有更上层 aggregate 锁（last-admin advisory / Member）→ User session lock → refresh row mutation → audit。禁止任何路径先锁 refresh row 再锁 User。
6. 两个 Nest app、两个独立 Prisma pool、真实 PostgreSQL wait evidence 覆盖：refresh vs 本人改密、短信找回、logout-all、admin disable、member offboard；replay vs rotation；旧密码 login vs 改密；SMS login vs phone change；WeChat login vs openid change；事务失败零 orphan refresh / 零假 audit。
7. 既有 characterization、Auth/Users/Members 受影响 E2E、contract snapshot 与全量 gate 全绿；不修改既有行为断言来换绿。

## 2. 探针驱动任务队列

| ID | 探针未满足才做 | 实施 | 验收 |
|---|---|---|---|
| P1 | session mutation 路径不存在统一 User 锁 | 新增唯一 lock helper，并替换 Auth/Users/Members 内 session 相关裸 User 锁 | `rg` 证明写集内 session 路径全调用同一 helper |
| P2 | `createSession()` 只信锁外 `{id,username,role}` | 改为 `userId + factor expectation`，锁后重读 authoritative snapshot | 三登录路径 stale factor 均拒绝且零 token/audit |
| P3 | refresh/logout/replay 与 broad revoke 可交错 | 全部按 User→refresh 顺序串行，锁后重读 | 双 pool barrier 证明线性化前后终态 |
| P4 | 身份/状态写与 revoke 未共享锁 | 在原事务内先取 User lock，再重读、写、revoke、audit | 失败回滚；成功后无 active sibling token |
| P5 | 仅有顺序 E2E | 新增确定性 concurrency spec，使用 `pg_stat_activity` / transaction barrier，禁 sleep-race | 每个 barrier 观察到真实 PostgreSQL blocking PID |

## 3. 授权清单

- 新增 focused session lock helper 与测试。
- 修改 Auth password/SMS/WeChat issuance、refresh、replay、logout/logout-all 内部编排。
- 修改 Users 的密码、status/delete、phone/wechat identity mutation 内部编排。
- 修改 Members 的关联账号 disable/reopen/offboard 内部编排。
- 新增/修改 characterization、unit、双连接 E2E；同步三个模块 `CLAUDE.md`、安全事实文档和 `changelog.d` fragment。
- 运行定向测试、`agent:check:full` 与只读 Git/GitHub 核验；创建分支、commit、push、PR。

## 4. 禁止域

- 不改 Prisma schema/migration/seed；不运行 `prisma migrate dev|reset|db push`。
- 不新增或修改 endpoint、DTO 字段、BizCode、Permission、Role、Guard、throttler、JWT payload、access-token 吊销策略。
- 不改变 refresh opaque token、SHA-256、rotation always、90d absolute expiration、family revoke、logout 幂等、失败统一 10007 等冻结契约。
- 不引入 Redis、queue、cron、tokenVersion、access blacklist 或新依赖。
- 不处理 Storage、日志、JWT TTL、OpenAPI、Recruitment ledger、release/tag/deploy；它们属于后续独立 PR。
- 不修改既有 archive；本文件新增后冻结，不回改。实施偏差写在 PR 正文或新文档，不篡改本稿。

## 5. 写集声明

允许写入：

- `src/modules/auth/{auth-session-lock.ts,auth.service.ts,auth.service.spec.ts,login-sms.service.ts,login-sms.service.spec.ts,login-wechat.service.ts,login-wechat.service.spec.ts,password-reset.service.ts,password-reset.service.spec.ts,CLAUDE.md}`
- `src/modules/users/{users.service.ts,users.service.spec.ts,CLAUDE.md}`
- `src/modules/members/{members.service.ts,members.service.spec.ts,CLAUDE.md}`
- `test/e2e/auth-session-linearization.e2e-spec.ts` 及为接入新 spec 所必需的测试清单文件（若存在）
- `docs/security.md`
- `docs/archive/reviews/auth-session-linearization-v0.60-review.md`（仅本次新增）
- `changelog.d/auth-session-linearization.md`

其余文件均不在写集。若测试编译要求扩大写集，必须先停下上报。

## 6. 锁后重读与失败映射

| 路径 | 锁外昂贵/外部步骤 | 锁后必须重读 | stale / inactive 结果 |
|---|---|---|---|
| password login | user lookup + bcrypt | status/deletedAt/passwordHash/username/role | `LOGIN_FAILED` |
| SMS login | phone resolve + code consume | status/deletedAt/phone/username/role | `SMS_CODE_INVALID` |
| WeChat login/bind | code2session（及 SMS consume） | status/deletedAt/openid/username/role | `WECHAT_CODE_INVALID`；绑定已提交但签发失败仍可重登 |
| refresh | tokenHash pre-read 仅用于定位 userId | User + token 全状态 | 统一 `REFRESH_TOKEN_INVALID` |
| password / identity / lifecycle mutation | bcrypt、step-up、RBAC 等既有前置 | 当前 User/目标 factor/role/status | 复用该路径既有 BizCode，不新增细分码 |

并发双 refresh 特例：若请求锁外观察到 fresh token、等待 User 锁后发现它已被另一请求 rotation，则按既有正常 CAS 竞争返回 10007，**不**把它升级为 replay family revoke；锁外已经观察到 rotated ancestor 的请求才执行 replay revoke。

## 7. 风险与回退

| 风险 | 控制 | 回退 |
|---|---|---|
| 跨 Member/User 路径死锁 | 保持既有 Member→User 顺序，session issuance 只锁 User | 单 PR revert，不含 schema 数据回退 |
| 锁持有时间扩大 | bcrypt、SMS、code2session 均留在锁外；锁内仅重读、token mutation、audit | 回退 helper 接线，恢复原事务编排 |
| 正常并发 refresh 被误判 replay | 保留锁外 observed-state 与锁后 current-state 双快照判定 | characterization + barrier mutation test 拦截 |
| 防枚举响应漂移 | 每种登录 stale 路径复用原 BizCode | contract/E2E 比较完整响应 |

## 8. 本 PR 不代表

- 不代表 production 已部署或真实 fleet 已排空。
- 不代表 Storage、日志、JWT TTL、OpenAPI、Recruitment 条件项已完成。
- 不授权 merge、release、tag 或 deploy。
