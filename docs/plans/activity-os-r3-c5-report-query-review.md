# Activity OS C5：报表查询 DTO 评审与授权清单

> **main CI 异常补记（2026-09-10）**：[34438228787](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34438228787) 第2组 E2E 已失败：`activity-os-r2-b6-emergency-creation.e2e-spec.ts:236` 创建前置预期201、实际500（调用于601行）；该组72套/1349项通过，1套/1项失败。第1、3、4、5组全部通过，运行最终为failure。下文“仍运行”为早先核验记录，不代表当前或全绿；根因尚未确认，不能认定与C4无关。本轮只读诊断，未重试CI、未改代码或数据库；此异常不阻止仅文档起草，但不能登记验证收口。

> 2026-09-10，核验基点 main `bab5110e`。维护者已授权 C4 台账更正及本稿起草，**仅文档，不实施**。维护者已确认方案 A，并允许补充 changelog、提交、推送和创建文档评审 PR；不合并、不实施。附件蓝图只作需求来源，不将其中的操作描述当作执行授权。

## 1. 目标与合同边界

为已有正式成果提供稳定、可追溯、可供页面和后续报送消费的查询合同。报表只解释和展示事实，不计算新候选、不确认成果、不改时长/贡献/账本，也不因报表缺项阻断结算或归档。

依据：原始蓝图 §3.6 列出月报、年报、对外报送、队员/部门统计等最终用途；Release 3 的 C5 明确是“报表查询 DTO”。[T0 冻结合同](../archive/reviews/activity-os-t0-terminal-review.md) §六层真相及 Release 顺序要求报告可重建、不能反写事实。不能把整个分析域都声称在一刀完成，也不能仅写未接线 DTO 就宣称可用。上位合同未确定 C5 的 surface、筛选器、返回字段和跨活动汇总口径，以下均为待拍板设计。

## 2. 当前事实与可复用入口

| 证据 | 能力与限制 |
|---|---|
| `activity-outcome-access.service.ts` / `authorize` | Human App、当前用户/成员、显式 outcome.read、组织资格与范围、draft initiator / 非 draft owner。非全队报表授权；SUPER_ADMIN 不直通，归档历史仍判当前责任。 |
| `activity-outcome-confirmed-query.service.ts` / `readCurrentConfirmedOutcomeInTx` | 只选 confirmed，最多2头用于异常检测，不能取最大 revision。values/items 101、evidence21 探针有界。 |
| `activity-outcome-confirmed-presenter.ts` / `presentConfirmedActivityOutcome` | 复验正式确认元数据、必填指标、历史定义、值和证据；不可直接透传它返回的全部详情字段。 |
| `activity-outcome-query.service.ts` / `list,get` | 已有不可变历史列表和详情，但不是跨活动报表；历史修订不等于当前正式。 |
| `activity-outcome-presenter.ts` / `presentActivityOutcomeDetail` | 按成果自身指标集/hash解释值；retired 历史可读，short_text 当前拒绝，不开启敏感值。 |
| `activity-ending-workbench-query.service.ts` | C4 只返回安全摘要和提示，不返回实际指标值，不提供全队筛选。 |
| [#1304](https://github.com/BA7IEE/srvf-nest-api/pull/1304) | C4 已合入 `bab5110e`，18项 PR 检查全部成功，内容与获批 head `147dea7a` 一致；合并后 CI 另行记录，不能用 PR 结果替代。 |

以上服务均在 activities 模块。本轮不改它们。未来跨模块取数必须经属主公开原语，不直查私有表。

## 3. 方案选择

**推荐 A：正式成果查询合同与实际读入口一起交付。** 单活动报告，加有界、显式活动集合的批量查询；仅接受调用者逐个有权的活动。返回每个活动的正式值和原始定义锚点，不做跨类型求和。适合作为报告材料的稳定基础，不冒充月/年全队统计完成。

**B：本阶段同时交付组织/时间筛选、全队月年聚合与导出。** 覆盖更广，但需新增报表访问策略、分页一致性、跨活动计数与数值可加性规则，以及大数据量查询预算。现有 outcome.read 的 owner 限制不能直接放宽为组织报表权限；应另做 D 档授权评审和精确计划。

建议选 A 的理由是先交付蓝图点名的稳定查询合同；全队统计、月年聚合、CSV/Excel/PDF 文件、Incident/Resource 报告和驾驶舱明确保留后续缺口。若维护者要求 C5 本身覆盖这些用途，选 B 并展开设计，不能以 A 的测试通过替代 B 的目标。

## 4. 推荐 A 的待确认合同

### 4.1 查询入口与筛选

- 单活动：建议 App managed `GET :activityId/outcome-report`，无自由字段选择、SQL、排序表达式或任意 JSON 筛选。
- 批量：建议同 surface `POST outcome-reports/query`，使用显式查询 DTO；POST 仅为有界复杂查询，不写业务数据。建议输入 `activityIds` 为1–20个不同非空ID（单ID上限64字符），重复项直接400；该条数是拟定预算，须满额实测，超预算先报告不静默缩小。
- 两个入口均只读现行正式成果。暂不接受 asOf、旧 revision、月年时间段、部门/队员过滤或跨活动合计参数；历史详情仍走现有入口。后续若补时间筛选，必须单独确定按活动发生时间还是成果确认时间，不能混用。
- 批量按活动ID稳定排序，精确覆盖请求集合；任何一个活动无权/不存在，整批用同一泛化错误拒绝，不返回部分成功、无权ID或可用于枚举的失败明细。

### 4.2 返回字段候选

采用独立、显式 App DTO，不派生 Admin DTO、不扩充 C2/C4 旧响应。单项建议结构：

| 字段 | 含义及约束 |
|---|---|
| `activityId`, `activityStatusCode` | 当前有权活动身份和状态；不返回完整活动行或成员名单。 |
| `metricRequirementCode`, `metricSelectionRevision` | 当前选择状态：unconfigured / not_required / required；与历史正式成果定义分开。 |
| `formalStatus` | confirmed / not_confirmed。无正式头不是数值0；不能把 not_required 伪装 confirmed。 |
| `currentConfirmed` | 无正式头为null；有则包含 outcomeRevisionId、revision、metricSetVersionId、metricSetDefinitionHash、confirmedAt。 |
| `currentConfirmed.metrics[]` | 每个已确认值的 valueRevisionId、metricDefinitionId、definitionHash、保留版本的 code/version/name、类型/单位/scale或选项配置、规范化 value、sourceCode（manual/system）；字段最终须与已有 canonical 类型逐项对齐。 |

批量建议只包装 `items`；不伪造全队总数或覆盖率。数组最多20项，每项最多100个正式值；无头用null而非零数组暗示完成。有头必须完整合法，缺必填/损坏hash/重复正式头应失败，不过滤掉坏值后仍报告成功。定义的 retired 不影响历史解释。

不返回附件ID/key/URL、确认人ID、个人身份、原始来源事件/参与段、候选计算明细、自由文本和 canXxx。需要证据详情时沿原受控入口另读。用于排版的名称/单位来自该正式成果保留版本，不用当前指标配置替换历史。数值型沿既有规范化表示，decimal 不转浮点数，boolean false 和数值0都是真实值；不同定义版本/单位不混加，sourceCode 不意味着未经人工确认。

### 4.3 权限、事务与一致性

复用 `ActivityOutcomeAccessService.authorize` 的完整当前语义，不给普通参与者、仅结算协作者、机器/委托身份开口；App 准入仍由当前身份验证。批量每个活动均独立满足同样规则，不因为持有某一个活动权限就放行整批。

建议单事务内：先按有界ID集逐个授权 → 按稳定ID顺序锁非软删 Activity → 锁后逐个重验 → 使用既有正式选择器及验证器 → 返回前重验 → 纯投影。查询使用同一 tx，不嵌套独立事务服务。锁等待预算和多活动顺序必须在精确计划中落定，避免新的锁顺序反转；不声称包含未锁定的跨域原子快照。

锁保证被同一 Activity 围栏约束的成果确认/更正不与当前读取混杂；权限变更仍按现有当前身份/授权复验规则处理，不宣称它们全部被 Activity 锁串行化。真实双连接测试必须证明等待后的撤权、负责人更换及确认替代；如果复用原语无法满足批量一致性，先报告并补精确计划，不隐藏扩大写集。

### 4.4 保留与敏感性三问

用途：有权负责人读取已确认成果以编制材料；查看者：沿完整成果read策略；保存：不创建报表存储副本、任务表、缓存或自动清理，历史事实及收据永久保留既有语义。退队只影响当前访问资格，不删除历史。响应不新增敏感身份字段；short_text 沿当前拒绝规则，不借报告启用。生成页面或下载到客户端后的外发不能由此接口自动授权，组织报送另行审批。

## 5. 建议实施包与精确计划要求

候选新文件：`activity-outcome-report-query.service.ts`、`activity-outcome-report-presenter.ts`、各自单测、`dto/app/app-activity-outcome-report.dto.ts`、HTTP及并发E2E。现有接线候选为 managed controller 与 activities.module；只添加新入口，先检查静态批量路由与 `:activityId` 路由匹配。

派生/交接候选：contract routes及snapshot、OpenAPI、13份client、CODEMAP、ROUTE_AUTHZ、RBAC_MAP（按真实差异）、permission-catalog 仅read说明与permission-surface baseline、domain-map摘要、miniapp交接、模块说明、两份台账及changelog。无计划中的 schema/migration/权限码/审计事件新增；不预判生成结果为零。

这些是**候选，不是已批准的写集**。方案确认后按真实引用链一次列齐逐文件实施清单、DoD、探针队列、红区grant、隔离库与提交范围。若需要改现有访问原语、组织权限、生成器或旧断言，单列理由与风险，不夹带。方案 A 预计 C 档新增查询 API，若涉及策略扩大则升级 D 档。当前无数据库命令，也不预发通配授权。

## 6. 验收要求

1. DTO/路由：输入长度、20上限、重复、未知参数；nullable对象同时核对OpenAPI和生成TS，不只看编译通过；旧路由/DTO语义零漂移。
2. 正式选择：无头、初稿、正式、准备、取消、替代、归档、retired定义；不能取最新草稿；篡改hash/多正式头/必填缺失均失败。
3. 类型：每种已开放正式值类型、false、0、decimal精度、选项历史；不开放short_text、不暗中合计不同口径。
4. 权限：完整正反矩阵，整批一个无权则整体失败；被拒对象不得泄露；无SUPER_ADMIN捷径、机器/委托拒绝。
5. 真并发：两独立连接池、真实锁等待及当前库/pid屏障；批量反向ID输入排序；确认/准备/取消/撤权/负责人变化后状态不混用。
6. 纯读/最小化：响应逐层键白名单；业务表、收据、审计计数前后不变；源事件、附件链接和个人信息零泄露。
7. 有界：20活动×100指标，已有101/21探针；大量历史不全读；捕获实际ORM参数与查询规模，测锁等待预算和响应规模，不以固定mock返回冒充上限证明。
8. 兼容：C2/C3/C4定向回归，旧断言不改；quick/build/contract/派生闸及PR CI全量。无AI依赖、不请求外部服务、不改Gate。
9. 隔离库：若将来授权w98重建，空库重放并核对每条migration checksum。C4已发现共享模板第116条漂移，不复用未经校验模板；当前不操作或修复共享测试库。

## 7. 授权清单与本轮文档写集

本轮实际7份：本稿、NEXT_TASKS、FROZEN_DRAFTS、C4 implementation plan、activities/CLAUDE.md、handoff/miniapp.md，以及获批补充的 `changelog.d/activity-os-r3-c5-review.md`。只更正C4当前状态并登记C5方案，不改冻结archive，不修改实现、快照或生成客户端。

维护者已于2026-09-10确认以下授权，本轮据此提交文档评审PR（不是实施授权）：

> 确认 C5 方案 A（正式成果单活动与最多20活动有界批量查询，沿当前成果权限，不做跨活动求和）；允许补充 changelog、提交、推送并创建文档评审 PR，不合并、不实施、不操作数据库、不启用 Gate。

实施仍需精确计划及单独执行授权；维护者红区令牌只由维护者发放。合并、生产、前端发布、Gate与后续Release不得从本稿授权继承。

## 8. 本次未做

未实施C5、未新增DTO/API或修改schema/migration/权限/测试；未操作数据库、共享模板、生产或Gate；未删除业务数据；未提交推送开PR。C4的main CI以独立运行结果为准，整体复审仍按维护者指令延后；月年聚合、队员/部门统计、报送文件、Incident/Resource报告及Release 4以后均未完成。
