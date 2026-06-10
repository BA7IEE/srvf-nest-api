# SRVF 手机号验证码基础设施评审稿(SMS Verification Infra Review)

> **状态**:**实施前评审稿(冻结文本)**(2026-06-10)
> **性质**:**D 档拍板记录 + implementation review**(沿 [`docs/process.md §4 / §7.1`](../../process.md))。维护者已于 2026-06-10 经 12 问逐项拍板,工程细节授权代决;goal 文本 = 立项 + 拍板凭据,本稿把 goal §0-§2 共识成文并冻结。**实施中任何偏离本稿的决定 → 人话简报(process §4.1)停下等回复,不得自行调整。**
> **范围**:通道层(`src/modules/sms/` + DevStub / 腾讯云双 Provider)+ 验证码服务(签发 / 校验 / 防刷)+ 手机号绑定(App 自助绑定 / 换绑 + Admin 清除)。purpose 本期仅 `PHONE_BIND`。
> **不在范围**:找回密码 / OTP 登录 / 通知用途 / pre-auth 发码 / 图形验证码 / repository 层 / cron 清理(详 §12)。
> **前置必读**:[`AGENTS.md §2/§3/§5/§8/§9/§10/§18.4`](../../../AGENTS.md) / [`docs/api-surface-policy.md §0`](../../api-surface-policy.md) / [`docs/srvf-foundation-baseline.md §1.1/§1.3`](../../srvf-foundation-baseline.md) / `srvf-prisma-change`、`srvf-auth-security`、`srvf-api-surface` skills。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线(沿 process §6);但在"本期 SMS 范围内的具体设计取舍"上,本稿即冻结决议。
> **解除条件**:本稿合入 main 后,T1-T4 实施 PR 按 §11 队列在 process §3/§4 流程内连续推进(goal 模式,process §7.1)。

---

## 0. TL;DR

1. **schema(T1)**:`User` +`phone String? @unique` +`phoneVerifiedAt DateTime?`;新表 `sms_settings`(镜像 `StorageSettings`)、`sms_verification_codes`、`sms_send_logs`;两个新 enum `SmsProviderType { DEV_STUB, TENCENT_SMS }` / `SmsPurpose { PHONE_BIND }` / `SmsSendStatus { SENT, FAILED }`。仅 schema/migration,不带业务代码。
2. **端点(T2+T3)**:7 个,全带 P2-2 鉴权后缀;System 面 4 个(sms-settings GET/PATCH/POST reset-credentials + sms-send-logs GET),App 面 2 个(me/phone/send-code POST + me/phone PUT),Admin 面 1 个(users/:id/phone DELETE)。**设置端点动词镜像 storage-settings 现状 = GET / PATCH / POST**(见 E-1)。
3. **权限码**:+5(`sms-setting.read.singleton` / `sms-setting.update.singleton` / `sms-setting.reset.credentials` / `sms-send-log.read.list` / `user.phone.clear`),76→81;ops-admin 绑 4 条(reset.credentials 不绑,镜像 storage D2=A,仅 SUPER_ADMIN 短路)。
4. **验证码语义**:6 位纯数字 / TTL 5 分钟 / 同 phone+purpose 单活码(新发自动 superseded)/ 错 5 次作废 / 验证成功即消费 / **明文码永不入库·不入日志·不入响应**(DevStub 例外:非 production 固定码 `888888` + debug 日志)。
5. **防刷三层**:同号 ≥60s 间隔 + 同号自然日 10 条(DB 判断,常量)+ IP throttler(send-code 5/60s、verify 10/60s,两个新命名实例物理隔离);message 不暴露阈值。
6. **BizCode 新开 24xxx 段**(6 个码,号位见 §3.3);baseline §1.1 段位表加行(红区,goal 已授权,随 T3 PR 落地,PR 描述逐行列出,沿 #294 范式)。
7. **安全**:`SMS_ENCRYPTION_KEY` 独立 env(production/smoke fail-fast,沿 STORAGE 范式);production 禁 `providerType=DEV_STUB`(写入校验 + 运行时双重);凭证 AES-256-GCM 加密(sms-crypto 沿 storage-crypto 范式);SDK 仅 `tencentcloud-sdk-nodejs-sms` 一个、锁精确版本。
8. **审计**:3 个新 `AuditLogEvent`:`phone.bind.self` / `phone.rebind.self` / `phone.clear.by-admin`;detail 中手机号一律掩码 `138****1234`;SmsSettings 变更审计沿 L-3 挂起不做。
9. **行为锁**:登录入参仍仅 username+password(AGENTS:242 不动)/ JWT payload zero drift / P0-E refresh 行为冻结 / auth-* 全组 e2e 原断言零改动全绿;**本期零触碰 `userSafeSelect` / `UserResponseDto` / App me 既有 DTO 字段集**(见 E-6)。
10. **队列**:T0(本稿,A 档)→ T1(schema,D 档)→ T2(通道层,D 档)→ T3(验证码与绑定,C/D 档)→ T4(docs 收尾 + 终验,A 档);顺序硬约束,探针驱动(§11)。

---

## 1. 决策汇总表

### 1.1 维护者拍板项(2026-06-10,goal 原文为凭据)

| # | 决策 | 内容 |
|---|---|---|
| D-SMS-1 | 范围 | 通道层 + 验证码服务 + 手机号绑定;purpose 仅 `PHONE_BIND`;三个消费者(找回密码 / OTP 登录 / 通知)全部不做,挂 NEXT_TASKS |
| D-SMS-2 | schema | User +2 字段;三新表字段集如 §3.1(一次设计,允许部分字段首期闲置,严禁未来推翻 schema,沿 StorageSettings 范式) |
| D-SMS-3 | 端点 | 7 个(§3.2);sms-settings 路径动词镜像 storage-settings 现状;凭证重置仅 SUPER_ADMIN 短路 |
| D-SMS-4 | 权限码 | 5 条新码,76→81;RBAC_MAP 同步,`docs:rbacmap:check` 0 FAIL |
| D-SMS-5 | 验证码语义 | 6 位纯数字 / TTL 5min / 单活码 / 错 5 次作废 / 成功即消费 / 明文三不(不入库·不入日志·不入响应);DevStub 例外:非 production 固定码 888888 + debug 日志 |
| D-SMS-6 | 防刷 | 三层:同号 ≥60s + 同号自然日 10 条(DB 判断,常量)+ IP throttler(send 5/60s / verify 10/60s,命名实例物理隔离);message 不暴露阈值 |
| D-SMS-7 | BizCode | 新段 24xxx;baseline §1.1 加行(红区例外,本 goal 唯一授权;AGENTS.md 零触碰) |
| D-SMS-8 | 安全 | `SMS_ENCRYPTION_KEY` 独立 env,production/smoke fail-fast;.env.example + docker-smoke workflow 各加一行(workflow 改动属已拍板范围);production 禁 DEV_STUB |
| D-SMS-9 | 审计 | 3 个新 AuditLogEvent(§3.5),手机号一律掩码;SmsSettings 变更审计沿 L-3 挂起 |
| D-SMS-10 | 依赖 | SDK 仅 `tencentcloud-sdk-nodejs-sms` 一个,锁版本(D 档已拍板) |
| D-SMS-11 | 行为铁律 | AGENTS:242 登录入参不动 / JWT payload zero drift / P0-E refresh 冻结 / 零触碰既有 auth 行为 / 禁删改既有测试断言 |
| D-SMS-12 | 模块与队列 | 模块位置 `src/modules/sms/`(平铺)+ providers/ 子目录例外解锁(§5);T0→T4 顺序硬约束;migration / 权限码 seed / SDK / docker-smoke env / 3 AuditLogEvent 均已拍板,队列内免二次确认 |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 决策 | 内容与依据 |
|---|---|---|
| E-1 | 设置端点动词 = **GET / PATCH / POST reset-credentials** | goal 文本"GET/PUT"为读/写简记,同句括号"**路径动词镜像 storage-settings 现状**"为准;现状 = [`storage-settings.controller.ts:39/50/64`](../../../src/common/storage/storage-settings.controller.ts)(GET / PATCH / POST reset-credentials) |
| E-2 | BizCode 号位 | 按 baseline §1.3 内部细分:24002 / 24010 / 24030 / 24031 / 24120 / 24121(详 §3.3) |
| E-3 | ops-admin 绑定矩阵 | +4 条(read/update singleton + send-log.read.list + user.phone.clear);`sms-setting.reset.credentials` **不绑**(镜像 storage D2=A);ops-admin 54→58 |
| E-4 | 判权模式 | System/Admin 面 5 端点全 R 模式(入口仅 JwtAuthGuard,Service 内 `rbac.can()`,失败 30100;镜像 storage-settings / users 域范式;RBAC_MAP §6 规则 4);App 面 2 端点仅 JwtAuthGuard;admin 清号再走 `assertCanManageUser` 既有护栏 |
| E-5 | App 准入豁免 | me/phone 两端点沿 `PUT /me/password` 账号级豁免先例(P2-3 评审稿 §4),**不**强约 `canUseApp=true`:User.phone 是账号级身份字段,服务找回密码等 pre-auth 类消费者,Admin 无 member 也需绑定;安全由登录态 + 验证码 + 三层防刷 + audit 闭合。豁免仅限本期两端点,禁止外溢到其他 App 端点 |
| E-6 | 既有 DTO 零触碰 | **不**改 `userSafeSelect` / `UserResponseDto` / App me 既有 DTO:既有 e2e 以 `EXPECTED_USER_RESPONSE_KEYS`([users-admin-crud.e2e-spec.ts:23](../../../test/e2e/users-admin-crud.e2e-spec.ts))/ `APP_ME_KEYS` / `APP_ME_ACCOUNT_KEYS` 锁死字段集,goal 禁止域禁删改既有断言。phone 字段仅经新端点专用 DTO 暴露;admin 清号返回 `UserResponseDto`(字段集不变);"查询当前绑定手机号"读路径留首个消费者立项(§12) |
| E-7 | 占用语义 | `User.phone @unique` 全局唯一,**含软删占用**(沿 AGENTS §10 username/email 不复用范式;预检查用 `findUnique` 含软删);send-code 时目标号已被任何账号(含本人)占用 → 24002;绑定落库时复查 + P2002 捕获转 24002 |
| E-8 | 码归属 | `PHONE_BIND` 码签发时记 `userId`(当前用户);校验时 `userId !== currentUser.id` → 视作无效(24010 统一码,防枚举不细分) |
| E-9 | 单活码实现 | 签发事务内 `updateMany({ where: { phone, purpose, consumedAt: null, supersededAt: null }, data: { supersededAt: now } })` 后 create 新码 |
| E-10 | 自然日口径 | 按 Asia/Shanghai 固定 UTC+8 计算日界(常量 `SMS_DAILY_WINDOW_UTC_OFFSET_HOURS = 8`,不引 tz 依赖;大陆手机号场景) |
| E-11 | 日限计数口径 | 按 `sms_verification_codes` 当日创建行数(含发送失败行,保守防滥用;不按 send_logs SENT) |
| E-12 | 发送失败处理 | provider 失败:已建 code 行**保留**(参与间隔/日限计数),`sms_send_logs` 记 FAILED(errCode/errMsg),抛 24031;不回滚、不重试 |
| E-13 | sms-crypto | 镜像 [`storage-crypto.service.ts`](../../../src/common/storage/storage-crypto.service.ts):AES-256-GCM + `scrypt(SMS_ENCRYPTION_KEY, 独立固定 salt, 32)`;序列化 `base64(iv:12B ‖ authTag:16B ‖ ciphertext)`;`credentialStatus` 三态 MISSING/CONFIGURED/INVALID 由 Service 合成 |
| E-14 | settings singleton 守护 | 镜像 `StorageSettingsService`:60s 内存缓存 + 写后主动 invalidate + DB >1 行 WARN 取 createdAt 最早;singleton 由 Service 层保证,DB 不强制 |
| E-15 | production 禁 DEV_STUB 双重 | ① PATCH 写入校验:production-like(production/smoke)拒绝 `providerType=DEV_STUB`(400);② 运行时 resolve:production-like 下 DEV_STUB 视作未配置(24030) |
| E-16 | Provider 路由 | `SmsProviderRouter` 每次调用 `resolve()` 按 settings.providerType 选 provider(镜像 storage Q-89-1);**不**缓存腾讯云 SDK client 实例(镜像 Q-89-2) |
| E-17 | 手机号校验 | DTO `@Matches(/^1[3-9]\d{9}$/)`(大陆手机号;SMS 通道边界,不沿用 EC 宽松座机 pattern) |
| E-18 | 响应形状 | send-code → `{ expiresInSeconds: 300 }`;PUT me/phone → `{ phone, phoneVerifiedAt }`(本人可见全量号码);响应永不含验证码 |
| E-19 | admin 清号幂等 | 目标用户无 phone → 200 正常返回不报错;仅实际清除时写 audit;软删用户统一 USER_NOT_FOUND(AGENTS §10) |
| E-20 | send-logs 查询 | 仅 list 分页只读(PaginationQueryDto + 可选 status / phone 精确过滤);响应 phone 掩码;无 detail 端点 |
| E-21 | 掩码规则 | `138****1234`(保留前 3 后 4,中间 4 个星号);`maskPhone()` 工具驻 sms 模块导出,users 模块 audit 复用同一实现 |
| E-22 | templateKey 语义 | 逻辑模板键常量(本期仅 `verify-code`),非 provider 模板 ID;provider 模板 ID 存 `sms_settings.templateIdVerifyCode` |
| E-23 | throttler | 新增 2 个命名实例 `sms-send`(5/60s)/ `sms-verify`(10/60s)+ 装饰器 `@SmsSendThrottle()` / `@SmsVerifyThrottle()`(纯 metadata,limit/ttl 从 `app.config.ts` 注入,沿 password-change 范式;与既有 default / password-change / refresh 物理隔离;`setHeaders: false` 沿用) |
| E-24 | audit 形状 | 见 §3.5;before/after 中 phone 一律掩码;extra 禁写明文码 / codeHash / 完整号码 |
| E-25 | baseline §1.1 行落地时机 | 随 T3 PR(BizCode 实装与段位登记原子化);红区行在 PR 描述逐行列出,沿 #294 范式 |
| E-26 | CHANGELOG 登记时机 | T1/T2/T3 的 Unreleased 登记随 T4 docs PR 统一补(process §5.1 阶段 2 允许"随 feature PR 或独立 docs PR") |
| E-27 | codeHash | `sha256(code).hex`(镜像 refresh tokenHash 范式);6 位码空间小,靠 5min TTL + 单活码 + 错 5 次作废 + 成功即消费补偿;DB 泄露场景下残余风险接受(码生命周期 ≤5min) |
| E-28 | 不建 FK | `sms_verification_codes.userId` / `sms_send_logs.codeId` / `sms_settings.updatedBy` 均纯 String 不建外键(镜像 `StorageSettings.updatedBy` 范式;retention 清理不受 FK 牵制) |
| E-29 | 码生成 | `crypto.randomInt(0, 1000000)` 左补零 6 位(CSPRNG;禁 `Math.random`);DevStub 通道下固定 `888888`(production-like 永不可达,沿 E-15) |
| E-30 | 发码编排归属 | `SmsCodeService.issue()`(sms 模块:间隔/日限/单活码/发送/落日志)对 User 无感知;users 模块负责 phone 占用检查与绑定落库(`users.service` 调 SmsCodeService),边界清晰不互相越界 |

---

## 2. 风险表

| # | 风险 | 影响 | 缓解 | 残余 |
|---|---|---|---|---|
| R-1 | **腾讯云签名 / 模板未过审**,真实发送不可用 | 生产验证码收不到,绑定流程不可用 | DevStub 先行打通全链路;`docs/ops/sms-production-rollout-checklist.md`(T4)承接运维侧开通;`SMS_CHANNEL_NOT_CONFIGURED` 显式可观测;`credentialStatus` 三态 + send_logs 留痕 | 运维侧接力项,系统侧无阻塞;上线初期需按 checklist 真实发送验收 |
| R-2 | **费用滥用**(短信轰炸 / 盗刷资费) | 资费损失、被投诉、号码被运营商拉黑 | 三层防刷(同号 60s + 自然日 10 条 + IP throttler)+ 仅登录态可发 + 已占用号拒发(省一次发送)+ send_logs 全量留痕可对账 | 大规模分布式登录态盗刷需图形验证码 / 风控,本期不做(goal 禁止域);依赖腾讯云侧套餐告警兜底 |
| R-3 | **PII(手机号)泄露 / 滥用** | 用户隐私受损 | 敏感字段三问已答(§8);send-logs 列表掩码;audit detail 一律掩码;pino 日志不写明文码与完整号码;明文码三不纪律;App 仅本人可见自己号码 | DB 内 phone 明文存储(业务必需,发送通道要用);依赖 DB 访问控制 |
| R-4 | **依赖供应链**(`tencentcloud-sdk-nodejs-sms`) | 恶意版本 / 漏洞引入 | 仅 1 个 SDK;package.json 锁精确版本(无 `^`);pnpm lockfile 锁全树;import 仅限 `providers/tencent-sms.provider.ts` 单文件;升级走 D 档 | 上游官方包自身风险;CI lockfile frozen 兜底 |
| R-5 | **migration 不可逆**(三表 + User 2 字段一经合入不回改) | schema 返工成本极高 | `srvf-prisma-change` 全流程;字段集 / 可空性 / 索引在本稿 §3.1 先冻结;T1 干净库 `prisma:deploy` 重放 + seed 幂等二跑;PR 描述贴 migration SQL 全文 | `phone @unique` 含软删占用语义已显式(E-7);后悔路径 = 新 migration 前滚,不回改历史 |

---

## 3. 五张清单

### 3.1 字段清单(schema;T1 落地)

**`User` 新增 2 字段**(放在 `lastLoginAt` 之后):

| 字段 | 类型 | 说明 |
|---|---|---|
| `phone` | `String? @unique` | 账号级手机号;全局唯一含软删占用(E-7);非 Member.phonePrimary(队员联系电话,互不相干) |
| `phoneVerifiedAt` | `DateTime?` | 最近一次验码绑定成功时刻;admin 清除后归 null |

**`sms_settings`**(model `SmsSettings`;镜像 `StorageSettings` 注释与结构;singleton 由 Service 层保证):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `providerType` | `SmsProviderType` | enum `DEV_STUB / TENCENT_SMS` |
| `enabled` | `Boolean @default(true)` | 全局启用开关 |
| `sdkAppId` | `String?` | 腾讯云 SMS SdkAppId(非 secret,明文) |
| `signName` | `String?` | 短信签名(须先过审) |
| `region` | `String?` | 腾讯云 region(如 ap-guangzhou) |
| `templateIdVerifyCode` | `String?` | 验证码模板 ID(须先过审) |
| `secretIdEncrypted` | `String?` | AES-256-GCM 密文;明文永不入库 |
| `secretKeyEncrypted` | `String?` | 同上 |
| `credentialConfigured` | `Boolean @default(false)` | DB 层简单事实;运行时 credentialStatus 三态由 Service 合成 |
| `remarks` | `String?` | 运维备注 |
| `updatedBy` | `String?` | User.id;不建外键(E-28) |
| `updatedAt` / `createdAt` | `DateTime` | `@updatedAt` / `@default(now())` |

**`sms_verification_codes`**(model `SmsVerificationCode`):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `phone` | `String` | 目标手机号 |
| `purpose` | `SmsPurpose` | enum,本期仅 `PHONE_BIND` |
| `codeHash` | `String` | `sha256(code).hex`;明文码永不入库(E-27) |
| `userId` | `String?` | 签发归属用户;PHONE_BIND 必填值,字段可空留 pre-auth 消费者(E-8);不建外键 |
| `expiresAt` | `DateTime` | 签发 +5min |
| `consumedAt` | `DateTime?` | 验证成功即消费 |
| `supersededAt` | `DateTime?` | 同 phone+purpose 新码签发时旧码作废(E-9) |
| `attempts` | `Int @default(0)` | 错误尝试计数;≥5 作废 |
| `ip` | `String?` | 签发请求 IP(防刷取证) |
| `createdAt` | `DateTime @default(now())` | |
| 索引 | `@@index([phone, purpose])` | 单活码定位 + 间隔/日限按 phone 前缀查询 |

**`sms_send_logs`**(model `SmsSendLog`;append-only,无更新删除路径):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `phone` | `String` | 明文存储(对账需要);**响应层一律掩码**(E-20/E-21) |
| `templateKey` | `String` | 逻辑模板键,本期仅 `verify-code`(E-22) |
| `providerType` | `SmsProviderType` | 发送时通道 |
| `status` | `SmsSendStatus` | enum `SENT / FAILED` |
| `providerMsgId` | `String?` | provider 回执 ID |
| `errCode` / `errMsg` | `String?` | 失败时 provider 错误(不含 secret) |
| `codeId` | `String?` | 关联 sms_verification_codes.id;不建外键(E-28) |
| `createdAt` | `DateTime @default(now())` | |
| 索引 | `@@index([phone, createdAt])` | 按号排错 + 列表查询 |

### 3.2 端点清单(7 个;T2 = ①-④,T3 = ⑤-⑦)

| # | Method | Path | 鉴权(summary 后缀) | 入参 DTO | 出参 | 说明 |
|---|---|---|---|---|---|---|
| ① | GET | `/api/system/v1/sms-settings` | `[rbac: sms-setting.read.singleton]` | — | `SmsSettingsResponseDto \| null` | 不存在返 data=null 不抛码;永不回显凭证(密文也不回显);含 credentialStatus 三态 |
| ② | PATCH | `/api/system/v1/sms-settings` | `[rbac: sms-setting.update.singleton]` | `UpdateSmsSettingsDto` | `SmsSettingsResponseDto` | upsert(不存在则建 default `providerType=DEV_STUB`);拒绝任何凭证字段;production-like 拒 DEV_STUB(E-15);成功 invalidate cache |
| ③ | POST | `/api/system/v1/sms-settings/reset-credentials` | `[rbac: sms-setting.reset.credentials]` | `ResetSmsCredentialsDto { secretId, secretKey }` | `SmsSettingsResponseDto` | **仅 SUPER_ADMIN 短路通过**(码不绑 ops-admin);AES-256-GCM 加密落库;不存在则 upsert 创建 default `providerType=TENCENT_SMS`;响应不回显 |
| ④ | GET | `/api/system/v1/sms-send-logs` | `[rbac: sms-send-log.read.list]` | `SmsSendLogQueryDto`(page/pageSize + 可选 status/phone) | `PageResultDto<SmsSendLogResponseDto>` | 分页只读;`@ApiWrappedPageResponse`;**响应 phone 掩码** |
| ⑤ | POST | `/api/app/v1/me/phone/send-code` | `[auth]` + `@SmsSendThrottle()` | `SendMyPhoneCodeDto { phone }` | `{ expiresInSeconds }` | 仅登录态(E-5 豁免 canUseApp);检查链:占用 → 间隔 → 日限 → 通道 → 签发+发送+落日志 |
| ⑥ | PUT | `/api/app/v1/me/phone` | `[auth]` + `@SmsVerifyThrottle()` | `BindMyPhoneDto { phone, code }` | `{ phone, phoneVerifiedAt }` | 验码绑定/换绑一体;事务内消费码 + 更新 User + audit(bind/rebind 按 before.phone 区分) |
| ⑦ | DELETE | `/api/admin/v1/users/:id/phone` | `[rbac: user.phone.clear]` | `IdParamDto` | `UserResponseDto` | Service 内 `rbac.can()` + `assertCanManageUser`;幂等(E-19);清除 phone + phoneVerifiedAt;audit |
| | | | | | | contract `EXPECTED_ROUTES` 148→155;snapshot diff 逐行可解释进 PR 描述 |

Swagger:`@ApiTags` 沿 Ops 范式(`Ops - SMS Settings` / `Ops - SMS Send Logs`);App 端点挂入既有 `AppMeController`(`app/v1/me`,不新建 controller class,沿 P2-3 范式);Admin 端点挂入既有 `UsersController`。

### 3.3 错误码清单(BizCode 24xxx 新段;T3 落地;baseline §1.1 加行沿 E-25)

| 常量 | code | httpStatus | message(不暴露阈值) | 触发 |
|---|---|---|---|---|
| `PHONE_ALREADY_BOUND` | 24002 | 409 CONFLICT | 该手机号已被绑定 | send-code 预检 / 绑定复查 / P2002(唯一约束段 XX002) |
| `SMS_CODE_INVALID` | 24010 | 400 BAD_REQUEST | 验证码错误或已失效 | **统一码防枚举**:码不存在 / 过期 / 已消费 / 已作废(superseded 或错 5 次)/ 码值不符 / 归属不符(E-8);禁止细分 |
| `SMS_CHANNEL_NOT_CONFIGURED` | 24030 | 503 SERVICE_UNAVAILABLE | 短信服务未配置或未启用 | settings 缺失 / enabled=false / 凭证非 CONFIGURED / production-like 下 DEV_STUB(状态非法段 XX030) |
| `SMS_SEND_FAILED` | 24031 | 502 BAD_GATEWAY | 短信发送失败,请稍后重试 | provider 调用异常 / 回执失败(E-12) |
| `SMS_SEND_INTERVAL_LIMIT` | 24120 | 429 TOO_MANY_REQUESTS | 发送过于频繁,请稍后再试 | 同号距上次签发 <60s(操作冲突段 XX120) |
| `SMS_PHONE_DAILY_LIMIT` | 24121 | 429 TOO_MANY_REQUESTS | 该手机号今日发送次数已达上限 | 同号自然日(E-10)≥10 条(E-11) |

不开的码:`SMS_CODE_EXPIRED` / `SMS_CODE_ATTEMPTS_EXCEEDED` 等细分(沿 10007 防枚举先例);权限拒绝沿通用 30100/40100/40300(RBAC_MAP §6 规则 5);IP throttle 命中沿 `TOO_MANY_REQUESTS=42900`。

### 3.4 权限码清单(seed +5,76→81;T2 落地;RBAC_MAP 同 PR 同步)

| code | module / action / resourceType | ops-admin 绑定 | 用途 |
|---|---|---|---|
| `sms-setting.read.singleton` | sms-setting / read / singleton | ✅ | 端点① |
| `sms-setting.update.singleton` | sms-setting / update / singleton | ✅ | 端点② |
| `sms-setting.reset.credentials` | sms-setting / reset / credentials | ❌(仅 SUPER_ADMIN 短路;镜像 storage D2=A) | 端点③ |
| `sms-send-log.read.list` | sms-send-log / read / list | ✅(镜像 audit-log.read.entry D2=B) | 端点④ |
| `user.phone.clear` | user / clear / phone(code 字符串按 goal 原文 `user.phone.clear`) | ✅(镜像 user.update.status 档位;service 内 assertCanManageUser 护栏) | 端点⑦ |

seed 实现:新增独立数组(不改既有数组及其计数注释);ops-admin 绑定集合追加 4 条;ops-admin 描述行计数 54→58 同步。

### 3.5 审计事件清单(AuditLogEvent +3;T3 落地;kebab-case 沿既有范式)

| 事件 | 写入点 | resourceType / resourceId | before / after / extra |
|---|---|---|---|
| `phone.bind.self` | users.service 绑定成功(原 phone 为 null) | `user` / currentUser.id | after `{ phone: 掩码 }`;extra `{ codeId }` |
| `phone.rebind.self` | users.service 换绑成功(原 phone 非 null) | `user` / currentUser.id | before/after `{ phone: 掩码 }`;extra `{ codeId }` |
| `phone.clear.by-admin` | users.service admin 清除(仅实际清除时写,E-19) | `user` / 目标 user.id | before `{ phone: 掩码 }`;extra 无附加 |

纪律:detail(before/after/extra)中手机号**一律掩码** `138****1234`(E-21);**禁止**写入明文验证码 / codeHash / 完整号码;`AuditContext.ip` 沿框架自带。SmsSettings 变更(②/③)**不写 audit**(沿 L-3 挂起,镜像 storage 现状,[`current-state.md §3`](../../current-state.md))。

---

## 4. 验证码语义与防刷(D-SMS-5/6 展开)

- **签发**:6 位纯数字 CSPRNG(E-29);TTL 5 分钟;同 phone+purpose 单活码(E-9);明文码只在内存中存在于"生成 → 交给 provider 发送"链路,**不入库(只存 sha256)、不入 pino 日志、不入响应、不入 audit、不入 OpenAPI 示例与测试 fixture 明文断言**(L3 纪律;DevStub 例外见下)。
- **校验**(消费方 `PUT /me/phone`):取 phone+purpose 最新未消费未作废码 → 依次判:不存在 / 已过期 / attempts≥5 / 归属不符 / `sha256(input) !== codeHash`(timingSafeEqual)→ 全部统一抛 24010;码值不符时事务内 `attempts + 1`;命中即事务内标 `consumedAt` 并执行绑定(单事务,沿 AGENTS §12)。
- **DevStub 例外**:providerType=DEV_STUB 时码固定 `888888`(E-29)且 provider 以 debug 级日志输出(便于本地/e2e);production-like 环境 DEV_STUB 不可达(E-15),故固定码永不出现在生产。
- **防刷三层**(send-code 检查顺序:占用 → 间隔 → 日限 → 通道):
  1. 同号 ≥60s 间隔(查 phone 最新一条 code.createdAt;跨 purpose 共享,本期单 purpose);
  2. 同号自然日 10 条(E-10/E-11;DB count,业务常量驻 `sms.constants.ts`,**不**做 env 可调);
  3. IP 维度 `@SmsSendThrottle()` 5/60s、`@SmsVerifyThrottle()` 10/60s(E-23;命中走 42900,不暴露 Retry-After)。
- 所有限频 message 不暴露具体阈值数字(D-SMS-6)。

## 5. 模块位置与 AGENTS §2 providers/ 子目录例外解锁记录

- **位置**:`src/modules/sms/` 平铺新业务模块(AGENTS §2 ✅;**不**入 `src/common/`——`common/storage/` 属历史遗留,current-state §4 已标 P3 超出 common 语义,不再复制该形态)。
- **例外解锁(本节即解锁记录)**:AGENTS §2 已解锁例外原不含"业务模块内 providers/ 子目录";2026-06-10 维护者 goal 拍板,为 `src/modules/sms/` 解锁 `providers/` 子目录(`dev-stub.provider.ts` / `tencent-sms.provider.ts`),镜像 [`src/common/storage/providers/`](../../../src/common/storage/providers/) 既有形态。**边界**:本解锁仅及 `src/modules/sms/providers/` 一个子目录(加上既有 `dto/` 例外);不得借此嵌套其他子目录;AGENTS.md 本体零触碰(goal §2 红区授权仅 baseline §1.1 一处)。
- **文件计划**(T2/T3):`sms.module.ts` / `sms-settings.controller.ts` / `sms-settings.service.ts` / `sms-send-logs.controller.ts` / `sms-send-logs.service.ts` / `sms-code.service.ts`(T3)/ `sms-crypto.service.ts` / `sms-provider.router.ts` / `sms.dto.ts`(>300 行再拆 `dto/`)/ `sms.types.ts` / `sms.constants.ts` / `providers/{dev-stub,tencent-sms}.provider.ts` + 对应 spec;App DTO 驻 users 模块 `dto/app/`(D-6 禁派生)。

## 6. 安全边界(D-SMS-8 展开)

- **`SMS_ENCRYPTION_KEY`**:独立 env,与 `STORAGE_ENCRYPTION_KEY` 互不复用;`app.config.ts` 沿 `parseStorageEncryptionKey` 范式新增解析(production/smoke 缺失或 <32 字符 → 启动 fail-fast;dev/test 允许空);`.env.example` 加一行(留空);`docker-smoke.yml` 加 `openssl rand -base64 32` 生成 + 容器 env 注入(已拍板范围)。
- **凭证链路**:secretId/secretKey 仅出现在 ③ 入参与 provider 调用内存中;落库必经 sms-crypto 加密;响应/日志/audit/snapshot 永不出现明文或密文(L3 红线,出现即拒合并)。
- **SDK**:`tencentcloud-sdk-nodejs-sms` 锁精确版本;import 仅限 tencent-sms.provider.ts。
- **腾讯云调用守护**(镜像 CosProvider 4 档):settings null / providerType 不符 / credentialStatus ≠ CONFIGURED / sdkAppId·signName·region·templateId 缺失 → 通道不可用错误(上抛 24030)。

## 7. 换绑 / 解绑 / 占用语义(D-SMS-3 展开)

- **绑定与换绑一体**:⑥ 单端点;首次绑定(before.phone=null)写 `phone.bind.self`,换绑写 `phone.rebind.self`;换绑直接覆盖旧号,无"旧号验证"环节(本期拍板:绑定凭据 = 登录态 + 新号验码)。
- **解绑**:**无自助解绑端点**(7 端点锁定);解除绑定唯一路径 = ⑦ admin 清除(phone/phoneVerifiedAt 同置 null)。
- **占用**:E-7;含软删账号占用;软删账号的号码释放无入口(对软删用户 ⑦ 统一 USER_NOT_FOUND,沿 AGENTS §10),与 username/email 同等约束,真实需求出现时单独立项。
- **自绑已绑号**:同号重绑同样在 send-code 即被 24002 拒绝(省 SMS 成本;本期不提供"重新验证当前号"语义)。

## 8. 敏感字段三问(AGENTS §18.4;入 schema 前必答)

涉及字段:`User.phone` / `User.phoneVerifiedAt` / `sms_verification_codes.{phone,ip,codeHash}` / `sms_send_logs.phone`。

1. **业务用途**:账号级手机号绑定基础设施,为后续三个消费者(找回密码 / OTP 登录 / 通知)提供"经验证的联系方式";`verification_codes.phone+ip` 服务验码匹配与防刷取证;`send_logs.phone` 服务发送对账与排错。
2. **查看角色与默认掩码**:本人 —— App ⑥ 响应可见自己全量号码;管理/运维 —— ④ send-logs 列表**一律掩码**;audit detail **一律掩码**;`UserResponseDto` / App me 既有 DTO 本期不暴露 phone(E-6);明文验证码对任何角色不可见(含 SUPER_ADMIN)。
3. **保存期限**:`User.phone` 随账号生命周期(软删不释放,沿 username/email 范式);`sms_verification_codes` 行过期后**本期不清理**(retention 待办挂 NEXT_TASKS,清理策略届时单独立项);`sms_send_logs` 永久留存对账(retention 同待办);退队(member 维度)不影响账号级 phone,账号软删时 phone 随行保留。

## 9. 既有行为锁(D-SMS-11 展开)

- 登录入参仍仅 `username + password`(AGENTS:242 原文不动;OTP 登录属未来消费者,启动前需对该行评审解锁)。
- `JwtPayload` 严格 `{ sub, username }` zero drift;`JwtStrategy.validate` select 字段集不动;P0-E refresh 全部行为冻结;`LoginDto` / `LoginResponseDto` / refresh 系 DTO 零触碰。
- auth-* 全组 e2e **原断言零改动**全绿(DoD-6);全仓既有测试断言禁删改(含 `EXPECTED_USER_RESPONSE_KEYS` / `APP_ME_KEYS` 系,推导出 E-6)。
- 既有 throttler(default / password-change / refresh)实例与配置零触碰;新 throttler 只增不改。

## 10. 测试计划(DoD-6 展开)

- **e2e 新增 3 组 + 既有横切**:
  - `sms-settings.e2e-spec.ts`:①-④ 全链(RBAC 正反 / reset 仅 SA / 凭证永不回显 / upsert 语义 / send-logs 掩码与分页);
  - `app-me-phone-bind.e2e-spec.ts`:绑定 → 换绑 → admin 清除 → 重绑全链 + 占用(他人/自己/软删)+ 码归属 + admin 幂等清除 + audit 断言(掩码);
  - `sms-throttle.e2e-spec.ts`:60s 间隔 / 日限 / IP 限流(send 5/60 + verify 10/60)/ 错 5 次作废 / 过期码 / 重用(已消费)码 / 单活码 superseded;
  - 横切组回归:`response-format` / `bizcode-http-status` / `request-id` + auth-* 全组零改动全绿。
- **unit**:`sms-crypto.service.spec`(沿 storage-crypto.spec 范式)/ `dev-stub.provider.spec` / `tencent-sms.provider.spec`(mock SDK,沿 cos.provider.spec 范式)/ `sms-code.service.spec`(T3)。
- **contract**:EXPECTED_ROUTES +7 显式登记;snapshot diff 逐行可解释(仅新增 path/schema,既有路由零漂移);L3 字段出现 = 拒。
- e2e 环境:test env 配 DEV_STUB settings(fixtures 建 row),固定码 888888 驱动正向链路;过期/作废场景直改 DB 行。

## 11. 任务队列与探针(顺序硬约束;goal §3 原文固化)

| 队列 | 档位 | 范围 | 探针(未满足才做) |
|---|---|---|---|
| T0 | A | 本稿 + NEXT_TASKS 登记(本立项 + 三消费者挂起 + retention 待办) | 评审稿文件在 main |
| T1 | D | §3.1 全部;仅 schema/migration 不带业务代码;`prisma migrate dev` 仅限本地生成 migration(已拍板免简报;PR 描述贴 SQL 全文) | migration 在 main + 干净库重放记录 |
| T2 | D | §5 文件计划(除 sms-code.service)+ SDK 依赖 + 权限码 seed + 端点①-④ + env 与 fail-fast + unit + contract 同步 | 端点①-④上线 + DoD-5 |
| T3 | C/D | sms-code.service + 端点⑤-⑦ + 3 audit 事件 + BizCode 24xxx(+baseline §1.1 行,E-25)+ throttler 装饰器 + e2e 三组 + contract 同步 | 端点⑤-⑦ + DoD-4/6 |
| T4 | A | CHANGELOG Unreleased(C/D 档,E-26)+ current-state §2/§4 + 根 CODEMAP 行 + `docs/ops/sms-production-rollout-checklist.md` + system-foundation-governance G-7 行改"通道已就绪,通知用途未启动" → DoD 八条探针 → 终版报告 | DoD-7/8 |

LOOP 纪律沿 process §7.1:同一失败修复 ≤2 轮;连续 2 轮零推进熔断;全程 `agent:check:full`(本机 Docker 可用时,否则 quick + CI 并显式声明);每 PR 合并沿 process §5.4 八条。

## 12. 本期不做(终版报告必列)

- ❌ 找回密码 / OTP 登录 / 通知用途三个消费者(挂 NEXT_TASKS;OTP 登录还需先解锁 AGENTS:242)
- ❌ pre-auth 发码(所有端点登录态)/ 图形验证码 / 风控 / repository 层 / cron·retention 清理(待办挂 NEXT_TASKS)
- ❌ 真实腾讯云凭证录入与真实发送验收(运维侧按 T4 checklist 接力:开通签名 → 模板审核 → admin API 录凭证 → 真实发送验收)
- ❌ L-3(SmsSettings/StorageSettings 配置变更审计)沿挂起
- ❌ `UserResponseDto` / App me 既有 DTO 暴露 phone(E-6;读路径留首个消费者立项,届时一并拍板更新既有字段集断言)
- ❌ 自助解绑 / 旧号验证换绑 / 重新验证当前号 / 软删账号号码释放 / sms-settings test-connection 端点 / 多模板·多 purpose / 国际号段
