# Activity OS R2 / B2：坐标系与旧字段兼容投影评审与授权清单

> **状态：维护者已于 2026-09-03 确认起草本稿；尚未确认 B2 方案 A，也未授权任何 B2 实现。** 当前授权只允许新增本评审稿及 CI 强制的冻结稿台账分类，不授权 Prisma schema、migration、测试基础设施、运行时代码、接口或生产部署。
>
> **上游合同**：Activity OS T0-A 终态合同第 6.1、10.3、11、12 节；原始蓝图第 8 章和 Release 2 排期。B1 已以 PR #1257 合入 main，B2 只接 B1 的地点存储地基，不重开 A1 至 A8、B3 表单、B4 Readiness、B5 快照或 B6 创建入口。
>
> **当前事实基线**：main 的 7b9f79d 已包含第 106 条 B1 migration。prisma/CLAUDE.md 的当前摘要仍称 B1 未合入，与 GitHub/main 冲突；本稿以代码和 GitHub 为准，但不借 B2 擅自更正该独立文档事实。

## 1. 维护者最低阅读量

- **做什么**：给 B1 新增的 PlacePreset 与 ActivityPlace 补齐坐标成对、范围和坐标系闭集的数据库证明；建立一个不访问数据库、不调用地图的纯转换与旧字段投影策略。
- **不做会怎样**：B6 第一次把地图选点写进新地点时，可能把 GCJ-02 或 BD-09 原值当成旧 WGS84 值写入签到链；同时 B1 暂时允许单边坐标、未知坐标系，错误会拖到更晚才暴露。
- **最坏情况与回退**：第 107 条 migration 会校验既有 B1 表数据；有不合法地点行时必须整体失败、零部分应用，不回填或“猜着修”。代码部署前可以整体回退；migration 已应用后保留约束和未被接线的纯策略，不用 DROP 反向回滚。
- **推荐方案**：方案 A。固定 wgs84、gcj02、bd09 三个坐标系，原始坐标留在新地点，纯策略统一投影为 WGS84；只在未来 B6 的活动根事务内消费结果。本刀不修改任何现有旧字段 writer 或签到运行链。

## 2. 已核验事实与边界

| 事实 | 证据 | B2 的处理 |
| --- | --- | --- |
| 一期只保存点位；旧字段按 WGS84 语义投影；地图不可用时文字地点仍可保存 | T0-A 终态合同 6.1；原始蓝图 8.1 至 8.5 | 新地点坐标可整体为空；不引入地图 SDK、搜索、区域、路线、geometryJson 或 PostGIS。 |
| Release 2 的既定顺序是 B1 Place、B2 坐标系和旧投影、B3 Form、B4 Readiness、B5 Snapshot、B6 API | T0-A 终态合同 11；原始蓝图 Release 2 表 | B2 只做坐标事实与兼容策略，不提前创建外部写入口或发布判定。 |
| B1 的第 106 条 migration 明确把坐标成对、范围、坐标系闭集和转换留给 B2 | prisma/migrations/20260903131800_activity_os_r2_b1_place_expand/migration.sql；B1 评审稿 3.2 | 第 107 条只 ALTER 两张 B1 新表；不 ALTER Activity 或 ActivitySession 的旧地点列。 |
| Activity 的 locationLongitude/locationLatitude 与 ActivitySession 的 longitude/latitude 都是 Decimal(10,7) 的 WGS84 坐标 | prisma/schema.prisma 的 Activity、ActivitySession | B2 的兼容输出固定为 WGS84、7 位小数；未来写入旧字段必须成对进行。 |
| ActivitySession 已有坐标成对和定位半径约束 | 第 76 条 session migration 的 activity_session_coordinate_pair_check 与 activity_session_location_policy_check | B2 不改既有约束，也不把多个新角色压成一个旧场次坐标。 |
| 签到与打卡运行链直接将旧 Activity/ActivitySession 坐标交给 WGS84 Haversine 计算 | src/modules/attendances/haversine-distance.ts；app-activity-check-ins.service.ts；attendance-punch-command.service.ts | B2 不能把运行时改为读取 ActivityPlace；任何未来进入旧字段的坐标必须先转换。 |
| B1 没有 PlacePreset/ActivityPlace writer，也没有 role 唯一约束 | B1 schema、migration 与评审稿 3.2、3.3 | B2 不能假设每个 scope 恰有一条 primary，更不能用 findFirst 式选择。 |
| 仓内没有 gcj02、bd09、coordtransform 或 proj4 实现/依赖 | 以 rg 与 git grep 分别检索 src、package.json、pnpm-lock.yaml | B2 需新建本地纯实现；不得通过网络、SDK、缓存或新环境变量获取转换结果。 |
| 当前 migration 计数为 106，九份 E2E 均写有 CURRENT_MIGRATION_COUNT | docs/current-state.md；九份 migration E2E 的双工具清点 | B2 预期成为第 107 条，所有现存计数执行位必须同步并以二次工具复核。 |

## 3. 方案 A 的精确边界

### 3.1 新地点的坐标存储合同

坐标仍以地图来源的原始坐标系保存在 PlacePreset 或 ActivityPlace。坐标系编码统一为小写闭集 wgs84、gcj02、bd09；它说明经纬度的语义，不代表 provider、可见范围或权限。

| 输入形状 | 数据库结果 | 理由 |
| --- | --- | --- |
| longitude、latitude、coordinateSystemCode 都为 NULL | 允许 | 无地图时仍可保存文字地点；B4 才判断定位活动能否发布。 |
| longitude、latitude 同时非空，coordinateSystemCode 为 wgs84、gcj02 或 bd09 | 允许，且经纬度须在全球有效范围内 | 是可转换的完整点位。 |
| 仅一个坐标非空 | 拒绝 | 单边坐标没有空间语义。 |
| 坐标为空但坐标系非空 | 拒绝 | 没有坐标的地点不能声称某个坐标系。 |
| 两个坐标齐全但坐标系为空或不在闭集 | 拒绝 | 不能安全投影到旧 WGS84 字段。 |
| 经度不在 -180 至 180，或纬度不在 -90 至 90 | 拒绝 | 不是有效的地理坐标。 |

第 107 条 migration 必须在两张 B1 新表上各落下三条已验证的 CHECK，且不能使用 NOT VALID 延后校验：

| 表 | 约束名 | 物理规则 |
| --- | --- | --- |
| PlacePreset | place_preset_coordinate_pair_check | longitude 与 latitude 同空或同有。 |
| PlacePreset | place_preset_coordinate_system_check | 无坐标时 system 也为空；有坐标时 system 必在三值闭集。 |
| PlacePreset | place_preset_coordinate_range_check | 坐标存在时经纬度同时为非空有限的全球合法范围。 |
| ActivityPlace | activity_place_coordinate_pair_check | longitude 与 latitude 同空或同有。 |
| ActivityPlace | activity_place_coordinate_system_check | 无坐标时 system 也为空；有坐标时 system 必在三值闭集。 |
| ActivityPlace | activity_place_coordinate_range_check | 坐标存在时经纬度同时为非空有限的全球合法范围。 |

SQL 不能依赖 CHECK 对 NULL 的默认放行。每一条“有坐标”的分支都必须显式检查 longitude、latitude、coordinateSystemCode 非空；原始 SQL E2E 必须覆盖 SQLSTATE 23514 和上述精确约束名。

providerCode 与 providerPlaceId 继续保持可空自由文本。本仓尚未选定地图提供方、可信性或生命周期合同，B2 不把未来 provider 的真假判断伪装成坐标校验。

### 3.2 纯转换策略

实现位是 activities 模块内的纯函数，不注入 Prisma、不查询数据库、不读取配置、不写审计、不调用网络。它只接受已完整读取的地点候选并返回显式结果：

| 输入坐标系 | 处理 | 输出 |
| --- | --- | --- |
| wgs84 | 恒等映射 | 同一 WGS84 点。 |
| gcj02 | 以固定次数和收敛精度的本地逆变换求 WGS84 | 一个可投影的 WGS84 点，或不可投影。 |
| bd09 | 先本地 BD-09 转 GCJ-02，再走同一 GCJ-02 逆变换 | 一个可投影的 WGS84 点，或不可投影。 |

gcj02 和 bd09 的转换仅在冻结的中国大陆转换包络内进行：经度 72.004 至 137.8347、纬度 0.8293 至 55.8271，边界包含在内。这个包络只限制“能否安全投影”，不是地点存储、权限或发布的地域限制。落在包络外的非 WGS84 点返回“不可投影”，绝不静默当作 WGS84 原样返回。

转换成功后以 7 位小数、half-up 规则固化为旧列可保存的 Decimal(10,7) 值。GCJ-02 逆变换必须使用固定上限的迭代并有收敛判定；BD-09 不得直接套到 WGS84。单测的期望坐标必须来自独立冻结样例或手工审核数值，不能拿同一待测函数反算作期望。

### 3.3 旧字段兼容投影的选择规则

本刀定义“如何安全得到旧字段候选”，但不在 B2 接线任何 writer。未来 B6 创建命令在同一个活动根事务里保存 ActivityPlace 本地快照，再调用该纯策略；只有结果为“可投影”时才成对写入旧 WGS84 列。

| 候选 ActivityPlace 集合 | 可投影的旧坐标目标 | 不满足时 |
| --- | --- | --- |
| sessionId 为空、roleCode 为 primary、该活动范围内恰有一条且坐标完整可转换 | Activity.locationLongitude 与 Activity.locationLatitude | 返回不投影；既有旧值不被清空。 |
| 某一 sessionId、roleCode 为 primary、该场次范围内恰有一条且坐标完整可转换 | ActivitySession.longitude 与 ActivitySession.latitude | 返回不投影；既有旧值不被清空。 |
| meeting、execution、evacuation、parking、other，或同一 scope 有多条 primary | 无 | 旧模型没有等价的角色坐标槽位，不能任意选一条或覆盖主点。 |
| PlacePreset | 无 | 它只是来源；B6 必须先复制成 ActivityPlace 快照后再评估。 |

因此 B2 明确禁止以下行为：

- 不给 ActivityPlace 加 role 唯一约束来强迫历史数据适应旧模型。
- 不给 Activity 或 ActivitySession 加触发器、生成列、回填、双写或读时 join。
- 不修改既有 Activity 写入、发布 proposal、签到、打卡、Haversine 或快照 v2 至 v5 的行为。
- 不把不可投影、缺坐标或角色歧义解释成零坐标、旧值清空或“默认第一条”。
- 不修改 Activity.location、ActivitySession.locationText、meetingPoint、executionPoint、evacuationPoint 的文字投影；文字角色映射属于 B6 的创建合同。

### 3.4 明确不在 B2 的范围

不新增地图搜索、地图 SDK、地图 provider 配置、地址标准化、空间检索、区域/路线/危险区、PostGIS、坐标专用加密仓、坐标保留期限、坐标专用角色、接口、DTO、Swagger、权限码、审计事件、发布 gate、表单字段、快照字段、旧数据回填或生产 deploy。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 新地点三值坐标闭集和数据库完整性；本地确定性转换；歧义或不可投影时不写旧字段；真正写入推迟到 B6 事务。 | 既守住旧 WGS84 签到语义，也不抢跑 B4/B6。 |
| B | 只允许 wgs84，推迟 gcj02/bd09。 | 看似更小，但与“地图坐标系”目标不完整，会迫使未来中国地图接入重新改数据库合同。 |
| C | coordinateSystemCode 保持任意字符串，或 GCJ/BD 坐标直接复制到旧列。 | 无法证明旧列仍是 WGS84，签到半径会产生静默误判。 |
| D | 用触发器、现有旧 writer 或读时同步立即投影。 | 把 B6 创建语义、历史兼容和运行时行为混入 D 档 schema 刀，无法独立回归和回退。 |
| E | 引入第三方地图/转换 SDK、网络服务、PostGIS 或缓存。 | 增加外部故障面、依赖和配置，违反本阶段 No-AI/无地图降级与基础设施冻结边界。 |

## 5. 风险、验证与 migration rehearsal

| 风险 | 处理和执行位 |
| --- | --- |
| B1 期间存在单边坐标或未知 system 的非空数据 | 在隔离库先应用 106 条 migration、插入合法地点后升级 107；另建独立非法库插入 B1 当时允许的脏行，107 必须失败、migration 计数仍为 106、六条新 CHECK 零部分存在。 |
| SQL 因 NULL 三值逻辑漏放行 | 原始 SQL 分别插入单经度、单纬度、system-only、pair-without-system、unknown-system、越界经纬度；逐条断言 23514 与精确 constraint 名，并有每个合法正对照。 |
| 转换算法把 GCJ/BD 当 WGS 或在包络外乱移 | 单元测试分别覆盖三坐标系、边界、包络外、非有限数、BD-09 链路、固定精度与已审核样例；不可投影只能返回显式结果。 |
| 多地点角色被任意挑选 | 纯策略对零条、多条、缺坐标、非 primary 和不同 session 分别返回不投影；不允许依赖数组顺序或数据库查询顺序。 |
| B2 意外改变签到/打卡行为 | 既有 app check-in、attendance punch 和 session 坐标约束测试保持原断言；B2 不改它们的 source，PR diff 要证明没有接线。 |
| 文字地点因地图故障被错误拒绝 | E2E 保留 NULL/NULL/NULL 的 PlacePreset 与 ActivityPlace 正例；Readiness 仍留 B4。 |
| migration 计数或派生文档陈旧 | 九份现存 CURRENT_MIGRATION_COUNT 执行位从 106 同步为 107，先用 Node 清点、再用 rg 清点；所有最后写入后才运行 docs:refresh，并立刻跑全部生成物 check。 |

实施后的最低验证：

1. Prisma schema validate 与 generate，lint、typecheck、agent:check:quick。
2. 新增 B2 的 PostgreSQL E2E：六条 CHECK、三种合法坐标系、冷库 107 回放、106 到 107 的合法非空升级、非法非空库 fail-closed。
3. 新增纯转换单测，并运行 B1 地点 E2E、既有签到/打卡定位 E2E 与九份 migration-count E2E。
4. 运行 test:contract，确认无 API 或 snapshot 差异；PR CI 冷跑 agent:check:full 作为全量结论。
5. 不运行 prisma migrate dev、prisma migrate reset、prisma db push，不对生产或真实数据环境执行 migration。

## 6. 预期写集与授权预算

### 6.1 本次已获授权

当前 B2 review PR 只获如下精确写集：

- docs/archive/reviews/activity-os-r2-b2-coordinate-projection-review.md：新增本冻结评审稿；此路径已由维护者在本 worktree 发放精确红区授权。
- docs/ai-harness/FROZEN_DRAFTS.md：新增一条 B2 的 open 分类。它是 archive 新增文件的 CI 强制机械登记，harness:needs 已确认该路径不是红区。

除上述两份文档外，本稿不授权其它路径，也不把“起草方案 A”解释成 schema、migration 或代码实施授权。

### 6.2 B2 实施前仍需维护者确认的写集

下表是预算而非已授权清单。评审稿合入后，必须在独立 B2 implementation worktree 对实际路径逐文件运行 harness:needs，再由维护者发放精确授权。

| 预期路径 | 用途 |
| --- | --- |
| prisma/schema.prisma | 仅为 B1 两个地点模型补充与第 107 条物理约束一致的说明；不改 Activity 或 ActivitySession 旧字段。 |
| prisma/migrations/YYYYMMDDHHMMSS_activity_os_r2_b2_coordinate_projection/migration.sql | 第 107 条 transaction：六条 CHECK，无 DML、无回填、无触发器、无 NOT VALID。 |
| src/modules/activities/activity-place-coordinate-projection.ts 及其单测 | 无数据库依赖的坐标转换、歧义判定和旧字段候选策略。 |
| test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts | 新地点约束和 106 到 107 rehearsal。 |
| 下列九份现存 migration-count E2E | 把 CURRENT_MIGRATION_COUNT 从 106 同步到 107；不得只改其中一部分。 |
| docs/current-state.md、CODEMAP.md、harness/domain-map.json、harness/state-machines.json、docs/ai-harness/CUTOVER_SIGNOFF.md | 仅在生成器或 migration 3b 签字要求时最小更新；先让检查决定实际 diff，不手工猜生成物。 |

test/setup/reset-db.ts 已在 B1 把 ActivityPlace 与 PlacePreset 纳入正确 TRUNCATE 顺序；B2 不新增表，不应改动该文件。package.json、pnpm-lock.yaml、controller、DTO、Swagger、路由、权限码、RBAC seed、AuditLogEvent、全局 Gate、旧 Activity/ActivitySession 字段、快照与生产 deploy 均不申请。

prisma/CLAUDE.md 的 B1 合并状态陈旧是独立事实更正，不自动并入 B2。若维护者希望它在未来 B2 migration 登记中一并改正，必须在实施授权时明确写入；否则单开最小文档更正。

九份 migration-count 执行位的精确清单如下：

- test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
- test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
- test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
- test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
- test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts

## 7. 维护者决策记录与下一次确认

维护者于 2026-09-03 已确认：

> 确认起草 B2 评审与授权清单（方案 A）

这只批准新增和评审本稿。维护者阅读并认可上述数据合同、转换包络和“歧义不投影”规则后，下一步需明确回复：

> 确认 B2 方案 A

该确认也只批准进入独立 implementation 授权清单的准备阶段。实际 schema、migration、测试或运行时代码仍须在 review PR 独立合入后，按真实 diff 重新申请授权；第 107 条 migration SQL 逐行审查完成后，还必须单独确认：

> 确认重签 3b（B2，第 107 条 migration）

任何 B3 至 B7 内容均不随本决定带入。
