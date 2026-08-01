- **企业微信身份与配置 schema 骨架(2026-08-01;企业微信接入 T1,冻结稿 [`wecom-integration-t0-terminal-review.md`](docs/archive/reviews/wecom-integration-t0-terminal-review.md) §5)**:第 68 个 migration,**expand-only**,**零业务行为变更**(三张新表此刻无任何 controller / service / DTO —— settings 端点在 T2,OAuth 与绑定在 T3)。

  **三张新表**,按冻结稿 §5 逐字落:
  - `WecomSettings` —— 单企业单自建应用的配置与凭证。singleton:migration 末尾 `CREATE UNIQUE INDEX ... ON ((true))` 在 **DB 层**强制全库至多一行(沿第 49 migration 四张 provider settings 表同一形状),不靠应用层自觉。三个开关 `enabled` / `loginEnabled` / `messageEnabled` **默认全 false** —— 上线是显式动作,不是部署副作用。
  - `WecomIdentity` —— 企业微信身份 ↔ User 的绑定行。**无 soft delete**:`revoked` 本身已是终态历史语义;绑定 / 换绑 / 清除**全部保留历史行**,换绑是「结束旧 active 行 + 新建 active 行」,不覆盖旧行的 `wecomUserId`。
  - `WecomAuthAttempt` —— OAuth state 与 binding ticket 的一次性凭证台账。**原始 state 与 binding ticket 不入库,只存 SHA-256 hash**(故列名带 `Hash` 后缀且 `@unique`);OAuth code 连 hash 都不存。

  **身份绑 User 不绑 Member**(冻结稿 §1.2 结论 4):会话属于 User,Admin 账号可能没有 Member,Member 的业务准入另由 `AppIdentityResolver` 决定。故 `WecomIdentity` 既无 `memberId`,也不存通讯录快照(部门 / 姓名 / 头像 / 手机 / 邮箱一概不建)。

  **`User` 只加两条反向 relation,零标量字段**(§5.4)。冻结稿 §0.3 第一条硬禁区就是「不把企业微信 `UserId` 写进 `User.openid`」:`openid` 是微信**小程序**身份键,企业微信内部成员身份键是 `corpId + wecomUserId`,塞进同一字段会让登录、换绑、通知、审计四条链路一起语义污染。身份占用全部落在 `WecomIdentity` 行上。

  **`SmsPurpose` +1:`WECOM_BIND`** —— 未绑定登录时以手机号锚定到已有 User 的 pre-auth 用途。本刀一并加,把 schema 变更收进这一条 migration;**T3 才消费**。

  **5 条手写约束**(Prisma DSL 表达不了 partial unique 的 WHERE 与 CHECK):
  - `wecom_settings_singleton_unique` —— 全库至多一行 settings
  - `wecom_identity_subject_active_unique` `(corpId, wecomUserId) WHERE status='active'` —— 一个企业微信身份至多绑一个 active User;partial 是关键,否则「解绑后换个人再绑同一个企业微信号」会被永久挡死
  - `wecom_identity_user_active_unique` `(corpId, userId) WHERE status='active'` —— 一个 User 在当前 Corp 下至多一个 active 身份
  - `wecom_identity_status_check` —— status 闭集 `{active, revoked}`
  - `wecom_identity_revocation_shape_check` —— `active ⇔ revokedAt IS NULL`;防「状态说 active 却带着撤销时间」与「状态说 revoked 却查不到什么时候撤的」,后者会让审计答不出「这个绑定什么时候失效的」

  **验证**:干净库 `migrate deploy` 重放 68 个 migration 全绿 + seed 幂等二跑(0 error);5 条约束**逐条跑过双向阳性对照** —— 第二行 settings 被拒、同 subject 第 2 条 active 被拒而 revoked 重复放行、同 user 第 2 条 active 被拒而换 corp 放行、两种坏撤销形状被拒而两种合法形状放行。用例见 `test/e2e/wecom-schema.e2e-spec.ts`。

  ⚠️ **一处实测发现的约束重叠(非缺陷,不改冻结稿)**:任何 `status ∉ {active, revoked}` 同时也让 `revocation_shape_check` 的两个分支都为假,PostgreSQL 实际报出的是 shape check —— `status_check` **在 INSERT 路径上被完全覆盖**,不存在「只违反 status_check 却满足 shape_check」的输入。冻结稿 §5.2 两条都要求写,本刀逐字落地不擅自删其一;但 e2e 对非法 status 只断言 `23514` 与「被拒」,**不断言命中哪条** —— 断言 `status_check` 会是一条假绿(它测的其实是 shape check)。`status_check` 的价值是纵深防御的声明(将来若放宽 shape,取值闭集仍然关着),不是一道独立可达的闸。

  **零回填、零删数、零 DROP、零 default 变更、零默认身份绑定、零不可逆操作**;生产未 deploy。
