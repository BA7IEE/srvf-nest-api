# Activity OS R1 / A7：周期 Series 与手工／按需生成评审与授权清单

> **状态：已拍板，本地验证与签字闸均完成。** 维护者已确认“确认 A7 方案 A”、下述收据更正（方案 A）、“确认重签 3b（A7，第105条 migration）”及“确认重签 4b（A7：Audit events 157 总计、152 活跃）”。第 105 条已在隔离测试库顺序回放，A7 E2E 与 contract 已通过；未部署 migration，现待 PR CI 冷跑后进入合入评审。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §5、§8、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§5.5、§7.5、§7.6、§15.2、§18、§23.5。A1 至 A6 已分别合入 #1237、#1239、#1241、#1244、#1246、#1248；本刀不重开已落地决策。

## 1. 维护者最低阅读量

### 人话简报

- **做什么**：给周期轮值、月度训练、定期会议和固定保障建立稳定的 Series / 不可变 Revision，并通过内部命令手工或按需生成未来独立 Activity。
- **不做会怎样**：现在只能逐个调用 A6 创建活动；没有周期事实、单期防重或批次重放锚点，人工重试和并发补齐都会有重复或半批风险。
- **最坏情况与回退**：本刀是新表 / 新关系的 additive migration；代码部署前可回退。migration 一旦落到环境，保留空表和引用，不以 DROP 回滚；每一条生成命令必须原子失败，不能留下半批 Activity。
- **推荐方案**：方案 A。用受限的 Series Definition V1、不可变 Revision、通用命令收据和单期 Occurrence 锚点；时区首期固定为 `Asia/Shanghai`；不新增 cron、依赖、外部入口或资源 / 地点 / 表单能力。

### 需要维护者确认的三个边界

1. **时区归属**：当前 T0-A 把时区归于 Series / Revision，而原始蓝图写“新活动时区 `Asia/Shanghai`”；现有 `Activity`、模板 Definition V1 和所有 migration 都没有 `timeZone` 字段。方案 A 将 `timeZone` 持久化在 Revision 且首期只允许 `Asia/Shanghai`，生成后的 Activity 保持既有 UTC 时间戳，不新增 Activity 时区列。若需要每一期独立 IANA 时区，必须另立 D 档。
2. **生成输入**：A6 命令强制要求 `title`、`organizationId`、`startAt`、`endAt`、`location`。模板 V1 不含标题、活动地点或活动时段，不能以模板名、模板场次地点或发起人偷偷补值。方案 A 要求 Revision 明确保存字面标题、文字地点、本地开始时刻和时长；不引入表达式、日期模板或任意脚本。
3. **负责人和资源**：`ActivityResponsibilityAssignment` 是“某个 Activity × Member”的已生效责任事实，不能被 `initiatorMemberId` 或 Series owner 冒充；仓内也没有 Resource Requirement 真相模型。方案 A 不存 JSON 占位、不自动创建责任分配、不创建资源需求，生成结果的 `initiatorMemberId` 保持空。以后有正式模型后另刀接入。

已获维护者 **“确认 A7 方案 A”**。实施仍须遵循精确写集；migration SQL 定稿后仍须另行完成第 105 条 3b 重签。

## 2. 已核验事实与必须补齐的缺口

| 事实 / 缺口                                                                                                                    | 证据                                                                          | A7 的处理                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Series / Revision 负责周期、时区、模板版本、生效期、默认组织和生成窗口；生成实例是独立 Activity                                | T0-A §5；原始蓝图 §7.5                                                        | 新建稳定 Series 与不可变 Revision，Activity 只通过 Occurrence 保存来源锚，不由 Series 后续写回。              |
| 首期只能人工未来 N 期、打开 Series 按需补齐或受控外部调度调用幂等命令；不得新增第三个 cron                                     | T0-A §5；原始蓝图 §7.6；全仓仅通知模块两个 `@Cron`                            | 仅内部 façade；零 `@Cron`、`ScheduleModule`、queue、Redis、缓存或定时器。外部 Integration 入口不属于 A7。     |
| T0-A 已点名 CreateActivitySeries 与 GenerateSeriesInstances，且所有写命令必须有权限、事务、幂等、校验、审计和安全 DTO          | T0-A §8                                                                       | 新增显式内部 application façade；不使用 Command Bus，不暴露 Prisma row。                                      |
| A6 的从模板创建要求精确 Version、严格 Definition V1、事务、审计和 `operationKey`；命令输入必须显式有标题、组织、起止时间和地点 | `src/modules/activities/activity-from-template.service.ts`；A6 评审 §3.1–§3.5 | A7 不猜输入；每个 Occurrence 以 Revision 的明确输入物化，再复用 A6 的受控 transaction-bound primitive。       |
| A6 自己开启 transaction，直接在 N 期循环中调用会造成“前几期已提交、后几期失败”的半批                                           | `activity-from-template.service.ts:195–329`                                   | A7 只能抽取不改变 A6 外部语义的 transaction-bound materializer，并由 Generate 命令持有唯一根事务。            |
| 当前不存在 ActivitySeries / Revision，也不存在 Activity / Template 的 timezone 持久化列                                        | `prisma/schema.prisma` 全文检索；T0-A §5；原始蓝图 §5.5                       | 本刀按方案 A 新增 Series 族表，Revision 保存固定 `Asia/Shanghai`；不扩 Activity 时区。                        |
| Node 22 原生 `Intl` 可识别 `Asia/Shanghai`；`package.json` 未声明 luxon / rrule / date-fns 等依赖                              | 当前 runtime 与 `package.json`                                                | 只实现闭合的规则 V1，不依赖 transitive 包、不改 package / lock。                                              |
| 现有责任事实与 Activity 强绑定，资源域尚无业务模型                                                                             | `ActivityResponsibilityAssignment`；`src/modules/` inventory                  | 不把 Series 默认负责人或资源需求伪造成 `initiatorMemberId`、JSON 或新表。                                     |
| Activity 发布与审计链已有严格快照语义，Series 后续变化不能回写已生成或已发布实例                                               | T0-A §5；原始蓝图 §7.4 / §7.5 / §23.5                                         | Occurrence 保存创建时所用 Revision；Revision / Series 变更不更新任何 Activity、Session、Position 或发布快照。 |

## 3. 方案 A：严格 Series Definition V1

### 3.1 命令边界与权限

仅增加模块内 application façade，不新增 controller、HTTP DTO、Swagger、route、权限码、RBAC seed、Gate 或 Integration endpoint：

| 命令                      | 权限                          | 幂等锚                                                                        | 结果                                                      |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `CreateActivitySeries`    | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash                                 | 新建 Series 与 Revision 1。                               |
| `ReviseActivitySeries`    | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash                                 | 只追加下一条不可变 Revision，绝不 UPDATE 旧 Revision。    |
| `SetActivitySeriesStatus` | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash                                 | 仅改 Series 生命周期 `active / paused / terminated`。     |
| `GenerateSeriesInstances` | 复用 `activity.create.record` | 通用命令收据的 `operationKey` + canonical requestHash；单期 Occurrence unique | 在一个事务内生成或返回指定窗口内已有的独立草稿 Activity。 |

这里的 Revision 与状态命令是内部写命令，不是新 API surface；名字的目的仅是让每一条写行为都有独立权限、事务、幂等、校验和审计归属。外部受控调度的 Integration 契约留给后续 Integration 业务面单独立项，不能在 A7 偷接。

### 3.2 Revision 的闭合输入

Revision 只接受严格白名单，不接受 rrule 字符串、cron 表达式、任意 JSON、模板插值、JavaScript 或动态 SQL：

| 区域         | V1 允许内容                                                                     | 规则                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 模板来源     | `templateVersionId`                                                             | 必须是精确 future Family Version；首次生成仍复验 A3 canonical/hash 和 A6 selectable 规则，不按 Family 或 `activityTypeCode` 猜版本。 |
| 周期         | `daily` / `weekly` / `monthly`、interval、weekly weekdays、monthly day-of-month | `daily` / `weekly` / `monthly` 都是有限枚举；weekly 至少一个星期几；monthly 的缺失日期一律 **skip**，不静默挪到月末。                |
| 时区         | `timeZone`                                                                      | 首期唯一允许 IANA 值 `Asia/Shanghai`；所有 timestamp 仍以 UTC 存库。日后多时区、DST 和 Activity 独立时区另立 D 档。                  |
| 时段         | 本地开始日期、本地开始时刻、`durationMinutes`、有效起止区间                     | 从 `Asia/Shanghai` 本地规则确定 UTC `startAt/endAt`；有效区间和生成窗口必须有上界。                                                  |
| 活动创建输入 | 字面 `title`、`organizationId`、字面 `location`、可选报名截止偏移               | 直接补齐 A6 所需输入；标题 / 地点不做插值或默认猜测。报名截止未配置即为 null。                                                       |
| 生成窗口     | `generationWindowDays` 与单次 `count` 上限                                      | 只允许有限、正整数范围；精确上下限在实现前由评审稿的测试和 SQL CHECK 一并固定，不能依赖内存保护。                                    |

`initiatorMemberId` 必须保持未设置。Series 身份、模板 owner、组织 owner 或创建者均不等于某一期 Activity 的责任事实；任何自动分配都需先有责任规则的独立合同。

### 3.3 持久化形状与不变量

方案 A 使用四个新表，不把 Series 规则塞进 `Activity` JSON，也不复用 Integration command receipt：

| 表                             | 责任                                                                      | 关键约束                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ActivitySeries`               | 稳定身份与生命周期                                                        | 唯一 code；状态只允许 `active / paused / terminated`；更新只允许状态与时间戳，不存可变周期规则。                                                             |
| `ActivitySeriesRevision`       | 不可变的 V1 周期、Version、时区、有效区间和生成输入                       | `(seriesId, revision)` 唯一；对 Series、Template Version、组织、创建人均为 Restrict FK；CHECK 守时间/范围/规则形状；migration trigger 拒绝 UPDATE / DELETE。 |
| `ActivitySeriesCommandReceipt` | Series 的 Create / Revise / SetStatus / Generate 四类命令共用的持久化收据 | `operationKey` 全局唯一，配套 commandCode 与 requestHash；重放只返回同一结果，hash 不同失败；不存原始请求或敏感数据。                                        |
| `ActivitySeriesOccurrence`     | 单个已生成期的唯一锚、创建时 Revision 和独立 Activity 的来源关系          | `(seriesId, occurrenceKey)` 唯一、`activityId` 唯一；Occurrence 保存 UTC 起止与不可变 Revision id；不允许重指向或删除。                                      |

`occurrenceKey` 是由 Revision 的本地规则和固定时区规范化得出的稳定键，不用墙钟、标题、调用者或随机数。它守住“同一 Series 的同一期最多一个 Activity”；不同批次、不同用户或外部调度对重叠窗口的调用都不能重复建单。

Receipt 与 Occurrence 的 `revisionId` 均和 `seriesId` 组成复合外键，引用 Revision 的 `(id, seriesId)` 复合唯一锚。这样数据库也会拒绝“Series A 的收据／期次挂 Series B 的 Revision”，不能只靠应用层约定保持来源链一致。

**已确认的收据更正**：早期草案将第三张表命名为 `ActivitySeriesGeneration`，其名称错误地暗示收据只服务 Generate。维护者已确认改为通用 `ActivitySeriesCommandReceipt`：同一张表覆盖 Create / Revise / SetStatus / Generate，`commandCode` 区分语义，仍然只有上述四张新表，绝不新增第五张收据表，也不因此新增 API、权限或 cron。

Revision 变更的语义固定如下：

1. 新 Revision 只决定其有效区间内、尚无 Occurrence 的期。
2. 已有 Occurrence 的 Activity、Session、Position 和审计永不被 Series / Revision 更新。
3. 已生成草稿的批量同步功能 **不在 A7**。原蓝图要求人工明确选择；A7 宁可不提供该命令，也不能默认修改草稿。
4. 已发布 Activity 绝不自动变化。任何未来批量草稿更新都要单独命令、明确选择和 D 档评审。

### 3.4 单事务、锁与重放

`GenerateSeriesInstances` 的根事务按以下顺序执行：

1. 按 CommandReceipt `operationKey` 查成功收据；相同 requestHash 直接返回既有结果，hash 不同报冲突，不再看当前 Series 状态。
2. 首次执行锁住 Series 行，再锁定命中的 Revision 和精确 Template Version；paused / terminated、有效期不匹配、模板 retired / legacy / hash 不一致或规则不合法均零写入失败。
3. 由纯函数从 Revision 生成有限个候选 occurrence；排除有效区间之外和窗口之外的本地期，规范化为稳定 `occurrenceKey`。
4. 对每个候选按 Occurrence 唯一锚检查或创建。已有同 key 时返回其 Activity，不改写其任何字段；新 key 才调用 A6 的 transaction-bound materializer，创建独立草稿、Session、Position 与 Activity 审计。
5. 在同一根事务内写 Occurrence、CommandReceipt 和 Series 审计。任一校验、单期物化、审计或唯一冲突处理失败，全批回滚。
6. 并发撞唯一后回读对应收据 / Occurrence：相同 hash 或同一期返回既有结果；不同 hash 的同一命令 key 明确失败，绝不泄露 P2002 或返回 500。

这要求从 A6 抽取 transaction-bound materializer，但其现有 public `createFromTemplate()` 行为、错误码、hash 结构、模板锁顺序、审计形状和 E2E 必须先做 characterization 再原样保留。不得复制一份模板物化逻辑，也不得让 A7 在 transaction 中嵌套调用 A6 的 public 方法。

### 3.5 审计与安全输出

每一条成功写命令写安全审计；重放不追加审计。需要在实施时将新增审计事件和 `resourceType` 明确登记，不能借用含义不符的字符串：

- Series 创建 / Revision 追加 / 生命周期改变：resource 为 `activity-series`，extra 至多记录 `operation`、revision、状态和安全的 Series id。
- 每期生成：仍以 Activity 为资源，extra 至多记录 `operation: generate_series_instance`、Series id、Revision、occurrenceKey 和模板 Version id；不记录 `operationKey`、requestHash、完整周期定义、成员资料、表单答案或 signed URL。
- 批次收据仅用于重放，不作为 API 返回 Prisma row；内部 façade 返回安全的 Series / Activity 摘要。

新增 `AuditLogEvent` union 值属于审计语义变更，必须在维护者授权和测试内显式登记；不能把审计缺口藏在 `extra` 中。

## 4. 方案比较

| 方案      | 内容                                                                                                   | 结论                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A（推荐） | 闭合 V1 周期 + 固定 `Asia/Shanghai` + Series / immutable Revision + CommandReceipt + Occurrence unique | 有可证明的单期防重、批次重放与历史隔离；不引新依赖或 cron，能逐条测试和回退。                               |
| B         | 直接接通用 rrule、全 IANA 时区和第三方时间库                                                           | 需要 package / lock D 档授权、DST 和异常本地时间合同，且当前 Activity 没有独立 timezone 字段；范围超过 A7。 |
| C         | Series 只存 JSON，循环调用 A6，每期各自提交                                                            | 中断会留下半批，且没有可靠的同一期唯一锚；不满足写命令事务与幂等合同。                                      |
| D         | 直接把 Series 更新批量同步到已生成草稿，或把负责人 / 资源需求一起落表                                  | 会重开责任、资源、地点、表单和发布边界，违反“必须人工选择”和一轴一 PR。                                     |

## 5. 明确不做

- 不新增第三个 cron、`ScheduleModule` 注册、定时器、queue、Redis、缓存、LLM、AI、pgvector 或 PostGIS；
- 不新增 HTTP / Swagger / DTO / route / Integration endpoint / Feature Gate / 权限码 / RBAC seed；
- 不改 A5 fallback、既有普通创建合同、A6 public façade 的语义、发布快照、Readiness、地点、表单、资格、通知、指标、时长或贡献；
- 不把 Series owner、模板 owner 或调用者写成 `initiatorMemberId`，不自动创建 `ActivityResponsibilityAssignment`；
- 不为资源需求、地点坐标或表单建立 JSON 占位或“先占位以后再用”的字段；
- 不回填、重解释、批量更新或物理删除历史 Activity / Session / Position / Audit；
- 不对已生成草稿或已发布活动做自动变更，不输出 secret、signed URL、完整请求体或敏感资料。

## 6. 验证、迁移与回退

实施后至少必须完成：

1. **纯函数 / 单元**：V1 白名单拒绝、`Asia/Shanghai` 本地规则到 UTC 的确定性转换、daily / weekly / monthly 边界、月内缺失日期 skip、有效区间、窗口与 count 上限、canonical requestHash、同 key 重放与冲突。
2. **服务 characterization**：抽取 A6 primitive 前后，现有 A6 的模板选择、hash、锁、错误、审计和输出逐字行为不变。
3. **PostgreSQL E2E**：创建 Series + Revision；同批重放；两个 Nest / Prisma pool 对同 Series 和同 occurrence 真并发；重叠窗口不重复；Revision 只影响尚未生成期；已生成 draft 和 published Activity 零改动；paused / terminated / retired template / hash 不一致全部零写入；审计失败全批回滚。
4. **migration rehearsal**：第 105 条仅新增四张表、FK、index、unique、CHECK 和不可变 trigger；不运行 `prisma migrate dev`、`reset` 或 `db push`，不回填、不删改数据。先逐行审查 SQL，再由维护者重签 3b。
5. **回归与派生文档**：受影响单元 / E2E、`pnpm agent:check:full`、`pnpm test:contract`、`pnpm docs:refresh`、派生检查和 PR CI 冷跑。无 Docker 时仅报告 quick，contract / E2E 留 CI，不得声称全绿。
6. **回退**：代码未部署时可整体回退；migration 应用后保留 additive 表与约束，不以 DROP 破坏未来产生的 Series / Occurrence 事实。

## 7. 预期写集与授权预算

### 7.1 已确认的实施范围

- `docs/archive/reviews/activity-os-r1-a7-series-generation-review.md`：将本稿改为已拍板状态，并登记通用 `ActivitySeriesCommandReceipt` 的四命令收据更正；
- `prisma/schema.prisma`：四张 Series 族模型及必要的反向关系；
- `prisma/migrations/20260902190221_activity_os_r1_a7_series_generation/migration.sql`：第 105 条 additive SQL；已逐行审查并完成 3b 重签；
- 已获普通写集：活动模块 Series façade、A6 transaction-bound primitive、审计类型、单元与 A7 E2E，以及既有 migration 数量断言的 104 → 105 同步。
- `src/common/datetime/date-only.util.ts`：只导出既有北京日界的唯一 IANA 常量，供 A7 复用日界转换；不新增另一套日期 / 时区算法或配置入口。
- `changelog.d/activity-os-r1-a7-series-generation.md`：A7 lane 的待归并变更说明；不直接改 `CHANGELOG.md`。

以上不改变“迁移 SQL 审查后另行 3b 重签”的边界，也不授权部署迁移、改 API surface、改权限或扩展到其他业务域。

### 7.2 未获授权的后续写集预算

下列仍是预算，不是预授权。必须以实际 diff 调用 `pnpm harness:needs` 收敛，再由维护者在 A7 worktree 亲自执行精确 `harness:grant`。

| 路径 / 范围                                                                                                                         | 为什么可能需要                                                                                     | 是否红区                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `docs/ai-harness/ROUTE_AUTHZ.md`、`harness/authz-assertion-patterns.json`、`harness/domain-map.json`、`harness/state-machines.json` | 仅在实际派生检查要求时刷新 authz 摘要、模型归属与状态机取证；零 route / 权限语义变更               | 后三者均为红区 / 执法层；以实际 needs 结果为准                   |
| `test/setup/reset-db.ts`                                                                                                            | 公共 E2E 清表清单必须显式先清四张 A7 表；否则新 FK 对 `Activity`、模板、组织或用户留下跨 spec 残留 | 红区 / 测试基础设施；只补清表顺序和表数，不改 reset 的测试库断言 |
| `docs/ai-harness/CUTOVER_SIGNOFF.md`                                                                                                | migration 3b 重签登记                                                                              | 仅在 SQL 审查后、维护者确认时改                                  |

明确不申请：`package.json` / `pnpm-lock.yaml`、`src/app.module.ts`、权限 catalog / seed、controller、Swagger、route contract、全局 Guard / Filter / Interceptor、auth、notifications cron、Resource / Place / Form 域、生产数据库。

## 8. 3b 后验证记录

截至 2026-09-02，实施侧已完成以下可不触库核验：

- 第 105 条 SQL 逐行复核为纯 forward-expand：恰四张 Series 表、9 条 `RESTRICT` 外键、必要 index / unique / CHECK 与四个不可变 trigger；零回填、seed、`INSERT`、`UPDATE`、`DELETE`、`DROP` 或 `TRUNCATE`。
- `ActivitySeriesRevision` 增加 `(id, seriesId)` 复合唯一锚；Receipt 与 Occurrence 均以 `(revisionId, seriesId)` 复合外键引用它。静态 migration 断言锁住两处外键，A7 E2E 已补“跨 Series 伪造 Revision 指向必须得到 P2003”的运行时回归。
- A7 排期不保留第二套时区算法：固定 IANA 值及本地日界转换复用 `common/datetime/date-only.util.ts` 的唯一北京日界入口。
- 已通过 `prisma validate`、`prisma:generate`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`（286 suites / 6810 passed / 5 todo）、`pnpm harness:selftest`（543 passed / 0 failed）及全部相关派生文档检查。

### 8.1 T0-A / 蓝图逐项对照

| 冻结要求 | A7 实装与证据 |
| --- | --- |
| Series / Revision 保存周期、时区、精确模板版本、有效期、默认组织与有限生成窗口 | `ActivitySeries`、`ActivitySeriesRevision` 与第 105 条 migration；V1 schedule 单元测试覆盖 daily / weekly / monthly、月末缺日 skip、时区和上限。负责人规则、资源需求没有真相模型，按已拍板边界不伪造为 `initiatorMemberId` 或 JSON。 |
| 每一期是独立 Activity；Series 改动不回写已生成或已发布实例 | Occurrence 以 `(seriesId, occurrenceKey)` 与 `activityId` 唯一锚定来源；A7 E2E 验证 Revision 只影响尚未生成期，既有 published Activity 的标题和状态不变。 |
| 只能人工 / 按需的幂等生成，不新增第三个 cron | `ActivitySeriesService.generate()` 是内部 application façade，使用通用 CommandReceipt 绑定 command / canonical hash；没有 controller、Integration endpoint、`@Cron`、queue 或 timer。派生计数仍为 570 endpoint、2 cron。 |
| 每条写命令都有权限、事务、校验、审计和安全输出 | create / revise / setStatus / generate 全部先判 `activity.create.record`，各自由根 `$transaction` 包裹、持久化 Receipt 并写安全审计；返回 `ActivitySeriesCommandResult`，不返回 Prisma row、operationKey、requestHash 或 definition 原文。 |
| 模板版本或审计失败时不留下半批事实；重叠窗口不得重复建单 | A7 E2E 直接覆盖 retired / definitionHash 不一致零写入、审计注入失败整批回滚，以及双 Nest / Prisma pool 真并发下只有一个 Occurrence。 |

维护者于 2026-09-02 确认 3b 后，已在受测试库保护的 global setup 中完成以下运行期验证：

- 105 条 migration 顺序回放成功；第 105 条只应用于隔离测试库，未触碰生产库。
- `JEST_MAX_WORKERS=1 pnpm test:e2e -- activity-os-r1-a7-series-generation.e2e-spec.ts`：1 个套件、9 个用例通过，覆盖创建与重放、Revision 隔离、paused / terminated / retired / hash 冲突零写入、双池重叠窗口并发、审计失败整批回滚、跨 Series 复合 FK 和 resetDb 清理顺序。
- `JEST_MAX_WORKERS=1 pnpm test:e2e -- activity-os-r1-a6-from-template-transaction.e2e-spec.ts`：1 个套件、6 个用例通过，确认抽取 transaction-bound materializer 后 A6 的公开创建 / 重放 / 审计合同仍保持原样。
- 8 个把 `CURRENT_MIGRATION_COUNT` 从 104 同步为 105 的既有 migration E2E：8 个套件、69 个用例通过，继续锁住历史 migration 的 additive 形状、约束和不可变性。
- `pnpm test:contract`：1 个套件、975 个断言、2 个快照通过。

未运行本机 `pnpm agent:check:full`：仓库 release 流程已明确该命令在本机重复榨干全量 E2E 会产生假红；全量口径由后续 PR CI 冷跑承担。已完成的本地 lint、typecheck、build、unit、harness 与本刀 E2E / contract 证据不以此冒充 PR CI 结果。

## 9. migration 复核已完成

第 105 条 SQL 已由维护者逐行审查并于 2026-09-02 重签 3b；其只含四张 additive 表、FK、index、unique、CHECK 与不可变 trigger，未引入回填、删改数据或部署动作。确认原文为：

```text
确认重签 3b（A7，第105条 migration）
```

该签字已允许隔离测试库 rehearsal 与后续合入评审，不授权 production deploy。因 A7 新增 `activity-series.change` 审计事件，签字总闸的 4b 对拍从 156 / 151 变为 157 / 152；维护者已于 2026-09-02 单独重签，签字闸现已通过。
