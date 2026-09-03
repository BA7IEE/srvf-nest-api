# Activity OS R2 / B1：PlacePreset 与 ActivityPlace 存储地基评审与授权清单

> **状态：维护者已于 2026-09-03 确认方案 A；本稿只冻结 B1 的边界与后续授权预算。** 当前授权只允许新增本评审稿，不授权 Prisma schema、migration、测试基础设施、运行时代码或生产部署。
>
> **上游合同**：Activity OS T0-A 终态合同第 6.1、10.3、11、12 节；原始蓝图第 8 章和 Release 2 排期。A1 至 A8 已依次合入，B1 不重开模板、Series、A6 物化或 A8 No-AI 的既有结论。

## 1. 维护者最低阅读量

- **做什么**：以纯加法方式建立 PlacePreset 和 ActivityPlace 两个存储对象，保留活动或场次的独立地点快照、预设来源和最小数据库锚点。
- **不做会怎样**：后续 B2 到 B6 没有可信地点真相可接入，只能继续把地点、坐标、可见范围和签到资格分散在旧 Activity 与 ActivitySession 字段中。
- **最坏情况与回退**：字段或外键设计错误会让后续地点写入受限；本刀只新增空表和约束、没有回填或删除，代码部署前可整体回退，migration 已应用后保留未使用的加法对象而不以 DROP 回滚。
- **推荐方案**：方案 A。B1 先做两个对象的持久化地基和 PostgreSQL 证明；坐标系转换与旧字段投影留 B2，发布判定留 B4，快照留 B5，外部创建入口留 B6。

## 2. 已核验事实与边界

| 事实 | 证据 | B1 的处理 |
| --- | --- | --- |
| 一期只保存点位；活动地点的语义包含活动或场次、角色、名称、文字地址、说明、经纬度、坐标系、提供方、可见性、签到资格、半径、预设来源和 workflowRevision | T0-A 终态合同 6.1 | 建立独立 ActivityPlace，字段不塞进 Activity JSON。 |
| 固定角色为 primary、meeting、execution、evacuation、parking、other；固定最小可见范围为 public、accepted、staff、command | T0-A 终态合同 6.1 | 两组闭集由 migration 的 CHECK 物理守住。 |
| 地图失效时草稿仍能保存文字地点；定位签到活动在发布前补坐标 | T0-A 终态合同 6.1、外部故障表 | B1 允许坐标为空，不做地图调用或发布拦截。 |
| 区域、路线、危险区属于未来 Incident 地理对象 | T0-A 终态合同 6.1 | 不建 geometryJson、空间索引、PostGIS、区域或路线表。 |
| 当前 Activity 仍有旧 location 以及可空 WGS84 经纬度 | prisma/schema.prisma 的 Activity 模型 | 不改旧列、不投影、不回填；B2 单独负责兼容投影。 |
| 当前 ActivitySession 已有 locationText、三种文字点位、坐标、定位要求和半径，且已有定位约束 | prisma/schema.prisma 的 ActivitySession 与第 76 条 migration | 不改这些既有字段、约束、DTO、service 或测试行为。 |
| A6 的 Template Definition V1 明确拒绝坐标、定位要求和半径 | activity-template-definition-v1.ts | 不借 B1 偷开模板地点输入；模板地点复制仍留后续独立切片。 |
| 仓内尚无 ActivityPlace 或 PlacePreset Prisma 模型 | schema 搜索 | B1 是新的加法对象，不碰历史数据。 |
| 当前 migration 累计 105 条，A7 已合入 | main、PR #1251、当前活动台账 | B1 预期为第 106 条 migration，仍须独立逐行审查和 3b 重签。 |

## 3. 方案 A 的精确数据边界

### 3.1 两个对象的责任

PlacePreset 是未来定义层的地点预设来源。B1 只建立其可被选择和复制的原子地点数据，不提供创建、更新、删除、查询、权限、可见范围或生命周期接口。未来控制面若需要修改预设，必须单独决定版本和生命周期，不能把更新传播到既有活动。

ActivityPlace 是计划层的活动地点快照。它本地保存地点展示、坐标、提供方、签到资格和半径；sourcePresetId 只保留来源，不允许读面按预设实时覆盖 ActivityPlace。这样预设日后发生变化，也不会改变已经创建的活动地点。

| 对象 | B1 字段 |
| --- | --- |
| PlacePreset | id、createdAt、updatedAt、name、addressText、instruction、longitude、latitude、coordinateSystemCode、providerCode、providerPlaceId、checkInEligible、radiusMeters |
| ActivityPlace | id、createdAt、updatedAt、activityId、sessionId、roleCode、name、addressText、instruction、longitude、latitude、coordinateSystemCode、providerCode、providerPlaceId、visibilityCode、checkInEligible、radiusMeters、sourcePresetId、workflowRevision |

字段含义固定如下：

- name 和 addressText 为非空文本。地图不可用时仍可以保存运营人员输入的文字地点；B1 不要求地理编码结果。
- instruction、longitude、latitude、coordinateSystemCode、providerCode、providerPlaceId、radiusMeters、sessionId、sourcePresetId 都可为空。
- checkInEligible 和 visibilityCode 均由将来的写入方显式选择；B1 不用业务默认值替维护者作决定。
- ActivityPlace.workflowRevision 默认 0，表示地点快照创建时所属活动的工作流版本锚。B1 不新增递增 writer。
- 预设不带 roleCode 或 visibilityCode：二者取决于某一个具体活动或场次，不能当成全局预设事实。

### 3.2 关系与数据库约束

ActivityPlace 必须有 activityId，并以 Restrict 外键关联 Activity。可选 sessionId 不能只验证“这个场次存在”：它和 activityId 必须通过复合外键关联 ActivitySession 的既有 activityId 与 id 复合唯一锚，数据库必须拒绝把活动 A 的场次挂到活动 B 的地点上。

sourcePresetId 可空，非空时以 Restrict 外键关联 PlacePreset。预设来源因此可以追溯，也不能被删除后留下失真的历史来源。B1 不给 providerPlaceId、地点名称或角色增加未经合同确认的唯一性约束；同一场次可以有多个 other 点位，合同也没有规定每种角色只能一条。

第 106 条 migration 必须至少包含下列物理边界：

1. ActivityPlace.roleCode 的六值 CHECK。
2. ActivityPlace.visibilityCode 的四值 CHECK。
3. ActivityPlace 到 Activity 的 Restrict 外键。
4. ActivityPlace 的 activityId 与 sessionId 复合外键，引用 ActivitySession 的 activityId 与 id。
5. ActivityPlace 到 PlacePreset 的可空 Restrict 外键。
6. activityId、sessionId、sourcePresetId 的查询索引，以及 Prisma 关系所需的反向 relation。

坐标成对、经纬度范围、坐标系闭集、坐标转换、provider 数据可信度，以及 checkInEligible 与 radiusMeters 的关系均不在 B1 落约束。原因是草稿允许文字地点和缺坐标，且发布时的定位完整性由 B4 Readiness 作确定性判定；把未来发布规则硬塞进 B1 会让草稿创建先被错误拦住。

### 3.3 明确的历史隔离

B1 不写触发器来“自动同步”预设，也不允许 ActivityPlace 在读时 join 后直接采用 PlacePreset 当前值。将来的 B6 写命令必须在活动根事务中，把选中的预设值复制入 ActivityPlace 的本地字段，再保存 sourcePresetId 作为来源。B1 的表结构使这个复制成为唯一正确形状，但不提前创造未获授权的 writer。

PlacePreset 的版本化、软删、运营可见范围、组织归属和管理权限目前都没有冻结字段合同。B1 不用空的 ownerOrganizationId、statusCode、JSON 配置或第二套版本表“先占位以后再用”；这些选择必须在未来真正存在管理面时单独审查。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | PlacePreset 与 ActivityPlace 同时建立；活动地点存本地快照和可空预设来源；只加 FK、索引和两组闭集 CHECK | 符合蓝图的两个目标概念，保住历史隔离和活动—场次同链锚点，又不提前接入地图、API 或发布行为。 |
| B | 只建 ActivityPlace，sourcePresetId 仅保存无外键字符串或完全推迟 PlacePreset | 不能满足 B1 已冻结的 PlacePreset / ActivityPlace 边界，且会丢失来源完整性。 |
| C | 直接改 Activity、ActivitySession 旧地点列并将其当新地点模型 | 会把 B2 的坐标投影与历史兼容混入 B1，破坏现有 API 和场次定位约束。 |
| D | 同时建立地图搜索、空间对象、路线、区域、PostGIS 或新的发布 Gate | 越过 B2、B4、B6 和 Incident 边界，扩大外部依赖与生产风险。 |

## 5. 风险、验证与迁移 rehearsal

| 风险 | 处理和执行位 |
| --- | --- |
| 跨活动伪造 sessionId | PostgreSQL E2E 以两条 Activity、两条 Session 的交叉组合插入为负例，断言 SQLSTATE 23503 和约束名；同时有合法正对照。 |
| 角色或可见范围错误但测试恒拒 | 每个拒绝用例都配对应的合法值；六角色、四可见范围逐值正向覆盖。 |
| 删除或更新预设改变历史地点 | E2E 建立来源与活动快照后更新预设，断言 ActivityPlace 本地字段不变；删除已被引用预设必须失败。 |
| 坐标规则过早收紧 | E2E 明确允许文字地点与空坐标草稿；不写坐标投影、provider 调用或发布判定。 |
| 新表遗漏 resetDb 导致 E2E 互相污染 | 修改受保护的 test/setup/reset-db.ts，将两张表加入明确的 TRUNCATE 顺序和表数注释；该文件必须另获红区授权。 |
| migration 计数只改到部分旧 E2E | 先对全仓 migration count 与字面数量作两种工具复核；当前可见的 8 份 CURRENT_MIGRATION_COUNT 断言须从 105 同步到 106，不能把这份名单当作唯一真相。 |

实施后最低验证如下：

1. Prisma validate、Prisma generate、lint、typecheck 和相关派生文档检查。
2. 新建 activity-os-r2-b1-place-schema-constraints E2E，覆盖精确列形状、所有 FK、两个闭集、独立地点快照、预设 Restrict 删除和跨活动场次拒绝。
3. 在空库完整回放 106 条 migration；在已有 105 条 migration 的非空隔离库执行第 106 条，确认旧 Activity、ActivitySession 和现有快照零改写。
4. 运行修改后的 migration count E2E、B1 定向 E2E、test:contract 和 agent:check:quick；全量 E2E 由 PR CI 冷跑裁决，不能在本机重复全量后宣称等同 CI。
5. 不运行 prisma migrate dev、migrate reset 或 db push；不对生产或真实数据环境执行 migration。

## 6. 预期写集与授权预算

### 6.1 本次已获授权

当前 worktree 只获如下精确授权：

- docs/archive/reviews/activity-os-r2-b1-place-review.md：新增本冻结评审稿。

本稿没有授权其它任何路径，也不把方案确认等同于 schema 写入授权。

### 6.2 实施前仍需维护者逐项授权

以下是预算，尚未获授权。实际 diff 形成后必须逐文件运行 harness:needs，并由维护者在 B1 实施 worktree 发放精确令牌：

| 预期路径 | 用途 |
| --- | --- |
| prisma/schema.prisma | 新增 PlacePreset、ActivityPlace 以及 Activity、ActivitySession 的反向 relation。 |
| prisma/migrations/20260903131800_activity_os_r2_b1_place_expand/migration.sql | 第 106 条纯加法 migration；表、FK、索引和两组 CHECK。 |
| test/setup/reset-db.ts | 把新表加入 E2E 隔离清理。 |
| 相关 harness 域模型或状态机取证文件 | 仅在派生检查实际要求时最小更新；不得预先申请或手改。 |
| docs/ai-harness/CUTOVER_SIGNOFF.md | 仅在 migration SQL 已逐行审查且维护者另行确认 3b 后登记。 |

不申请 package.json、lockfile、controller、DTO、Swagger、路由、权限码、RBAC seed、审计事件、Gate、模板 Definition V1、旧 Activity 或 ActivitySession 字段、生产 migration deploy。

## 7. 维护者决策记录

维护者于 2026-09-03 确认：

> 确认 B1 方案 A

此决定批准先新增并评审本稿。实施 PR 需要在本稿独立合并后重新发起精确 schema、migration 和测试基础设施授权；migration SQL 定稿后还必须由维护者单独确认“重签 3b（B1，第 106 条 migration）”。任何 B2 至 B7 内容均不随本决定带入。
