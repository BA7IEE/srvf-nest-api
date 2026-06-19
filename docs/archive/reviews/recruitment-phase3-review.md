# SRVF 招新三期(入队:志愿者 → 队员)评审稿(Recruitment Phase-3 Enlistment Review)

> **状态:冻结**(2026-06-19;goal「招新 phase 3(入队)— 志愿者 → 队员:10 项考核 + 综合评估 → 部门 + 级别1」拍板,goal 文本即立项 + 评审授权;**§0.5 元核验已于 2026-06-19 经维护者全部确认**:工程决策 E-J-1~8 + wrinkle W①②③ + Q4/Q5 全「按推荐」,Q1 门槛清单经维护者会议纪要纠正、Q2/Q3 + 延长期口径确认;本稿按 [`process.md §4`](../../process.md) D 档降速产出,冻结后不回改)。
> **业务依据**:goal 原文(自含,维护者已拍板事实)+ 招新入队需求会会议纪要(10 项考核 / 综合评估 / 一键入队四节点)。需求文档不入仓,引用以 goal 原文 + §0.5 元核验为准。
> **范式母本**:① 入队轮 + 申请状态机 + partial unique 沿 `recruitment_cycles`/`recruitment_applications`(phase-1/2)既成;② 一键入队事务原子性逐层镜像 phase-2 `RecruitmentPromotionService`(**单事务直连 prisma、不复用 service、防环**);③ 设部门镜像 `MemberDepartmentsService.set` 幂等语义(软删旧 + 建新);④ 设级别镜像 `MembersService.assertGradeCodeValid` + `gradeCode` 写入;⑤ 贡献值汇总镜像 `AttendancesService.listMyRecords` 的 approved-only 过滤。
> **冲突优先级**:本稿让步给 `AGENTS.md` / `ARCHITECTURE.md` / baseline / V2 红线 / `api-surface-policy.md`(沿 process §6);但在「本期入队范围内的具体设计取舍」上,本稿即冻结决议。
> **承接**:phase-1 [`recruitment-phase1-review.md`](recruitment-phase1-review.md)(D-R / E-R)+ phase-2 [`recruitment-phase2-review.md`](recruitment-phase2-review.md)(D-R2 / E-R2 / M-);本稿新决议用 **D-J / E-J / W-J** 前缀,元核验项用 **Q-** 前缀。

---

## 0. TL;DR

1. **新建第 27 模块 `team-join/`(不挤进 recruitment)**:actor = phase-2 promote 出的已转正志愿者(member,有 User 可登录小程序、但**无部门、无级别**);surface = `app/v1` 鉴权自助面(志愿者本人)+ `admin/v1` 后台面。与招新 `open/v1` 公开报名面边界不同 → 独立模块,沿模块边界铁律(E-J-1)。
2. **两张新表(E-J-2)**:`team_join_cycles`(入队轮:annual 批次,admin 开/关,**至多一个 open**;无发号 seq、无 capacity、无通知配置)+ `team_join_applications`(入队申请:**有真实 `memberId` FK** —— 与招新表「无 Member FK」相反,因申请人此刻已是 member)。第 21 migration,纯建表无破坏。
3. **状态机(E-J-3;纯 String 无 enum)**:`joining`(考核中,初态)→ `pending_evaluation`(通用门槛全过自动推进)→ `approved`(综合评估通过、待入队)→ `joined`(已入队,终态)/ `rejected`(已拒,终态);`eliminationStage` = `evaluation`(综合评估不通过)/ `gate-timeout`(门槛超期/人工淘汰)。沿 phase-2 statusCode String 范式。
4. **10 项考核精确拆解(Q1 维护者会议纪要纠正 + Q2 确认)**:
   - **通用门槛 = 8 admin 标 gate(落 `gateMarks` JSON,各带完成日 → 有效期)+ 1 系统自动 contribution(实时算、不落库)= 9 必过项**;**第 10「项」= 综合评估**(人工闸,evaluate transition,非 gateMark)。9 必过项全满足 → 自动推进 `joining`→`pending_evaluation`。
   - 8 admin gate:`fitness` 基础体能(参加即可,**本轮**)/ `first-aid-training` 初级救援培训(**3年**)/ `military` 军训2天2夜(**2年**)/ `psych` 心理测试(**本轮**)/ `interview` 部门面试+附件4(**本轮**)/ `dept-assessment` 部门考核(**本轮·★可延长期**)/ `entry-exam` 入队普考医疗·信息·通讯(**本轮**)/ `intermediate-outdoor` 中级户外资质人工审核(**长期**)。
   - **4 条件性专业队 gate**(`team-water` 水队 / `team-urban` 城搜 / `team-mountain` 山地 / `team-high` 高空):同落 `gateMarks` JSON、各 **本轮**、**不计入「9 必过项自动推进」**;仅选对应专业队时才要求。
5. **wrinkle① 专业队识别(W-J-1;node_type code 约定,最省)**:模块常量 `专业队 node_type code → 该队 gate code` 映射 + seed 4 队 placeholder code;选目标部门时查 `org.nodeTypeCode`——**非专业队 = `fitness` 过即可**(基础体能参加即可申);**4 专业队 = 各自 `team-*` gate 过才可选该队**(否则只能入非专业队)。**不给 `Organization` 加字段、不改 schema**。
6. **wrinkle② 证书类 gate(W-J-2;v1 admin 标记)**:`first-aid-training` / `intermediate-outdoor` 等证书/资质类一律走 **admin 标记**(沿招新红十字/BSAFE 范式),**不**接 `CertificatesService.isQualified`、**不**建 cert_type seed/桥(避免过度工程);`isQualified` 已存在,留作未来选项(§10)。
7. **wrinkle③ 贡献值汇总(W-J-3 + Q4)**:`attendanceRecord.aggregate({_sum:{contributionPoints}})`,过滤 `{ memberId, sheet:{ statusCode:'approved', deletedAt:null }, deletedAt:null }`(字面镜像 `listMyRecords` approved-only);**date-anchor = `checkInAt`**(在记录上、免连表)/ **历史累计**(无下界)/ **cutoff = 入队轮年份 3-31 北京日界**(`checkInAt < April-1 00:00 +08:00`);Decimal(5,2) 精度;阈值 **≥5**;**实时算,不落 `gateMarks`**。
8. **级别 seed(E-J-6;守 R13 红线)**:`member_grade` 字典 demo 占位替换为 **`level-1`…`level-7`**(code 稳定 = 长期契约;**label 仅占位「级别 N(待运营命名)」,真实级别名永不进 git**,沿 v2-data-model §0.2 / research R13);入队设 `gradeCode='level-1'`(Q5);调级走现有 `PATCH admin/v1/members/:id`(biz-admin),**不单独建 APD 角色**。
9. **一键入队 = 最重一刀(E-J-4)**:综合评估 `approved` → admin 从「面试通过的候选部门」选定**单一**目标部门(Q3)→ 自建 `$transaction` **直连 prisma**(不调 `MemberDepartmentsService.set`/`MembersService.update`——Prisma 不支持嵌套交互事务 + 防环零漂移,沿 phase-2 promote 铁律):`assertGradeCodeValid('level-1', tx)` → `tx.member.update{gradeCode:'level-1'}` + `tx.memberDepartment`(软删旧 active + 建新,镜像 set 幂等语义)→ 状态 `joined` + `selectedOrganizationId` + `joinedAt`。**单事务原子 + 幂等**(已 joined 重跑命中 0 / wrong-state 报错)+ **两层身份转换**(此刻才赋部门 + 级别)。
10. **自助面 self-scope(E-J-5)**:`app/v1/me/team-join/*` 发起申请 + 选多候选部门 + 查进度,全锁 `currentUser.memberId`、不接 path param、不挂 RBAC(镜像 insurances `me/insurances` 防 IDOR);admin 面标考核 + 综合评估 + 一键入队。
11. **延长期(Q 确认)**:`dept-assessment` gate + `综合评估` 支持 admin 延长期(超「本轮」仍认):gateMark 带可选 `extendedUntil`、application 带 `evaluationExtendedUntil`;**仅此二者**可延,其余 gate 按固定有效期(过期失效需重做)。
12. **增量小结**:schema 第 21 migration(2 新表 + 1 partial unique + 索引);seed(grade 1-7 替换 demo + node_type 4 专业队 code);权限码 +7 全绑 biz-admin(139→**146**);BizCode 新开 **282xx 子段**(招新域预留内,与 phase-1/2 的 280xx 物理分组);audit union +6(51→**57**);端点 +12(admin 9 + app 自助 3,均 `app/v1` 与 `admin/v1`,**零公开 `open/v1` 端点、零新 throttler**)。
13. **零行为漂移**:members / member-departments / certificates / 活动 / 考勤 / auth / wechat / sms / recruitment(phase-1/2)一律零 diff、既有断言零修改;两层身份铁律全程守住(入队前无部门无级别、入队后才赋)。

---

## 0.5 元核验结论(2026-06-19 冻结)

> **元核验结论(2026-06-19,维护者)**:工程决策 E-J-1~8 + wrinkle W①②③ + Q4/Q5 全部「按推荐」;Q1 门槛清单经维护者会议纪要**纠正**(我 T0 简报的猜测有误);Q2 专业队语义、Q3 多部门模型、延长期口径确认。本节存档拍板。

**Q1 · 10 项考核确切清单 — ✅ 以会议纪要为准(纠正 T0 简报猜测)**
T0 简报误把「红十字 / BSAFE」当入队考核(实为**招新**门槛)、且漏列军训/心理/部门考核/入队普考。维护者纠正后冻结为:8 admin gate(`fitness` 本轮 / `first-aid-training` 3年 / `military` 2年 / `psych` 本轮 / `interview` 本轮 / `dept-assessment` 本轮★ / `entry-exam` 本轮 / `intermediate-outdoor` 长期)+ 1 自动 `contribution`(≥5,截至入队年 3-31)+ 综合评估人工闸(★)。详 §4.1。

**Q2 · 专业队与「10 项」的关系 — ✅ 10 通用必过 + 4 专业队条件性**
通用 9 必过项(8 admin + contribution)对所有人一致、全过才进综合评估;4 专业队 gate(`team-water`/`team-urban`/`team-mountain`/`team-high`)**条件性** —— `fitness` 参加即可申**非专业队**;**4 专业队需对应考核过才可选该队**、否则只能入非专业队。专业队 gate 同落 `gateMarks` 但**不计入**「9 必过项自动推进」。详 §4.4。

**Q3 · 多部门申请模型 — ✅ 一行/(member×入队轮) + 候选数组 + admin 选定**
志愿者自助可申请**多个**候选部门(`targetOrganizationIds` JSON 数组,`joining` 态可改);**最终单部门 = admin 在一键入队时从「面试通过的候选」里选定**(写 `selectedOrganizationId`)。一申请一行(per member × cycle),gateMarks 挂此行。详 §3.1 / §4.5。

**Q4 · 贡献值 date-anchor + 窗口 — ✅ checkInAt / 历史累计 / cutoff 入队年 3-31**
anchor = `attendance_records.checkInAt`(在记录上、免 record→sheet→activity 连表;= 实际参与时刻);窗口 = **历史累计**(无下界);cutoff = **入队轮 `year` 的 3-31 北京日界**(`checkInAt < ${year}-04-01 00:00:00 +08:00`);approved sheet only;阈值 ≥5。详 §4.3。

**Q5 · 级别命名 — ✅ level-1~7 占位 code,真实名归运营**
`member_grade` 字典 seed = `level-1`…`level-7`,label 占位「级别 N(待运营命名)」;真实级别名永不进 git(R13);入队设 `level-1`。详 §3.4 / E-J-6。

**延长期 · ✅ dept-assessment + 综合评估 可 admin 延长期**
此二者支持 admin 延长「本轮」有效期(超本轮仍认);其余 gate 按固定有效期,过期失效需重做。详 §4.2。

---

## 1. 决策汇总表

### 1.1 goal / 元核验已拍板项(D-J;冻结,不重开)

| # | 决策 |
|---|---|
| D-J-1 | **入口态 = phase-2 promote 出的志愿者**(`members` 行 status ACTIVE、`gradeCode=null`〔无级别〕、无 `member_departments`〔无部门〕、有 User 可登录小程序);入队链路:志愿者自助发起 → 10 项考核(admin/部门标 + 贡献值自动)→ 综合评估(人工)→ 一键入队 = 设部门 + 设级别 1。 |
| D-J-2 | **入口 = 志愿者自助申请**(小程序;复用 promote 时建的 User;走 `app/v1` 鉴权面,**不新开公开面**);admin/部门后台标考核 + 综合评估 + 一键入队。 |
| D-J-3 | **门槛跟踪 = 贡献值≥5 系统自动算**(读考勤工分汇总)+ **其余 8 项 admin/部门标记**(通过/未通过 + 完成日 → 算有效期);沿招新阶段标记范式;**不打通活动/考勤/证书模块**(只判完成与否,贡献值除外 = 只读汇总)。 |
| D-J-4 | **专业队 = 字典 code 约定标记 4 队**(水/城搜/山地/高空);基础体能参加即可申非专业队,4 专业队需各自考核过才可选该队。 |
| D-J-5 | **级别 = seed 真实 1-7 `member_grade` 字典项**(code 稳定、名称占位待运营);入队设 `gradeCode='level-1'`;调级 v1 走现有 member PATCH(biz-admin),**不单独建 APD 角色**。 |
| D-J-6 | **贡献值窗口 = 历史累计 ≥5、截至入队年 3-31**(Q4 确认 checkInAt / 历史累计 / 北京日界 cutoff)。 |
| D-J-7 | **不在范围**:phase 3 之后任何(退队 / 晋升体系扩展等);真实腾讯云通道;新 cron;单独建 APD 角色;改既有 login/wechat/sms/活动/考勤/certificates 行为。 |

### 1.2 工程细节代决项(本稿固化;实施不得再漂移)

| # | 代决 | 依据 |
|---|---|---|
| E-J-1 | **新建第 27 模块 `team-join/`**;不挤进 recruitment(actor/surface 边界不同) | 模块边界铁律;AGENTS §目录 |
| E-J-2 | **两张新表** `team_join_cycles` + `team_join_applications`;后者**有真实 `memberId` FK**(Restrict);第 21 migration 纯建表 | 镜像 recruitment_cycles/applications;两层身份已是 member |
| E-J-3 | **状态机 +5 String 态** `joining`/`pending_evaluation`/`approved`/`joined`/`rejected`;`eliminationStage` = `evaluation`/`gate-timeout`;无 enum、无单独 migration(纯 String 列) | 沿 phase-2 E-R2-1 statusCode String 范式 |
| E-J-4 | **一键入队 = 自建 `$transaction` 直连 prisma**(不复用 `MemberDepartmentsService.set` / `MembersService.update`,Prisma 嵌套交互事务不支持 + 防环);单事务原子 + 幂等 + 失败可恢复 | phase-2 `RecruitmentPromotionService`「直连 prisma 不复用 service」铁律 |
| E-J-5 | **自助面 self-scope**:`app/v1/me/team-join/*` 锁 `currentUser.memberId`、不接 path param、不挂 RBAC;**永不返回 L3**;准入要求 `memberId != null`(已转正) | 镜像 insurances `me/insurances` 防 IDOR + App surface 铁律 |
| E-J-6 | **级别 seed = `level-1`…`level-7`**(code 稳定 + label 占位,真实名不进 git);`assertGradeCodeValid('level-1')` 依赖其存在 + ACTIVE | R13 / v2-data-model §0.2;复用既有 grade 校验 |
| E-J-7 | **贡献值只读汇总**:`aggregate _sum contributionPoints`,approved-only + `checkInAt < cutoff`;Decimal 比较 ≥5;实时算不落库 | 镜像 `listMyRecords` 过滤;Decimal(5,2) |
| E-J-8 | **段位**:权限码 +7(team-join-cycle 3 + team-join-application 4)全绑 biz-admin,自助零码,139→**146**;BizCode 新开 **282xx**;audit +6,51→**57** | 镜像 phase-1 招新段位手法;biz-admin 边界 = 全量业务权限 |

### 1.3 wrinkle 三连

| # | wrinkle | 冻结决议 |
|---|---|---|
| W-J-1 | 专业队识别 | **node_type code 约定**:模块常量 `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE = { professional-water → team-water, professional-urban → team-urban, professional-mountain → team-mountain, professional-high → team-high }`;seed 4 node_type code(placeholder label);**不给 Organization 加字段**。选专业队 → 查 `org.nodeTypeCode` 命中映射 → 要求对应 gate 满足;否则按非专业队(仅 `fitness`)。 |
| W-J-2 | 证书类 gate | **v1 走 admin 标记**(沿红十字/BSAFE 范式),不接 `CertificatesService.isQualified`、不建 cert_type seed/桥;留作未来选项(§10)。 |
| W-J-3 | 贡献值汇总 | **approved-only + checkInAt date-anchor + 历史累计 + cutoff 入队年 3-31**(详 §4.3);实时算不落 `gateMarks`。 |

---

## 2. 风险表(D 档降速 ②)

| 风险 | 等级 | 缓解 |
|---|---|---|
| 一键入队半建态(设了部门没设级别 / 反之) | 高 | 单一 `$transaction` 全或无;失败整体回滚;吸取 phase-1/2 FM-A 教训;e2e 断言「入队后 member 同时有 dept + gradeCode,失败则两者皆无」 |
| 同一志愿者重复入队(双部门/双级别) | 高 | ① 申请创建时拒绝「已有 active member_department 或 非空 gradeCode」的 member(28210);② 一键入队幂等(`joined` 离开 `approved` + `selectedOrganizationId` 置则重跑命中 0);③ member_departments partial unique 兜底 | 
| 贡献值汇总误纳未终审 sheet / 误算 Decimal | 中 | 字面镜像 `listMyRecords` 的 `statusCode='approved'` 过滤;`aggregate _sum` 返 `Decimal \| null`,null 视作 0;`new Prisma.Decimal(5)` 比较,不转 number 防精度丢失 |
| 专业队资格绕过(无考核选专业队) | 中 | 一键入队时按 `selectedOrganizationId` 的 `nodeTypeCode` 强校验对应 gate;否则 28242;e2e 两路 |
| 嵌套事务 / 复用 service 引环 | 中 | E-J-4 直连 prisma;不 import members/member-departments service 进事务;codemap 依赖观察 |
| grade seed 漂移(demo 残留 / label 入 git) | 中 | seed 替换为 level-1~7 stable code;label 占位;clean-DB replay 只得 1-7;既有库 demo grade 为无引用孤项(无成员引用,无害) |
| 既有模块行为漂移 | 高 | 新模块隔离;members/member-departments 仅**读**校验 + 事务内**直写**(不调其 public 方法);零既有 spec 改动为 DoD 硬约束 |

---

## 3. 五张清单

### 3.1 schema(T1;以下增量 = 本稿冻结;第 21 migration)

**新表 `team_join_cycles`(入队轮):**

| 字段 | 类型 | 说明 |
|---|---|---|
| id / createdAt / updatedAt / deletedAt | 标准 | 软删 |
| year | Int | 入队年份(贡献值 cutoff = `{year}-03-31` 北京日界;级别/编号无关) |
| name | String | 轮次名(长度 DTO 约束) |
| statusCode | String | `open` / `closed`(后台开关;**至多一个 open**,service 守) |
| openedAt / closedAt | DateTime? | 开/关时刻 |

> **比 recruitment_cycles 更简**:无 `tempNoSeq`/`memberNoSeq`(不发号,member 已有 memberNo)、无 `capacity`、无 `meetingInfo`/`qqGroup`/`notifyTemplate`。
> `@@index([statusCode])` / `([year])` / `([deletedAt])` / `([createdAt])`;`@@map("team_join_cycles")`。

**新表 `team_join_applications`(入队申请):**

| 字段 | 类型 | 说明 |
|---|---|---|
| id / createdAt / updatedAt / deletedAt | 标准 | 软删 |
| cycleId | String | FK → `team_join_cycles.id`(Restrict) |
| **memberId** | String | **FK → `Member.id`(Restrict)** —— 申请人(已转正志愿者);**与招新表无 Member FK 相反** |
| statusCode | String | `joining`/`pending_evaluation`/`approved`/`joined`/`rejected` |
| targetOrganizationIds | Json | 候选目标部门 orgId 数组(志愿者自助选,可多;`joining` 态可改) |
| gateMarks | Json? | `{ [gateCode]: { at, by, passed, completionDate, extendedUntil? } }`;8 通用 admin gate + 0~4 专业队 gate;**contribution 不在此(实时算)** |
| selectedOrganizationId | String? | FK → `Organization.id`(Restrict);一键入队时 admin 定的最终单部门 |
| evaluatedByUserId | String? | 综合评估操作人(不建外键,沿 phase-2 `evaluatedByUserId`/SmsSettings.updatedBy) |
| evaluatedAt | DateTime? | 综合评估时刻 |
| evaluationNote | String? | 综合评估备注 |
| evaluationExtendedUntil | DateTime? | 综合评估延长期(admin 设;超本轮仍认) |
| eliminationStage | String? | `evaluation` / `gate-timeout`(rejected 时记) |
| joinedAt | DateTime? | 一键入队执行时刻 |

> **partial unique(migration.sql 末尾手写,Prisma DSL 不支持带 WHERE;沿 phase-1 E-R-9/10 范式)**:
> `team_join_applications_member_cycle_active_unique ON (memberId, cycleId) WHERE "deletedAt" IS NULL AND "statusCode" <> 'rejected'` —— 同轮同人至多一活跃申请,允许 rejected 后同轮重试;service P2002 兜底转 28203。
> `@@index([cycleId])` / `([memberId])` / `([statusCode])` / `([selectedOrganizationId])` / `([deletedAt])` / `([createdAt])`;`@@map("team_join_applications")`。

**贡献值复合索引(按需)**:`AttendanceRecord` 已有的索引覆盖 `memberId`?——T1 实测查询计划;若 `_sum` 走 `(memberId, deletedAt)` + sheet join 慢,补 `@@index([memberId, deletedAt])`(纯加索引,迁移安全)。**默认不预加,实测触发再补**(避免预先优化)。

### 3.2 端点清单(T2 admin + T3 app 自助;均落 `admin/v1` / `app/v1`,零 `open/v1`)

**admin(`admin/v1/team-join/`,9 端点;RBAC `rbac.can()`):**

| 方法 路径 | 权限码 |
|---|---|
| POST `/cycles` | `team-join-cycle.create.record` |
| GET `/cycles` | `team-join-cycle.read.record` |
| GET `/cycles/:id` | `team-join-cycle.read.record` |
| PATCH `/cycles/:id`(open/close) | `team-join-cycle.update.record` |
| GET `/applications`(列表,按 cycle/status 筛) | `team-join-application.read.record` |
| GET `/applications/:id`(详情 + gate 实况 + 实时贡献值) | `team-join-application.read.record` |
| PATCH `/applications/:id/gates`(标 gate,幂等) | `team-join-application.mark.gate` |
| POST `/applications/:id/evaluate`(综合评估通过/不通过) | `team-join-application.evaluate.assessment` |
| POST `/applications/:id/join`(一键入队,带 `organizationId`) | `team-join-application.join.member` |

**app 自助(`app/v1/me/team-join/`,3 端点;self-scope 锁 `currentUser.memberId`,零权限码):**

| 方法 路径 | 说明 |
|---|---|
| POST `/applications`(发起申请,选候选部门数组) | self;校验 member 未入队(28210)+ 有 open 轮(28230) |
| GET `/applications/current`(查本人当前轮进度:状态/各 gate/实时贡献值/候选部门) | self-scope |
| PATCH `/applications/:id/targets`(改候选部门) | self;仅 `joining` 态可改 |

> contract 200 → **~212**(仅新增;最终数 T2/T3 亲核)。**零新 throttler**(自助走鉴权面,沿既有 App throttle)。

### 3.3 BizCode(新开 282xx 子段;招新域 280xx-290xx 预留内,与 phase-1/2 的 280xx/281xx 物理分组)

| code | key | HTTP | 触发 |
|---|---|---|---|
| 28201 | TEAM_JOIN_CYCLE_NOT_FOUND | 404 | 入队轮不存在 |
| 28202 | TEAM_JOIN_APPLICATION_NOT_FOUND | 404 | 入队申请不存在 |
| 28203 | TEAM_JOIN_DUPLICATE_APPLICATION | 409 | 同轮同人已有活跃申请(partial unique P2002 兜底) |
| 28210 | TEAM_JOIN_MEMBER_ALREADY_ENROLLED | 409 | member 已有部门/级别(已入队,非新志愿者) |
| 28230 | TEAM_JOIN_CYCLE_NOT_OPEN | 409 | 无 open 入队轮 / 已关 |
| 28240 | TEAM_JOIN_APPLICATION_WRONG_STATE | 409 | 状态机闸(标 gate/评估/入队目标态不符) |
| 28241 | TEAM_JOIN_GATES_NOT_SATISFIED | 409 | 入队时通用门槛/贡献值未全满足(状态兜底防御) |
| 28242 | TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE | 409 | 选定部门不在候选 / 专业队对应 gate 未过 |

> 不开 281xx-FORBIDDEN_*(权限拒绝走通用 30100/40300,沿 phase-1 §3.3);grade-code-invalid 走既有 `MEMBER_GRADE_CODE_INVALID`(level-1 seed 缺失时,理论不发生)。最终码集 T2 亲核。

### 3.4 权限码(+7;全绑 biz-admin;139→146)

`team-join-cycle.read.record` / `.create.record` / `.update.record`(3)+ `team-join-application.read.record` / `.mark.gate` / `.evaluate.assessment` / `.join.member`(4)。全绑内置 `biz-admin`(ADMIN 边界 = 全量业务权限);**自助 `app/v1/me/team-join/*` 零权限码**(self-scope,沿 insurances me 范式)。RBAC_MAP 同步 +7。

> seed 同步 `member_grade` 1-7(§3.5)+ node_type 4 专业队 code;**非权限码,走 V2_DICT_SEED upsert**。

### 3.5 audit 事件(+6;51→57)

`team-join-cycle.create` / `team-join-cycle.update` / `team-join-application.submit`(自助;actorUserId = 本人 User)/ `team-join-application.mark-gate`(extra: {gateCode, passed, allGeneralComplete})/ `team-join-application.evaluate`(extra: {approved, eliminationStage?})/ `team-join-application.join`(extra: {organizationId, gradeCode, memberId})。`AuditLogEvent` union 51→57。

> 自助改候选部门(`PATCH .../targets`)v1 复用 `team-join-application.submit` 语义不单列事件(轻写;T3 可视需要单列)。

---

## 4. 入队流程冻结(实施不得调换)

### 4.1 10 项考核拆解(§0.5 Q1 纠正后的权威清单)

| # | gate code | 项目 | 标记方 | 有效期 | 落 gateMarks |
|---|---|---|---|---|---|
| 1 | `fitness` | 基础体能(参加即可) | admin/部门 | 本轮 | ✅ |
| 2 | `first-aid-training` | 初级救援培训(完成) | admin | 3年 | ✅ |
| 3 | `military` | 军训 2天2夜(完成) | admin | 2年 | ✅ |
| 4 | `psych` | 心理测试(通过) | admin | 本轮 | ✅ |
| 5 | `interview` | 部门面试 + 附件4(通过) | admin | 本轮 | ✅ |
| 6 | `dept-assessment` | 部门考核(通过) | 部门 | 本轮 ★可延长期 | ✅ |
| 7 | `entry-exam` | 入队普考 医疗/信息/通讯(通过) | admin | 本轮 | ✅ |
| 8 | `intermediate-outdoor` | 中级户外资质(人工审核) | admin | 长期 | ✅ |
| 9 | `contribution` | 贡献值 ≥5(截至入队年 3-31) | **系统自动** | 实时 | ❌(实时算) |
| 10 | (综合评估) | 综合评估人工闸 | biz-admin | ★可延长期 | ❌(evaluate transition) |
| 条件 | `team-water`/`team-urban`/`team-mountain`/`team-high` | 4 专业队考核 | 部门 | 本轮 | ✅ |

> **自动推进条件**(`joining`→`pending_evaluation`):8 通用 admin gate 全 `passed=true` 且在有效期内 **AND** 实时 `contribution≥5`。**专业队 gate 不计入**自动推进。每次 `PATCH .../gates` 后重算;任一通用 gate 失效/未过 → 回退 `joining`(单一真相源,只在此二态切换;`approved`/`joined` 后 gate 不可再动 → 28240)。

### 4.2 gate 有效期 + 延长期语义(W-J / 延长期确认)

- **有效期类型**(模块常量 `GATE_VALIDITY: Record<gateCode, 'cycle' | {years:N} | 'long-term'>`):
  - `cycle`(本轮):`completionDate >= cycle.openedAt`(本轮内完成);否则失效需重做。
  - `{years:N}`:`completionDate + N 年 > 校验时刻(评估/入队 now)`。`first-aid-training`=3 / `military`=2。
  - `long-term`(长期):一经 `passed` 永久有效。`intermediate-outdoor`。
  - 专业队 4 gate = `cycle`。
- **延长期(仅 `dept-assessment` + 综合评估)**:
  - `dept-assessment` 的 gateMark 可带 `extendedUntil: ISO`(admin 设);设了则有效期判定改为 `now <= extendedUntil`(超本轮仍认)。
  - 综合评估 = application `evaluationExtendedUntil: DateTime?`;`approved` 态跨轮入队时,若 `evaluationExtendedUntil` 未到则仍认通过。
  - 其余 gate **不可延**,过期失效需重做(`passed` 重标 + 新 `completionDate`)。

### 4.3 贡献值汇总(W-J-3 + Q4;实时只读)

```
cutoff = Date.UTC(cycle.year, 3 /*Apr*/, 1, 0,0,0) 减 8h  // = {year}-04-01 00:00:00 +08:00 的 UTC 瞬间(exclusive)
sum = attendanceRecord.aggregate({
  where: { memberId, deletedAt: null,
           sheet: { statusCode: 'approved', deletedAt: null },
           checkInAt: { lt: cutoff } },          // 历史累计、无下界
  _sum: { contributionPoints: true },
})
满足 = (sum._sum.contributionPoints ?? Decimal(0)).gte(Decimal(5))
```

- date-anchor = `checkInAt`(在记录上、免连表;= 实际参与时刻)。
- approved-only 字面镜像 `AttendancesService.listMyRecords`(`SHEET_STATUS_APPROVED`)。
- Decimal 全程不转 number(精度);`null` 视作 0。

### 4.4 专业队资格(W-J-1;node_type code 约定)

- 模块常量 `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE`(node_type code → team gate code,4 项)。
- 候选/选定部门 `org` 的 `nodeTypeCode` 命中映射 → **专业队**:要求对应 `team-*` gate `passed` 且有效;未命中 → **非专业队**:仅要求 `fitness`(已在通用 8)。
- seed `member_grade`(level-1~7)+ 4 node_type code(placeholder label,ops 后续把真实队挂到对应 org)。**Organization 不加字段。**

### 4.5 一键入队事务(E-J-4;最重一刀,逐步冻结)

前置(`approved` 态;admin 传 `organizationId`):
1. 申请存在 + `statusCode === 'approved'`(否则 28240)。
2. `organizationId ∈ targetOrganizationIds`(候选内)且 org 存在 + ACTIVE(否则 28242)。
3. 专业队校验(§4.4):若 `org.nodeTypeCode` 命中专业队映射 → 对应 `team-*` gate 满足;否则 28242。
4. 兜底:8 通用 gate + contribution 仍满足(防 `approved` 后 gate 过期;否则 28241)。
5. member 仍 ACTIVE 且**仍无 active member_department / gradeCode 仍 null**(防重复入队;否则 28210)。

事务(`$transaction`,直连 prisma,**不调 member-departments / members service**):
```
await tx.member.findFirst(...)                       // 行内复核 ACTIVE + gradeCode=null
await assertGradeCodeValidTx(tx, 'level-1')          // 复用既有校验逻辑(读 dict)
// 设部门(镜像 set 幂等:志愿者无旧 active 归属,直接建)
const dup = await tx.memberDepartment.findFirst({ where:{ memberId, deletedAt:null } })
if (dup) { /* 理论不应有;有则 28210 */ }
await tx.memberDepartment.create({ data:{ memberId, organizationId } })   // P2002 兜底
// 设级别
await tx.member.update({ where:{id:memberId}, data:{ gradeCode:'level-1' } })
// 状态机终态
await tx.teamJoinApplication.update({ where:{id}, data:{
  statusCode:'joined', selectedOrganizationId:organizationId, joinedAt:now } })
await auditLogs.log({ event:'team-join-application.join', ..., tx })
```
**原子**(全或无;失败回滚 → member 仍无 dept/级别);**幂等**(`joined` 离开 `approved`,重跑前置 28240 命中 0;member_departments partial unique 兜底);**两层身份转换**(此刻才赋部门 + 级别)。

---

## 5. 模块结构(新建 `team-join/` 第 27 模块)

```
src/modules/team-join/
  team-join.module.ts
  team-join.constants.ts        // 状态码 / GATE_CODES(8 通用 + 4 专业队) / GATE_VALIDITY / PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE / 自动推进 helper / cutoff helper
  team-join.dto.ts              // cycle CRUD / 申请提交 / 改候选 / 标 gate / 评估 / 入队 / 进度响应
  team-join-cycles.controller.ts            // admin/v1/team-join/cycles
  team-join-applications.admin.controller.ts // admin/v1/team-join/applications/*
  team-join-applications.app.controller.ts   // app/v1/me/team-join/*(self-scope)
  team-join-cycles.service.ts               // 轮次 CRUD + 至多一个 open 守
  team-join-applications.service.ts         // 提交/改候选/标 gate(+自动推进)/评估/列表/详情/实时贡献值汇总
  team-join-enrollment.service.ts           // 一键入队单事务(镜像 recruitment-promotion.service.ts)
  *.service.spec.ts
```
导出 3 service;import Prisma / AuditLogs / Permissions(rbac);**不 import** members / member-departments service 进事务(E-J-4 防环)。第 27 模块 → CODEMAP 模块数 +1。

---

## 6. 既有行为锁(实施期间任何一条破坏 = 停下报告)

1. members / member-departments / certificates / activities / attendances / auth / wechat / sms / recruitment(phase-1/2)模块**零 diff**;既有 e2e/unit 断言**零修改**。
2. `MemberDepartmentsService.set` / `MembersService.update` public 行为零变化(本期不改,只在 enrollment 事务内**直写** member_departments / member.gradeCode)。
3. `member_grade` 字典从 demo 占位换 level-1~7 = **新增 code**;不删除既有 demo 行的迁移(seed upsert-only),clean-DB replay 只得 1-7;现有库 demo grade 无成员引用(无害孤项)。
4. 贡献值汇总**只读** attendance,零写、零碰 contribution-rules / 考勤状态机。
5. 两层身份铁律:入队前 member 无部门无级别、入队后才赋;e2e 锁定。

---

## 7. 测试计划(DoD 展开)

- **migration**:干净库 21/21 重放;seed 二跑幂等(含 grade 1-7 + node_type 4 专业队 code)。
- **e2e(team-join 新 spec)**:
  1. 自助发起入队申请 + 选多候选部门;非 member / 已入队 member 被拒(28210)。
  2. 8 通用 gate 标记全链(幂等;谁标/何时;passed true/false)+ 自动推进 `joining`→`pending_evaluation`;任一通用 gate 清/失效 → 回退。
  3. 贡献值自动算两路:≥5 满足 / <5 不满足;**有效期过期失效**(老 `completionDate` 的 cycle gate / 超期 years gate → 不满足);延长期(dept-assessment / 综合评估 extended)仍认。
  4. 综合评估两路:approved→`approved` / reject→`rejected`(eliminationStage=evaluation);`joining` 态 reject→rejected(gate-timeout)。
  5. 一键入队:设部门 + level-1、**单事务原子**(失败两者皆无)、**幂等重跑**(命中 0)、**两层身份转换**(前无 dept/级别 → 后有)。
  6. 专业队 vs 非专业队选部门门槛:非专业队 fitness 过即可;选专业队缺对应 gate → 28242;专业队 gate 过 → 入队成功。
  7. 状态机各分支 + 候选部门外的 organizationId → 28242。
- **零回归**:members/member-departments/certificates/活动/考勤/auth/wechat/recruitment 既有断言零改;phase-1/2 链路零回归。
- **全绿**:unit / e2e / contract(~212 路由白名单)/ `docs:rbacmap:check` 0 FAIL/0 WARN(146 码)/ `docs:codemap:check` 0 FAIL(27 模块 / 21 migration)。

---

## 8. 任务队列与探针(顺序硬约束;goal 原文固化)

- **T0**(本稿)✅:评审稿冻结 + §0.5 元核验。
- **T1 schema**(srvf-prisma-change D 档):2 新表 + 1 partial unique + 索引 + grade 1-7 dict seed + node_type 4 专业队 dict seed;第 21 migration;干净库重放 + seed 幂等二跑。**权限码不在 T1**(rbacmap 检查 F「孤码」= WARN,无 controller 调用点的码会触 WARN;故 +7 码随 T2 controller 落,与 call-site 同步,避免孤码;亦对齐 goal T1 仅「schema + grade seed + migration」口径)。
- **T2 admin 面 + 自动贡献值**:9 admin 端点(cycle CRUD + 标 gate + 评估 + 一键入队)+ 贡献值只读汇总;状态机推进 + audit;**权限码 +7 全绑 biz-admin(139→146)+ RBAC_MAP true-up**(与 rbac.can() call-site 同 PR)。
- **T3 志愿者自助面**(app/v1):发起 + 选候选部门 + 查进度(self-scope)。
- **T4 一键入队**:enrollment 单事务(设部门 + 级别 1,原子/幂等/失败可恢复;两层身份转换)。
  > 注:T2 与 T4 实现上耦合(`/applications/:id/join` 端点 = T2 列出、enrollment 事务 = T4 实现);实施可合并 PR,文档与队列保留分项以对齐 goal。
- **T5 docs 收尾**:current-state §2/§3/§4 + CHANGELOG + NEXT_TASKS(P1-13 转归档)+ 本稿引用。

---

## 9. 本期不做(终版报告必列)

- phase 3 之后:退队 / 晋升体系扩展 / 多部门常态归属 / 级别历史版本化。
- 接 `CertificatesService.isQualified`(W-J-2 留作未来:`first-aid-training`/`intermediate-outdoor` 等若需自动核验,届时 +cert_type seed + team-join↔cert 桥,单独立项)。
- 部门级权限细分(标 gate 的「部门」职务无数据模型承载,v1 = biz-admin 统一标,沿 Slow-3 考勤终审同款挂起)。
- 真实腾讯云通道 / 新 cron / 单独 APD 角色 / 小程序前端。
- 贡献值「年度窗口」语义(Q4 取历史累计;若业务后续改年度窗口 = 改 cutoff 下界,单独立项)。

---

## 10. 红区改动计划(goal 授权范围内)

- `prisma/schema.prisma`:+2 model(`team_join_cycles` / `team_join_applications`);A-3 解除(goal 授权 D 档)。
- `prisma/migrations/`:第 21 migration(建表 + partial unique);A-4 解除。
- `prisma/seed.ts`:`member_grade` 1-7 + node_type 4 专业队 code(upsert 幂等)。
- `baseline §1.1` 红区:282xx BizCode 段登记(goal 授权 true-up)。
- `AGENTS.md` surface/段位表 / `docs/current-state.md` §2/§3/§4 / `RBAC_MAP.md`(146)/ CODEMAP(27 模块 21 migration):T5 true-up。
- 受保护文档改动随 PR body 标注(沿 protected-docs-goal-authorization)。
</content>
</invoke>
