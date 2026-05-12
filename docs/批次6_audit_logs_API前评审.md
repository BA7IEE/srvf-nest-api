# 《批次6_audit_logs_API前评审稿》(D6 v1.1 冻结版)

> **状态**:D6 v1.1 冻结版,已经业务确认 + 用户评审通过(2026-05-12),**本文件为最终归档版**
> **修订日志(v1.0 → v1.1)**:仅修正文档表述,**业务范围与技术决策完全不变**
> 1. §16 决议表数量:**30 项 → 25 项**(B1-B5 共 5 + D1-D10 共 10 + F1-F10 共 10)
> 2. AuditLog model 字段描述:**"8 字段" → "9 个业务字段 + 1 个 User relation"**
> 3. AuditContext 字段描述:**"5 字段" → "6 字段:3 必填 + 3 可选"**
> 4. audit-logs 模块文件数:**"模块 5 文件" → "模块 6 文件"**(主体 4 + select.ts + types.ts)
>
> **上一批次**:5-A 贡献值规则 CRUD (v0.6.0)
> **业务确认源**:[docs/批次6_audit_logs_业务确认稿.md](./批次6_audit_logs_业务确认稿.md)
> **核心架构**:**不**升级 `auditPlaceholder` 内部实现;新增 `AuditLogsService.log()` 作为第一批落库入口;两套 union(`AuditEvent` / `AuditLogEvent`)独立维护,允许后续批次渐进迁移

---

## 1. 前置业务确认结果

| Q | 内容 | 锁定 |
|---|---|---|
| Q1 | 是否记录查看行为 | **A** — 第一批仅写操作;后续再评估 B/C |
| Q2 | 操作记录保存多久 | **A** — 永久保留(红线:绝不删除)|
| Q3 | 管理员看自己 | **B** — 管理员能看自己,超级管理员能看全部 |
| Q4 | 敏感字段打码清单 | 身份证号 / 紧急联系人姓名 / 紧急联系人电话 / 家庭住址 |
| Q5 | 第一批接入模块 | **B** — 紧急联系人 + 证书的"写操作" |

---

## 2. 本批次目标

1. 新增 `AuditLog` Prisma model + migration(单表 **9 个业务字段 + 1 个 User relation**)
2. 新增 `audit-logs` 模块:**6 文件**(主体 4 + `audit-logs.select.ts` + `audit-logs.types.ts`;后者含 `AuditLogEvent` union + `AuditContext` 锁形 type)
3. 新增 `AuditLogsService`(`@Injectable`)+ `AuditLogsService.log()` **第一批落库入口**
4. 新增 2 个查询接口:`GET /api/v2/audit-logs` + `GET /api/v2/audit-logs/:id`
5. **第一批仅迁移 8 处 service 调用**:从 `auditPlaceholder(...)` 改为 `await this.auditLogs.log(...)`(emergency-contacts × 3 + certificates × 5)
6. 引入 `src/common/audit/mask-pii.util.ts` 打码工具(4 函数)
7. 新增 BizCode `14001` / `14101`

### 2.1 关键架构修订(D-A 拍板)

- 不升级 `auditPlaceholder` 内部实现
- `auditPlaceholder` 函数体**保持原样**(继续 pino-only)
- `auditPlaceholder` union 类型 `AuditEvent`(28 项)**保持不动**
- 新增 `AuditLogEvent`(6 项,**仅本批次落库的事件**)作为 `AuditLogsService.log()` 的入参 union
- 8 处调用方迁移后,**其余 ~30 处** `auditPlaceholder` 调用**继续 pino-only**,等后续批次按需迁移

**两套 union 共存关系**:

| union | 维护位置 | 用途 | 当前项数 | 迁移路径 |
|---|---|---|---|---|
| `AuditEvent` | `src/common/audit/audit-placeholder.ts` | 旧 pino 占位 | 28 项 | 后续批次按需迁出到 `AuditLogEvent`,**事件名维持不变** |
| `AuditLogEvent` | `src/modules/audit-logs/audit-logs.types.ts`(新)| 第一批 DB 落库入口 | 6 项 | 后续批次扩展 |

---

## 3. 本批次不做(对齐 D-A 修订 + V2.x 渐进接入)

- 不升级 `auditPlaceholder` 函数体(D-A 修订核心)
- 不迁移 8 处之外的 `auditPlaceholder` 调用(包括 `profile.read.other` / `emergency-contact.read.other` / `certificate.read.*` / `certificate.read.qualification-flag` / `activity.publish` / `registration.*` / `attendance-sheet.*` / `contribution-rule.*` 等约 30 处)
- 不记录任何"查看"行为(Q1=A)
- 不接 activities / activity-registrations / attendances / contribution-rules(Q5=B 范围外)
- 不做 export / 复杂搜索 / 归档 / 清理 / 删除 / 编辑接口
- 不做失败操作审计(`success` 默认 true,BizException 回滚)
- 不审计 audit_logs 自身(避免循环)
- 不引入队列 / Redis / 定时任务 / cls-rs / AsyncLocalStorage
- 不改 v1 任何接口 / 表 / 测试
- 不改 `prisma/seed.ts`
- 不为 audit_logs 引入新的 Prisma enum
- 不开 `Retry-After` 头 / 不开限流

---

## 4. schema 草案

### 4.1 AuditLog model

```prisma
model AuditLog {
  id              String   @id @default(cuid())
  createdAt       DateTime @default(now())

  // 主体
  actorUserId     String?
  actorRoleSnap   Role?

  // 客体
  resourceType    String   // 'emergency_contact' / 'certificate'(第一批 2 种)
  resourceId      String?  // create 失败时可为 null

  // 动作
  event           String   // 沿 AuditLogEvent union 同值

  // 上下文(锁形,详见 §10)
  context         Json

  // 状态
  success         Boolean  @default(true)

  actorUser       User?    @relation(fields: [actorUserId], references: [id], onDelete: Restrict, onUpdate: Restrict)

  @@index([resourceType, resourceId])
  @@index([actorUserId, createdAt])
  @@index([event, createdAt])
  @@map("audit_logs")
}
```

**字段构成**:
- **9 个业务字段**:`id` / `createdAt` / `actorUserId` / `actorRoleSnap` / `resourceType` / `resourceId` / `event` / `context` / `success`
- **1 个 User relation**:`actorUser`(`onDelete: Restrict` / `onUpdate: Restrict`,不计入业务字段)

### 4.2 User model 反向关系

```prisma
model User {
  // ... 既有
  auditLogs AuditLog[]
}
```

### 4.3 铁律
- 无 `updatedAt` / `deletedAt`
- `event` / `resourceType` 用 `String` 不用 enum
- `actorRoleSnap` 用 Prisma `Role` enum
- `context` 用 `Json`,**但运行时强约束**(详 §10)

---

## 5. API 草案

| Method | Path | 权限 | 用途 |
|---|---|---|---|
| GET | `/api/v2/audit-logs` | ADMIN+ | 分页查列表 |
| GET | `/api/v2/audit-logs/:id` | ADMIN+ | 单条详情 |

`AuditLogQueryDto` 字段:`page` / `pageSize` / `resourceType` / `resourceId` / `event` / `actorUserId` / `startDate` / `endDate`(共 8,严格白名单)。

默认排序:`[{ createdAt: 'desc' }, { id: 'desc' }]`。

**禁开**:POST / PATCH / PUT / DELETE / export / 聚合。

---

## 6. 权限规则(D-D 拍板)

### 6.1 Guard 层
`@Roles(Role.SUPER_ADMIN, Role.ADMIN)`

### 6.2 Service 层 `assertCanReadAuditLog(currentUser, log)`

| currentUser.role | 可看条件 |
|---|---|
| `SUPER_ADMIN` | 全部 |
| `ADMIN` | `log.actorUserId === currentUser.id` **OR** `log.actorRoleSnap === Role.USER` |
| `USER` | 任何记录都不可看(Guard 已挡)|

### 6.3 list where 强制注入
```ts
if (currentUser.role === Role.ADMIN) {
  where.OR = [
    { actorUserId: currentUser.id },
    { actorRoleSnap: Role.USER },
  ];
}
```

### 6.4 越级 detail 响应(D-D 拍板)
ADMIN 查 SUPER_ADMIN 的 detail → **`403` + `FORBIDDEN_AUDIT_LOG_READ = 14101`**。

### 6.5 SUPER_ADMIN 互看
沿 v1 §13,SUPER_ADMIN 之间可互看。

---

## 7. 敏感字段处理(D-C 拍板)

### 7.1 打码工具 `src/common/audit/mask-pii.util.ts`

```ts
export function maskName(name: string | null | undefined): string | null;
// "张三" → "张*";"王五六" → "王**";"a" → "*";null/undefined/"" → null

export function maskPhone(phone: string | null | undefined): string | null;
// "13800001111" → "138****1111";长度 ≠ 11 → "****";null → null

export function maskAddress(addr: string | null | undefined): string | null;
// D-C 拍板:保留前 6 字符,其余固定填 6 个 "*"
// "广东省深圳市福田区..." → "广东省深圳市******"
// null → null

export function maskIdCard(idCard: string | null | undefined): string | null;
// 预备能力,本批次无实际调用方
// "110101199001011234"(18 位)→ "110101********1234"
// "110101900101123"(15 位)→ "110101*****1234"
// 长度 ≠ 15/18 → "****"
```

### 7.2 调用纪律
- 工具函数纯 in/out,**无依赖**,可单测
- **由 service 调用方**在构造 `before` / `after` JSON **前**调用打码
- `AuditLogsService.log()` **不**二次打码
- 边界 null/undefined/empty 短路返回原值

### 7.3 第一批字段打码矩阵

| 字段 | 是否打码 | 调用打码函数 |
|---|---|---|
| `emergency_contact.contactName` | 是 | `maskName` |
| `emergency_contact.phonePrimary` | 是 | `maskPhone` |
| `emergency_contact.phoneBackup` | 是 | `maskPhone` |
| `emergency_contact.address` | 是 | `maskAddress` |
| `emergency_contact.relationCode` | 否 | 字典代码 |
| `emergency_contact.priority` | 否 | 非敏感 |
| `certificate.certNumber` | 否 | Q4 未勾选 |
| `certificate.issuingOrg` | 否 | 非敏感 |
| `certificate.certTypeCode` / `certSubTypeCode` / `issuedAt` / `expiredAt` / `certStatusCode` / `verifyNote` / `verifiedBy` / `verifiedAt` / `attachmentKey` | 否 | 非敏感 |

### 7.4 D6 显式记录(对齐业务确认稿 §五)
- 队员本人手机号:Q4 未勾选 — V2 第一阶段 schema **无该字段**,无影响
- 紧急联系人关系:Q4 未勾选 — relationCode 是字典代码,**原值入 audit**
- 医疗信息:V2 第一阶段 `member_profiles` 已延后,**无入口**;`member_profiles` 复活时**重新发起业务确认稿**

---

## 8. 第一批接入事件清单(D-A 修订核心)

### 8.1 `AuditLogEvent` union(本批次落库入口,6 项)

```ts
// src/modules/audit-logs/audit-logs.types.ts
export type AuditLogEvent =
  | 'emergency-contact.write'   // batch 1 hook,3 个 service 上下文(create/update/softDelete)
  | 'certificate.create'         // batch 2 hook
  | 'certificate.update'         // batch 2 hook
  | 'certificate.delete'         // batch 2 hook
  | 'certificate.verify'         // batch 2 hook
  | 'certificate.reject';        // batch 2 hook
```

**事件名与 `AuditEvent`(旧 union)同值**,确保未来批次迁移时,**仅是把字符串从一个 union 挪到另一个**。

### 8.2 8 处 service 调用迁移清单

| # | event | service 位置 | 资源 ID | before/after 建议 | 打码 |
|---|---|---|---|---|---|
| 1 | `emergency-contact.write` (create) | `emergency-contacts.service.ts:147` | `created.id` | `after = { contactName*, relationCode, phonePrimary*, phoneBackup*, address*, priority }` | 是 name/phone/address |
| 2 | `emergency-contact.write` (update) | `emergency-contacts.service.ts:188` | `contact.id` | `before` 完整 + `after` 命中字段 | 是 |
| 3 | `emergency-contact.write` (softDelete) | `emergency-contacts.service.ts:218` | `contact.id` | `before` 完整 | 是 |
| 4 | `certificate.create` | `certificates.service.ts:259` | `created.id` | `after` 完整 | 否 |
| 5 | `certificate.update` | `certificates.service.ts:317` | `cert.id` | `before` 完整 + `after` 命中字段 | 否 |
| 6 | `certificate.delete` | `certificates.service.ts:347` | `cert.id` | `before` 完整(含 `priorStatusCode`)| 否 |
| 7 | `certificate.verify` | `certificates.service.ts:390` | `cert.id` | `before.status` + `after.status` + `verifyNote` + `verifierMemberId` | 否 |
| 8 | `certificate.reject` | `certificates.service.ts:434` | `cert.id` | 同 verify | 否 |

### 8.3 调用方迁移示例

**旧**(pino-only):
```ts
auditPlaceholder('emergency-contact.write', {
  operatorUserId: currentUser.id,
  targetMemberId: memberId,
  operation: 'create',
  contactId: created.id,
});
```

**新**(第一批落库):
```ts
await this.auditLogs.log({
  event: 'emergency-contact.write',
  actorUserId: currentUser.id,
  actorRoleSnap: currentUser.role,
  resourceType: 'emergency_contact',
  resourceId: created.id,
  meta: auditMeta,
  after: {
    contactName: maskName(created.contactName),
    relationCode: created.relationCode,
    phonePrimary: maskPhone(created.phonePrimary),
    phoneBackup: maskPhone(created.phoneBackup),
    address: maskAddress(created.address),
    priority: created.priority,
  },
  extra: { targetMemberId: memberId, operation: 'create' },
  tx,
});
```

### 8.4 未迁移调用方一览(继续 pino-only,本批次零修改)

| 模块 | 调用方处数 | union 项 |
|---|---|---|
| member-profiles | 1 | `profile.read.other` |
| emergency-contacts | 1 | `emergency-contact.read.other` |
| certificates | 4 | `certificate.read.other` × 2 / `certificate.read.qualification-flag` × 1 |
| activities | 5 | `activity.publish` × 5 |
| activity-registrations | 7 | `registration.create` × 2 / `registration.review` × 5 |
| attendances | 12 | `attendance-sheet.submit` × 1 / `.edit` × 2 / `.delete` × 1 / `.review` × 2 / `.final-review` × 2 / `.read.other` × 3 |
| contribution-rules | 3 | `contribution-rule.create` / `.update` / `.delete` |
| **合计** | **~33** | **22 个 union 项中,本批次未迁移** |

---

## 9. BizCode 建议(段位 `140xx + 141xx`)

| Code | Name | HttpStatus | message | 触发 |
|---|---|---|---|---|
| `14001` | `AUDIT_LOG_NOT_FOUND` | 404 | 审计记录不存在 | `GET /:id` 不存在 |
| `14101` | `FORBIDDEN_AUDIT_LOG_READ` | 403 | 无权查看该审计记录 | ADMIN 越级查 SUPER_ADMIN 的 detail(D-D 拍板)|

不开 `14002+` / `14010+` / `14102+`(沿 baseline §1.3)。

---

## 10. `AuditContext` 锁形契约(D-F 拍板)

### 10.1 类型定义

```ts
// src/modules/audit-logs/audit-logs.types.ts
export interface AuditContext {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AuditMeta {
  requestId: string;
  ip: string | null;
  ua: string | null;
}
```

### 10.2 锁形铁律

- **共 6 字段:3 必填 + 3 可选**
- **3 个必填**:`requestId` / `ip` / `ua`(ip 与 ua 可为 null,但**字段必须存在**;`requestId` 必为非空字符串)
- **3 个可选**:`before` / `after` / `extra`(按事件语义决定)
- `AuditLogsService.log()` 内部构造 `AuditContext`,**单测断言 6 字段(3 必填 + 3 可选)结构正确**
- Prisma 写入时 `context as Prisma.InputJsonValue`

### 10.3 字段语义

| 字段 | 来源 | 备注 |
|---|---|---|
| `requestId` | nestjs-pino `req.id`(V1.1 §17.4 已接) | 用于跨日志关联 |
| `ip` | `request.ip` | 可为 null |
| `ua` | `request.headers['user-agent']` | 可为 null |
| `before` | service 调用方构造,**敏感字段已打码** | create 场景无 |
| `after` | service 调用方构造,**敏感字段已打码** | softDelete 场景无 |
| `extra` | 调用方自定义 metadata(`targetMemberId` / `operation` / `verifierMemberId` 等)| 不打码字段 |

---

## 11. Audit meta 传递机制(显式,不引入新依赖)

### 11.1 设计

`AuditMeta` 由 **controller 层**构造并显式传给 service,8 个 controller 方法签名增 1 个 `auditMeta: AuditMeta` 参数。

### 11.2 实现路径

```ts
// emergency-contacts.controller.ts(示例)
@Post(':memberId/contacts')
async create(
  @Param() params: MemberIdParamDto,
  @Body() dto: CreateEmergencyContactDto,
  @CurrentUser() currentUser: CurrentUserPayload,
  @Req() req: Request,
): Promise<EmergencyContactResponseDto> {
  const auditMeta: AuditMeta = {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: (req.headers['user-agent'] as string) ?? null,
  };
  return this.emergencyContactsService.create(params.memberId, dto, currentUser, auditMeta);
}
```

### 11.3 影响范围

| Controller | 改动方法数 |
|---|---|
| emergency-contacts.controller.ts | 3(create / update / softDelete) |
| certificates.controller.ts | 5(create / update / softDelete / verify / reject) |
| **合计** | **8** |

不动:emergency-contacts / certificates 的 list / detail / isQualified controller 方法。

---

## 12. e2e 覆盖建议

预估新增 e2e:**~42 条**。

| 矩阵 | 用例数 | 重点 |
|---|---|---|
| **8 处迁移 hook 触发** | 8 | 8 个 service 调用点逐个执行 → 查 audit 必有对应记录 |
| **AuditContext 锁形断言** | 5 | 每条 audit 必含 `requestId` / `ip` / `ua` 3 字段;before/after/extra 按事件类型存在 |
| **before / after 结构** | 5 | create only after;update before+after;delete only before;verify/reject 含状态码 |
| **敏感字段打码生效** | 6 | emergency-contact 3 场景 + maskName/Phone/Address 各 1 边界 |
| **不打码字段验证** | 3 | certificate.certNumber / relationCode / certTypeCode 原值保留 |
| **list 分页 + 过滤** | 9 | 8 个 filter 各 1 + 排序稳定性 1 |
| **detail** | 2 | 200 + 404 |
| **权限边界** | 6 | USER 401 / ADMIN 看 USER ok / ADMIN 看 SUPER_ADMIN ≠ → 403 14101 / ADMIN 看自己 ok / SUPER_ADMIN 全看 / list where 注入验证 |
| **不可改不可删** | 3 | PATCH / DELETE / PUT 返 404 |
| **不审计自身** | 1 | GET audit 不写新 audit |
| **同事务回滚** | 2 | 业务抛 BizException → audit 不入表 |
| **`AuditEvent` 与 `AuditLogEvent` 隔离** | 3 | 调 read 类接口 → pino 有日志,audit_logs 表**零**新记录 |
| **未迁移写操作不入库** | 2 | 调 `activity.publish` / `contribution-rule.create` → audit_logs **零**新记录 |
| **OpenAPI 快照** | 1 | 新增 2 paths + schemas,既有零漂移 |

### 12.1 e2e 数据清理(D-E 拍板)
- 测试库**豁免** `audit_logs` DELETE 红线
- `beforeEach` / `afterEach` 用 `TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`
- 生产 schema 维持 `@@map("audit_logs")` 不变;**红线只在生产代码层强约束**(controller 不开 delete 接口),DB 层无 trigger
- 测试 helper 集中在 `test/e2e/__helpers__/audit-logs-cleanup.ts`

---

## 13. 风险与返工点

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| **R1** | schema 红线:写入后**不可改不可删**;`AuditContext` 锁形定错 → 后续解析全乱 | **高** | D-F 已锁 6 字段结构;e2e §12 强断言每条 audit 必含 `requestId` / `ip` / `ua` |
| **R2** | `AuditLogEvent`(6 项)与 `AuditEvent`(28 项)两套 union 并存,可能让维护者困惑 | **中** | `audit-logs.types.ts` 注释明确"AuditLogEvent ⊆ AuditEvent,事件名同步;后续批次迁移时**仅**移动字符串";code review 阶段把关 |
| **R3** | 8 处 service 调用 + 8 处 controller 改造影响现有 e2e(emergency-contacts ~25 / certificates ~50) | **中** | service 主逻辑不动,只动 audit 调用点;**既有 e2e 零退化**作为 A 档门槛 |
| **R4** | audit 与业务同事务 fail-fast(D-B):audit 写失败 → 业务回滚 | **中** | 设计选择;`AuditLogsService.log` 单测覆盖异常场景;e2e 模拟 audit 写失败断言业务回滚 |
| **R5** | `before` / `after` JSON Decimal / Date 序列化丢精度 | **中** | service 层手动 `.toISOString()`;Decimal 暂无字段;未来批次迁移时另行评估 |
| **R6** | maskPii 边界(null/empty/超短)处理错 | **中** | 单测 ~20 条覆盖每个函数 5 边界 |
| **R7** | `actorRoleSnap` 从 `currentUser.role` 取,JwtStrategy 异常时为 undefined | **低** | JwtStrategy 已保证;service 层 assert |
| **R8** | PG 分页不稳 | **低** | tie-breaker `id: 'desc'` |
| **R9** | `maskAddress` 保留前 6 字符的语义边界 | **低** | D-C 已锁 6;单测 + 文档注释;后续如需调整作为 v0.7.x 独立调整 |
| **R10** | audit_logs 长期增长 | **低** | Q2=A 永久保留;真撑不住再加 partition(v2.x+) |
| **R11** | 测试 TRUNCATE 误用到生产 | **中** | helper 命名带 `test-only`;helper 内部 `assert(APP_ENV !== 'production')` 防御;cleanup helper 仅 `test/` 引用 |
| **R12** | `auditLog.create` 在事务内,如果业务 service 没用 tx 怎么办 | **中** | 8 处迁移点全部已经在 `prisma.$transaction` 内,**无例外**;评审稿强制要求 `AuditLogsService.log({ tx })` 显式传 tx;未来迁移的非事务调用方需另行评估 |
| **R13** | `req.id` 在 nestjs-pino 之外的场景拿不到 | **低** | V1.1 §17.4 已全局接 nestjs-pino;e2e 验证 `auditMeta.requestId` 非空字符串 |
| **R14** | `user` 被软删后 `audit_logs.actorUserId` 引用悬空 | **低** | `onDelete: Restrict`;v1 user 是软删 deletedAt,**不物理删除**,实际不触发 |
| **R15** | 未迁移的 `auditPlaceholder` 调用看起来"不工作"(部分入库 / 部分 pino-only)| **中** | 评审稿 §8.4 明确未迁移清单;CHANGELOG 显式说明"第一批 6 事件落库,其余 22 事件继续 pino";handoff 详细记录 |

---

## 14. PR 拆分建议(沿 batch5-A 范式)

| PR | 类型 | 主题 | 内容 |
|---|---|---|---|
| **PR #1** | `feat` | `feat(audit-logs): add schema + module + AuditLogsService + maskPii util` | prisma schema + migration `<ts>_v2_batch6_audit_logs` + AuditLog model + User.auditLogs 反向 + `audit-logs` 模块 **6 文件**(主体 4 + select.ts + types.ts)+ `AuditLogsService.log()` 实装 + `mask-pii.util.ts` 4 函数 + 单元测试 ~25 + BizCode 14001/14101 + 2 接口 Controller + Swagger + e2e ~28(权限/不可改不可删/list/detail/不审计自身/AuditContext 锁形/事件隔离/cleanup helper)|
| **PR #2** | `feat` | `feat(audit-logs): migrate emergency-contacts + certificates write events to AuditLogsService` | 8 处 service 调用从 `auditPlaceholder` 改为 `await this.auditLogs.log(...)` + 8 处 controller 注入 `req` 构造 `auditMeta` + e2e ~14(8 触发 + 5 before/after + 6 打码 + 2 同事务回滚 + 2 未迁移不入库)+ contract snapshot |
| **PR #3** | `docs` | `docs(v2-batch-6): record audit_logs first-wave landing` | CHANGELOG Unreleased + handoff 增量(明确 28 项 union 中 6 项已迁移,22 项继续 pino)+ baseline §1.1 v0.6 段位收口(`140xx + 141xx` 归属 `audit_logs`) |
| **PR #4** | `chore` | `chore: bump version to 0.7.0` | `package.json#version` 0.6.0 → 0.7.0 + `src/bootstrap/apply-swagger.ts:20` `setVersion('0.6.0' → '0.7.0')` |

**版本 + tag**:PR #4 merge 后,维护者手动打 `v0.7.0` tag + GitHub Release。

**PR 顺序铁律**:
- PR #1 先合(基础设施 + 接口 + service.log 实装)
- PR #2 依赖 PR #1(8 处迁移)
- PR #3 / PR #4 在 PR #2 后

**回滚成本**:
- PR #1 revert → schema rollback(audit_logs 表删除),既有 28 处 `auditPlaceholder` 调用零影响
- PR #2 revert → 8 处 service / controller 改回,既有 audit_logs 表保留(空表)
- PR #3 / PR #4 revert → 文档 + 版本号回退

---

## 15. 验收门槛(沿 baseline §14)

### 15.1 A 档(每 PR 必跑)
1. `pnpm lint`(`--max-warnings 0`)
2. `pnpm typecheck`(src + test 双 tsconfig)
3. `pnpm test`(unit:加 maskPii ~20 + AuditLogsService ~10 → 总 ~575)
4. `pnpm test:e2e`(~705 / 32 suites)
5. `pnpm test:contract`(~165 + snapshot 主动更新)
6. `pnpm build`
7. v1 14 + V2 72 既有接口 schema + paths **零漂移**
8. 决议表(§16)逐项满足

### 15.2 B 档(PR #1 + PR #2 涉及 HTTP / Controller / Swagger,追加)
- `/api/docs` 正常打开
- `GET /api/health` 仍 v1 契约
- 2 个 audit-logs 接口 Swagger UI 可见 + 受保护标识
- 典型成功路径 + 404 / 403 / 401 在 Swagger UI 试调通过

### 15.3 实施验收清单
- [ ] AuditLog model **9 个业务字段 + 1 个 User relation**(User.auditLogs 反向)
- [ ] migration `<ts>_v2_batch6_audit_logs`
- [ ] **模块 6 文件**(主体 4 + select.ts + types.ts)
- [ ] `AuditLogEvent` union 6 项,**与 `AuditEvent` 物理隔离**(不同文件)
- [ ] **`AuditContext` 锁形 6 字段(3 必填 + 3 可选)**
- [ ] BizCode 140xx 2 个码;不开 14002+/14102+
- [ ] DTO 白名单 8 字段;`forbidNonWhitelisted` 兜底
- [ ] `auditPlaceholder` 函数体 / `AuditEvent` union **零修改**
- [ ] 8 处 service 调用迁移;8 处 controller 改造增 `auditMeta`
- [ ] 22 处未迁移 `auditPlaceholder` 调用 **零修改**(grep 验证)
- [ ] `mask-pii.util.ts` 4 函数 + 单元 ~20
- [ ] `AuditLogsService.log` 单元 ~10(含异常 / null 边界 / tx 透传)
- [ ] `assertCanReadAuditLog` service 层二次校验
- [ ] e2e cleanup helper 仅 test/ 引用 + `APP_ENV` 防御
- [ ] e2e ~42 条覆盖 §12 矩阵
- [ ] OpenAPI snapshot 新增 2 paths + schemas;既有零漂移
- [ ] Swagger 100% 覆盖
- [ ] `prisma/schema.prisma` 唯一改动:AuditLog model + User.auditLogs
- [ ] `prisma/seed.ts` 未改;`package.json` 无新依赖

---

## 16. 决议表(本评审稿锁定,共 25 项)

### 16.1 业务确认(B 系列,5 项)
| ID | 决议 | 来源 |
|---|---|---|
| B1 | Q1 = A — 第一批不记查看 | 业务确认稿 |
| B2 | Q2 = A — 永久保留 | 业务确认稿 |
| B3 | Q3 = B — 管理员看自己 + 超管看全部 | 业务确认稿 |
| B4 | Q4 打码清单 4 项 | 业务确认稿 |
| B5 | Q5 = B — 第一批接 emergency-contacts + certificates 写操作 | 业务确认稿 |

### 16.2 架构决策(D 系列,10 项)
| ID | 决议 | 来源 |
|---|---|---|
| D1 | **不**升级 `auditPlaceholder` 内部,新增 `AuditLogsService.log()` 作落库入口;第一批仅 8 处迁移 | D-A 修订 |
| D2 | `AuditEvent`(28) vs `AuditLogEvent`(6)两套 union 物理隔离,事件名同值,后续批次仅移动字符串 | D-A 修订 |
| D3 | audit 与业务同事务 fail-fast | D-B |
| D4 | `maskAddress` 保留前 6 字符,其余打码 | D-C |
| D5 | ADMIN 越级查 SUPER_ADMIN → 403 + 14101 | D-D |
| D6 | 测试库 TRUNCATE 豁免 DELETE 红线;helper 防御 `APP_ENV` | D-E |
| D7 | `AuditContext` 锁形 6 字段 `{ requestId, ip, ua, before?, after?, extra? }` | D-F |
| D8 | `AuditMeta` 由 controller 层从 `@Req()` 构造,显式传给 service;**不**引入 cls-rs / AsyncLocalStorage | 本稿内部决策 |
| D9 | audit log 与业务同 `prisma.$transaction` tx 透传 | 沿草案 §4.4 |
| D10 | `actorRoleSnap` 用 Prisma `Role` enum;`event` / `resourceType` 用 String | v0.1 §4.3 |

### 16.3 范围与禁止(F 系列,10 项)
| ID | 决议 | 来源 |
|---|---|---|
| F1 | 不升级 `auditPlaceholder` 函数体 | D1 |
| F2 | 不迁移 22 处未迁移 `auditPlaceholder` 调用 | D1 |
| F3 | 不记查看行为 | B1 |
| F4 | 不接 activities / attendances / contribution-rules / registrations 写事件 | B5 |
| F5 | 不开 POST / PATCH / PUT / DELETE / export / 聚合接口 | §5 |
| F6 | 不审计 audit_logs 自身 | §3 |
| F7 | 不引入新依赖 / 队列 / Redis / cls-rs / AsyncLocalStorage | §3 |
| F8 | 不改 v1 接口 / `prisma/seed.ts` / 既有 e2e 主路径 | §3 |
| F9 | 不开 14002+/14010+/14102+ BizCode | §9 |
| F10 | 不在测试外开放 audit_logs DELETE | D6 |

**决议合计**:5 + 10 + 10 = **25 项**

---

## 17. 落地节奏

| 阶段 | 产物 | 状态 |
|---|---|---|
| D6 v0.1 草案 | 6 决策点 | 已交付 |
| D6 v1.0 冻结 | 决议表 + PR 拆分 + 风险 | 已交付 |
| D6 v1.1 冻结(本稿) | 4 点表述修正 | **已通过用户评审 + 已归档** |
| 实施 PR #1 → #2 → #3 → #4 | 沿 batch5-A 节奏 | 待启动 |
| Release v0.7.0 | tag + GitHub Release | 维护者手动 |
