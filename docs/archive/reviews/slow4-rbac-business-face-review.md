# Slow-4 业务面 RBAC 接入评审稿(权限双轨收口)

> **性质**:冻结评审稿(2026-06-11,goal「权限双轨收口——业务面 RBAC 接入」T0 产出)。
> **法理**:process §7.1 goal 协作模式;goal 文本 = 立项 + 拍板凭据(D 档预拍板);本稿为 T1-T4 实施的冻结文本,实施偏离本稿即停。
> **冻结后不回改**(process §6);如发现过时,更新 `docs/current-state.md` / `RBAC_MAP.md`,不回改本稿。

---

## 0. TL;DR

把 RBAC_MAP §2.2 G 模式 7 个业务模块(**44 个端点,亲核修正,见 D-S4-1**)从 Guard `@Roles` 双轨迁移到 Service 层 `rbac.can()` 单轨:新增内置角色 `biz-admin`(承载 Slow-3 决议的"全量业务权限")+ **36 枚新权限码**(绑 35,`member.delete.record` 仅 SA 沿 D1=A 判例);activities 列表+详情 2 端点无码化(仅登录)。**验收线 = 零行为漂移**:今天能干的迁后原样能干,今天不能的迁后依旧不能(拒权码按既定语义 40300→30100,沿 P0-F 先例)。

## 1. 决策汇总

### 1.1 Slow-3 决议(维护者 2026-06-11 拍板;goal §0 原文为凭据)

- ADMIN 内置角色边界 = **全量业务权限**,由新内置角色 **`biz-admin`** 承载;
- 部门级细分**仍不做**(P1-5 方案 A 沿用:维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录);
- 迁移目标 = **零行为漂移**。

### 1.2 goal 既定拍板项(不再讨论)

| 项 | 拍板内容 |
|---|---|
| 范围 | 7 模块 44 端点(见 §3);不动 App surface / `@Public` / ops-admin 与 member 绑定 / attachment 存量 20 码 / AGENTS:242 |
| 拒权码 | 沿既有 `RBAC_FORBIDDEN`(30100)段;**零新增 BizCode** |
| seed | 纯 seed 无 schema;幂等不变式「每个 `Role.ADMIN` 用户持有 biz-admin」每次 seed 自动补挂 + 强校验(沿"至少 1 个 ops-admin"范式) |
| members DELETE | 码不绑 biz-admin,ADMIN(即使持 biz-admin)仍拒、SA 仍通(D1=A 判例镜像) |
| activities 列表+详情 | 无码化,仅登录(`[auth]`);service 内 Q-A7 USER 过滤逻辑原样保留 |
| e2e | 新建 `grantBizAdminToUser` fixture;既有业务 spec 的 ADMIN 测试用户统一补挂;每模块新增权限边界 spec |
| 红区 | 例外仅 AGENTS §8 主题内措辞校准(T4);不收紧也不放宽任何权限语义 |

### 1.3 工程细节代决项(本稿固化;实施不得再漂移)

| 编号 | 决定 | 依据 |
|---|---|---|
| **D-S4-1** | 端点计数 true-up:**48 → 44**。亲核三方一致:活跃 `@Roles` 装饰器 44 行 = HTTP 端点 44 个 = `[roles:]` summary 后缀 44 处(6+3+4+8+7+6+10);RBAC_MAP §2.2 的"48 处"为该表笔误(P2-2 归档记录亦为 44)。7 模块范围与 goal 完全一致,无端点增减 | RBAC_MAP §6.6"与代码不一致以代码为准";goal §4 统计亲核纪律 |
| **D-S4-2** | 权限码 **36 枚**(goal 预估 ~40;按映射表收敛):member 5 / member-profile 3 / emergency-contact 4 / certificate 6 / activity 5 / activity-registration 5 / attendance 8。权限码总数 81 → **117** | §4 逐码清单 |
| **D-S4-3** | contract snapshot diff 口径 = **summary 行 + `@ApiBizErrorResponse` 换码(FORBIDDEN→RBAC_FORBIDDEN)投影的 403 响应行**(description/enum/example),零路由/零字段/零 L3。不选"保留 FORBIDDEN 文档"方案——会让 OpenAPI 对实际抛 30100 的端点撒谎,违背既有 R 模式 81 端点全部如实标注的惯例(snapshot 现有 30100 出现 335 次) | `api-response.decorator.ts:49`"不让 snapshot 撒谎";P0-F 全部 R 模式先例 |
| **D-S4-4** | 既有 spec **权限边界区块**拒权断言改码 40300→30100(7 文件约 36 处,逐处列 PR 描述);业务行为断言(CRUD / 状态机 / audit / 响应字段)**零修改**。这是 DoD-5"断言零修改"的精确口径——拒权码变化是 goal DoD-4③ 既定语义本体,P0-F #134 对 organizations 等模块完全同款改法 | `git show 31b7e55`(P0-F 先例:`USER GET → 403` 改 `→ 30100 RBAC_FORBIDDEN`) |
| **D-S4-5** | service 方法补 `currentUser: CurrentUserPayload` 入参(members 全部 6 方法;registrations `list` 如缺则补),仅加参判权,不改业务逻辑 | members.service 现无 currentUser 入参(亲核) |
| **D-S4-6** | characterization 适配:src 内 4 个 service unit spec(activities / activity-registrations / attendances / certificates)构造函数注入 rbac mock(`can` 恒 `true`),断言零修改;service 直调型 e2e spec(state-transition / audit-characterization 等)用 fixture 给 DB 内 ADMIN 测试用户补挂 biz-admin | 这些 spec 绕过 Guard 直调 service,迁移后判权下沉至 service 必然命中 |
| **D-S4-7** | biz-admin 补挂范围 = `role=ADMIN && deletedAt=null`(含 DISABLED;禁用→重启用周期内无需重跑 seed 即保持零漂移;软删用户除外)。强校验 = 补挂后「无 biz-admin 的非软删 ADMIN 数 = 0」否则 throw。**运行时新建的 ADMIN 不自动持有**(seed 时机外),由运维走既有 `system/v1/users/:userId/roles` 端点授予——这正是 DoD-4③ 的设计空间 | 镜像 seed `seedRbac` ops-admin ≥1 强校验范式(`prisma/seed.ts:1289-1308`) |
| **D-S4-8** | `rbac.can()` 调用位置 = 每个 admin 方法**第一条语句**(先判权后查资源),保持"被拒者不可探测资源存在性"与今天 Guard 前置语义一致;沿 P0-F `assertCanOrThrow` 私有 helper 范式 | `contribution-rules.service.ts:57-61` |
| **D-S4-9** | 已知且接受的错误码**顺位**变化:无权限者携带非法 body/param 时,今天 Guard(403)先于 ValidationPipe(400);迁后 400 先于 30100(Nest Guard→Pipe→Service 固定顺序)。权限矩阵(谁能成功操作什么)零漂移;P0-F 迁移已同样接受。既有 spec 的拒权用例均用合法入参(抽查确认),如全量跑暴露组合断言,按 D-S4-4 口径处置并列 PR 描述 | Nest 执行顺序;P0-F 先例 |

## 2. 风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| ADMIN 在生产升级后瞬间失权(seed 未跑) | 高 | 部署 SOP 本就要求 migrate + seed;T1 先行合入(seed 先于 T2/T3 行为切换两个 release 阶段);幂等补挂保证存量 ADMIN 自动持有 biz-admin |
| 漏挂 e2e ADMIN 用户导致大面积 30100 红 | 中 | T2/T3 全量 e2e;按模块迁移,失败即该 spec 进补挂清单(§8 候选清单已预扫描) |
| characterization 断言被 rbac 拦截失真 | 中 | D-S4-6:unit 注入恒 true mock;e2e 直调型补挂真实角色;两者断言零修改 |
| snapshot 出现预期外 diff | 中 | DoD-6 终验逐行核对:仅 summary 行 + 403 响应行两类;出现第三类即停 |
| 孤码 WARN 误判 | 低 | T1→T2 过渡期 36 码为预期 WARN(`docs:rbacmap:check` F 项 WARN 不 FAIL,先例 `user.phone.clear`);T3 后清零 |
| RbacCache 滞后导致授权不即时 | 低 | 既有三档失效机制 + e2e fixture 内 `invalidateUser`;不加新机制(goal §4) |

## 3. 44 端点逐行映射表(主体;逐端点亲核 controller 现状)

> 列:HTTP 端点 | 旧 `@Roles` 形态 | 新权限码(或无码)| biz-admin 绑定。
> 全部 44 端点迁移后:controller 摘 `@Roles`,入口仅 JwtAuthGuard;除标注外判权下沉 service 第一条语句。

### 3.1 members(`admin/v1/members`,6 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 1 | GET `''`(列表) | SA,ADMIN | `member.read.record` | ✅ |
| 2 | POST `''` | SA,ADMIN | `member.create.record` | ✅ |
| 3 | GET `:id` | SA,ADMIN | `member.read.record` | ✅ |
| 4 | PATCH `:id` | SA,ADMIN | `member.update.record` | ✅ |
| 5 | PATCH `:id/status` | SA,ADMIN | `member.update.status` | ✅ |
| 6 | DELETE `:id` | **仅 SA** | `member.delete.record` | ❌(仅 SA 短路,D1=A 镜像) |

### 3.2 member-profiles(`admin/v1/members/:memberId/profile`,3 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 7 | GET | SA,ADMIN | `member-profile.read.record` | ✅ |
| 8 | POST | SA,ADMIN | `member-profile.create.record` | ✅ |
| 9 | PATCH | SA,ADMIN | `member-profile.update.record` | ✅ |

### 3.3 emergency-contacts(`admin/v1/members/:memberId/emergency-contacts`,4 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 10 | GET | SA,ADMIN | `emergency-contact.read.record` | ✅ |
| 11 | POST | SA,ADMIN | `emergency-contact.create.record` | ✅ |
| 12 | PATCH `:id` | SA,ADMIN | `emergency-contact.update.record` | ✅ |
| 13 | DELETE `:id` | SA,ADMIN | `emergency-contact.delete.record` | ✅ |

### 3.4 certificates(`admin/v1/members/:memberId/certificates`,8 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 14 | GET `''` | SA,ADMIN | `certificate.read.record` | ✅ |
| 15 | POST `''` | SA,ADMIN | `certificate.create.record` | ✅ |
| 16 | GET `qualification-flag` | SA,ADMIN | `certificate.read.record`(共用 read) | ✅ |
| 17 | GET `:id` | SA,ADMIN | `certificate.read.record` | ✅ |
| 18 | PATCH `:id` | SA,ADMIN | `certificate.update.record` | ✅ |
| 19 | DELETE `:id` | SA,ADMIN | `certificate.delete.record` | ✅ |
| 20 | PATCH `:id/verify` | SA,ADMIN | `certificate.verify.record` | ✅ |
| 21 | PATCH `:id/reject` | SA,ADMIN | `certificate.reject.record` | ✅ |

### 3.5 activities(`admin/v1/activities`,7 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 22 | GET `''`(列表) | SA,ADMIN,**USER** | **无码,`[auth]`**(service 内 Q-A7 USER 过滤原样保留) | — |
| 23 | POST `''` | SA,ADMIN | `activity.create.record` | ✅ |
| 24 | GET `:id`(详情) | SA,ADMIN,**USER** | **无码,`[auth]`**(Q-A7 同上) | — |
| 25 | PATCH `:id` | SA,ADMIN | `activity.update.record` | ✅ |
| 26 | DELETE `:id` | SA,ADMIN | `activity.delete.record` | ✅ |
| 27 | PATCH `:id/publish` | SA,ADMIN | `activity.publish.record` | ✅ |
| 28 | PATCH `:id/cancel` | SA,ADMIN | `activity.cancel.record` | ✅ |

### 3.6 activity-registrations(`admin/v1/activities/:activityId/registrations`,6 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 29 | GET `''` | SA,ADMIN | `activity-registration.read.record` | ✅ |
| 30 | POST `''`(代报名) | SA,ADMIN | `activity-registration.create.record` | ✅ |
| 31 | GET `export`(CSV) | SA,ADMIN | `activity-registration.read.record`(共用 read) | ✅ |
| 32 | PATCH `:id/approve` | SA,ADMIN | `activity-registration.approve.record` | ✅ |
| 33 | PATCH `:id/reject` | SA,ADMIN | `activity-registration.reject.record` | ✅ |
| 34 | PATCH `:id/cancel` | SA,ADMIN | `activity-registration.cancel.record` | ✅ |

### 3.7 attendances(2 个 Admin class,10 端点)

| # | 端点 | 旧 @Roles | 新权限码 | biz-admin |
|---|---|---|---|---|
| 35 | POST `admin/v1/activities/:activityId/attendance-sheets` | SA,ADMIN | `attendance.create.sheet` | ✅ |
| 36 | GET `admin/v1/activities/:activityId/attendance-sheets` | SA,ADMIN | `attendance.read.sheet` | ✅ |
| 37 | GET `admin/v1/attendance-sheets/:id/review-detail` | SA,ADMIN | `attendance.read.sheet`(共用 read) | ✅ |
| 38 | GET `admin/v1/attendance-sheets/:id` | SA,ADMIN | `attendance.read.sheet` | ✅ |
| 39 | PATCH `admin/v1/attendance-sheets/:id` | SA,ADMIN | `attendance.update.sheet` | ✅ |
| 40 | DELETE `admin/v1/attendance-sheets/:id` | SA,ADMIN | `attendance.delete.sheet` | ✅ |
| 41 | PATCH `:id/approve` | SA,ADMIN | `attendance.approve.sheet` | ✅ |
| 42 | PATCH `:id/reject` | SA,ADMIN | `attendance.reject.sheet` | ✅ |
| 43 | PATCH `:id/final-approve`(终审通过) | SA,ADMIN | `attendance.final-approve.sheet` | ✅ |
| 44 | PATCH `:id/final-reject`(终审驳回) | SA,ADMIN | `attendance.final-reject.sheet` | ✅ |

## 4. 权限码清单(36 枚;全部符合 D7 v1.2 正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`)

命名沿既有域风格(`user.read.account` / `org.read.node` / `contribution.read.rule` 三段式;module=第 1 段,action=第 2 段,resourceType=第 3 段;list/detail 共用 read 沿 PR-4B D4=A 判例):

| 域(module) | 条数 | 码 |
|---|---|---|
| member | 5 | `member.{read,create,update,delete}.record` / `member.update.status` |
| member-profile | 3 | `member-profile.{read,create,update}.record` |
| emergency-contact | 4 | `emergency-contact.{read,create,update,delete}.record` |
| certificate | 6 | `certificate.{read,create,update,delete}.record` / `certificate.{verify,reject}.record` |
| activity | 5 | `activity.{create,update,delete}.record` / `activity.{publish,cancel}.record` |
| activity-registration | 5 | `activity-registration.{read,create}.record` / `activity-registration.{approve,reject,cancel}.record` |
| attendance | 8 | `attendance.{create,read,update,delete}.sheet` / `attendance.{approve,reject}.sheet` / `attendance.{final-approve,final-reject}.sheet` |

权限码总数对账:**81 → 117**(+36);`docs:rbacmap:check` B 项计数随 T1 同步 true-up。

## 5. seed 设计(T1;纯 seed 无 schema,D 档)

1. **36 码 upsert**:7 个 `*_PERMISSION_SEED` 常量数组(沿 `code: '<literal>'` 形态,保证检查脚本 A 项可提取),`update: {}` 幂等不覆盖运营调整;
2. **`biz-admin` RbacRole upsert**:code=`biz-admin`,displayName=`业务管理员`,description 注明 Slow-3 决议承载 + 36 码绑 35;
3. **RolePermission 绑定 35 条**:36 码过滤 `member.delete.record`(常量 `MEMBER_DELETE_RECORD_CODE`,镜像 `PR_3B_USER_UPDATE_ROLE_CODE` 过滤范式);
4. **幂等补挂**:`role=ADMIN && deletedAt=null` 的全部用户逐个 `userRole.upsert`(复合唯一键 `userId_roleId`);
5. **强校验**:补挂后查询「非软删 ADMIN 且未持 biz-admin」计数,非 0 即 throw 退出(镜像 ops-admin ≥1 强校验);
6. **零变化项**:ops-admin 绑定(58)/ member 绑定(9)/ 既有 81 码,一行不动;
7. **验收**:seed 幂等二跑(两次后 Permission/RolePermission/UserRole 计数与 id 稳定)+ 新增 seed e2e spec(镜像 `seed-attachment-permissions.e2e-spec.ts` 8 项结构)+ `docs:rbacmap:check` 0 FAIL(36 孤码 WARN 属 T1→T3 过渡预期)。

## 6. 不绑清单与零变化项(终版报告必列)

| 项 | 处置 | 理由 |
|---|---|---|
| `member.delete.record` | 进 Permission 表,**不绑 biz-admin** | members DELETE 今天仅 SA(`@Roles(Role.SUPER_ADMIN)`);D1=A 判例(`user.update.role` 仅 SA 短路)镜像;绑了 = 放宽,违零漂移 |
| attachment 存量 20 码 | **不绑 biz-admin,一字不动** | attachments 已是 R 模式:今天未持 RBAC 角色的 ADMIN 调 attachments 得 30100;若 biz-admin 绑入 attachment.* 则 ADMIN 凭空获权 = 放宽漂移 |
| ops-admin 绑定(58 条) | 零变化 | goal §2 禁止域 |
| member 角色绑定(9 条) | 零变化 | goal §2 禁止域 |
| `rbac.*` / 配置面 / users / audit-log 等既有 81 码 | 不进 biz-admin | Slow-3 决议只覆盖"业务权限";管理面/配置面归 ops-admin 轨道,互不交叉 |

## 7. 零行为漂移验收方案(DoD-4 五类 → e2e 锁定)

| # | 场景 | 迁移前 | 迁移后 | 锁定方式 |
|---|---|---|---|---|
| ① | SA 调 44 端点 | 全通(RolesGuard 含 SA) | 全通(`judge()` SA 短路) | 既有 spec 主路径全部以 SA/补挂 ADMIN 跑,断言零修改全绿 |
| ② | 持 biz-admin 的 ADMIN | 全通(@Roles 含 ADMIN;DELETE 除外) | 全通(绑定 35 码;DELETE 除外) | 既有 spec ADMIN 用例补挂后断言零修改全绿 + 新权限边界 spec 正向断言 |
| ③ | **未持 biz-admin 的 ADMIN** | 通(@Roles 含 ADMIN) | **拒 30100** | 新权限边界 spec 反向断言(沿 organizations `adminDefaultAuth` 范式)。注:这是 Slow-3 决议的本体——"ADMIN 身份"与"业务权限"解耦,存量 ADMIN 由 seed 补挂保证不失权 |
| ④ | 裸 USER | activities 列表+详情可读;其余 40300 | 同 2 端点可读;其余 **30100** | 既有 spec 拒权断言按 D-S4-4 改码;activities USER 用例断言零修改(Q-A7 行为不动) |
| ⑤ | members DELETE | ADMIN 40300 拒 / SA 通 | ADMIN(含持 biz-admin)**30100** 拒 / SA 通 | 新权限边界 spec 显式双断言(持 biz-admin 的 ADMIN 仍拒) |

> ③④⑤ 的拒权码 40300→30100 是 goal DoD-4③"RBAC 拒权码,沿 attachments/users 先例"的既定语义,**不是**矩阵漂移;allow/deny 矩阵零变化(③ 是 Slow-3 决议显式新增的拒绝面)。

## 8. e2e / fixture 适配方案(改动文件逐一列入各 PR 描述)

1. **新建 `test/fixtures/biz-admin.fixture.ts`**(镜像 `rbac.fixture.ts`):`seedBizAdminPermissionsAndRole(app)`(36 码 + biz-admin + 35 绑定,幂等)/ `grantBizAdminToUser(app, userId, bizAdminRoleId)`(upsert + `invalidateUser`)/ `revokeBizAdminFromUser`(对称);
2. **既有 spec ADMIN 用户补挂**(beforeAll 内 seed + grant;候选清单按预扫描,以全量 e2e 实跑为准):HTTP 驱动型 members / member-profiles / emergency-contacts / certificates / activities / activity-registrations / attendances / member-departments / audit-logs-migrations / app-activities-available / app-activities-detail / app-my-attendance-records / app-my-certificates / app-my-registrations-*;service 直调型 activities-{state-transition,audit-characterization} / activity-registrations-{state-transition,audit-characterization} / attendances-{state-transition,reject-transition,audit-characterization,contribution-prefill,status-guards,time-overlap};
3. **拒权断言改码**(D-S4-4,~36 处/7 文件):members(3)/ member-profiles(3)/ emergency-contacts(4)/ certificates(8)/ activities(5)/ activity-registrations(5)/ attendances(8);
4. **src 内 4 个 service unit spec**:构造函数注入 rbac mock(`can` 恒 true),断言零修改;
5. **每模块新增权限边界 spec**(7 个模块,DoD-4 ①-⑤ 场景矩阵;members 模块含 ⑤ DELETE 双断言);
6. contract:`pnpm test:contract` + snapshot 显式更新,diff 逐行核对仅 D-S4-3 两类。

## 9. 任务队列与探针(goal §3 原文固化;顺序硬约束)

| 队列 | 档位 | 内容 | 探针 |
|---|---|---|---|
| T0 | A | 本评审稿冻结 + NEXT_TASKS P1-3 标进行中 | 评审稿在 main |
| T1 | D | seed PR(§5 全部;PR 描述贴码清单 + 绑定矩阵 + 幂等二跑记录) | seed 在 main + rbacmap 0 FAIL |
| T2 | C/D | member 族 4 模块(members / member-profiles / emergency-contacts / certificates) | 4 模块活跃 @Roles=0 + DoD-4 对应断言绿 |
| T3 | C/D | participation 3 模块(activities / activity-registrations / attendances×2 class)+ 2 端点无码化 | 全仓活跃 @Roles=0 + DoD-4 全部断言绿 |
| T4 | A | docs 收尾(AGENTS §8 校准 / current-state §3§4 / NEXT_TASKS ✅ / RBAC_MAP 大 true-up / participation §4 注记 / CHANGELOG)+ 8 条探针终验 + 终版报告 | DoD 8 条全真 |

## 10. 本期不做(终版报告必列)

- ❌ 不收紧也不放宽任何权限语义(allow/deny 矩阵零漂移是验收线);
- ❌ attachment 存量 20 码不绑 biz-admin(§6 零漂移理由);
- ❌ 部门级细分(部长/终审 finalReviewer 细粒度)仍挂 Slow-3 子议题,不实现、不新增码、不补部门级 e2e;
- ❌ ops-admin / member 绑定零变化;不动 App surface / `@Public` / AGENTS:242(v1 登录契约);
- ❌ 不新增 BizCode;不动 `RbacService` 判权逻辑 / `RbacCacheService` 失效机制;
- ❌ 不给运行时新建 ADMIN 自动挂 biz-admin(seed 时机外走既有 user-roles 端点);
- ❌ 不删 `RolesGuard` / `@Roles` 装饰器机制本身(Guard 链保留,仅业务面使用点清零)。
