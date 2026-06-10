# MODULE_MAP — 模块依赖 / 鉴权模式 / 测试对照

> **性质**:derived 地图,非规则源。模块职责 / 体量 / 本地铁律以根 [`CODEMAP.md`](../../CODEMAP.md) 为权威;本文件补**跨模块依赖、鉴权模式、e2e spec 对照、AI 改造分区**四列。
> 数据快照:2026-06-10,HEAD `ccd8817`(post-P2-2 #287 + 检查项 G #288;模块结构零变化,e2e spec 名抽查与磁盘一致)。与代码冲突时以 `src/**` 为准并回头修本表。

---

## 1. 模块总表(19 个业务模块 + common/storage)

鉴权模式:**R** = Service 层 `rbac.can()`(管理面收紧完成)/ **G** = Guard `@Roles(...)` 双轨(Slow-4 待业务拍板)/ **A** = App surface(JwtAuthGuard + `memberId` self-scope)/ **P** = `@Public`。
风险级:🔴 红区(非授权不动)/ 🟡 谨慎 / 🟢 常规。

| 模块 | HTTP 前缀 | 鉴权 | 依赖(imports) | 主要 e2e spec | 风险 | 备注 |
|---|---|---|---|---|---|---|
| `auth/` | `auth/v1` | P+JWT | Database, AuditLogs | auth-login / auth-jwt-guard / auth-refresh / auth-logout / auth-logout-all / auth-*-throttle | 🔴 | P0-E 行为冻结(AGENTS §9);不引入 LocalStrategy |
| `users/` | `admin/v1/users` + `app/v1/me` | R + A | Database, AuditLogs, Permissions | users-admin-* / users-role-boundary / users-self-protection / users-last-super-admin / users-soft-delete / users-password-reset / app-me / app-me-password | 🔴 | assertCanManageUser / 最后 SUPER_ADMIN 保护;exports AppIdentityResolver |
| `permissions/` | `system/v1/permissions·roles·rbac` 等 | R | Database | permissions / rbac-roles / role-permissions / user-roles / rbac-me-permissions / rbac-reload / seed-rbac | 🔴 | RBAC 4 表 + RbacService.can() + RbacCacheService;`me/permissions` 方法级 Mixed 存量(P1-A 不拆) |
| `audit-logs/` | `system/v1/audit-logs` | R | Database, Permissions | audit-logs / audit-logs-migrations | 🔴 | A-1 红线:写入即不可改不可删 |
| `members/` | `admin/v1/members` | G | Database | members | 🟡 | `memberNo` 全局唯一不复用(编号铁律,改 = 人工确认) |
| `member-profiles/` | `admin/v1/members/:id/profile` | G | Database | member-profiles | 🟡 | 1:1 子资源;敏感字段(证件号掩码后 4 位);dto 已拆 `dto/` 4 文件(AGENTS §2 >300L 例外) |
| `emergency-contacts/` | `admin/v1/members/:id/emergency-contacts` | G | Database, AuditLogs | emergency-contacts | 🟢 | N:1 子资源 |
| `member-departments/` | `admin/v1/members/:id/department` | R | Database | member-departments | 🟢 | 一人一部门 partial unique |
| `organizations/` | `admin/v1/organizations` | R | Database, Permissions | organizations | 🟡 | 单树:队→部门→小组;parentId 自引 Restrict |
| `dictionaries/` | `system/v1/dict-types·dict-items` | R | Database, Permissions | dictionaries | 🟡 | 双表父子树;同文件双 controller(非 surface Mixed,存量冻结) |
| `certificates/` | `admin/v1/members/:id/certificates` + `app/v1/my` | G + A | Database, AuditLogs, Users | certificates / app-my-certificates | 🟡 | 4 态闭集 + verify/reject;**不属** participation 上下文 |
| `activities/` | `admin/v1/activities` + `app/v1/activities` | G + A | Database, AuditLogs, Users | activities / activities-state-transition / activities-audit-characterization / app-activities-* | 🟡 | 4 态状态机已抽离;participation 核心 |
| `activity-registrations/` | `admin/v1/activities/:id/registrations` + `app/v1/my` | G + A | Database, AuditLogs, Users, **Activities** | activity-registrations / *-state-transition / *-audit-characterization / app-my-registrations-* | 🟡 | partial unique + CSV export;service 750L ⚠G |
| `attendances/` | `admin/v1/…attendance-sheets` + `app/v1/my` | G + A | Database, AuditLogs, Users | attendances / *-state-transition / *-reject-transition / *-status-guards / *-time-overlap / *-contribution-prefill / *-audit-characterization / app-my-attendance-records | 🟡 | 5 态(含终审);service 1100L ⚠G(P1-4 收口,体量观察);state-machine / audit-recorder / time-overlap-policy / contribution-calculator / presenter(#280)已抽离 |
| `contribution-rules/` | `system/v1/contribution-rules` | R | Database, AuditLogs, Permissions | contribution-rules | 🟡 | D14 预填规则;归 System surface(D-1 决策锁) |
| `attachments/` | `admin/v1/attachments` | R(20 条 attachment.*) | Database, Permissions, AuditLogs, **Storage** | attachments / attachments.upload / attachments.audit / *-audit-characterization / seed-attachment-permissions | 🟡 | 业务面 rbac.can() 首批;service 827L ⚠G;key 永不返回完整 signed URL |
| `attachment-configs/` | `system/v1/attachment-*-configs` | R | Database, AuditLogs, Permissions | attachment-type-configs / attachment-mime-configs / attachment-size-limit-configs / attachment-configs.audit / attachment-configs.in-use | 🟡 | 三表 override-with-default;**不合表不抽 facade**([`attachment-config-boundary.md`](../attachment-config-boundary.md)) |
| `health/` | `system/v1/health` | P | Database(直连 ping) | health / health-live / health-ready | 🟢 | 结构例外:无 service |
| `ai/` | — | — | — | — | 🟢 | README 占位;**本期不实现**(AGENTS §1 C 档) |
| `common/storage/` | `system/v1/storage-settings` | R | Database, Permissions | storage-settings | 🔴 | AES-256-GCM 凭证加密;P3 债务:超出 common 语义,长期可迁 modules/,本期不动 |

横切 e2e(不属单一模块):response-format / request-id / bizcode-http-status / swagger / seed。

## 2. 依赖枢纽(改动影响面判断)

```text
被依赖方向(←)                         扇入
DatabaseModule        ← 全部业务模块     19
AuditLogsModule       ← auth users emergency-contacts certificates activities
                        activity-registrations attendances contribution-rules
                        attachment-configs attachments                  ~10
PermissionsModule(RbacService) ← users dictionaries organizations
                        member-departments contribution-rules audit-logs
                        attachment-configs attachments common/storage    9
UsersModule(AppIdentityResolver) ← activities activity-registrations
                        attendances certificates                          4
ActivitiesModule      ← activity-registrations                            1
StorageModule         ← attachments                                       1
```

**判读规则**:
- 改 `PermissionsModule` / `AuditLogsModule` / `common/` 任何导出物 = 跨 9-10 个模块的影响面,**先列引用链再动手**(AGENTS §0 符号确认铁律),并按 D 档降速。
- 业务模块之间唯一的横向依赖是 `activity-registrations → activities` 与 4 个模块对 `AppIdentityResolver` 的注入;**无循环依赖**。
- participation 上下文(activities / activity-registrations / attendances / contribution-rules)有跨模块状态链条,改状态机前必读 [`participation-bounded-context.md`](../participation-bounded-context.md)。

## 3. AI 改造分区

**适合 AI 分批独立改造(常规 B/C 档)**:
- 各业务模块的 DTO 校验补强 / Swagger 注解 / service 内局部逻辑(不动签名链)
- 测试补强(unit characterization / e2e 异常路径)——零生产代码风险
- docs / 地图 true-up(A 档)

**不建议 AI 随意修改(触碰即降速 / 暂停)**:
- `auth/`(P0-E 冻结)、`permissions/`(RBAC 核心)、`audit-logs/`(A-1 红线)、`common/storage/`(凭证)
- 3 个 god-service 的**拆分**(attendances 1100L / attachments 827L / activity-registrations 750L):**P1-4 系列已于 2026-06-10 调研收口**(attendances 第一刀 presenter #280 落地后,三模块均判定已达 [`architecture-boundary.md`](../architecture-boundary.md) 合理形态,详 [`current-state.md §4`](../current-state.md) P2 行 + [`NEXT_TASKS.md`](./NEXT_TASKS.md) 归档区);重开需 §6 新触发条件并单独立项
- 7 个 G 模式模块**自行加 rbac.can()**(那是 Slow-4,等业务拍板 Slow-3,见 [`RBAC_MAP.md §5`](./RBAC_MAP.md))
- `members.memberNo` 编号规则、组织树形态(单树三层)——业务模型级,人工确认
