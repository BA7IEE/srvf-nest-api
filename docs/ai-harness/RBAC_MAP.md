# RBAC_MAP — 权限体系地图与对照表

> **性质**:derived 地图,非规则源。权限**事实**权威源:权限码与绑定 → [`prisma/seed.ts`](../../prisma/seed.ts);判权实现 → [`src/modules/permissions/rbac.service.ts`](../../src/modules/permissions/rbac.service.ts);铁律 → [`AGENTS.md §8 / §13`](../../AGENTS.md)。
> 数据快照:2026-06-11,**Slow-4 权限双轨收口完成**(goal #314-#317,冻结评审稿 [`slow4-rbac-business-face-review.md`](../archive/reviews/slow4-rbac-business-face-review.md)):117 码 / 内置角色 ×3 / **全仓活跃 `@Roles` = 0**(原 G 模式 44 处全摘;RolesGuard 机制保留 Guard 链);`docs:rbacmap:check` 0 FAIL / 0 WARN(seed↔代码双向对齐)。**任何权限事实的变更本身是 D 档**(评审稿 + 用户拍板),本文件只能事后 true-up。

---

## 1. 双轨架构现状(一句话版)

三层 `Role` enum(SUPER_ADMIN > ADMIN > USER,Guard 链全局注册:`ThrottlerBizGuard → JwtAuthGuard → RolesGuard`)是**身份层**;判权**单轨**走 RBAC 4 表(`RbacRole` / `Permission` / `RolePermission` / `UserRole`,Service 层 `rbac.can()`):

- **管理面 / 配置面 / System surface:已收紧**(v0.15.0 P0-F)——controller 不标 `@Roles`,入口仅要求登录,每个写读路径在 Service 层 `rbac.can('<code>')` 判权,SUPER_ADMIN 短路通过。
- **业务面:已收口**(2026-06-11 Slow-4,goal #314-#317)——原 G 模式 7 模块 44 端点全部摘 `@Roles`:42 端点 Service 层判权(`biz-admin` 承载 ADMIN 业务权限,Slow-3 决议;`member.delete.record` 仅 SA 短路),activities 列表/详情 2 端点无码仅登录(`[auth]`,Q-A7 过滤留 service)。**全仓活跃 `@Roles` = 0**;`RolesGuard` 机制与装饰器保留 Guard 链(防御性兜底),新 endpoint 不再标 `@Roles`。
- **App surface:不走 RBAC**——仅 JwtAuthGuard + Service 层 `where: { memberId: currentUser.memberId }` self-scope + 准入语义(`memberId != null && User.ACTIVE && Member.ACTIVE`);capabilities 返回产品级能力而非 raw permission code(D-5.3)。
- **没有 `@Permissions` 装饰器 / PermissionsGuard**(已核实不存在)。判权唯一服务入口 = `RbacService.can()`;`RbacCacheService` 是权限解析缓存(TTL 1800s,三档失效),不是身份缓存。

## 2. controller × 鉴权模式对照(34 个 controller class)

### 2.1 R 模式 — Service 层 `rbac.can()`(管理面,已收紧)

| controller(路径前缀) | 权限码域 |
|---|---|
| `system/v1/permissions` | `rbac.permission.*`(4) |
| `system/v1/roles` | `rbac.role.*`(4) |
| `system/v1/roles/:id/permissions` | `rbac.role-permission.*`(2) |
| `system/v1/users/:userId/roles` | `rbac.user-role.*`(3) |
| `system/v1/rbac`(reload) | `rbac.config.reload`(1);`GET me/permissions` 仅登录(方法级 Mixed 存量) |
| `admin/v1/users` | `user.*`(8;其中 `user.update.role` 不绑 ops-admin,仅 SA 短路 = D1=A 拍板;`user.phone.clear` 为 SMS T3 清号端点)|
| `system/v1/audit-logs` | `audit-log.read.entry`(1) |
| `system/v1/dict-types` + `dict-items` | `dict.*.type` / `dict.*.item`(8) |
| `admin/v1/organizations` | `org.*.node`(4) |
| `admin/v1/members/:id/department` | `member-department.*.current`(3) |
| `system/v1/contribution-rules` | `contribution.*.rule`(4) |
| `system/v1/attachment-{type,mime,size-limit}-configs` | `attachment-config.*`(12) |
| `system/v1/storage-settings` | `storage-setting.*`(3;`reset.credentials` 不绑 ops-admin = D2=A 拍板) |
| `system/v1/sms-settings` | `sms-setting.*`(3;`reset.credentials` 不绑 ops-admin,镜像 D2=A;SMS T2)|
| `system/v1/sms-send-logs` | `sms-send-log.read.list`(1;响应手机号一律掩码;SMS T2)|
| `admin/v1/attachments`(业务面首批) | `attachment.*`(20:member/certificate 各 8 含 `.self`/`.other`,activity 4) |
| `admin/v1/members`(Slow-4 T2) | `member.*`(5;DELETE = `member.delete.record` 仅 SA 短路不绑 biz-admin) |
| `admin/v1/members/:memberId/profile`(Slow-4 T2) | `member-profile.*.record`(3) |
| `admin/v1/members/:memberId/emergency-contacts`(Slow-4 T2) | `emergency-contact.*.record`(4) |
| `admin/v1/members/:memberId/certificates`(Slow-4 T2) | `certificate.*.record`(6;list/detail/qualification-flag 共用 read) |
| `admin/v1/activities`(Slow-4 T3) | `activity.*.record`(5,仅 5 个写端点;**列表/详情无码仅登录 `[auth]`**) |
| `admin/v1/activities/:activityId/registrations`(Slow-4 T3) | `activity-registration.*.record`(5;list/export 共用 read) |
| `admin/v1/…attendance-sheets`(2 个 Admin class;Slow-4 T3) | `attendance.*.sheet`(8;list/detail/review-detail 共用 read;终审两码独立,ADMIN 级沿 P1-5 方案 A) |

### 2.2 G 模式 — Guard `@Roles`(已清零)

**2026-06-11 Slow-4 T2/T3(#316/#317)后不存在 G 模式 controller**:原 7 模块 44 处 `@Roles`(历史计数"48 处"系本表笔误,亲核 true-up 见评审稿 D-S4-1)全部迁入上方 R 模式或无码化;迁移前逐端点形态冻结于评审稿 §3 映射表。

### 2.3 A 模式 — App surface(17 endpoint,JwtAuthGuard + self-scope;SMS T3 +me/phone 两端点沿 me/password 账号级豁免)

`app/v1/me`(5)/ `app/v1/activities`(2)/ `app/v1/my`×3 class(registrations 5 + attendance-records 1 + certificates 1)+ `app/v1/me/password`(继承 P0-D/P0-E 全套铁律)。**永不返回 L3 字段**(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)。

### 2.4 P 模式 — `@Public`

`auth/v1`:login / refresh / logout(logout-all 走 JWT);`system/v1/health`:live / ready。

## 3. 权限码全集(117 条,seed 幂等 upsert)

| 域 | 条数 | 码 |
|---|---|---|
| rbac meta | 14 | `rbac.permission.{read,create,update,delete}` / `rbac.role.{read,create,update,delete}` / `rbac.role-permission.{create,delete}` / `rbac.user-role.{read,create,delete}` / `rbac.config.reload` |
| 字典 | 8 | `dict.{read,create,update,delete}.{type,item}` |
| 组织 | 4 | `org.{read,create,update,delete}.node` |
| 队员部门 | 3 | `member-department.{read,set,clear}.current` |
| 贡献规则 | 4 | `contribution.{read,create,update,delete}.rule` |
| 附件配置 | 12 | `attachment-config.{read,create,update,delete}.{type,mime,size-limit}` |
| 存储设置 | 3 | `storage-setting.{read,update}.singleton` / `storage-setting.reset.credentials` |
| 短信设置 | 3 | `sms-setting.{read,update}.singleton` / `sms-setting.reset.credentials`(SMS T2,评审稿 §3.4)|
| 短信日志 | 1 | `sms-send-log.read.list`(SMS T2)|
| 用户管理 | 8 | `user.{read,create,update,delete}.account` / `user.reset.password` / `user.update.role` / `user.update.status` / `user.phone.clear`(SMS T2 seed,T3 端点已实装)|
| 审计 | 1 | `audit-log.read.entry` |
| 附件业务 | 20 | `attachment.{upload,view,update,delete}.member.{self,other}`(8)/ `…certificate.{self,other}`(8)/ `…activity`(4) |
| 队员(Slow-4 T1) | 5 | `member.{read,create,update,delete}.record` / `member.update.status` |
| 队员扩展档案(Slow-4 T1) | 3 | `member-profile.{read,create,update}.record` |
| 紧急联系人(Slow-4 T1) | 4 | `emergency-contact.{read,create,update,delete}.record` |
| 证书(Slow-4 T1) | 6 | `certificate.{read,create,update,delete}.record` / `certificate.{verify,reject}.record` |
| 活动(Slow-4 T1) | 5 | `activity.{create,update,delete}.record` / `activity.{publish,cancel}.record`(列表/详情无码,仅登录) |
| 活动报名(Slow-4 T1) | 5 | `activity-registration.{read,create}.record` / `activity-registration.{approve,reject,cancel}.record` |
| 考勤(Slow-4 T1) | 8 | `attendance.{create,read,update,delete}.sheet` / `attendance.{approve,reject,final-approve,final-reject}.sheet` |

内置角色:`ops-admin`(绑 58 条:全集过滤 `user.update.role` + `storage-setting.reset.credentials` + `sms-setting.reset.credentials`,三者仅 SUPER_ADMIN 短路可用——**这是已拍板设计 D1=A / D2=A 及 SMS 镜像 E-3,不是缺口**)+ `member`(占位,绑 9 条 attachment self 权限)+ **`biz-admin`(Slow-4,绑 35 条 = 36 业务面码过滤 `member.delete.record`〔仅 SA 短路,D1=A 镜像〕;attachment 存量 20 码不绑〔零漂移〕;seed 幂等补挂「每个非软删 ADMIN 持有 biz-admin」+ 强校验;运行时新建 ADMIN 走既有 user-roles 端点显式授予)**。seed 与代码调用**双向对齐**:无"seed 有码未用",无"代码用码未 seed"(`docs:rbacmap:check` 0 FAIL / 0 WARN)。

## 4. 保护不变式(改 users / permissions 前必读)

| 不变式 | 实现位置 | 铁律 |
|---|---|---|
| 自我保护 | `users.service.ts` `assertCanManageUser`(删/禁/改角色拒绝 self) | AGENTS §13 |
| 最后一个活跃 SUPER_ADMIN ≥ 1 | 同上,**事务内计数 + 更新** | AGENTS §12/§13;**禁止** AI 增加"SA 互不可操作"校验 |
| 最后一个 ops-admin 持有者 ≥ 1 | `user-roles.service.ts` revoke 路径 | seed bootstrap 强校验呼应 |
| ADMIN 只能管 USER | `assertCanManageUser` 统一入口;**禁止** service 内散落 `role ===` 比较(已核实 0 处) | AGENTS §13 |
| 身份有效性不缓存 | `JwtStrategy.validate` 每请求查库(`deletedAt + status`) | AGENTS §8;RbacCache 是唯一例外(权限解析缓存) |
| 防账号枚举 | 登录四场景统一 10004 + dummy bcrypt timing 防御 | AGENTS §8 |
| Guard 全局注册 | `app.module.ts` APP_GUARD ×3,顺序固定;**全仓 0 处 `@UseGuards`**(已核实) | AGENTS §8 |

## 5. 缺口与冻结存量(AI 不得"顺手修")

| 项 | 状态 | 谁拍板 |
|---|---|---|
| 7 个业务模块接入 `rbac.can()`(Slow-4) | ✅ 已完成(2026-06-11 goal #314-#317;Slow-3 决议 = `biz-admin` 承载全量业务权限) | 已决 |
| `rbac.controller.ts` `GET me/permissions` 方法级 Mixed | 存量冻结(P1-A 不拆),返回 raw code 仅限该 system 端点;App 端能力走 `me/capabilities` | 用户 |
| `dictionaries.controller.ts` 同文件双 controller | 非 surface Mixed,存量冻结不扩展 | 用户 |
| Swagger 不体现权限码要求 | ✅ 已闭环(2026-06-10 P2-2 #287):全部 148 endpoint summary 统一鉴权后缀(`[rbac:]`/`[roles:]`/`[public]`/`[auth]`),`docs:rbacmap:check` 检查项 G(#288)锁后缀↔装饰器/seed 一致性 | 已决;后缀惯例变更走 A/B 档 + 检查项 G 同步 |
| 部门级权限(部长/终审 finalReviewer 细粒度) | ✅ 已拍板(2026-06-10 方案 A):维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录;细分挂 Slow-3 子议题,未立项不实现(详 [`participation-bounded-context.md §4`](../participation-bounded-context.md)) | 已决;重开走 Slow-3 |

## 6. AI 硬规则(权限相关)

1. 改 `Role` enum / `Permission` seed / `RolePermission` 绑定 / Guard / `JwtStrategy` / throttler → **必然 D 档**:只读调研 → 风险表 → 方案 A/B → 用户拍板 → 评审稿冻结 → 再实施([`process.md §4`](../process.md))。
2. Slow-4 已完成(G 模式清零);**禁止**自行新增权限码 / 调整角色绑定 / 给端点重新挂 `@Roles`(均为 D 档,沿规则 1)。
3. **禁止**绕过 / 弱化:`assertCanManageUser`、最后 SA/ops-admin 保护、防枚举四场景一致性、`@Public` 与 `@Roles` 互斥。
4. 新管理面 endpoint 默认模式 = R 模式(沿既有模块范式);新 App endpoint 默认 self-scope,**禁止**用 `role` 短路 scope。
5. 错误码:权限拒绝只允许既有 `UNAUTHORIZED(40100)` / `FORBIDDEN(40300)` / RBAC 拒绝码(30100 段)/ 业务护栏码;**禁止**自创 token 类 100xx 码(AGENTS §5)。
6. 本文件对照表与代码不一致时:以代码为准,**先报告再 true-up**,不得据本表"纠正"代码。

## 7. 漂移检查与重新生成口径

**首选自动检查**(NEXT_TASKS P1-1 已落地;0 FAIL 才算本表与事实一致):

```bash
pnpm docs:rbacmap:check   # seed 码↔本表计数 / controller 数↔本表 / 4 canonical 前缀 / 直调码必在 seed / 孤码 WARN / summary 鉴权后缀一致(P2-2)
```

手工重新生成口径(true-up 改表时用):

```bash
# 权限码全集(seed)
grep -oE "code: '[a-z][a-z-]*\.[a-z.-]+'" prisma/seed.ts | sort -u   # + 常量声明 PR_3B_USER_UPDATE_ROLE_CODE
# controller 前缀清单
grep -rE "^@Controller\(" src --include="*.ts" -h | sort | uniq -c
# 模块鉴权模式
grep -rl "this\.rbac" src/modules --include="*.service.ts"
grep -rc "@Roles(" src/modules/<module> --include="*.controller.ts"
```
