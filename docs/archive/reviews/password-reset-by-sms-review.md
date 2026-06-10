# SRVF 找回密码评审稿(Password Reset by SMS Review)

> **状态**:**实施前评审稿(冻结文本)**(2026-06-11)
> **性质**:**D 档拍板记录 + implementation review**(沿 [`docs/process.md §4 / §7.1`](../../process.md))。维护者已于 2026-06-11 经评审逐项拍板(4 项拍板,§1.1),工程细节授权代决(§1.2);goal 文本 = 立项 + 拍板凭据,本稿把 goal §0-§2 共识成文并冻结。**实施中任何偏离本稿的决定 → 人话简报(process §4.1)停下等回复,不得自行调整。**
> **范围**:pre-auth 找回密码两端点(`POST /api/auth/v1/password-reset/send-code` + `POST /api/auth/v1/password-reset`)+ `SmsPurpose` 枚举 +`PASSWORD_RESET`(migration)+ 第 5 联动撤销场景 `'self-password-reset'` + audit `password.reset.by-sms` + AGENTS §9 红区行更新(四场景→五场景)。
> **不在范围**:三步式票据 / 重置后自动登录(返 token)/ 图形验证码 / OTP 登录(AGENTS:242 不动)/ 通知用途短信 / 新 BizCode / 新权限码 / repository 层 / cron(详 §10)。
> **前置基建**(已就绪,v0.18.0;冻结评审稿 [`sms-verification-infra-review.md`](./sms-verification-infra-review.md),下称 **SMS 评审稿**):`SmsCodeService.issue/verifyAndConsume`(`sms_verification_codes.userId` 可空即为 pre-auth 消费者预留)、`User.phone @unique`(含软删占用)、防刷三层、DevStub 固定码 888888。
> **前置必读**:[`AGENTS.md §5/§8/§9`](../../../AGENTS.md) / [`docs/api-surface-policy.md §0`](../../api-surface-policy.md) / `srvf-auth-security`、`srvf-prisma-change`、`srvf-api-surface` skills。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线(沿 process §6);但在"本期找回密码范围内的具体设计取舍"上,本稿即冻结决议。
> **解除条件**:本稿合入 main 后,T1-T3 实施 PR 按 §8 队列在 process §3/§4 流程内连续推进(goal 模式,process §7.1)。

---

## 0. TL;DR

1. **schema(T1)**:`SmsPurpose` 枚举新增 `PASSWORD_RESET` 单值(单行 migration;无新表、无新字段、无新索引)。
2. **端点(T2)**:2 个,均落 `auth/v1` surface、`@Public()` + `@PasswordResetThrottle()`(IP 3/60s,新命名 throttler 实例物理隔离)、summary 带 `[public]` 后缀;contract `EXPECTED_ROUTES` 155→157。
3. **防枚举(本功能安全核心,§4)**:号码「不存在 / 未绑定 / 被禁用 / 已软删」四种无效场景下 send-code 返回**完全相同**的泛化 200(不发码、不写 `sms_verification_codes` / `sms_send_logs`);reset 一切失败(码错 / 过期 / 超次 / 号码无效)统一 `SMS_CODE_INVALID=24010`;**零新增可区分账号存在性的错误码**;e2e 四场景响应体一致性断言锁定。
4. **有效号发码走既有通道**:同号 ≥60s 间隔 + 同号自然日 10 条(**全用途合计**,SMS 评审稿 §4 既有 DB 层防刷天然生效)+ 本期新增 IP 3/60s throttler;message 不暴露阈值。
5. **重置后效(§5)**:同一事务内 更新 `passwordHash` + `updateMany` 撤销该用户全部未撤销未过期 refresh token(`revokedReason='self-password-reset'`,联动撤销**第 5 场景**)+ audit `password.reset.by-sms`(actor=本人,`extra.refreshTokensRevoked` 计数,手机号一律掩码);access token 沿 D-4 **不**吊销。
6. **10006 不烧码**:新密码 bcrypt 比对旧 hash 相同 → 抛 `NEW_PASSWORD_SAME_AS_OLD=10006`,**不消费验证码**(可换密码用同码重试);该检查必须发生在验证码有效性确认**之后**(防密码 oracle,E-5)。
7. **零新增 BizCode / 零新增权限码**:全部复用 24010 / 10006 / 24120 / 24121 / 24030 / 24031 / 42900 / 40000。
8. **AGENTS §9 红区最小加行**:「联动撤销四场景」全部措辞更新为**五场景**并补 `'self-password-reset'` 行(随 T2 实施 PR,PR 描述逐行列 before/after,沿 #294 范式;goal 已授权,红区例外仅此一处)。
9. **行为锁**:AGENTS:242 登录契约不动(本功能不是登录)/ P0-E refresh 行为冻结 / 「改密后旧 access 仍可用」反向锁定断言不破 / auth 既有 e2e(login / refresh / logout / 改密)**断言零修改**全绿;`auth.service.ts` 与 `users.service.ts` 目标 **零 diff**(E-1)。
10. **队列**:T0(本稿,A 档)→ T1(enum migration,D 档)→ T2(实施,C/D 档)→ T3(docs 收尾 + 终验,A 档);顺序硬约束,探针驱动(§8)。

---

## 1. 决策汇总表

### 1.1 维护者拍板项(2026-06-11,goal 原文为凭据)

| # | 决策 | 内容 |
|---|---|---|
| D-PR-1 | 范围与形态 | pre-auth 找回密码 = 两端点(send-code + reset),落 `auth/v1` surface;**非**三步式票据(无 reset ticket 中间态),**不**自动登录(reset 成功不返 token,客户端引导重新登录);`SmsPurpose` 仅扩 `PASSWORD_RESET` 一值;DevStub 先行全验,真实短信仍只卡腾讯云审核(运维接力不变,无新增运维作业) |
| D-PR-2 | 防枚举设计 | 四种无效号码场景 send-code 返回**完全相同**泛化 200(不发码、不留痕);reset 一切失败统一 24010;零新增可区分账号存在性的错误码;全部以 e2e 一致性断言锁定(§4) |
| D-PR-3 | 重置后效 | 同事务:`passwordHash` 更新 + 全量 refresh 撤销(`revokedReason='self-password-reset'`,第 5 场景)+ audit `password.reset.by-sms`(actor=本人,extra.refreshTokensRevoked,手机号掩码);10006 不消费验证码;`newPassword` 校验镜像 `ChangeMyPasswordDto`;access 沿 D-4 不吊销;**AGENTS §9 红区行授权**(四场景→五场景 + 新场景行,随实施 PR) |
| D-PR-4 | 防刷与限流 | 两端点均 `@PasswordResetThrottle()`(IP 3/60s,**新命名实例**物理隔离,message 不暴露阈值);同号 60s 间隔 + 日 10 条**全用途合计**沿既有 DB 层防刷天然生效;图形验证码本期不做,重启条件成文(§9) |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 决策 | 内容与依据 |
|---|---|---|
| E-1 | 文件归属 | 新建 [`src/modules/auth/password-reset.service.ts`](../../../src/modules/auth/password-reset.service.ts)(auth 模块平铺新文件,沿 `refresh-token.util.ts` 先例);端点挂入既有 `AuthController`(同 tag `Auth`,不新建 controller、不形成 Mixed Controller);DTO 追加进 `auth.dto.ts`。**`auth.service.ts` 与 `users.service.ts` 零 diff**——P0-E 冻结与改密行为以"文件未触碰"为最强证据 |
| E-2 | 用户解析口径 | `findFirst({ where: { phone } })`(**不**经 `notDeletedWhere`,需识别软删行)后判 `deletedAt === null && status === ACTIVE` 才算有效;四种无效场景 = 无匹配行(覆盖「不存在」「未绑定/已被 admin 清除」)/ 行 `status=DISABLED` / 行 `deletedAt != null` |
| E-3 | send-code 无效号响应 | 与有效号**同形状同值**常量 `{ expiresInSeconds: 300 }`(300 = `SMS_CODE_TTL_SECONDS`);不写 codes / send_logs、不调 provider、不写 audit;响应体逐字节一致由 e2e 断言 |
| E-4 | 有效号限频照常抛 | 24120 / 24121 / 24030 / 24031 仅对有效号可达(无效号在解析层短路返 200)。由此存在「重复请求同号观察 24120 与否」的残余 oracle,**接受**:IP 3/60s 使探测代价高 + 内部管理系统号码集合封闭 + 真实通道开通前无实币损失;详 §2 R-1 |
| E-5 | reset 校验顺序(冻结) | ① 解析用户(无效 → 24010)→ ② 码预检 `assertValid`(不消费;错码 `attempts+1` 后抛 24010)→ ③ 10006 检查(`bcrypt.compare(newPassword, passwordHash)` 相同 → 抛,不消费、不计 attempts)→ ④ `verifyAndConsume` 原子消费(并发重放单赢家)→ ⑤ 事务(改密 + 撤销 + audit)。**③ 必须在 ② 之后**:10006 是"新密码=当前密码"oracle,只允许对已证明持有有效验证码(即手机号控制权)者可达 |
| E-6 | SmsCodeService 改造 | 新增 `assertValid()`(只验不消费,错码计数独立提交语义与 `verifyAndConsume` 一致);校验链抽私有 helper 供两方法复用,**`verifyAndConsume` 行为零漂移**(既有 unit spec 断言零修改全绿为证);不为 `PASSWORD_RESET` 单独调验证码参数(6 位 / 5min / 单活码 / 错 5 次作废 / 成功即消费全沿用) |
| E-7 | 码归属 | `issue` 时 `userId` = 按 phone 解析出的目标用户 id(非当前登录用户;本流程 pre-auth 无登录态);`verifyAndConsume` / `assertValid` 时归属不符 → 24010(沿 SMS 评审稿 E-8 统一码);发码与重置之间号码被换绑 → 归属不符自然拒绝 |
| E-8 | DTO | `SendPasswordResetCodeDto { phone }` / `ResetPasswordBySmsDto { phone, code, newPassword }`;phone 沿 `MAINLAND_PHONE_PATTERN`(SMS 评审稿 E-17),code 沿 6 位数字校验(镜像 `BindMyPhoneDto.code`),`newPassword` **镜像 `ChangeMyPasswordDto.newPassword`**(`@MinLength(8)` + `@MaxLength(128)` + 字母数字 `@Matches`);严格白名单,禁夹带 `username` / `oldPassword` 等任何其他字段;格式校验失败走全局 ValidationPipe 400(格式错误不构成存在性泄露) |
| E-9 | 响应形状 | send-code → `{ expiresInSeconds: number }`(复用形状,auth 模块独立定义 DTO,不跨模块 import users App DTO,沿 D-6 隔离精神);reset 成功 → `data: null`(**不**返 token、不返用户任何字段) |
| E-10 | throttler | 新命名实例 `password-reset`(第 6 实例)+ 装饰器 `@PasswordResetThrottle()`(纯 metadata,limit/ttl 从 `app.config.ts` 注入 `PASSWORD_RESET_THROTTLE_LIMIT/TTL_SECONDS`,默认 3/60s);`throttler-biz.guard.ts` 沿 SMS T3 **同型扩展**(红区文件,本行即拍板覆盖凭据,diff 仅第 6 实例加行);两端点共用同名实例(throttler 计数按 端点×IP 维度);`.env.example` 加注释行;`setHeaders: false` 沿用 |
| E-11 | audit 形状 | `password.reset.by-sms`:`actorUserId` = 目标用户 id(actor=本人;pre-auth 下 actor 即被重置账号本人)/ `actorRoleSnap` = 该用户 role / `resourceType='user'` / `resourceId` = 同 id / `meta` 沿 controller `buildAuditMeta(req)` 显式传(不引 AsyncLocalStorage)/ `extra = { refreshTokensRevoked: count, phone: 掩码, codeId }`;**禁**写明文码 / codeHash / 完整号码 / 新旧密码任何形态;send-code **不**写 audit(发送留痕已有 `sms_send_logs`,E-17 同 SMS 评审稿) |
| E-12 | 撤销 where 口径 | 镜像 `changeMyPassword`:`{ userId, revokedAt: null, expiresAt: { gt: now } }`(goal「全部未撤销」语义按既有四场景实现口径 = 未撤销且未过期;已过期 token 本就不可用,不补写) |
| E-13 | Swagger | tag 沿 `Auth`;两 summary 带 `[public]` 后缀(检查项 G 口径);`@ApiBizErrorResponse` 枚举各自可达错误码;OpenAPI 示例不含真实可用验证码语义(固定 example 串) |
| E-14 | e2e | 新组单文件 [`test/e2e/auth-password-reset.e2e-spec.ts`](../../../test/e2e/auth-password-reset.e2e-spec.ts);DevStub 固定码 888888 驱动正向链路;过期 / 作废 / 归属场景直改 DB 行(沿 SMS 评审稿 §10 范式);限流场景注意 throttler 计数隔离(用例排布避免互相吃配额) |
| E-15 | schema 注释 true-up | `SmsPurpose.PHONE_BIND` 行注释「本期唯一 purpose」随 T1 改为两 purpose 现状;`sms_verification_codes.userId` 注释补 PASSWORD_RESET 归属语义;User 模型零触碰 |
| E-16 | 派生层顺手校准 | T2 顺手校准 [`src/modules/auth/CLAUDE.md`](../../../src/modules/auth/CLAUDE.md)(scope + 端点 + throttler + audit 事件 + 不变式;process §6 模块 CLAUDE.md 例外);根 `CODEMAP.md` auth 行、`docs/ai-harness/README.md` 与 `srvf-auth-security` skill 中「四场景」字样的 true-up 归 T3(derived 层让步条款);`docs/security.md` 如有同主题行一并 T3 true-up |
| E-17 | 重置后会话语义 | 旧 access token 沿 D-4 **不**吊销(≤15m 自然过期;e2e 补正向断言:reset 后旧 access 仍可调 `/me`,与改密 §7.5 反向锁定对称);全部 refresh 撤销后旧 refresh 统一 `REFRESH_TOKEN_INVALID=10007`;**不**提供"踢所有设备并强制下线 access"能力(tokenVersion 沿 AGENTS §9 不做) |
| E-18 | 发码成功语义 | 有效号走 `SmsCodeService.issue` 原样(间隔 → 日限 → 通道 → 单活码 → 发送 → 落日志);`PASSWORD_RESET` 与 `PHONE_BIND` 单活码互不作废(单活码按 phone+purpose 维度,SMS 评审稿 E-9),但 60s 间隔与日 10 条跨 purpose 合计(同稿 §4) |

---

## 2. 风险表

| # | 风险 | 影响 | 缓解 | 残余 |
|---|---|---|---|---|
| R-1 | **防枚举侧信道**:send-code 对有效号可能抛 24120/24121(无效号恒 200),且有效号路径含 provider 调用,耗时分布与无效号不同(timing oracle) | 攻击者以时间差 / 重复请求差异推断号码是否绑定账号 | 响应体四场景逐字节一致(主信道关死);IP 3/60s 新实例(重复采样代价高);同号 60s 间隔(放大探测周期);内部管理系统号码集合封闭、无公开注册面;DevStub 阶段无真实网络耗时差 | timing 差异为 ms 级 DB 查询(无 bcrypt 级慢操作),网络抖动内;接受并成文。真实通道开通后若出现实测探测证据 → §9 图形码重启条件 ① |
| R-2 | **验证码即账号凭据**:持有手机号控制权即可重置密码(SIM 劫持 / 验证码转发诈骗场景) | 账号被接管 | 6 位 CSPRNG / 5min TTL / 错 5 次作废 / 单活码 / 成功即消费(SMS 评审稿 D-SMS-5 全沿用);重置即撤销全部 refresh(第 5 场景)+ audit 留痕(掩码);audit `password.reset.by-sms` 可作为接管取证锚点 | 手机号信道本身的风险(运营商侧)系统外;与业界短信找回密码基线一致,接受 |
| R-3 | **费用滥用**(对有效号轰炸发码) | 资费损失 | 既有三层防刷全用途合计天然生效 + 本期 IP 3/60s(严于绑定流 5/60s);无效号不发码(零成本) | 大规模分布式盗刷 → §9 图形码重启条件 ②;腾讯云套餐告警兜底(运维侧已有 SOP) |
| R-4 | **红区触碰**:AGENTS §9(红区文档)与 `throttler-biz.guard.ts`(红区代码)各一处 | 改错冻结行为 | AGENTS §9 仅「四场景→五场景措辞 + 新场景行」最小加行,PR 描述逐行 before/after(#294 范式);guard 仅第 6 实例同型加行(SMS T3 先例);auth 既有 e2e 断言零修改全绿为行为锁 | goal 拍板覆盖,无未授权红区残留 |
| R-5 | **migration 不可逆**(enum 值一经合入不回改) | enum 值废弃成本高 | 单值单行 `ALTER TYPE ... ADD VALUE`;T1 干净库 `prisma:deploy` 全量重放 + seed 幂等二跑;PR 描述贴 SQL 全文;`srvf-prisma-change` 全流程 | 后悔路径 = 值闲置不删(Postgres enum 删值需重建类型,本就禁止);可接受 |

---

## 3. 五张清单

### 3.1 schema 清单(T1 落地;仅此一行)

| 对象 | 变更 | migration SQL(预期) |
|---|---|---|
| `enum SmsPurpose` | 新增值 `PASSWORD_RESET`(置于 `PHONE_BIND` 之后) | `ALTER TYPE "SmsPurpose" ADD VALUE 'PASSWORD_RESET';` |

无新表 / 无新字段 / 无新索引 / 无 seed 变更(零新增权限码);`User` / `sms_verification_codes` / `sms_send_logs` 结构零触碰(仅注释 true-up,E-15)。

### 3.2 端点清单(2 个;T2 落地)

| # | Method | Path | 鉴权(summary 后缀) | 入参 DTO | 出参 | 说明 |
|---|---|---|---|---|---|---|
| ① | POST | `/api/auth/v1/password-reset/send-code` | `[public]` + `@PasswordResetThrottle()` | `SendPasswordResetCodeDto { phone }` | `{ expiresInSeconds }` | 解析用户:四种无效场景**同泛化 200**(不发码不留痕,E-2/E-3);有效 → `issue(purpose=PASSWORD_RESET, userId=目标用户)`,限频 / 通道错误照常抛(E-4) |
| ② | POST | `/api/auth/v1/password-reset` | `[public]` + `@PasswordResetThrottle()` | `ResetPasswordBySmsDto { phone, code, newPassword }` | `data: null` | 校验顺序冻结 E-5;一切失败统一 24010(10006 例外:仅对已验码者可达);成功 = 事务内 改密 + 第 5 场景撤销 + audit |
| | | | | | | contract `EXPECTED_ROUTES` 155→**157**;snapshot diff 纯新增、零删除、零 L3 字样 |

### 3.3 错误码清单(**零新增**;全部复用)

| 场景 | 复用码 | 说明 |
|---|---|---|
| reset:码错 / 过期 / 超次 / 已消费 / 已作废 / 归属不符 / **号码无效(四场景)** | `SMS_CODE_INVALID=24010`(400) | 统一防枚举,禁止细分;响应体逐字节一致 |
| reset:新密码与旧密码相同 | `NEW_PASSWORD_SAME_AS_OLD=10006`(400) | **不消费验证码**;仅持有效码者可达(E-5) |
| send-code:同号 <60s / 日 10 条 | `SMS_SEND_INTERVAL_LIMIT=24120` / `SMS_PHONE_DAILY_LIMIT=24121`(429) | 仅有效号可达(E-4) |
| send-code:通道未配置 / 发送失败 | `SMS_CHANNEL_NOT_CONFIGURED=24030` / `SMS_SEND_FAILED=24031` | 仅有效号可达 |
| IP throttle 命中 | `TOO_MANY_REQUESTS=42900`(429) | 新实例 `password-reset`,message 不暴露阈值 |
| DTO 格式错误 | `BAD_REQUEST=40000`(400) | 全局 ValidationPipe;格式错误无存在性信息 |

**不开的码**:`PHONE_NOT_REGISTERED` / `ACCOUNT_DISABLED` / `RESET_CODE_*` 任何细分(本功能安全核心即"零新增可区分账号存在性的错误码")。

### 3.4 审计事件清单(AuditLogEvent +1;T2 落地)

| 事件 | 写入点 | actor / resource | extra |
|---|---|---|---|
| `password.reset.by-sms` | `password-reset.service` 重置成功事务内(唯一写入点) | actor = 本人(目标用户 id + role snap)/ `user` / 目标用户 id | `{ refreshTokensRevoked: count, phone: 掩码(maskPhone), codeId }`;禁明文码 / codeHash / 完整号码 / 密码任何形态 |

命名沿 `password.change.self` / `password.reset.by-admin` kebab-case 对称范式;send-code 不写 audit(E-11)。

### 3.5 throttler 清单(+1,共 6 实例)

| 实例 | 装饰器 | 阈值(默认) | 挂载端点 |
|---|---|---|---|
| `password-reset`(新) | `@PasswordResetThrottle()` | IP 3 次 / 60s(`PASSWORD_RESET_THROTTLE_LIMIT/TTL_SECONDS`) | 本期两端点(计数按 端点×IP) |

与既有 `default` / `password-change` / `refresh` / `sms-send` / `sms-verify` 物理隔离;既有五实例配置零触碰。

---

## 4. 防枚举设计(D-PR-2 展开;本功能安全核心)

- **send-code 四种无效场景**(E-2):① 号码从未绑定任何账号;② 号码曾绑定但已被 admin 清除(DB 视图同 ①,e2e 独立场景验证);③ 号码绑定的账号 `status=DISABLED`;④ 号码绑定的账号已软删(`deletedAt != null`,phone 随软删行保留占用)。四者一律返回与有效号成功发码**完全相同**的 `{ code: 0, message: 'ok', data: { expiresInSeconds: 300 } }`,且:**不**创建 `sms_verification_codes` 行、**不**写 `sms_send_logs`、**不**调 provider、**不**写 audit(零侧写痕迹,e2e 以 DB 计数断言锁定)。
- **reset 统一 24010**:号码无效(同四场景)/ 码不存在 / 已过期 / attempts≥5 / 已消费 / 已作废 / 码值不符 / 归属不符 → 全部 `SMS_CODE_INVALID=24010`,响应体逐字节一致(e2e 一致性断言);错码路径仍执行 `attempts+1`(防爆破语义不因防枚举而弱化)。
- **10006 的可达性边界**(E-5):`NEW_PASSWORD_SAME_AS_OLD` 仅在验证码预检通过后可达——未持有效码者永远拿不到 10006,故其不构成存在性或密码 oracle;持有效码者已拥有手机号控制权,语义上即本人。
- **DTO 格式 400**:phone 非 11 位等格式错误走全局 ValidationPipe,无存在性信息(任何 phone 值同样校验)。
- **e2e 断言计划**(DoD-4):四场景响应体两两 deep-equal + 与有效号响应同形状;四场景后 DB `sms_verification_codes` / `sms_send_logs` 按 phone 计数为 0;reset 各失败场景响应体一致(均 24010 同 message)。
- **残余侧信道与接受理由**:见 §2 R-1(限频差异 + timing;主信道关死、采样代价高、号码集合封闭、DevStub 阶段零实币)。

## 5. 重置后效与第 5 联动撤销场景(D-PR-3 展开)

- **事务原子三件套**(镜像 `changeMyPassword`,[`users.service.ts:246`](../../../src/modules/users/users.service.ts) 范式):`tx.user.update({ passwordHash })` + `tx.refreshToken.updateMany({ where: { userId, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now, revokedReason: 'self-password-reset' } })` + `auditLogs.log({ ..., tx })`。
- **会话后效**:全部 refresh 即时失效(旧 refresh → 10007);旧 access 沿 D-4 不吊销,≤15m 自然过期(e2e 正向断言对称改密 §7.5 反向锁定,E-17);用户须以新密码重新登录。
- **AGENTS §9 红区行(随 T2 实施 PR,逐行 before/after 进 PR 描述)**:
  - `AGENTS.md` §9 主条目 3 处「联动撤销四场景」→「联动撤销五场景」(本人改密行 / 管理员重置行 / 禁用与软删行);
  - §9 P0-E 子节「**联动撤销四场景**(…):本人改密 → `'self-password-change'` / 管理员重置 → `'admin-password-reset'` / 用户禁用 → `'admin-disable'` / 用户软删 → `'admin-delete'`」→ 五场景 + 追加「本人短信重置 → `'self-password-reset'`」;
  - **不**触碰 §8「登录失败防账号枚举四场景」(另一主题,零关系);AGENTS 其余零触碰。
- **`revokedReason` 取值全集(after)**:`'logout'` / `'family-revoked'` / `'self-password-change'` / `'admin-password-reset'` / `'admin-disable'` / `'admin-delete'` / **`'self-password-reset'`**(新)。

## 6. 既有行为锁(goal §0 行为铁律展开)

- 登录入参仍仅 `username + password`(AGENTS:242 原文零触碰;本功能不是登录,reset 成功不返 token,D-PR-1)。
- P0-E refresh 全部行为冻结;`JwtPayload` / `JwtStrategy` / `LoginDto` / `LoginResponseDto` / refresh 系 DTO 零触碰;`auth.service.ts` 零 diff(E-1)。
- auth 既有 e2e(`auth-login` / `auth-refresh-token` / logout 系 / `users-change-my-password`)**断言零修改**全绿(DoD-6);「改密后旧 access 仍可用」§7.5 反向锁定断言不破。
- 既有六分之五 throttler 实例配置零触碰;SMS 既有端点(`me/phone` 系)与 `PHONE_BIND` 流程行为零变化(`verifyAndConsume` 行为零漂移由既有 unit spec 锁定,E-6)。
- 既有 `EXPECTED_ROUTES` 155 行零删除;snapshot diff 纯新增。

## 7. 测试计划(DoD-4/6 展开)

- **e2e 新组** `auth-password-reset.e2e-spec.ts`(E-14):
  1. **防枚举四场景一致性**:四无效场景 send-code 响应体两两相等 + DB 零留痕;reset 各失败场景统一 24010 响应体一致;
  2. **全链成功**:绑定号发码(DevStub 888888)→ reset → 旧密码登录 10004 → 新密码登录成功 → 旧 refresh 全部 10007(并断言 DB `revokedReason='self-password-reset'` + audit 行存在且 phone 掩码)→ 旧 access 仍可调 `/me`(E-17);
  3. **码错 5 次作废**:错码 ×5 各 24010,第 6 次用正确码仍 24010;
  4. **过期**:直改 DB `expiresAt` → 24010;
  5. **重用**:成功 reset 后同码再用 → 24010;
  6. **10006 不烧码**:同码先撞 10006 再换新密码成功(同一验证码);
  7. **限流**:IP 3/60s 第 4 次 42900(两端点各自计数);
  8. 附:`PHONE_BIND` 码不能用于 `PASSWORD_RESET`(purpose 隔离)、发码 60s 间隔跨 purpose 合计(E-18)。
- **unit**:`sms-code.service.spec.ts` 既有断言零修改 + 新增 `assertValid` 分支(有效不消费 / 错码计数 / 过期 / 作废 / 归属)与 `PASSWORD_RESET` purpose 用例。
- **横切回归**:auth 全组 + `response-format` / `bizcode-http-status` / `request-id`;contract `EXPECTED_ROUTES` +2 显式登记,snapshot diff 逐行可解释(纯新增、零 L3 字样)。

## 8. 任务队列与探针(顺序硬约束;goal §3 原文固化)

| 队列 | 档位 | 范围 | 探针(未满足才做) |
|---|---|---|---|
| T0 | A | 本稿冻结 + NEXT_TASKS P1-7 ① 标立项 | 评审稿在 main |
| T1 | D | §3.1(仅 schema/migration,PR 描述贴 SQL;`prisma migrate` 仅限本地生成 migration,已拍板免简报) | migration 在 main + 干净库重放记录 |
| T2 | C/D | 两端点 + `@PasswordResetThrottle()` + `SmsCodeService` 接线(E-6)+ 第 5 撤销场景 + audit + AGENTS §9 红区行 + auth CLAUDE.md 校准 + e2e 组 + unit + contract 同步 | DoD-3/4/5/6 |
| T3 | A | CHANGELOG Unreleased(C/D 段)+ current-state §2/§4 + NEXT_TASKS ① ✅ 归档 + 派生层四→五场景 true-up(E-16)→ 全部探针 → 终版报告(含「本次未做」与运维侧无新增作业说明) | DoD-7 |

LOOP 纪律沿 process §7.1:同一失败修复 ≤2 轮;连续 2 轮零推进熔断;`agent:check:full`(本机 Docker 可用时,否则 quick + CI 并显式声明);每 PR 合并沿 process §5.4 八条;明文码 / 凭证三不(日志 · 响应 · snapshot)。

## 9. 图形验证码重启条件(D-PR-4 成文;命中任一 → 单独立项评审,均 D 档)

1. 真实通道开通后,`sms_send_logs` 出现异常放量(单日条数显著超活跃用户基数)或腾讯云费用 / 条数告警触发;
2. 实测出现分布式 IP 池逐号探测 / 防刷三层被绕过的证据(R-1 残余 oracle 被武器化);
3. 业务面出现公开注册 / 自助拉新等开放场景(当前为内部管理系统,号码集合封闭的前提失效);
4. OTP 登录立项(pre-auth 发码面扩大,需与 AGENTS:242 解锁评审一并设计)。

届时候选:行为/图形验证码前置 send-code、风控计分、号段黑名单;本期一律不做(goal 禁止域)。

## 10. 本期不做(终版报告必列)

- ❌ 三步式票据(verify 后发 reset ticket 再改密)——两步式(码 + 新密码单请求)已满足且面更小
- ❌ 重置成功自动登录 / 返 token(客户端引导重新登录)
- ❌ 图形验证码 / 风控(重启条件 §9)
- ❌ OTP / 验证码登录(动 AGENTS:242,需先红区行评审解锁;仍挂 NEXT_TASKS P1-7 ②)
- ❌ 通知用途短信(P1-7 ③)/ 新模板 / templateKey 扩展
- ❌ 新 BizCode / 新权限码 / repository 层 / cron · retention(沿 NEXT_TASKS P2-6)
- ❌ email 找回 / 安全问题找回 / 管理员代发找回链接
- ❌ 改密流程加验证码(P1-7 原「改密加验」诉求,未拍板不做)
- ❌ 真实腾讯云凭证录入与真实发送验收(运维接力不变:[`docs/ops/sms-production-rollout-checklist.md`](../../ops/sms-production-rollout-checklist.md);本功能 DevStub 已全验,真实短信仍只卡腾讯云审核一件事)
