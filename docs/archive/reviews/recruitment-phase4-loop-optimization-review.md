# SRVF 招新 → 入队完整闭环优化评审稿(Recruitment → Enlistment Loop Optimization Review)— T0 冻结

> **状态:冻结,不回改**(2026-06-24;立项源 = goal「招新→入队完整闭环优化 —— T0 评审稿冻结(只调研零代码)」,goal 文本即立项 + 评审授权;维护者拍板「这批约 12 个特性域体量大、含 D 档 schema、跨模块耦合 → 先以一份 T0 评审稿打包冻结设计与排期,本轮零代码,随后按切片逐个另出实施 goal」;本稿按 [`process.md §4`](../../process.md) D 档降速 + [`§7.1`](../../process.md) 循环产出,**只调研 + 只出评审稿,零代码 / 零 schema / 零 migration / 零 seed / 零 RBAC 码**)。
> **性质**:本文件是「招新前段(报名/OCR)→ 招新后段(门槛/评定/公示/发号)→ 入队(志愿者→队员)」**完整闭环优化**的 T0 评审**冻结档**,镜像 [`recruitment-phase1/2/3-review`](./recruitment-phase1-review.md) / [`recruitment-realname-ocr-review`](./recruitment-realname-ocr-review.md) / [`member-notification-review`](./member-notification-review.md) / [`sms-verification-infra-review`](./sms-verification-infra-review.md) 系列。
> **权威分层**:本文件是**冻结时刻**的设计依据,**非当前事实源**;当前字段/接口/错误码事实以 `prisma/schema.prisma` + live `/api/docs-json` + `src/**` 为准。实施(各切片 T1+)以本稿为准;与 goal 原文冲突时 **goal 优先**;**§13 待拍板未经维护者元核验前不实施**。
> **基线**:main HEAD = `247d2f83`(v0.30.0;worktree HEAD == origin/main 已核,0/0);`git status` clean;0 open PR;`grep '"version"'` = 0.30.0;latest tag = `v0.30.0`。
> **范式母本**:`recruitment-phase3-review.md`(change-to-existing-flow + 流程冻结 + 既有行为锁)+ `recruitment-realname-ocr-review.md`(分叉式待拍板 + 零 schema 框定)+ `member-notification-review.md`(T0 待拍板清单 + 五张清单 + 风险表)。
> **决策 token 约定**:`Q-P4-n` = 待维护者拍板(带本稿推荐);`E-P4-n` = 工程师决定、本稿固化、实施不得再漂移;`S-n` = 实施切片。引用沿 `§N` / `§N.M`。

---

## ⚠️ 待维护者拍板清单(实施前须逐条元核验「按推荐」或改写)

> 镜像 member-notification T0:产品口径未拍板项一律写「待拍板(建议:…)」,不自行定死。**工程实现细节(E-P4-*)不在此表,已由本稿固化。** 每条标注「改了它会牵动哪些章节」。

| # | 待拍板(产品口径) | 本稿推荐 | 一句话理由 | 牵动章节 |
|---|---|---|---|---|
| **Q-P4-1** | OCR 重拍计数存哪(模糊不落报名记录前提下) | 存在 §3 新建的**报名前身份会话行**(`RecruitmentIdentitySession`,按 手机+轮次)上,**不污染** `recruitment_applications`;客户端兜底计数做 UX,服务端 IP 限流挡 OCR 滥用 | 会话行本就是 H5 身份链所需载体,顺带承载 `ocrAttemptCount/lastOcrOutcome/requiresRetake`,一表两用、零报名脏数据 | §2 §3 |
| **Q-P4-2** | OCR 不一致是否强制三选一(用OCR结果 / 改填写 / 确认OCR错)才放行 | **是**:仅「确认OCR错」才落 `applicantConfirmedOcrWrong=true` 进普通人工;前两项就地纠正后重判,不进人工 | 把「对不上」从「一律转人工」收敛为「能自助纠就自助」,人工量大降 | §2 |
| **Q-P4-3** | 防伪告警/疑似篡改是否单列「高风险复核」队列(与普通人工分流) | **是**:`riskLevel=high` 单独标识 + 单独筛选;先提示重拍原件,再不行进高风险复核 | 篡改/翻拍与「外籍/生僻字」性质不同,混在一个 manual_review 桶里 admin 无法分流 | §2 §11 |
| **Q-P4-4** | OCR 上游连续失败几次才进「系统OCR异常」通道(与证件异常分流) | **连续 2 次**上游失败(`ocr_error`)才进系统异常通道;首次只提示重试 | 偶发抖动不该污染人工队列,也不该秒切人工掩盖系统问题 | §2 |
| **Q-P4-5** | H5 链手机号定位:由「仅通知」上调为「身份链一环」是否拍板 | **是**:H5 入口 `phoneVerificationToken` 必填、`wechatCode` 可选;小程序链仍以 `wechatCode` 为主、手机为辅 | 没有微信环境(线下扫码 H5)也能自助报名/查询,是闭环缺口 | §3 |
| **Q-P4-6** | 查询身份四法(微信code / 手机+验证码 / 临时编号+手机 / 证件后四位+手机)是否全做 | **全做**,但分切片:微信code(现状)+ 手机+验证码 先行,后两法次切片 | 四法覆盖「换了微信 / 没微信 / 忘了临时号」全场景,但价值递减、可分期 | §3 §6 |
| **Q-P4-7** | promote 是否改为 `gradeCode=volunteer` + 建 VOL 归口部门(替代现 `null`+零部门)——**注:此项推翻 phase-3 冻结取舍 E-J-6「双表示是已知取舍,不改 promote/team-join 代码」**(seed.ts:113 注释) | **是**:语义显式化(志愿者就是志愿者),入队门禁配套改判(§5);历史 `null` 成员靠**门禁双兼容**零迁移 | 「双表示(null=志愿者)」对前端/统计是隐性陷阱,显式化收益大;但牵动入队两处门禁、推翻既有冻结取舍,必须维护者明确拍板 | §4 §5 |
| **Q-P4-8** | promoted 展示文案口径(禁「已晋升」) | 「**已转志愿者 / 待入队**」(发号视角可加「已发永久编号」);全程禁「晋升」 | 发永久编号 = 成为志愿者,不是晋升;晋升是入队后的 level-1→7 | §4 §6 |
| **Q-P4-9** | 误通过/误拒绝/发号后纠错的边界(可逆 vs 留痕重开) | 发号前一律可撤回;**发号后不回滚已建 Member**,改走「档案纠错 + 双留痕」;误拒走「重开/重提留两条记录」 | 发号已建 User+Member+号段,回滚破坏「号段连续无空洞」铁律,只能向前纠错 | §10 |
| **Q-P4-10** | RBAC 是否拆「敏感查看」独立码(完整证件号/证件照/详址/紧急联系人/OCR详情) | **是**:`read.record`(脱敏列表/详情)+ 新 `read.sensitive`(明文敏感)双码;现 `read.record` 语义收窄为脱敏 | 现状「一个 read 码看尽明文身份证+证件照」过宽,字段级分级是合规刚需 | §11 |
| **Q-P4-11** | 通知闭环挂载时点 | **挂在 GAP-005 会员通知模块(站内信)落地之后**;本批只登记状态变更触发点 + payload 契约,**不自建通知出口/Effect**(architecture-boundary §3.6) | 自建第二个通知出口违反「新通知类型先回评审、不自由生长」;复用 GAP-005 站内信零架构代价 | §9 |
| **Q-P4-12** | 批量发号预检/批量标门槛/批量导出的口径上限 | 预检默认全做(可发/跳过/原因/重复openid/缺字段/特殊证件);批量导出**按 §11 权限脱敏**、单次上限分页;批量标门槛支持「临时编号/手机/姓名+手机/签到导入」匹配 | 工作台批量是 admin 真实诉求,但导出必须先有字段分级(§11)托底 | §7 §8 §11 |

> 改 **Q-P4-1/2/3/4**(OCR 判定树细节)→ §2 判定树 + §3 会话表字段微调;改 **Q-P4-7**(promote 志愿者化)→ §4/§5/§11 联动;改 **Q-P4-10/11** → §9/§11 + 路线图切片顺序微调。工程项(E-P4-*)随上表拍板自动收敛。

---

## 0. TL;DR

1. **范围 = 招新前段(报名/OCR)→ 后段(门槛/评定/公示/发号)→ 入队(志愿者→队员)整条线的 12 个特性域**;本轮**只冻结设计 + 排期,零代码**,实施按 §12 切片逐个另出 goal。
2. **现状重核(§1)整体吻合 goal 侦察,但纠正/补强 8 处**(详 §1.2),其中两处关键:① **入队门禁耦合是「两处」不是一处**——除 `team-join-enrollment.service.ts:140-147`(一键入队),报名侧 `team-join-applications.app.service.ts:60-75`(志愿者自助发起申请)也同样卡 `gradeCode==null + 零部门`;② **`verifyOutcome` 已有 8 细分值**〔S4b 顺修:原稿误记 7〕(matched/mismatch/manual/skipped + forgery_warning/ocr_unclear/ocr_error/category_mismatch),不是「仅一个字段记原因」——新拆分原因应**复用并扩展**它,而非另起炉灶。
3. **OCR 拆分(§2)**:把现「5 条全塞 manual_review」改为「自动通过 / 模糊→前端重拍不落记录 / 不一致→自助三选一仅确认错才进人工 / 防伪→高风险复核单列 / 上游失败→连续多次才进系统异常通道 / 特殊证件→人工」六分流;新增 `manualReviewReason/riskLevel/ocrAttemptCount/lastOcrOutcome/applicantConfirmedOcrWrong/requiresRetake`,**重拍计数落在 §3 报名前身份会话行**(Q-P4-1)。
4. **H5 + 手机身份链(§3)**:复用 `sms-code.service`(发码/验码/限流/加密**全在**),但 `SmsPurpose` 是 **DB enum**(加值 = D 档 migration),且 `issue/verifyAndConsume` 形参 `userId:string`、而报名人匿名 → 需**放宽形参为可空**(列本就可空)或传稳定 sentinel;**无既有「验后凭证」** → 须新建短时 `phoneVerificationToken`(承载在报名前身份会话行)。
5. **状态业务化(§4)**:后端只管 `statusCode`(机器态)+ 派生 `stage`(业务态),字典/前端管文案;**`promoted` enum 值不改库,展示一律「已转志愿者/待入队」,全程禁「已晋升」**(Q-P4-8)。
6. **promote 志愿者化 + 入队门禁适配(§5,关键耦合,给可执行解)**:promote 改 `gradeCode=volunteer` + 建 VOL 归口部门(VOL≠VOD);**配套把两处门禁从「null+零部门」改判为「volunteer 身份 + 仅 VOL 部门(且兼容 legacy null+零部门)」**;入队写从「create 目标部门」改为「软删 VOL 部门 + create 目标部门」(守 `member_departments` 单部门 partial unique);历史 `null` 成员靠**门禁双兼容零迁移**(可选后续 backfill)。
7. **新人进度模型(§6)**:跨「招新 statusCode + thresholdMarks + 入队 statusCode」派生统一 9 阶段响应(`stage/stageText/statusText/nextAction/tempNo/memberNo/identityText/todoList[]/meetingInfo/qqGroup/notice`);**纯读、零 schema、零耦合 → 列为首切片**。
8. **招新工作台(§7)**:聚合只读 stats 端点(今日/待处理/门槛进度/综合评定/公示发号 五组);**答 handoff GAP-003「招新进度」部分**。
9. **批量操作(§8)**:批量标门槛 / 批量通知 / 批量导出(按 §11 脱敏)/ 一键发号预检;给端点形态 + 幂等 + 审计要点。
10. **通知闭环(§9,依赖耦合)**:状态变更触发点清单 + 渠道 + payload 契约**现在登记**,通知出口**挂 GAP-005 会员通知模块站内信落地后**,本批不自建出口/Effect(architecture-boundary §3.6;Q-P4-11)。
11. **纠错流程(§10)+ RBAC 字段分级(§11)**:重复报名/换微信/换手机/OCR错/误通过/误拒绝/发号后纠错/公示投诉每类给路径+审计;`read.record` 拆为 普通查看/敏感查看/审核/门槛/发号/纠错 六类码。
12. **路线图(§12)**:7 个有序切片,首推 **S1「状态业务文案 + 新人进度模型」(档 A,纯读零 schema 零耦合)**;最重一刀 **S5「promote 志愿者化 + 入队门禁」(档 D/E)**单独切;通知 **S7 阻塞于 GAP-005**。

---

## 1. 现状基线重核(file:line)

> runner 亲核(读源码,非 grep 二手);与 goal 侦察不符处在 §1.2 标注「亲核纠正」。

### 1.1 状态机 / OCR / promote / 门禁 / RBAC 现状表

| 核查项 | 结论(现状) | 证据(file:line) |
|---|---|---|
| 招新状态机 7 值 | `pending_verification`(退役,OCR 改造后报名不再产生)/ `verified` / `manual_review` / `rejected` / `pending_evaluation` / `publicity` / `promoted`,均 String 无 enum | [recruitment.constants.ts:15-22](../../../src/modules/recruitment/recruitment.constants.ts) |
| `verifyOutcome` 细分值 | **已 8 值**〔S4b 顺修:原稿误记 7,实为 8〕:`matched`/`mismatch`/`manual`/`skipped` + OCR 改造分叉⑥ 加 `forgery_warning`/`ocr_unclear`/`ocr_error`/`category_mismatch` | [recruitment.constants.ts:25-33](../../../src/modules/recruitment/recruitment.constants.ts) |
| OCR 判定分支(大陆) | `decideMainlandOcr` **5 分支全塞 manual_review**:上游失败→`ocr_error` / 不清晰→`ocr_unclear` / 防伪告警→`forgery_warning` / 匹配→`verified`(唯一放行) / 不一致→`mismatch` | [recruitment-applications.service.ts:356-395](../../../src/modules/recruitment/recruitment-applications.service.ts) |
| OCR 判定分支(非大陆) | 护照/回乡证/台胞证/外永居/其余 → 提交端**不再 OCR**,恒 `manual_review`+`manual` | [recruitment-applications.service.ts:250-253](../../../src/modules/recruitment/recruitment-applications.service.ts) |
| `recognize()` 预填 | **无状态、不落库、不发 token**;已返 `clarityOk:false`+`hint:'请重拍清晰证件照'`(前端重拍 UX 钩子**已部分存在**于识别端,缺的是提交端的对齐) | [recruitment-applications.service.ts:112-171](../../../src/modules/recruitment/recruitment-applications.service.ts) |
| OCR 新字段缺口 | 无 `riskLevel/ocrAttemptCount/lastOcrOutcome/applicantConfirmedOcrWrong/requiresRetake/manualReviewReason`(仅 `verifyOutcome`+`reviewNote` 记账) | [schema.prisma:1421-1427](../../../prisma/schema.prisma) |
| 提交 DTO | `wechatCode` **必填**(:55-60);`phone` 仅 `@Matches` 大陆号、注释「仅通知用途,非身份证据」,**无短信验证** | [recruitment.dto.ts:55-87](../../../src/modules/recruitment/recruitment.dto.ts) |
| 查询 DTO | 仅 `wechatCode`(纯靠 code2session 换 openid 查最近一条);公开返回 DTO 仅 6 字段(`statusCode/tempNo/cycleName/meetingInfo/qqGroup/notifyTemplate`),**无 stage/stageText/nextAction/todoList** | [recruitment.dto.ts:162-189](../../../src/modules/recruitment/recruitment.dto.ts) · [service.ts:398-411](../../../src/modules/recruitment/recruitment-applications.service.ts) |
| promote 建 Member | `tx.member.create({ memberNo, displayName, status:'ACTIVE' })` —— **无 `gradeCode`**(=null)、**不建 `member_departments`**(两层身份铁律) | [recruitment-promotion.service.ts:131-133](../../../src/modules/recruitment/recruitment-promotion.service.ts) |
| promote 链 + 清敏感 | 标 `promoted` + `promotedMemberId` + 清 9 敏感字段;`joinSourceCode='recruitment'`(自由串直写) | [recruitment-promotion.service.ts:186-203](../../../src/modules/recruitment/recruitment-promotion.service.ts) · [:42](../../../src/modules/recruitment/recruitment-promotion.service.ts) |
| 入队门禁 ①(一键入队) | `member.gradeCode != null → ALREADY_ENROLLED`;`memberDepartment 存在 → ALREADY_ENROLLED`;入队写 `create 目标部门` + `gradeCode=level-1` | [team-join-enrollment.service.ts:140-164](../../../src/modules/team-join/team-join-enrollment.service.ts) |
| 入队门禁 ②(自助发起申请) | **亲核新增**:`assertNotEnrolledOrThrow` 同样卡 `gradeCode!=null`/`有部门 → ALREADY_ENROLLED`(志愿者**自助**发起入队申请处) | [team-join-applications.app.service.ts:60-75](../../../src/modules/team-join/team-join-applications.app.service.ts) |
| `member_departments` 单部门约束 | `partial unique (memberId) WHERE deletedAt IS NULL`(migration.sql 末尾手写);单归属铁律 | [schema.prisma:243-265](../../../prisma/schema.prisma) |
| member_grade 字典 | 9 项:`volunteer`(sort0)/`level-1`..`level-7`/`reserve`;入队写 `level-1`(`JOIN_GRADE_CODE`) | seed.ts:115-126 · [team-join.constants.ts JOIN_GRADE_CODE](../../../src/modules/team-join/team-join.constants.ts) |
| 组织树 VOL/VOD | `VOL`(name 志愿者,`nodeTypeCode=volunteer`,seed.ts:634)≠ `VOD`(name 志愿者组织部,`nodeTypeCode=functional-dept`,seed.ts:629);根 SRVF + 15 部门 | seed.ts:606-635 |
| RBAC 码(招新+入队) | **15 码**(recruitment-cycle 3 + recruitment-application 5 + team-join-cycle 3 + team-join-application 4),**全绑 biz-admin 无例外** | seed.ts:2120-2239(绑定块 2341-2352 / 2407-2418) |
| RBAC 无字段级分级 | 列表(脱敏)/详情(明文)/证件照 signed-URL / 公示名单 **共用** `recruitment-application.read.record` | [service.ts:419](../../../src/modules/recruitment/recruitment-applications.service.ts) · [:451](../../../src/modules/recruitment/recruitment-applications.service.ts) · [:462](../../../src/modules/recruitment/recruitment-applications.service.ts) · [:663](../../../src/modules/recruitment/recruitment-applications.service.ts) |
| 无工作台/批量 | 无招新 stats/工作台端点;批量仅 promote 一处(无批量标门槛/通知/导出/发号预检) | (全仓无对应 controller) |
| SMS 可复用件 | `SmsCodeService.issue/verifyAndConsume/assertValid` + 三层限流 + 加密**全在**;`SmsPurpose` 是 **DB enum 4 值**;`SmsVerificationCode.userId` 列**可空**但方法形参 `userId:string`;**无验后持久凭证**(只 `User.phoneVerifiedAt`) | [sms-code.service.ts:51/171/200](../../../src/modules/sms/sms-code.service.ts) · [schema.prisma:1175/1189-1194](../../../prisma/schema.prisma) |
| 通知模块现状 | `notifications/` 仅生日 job,**零端点/零码/零 DTO**;新通知出口须回评审 | [notifications.module.ts:11-17](../../../src/modules/notifications/notifications.module.ts) · architecture-boundary §3.6 |

### 1.2 相对 goal 侦察的亲核纠正(8 处)

1. **入队门禁是「两处」耦合,非一处**(goal 仅列 enrollment ~134-150):报名侧自助发起申请 [team-join-applications.app.service.ts:60-75](../../../src/modules/team-join/team-join-applications.app.service.ts) 同样卡 `gradeCode==null+零部门`。**§5 改造必须同时改这两处 + `member_departments` 单部门写法**,否则志愿者连「发起入队申请」都进不去。
2. **`verifyOutcome` 已有 8 细分值**〔S4b 顺修:原稿误记 7〕(goal 述「仅一个 verifyOutcome 字段记原因」偏弱):OCR 改造分叉⑥ 已加 `forgery_warning/ocr_unclear/ocr_error/category_mismatch`([constants:25-33](../../../src/modules/recruitment/recruitment.constants.ts))。**§2 新拆分原因 = 复用扩展 `verifyOutcome`,真正缺的是 `riskLevel/ocrAttemptCount/applicantConfirmedOcrWrong/requiresRetake/manualReviewReason`(后台展示用人话归类)**。
3. **OCR 实为 6 分流不是 5**:`decideMainlandOcr` 5 分支(大陆)+ 非大陆恒人工([service:250-253](../../../src/modules/recruitment/recruitment-applications.service.ts))是独立第 6 路。
4. **「前端重拍」UX 钩子已部分存在**:`recognize()` 已返 `clarityOk:false`+重拍 hint([service:153-162](../../../src/modules/recruitment/recruitment-applications.service.ts));缺口是**提交端** `submit()` 仍把模糊→manual_review([:380](../../../src/modules/recruitment/recruitment-applications.service.ts))。§2 改造点 = 让提交端与识别端对齐「模糊不落记录」。
5. **`SmsPurpose` 是 DB enum**(非 String 约定):加 `RECRUITMENT_*` purpose = **D 档 enum migration**([schema:1189-1194](../../../prisma/schema.prisma)),非零成本。
6. **SMS 服务形参 `userId:string` 与匿名报名人冲突**:列 `userId` 可空但 `issue/verifyAndConsume` 形参非空([sms-code.service.ts:51/171](../../../src/modules/sms/sms-code.service.ts));§3 须放宽形参为 `string|null` 或传稳定 sentinel。
7. **无「验后持久凭证」**:验码成功只返 `{codeId}`(审计用),proof-of-phone 仅 `User.phoneVerifiedAt`(且只 bind 时写)。§3 的 `phoneVerificationToken` **必为净新建**。
8. **`join_source` 字典未 seed**:promote 写 `joinSourceCode='recruitment'` 为自由串(`MemberProfile.joinSourceCode` NOT NULL 但无 FK,直写可行)。非 bug,但 §5 promote 改造切片应顺手把 `join_source` 字典补 `recruitment` 项(镜像 phase-2 E-R2-15 遗留)。

---

## 2. OCR / 人工复核拆分(§2)

### 2.1 现状 → 目标判定树

**现状**:大陆 OCR 5 分支 + 非大陆 1 路,**全部塞 `manual_review`**,admin 只能靠 `verifyOutcome` 一个字段区分,模糊/上游失败/篡改/不一致/外籍混在一个队列。

**目标判定树**(提交端 `submit()` + 识别端 `recognize()` 对齐;E-P4-1 固化分流):

| 触发条件 | 目标处置 | 是否落报名记录 | 落点字段 |
|---|---|---|---|
| 大陆 OCR 匹配 + 清晰 + 无防伪告警 | **自动通过** `verified` + 发临时号(现状保留) | 是 | `verifyOutcome=matched` |
| 图片模糊 / OCR 读不出(`ocr_unclear`) | **前端重拍,不落报名记录、不进人工**;计数累积 | **否**(落 §3 身份会话行) | 会话行 `requiresRetake=true`、`ocrAttemptCount++`、`lastOcrOutcome=ocr_unclear` |
| OCR 与填写不一致(`mismatch`) | 先让申请人**三选一**:① 用 OCR 结果回填 ② 改自己填写 ③ 确认 OCR 错;**仅③** `applicantConfirmedOcrWrong=true` 才落记录进**普通人工** | ③才落 | `verifyOutcome=mismatch`、`manualReviewReason=ocr_mismatch_confirmed`、`riskLevel=normal` |
| 防伪告警 / 疑似篡改·复印·遮挡·翻拍(`forgery_warning`) | 先提示**重拍原件**;再不行落记录进**高风险复核**(与普通人工分流、单独标识) | 重拍 N 次后才落 | `verifyOutcome=forgery_warning`、`manualReviewReason=forgery_suspected`、`riskLevel=high` |
| OCR 上游失败/通道未配(`ocr_error`) | **首次**提示重试;**连续 2 次**(Q-P4-4)才落记录进「系统 OCR 异常」通道(与证件异常分流) | 连续失败后才落 | `verifyOutcome=ocr_error`、`manualReviewReason=system_ocr_error`、`riskLevel=system`〔S4b 顺修:原稿误记 normal,与 §2.4「系统异常栏=system」一致〕 |
| 特殊证件 / 非 OCR 类型 / 生僻字多次失败 | **人工**(现状保留,恒 `manual`) | 是 | `verifyOutcome=manual`、`manualReviewReason=special_document` |

> 「自助三选一」(Q-P4-2)与「高风险分流」(Q-P4-3)、「上游失败计次」(Q-P4-4)是产品口径,均带本稿推荐,见 §13。

### 2.2 字段设计(新增)与 `verifyOutcome` 关系

| 新字段 | 类型 | 含义 | 与既有关系 |
|---|---|---|---|
| `manualReviewReason` | String? | 后台「人工原因分类展示」人话码:`ocr_mismatch_confirmed`/`forgery_suspected`/`system_ocr_error`/`special_document`/`age_or_format`/`other` | **派生归类**自 `verifyOutcome`,供 admin 分流筛选;`verifyOutcome` 保留为「机器判定原因」、`manualReviewReason` 为「人工队列分类」并存(E-P4-2) |
| `riskLevel` | String? | `normal` / `high`(防伪/篡改)/ `system`(上游异常) | 新增,驱动「高风险复核」「系统异常通道」分队列 |
| `ocrAttemptCount` | Int | 付费 OCR / 重拍累计次数 | 新增,**落 §3 身份会话行**(不落 application,Q-P4-1) |
| `lastOcrOutcome` | String? | 最近一次 OCR 结论(=某个 `verifyOutcome` 值) | 新增,落会话行;submit 落库时快照进 application |
| `applicantConfirmedOcrWrong` | Boolean | 申请人是否「确认 OCR 错」 | 新增,决定 mismatch 是否进人工 |
| `requiresRetake` | Boolean | 是否处于「待重拍」(模糊/防伪重拍循环) | 新增,落会话行,驱动 §6 `stage=待重拍` |

### 2.3 「重拍计数存哪」方案建议(Q-P4-1,goal 强制)

**前提**:`recognize()` 无状态、`submit()` 才建 application → 重拍循环发生在**任何 application 行存在之前**,无处挂计数。

| 方案 | 评价 |
|---|---|
| (A) 客户端计数 | 最简、零 schema,但非服务端权威,不能强制「N 次后转人工」 |
| (B) 缓存(Redis/内存) | 服务端权威,但本仓**无 Redis**(限流为内存 throttler),内存重启即丢、多实例不一致 |
| (C) 草稿态 application | 反「不落报名记录」,污染 `recruitment_applications` 统计/去重 |
| **(D) 报名前身份会话行(推荐)** | **§3 H5 身份链本就要建一张 `RecruitmentIdentitySession`(按 手机+轮次)承载 `phoneVerifiedAt/phoneVerificationToken`;重拍计数顺带挂它**:`ocrAttemptCount/lastOcrOutcome/requiresRetake` 落会话行,submit 成功即结转/清理(或 TTL 过期清)。一表两用、零报名脏数据、服务端权威 |

**推荐 = (D) 为主 + (A) 客户端做即时 UX + IP 限流(现 `recruitment` throttler 10/3600)挡付费 OCR 滥用**。若维护者不接受新会话表(Q-P4-5 改否),退化为 (A)+IP 限流(纯 UX,放弃服务端强制转人工)。

### 2.4 后台「人工原因分类展示表」

admin 人工队列按 `riskLevel` 分三栏、按 `manualReviewReason` 分组:

| 队列 | `riskLevel` | 含 `manualReviewReason` | admin 动作 |
|---|---|---|---|
| 普通人工 | normal | ocr_mismatch_confirmed / special_document / age_or_format | 看证件照 → approve 发号 / reject |
| 高风险复核 | high | forgery_suspected | 重点核原件 → approve / reject(留重证据) |
| 系统异常 | system | system_ocr_error | 多为系统问题,人工补判或退回重试 |

### 2.5 风险 / 兼容

- `recognize()`/`submit()` OCR 调用顺序、付费纪律、`verified` 原子发号事务**不变**;仅在「不清晰/防伪/上游失败」的**落库决策**上改道(模糊不落、防伪重拍、上游计次)。
- 既有 `verifyOutcome` 值全保留(向后兼容);新字段全可空、纯加列,无破坏。
- **既有行为锁**:`verified` 唯一放行路径(匹配+清晰+无告警)+ 单事务原子发号 + 容量校验(FM-C)实施期间**任一破坏 = 停下报告**。

---

## 3. H5 + 手机号身份链(§3)

### 3.1 现状 → 目标

**现状**:`wechatCode` 必填、`phone` 仅通知、无短信验证、查询仅微信 code。**无微信环境(线下扫码 H5)无法自助报名/查询** = 闭环缺口。

**目标**:
- **两套入口**:小程序链(`wechatCode` 主、手机辅)/ H5 链(`phoneVerificationToken` 必填、`wechatCode` 可选)。
- **手机号定位上调**为身份链一环(Q-P4-5):验码 → 发 `phoneVerificationToken` → 提交/查询凭 token。
- **查询四法**(Q-P4-6,分期):① 微信 code(现状)② 手机+验证码 ③ 临时编号+手机 ④ 证件后四位+手机。
- **换绑**:换微信换绑、换手机换绑(+ 换绑历史 + 审计 + 后台解绑错误绑定)。

### 3.2 复用 SMS 基建 + 必补缺口

| 件 | 状态 | 改造 |
|---|---|---|
| `SmsCodeService.issue/verifyAndConsume/assertValid` | 全在 | 直接复用 |
| 三层限流(发 60s/10日 + IP send5 / verify10)、5min TTL、错5作废、加密 | 全在 | 直接复用 |
| `SmsPurpose` enum | 4 值,**DB enum** | **+`RECRUITMENT_BIND`(或 `RECRUITMENT_PHONE`)= D 档 enum migration**(E-P4-3) |
| `userId:string` 形参 vs 匿名报名人 | 冲突 | **放宽形参 `string\|null`(列本就可空)** 或传按手机派生的稳定 sentinel(E-P4-4;推荐放宽) |
| 验后持久凭证 | **无** | **新建 `phoneVerificationToken`**(短时、一次性、绑手机+轮次),承载于报名前身份会话行 |

### 3.3 报名前身份会话行设计(净新建;承载 §2 重拍计数)

新表 `RecruitmentIdentitySession`(命名待 T1 定;E-P4-5):

| 字段 | 含义 |
|---|---|
| `id` / `cycleId` / `createdAt` / `expiresAt` | 会话 + TTL(如 30min) |
| `phone` | 验证过的手机(身份链锚) |
| `phoneVerifiedAt` | 验码成功时刻 |
| `phoneVerificationMethod` | `sms`(H5)/ `wechat`(小程序辅) |
| `phoneVerificationToken` | 短时一次性令牌(提交/查询出示);submit 消费即作废 |
| `openid` | 可选(小程序链 code2session 得) |
| `ocrAttemptCount` / `lastOcrOutcome` / `requiresRetake` | §2 重拍计数(Q-P4-1) |

> 提交成功 → 会话行结转/软删,身份信息搬入 application;TTL 过期由留存 SOP 清。**会话行不进 `recruitment_applications`,不参与去重/统计/容量**。

### 3.4 换绑 + 历史 + 审计

| 场景 | 路径 | 落点 |
|---|---|---|
| 换微信换绑 | 新 `wechatCode` → code2session 新 openid → 校验本人(手机一致)→ 更新 application.openid | 审计 `recruitment-application.rebind-wechat` + 换绑历史行 |
| 换手机换绑 | 新手机验码 → token → 校验本人 → 更新 application.phone + `phoneChangedAt/phoneChangeReason` | 审计 `rebind-phone` + `phoneBindingHistory` Json 追加 |
| 后台解绑错误绑定 | admin 凭新 RBAC 码(§11)解绑/改绑 | 审计 + `phoneRiskFlag` 标记 |

application 侧新增落点字段(全可空):`phoneVerifiedAt/phoneVerificationMethod/phoneChangedAt/phoneChangeReason/phoneBindingHistory(Json)/phoneRiskFlag`。

### 3.5 风险 / 兼容

- `SmsPurpose` 加值是**唯一不可逆动作**(PG enum `ADD VALUE` 不可删)→ 走 srvf-prisma-change D 档降速,先人话简报。
- 小程序链(`wechatCode`)保持现状可用(向后兼容);H5 链为新增入口,不破坏既有提交。
- 跨 purpose 日限 10/日是**全局**(手机维度),H5 报名与其他短信流共享额度——可接受,T1 评估是否需独立额度。

---

## 4. 状态业务化(§4)

### 4.1 各层职责切清(E-P4-6)

| 层 | 管什么 | 不管什么 |
|---|---|---|
| 后端 | `statusCode`(机器态,String 不动)+ 派生 `stage`(业务态枚举)+ `nextAction`(动作码) | 不存「展示文案」明文(避免改文案要发版) |
| 字典 | `stage`→中文文案、按钮文案、说明(`recruitment_stage` 候选字典,可后台改) | 不参与状态流转判定 |
| 前端 | 渲染文案 + 按钮 + todoList 勾选态 | 不自行推断 stage(以后端 `stage` 为准) |

### 4.2 全状态 → 业务文案映射表

| `statusCode`(招新)| + 条件 | `stage` | 业务文案(`stageText`,字典候选)| 禁用文案 |
|---|---|---|---|---|
| (无记录,会话态)| `requiresRetake=true` | `retake` | 待重拍 | — |
| (无记录,会话态)| mismatch 待三选一 | `confirm` | 待核对 | — |
| `manual_review` | `riskLevel=high` | `manual_high` | 待人工(高风险复核)| — |
| `manual_review` | 其余 | `manual` | 待人工核验 | — |
| `verified` | 门槛未齐 | `threshold` | 门槛未完成 | — |
| `verified` | 门槛齐(瞬态,自动进下一态)| `threshold_done` | 门槛已完成 | — |
| `pending_evaluation` | — | `evaluation` | 待综合评定 | — |
| `publicity` | — | `publicity` | 公示中 | — |
| `promoted` | — | `volunteer` | **已转志愿者 / 待入队**(发号视角可加「已发永久编号」)| **禁「已晋升」**(Q-P4-8) |
| `rejected` | — | `rejected` | 未通过 | — |

入队段(`team_join_applications.statusCode`)续接:`joining→考核中` / `pending_evaluation→待综合评估` / `approved→待入队` / `joined→已正式入队` / `rejected→未通过`。

> **`promoted` enum 值不改库**(零 migration),仅改**展示层**文案 + `stage` 派生(E-P4-7)。

### 4.3 风险 / 兼容

- 纯展示派生,`statusCode` 流转逻辑**一字不改**;字典 `recruitment_stage` 为候选新增(可后台维护)。
- 与 §6 进度模型同源(stage 派生函数唯一真相),**列入首切片 S1**。

---

## 5. promote 志愿者化 + 入队门禁适配(§5,关键耦合 —— 给可执行解,不写「待定」)

### 5.1 耦合全貌(亲核:三处联动,非一处)

现「两层身份」靠 `gradeCode==null + 零部门` 表达「已发号未入队的志愿者」——这是 **phase-3 冻结取舍 E-J-6**(seed.ts:113「双表示是已知取舍,**不改 promote / team-join 代码**」);本章 §5 的改造**等于推翻该取舍**,故 Q-P4-7 须维护者明确拍板,而非工程师自决。promote 与入队**两处门禁 + 一处单部门约束**互锁:

```
promote(建 Member: gradeCode=null, 零部门)
   │
   ├─→ 志愿者自助发起入队申请: team-join-applications.app.service.ts:60-75
   │      assertNotEnrolledOrThrow: gradeCode!=null || 有部门 → ALREADY_ENROLLED
   │
   └─→ admin 一键入队: team-join-enrollment.service.ts:140-164
          140-147: gradeCode!=null || 有部门 → ALREADY_ENROLLED
          154-164: create 目标部门 + gradeCode=level-1
                   (受 member_departments partial unique (memberId) WHERE deletedAt IS NULL 约束)
```

**若 promote 改 `gradeCode=volunteer` + 建 VOL 部门而门禁不改 → 每个新志愿者连「发起入队申请」都被判 ALREADY_ENROLLED,闭环断裂。**

### 5.2 可执行解(E-P4-8;Q-P4-7 拍板后实施)

**(a) promote 改写**([recruitment-promotion.service.ts:131-133](../../../src/modules/recruitment/recruitment-promotion.service.ts)):
- `member.create` 加 `gradeCode: 'volunteer'`;
- 同事务 `memberDepartment.create({ memberId, organizationId: VOL_ORG_ID })`(VOL = `nodeTypeCode=volunteer` 节点,seed.ts:634;**≠ VOD**);
- VOL_ORG_ID 解析:按 `Organization.code='VOL'`(或 `nodeTypeCode='volunteer'` 唯一节点)运行时查,守 ACTIVE。

**(b) 两处门禁改判**(从「null+零部门」→「volunteer 身份 + 仅 VOL 部门」,**且兼容 legacy null+零部门**):
- 抽一个共享判定 `isUnenrolledVolunteer(member, depts)`(纯函数,两处调用,零漂移):
  - 新口径:`gradeCode=='volunteer'` 且 仅有一条 active 部门且其 org 是 VOL;
  - legacy 口径:`gradeCode==null` 且 零 active 部门;
  - 命中任一 → 视为「未入队志愿者」放行。
- 落点:[team-join-applications.app.service.ts:60-75](../../../src/modules/team-join/team-join-applications.app.service.ts) + [team-join-enrollment.service.ts:140-147](../../../src/modules/team-join/team-join-enrollment.service.ts) 同步改。

**(c) 入队写改法**([team-join-enrollment.service.ts:154-164](../../../src/modules/team-join/team-join-enrollment.service.ts)):
- 受单部门 partial unique 约束,不能同时存在 VOL + 目标两条 active 行;
- 新写法(单事务,全或无):**软删 VOL 部门行(若存在)→ create 目标部门行 → `gradeCode` volunteer/null → `level-1`**;
- legacy 成员(零部门)→ 直接 create 目标部门(现状路径),无 VOL 行可删。

**(d) 历史 `null` 成员兼容**:
- **首选 = 门禁双兼容(b),零迁移、零不可逆动作**;已 promote 的 `null` 志愿者照常能发起/入队。
- **可选后续 = 一次性 backfill**(把 `null` + 零部门的未入队成员补 `volunteer`+VOL 部门,D 档数据迁移)——非必须,留作清理切片,**不在首实施范围**。

### 5.3 阶段身份表

| 阶段 | 实体 | 身份表达 |
|---|---|---|
| 报名申请人 | `RecruitmentApplication`(无 Member FK)| `statusCode` ∈ verified/manual/... |
| 招新候选人 | 同上 | publicity / pending_evaluation |
| **志愿者** | `Member` | **新:`gradeCode=volunteer` + VOL 部门**;legacy:`null` + 零部门 |
| 正式队员 | `Member` | `gradeCode=level-1..7` + 目标部门 |

### 5.4 风险 / 兼容

- promote 改动牵动 `members`/`member_departments` 写 + VOL 节点依赖(须先确认 VOL ACTIVE);走 srvf-god-service-refactor + srvf-prisma-change 双 D 档。
- **既有行为锁**:promote 单事务「全或无、号段连续无空洞、幂等(promotedMemberId 置则不重入 + @unique 兜底)」实施期**任一破坏 = 停下报告**;入队单部门 partial unique 不可绕。
- backfill(若做)= 不可逆数据变更,单独 D 档降速 + 人话简报。

---

## 6. 新人进度模型(§6)

### 6.1 响应模型(纯读派生;E-P4-9)

公开查询 / 小程序进度页统一返回(跨「招新 statusCode + thresholdMarks + 入队 statusCode + 会话态」派生):

```
{
  stage,            // §4.2 业务态枚举(含 retake/confirm/... volunteer/joined)
  stageText,        // 字典文案(后台可维护)
  statusText,       // 一句话当前状态说明
  nextAction,       // 动作码(retake/confirm-ocr/wait-review/complete-threshold/...)
  tempNo,           // 临时编号(verified 后)
  memberNo,         // 永久编号(promoted 后,经 promotedMemberId→Member.memberNo)
  identityText,     // 身份文案:报名申请人/招新候选人/志愿者/正式队员
  todoList: [ { code, name, done } ],   // 门槛/待办清单(5 招新门槛 / 8+4 入队 gate 投影)
  meetingInfo, qqGroup, notice          // 轮次通知配置(现状字段)
}
```

### 6.2 九阶段展示文案 + 按钮动作

| 阶段 | 文案 | 按钮动作(`nextAction`)|
|---|---|---|
| 待重拍 | 证件照不清晰/疑似异常,请重拍 | 重新拍照上传(`retake`)|
| 待核对 | OCR 与填写不一致,请核对 | 用OCR结果 / 改填写 / 确认OCR错(`confirm-ocr`)|
| 待人工 | 已提交,人工核验中 | 等待(`wait-review`),可看进度 |
| 已初审 | 核验通过,临时编号 T… | 查看门槛清单(`view-threshold`)|
| 门槛未完成 | 还差 N 项门槛 | 按 todoList 完成(`complete-threshold`)|
| 待综合评定 | 门槛已齐,等待综合评定 | 等待(`wait-evaluation`)|
| 公示 | 公示中,拟发编号 … | 查看公示(`view-publicity`)|
| 已转志愿者 | 已发永久编号 …,可发起入队 | 发起入队申请(`apply-teamjoin`)|
| 已正式入队 | 已加入 …(部门),级别 level-1 | 完成(`done`)|

### 6.3 风险 / 兼容

- **纯读、零 schema(stage 派生函数)、零耦合**;与 §4 共享 stage 真相源。
- **列为首切片 S1**(零风险冷启动,先把闭环「可见」做出来)。

---

## 7. 招新工作台(§7)

### 7.1 聚合只读 stats 端点设计(E-P4-10)

`GET /api/admin/v1/recruitment/cycles/:id/stats`(或不带 cycle 取当前 open 轮),RBAC 复用 `recruitment-application.read.record`(只读聚合,无敏感明文),覆盖五组:

| 组 | 指标 | 来源 |
|---|---|---|
| 今日数据 | 今日新报名 / 今日发临时号 / 今日人工处理数 | createdAt/verifiedAt/reviewedAt 当日聚合(北京日界)|
| 待处理事项 | 待人工(分 normal/high/system 三栏)/ 待综合评定 / 待发号(publicity)| `statusCode` + `riskLevel` count |
| 门槛进度 | 门槛跟踪中人数 / 各门槛完成分布(5 项)| `thresholdMarks` 聚合 |
| 综合评定 | 待评定 / 已通过 / 已淘汰 | `pending_evaluation`/`publicity`/`rejected(evaluation)` |
| 公示发号 | 公示中人数 / 可一键发号数 / 需手动建档数 / 已发号 | 复用 `decidePromotionIssuance` 预判 + `promoted` count |

### 7.2 风险 / 兼容 / 交接

- 纯读聚合,零 schema、零写;**答 handoff GAP-003「招新进度」部分**(其余「待审报名/进行中活动」仍可与活动域 stats 合并)。
- 与 §6 stage 派生共享口径(`待处理事项` 即各 stage 计数)。**切片 S2,依赖 S1 的 stage 函数。**

---

## 8. 批量操作(§8)

### 8.1 四类批量端点形态(E-P4-11)

| 操作 | 端点形态 | 幂等 | 审计 |
|---|---|---|---|
| 批量标门槛 | `POST .../applications/batch-mark-threshold`,入参 = 匹配键(临时编号/手机/姓名+手机/签到记录导入)+ thresholdCode + completed | 标记幂等(重复标同值无副作用,沿现 markThreshold)| 每行一条 `mark-threshold` audit + 批次汇总 |
| 批量通知 | `POST .../applications/batch-notify`(挂 §9 通知出口落地后)| 同一通知不重发(通知去重键)| 批次 audit |
| 批量导出 | `POST .../applications/export`,**按 §11 权限脱敏**(普通码出脱敏列,敏感码出明文)| 读操作,无副作用 | `export` placeholder audit(含 admin/范围/脱敏级)|
| 一键发号前预检 | `GET .../cycles/:id/promote-precheck` | 纯读 | placeholder audit |

### 8.2 发号预检输出(复用 `decidePromotionIssuance`,结构性保证「预检 = 实发」)

每行:`可发 / 跳过 + 跳过原因`(foreign-manual-build / openid-already-bound / missing-openid / duplicate-openid-in-batch / missing-derived-field / incomplete-data),+ 重复 openid 高亮、缺手机/生日/性别、特殊证件标识。**与公示 `publicityList` / promote 同源**([constants:154-170](../../../src/modules/recruitment/recruitment.constants.ts))。

### 8.3 风险 / 兼容

- 批量写(标门槛/通知)须逐行幂等 + 批次单事务或逐行容错(择一,T1 定);批量导出**强依赖 §11 字段分级落地**(否则脱敏无码可依)→ 切片顺序 S3(RBAC)先于 S6(批量)。
- 批量通知阻塞于 §9 / GAP-005。

---

## 9. 通知闭环(§9,依赖耦合 —— 给排期与接口约定,本批不自建出口)

### 9.1 状态变更触发点清单(现在登记,出口后挂)

| 触发 | 渠道(目标)| payload 要素 |
|---|---|---|
| 报名受理(verified 发临时号)| 站内信 + 可选订阅消息 | tempNo / cycleName / 下一步 |
| 转人工 / 人工结果(approve/reject)| 站内信 | stage / reason(脱敏)|
| 门槛进度更新 / 门槛齐 | 站内信 | todoList 完成度 |
| 综合评定结果 / 公示开始 | 站内信 | stage / 公示链接 |
| 发号(已转志愿者)| 站内信 + 订阅消息 | memberNo / 发起入队入口 |
| 入队结果(joined/rejected)| 站内信 | 部门 / 级别 |

### 9.2 接口约定 + 排期(Q-P4-11)

- **本批只登记触发点 + payload 契约 + 渠道倾向**,**不自建通知出口、不加 Effect 类、不在本模块自由生长**(architecture-boundary §3.6 + [notifications.module.ts:11-12](../../../src/modules/notifications/notifications.module.ts):「后续新通知类型先回评审」)。
- **挂载时点 = GAP-005 会员通知模块(站内信 + 已读表,[member-notification-review.md](./member-notification-review.md))落地之后**;招新触发点作为该模块的「系统触发源」之一接入(届时回评审一次:招新触发是否走 manual `admin 撰写` 之外的「系统自动站内信」,可能需 GAP-005 的「触发方式 ⑧」从纯手动放宽)。
- 排期:**切片 S7,前置 = GAP-005 模块发版**;本稿只产出契约,不实现。

### 9.3 风险 / 兼容

- 若先于 GAP-005 实现招新通知 = 造第二个通知出口,**违反架构边界,禁止**。
- GAP-005 当前 T0 冻结但 5 决策未拍板、未建;**S7 是全程最末、阻塞最重的切片**。

---

## 10. 纠错流程(§10)

| 场景 | 风险/策略 | 处理路径 | 审计 |
|---|---|---|---|
| 重复报名(同证/同手机/同微信)| 现 partial unique(cycleId+idCardNumber)挡同证;手机/微信重复给**前端风险提示**(非硬拦)| 提交端预检提示 + P2002 兜底 28003 | submit audit |
| rejected 后重报 | 现状允许(partial unique `statusCode<>rejected`)| 直接重报,新行 | submit audit |
| 换微信 | §3.4 换绑 | 校验本人 → 更新 openid | rebind-wechat |
| 换手机 | §3.4 换绑 | 验码 → 更新 phone | rebind-phone + 历史 |
| OCR 错(误判不一致)| 自助三选一「确认OCR错」(§2)| 申请人确认 → 普通人工 → admin 看图放行 | resolve-manual |
| **误通过(发号前撤回)** | publicity/verified 未发号 → 可逆 | admin 撤回到 manual_review / rejected(新「纠错」码)| correct-withdraw |
| **误通过(发号后)** | 已建 User+Member+号段 → **不回滚**(守号段连续)| 走「档案纠错」:改 Member/Profile 字段 + 标注;不删号 | correct-archive(双留痕)|
| 误拒绝 | 留两条记录(原 rejected + 重开)| 重开/重提,新行 + 链原行 | reopen(留两条)|
| 发号后资料纠错 | 同误通过发号后 | 档案纠错端点 | correct-archive |
| 公示投诉 | 公示期内 | admin 撤下(publicity→manual/rejected)+ 记投诉 | correct-withdraw + note |

> 「发号后不回滚、改向前纠错」是 Q-P4-9 拍板项(守 promote「号段连续无空洞」铁律)。纠错动作绑新 RBAC `correct.*` 码(§11)。

---

## 11. RBAC 字段分级(§11)

### 11.1 现状 → 目标拆分(命名沿 `<resource>.<action>.<scope>` kebab-case,AGENTS §audit/命名铁律)

现 `recruitment-application.read.record` **一码看尽**列表(脱敏)+ 详情(明文身份证)+ 证件照 signed-URL + 公示名单 → 拆为六类:

| 新码 | 覆盖 | 现码迁移 |
|---|---|---|
| `recruitment-application.read.record` | 普通查看:脱敏列表 + 脱敏详情 + 公示名单 + 工作台 stats | **语义收窄**(保留码,去掉明文)|
| `recruitment-application.read.sensitive` | 敏感查看:完整证件号 / 证件照 signed-URL / 详址 / 紧急联系人 / OCR 详情 / 审核备注 | **新增**(从 read.record 切出)|
| `recruitment-application.resolve.manual` | 审核(人工 resolve)| 现状保留 |
| `recruitment-application.mark.threshold` | 门槛标记 | 现状保留 |
| `recruitment-application.promote.member` | 发号 | 现状保留 |
| `recruitment-application.correct.record` | 纠错(撤回/档案纠错/重开/解绑,§10)| **新增** |

> `evaluate.assessment`(综合评定)现状保留。批量导出按 持 `read.record`(出脱敏)/ `read.sensitive`(出明文)分级(§8)。

### 11.2 绑定角色 + 迁移关系

- 全部默认绑 `biz-admin`(沿现 15 码无例外);`read.sensitive` / `correct.record` 是否对 ops-admin 或细分子角色开放 = 待 T1 与权限地图(`docs/ai-harness/RBAC_MAP.md`)一起定。
- **迁移关键**:现持 `read.record` 的角色,拆分后**默认补挂 `read.sensitive`**(避免 admin 突然看不到明文,行为不回退);新部署再按需收紧——T1 须给「现码→新码」幂等补挂 seed 脚本。

### 11.3 风险 / 兼容

- 改 RBAC 码 = 改 admin-web 契约 → **须同 PR 更新前端对接指南**(srvf-admin-web-frontend-integration 铁律);走 `docs:rbacmap:check`。
- 字段级分级是 §8 批量导出脱敏的前置 → **切片 S3 先行**。

---

## 12. 分期实施路线图(§12)

### 12.1 切片表(有序;每片标档位/依赖/前后置/增量估算)

| 切片 | 内容 | 档位 | 依赖/前置 | schema | 端点 | RBAC | 说明 |
|---|---|---|---|---|---|---|---|
| **S1**(首推)| 状态业务文案 + 新人进度模型(§4+§6)| **A** | 无 | 0(字典 `recruitment_stage` 候选)| 改造现查询出参 + 可加进度端点 | 0 | **纯读、零 schema、零耦合**,先把闭环「可见」 |
| **S2** | 招新工作台 stats(§7)| **A** | S1(stage 函数)| 0 | +1 聚合 stats 端点 | 0(复用 read.record)| 答 GAP-003 招新进度 |
| **S3** | RBAC 字段分级(§11)| **D-lite** | 无(但 S6 前置)| 0 列(改 seed RBAC + 绑定)| 既有端点判权细化 | +2(`read.sensitive`/`correct.record`)| 同 PR 更新前端指南 + rbacmap:check |
| **S4** | H5 + 手机身份链 + 报名前会话表 + OCR 拆分(§2+§3)| **D** | 无 | +1 表(IdentitySession)+ application 多个可空列 + `SmsPurpose` enum 加值 | +验码/发token/提交(H5)+ 三选一 | 0(自助无码)| 最大 schema 切片;含不可逆 enum migration,srvf-prisma-change D 档 |
| **S5** | promote 志愿者化 + 入队两处门禁适配(§5)| **D/E** | 无(独立)| 0 列(+`join_source` 字典补 `recruitment`)| 改 promote + 两 gate 内部 | 0 | **最重一刀**,牵动 members/member_departments;backfill 可选后续 |
| **S6** | 批量操作(标门槛/导出/发号预检;§8 通知除外)| **E** | S1(stage)、S3(脱敏码)| 0 | +批量/预检/导出端点 | 复用 + 脱敏分级 | 导出强依赖 S3 |
| **S7** | 通知闭环(§9)| **A/E** | **GAP-005 会员通知模块发版**(阻塞)| 0(复用 GAP-005)| 触发挂接 | 0 | 全程最末,阻塞最重;本批只出契约 |

> 切片内可再拆 PR(如 S4 拆「身份会话+H5」与「OCR 拆分」两 PR);每片实施前另出 per-feature goal,**拍板对应 Q-P4-* 后**方可动工。S3 与 S4/S5 相对独立可并行排期;S6 须等 S1+S3;S7 须等 GAP-005。

### 12.2 待拍板清单(逐切片 T1 拍板用)

**完整 12 条待拍板见顶部 ⚠️ 清单**(Q-P4-1 ~ Q-P4-12,每条带本稿推荐 + 一句话理由 + 牵动章节)。逐切片映射:

| 切片 | 须先拍板 |
|---|---|
| S1 | Q-P4-8(promoted 文案)|
| S2 | (沿 S1)|
| S3 | Q-P4-10(敏感查看拆码)、Q-P4-12(导出脱敏口径)|
| S4 | Q-P4-1(重拍计数存哪)、Q-P4-2(三选一)、Q-P4-3(高风险分流)、Q-P4-4(上游失败计次)、Q-P4-5(手机身份链)、Q-P4-6(查询四法范围)|
| S5 | Q-P4-7(promote 志愿者化 + 门禁)|
| S6 | Q-P4-12(批量口径)|
| S7 | Q-P4-11(通知挂载时点)|
| S10/纠错 | Q-P4-9(发号后纠错边界)|

---

## 13. 风险表(D 档降速)

| 项 | 结论 |
|---|---|
| 改 schema? | **是(S4/S5)**:S4 新 `RecruitmentIdentitySession` 表 + application 多个可空列 + `SmsPurpose` enum 加值;S5 零列(改写 + 字典补项)。S1/S2/S6/S7 零 schema |
| 新 migration? | 是(S4;含**不可逆** PG enum `ADD VALUE`)→ srvf-prisma-change D 档,先人话简报 |
| 不可逆数据变更? | S4 enum 加值不可逆;S5 可选 backfill 不可逆(默认不做)。promote 改写本身不删旧数据 |
| 新 cron? | 否(会话行 TTL 清理走留存 SOP,不引 cron) |
| 改 RBAC 码? | 是(S3 +2 码 / S5 字典 / S10 +纠错码)→ 同 PR 更新前端指南 + `docs:rbacmap:check` |
| 改 enum/状态机值? | 招新/入队 statusCode **不动**(纯展示派生);仅 `SmsPurpose` 加值(S4)|
| 新通知出口/Effect? | **否(本批禁)**;S7 复用 GAP-005,回评审后挂接(architecture-boundary §3.6)|
| 触前端契约? | 是(S1 出参 / S3 RBAC / S4 H5 端点)→ srvf-fe-be-handoff 同 PR 更新 docs/handoff |
| 破坏既有行为锁? | 否(本稿为设计;实施期 promote 单事务/号段连续/容量原子/单部门 unique/`verified` 唯一放行 任一破坏 = 停下报告)|
| 需维护者拍板? | 是(12 条 Q-P4-*,见顶部清单;**未拍板不实施**)|

---

## 14. 本期不做(终版必列)/ 既有行为锁

**本期(T0)不做**:任何代码 / schema / migration / seed / enum / RBAC 码 / 端点;不碰 GAP-005 会员通知模块实现;不替维护者拍板纯产品决策(全写入 ⚠️ 清单带推荐);不做 backfill。

**实施期(各切片 T1+)既有行为锁**(任一破坏 = 停下报告):
1. promote 单事务「全或无 / 号段连续无空洞 / 幂等(promotedMemberId + @unique 兜底)/ 失败可恢复」;
2. `member_departments` 单部门 partial unique(memberId WHERE deletedAt IS NULL)不可绕;
3. 招新 `verified` 唯一放行路径(OCR 匹配+清晰+无告警)+ 单事务原子发临时号 + 容量校验 FM-C;
4. 入队「两层身份转换在入队时点才赋部门+级别」+ 综合评估本轮有效/延长期消费;
5. 敏感字段掩码三不(日志/audit/snapshot 不出明文身份证/姓名/手机)+ 证件照 L3 短 TTL signed-URL;
6. 招新/入队 `statusCode` 流转逻辑不因展示业务化而变。

---

> **冻结声明**:本评审稿自 2026-06-24 冻结,不回改。产品 **12 项待维护者拍板**(§13 / 顶部 ⚠️ 清单),每条带本稿推荐;实施(各切片 T1+)以本稿为准,与 goal 原文冲突时 goal 优先;**未拍板前不实施**。两处关键耦合的最终建议:**§5** = promote 改 `gradeCode=volunteer`+建 VOL 部门,配套把入队**两处**门禁(自助发起 `app.service.ts:60-75` + 一键入队 `enrollment.service.ts:140-164`)改判为「volunteer+仅VOL部门」并兼容 legacy `null`+零部门,入队写改「软删 VOL + create 目标」守单部门 unique,历史成员零迁移;**§9** = 状态变更通知只登记触发点+payload 契约,通知出口复用 GAP-005 会员通知模块(站内信)落地后挂接,本批不自建出口/Effect(architecture-boundary §3.6)。首切片 = **S1 状态业务文案 + 新人进度模型(档 A,纯读零 schema 零耦合)**。
