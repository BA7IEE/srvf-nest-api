# SRVF 招新可用性收口评审稿(Recruitment Usability Closeout Review)— 冻结

> **状态:冻结,不回改**(2026-07-11;立项源 = goal「招新可用性收口 —— 手工建档闭环 + 防重成本线 + 申请人自助包」,goal 文本即立项 + 拍板记录 + 执行授权;维护者已对 9 项核实**逐项拍板**〔R1–R7,见 §3〕,本稿是拍板记录的扩写冻结档,**非待拍板稿**——runner 不再询问,按 §6 切片直接实施)。
> **性质**:镜像 [`recruitment-phase4-loop-optimization-review.md`](./recruitment-phase4-loop-optimization-review.md) 体例;本文件是**冻结时刻**的核实与设计依据,**非当前事实源**;当前字段/接口/错误码事实以 `prisma/schema.prisma` + live `/api/docs-json` + `src/**` 为准。实施与本稿冲突时 **goal 原文优先**。
> **基线**:main HEAD = `5b609b5e`(v0.40.0;worktree HEAD == origin/main 已核);`git status` clean;0 open PR;`grep '"version"'` = 0.40.0;latest tag = `v0.40.0`(Release Latest 已核);CHANGELOG `## Unreleased` 空。计数基线:权限码 **201** / biz-admin **77** / org-admin **60** / ops-admin **96** / `EXPECTED_ROUTES` **329** / controller **66** / 模块 **35** / migration **40** / 角色 **7**。
> **本 goal 发版号 = v0.41.0**(下一未占用 minor,亲核)。

---

## 0. TL;DR

1. **9 项问题核实结论(§2)**:6 属实(#1 手工建档无闭环 / #5 防重只认身份证号 / #6 中间无通知 / #7 不能改·撤·诉 / #8 缺签名 / #9 证书无上传口)、2 部分属实(#2 H5 卡 missing-openid〔**已由 v0.40.0 H5 手机通道发号解决,本 goal 不重做**〕/ #3 查询链断点)、1 机制描述不准但风险真实(#4 限流互挤)。#3c 维护者作废;#6 挂账 NEXT_TASKS P1-14 不进本 goal。
2. **v0.40.0 边界亲核(F4 幂等口径)**:CHANGELOG v0.40.0 T5 交付范围**仅 promote 侧**(`isPromotable` 登录通道放宽 + skip reasons 三变 + 手机通道建 SMS 登录 User),**未**触碰 `recruitment-identity.service` 的 28030 闸、**未**改 query/query-by-phone miss 路径 → **F4 两项(3a/3b)均未被覆盖,照做**。
3. **切片(§6)**:F0 本稿(A)→ F1 防重前移 + OCR 成本线(C~D,+1 migration)→ F2 admin 改资料(D,+1 码)→ F3 单人手动建档(D,+1 码)→ F4 查询链修复(C)→ F5 知情同意+签名图(D,migration)→ F6 自助撤销(D,migration)→ F7 证书图长期档案(D,migration)→ F8 docs 收尾 + 发版 v0.41.0(E)。每片 1 PR、CI 绿自合。
4. **预估终值**:权限码 201→**203**(+`recruitment-application.update.record` / `+.promote.single`,全绑 biz-admin;org-admin 按 `recruitment-` 前缀排除自动零波及)/ `EXPECTED_ROUTES` 329→**334**(+5)/ migration 40→**44**(F1 计数表 + F5 + F6 + F7)/ BizCode +7(280xx additive)/ `recruitment_stage` 字典 10→11(+withdrawn)。以各片亲核 true-up 为准。
5. **⚠️ 行为变更预告(F8 CHANGELOG 置顶)**:① submit 必填 `privacyConsentAccepted=true`(契约收紧,旧客户端 400);② 同轮同 openid/phone 活跃报名二次提交改拒(28004/28005);③ 发号后公开查询由「查无 28002」改返 stage=volunteer 引导态;④ promote 的 `privacyConsentSigned` 由硬编码 true 改搬申请真值(存量/未签 → false)。

---

## 1. 名词与链路速查

- **报名主链**:`POST open/v1/recruitment/applications`(multipart)→ OCR 六分流 → `verified`(发临时号)/`manual_review` → 门槛 5 项 → `pending_evaluation` → 评定 → `publicity` → **promote**(批量发永久编号,建 User+Member+档案,清敏感)→ `promoted` 终态。
- **身份链两入口**:小程序 `wechatCode`(code2session → openid)/ H5 `phoneVerificationToken`(send-code → verify-code → 30min 一次性 token)。
- **公开自助面 8 端点**(全部 `@Public` + `@RecruitmentThrottle`):submit / recognize / query / identity/send-code / identity/verify-code / query-by-phone / rebind-wechat / rebind-phone([recruitment-public.controller.ts](../../../src/modules/recruitment/recruitment-public.controller.ts))。
- **留存 SOP**:rejected 或轮 closed 满 30 天 → 敏感字段 NULL 化 + 按 key 删 blob;promote 则**即时清**(schema.prisma:1776-1784 注释 + recruitment-promotion.service.ts:232-251)。

## 2. 9 项核实(file:line 证据;基线 v0.40.0 HEAD `5b609b5e`)

### 2.1 #1 手工建档无闭环 — **属实**

- 批量 promote 的 skip 项**永停 publicity**:事务前分区 skip + report 不 block([recruitment-promotion.service.ts:107-123](../../../src/modules/recruitment/recruitment-promotion.service.ts)),无任何后续处置端点。
- **skip 原因清单(v0.40.0 后为 8 具名 + 1 兜底;goal 原文「7 种」为 v0.39.0 时点计数,本稿 true-up)**——同源纯函数 `promotionSkipReason`([recruitment.constants.ts:161-177](../../../src/modules/recruitment/recruitment.constants.ts)),判定顺序即优先级:

| # | reason | 语义 | 本 goal 出路 |
|---|---|---|---|
| 1 | `foreign-manual-build` | 外籍(非大陆证件)不可派生 birth/gender | **F3 promote-single 放行**(F2 先补录派生字段) |
| 2 | `openid-already-bound` | openid 被既有 User 占用(含软删) | R3:先自助 rebind-wechat 换绑,再 F3 择 phone 锚 |
| 3 | `phone-already-bound` | 手机通道 phone 被既有 User 占用(v0.40.0) | R3:先 rebind-phone,再 F3 |
| 4 | `missing-login-channel` | openid+phone 皆无(v0.40.0,取代 missing-openid) | R3:不建无锚号;引导自助补绑 |
| 5 | `duplicate-openid-in-batch` | 批内同 openid 仅首行可发 | F3 单发即天然规避 |
| 6 | `duplicate-phone-in-batch` | 批内同 phone 仅首行可发(v0.40.0) | 同上 |
| 7 | `missing-derived-field` | 缺 birthDate/genderCode | **F2 补录** → F3 |
| 8 | `incomplete-data` | 缺 realName | **F2 补录** → F3 |
| 9 | `not-promotable` | 兜底(理论不可达) | — |

- 「admin 手动建档」只存在于注释/DTO 描述(`needsManualBuild`,[recruitment.dto.ts:631-632](../../../src/modules/recruitment/recruitment.dto.ts) 等),admin surface 全量 8+8 路由中**无建档/改资料端点**([recruitment-applications.admin.controller.ts](../../../src/modules/recruitment/recruitment-applications.admin.controller.ts) / [recruitment-cycles.controller.ts](../../../src/modules/recruitment/recruitment-cycles.controller.ts))。P1-12 当时拍板的 v1 边界,本 goal F2+F3 还账。

### 2.2 #2 H5 纯手机号必落 missing-openid — **部分属实 → 已由 v0.40.0 解决,本 goal 仅消费**

- v0.40.0 T5「H5 手机通道发号」已交付:`isPromotable` 登录通道条件放宽为「openid **或** 已验证 phone」([recruitment.constants.ts:118-133](../../../src/modules/recruitment/recruitment.constants.ts));无 openid 有 phone 者 promote 建 SMS 登录 User(`phone + phoneVerifiedAt=now`,[recruitment-promotion.service.ts:184-196](../../../src/modules/recruitment/recruitment-promotion.service.ts))。
- **亲核交付边界**:CHANGELOG v0.40.0 该条全文仅涉 promote/precheck/publicity 三消费者 + `decidePromotionIssuance`;`recruitment-identity.service.ts` 与 query 路径零 diff → F4 不受挤占。

### 2.3 #3 查询链断点 — **部分属实**(3c 已作废)

- **3a 闭轮全断**:`sendCode`/`verifyCode` 均硬卡 `findOpenCycleIdOrThrow()` → 28030([recruitment-identity.service.ts:67-68 / 82 / 334-344](../../../src/modules/recruitment/recruitment-identity.service.ts))。闭轮后手机侧 query-by-phone / rebind-wechat / rebind-phone 虽自身不卡轮,但都需验证码 → **发码即断,整链不可达**。微信 query 不受影响(不依赖短信)。
- **3b 发号后查无**:promote 即时清 `phone`/`openid`([recruitment-promotion.service.ts:235-251](../../../src/modules/recruitment/recruitment-promotion.service.ts))→ `query`(openid 定位,[recruitment-applications.service.ts:543-551](../../../src/modules/recruitment/recruitment-applications.service.ts))与 `queryByPhone`(phone 定位,[recruitment-identity.service.ts:347-356](../../../src/modules/recruitment/recruitment-identity.service.ts))天然 miss → 28002「查无」,体验像报名消失。脱敏留存是刻意设计(SOP),**报名行本身仍在**:`statusCode=promoted` / `promotedMemberId` / `thresholdMarks` / `tempNo` 全保留 → F4-3b 经 User 反查 `promotedMemberId` 即可用真实行组装引导态,零新增 PII 留存。

### 2.4 #4 限流 — **机制描述不准,风险真实(不改代码,只补 runbook)**

- 8 公开端点各挂 `@RecruitmentThrottle()`([recruitment-public.controller.ts:112/163/210/230/255/274/295/318](../../../src/modules/recruitment/recruitment-public.controller.ts));装饰器为纯 metadata([recruitment-throttle.decorator.ts](../../../src/common/decorators/recruitment-throttle.decorator.ts)),命名 throttler `recruitment` 按 **route+IP** 计数 → **8 个各自独立的 10 次/时/IP 桶,非共用池**。
- 共享出口 IP(同一 WiFi 的招新现场)按端点互挤:OCR 重拍循环(recognize)最易打满。
- 参数本就是 env:`RECRUITMENT_THROTTLE_LIMIT`(默认 10)/ `RECRUITMENT_THROTTLE_TTL_SECONDS`(默认 3600),[app.config.ts:511-528](../../../src/config/app.config.ts)。→ **F8 补 runbook**(招新活动期调 30–60 指引),禁区:不改 tracker/分桶。

### 2.5 #5 防重只认身份证号 — **属实**

- 唯一去重键 = 同轮 + `idCardNumber`(预检 [recruitment-applications.service.ts:249-261](../../../src/modules/recruitment/recruitment-applications.service.ts);partial unique `(cycleId, idCardNumber) WHERE deletedAt IS NULL AND statusCode <> 'rejected'` 兜底,schema.prisma:1845-1850 注释)。
- `openid` 仅普通 `@@index`(schema.prisma:1853)无唯一约束;`phone` 在 `recruitment_applications` **无索引**;→ 换一个证件号即可用同一 openid/phone 重复触发付费 OCR。
- `recognize` 端点**零去重零身份**(无状态设计,[recruitment-applications.service.ts:115-185](../../../src/modules/recruitment/recruitment-applications.service.ts))→ 可刷付费 OCR(cost-DoS 已在 phase-1 登记接受,本 goal F1 补日封顶成本线)。
- 小程序链 OCR 升级计数恒「首个 attempt」:无会话行时 `sessionPriorCount=null`([recruitment-applications.service.ts:292-300](../../../src/modules/recruitment/recruitment-applications.service.ts)),重拍/重试计数无法跨请求累计(会话计数仅 H5 链有,Q-P4-1 设计边界)。
- → **F1**:submit 在付费 OCR **前**增同轮活跃(非 rejected/withdrawn)openid/phone 去重(28004/28005 温和文案);OCR 调用(recognize+submit 共享)按 IP 北京自然日封顶(env 默认 30,超限 28060/HTTP 429);**recognize 契约不加身份参数,维持无状态**(拍板);共用手机的罕见正常场景(如夫妻同机报名)由 F3 手动路径兜底 —— **已知取舍,记录在此**。

### 2.6 #6 中间阶段无通知 — **属实 → 挂账 P1-14,不进本 goal(R7)**

- 全链路仅 **2 个**主动派发点:① promote 发号+转志愿者一体([recruitment-promotion.service.ts:293/307-323](../../../src/modules/recruitment/recruitment-promotion.service.ts) `dispatchPromotionNotifications`,站内+微信);② team-join 一键入队([team-join-enrollment.service.ts:238](../../../src/modules/team-join/team-join-enrollment.service.ts))。
- 报名受理/转人工/人工结果/门槛推进/评定结果/公示上榜均无主动通知(靠申请人自查)。报名前 openid 非会员推送路已挂 NEXT_TASKS P1-14。

### 2.7 #7 不能修改/撤销/申诉 — **属实**

- 公开侧仅 submit + rebind-wechat + rebind-phone(§1 端点表);无改资料/撤销/申诉。
- admin 侧 8 路由(list/batch-mark-threshold/export/:id/:id/id-card-image-url/:id/resolve/:id/thresholds/:id/evaluate)**无改资料端点** → `missing-derived-field`/`incomplete-data` 两类 skip 无解(外籍申请人 birthDate/genderCode 无处补录)。
- → **F2 admin 改资料(R1 范围)+ F6 自助撤销(R4)**;申诉模块列禁区(不做)。

### 2.8 #8 缺签名 — **属实且有合规瑕疵**

- 报名链零签名零知情同意:submit payload 无 consent 字段([recruitment.dto.ts:62-154](../../../src/modules/recruitment/recruitment.dto.ts));`recruitment_applications` 无 consent/签名列(schema.prisma:1764-1856)。
- `member_profiles.privacyConsentSigned`(MP-30a,NOT NULL)在 promote **硬编码 true**([recruitment-promotion.service.ts:209](../../../src/modules/recruitment/recruitment-promotion.service.ts))——当事人从未签署。
- → **F5**:submit 必填 `privacyConsentAccepted=true`(+版本号)+ 可选签名图 multipart;promote 搬真值 + 签名图 key 搬 `member_profiles.signatureImageKey` 长期留存(R5,镜像 idCardImageKey 搬运范式,不随脱敏清除)。

### 2.9 #9 证书无上传入口 — **属实**

- `Certificate` 模型只服务队员(`memberId` FK Restrict)且**无图片字段**(schema.prisma:678-712);app 侧 `GET app/v1/my/certificates` DTO 无图片/URL 字段(dto/app/app-my-certificate.dto.ts)。
- 招新 redCross/bsafe 是 admin 手工勾选门槛(`thresholdMarks`,[recruitment.constants.ts:64](../../../src/modules/recruitment/recruitment.constants.ts)),申请人无自证材料上传口;附件上传仅 admin 面。
- `cert_type` 字典已有 `first_aid`/`bsafe`(prisma/seed.ts:214-215);certificates 建行 `certStatusCode='pending'` 先例(certificates.service.ts:287)。
- → **F7(R6)**:公开上传(双通道凭证)→ 存 `recruitment_applications.certificateImages Json` → admin 看图签名 URL(复用 read.sensitive)→ 审核动作仍 = 既有标门槛 → promote 自动建 pending `Certificate` + 图 key 搬 `Certificate.imageKeys Json?`,报名行清空;未发号者的证书图随既有留存 SOP 清理。

## 3. 维护者拍板(2026-07-11 已全部定案;runner 不再询问)

| # | 拍板 | 内容 |
|---|---|---|
| **R1** | admin 改资料范围 | 非身份字段(地址/紧急联系人/profileExtra 等报名资料)恒可改;身份字段(realName/idCardNumber/birthDate/genderCode)仅 `statusCode='manual_review'` **或** 外籍记录可改;已 verified 的大陆记录**不开**;必落 audit |
| **R2** | 手机锚定 User | 复用 P1-18 范式(username 探测式 + SMS 登录 + 随机口令 hash 不外发)——**由 v0.40.0 H5 切片交付,本 goal 消费** |
| **R3** | 双锚全占用 | **不建无登录锚点的号**;引导先自助换绑(rebind-phone/rebind-wechat)再手动发号 |
| **R4** | 撤销语义 | 新增 `withdrawn` 终态,允许下轮及同轮重报(同轮防重 partial unique 排除集 rejected → rejected+withdrawn,migration 重建索引) |
| **R5** | 签名留存 | 签名图 = 责任文件,promote 时搬 `member_profiles.signatureImageKey` 长期留存,报名行 key 清空(镜像 idCardImageKey 搬运范式);**不随脱敏清除** |
| **R6** | 证书图进长期档案 | promote 时为已上传证书图的类别自动建 `Certificate` 行(pending)+ 图 key 搬入 Certificate 新列,报名行清空;后续走既有 certificates verify/reject 核验。未发号(被拒/撤销)者证书图随既有留存 SOP 清理 |
| **R7** | 范围外 | 3c 作废;#6 通知路(P1-14)不进本 goal |

## 4. 公开端点限流表(现状;F8 runbook 素材)

| 端点(open/v1/recruitment) | throttler | 桶 | 备注 |
|---|---|---|---|
| POST applications(submit) | recruitment 10/3600/IP | 独立 | multipart;付费 OCR 在免费校验后 |
| POST applications/recognize | recruitment 10/3600/IP | 独立 | 无状态付费 OCR;重拍循环最易打满 |
| POST applications/query | recruitment 10/3600/IP | 独立 | 微信 code 查询 |
| POST identity/send-code | recruitment 10/3600/IP | 独立 | 另有 SMS 层 60s 间隔 + 手机日 10 条 |
| POST identity/verify-code | recruitment 10/3600/IP | 独立 | |
| POST applications/query-by-phone | recruitment 10/3600/IP | 独立 | 验码消费一码 |
| POST applications/rebind-wechat | recruitment 10/3600/IP | 独立 | |
| POST applications/rebind-phone | recruitment 10/3600/IP | 独立 | 双验两码 |

> 8 桶独立、参数全局共享一组 env;招新活动现场共享出口 IP 时建议临时调 `RECRUITMENT_THROTTLE_LIMIT=30~60`(F8 落 runbook;**不改代码/不改 tracker/不改分桶** = 禁区)。F1 的 OCR 日封顶(按 IP 北京自然日,默认 30)是**独立于限流器**的成本线,持久化计数,不受进程重启清零影响。

## 5. 通知派发点清单(现状 2 处;P1-14 域,本 goal 不动)

| 触发点 | 渠道 | file:line |
|---|---|---|
| promote 发号(转志愿者一体) | 站内 + 微信(quota 缺则 skip) | recruitment-promotion.service.ts:293/307-323 |
| team-join 一键入队 | 站内 + 微信 | team-join-enrollment.service.ts:238 |

## 6. 切片表(每片 1 PR,CI 绿自合;计数 runner 亲核 true-up)

| 片 | 档 | 内容 | schema/migration | 新码 | 新 BizCode(预估) | 新路由 |
|---|---|---|---|---|---|---|
| F0 | A | 本冻结评审稿 | — | — | — | — |
| F1 | C~D | submit 防重前移(同轮活跃 openid/phone)+ OCR IP 日封顶(env 默认 30,计数表) | +1(计数表) | 0 | 28004/28005/28060 | 0 |
| F2 | D | `PATCH admin/v1/recruitment/applications/:id` 改资料(R1 白名单 + 身份字段条件闸) | 0 | +1 `recruitment-application.update.record`(biz-admin) | 28045 | +1 |
| F3 | D | `POST .../applications/:id/promote-single` 单人手动建档(复用 promote 内核;放行外籍;锚点择优 openid→phone) | 0 | +1 `recruitment-application.promote.single`(biz-admin) | 28046/28047 | +1 |
| F4 | C | 3a 闭轮发码/验码放行(开放轮 或 手机命中未清除报名;防枚举沿 login-sms)+ 3b query 双通道 fall-through 引导态 | 0 | 0 | 0 | 0 |
| F5 | D | 知情同意必填(⚠️ 契约收紧)+ 签名图;promote 搬真值+搬 key | +1(3 列 + member_profiles 1 列) | 0 | 0 | 0 |
| F6 | D | `POST open/v1/recruitment/applications/withdraw` 自助撤销;withdrawn 终态;partial unique 重建;字典 +1 | +1(索引重建) | 0 | 28052 | +1 |
| F7 | D | 证书图公开上传 + admin 取图 + promote 建 pending Certificate 搬图 | +1(certificateImages + Certificate.imageKeys) | 0(取图复用 read.sensitive) | 0(校验复用既有码) | +2 |
| F8 | E | docs 收尾(CHANGELOG ⚠️ 置顶/RBAC_MAP/CODEMAP/NEXT_TASKS/runbook)+ 发版 v0.41.0 | — | — | — | — |

### 6.1 关键工程决策(实施固化,不再漂移)

- **E-U-1(F1 载体)**:OCR 日封顶计数表 `recruitment_ocr_daily_counters`(`ip + dateKey〔北京日 YYYY-MM-DD〕` 唯一,原子 upsert increment 后判限)——现有持久化无合适载体(SMS 计数按 phone 非 IP;throttler 内存态);超限计一次已拒尝试可接受(计数只增,拒者恒拒)。
- **E-U-2(F1 去重语义)**:openid 去重仅小程序链可判(code2session 在 OCR 前);H5 会话 openid 恒 null(verify-code 不写),不参与预检;phone 恒可判(payload.phone 必填)。排除集 F1 时点 = `{rejected}`,F6 落地后 = `{rejected, withdrawn}`(F6 顺改)。
- **E-U-3(F3 状态闸)**:promote-single 仅 `statusCode='publicity'` 可发(与批量同源),他态 28041(复用);已 promoted 重跑 → 28041(幂等语义 = 不重复建档,响应可辨)。
- **E-U-4(F3 锚点择优)**:openid 未占用 → 微信通道;openid 缺/占用且 phone 未占用 → 手机通道;双缺/双占 → 28046(R3 引导先换绑)。批量 promote 的通道分流行为锁不破(单发走独立入口,批量代码路径零改动语义)。
- **E-U-5(F4-3b fall-through)**:app miss → `User`(openid/phone,live)∪ `member_profiles.mobile` 反查 → member `status=ACTIVE` → `recruitment_applications.promotedMemberId` 定位真实报名行(最近一条)→ 既有 presenter 组装(stage=volunteer「已转志愿者 / 待入队」)。member 非 ACTIVE 或无报名行 → 维持 28002。**闭轮 + 已发号 + 纯手机通道**者 send-code 仍走防枚举泛化(app 行 phone 已清)→ 该人群闭轮期查询不可达 = 已知边界(引导语本就是「请登录小程序」,其已有账号)。
- **E-U-6(F5 版本号)**:`privacyConsentVersion` 前端传(自由短串,如 `2026-07`);后端只存不校验版本内容;`privacyConsentAccepted !== true` → 400(40000,契约收紧)。
- **E-U-7(F7 上传约束)**:category ∈ {first_aid, bsafe}(cert_type 既有码);每类 ≤3 张,重传**整类覆盖**(替换语义,免增量删除口);单图校验镜像 idCardImage(jpeg/png ≤5MB);`certificateImages Json = { [category]: string[] }`。
- **E-U-8(禁区重申)**:P1-14 通知路;申诉模块;申请人自助改 PII;attachments owner-type 接线;限流器 tracker/分桶改造;OCR recognize 加身份参数;跨轮防重;新 cron/queue;migrate reset 及对非空库的破坏性操作(恒需实时同意)。

## 7. DoD(goal §3 原文为准;报告逐条附证据)

干净库 migration 全量重放(40→预估 44)+ seed 幂等二跑;unit/contract/full e2e 三绿;新增 e2e 覆盖 F1–F7 各关键路径(goal §3.2 清单);`docs:rbacmap:check`/`docs:codemap:check` 0 FAIL;handoff + openapi.json 同 PR 更新;行为锁:auth 模块零 diff / RbacService·AuthzService 判权核心零 diff / 批量 promote 与既有 8 公开端点未涉场景行为逐字不变 / 既有 e2e 断言除列明行为变更处外零修改。
