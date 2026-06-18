# SRVF 招新二期(招新后段)评审稿(Recruitment Phase-2 Back-Segment Review)

> **状态:冻结**(2026-06-19;goal「招新 phase 2(招新后段)— 门槛 → 综合评定 → 公示 → 一键发永久编号(建 User+Member)」拍板,goal 文本即立项 + 评审授权;**§0.5 四项元核验已于 2026-06-19 经维护者全部「按推荐」冻结**;本稿按 [`process.md §4`](../../process.md) D 档降速产出,冻结后不回改)。
> **业务依据**:goal 原文(自含,维护者已拍板事实)+ 招新需求会会议包(门槛/综合评定/公示/发号四节点)。需求文档不入仓,引用以 goal 原文为准。
> **范式母本**:① 状态机 + partial unique 沿 `recruitment_applications`(phase-1)既成;② 发号原子性逐层镜像 phase-1 `tempNoSeq` 行级自增,**升级为批量单事务**;③ User/Member/profile/紧急联系人写入镜像既有 `users`/`members`/`member-profiles`/`emergency-contacts` 模块的 create 范式;④ promote 数据搬家 + 敏感清理沿 phase-1 留存 SOP 精神。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线 / `api-surface-policy.md`(沿 process §6);但在「本期招新后段范围内的具体设计取舍」上,本稿即冻结决议。
> **承接**:phase-1 冻结评审稿 [`recruitment-phase1-review.md`](recruitment-phase1-review.md)(D-R / E-R 编号沿用;本稿新决议用 **D-R2 / E-R2** 前缀,元核验项用 **M-** 前缀)。

---

## 0. TL;DR

1. **不碰新模块,扩 `recruitment/` 第 26 模块**:招新后段全部增量落在既有 recruitment 模块;**不新建模块、不新建表、不新建 enum、不新建 throttler**。入口态 = phase-1 的 `verified`(临时编号已发、待门槛)。
2. **状态机 +3 字符串态(M-2)**:`verified`(门槛跟踪中,reused)→ `pending_evaluation`(待综合评定,门槛全完成自动推进)→ `publicity`(公示中)→ `promoted`(已发永久编号,终态);`rejected` reused,`eliminationStage` +2 值(`evaluation` / `threshold-timeout`)。**全为 String,沿 `activity_registrations.statusCode` 范式,无 migration。**
3. **门槛 = 轻量 admin 标记(D-R2-2 / M-3)**:5 项固定门槛(巡山×2 + 培训 + 红十字 + BSAFE)落单列 `recruitment_applications.thresholdMarks Json?`,每项 `{at, by}`(谁标 / 何时);**不打通现有活动/考勤/证书模块,只判完成与否、不算工时/贡献值**;补课 = 改 JSON;末次完成自动推进 `verified`→`pending_evaluation`,清空自动回退。
4. **综合评定 = 单一人工闸(D-R2-3)**:biz-admin 在 `pending_evaluation` 标通过/不通过 + 备注;通过→`publicity`,不通过→`rejected`(eliminationStage='evaluation');**verified 态可由同一 evaluate 端点 approved=false 直接淘汰**(门槛超期/退出,eliminationStage='threshold-timeout')。
5. **公示名单(D-R2-4)**:系统出名单 = 姓名 + 拟发编号(拼音序,**零敏感**)→ 官网外部公示(系统不强制时长)→ admin 点「公示结束发号」。`GET .../cycles/:id/publicity-list` 返计算式预览(拟发编号 = 同一确定性拼音排序 + 当前 memberNoSeq 推算,发号时一致)。
6. **promote / 一键发号(D-R2-5;最重一刀)**:对 cycle 内全部 `publicity` 报名按**姓名拼音序**分配 `{YY}{NNN}` → 建 **User**(绑 openid,可登录小程序)+ **Member**(永久 memberNo)+ **member_profiles** + **emergency_contacts** → 标 `promoted` + `promotedMemberId`。**单一事务、全或无、号段连续无空洞、幂等可重跑**(吸取 phase-1 FM-A);**两层身份铁律:建的是无部门、无级别志愿者**(phase 3 入队才有)。
7. **永久编号 `{YY}{NNN}`(D-R2-6 / M-4)**:`{YY}` = cycle.year 后两位(与 phase-1 tempNo 同源);`{NNN}` = 当年流水 001 起;计数器 `recruitment_cycles.memberNoSeq Int @default(0)` 批量事务内 +N;撞既有 memberNo @unique → 整批报错不跳号;撞 999 → 报错(新 BizCode,不扩位)。
8. **拼音排序无新依赖(E-R2-4;化解 goal 红线担忧)**:Node 自带 full-ICU `Intl.Collator('zh-u-co-pinyin')` 应用层排序 by `realName`(实测 node22/icu78 正确),**零新 npm 依赖 / 零 DB collation / 零拼音列 → ARCHITECTURE §9 红线完全不触发**;goal 列的三选一全不需要。
9. **wrinkle① 证件照(E-R2-3)**:`member_profiles` +`idCardImageKey String?`(裸 key,镜像 `User.avatarKey`)**不进 Attachment 多态表、不触 E-20 整包**;promote 时搬 key(profile 接管,application 清空 key,blob 单一属主);phase-2 不加成员证件照查看端点。
10. **wrinkle③ User(E-R2-5)**:微信-only 志愿者 User = `passwordHash`=bcrypt(高熵随机)+ `username`=memberNo + `openid`=报名 openid + `email`/`phone`=null + `role`=USER + `memberId`=新 member;**零 schema 改动、零 auth 改动**;密码登录因随机口令天然关闭,日后可走既有 SMS 改密。
11. **档案缺口(M-1)**:`member_profiles.email` 放宽为可空(报名链路不采集 email);**v1 一键发号仅限可派生 birthDate+genderCode 的大陆报名**,外籍 verified 暂不进批量发号(留待既有 admin 建档手填);唯一触碰既有共享模型(member_profiles)的列改动,迁移安全。
12. **增量小结**:schema 第 20 migration(`recruitment_applications` +5 列 / `recruitment_cycles` +1 列 / `member_profiles` +1 列 + email 改可空);BizCode 28041-28043(3 码)；权限码 +3 全绑 biz-admin(136→139)；audit union +3(48→51)；端点 +4 admin(thresholds / evaluate / publicity-list / promote)。**公开侧零新端点、零新 throttler。**
13. **零行为漂移**:auth / wechat / sms / 活动 / 考勤 / 证书 / attachments / members-create 一律零 diff;phase-1 报名链路零回归;既有 e2e 断言零修改(member_profiles.email 放宽仅 widening,存量有值成员断言不受影响)。

---

## 0.5 元核验结论(2026-06-19 冻结)

> **元核验结论(2026-06-19,维护者)**:四项产品/数据口径全部「按推荐」,其余按 T0 简报推荐冻结。本节记录四项拍板存档。

**M-1 · 档案 NOT NULL 缺口 — ✅ 放宽 email + 限大陆发号**
报名表不采集 email,`MemberProfile.email` 是 NOT NULL;外籍报名 birthDate/genderCode 为 null(只大陆身份证派生)。取**放宽 `member_profiles.email` 为可空**(迁移安全,存量行有值不受影响,admin profile DTO 仍业务必填 email)+ **v1 一键发号仅处理可派生 birthDate+genderCode 的大陆报名**;外籍 verified 报名暂不进批量发号(出口 = 既有 admin 建档手填全字段)。不放宽 birthDate/genderCode(避免触碰两个一级必填列)、不伪造数据。

**M-2 · 状态机形态 — ✅ 3 新态 + 自动推进**
取 **+3 字符串态**(`pending_evaluation` / `publicity` / `promoted`);门槛标记端点**单一真相源**自动推进 `verified`↔`pending_evaluation`(每次标记重算「5 项是否全完成」,只在此二态间切换;评定后门槛不可再动)。biz-admin 得干净「待评定」工作清单,零额外点击;贴合 goal 列出的 5 节点流。不取「并掉 pending_evaluation 精简 2 态」(丢工作清单信号)。

**M-3 · 门槛标记落库 — ✅ 单列 JSON**
取**单列 `recruitment_applications.thresholdMarks Json?`**(沿 `emergencyContacts`/`profileExtra`/`notifyTemplate` 既成 JSON 范式);5 固定 code 常量,每项 `{at, by}`;1 列、加第 6 项门槛免 migration、补课 = 改 JSON。不取扁平 10 列(列多 + 改门槛集要 migration)。

**M-4 · 永久号 999 溢出 — ✅ 报错**
取**报错**(新 BizCode `RECRUITMENT_MEMBER_NO_EXHAUSTED`),保持 `{YY}{NNN}` 固定 5 位。公益救援队单年新增 >999 人不现实;报错最安全、格式不漂、下游固定 5 位假设不破。不取自动扩位(`{YY}{NNNN}` 变长破坏下游假设)。

---

## 1. 决策汇总表

### 1.1 goal 已拍板项(D-R2;冻结,不重开)

| # | 决策 |
|---|---|
| D-R2-1 | **后段四节点**:入口态 `verified`(临时编号已发)→ 门槛(巡山×2 + 培训 + 红十字 + BSAFE 完成)→ 综合评定(单一人工闸)→ 公示(官网)→ 一键发永久编号 = 建 User+Member |
| D-R2-2 | **门槛 = 轻量 admin 标记**:报名记录上加完成标记,admin/带队人后台勾;补课 = 改标记;**不打通现有活动/考勤/证书模块**(报名者临时身份,门槛只判「完成与否」,不算工时/贡献值) |
| D-R2-3 | **综合评定 = 单一人工闸**:门槛全完成后,biz-admin 标 通过/不通过 + 备注 |
| D-R2-4 | **公示 = 系统出名单**(姓名 + 拟发编号,拼音序,**不含敏感**)→ 官网外部公示(系统不强制时长)→ admin 点「公示结束发号」 |
| D-R2-5 | **promote = 一键发号即建 User**(绑报名 openid,志愿者可登录小程序)+ **Member**(永久 memberNo)+ 迁移报名数据进 member_profiles / emergency_contacts;**志愿者此时无部门、无级别**(phase 3 入队才有) |
| D-R2-6 | **永久编号格式 `{YY}{NNN}`**(2 位年份 + 3 位流水,如 26001);按姓名拼音首字母排序、一键批量分配;每年流水上限 999 |
| D-R2-7 | **不在范围**:phase 3(入队 10 项 / 部门 / 级别);打通现有活动/考勤/证书给报名者(approach A 已定);接真实腾讯云通道;新 cron;改既有 login/wechat/sms/活动/考勤/证书 行为 |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 代决 | 依据 |
|---|---|---|
| E-R2-1 | 状态机 +3 字符串态(`pending_evaluation` / `publicity` / `promoted`),`rejected` reused;`eliminationStage` +2 值(`evaluation` / `threshold-timeout`);全 String 常量,**无 migration**(ops 可扩) | 沿 phase-1 E-R-8 `activity_registrations.statusCode` 范式 |
| E-R2-2 | 门槛 = `thresholdMarks Json?`,5 固定 code(`patrol1` / `patrol2` / `training` / `redCross` / `bsafe`),各 `{at: ISO, by: userId}`;标记端点幂等,**仅 `verified` / `pending_evaluation` 态可标**(他态 28041);末次完成自动→`pending_evaluation`,清空→回退 `verified`(单一真相源,只在此二态切换) | M-3;沿既成 JSON 范式 |
| E-R2-3 | wrinkle① 证件照:`member_profiles` +`idCardImageKey String?`(裸 key,镜像 `User.avatarKey`)**不进 Attachment、不触 E-20**;promote 搬 key(profile 接管 + application 清 key,同一 storage 对象,blob 单属主);**phase-2 不加成员证件照查看端点**(留存备查,要查另立项) | wrinkle①推荐;phase-1 E-R-15 分叉③A 延续 |
| E-R2-4 | wrinkle② 拼音:**Node 自带 full-ICU `Intl.Collator('zh-u-co-pinyin')` 应用层排序** by `realName` + 稳定次级键(`createdAt`, `id`);**零新依赖 / 零 DB collation / 零拼音列 → ARCHITECTURE §9 红线不触发**;docker-smoke 加 full-ICU 锚行(防 base image 退化 small-icu,DoD 显式项) | wrinkle②推荐;实测 node22/icu78 正确 |
| E-R2-5 | wrinkle③ User:`passwordHash`=bcrypt(高熵随机串,复用既有 hashPassword)+ `username`=memberNo + `openid`=报名 openid + `email`=null + `phone`=null(报名手机仅通知/未验证,改入 `member_profiles.mobile`)+ `role`=USER + `status`=ACTIVE + `memberId`=新 member;**零 schema/auth 改**;`openid`/`username`/`memberNo` @unique **含软删预检** + P2002 兜底 | wrinkle③推荐;镜像 users.service create 范式 |
| E-R2-6 | 发号原子性:`recruitment_cycles` +`memberNoSeq Int @default(0)`(镜像 phase-1 tempNoSeq);批量 promote **单一事务**(锁 cycle 行 → 取 `publicity` 集 → 拼音排序 → 分配 `{YY}{memberNoSeq+1..+N}` → 逐个建 User+Member+profile+contacts → 标 `promoted`+`promotedMemberId` → `memberNoSeq+=N`);**事务前全集校验**(任一报名缺必填/缺 openid/openid 已绑/非大陆缺派生字段 → 整批拒 28042、零发号);幂等(`promoted` 离开 `publicity` + `promotedMemberId` 置则跳 + @unique 兜底);`{YY}`=cycle.year 后两位 | E-R2 发号;吸取 phase-1 FM-A 半建态教训 |
| E-R2-7 | promote 数据迁移(§6 逐字段):email→null(M-1);`joinedDate`=发号日(归一 00:00:00Z);`joinSourceCode`='recruitment'(seed dict 项);`privacyConsentSigned`=true(报名即授权);紧急联系人 Json → `EmergencyContact` 行(contactName/relationCode/phonePrimary + priority=序;relationCode 原样 best-effort);**promote 同事务清空 application 敏感字段 + 置 `sensitivePurgedAt`**(PII 已搬 member,blob 归 member;留存 SOP 不再触 promoted 行) | E-R2 迁移;沿 phase-1 留存精神 |
| E-R2-8 | `recruitment_applications` +`promotedMemberId String?`(**不建外键**,沿 `reviewedByUserId`/`SmsSettings.updatedBy` 范式,保 phase-1 D-R-1「报名行无 Member FK」字面)+ `evaluatedByUserId String?` + `evaluatedAt DateTime?` + `evaluationNote String?`(综合评定记账) | E-R2 schema |
| E-R2-9 | 端点 +4 admin:`PATCH .../applications/:id/thresholds`(标门槛,幂等)/ `POST .../applications/:id/evaluate`(综合评定 = 单一人工闸,pending_evaluation 通过→publicity / 不通过→rejected;verified approved=false→rejected timeout)/ `GET .../cycles/:id/publicity-list`(姓名+拟发编号,拼音序,零敏感)/ `POST .../cycles/:id/promote`(一键发号);publicity-list **复用 `recruitment-application.read.record`**;**公开侧零新端点、零新 throttler** | E-R2 端点;评定/淘汰统一 evaluate 闸求精简 |
| E-R2-10 | BizCode `28041` `RECRUITMENT_APPLICATION_WRONG_STATE`(409)/ `28042` `RECRUITMENT_APPLICATION_NOT_PROMOTABLE`(409,全集校验失败,extra 列坏行)/ `28043` `RECRUITMENT_MEMBER_NO_EXHAUSTED`(409,当年 999 耗尽);亲核 28xxx 现仅 28001-28003/28010/28011/28030/28031/28040,28041+ 空闲 | E-R2 BizCode;续号 |
| E-R2-11 | 权限码 +3 全绑 biz-admin(136→139,biz-admin 47→50):`recruitment-application.mark.threshold` / `recruitment-application.evaluate.assessment` / `recruitment-application.promote.member`;publicity-list 复用 read.record(不另加码) | 镜像 phase-1 E-R-19 全绑 biz-admin + 读复用 |
| E-R2-12 | 审计:DB union +3(48→51):`recruitment-application.mark-threshold`(标门槛,who/what)/ `recruitment-application.evaluate`(评定/淘汰,fromStatus+approved+eliminationStage)/ `recruitment-application.promote`(逐报名一条,memberNo+memberId+tempNo);actor = 操作 admin;openid/手机/身份证一律掩码 | 沿 phase-1 E-R-20 掩码范式 |
| E-R2-13 | `member_profiles.email` 放宽 `String` → `String?`(M-1):**唯一触碰既有共享模型的列**;迁移安全(存量行有值);**admin member-profile create/update DTO 仍 `@IsEmail` 业务必填**(仅 promote 路径写 null);profile 响应 DTO `email` 变 `string | null`(OpenAPI snapshot widening;既有断言针对有 email 存量成员不受影响) | M-1 |
| E-R2-14 | 模块结构:扩 `recruitment/` 第 26 模块(不新建模块);recruitment 模块 import `Members? / UsersModule?` —— **不 import 既有 service**(避免环 + 行为耦合),promote 内**直接 `prisma.$transaction` 建 User+Member+profile+contacts**(镜像各 create 的纯写法,不复用其 service 的 RBAC/audit 装配);hashPassword 复用方式 = 抽 `bcryptjs` 直用 或 注入轻量 helper(T3 定,不 import UsersService) | 防环 + 零行为漂移;§5 |
| E-R2-15 | seed:+3 权限码(全绑 biz-admin)+ `join_source` 字典补 `recruitment` 项(若缺);计数同步 `seed-biz-admin.e2e-spec.ts` +3 / `biz-admin.fixture.ts` +3;RBAC_MAP 136→139 随 PR true-up | 守护脚本口径 |

---

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ T1:`recruitment_applications` +5 列 / `recruitment_cycles` +1 列 / `member_profiles` +1 列 + `email` 改可空;**无新表 / 无新 enum / 无 Member-application FK**(promotedMemberId 不建外键) |
| 是否新增 migration | ✅ T1 一个(**第 20 个**;命名 `2026MMDDHHMMSS_add_recruitment_phase2`);**纯加列 + 一处 NOT NULL→NULL 放宽,无破坏性,无历史数据回填** |
| 是否修改 `prisma/seed.ts` | ✅ T1:+3 权限码(全绑 biz-admin)+ `join_source` 补 `recruitment` 项;既有码/绑定/角色零变化 |
| 是否影响现有数据 | ❌(全部加列;`member_profiles.email` 放宽不动存量值);promote 是**新建**(members/users/profiles/contacts 新增行,不改既有成员) |
| 是否不可逆 | ❌ 全可逆(drop 加列 / email 收紧需先补值,但 v1 不收紧);statusCode/eliminationStage 为 String 值不涉 enum 不可逆 |
| 是否影响 OpenAPI / contract snapshot | ✅ +4 admin 端点(仅新增,零删改,零 L3);member-profile 响应 DTO `email` widening 为 nullable(snapshot 更新) |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 权限码 136→139;AuditLogEvent union 48→51;**JwtPayload / auth / Guard 链 / AppIdentityResolver 零碰**;promote 建 User 走纯 prisma 写,不经 login/注册路径 |
| 是否需要新增 BizCode | ✅ 28041-28043(3 码);baseline §1.1 `280xx` 行已含「招新已实装」,**号位扩充无须新段**(同段续号) |
| 是否需要新增 env / docker-smoke | ❌ 无新 env;docker-smoke +full-ICU 锚行(`Intl` pinyin 自检,防 base image 退化;DoD 显式项) |
| 是否触碰 api-surface-policy 红区 | ❌(全落既有 `admin/v1`;open/v1 已 phase-1 首用,本期不新增公开端点) |
| 是否需要用户拍板 | ✅ goal 已立项 + 授权;§0.5 四项 2026-06-19 元核验全冻结(按推荐) |
| **两层身份铁律** | ✅ promote 建的是**无部门、无级别**志愿者(无 `member_departments` 行、`gradeCode`=null);e2e 显式断言 |

---

## 3. 五张清单

### 3.1 schema(T1;以下增量 = 本稿冻结)

```prisma
// recruitment_cycles 增量(1 列):
//   memberNoSeq Int @default(0)  // 永久编号当年流水原子计数器(批量 promote +N;E-R2-6)

// recruitment_applications 增量(5 列):
//   thresholdMarks    Json?      // 门槛标记 { patrol1:{at,by}, patrol2, training, redCross, bsafe }(M-3 / E-R2-2)
//   promotedMemberId  String?    // 报名→Member 链(不建外键,沿 reviewedByUserId;E-R2-8)
//   evaluatedByUserId String?    // 综合评定操作人(不建外键)
//   evaluatedAt       DateTime?
//   evaluationNote    String?    // 综合评定备注(D-R2-3)

// member_profiles 增量(1 列 + 1 放宽):
//   idCardImageKey String?       // 证件照裸 key(wrinkle①;promote 从 application 搬入;E-R2-3)
//   email          String?       // 放宽 String→String?(M-1;报名链路不采集;admin DTO 仍业务必填)
```

> 不新增 model、不新增 enum;partial unique 沿 phase-1 两条不变;新 statusCode / eliminationStage / threshold code 全为 service 层 String 常量。

### 3.2 端点清单(T2 标门槛/评定/公示名单 3 + T3 发号 1;全落 `admin/v1`)

| # | T | Method Path | 鉴权后缀 | 说明 |
|---|---|---|---|---|
| 1 | T2 | `PATCH admin/v1/recruitment/applications/:id/thresholds` | `[rbac: recruitment-application.mark.threshold]` | 标/清单个门槛(幂等);仅 verified/pending_evaluation 态(他态 28041);末次完成自动推进 pending_evaluation |
| 2 | T2 | `POST admin/v1/recruitment/applications/:id/evaluate` | `[rbac: recruitment-application.evaluate.assessment]` | 综合评定(单一人工闸):pending_evaluation 通过→publicity / 不通过→rejected(evaluation);verified approved=false→rejected(threshold-timeout);他态/verified approved=true → 28041 |
| 3 | T2 | `GET admin/v1/recruitment/cycles/:id/publicity-list` | `[rbac: recruitment-application.read.record]` | 公示名单:姓名 + 拟发编号(拼音序,**零敏感**);计算式预览(拟发号 = 同一确定性排序 + 当前 memberNoSeq) |
| 4 | T3 | `POST admin/v1/recruitment/cycles/:id/promote` | `[rbac: recruitment-application.promote.member]` | 一键发号:对全部 publicity 报名按拼音序批量发 {YY}{NNN} + 建 User+Member+profile+contacts(单事务;空集 200 零发;不可发 → 28042;999 → 28043) |

Tag:`Admin - Recruitment Applications`(端点 1/2)/ `Admin - Recruitment Cycles`(端点 3/4)。contract `EXPECTED_ROUTES` 196 → **200**(逐 PR 显式登记,仅新增)。

### 3.3 BizCode(28xxx 续号;亲核现仅 8 码,28041+ 空闲)

| code | 常量 | http | 落点 |
|---|---|---|---|
| 28041 | `RECRUITMENT_APPLICATION_WRONG_STATE` | 409 | 标门槛/评定/发号目标态不符(状态机闸) |
| 28042 | `RECRUITMENT_APPLICATION_NOT_PROMOTABLE` | 409 | promote 全集校验失败(缺必填/缺 openid/openid 已绑/外籍缺派生字段;extra 列坏行) |
| 28043 | `RECRUITMENT_MEMBER_NO_EXHAUSTED` | 409 | 当年流水撞 999 上限(M-4;不扩位) |

**不开**:门槛未齐综合评定 → 由「仅 pending_evaluation 可 evaluate(蕴含门槛全完成)」机制保证,落 28041 不另开码;空 publicity 集 promote = 200 零发(非错);权限拒绝走通用 30100/40300。

### 3.4 权限码(+3;全绑 biz-admin)

| code | module / action / resourceType | 绑定 | 用途 |
|---|---|---|---|
| `recruitment-application.mark.threshold` | recruitment-application / mark / threshold | biz-admin ✅ | 端点 1 |
| `recruitment-application.evaluate.assessment` | recruitment-application / evaluate / assessment | biz-admin ✅ | 端点 2 |
| `recruitment-application.promote.member` | recruitment-application / promote / member | biz-admin ✅ | 端点 4 |

权限码全集 136→**139**;biz-admin 47→**50**(+3);ops-admin / member 零变化;publicity-list(端点 3)复用 `recruitment-application.read.record`。

### 3.5 audit 事件

**DB `AuditLogEvent` union +3(48→51)**:

| 事件 | 触发 | actor | resourceType / resourceId | extra(掩码) |
|---|---|---|---|---|
| `recruitment-application.mark-threshold` | admin 标/清门槛 | 操作人 | recruitment-application / 申请 id | `{thresholdCode, completed, allComplete}` |
| `recruitment-application.evaluate` | admin 综合评定/淘汰 | 操作人 | 同上 | before/after status;`{approved, eliminationStage?}` |
| `recruitment-application.promote` | 一键发号(逐报名一条) | 操作人 | 同上 | `{memberNo, memberId, tempNo, openid:掩码}` |

**不写**:公示名单读(配置台账类,沿 contribution-rules / phase-1 列表读)；任何明文凭据/身份证号/证件照 URL(L3)。

---

## 4. 后段流程冻结(实施不得调换)

**门槛标记 `PATCH .../:id/thresholds`(E-R2-2)**:
1. 校验目标态 ∈ {`verified`, `pending_evaluation`}(否则 28041)。
2. 校验 thresholdCode ∈ 5 固定 code(否则通用 422)。
3. 标记:`thresholdMarks[code] = {at: now, by: userId}`;清:删该 key(幂等)。
4. 重算「5 项是否全完成」:全完成且当前 `verified` → `pending_evaluation`;未全完成且当前 `pending_evaluation` → 回退 `verified`。
5. audit `mark-threshold`。

**综合评定 / 淘汰 `POST .../:id/evaluate`(D-R2-3)**:
- 当前 `pending_evaluation`:`approved=true` → `publicity`;`approved=false` → `rejected`(eliminationStage='evaluation')。
- 当前 `verified`:`approved=false` → `rejected`(eliminationStage='threshold-timeout',门槛超期/退出);`approved=true` → 28041(门槛未齐不可直接过评定)。
- 其余态 → 28041。
- 记 `evaluatedByUserId` / `evaluatedAt` / `evaluationNote`;audit `evaluate`。

**公示名单 `GET .../cycles/:id/publicity-list`(D-R2-4)**:取 cycle 内 `publicity` 报名 → 拼音排序(`Intl.Collator('zh-u-co-pinyin')` by realName + createdAt + id)→ 返 `[{realName, proposedMemberNo}]`(proposedMemberNo = `{YY}{memberNoSeq+i}`,i=1..N;**零敏感字段**)。预览随 publicity 集 / memberNoSeq 变化,最终以发号为准。

**一键发号 `POST .../cycles/:id/promote`(D-R2-5;最重一刀;E-R2-6/7)**:
1. 取 cycle 内 `publicity` 报名集(空 → 200 零发)。
2. **全集校验**(事务前):每条须 openid 非空 + openid 未被既有 User 占用(含软删)+ birthDate + genderCode 非空(大陆派生)+ 必填齐;任一不满足 → 28042(extra 列坏行 id),零发号。
3. 拼音排序(确定性 + 稳定次级键)。
4. **单一事务**:
   - 锁 cycle 行(`update memberNoSeq`),读基值 seq0;
   - 逐报名(i=1..N):memberNo=`{YY}{seq0+i}`;`seq0+i > 999` → 抛 28043(整事务回滚);
   - 建 `Member`(memberNo / displayName=realName / status=ACTIVE / gradeCode=null);
   - 建 `User`(openid / passwordHash=bcrypt(随机) / username=memberNo / memberId);
   - 建 `MemberProfile`(§6 映射;email=null;idCardImageKey 从 application 搬);
   - 建 `EmergencyContact[]`(from emergencyContacts Json);
   - 标 application:`promoted` + `promotedMemberId` + 清空敏感字段 + `sensitivePurgedAt`=now + `idCardImageKey`=null(blob 归 member);
   - audit `promote`(逐报名);
   - `memberNoSeq = seq0 + N`;
   - 提交(全或无)。
5. 幂等:重跑找 0 条 `publicity`(已 `promoted`)→ no-op;`promotedMemberId` 置则跳;`memberNo`/`openid`/`username` @unique 兜底。

> **两层身份铁律**:promote 建的 Member **无 member_departments 行、gradeCode=null**(无部门、无级别);phase 3 入队才赋。

---

## 5. 模块结构(扩 recruitment 第 26 模块,不新建)

```
src/modules/recruitment/
├── recruitment.module.ts                          # 既有 import 不变;promote 用纯 prisma 写,不 import MembersService/UsersService(防环 + 零行为漂移,E-R2-14)
├── recruitment-applications.admin.controller.ts   # +端点 1/2(thresholds / evaluate)
├── recruitment-cycles.controller.ts               # +端点 3/4(publicity-list / promote)
├── recruitment-applications.service.ts            # +标门槛 / 评定 / 全集校验(promote 编排)
├── recruitment-promotion.service.ts               # ★新:promote 单事务(发号 + 建 User+Member+profile+contacts + 迁移 + 清敏感)+ 拼音排序
├── recruitment.constants.ts                       # +新 statusCode / eliminationStage / threshold code / formatMemberNo / pinyinComparator
├── recruitment.dto.ts                             # +ThresholdMarkDto / EvaluateDto / PublicityListItemDto / PromoteResultDto
└── recruitment.types.ts                           # +threshold marks 类型
```

跨模块:promote 写 User/Member/profile/contacts = **直连 prisma**(不复用既有 service,避免引入其 RBAC/audit 装配与潜在环);`bcryptjs` 直用或注入轻量 hash helper(T3 定)。recruitment 仍是叶子模块(不被既有模块 import)。

---

## 6. promote 数据迁移逐字段映射(E-R2-7)

| 目标 | 来源 / 规则 |
|---|---|
| `Member.memberNo` | 新发 `{YY}{NNN}` |
| `Member.displayName` | application.realName |
| `Member.status` / `gradeCode` | ACTIVE / **null(无级别)** |
| `User.openid` / `username` / `passwordHash` | application.openid / memberNo / bcrypt(高熵随机) |
| `User.email` / `phone` / `role` / `memberId` | null / null / USER / 新 member.id |
| `MemberProfile.realName / documentTypeCode / documentNumber / mobile` | application.realName / documentTypeCode / idCardNumber / phone |
| `MemberProfile.birthDate / genderCode` | application.birthDate / genderCode(**大陆派生;外籍不进 v1 发号,M-1**) |
| `MemberProfile.email` | **null(M-1 放宽列)** |
| `MemberProfile.joinedDate / joinSourceCode / privacyConsentSigned` | 发号日(归一)/ `'recruitment'`(seed dict)/ `true`(报名即授权) |
| `MemberProfile.idCardImageKey` | application.idCardImageKey(**搬运;application 侧清空**,wrinkle①) |
| 其余 MemberProfile 可空字段 | application.profileExtra Json 有则填,无则 null |
| `EmergencyContact[]` | application.emergencyContacts Json `[{name,relation,phone}]` → 逐行(contactName/relationCode/phonePrimary + priority=序;relationCode 原样 best-effort) |
| application 善后 | statusCode=`promoted` + promotedMemberId + **清空全部敏感字段(realName/idCardNumber/birthDate/phone/detailedAddress/emergencyContacts/profileExtra/idCardImageKey)** + sensitivePurgedAt=now;脱敏统计字段(cycleId/genderCode/ageGroup/cityDistrict/sourceChannel)永久留存 |

**敏感字段三问(沿 phase-1 §6)**:promote 后 PII 已搬入 member_profiles/emergency_contacts(成员档案合法承载),application 即时脱敏(数据最小化,不双存);证件照 blob 单一属主 = member,phase-1 留存 SOP 仅清 `rejected`/未发号 closed 行,**不触 `promoted` 行**(已 sensitivePurgedAt + 无 idCardImageKey)。

---

## 7. 既有行为锁(实施期间任何一条破坏 = 停下报告)

1. auth(密码/OTP/微信/refresh/logout)+ `JwtPayload` zero drift + 既有 e2e 断言**零修改**全绿;promote 建 User 走纯 prisma 写,**不经 login/注册/createSession**。
2. **wechat / sms / 活动 / 考勤 / 证书 / attachments 模块零 diff**;**members / users / member-profiles / emergency-contacts 既有 service 零碰**(promote 直连 prisma,不复用其方法)。
3. `member_profiles.email` 放宽为 widening(可空):**存量有值成员的既有断言不受影响**;admin member-profile create/update DTO 仍 `@IsEmail` 业务必填;仅 promote 路径写 null。
4. phase-1 报名链路(提交/核验/发临时编号/查询/人工 resolve/FM-A 收紧)**零回归**;既有 phase-1 状态机 4 态语义不变(新增 3 态为扩展)。
5. contract snapshot **仅新增**(+4 admin 端点)+ member-profile email widening;零删改、零 L3。
6. seed 既有码/绑定零变化;biz-admin 仅 +3;`docs:rbacmap:check` / `docs:codemap:check` 各阶段 0 FAIL。
7. **两层身份**:promote 出的 Member **无部门、无级别**;e2e 显式断言(无 member_departments 行 / gradeCode=null)。
8. **临时编号 tempNo 与永久编号 memberNo 不混**:tempNo 留在 application(promote 后 application 仍持脱敏统计,tempNo 可留作链路追溯);memberNo 在新 Member;两者格式不同(`T...` vs `{YY}{NNN}`)。

---

## 8. 测试计划(DoD 展开)

- **T1**:`seed-biz-admin.e2e-spec.ts` 期望 +3 断言绿;干净库 `prisma migrate deploy` 重放 20/20;seed 幂等二跑;`member_profiles.email` 放宽不破既有 member-profile e2e。
- **T2 e2e**(`recruitment-application.e2e-spec.ts` 扩):门槛标记全链(逐项标 → 末次自动 pending_evaluation / 清一项回退 verified / 非法态 28041 / 幂等)/ 综合评定两路(pending_evaluation 通过→publicity、不通过→rejected evaluation;verified approved=false→rejected timeout;verified approved=true→28041)/ 公示名单(拼音序断言 + **零敏感字段**断言 + 拟发号预览)。
- **T3 e2e**(DoD 逐条):一键发号全链(publicity 集 → 拼音序分配 {YY}{NNN} → 建 User+Member+profile+紧急联系人迁移)/ **编号 {YY}{NNN} 拼音序唯一 + 连续无空洞** / **批量原子**(中途坏数据 → 整批回滚零发号 28042)/ **失败恢复 + 幂等重跑**(同一报名不重复建 Member;重跑 no-op)/ **两层身份**(promote 出 Member 无 member_departments / gradeCode=null)/ **wrinkle① 证件照搬运**(member_profiles.idCardImageKey 落、application.idCardImageKey 清)/ **wrinkle③ User**(openid 绑定、passwordHash 非空且密码登录不可、username=memberNo)/ 999 溢出 28043 / 空集零发 / member_profiles.email=null 落库。
- **拼音排序单测**:`recruitment.constants.spec`(pinyinComparator 对混合中英文名确定性排序 + 稳定次级键)。
- **横切回归**:auth-* / wechat / sms / app-me / insurance / members / member-profiles 全组零修改全绿;contract 仅新增 + email widening;docker-smoke 含 full-ICU 锚行。
- 全程 `agent:check:full`(本地无 Docker → quick + 显式声明留 CI,不谎报)。

---

## 9. 任务队列与探针(顺序硬约束;goal 原文固化)

| 阶段 | 档 | 内容 | 探针(未满足才做) |
|---|---|---|---|
| **T0** | A | 本稿(§0.5 四项 2026-06-19 元核验冻结)+ memory 登记 | 本稿不存在 |
| T1 | D | §3.1 schema + 第 20 migration + §3.4 前 +3 码 seed + join_source dict + 计数同步(E-R2-15) | schema 无 `thresholdMarks` |
| T2 | C/D | 端点 1/2/3(标门槛 + 综合评定 + 公示名单)+ 状态机推进 + 拼音排序 + audit +3 + BizCode 28041/28042 + e2e | `thresholds` 路由不存在 |
| T3 | D | 端点 4(promote 单事务)+ `recruitment-promotion.service` + 发号原子性 + 迁移 + 清敏感 + 28043 + 两层身份 e2e | `promote` 路由不存在 |
| T4 | A | CHANGELOG / current-state §2(招新行扩后段)/ §3(phase-2 转归档、phase-3 挂项)/ RBAC_MAP 139 / CODEMAP / NEXT_TASKS(phase-2 归档 + phase-3 挂项)+ 评审稿冻结 + 必要时 promote 后敏感数据去向 ops/合规 SOP | current-state §2 无招新后段行 |

LOOP 纪律沿 process §7.1:同失败修复 ≤2 轮;连续 2 轮零推进熔断;每 PR 合并沿 §5.4 八条。

---

## 10. 本期不做(终版报告必列)

- **phase 3**:入队 10 项 / 部门 / 级别 1-7 APD 调级。
- 打通现有活动/考勤/证书模块给报名者(approach A 已定:门槛只判完成与否,不算工时/贡献值)。
- 外籍 verified 报名一键发号(M-1:v1 仅大陆可派生 birthDate+gender 报名;外籍走既有 admin 建档手填)。
- 成员证件照查看端点(wrinkle① 留存备查,要查另立项);证件照转正式 Attachment(E-20 式单独立项)。
- 新 cron / 自动留存清理(沿 phase-1 手动 SQL+blob SOP);接真实腾讯云实名核验通道(运维接力,DevStub 全验)。
- 改既有 login/wechat/sms/活动/考勤/证书 行为;复用 members/users service 方法(promote 直连 prisma)。
- `member_profiles.email` 由可空再收紧(v1 放宽即终态;收紧需历史回填,另议)。

---

## 11. 红区改动计划

- **`docs/srvf-foundation-baseline.md` §1.1**:`280xx` 行已含「招新一期已实装」,本期仅**段内续号**(28041-28043),措辞更新「招新一期 + 二期(后段)已实装」即可,**不新增段位行**(T3 PR,逐行可解释)。
- **`AGENTS.md`**:无本体规则改动(无新 surface / 无新 enum / 无新依赖);`member_profiles.email` 放宽属 goal 授权 schema 范围内,不触 §0 受保护文档规则之外的红线。
- **`prisma/schema.prisma`**:goal 授权 D 档,解除 A-3/A-4;改动逐列可解释(§3.1)。

`AGENTS.md` 本体 / V2 红线 / api-surface-policy **零碰**。

---

> 实施(T1-T4)以本稿为准;与 goal 原文冲突时 goal 优先;§0.5 四项以 2026-06-19 维护者元核验冻结结论为准;新发现问题按 process §4.1 人话简报上报,不顺手修。
