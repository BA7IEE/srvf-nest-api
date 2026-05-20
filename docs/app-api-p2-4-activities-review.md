# SRVF App API P2-4 Activities Review

> **状态**:v0.1(2026-05-20;v0 同日 PR #149 v0.1 修订:D-P2-4-1 / D-P2-4-5 锁定 + DTO 收窄)
> **范围**:`GET /api/app/v1/activities/available` + `GET /api/app/v1/activities/:id` 两个浏览类只读端点
> **性质**:**P2-4 implementation review**(不是实现任务 / 不是代码改造 / 不是 migration)
> **冲突优先级**(沿 [`docs/srvf-foundation-baseline.md §14.4`](srvf-foundation-baseline.md)):
> v1 §1-§17 / V1.1 §17 / V2 §18 / baseline / 红线 / [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) / [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) / [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) / [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) > **本评审稿(§1-§16)**
> 冲突时本稿让步,**不擅自调和**。
>
> **前置必读**(实施 PR 启动前):
> 1. [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md)(Phase 2 顶层评审稿)
> 2. [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md)(P2-2 章节骨架 + DTO 命名 + AppIdentityResolver 范式)
> 3. [`docs/app-api-p2-3-password-review.md`](app-api-p2-3-password-review.md)(P2-3 helper 范式 + 独立 PR 拆分决议)
> 4. [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)(D-5.1 ~ D-5.4)
> 5. [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md)(L1 ~ L8 + scope 默认 self)
> 6. [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md)(Presenter / QueryService / FieldPolicy 边界)

---

## 0. TL;DR(11 条)

1. **范围严格 2 端点**:`GET /api/app/v1/activities/available`(可参加活动列表 + 分页) + `GET /api/app/v1/activities/:id`(活动详情)。**不**实现报名 / 我的活动 / 报名记录 / 取消报名 / 考勤 / 证书 / tasks / managed。
2. **D-P2-4-1 = A(v0.1 锁定)**:App 可见集严格 `statusCode='published' AND deletedAt IS NULL`。`draft` / `cancelled` / `completed` / `deletedAt!=null` 一律对 App **不可见**;`/:id` 命中不可见 → **404**(沿现有 v2 USER `findOne` Q-A7 范式,避免存在性泄漏)。**不再保留**对齐 v2 USER 含 `completed` 的备选方案 C 切换路径。`completed` / `cancelled` 历史归未来 `/api/app/v1/my/activities`(P2-5),**不**通过 P2-4 端点暴露。
3. **复用 AppIdentityResolver 强约束**:`JwtAuthGuard` + `canUseApp=true`(即 `memberId != null` AND `Member.status=ACTIVE` AND `Member.deletedAt IS NULL`);沿 P2-2 范式,**不**沿 P2-3 admin-without-member 例外。Admin 兼队员按 linked member self perspective(沿 D-5.2)。**Admin without member → FORBIDDEN(40300)**。
4. **DTO 严格反 Admin 复用 + v0.1 收窄**(沿 D-7 + Phase 0.7 §2.2):新建 `AppAvailableActivityListItemDto`(**11 字段**;v0 15 → v0.1 11)+ `AppActivityDetailDto`(**13 字段**;v0 22 → v0.1 13)。**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 任一 Admin DTO(`ActivityListItemDto` / `ActivityResponseDto`)。
5. **Service 强制独立 method**(沿 phase-2-review.md §2 + 风险表 10.5):新建 `AppActivitiesService` + 方法 `listAvailableForMember(memberId, query)` + `findVisibleByIdForMember(id, memberId)`;**禁止**调用 `ActivitiesService.list` / `ActivitiesService.findOne`。
6. **Presenter 内嵌私有方法**(沿 Phase 0.7 §13.3 P0/P1 过渡):P2-4 第一版 `AppActivitiesService` 内私有 `toListItemDto` / `toDetailDto` 完成 Prisma row → App DTO 映射,**不**新建独立 `AppActivityPresenter` 类(第二次复用即"P2-5+ 重复需求出现"再抽)。
7. **Query 严格白名单 2 参数**:`page` / `pageSize`(沿 `PaginationQueryDto`)。**不**接收 `statusCode` / `activityTypeCode` / `keyword` / 任何 date range 字段;客户端**无法**通过参数绕过 `published` 可见性。`activityTypeCode` / `keyword` / date range 留 P2-5+ 评审稿决议。
8. **零新增 BizCode**:全部复用既有(`UNAUTHORIZED=40100` / `FORBIDDEN=40300` / `ACTIVITY_NOT_FOUND=20001` / `BAD_REQUEST=40000`)。**禁止**新开 `APP_*` 段位 / `ACTIVITY_NOT_VISIBLE` / `ACTIVITY_HIDDEN`。
9. **不返回报名状态 / hint / capabilities**:沿 §4 决议 D-P2-4-2 = A 档。`canRegister` / `myRegistrationStatus` / `myRegistrationId` / `registeredCount` 全部**留 P2-5**(报名相关本就是 P2-5+ 范围,避免越界把 P2-5 数据夹带进来)。
10. **D-P2-4-5 = split(v0.1 锁定)**:**强制拆 P2-4a(list) + P2-4b(detail) 两 PR**;v0 备选"单 PR > 500 行"方案 A **关闭**。P2-4a 合入后 P2-4b 才允许立项。
11. **零变更 `/api/v2/activities*`**:旧 7 个 admin endpoint 行为**逐字不变**(沿 phase-2-review.md §3.2 + migration-plan §5 方案 C);P2-4 新增 2 path **不**改老 Controller / DTO / Service / 权限 / Tag。

---

## 1. 最终 endpoint 设计

| Method | Path | Purpose | Surface | Scope | Auth | DTO 出参 | DTO 入参 | Service / Presenter | Risk Level |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/app/v1/activities/available` | App 视角可参加活动列表(分页) | mobile | self(隐式:visible-to-current-member;published only) | `JwtAuthGuard` + `AppIdentityResolver.resolve` + `assertCanUseApp` | `PageResultDto<AppAvailableActivityListItemDto>` | `PaginationQueryDto`(page / pageSize) | `AppActivitiesService.listAvailableForMember(memberId, query)` + 私有 `toListItemDto` | **高(新逻辑)** |
| GET | `/api/app/v1/activities/:id` | App 视角活动详情 | mobile | self(隐式;published only) | `JwtAuthGuard` + `AppIdentityResolver.resolve` + `assertCanUseApp` | `AppActivityDetailDto` | `IdParamDto`(沿 CLAUDE.md §11) | `AppActivitiesService.findVisibleByIdForMember(id, memberId)` + 私有 `toDetailDto` | 中(DTO 隔离) |

**Controller**:**新建** `src/modules/activities/controllers/app-activities.controller.ts`(沿 P2-1 `app-me.controller.ts` 目录范式);**禁止**追加方法到既有 `ActivitiesController`(沿 phase-2-review.md §3.2 不动 admin controller)。

**模块归属**:`ActivitiesModule`(`src/modules/activities/activities.module.ts`)追加 `AppActivitiesController` + `AppActivitiesService` provider。**禁止**新建 `AppActivitiesModule`(避免模块爆炸;沿 §8 决议)。

---

## 2. 活动可见性规则(D-P2-4-1)

### 2.1 现状

- v2 既有规则(沿 [`src/modules/activities/activities.service.ts:50-51`](../src/modules/activities/activities.service.ts) + Q-A7):**USER 角色**可见 `statusCode ∈ {published, completed}`;`draft` / `cancelled` → list 不返、detail → 404
- ADMIN / SUPER_ADMIN 看全 4 态
- `deletedAt != null` 对任何角色不返(沿 `notDeletedWhere`)
- 状态字典 4 态闭集(沿 [`activities.service.ts:45-48`](../src/modules/activities/activities.service.ts)):`draft` / `published` / `cancelled` / `completed`

### 2.2 App 可见性候选方案

| 方案 | `/available` 列表 | `/:id` 详情 | 与 v2 USER 一致性 | 评估 |
|---|---|---|---|---|
| A | `published` only | `published` only | 比 v2 USER **更严**(去掉 completed) | ✅ **推荐**:App 是"我现在能做什么"视图,`completed` 已不可报名,不属于"可参加"语义;`/available` 名词性已暗示"可参加",completed 进列表反而误导;详情同步严格,保持端点语义一致 |
| B | `published` only | `published` + `completed` | 列表与详情 split | ❌ 不推荐:列表与详情语义分裂;前端从列表打开详情后又出现"已完成"卡片困惑 |
| C | `published` + `completed` | `published` + `completed` | 与 v2 USER 完全对齐 | ⚠️ 备选:与 v2 USER 字面一致便于联调;但 `/available` 字面含义偏差,且 `completed` 详情在 App 端价值低(无报名 / 无操作);若后续需要"历史活动回顾"应走 `/my/activities`(P2-5+) |
| D | published + cancelled(已报名者) + completed(已参加者) | 同 | 复杂度高 | ❌ 不推荐:本期未实现 `/my/registrations`(P2-5+),无法判断"已报名"/"已参加";会把 P2-5 数据查询提前 |

### 2.3 决议 D-P2-4-1 = A(v0.1 锁定)

**锁定**:`/available` 与 `/:id` **一律仅** `statusCode='published' AND deletedAt IS NULL` 可见;`draft` / `cancelled` / `completed` / 软删在 App 端表现为"不存在"(`/:id` → 404)。

**v0.1 修订要点**:
- 从"v0 待拍板,推荐 A"升级为**已锁定**;v0 备选方案 C(对齐 v2 USER 含 `completed`)**关闭**,不再保留切换路径
- `completed` / `cancelled` 历史活动归未来 `/api/app/v1/my/activities`(P2-5),按本人 member 数据视角拉取;P2-4 端点**不**作为历史回顾入口

**锁定理由**:
- `/available` 字面语义 = "我现在可参加的活动",`completed` / `cancelled` 已不可报名,语义上不属于"可参加"
- 单一可见集合简化前端心智模型(列表 = 详情可见集 = `published`)
- 历史 / 已结束活动展示职责清晰划归 P2-5 `/my/activities`(按 member registration 反查),P2-4 与 P2-5 端点职责正交
- 与 v2 USER `completed` 可见的差异属于**端点语义差异**,不属于 v2 行为破坏(v2 `/api/v2/activities*` 不改)
- 沿 v2 既有 404 范式:`/:id` 命中不可见 → `BizException(ACTIVITY_NOT_FOUND)`(20001 / HTTP 404),避免存在性泄漏

**反向**(永不解锁):
- `draft` 永不对 App 可见(沿 v2 Q-A7 + Phase 0.6 §4.3)
- `deletedAt != null` 永不对 App 可见(沿 CLAUDE.md §10 + lifecycle §3.2)
- `cancelled` / `completed` 永不通过 P2-4 端点对 App 可见(历史回顾归 P2-5)
- 不引入"App 端 cancelled 仅已报名者可见"(P2-5+ 评估)
- 不引入"draft 创建者可见"(App 端无活动创建职责)
- **不**为切换至"含 completed"重开 D-P2-4-1;若 P2-5+ 出现历史展示诉求,应通过 `/my/activities` 解决,**不**修改 `/available` / `/:id` 可见集

---

## 3. 报名资格 / capabilities 是否在 P2-4 返回(D-P2-4-2)

### 3.1 候选方案

| 选项 | `/available` 单项是否含 `canRegister` | 详情是否含 `myRegistrationStatus` | 详情是否含 `registeredCount` | 评估 |
|---|---|---|---|---|
| A | ❌ 不返 | ❌ 不返 | ❌ 不返 | ✅ **推荐**:P2-4 是纯浏览,不依赖任何 `ActivityRegistration` 查询;diff 最小;无越界到 P2-5;前端报名按钮状态在 P2-5 拉取 `/my/registrations` 列表后映射 |
| B | ✅ minimal `canRegister: boolean` | ✅ `myRegistrationStatus: 'pending'\|'pass'\|'reject'\|'cancelled'\|null` | ❌ | ⚠️ 备选:给前端按钮状态;但需在 service 内为每项再 query 一次 `activityRegistration`,n+1 风险;且 `canRegister` 计算逻辑(`isPublicRegistration` + 报名截止 + 容量未满 + 性别符合 + 未已报名)复杂,本质是 PolicyService 职责,会把 P2-5 政策判断逻辑提前到 P2-4 |
| C | ✅ + ✅ + ✅ `registeredCount: number` | 同 B | ✅ | ❌ 不推荐:`registeredCount` 需对每条列表项再 count 一次 `activityRegistration`(20 项 = 20 次 count query;沿 [`activity-registrations.service.ts:264`](../src/modules/activity-registrations/activity-registrations.service.ts) 范式);P2-4 性能开销 + 强耦合到 P2-5 数据模型;若必要应在 schema 层加 denormalized 字段(P2-5+ 评估) |

### 3.2 决议 D-P2-4-2(待用户拍板)

**推荐方案 A**:P2-4 端点 zero registration-related field。

**理由**:
- P2-4 的职责是"让 App 看到有什么活动",报名状态属于"我和这个活动的关系",归 `/my/registrations` / `/my/activities`(P2-5+)
- `canRegister` 是 capability(沿 [`docs/app-permission-boundary-review.md §10.2 D-5.3`](app-permission-boundary-review.md));P2-1 `GET /me/capabilities` 已暴露 product-level `canRegisterActivity: boolean`(沿 [`src/modules/users/dto/app/app-capability-response.dto.ts:34`](../src/modules/users/dto/app/app-capability-response.dto.ts));**单活动级别**的 canRegister 不在 P2-4 范围,属于 P2-5 PolicyService 职责
- `registeredCount` 是运营数据(L2;沿 [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md)),App 端是否暴露需运营评估(隐含名额竞争压力);P2-4 不预判
- 沿 phase-2-review.md §6 + §11.3 风险表 10.5 + Phase 0.7 §6 P0 边界:**新工作 boundary-aware**,P2-4 不夹带 P2-5 数据访问层 / 业务逻辑层

**反向**(永不解锁):
- P2-4 不返回 `passCount` / `pendingCount` / 已通过 / 已驳回任何 registration 维度的聚合数字
- P2-4 不返回 `attendanceRecordsCount` / 任何 attendance 维度字段

---

## 4. App Activity List DTO 设计(`AppAvailableActivityListItemDto`)

### 4.1 字段集(v0.1 锁定 11 项)

> **v0.1 收窄**(2026-05-20):从 v0 的 15 项收窄到 11 项;移除 `organizationId` / `genderRequirementCode` / `isPublicRegistration` / `description` 共 4 项(理由见 §4.2)。字段名沿真实 Prisma schema(`startAt` / `endAt`,**非** `startTime` / `endTime`)。

| 字段 | 类型 | 必返 / 可空 | 来源 | App 必要性 |
|---|---|---|---|---|
| `id` | `string` | 必返 | `Activity.id`(cuid) | 详情跳转必需 |
| `title` | `string` | 必返 | `Activity.title` | 列表主标题 |
| `activityTypeCode` | `string` | 必返 | `Activity.activityTypeCode` | 类型展示;label 由前端字典 map(沿 v2 范式) |
| `statusCode` | `string` | 必返 | `Activity.statusCode` | 状态展示;App 端永远 = `'published'`(沿 D-P2-4-1),保留字段便于前端泛化 |
| `startAt` | `Date` | 必返 | `Activity.startAt` | 起始时间展示 + 排序参考 |
| `endAt` | `Date` | 必返 | `Activity.endAt` | 结束时间展示 |
| `location` | `string` | 必返 | `Activity.location` | 地点展示(自由文本) |
| `capacity` | `number \| null` | 可空 | `Activity.capacity` | 名额展示;null = 不限名额 |
| `registrationDeadline` | `Date \| null` | 可空 | `Activity.registrationDeadline` | 报名截止;null = 不限 |
| `coverImageUrl` | `string \| null` | 可空 | `Activity.coverImageUrl` | 列表封面;裸 URL 字符串(**非** signed URL,**非 L3**) |
| `createdAt` | `Date` | 必返 | `Activity.createdAt` | 排序参考 |

### 4.2 明确不返字段(v0.1 锁定 17 项)

> **v0.1 新增不返**:`organizationId` / `genderRequirementCode` / `isPublicRegistration` / `description` 从 v0 List 移除(P2-4 第一版仅核心展示;详情或 P2-5+ 出现实际诉求再评估)。

| 字段 | 来源 | 不返理由 |
|---|---|---|
| `description` | `Activity.description` | **v0.1 收窄**:列表暂仅核心字段;若产品需要列表摘要,在 P2-5+ 实测后基于真实诉求评估 |
| `organizationId` | `Activity.organizationId` | **v0.1 收窄**:App 端列表不展示承办组织(列表已有 title / 类型 / 时间 / 地点足以决策);若产品需要,P2-5+ 评估返 `organizationId` 还是 `organizationName` 派生字段 |
| `genderRequirementCode` | `Activity.genderRequirementCode` | **v0.1 收窄**:性别要求是报名时校验项(归 PolicyService / P2-5);列表展示价值低,移除避免误导前端"作为筛选条件" |
| `isPublicRegistration` | `Activity.isPublicRegistration` | **v0.1 收窄**:App 当前不接非公开报名场景(P2-4 v0.1 默认 published 都对 App 公开);若未来引入"非公开活动定向投放",归 P2-5+ |
| `deletedAt` | `Activity.deletedAt` | 沿 v2 `activityListItemSelect` 永不返;CLAUDE.md §10 |
| `publishedBy` | `Activity.publishedBy` | 内部 User.id;App 不展示发布人 |
| `publishedAt` | `Activity.publishedAt` | 内部 audit;App 看 createdAt / startAt 即可 |
| `cancelledBy` | `Activity.cancelledBy` | App 不见 cancelled |
| `cancelledAt` | `Activity.cancelledAt` | 同上 |
| `cancelReason` | `Activity.cancelReason` | App 不见 cancelled |
| `registrationNotes` | `Activity.registrationNotes` | 列表精简;详情返(沿 v2 `activityListItemSelect` 排除 + `activitySafeSelect` 返) |
| `registrationSchema` | `Activity.registrationSchema` | 列表精简;详情亦不返(沿 §5 v0.1 收窄) |
| `galleryImageUrls` | `Activity.galleryImageUrls` | 列表精简;详情亦不返(沿 §5 v0.1 收窄) |
| `content` | `Activity.content` | 列表精简;详情亦不返(沿 §5 v0.1 收窄) |
| `locationLongitude` | `Activity.locationLongitude` | 列表 + 详情均不返(v0.1 收窄;App 端暂无地图集成) |
| `locationLatitude` | `Activity.locationLatitude` | 同上 |
| `updatedAt` | `Activity.updatedAt` | 列表 + 详情均不返(v0.1 收窄) |

> **注**:与 v2 `activityListItemSelect` 差异:P2-4 列表**不返** `organizationId` / `description` / `genderRequirementCode` / `isPublicRegistration` / `locationLongitude` / `locationLatitude`。这是 App DTO 独立设计选择(D-7),**不是** v2 行为变更;v2 `/api/v2/activities` 行为逐字不变。

### 4.3 字段隔离铁律

- ❌ **禁止** `class AppAvailableActivityListItemDto extends ActivityListItemDto {}`
- ❌ **禁止** `class AppAvailableActivityListItemDto extends OmitType(ActivityListItemDto, [...] as const) {}`
- ❌ **禁止** `class AppAvailableActivityListItemDto extends PickType(ActivityListItemDto, [...] as const) {}`
- ❌ **禁止** `class AppAvailableActivityListItemDto extends IntersectionType(...)`
- ❌ **禁止** `class AppAvailableActivityListItemDto extends PartialType(ActivityListItemDto) {}`
- ✅ **必须**独立 class 字段集逐字声明,带 `@ApiProperty` / `@ApiPropertyOptional` 各自描述
- ✅ Decimal 字段(若详情返)按 v2 `decimalToString` 范式返 `string \| null`

### 4.4 文件归属

- `src/modules/activities/dto/app/app-available-activity-list-item.dto.ts`(单 class;沿 P2-2 `src/modules/users/dto/app/app-self-profile.dto.ts` 目录范式)
- 不复用 `src/modules/activities/activities.dto.ts`(Admin DTO 文件)

---

## 5. App Activity Detail DTO 设计(`AppActivityDetailDto`)

### 5.1 字段集(v0.1 锁定 13 项)

> **v0.1 收窄**(2026-05-20):从 v0 的 22 项收窄到 13 项。详情在 List 11 项基础上**仅追加** 2 项(`description` + `registrationNotes`);移除 v0 设计中的 `registrationSchema` / `galleryImageUrls` / `content` / `locationLongitude` / `locationLatitude` / `updatedAt` / `organizationId` / `genderRequirementCode` / `isPublicRegistration` 共 9 项。字段名沿真实 Prisma schema(`startAt` / `endAt` / `cancelReason`,**非** `startTime` / `endTime` / `cancelledReason`)。

| 字段(全量) | 类型 | 必返 / 可空 | 来源 | List 项? | 详情新增? |
|---|---|---|---|---|---|
| `id` | `string` | 必返 | `Activity.id` | ✅ | |
| `title` | `string` | 必返 | `Activity.title` | ✅ | |
| `description` | `string \| null` | 可空 | `Activity.description` | ❌ | ✅ **v0.1 详情专有** |
| `activityTypeCode` | `string` | 必返 | `Activity.activityTypeCode` | ✅ | |
| `statusCode` | `string` | 必返 | `Activity.statusCode` | ✅ | |
| `startAt` | `Date` | 必返 | `Activity.startAt` | ✅ | |
| `endAt` | `Date` | 必返 | `Activity.endAt` | ✅ | |
| `location` | `string` | 必返 | `Activity.location` | ✅ | |
| `capacity` | `number \| null` | 可空 | `Activity.capacity` | ✅ | |
| `registrationDeadline` | `Date \| null` | 可空 | `Activity.registrationDeadline` | ✅ | |
| `registrationNotes` | `string \| null` | 可空 | `Activity.registrationNotes` | ❌ | ✅ **v0.1 详情专有** |
| `coverImageUrl` | `string \| null` | 可空 | `Activity.coverImageUrl` | ✅ | |
| `createdAt` | `Date` | 必返 | `Activity.createdAt` | ✅ | |

### 5.2 明确不返字段(v0.1 锁定 13 项)

> **v0.1 新增不返**:`registrationSchema` / `galleryImageUrls` / `content` / `locationLongitude` / `locationLatitude` / `updatedAt` / `organizationId` 共 7 项从 v0 详情移除;沿 §4.2 List 已不返的 `genderRequirementCode` / `isPublicRegistration` 详情同样不返;**注意** v0 草案 `cancelledReason` 是笔误,真实 schema 字段名为 `cancelReason`。

| 字段 | 来源 | 不返理由 |
|---|---|---|
| `registrationSchema` | `Activity.registrationSchema`(Json) | **v0.1 收窄**:报名表自定义字段属报名流程数据,归 P2-5 `POST /my/registrations` 入参 schema 拉取;P2-4 浏览不需要 |
| `galleryImageUrls` | `Activity.galleryImageUrls`(Json) | **v0.1 收窄**:相册展示是 nice-to-have;App 端封面 `coverImageUrl` 已满足列表 + 详情主图;相册若产品确需,P2-5+ 立项时同步评估 signed URL / CDN 优化 |
| `content` | `Activity.content`(Json) | **v0.1 收窄**:富正文 Json 结构 App 端解析复杂(前端 / 小程序约定不同);P2-4 v0.1 以 `description` 满足摘要;若 App 端引入富文本渲染,P2-5+ 评估返 `content` + 前端 schema 协议版本号 |
| `locationLongitude` | `Activity.locationLongitude`(Decimal) | **v0.1 收窄**:App 端暂无地图集成(地图组件需小程序额外授权 + iOS / Android 地图 SDK);若产品出地图需求,P2-5+ 单独立项(含坐标系换算 WGS84 → GCJ02 / BD09) |
| `locationLatitude` | `Activity.locationLatitude`(Decimal) | 同上 |
| `updatedAt` | `Activity.updatedAt` | **v0.1 收窄**:App 浏览端不需要 updatedAt(无缓存对比 / 增量同步语义) |
| `organizationId` | `Activity.organizationId` | **v0.1 收窄**:同 §4.2;App 详情仅展示活动本身,承办组织展示归 P2-5+ |
| `genderRequirementCode` | `Activity.genderRequirementCode` | **v0.1 收窄**:同 §4.2;报名期 PolicyService 校验,详情不展示 |
| `isPublicRegistration` | `Activity.isPublicRegistration` | **v0.1 收窄**:同 §4.2 |
| `deletedAt` | `Activity.deletedAt` | 永不返 |
| `publishedBy` | `Activity.publishedBy` | 内部 User.id;App 不展示发布人(后续若运营要求,P2-5+ 评审引入 `organizer` 派生字段 = `publisher.nickname`,**禁止**裸返 User.id) |
| `publishedAt` | `Activity.publishedAt` | 内部 audit |
| `cancelledBy` | `Activity.cancelledBy` | App 不见 cancelled |
| `cancelledAt` | `Activity.cancelledAt` | 同上 |
| `cancelReason` | `Activity.cancelReason`(**注意**真实字段名是 `cancelReason` 非 `cancelledReason`) | 同上 |

> **注**:由于 D-P2-4-1 锁定方案 A 严格只允许 `published`,`cancelled*` / `publishedBy/At` 在 App 不会出现非 null 值,但**依然显式排除字段本身**,避免未来若误增 controller / Presenter 时遗漏字段裁剪。

### 5.3 富文本 / XSS 安全

- `description` / `registrationNotes` / `coverImageUrl` 全部**原样返回**(沿 v2 `ActivityResponseDto` 范式;后端不解析 / 不渲染)
- **v0.1 范围缩减后**,`registrationSchema` / `galleryImageUrls` / `content` Json 字段**不返**,XSS / Json 注入面进一步收窄
- **不**在 P2-4 引入 HTML sanitize / DOMPurify / 任何 XSS 防御层:沿 v2 已有范式 + App 端是原生 / 小程序客户端,渲染富文本时由前端各自处理 markdown / HTML / 富文本协议
- **不**对 URL 做 SSRF 校验:`coverImageUrl` 是创建活动时管理员录入的可信内容(沿 v2 `CreateActivityDto.coverImageUrl` 仅 `@IsString() + @MaxLength(512)` 校验);若担心,在 P2-5+ 评估后端 URL 白名单(图床域名)

### 5.4 字段隔离铁律

同 §4.3(对 `ActivityResponseDto` 同样禁止任何继承 / 裁剪关键字)。

### 5.5 文件归属

- `src/modules/activities/dto/app/app-activity-detail.dto.ts`(单 class)

---

## 6. Identity / Access 规则

### 6.1 准入硬约束

| 检查项 | 来源 | 失败行为 |
|---|---|---|
| `JwtAuthGuard.canActivate` | 全局 Guard(沿 CLAUDE.md §8) | token 无效 / 过期 / user 软删 / DISABLED → `UNAUTHORIZED=40100` / HTTP 401(沿 `JwtStrategy.validate`) |
| `AppIdentityResolver.resolve(currentUser).canUseApp === true` | [`src/modules/users/app-identity.resolver.ts:28`](../src/modules/users/app-identity.resolver.ts) | `false` → `BizException(FORBIDDEN)` / HTTP 403(沿 P2-2 §6.1 范式;**禁止**返 200 + 空 list) |

### 6.2 admin-without-member 处理

- 沿 D-5.2 + P2-2 §5.4:Admin 无 `memberId` 关联 → `canUseApp=false`(reason=`MEMBER_NOT_LINKED`) → P2-4 抛 `FORBIDDEN`
- **不**沿 P2-3 D-P2-3-1 admin-without-member 例外(沿 [`docs/app-api-p2-3-password-review.md §4.6`](app-api-p2-3-password-review.md)):该例外**严格仅** `PUT /api/app/v1/me/password` 适用,**禁止**扩散到 P2-4(活动列表是 member-domain 业务数据,与账号级改密语义完全不同;Admin 无 member 关联看"我可参加的活动"无意义)

### 6.3 admin-as-member 处理

- 沿 D-5.2:`ADMIN` / `SUPER_ADMIN` 有 `memberId != null` 且 member ACTIVE → `canUseApp=true` → P2-4 走**linked-member self perspective**
- 看到的活动 = 与普通 `USER` 兼队员看到的活动**完全一致**(沿 D-5.2:App API 永远靠 `currentUser.memberId` 锁定本人范围,**不**因 role 扩大范围)
- 例:Admin 兼队员调 `/available` 不会看到 `draft` 或 `cancelled`(那是 admin 管理后台 `/api/v2/activities` 职责)

### 6.4 Member status 检查

- `AppIdentityResolver.resolve` 已统一处理(沿 [`app-identity.resolver.ts:36-45`](../src/modules/users/app-identity.resolver.ts)):member 不存在 / `deletedAt!=null` → reason=`MEMBER_DELETED`;`status!=ACTIVE` → reason=`MEMBER_INACTIVE`
- P2-4 仅检查 `canUseApp`,**不**单独区分 reason(沿 P2-2 §6.1 范式;所有失败统一 FORBIDDEN)
- reason 信息在 `GET /me/capabilities`(P2-1)已通过 `account.reason` 字符串暴露给前端,P2-4 不重复

### 6.5 数据可见性 scope = visible-to-current-member

- 沿 Phase 0.6 §3.3 Mobile API 默认 `scope = self`
- P2-4 具体表现:`AppActivitiesService.listAvailableForMember(memberId, query)` 的 `where` 子句**不**用 `memberId` 直接过滤活动(活动本身不归属单一 member);scope 表现为"全员可见的 published 活动"——本质上 P2-4 是"all members 共享 published 活动池"的 self perspective(每个 member 看到的可见集相同,但每个 member 是从自己视角看)
- 实施铁律:**禁止**在 service 内出现 `if (currentUser.role === ADMIN) where.deletedAt = undefined` / `if (role === USER) ...` / 任何 role 短路;`where` 完全独立于 role,固定 `{ statusCode: 'published', deletedAt: null }`(沿 D-5.2)

---

## 7. BizCode / 404 vs 403 策略(D-P2-4-3)

### 7.1 BizCode 策略(零新增)

| 场景 | BizCode | code | HTTP | 来源 |
|---|---|---|---|---|
| 未携带 / 无效 / 过期 access token | `UNAUTHORIZED` | 40100 | 401 | 沿 `JwtStrategy.validate` |
| user 软删 / `status=DISABLED` | `UNAUTHORIZED` | 40100 | 401 | 沿 `JwtStrategy.validate` |
| `canUseApp=false`(member 未关联 / 未激活 / 软删) | `FORBIDDEN` | 40300 | 403 | 沿 P2-2 §6.1;**新逻辑由本评审稿 §6.1 锁定** |
| `:id` 命中 `draft` / `cancelled` / `completed` / `deletedAt!=null` / 不存在 | `ACTIVITY_NOT_FOUND` | 20001 | 404 | 沿 v2 `findOne` Q-A7 + 现有 [`biz-code.constant.ts:378-382`](../src/common/exceptions/biz-code.constant.ts) |
| `IdParamDto` 校验失败(id 长度不符 / 非字符串) | `BAD_REQUEST` | 40000 | 400 | 沿全局 `ValidationPipe` |
| `PaginationQueryDto` 校验失败 | `BAD_REQUEST` | 40000 | 400 | 同 |
| `pageSize` > 100 | `BAD_REQUEST` | 40000 | 400 | 沿 `PaginationQueryDto.@Max(100)`(若未配置即沿 CLAUDE.md §4 默认) |
| `forbidNonWhitelisted` 命中(传入 `statusCode` / `activityTypeCode` 等未声明字段) | `BAD_REQUEST` | 40000 | 400 | 沿全局 `ValidationPipe.forbidNonWhitelisted: true` |

### 7.2 不开的 BizCode(锁定)

- ❌ `APP_MEMBER_NOT_LINKED`(canUseApp=false 走通用 `FORBIDDEN`;reason 在 `/me/capabilities` 字符串暴露,**非** BizCode;沿 [`app-access-reason.ts`](../src/modules/users/dto/app/app-access-reason.ts) 注释)
- ❌ `APP_MEMBER_INACTIVE`(同上)
- ❌ `APP_MEMBER_DELETED`(同上)
- ❌ `ACTIVITY_NOT_VISIBLE`(走 `ACTIVITY_NOT_FOUND`,避免存在性泄漏)
- ❌ `ACTIVITY_HIDDEN`(同上)
- ❌ `APP_ACTIVITY_*` 新段位(沿 baseline §1.3 不为 surface 开独立段位;activities 段 200xx 共享 admin + app)

### 7.3 404 vs 403 决议 D-P2-4-3

**决议**:对**不可见**活动(`:id` 命中 draft / cancelled / completed / 软删 / 不存在)**统一返 404**(`ACTIVITY_NOT_FOUND=20001`)。

**理由**:
- 沿 v2 `ActivitiesController.findOne` Q-A7 既有范式([`activities.service.ts:329-337`](../src/modules/activities/activities.service.ts)):USER 看 draft / cancelled → 404(注释明确"避免存在性泄漏")
- 沿 `biz-code.constant.ts:373` 注释 + §11.3 风险表 10.5:USER 越权访问他人 → 404 是仓库统一风格
- 若返 403,攻击者可通过比较 403(存在但不可见)vs 404(不存在)枚举活动 id,泄漏内部活动数量 / 创建节奏
- 与 `canUseApp=false` 走 `FORBIDDEN`(403)区分:403 表达"你没权限用 App",404 表达"这个活动不存在"——两层语义清晰

**永不解锁**:
- ❌ 不为"不可见但存在"开 403 + 自定义 message(如"该活动当前不可查看")
- ❌ 不在响应体里区分 "not_found_truly" vs "not_found_visibility_filtered"
- ❌ 不在 audit / 日志中以"不可见命中"为可观测信号(沿 lifecycle §6.7 不暴露内部状态)

---

## 8. Query / Presenter / Service 落地建议

### 8.1 4 个候选方案对比

| 选项 | 描述 | 优点 | 缺点 | 推荐 |
|---|---|---|---|---|
| A | `ActivitiesService` 新增 method `listAvailableForMember` / `findVisibleByIdForMember`;`ActivitiesController` 不动;新建 `AppActivitiesController` 直接调 `ActivitiesService` 新方法 | 单 service 内聚 | `ActivitiesService` 已 657 行;再加 2 method + 2 toDto 转换会膨胀;`ActivitiesService` 与 admin DTO 强耦合,App method 在同 file 易误用 admin `toResponseDto` | ❌ |
| B | 新建 `AppActivitiesService`;复用 `ActivitiesService` 内部 helper(`notDeletedWhere` / `decimalToString`);`AppActivitiesController` 调 `AppActivitiesService` | 物理隔离 admin / app;App service 内字段集独立可控 | `notDeletedWhere` 在 `common/prisma/soft-delete.util` 而非 `ActivitiesService`,跨 service 可复用;`decimalToString` 在 `ActivitiesService` 是 private,需重复实现(或抽 util) | ✅ **推荐** |
| C | 复用 `ActivitiesService.list(currentUser, query)` + Presenter 转 App DTO | 最小 diff | **直接违反 phase-2-review.md §11.3 风险 10.5**:`activities.service.list` 内部按 role 过滤是 admin / user 混合逻辑,App 复用会把 Mixed 扩张;且 query DTO 字段集不同(admin 接收 statusCode / activityTypeCode / organizationId / isPublicRegistration,App 接收只 page / pageSize) | ❌ **禁止** |
| D | 新建 `AppActivitiesService` + 独立 `AppActivityPresenter` class | 严格 boundary(沿 Phase 0.7 §2) | P2-4 第一版仅 2 endpoint,独立 Presenter class 是过度设计;沿 Phase 0.7 §13.3 P0/P1 过渡 + §11 Refactor Triggers:**第二次复用**(P2-5+ `/my/activities` 出现)再抽 | ⚠️ 备选(若 P2-5 立项时 Presenter 复用诉求已显现,P2-4 同步实施) |

### 8.2 决议 D-P2-4-4(待用户拍板)

**推荐方案 B**:`AppActivitiesService`(新建)+ 私有 `toListItemDto` / `toDetailDto` 在 service 内部完成 Prisma → App DTO 映射;**不**新建 `AppActivityPresenter` 类。

**理由**:
- 沿 P2-2 `AppProfileService` 同范式(沿 [`docs/app-api-p2-2-profile-review.md §7.2`](app-api-p2-2-profile-review.md));P2-2 / P2-4 都是"新 surface + 单 module",service 内私有 mapper 已足够
- Phase 0.7 §13.3 P0/P1 过渡明确:`AppXxxService` 是 P0(本期必做);独立 `AppXxxPresenter` 是 P1(第二次复用再抽)
- 避免与 phase-2-review.md §2 line 99 "复用 `activities.service.findOne` + 新 `AppActivityPresenter`"字面冲突:phase-2-review.md 写的"新 `AppActivityPresenter`"语义是"App 端独立的字段映射逻辑",未限定必须是独立 class;本评审稿明确"私有方法形态"作为 v0 落地形式,符合 phase-2-review.md 精神

### 8.3 Service 内部实现要点

#### `AppActivitiesService.listAvailableForMember(memberId, query)`

- 入参:`memberId: string`(已通过 `AppIdentityResolver.resolve` 验证) + `query: PaginationQueryDto`
- 注意:`memberId` 在 v0.1 实际**未参与 where 过滤**(沿 §6.5;published 活动池对全员相同);保留 `memberId` 入参为后续 P2-5+ 若引入"已报名活动从列表排除"留扩展槽 + 调用链显式传递语义意图
- where 子句:`notDeletedWhere({ statusCode: 'published' })`(沿 D-P2-4-1 锁定方案 A;**不**保留切换至 `{ statusCode: { in: ['published', 'completed'] } }` 的备选注释)
- select:**新建** `appActivityListItemSelect`(字段集 = §4.1 锁定 **11 项**;**不**复用 `activityListItemSelect`);明确**不** select `description` / `organizationId` / `genderRequirementCode` / `isPublicRegistration` / `locationLongitude` / `locationLatitude` / `updatedAt` / 任何 audit 字段
- orderBy:`{ createdAt: 'desc' }`(沿 CLAUDE.md §4 默认)
- 分页:`skip = (page - 1) * pageSize`,`take = pageSize`(沿 CLAUDE.md §4)
- 事务:`prisma.$transaction([findMany, count])`(沿 v2 `activities.service.ts:305-314` 范式)
- 返回:`PageResultDto<AppAvailableActivityListItemDto>`(`items` / `total` / `page` / `pageSize`)

#### `AppActivitiesService.findVisibleByIdForMember(id, memberId)`

- 入参:`id: string`(沿 `IdParamDto`)+ `memberId: string`
- 同样保留 `memberId` 为扩展槽
- 查询:`prisma.activity.findFirst({ where: notDeletedWhere({ id, statusCode: 'published' }), select: appActivityDetailSelect })`
- **关键**:`statusCode: 'published'` 直接在 where 子句,**不**走"先查再判断"模式(避免存在性侧信道:同时 `draft` 与 `not found` 都走同一 query path,SQL plan 一致)
- select:**新建** `appActivityDetailSelect`(字段集 = §5.1 锁定 **13 项**);明确**不** select `registrationSchema` / `galleryImageUrls` / `content` / `locationLongitude` / `locationLatitude` / `updatedAt` / `organizationId` / `genderRequirementCode` / `isPublicRegistration` / 任何 audit 字段
- 失败:`null` → `throw new BizException(ACTIVITY_NOT_FOUND)`
- 返回:`AppActivityDetailDto`(经私有 `toDetailDto` 转换)

#### 私有 mapper

```ts
private toListItemDto(row: AppActivityListRow): AppAvailableActivityListItemDto {
  return {
    id: row.id,
    title: row.title,
    activityTypeCode: row.activityTypeCode,
    statusCode: row.statusCode,
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    capacity: row.capacity,
    registrationDeadline: row.registrationDeadline,
    coverImageUrl: row.coverImageUrl,
    createdAt: row.createdAt,
  };
}

private toDetailDto(row: AppActivityDetailRow): AppActivityDetailDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    activityTypeCode: row.activityTypeCode,
    statusCode: row.statusCode,
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    capacity: row.capacity,
    registrationDeadline: row.registrationDeadline,
    registrationNotes: row.registrationNotes,
    coverImageUrl: row.coverImageUrl,
    createdAt: row.createdAt,
  };
}
```

- **v0.1 收窄后**:mapper 内不再需要 Decimal / Json helper(`locationLongitude/Latitude` / `registrationSchema` / `galleryImageUrls` / `content` 均不返);若未来 P2-5+ 解锁这些字段,沿 v2 `decimalToString` / `jsonAsObject` / `jsonAsStringArray` 范式**复制**而非 import(沿 P2-3 `buildAuditMeta` 复制范式;第二次复用再抽 `common/prisma/`)

### 8.4 复用既有基础设施

| 模块 | 复用方式 |
|---|---|
| `AppIdentityResolver` | 注入 + `resolve(currentUser)` + `if (!access.canUseApp) throw FORBIDDEN` |
| `notDeletedWhere` | 直接 import `common/prisma/soft-delete.util`(沿 v2 范式) |
| `PaginationQueryDto` | 直接 import `common/dto/pagination.dto` |
| `PageResultDto<T>` | 直接 import 同上 |
| `IdParamDto` | 直接 import `common/dto/id-param.dto` |
| `ResponseInterceptor` | 全局 + 自动包装 |
| `AllExceptionsFilter` | 全局 + 自动处理 BizException |
| `JwtAuthGuard` / `RolesGuard` | 全局 + 自动鉴权(本评审稿 endpoint **不**挂 `@Roles(...)`;沿 P2-2 范式;App 内**不**用 `Role` 短路) |

---

## 9. 分页 / 筛选 / 排序策略

### 9.1 入参 query

**P2-4 v0 严格 2 参数**:`page`(默认 1)、`pageSize`(默认 20,最大 100;沿 CLAUDE.md §4)。

**明确不接收**:
- ❌ `statusCode`(客户端**无法**绕过可见性;沿 D-P2-4-1 锁定;若传入 → `forbidNonWhitelisted` → 400)
- ❌ `activityTypeCode`(留 P2-5+ 评审决议;v0 不暴露分类筛选)
- ❌ `organizationId`(留 P2-5+;App 是 self perspective 不按组织筛)
- ❌ `keyword` / `q`(留 P2-5+;搜索需评估索引 / pg_trgm / 性能)
- ❌ `fromDate` / `toDate` / `startAfter` / `endBefore`(留 P2-5+;时间范围筛选需评估默认范围 + UTC 边界)
- ❌ `isPublicRegistration`(管理员关心;App 端无意义)

**v0 不接收的理由**:
- 沿 Phase 0.7 §11 Refactor Triggers:**新 query filter** 是 QueryService 抽取触发条件;P2-4 v0 不引入 QueryService(沿 §8.2)
- 沿 baseline §11 v1 兼容性:P2-4 不夹带 v2 query 范式;若 App 端 query 需求与 v2 admin 范式不同(常见;App 通常按"开始时间近期 / 距离我近 / 我所在部门承办"筛),应在 P2-5+ 单独立项设计

### 9.2 出参分页

- 严格 `PageResultDto<AppAvailableActivityListItemDto>`(`items` / `total` / `page` / `pageSize`)
- 沿 CLAUDE.md §4 + §6 + Swagger 装饰器 `@ApiWrappedPageResponse(AppAvailableActivityListItemDto)`

### 9.3 排序

- 默认 `orderBy: { createdAt: 'desc' }`(沿 CLAUDE.md §4)
- **不**暴露 `sort` / `orderBy` query 参数(留 P2-5+ 评估;App 端典型按 startAt asc / desc,但需 product 决议默认值)

---

## 10. 测试计划(e2e + contract)

### 10.1 文件(v0.1 拆分:对应 P2-4a / P2-4b 两 PR)

- **P2-4a PR** 新建 `test/e2e/app-activities-available.e2e-spec.ts`(沿 `app-me-password.e2e-spec.ts` 命名范式)
- **P2-4b PR** 新建 `test/e2e/app-activities-detail.e2e-spec.ts`(同上)
- **v0.1 修订**:由于 D-P2-4-5 锁定**拆 P2-4a + P2-4b 两 PR**,e2e 不再放同一文件(v0 单文件方案 `app-activities.e2e-spec.ts` 关闭);两文件物理隔离便于 PR review 与回滚

### 10.2 P2-4a 测试计划(`/api/app/v1/activities/available` 列表)

> 沿用户 PR #149 v0.1 修订要求的 9 类 it block;**字段集断言数字同步收窄为 11**。

| 类别 | it block | 估算 it 数 |
|---|---|---|
| 1 success published only | `200 + 列表全部返 statusCode='published' + 字段集恰好 11 项(沿 §4.1)` | 1-2 |
| 2 draft / cancelled / completed / deleted not listed | 参数化 4 态:`draft 不在列表` / `cancelled 不在列表` / `completed 不在列表` / `软删活动不在列表` | 1(参数化) |
| 3 unauthenticated 401 | `401 不带 token` / `401 无效 / 过期 token` | 1(参数化 2 case) |
| 4 member not linked 403 | `User.memberId=null + canUseApp=false → 403 FORBIDDEN`(沿 §6.1) | 1 |
| 5 admin without member 403 | `ADMIN / SUPER_ADMIN 无 memberId → 403`(沿 §6.2;不沿 P2-3 例外) | 1 |
| 6 admin-as-member success | `ADMIN + memberId + Member.ACTIVE → 200 + 可见集合 = 普通 USER 兼队员零差异`(沿 D-5.2) | 1 |
| 7 field isolation | 参数化字段反向:`不返 deletedAt` / `不返 publishedBy` / `不返 publishedAt` / `不返 cancelledBy` / `不返 cancelledAt` / `不返 cancelReason` / `不返 organizationId` / `不返 description` / `不返 genderRequirementCode` / `不返 isPublicRegistration` / `不返 registrationNotes` / `不返 registrationSchema` / `不返 galleryImageUrls` / `不返 content` / `不返 locationLongitude` / `不返 locationLatitude` / `不返 updatedAt`(v0.1 收窄 17 字段反向) | 1-2(参数化) |
| 8 pagination | `200 + page=2 / pageSize=5 + total / page / pageSize 三字段正确` / `pageSize=101 → 400`(沿 PaginationQueryDto.@Max) / `Query 反向:传 statusCode → 400 forbidNonWhitelisted` / `传 activityTypeCode → 400` / `传 keyword → 400` | 1-2(参数化) |
| 9 old v2 path unchanged | `/api/v2/activities` ADMIN GET list 行为逐字不变(snapshot 对比 main HEAD)` / `/api/v2/activities` USER GET list 行为逐字不变` | 2 |

**P2-4a 估算总 it 数**:**10 ~ 13 cases**。

### 10.3 P2-4b 测试计划(`/api/app/v1/activities/:id` 详情)

> 沿用户 PR #149 v0.1 修订要求的 8 类 it block;**字段集断言数字同步收窄为 13**。

| 类别 | it block | 估算 it 数 |
|---|---|---|
| 1 success published | `200 + 字段集恰好 13 项(沿 §5.1) + statusCode='published'` | 1 |
| 2 draft / cancelled / completed / deleted → 404 | 参数化 4 态 + 1 不存在 id:`draft → 404 + ACTIVITY_NOT_FOUND` / `cancelled → 404` / `completed → 404` / `软删 → 404` / `不存在 id → 404`(全部命中 ACTIVITY_NOT_FOUND=20001 / HTTP 404) | 1(参数化 5 case) |
| 3 not found 404 | 与 2 合并参数化(`不存在 id → 404`),独立断言 BizCode = ACTIVITY_NOT_FOUND | 包含在 2 内 |
| 4 unauthenticated 401 | `401 不带 token` / `401 无效 / 过期 token` | 1(参数化 2 case) |
| 5 member not linked 403 | `User.memberId=null → 403` | 1 |
| 6 admin without member 403 | `ADMIN 无 memberId → 403`(不沿 P2-3 例外) | 1 |
| 7 field isolation | 参数化字段反向:`不返 deletedAt` / `不返 publishedBy` / `不返 publishedAt` / `不返 cancelledBy` / `不返 cancelledAt` / `不返 cancelReason` / `不返 organizationId` / `不返 genderRequirementCode` / `不返 isPublicRegistration` / `不返 registrationSchema` / `不返 galleryImageUrls` / `不返 content` / `不返 locationLongitude` / `不返 locationLatitude` / `不返 updatedAt`(v0.1 收窄 13 字段反向 + 6 admin/audit 字段) | 1-2(参数化) |
| 8 old v2 path unchanged | `/api/v2/activities/:id` ADMIN GET draft 仍 200(看到全字段)` / `/api/v2/activities/:id` USER GET draft 仍 404`(沿 v2 Q-A7) / `/api/v2/activities/:id` ADMIN GET cancelled 仍 200 + 看到 cancelReason` | 2-3 |

**P2-4b 估算总 it 数**:**8 ~ 11 cases**。

### 10.4 P2-4a / P2-4b 共通补充(各自重复一份)

- admin-as-member success 在 P2-4b 也加一条(`ADMIN 兼队员 GET /:id published → 200`)
- IdParamDto 反向(P2-4b)`id 长度 < 8 → 400` / `id 长度 > 64 → 400` / `id 非字符串 → 400`(参数化 1 it)

### 10.5 不覆盖的反向

由 D-P2-4-2 锁定:**禁止**在 P2-4 e2e 出现以下断言:
- ❌ `canRegister` / `myRegistrationStatus` / `registeredCount` / `passCount` / 任何 registration 维度字段
- ❌ `attendanceRecordsCount` / 任何 attendance 维度字段
- ❌ "report 后看自己是否已 register"类用例(留 P2-5)
- ❌ "活动报名截止后 canRegister=false"(留 P2-5 PolicyService 测试)

### 10.6 e2e fixture

- 复用既有 `createTestUser` / `createTestMember`(沿 `test/helpers/` 范式;P2-2 已使用)
- 复用既有 `createTestActivity`(若不存在,各自 PR 内联 helper 创 1 draft + 1 published + 1 cancelled + 1 completed + 1 软删 5 态;**禁止**新建跨 module fixture util)
- canUseApp=false 三态 fixture(沿 P2-2 `app-me-profile.e2e-spec.ts` 范式)
- **v0.1 拆分提示**:P2-4a / P2-4b 两 PR 各自复制 fixture 创建 helper(避免 P2-4b 强依赖 P2-4a 已合入;沿 P2-3 `buildAuditMeta` 复制范式);若 fixture 第二次复用诉求出现,P2-5+ 立项时再抽到 `test/helpers/`

### 10.7 contract snapshot

- **P2-4a PR**:新增 1 path `/api/app/v1/activities/available` GET + 1 ~ 2 DTO schema(`AppAvailableActivityListItemDto` + 可能的 `PageResultDto_AppAvailableActivityListItemDto` 泛型展开)
- **P2-4b PR**:新增 1 path `/api/app/v1/activities/{id}` GET + 1 DTO schema `AppActivityDetailDto`
- 各 PR 修改 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES`:在 Phase 2 P2-3 段(line ~323)之后**各自**追加 1 行
- 各 PR 修改同文件 components.schemas 期望段:**各自**追加对应 DTO 名
- snapshot 重生:`pnpm test:contract -u` + PR diff review

---

## 11. Contract / OpenAPI 要求

### 11.1 新增 / 修改 / 删除(按 P2-4a / P2-4b 拆分)

**P2-4a PR**:

| 类型 | path | DTO schema | 备注 |
|---|---|---|---|
| 新增 | `GET /api/app/v1/activities/available` | `PageResultDto<AppAvailableActivityListItemDto>` | 沿 `@ApiWrappedPageResponse` |
| 新增 | — | `AppAvailableActivityListItemDto` | 沿 `@ApiExtraModels` 注册 |
| 删除 | ❌ 无 | — | — |
| 修改 | ❌ 无(老 path / 老 DTO / 老 security 一律不动) | — | — |

**P2-4b PR**(在 P2-4a 合入之后立项):

| 类型 | path | DTO schema | 备注 |
|---|---|---|---|
| 新增 | `GET /api/app/v1/activities/{id}` | `AppActivityDetailDto` | 沿 `@ApiWrappedOkResponse` |
| 新增 | — | `AppActivityDetailDto` | 沿 `@ApiExtraModels` 注册 |
| 删除 | ❌ 无 | — | — |
| 修改 | ❌ 无(P2-4a 已新增内容也不动) | — | — |

### 11.2 Tag 归属

- 新增 `@ApiTags('Mobile - Activities')`(沿 Phase 1A Swagger Tag 命名 + P2-1 `Mobile - Me` 范式;参考 [`app-me.controller.ts:49`](../src/modules/users/controllers/app-me.controller.ts))
- **不**复用 `Admin - Activities`(沿 D-7)
- **不**新建 `App - Activities`(沿 Phase 1A 已统一 `Mobile -` 前缀)

### 11.3 @ApiBearerAuth + 错误码标注

```ts
@ApiTags('Mobile - Activities')
@ApiBearerAuth()
@Controller('app/v1/activities')
export class AppActivitiesController {
  @Get('available')
  @ApiOperation({ summary: 'App 视角可参加活动列表(分页;仅 published)' })
  @ApiWrappedPageResponse(AppAvailableActivityListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
  )
  listAvailable(...) {...}

  @Get(':id')
  @ApiOperation({ summary: 'App 视角活动详情(仅 published 可见;其他 → 404)' })
  @ApiWrappedOkResponse(AppActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  findOne(...) {...}
}
```

### 11.4 禁止出现

- ❌ 旧 path 删除 / 重命名
- ❌ 旧 path response 体 / status 变化
- ❌ 旧 DTO schema 字段增删
- ❌ 旧 path security scheme 变化(`@ApiBearerAuth`)
- ❌ Controller 类被改名(`ActivitiesController` 不动)

---

## 12. PR 大小估算与拆分决议

### 12.1 行数估算(v0.1 收窄后,按 P2-4a / P2-4b 拆分)

**P2-4a PR(`/available` 列表)**:

| 文件 | 估算行数 |
|---|---|
| `src/modules/activities/dto/app/app-available-activity-list-item.dto.ts` | 55-70(11 字段 + Swagger 装饰) |
| `src/modules/activities/controllers/app-activities.controller.ts`(新建,仅 list method) | 35-50 |
| `src/modules/activities/app-activities.service.ts`(新建,仅 listAvailableForMember) | 70-95 |
| `src/modules/activities/activities.module.ts` 改动 | +3-5 |
| `test/e2e/app-activities-available.e2e-spec.ts` | 150-200 |
| `test/contract/openapi.contract-spec.ts` 改动 | +3-5 |
| contract snapshot 自动更新 | +25-50 |
| **P2-4a 总计** | **~340-475** ✅ < 500 |

**P2-4b PR(`/:id` 详情)**:

| 文件 | 估算行数 |
|---|---|
| `src/modules/activities/dto/app/app-activity-detail.dto.ts` | 65-85(13 字段 + Swagger 装饰) |
| `src/modules/activities/controllers/app-activities.controller.ts` 改动(追加 findOne method) | +30-45 |
| `src/modules/activities/app-activities.service.ts` 改动(追加 findVisibleByIdForMember) | +50-70 |
| `test/e2e/app-activities-detail.e2e-spec.ts` | 130-180 |
| `test/contract/openapi.contract-spec.ts` 改动 | +3-5 |
| contract snapshot 自动更新 | +30-50 |
| **P2-4b 总计** | **~310-435** ✅ < 500 |

### 12.2 决议 D-P2-4-5 = split(v0.1 锁定)

**锁定**:**强制拆 P2-4a + P2-4b 两个独立 PR**:

- **P2-4a** = `GET /api/app/v1/activities/available` + `AppAvailableActivityListItemDto` + `AppActivitiesService.listAvailableForMember` + `AppActivitiesController` 列表 method + e2e + contract
- **P2-4b** = `GET /api/app/v1/activities/:id` + `AppActivityDetailDto` + `AppActivitiesService.findVisibleByIdForMember` + `AppActivitiesController` findOne method + e2e + contract

**v0.1 修订要点**:
- 从"v0 待拍板,推荐 B"升级为**已锁定**;v0 备选方案 A(单 PR > 500 行)**关闭**
- v0.1 DTO 收窄(List 15 → 11 + Detail 22 → 13)后,P2-4a / P2-4b 各 PR 估算行数均显著低于 500 行阈值(沿 §12.1)
- P2-4a 合入后 P2-4b 才允许立项(顺序串行;**不**并行评审)

**锁定理由**:
- 沿 phase-2-review.md §8 "每个 PR diff < 500 行(超 500 行必须拆)"硬铁律
- 两 endpoint 行为独立 + DTO 物理隔离;不像 P2-2 GET + PATCH 是强语义对 + 共享 service method
- P2-4a 合入后 App 端已可独立联调"看可参加活动列表",前端不必等 P2-4b
- 拆分降低单 PR review 复杂度;字段隔离反向断言 + admin-as-member + 旧路径稳定每 PR 独立验证
- P2-4b 启动前会有"P2-4a 已合入"的真实情况(controller / service / module 已存在),P2-4b 改动以追加 method 为主,审阅面更窄

**永不解锁**:
- ❌ 不允许 P2-4b 在 P2-4a 之前立项
- ❌ 不允许 P2-4a / P2-4b 合并回单 PR(即便最终实际行数和远低于 500)
- ❌ 不允许拆 P2-4a(DTO+Service)+ P2-4b(Controller+e2e) — DTO + Service 没 Controller 无法 e2e,P2-4a 单独无法验收

### 12.3 PR 串

- 当前:P2-3 已合入(PR #148);P2-4 docs 评审稿待合(本 PR #149)
- 下一步:本 PR(#149)合入 → 用户单独立项 P2-4a → P2-4a 合入 → 用户单独立项 P2-4b → P2-4b 合入 → P2-4 整体完成 → P2-5 docs 评审稿独立立项
- **本 docs PR 合入不自动触发** P2-4a / P2-4b 实施(沿 §16.1)

---

## 13. 风险表

| # | 风险 | 触发条件 | 影响 | 缓解方案 | 阻塞 P2-4? |
|---|---|---|---|---|---|
| 13.1 | `draft` 活动泄漏给 App | service `where` 漏掉 `statusCode='published'`;或客户端 query 传 `statusCode=draft` 被错误接受 | **极高(信息泄漏)**:未发布活动设计 / 文案被公开 | (a) `where` 子句**固定** `{ statusCode: 'published' }` 不依赖入参;(b) DTO query 仅 page / pageSize,`forbidNonWhitelisted` 兜底;(c) e2e 反向断言 `传 statusCode=draft → 400`;(d) e2e 正向断言 list / detail 不含 draft | ✅ 是 |
| 13.2 | `deletedAt!=null` 活动泄漏 | service `where` 漏 `notDeletedWhere` | **极高**:已"删除"活动重新出现 | (a) 强制走 `notDeletedWhere(...)` 包装;(b) e2e 反向 `软删活动不在列表 / 软删活动 :id → 404` | ✅ 是 |
| 13.3 | `cancelled` 活动详情可被 App 看到 | service findVisible 漏 statusCode 过滤 | 高:cancel 原因 / cancelledBy 可能曝光 | (a) `where: { statusCode: 'published' }`;(b) e2e 反向 `cancelled :id → 404`;(c) DTO §5.2 显式排除 `cancelled*` / `cancelReason` 字段 | ✅ 是 |
| 13.4 | 返回 admin internal fields | toDetailDto 误返 `publishedBy` / `cancelledBy` / `deletedAt` | 高:内部 User.id 链 / audit 时间外泄 | (a) DTO §5.2 字段集锁定 5 项排除;(b) `appActivityDetailSelect` Prisma select 不查这些字段(从源头切断);(c) e2e 字段隔离断言 `不返 publishedBy / publishedAt / cancelledBy / cancelledAt / cancelReason / deletedAt`(参数化 6 字段) | ✅ 是 |
| 13.5 | 复用 Admin DTO | 实施者写 `class AppAvailableActivityListItemDto extends ActivityListItemDto` / `extends OmitType(ActivityResponseDto, [...] as const)` | **极高(D-7 违反)**:Admin DTO 字段变更直接污染 App | (a) §4.3 / §5.4 铁律明确;(b) PR review grep `extends.*ActivityListItemDto\|extends.*ActivityResponseDto\|extends.*OmitType.*Activity\|extends.*PickType.*Activity` 一律拒合并;(c) 文件归属 `dto/app/` 物理隔离 | ✅ 是 |
| 13.6 | status filter 被客户端绕过 | DTO 接收了 `statusCode` 字段(实施者误以为"做白名单服务侧再过滤就行") | **极高**:与 13.1 等价 | (a) `Query DTO` 仅声明 `page` / `pageSize`;(b) `forbidNonWhitelisted: true` 兜底;(c) e2e 反向 `传 statusCode → 400` | ✅ 是 |
| 13.7 | `registeredCount` 性能 | 实施者为 list 每项加 count query | 中:n+1 查询 / 列表慢 | (a) D-P2-4-2 锁定不返 registeredCount;(b) DTO §4.1 / §5.1 字段集不含;(c) e2e 字段集断言 | ✅ 是 |
| 13.8 | attachment signed URL 泄露 | `coverImageUrl` / `galleryImageUrls` 在未来若改 signed URL,默认返回 | 中:可重放令牌泄漏 | (a) 当前 schema `coverImageUrl: String` 是裸 URL 字符串(非 signed URL),P2-4 v0 无此风险;(b) 若未来 P0-* / P2-5+ 引入 signed URL,**必须**在 DTO Presenter 内裁剪 / 重签 / 短 TTL;(c) 在 P2-4 评审稿留下记录,未来 attachment 改造时回查本风险 | ⚠️ 留警告 |
| 13.9 | `activity not visible` 返 403 暴露存在性 | 实施者写 `if (row.statusCode !== 'published') throw FORBIDDEN` | 高:可枚举活动 id | (a) D-P2-4-3 锁定 404;(b) where 子句直接过滤(从查询层切断);(c) e2e 断言"不可见 → 404 + ACTIVITY_NOT_FOUND"(而非 403 + FORBIDDEN) | ✅ 是 |
| 13.10 | admin-without-member 越权 | 实施者为减少 403 错误把 admin 当作"看得见所有 published"的特殊角色 | **极高(D-5.2 违反)** | (a) §6.2 锁定 admin without member → 403;(b) e2e `admin without member → 403`;(c) service 内**禁止** `if (role === ADMIN) ...` 任一 role 短路 | ✅ 是 |
| 13.11 | `/me/password` 例外被错误复用 | 实施者参照 P2-3 D-P2-3-1 在 P2-4 也豁免 canUseApp 检查 | 高:Admin 无 member 看到 App 业务数据 | (a) §6.2 明确"**不**沿 P2-3 admin-without-member 例外";(b) `AppActivitiesService` 必须调 `AppIdentityResolver.resolve` + `if (!access.canUseApp) throw FORBIDDEN`;(c) e2e 三 case `admin without member`(get list + get detail + 正常 admin 兼队员)对比验证 | ✅ 是 |
| 13.12 | 修改旧 `/api/v2/activities*` 行为 | 实施者"顺手"统一返回字段 / 改 USER 可见性 / 调整字典 | **极高(phase-2-review.md §3.2 违反 + migration-plan §5 方案 C 违反)** | (a) §11.4 锁定不动旧 path / DTO / Controller / Service / Tag;(b) `ActivitiesController` / `ActivitiesService` / `ActivityResponseDto` / `ActivityListItemDto` / `ListActivitiesQueryDto` 5 文件 PR diff 必须 0 行;(c) e2e `/api/v2/activities*` 6+ 用例继续通过(`activities.e2e-spec.ts` 840 行不动) | ✅ 是 |
| 13.13 | P2-5 报名逻辑提前夹带 | 实施者为"对齐前端展示"在 P2-4 service 内查 `activityRegistration` 计算 myRegistrationStatus | **极高(D-P2-4-2 + D-8 违反)** | (a) D-P2-4-2 锁定不返;(b) `AppActivitiesService` **禁止** import `ActivityRegistrationsService` / `Prisma.activityRegistration.*`;(c) PR review grep `activityRegistration` 在 `app-activities.service.ts` 内出现 → 拒合并 | ✅ 是 |
| 13.14 | `keyword` / 日期范围筛选提前实现 | 实施者觉得"早晚要做"在 P2-4 加 | 中:scope 蠕变 + 性能 / 索引未评估 | (a) §9.1 锁定 v0 严格 2 参数;(b) Query DTO 仅 `page` / `pageSize`;(c) e2e 反向 `传 keyword → 400` / `传 fromDate → 400` | ✅ 是 |
| 13.15 | `AppActivityPresenter` 过度抽象 | 实施者沿 phase-2-review.md §2 line 99 字面 + 自加独立 class | 低:过度设计 | (a) §8.2 决议明确"私有 method 形态",不新建独立 class;(b) PR review 不接受 `AppActivityPresenter` 独立 file | ⚠️ 软约束 |
| 13.16 | XSS / 富文本污染 | `description` / `content` / `registrationNotes` 含 `<script>` 等被前端 innerHTML 渲染 | 中(责任在前端);后端 P2-4 无新增风险 | (a) §5.3 锁定 P2-4 不在后端做 sanitize(沿 v2 现状);(b) 前端 App 客户端应在富文本渲染时按各平台范式处理;(c) 此风险与 v2 行为一致,P2-4 不引入新增点 | ⚠️ 留警告 |
| 13.17 | `registrationSchema` Json 注入 | `registrationSchema` 是 Json,客户端按 schema 解析时若结构异常 | 中(责任在前端) | (a) Admin 录入侧 `@IsObject()` 仅校验对象类型,沿 v0.2 D12 + Q-A13;(b) App 端按约定 schema 安全解析(沿 phase-2-review.md §3.2 不动 v2);(c) P2-4 不引入新增点 | ⚠️ 留警告 |
| 13.18 | `pageSize` DoS | 实施者为方便联调把 max 改大或去掉 | 中:大查询 OOM | (a) 沿 CLAUDE.md §4 `PaginationQueryDto.@Max(100)` 默认;(b) e2e 反向 `pageSize=101 → 400`;(c) 不在 P2-4 内修改 `PaginationQueryDto` | ✅ 是 |
| 13.19 | **P2-4a / P2-4b 合并回单 PR** | 实施者觉得"反正都 < 500 行,合一起方便" | **极高(D-P2-4-5 v0.1 违反)** | (a) D-P2-4-5 锁定 split;(b) 顶层 process / PR review 强制查"P2-4a 单独 endpoint" / "P2-4b 单独 endpoint";(c) §16.3 永不解锁 | ✅ 是 |
| 13.20 | **v0.1 收窄字段被实施者私自加回** | 实施者觉得"前端调试方便",在 P2-4a / P2-4b implementation PR 中把 `description` / `organizationId` / `genderRequirementCode` 等加回 list,或把 `content` / `galleryImageUrls` / 经纬度 加回 detail | **极高(§4.2 / §5.2 v0.1 违反)** | (a) §4.1 / §5.1 字段集严格 11 / 13 项;(b) e2e §10.2 类别 7 / §10.3 类别 7 字段隔离反向参数化全字段断言;(c) §16.2 明确"扩字段必须 P2-5+ 单独立项";(d) PR review 强制比对 DTO 字段集与本评审稿表格 | ✅ 是 |

---

## 14. 同步引用与文档归属

### 14.1 必须同步修改

| 文件 | 修改内容 | 行数 |
|---|---|---|
| [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) §11.3 | 在"P2-1 / P2-4 / P2-5 / P2-6 / P2-7 — 各 PR 启动前由用户决议是否需要独立评审稿"行**上方**插入 P2-4 引用行;同时**从下方行中移除 `P2-4`**(从"P2-1 / P2-4 / P2-5 / P2-6 / P2-7"改为"P2-1 / P2-5 / P2-6 / P2-7") | +1 修 1 |

### 14.2 不修改

- ❌ `CLAUDE.md`(沿 §19.7 D-8 已覆盖 Phase 2 review chain;P2-4 不需在 §19+ 增 P2-4 子节)
- ❌ `AGENTS.md`(同上)
- ❌ `docs/api-client-boundary-migration-plan.md`(P2-4 是 P2-N 评审稿,不动 migration plan;若 D-P2-4-N 锁定后影响 migration plan §4.x P2-4 行,在 P2-4 实施 PR 启动前评估)
- ❌ `docs/app-permission-boundary-review.md` / `data-access-lifecycle-boundary-review.md` / `code-architecture-boundary-review.md`(本评审稿是这些 review 的下位应用,**不**反向修改上位文档)
- ❌ `docs/process.md`(沿 D-8;P2-4 走 P2-N 流程已有定义)
- ❌ `docs/current-state.md`(评审稿合入仅是 docs PR;current-state 不夹带未来计划)
- ❌ `docs/handoff/*`(同上)

### 14.3 引用链

P2-4 implementation must read:
- [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md)
- [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md)(章节骨架 + AppIdentityResolver 范式)
- [`docs/app-api-p2-3-password-review.md`](app-api-p2-3-password-review.md)(`buildAuditMeta` helper 复制范式;P2-4 不需 audit meta,但 controller 文件骨架沿其形态)
- [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)(D-5.1 ~ D-5.4)
- [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md)(scope 默认 self + L1 ~ L8)
- [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md)(Presenter / QueryService 边界 + Refactor Triggers)
- 本评审稿 **`docs/app-api-p2-4-activities-review.md`**

---

## 15. 决议记录(用户拍板项)

| 编号 | 决议项 | 决议值 | 状态 |
|---|---|---|---|
| **D-P2-4-1** | App 可见状态白名单 | **= A**:仅 `statusCode='published' AND deletedAt IS NULL`;`draft / cancelled / completed / 软删` 一律 App 不可见;`/:id` 命中不可见 → 404;completed / cancelled 历史归 P2-5 `/api/app/v1/my/activities` | ✅ **v0.1 锁定**(2026-05-20);备选方案 C 关闭 |
| **D-P2-4-2** | P2-4 是否返回报名状态 / hint / capabilities / registeredCount | **= A**:全部不返(纯浏览;报名相关属 P2-5) | ⏳ 待拍板 |
| **D-P2-4-3** | 不可见活动 404 vs 403 | **= 404**(沿 v2 USER `findOne` Q-A7 范式;避免存在性泄漏) | ⏳ 待拍板 |
| **D-P2-4-4** | Service / Presenter 落地形态 | **= 方案 B**:`AppActivitiesService` 新建 + 私有 mapper(不新建独立 `AppActivityPresenter` class) | ⏳ 待拍板;备选方案 D(同时建独立 Presenter class) |
| **D-P2-4-5** | PR 拆分 | **= split**:强制拆 P2-4a(GET `/api/app/v1/activities/available`) + P2-4b(GET `/api/app/v1/activities/:id`)两 PR;各自走 C 档 < 500 行;P2-4a 先于 P2-4b | ✅ **v0.1 锁定**(2026-05-20);备选方案 A(单 PR)关闭 |

---

## 16. 边界声明

### 16.0 P2-4 vs P2-5 职责分界(v0.1 明确)

> P2-4 仅负责 **public App browsing of currently published activities**;以下能力**全部**归未来 `/api/app/v1/my/*`(P2-5+),**禁止**在 P2-4 端点夹带。

| 能力 | 归属 | 端点(预期) |
|---|---|---|
| 报名(create registration) | P2-5 | `POST /api/app/v1/my/registrations` |
| 取消报名 | P2-5 | `DELETE /api/app/v1/my/registrations/:id` |
| 报名记录列表 / 详情 | P2-5 | `GET /api/app/v1/my/registrations*` |
| **我的(含已报名)活动列表** | P2-5 | `GET /api/app/v1/my/activities` |
| **completed 历史活动回顾**(本人参加过的) | P2-5 | `GET /api/app/v1/my/activities`(按 registration 反查) |
| **cancelled 活动查询**(本人曾报名的) | P2-5 | `GET /api/app/v1/my/registrations`(含 cancelled 状态过滤) |
| 单活动级 `canRegister` 资格判断 | P2-5 | PolicyService;承载在 P2-5 endpoint 或 `/api/app/v1/activities/:id/registration-eligibility`(待 P2-5 评审决议) |
| `registeredCount` / 报名人数 | P2-5+ | 运营数据;需评估是否暴露给 App |
| `myRegistrationStatus` 派生字段 | P2-5 | 在 P2-5 `/my/registrations` 列表 + 详情中暴露;**禁止**在 P2-4 detail 中夹带 |
| 我的考勤 | P2-6 | `GET /api/app/v1/my/attendance-records*` |
| 我的证书 | P2-7 | `GET /api/app/v1/my/certificates*` |
| 待办 / managed | Phase 2 不实施 | 命名空间预留 |

### 16.1 本评审稿明确不在范围

- ❌ `POST /api/app/v1/my/registrations`(报名;P2-5)
- ❌ `DELETE /api/app/v1/my/registrations/:id`(取消报名;P2-5)
- ❌ `GET /api/app/v1/my/registrations*`(报名记录;P2-5)
- ❌ `GET /api/app/v1/my/activities*`(我的活动;P2-5)
- ❌ `GET /api/app/v1/my/attendance-records*`(我的考勤;P2-6)
- ❌ `GET /api/app/v1/my/certificates*`(我的证书;P2-7)
- ❌ 任何 `/api/app/v1/managed/*`(管理范围;Phase 2 不实施)
- ❌ 任何 `/api/app/v1/tasks/*`(待办;Phase 2 不实施)
- ❌ 任何 `/api/auth/v1/*`(沿 Phase 1B 范围;非 P2-4)
- ❌ 任何 `/api/public/v1/*`(沿 Phase 1B 范围;非 P2-4)
- ❌ 修改旧 `/api/v2/activities*` 任何行为(沿 §11.4 + 风险表 13.12)
- ❌ 修改 `/api/v2/activities/:activityId/registrations*` 任何行为
- ❌ 修改 `ActivitiesController` / `ActivitiesService` / `Activity*Dto` / `ListActivitiesQueryDto` / `CancelActivityDto` / `CreateActivityDto` / `UpdateActivityDto`(沿 §11.4)
- ❌ 修改 `prisma/schema.prisma`(沿 CLAUDE.md §0 + §18.1;P2-4 不需 schema 变更)
- ❌ 生成 migration(沿 §0)
- ❌ 启动 P2-4a / P2-4b implementation(本评审稿是评审,实施需单独立项;P2-4a 先于 P2-4b)
- ❌ 启动 P2-5+(本评审稿冻结后 P2-5 评审稿独立立项)
- ❌ 启动 Phase 1B(本评审稿与 Phase 1B 完全独立)
- ❌ 复用 Admin DTO 作为 App DTO(沿 §4.3 + §5.4 + 风险表 13.5)

### 16.2 本评审稿允许未来评审重开

- ✅ §4.2 / §5.2 列表 / 详情 DTO 字段补充(若 P2-4a / P2-4b 实施后联调实测发现 11 / 13 字段不足)— 在 P2-5+ 评估真实诉求后立项扩展;**禁止**在 P2-4a / P2-4b implementation PR 内自行增字段
- ✅ §9.1 Query 字段集扩展(`activityTypeCode` / 日期范围 / `keyword`)— 留 P2-5+ 评审决议
- ✅ §8.2 抽出独立 `AppActivityPresenter` class — 第二次复用(P2-5+)出现时

### 16.3 本评审稿永不解锁

- ❌ `draft` 状态对 App 可见(任意角色)
- ❌ `deletedAt!=null` 对 App 可见
- ❌ **`cancelled` / `completed` 通过 P2-4 端点对 App 可见**(沿 D-P2-4-1 v0.1 锁定;历史回顾归 P2-5 `/my/activities`)
- ❌ 在 App API where 子句用 `role` 短路决定可见集
- ❌ 在 App API service 内 import `ActivityRegistrationsService`(P2-4 范围)
- ❌ 在 App DTO 内继承 / Pick / Omit Admin DTO
- ❌ 修改 v2 `/api/v2/activities*` 现有行为
- ❌ 不可见活动返 403(必须 404)
- ❌ 合并 P2-4a + P2-4b 回单 PR(沿 D-P2-4-5 v0.1 锁定)
- ❌ P2-4b 在 P2-4a 之前立项
- ❌ 切换 D-P2-4-1 至"含 completed"备选方案 C(v0.1 关闭)

---

## 修订历史

- **v0(2026-05-20)**:初稿。锁定 endpoint 范围 / DTO 字段集 / 可见性 / Identity / BizCode / Service 落地 / 测试 / 风险表;5 项决议(D-P2-4-1 ~ D-P2-4-5)待用户拍板。
- **v0.1(2026-05-20)**:同日 PR #149 review 修订。
  - **D-P2-4-1 锁定 = A**:仅 `statusCode='published' AND deletedAt IS NULL`;`completed` / `cancelled` 历史归 P2-5 `/my/activities`;备选方案 C(对齐 v2 USER 含 completed)关闭。
  - **D-P2-4-5 锁定 = split**:强制拆 P2-4a(list)+ P2-4b(detail)两 PR;P2-4a 先于 P2-4b;备选方案 A(单 PR)关闭。
  - **List DTO 收窄 15 → 11 字段**(`AppAvailableActivityListItemDto`):移除 `description` / `organizationId` / `genderRequirementCode` / `isPublicRegistration`;字段名沿真实 Prisma schema `startAt` / `endAt`(非 `startTime` / `endTime`)。
  - **Detail DTO 收窄 22 → 13 字段**(`AppActivityDetailDto`):移除 `registrationSchema` / `galleryImageUrls` / `content` / `locationLongitude` / `locationLatitude` / `updatedAt` / `organizationId` / `genderRequirementCode` / `isPublicRegistration`;详情仅在 list 11 项基础上追加 `description` + `registrationNotes`;字段名沿真实 Prisma schema `cancelReason`(非 `cancelledReason`)。
  - **§8.3 service select / mapper 同步收窄**:`appActivityListItemSelect` / `appActivityDetailSelect` 字段集对齐 DTO;mapper 不再需 Decimal / Json helper。
  - **§10 测试计划重写**:拆 P2-4a(`test/e2e/app-activities-available.e2e-spec.ts`,9 类 it block,~10-13 cases)+ P2-4b(`test/e2e/app-activities-detail.e2e-spec.ts`,8 类 it block,~8-11 cases);字段隔离反向参数化全字段断言。
  - **§11 contract 拆分**:P2-4a / P2-4b 各自新增 1 path + 1 ~ 2 DTO schema。
  - **§12.1 行数估算重新分摊**:P2-4a ~340-475 行 / P2-4b ~310-435 行,均 < 500 行阈值。
  - **§16.0 新增 P2-4 vs P2-5 职责分界表**;§16.3 明确"`cancelled` / `completed` 通过 P2-4 端点对 App 可见"永不解锁。
  - **§13 风险表新增 13.19**(P2-4a / P2-4b 合并回单 PR 风险)+ **13.20**(v0.1 收窄字段被实施者私自加回风险)。
