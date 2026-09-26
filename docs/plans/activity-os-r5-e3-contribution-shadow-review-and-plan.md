# Activity OS Release 5 / E3：贡献政策新旧并算评审与精确授权清单

> 2026-09-27，基点为 `main@5510c43cefbe4f5e6f2fda506355c04a83efd975`。本稿仅供评审：不实施、不查询数据库、不操作生产、不启用 Gate，也不继承 E2 的 w98 或红区授权。下列路径是**候选写集**，不是已批准的实施清单。

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
