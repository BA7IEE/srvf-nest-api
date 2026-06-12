# SRVF 保险模块评审稿(Insurance Module Review)

> **状态:冻结**(2026-06-13;maintainer 2026-06-12 goal「保险模块」拍板,goal 文本即立项 + 评审授权;本稿按 [`process.md §4`](../../process.md) D 档降速产出,冻结后不回改)。
> **业务依据**:维护者持有的需求说明书 `:687`(报名"无保险信息不予通过")/ `:698`(部分活动组织方买险)/ `:422`(志愿者自购)/ `:452`(队统一买)+ 顶层设计 §8(保险业务域)+ C015(保险必须存系统)。需求文档不入仓,引用以 goal 原文为准。
> **范式母本**:保险记录镜像 `certificates`(软删 / 审计 / 到期字段);App 自助镜像 App self-scope(`app/v1/me/*`);admin 端沿 Slow-4 业务面 `rbac.can()` + biz-admin。

---

## 0. TL;DR

三块数据:① 自购保险(`member_insurances`,每队员多条,App 自助 CRUD,self-scope 不接 RBAC);② 队统一保单(`team_insurance_policies`,admin CRUD);③ 覆盖名单(`team_insurance_coverages`,保单 × 队员 join,partial unique,支持"全体在册一键加"幂等批量)。活动门槛:`Activity +requiresInsurance @default(false)`,报名 create 时校验「自购有效 **或** 队保单覆盖,任一即可」,否则抛 `INSURANCE_REQUIRED=26030`。自报即可,v1 无核验流程;到期时间是有效性唯一依据。

## 1. 决策汇总表

### 1.1 goal 已拍板项(D-INS;冻结,不重开)

| # | 决策 |
|---|---|
| D-INS-1 | 三表 + `Activity.requiresInsurance Boolean @default(false)`;默认 false = 迁移安全,既有活动 / 测试零影响,新活动发布时显式开 |
| D-INS-2 | 自购保险字段:保险公司 / 保单号 / 到期时间(必填)+ 起保日(可选);队保单:保险公司 / 保单号 / 起保 / 到期 + 备注,一张 = 一条 |
| D-INS-3 | 自助端点落 `app/v1/me/insurances`,JwtAuthGuard + `currentUser.memberId` 锁本人,**不接 RBAC**;admin 端沿 `rbac.can()` + biz-admin |
| D-INS-4 | 门槛 = 报名时校验(快照),「到期 ≥ 活动日期的自购保险」**或**「到期 ≥ 活动日期的队保单覆盖名单内」任一来源即可;有起保日则 起保 ≤ 活动日 也校 |
| D-INS-5 | 自报即可,v1 不做核验流程;到期时间是有效性唯一依据 |
| D-INS-6 | 一键加 = 批量、幂等、仅 active 未软删队员 |
| D-INS-7 | v1 不做:理赔记录(§8 单独立项)/ 到期主动提醒(到期字段已留,不发短信)/ 保险核验工作流 |
| D-INS-8 | 跨模块依赖单向:activity-registration → insurances;BizCode 段预计 26xxx(本稿 §3.3 亲核确认);红区仅 baseline §1.1 加 BizCode 段 |

### 1.2 工程代决项(E-INS;本稿冻结)

| # | 代决 | 依据 |
|---|---|---|
| E-1 | 表名 `@@map` snake 复数(`member_insurances` / `team_insurance_policies` / `team_insurance_coverages`),model 名 `MemberInsurance` / `TeamInsurancePolicy` / `TeamInsuranceCoverage` | 沿 RBAC / attachments / sms / wechat 近期惯例;goal 表名即 snake 形 |
| E-2 | 字段名:`insurerName`(128)/ `policyNumber`(128;**不做唯一**,不同人可在同公司同保单号下,无业务唯一性)/ `coverageStart` / `coverageEnd` / `note`(500);长度由 DTO 承担不落 `@db.VarChar`(沿批次 1/2/3 B 路径) | 镜像 `Certificate.issuingOrg` / `certNumber` / `expiredAt` |
| E-3 | 覆盖名单 partial unique `team_insurance_coverages_policy_member_active_unique` ON (`"policyId"`,`"memberId"`) WHERE `"deletedAt" IS NULL`,migration SQL 末尾手写 | 沿 `activity_registrations_activity_member_active_unique` 范式(Prisma DSL 不支持带 WHERE) |
| E-4 | 三表 FK 全部 `onDelete: Restrict`;软删走 `deletedAt`(certificates 范式);保单软删**不级联**软删覆盖行(门槛查询 join `policy.deletedAt IS NULL`,被删保单下的覆盖行自然失效) | 镜像 certificates / 报名;最小机制 |
| E-5 | 索引:`member_insurances`(memberId / coverageEnd / deletedAt / createdAt);`team_insurance_policies`(coverageEnd / deletedAt / createdAt);`team_insurance_coverages`(policyId / memberId / deletedAt / createdAt) | 镜像 certificates(memberId / expiredAt / deletedAt …);coverageEnd 是门槛查询主路径 |
| E-6 | 权限码 7 条(§3.4),全部绑 biz-admin(无 `member.delete.record` 式例外);追加进 `BIZ_PERMISSION_SEED`(36→43,biz-admin 绑 35→42);ops-admin(61)/ member(9)零变化 | 沿 Slow-4 评审稿 §5 拼装 + 强校验(动态 length,公式自适应) |
| E-7 | `member-insurance.read.other` 取 goal 原文码形(module=`member-insurance` / action=`read` / resourceType=`other`);3 段形沿 D2 正则 | goal 文本即拍板 |
| E-8 | BizCode 占 `260xx` 段 6 码(§3.3);**不开** `261xx` `FORBIDDEN_*`(权限不足走 30100 / 40300,沿 baseline);过期与无保险**不细分**(同 26030,前端提示价值无差) | 沿 23xxx / 24xxx / 25xxx 先例 |
| E-9 | audit:写操作 8 事件进 `AuditLogEvent`(DB union 35→43,§3.5),镜像 certificates 写审计(before/after snapshot,无掩码需求——保单号中敏感非 L3,audit_logs 本身 RBAC 保护,沿 certificates `certNumber` 先例);admin 读他人自购保险补 1 条 `auditPlaceholder` pino 事件 `member-insurance.read.other`(镜像 `certificate.read.other`;placeholder union 28→29);App self 读写中**读不写 audit**(沿 D-P2-7-16);队保单读不 hook(团队台账非个人敏感,沿 contribution-rules 先例) | 镜像 certificates 双轨 |
| E-10 | 门槛断言放 `activity-registrations.service` 的 `create()`(admin 代报名)与 `createMy()`(自助;App `createMyForApp` 薄壳经此)**两处事务内**,位置在 `assertNoActiveRegistration` 之后、`create` 之前;admin 代报名**同样拦截**(C015 保险必须存系统,无旁路) | 双 create 路径全覆盖 |
| E-11 | 门槛日期语义(冻结):活动区间 [startAt, endAt](两者 NOT NULL);自购有效 = `deletedAt IS NULL AND coverageEnd >= endAt AND (coverageStart IS NULL OR coverageStart <= startAt)`;队保单覆盖 = 覆盖行与保单均未软删 `AND p.coverageEnd >= endAt AND p.coverageStart <= startAt`;边界含等号(coverageEnd = endAt 通过) | D-INS-4 展开;覆盖整个活动期 |
| E-12 | 门槛快照语义:仅报名 create 时校验;approve / cancel / 保险后续变化**不回溯复检**(goal「报名时校验(快照)」) | D-INS-4 |
| E-13 | 导出校验服务 `InsuranceRequirementService.assertMemberInsuredForActivity(memberId, activity, tx)`(接受 TransactionClient,事务内复用);`InsurancesModule` export,`ActivityRegistrationsModule` import(单向) | D-INS-8 |
| E-14 | App 自助 4 端点(list 分页 / create / update / delete;**无 :id 详情**,goal 列举即 4);list 无过滤参数(v1 最小);准入沿 `AppIdentityResolver` + canUseApp=false → 40300;防 IDOR:update/delete 按 `id + memberId(本人)+ deletedAt IS NULL` 查,他人 / 不存在 / 已删统一 26001(防侧信道,沿 P2-5 `findMy` 范式) | 镜像 app-my-certificates + cancelMy |
| E-15 | admin 查队员保险 `GET admin/v1/members/:memberId/insurances` 返**数组无分页**(镜像 admin certificates list);先 `MEMBER_NOT_FOUND` 校验 | 镜像 certificates.list |
| E-16 | 队保单 list / 覆盖名单 list 分页(`PageResultDto`;admin 顶层集合);单加重复 → 26004(409;P2002 兜底同码);移除按 `DELETE :id/members/:memberId`(partial unique 保证活跃行唯一),不存在 → 26003;一键加二跑 `addedCount=0`(幂等证据) | 沿统一分页铁律 + 21002 范式 |
| E-17 | 一键加端点 `POST admin/v1/team-insurance-policies/:id/members/add-all-active`;选取 = `Member.deletedAt IS NULL AND status=ACTIVE` 且不在该保单活跃覆盖中;单加(`POST :id/members`,body `{memberId}`)要求 member 存在 + 未软删(status 不限,管理员显式意图);audit 单事件 extra 区分 mode | D-INS-6 展开 |
| E-18 | 日期跨字段校验(coverageStart > coverageEnd → `26010`,400)在 service 层(DTO 无跨字段能力);自购与队保单共用 | — |
| E-19 | T3 `requiresInsurance` 接线镜像 `isPublicRegistration`:CreateActivityDto(可选,缺省走 Prisma default false)/ UpdateActivityDto(可选)/ ActivityResponseDto + ListItem + safeSelect + mapper;**仅 admin 面**;App activities DTO 字段集不动(App 端拒报时经 26030 message 提示;App 列表展示门槛标识挂 NEXT_TASKS 等小程序前端真实需要) | T3 DoD 原文「activities create/update DTO + requiresInsurance(Swagger)」最小忠实 |
| E-20 | **保单图本期不接线**:attachments 多态(ownerType+ownerId)天然无需 schema 字段,设计语义预留 `ownerType='member-insurance'`;但完整上传链 = `AttachmentOwnerType` 硬编码 enum 扩展 + `assertOwnerExists`/scope 分支 + `attachment.{upload,view,update,delete}.member-insurance.{self,other}` 8 权限码 seed + 配置三表运行时行,**超出 goal T1(~6-7 码)/ T2 DoD 清单**(D 档禁顺手做)→ 挂 NEXT_TASKS 单独立项 | goal DoD 忠实执行;§10 显式列入"本期不做" |
| E-21 | seed 二档计数随授权 seed 变更同步(沿 wechat T2 先例):`seed-biz-admin.e2e-spec.ts` 期望清单 +7(36→43 / 35→42)+ `biz-admin.fixture.ts` 清单 +7;RBAC_MAP 计数 121→128 随 T1 PR true-up(rbacmap 检查 B 项要求) | 守护脚本口径 |
| E-22 | T1 新 7 码在 src 无引用 → `docs:rbacmap:check` F 项 WARN(孤码候选)**属预期**,T2 实装清零(镜像 wechat T2 `user.wechat.clear` 先例);T1/T2 间 26xxx 常量先于 baseline 行落地的窗口由本稿冻结消歧(红区行按 goal 归 T3 PR) | — |
| E-23 | 模块结构(§5):平铺 `src/modules/insurances/`,2 admin controller + 1 App controller(controllers/ 子目录)+ 3 service + dto/app/ 隔离;**不**新增 Mixed Controller;App DTO 禁派生 | AGENTS §2 已解锁例外 |
| E-24 | 不加 `expireNotifyDueAt` 类提醒 hook 字段(certificates HK-1 不复制;goal「留字段不发短信」之"字段"即 `coverageEnd`) | D-INS-7 |

## 2. 风险表(D 档降速 ②)

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ T1:三表 + `Activity.requiresInsurance` + Member 反向关系 2 处 |
| 是否新增 migration | ✅ T1 一个(第 18 个;命名 `2026MMDDHHMMSS_add_insurance_module`);含手写 partial unique;**纯新增 + 单列 default false 加列,无破坏性,无历史数据回填** |
| 是否修改 `prisma/seed.ts` | ✅ T1:+7 权限码进 BIZ_PERMISSION_SEED,全绑 biz-admin;既有码 / 绑定 / 角色零变化 |
| 是否影响现有数据 | ❌(全部新增;`requiresInsurance` default false 对既有行无行为影响) |
| 是否不可逆 | ❌(回退 = drop 三表 + drop column;无数据迁移) |
| 是否影响 OpenAPI / contract snapshot | ✅ T2 +14 端点 / T3 活动 DTO +1 字段;**仅新增,零删改,零 L3** |
| 是否影响鉴权 / Permission seed / 审计 | ✅ 权限码 121→128 / biz-admin 35→42;AuditLogEvent union 35→43 + placeholder 28→29;**JwtPayload / auth 模块 / Guard 链零碰** |
| 是否需要新增 BizCode | ✅ 26xxx 段 6 码(§3.3 亲核空闲);baseline §1.1 红区加行(T3,逐行进 PR,#294 范式) |
| 是否需要用户拍板 | ✅ 已拍板(2026-06-12 goal 即授权;本稿为 T0 冻结) |

## 3. 五张清单

### 3.1 schema(T1)

```prisma
model MemberInsurance {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  memberId      String
  insurerName   String    // 保险公司;长度 128 由 DTO 约束(沿 issuingOrg 范式)
  policyNumber  String    // 保单号;长度 128 由 DTO 约束(沿 certNumber;无唯一约束)
  coverageStart DateTime? // 起保日(可选)
  coverageEnd   DateTime  // 到期时间(必填;有效性唯一依据,D-INS-5)

  member Member @relation(fields: [memberId], references: [id], onDelete: Restrict)

  @@index([memberId])
  @@index([coverageEnd])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("member_insurances")
}

model TeamInsurancePolicy {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  insurerName   String
  policyNumber  String
  coverageStart DateTime // 起保(必填,goal ②)
  coverageEnd   DateTime
  note          String?  // 备注;长度 500 由 DTO 约束

  coverages TeamInsuranceCoverage[]

  @@index([coverageEnd])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("team_insurance_policies")
}

model TeamInsuranceCoverage {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  policyId String
  memberId String

  policy TeamInsurancePolicy @relation(fields: [policyId], references: [id], onDelete: Restrict)
  member Member              @relation(fields: [memberId], references: [id], onDelete: Restrict)

  // partial unique (policyId, memberId) WHERE "deletedAt" IS NULL —— migration SQL 末尾手写(E-3)
  @@index([policyId])
  @@index([memberId])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("team_insurance_coverages")
}
```

+ `Activity.requiresInsurance Boolean @default(false)`;+ `Member.memberInsurances MemberInsurance[]` / `Member.teamInsuranceCoverages TeamInsuranceCoverage[]`。

### 3.2 端点清单(T2 共 14;T3 零新端点)

| # | Method Path | 鉴权后缀 | 出参 |
|---|---|---|---|
| 1 | `GET app/v1/me/insurances` | `[auth]` | 分页 `AppMyInsuranceDto` |
| 2 | `POST app/v1/me/insurances` | `[auth]` | `AppMyInsuranceDto` |
| 3 | `PATCH app/v1/me/insurances/:id` | `[auth]` | `AppMyInsuranceDto` |
| 4 | `DELETE app/v1/me/insurances/:id` | `[auth]` | `AppMyInsuranceDto`(软删) |
| 5 | `GET admin/v1/team-insurance-policies` | `[rbac: team-insurance-policy.read.record]` | 分页 |
| 6 | `POST admin/v1/team-insurance-policies` | `[rbac: team-insurance-policy.create.record]` | 单对象 |
| 7 | `GET admin/v1/team-insurance-policies/:id` | `[rbac: team-insurance-policy.read.record]` | 单对象 |
| 8 | `PATCH admin/v1/team-insurance-policies/:id` | `[rbac: team-insurance-policy.update.record]` | 单对象 |
| 9 | `DELETE admin/v1/team-insurance-policies/:id` | `[rbac: team-insurance-policy.delete.record]` | 单对象(软删) |
| 10 | `GET admin/v1/team-insurance-policies/:id/members` | `[rbac: team-insurance-policy.read.record]` | 分页(覆盖名单,含 member 摘要) |
| 11 | `POST admin/v1/team-insurance-policies/:id/members` | `[rbac: team-insurance-policy.add.member]` | 覆盖行 |
| 12 | `POST admin/v1/team-insurance-policies/:id/members/add-all-active` | `[rbac: team-insurance-policy.add.member]` | `{ addedCount }` |
| 13 | `DELETE admin/v1/team-insurance-policies/:id/members/:memberId` | `[rbac: team-insurance-policy.remove.member]` | 覆盖行(软删) |
| 14 | `GET admin/v1/members/:memberId/insurances` | `[rbac: member-insurance.read.other]` | 数组(无分页,镜像 certificates) |

contract 168→182(仅新增)。App 控制器 `@Controller('app/v1/me/insurances')` 与既有 `app/v1/me`(users 模块,全字面段)无路由遮蔽。Tag:`Mobile - My Insurances` / `Admin - Team Insurance Policies` / `Admin - Member Insurances`。

### 3.3 BizCode(26xxx;2026-06-13 亲核:`grep "code: 26" biz-code.constant.ts` 零命中,§1.1 表 `260xx-290xx` 未规划预留,25xxx wechat 为最后实装段)

| code | 常量 | http | 落点 |
|---|---|---|---|
| 26001 | `MEMBER_INSURANCE_NOT_FOUND` | 404 | T2(App update/delete 防侧信道统一;admin 查不存在) |
| 26002 | `TEAM_INSURANCE_POLICY_NOT_FOUND` | 404 | T2 |
| 26003 | `TEAM_INSURANCE_COVERAGE_NOT_FOUND` | 404 | T2(移除不在名单的队员) |
| 26004 | `TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS` | 409 | T2(单加重复;P2002 兜底同码) |
| 26010 | `INSURANCE_COVERAGE_DATE_RANGE_INVALID` | 400 | T2(coverageStart > coverageEnd;自购与队保单共用) |
| 26030 | `INSURANCE_REQUIRED` | 409 | T3(报名门槛;message「该活动要求保险,当前队员无覆盖活动日期的有效保险」;409 沿 20120/21030 报名业务态冲突家族) |

**不开**:`261xx FORBIDDEN_*` / 过期细分码 / `26005+` 预留。baseline §1.1 红区加行随 T3 PR(§11)。

### 3.4 权限码(7 条,T1 seed;全绑 biz-admin;自助侧零码)

| code | module / action / resourceType | description 要点 |
|---|---|---|
| `team-insurance-policy.read.record` | team-insurance-policy / read / record | 列表 + 详情 + 覆盖名单共用 read |
| `team-insurance-policy.create.record` | … / create / record | — |
| `team-insurance-policy.update.record` | … / update / record | — |
| `team-insurance-policy.delete.record` | … / delete / record | 软删;不级联覆盖行(E-4) |
| `team-insurance-policy.add.member` | … / add / member | 单加 + 一键加共用 |
| `team-insurance-policy.remove.member` | … / remove / member | — |
| `member-insurance.read.other` | member-insurance / read / other | admin 查队员自购保险(App 本人侧无码,self-scope) |

权限码全集 121→**128**;biz-admin 35→**42**;ops-admin 61 / member 9 零变化。

### 3.5 audit 事件

**DB `AuditLogEvent` union +8(35→43;T2 接入)**:

| 事件 | 触发 | resourceType / resourceId | extra 要点 |
|---|---|---|---|
| `member-insurance.create.self` | App create | member-insurance / 记录 id | memberId;after snapshot |
| `member-insurance.update.self` | App update | 同上 | before/after |
| `member-insurance.delete.self` | App delete(软删) | 同上 | before |
| `team-insurance-policy.create` | admin create | team-insurance-policy / 保单 id | after |
| `team-insurance-policy.update` | admin update | 同上 | before/after |
| `team-insurance-policy.delete` | admin 软删 | 同上 | before |
| `team-insurance-coverage.add` | 单加 / 一键加 | team-insurance-policy / 保单 id | mode ∈ {single, all-active};single 带 memberId;all-active 带 addedCount |
| `team-insurance-coverage.remove` | 移除 | 同上 | memberId |

**pino `auditPlaceholder` union +1(28→29)**:`member-insurance.read.other`(admin list 队员自购保险;镜像 `certificate.read.other`)。
**不写**:App self 读(D-P2-7-16)/ 队保单与覆盖名单读(配置台账类,沿 contribution-rules 读不 hook)/ 任何明文凭证(本域无 L3)。

## 4. 门槛校验语义冻结(E-10/E-11/E-12 汇总;实施不得调换)

1. `requiresInsurance=false` → 零查询直接通过(既有活动 / 既有测试全部走此路径 = 零回归保证)。
2. `requiresInsurance=true` → `InsuranceRequirementService.assertMemberInsuredForActivity(memberId, { startAt, endAt }, tx)`:
   - 自购:`member_insurances` 存在 `memberId 本人 AND deletedAt IS NULL AND coverageEnd >= endAt AND (coverageStart IS NULL OR coverageStart <= startAt)` → 通过;
   - 否则队保单:`team_insurance_coverages c JOIN team_insurance_policies p` 存在 `c.memberId 本人 AND c.deletedAt IS NULL AND p.deletedAt IS NULL AND p.coverageEnd >= endAt AND p.coverageStart <= startAt` → 通过;
   - 两者皆无 → `BizException(INSURANCE_REQUIRED=26030)`。
3. 调用点:`create()`(admin 代报名)与 `createMy()`(自助)事务内,`assertNoActiveRegistration` 之后、`tx.create` 之前;`assertActivityRegistrable` select 扩展 `requiresInsurance / startAt / endAt` 三字段供断言复用(不另发查询)。
4. 快照:approve / cancel / 保险增删改**不回溯**;开关 update 改 true 只影响其后新报名。

## 5. 模块结构(AGENTS §2 已解锁例外内)

```
src/modules/insurances/
├── insurances.module.ts                       # imports UsersModule(AppIdentityResolver)/ PermissionsModule / AuditLogsModule;exports InsuranceRequirementService
├── insurances.dto.ts                          # admin DTO(超 300 行则拆 dto/ 子目录)
├── team-insurance-policies.controller.ts      # admin/v1/team-insurance-policies(端点 5-13)
├── admin-member-insurances.controller.ts      # admin/v1/members/:memberId/insurances(端点 14)
├── team-insurance-policies.service.ts         # 保单 CRUD + 覆盖管理 + rbac.can + audit
├── member-insurances.service.ts               # admin read.other(+ auditPlaceholder)
├── insurance-requirement.service.ts           # 导出门槛校验(E-13;无 rbac,内部服务)
├── controllers/
│   └── app-me-insurances.controller.ts        # app/v1/me/insurances(端点 1-4)
├── app-me-insurances.service.ts               # App self CRUD(AppIdentityResolver 准入 + memberId 锁 + audit self 事件)
└── dto/app/                                   # App DTO 独立,禁派生(D-6)
```

跨模块:`ActivityRegistrationsModule` import `InsurancesModule`(单向,T3);insurances **不** import activity 系模块(防环)。

## 6. 敏感字段三问(AGENTS §18.4)

1. **业务用途**:保单号 / 保险公司 = 报名门槛资格依据 + 队务保单台账(需求 :687/:698/:422/:452 + C015 保险必须存系统)。
2. **查看角色**:本人(App self-scope)+ 持 `member-insurance.read.other` 的管理面(biz-admin 默认含);队保单 = 持 `team-insurance-policy.read.record`。**中敏感,沿 certificates 可见性,不掩码**(`certNumber` 全显先例);**无 L3 字段**(无 token / secret / 证件号),不进日志 redact 清单。
3. **保存期限**:软删保留(沿 certificates);v1 不做退队自动清理(真实诉求出现单独立项);audit snapshot 沿 certificates 全量(audit_logs 自身 RBAC 保护)。

## 7. 既有行为锁(实施期间任何一条破坏 = 停下报告)

1. 既有 activity-registration characterization + e2e **断言零修改**全绿(default false 保证;若需改既有断言才能绿 → 停 + 人话简报,goal §3 原文)。
2. registration audit 事件名 / extra 形态零变化(门槛在 create 落库前抛,无新 audit 路径)。
3. contract snapshot **仅新增**(168→182 路由 + 活动 DTO 字段),零删改、零 L3。
4. auth / JwtPayload / throttler / Guard 链零碰;attachments / sms / wechat 模块零 diff。
5. seed 既有码与绑定零变化(ops-admin 61 / member 9 / attachment 20 码不绑维持);biz-admin 仅增量 +7。
6. `docs:rbacmap:check` / `docs:codemap:check` 各阶段 0 FAIL(T1 孤码 WARN 预期,T2 清零,E-22)。

## 8. 测试计划

- **T1**:`seed-biz-admin.e2e-spec.ts` 期望清单 +7(43/42)断言绿;干净库 `prisma migrate deploy` 重放 18/18(docker-smoke CI 兜底 + 本地 Docker 可用则亲跑);seed 幂等二跑(docker-smoke 既有双跑步骤)。
- **T2 新 spec ×2**:
  - `app-me-insurances.e2e-spec.ts`:自助 CRUD 全链;**防越权**(B 改 / 删 A 的记录 → 26001 不泄露存在性;无 member 用户 → 40300;未登录 → 40100);26010 日期校验;软删后 list 不可见。
  - `team-insurance-policies.e2e-spec.ts`:保单 CRUD;覆盖单加 / 重复 26004 / 移除 / 移除不存在 26003;**一键加幂等**(首跑 addedCount=N,二跑 =0;INACTIVE / 软删队员不入名单);RBAC 边界(未持码 ADMIN → 30100,biz-admin → 通过,SA 短路;镜像 *-rbac-boundary 范式);admin 查队员保险 + MEMBER_NOT_FOUND。
- **T3 新 spec ×1**:`activity-registrations-insurance-gate.e2e-spec.ts` 5 场景:关→不校验(无保险也过)/ 开+自购有效→过 / 开+队保单覆盖→过 / 开+无保险→26030 / 开+过期→26030;边界:coverageEnd=endAt 过、coverageStart>startAt 拒、App 自助路径同拦截、admin 代报名同拦截。
- 全程:`agent:check:full`(本地无 Docker 时 quick + 显式声明留 CI,不谎报)。

## 9. 任务队列与探针(顺序硬约束;goal §2 原文固化)

| 阶段 | 档位 | 内容 | 探针(未满足才做) |
|---|---|---|---|
| T0 | A | 本稿 + NEXT_TASKS 登记 | 本稿不存在 / NEXT_TASKS 无保险条目 |
| T1 | D | §3.1 schema + migration + §3.4 seed + 计数同步(E-21) | schema 无 `MemberInsurance` |
| T2 | C/D | §3.2 端点 + §3.5 audit + §3.3 前 5 码 + 门槛服务 + e2e ×2 + contract | `src/modules/insurances/` 不存在 |
| T3 | C/D | `requiresInsurance` DTO 接线(E-19)+ 双 create 断言(E-10)+ 26030 + baseline §1.1 红区行 + e2e 5 场景 | 报名 create 无门槛断言 |
| T4 | A | CHANGELOG / current-state / RBAC_MAP / CODEMAP true-up / NEXT_TASKS 归档 + 后续挂项 | current-state §2 无保险行 |

## 10. 本期不做(终版报告必列)

- 理赔记录(顶层设计 §8 余项,单独立项)
- 到期主动提醒(`coverageEnd` 字段已留;不发短信、不进生日批 cron——新定时任务 = 新 D 档评审,R-5)
- 保险核验工作流(自报即可,无 verify 状态机 / 状态字段;无 `expireNotifyDueAt` 类 hook 字段,E-24)
- **保单图 attachments 接线**(E-20:ownerType 语义已预留,enum 分支 + 8 权限码 + 配置行挂 NEXT_TASKS 单独立项)
- App activities DTO 暴露 `requiresInsurance`(E-19;拒报经 26030 message 提示,列表标识等前端真实需要)
- insurance 自助端点接 RBAC(走 self-scope,goal 禁区)
- 真实保险数据录入(业务侧作业)

## 11. 红区改动计划

唯一红区 = `docs/srvf-foundation-baseline.md §1.1`(T3 PR,逐行可解释,沿 #294 范式):

1. 总段位映射表:`260xx`-`290xx` 预留行收窄为 `270xx`-`290xx`;其上插入 `| 260xx + 261xx | insurances | 200 | 保险模块已实装(2026-06-13 goal 拍板;260xx 段 6 BizCode〔26001/26002/26003/26004/26010/26030〕;不开 261xx;冻结评审稿本文件)|`。
2. 状态说明 bullet 区追加一条"保险模块已实装"说明(码清单 + 不开项 + 评审稿链接)。
3. "仅 260xx-290xx + 310xx 起仍属未规划预留"措辞同步为 270xx。

AGENTS.md / V2 红线 / api-surface-policy **零碰**(本模块无需解锁任何既有铁律行)。
