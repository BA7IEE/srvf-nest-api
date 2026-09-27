# Activity OS Release 5 / E3：贡献政策新旧并算评审与精确授权清单

> 2026-09-27，基点为 `main@5510c43cefbe4f5e6f2fda506355c04a83efd975`。本稿仅供评审：不实施、不查询数据库、不操作生产、不启用 Gate，也不继承 E2 的 w98 或红区授权。下列路径是**候选写集**，不是已批准的实施清单。

> E3-1 后续执行记录（2026-09-27）：维护者已单独批准 §6 第一表，仅实现纯比较器与固定夹具测试；E3-2、真实映射、运行时 shadow、数据库、Gate 均未获批。本段只记录 E3-1，不改变上方原评审时点的边界。

## 1. 结论与不变边界

E3 必须让同一条可比较的参与事实同时经过旧 `ContributionRule` 计算和 E1 `ContributionPolicyVersion` evaluator，留下可复核的差异清单。E3 **只观察**：旧考勤预填仍是正式输入；不回写新分值，不改现有结算、`ParticipationLedgerEntry`、每日封顶、Correction、统计、发布或历史记录。E4 才接结算，E5 才在独立窗口切换并使旧规则只读；E3 通过不能代替 E4／E5 的授权。

**推荐方案 A：先锁比较合同，再接受控 shadow 与不可变证据。** 第一刀用纯函数和固定夹具证明边界／分类／重放；第二刀只在已签映射、同一事实输入和受控开关同时成立时，挂到旧预填链旁边，保持旧结果唯一对外。两刀均为独立 PR，第二刀不因第一刀合入而自动获批。只有真实目标已确认、来源规则和映射逐项签字、同链事实可得时，才能另行申请真实对账；系统尚未上线时，固定夹具对照只证明能力，不能登记为真实存量“差异归零”。

## 2. 现场证据与关键缺口

| 现有事实                                                                                                                                                                                               | 依据                                                                                                                                                                                      | E3 的影响                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 旧预填在 `ContributionCalculator.applyContributionRulePrefill` 里按活动类型×角色取 ACTIVE、未软删规则，重复 pair fail-closed；比较 `serviceHours: number` 与 `Number(durationThreshold)`；无规则返回 0 | `src/modules/attendances/contribution-calculator.ts`                                                                                                                                      | shadow 不得把旧计算器重写成“更合理”的新算法，也不得改变其返回值／异常   |
| 新 evaluator 按角色、四类 `timeCategoryCode` 和非负整数 `durationSeconds` 查不可变定义，产出 `recognizedPoints` 与解释码                                                                               | `src/modules/activities/activity-contribution-policy-definition.ts`                                                                                                                       | 点数能比较，解释码只能作为诊断；分类与秒数须由已批准的同一事实来源给出  |
| E2 第 132 条只交付收据与 `e2_fixture_*` 隔离转换，31 个真实类型均为 `hold`                                                                                                                             | `src/modules/activities/activity-contribution-rule-conversion.service.ts`、`activity-contribution-rule-conversion.mapping.ts`、[#1356](https://github.com/BA7IEE/srvf-nest-api/pull/1356) | 目前不存在可供真实类型直接启用的已签候选；E3 不能暗中把目录选择器当映射 |
| E1 的政策版本及选择链有精确 id／hash／evaluator 锚点，未批准草稿不能成为正式选择                                                                                                                       | `prisma/schema.prisma` 的 `ContributionPolicyVersion`、`ActivityContributionPolicySelectionItem`                                                                                          | 对照必须固定版本和 hash，不读“最新版”，不能借 shadow 让 E2 草稿变相生效 |

旧 `serviceHours` 可能按两位小时入库，新的时长事实按整数秒。例：4 小时 1 秒若旧值为 4.00 小时，新值为 14,401 秒；对 4 小时阈值直接宣称“同输入等价”是错误的。比较合同必须同时记录旧小时原值、新秒数、来源和精度规则；输入不齐或来源不同的样本归为**不可比较**，不能计入相等分母，也不能当作政策算法差异。

### 2.1 Prisma 与契约风险表

| 项                                  | 本轮文档结论；未来 E3-2 须另审                                            |
| ----------------------------------- | ------------------------------------------------------------------------- |
| 是否修改 `prisma/schema.prisma`     | 本轮否；若要持久差异证据，E3-2 候选是新增只追加模型                       |
| 是否新增／改动 migration            | 本轮否；候选只允许 additive DDL，历史 migration 不回改，SQL 定稿后另签 3b |
| 是否修改 `prisma/seed.ts`           | 本轮否；若批准新权限码／字典，另行明确 seed 范围与 4b                     |
| 是否影响现有数据                    | 本轮否；未来 shadow 只追加证据，不回填、重算或改写旧规则／正式账本        |
| 是否不可逆                          | 本轮否；未来证据一经写入需保留，禁止以删除业务证据作为回滚                |
| 是否影响 OpenAPI／contract snapshot | 本轮否；默认无新 HTTP，若加查询入口须独立评审并同步 handoff               |
| 是否影响鉴权／Permission seed／审计 | 本轮否；未来证据读面、掩码和审计属待签合同，零默认授予是推荐而非现行授权  |
| 是否需要新增 `BizCode`              | 本轮否；未来错误分类先复用受控内部结果，若对外暴露再核定号段              |
| 是否需要用户拍板                    | 是：§7 的业务映射、事实精度、证据三问、精确写集及未来 3b／4b／红区授权    |

## 3. 推荐比较合同（待业务拍板）

1. 比较单位是一条明确的同活动、同成员、同考勤记录或同一受控夹具事实；固定旧规则 ID／来源指纹、E1 policy/version/hash/evaluator、映射签字版本、事实锚点及发生时间。没有一一对应锚点不比较，不用活动标题或姓名拼链。
2. 旧侧调用现有计算器／等价无副作用适配，保留无匹配 0、阈值 `<=`、`pointsAbove ?? pointsBelow` 和重复 ACTIVE pair 失败语义。新侧调用 E1 纯 evaluator。不得把新侧的 `defaultResult` 擅自解释为旧侧的“无规则 0”。
3. 只有已签的活动类型→四类时长、旧角色→新角色、取数来源、精度／舍入、`defaultResult`／zero 语义和有效时间全部齐全，才判为 `comparable`。G04／G05 默认 hold，G13 的 zero 单独签字；其余未签类型同样 hold。
4. 结果至少区分 `equal`、`points_mismatch`、`legacy_rule_missing`、`policy_version_missing_or_unapproved`、`mapping_hold`、`input_source_mismatch`、`precision_boundary`、`source_drift`、`duplicate_active_pair`、`evaluation_error`。`not_comparable` 汇总不能混入 mismatch 或 equal。错误不得改旧结果或被静默吞掉；shadow 自身故障要形成脱敏诊断并按批准的故障预算处理。
5. 差异判断使用统一的百分位定点表示（旧 Decimal(5,2) 与新字符串点数），逐条保留两侧原值和解释，但不得把比较过程写入正式账本。需要给出总体、逐类型／角色、边界档、缺失与错误分桶；“差异归零”只对有真实来源且完整覆盖的 comparable 集合有意义。

## 4. 证据、权限和留存的三问

业务用途是为 E4／E5 提供可复核的差异治理证据，不是再造正式分数。推荐将每次比较的运行批次、精确版本／来源指纹、脱敏事实锚点、两侧点数、分类和异常码写成**只追加、不可覆盖**的受限证据；不保存姓名、手机号、证件号、原始备注或完整个人资料。可见面推荐仅显式 GLOBAL Human 授权的复核角色，内建角色零默认授予；具体权限码、查询入口、掩码和审计须在实施前单独评审。业务证据不设自动删除或 cron 清理；保留期限与退队后的可见性需维护者明确签字，不能先占位后补。若证据模型、字段或权限未签，本阶段只能做隔离夹具报告，不得把生产 shadow 改成无痕日志。

## 5. 分刀实施建议与验收

| 刀               | 目标                                                                                                                                   | 最低验收与停止条件                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E3-1 比较合同    | 纯比较器、分类与固定夹具报告；不接运行时、schema、权限或 API                                                                           | 同输入相等／不等、无规则、阈值两侧与等号、小时精度、角色／类别不匹配、重复 pair、版本 hash 漂移、重放稳定性均有正反例；旧计算器 characterization 原断言不改。只登记“夹具证明”，不登记真实等价                                              |
| E3-2 受控 shadow | 明确 off／shadow，默认 off；只在旧预填路径旁采集已签、同链、可比较事实，保留旧结果；写不可变差异证据与脱敏批次摘要，不引入 active 模式 | off 零副作用；shadow 下旧 HTTP／账本输出逐字不变；重复、并发、失败、权限撤销、旧规则变更和版本漂移 fail-closed 或明确归类；有限查询／时延预算；隔离库非空 rehearsal、全量回归、3b／4b／红区与 PR CI 各自独立通过。真实目标仍需另行现场授权 |

E3-1 与 E3-2 都不能用 `it.todo`、降低断言、提高业务超时或跳过失败来凑通过。E3-2 若引入持久证据须走 D 档六步；如需要新环境开关，只允许 `off`／`shadow`，不得提前接 `active`、第三个 cron、队列、缓存或 AI 解释器。失败记录与正式结算隔离，不能出现 shadow 写失败导致旧预填被悄然改值；具体故障处理与事务边界须在精确实施计划中拍板。

## 6. 候选精确写集（只用于下一轮授权评审）

以下路径来自当前引用链；**不是**本轮写入许可。E3-1 候选：

| 路径                                                                           | 目的                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `src/modules/activities/activity-contribution-shadow-comparison.ts`（新）      | 纯比较合同与分类，不查库、不写账本                      |
| `src/modules/activities/activity-contribution-shadow-comparison.spec.ts`（新） | 同输入／精度／缺项／差异正反例                          |
| `src/modules/attendances/contribution-calculator.spec.ts`                      | 只在旧行为确有覆盖缺口时补 characterization，保留原断言 |
| `docs/plans/activity-os-r5-e3-contribution-shadow-review-and-plan.md`          | 记录签字、实际写集和验收证据                            |
| `changelog.d/activity-os-r5-e3-contribution-shadow.md`（新）                   | E3-1 独立 PR 的变更片段                                 |

E3-2 **条件候选**（只有 §3／§4 签字和 E3-1 合入后再冻结）：

| 路径                                                                                                                                                    | 目的                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `prisma/schema.prisma`、`prisma/migrations/<审定时间戳>_activity_os_r5_e3_contribution_shadow/migration.sql`（新）                                      | 仅在批准持久证据合同后建只追加证据；无历史 DML／删除；SQL 另签 3b              |
| `src/modules/attendances/contribution-calculator.ts`、`src/modules/attendances/attendances.service.ts`、`src/modules/attendances/attendances.module.ts` | 旧预填旁的 off／shadow 接线，不改变旧返回或事务语义                            |
| `src/modules/activities/activity-contribution-policy-definition.ts`、`src/modules/activities/activity-contribution-policy-selection-query.service.ts`   | 仅在证明现有公开 evaluator／精确版本查询不足后申请；默认只读复用，不预授权修改 |
| `src/config/app.config.ts`、`src/config/app.config.spec.ts`                                                                                             | off／shadow 配置与默认关闭验证，具体配置名待定                                 |
| `test/e2e/attendances-contribution-prefill.e2e-spec.ts`、`test/e2e/activity-os-r5-e3-contribution-shadow.e2e-spec.ts`（新）                             | 旧预填零漂移、shadow 证据、并发和失败回归                                      |
| `docs/ops/activity-contribution-shadow.md`（新）、`docs/ai-harness/NEXT_TASKS.md`、`docs/ai-harness/FROZEN_DRAFTS.md`                                   | 操作边界与权威状态                                                             |

E3-2 的证据写者、审计事件／权限目录、生成文档、旧迁移 E2E 和测试清理 helper 具体路径尚不能从未签的数据合同确定，**不在此候选写集内**；一旦证实必需，先补精确路径并重新授权，不准“顺手”扩写。无新 HTTP／DTO 是本案默认；若评审决定对外提供差异查询，必须另行走 API surface、RBAC、OpenAPI／前端 handoff 与 contract 审批。

## 7. 一次性拍板与下次授权清单

1. 逐类型／角色签字：31 类中哪些真实可比较、四类时长映射、来源秒数及旧小时精度、zero/default、G04/G05/G13 处理、候选版本批准条件和生效时间。未签一律 hold。
2. 证据合同：比较粒度、事实锚点、不可比较分类、完整性分母、逐条／批次证据字段、查看角色与掩码、保存期限和退队边界；确认是否需要 additive 持久模型。
3. E3-1 精确实施授权：仅批准 §6 第一表的路径、指定隔离测试库、验证和 PR 流程；不把 E3-2 自动带入。E3-2 待 E3-1 主干通过后重新冻结全路径、查询／事务预算、schema／migration／seed／权限／审计／API 影响面，并另行批准 3b／4b 和红区令牌。
4. 真实目标：系统尚未上线，不预设生产连接。将来若选定实际目标，先单独授权只读盘点并确认旧规则、版本、同链事实存在；零来源则只能签“零来源／不适用”，不得制造规则或伪造差异归零。任何真实 shadow、部署、D8-OPS、E4／E5、Gate、删除或重算数据都须独立授权。

## 8. 本轮文档验收

本轮只更新 E2 两份台账并新增本稿。检查应包括：#1356 合并提交和同 SHA main CI、E1/E2 现有代码引用、文档格式／链接、`pnpm docs:readtax:check`、`pnpm docs:counts:check` 与 `git diff --check`。文档检查通过不代表 E3-1／E3-2 代码、数据库或真实业务验收完成。

## 9. E3-1 离线比较器交付边界

E3-1 的输入全部由调用方显式提供：夹具事实锚点、同源旧小时与新秒数、签字映射版本、旧规则快照与来源指纹、已批准政策版本和 definition hash。比较器不查库、不取“最新版”、不写正式账本，也不持久化差异。`equal`／`points_mismatch` 才进入可比较分母；未签映射、角色／类别缺失、来源不同、精度边界、版本／来源漂移、重复 pair 和求值错误均单独分桶。旧小时严格按两位小数换算为 36 秒单位；相差至多 18 秒记为精度边界，更大差异记为来源不一致。签字输入在本轮仅是固定夹具证明，**不是** 31 个真实类型的签字，也不是运行时可信采集链。

E3-1 只校验调用方提供的旧来源指纹 `expected`／`observed` 相等；它不负责从数据库快照独立重算该指纹。E3-2 若推进，必须在属主查询和同事务事实锚点上重新证明来源真实性、规则状态及版本批准，不能拿 E3-1 的夹具布尔值当生产授权。当前无真实目标或真实数据，不能宣称差异归零。

## 10. E3-1 主干验收与 E3-2 计划基点（2026-09-27）

[#1358](https://github.com/BA7IEE/srvf-nest-api/pull/1358) 已 Squash 合入 main `c0f9f07548a018ee039610212d310a39ca884541`。
[main CI 36295160818](https://github.com/BA7IEE/srvf-nest-api/actions/runs/36295160818) 对同一 SHA 的 attempt 2 为 completed/success：失败的 Contract + E2E (4) 与汇总均在维护者授权的单次重跑后通过，其他检查沿用首轮成功结果。首轮 D4 旧迁移回放在重建隔离 worker 库时因仍有连接而被安全守卫拒绝；重跑通过**不证明**连接未退出的根因已修复，亦不能把该故障夹进 E3-2 范围顺手修改。

E3-1 的交付物是 `activity-contribution-shadow-comparison.ts` 纯比较器及固定夹具测试，运行时、DB、权限、正式结果均未接线。以下 §11–14 是**评审提案与候选写集，不是 E3-2 实施授权**；未签决策仍为 hold。

## 11. E3-2 必须先签的数据与行为合同

| 决策点       | 推荐评审方向                                                                                                                                                                                                                         | 签字前的硬边界                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实类型映射 | 对 31 类逐类型／角色签旧规则、政策版本、四类时长、来源、旧小时精度、零分与有效期；G04／G05 默认 hold，G13 的 zero 单签。映射须有不可变版本和签字人。                                                                                 | 现有 `LEGACY_CONTRIBUTION_MAPPING_HOLDS` 全部仍是 hold；不得把目录候选、E2 `e2_fixture_*` 或 E3-1 `mapping.approved` 夹具布尔值当签字。                                                         |
| 同一事实锚点 | 对每个旧 submit/edit 的旧 `AttendanceRecord`、Activity、Member、旧规则快照与 E1 选择 revision／version/hash 建同链关系；从属主查询取 ACTIVE 未软删规则，重算来源指纹，锁后核对。                                                     | 新 submit 的记录 ID 在当前预填调用点尚未生成；edit 的旧记录之后被软删。须在精确接线设计里证明新旧记录及重放的稳定锚点，不可用姓名或顺序猜配。                                                   |
| 时间与分数   | 保留旧 `serviceHours Decimal(5,2)` 原值和来源；新 `durationSeconds` 只能来自已签同源事实，精度边界单列不可比较；新政策固定 `(id, policyId, definitionHash, evaluatorVersion)`，不得读“最新版”。                                      | `checkOutAt-checkInAt` 不自动等于可手工填写的旧 `serviceHours`；来源或精度无法证明时不做等价断言。旧预填、每日封顶和正式账本输出不变。                                                          |
| 证据与可见面 | 推荐持久、只追加的 run／comparison 收据：精确来源和签字版本、脱敏事实锚点、旧／新点数、分类、异常、时间与重放键；不保存姓名、手机号、证件号、备注。仅明确授权的 Human 复核面读取，按签字的脱敏／审计规则呈现。                       | 需维护者回答业务用途、谁可看／如何掩码、保留多久与退队后如何处理；未签不得占位建表、开放查询或宣称真实差异归零。用户此前已明确业务证据不因省空间自动删除。                                      |
| 故障与事务   | 在设计评审中选择“旧写绝不因 shadow 失败回滚”如何与“每次 shadow 尝试都有可追踪证据”同时成立，给出写前／写后时序、幂等键、失败补偿和告警闭环。既有考勤审计只可作为成功旧写的定位候选；§15 已核查它不足以单独担保不可变证据与失败重试。 | 当前旧预填位于业务事务内；同事务新增证据写若失败会回滚旧请求，纯事务后写若失败又可能无持久证据。两者不能靠一句“异步 best effort”调和；未定案不接运行时。不得引入第三个 cron、Redis 或新 queue。 |
| 开关和规模   | 仅 `off`／`shadow`，默认 off；分别测 submit/edit 的 1／100／2000 记录批量查询、事务时长、证据写入和并发／重放预算，最后在隔离库非空回放与 PR CI 验收。                                                                               | 不预填一个未经测量的 SQL／时延上限；不得提高既有业务超时、删测试或放宽断言。不加 active 模式，不启用生产 Gate。                                                                                 |

上述是需维护者/业务负责人拍板的合同，不因本稿写成“推荐”就成为事实。真实目标尚未选定，也没有获准查询真实旧规则；若目标确实零来源，只能签“零来源／不适用”，不能制造样本或把固定夹具报告写成差异归零。

## 12. D 档风险表与回退边界

| 项                         | 本轮文档／未来 E3-2 候选                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.prisma`、migration | 本轮零改动；持久证据方案若签，拟加只追加模型与一条 additive migration，旧 SQL 不回改，DDL／触发器定稿后另签 3b。                                   |
| seed、权限、审计           | 本轮零改动；若证据读面或新审计事件获批，须逐码说明 Human／scope／内建角色默认授予与 Service Principal 边界，另签 4b；不能假定 SUPER_ADMIN 直通。   |
| 现有数据与不可逆性         | 本轮零改动；候选仅追加新证据，不回填、不转换旧规则、不改正式账本。新增证据长期保留，不能以物理删除作为回滚；功能回退只能关闭 shadow 并保留证据。   |
| OpenAPI、DTO、BizCode      | 推荐本刀无新 HTTP／DTO／BizCode；一旦决定开放复核查询，必须另评 API surface、RBAC、审计、OpenAPI snapshot 和前后端 handoff，不能借本候选写集实施。 |
| soft-delete／unique／P2002 | 旧规则查询继续 `status=ACTIVE AND deletedAt IS NULL`，数据库现有 ACTIVE pair 约束不放宽；新证据的幂等唯一键和冲突重放语义待 SQL 评审定案。         |
| 人工审批                   | §11 六项合同、完整精确写集、红区令牌、3b／4b、隔离测试目标和 PR 流程均须独立批准；本轮文档授权不包含这些动作。                                     |

## 13. 候选写集核对清单（不是实施许可）

下面逐项列出**已可定位的候选路径**，避免“只批三文件”后在实施中无限扩写；新文件名是提案，必须随 §11 决策冻结，未列出的后果面须重新列项授权。

| 写集组        | 精确候选路径                                                                                                                                                                                                                                                                                                               | 前置／限制                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据地基      | `prisma/schema.prisma`；拟新增 `prisma/migrations/20260927180000_activity_os_r5_e3_contribution_shadow_evidence/migration.sql`                                                                                                                                                                                             | 仅在证据字段、唯一键、保留与事务策略签字后；SQL 仅 additive、同链 FK Restrict、不可改删及重放守卫，另签 3b。实际迁移时间戳若冲突须重新确认路径。                                       |
| 旧预填属主    | `src/modules/attendances/contribution-calculator.ts`、`src/modules/attendances/attendances.service.ts`、`src/modules/attendances/attendances.service.spec.ts`、`src/modules/attendances/attendances.module.ts`                                                                                                             | submit/edit 两处均接入；正式 `contributionPoints` 与旧异常、锁序、事务和返回逐字不变。先跑旧计算器 characterization。                                                                  |
| shadow 与证据 | 拟新增 `src/modules/attendances/contribution-shadow.service.ts`、`src/modules/attendances/contribution-shadow.service.spec.ts`、`src/modules/attendances/contribution-shadow-evidence.write.service.ts`、`src/modules/attendances/contribution-shadow-evidence.write.service.spec.ts`                                      | 具体拆分取决于 §11 事务／故障决策；证据模型属主与幂等写者须在代码评审中一一对应。复用 E3-1 `src/modules/activities/activity-contribution-shadow-comparison.ts`，不预授权改纯比较合同。 |
| E1 属主查询   | 拟新增 `src/modules/activities/activity-contribution-policy-shadow.query.ts`、`src/modules/activities/activity-contribution-policy-shadow.query.spec.ts`；`src/modules/activities/activities.module.ts`                                                                                                                    | 仅公开精确版本、批准态及同链选择查询，不从 attendances 深引 activities 私有实现；是否需要该新增原语须以现有公开服务不足为证。                                                          |
| 配置          | `src/config/app.config.ts`、`src/config/app.config.spec.ts`                                                                                                                                                                                                                                                                | 仅 off／shadow 且默认 off，配置来源和禁用行为做正反例；不预授权修改全局 bootstrap。                                                                                                    |
| 回归          | `src/modules/attendances/contribution-calculator.spec.ts`、`test/e2e/attendances-contribution-prefill.e2e-spec.ts`；拟新增 `test/e2e/activity-os-r5-e3-contribution-shadow.e2e-spec.ts`、`test/e2e/activity-os-r5-e3-contribution-shadow-migration.e2e-spec.ts`                                                            | 旧断言一条不删不放宽；覆盖 off 零副作用、同源对照、hold、来源漂移、事务故障、并发重放、不可变证据及历史非空升级。                                                                      |
| 治理和运维    | `test/setup/reset-db.ts`、`harness/domain-map.json`、`CODEMAP.md`、`docs/current-state.md`、`docs/ai-harness/ROUTE_AUTHZ.md`、`docs/ai-harness/CUTOVER_SIGNOFF.md`、`docs/ai-harness/NEXT_TASKS.md`、`docs/ai-harness/FROZEN_DRAFTS.md`；拟新增 `docs/ops/activity-contribution-shadow.md` 和独立 implementation changelog | 仅随实际模型／路由／计数刷新对应生成块；`test/setup` 与红区文档需逐路径令牌。若没有新路由，ROUTE_AUTHZ 只检摘要变化。                                                                  |

`prisma/seed.ts`、权限目录、AuditLogEvent union、OpenAPI/前端生成物和旧迁移测试的**精确文件清单目前不能冻结**：取决于 §11 的访问面、证据字段及新增 migration 的最终形态。它们不在上表实施许可内；先做只读引用链与生成器后果扫描，再补路径并重审，不允许实施时“顺手”补。未获业务映射签字时，运行时真实类型必须全部保持 hold；不能把缩成 fixture-only 的能力冒充 E3-2 完成。

## 14. 下一次授权与验收顺序

1. 先请维护者确认 §11 六项合同（含证据三问和故障／事务取舍）及真实目标。若暂时无真实来源，可以先评审数据合同与隔离环境，但不得宣称真实对账完成。
2. 再依据签字结果，做只读符号／引用链、schema 和派生文件后果扫描，冻结 §13 的增删与完整精确路径、SQL／查询／时延预算，提交单独 D 档实施授权清单。schema/migration/seed/权限/审计任何一项定稿后仍需对应 3b／4b、红区令牌；禁止 AI 自发授权。
3. 实施必须独立 PR：本地定向验证与获准隔离库冷回放、非空升级、旧 submit/edit 零漂移、正反例与规模；PR CI 冷跑；独立确认合并、同 SHA main CI。D8-OPS、真实转换、E4／E5、前端、生产与 Gate 都不继承该 PR 的许可。

本轮四文档编辑只验文档格式、台账状态、链接和 `git diff --check`；没有运行数据库、迁移或 E3-2 的任何行为测试。审查通过也只表示**计划可供拍板**，不表示 E3-2 数据合同已签或开发完成。

## 15. 既有考勤审计的证据边界补查（仅评审，不实施）

`AttendancesService.submit` 与带 records 的 `edit` 已在旧业务事务内写 `attendance-sheet.submit`／`attendance-sheet.edit` 审计；`after` 含 Sheet 与 Record 快照，审计写失败沿既有合同回滚业务事务。因此，这两类**成功提交**可以用既有审计定位候选旧事实，且不能把“审计存在”误当成 shadow 已尝试。`edit` 不带 records 的分支另有 `edit-no-records` 审计，不能混入逐条贡献值对照分母。

这份审计**不足以单独承担 E3-2 不可变证据**：快照包含 `note` 等敏感原文，现有审计查询会返回完整 `context`，读取范围也不是 E3-2 专用复核面；服务层不提供审计修改／删除方法，但仓内已落 migration 未见针对 `audit_logs` 的数据库级禁 UPDATE／DELETE 触发器。成功旧写的审计还没有签字映射版本、当时的 shadow 开关、对比尝试／结果／失败分类和重放键，不能靠事后猜测宣称“每次 shadow 尝试都有证据”或“真实差异归零”。这些结论是**仓内代码与 migration 的只读核查**，不是生产数据库审计。

后续候选设计只能把旧审计当作受控内部定位线索，不复制其敏感快照到新收据，也不直接开放通用审计 context 作为 E3-2 读面。若要满足 §11 的双重承诺，须另行评审最小化、只追加且数据库可验证的对比／失败收据，以及成功旧写与缺失收据的可核对锚点；必须说明 shadow 开关何时固定、失败发生在提交前还是提交后、如何发现并安全重试缺口。若另加同事务 intent，其写失败会影响旧写；若仅事后 best-effort 写收据，其失败又可能不留痕——两条路都不能在未设计、未验证前称为完成。审计访问面、保留／退队处理及模型字段仍待业务负责人签字；31 类真实映射保持 `hold`。

本节只更正评审依据，不批准新表、审计字段、权限、worker、接口、数据库操作或 E3-2 实施。§13 候选写集仍未冻结，须在上述取舍定案后另行列明精确路径、风险表与验证清单。
