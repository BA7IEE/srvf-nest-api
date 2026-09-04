# Activity OS R2 / B4 发布就绪评审记录

> **状态：维护者已于 2026-09-04 确认方案 A；本稿只冻结 B4 的边界、判决合同与后续写集预算。**
> 本决定不授权运行时代码、现有发布链路接线、接口、schema、migration、开关或生产动作。
>
> **需求来源**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §6.3、
> 原始《SRVF 活动域终态蓝图与分阶段落地方案》§5.2、§10、§21.2、§22。原始蓝图仅提供业务需求，
> 不能覆盖仓库当前事实、红区、迁移和维护者授权流程。

## 1. 拟议结论

采用方案 A：新增模块内、只读、确定性的 `ActivityPublishReadinessService`，把“当前草稿距离
**终态**可发布还缺什么”变成结构化结果。它返回 `blockers`、`warnings`、`suggestions` 和
`resolvedSummary`；每个问题固定包含 `code`、`severity`、`fieldPath`、`message`、
`resolutionHint`。

这一刀是 **gate-off** 的控制面地基：

1. 不新增 HTTP endpoint、DTO、Swagger、OpenAPI、前端 client、权限码、审计事件、配置或环境开关。
2. 不调用、不替换、也不改变既有 `ensureInitialPublishable`、初始发布提交、变更审核、审批或
   apply 路径；当前发布行为保持原样。
3. 不建表、不写 migration、不回填、不写缓存、不创建快照 v6，也不改变 Template 的选择、状态或
   resolver 语义。
4. Readiness 只读取当前已存在的事实；规则评估是纯函数，不能调用 AI、网络、队列、cron、缓存或
   随机数。
5. 对尚未拥有权威模型的终态必需项，明确返回 blocker，不能因为当前无处可查就把活动说成
   “ready”。因此 B4 初始版本会让所有活动至少带有政策、成果和安全的未表示 blocker；这是
   诚实的终态判决，且因 B4 不接入发布链路，不改变任何现有用户行为。

未来 B5 才在新提案里冻结 snapshot v6，B6 才定义创建 API 和地点写入，B7 才讨论前端交接及灰度；
Activity v1.1 cutover 完成并稳定观察前，任何控制面都不得在生产 active。

## 2. 已核验事实与约束

| 事实 / 风险 | 证据 | 对 B4 的约束 |
| --- | --- | --- |
| 蓝图规定草稿允许不完整，正式发布前须经过确定性 Readiness；blocker 阻止、warning 需确认、suggestion 不影响。 | 原始蓝图 §5.2、§10。 | B4 输出问题清单，不用异常替代清单，也不能让 AI 作决定。 |
| T0-A 已固定问题字段与最低检查域，并把 `GetActivityReadiness` 列为未来 façade。 | `activity-os-t0-terminal-review.md` §6.3、§8。 | 先建立模块内服务；本刀不抢跑 future query endpoint。 |
| 既有初始发布提交在 Activity 锁和事务内调用 `ensureInitialPublishable(activity)`，只会通过或抛既有 BizCode。 | `activity-publish-review-submit.service.ts`；`activity-publish-review-access.ts`。 | B4 不接线、不改错误码、不改变锁序或事务边界。日后若要接线，必须先做既有发布行为 characterization。 |
| proposal v2 已复验模板、表单、资格、时间和容量，但其 `assertProposalValid` 是提交/审批校验，不是可解释的终态问题聚合。 | `activity-publish-proposal-v2.service.ts`。 | B4 可以复用已确定的纯解析器和事实，不复制第二套 writer 规则，也不把现有抛错语义改成 Readiness 语义。 |
| A5 仍支持 legacy 的 template fallback；明确选择 future Version 后即使 retired 也应保持可读。 | `activity-publish-proposal-v2.service.ts` 的模板解析；`src/modules/activities/CLAUDE.md`。 | 只判断“当前 resolver 能否确定并解析版本”，不自行发明“当前可选 / active 才合法”的新生命周期规则。 |
| B1/B2 已有 PlacePreset、ActivityPlace 和坐标闭集，但尚无地点 writer，也没有把它们改成既有签到的唯一真相。 | `prisma/schema.prisma` 的 PlacePreset / ActivityPlace；`activity-place-coordinate-projection.ts`。 | B4 可读取已持久化地点作事实参考；定位发布判定仍以当前 Session / Position 的定位事实为准，不能让空的未来 Place 表取代旧字段。 |
| B3 的报名表已使用 canonical definition；legacy / governed 形状及 hash 兼容都有单一解释器。 | `registration-form-definition.ts`、`registration-form-version.service.ts`。 | B4 只能调用现有 canonicalizer 检验当前定义，不能重写 Form、hash、答案、上传或公开投影。 |
| 活动分类当前仍由 `activityTypeCode` 和静态 legacy registry 解释；`pending_classification` 不是正式分类，`manualGovernance` 不能被自动消除。 | `activity-type-migration.registry.ts`。 | 未映射或 pending 必须 blocker；有人工治理项只能报告 warning，不能自动视为已认定。 |
| TimePolicy、ContributionPolicy、Metric Set 与可判定的安全要求尚无当前活动域正式模型。 | T0-A §7；原始蓝图 Release 3–5 排期；当前 Prisma / activities 模块盘点。 | 不伪造 selector、JSON、默认值或“无风险”判断；分别报告未表示 blocker，留给后续 Release 3–5 / Incident 相关评审闭合。 |
| 蓝图允许 T0 后开发 additive、gate-off 控制面，但禁止在 v1.1 cutover 和稳定观察前生产 active。 | 原始蓝图 §21.2。 | 即使日后实现，本刀也不增加 gate、配置和发布强制执行。 |

## 3. 方案 A 的精确合同

### 3.1 返回形状、稳定性与排序

服务结果固定为下列内部类型；它不是 HTTP DTO，也不携带活动标题、报名答案、成员信息、地址全文、
token 或其他敏感值。

```text
ActivityPublishReadinessResult {
  blockers: ReadinessIssue[]
  warnings: ReadinessIssue[]
  suggestions: ReadinessIssue[]
  resolvedSummary: ReadinessDomainSummary[]
}

ReadinessIssue {
  code: string
  severity: 'blocker' | 'warning' | 'suggestion'
  fieldPath: string
  message: string
  resolutionHint: string
}

ReadinessDomainSummary {
  domain: ActivityReadinessDomain
  status: 'clear' | 'attention' | 'blocked' | 'unrepresentable'
  issueCodes: string[]
}
```

域顺序固定为：`basic`、`categoryTemplate`、`timeCapacity`、`locationAttendance`、
`registration`、`form`、`qualification`、`visibilityAudienceInsurance`、`terminalPolicyOutcomeSafety`。
三个问题数组都按“域顺序 → fieldPath → code”排序；`resolvedSummary` 始终按上述域顺序返回，
不依赖数据库返回顺序。每个数组内的 `(code, fieldPath)` 唯一。

读取层在同一只读事实快照中显式排序子集合；纯 evaluator 接收该快照和调用方传入的
`referenceTime`。evaluator 内不调用 `Date.now()`，不使用随机数或全局可变状态。相同事实和相同
`referenceTime` 必须逐字得到相同结果；没有 `checkedAt`、git SHA 或运行环境噪声。

### 3.2 当前可判定的规则

下表是 B4 初始版本必须提供的固定问题字典。方括号中的标识在运行时替换为当前持久化 id；
`message` 和 `resolutionHint` 为对应 code 的固定文案，不能拼接数据库原值或异常堆栈。

| 域 | code / severity / fieldPath | message | resolutionHint |
| --- | --- | --- | --- |
| 基本信息 | `BASIC_TITLE_MISSING` / blocker / `activity.title` | 活动标题不能为空。 | 补充非空标题。 |
| 基本信息 | `BASIC_ORGANIZATION_UNRESOLVED` / blocker / `activity.organizationId` | 发起组织不存在、不可用或无法解析。 | 选择一个当前可用的发起组织。 |
| 基本信息 | `BASIC_RESPONSIBLE_INITIATOR_MISSING` / blocker / `activity.initiatorMemberId` | 活动缺少可解析的负责人。 | 指定当前有效的发起负责人。 |
| 分类与模板 | `CATEGORY_NOT_FORMAL` / blocker / `activity.activityTypeCode` | 当前活动类型不能映射到正式业务分类。 | 完成分类治理，不得按标题猜测分类。 |
| 分类与模板 | `CATEGORY_MANUAL_GOVERNANCE_PENDING` / warning / `activity.activityTypeCode` | 该分类仍带有需要人工完成的治理事项。 | 按分类目录记录的事项完成核验并留存后续治理证据。 |
| 分类与模板 | `TEMPLATE_VERSION_UNRESOLVED` / blocker / `activity.selectedTemplateVersionId` | 当前模板解析器无法确定此活动的模板版本。 | 修复显式指针或既有 legacy fallback 所需事实。 |
| 分类与模板 | `TEMPLATE_DEFINITION_INVALID` / blocker / `activity.selectedTemplateVersionId` | 已解析模板版本无法通过当前定义与 hash 校验。 | 修复模板定义或选择一份可解析的版本。 |
| 时间与容量 | `SESSION_REQUIRED` / blocker / `sessions` | 活动没有可发布的有效场次。 | 至少保留一个有效场次。 |
| 时间与容量 | `SESSION_TIME_INVALID` / blocker / `sessions[${sessionId}].startAt` | 场次时间窗口不合法或不落在活动时间内。 | 修正场次开始和结束时间。 |
| 时间与容量 | `REGISTRATION_DEADLINE_INVALID` / blocker / `activity.registrationDeadline` | 报名截止时间不符合当前发布时序。 | 将截止时间调整到活动开始前的有效窗口。 |
| 时间与容量 | `POSITION_CAPACITY_EXCEEDS_SESSION` / blocker / `sessions[${sessionId}].positions[${positionId}].capacity` | 岗位容量超过所属场次容量。 | 降低岗位容量或提高场次容量，并复核总容量。 |
| 地点与考勤 | `LOCATION_COORDINATE_REQUIRED` / blocker / `sessions[${sessionId}].location` | 定位活动缺少当前签到真相所需的成对坐标。 | 为该场次补齐合法坐标，或取消定位要求。 |
| 地点与考勤 | `CHECKIN_RADIUS_INCOMPLETE` / blocker / `sessions[${sessionId}].radiusMeters` | 定位签到要求与签到半径配置不完整或互相矛盾。 | 让定位要求、坐标和半径满足现有闭集。 |
| 报名 | `VISIBILITY_OR_REGISTRATION_MODE_INCOMPLETE` / blocker / `activity.visibilityCode` | 可见性或报名方式缺少当前可解释的配置。 | 补齐当前受控闭集中的可见性和报名方式。 |
| 报名 | `INSURANCE_REQUIREMENT_UNVERIFIABLE` / warning / `activity.requiresInsurance` | 已要求保险，但当前事实无法证明保险门槛配置可被既有流程验证。 | 先修复既有保险配置和生命周期事实；不要在 B4 新造保险策略。 |
| 表单 | `REGISTRATION_FORM_INVALID` / blocker / `registrationForm` | 当前报名表定义无法通过既有 canonical 解析。 | 使用既有表单受控面修复定义，不改写历史 hash。 |
| 资格 | `QUALIFICATION_RULE_SCOPE_INVALID` / blocker / `qualificationRuleSets[${ruleSetId}]` | 资格规则集的作用域、版本或引用无法由当前正式模型解析。 | 在既有资格规则受控面修复作用域和有效版本。 |

其中：

- 只有静态 registry 明确给出 `manualGovernance` 时才报该 warning；它不自动推导时长、贡献、
  成果、风险等级或任何成员资格。
- 初始发布前的负责人事实是当前有效的 `initiatorMemberId`；既有发布事务会据此创建 active
  `ActivityResponsibilityAssignment(owner)`。B4 只读地复核前者，不要求草稿预先已有 owner
  assignment，也绝不把 `publishedBy` 当负责人或自行创建责任记录。
- 没有显式选择的 future Template Version 不等于必然失败。B4 必须尊重 A5 的现有 fallback，
  只在 resolver 的实际结果缺失或不可解析时报告模板 blocker。
- 文字地点本身不是 blocker；仅当当前 Session / Position 已声明 `locationRequired` 时，才使用
  已有坐标和半径规则判定。B4 不以“第一条 ActivityPlace”、零坐标或地图 provider 猜测地点。
- 保险仅复核已有 `requiresInsurance` 及既有正式服务能够表达的事实；不会新增险种、阈值、
  证据读取、权限或开关。
- 表单和资格只判断已持久化的定义 / 引用是否能用当前正式解释器解析；不评估某个报名人的答案、
  不读成员档案，也不复制敏感数据。

### 3.3 不可表示的终态要求

下列四项是 T0-A 已定义、但当前仓库尚没有权威模型的终态发布条件。B4 必须**始终**报告它们为
blocker，而不是静默遗漏或降级为 suggestion：

| code / fieldPath | message | resolutionHint | 由谁闭合 |
| --- | --- | --- | --- |
| `TIME_POLICY_UNREPRESENTABLE` / `policy.time` | 当前活动没有可解析的有效时长政策指针。 | 在 Release 4 建立 TimePolicy / Version 与活动选择关系后重新判定。 | Release 4。 |
| `CONTRIBUTION_POLICY_UNREPRESENTABLE` / `policy.contribution` | 当前活动没有可解析的有效贡献政策指针。 | 在 Release 5 建立 ContributionPolicy / Version 与活动选择关系后重新判定。 | Release 5。 |
| `METRIC_SET_UNREPRESENTABLE` / `metrics.requiredSet` | 当前活动没有可解析的必需指标集。 | 在 Release 3 建立 Metric Definition / Set Version 后重新判定。 | Release 3。 |
| `SAFETY_REQUIREMENTS_UNREPRESENTABLE` / `safety.requirements` | 当前活动没有可判定的风险与安全要求事实。 | 在独立安全 / Incident 评审定义风险分类、安全说明和装备要求后重新判定。 | 后续独立业务轴。 |

这四条不是把未来需求提前塞进 `Activity` 的 JSON 或默认值；它们明确表示“当前不能诚实地下达
终态 ready 结论”。B4 是 gate-off，因此这种 blocker 不会影响当前草稿保存、既有审核、发布或线上
活动。

### 3.4 事实装载与纯评估边界

实现时可在 `ActivityPublishReadinessService` 内以当前 Prisma 事务读取一个最小事实图：
Activity、有效 Session / Position、当前地点事实、当前 Form、当前 Qualification RuleSet、模板解析
结果以及已有组织 / 负责人 / 保险事实。随后交给不碰数据库的 evaluator。

必须遵守以下边界：

- 所有软删集合按既有 `notDeletedWhere` / 活跃语义读取；不以 `findUnique` 绕过软删语义。
- 查到的数据库行必须先投影为无 Prisma 对象、无成员敏感字段的 facts，再进入纯 evaluator。
- 不将 B4 的 aggregate query 当成发布事务的前置锁或写锁；它不会新增事务、写操作、审计、缓存或
  后台任务。
- 不能直接读取 PlacePreset 的当前值来覆盖 ActivityPlace，也不能从模板、组织、成员资料或标题补齐
  缺失字段。
- `resolvedSummary` 只说明每个域的结果和 issue code，不回显问题原始数据、表单内容、地址、
  资格规则内容或保险证明。

### 3.5 与现有发布链路的隔离

本刀明确保持下列边界：

- `ActivityPublishReviewSubmitService`、`ActivityPublishProposalV2Service`、
  `ActivityPublishReviewService`、`ActivityPublishReviewAccess` 和既有 controller 不调用
  ReadinessService。
- 不替换 `ensureInitialPublishable`，不修改任何既有 BizCode、锁序、hash、snapshot v2–v5
  或审批前重建逻辑。
- 不创建 `GetActivityReadiness` route，也不把结果写进 Review、Activity、AuditLog 或缓存。
- 不新增全局 / 局部 Gate、环境变量、配置项、定时器、queue、cron、Integration 或 AI 入口。
- 未来若要让 Readiness 影响正式发布，必须独立评审：先固定 warning confirmation 的持久化和审计
  合同，再做发布行为 characterization、snapshot 版本与灰度 / 回退设计；不得把它作为 B4
  “顺手接线”。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 内部只读、确定性、gate-off 服务；完整问题结构与稳定排序；当前可判定项真实检查，未来未建模的政策 / 指标 / 安全显式 blocker。 | 先把终态判断合同做实，不改变现有发布行为，也不把无模型误说成已通过。 |
| B | 只检查当前 Activity、Session、Form，悄悄不提政策、指标和安全。 | 会让 `ready` 降格为“当前旧流程没报错”，与 T0-A 的终态含义相冲突。 |
| C | 立即接进 `ensureInitialPublishable` 或发布审核。 | 会改变冻结的线上发布行为，并使所有活动受未建模 blocker 影响；需另立 rollout / snapshot / confirmation 设计。 |
| D | 自行把 Template active 状态、ActivityPlace、标题、旧字段或 JSON 解释成新的最终真相。 | 违反 A5 legacy fallback、B1/B2 未接线边界和单一真相原则。 |
| E | 同时做 B5 snapshot v6、B6 创建 API、B7 前端灰度、AI 解释、政策模型或安全模型。 | 混入后续业务轴，失去独立验证、回退和授权边界。 |

## 5. 风险与验证要求

| 风险 | 必须证明的处理 |
| --- | --- |
| 相同事实得到不稳定问题序列 | evaluator 单测用乱序 facts 多次运行，断言三类数组、summary、code、fieldPath 和文案逐字相同。 |
| `Date.now()`、数据库默认顺序或原始异常泄进结果 | 静态 / 单测证明 evaluator 只收 `referenceTime`；facts 预排序；故障映射到固定 issue，不回显异常信息。 |
| legacy template fallback 被误判为无模板，或 retired 已选 Version 被误拒 | 用 A5 的显式指针、legacy fallback、retired 已选、缺行、hash 不匹配五组 characterization fixture 覆盖。 |
| B4 重复当前发布校验却偷偷改变行为 | 为既有 submit / approval 路径补 characterization，断言 B4 provider 未被调用，既有错误码、事务和 snapshot v2–v5 行为不变。 |
| 定位活动被文字地点、空 Place、单边坐标或零坐标误放行 | 覆盖 `locationRequired` 真 / 假、合法坐标、缺一边、缺半径和多地点乱序；只按当前 Session / Position 事实判定。 |
| Form / Qualification 的旧 hash 或敏感数据泄出 | 对 legacy / governed Form、非法 canonical 形状、资格作用域坏引用做单测；结果不得含题目、答案、地址、成员资料或证据内容。 |
| 缺模型被错误标为 clear | 固定四个 terminal blocker 的完整对象、排序和 summary；没有 Time / Contribution / Metric / Safety 物理模型前，不允许任何测试把它们降级。 |
| 未来把 B4 当生产开关 | 代码 / PR diff 必须证明没有 controller、DTO、OpenAPI、config、Gate、Audit、schema、migration 或 publish-chain diff。 |

实施后的最低验证（仅限未来独立 implementation PR）：

1. `pnpm agent:check:quick`，以及新 service / evaluator 的定向单测。
2. 运行现有 template resolver、registration form、qualification、publish proposal 和 publish submit 的
   受影响单测；对既有提交 / 审批路径做 characterization。
3. `pnpm test:contract` 应无 snapshot 变化；没有新增 HTTP 时，任何契约 diff 都是越界信号。
4. PR CI 的 `agent:check:full` 才是全量结论。本地没有 Docker 时只报告 quick，contract / E2E
   留给 CI；不运行 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`，也不对
   生产或真实数据环境做任何动作。

## 6. 写集与授权预算

### 6.1 本次已获授权

本 review PR 只允许：

- `docs/archive/reviews/activity-os-r2-b4-publish-readiness-review.md`：新增本冻结评审稿；
  维护者已在本 worktree 发放精确 archive 新增授权。
- `docs/ai-harness/FROZEN_DRAFTS.md`：登记 B4 评审稿，并更正 B1、B2、B3 已合并实现的事实。

该授权不授权源码、测试、schema、migration、生成物、GitHub 合并或生产动作。

### 6.2 B4 implementation 前仍须维护者确认的写集

下表是预算，不是已授权清单。review PR 合入后，implementation worktree 必须先对实际 diff 运行
`pnpm harness:needs -- <paths...>`。若 diff 保持无 API / schema / migration / permission / audit /
Gate 的内部 gate-off 服务，按 `docs/process.md` §3 预计为 B 档；一旦需要 route、DTO、配置、发布
接线或任何红区路径，立即停下重判，不得借本稿扩权。

| 预期路径 | 用途 |
| --- | --- |
| `src/modules/activities/activity-publish-readiness.service.ts` | 最小只读 facts loader、固定 issue 字典和纯 evaluator 入口；不包含 writer / controller。 |
| `src/modules/activities/activity-publish-readiness.service.spec.ts` | 确定性、排序、当前事实、terminal blocker 和无敏感泄露的单测。 |
| `src/modules/activities/activities.module.ts` | 仅注册内部 provider；不 export 到 HTTP 或其它 bounded context，除非另行评审。 |
| 既有受影响的 unit / characterization spec | 只在为了证明 B4 不改变 resolver、Form、Qualification 或 publish 链路时最小增补。 |
| `CODEMAP.md`、`docs/current-state.md`、`harness/domain-map.json` | 仅在生成器或实际检查明确要求时最小更新；先让检查决定是否需要。 |

明确不在 B4 implementation 预算内：`prisma/schema.prisma`、`prisma/migrations/**`、seed、
controller、DTO、Swagger、OpenAPI、client、权限码、RBAC seed、BizCode、AuditLogEvent、发布 submit /
approval / applier、snapshot v2–v6、Activity / Session / Position / Place writer、Form / Qualification
writer、保险策略、TimePolicy、ContributionPolicy、Metric、Safety、环境变量、Gate、AI、Integration、
cache、cron、queue、生产 deploy，以及 `NEXT_TASKS.md` 或其他未获授权的文档纠正。

## 7. 维护者决策记录与下一次确认

维护者已于 2026-09-04 确认：

> 确认 B4 评审方案 A；确认更正 FROZEN_DRAFTS 的 B1-B3 状态；已执行

该决定确认了：只读 deterministic ReadinessService、完整四段返回形状、当前已表示事实的检查、
未表示终态条件的显式 blocker、B4 gate-off、零 AI，以及 B1–B3 已合并事实的台账更正。它仅允许完成
本 review PR，不授权 B4 implementation。

review PR 合入后，若仍采用本稿的无 API / 无 schema / 无 publish 接线写集，维护者须另行确认实际
implementation 写集；任何 B5–B7、生产 active、warning confirmation、snapshot v6 或发布强制执行
都必须再次独立评审和授权。
