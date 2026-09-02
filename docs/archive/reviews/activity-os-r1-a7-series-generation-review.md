# Activity OS R1 / A7：周期 Series 与手工／按需生成评审与授权清单

> **状态：草案，尚未拍板。** 本稿只记录 A7 的可选方案、风险、写集和后续授权预算；未获得维护者“确认 A7 方案 A”前，禁止创建 `ActivitySeries`、`ActivitySeriesRevision`、生成收据或任何 migration，禁止改 A6 写路径。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §5、§8、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§5.5、§7.5、§7.6、§15.2、§18、§23.5。A1 至 A6 已分别合入 #1237、#1239、#1241、#1244、#1246、#1248；本刀不重开已落地决策。

## 1. 维护者最低阅读量

### 人话简报

- **做什么**：给周期轮值、月度训练、定期会议和固定保障建立稳定的 Series / 不可变 Revision，并通过内部命令手工或按需生成未来独立 Activity。
- **不做会怎样**：现在只能逐个调用 A6 创建活动；没有周期事实、单期防重或批次重放锚点，人工重试和并发补齐都会有重复或半批风险。
- **最坏情况与回退**：本刀是新表 / 新关系的 additive migration；代码部署前可回退。migration 一旦落到环境，保留空表和引用，不以 DROP 回滚；每一条生成命令必须原子失败，不能留下半批 Activity。
- **推荐方案**：方案 A。用受限的 Series Definition V1、不可变 Revision、批次收据和单期 Occurrence 锚点；时区首期固定为 `Asia/Shanghai`；不新增 cron、依赖、外部入口或资源 / 地点 / 表单能力。

### 需要维护者确认的三个边界

1. **时区归属**：当前 T0-A 把时区归于 Series / Revision，而原始蓝图写“新活动时区 `Asia/Shanghai`”；现有 `Activity`、模板 Definition V1 和所有 migration 都没有 `timeZone` 字段。方案 A 将 `timeZone` 持久化在 Revision 且首期只允许 `Asia/Shanghai`，生成后的 Activity 保持既有 UTC 时间戳，不新增 Activity 时区列。若需要每一期独立 IANA 时区，必须另立 D 档。
2. **生成输入**：A6 命令强制要求 `title`、`organizationId`、`startAt`、`endAt`、`location`。模板 V1 不含标题、活动地点或活动时段，不能以模板名、模板场次地点或发起人偷偷补值。方案 A 要求 Revision 明确保存字面标题、文字地点、本地开始时刻和时长；不引入表达式、日期模板或任意脚本。
3. **负责人和资源**：`ActivityResponsibilityAssignment` 是“某个 Activity × Member”的已生效责任事实，不能被 `initiatorMemberId` 或 Series owner 冒充；仓内也没有 Resource Requirement 真相模型。方案 A 不存 JSON 占位、不自动创建责任分配、不创建资源需求，生成结果的 `initiatorMemberId` 保持空。以后有正式模型后另刀接入。

维护者回复 **“确认 A7 方案 A”** 后，才可以按本稿列出的精确写集实施；migration SQL 定稿后仍须另行完成第 105 条 3b 重签。

## 2. 已核验事实与必须补齐的缺口

| 事实 / 缺口 | 证据 | A7 的处理 |
| --- | --- | --- |
| Series / Revision 负责周期、时区、模板版本、生效期、默认组织和生成窗口；生成实例是独立 Activity | T0-A §5；原始蓝图 §7.5 | 新建稳定 Series 与不可变 Revision，Activity 只通过 Occurrence 保存来源锚，不由 Series 后续写回。 |
| 首期只能人工未来 N 期、打开 Series 按需补齐或受控外部调度调用幂等命令；不得新增第三个 cron | T0-A §5；原始蓝图 §7.6；全仓仅通知模块两个 `@Cron` | 仅内部 façade；零 `@Cron`、`ScheduleModule`、queue、Redis、缓存或定时器。外部 Integration 入口不属于 A7。 |
| T0-A 已点名 CreateActivitySeries 与 GenerateSeriesInstances，且所有写命令必须有权限、事务、幂等、校验、审计和安全 DTO | T0-A §8 | 新增显式内部 application façade；不使用 Command Bus，不暴露 Prisma row。 |
| A6 的从模板创建要求精确 Version、严格 Definition V1、事务、审计和 `operationKey`；命令输入必须显式有标题、组织、起止时间和地点 | `src/modules/activities/activity-from-template.service.ts`；A6 评审 §3.1–§3.5 | A7 不猜输入；每个 Occurrence 以 Revision 的明确输入物化，再复用 A6 的受控 transaction-bound primitive。 |
| A6 自己开启 transaction，直接在 N 期循环中调用会造成“前几期已提交、后几期失败”的半批 | `activity-from-template.service.ts:195–329` | A7 只能抽取不改变 A6 外部语义的 transaction-bound materializer，并由 Generate 命令持有唯一根事务。 |
| 当前不存在 ActivitySeries / Revision，也不存在 Activity / Template 的 timezone 持久化列 | `prisma/schema.prisma` 全文检索；T0-A §5；原始蓝图 §5.5 | 本刀按方案 A 新增 Series 族表，Revision 保存固定 `Asia/Shanghai`；不扩 Activity 时区。 |
| Node 22 原生 `Intl` 可识别 `Asia/Shanghai`；`package.json` 未声明 luxon / rrule / date-fns 等依赖 | 当前 runtime 与 `package.json` | 只实现闭合的规则 V1，不依赖 transitive 包、不改 package / lock。 |
| 现有责任事实与 Activity 强绑定，资源域尚无业务模型 | `ActivityResponsibilityAssignment`；`src/modules/` inventory | 不把 Series 默认负责人或资源需求伪造成 `initiatorMemberId`、JSON 或新表。 |
| Activity 发布与审计链已有严格快照语义，Series 后续变化不能回写已生成或已发布实例 | T0-A §5；原始蓝图 §7.4 / §7.5 / §23.5 | Occurrence 保存创建时所用 Revision；Revision / Series 变更不更新任何 Activity、Session、Position 或发布快照。 |

## 3. 方案 A：严格 Series Definition V1

### 3.1 命令边界与权限

仅增加模块内 application façade，不新增 controller、HTTP DTO、Swagger、route、权限码、RBAC seed、Gate 或 Integration endpoint：

| 命令 | 权限 | 幂等锚 | 结果 |
| --- | --- | --- | --- |
| `CreateActivitySeries` | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash | 新建 Series 与 Revision 1。 |
| `ReviseActivitySeries` | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash | 只追加下一条不可变 Revision，绝不 UPDATE 旧 Revision。 |
| `SetActivitySeriesStatus` | 复用 `activity.create.record` | 调用方 `operationKey` + canonical requestHash | 仅改 Series 生命周期 `active / paused / terminated`。 |
| `GenerateSeriesInstances` | 复用 `activity.create.record` | 批次收据的 `operationKey` + canonical requestHash；单期 Occurrence unique | 在一个事务内生成或返回指定窗口内已有的独立草稿 Activity。 |

这里的 Revision 与状态命令是内部写命令，不是新 API surface；名字的目的仅是让每一条写行为都有独立权限、事务、幂等、校验和审计归属。外部受控调度的 Integration 契约留给后续 Integration 业务面单独立项，不能在 A7 偷接。

### 3.2 Revision 的闭合输入

Revision 只接受严格白名单，不接受 rrule 字符串、cron 表达式、任意 JSON、模板插值、JavaScript 或动态 SQL：

| 区域 | V1 允许内容 | 规则 |
| --- | --- | --- |
| 模板来源 | `templateVersionId` | 必须是精确 future Family Version；首次生成仍复验 A3 canonical/hash 和 A6 selectable 规则，不按 Family 或 `activityTypeCode` 猜版本。 |
| 周期 | `daily` / `weekly` / `monthly`、interval、weekly weekdays、monthly day-of-month | `daily` / `weekly` / `monthly` 都是有限枚举；weekly 至少一个星期几；monthly 的缺失日期一律 **skip**，不静默挪到月末。 |
| 时区 | `timeZone` | 首期唯一允许 IANA 值 `Asia/Shanghai`；所有 timestamp 仍以 UTC 存库。日后多时区、DST 和 Activity 独立时区另立 D 档。 |
| 时段 | 本地开始日期、本地开始时刻、`durationMinutes`、有效起止区间 | 从 `Asia/Shanghai` 本地规则确定 UTC `startAt/endAt`；有效区间和生成窗口必须有上界。 |
| 活动创建输入 | 字面 `title`、`organizationId`、字面 `location`、可选报名截止偏移 | 直接补齐 A6 所需输入；标题 / 地点不做插值或默认猜测。报名截止未配置即为 null。 |
| 生成窗口 | `generationWindowDays` 与单次 `count` 上限 | 只允许有限、正整数范围；精确上下限在实现前由评审稿的测试和 SQL CHECK 一并固定，不能依赖内存保护。 |

`initiatorMemberId` 必须保持未设置。Series 身份、模板 owner、组织 owner 或创建者均不等于某一期 Activity 的责任事实；任何自动分配都需先有责任规则的独立合同。

### 3.3 持久化形状与不变量

方案 A 使用四个新表，不把 Series 规则塞进 `Activity` JSON，也不复用 Integration command receipt：

| 表 | 责任 | 关键约束 |
| --- | --- | --- |
| `ActivitySeries` | 稳定身份与生命周期 | 唯一 code；状态只允许 `active / paused / terminated`；更新只允许状态与时间戳，不存可变周期规则。 |
| `ActivitySeriesRevision` | 不可变的 V1 周期、Version、时区、有效区间和生成输入 | `(seriesId, revision)` 唯一；对 Series、Template Version、组织、创建人均为 Restrict FK；CHECK 守时间/范围/规则形状；migration trigger 拒绝 UPDATE / DELETE。 |
| `ActivitySeriesGeneration` | 一次 Generate 命令的持久化收据 | `operationKey` 全局唯一，配套 requestHash；重放只返回同一结果，hash 不同失败；不存原始请求或敏感数据。 |
| `ActivitySeriesOccurrence` | 单个已生成期的唯一锚、创建时 Revision 和独立 Activity 的来源关系 | `(seriesId, occurrenceKey)` 唯一、`activityId` 唯一；Occurrence 保存 UTC 起止与不可变 Revision id；不允许重指向或删除。 |

`occurrenceKey` 是由 Revision 的本地规则和固定时区规范化得出的稳定键，不用墙钟、标题、调用者或随机数。它守住“同一 Series 的同一期最多一个 Activity”；不同批次、不同用户或外部调度对重叠窗口的调用都不能重复建单。

Revision 变更的语义固定如下：

1. 新 Revision 只决定其有效区间内、尚无 Occurrence 的期。
2. 已有 Occurrence 的 Activity、Session、Position 和审计永不被 Series / Revision 更新。
3. 已生成草稿的批量同步功能 **不在 A7**。原蓝图要求人工明确选择；A7 宁可不提供该命令，也不能默认修改草稿。
4. 已发布 Activity 绝不自动变化。任何未来批量草稿更新都要单独命令、明确选择和 D 档评审。

### 3.4 单事务、锁与重放

`GenerateSeriesInstances` 的根事务按以下顺序执行：

1. 按 Generation `operationKey` 查成功收据；相同 requestHash 直接返回既有结果，hash 不同报冲突，不再看当前 Series 状态。
2. 首次执行锁住 Series 行，再锁定命中的 Revision 和精确 Template Version；paused / terminated、有效期不匹配、模板 retired / legacy / hash 不一致或规则不合法均零写入失败。
3. 由纯函数从 Revision 生成有限个候选 occurrence；排除有效区间之外和窗口之外的本地期，规范化为稳定 `occurrenceKey`。
4. 对每个候选按 Occurrence 唯一锚检查或创建。已有同 key 时返回其 Activity，不改写其任何字段；新 key 才调用 A6 的 transaction-bound materializer，创建独立草稿、Session、Position 与 Activity 审计。
5. 在同一根事务内写 Occurrence、Generation 收据和 Series 审计。任一校验、单期物化、审计或唯一冲突处理失败，全批回滚。
6. 并发撞唯一后回读对应收据 / Occurrence：相同 hash 或同一期返回既有结果；不同 hash 的同一命令 key 明确失败，绝不泄露 P2002 或返回 500。

这要求从 A6 抽取 transaction-bound materializer，但其现有 public `createFromTemplate()` 行为、错误码、hash 结构、模板锁顺序、审计形状和 E2E 必须先做 characterization 再原样保留。不得复制一份模板物化逻辑，也不得让 A7 在 transaction 中嵌套调用 A6 的 public 方法。

### 3.5 审计与安全输出

每一条成功写命令写安全审计；重放不追加审计。需要在实施时将新增审计事件和 `resourceType` 明确登记，不能借用含义不符的字符串：

- Series 创建 / Revision 追加 / 生命周期改变：resource 为 `activity-series`，extra 至多记录 `operation`、revision、状态和安全的 Series id。
- 每期生成：仍以 Activity 为资源，extra 至多记录 `operation: generate_series_instance`、Series id、Revision、occurrenceKey 和模板 Version id；不记录 `operationKey`、requestHash、完整周期定义、成员资料、表单答案或 signed URL。
- 批次收据仅用于重放，不作为 API 返回 Prisma row；内部 façade 返回安全的 Series / Activity 摘要。

新增 `AuditLogEvent` union 值属于审计语义变更，必须在维护者授权和测试内显式登记；不能把审计缺口藏在 `extra` 中。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 闭合 V1 周期 + 固定 `Asia/Shanghai` + Series / immutable Revision + Generation receipt + Occurrence unique | 有可证明的单期防重、批次重放与历史隔离；不引新依赖或 cron，能逐条测试和回退。 |
| B | 直接接通用 rrule、全 IANA 时区和第三方时间库 | 需要 package / lock D 档授权、DST 和异常本地时间合同，且当前 Activity 没有独立 timezone 字段；范围超过 A7。 |
| C | Series 只存 JSON，循环调用 A6，每期各自提交 | 中断会留下半批，且没有可靠的同一期唯一锚；不满足写命令事务与幂等合同。 |
| D | 直接把 Series 更新批量同步到已生成草稿，或把负责人 / 资源需求一起落表 | 会重开责任、资源、地点、表单和发布边界，违反“必须人工选择”和一轴一 PR。 |

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

### 7.1 仅本次起草已授权的写入

- `prisma/CLAUDE.md`：校正 A6 已完成 PR / CI / 合并的事实；
- `docs/archive/reviews/activity-os-r1-a7-series-generation-review.md`：新建本评审稿。

### 7.2 方案 A 获批后才可申请的实施写集

下列是预算，不是预授权。必须先以实际 diff 调用 `pnpm harness:needs` 收敛，再由维护者在 A7 worktree 亲自执行精确 `harness:grant`；不得用 `**` 或预先猜测 migration 时间戳扩大权限。

| 路径 / 范围 | 为什么可能需要 | 是否红区 |
| --- | --- | --- |
| 本评审稿 | 将状态从草案改为已拍板并记录最终范围 | archive（既有文件编辑需授权） |
| `prisma/schema.prisma` | 四个 Series 族模型和 Activity 来源关系 | 是 |
| 第 105 条实际 migration SQL | additive 表、FK、unique、CHECK、trigger | 是，且另需 3b 重签 |
| `src/modules/activities/**` | Series façade、纯函数、A6 primitive 抽取、审计调用与模块装配 | 否，但属同一 bounded context |
| `src/modules/audit-logs/audit-logs.types.ts` | 新增明确 Series 审计事件 | 否，但属于 D 档审计语义 |
| `test/e2e/**`、活动模块 unit spec | Series / A6 characterization / PostgreSQL 证明 | 常规 test 可写；不得改 `test/setup/**` / contract |
| `docs/ai-harness/ROUTE_AUTHZ.md`、`harness/domain-map.json`、`harness/state-machines.json` | 仅在 `docs:refresh` 实际要求时更新生成取证 | 后两者红区 / 执法层；以实际 needs 结果为准 |
| `docs/ai-harness/CUTOVER_SIGNOFF.md` | migration 3b 重签登记 | 仅在 SQL 审查后、维护者确认时改 |

明确不申请：`package.json` / `pnpm-lock.yaml`、`src/app.module.ts`、权限 catalog / seed、controller、Swagger、route contract、全局 Guard / Filter / Interceptor、auth、notifications cron、Resource / Place / Form 域、生产数据库。

## 8. 后续维护者决策与命令

本稿落地后，请维护者先审阅并回复：

```text
确认 A7 方案 A
```

收到后，执行体先以最终实际写集生成授权预算，例如：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-activity-os-r1-a7-series-generation-review
pnpm harness:needs docs/archive/reviews/activity-os-r1-a7-series-generation-review.md prisma/schema.prisma <第105条migration实际路径> src/modules/audit-logs/audit-logs.types.ts docs/ai-harness/ROUTE_AUTHZ.md harness/domain-map.json harness/state-machines.json docs/ai-harness/CUTOVER_SIGNOFF.md
```

维护者只执行该命令输出的精确 `pnpm harness:grant '<glob>' --reason 'Activity OS R1 A7 方案 A 已确认：<对应范围>'`，不得由 AI 自行授权。migration SQL 逐行审查完成后，维护者还必须另行回复：

```text
确认重签 3b（A7，第105条 migration）
```

在上述两次确认之前，本稿不是实施授权。
