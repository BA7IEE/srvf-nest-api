# SRVF 招新一期(招新前段)评审稿(Recruitment Phase-1 Front-Segment Review)

> **状态:冻结**(2026-06-18;goal「招新一期(招新前段)— 报名 + 实名核验 + 临时编号 + 通知」拍板,goal 文本即立项 + 评审授权;**§0.5 四分叉已于 2026-06-18 经维护者元核验全部「按推荐」冻结 + 3 条配套补充**;本稿按 [`process.md §4`](../../process.md) D 档降速产出,冻结后不回改)。
> **业务依据**:goal 原文(自含,维护者已拍板事实)+ `SRVF/01-业务整理/招新需求会_会议包`(讨论稿 v1 / 技术就绪度对照 v1 / 访谈两轮 F01-F29 / 报名表抓取 §3.1)。需求文档不入仓,引用以 goal 原文为准。
> **范式母本**:① `realname/` 通道层**逐层镜像** `wechat/` / `sms/` 通道层(provider 接口 + DevStub 确定性假结果 + 真实腾讯云 provider + settings 单例三端点〔reset 仅 SA〕+ 独立 `*_ENCRYPTION_KEY`+独立 salt);② `recruitment/` 业务镜像 `activity_registrations`(`statusCode` String 状态机 + partial unique)+ `insurances`(模块结构 + 红区登记范式);③ 自助操作审计 `actorUserId` 置空沿技术就绪度对照 T5。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线 / `api-surface-policy.md`(沿 process §6);但在「本期招新范围内的具体设计取舍」上,本稿即冻结决议。

---

## 0. TL;DR

1. **两个新模块,不碰 members**:`src/modules/realname/`(**第 25 模块**,通道层,T2)+ `src/modules/recruitment/`(**第 26 模块**,业务,T3)。报名者**不建 User、不进 members**,身份完全由 `recruitment_applications` 记录承载;临时编号绑报名记录,**永不写入 members 表**。
2. **schema(T1,3 表 + 1 enum)**:`recruitment_cycles`(轮次:后台开关 + 容量 + 临时编号原子计数器 + 通知配置)+ `recruitment_applications`(报名:openid 锚点 + 敏感资料 + 脱敏留存字段 + 状态 + 临时编号)+ `realname_verification_settings`(单例,镜像 `SmsSettings`)+ enum `RealnameProviderType { DEV_STUB, TENCENT_CLOUD }`。`recruitment_applications` **仅一个 FK → cycle**(无 Member FK),从 schema 层保证「临时编号不进 members」。
3. **realname 通道层(T2)**:provider 接口(`verify({name, idCardNumber})`)+ DevStub(确定性两路:匹配 / 不匹配)+ 真实腾讯云 provider(二要素核验,8s 超时沿 G3,**休眠待运维**)+ settings 三端点 + `REALNAME_ENCRYPTION_KEY` 独立 key + 独立 salt(AES-256-GCM,镜像 sms-crypto)。
4. **报名端点(T3)**:报名者经小程序 `wx.login` 取 code →(后端 `code2session` 复用 `WechatService`,**零改 wechat/sms**)→ openid;提交报名(年龄 18-60 从身份证号校验 / 生日自动提取 / 紧急联系人 ≥2 / 证件照)→ **先免费校验 + 去重,通过后才调付费实名核验**(身份证类型走 provider;外籍/护照转**人工待核**)→ 通过则**按序原子发临时 T 编号** + 触发通知。公开侧 2 + admin 轮次/报名管理 + admin 人工待核 resolve + admin 取证件照 signed-URL。
5. **状态机**(镜像 `activity_registrations.statusCode`,String):`pending_verification`(待核验)→ `verified`(核验通过,待巡山培训,移交二期)/ `manual_review`(人工待核,外籍等)/ `rejected`(未通过)。
6. **临时编号**:`T{cycleYear}{seq:04d}`(如 `T20260001`),按**核验通过顺序**发;实现 = `recruitment_cycles.tempNoSeq` 行级原子自增 + `(cycleId, tempNo)` partial unique 兜底;≠ `memberNo`(后者客户端分配、进 members)。
7. **BizCode 两新段**:`27xxx`(实名核验通道,2 码)+ `28xxx`(报名,8 码);亲核 `grep "code: 27/28"` **零命中,段位全空闲**。baseline §1.1 段位表加 2 行(红区,goal 授权,随 T3 PR)。
8. **权限码 +8(128→136)**:5 条 admin 业务码(全绑 biz-admin,42→47;含读 PII + 取证件照同码)+ 3 条 realname settings 码(read/update 绑 ops-admin 61→63,reset 仅 SA 不绑);**自助公开侧零权限码**。
9. **审计**:DB `AuditLogEvent` +5(43→48;含**每次实名核验调用 1 条** + 自助 submit `actorUserId` 置空)+ pino placeholder +2(29→31,admin 读报名 PII + 取证件照图)。手机/身份证/openid 一律掩码。
10. **留存脱敏**:报名记录**两套字段共存**——敏感字段(姓名/身份证号/精确生日/手机/详细住址/证件照/紧急联系人)在「未通过 或 本轮结束 **30 天**后」由**手动 SQL+blob SOP** 清空(**含按 key 删除 storage 对象**,不解锁 cron,沿 SMS retention 范式);脱敏字段(轮次/年龄段/性别/城市到区/来源渠道/淘汰环节/是否外籍)永久保留行级。
11. **公开端点落 `open/v1` 首用**(分叉① 元核验取方案 A):激活预留的 `open/v1` 对外开放面;`@RecruitmentThrottle()`(第 9 throttler)限流。手机字段**仅作通知用途、非身份证据**;身份闸门 = 实名核验 + openid。
12. **零行为漂移**:既有登录契约 / 微信 / sms / app 双 ACTIVE 准入 / attachments / members 一律零 diff;既有 e2e 断言零修改。

---

## 0.5 元核验结论与 4 个架构分叉(2026-06-18 冻结)

> **元核验结论(2026-06-18,维护者)**:四分叉**全部按推荐** ① 启用 `open/v1` 首用(走解锁范式)② 提交期不单独短信验手机 ③ 证件照存 `application.idCardImageKey`(走 storage 层、不进 Attachment)④ 一期含最小人工 resolve 端点。另补 **3 条配套**(写入 E-R-25/26/27 + §4/§6/§11,**不改方向**):①付费核验前先免费校验 + 同轮身份证去重 + 公开端点限流;②证件照 admin 取图走短 TTL signed-URL + 权限门控,留存清理**按 key 删 blob**;③实名核验每次调用入 audit + 显式标注「手机仅通知用途、非身份证据」。本节以下分叉记录冻结存档。

**分叉① · 公开端点 surface — ✅ 方案 A(`open/v1` 首用)**
报名者无 User → 无 JWT;`AppIdentityResolver` 结构上要 JWT+Member(`app/v1` 鉴权豁免路证伪);`open/v1` 标「预留不实现不占用」([api-surface-policy.md §0](../../api-surface-policy.md))。取**方案 A**:激活 `open/v1` 对外开放面(语义最正 + goal 已点名 + 招新后续公开端点干净归宿);红区 = `api-surface-policy.md §0` 一行(open/v1 预留→首用)+ AGENTS 注记,沿 cron/wechat §9 goal 授权解锁范式(§11)。

**分叉② · 提交期短信验手机 — ✅ 方案 A(不单独短信验)**
`SmsCodeService.issue/verify` 硬绑既有 ACTIVE 用户 userId([sms-code.service.ts](../../../src/modules/sms/sms-code.service.ts)),无账号报名者用不了,改之即撞 goal 禁区「禁改 sms」。取**方案 A**:身份强证据 = 实名核验 + openid 锚点;手机仅通知联系方式,提交期不经 SmsCodeService 二次验(配套③ 显式标注「手机非身份证据」)。

**分叉③ · 证件照落地 — ✅ 方案 A(storage key,不进 Attachment)**
现 `Attachment` 上传强制 `uploadedBy` NOT NULL FK→User,无账号走不通;完整接 Attachment = 新 ownerType+8 码+配置三表(保险评审稿 E-20 判「D 档禁顺手做」)。取**方案 A**:multipart 收图 → `StorageProvider`(AES-256-GCM)→ key 写 `idCardImageKey`,不经 Attachment 表/不接 RBAC;「证件照走 attachments」按『走附件保险柜(storage 层)』落实(配套② 补 admin signed-URL 取图 + blob 删除)。

**分叉④ · 人工待核 resolve — ✅ 方案 A(一期含最小 resolve 端点)**
外籍/护照 → `manual_review`。取**方案 A**:一期含 `POST admin/.../:id/resolve`(人工通过→发号 / 不通过→拒),外籍是有效报名者需出口闭环;增量仅 1 端点 + 1 码 + 1 审计。

---

## 1. 决策汇总表

### 1.1 goal 已拍板项(D-R;冻结,不重开)

| # | 决策 |
|---|---|
| D-R-1 | **两层身份**:报名者不建 User、不进 members;招新报名独立承载;临时编号绑报名记录,**永不进 members**(转永久 = 二期建 User+Member,本 goal 范围外) |
| D-R-2 | **身份锚点**:小程序 `wx.login` → code → `code2session`(复用 `WechatService`,零改 wechat/sms)→ openid;openid = 再查询锚点 + 同轮去重次级键;实名核验 = 身份强证据(分叉②A);**手机仅通知用途、非身份证据**(配套③) |
| D-R-3 | **3 表 + 1 enum**:`recruitment_cycles` / `recruitment_applications` / `realname_verification_settings` + `RealnameProviderType`;`recruitment_applications` 仅 FK→cycle,无 Member FK(D-R-1 的 schema 保证) |
| D-R-4 | **状态机**:`pending_verification` → `verified`(待巡山培训,移交二期)/ `manual_review`(外籍等)/ `rejected`;String 沿 `activity_registrations.statusCode` 范式 |
| D-R-5 | **临时编号** `T{cycleYear}{seq:04d}`,按核验通过顺序发,行级原子自增 + partial unique 兜底;≠ memberNo |
| D-R-6 | **实名核验**:能接的真接(腾讯云二要素 name+idCardNumber);外籍/港澳/护照走人工(`manual_review`);自报姓名+身份证号,provider 判匹配 |
| D-R-7 | **失败者数据脱敏行级留存**:留 轮次/年龄段/性别/城市到区/来源渠道/淘汰环节/是否外籍;删 姓名/身份证号/证件照/手机/紧急联系人/精确生日/详细住址;**未通过 或 本轮结束 30 天后**清敏感字段(手动 SOP,不解锁 cron) |
| D-R-8 | **本 goal 只做一期(招新前段)**:二期(巡山培训门槛/综合评定/公示/发永久编号)+ 三期(入队 10 项/部门/级别 1-7 APD 调级)**不在范围** |
| D-R-9 | **招新自助走小程序**(2026-06-18 维护者拍板正式启动「招新自助小程序化」,解除 current-state §3 / wechat 评审稿 §12 缓置);本仓只出 app/核验端点,小程序前端是另一项目 |
| D-R-10 | **一轮 = 每年一个完整招新流程,可跨年**;轮次后台开/关 + 可临时增容(容量) |
| D-R-11 | **通知**:可配置模板(文案/QQ群/见面会信息**后填**)+ 小程序内展示所需数据 + 可选短信(复用 sms infra);真实文案/凭证后填,通道休眠 |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 代决 | 依据 |
|---|---|---|
| E-R-1 | 表名 `@@map` snake 复数(`recruitment_cycles` / `recruitment_applications` / `realname_verification_settings`),model 名 `RecruitmentCycle` / `RecruitmentApplication` / `RealnameVerificationSettings` | 沿 sms/wechat/insurance 近期惯例;goal 表名即 snake 形 |
| E-R-2 | `realname/` 通道层逐层镜像 `wechat/`:provider 接口 + DevStub + 真实 provider + `RealnameSettingsService`(60s 缓存 / 三态 credentialStatus / reset 仅 SA)+ `RealnameCryptoService`(AES-256-GCM + scrypt **独立 salt `srvf-realname-key-derivation-salt-v1`**) | wechat-crypto / sms-crypto 范式 |
| E-R-3 | 凭证两段(`secretId` + `secretKey`,镜像 `SmsSettings`,**非** wechat 单段 appSecret);腾讯云实名核验走 secretId/secretKey | 腾讯云 SDK 凭证形态 = secretId+secretKey |
| E-R-4 | `REALNAME_ENCRYPTION_KEY` 独立 env:production/smoke fail-fast(≥32 字符),dev/test 留空允许;`.env.example` + `docker-smoke.yml` 各加一行(**docker-smoke 锚行** = DoD 显式项) | 镜像 `parseWechatEncryptionKey`(app.config.ts) |
| E-R-5 | 真实 provider 走腾讯云 SDK(实名核验)或原生 fetch + 8s `AbortController`(沿 #346 外部请求 8s 上限 / wechat E-2);DevStub 非 production-like 确定性两路,production-like 写入口 + 运行时双重禁用 | 沿 wechat DevStub E-10 / 双重校验 E-15 |
| E-R-6 | DevStub 确定性两路:身份证号校验位为偶 → `matched`、为奇 → `mismatch`(T2 定常量);**外籍由 documentTypeCode 在 provider 前判定 → `manual_review`,不到 provider** | goal「DevStub 两路」+ 外籍走人工 |
| E-R-7 | `recruitment/` 业务模块**消费** `realname/`(单向 import,镜像 activity-registrations→insurances);另 import `WechatModule`(code2session)/ `StorageModule`(证件照 key + signed-URL)/ `SmsModule`(可选通知,通道休眠) | 防环单向依赖 |
| E-R-8 | `statusCode` 用 String(非 Prisma enum),字典/常量映射 4 值 | 沿 `activity_registrations.statusCode` 既成范式(ops 可扩,免 migration) |
| E-R-9 | 临时编号 = `recruitment_cycles.tempNoSeq Int @default(0)` 事务内 `update … set tempNoSeq = tempNoSeq + 1` 原子自增取号 → `T{year}{seq:04d}`;`(cycleId, tempNo) WHERE tempNo IS NOT NULL` partial unique 兜底并发 | 行级自增天然串行,免「取 max+1」竞态;就绪度对照 T2 复合唯一精神 |
| E-R-10 | 防重复报名 = `(cycleId, idCardNumber) WHERE deletedAt IS NULL AND statusCode != 'rejected'` partial unique(migration SQL 末尾手写;P2002 兜底 → 28003);**允许 rejected 后同轮重试**(实名错填可纠) | 逐字镜像 `activity_registrations_activity_member_active_unique`(!= cancelled) |
| E-R-11 | 至多一个 `open` 轮次:service 层强校验(开新轮拒已有 open);提交报名落**当前唯一 open 轮**,无 open 轮 → 28030 | 「同轮」语义需唯一当前轮;最小机制(不引单行 partial unique) |
| E-R-12 | 年龄 18-60 校验 = service 层从身份证号提取生日 → 计算周岁(北京日界)→ 越界抛 28010;身份证号格式(18 位 + 校验位)走 DTO `@Matches` + 校验位算法,格式错 → 通用 422 校验失败 | goal「18-60 从身份证号校验 / 生日自动提取」 |
| E-R-13 | 紧急联系人 ≥2 = DTO `@ArrayMinSize(2)`(通用 422 校验失败,不新增 BizCode);存 `emergencyContacts Json`(数组 `[{name, relation, phone}]`),敏感留存清空 | goal「紧急联系人 ≥2 校验」;就绪度对照 T3 单表承载 |
| E-R-14 | 脱敏留存双套字段:敏感字段全 nullable(留存 SOP NULL 化),脱敏字段提交时派生(ageGroup 从生日 / cityDistrict 从住址)落库,survive 清理 | D-R-7 展开;§6 |
| E-R-15 | 证件照存 `idCardImageKey String?`(分叉③A);提交期 multipart → `StorageProvider`(AES-256-GCM)落 key;缺图 → 28011;**不经 Attachment 多态表/不接 RBAC** | §0.5③ |
| E-R-16 | 报名提交核验编排(§4):纯校验(DTO) → open 轮/容量 → 年龄 → `code2session`(免费) → **同轮去重预检** → **才调付费 `realname.verify`**(外籍跳过);外部调用全置事务外 | 镜像 wechat-bind 校验顺序 + AGENTS §12 + 配套① 成本纪律 |
| E-R-17 | 通知配置落 `recruitment_cycles`(`meetingInfo` / `qqGroup` / `notifyTemplate Json`,nullable,后填);**不动 `sms_settings` schema**;小程序展示读 cycle + application;SMS 通知为可选休眠 hook(模板/凭证后填,沿真实通道休眠) | D-R-11;免触 sms 禁区(分叉② 同源) |
| E-R-18 | BizCode `27xxx`(realname 通道 2 码)+ `28xxx`(报名 8 码),亲核空闲(§3.3);号位细分在 T3 最终定,段位本稿冻结 | 沿 24/25/26xxx 收口范式 |
| E-R-19 | 权限码 +8(128→136):5 admin 业务(全绑 biz-admin 42→47)+ 3 realname settings(read/update 绑 ops-admin 61→63,reset 仅 SA 不绑);自助侧零码;取证件照图复用 `recruitment-application.read.record`(不另加码) | 镜像 insurance(全绑 biz-admin)+ sms/wechat settings(reset 不绑)+ certificates 附件读复用 read 码 |
| E-R-20 | 审计:DB union +5(43→48)+ placeholder +2(29→31);手机/身份证/openid 一律掩码;submit `actorUserId` 置空,context 记掩码自助凭据 | 就绪度对照 T5 + sms/wechat 掩码范式 + 配套③ |
| E-R-21 | 模块结构:`realname/` 解锁 `providers/` 子目录(仅本模块本子目录,沿 sms/wechat 第三/四例);`recruitment/` 平铺 + `controllers/`(公开)+ `dto/`(public DTO 禁派生) | AGENTS §2 已解锁例外延用 |
| E-R-22 | seed 计数同步:`seed-biz-admin.e2e-spec.ts` +5 / `biz-admin.fixture.ts` +5;ops-admin 期望集 +2;RBAC_MAP 128→136 随 T2 PR true-up;T1/T2 间孤码 rbacmap WARN 预期(镜像 wechat T2) | 守护脚本口径 |
| E-R-23 | CODEMAP 模块数 +2(24→26,realname T2 + recruitment T3 各 +1);realname/recruitment **不**建模块级 CLAUDE.md(8 个存量名单不扩,沿 wechat E-30) | codemap check 守护 |
| E-R-24 | 真实通道休眠:realname 腾讯云 provider 正确但休眠(DevStub 全验);运维 SOP `docs/ops/realname-verification-rollout-checklist.md`(T4 出);腾讯云实名核验产品开通 + 凭证录入 + 真实核验由运维接力 | 镜像 sms/wechat/cos rollout checklist 范式 |
| **E-R-25** | **配套① 成本纪律 + 限流**:付费 `realname.verify` 是**最后一道闸**——前置全部免费校验(DTO 身份证格式/年龄越界/紧急联系人≥2/证件照存在 + service 周岁 + open 轮/容量)+ **同轮身份证去重预检**全通过后才调;`@RecruitmentThrottle()`(**第 9 throttler 实例** IP n/60s,沿命名 throttler 范式)挂两个公开端点;外籍由证件类型在 verify 前分流(根本不调付费核验) | 维护者 2026-06-18 配套①;省付费核验调用 + 防刷 |
| **E-R-26** | **配套② 证件照取图 + 留存删 blob**:admin 取图 `GET admin/v1/recruitment-applications/:id/id-card-image-url` 返**短 TTL signed-URL**(L3,永不入日志/snapshot/audit detail)+ `recruitment-application.read.record` 门控 + placeholder 审计 `recruitment-application.id-card-image.read`(镜像 `certificate.attachment.read`);**留存清理 SOP 必须按 key 删除 storage blob**(经 `StorageProvider.delete` / COS 工具,纯 SQL 不可达对象),再 NULL `idCardImageKey` | 维护者 2026-06-18 配套②;PII 图最小暴露 + 真删 |
| **E-R-27** | **配套③ 核验调用审计 + 手机定性**:每次 `realname.verify` 调用 → DB 审计 `recruitment-application.realname-verify`(**独立写,紧随 provider 返回、主事务前提交**,确保每次付费调用必留痕;actor 置空;extra `{idCard:掩码, name:掩码, outcome}`);评审稿与代码注释**显式标注「手机仅通知用途、非身份证据」**(身份闸门 = 实名核验 + openid) | 维护者 2026-06-18 配套③;合规取证 + 身份语义防混 |

---

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ T1:3 新表 + 1 新 enum(`RealnameProviderType`);**无 Member/User 反向关系**(D-R-1) |
| 是否新增 migration | ✅ T1 一个(**第 19 个**;命名 `2026MMDDHHMMSS_add_recruitment_phase1`);含手写 partial unique ×2;**纯新增,无破坏性,无历史数据回填** |
| 是否修改 `prisma/seed.ts` | ✅ T2:+8 权限码(5 绑 biz-admin / 2 绑 ops-admin / 1 不绑);既有码 / 绑定 / 角色零变化;realname settings 无 seed 行(运行时 upsert) |
| 是否影响现有数据 | ❌(全部新增;不碰任何既有表/列/enum) |
| 是否不可逆 | enum value 增加在 PG 不可简单回收(沿 SmsPurpose+LOGIN/WECHAT_BIND 先例接受);其余可逆(drop 三表) |
| 是否影响 OpenAPI / contract snapshot | ✅ T2 settings 3 端点 + T3 公开/admin 10 端点;**仅新增,零删改,零 L3** |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 权限码 128→136;AuditLogEvent union 43→48 + placeholder 29→31;**JwtPayload / auth 模块 / Guard 链 / AppIdentityResolver 零碰** |
| 是否需要新增 BizCode | ✅ 27xxx(2)+ 28xxx(8);baseline §1.1 红区加 2 行(T3,逐行进 PR,#294 范式) |
| 是否需要新增 env / docker-smoke | ✅ `REALNAME_ENCRYPTION_KEY`(.env.example + docker-smoke 锚行;DoD 显式项) |
| 是否触碰 api-surface-policy 红区 | ✅ **分叉①A**:`open/v1` 首用 = 政策红区(T3 PR,§11);沿 cron/wechat §9 goal 授权解锁范式 |
| 是否需要用户拍板 | ✅ goal 已立项 + 授权;§0.5 四分叉 2026-06-18 元核验全冻结 |

---

## 3. 五张清单

### 3.1 schema(T1;以下字段集 = 本稿冻结候选,Q7 报名表精简结论可在 T1 微调但表/状态/留存语义不变)

```prisma
// ① 招新轮次
model RecruitmentCycle {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  year       Int     // 招新年份(临时编号 T{year}{seq} 的 year)
  name       String  // 轮次名(如「2026 年度招新」);长度由 DTO 约束
  statusCode String  // open / closed(后台开关;String 沿 activity 范式)
  capacity   Int?    // 容量上限(可临时增容;null=不限)
  tempNoSeq  Int     @default(0) // 临时编号原子计数器(发号时 +1;E-R-9)
  openedAt   DateTime?
  closedAt   DateTime?

  // 通知配置(后填;小程序展示 + 可选短信文案;E-R-17)
  meetingInfo    String? // 见面会信息
  qqGroup        String? // QQ 群
  notifyTemplate Json?   // 可配置通知模板(各节点文案)

  applications RecruitmentApplication[]

  @@index([year])
  @@index([statusCode])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("recruitment_cycles")
}

// ② 招新报名(报名者无 User/Member;身份全由本表承载)
model RecruitmentApplication {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  cycleId    String
  statusCode String  // pending_verification / verified / manual_review / rejected
  tempNo     String? // 临时编号 T{year}{seq};仅 verified 有值;≠ memberNo

  openid     String? // 微信 openid(code2session;再查询 + 同轮去重次级;掩码回显)

  // ===== 敏感资料(留存 SOP 30 天后 NULL 化 + blob 删除;§6)=====
  realName          String?
  idCardNumber      String?   // 身份证号(高敏感;同轮去重键;留存清)
  birthDate         DateTime? // 精确生日(从身份证号提取;留存清)
  phone             String?   // 手机(仅通知联系方式,非身份证据;留存清)
  detailedAddress   String?   // 详细住址(留存清)
  idCardImageKey    String?   // 证件照 storage key(分叉③A;留存按 key 删 blob)
  emergencyContacts Json?     // 紧急联系人 ≥2:[{name, relation, phone}](留存清)
  profileExtra      Json?     // 其余报名字段(Q7 精简后冻结,本期最小;留存清)

  // ===== 脱敏留存字段(永久行级保留;§6)=====
  documentTypeCode String  // 证件类型(判外籍/人工;非高敏)
  isForeigner      Boolean @default(false)
  genderCode       String?
  ageGroup         String? // 年龄段(提交时从生日派生)
  cityDistrict     String? // 城市到区(提交时从住址派生)
  sourceChannel    String? // 来源渠道
  eliminationStage String? // 淘汰环节(rejected 时记)

  // 核验/人工记账
  verifiedAt        DateTime?
  verifyOutcome     String?   // matched / mismatch / manual / skipped
  reviewedByUserId  String?   // 人工 resolve 操作人(admin;不建外键,沿 settings.updatedBy)
  reviewedAt        DateTime?
  reviewNote        String?
  sensitivePurgedAt DateTime? // 留存清理(字段 NULL + blob 删)执行时刻

  cycle RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Restrict)

  // partial unique(migration SQL 末尾手写,E-R-9/10):
  //   recruitment_applications_cycle_idcard_active_unique ON (cycleId, idCardNumber) WHERE deletedAt IS NULL AND statusCode != 'rejected'
  //   recruitment_applications_cycle_tempno_unique        ON (cycleId, tempNo)        WHERE tempNo IS NOT NULL
  @@index([cycleId])
  @@index([statusCode])
  @@index([openid])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("recruitment_applications")
}

// ③ 实名核验设置(单例,镜像 SmsSettings;singleton 由 Service 层保证)
model RealnameVerificationSettings {
  id String @id @default(cuid())

  providerType RealnameProviderType
  enabled      Boolean @default(true)

  region             String? // 腾讯云 region
  secretIdEncrypted  String? // AES-256-GCM;明文永不入库
  secretKeyEncrypted String? // 同上
  credentialConfigured Boolean @default(false)

  remarks   String?
  updatedBy String? // User.id;不建外键(沿 SmsSettings)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@map("realname_verification_settings")
}

enum RealnameProviderType {
  DEV_STUB     // 非生产联调:确定性两路(E-R-6;production-like 不可达)
  TENCENT_CLOUD
}
```

### 3.2 端点清单(T2 settings 3 + T3 公开 2 + admin 8;`open/v1` = 分叉①A)

| # | T | Method Path | 鉴权后缀 | 说明 |
|---|---|---|---|---|
| 1 | T2 | `GET system/v1/realname-settings` | `[rbac: realname-setting.read.singleton]` | 不存在返 data=null;永不回显凭证;含 credentialStatus 三态 |
| 2 | T2 | `PATCH system/v1/realname-settings` | `[rbac: realname-setting.update.singleton]` | upsert 缺省 DEV_STUB;production-like 拒 DEV_STUB;拒凭证字段 |
| 3 | T2 | `POST system/v1/realname-settings/reset-credentials` | `[rbac: realname-setting.reset.credentials]` | **仅 SA 短路**;`{secretId, secretKey}` AES-256-GCM 落库;upsert 缺省 TENCENT_CLOUD |
| 4 | T3 | `POST open/v1/recruitment/applications` | `[public]` + `@RecruitmentThrottle()` | 报名提交(multipart:profile + 证件照);校验流程 §4;返申请状态(+临时编号) |
| 5 | T3 | `POST open/v1/recruitment/applications/query` | `[public]` + `@RecruitmentThrottle()` | 凭新 `wx.login` code→openid→查本人当前轮申请(状态/临时编号/通知展示);防枚举:仅返 openid 匹配项 |
| 6 | T3 | `GET admin/v1/recruitment-cycles` | `[rbac: recruitment-cycle.read.record]` | 分页 |
| 7 | T3 | `POST admin/v1/recruitment-cycles` | `[rbac: recruitment-cycle.create.record]` | 建轮(默认 closed,显式开) |
| 8 | T3 | `GET admin/v1/recruitment-cycles/:id` | `[rbac: recruitment-cycle.read.record]` | 详情 |
| 9 | T3 | `PATCH admin/v1/recruitment-cycles/:id` | `[rbac: recruitment-cycle.update.record]` | 开/关 + 容量 + 通知配置(E-R-11 唯一 open) |
| 10 | T3 | `GET admin/v1/recruitment-applications` | `[rbac: recruitment-application.read.record]` | 分页(按 cycle/status 过滤);读 PII → placeholder 审计 |
| 11 | T3 | `GET admin/v1/recruitment-applications/:id` | `[rbac: recruitment-application.read.record]` | 详情(PII;掩码策略见 §6) |
| 12 | T3 | `POST admin/v1/recruitment-applications/:id/resolve` | `[rbac: recruitment-application.resolve.manual]` | 分叉④A:人工待核 → 通过(发号)/ 不通过;非 manual 态 → 28040 |
| 13 | T3 | `GET admin/v1/recruitment-applications/:id/id-card-image-url` | `[rbac: recruitment-application.read.record]` | 配套②:短 TTL signed-URL(L3);placeholder 审计 `id-card-image.read` |

Tag:`Ops - Realname Settings` / `Recruitment - Applications`(公开)/ `Admin - Recruitment Cycles` / `Admin - Recruitment Applications`。contract `EXPECTED_ROUTES` 183 → T2 186 → T3 **196**(逐 PR 显式登记,仅新增)。

### 3.3 BizCode(27xxx realname + 28xxx recruitment;2026-06-18 亲核:`grep "code: 27/28" biz-code.constant.ts` **零命中**;baseline §1.1 `270xx-290xx` 未规划预留)

| code | 常量 | http | 落点 |
|---|---|---|---|
| 27030 | `REALNAME_CHANNEL_NOT_CONFIGURED` | 503 | settings 缺失/未启用/凭证非 CONFIGURED/production-like DEV_STUB(XX030 通道段) |
| 27031 | `REALNAME_API_FAILED` | 502 | provider 调用异常/超时/响应异常(XX031) |
| 28001 | `RECRUITMENT_CYCLE_NOT_FOUND` | 404 | admin 轮次不存在 |
| 28002 | `RECRUITMENT_APPLICATION_NOT_FOUND` | 404 | admin/查询 申请不存在 |
| 28003 | `RECRUITMENT_DUPLICATE_APPLICATION` | 409 | 同轮同人(E-R-10;P2002 兜底同码) |
| 28010 | `RECRUITMENT_AGE_OUT_OF_RANGE` | 400 | 周岁 <18 或 >60(E-R-12) |
| 28011 | `RECRUITMENT_ID_CARD_IMAGE_REQUIRED` | 400 | 证件照缺(E-R-15) |
| 28030 | `RECRUITMENT_CYCLE_NOT_OPEN` | 409 | 无 open 轮 / 轮次已关(轮次开关) |
| 28031 | `RECRUITMENT_CYCLE_CAPACITY_FULL` | 409 | 容量已满(capacity 非 null 且达上限) |
| 28040 | `RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL` | 409 | resolve 非 manual_review 态(分叉④A) |

**不开**:`271xx/281xx FORBIDDEN_*`(权限拒绝走通用 30100/40300);实名核验「不匹配」**不是 BizCode**(是 verify 结果,驱动 `rejected` 态);身份证号格式错 / 紧急联系人<2 走通用 422 校验失败(E-R-12/13)。baseline §1.1 红区加 2 行随 T3 PR(§11)。

### 3.4 权限码(8 条;T2 seed;自助公开侧零码)

| code | module / action / resourceType | 绑定 | 用途 |
|---|---|---|---|
| `realname-setting.read.singleton` | realname-setting / read / singleton | ops-admin ✅ | 端点 1 |
| `realname-setting.update.singleton` | realname-setting / update / singleton | ops-admin ✅ | 端点 2 |
| `realname-setting.reset.credentials` | realname-setting / reset / credentials | ❌(仅 SA 短路,镜像 sms/wechat D2=A) | 端点 3 |
| `recruitment-cycle.read.record` | recruitment-cycle / read / record | biz-admin ✅ | 端点 6/8 |
| `recruitment-cycle.create.record` | recruitment-cycle / create / record | biz-admin ✅ | 端点 7 |
| `recruitment-cycle.update.record` | recruitment-cycle / update / record | biz-admin ✅ | 端点 9 |
| `recruitment-application.read.record` | recruitment-application / read / record | biz-admin ✅ | 端点 10/11/**13**(读 PII + 取证件照图共用) |
| `recruitment-application.resolve.manual` | recruitment-application / resolve / manual | biz-admin ✅ | 端点 12(分叉④A) |

权限码全集 128→**136**;biz-admin 42→**47**(+5);ops-admin 61→**63**(+2);member 9 零变化。

### 3.5 audit 事件

**DB `AuditLogEvent` union +5(43→48;T3 接入)**:

| 事件 | 触发 | actor | resourceType / resourceId | extra(掩码) |
|---|---|---|---|---|
| `recruitment-cycle.create` | admin 建轮 | 操作人 | recruitment-cycle / 轮 id | after |
| `recruitment-cycle.update` | admin 开关/容量/通知配置 | 操作人 | 同上 | before/after |
| `recruitment-application.submit` | **公开提交**(自助) | **置空** | recruitment-application / 申请 id | `{cycleId, phone:掩码, openid:掩码, idCard:掩码, createStatus}` |
| `recruitment-application.realname-verify` | **每次实名核验调用**(配套③;独立写,主事务前) | **置空** | recruitment-application / 申请 id | `{idCard:掩码, name:掩码, outcome, tempNo?}` |
| `recruitment-application.resolve-manual` | admin resolve(分叉④A) | 操作人 | 同上 | before/after status;`{tempNo?, eliminationStage?}` |

**pino `auditPlaceholder` union +2(29→31)**:
- `recruitment-application.read.other`(admin 读报名 PII;镜像 `certificate.read.other` / `member-insurance.read.other`)
- `recruitment-application.id-card-image.read`(admin 取证件照 signed-URL;镜像 `certificate.attachment.read`,配套②)

**不写**:自助 query 读(防枚举泛化)/ 轮次列表读(配置台账类,沿 contribution-rules)/ 任何明文凭证/身份证号/证件照 URL(L3)。

---

## 4. 报名核验流程冻结(实施不得调换;配套① 成本纪律 = 付费核验最后调)

**提交报名 `POST open/v1/recruitment/applications`(E-R-16/25)**——顺序即「免费在前、付费在后」:
1. **DTO 校验**(controller,框架,免费):身份证号格式+校验位 / 紧急联系人 ≥2 / 证件照存在 / 必填 → 通用 422。
2. **当前 open 轮解析**(cheap DB):无 open 轮 → 28030;容量满 → 28031。
3. **年龄 18-60**(纯,从身份证号提取生日算周岁)→ 越界 28010。
4. **`code2session(wechatCode)`**(免费 wechat 网络;失败 → 沿 wechat 25030/25031)→ openid。
5. **同轮去重预检**(DB):`(cycleId, idCardNumber)` 活跃且非 rejected 已存在 → 28003。
6. **证件照落库**:multipart 文件 → `StorageProvider` → `idCardImageKey`(失败不建申请)。
7. **tx1**:create application(`pending_verification`〔大陆证件〕/ `manual_review`〔外籍,证件类型在此分流〕+ openid + 敏感资料 + 派生脱敏字段 + idCardImageKey)+ 去重 unique 强制(P2002→28003)+ audit `recruitment-application.submit`(actor 置空)。
8. **付费实名核验**(仅大陆证件;事务外):`realname.verify({name, idCardNumber})`(通道不可用 27030 / API 异常 27031)→ `matched` / `mismatch`。
9. **核验调用审计**(配套③;独立写,紧随返回):DB audit `recruitment-application.realname-verify`(每次付费调用必留痕,outcome)。
10. **tx2**(仅大陆证件):
    - `matched` → `verified` + **原子发号**(`tempNoSeq+1` → `T{year}{seq}`;P2002→重试)+ 记 tempNo 入 verify audit extra;
    - `mismatch` → `rejected`(eliminationStage='realname')。
11. **事务后**:触发通知(小程序展示数据已落库;可选 SMS 为休眠 hook,非阻塞,失败不回滚,沿生日批)。

> 外籍路径:步骤 7 直接落 `manual_review`,**不进 8-10**(根本不调付费核验);出口 = 人工 resolve。

**人工 resolve `POST admin/.../:id/resolve`(分叉④A)**:非 `manual_review` → 28040;通过 → `verified` + 原子发号 + audit `resolve-manual`;不通过 → `rejected`(eliminationStage='manual')+ audit。

**查询 `POST open/v1/recruitment/applications/query`**:`code2session` → openid → 查当前轮 openid 匹配申请 → 返状态/临时编号/通知展示(cycle.meetingInfo/qqGroup/notifyTemplate);无匹配 → 空(不泄露他人,防枚举沿 self-scope 范式)。

---

## 5. 模块结构(AGENTS §2 已解锁例外内)

```
src/modules/realname/                          # 第 25 模块(T2;镜像 wechat/sms 通道层)
├── realname.module.ts                         # exports RealnameVerificationService, RealnameSettingsService
├── realname.service.ts                        # resolve(内联 router)+ verify + 域错误→BizCode 映射
├── realname-settings.controller.ts            # 端点 1-3
├── realname-settings.service.ts               # 镜像 sms-settings(60s 缓存 / rbac.can / 三态)
├── realname-crypto.service.ts                 # 镜像 sms-crypto(独立 salt,E-R-2)
├── realname.dto.ts / realname.types.ts / realname.constants.ts
└── providers/
    ├── dev-stub.provider.ts                   # 确定性两路(E-R-6)
    └── tencent-realname.provider.ts           # 真实(SDK 或 fetch+8s);含 spec(mock)

src/modules/recruitment/                       # 第 26 模块(T3;业务)
├── recruitment.module.ts                      # imports RealnameModule / WechatModule / StorageModule / SmsModule / PermissionsModule / AuditLogsModule
├── recruitment-cycles.controller.ts           # admin 端点 6-9
├── recruitment-cycles.service.ts              # 轮次 CRUD + open 唯一 + rbac.can + audit
├── recruitment-applications.admin.controller.ts # admin 端点 10-13
├── recruitment-applications.service.ts        # 提交编排(§4)+ 发号 + resolve + signed-URL + audit
├── controllers/
│   └── recruitment-public.controller.ts       # 公开端点 4-5(multipart 提交 + 查询)
├── recruitment.dto.ts / recruitment.types.ts / recruitment.constants.ts
└── dto/                                        # public DTO 独立,禁派生
```

跨模块:`recruitment` → `realname` / `wechat` / `storage` / `sms`(单向);`realname` / `recruitment` **不**被既有模块 import(叶子)。

---

## 6. 敏感字段三问 + 脱敏留存(AGENTS §18.4 + D-R-7)

1. **业务用途**:`realName` / `idCardNumber` = 实名核验二要素 + 同轮去重;`phone` = **仅通知联系方式,非身份证据**(配套③;身份闸门 = 实名核验 + openid);`emergencyContacts` / `birthDate` / `detailedAddress` / `idCardImageKey` = 入队准入资料(goal 硬门槛照收);脱敏字段 = 招新统计/复盘(年龄段/性别/城市/渠道/淘汰环节/外籍分布)。
2. **查看角色与掩码**:本人(自助 query,凭 openid)+ 持 `recruitment-application.read.record` 的管理面(biz-admin 默认含)。**身份证号/手机在 admin 列表掩码、详情可全显**(沿 certificates `certNumber` 可见性,审计 placeholder 兜底);**证件照**仅经 admin **短 TTL signed-URL**(配套②;URL = L3,不入日志/snapshot/audit detail);**`RealnameVerificationSettings.secret*Encrypted` = L3,任何角色不可见**(reset 仅返 credentialStatus);openid 一律掩码。
3. **保存期限(D-R-7 脱敏留存)**:
   - **敏感字段**(`realName` / `idCardNumber` / `birthDate` / `phone` / `detailedAddress` / `emergencyContacts` / `profileExtra`)在「**`rejected` 或 本轮 `closed` 后满 30 天**」由**手动 SQL SOP** NULL 化 + 置 `sensitivePurgedAt`;
   - **证件照 blob**(配套②):同期**按 `idCardImageKey` 删除 storage 对象**(经 `StorageProvider.delete` / COS 工具,**纯 SQL 不可达对象**),再 NULL `idCardImageKey`;
   - **脱敏字段**(`cycleId`/`isForeigner`/`genderCode`/`ageGroup`/`cityDistrict`/`sourceChannel`/`eliminationStage`)**永久行级保留**;
   - **不解锁 cron**:沿 [`ops/sms-data-retention-sop.md`](../../ops/sms-data-retention-sop.md) 范式,T4 出 `ops/recruitment-data-retention-sop.md`(季度例行 + 报警线;备份→预数→**删 blob**→UPDATE NULL→复核 强制顺序);**新增任何定时任务 = 新 D 档评审**。

---

## 7. 既有行为锁(实施期间任何一条破坏 = 停下报告)

1. 既有登录契约(密码/OTP/微信/refresh/logout)+ `JwtPayload` zero drift + auth 既有 e2e 断言**零修改**全绿。
2. **sms 模块零 diff**(分叉②A 不动 `SmsCodeService`/`sms_settings`);**wechat 模块零 diff**(仅 `WechatService.code2session` 只读复用);**attachments 模块零 diff**(分叉③A 不走 Attachment 表);**members / member-profiles / activity-registrations 零 diff**。
3. `AppIdentityResolver` / 既有 throttler / RolesGuard / ResponseInterceptor 零碰;新 throttler(`@RecruitmentThrottle()` 第 9 实例)只增不改。
4. contract snapshot **仅新增**(settings 3 + 公开/admin 10),零删改、零 L3。
5. seed 既有码与绑定零变化;biz-admin 仅 +5 / ops-admin 仅 +2;`docs:rbacmap:check` / `docs:codemap:check` 各阶段 0 FAIL(T1/T2 间孤码 WARN 预期)。
6. **临时编号永不出现在 `members` 表 / `Member.memberNo`**(schema 层 `recruitment_applications` 无 Member FK 已保证;e2e 显式断言 members 计数零增长)。

---

## 8. 测试计划(DoD 展开)

- **T1**:`seed-biz-admin.e2e-spec.ts` 期望 +5 / ops-admin 期望 +2 断言绿;干净库 `prisma migrate deploy` 重放 19/19;seed 幂等二跑;partial unique ×2 落地验证。
- **T2 unit + e2e**:`realname-crypto.service.spec`(roundtrip/篡改/key 缺失)/ `providers/dev-stub.provider.spec`(确定性两路)/ `providers/tencent-realname.provider.spec`(mock:成功匹配 / 不匹配 / 超时→27031 / 通道错→27030);`realname-settings.e2e-spec.ts`(三端点 RBAC 边界〔reset 仅 SA〕/ 凭证永不回显 / upsert 缺省 / production-like 拒 DEV_STUB)。
- **T3 e2e**(DoD 逐条):`recruitment-application.e2e-spec.ts`——报名全链(提交→DevStub 匹配→发临时编号→通知触发数据落库)/ DevStub 不匹配→rejected / 外籍→manual_review(**不调付费核验**断言)/ **resolve 人工→发号**(分叉④A);校验失败分支(28010 年龄越界 / DTO 紧急联系人<2 / 28011 证件照缺);**临时编号按序唯一**(并发提交 → 号连续无重)/ **防重复报名**(同轮同身份证 28003 / rejected 后可重试)/ **轮次开关**(closed→28030;唯一 open)/ **付费核验前置免费校验**(年龄越界/缺图时核验 provider 零调用断言,配套①)/ **每次核验入 audit**(配套③)/ admin signed-URL 取图 + placeholder(配套②);`recruitment-cycle.e2e-spec.ts`(轮次 CRUD + 开关 + 容量满 28031 + RBAC 边界);**members 计数零增长**断言(D-R-1)。
- **横切回归**:auth-* / sms / wechat / app-me / insurance 全组零修改全绿;contract 仅新增;docker-smoke 含 `REALNAME_ENCRYPTION_KEY` 锚行。
- 全程 `agent:check:full`(本地无 Docker → quick + 显式声明留 CI,不谎报)。

---

## 9. 任务队列与探针(顺序硬约束;goal 原文固化)

| 阶段 | 档 | 内容 | 探针(未满足才做) |
|---|---|---|---|
| **T0** | A | 本稿(§0.5 四分叉 2026-06-18 元核验冻结 + 3 配套)+ NEXT_TASKS 登记 | 本稿不存在 |
| T1 | D | §3.1 schema + 第 19 migration(手写 partial unique ×2)+ §3.4 前 8 码 seed + 计数同步(E-R-22) | schema 无 `RecruitmentApplication` |
| T2 | D | `realname/` 第 25 模块(provider + DevStub + 真 provider + settings 3 端点 + crypto + `REALNAME_ENCRYPTION_KEY`)+ CODEMAP/RBAC_MAP | `src/modules/realname/` 不存在 |
| T3 | C/D | `recruitment/` 第 26 模块 + 公开/admin 端点(含 signed-URL 取图)+ 状态机 + 发号 + BizCode 27/28xxx + audit +5/+2 + 第 9 throttler + baseline §1.1 红区 + **api-surface-policy §0 open/v1 首用红区** + e2e | `recruitment/applications` 路由不存在 |
| T4 | A | CHANGELOG / current-state §2(新增能力行)/ §3(移除「招新自助小程序化」缓置)/ RBAC_MAP / CODEMAP / NEXT_TASKS(一期归档 + 二/三期挂项)+ `ops/realname-verification-rollout-checklist.md` + `ops/recruitment-data-retention-sop.md`(含删 blob) | current-state §2 无招新行 |

LOOP 纪律沿 process §7.1:同失败修复 ≤2 轮;连续 2 轮零推进熔断;每 PR 合并沿 §5.4 八条。

---

## 10. 本期不做(终版报告必列)

- 二期:巡山培训门槛 / 4 项考核进度记账 / 综合评定 / 公示 / 发永久编号 / promote-to-member(建 User+Member + 资料搬家);三期:入队 10 项 / 部门 / 级别 1-7 APD 调级。
- 真实腾讯云实名核验通道接入(运维接力,出 SOP;DevStub 全验);真实短信通知发送(模板/文案/凭证后填,通道休眠)。
- 新 cron / 自动留存清理(沿手动 SQL+blob SOP);进度查询进度条(建议 A 细粒度,等小程序前端真实需要)。
- 证件照走 `Attachment` 多态表(分叉③A 走 storage key;若日后接 Attachment = insurance-E-20 式单独立项)。
- 提交期短信验手机(分叉②A;手机仅通知用途);改现有登录/微信/sms/attachments/members 模块行为;临时编号写入 members(禁区)。

---

## 11. 红区改动计划

1. **`docs/srvf-foundation-baseline.md` §1.1**(T3 PR,逐行可解释,沿 #294 范式):
   - `270xx-290xx` 预留行收窄为 `290xx`;其上插入两行:
     `| 270xx | realname | 200 | 实名核验通道已实装(2026-06-18 goal;27030/27031;不开 271xx;评审稿本文件)|`
     `| 280xx + 281xx | recruitment | 200 | 招新一期已实装(28001-28003/28010/28011/28030/28031/28040;不开 281xx FORBIDDEN_*;评审稿本文件)|`
   - 「仅 270xx-290xx + 310xx 起未规划预留」措辞同步为 `290xx`。
2. **`docs/api-surface-policy.md §0`**(分叉①A;T3 PR):`open/v1`「预留:本期不实现、不占用」→「**首用:招新自助公开面**(2026-06-18 goal 授权;`open/v1/recruitment/*`;评审稿本文件)」;配套 `AGENTS.md` §9 / §21「open/v1 未实现」注记解锁(沿 cron / wechat §9 范式,逐行进 PR)。

`AGENTS.md` 本体(除①A 的 §9/§21 解锁注记)/ V2 红线 **零碰**。

---

> 实施(T1-T4)以本稿为准;与 goal 原文冲突时 goal 优先;§0.5 四分叉以 2026-06-18 维护者元核验冻结结论为准;新发现问题按 process §4.1 人话简报上报,不顺手修。
