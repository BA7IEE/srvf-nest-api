# SRVF App API P2-7 My Certificates Review

> **状态**:**草案 v0.1**(待用户拍板冻结)
> **范围**:Phase 2 P2-7 — `GET /api/app/v1/my/certificates` 单 endpoint 实施前评审
> **生效条件**:本评审稿用户拍板冻结后,P2-7 implementation PR 才允许立项
> **冲突优先级**:与 [`CLAUDE.md`](../CLAUDE.md) §1-§19 / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / [Phase 2 顶层评审稿](app-api-phase-2-review.md) / [Phase 0.5](app-permission-boundary-review.md) / [Phase 0.6](data-access-lifecycle-boundary-review.md) / [Phase 0.7](code-architecture-boundary-review.md) 冲突时本评审稿让步
> **下位关系**:本评审稿是 [Phase 2 顶层评审稿 §2 行 106](app-api-phase-2-review.md) `/my/certificates` 占位行的具体化;不替代顶层评审稿任何决议
> **依赖前置**:P2-1 已合入(`AppIdentityResolver` exports + `canUseApp` 准入闭包);P2-6 已合入(P2-6 同形态 thin self-list 范式可借鉴)
> **预估实施**:主代码 < 280 行 + e2e ~700-900 行;**C 档**

---

## 0. TL;DR(8 条)

1. **唯一 endpoint**:`GET /api/app/v1/my/certificates`(沿顶层 §2 行 106)。
2. **独立 App service** — `AppMyCertificatesService` 内 `PrismaService` 自查(沿 D-P2-7-9);**不** thin-wrap `certificates.service.list`(admin list 写 `certificate.read.other` 审计 + 临时权限策略 `@Roles(ADMIN/SUPER_ADMIN)`,与 App self 语义不匹配)。
3. **新建 4 个文件**:`AppMyCertificatesController` + `AppMyCertificatesService` + `AppMyCertificateDto` + `ListAppMyCertificatesQueryDto`。
4. **严禁复用** admin `CertificateResponseDto` / `CertificateListItemDto`(沿 Phase 0.6 §1.3 + Phase 0.7 §2.2 + D-P2-7-3)。
5. **字段集恰好 12 项**(沿 §5;**比 Phase 2 §5.1 #10 placeholder 的 4 项更丰富**;`memberId` / `verifiedBy` / `supersededByCertId` / `updatedAt` / `deletedAt` 全部丢)。
6. **0 新 BizCode / 0 schema / 0 migration / 0 新依赖**(沿顶层 §3.2 + D-P2-7-11)。
7. **准入**:JwtAuthGuard(全局)+ `AppIdentityResolver.resolve` + `canUseApp === false` → `FORBIDDEN=40300`;**不**沿 D-P2-3-1 admin-without-member 例外(沿 D-P2-6-12 同范式)。
8. **PR 拆分**:本评审稿独立 docs-only PR(A 档);P2-7 implementation 独立 C 档 PR。

---

## 1. 背景与范围

### 1.1 背景

P2-1 ~ P2-6 已合入(HEAD `4a2a205`),App API 14 endpoint 已落地。P2-7 是 Phase 2 范围内最后一个业务 PR(P2-8 仅 docs 收尾)。

certificates 模块由 V2 第一阶段批次 2 落地(admin 8 endpoint;`@Roles(SUPER_ADMIN, ADMIN)` 兜底;**不开放** USER 自助;沿 [`certificates.controller.ts:32`](../src/modules/certificates/certificates.controller.ts) 临时权限策略)。App 端"我的证书"是 first-release 刚需(沿 [inventory §4 P1](api-client-boundary-inventory.md))。

### 1.2 范围

- ✅ 新建 `GET /api/app/v1/my/certificates`(App 视角"我的证书"列表;含本人 pending / rejected / expired)
- ✅ 新建 4 物理文件(controller / app service / DTO × 2)+ 1 e2e spec;更新 contract spec 白名单 + snapshot

### 1.3 不在范围

- ❌ 不实现 `GET /api/app/v1/my/certificates/:id` 详情(P2-7 仅列表;若产品需要详情走 Phase 2.x 单独立项)
- ❌ 不实现 App 本人申请新证书 `POST /api/app/v1/my/certificates`(沿 admin create 仍是 `@Roles(ADMIN)`;App 自助申请属业务边界变更,需独立评审稿)
- ❌ 不实现 App 本人改证书资料 / 删证书(沿 admin 仍走临时权限策略;App 仅只读)
- ❌ 不实现 qualification-flag 资质判定的 App 入口(admin `GET .../qualification-flag` 是审核辅助接口,App 不暴露)
- ❌ 不改 admin `/api/v2/members/:memberId/certificates/*` 8 endpoint 任一(沿顶层 §3.2 + D-P2-7-11)
- ❌ 不动 `certificates.service.ts` / `certificates.controller.ts` / `certificates.dto.ts` / `prisma/schema.prisma` / migration / BizCode / `members/*` / P2-1~P2-6 已落地文件(沿 §11)
- ❌ **不**做 P2-8 docs 收尾(独立 PR;沿 §11.1)
- ❌ **不**做 Phase 1B `/api/auth/v1/*` / `/api/public/v1/*` alias(独立通道;沿 §11.1)

---

## 2. 与 Phase 2 顶层评审稿的关系

### 2.1 引用矩阵

| 顶层段落 | 本评审稿对应 |
|---|---|
| [`§2 行 106`](app-api-phase-2-review.md)(P2-7 行) / [`§2.2 行 129`](app-api-phase-2-review.md)(`listForMember` 占位) | §4 endpoint 契约 + §7 修订为独立 App service(详 §7.5) |
| [`§3.2`](app-api-phase-2-review.md)(不动 schema / admin) | §11 禁止修改清单 |
| [`§5.1 行 267`](app-api-phase-2-review.md)(AppSelf L0+L1)/ [`§5.2 #10 行 297`](app-api-phase-2-review.md)(placeholder 4+1 字段 + `rejectionReason`) | §5 字段集 + §5.0 修订(扩 12 + 命名 `verifyNote`) |
| [`§6.2 行 349`](app-api-phase-2-review.md)(准入:JwtAuth + memberId 必填 + Member ACTIVE) | §8 准入规则 |
| [`§8.1 行 430`](app-api-phase-2-review.md)(C 档 / 依赖 P2-1 / < 400 行)/ [`§9 行 608`](app-api-phase-2-review.md)(由用户决议是否独立稿)/ [`§12.2.8 行 636`](app-api-phase-2-review.md)("含 pending/rejected") | §15 PR 验收 + 本评审稿存在依据 + §5.1 可见性约定 |

### 2.2 引用同步要求

本评审稿任何字段集 / 准入规则 / 路径 / 命名调整,**必须**与顶层评审稿对齐;冲突时**以顶层评审稿为准**,本评审稿让步。**例外**:§5.0 字段集扩展与 §5.0 `verifyNote` 命名保留是本 v0.1 主动细化项,顶层 §5.2 #10 是 placeholder,具体化让位本评审稿。

---

## 3. 已锁决策表

| ID | 决策 | 依据 |
|---|---|---|
| **D-P2-7-1** | 唯一 endpoint = `GET /api/app/v1/my/certificates`(无详情 / 无写 / 无 qualification-flag) | 顶层 §2 行 106 + §1.3 不在范围 |
| **D-P2-7-2** | 准入:JwtAuthGuard 全局 + `AppIdentityResolver.resolve` + `canUseApp === true && member !== null`;**不**挂 `@Public` / **不**挂 `@Roles` | 顶层 §6.2 + §6.4 + [`CLAUDE.md §19.7 D-5.2`](../CLAUDE.md) |
| **D-P2-7-3** | **严禁**复用 / 继承 / Pick / Omit / IntersectionType / PartialType / OmitType / Mapped Types admin `CertificateResponseDto` / `CertificateListItemDto`;App DTO 物理隔离于 `certificates/dto/app/` | Phase 0.6 §1.3 + Phase 0.7 §2.2 + 顶层 §5.2 #1 |
| **D-P2-7-4** | 字段集**恰好 12 项**(详 §5);snapshot 强 freeze;`memberId` / `verifiedBy` / `verifier` / `supersededByCertId` / `supersededBy` / `replacedCertificates` / `updatedAt` / `deletedAt` 全部丢 | §5.1 字段表 |
| **D-P2-7-5** | `verifyNote` **保留命名**,**不**改 `rejectionReason`(沿 Prisma schema 字段名 + admin DTO 语义一致;前端可自行显示为"拒绝原因 / 审核备注") | Prisma `Certificate.verifyNote` + 顶层 §5.2 #10 placeholder 不约束最终命名 |
| **D-P2-7-6** | 状态展示**只返**持久态 `certStatusCode`;**不**在 App service 内根据 `expiredAt < now()` 实时映射 `expired` 状态;过期推进由后台任务 / 管理流程维护 | Prisma schema 注释 §3 "CERT_STATUS_EXPIRED 由后台任务推动,本批次 service 不主动写入";避免 App / Admin 双权威源漂移 |
| **D-P2-7-7** | Query DTO **严格 4 字段**(`page` / `pageSize` via `PaginationQueryDto` + 可选 `certStatusCode` + 可选 `certTypeCode`);`certStatusCode` 必须 4 态白名单(`pending` / `verified` / `expired` / `rejected`);`forbidNonWhitelisted` 兜底任何越界 | §6.1 字段表 |
| **D-P2-7-8** | 默认排序 `orderBy: { createdAt: 'desc' }`(不沿 admin `[{certStatusCode: 'asc'}, {createdAt: 'desc'}]`;App 视角按时间线最直观,避免状态优先级歧义) | §4 排序段 + 沿 P2-6 / P2-5a 范式 |
| **D-P2-7-9** | **独立 App service**(`AppMyCertificatesService` 内 `PrismaService` 自查);**不** thin-wrap `certificates.service.list`(admin list 写 `certificate.read.other` 审计 + 写 admin `@Roles` 兜底,语义不匹配);**不**在 `certificates.service.ts` 新增 `listForMember` method(沿 Phase 0.7 §6 不立即重构 + Phase 2 §3.3 不拆既有大 service) | §7.5 决策理由长版 |
| **D-P2-7-10** | 物理布局:`controllers/app-my-certificates.controller.ts` + `app-my-certificates.service.ts` + `dto/app/app-my-certificate.dto.ts` + `dto/app/list-app-my-certificates-query.dto.ts` + `certificates.module.ts` 注册 controller / provider | §7.1 文件清单 |
| **D-P2-7-11** | **0 schema / 0 migration / 0 seed / 0 admin diff / 0 新 BizCode / 0 新依赖** | 顶层 §3.2 + §11 |
| **D-P2-7-12** | **不**沿 D-P2-3-1 admin-without-member 例外(严格仅 `/me/password` 适用);admin 无 member → 40300 | 沿 D-P2-6-12 范式 |
| **D-P2-7-13** | admin-as-member 走 linked-member self perspective;**禁止** role 短路 / 接收 query `memberId` | [`CLAUDE.md §19.7 D-5.2`](../CLAUDE.md) + D-P2-6-13 范式 |
| **D-P2-7-14** | 私有静态 mapper 内嵌薄壳 service(沿 P2-5 / P2-6 P0/P1 过渡;**不**抽独立 Presenter class) | Phase 0.7 §7.2 + P2-6 D-P2-6-14 |
| **D-P2-7-15** | 旧 admin `/api/v2/members/:memberId/certificates/*` 8 endpoint 行为**逐字不变**(path stability + service / DTO / controller 整文件 0 diff;**含** `certificates.service.ts` 内 `auditPlaceholder('certificate.read.other', …)` 与 `@Roles` 临时策略均原样保留) | 顶层 §3.2 + §5 line 529 path stability |
| **D-P2-7-16** | 纯只读 endpoint,**不写 audit**(沿批次 6 Q1=A;P2-5a / P2-6 同范式);App self-read 不算 admin-perspective `read.other`,避免错误审计语义 | P2-5a / P2-6 实施未新增 audit |

---

## 4. Endpoint 契约

```
GET /api/app/v1/my/certificates?page=1&pageSize=20&certStatusCode=verified&certTypeCode=ARS_W

Auth:         JwtAuthGuard(全局;无 @Roles,无 @Public)
Throttle:     默认(不专门限流)
Scope:        self(由 AppMyCertificatesService 内 where `memberId = currentUser.memberId` 锁定)
Response:     PageResultDto<AppMyCertificateDto>
Tag:          'Mobile - My Certificates'
```

**响应包装**:沿 `ResponseInterceptor` 三层 `{ code: 0, message: 'ok', data: { items, total, page, pageSize } }`(沿 [`CLAUDE.md §4`](../CLAUDE.md))。

**排序**:`orderBy: { createdAt: 'desc' }`(D-P2-7-8;App 视角按时间线最直观)。

**过滤铁律**(沿 D-P2-7-9 独立 App service where 子句):
- `memberId = currentUser.memberId`(本人锁定;不接受 query 传入 memberId)
- `deletedAt IS NULL`(沿 `notDeletedWhere`;软删 cert 不可见)
- 可选 `certStatusCode` filter(query 提供时;4 态白名单)
- 可选 `certTypeCode` filter(query 提供时)

**状态可见性**(沿 D-P2-7-6 + 顶层 §12.2.8):本人**可见所有自己的状态**:`pending` / `verified` / `expired` / `rejected`(让本人看自己的未通过,审核反馈用)。

---

## 5. `AppMyCertificateDto` 字段集

### 5.0 v0.1 修订说明(对顶层 §5.2 #10 placeholder 的细化)

顶层 §5.2 #10 占位字段集 `id / certStatusCode / issuedDate / createdAt + rejectionReason`(4+1 字段);本 v0.1 细化为 **12 项**,4 点理由:① **可用性**:需 `certTypeCode` / `certSubTypeCode` / `issuingOrg` 让本人区分多张同状态证书;② **资料完整性**:`issuedAt` / `expiredAt` 是有效期判断核心字段;③ **命名一致**:`issuedDate` → `issuedAt`(沿 Prisma)、`rejectionReason` → `verifyNote`(D-P2-7-5);④ **L1 对本人可见**:`certNumber` / `verifyNote` / `verifiedAt` 均沿 Phase 0.6 §2.4 / §5.4。

**仍丢弃**(沿 Phase 0.6 §6.5):`memberId` / `verifiedBy` / `verifier` / `supersededByCertId` / `supersededBy` / `replacedCertificates` / `updatedAt` / `deletedAt` / 审计上下文。

### 5.1 字段表(恰好 12 项)

| # | 字段 | 类型 | 等级 | 来源 | 决议 |
|---|---|---|---|---|---|
| 1 | `id` | `string` | L0 | `Certificate.id` | ✅ 保留(主键) |
| 2 | `certTypeCode` | `string` | L0 | `Certificate.certTypeCode` | ✅ 保留(字典 `cert_type`) |
| 3 | `certSubTypeCode` | `string \| null` | L0 | `Certificate.certSubTypeCode` | ✅ 保留(字典 `cert_sub_type`) |
| 4 | `issuingOrg` | `string` | L0 | `Certificate.issuingOrg` | ✅ 保留(自由文本) |
| 5 | `certNumber` | `string \| null` | L1(对本人) | `Certificate.certNumber` | ✅ 保留(中敏感;本人完整可见) |
| 6 | `issuedAt` | `Date` | L0 | `Certificate.issuedAt` | ✅ 保留(颁发日期) |
| 7 | `expiredAt` | `Date \| null` | L0 | `Certificate.expiredAt` | ✅ 保留(NULL = 终身有效) |
| 8 | `certStatusCode` | `string` | L0 | `Certificate.certStatusCode` | ✅ 保留(4 态闭集;D-P2-7-6 持久态) |
| 9 | `isInternal` | `boolean` | L0 | `Certificate.isInternal` | ✅ 保留(本会颁发) |
| 10 | `verifyNote` | `string \| null` | L1(对本人) | `Certificate.verifyNote` | ✅ 保留(拒绝原因 / 审核备注;D-P2-7-5 命名沿 admin) |
| 11 | `verifiedAt` | `Date \| null` | L1(对本人) | `Certificate.verifiedAt` | ✅ 保留(审核时间;沿 verifyNote 同等级) |
| 12 | `createdAt` | `Date` | L0 | `Certificate.createdAt` | ✅ 保留(排序参考) |

### 5.2 字段丢弃列表(snapshot 触发即拒合并)

| 字段 | 丢弃理由 |
|---|---|
| `memberId` | AppSelf scope 下所有 row 都属 `currentUser.memberId`,本人已知 via `/me/account.linkedMemberId`(沿 P2-6 §5.2 默认锁) |
| `verifiedBy` / `verifier` 嵌套 | **避免泄露审核人身份**(沿 Phase 0.6 §6.5;审核人是另一名 Member,L2 跨 member 信息) |
| `supersededByCertId` / `supersededBy` / `replacedCertificates` | 替代关系链路 App 侧不暴露(沿 Phase 0.6 §6.5;前端复杂度高;若需要单独立项) |
| `updatedAt` | admin housekeeping(沿 P2-6 §5.2 默认锁) |
| `deletedAt` | 软删 row 已被 where 过滤,不暴露 |
| `expireNotifyDueAt` | 后台任务字段(沿 Prisma schema 注释 HK-1) |

### 5.3 绝对禁止返回(snapshot 触发即拒合并)

- ❌ `passwordHash` / `refreshToken` / `tokenHash` / `accessToken`(L3 Credential)
- ❌ 任何 audit context(`requestId` / `ip` / `ua` / `actorUserId` / `actorRoleSnap`)
- ❌ 任何 verifier `Member` 字段(`verifier.realName` / `verifier.documentNumber` / `verifier.mobile` / `verifier.memberNo` 等)
- ❌ 任何 `Member.*` L2 字段(`mobile` / `documentNumber` / `medicalNotes` / `bloodTypeCode`)
- ❌ `supersededBy` 关联 row 完整字段集(关联软删 / 替代旧 row 的完整快照)

### 5.4 物理文件

- `src/modules/certificates/dto/app/app-my-certificate.dto.ts`(**独立 class**;**不** `extends` / Pick / Omit 任何 admin DTO);每字段 `@ApiProperty({ description })` 或 `@ApiPropertyOptional({ nullable: true })`;出参 DTO 不需 `class-validator`(沿 [`UserResponseDto`](../src/modules/users/dto/user-response.dto.ts) 范式)

---

## 6. `ListAppMyCertificatesQueryDto` 字段集

### 6.1 字段表(恰好 4 项)

| # | 字段 | 类型 | 校验 | 来源 |
|---|---|---|---|---|
| 1 | `page` | `number` | `IsInt + Min(1)` | `extends PaginationQueryDto`(跨模块公共,**唯一允许 extends**) |
| 2 | `pageSize` | `number` | `IsInt + Min(1) + Max(100)` | 同上 |
| 3 | `certStatusCode` | `string?`(可选) | `IsOptional + IsIn(['pending','verified','expired','rejected'])` | 本 DTO 自定义(D-P2-7-7 4 态白名单) |
| 4 | `certTypeCode` | `string?`(可选) | `IsOptional + IsString + MinLength(1) + MaxLength(64)` | 本 DTO 自定义(沿 admin 字典 code 长度) |

### 6.2 严禁字段

`forbidNonWhitelisted: true` 兜底;**禁止**:
- `memberId` / `userId`(本人查本人,后端从 `currentUser.memberId` 推导;接收即视作越权)
- `verifiedBy` / `verifier` / `verifierMemberId`(审核人是 admin 视角字段)
- `includeDeleted` / `withDeleted`(软删 row 永远不可见)
- `supersededByCertId`(替代链路 App 不暴露)
- `dateFrom` / `dateTo` / `issuedAt[gte]` / `expiredAt[lte]`(P2.x 单独立项)
- `sortBy` / `sortOrder`(默认 createdAt desc;沿 D-P2-7-8)
- `isInternal` filter(若需要 P2.x 立项;本评审稿不开)

### 6.3 物理文件

- `src/modules/certificates/dto/app/list-app-my-certificates-query.dto.ts`
- `extends PaginationQueryDto`(沿 P2-5a / P2-6 范式;`PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共,**非** admin 模块 DTO,不违反 D-P2-7-3 铁律)

---

## 7. Controller / Service / Module 物理布局

### 7.1 文件清单(D-P2-7-10 + D-P2-7-14)

| 层 | 物理路径 | 职责 | 预估行数 |
|---|---|---|---|
| Mobile Controller | `src/modules/certificates/controllers/app-my-certificates.controller.ts` | thin;`@CurrentUser()` + `@Query()` → 委派 service | ~55 |
| App Service(独立) | `src/modules/certificates/app-my-certificates.service.ts` | 1) `assertCanUseAppOrThrow` 2) `prisma.certificate.findMany / count`(本人 + 软删过滤 + 可选 filter)3) 私有静态 mapper | ~135 |
| 输出 DTO | `src/modules/certificates/dto/app/app-my-certificate.dto.ts` | 字段集 12 项(§5) | ~70 |
| Query DTO | `src/modules/certificates/dto/app/list-app-my-certificates-query.dto.ts` | 字段 4 项(§6) | ~30 |
| Module | `src/modules/certificates/certificates.module.ts`(**修改**) | imports +`UsersModule`(取 `AppIdentityResolver`)/ controllers +`AppMyCertificatesController` / providers +`AppMyCertificatesService` | +5 行 diff |

### 7.2 Controller 顶层标记

```ts
@ApiTags('Mobile - My Certificates')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyCertificatesController { ... }
```

- **不**挂 `@Roles`(沿 P2-2 ~ P2-6 范式;App 不用 Role 短路)
- **不**挂 `@Public`(全部要登录)
- **不**挂限流装饰器(default throttler)

### 7.3 Service 范式(D-P2-7-9 独立 App service)

```ts
@Injectable()
export class AppMyCertificatesService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly prisma: PrismaService,
  ) {}

  async listMyCertificates(query, currentUser): Promise<PageResultDto<AppMyCertificateDto>> {
    const access = await this.assertCanUseAppOrThrow(currentUser); // §8.1
    const where: Prisma.CertificateWhereInput = {
      memberId: access.member.id,
      deletedAt: null,
      ...(query.certStatusCode !== undefined ? { certStatusCode: query.certStatusCode } : {}),
      ...(query.certTypeCode !== undefined ? { certTypeCode: query.certTypeCode } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.certificate.findMany({
        where, select: AppMyCertificatesService.appSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
      this.prisma.certificate.count({ where }),
    ]);
    return { items: rows.map(AppMyCertificatesService.toAppDto), total, page: query.page, pageSize: query.pageSize };
  }

  // appSelect 严格 12 字段(沿 §5.1);toAppDto 直 spread(等价 Prisma row → DTO,无字段名转换)
}
```

**铁律**(沿 §11):**不**改 `certificates.service.ts`(整文件 0 diff);**不**调用 admin `list / findOne / isQualified`(admin list 写 `read.other` 审计 + admin scope,语义不匹配);**不**新增 `listForMember(...)` 到 admin service(沿 D-P2-7-9 + Phase 0.7 §6 不立即重构);**允许** AppMy service 通过 `PrismaService` 直查 `Certificate`(沿 P2-5a / P2-6 范式)。

### 7.4 例外退路

如 implementation 发现:① 字段集 §5.1 12 项**仍不足**(产品反馈)/ ② `certStatusCode` 4 态枚举与 Prisma 实际不一致 / ③ admin-as-member 边界与 AppIdentityResolver 行为不符,**必须**:
1. **立刻暂停**回到对话汇报缺口
2. **不**擅改既有文件 / 不擅扩字段
3. 由用户拍板是否新开 v0.2 评审稿
4. v0.2 冻结前**禁**任何 implementation 代码动作

### 7.5 D-P2-7-9 决策理由(为什么 v0.1 不沿顶层 §2.2 "新 method `listForMember`")

顶层 §2.2 行 129 提议 `certificates.service.listForMember(memberId, query)`;本 v0.1 修订为**独立 App service**,4 点理由:① **审计语义错配** — admin `list` 调 `auditPlaceholder('certificate.read.other')`,App self list **不应**写 `read.other`(沿 D-P2-7-16);② **避免双权威源** — `certificates.service` 已 556 行 / 8 endpoint / 完整字典校验+状态机+audit+transaction;新增 method 引入"App 不审计 / admin 审计"分支易漂移;③ **沿 Phase 0.7 §6 不立即重构 + Phase 2 §3.3 不拆既有大 service** — 独立 App service 最小侵入;④ **AppMy self-scope 简单** — `findMany + count` 2 次 DB,无字典/状态机/audit,独立写不复杂。`certificates.service` 内 helper(`assertDictItemValid` 等)本 endpoint 不需要(列表只读)。Phase 2.x P2-7-detail 立项时再评估抽公共 service。

---

## 8. 准入规则

### 8.1 硬约束(沿 P2-6 §8.1 + AppIdentityResolver)

| 顺序 | 检查 | 不通过响应 |
|---|---|---|
| 1 | JwtAuthGuard 全局 | 401 `UNAUTHORIZED=40100`(token 无效 / 过期 / 用户 DISABLED / 软删) |
| 2 | `AppIdentityResolver.resolve(currentUser)` → `canUseApp === true && member !== null` | `FORBIDDEN=40300` |

### 8.2 拒绝路径(D-P2-7-12 + D-P2-7-13)

| 场景 | reason | 响应 |
|---|---|---|
| memberId === null(USER 未绑 + Admin 未绑) | `MEMBER_NOT_LINKED` | `FORBIDDEN=40300` |
| member 不存在 / 软删 | `MEMBER_DELETED` | `FORBIDDEN=40300` |
| member.status !== ACTIVE | `MEMBER_INACTIVE` | `FORBIDDEN=40300` |
| canUseApp=true(含 admin-as-member) | — | 200 + linked-member self perspective(D-P2-7-13) |

**铁律**:
- ❌ **禁止**沿 D-P2-3-1 admin-without-member 例外
- ❌ **禁止**因 `role=ADMIN` 扩大 scope
- ❌ **禁止**从 body / query 接收 `memberId`(DTO 严格白名单)
- ❌ **禁止**返回 reason 字段细分给前端(`reason` 仅用于 `/me/capabilities`)

---

## 9. OpenAPI Contract 变更

### 9.1 EXPECTED_ROUTES(+1)

[`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` 在 P2-6 段后追加:

```ts
// Phase 2 P2-7(2026-05-2X):App /api/app/v1/my/certificates
// 沿 docs/app-api-p2-7-my-certificates-review.md §4 endpoint 契约 + §5 字段集恰好 12;
// 独立 AppMyCertificatesService(沿 D-P2-7-9;不动 certificates.service.ts);
// 0 新 BizCode / 0 schema / 0 migration;admin /v2/members/:memberId/certificates/* 8 endpoint 逐字不变。
['get', '/api/app/v1/my/certificates'],
```

### 9.2 EXPECTED_SCHEMAS(+1)

`EXPECTED_SCHEMAS` 数组追加:

```ts
// Phase 2 P2-7:App /api/app/v1/my/certificates 出参 DTO
// 字段集恰好 12(沿 §5.1);独立 class,禁止继承 / Pick / Omit / Mapped Types
// admin CertificateResponseDto / CertificateListItemDto(沿 D-P2-7-3 + Phase 0.7 §2.2)。
'AppMyCertificateDto',
```

### 9.3 Query DTO 不进 schemas

`ListAppMyCertificatesQueryDto` 是 `@Query()` DTO,被 NestJS Swagger 内联为 parameters,**不**注册到 `components.schemas`(沿 P2-5 / P2-6 注释惯例)。

### 9.4 Snapshot 重生

`pnpm test:contract -u` 重新生成 `test/contract/__snapshots__/openapi.contract-spec.ts.snap`。预期 diff:
- 新增 1 个 path key `/api/app/v1/my/certificates`
- 新增 1 个 schema `AppMyCertificateDto`
- **0 修改** 既有 path / schema(含 admin certificates 8 path 完全不动)

---

## 10. E2E 测试矩阵

### 10.1 e2e spec 文件

- **新建**:`test/e2e/app-my-certificates.e2e-spec.ts`
- **预估**:~700-900 行(沿 P2-6 [app-my-attendance-records.e2e-spec.ts 955 行](../test/e2e/app-my-attendance-records.e2e-spec.ts) 范式)

### 10.2 必备用例矩阵(沿 D-P2-7-12 至少 15 项)

| # | 类别 | 用例 |
|---|---|---|
| 1 | 鉴权 | 未登录 → 401 `UNAUTHORIZED` |
| 2 | 准入 | admin-without-member(无 `memberId`)→ 403 `FORBIDDEN`(**不**沿 D-P2-3-1 例外) |
| 3 | 准入 | `Member.status = INACTIVE` → 403 `FORBIDDEN` |
| 4 | 准入 | `Member.deletedAt != null` → 403 `FORBIDDEN` |
| 5 | scope | admin-as-member(`role=ADMIN` + linked member)只看 linked member 自己的证书,**不**看别人 |
| 6 | scope | USER A 看不到 USER B 的证书(seed 2 USER + 各自 cert,A 登录读不到 B 的 row) |
| 7 | 状态可见性 | 本人 `pending` / `verified` / `expired` / `rejected` 4 态 row **全部可见**(沿 顶层 §12.2.8) |
| 8 | 软删 | 软删 cert(`deletedAt != null`)**不可见**(`notDeletedWhere` 等价) |
| 9 | filter | `?certStatusCode=verified` 仅返 verified;`?certStatusCode=invalid` → 400 `BAD_REQUEST`(`IsIn` 校验失败) |
| 10 | filter | `?certTypeCode=ARS_W` 仅返该 type;不存在 type → items=[] / total=0 |
| 11 | query 边界 | 未声明 query(`?memberId=xxx` / `?verifiedBy=xxx` / `?includeDeleted=true`)→ 400 `BAD_REQUEST`(`forbidNonWhitelisted`) |
| 12 | 字段集白名单 | `200 + Object.keys(items[0]).length === 12 + 字段名集合恰好等于 §5.1 表`;**不含** `memberId` / `verifiedBy` / `verifier` / `supersededByCertId` / `updatedAt` / `deletedAt` / `passwordHash` 等(逐项断言) |
| 13 | pagination | `page=1 / pageSize=20` 默认;`pageSize=101` → 400;`page=0` → 400;`page=2` 翻页正确 |
| 14 | sort | 默认 `orderBy createdAt desc`;seed 3 cert 不同 createdAt,断言响应数组顺序 |
| 15 | legacy admin 不破坏 | 旧 admin 8 endpoint(`GET .../v2/members/:memberId/certificates` / `POST ` / `GET .../qualification-flag` / `GET .../:id` / `PATCH .../:id` / `DELETE .../:id` / `PATCH .../:id/verify` / `PATCH .../:id/reject`)**响应字面不变**(D-P2-7-15;由 `test/e2e/certificates.e2e-spec.ts` 982 行既有覆盖 + P2-7 e2e 增补 1-2 个反向断言用例) |

### 10.3 测试 fixture

沿 [`test/e2e/certificates.e2e-spec.ts`](../test/e2e/certificates.e2e-spec.ts) 复用既有 helpers(`loginAs` / `seed dictionary cert_type+cert_sub_type+cert_status` / `seed member` / `seed certificate with status`);沿 P2-6 / P2-5a e2e 范式构造 admin-as-member + cross-member 隔离场景。

---

## 11. 禁止修改清单

### 11.1 严禁修改文件

| 文件 / 区域 | 理由 |
|---|---|
| `prisma/schema.prisma` / `prisma/migrations/*` | D-P2-7-11(0 schema / 0 migration) |
| `prisma/seed.ts` | D-P2-7-11(0 seed diff) |
| `src/modules/certificates/certificates.service.ts` | D-P2-7-9 + §11.1;**完全禁修改**(0 diff);**禁止**新增 `listForMember` 或任何 method;若发现 App service 自查不足,**必须**暂停回到对话另立 v0.2,**禁止**自行解锁 |
| `src/modules/certificates/certificates.controller.ts` | admin 8 endpoint 路径 / 装饰器 / `@Roles` / `@ApiBearerAuth` / Tag 全部不动(D-P2-7-15) |
| `src/modules/certificates/certificates.dto.ts` | admin DTO 7 个不动(D-P2-7-3 DTO 隔离) |
| `src/modules/users/*`(含 `app-identity.resolver.ts` / `app-capability.service.ts` / `users.module.ts` / 其余) | P2-1 已冻结;`AppIdentityResolver` 已 exports |
| `src/modules/activity-registrations/*` / `src/modules/activities/*` / `src/modules/attendances/*` | P2-4 / P2-5 / P2-6 已落地,不动 |
| `src/modules/auth/*` / `src/modules/permissions/*` / `src/modules/refresh-tokens/*` / `src/common/storage/*` | 业务范围之外 |
| `src/bootstrap/apply-swagger.ts` / `apply-global-setup.ts` | 顶层 §3.2 |
| `package.json` / `pnpm-lock.yaml` | 0 新依赖 |
| 所有 `/api/v2/*` 现有路径 / Phase 1A Swagger Tag / `/api/auth/*` 现状 | Phase 3 方案 C + 顶层 §3.2 |
| `Role` / `UserStatus` / `MemberStatus` enum / Permission seed / RbacRole | 顶层 §3.2 |
| `CLAUDE.md` / `AGENTS.md` | 本评审稿 docs-only;铁律修订归独立 PR |
| `docs/current-state.md` / `CHANGELOG.md` | 本 PR 不动;**P2-8 收尾**或后续 PR 回填(**禁止**混入本 PR;沿 §1.3) |
| Phase 1B `/api/auth/v1/*` / `/api/public/v1/*` alias | 独立通道(沿 §1.3);**禁止**混入本 PR |

### 11.2 BizCode 锁死

- ✅ **复用** `UNAUTHORIZED=40100` / `FORBIDDEN=40300` / `BAD_REQUEST=40000` / `INTERNAL_ERROR=50000`
- ❌ **不新增**任何 BizCode(沿 D-P2-7-11)
- ❌ **不开** `CERTIFICATE_NOT_FOUND` / `CERTIFICATE_NOT_BELONGS_TO_MEMBER` / `CERTIFICATE_TYPE_CODE_INVALID` 暴露给 App(本 endpoint 是只读列表,无单 row lookup;type filter 不存在 type → items=[]+200,**不**抛业务码)
- ⚠️ 若 implementation 发现 40300 不足以表达某场景,**必须**暂停回到对话,经用户拍板才允许新增 BizCode(默认不开)

---

## 12. Implementation 步骤(供 P2-7 implementation PR 用)

> **铁律**:本评审稿冻结后,P2-7 implementation PR 才允许立项。下列步骤仅供参考排序;**禁止**在 PR 内做超出本评审稿范围的工作。

1. 新建 `src/modules/certificates/dto/app/app-my-certificate.dto.ts`(§5.1 12 字段)
2. 新建 `src/modules/certificates/dto/app/list-app-my-certificates-query.dto.ts`(§6.1 4 字段)
3. 新建 `src/modules/certificates/app-my-certificates.service.ts`(§7.3 范式)
4. 新建 `src/modules/certificates/controllers/app-my-certificates.controller.ts`(§7.2 范式)
5. 修改 `src/modules/certificates/certificates.module.ts`:imports 增 `UsersModule`(取 `AppIdentityResolver`)、controllers 增 `AppMyCertificatesController`、providers 增 `AppMyCertificatesService`
6. 修改 `test/contract/openapi.contract-spec.ts`(§9.1 + §9.2 各增一行)
7. `pnpm test:contract -u` 重生 snapshot(§9.4)
8. 新建 `test/e2e/app-my-certificates.e2e-spec.ts`(§10.2 15 用例矩阵)
9. 跑通 `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:contract` / `pnpm test:e2e`(§14)

**例外退路**(沿 §7.4):字段争议 / 命名争议 / `certStatusCode` 4 态枚举与 Prisma 实际不一致 / admin-as-member 边界与 AppIdentityResolver 不符 → **暂停**回到对话,**禁止**自行扩字段或改既有文件。

---

## 13. 风险表 Top 9

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 误复用 / 继承 admin `CertificateResponseDto` 或 `CertificateListItemDto`(`extends` / `Pick` / `Omit` / Mapped Types) | **高** | DTO 物理独立 class;e2e 字段集严格 `Object.keys().length===12` 断言;snapshot diff review;代码 review 强查 `import .*Certificate(Response\|ListItem)Dto` 不出现在 App 文件 |
| R2 | 误改 `certificates.service.ts`(改既有签名 / 新增 `listForMember` / 任何 diff) | **高** | 沿 D-P2-7-9 + §11.1 完全禁修改;PR review 强查 `certificates.service.ts` **整文件 0 diff**;新增 method 必须先暂停回到对话另立 v0.2 |
| R3 | 误碰旧 admin `/v2/members/:memberId/certificates/*` 8 endpoint 行为 | **高** | PR review 强查 `certificates.controller.ts` / `certificates.dto.ts` 0 diff;e2e 用例 15 反向断言旧路径响应字面不变;`test/e2e/certificates.e2e-spec.ts` 982 行既有覆盖 + 增 1-2 个 P2-7 反向用例 |
| R4 | 跳过 `AppIdentityResolver` 直接用 `currentUser.memberId` 短路 | **高** | AppMy service 入口 `assertCanUseAppOrThrow` 强约束;e2e 2+3+4 三用例(admin-without-member / INACTIVE / 软删) |
| R5 | 误返 L2 跨 member 字段:`verifiedBy`(暴露审核人身份)/ `verifier`(嵌套审核人 Member)/ `member` 嵌套 / `supersededBy(Cert)` 嵌套链路 | **高** | `appSelect` 严格 12 字段白名单(不含 `include` / 不含关联 row);snapshot freeze;e2e 用例 12 逐字段反向断言;沿 Phase 0.6 §6.5 |
| R6 | 实时 `expiredAt < now()` 映射为 `expired` 状态(造成 App / Admin 双权威源漂移) | **高** | sealed by D-P2-7-6;`appSelect` 直返 `certStatusCode` 持久态;e2e 用例 7 断言 4 态 row 持久值不变 |
| R7 | 误新增 BizCode(`CERTIFICATE_NOT_FOUND` / `MY_CERTIFICATE_FORBIDDEN`)或忘更 `EXPECTED_ROUTES` / `EXPECTED_SCHEMAS` | 中 | sealed by D-P2-7-11 + §11.2;PR review 强查 `biz-code.constant.ts` diff = 0;`pnpm test:contract` 白名单全等断言 + snapshot diff 兜底 |
| R8 | admin-as-member 边界:linked-admin 拿到自己证书 ≠ 其它管理证书(意外 scope 扩大) | 中 | service 入口锁 `memberId = access.member.id`(沿 AppIdentityResolver);e2e 用例 5 强校验 |
| R9 | diff > 400 行(突破顶层 §8.1 P2-7 < 400 行软上限) | 低 | e2e ~700-900 行不计入 PR 主代码;主代码(controller + service + DTO × 2 + module diff)预估 < 280 行 |

---

## 14. 自查命令(P2-7 implementation PR 用)

### 14.1 必跑命令

- **A 档**:`pnpm lint` / `pnpm typecheck` / `pnpm test`(unit) / `pnpm test:contract -u`(修 DTO/Controller 后) / `pnpm test:contract` / `pnpm test:e2e` — 全部在提 PR 前跑通
- **B 档**:启服务后访 `/api/docs` 检查新 endpoint 在 `Mobile - My Certificates` Tag;`curl -H "Authorization: Bearer …" .../my/certificates` 手工抽测本人 200 / scope-self 仅本人 / DISABLED 401 / admin-without-member 403

### 14.2 禁止命令

- ❌ `pnpm prisma migrate dev` / `migrate deploy` / `db push`(沿 D-P2-7-11)
- ❌ `pnpm add` / `pnpm remove` 任何依赖

### 14.3 前置 grep 复核

implementation PR 启动前在新代码搜:
- `grep -nE "CertificateResponseDto|CertificateListItemDto" src/modules/certificates/app-my-certificates.service.ts src/modules/certificates/controllers/app-my-certificates.controller.ts src/modules/certificates/dto/app/`(必须无命中)
- `grep -nE "extends|Pick<|Omit<|IntersectionType|PartialType|OmitType" src/modules/certificates/dto/app/`(必须仅 `extends PaginationQueryDto`)
- `grep -n "@Roles" src/modules/certificates/controllers/app-my-certificates.controller.ts`(必须无命中)
- `grep -n "memberId" src/modules/certificates/dto/app/app-my-certificate.dto.ts`(必须无命中)
- `grep -n "listForMember\|certificates.service" src/modules/certificates/app-my-certificates.service.ts`(必须无命中)

---

## 15. PR 验收标准

### 15.1 本评审稿 docs-only PR(A 档)

- **范围**:本评审稿 1 文件
- **diff**:仅新增 1 个 `docs/app-api-p2-7-my-certificates-review.md`
- **0 src / 0 prisma / 0 migration / 0 test / 0 package.json / 0 workflow / 0 .env.example 变更**
- **不动**:`CLAUDE.md` / `AGENTS.md` / `docs/current-state.md` / `CHANGELOG.md` / Phase 2 顶层评审稿 / P2-1~P2-6 评审稿
- **commit message**:`docs(app): add P2-7 App my-certificates implementation review`
- **PR title**:同上
- **验收**:A 档(`pnpm lint` / `pnpm typecheck` 不需要,纯 docs)

### 15.2 P2-7 implementation PR(C 档,后续独立立项)

- **范围**:1 endpoint + 4 新文件 + 2 修改文件(module + contract spec)+ 1 e2e + 1 snapshot 更新
- **依赖前置**:本评审稿合入后才允许立项
- **commit message**:`feat(app): add App my-certificates endpoint (P2-7)`
- **PR title**:同上
- **验收**:A 档全套 + B 档手工验证(详 §14)
- **diff 上限**:主代码 < 400 行;e2e 单独计

### 15.3 不混档铁律

- ❌ **禁止**把评审稿与 implementation 揉进同一 PR
- ❌ **禁止**在 implementation PR 内"顺手"扩字段(沿 §5 字段集冻结;**字段争议必须暂停回到对话**,不得擅扩)
- ❌ **禁止**在 implementation PR 内顺手做 **P2-8 收尾** / **Phase 1B alias** / 任何其它工作
- ❌ **禁止**回填 `docs/current-state.md` / `CHANGELOG.md`(留 P2-8)

---

## 16. 元信息

**状态机**:草案 v0.1(本文件)✅ → 用户拍板冻结 ⏳ → docs-only PR 合入 ⏳ → implementation PR 立项 ⏳ → P2-7 完成(e2e 全绿)⏳ → P2-8 docs 收尾(独立 PR)⏳。

**冻结后修订**:沿 [`docs/process.md §6`](process.md),评审稿冻结后**不回改**;implementation 发现需修订必须先回对话说明,经用户同意后另开 v0.2,本文件保留 v0.1。

**撰写边界**:本评审稿**不**修改顶层 Phase 2 / P2-1~P2-6 评审稿 / Phase 0.5~0.7 评审稿 / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/current-state.md`](current-state.md) / [`CHANGELOG.md`](../CHANGELOG.md);current-state / CHANGELOG 回填留 P2-8 收尾 PR。

**草案 v0.1 完。等待用户拍板。**
