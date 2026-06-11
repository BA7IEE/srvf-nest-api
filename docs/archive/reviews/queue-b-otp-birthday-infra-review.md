# SRVF B 队列评审稿(Queue-B: Storage 迁移 / SMS Retention SOP / OTP 登录 / 生日祝福)

> **状态**:**实施前评审稿(冻结文本)**(2026-06-11)
> **性质**:**D 档拍板记录 + implementation review**(沿 [`docs/process.md §4 / §7.1`](../../process.md))。维护者已于 2026-06-11 经评审拍板六项(§1.1),工程细节授权代决(§1.2);goal「B 队列一次收清」文本 = 立项 + 授权凭据,本稿把 goal 共识成文并冻结。**实施中任何偏离本稿的决定 → 人话简报(process §4.1)停下等回复,不得自行调整。**
> **范围**(四节一文,对应 F2-F5 四个实施阶段):① `src/common/storage/` → `src/modules/storage/` 全量迁移(零行为);② SMS 数据 retention 手动 SQL SOP;③ OTP(验证码)登录两端点 + `SmsPurpose +LOGIN` + **AGENTS:242 红区行解锁改写**;④ 生日祝福短信 + `@nestjs/schedule` 引入(**no-cron 升级路径正式触发**)+ `SmsSettings +templateIdBirthday` + 新 `src/modules/notifications/` 模块(G-7 首个落地点)。
> **不在范围**:通知退订 / 群发 / 活动通知 / 农历生日 / 生日发 `MemberProfile.mobile` / cron 数据清理 / 二要素登录 / 新 BizCode / 新权限码 / repository 层(详 §9)。
> **前置基建**(已就绪):SMS 通道层 + `SmsCodeService`(v0.18.0,[`sms-verification-infra-review.md`](./sms-verification-infra-review.md),下称 **SMS 评审稿**);找回密码防枚举范式(v0.19.0,[`password-reset-by-sms-review.md`](./password-reset-by-sms-review.md),下称 **找回密码评审稿**);RBAC 单轨(v0.20.0)。
> **前置必读**:[`AGENTS.md §1/§5/§8/§9`](../../../AGENTS.md) / [`docs/api-surface-policy.md §0`](../../api-surface-policy.md) / `srvf-auth-security`、`srvf-prisma-change`、`srvf-api-surface`、`srvf-release-closeout` skills;SMS 评审稿 §12 与找回密码评审稿 §9/§10(P1-7 启动前置)。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线(沿 process §6);但在"本队列四项范围内的具体设计取舍"上,本稿即冻结决议。
> **解除条件**:本稿合入 main 后,F2-F5 实施 PR 按 §8 队列在 process §3/§4 流程内连续推进(goal 模式,process §7.1)。

---

## 0. TL;DR

1. **storage 迁移(F2,D 档)**:`src/common/storage/` 20 文件(含 CLAUDE.md)全量 `git mv` 至 `src/modules/storage/`,**纯搬迁零行为**;controller path / Swagger / DTO / 行为零变化,**OpenAPI snapshot 零 diff 为硬验收**;import 链全量更新(外部 3 文件 + 迁移文件内部相对路径深度修正);CODEMAP / current-state §4 P3 行 / NEXT_TASKS P2-4 随 PR 闭环。
2. **retention SOP(F3,A 档)**:新 [`docs/ops/sms-data-retention-sop.md`](../../ops/sms-data-retention-sop.md)——`sms_verification_codes` 保留 **90 天** / `sms_send_logs` 保留 **1 年**(数值可改);SQL 在 app_test 实测后冻结(记录贴 PR);体量报警线 + 执行记录模板;**手动 psql 作业,不解锁 cron 清理**(拍板③,即使 F5 已引入 `@nestjs/schedule`);NEXT_TASKS P2-6 ✅。
3. **OTP 登录(F4,C/D 档)**:`POST /api/auth/v1/login-sms/send-code` + `POST /api/auth/v1/login-sms`{phone,code},均 `@Public()` + `@LoginSmsThrottle()`(**第 7 命名 throttler 实例** `login-sms`,IP 5/60s,物理隔离);`SmsPurpose +LOGIN`(单行 migration,F4-T1 先行);**防枚举全程沿找回密码范式**(send-code 四无效场景泛化 200 逐字节一致零留痕;登录一切失败统一 24010,**零新增 BizCode**);成功签发会话与密码登录**完全同构**(同 `LoginResponseDto` / 同 refresh family 机制 / lastLoginAt 同步;实现 = `AuthService` 抽取公共签发方法,E-O6);audit 新事件 `auth.login.sms`;**AGENTS:242 红区行解锁改写**(§5.4,before/after 逐行,本稿即解锁评审记录);密码登录与 P0-E 既有 e2e **断言零修改**全绿。
4. **生日祝福(F5,C/D 档)**:新依赖 `@nestjs/schedule`(锁精确版本)——**no-cron 铁律升级路径正式触发**(拍板④;AGENTS:73「异步任务诉求触发时评审」之评审即本稿,仅服务生日批,数据清理仍走 SOP);`SmsSettings +templateIdBirthday`(单列 migration);新 `src/modules/notifications/`(G-7 首个落地点);每日 09:00(Asia/Shanghai)选取「`MemberProfile.birthDate` 月日=今天 && Member ACTIVE && profile 未软删 && User 已绑 phone 且 ACTIVE」逐个单发(**仅 `User.phone`**,拍板⑤);**幂等防重发** = 发前查 `sms_send_logs` 当日同模板同号 SENT 已存在则跳过(重启不重发,e2e 锁定);失败记 FAILED 不重试不阻断;**不进 audit_logs**;手机号全程掩码;**单实例部署前提成文**(多实例需先加锁,§6.8)。
5. **测试**:job 选取 / 幂等 / 掩码经**直调 e2e**(`app.get(...).runOnce()`)+ unit 锁定,不等真实定时;OTP 全链 e2e(发码→登录→token 可用→refresh 轮换→防枚举一致性→限流);全部既有 e2e 断言零修改全绿;contract 路由级仅 +2(157→159),字段级仅 sms-settings ±`templateIdBirthday`,零 L3。
6. **队列**:F0(v0.20.0 收口,已完成)→ F1(本稿)→ F2 → F3 → F4 → F5 → F6(v0.21.0 收口);顺序硬约束,探针驱动(§8)。

---

## 1. 决策汇总表

### 1.1 维护者拍板项(2026-06-11,goal 原文为凭据)

| # | 决策 | 内容 |
|---|---|---|
| D-QB-1 | OTP 形态 | OTP = **并行登录方式**(独立端点 `login-sms`,密码登录零变化)→ **解锁 AGENTS:242**(「v1 入参固定 username+password(不支持…验证码登录)」行,2026-06-11 时点位于 AGENTS.md:243;红区例外仅此一行改写,#294 范式 before/after) |
| D-QB-2 | 通知首批 | 通知用途短信首批 = **生日祝福**(单发、零变量模板;群发/退订/活动通知不做) |
| D-QB-3 | retention 形态 | retention = **手动 SQL SOP**(`docs/ops/`,维护者手动执行;**不解锁 cron 清理**,即使 `@nestjs/schedule` 已引入) |
| D-QB-4 | 调度引入 | 引入 `@nestjs/schedule`——**no-cron 铁律的升级路径正式触发**(AGENTS:73「Redis / queue / cron(异步任务诉求触发时评审,需评估运维承接)」之评审 = 本稿;**仅服务生日批**,运维承接 = 单实例容器内进程级 cron,零新增运维组件) |
| D-QB-5 | 生日覆盖面 | 祝福**仅发 `User.phone`**(已绑定账号且 ACTIVE 者;`MemberProfile.mobile` 不用——未验证号码不发) |
| D-QB-6 | 队列形态 | 全队列一个 goal 串行(F0→F6,两次 E 档收口含 tag/Release;预计 12-15 PR;会话中断可同 goal 重跑,探针自动跳过已完成项) |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

> 编号前缀按节:E-S(storage)/ E-R(retention)/ E-O(OTP)/ E-B(birthday)。正文 §3-§6 展开。

---

## 2. 风险表

| # | 风险 | 影响 | 缓解 | 残余 |
|---|---|---|---|---|
| R-1 | **storage 迁移 import 链漏改 / 相对路径深度错**(迁移文件内部 `../` 引用 common 兄弟目录需改 `../../common/`) | 编译失败 / 运行时 DI 失败 | `git mv` 保历史 + `tsc` typecheck + 全仓 `grep 'common/storage'` 残留=0(archive 豁免)+ `agent:check:full` 全绿 + **snapshot 零 diff 硬验收** | 低;纯机械变更,工具链全覆盖 |
| R-2 | **验证码即登录凭据**(OTP 把手机号控制权升格为账号会话;SIM 劫持面扩大) | 账号被接管 | 沿找回密码 R-2 同理:6 位 CSPRNG / 5min / 错 5 次作废 / 单活码 / 成功即消费;audit `auth.login.sms` 留痕(掩码);IP 5/60s + 同号 60s + 日 10 条;内部系统号码集合封闭 | 与业界 OTP 登录基线一致,接受;图形码重启条件沿找回密码评审稿 §9(其 ④「OTP 登录立项需一并设计」已由本稿承接:不前置图形码,重启条件全集继续生效) |
| R-3 | **AGENTS:242 红区改写**(登录契约铁律行) | 改错冻结契约 | 仅一行改写(§5.4 before/after 冻结);密码登录端点 / DTO / `AuthService.login` 入口行为零变化;auth 既有 e2e 断言零修改全绿为行为锁 | goal 拍板覆盖(D-QB-1),无未授权红区残留 |
| R-4 | **`AuthService` 签发逻辑抽取**(E-O6 重排 P0-E 冻结区文件) | refresh family / audit 行为漂移 | 抽取式重排(逻辑零增删);P0-E 全组 + auth-login 全组断言零修改全绿;`JwtPayload` / `LoginResponseDto` / refresh 系 DTO 零触碰 | 低;e2e 1775 例全量回归兜底 |
| R-5 | **`@nestjs/schedule` 引入越界使用**(后续任务擅自挂新 cron) | no-cron 铁律失守 | 解锁范围冻结 = **仅生日批一个 `@Cron`**;current-state §3 no-cron 行注记「已按升级路径解锁,仅生日批」;新增任何 cron = 新 D 档评审(含 retention,D-QB-3 明确不解锁) | 制度护栏;依赖 review 纪律 |
| R-6 | **生日批重复发送**(进程重启 / 重叠触发) | 用户重复收短信 | 幂等防重发:发前查 `sms_send_logs` 当日同模板同号 SENT(E-B6);重启不重发 e2e 锁定;@Cron 单实例单触发 | 极端窗口(发送成功但落日志失败,进程即崩)可能次日内重发一次;概率极低,接受 |
| R-7 | **多实例并发跑批**(未来横向扩容时双发) | 重复发送 | **单实例部署前提成文**(E-B12/§6.8):当前部署为单实例;多实例前必须先加分布式锁(DB advisory lock / 任务表)再扩,挂为边界条款 | 前提条款;违反属部署侧违规 |
| R-8 | **retention SQL 误删**(手动作业风险) | 不可逆数据丢失 | SQL 在 app_test 实测后冻结;SOP 强制顺序 = 备份 → 事务内预数 → DELETE → 复核 → COMMIT;仅维护者手动执行;保留窗口 90d/1y 远大于排障需要 | 手动作业固有风险;SOP 模板 + 执行记录表降低 |
| R-9 | **migration 不可逆**(`SmsPurpose +LOGIN` enum 值 + `templateIdBirthday` 列) | 废弃成本高 | 单行 / 单列;干净库全量重放 + `migrate diff` 零差异 + seed 幂等二跑;PR 贴 SQL 全文;`srvf-prisma-change` 全流程 | 后悔路径 = 闲置不删,可接受(沿 #308 先例) |
| R-10 | **OTP 防枚举侧信道**(同找回密码 R-1:有效号限频差异 / timing) | 号码存在性探测 | 主信道关死(四场景逐字节一致泛化 200 + 登录统一 24010);IP 5/60s;号码集合封闭;DevStub 阶段零实币 | 同找回密码 R-1 接受口径;真实通道开通后有实测探测证据 → 图形码重启条件 ① |

---

## 3. Storage 迁移(F2,D 档;纯搬迁零行为)

### 3.1 迁移清单(E-S1)

`git mv src/common/storage src/modules/storage`,**20 文件全量随迁**:`storage.module.ts` / `storage-settings.controller.ts` / `storage-settings.service.ts` / `storage-settings.dto.ts` / `storage-settings.types.ts` / `storage-crypto.service.ts` / `storage-provider.router.ts` / `storage.constants.ts` / `storage.interface.ts` / `storage.types.ts` / `upload-token.util.ts` / `providers/local.provider.ts` / `providers/cos.provider.ts` / 6 个同名 `.spec.ts` / **`CLAUDE.md`(随迁 + 路径引用 true-up)**。

### 3.2 import 链(E-S2)

- **外部引用 3 文件**:`src/app.module.ts`(StorageModule)/ `src/modules/attachments/attachments.module.ts` / `src/modules/attachments/attachments.service.ts`(CosProviderUnavailableError / StorageSettingsService / STORAGE_PROVIDER token / StorageProvider / signUploadToken)——路径 `common/storage` → `modules/storage`(attachments 侧相对路径 `../../common/storage/...` → `../storage/...`)。
- **内部相对路径深度修正**:迁移文件内对 `src/common/` 兄弟目录(exceptions / decorators / guards 等)与 `src/config` / `src/prisma` 的引用按新深度逐一修正(`../x` → `../../common/x` 等)。
- **验收**:全仓 `grep -rn 'common/storage'` 残留 = 0(`docs/archive/**` 历史档案豁免不回改);`tsc` 零错;jest 测试发现不依赖路径白名单(testMatch 全局 glob,spec 随迁自动收编)。

### 3.3 验收冻结(E-S3)

**snapshot 零 diff(逐字节)为硬验收**:controller path(`/api/system/v1/storage-settings*`)/ Swagger tag / summary / DTO / 错误码全部零变化;`agent:check:full` 全绿;**禁夹带任何行为变化 / 顺手重构 / 注释洗稿**(D 档纯搬迁纪律)。

### 3.4 派生层随 PR 闭环(E-S4)

根 `CODEMAP.md` storage 行迁区(common → modules 段);`docs/current-state.md §4` P3 行「`common/storage/` 超出 common 语义」**闭环移除**;`docs/ai-harness/NEXT_TASKS.md` P2-4 ✅ 归档;模块 CLAUDE.md 内路径字样 true-up;`docs/development.md` 等活文档若有 `common/storage` 字样一并 true-up。

---

## 4. SMS Retention SOP(F3,A 档;手动 SQL,不解锁 cron)

### 4.1 SOP 文件(E-R1)

新建 [`docs/ops/sms-data-retention-sop.md`](../../ops/sms-data-retention-sop.md),登记进 `docs/README.md §1` Active docs 表。保留策略(**数值可改**,SOP 内声明维护者可按需调整,改值不需重新评审):

| 表 | 保留窗口 | 理由 |
|---|---|---|
| `sms_verification_codes` | **90 天** | 验证码 5min 即失效,行仅剩排障/审计价值;90 天远超排障窗口 |
| `sms_send_logs` | **1 年** | 发送流水 = 费用对账 + 触达留痕(生日祝福幂等仅查当日,不受清理影响);1 年覆盖年度对账 |

### 4.2 SQL 冻结(E-R2;app_test 实测后冻结,实测记录贴 F3 PR)

```sql
BEGIN;
SELECT count(*) FROM sms_verification_codes WHERE "createdAt" < now() - interval '90 days';
DELETE FROM sms_verification_codes WHERE "createdAt" < now() - interval '90 days';
SELECT count(*) FROM sms_send_logs WHERE "createdAt" < now() - interval '1 year';
DELETE FROM sms_send_logs WHERE "createdAt" < now() - interval '1 year';
COMMIT;
ANALYZE sms_verification_codes; ANALYZE sms_send_logs;
```

强制顺序:表级备份(`pg_dump -t`)→ 事务内预数 → DELETE → 行数复核(预数 = 删除数)→ COMMIT;任何意外 `ROLLBACK`。

### 4.3 体量报警线与节奏(E-R3;数值可改)

- 例行节奏:**每季度**执行一次(或真实通道开通后首月复查一次)
- 报警线(任一命中立即执行):`sms_verification_codes` > **50,000 行** 或 `sms_send_logs` > **500,000 行** 或两表合计体积 > **100 MB**(SOP 附查询 SQL)
- SOP 附执行记录表模板(日期 / 执行人 / 两表删除行数 / 备份位置)

### 4.4 边界(E-R4)

物理删数据 = D 档动作,但**作业本体是维护者手动 psql**,系统侧零代码零端点零权限码;**不解锁 cron 清理**(D-QB-3;`@nestjs/schedule` 的解锁范围不含此,见 R-5);NEXT_TASKS P2-6 ✅ 随 F3 PR 归档。

---

## 5. OTP 登录(F4,C/D 档;防枚举沿找回密码范式)

### 5.1 schema(F4-T1;仅此一行)

| 对象 | 变更 | migration SQL(预期) |
|---|---|---|
| `enum SmsPurpose` | 新增值 `LOGIN`(置于 `PASSWORD_RESET` 之后) | `ALTER TYPE "SmsPurpose" ADD VALUE 'LOGIN';` |

无新表 / 无新字段 / 无 seed 变更;干净库重放 + seed 幂等二跑;schema 注释 purpose 计数 true-up(沿 E-15 先例)。

### 5.2 端点清单(F4-T2)

| # | Method | Path | 鉴权(summary 后缀) | 入参 DTO | 出参 | 说明 |
|---|---|---|---|---|---|---|
| ① | POST | `/api/auth/v1/login-sms/send-code` | `[public]` + `@LoginSmsThrottle()` | `SendLoginSmsCodeDto { phone }` | `{ expiresInSeconds }` | 四无效场景**同泛化 200**(零留痕,镜像找回密码 E-2/E-3);有效 → `issue(purpose=LOGIN, userId=目标用户)`,限频/通道错误照常抛(镜像 E-4) |
| ② | POST | `/api/auth/v1/login-sms` | `[public]` + `@LoginSmsThrottle()` | `LoginSmsDto { phone, code }` | **`LoginResponseDto`(与密码登录同 DTO)** | 校验顺序冻结 E-O5;一切失败统一 24010;成功 = 签发会话(E-O6)+ audit `auth.login.sms` |

contract `EXPECTED_ROUTES` 157→**159**;snapshot diff 纯新增、零删除、零 L3 字样。

### 5.3 工程代决(E-O 系)

| # | 决策 | 内容 |
|---|---|---|
| E-O1 | 文件归属 | 新建 `src/modules/auth/login-sms.service.ts`(镜像 `password-reset.service.ts` 先例);端点挂入既有 `AuthController`(tag `Auth`);DTO 追加 `auth.dto.ts`;`users.service.ts` 零 diff |
| E-O2 | 用户解析口径 | **完全沿找回密码 E-2**:`findFirst({ where: { phone } })` 后判 `deletedAt === null && status === ACTIVE`;四无效场景 = 无匹配 / 未绑定 / DISABLED / 软删 |
| E-O3 | throttler | 新命名实例 `login-sms`(**第 7 实例**)+ `@LoginSmsThrottle()`;IP **5/60s** 默认(goal 拍板值;`LOGIN_SMS_THROTTLE_LIMIT/TTL_SECONDS` 注入,`.env.example` 加注释行);两端点共用实例(计数按 端点×IP);`throttler-biz.guard.ts` 同型扩展(红区文件,本行即拍板覆盖凭据,diff 仅第 7 实例加行);既有六实例零触碰 |
| E-O4 | send-code 防枚举 | 镜像找回密码 E-3:无效号返回与有效号**同形状同值** `{ expiresInSeconds: 300 }`,不写 codes / send_logs、不调 provider、不写 audit;逐字节一致 e2e 断言 |
| E-O5 | 登录校验顺序(冻结) | ① 解析用户(四无效场景 → 24010)→ ② `verifyAndConsume(phone, LOGIN, code, userId)`(码错 `attempts+1` 后 24010;过期/超次/已消费/归属不符同 24010)→ ③ 签发会话(E-O6)。**一切失败统一 `SMS_CODE_INVALID=24010`**(不用 10004——10004 是密码登录防枚举码,语义为「账号或密码错误」,与验证码流不符;两套防枚举体系各自闭合,零新增 BizCode);成功即消费,无 10006 类预检(无新旧密码概念) |
| E-O6 | 会话签发同构(**唯一允许的 auth.service.ts diff**) | `AuthService.login()` 内「签 access + 创建 refresh token 行(family 机制)+ lastLoginAt fire-and-forget + audit + 组装 `LoginResponseDto`」段**抽取为公开方法** `createSession(user, meta, event: 'auth.login' \| 'auth.login.sms')`(纯抽取式重排,逻辑零增删);`login()` 改为「解析校验 → `createSession(..., 'auth.login')`」,`LoginSmsService` 验码后调 `createSession(..., 'auth.login.sms')`。**行为锁**:auth 既有 e2e(login / refresh / logout 系 / P0-E 全组)断言零修改全绿;`JwtPayload` / `LoginResponseDto` / refresh 系 DTO / `JwtStrategy` 零触碰 |
| E-O7 | audit 形状 | `auth.login.sms`(AuditLogEvent union +1,共 31 项):actor = 登录用户 / `resourceType='user'` / extra 镜像 `auth.login`(familyId)**+ `phone`(掩码)+ `codeId`**;登录失败不写 audit(镜像密码登录);send-code 不写 audit(沿 E-11 先例,流水在 `sms_send_logs`) |
| E-O8 | DTO | `SendLoginSmsCodeDto { phone }`(MAINLAND_PHONE_PATTERN)/ `LoginSmsDto { phone, code }`(code 6 位数字,镜像 `BindMyPhoneDto.code`);严格白名单禁夹带;响应**复用 `LoginResponseDto`**(同 DTO,goal 原文);格式错误走全局 ValidationPipe 400(无存在性信息) |
| E-O9 | AGENTS:242 改写(红区,随 F4-T2 PR,before/after 进 PR 描述) | 见 §5.4 |
| E-O10 | 语义边界 | OTP 登录**不**更新 `phoneVerifiedAt`(绑定语义专属);**不**提供「OTP + 密码」二要素(goal 禁止域);登录成功后既有「错 5 次作废 / 单活码 / 60s 间隔 / 日 10 条(全用途合计)」全沿用;`lastLoginAt` 与密码登录同步更新(同一 `createSession` 路径天然保证) |
| E-O11 | 派生层 | `src/modules/auth/CLAUDE.md` 随 PR 校准(端点 + throttler + audit + 防枚举不变式);`docs/security.md` / `ai-harness/README.md` / `srvf-auth-security` skill 的登录契约字样 true-up 归 F6(derived 让步条款) |

### 5.4 AGENTS:242 红区行改写(D-QB-1 解锁;本稿即解锁评审记录)

> 该行 2026-06-11 时点实际位于 `AGENTS.md:243`(§8「登录」节首行;goal 沿用历史行号 242 指称,内容锚定为准)。**红区例外仅此一行**;同节「登录失败防账号枚举」(密码登录四场景 10004)与 §8 其余内容零触碰。

**before**:

```
- v1 入参固定 `username + password`(不支持 email / 手机号 / 验证码登录)
```

**after**:

```
- 密码登录(`POST /api/auth/v1/login`)入参固定 `username + password`(不支持 email 登录 / 不支持在本端点混入手机号或验证码);**验证码(OTP)登录为独立端点** `POST /api/auth/v1/login-sms`(2026-06-11 解锁,冻结评审稿 [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md`](docs/archive/reviews/queue-b-otp-birthday-infra-review.md);防枚举统一 24010,会话签发与密码登录同构),密码登录契约本身零变化
```

### 5.5 行为锁(goal DoD-5 展开)

- 密码登录端点入参 / 响应 / 10004 防枚举四场景 / timing 防御零变化;auth 既有 e2e **断言零修改**全绿。
- P0-E refresh 全部行为冻结(rotation always / family revoke / 90d absolute / 联动撤销五场景);OTP 会话进入同一 refresh family 机制(同构即同一套代码路径)。
- 找回密码两端点与 `PASSWORD_RESET` 流程零变化(purpose 隔离:`LOGIN` 码不能用于重置,反之亦然——`verifyAndConsume` 按 phone+purpose 维度天然隔离,e2e 断言)。
- 既有 7 之 6 throttler 实例配置零触碰;`EXPECTED_ROUTES` 既有 157 行零删除。

---

## 6. 生日祝福(F5,C/D 档;`@nestjs/schedule` 升级路径触发)

### 6.1 依赖与装配(E-B1/E-B3;D-QB-4 展开)

- `@nestjs/schedule` **锁精确版本**(pnpm 解析当日 latest 并钉死,版本号记入 PR 描述与 CHANGELOG;import 仅限 `app.module.ts` 与 `notifications` 模块)
- `ScheduleModule.forRoot()` 于 `app.module.ts` 全局装配(随 F5 实施 PR,goal 已授权)
- **解锁范围冻结**:本仓 `@Cron` 仅生日批一个;新增任何定时任务 = 新 D 档评审(R-5 护栏;retention 不解锁,D-QB-3)

### 6.2 schema(F5-T1;仅此一列)

| 对象 | 变更 | migration SQL(预期) |
|---|---|---|
| `sms_settings` | 新增列 `templateIdBirthday String?`(镜像 `templateIdVerifyCode`,可空) | `ALTER TABLE "sms_settings" ADD COLUMN "templateIdBirthday" TEXT;` |

GET/PATCH `/api/system/v1/sms-settings` DTO 同步暴露该字段(**contract 字段级 diff 仅此一处**;模板 ID 非凭证非 L3,沿 `templateIdVerifyCode` 既有暴露先例);凭证加密体系零触碰。

### 6.3 模块形态(E-B4;G-7 首个落地点)

新 `src/modules/notifications/`:`notifications.module.ts` + `birthday-greeting.service.ts` + `CLAUDE.md`。`@Cron('0 0 9 * * *', { name: 'birthday-greeting', timeZone: 'Asia/Shanghai' })` 为**薄壳**,全部逻辑在公开方法 `runOnce(): Promise<BirthdayRunSummary>`(直调可测,E-B11);零新端点 / 零新权限码。

### 6.4 选取口径(E-B5;D-QB-5 展开)

单查询 JOIN 链(User → Member → MemberProfile),**全部条件同时满足**:

- `MemberProfile.birthDate` 月日 = 今天(**Asia/Shanghai 即固定 UTC+8 日界**,复用 `startOfDayUtc8` 语义;`birthDate` null 自然排除)
- `MemberProfile.deletedAt = null`(profile 未软删)
- `Member.status = ACTIVE && Member.deletedAt = null`
- `User.phone != null && User.status = ACTIVE && User.deletedAt = null`(**仅 `User.phone`**;`MemberProfile.mobile` 永不使用)

**2/29 生日仅闰年当天发**(非闰年不发,不顺延 2/28 或 3/1;KISS 成文,需顺延时单独立项)。

### 6.5 发送与日志(E-B7/E-B9)

- 通道:`SmsProviderRouter` 新公开方法 `sendBirthdayGreeting({ phone })`(镜像 `sendVerifyCode` 形态;模板 ID 取 `settings.templateIdBirthday`);**首版模板零变量**(`params: []`,纯祝福文案;需姓名等变量时改模板单独立项)
- 新逻辑模板键常量 `SMS_TEMPLATE_KEY_BIRTHDAY = 'birthday-greeting'`(写入 `sms_send_logs.templateKey`)
- **job 级前置检查**(任一不满足 → `logger.warn` 一次 + 整批跳过,零行零发送):settings 未配置 / production-like 下 DEV_STUB / `templateIdBirthday` 为空
- **单条失败语义**:provider 抛错 → 写 `sms_send_logs` FAILED 行(errCode/errMsg)→ **不重试、不阻断**,继续下一人;`codeId = null`(非验证码类发送)
- job 收尾 `logger.log` 汇总计数(selected / sent / skippedIdempotent / failed),**全程零明文号码**(`maskPhone`)

### 6.6 幂等防重发(E-B6;goal DoD-6 展开)

发前逐人查:`sms_send_logs` 存在 `{ phone, templateKey: 'birthday-greeting', status: SENT, createdAt >= startOfDayUtc8(now) }` → 跳过(skippedIdempotent)。**重启不重发**(以 DB 为准,无内存状态);FAILED 行不挡重试边界 = 同日重跑会对 FAILED 者再试一次(可接受:FAILED ≠ 已触达;e2e 锁定 SENT 跳过语义)。

### 6.7 审计与隐私(E-B8)

**不进 `audit_logs`**(拍板:运营触达非管理动作,`sms_send_logs` 流水足够);应用日志一律 `maskPhone`;短信内容为静态模板(零变量),无个人信息出仓。

### 6.8 单实例部署前提(E-B12;边界条款)

当前部署 = 单实例容器,`@Cron` 进程级触发即全局唯一;**多实例横向扩容前必须先为生日批加分布式锁(DB advisory lock / 任务表)**,否则双发——此为部署侧边界条款,记入 `docs/deployment.md`(F6 true-up)与模块 CLAUDE.md。

### 6.9 docker-smoke(E-B10;goal DoD-8 展开)

`NotificationsModule` 启动日志锚行(如 `Birthday greeting cron registered (09:00 Asia/Shanghai)`);docker-smoke workflow 加 grep 该锚行步骤(确证 `ScheduleModule.forRoot()` 生产镜像内装配成功且 job 注册)。

---

## 7. 测试计划(goal DoD-7 展开)

- **OTP e2e 新组** `test/e2e/auth-login-sms.e2e-spec.ts`:
  1. 全链:发码(DevStub 888888)→ 登录成功(响应形状 = 密码登录同构:accessToken / refreshToken / user 字段集一致)→ access 调 `/me` → refresh 轮换成功(family 延续)→ logout;`lastLoginAt` 更新断言;audit `auth.login.sms` 行存在且 phone 掩码;
  2. 防枚举:send-code 四无效场景响应体两两 deep-equal + DB 零留痕;登录失败各场景(无效号 / 码错 / 过期 / 已消费 / purpose 错配)统一 24010 响应体一致;
  3. 码错 5 次作废:第 6 次正确码仍 24010;
  4. purpose 隔离:`PASSWORD_RESET` 码登录 → 24010;`LOGIN` 码重置密码 → 24010;
  5. 限流:IP 5/60s 第 6 次 42900(与 `password-reset` / `sms-send` 实例计数隔离);
  6. DISABLED / 软删账号:send-code 泛化 200 + 登录 24010(永不可达 10005/10004)。
- **密码登录回归**:auth 全组(login / refresh / logout / 改密 / password-reset)**断言零修改**全绿(E-O6 行为锁)。
- **生日 unit**(`birthday-greeting.service.spec.ts`):选取 where 构造(六条件)/ 2-29 闰年判定 / UTC+8 日界换算 / 单条失败继续 / 前置检查跳过 / 掩码日志(mock router + prisma)。
- **生日 e2e**(`notifications-birthday.e2e-spec.ts`,**直调** `app.get(BirthdayGreetingService).runOnce()`,不等真实定时):
  1. 造数六类(今天生日全链 ACTIVE / 生日非今天 / Member INACTIVE / User 无 phone / User DISABLED / profile 软删)→ runOnce → `sms_send_logs` 仅第一类有 SENT 行(templateKey=birthday-greeting);
  2. **幂等**:立即二跑 → 零新增行(skippedIdempotent 计数);
  3. settings 未配置 / templateIdBirthday 空 → 整批跳过零行;
  4. summary 计数与 DB 行数一致。
- **contract**:`EXPECTED_ROUTES` +2(157→159,仅 OTP);snapshot diff = 2 新路由 + sms-settings schema ±`templateIdBirthday`,零删除零 L3;`docs:codemap:check` + `docs:rbacmap:check` 0 FAIL。
- **检查链**:每实施 PR 本机 `agent:check:full`(Docker 已确认可用)+ CI 全绿;docker-smoke 锚行步骤(E-B10)。

---

## 8. 任务队列与探针(顺序硬约束;goal §3 原文固化)

| 队列 | 档位 | 范围 | 探针(未满足才做) |
|---|---|---|---|
| F0 | E | v0.20.0 收口(九阶段) | Release Latest=v0.20.0 + Unreleased 空 ✅(2026-06-11 完成:#319 bump / #320 handoff `9116a67` / tag / Release Latest / #321 回填) |
| F1 | A | 本稿冻结 + NEXT_TASKS 状态(P1-7 ②③ / P2-4 / P2-6 标进行中) | 评审稿在 main |
| F2 | D | storage 迁移 PR(§3;纯搬迁禁夹带) | `src/common/storage/` 不存在 + snapshot 零 diff + full 绿 |
| F3 | A | retention SOP PR(§4;SQL app_test 实测记录贴 PR) | SOP 在 main + README §1 已登记 |
| F4 | C/D | OTP:T1 migration(§5.1)→ T2 实施(§5.2-§5.5;可拆 2 PR) | goal DoD-5 全部 |
| F5 | C/D | 生日:T1 依赖+migration(§6.1/§6.2)→ T2 实施(§6.3-§6.9;可拆 2 PR) | goal DoD-6/7 对应项 |
| F6 | E | v0.21.0 收口(九阶段)+ docs 终 true-up(current-state §2/§3/§4 + NEXT_TASKS P1-7 整项闭环 + RBAC_MAP 戳 + 送审清单两模板 + G-7 行注记)+ 终版报告 | goal DoD-1/10 |

LOOP 纪律沿 process §7.1:同一失败修复 ≤2 轮;连续 2 轮零推进熔断;明文码 / 凭证三不;统计数字亲核;每阶段轮报告含「本次未做」。

---

## 9. 本期不做(终版报告必列)

- ❌ 通知退订 / 群发 / 活动通知 / 模板变量(姓名等)/ 通知偏好设置(G-7 统一出口策略仍待 Effect 决议,本期仅单 job 直发)
- ❌ 农历生日 / 2-29 顺延 / 自定义发送时刻
- ❌ 生日发 `MemberProfile.mobile`(拍板⑤:仅 `User.phone`)
- ❌ cron 数据清理(retention 永走手动 SOP,D-QB-3;`@nestjs/schedule` 解锁范围仅生日批)
- ❌ 二要素登录(OTP+密码)/ 图形验证码(重启条件沿找回密码评审稿 §9 全集)/ OTP 自动注册(号码无账号不建号)
- ❌ 新 BizCode / 新权限码 / repository 层 / Redis / queue
- ❌ 多实例分布式锁(单实例前提成文 §6.8,扩容时单独立项)
- ❌ 真实腾讯云凭证录入与真实发送验收(运维接力:[`sms-production-rollout-checklist.md`](../../ops/sms-production-rollout-checklist.md) 届时**两模板一批**送审:验证码 + 生日祝福;F6 更新该清单)
- ❌ storage 迁移夹带任何行为变化 / 重构(纯搬迁)
