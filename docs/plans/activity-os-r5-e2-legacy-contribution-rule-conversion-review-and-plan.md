# Activity OS Release 5 / E2 旧 ContributionRule 转换：评审与精确授权清单

> 状态：精确实施计划草稿，2026-09-24；未上线场景修订于 2026-09-25。E1-3 已随 #1349、E2 映射评审已随 #1351 合入 main，均未据此部署。本稿不授权实施转换、运行数据库命令、操作生产或启用 Gate；E2 不继承 E1-3 的实施授权。

## 1. 目标与阶段边界

E2 的目标是把旧 `ContributionRule` 的业务含义整理为可追溯的版本化 `ContributionPolicyVersion` 候选，**保留旧规则及其历史证据**。E2 不改变任何现有考勤预填、结算或统计读写路径，不把转换结果当成正式生效政策。E3 才做新旧并算和差异清单；E4 才接正式结算；E5 才在独立窗口切换并将旧规则只读化。旧数据不删除、不重算，也不以转换覆盖 E1 已存在的版本。

本稿与 [E1 评审](activity-os-r5-e1-contribution-policy-review-and-plan.md)及终态蓝图 §13.4、Release 5 顺序一致。当前仅基于仓库代码和文档，不读取实际数据库，因此没有声称已知真实旧规则数量、分布或脏数据比例。

## 2. 已核对的现状与转换难点

| 事实                                                                                              | 当前证据                                                                | E2 约束                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 旧业务键为 `activityTypeCode × attendanceRoleCode`；`ACTIVE` 且未软删的同键槽位应唯一             | `prisma/schema.prisma` 的 `ContributionRule` 与手写 partial unique 注释 | 不按 `durationThreshold` 另起规则槽位；重复、软删或无效状态不能悄悄当成一条有效规则                       |
| 旧预填由考勤侧 `ContributionCalculator` 在调用方事务中读取；无规则为 0，重复 ACTIVE pair 直接报错 | `src/modules/attendances/contribution-calculator.ts`                    | 转换与对照必须保留无规则、等于阈值、超阈值和 `pointsAbove` 空值的原语义；不能以“看起来相似”替换线上计算器 |
| 旧 `dailyCap` 字段已废弃，计算器不读取；每日上限在汇总处另算                                      | 同上及 schema 注释                                                      | 不把旧 `dailyCap` 误写进版本政策或假称它在旧预填时生效                                                    |
| E1 已提供政策身份、不可变版本及选择／发布冻结                                                     | `ContributionPolicy`、`ContributionPolicyVersion` 与 E1-3               | 转换必须复用现有定义校验、canonical/hash 和版本治理，不直接改 E1-3 已冻结的选择或快照                     |

**关键语义缺口**：旧规则只有活动类型与角色，旧计算输入是浮点小时；E1 定义按角色、`volunteer_service`／`training`／`organization`／`non_creditable` 四类及整数秒档位求值，且有必填 `defaultResult`。当前没有代码可证明旧活动类型到这四类的一一映射。因此“旧规则逐行转成政策版本”并非已确定的数据合同；未经映射拍板与等价测试，不得批量写入或宣称 shadow 可比较。`Decimal(5,2)` 小时阈值转整数秒理论上可精确换算（0.01 小时 = 36 秒），但旧记录的 `serviceHours` 输入精度、边界舍入与新时长来源仍须用真实样本和正反例证明。

### 旧活动类型 13 组、31 条逐项映射（仅评审索引）

按 `LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY` 的「时长选择器 → 贡献选择器」相同分组。组号只是评审索引，不是政策身份、版本、E1 四类时长分类或等价结论。每条目录记录均带人工治理要求；同组不同类型、角色的实际旧规则仍须分别盘点和签字，不得自动合并。

| 组       | 时长选择器 → 贡献选择器                           |   条数 | 旧 `activityTypeCode` 与 `categoryCode`                                                                                           |
| -------- | ------------------------------------------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------- |
| G01      | `duty` → `duty`                                   |      5 | `futian_ustation`、`wutongshan_duty`、`icc_duty`、`helicopter_duty`、`department_duty`：`duty_readiness`                          |
| G02      | `incident_response` → `incident_response`         |      2 | `rescue_mission`、`disaster_relief`：`emergency_response`                                                                         |
| G03      | `logistics` → `logistics`                         |      3 | `daily_supplies`、`event_support_supplies`、`rescue_relief_supplies`：`logistics_support`                                         |
| G04      | `manual_recognition` → `manual_recognition`       |      1 | `assembled_no_action`：`emergency_response`                                                                                       |
| G05      | `none_until_classified` → `none_until_classified` |      3 | `assistance`、`psychological_assessment`、`transportation`：`pending_classification`                                              |
| G06      | `organization` → `organization_operation`         |      2 | `key_meeting`、`general_meeting`：`organization_operation`                                                                        |
| G07      | `public_service` → `public_service`               |      1 | `special_social_service`：`public_service`                                                                                        |
| G08      | `role_based` → `cooperation_exchange`             |      1 | `competition_exchange`：`cooperation_exchange`                                                                                    |
| G09      | `role_based` → `event_support`                    |      1 | `event_support`：`event_support`                                                                                                  |
| G10      | `role_based` → `organization_operation`           |      2 | `team_activity_support`、`department_team_building`：`organization_operation`                                                     |
| G11      | `role_based` → `outreach`                         |      4 | `external_lecture`、`external_promotion_federation`、`external_promotion_department`、`interview`：`outreach_communication`       |
| G12      | `training` → `training`                           |      5 | `external_training`、`team_training`、`external_course`、`external_joint_drill`、`internal_multi_dept_drill`：`training_exercise` |
| G13      | `training` → `zero`                               |      1 | `no_contribution_training`：`training_exercise`                                                                                   |
| **合计** | **13 个评审组，不是 13 个正式政策**               | **31** | **逐项要求见下表**                                                                                                                |

| 组  | 旧 `activityTypeCode`           | 目录原文：逐条人工治理要求               |
| --- | ------------------------------- | ---------------------------------------- |
| G01 | `futian_ustation`               | 核验站点、岗位和实际值守段。             |
| G01 | `wutongshan_duty`               | 核验站点、岗位和实际值守段。             |
| G01 | `icc_duty`                      | 核验站点、岗位和实际值守段。             |
| G01 | `helicopter_duty`               | 专业资格、地点和安全要求必核。           |
| G01 | `department_duty`               | 核验所属组织、地点和岗位。               |
| G02 | `rescue_mission`                | 核验关联 Incident 与正式结果。           |
| G02 | `disaster_relief`               | 核验关联 Incident 与正式结果。           |
| G03 | `daily_supplies`                | 核验物资事实归资源域。                   |
| G03 | `event_support_supplies`        | 核验保障上下文；不把物资当成果真相。     |
| G03 | `rescue_relief_supplies`        | 核验 Incident link 和资源事实。          |
| G04 | `assembled_no_action`           | 结果不得自动推出时长或贡献。             |
| G05 | `assistance`                    | 必填，禁止标题猜测。                     |
| G05 | `psychological_assessment`      | 必须先通过用途、可见性、掩码和留存治理。 |
| G05 | `transportation`                | 必填，运输不能自行充当 category。        |
| G06 | `key_meeting`                   | 核验是否为正式组织运行。                 |
| G06 | `general_meeting`               | 核验是否为正式组织运行。                 |
| G07 | `special_social_service`        | 核验服务对象、证据和特殊限制。           |
| G08 | `competition_exchange`          | 核验参赛、组织、保障身份。               |
| G09 | `event_support`                 | 核验岗位与受益对象。                     |
| G10 | `team_activity_support`         | 抽样核验是否实际为对外保障。             |
| G10 | `department_team_building`      | 核验组织运行与非计入情形。               |
| G11 | `external_lecture`              | 核验讲师、学员、保障身份。               |
| G11 | `external_promotion_federation` | 核验外部主体与活动目的。                 |
| G11 | `external_promotion_department` | 核验外部主体与活动目的。                 |
| G11 | `interview`                     | 核验采访对象、发布责任和参与身份。       |
| G12 | `external_training`             | 核验学员、讲师、保障身份。               |
| G12 | `team_training`                 | 核验学员、讲师、保障身份。               |
| G12 | `external_course`               | 核验课程和实际参与身份。                 |
| G12 | `external_joint_drill`          | 核验联合主体、岗位和科目。               |
| G12 | `internal_multi_dept_drill`     | 核验联合部门、岗位和科目。               |
| G13 | `no_contribution_training`      | 无贡献是政策结果，不删除培训事实。       |

这张表只证明目录覆盖，不证明旧库存在相应规则，也不填分值、角色、政策版本或生效状态。G05 的分类和敏感信息治理、G04 的单独认定均须先完成；G13 的 `zero` 不等于“无旧规则时返回 0”，不能删除培训事实。目录选择器到 E1 四类 `timeCategoryCode` 尚无获批映射；未映射或证据冲突保持待定、拒绝写入。真实分布和数值等价证明留待另行授权的只读数据库盘点与业务签字。

**未上线边界更正**：维护者已说明当前尚未上线，且仓内 seed 不内置真实 `ContributionRule`。这不能证明所有开发／测试环境均无旧规则，也不能凭空指定一个“生产库”要求维护者提供连接。开发纯转换器、固定夹具和隔离库验证不以生产盘点为前置；只有准备对某个实际目标执行存量转换时，才需另行确认该目标、只读核对旧规则分布并签字。目标确认为空时，记录零来源证据并保持零写入；不得制造历史规则、候选版本或转换收据以凑验收。

## 3. 待评审方案 A：先形成候选与证明，不切换读写

1. 先核对冻结目录与固定夹具；拟对实际目标执行转换时，再对**已确认的目标**做只读盘点：按状态、软删、活动类型、角色、阈值和上下分值分组，输出脱敏数量、异常分类与来源指纹。目标数据库、盘点脚本和结果保存位置须另行审批；未上线场景不预设存在生产目标，本轮不运行。
2. 对每个合法的现行旧规则组生成确定性的政策定义候选；记录原规则 ID、原始字段快照／hash、转换器版本、目标政策／版本及映射状态。原则上保留历史非 ACTIVE／软删记录为来源证据，而不是把它们激活。是否需要新增专门映射／收据表，待精确数据合同评审后确定，不预设 schema 已获批准。
3. 转换默认 **dry-run／零写入**；正式写入必须具备明确幂等键、冲突拒绝、事务一致性和可中断重放。若目标 code、版本或来源指纹冲突，fail-closed 并列异常清单；不得覆盖已批准／已冻结的政策版本。
4. 用固定样例先证明数值等价：无规则、无阈值、等于阈值、超阈值、`pointsAbove=null`、小数精度、重复 ACTIVE pair、软删及 INACTIVE。代表性历史样本和实际业务分布需在后续授权的隔离环境中验证。
5. E2 完成标准仅为**候选可追溯、异常可解释、回放可复现**。E3 运行时 shadow 对照、差异处理和任何切换判定均不在 E2 内；不因为 E2 测试通过而宣称业务等价已经证明。

### 尚待维护者拍板的业务选择

- 转换范围：只转换当前 ACTIVE 且未软删规则，还是也给历史 INACTIVE／软删规则建立非生效归档映射？推荐后者保留可追溯证据，但绝不激活历史规则。
- 无匹配规则的 0 分语义：是否仅在 E3 对照中保留旧语义，还是为其建立显式 zero-policy 候选？推荐不批量合成默认政策，先由 E3 差异报告呈现；蓝图的 `no_contribution_training` 示例须逐类型单独确认。
- 多个旧活动类型能否合并为同一政策身份，以及旧角色到 E1 定义角色的对应表；必须依据真实字典和业务签字，不做字符串猜测。
- 每个旧活动类型对应哪种时长分类、是否允许同一旧规则复制到多个分类，以及 `defaultResult` 的明确值和解释码。推荐先逐类型签映射表；未映射类型拒绝转换，不自动归入 `volunteer_service`。
- 新政策使用哪个已确认的时长来源与秒数，旧 `serviceHours` 小时阈值在 `<=` 边界如何换算；E3 必须用同一事实输入比较，不能把不同来源造成的差异误报成转换错误。
- 存量规则若在盘点与转换之间变更，采用什么冻结窗口／版本指纹及冲突处理；不得靠无审计的静默重试。
- 转换证据的永久归档位置、可见角色、保存期限，以及异常清单中敏感字段的脱敏规则。

## 4. 风险表（本轮文档编辑与未来 E2 分开）

| 项                                 | 本轮       | E2 实施候选，待独立审批                                                                            |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| schema／migration／seed            | 不修改     | 映射与收据是否需 additive schema/migration 尚待数据合同；seed 默认不动，若需改须单列               |
| 现有数据／不可逆性                 | 不触碰     | 来源旧规则永久保留；写入新候选是新增事实，须具备幂等、审计与回退策略；禁止覆盖／物理删除／历史重算 |
| API／DTO／OpenAPI／contract        | 不修改     | 默认无新增公开入口；若确需管理入口，另起 API surface、权限、handoff 和契约评审                     |
| 鉴权／权限／审计／BizCode          | 不修改     | 转换执行 actor、授权面、审计事件和错误码须在实施计划中逐一核定，不借用 E1-3 权限默认放行           |
| soft-delete／partial unique／P2002 | 不触碰     | 必须覆盖活动槽位冲突、并发插入及软删语义，不能把 P2002 归为成功                                    |
| 用户拍板                           | 已授权本稿 | 数据合同、真实库盘点、精确写集、隔离库、3b/4b、PR、生产窗口分别拍板                                |

## 5. 下一轮实施前的精确授权清单

下表是形成 §7–§11 候选实施计划的**只读输入**，不含数据库操作。§10 列出逐路径候选写集，但活动类型→时长分类、默认结果和时长来源尚未拍板，因此它不是可直接执行的最终写集；未决条件在 §7 明列，不能把候选路径数冒充实施授权。

| 只读工作           | 精确输入路径                                                                                                                                                                                                                                                                | 交付物                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 旧规则与写读链复核 | `prisma/schema.prisma`、`prisma/migrations/20260718160000_contribution_rule_active_pair_unique/migration.sql`、`src/modules/attendances/contribution-calculator.ts`、`src/modules/attendances/attendances.service.ts`、`src/modules/activities/settlement-draft.service.ts` | 旧业务键、状态／软删、事务、阈值和无规则语义矩阵；不读取真实库    |
| E1 目标合同复核    | `src/modules/activities/activity-contribution-policy-definition.ts`、`src/modules/activities/activity-contribution-policy.service.ts`、`prisma/schema.prisma`                                                                                                               | 四类分类、`defaultResult`、秒档位、版本状态和 canonical/hash 对照 |
| 兼容测试定位       | `src/modules/attendances/contribution-calculator.spec.ts`、`test/e2e/attendances-contribution-prefill.e2e-spec.ts`、`test/e2e/contribution-rules.e2e-spec.ts`、`src/modules/activities/activity-contribution-policy-definition.spec.ts`                                     | 待新增正反例清单；不改既有断言                                    |

这项只读定稿完成并取得业务选择后，再给出逐文件**实施写集**（不得用目录 glob 代替）、新增模型／字段／FK／索引及 SQL 草案、历史兼容矩阵、隔离测试库与清理范围、性能预算和 rollback/fail-closed 方案。拟实施时依次单独确认：

1. 方案 A 的最终数据合同与业务映射；确定性样本、异常分类、证据保存与 E2/E3 分界。
2. 精确写集及红区范围；由维护者本人发放红区令牌。任何 schema/migration/seed 变动单独按 D 档评审，SQL 定稿后再进行 3b 签字；权限／审计／目录变化定稿后再进行 4b 签字。
3. 指定**隔离测试数据库**、允许的测试夹具重建及回滚范围。不得把测试库授权推导为生产库、真实业务数据清理或历史回填授权。
4. 本地定向验证、旧语义 characterization、迁移冷回放／非空升级（若有 migration）、幂等／并发／冲突负例、完整 contract 与 PR CI；保留全部既有断言。
5. 提交／推送／创建 Draft PR、Ready、可信红区审批、合并及最终 main CI 分阶段授权。若 #1324 仍 open，唯一 open PR 例外也须重新确认，不能沿用 E1-3 的一次性豁免。

生产盘点、生产转换、部署、D8-OPS、E3–E5、v1.1 Gate、旧规则只读化、业务数据删除或重算均在本清单之外，必须另立授权。

## 6. 13 组映射续稿的已完成记录（#1351）

原 E2 评审稿已随 #1350 合入 main；映射续稿 #1351 也已合入。#1351 仅编辑本文件，新增上述 13 组、31 条评审映射；未改 `NEXT_TASKS`、`FROZEN_DRAFTS`、TypeScript、Prisma、测试或门禁。该轮已用目录逐条核对组选择器、条数及人工治理原文，并通过 `pnpm docs:readtax:check`、`pnpm docs:counts:check`、本稿 Prettier 检查和 `git diff --check`。此处的文档定稿不构成 E2 实施、数据库盘点或转换授权。

## 7. E2 实施方案 A：逐类型候选，不按 13 组自动合并

1. **一旧类型一候选政策身份**：13 组只作评审排班；建议以 `legacy_<activityTypeCode>` 生成候选 `ContributionPolicy.code`（31 个目录 code 的最长结果为 36 字符，符合现有 64 字符上限）。若该 code 已占用、旧类型不在冻结目录、角色不在已签字对照表、ACTIVE pair 重复或来源发生变更，全部列异常并拒绝写入；不得覆盖、复用或猜测已有政策身份。多个类型共享政策身份只能另行签字。
2. **先签映射，再生成定义**：每个类型须明确 E1 的 `timeCategoryCode`（四选一）、旧角色→E1 角色、时长来源、`defaultResult` 及解释码、是否可转换；G04、G05 默认 `hold`，G13 的 `zero` 须单独签“政策结果为零而培训事实保留”。未签类型没有正式候选版本，绝不由目录选择器自动推成 `volunteer_service`。
3. **只为有合法 ACTIVE 规则的类型建立 draft 候选**；没有旧规则不批量合成 zero-policy。历史 INACTIVE／软删规则继续留在旧表；若维护者选择归档映射，只产生非生效来源证据，不激活、不回填旧业务。E2 不把 draft 变为 active，也不写活动选择、考勤、结算、账本、每日上限或统计。
4. `ContributionPolicyDefinition` 建议每个 ACTIVE 旧角色产生一个 `roleRule`，仅在已签时长分类下建档；无匹配角色的 `defaultResult` 候选为 `{ recognizedPoints: '0.00', explanationCode: 'legacy_no_rule' }`，**此值与解释码仍需业务拍板**。定义和版本一律走 E1 的 parser、canonical/hash、`schemaVersion=1`、`evaluatorVersion=1`；`effectiveFrom` 由签字清单给定，不能用运行时 `now()` 补空。
5. `durationThreshold=null` → 一个末档；非空时 `Decimal(5,2)` 小时按十进制定点运算 `× 3600` 得到包含边界的整数秒档（0.01 小时 = 36 秒），高档使用 `pointsAbove ?? pointsBelow`。旧计算器实际上比较 `serviceHours: number` 与 `Number(threshold)`；**只有证明旧输入精度和新秒数来源在边界一致后**才能宣称同输入等价。旧 Decimal 可能存在 E1 `recognizedPoints` 不接受的负值／越界值，须列异常并拒绝，不能夹取或重写。若时长不一致，记录差异并停在 E3 对照，不改旧断言来掩盖。
6. 推荐一份未来的受控实现 PR 包含 dry-run 与候选写入能力，但正式写入入口必须显式 `--commit` 且绑定已签映射指纹、操作者和目标环境；默认 dry-run 零写入。生产运行、生产盘点、部署及开 Gate 均另立现场授权。

### 实施前须一次拍板的选择（当前均未获批）

| 决策                                    | 推荐 A                                                                                                     | 未签字时的处理               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 31 类到 E1 四类的映射、角色与时长来源   | 每类型／角色逐项签字，G04/G05 hold、G13 单签                                                               | 不生成该类型的版本           |
| 政策身份与碰撞                          | 每类型一新 code；既有 code 绝不覆盖                                                                        | 碰撞列异常并停止该批         |
| 无规则与默认结果                        | 不为无规则类型造版本；有规则类型未匹配角色返回 `0.00` 候选                                                 | 不写版本，保持旧行为         |
| 历史 INACTIVE／软删来源                 | 旧表永久保留；非生效来源索引可选                                                                           | 不激活、不删除、不重算       |
| `effectiveFrom`、解释码、证据可见与留存 | 由维护者签字的不可变清单给定，不用当前时钟猜                                                               | 拒绝写入                     |
| 操作者、授权与审计                      | 复用显式 GLOBAL Human `contribution-policy.manage.version`，锁后重读 ACTIVE 身份；建议新增独立转换审计事件 | 无操作者或授权则拒绝         |
| 执行与回放                              | dry-run 默认；提交同事务写 draft、来源收据和审计，重放仅返回原结果                                         | 指纹变更／缺收据 fail-closed |

## 8. 候选数据合同与事务边界（待 schema／SQL 评审，不是实施授权）

建议只**追加** `ContributionRuleConversionReceipt`，不修改或删除 `ContributionRule`，也不改 E1 既有版本合同。每条收据锚定 `sourceRuleId`、`sourceFingerprint`、`converterVersion`、`mappingFingerprint`、`batchFingerprint`、结果状态、操作者与时间；生成候选时再锚定 `policyId`、`versionId`、`definitionHash`、`evaluatorVersion`。源快照只保留类型、角色、阈值、上下档分值、状态、软删和更新时间等必要字段；`remark`、用户姓名等不复制。来源旧表永久留存。建议 `(sourceRuleId, sourceFingerprint, converterVersion)` 唯一，旧规则与 E1 版本的 FK 均 `Restrict`，目标版本以 E1 已有复合锚点校验；收据写后不可 UPDATE／DELETE／TRUNCATE。归档历史来源若获批，可用 nullable 目标锚点和独立非生效状态，但不能混同已创建候选。

一类型的全部 ACTIVE 角色构成同一候选版本和批次指纹：按业务键及源 ID 排序后 canonical/hash，避免查询顺序影响回放。只读盘点可分批游标扫描；写入在**同一事务**中先锁来源行、按固定顺序锁／占用目标政策身份，锁后重读来源指纹和操作者 GLOBAL 权限，再创建政策、draft 版本、逐源收据与审计。不得调用会另起事务的 HTTP 命令拼装原子性；E1 写者须提供可复用的事务内属主原语。重复的相同批次核对收据、源指纹、映射指纹、版本复合锚点与定义 hash 后返回原结果，不能新建版本；映射变更须明确提升转换器版本并重新签字，不能覆盖原收据。缺项、P2002、陈旧指纹或目标 code 冲突都回滚并报脱敏异常，不把冲突当成功。一次事务的规则数、锁等待和超时预算须用隔离规模样本核定，不得盲目扩大 5 秒业务预算。

迁移只建新表、FK、索引与守卫，**零历史 DML／回填／删除**；非空库升级先只读证明现有规则、E1 版本与 FK 无冲突，失败时整条 migration 回滚。回退应用不能物理删掉已经产生的候选与收据；停用转换入口并保留旧计算器为唯一正式路径，数据修正须另走审计流程。

## 9. 未来实现顺序与验收矩阵（本轮一项也不执行）

| 顺序                  | 实现探针与交付                                                                                                                                                                                           | 失败时的闭锁                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A. 签字清单和目标盘点 | 先用冻结目录与固定夹具完成逐类型映射、边界和精度评审，不要求提供不存在的生产连接；仅在拟对某个实际目标执行存量转换前，另行授权该目标只读盘点 type／role、ACTIVE pair、软删和阈值，并记录零／非零来源证据 | 未签映射或夹具语义不明则不提交候选；未确认目标和只读结果则不对该目标执行转换 |
| B. 纯转换器与 dry-run | 固定 manifest → 逐类型定义／来源 hash／异常清单；不建版本、不写收据；检验 64 角色上限、两个时长档上限、阈值 `<=`、`pointsAbove=null`、无规则 0、顺序无关                                                 | 任何一例不等价或不满足 E1 parser／hash 即拒绝候选                            |
| C. additive 数据地基  | 一条新 migration 只建收据与约束，无 DML；131 条历史 checksum 不变；132 条冷回放与 131→132 含旧规则、E1 版本的非空升级                                                                                    | migration 失败整体回滚；不修脏数据、不跳过守卫                               |
| D. 隔离环境提交       | 显式 `--commit`：锁来源、锁后复核权限与指纹，同事务建新政策／draft 版本／逐源收据／审计；相同输入重放零新增，冲突回滚                                                                                    | P2002、版本／来源／权限变化不得转换成成功；不覆盖既有政策                    |
| E. 回归与交付         | `ContributionCalculator`、考勤预填、旧规则管理和结算 characterization 不变；新候选不进入选择／发布／正式账本；CI 全量冷跑                                                                                | 既有断言变更或正式路径分值变化立即停下报告                                   |

性能预算须在获批隔离测试库测量并随实施 PR 写明，包括盘点分页上限、每类型最大角色数、锁等待、事务查询数和批量写入耗时；不得靠提高既有 5 秒业务事务超时或删断言求绿。盘点脚本不得输出姓名、备注、原始敏感内容或真实业务主键到 PR／CI 日志。新收据在测试夹具库的清理范围也须单列；测试库重建不等于业务数据删除授权。

未上线实施按两层验收：第一层可在无真实存量规则时实现、验证纯转换能力及隔离夹具中的非空提交／重放／约束，证明“具备转换能力”，不声称“已转换存量”；第二层仅在实际目标存在旧规则、盘点和业务签字齐全后，另行授权运行转换并形成该目标的来源收据。若实际目标确认为零来源，则第二层只能签“零来源、零写入／不适用”，不能伪造非空转换完成。E3 新旧并算若没有真实同链旧事实，只能做受控夹具对照；不得据此宣称真实存量等价或跨越 E4／E5 的切换门槛。尤其旧 `serviceHours` 按两位小时数取整时，4 小时 1 秒可能变成 4.00 小时，而新事实为 14,401 秒；直接把 4 小时阈值换成 14,400 秒并用“同输入”宣称等价是不成立的，必须先固定来源精度再判断差异。

## 10. 逐路径候选写集（实施前须按实际数据合同再冻结）

以下 41 项均是**具体路径**（27 个既有、14 个拟新增），不是目录 glob；只列能从当前代码引用链确定的候选。新增路径以“新”标识。本轮仅编辑本评审稿。A/B 项以第 7 节业务签字为前提，C 项仅在相应生成器／迁移兼容探针命中时刷新；未列文件若成为必需，先扩写集并重新拍板，不“顺手”带入。路径数是候选上限，**不是最终获批实施路径数**。

| 组  | 精确路径                                                                                              | 预期作用                                                             |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A   | `prisma/schema.prisma`                                                                                | additive 收据模型、复合锚点与 Restrict 关系；不改旧规则列            |
| A   | `prisma/migrations/20260924180000_activity_os_r5_e2_contribution_rule_conversion/migration.sql`（新） | 第 132 条候选 migration；仅 DDL、约束与不可变守卫；SQL 定稿后另签 3b |
| A   | `harness/domain-map.json`                                                                             | 新模型属主登记                                                       |
| A   | `harness/state-machines.json`                                                                         | 若收据结果闭集落库，仅登记不可变结果配置，不造生命周期               |
| A   | `src/modules/activities/activity-contribution-rule-conversion.mapping.ts`（新）                       | 逐类型已签映射与映射版本指纹；未签值不得填充                         |
| A   | `src/modules/activities/activity-contribution-rule-conversion.ts`（新）                               | 纯来源规范化、十进制阈值换算、E1 定义和 hash                         |
| A   | `src/modules/activities/activity-contribution-rule-conversion.service.ts`（新）                       | dry-run、锁序、同事务提交和收据回放                                  |
| A   | `src/modules/activities/activity-contribution-rule-conversion-audit-recorder.ts`（新）                | 转换提交专属脱敏审计；事件定稿后另签 4b                              |
| A   | `src/modules/activities/activity-contribution-policy-command.ts`                                      | 提供事务内属主原语；四种 E1 既有命令行为不变                         |
| A   | `src/modules/activities/activities.module.ts`                                                         | 只注册内部 provider，不新增 controller／route                        |
| A   | `src/modules/audit-logs/audit-logs.types.ts`                                                          | 若采用独立事件，仅加评审通过的一项，不借旧事件冒充                   |
| A   | `scripts/activity-contribution-rule-conversion.ts`（新）                                              | 默认 dry-run、显式提交开关和目标库／操作者 fail-closed 预检          |
| B   | `src/modules/activities/activity-contribution-rule-conversion.mapping.spec.ts`（新）                  | 31 条覆盖、hold、未知类型与签字指纹                                  |
| B   | `src/modules/activities/activity-contribution-rule-conversion.spec.ts`（新）                          | 旧阈值、精度、无规则／无档位、上下档及 canonical/hash 正反例         |
| B   | `src/modules/activities/activity-contribution-rule-conversion.service.spec.ts`（新）                  | 幂等、锁后复核、冲突、回滚、权限失效与零副作用                       |
| B   | `src/modules/activities/activity-contribution-rule-conversion-audit-recorder.spec.ts`（新）           | 审计事件、字段白名单和脱敏                                           |
| B   | `src/modules/activities/activity-contribution-policy-command.spec.ts`                                 | E1 既有命令 characterization 不变                                    |
| B   | `src/modules/audit-logs/audit-event-registry.spec.ts`                                                 | 新事件登记正反例；若复用现有事件则不改                               |
| B   | `test/e2e/activity-os-r5-e2-contribution-rule-conversion.e2e-spec.ts`（新）                           | 隔离库 dry-run／提交／重放／并发／旧路径不变                         |
| B   | `test/e2e/activity-os-r5-e2-contribution-rule-migration.e2e-spec.ts`（新）                            | 132 冷回放、131→132 非空升级、FK／守卫负例                           |
| B   | `test/setup/time-ledger-fixture-cleanup.ts`                                                           | 新收据测试夹具受控清理及 no-truncate 守卫恢复                        |
| B   | `test/setup/reset-db.ts`                                                                              | 仅隔离测试库清理依赖闭包，不触及业务数据                             |
| B   | `test/e2e/activity-os-r5-e1-3-contribution-policy-selection-migration.e2e-spec.ts`                    | 当前总数 131→132，历史 130→131 目标不改                              |
| B   | `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`                                      | 当前总数适配，历史断言不变                                           |
| B   | `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`                                        | 同上                                                                 |
| B   | `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`                           | 同上                                                                 |
| B   | `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`                                        | 同上                                                                 |
| B   | `test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts`                                        | 同上                                                                 |
| B   | `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`                                    | 同上                                                                 |
| C   | `docs/ops/activity-contribution-rule-conversion.md`（新）                                             | dry-run、授权、隔离库、异常、重放和生产 NO-GO SOP                    |
| C   | `docs/plans/activity-os-r5-e2-legacy-contribution-rule-conversion-review-and-plan.md`                 | 记录最终签字、实测和 PR／CI 状态                                     |
| C   | `changelog.d/activity-os-r5-e2-legacy-contribution-rule-conversion.md`（新）                          | 仅登记仓内事实，不声称部署／业务切换                                 |
| C   | `prisma/CLAUDE.md`                                                                                    | 当前模型与 migration 摘要                                            |
| C   | `src/modules/activities/CLAUDE.md`                                                                    | 新属主职责摘要                                                       |
| C   | `CODEMAP.md`                                                                                          | 运行既有生成器刷新摘要                                               |
| C   | `docs/current-state.md`                                                                               | 仅运行 `docs:counts` 刷新 migration 等生成计数                       |
| C   | `docs/ai-harness/STATE_MACHINE_INVENTORY.md`                                                          | 新结果闭集 inventory（若适用）                                       |
| C   | `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`                                                             | 新审计事件目录（若采用），配 4b                                      |
| C   | `docs/ai-harness/CUTOVER_SIGNOFF.md`                                                                  | SQL 与权限／审计最终摘要签字；不得预签                               |
| C   | `docs/ai-harness/FROZEN_DRAFTS.md`                                                                    | 仅顶部当前 E2 状态和派生读数                                         |
| C   | `docs/ai-harness/NEXT_TASKS.md`                                                                       | 仅顶部 E2 进度与下一授权点                                           |

`prisma/seed.ts`、权限码目录、API／DTO／OpenAPI snapshot、`ContributionRule` 旧写路径、`ContributionCalculator`、E1 已生效选择／模板和账本不在候选写集。若真实盘点发现必须扩展上述任一路径，不把它视为本计划的隐含授权。七份旧 migration 测试只允许刷新“当前总数”，不得改变各自历史升级目标和业务断言。

## 11. 执行授权包与验收边界（下一轮再确认）

1. **业务签字**：批准逐类型四类时长映射、角色对照、hold／zero 决定、`defaultResult` 与解释码、`effectiveFrom`、来源精度、证据可见和留存；31 条目录只是候选索引，不代替签字。
2. **数据库与写集**：第一层能力实施先批准第 8 节模型、SQL、逐路径写集和指定隔离测试库，用固定夹具证明非空／空源、边界、重放和兼容，不以生产连接为前置。仅第二层实际目标转换前，另行确认目标并批准其**只读**盘点及脱敏结果位置；根据真实零／非零分布再决定是否需要对该目标执行转换。维护者本人发红区令牌，SQL 最终 SHA-256 再签 3b；审计事件／目录最终摘要再签 4b。不得用测试库令牌推导生产授权。
3. **验证与交付**：隔离库定向 E2E、迁移冷回放与非空升级、旧 `ContributionCalculator`／考勤预填／结算 characterization、contract、lint／typecheck／build、Harness 与 docs 守护、PR CI 冷跑。提交／推送／Draft PR、Ready、可信红区审批、合并、main CI 分阶段记录；若 #1324 仍 open，再单独确认该次唯一 open PR 例外。
4. **操作禁区**：本计划不执行任何数据库查询或写入；未来实施 PR 也不自动运行生产盘点／转换、`migrate dev|reset`、`db push`、生产 `migrate deploy`、D8-OPS、E3–E5、Gate、旧规则只读化、业务数据删除或重算。

## 12. 本次计划稿的独立验收

本次只编辑本文件；以上字段、目录与路径基于 `schema.prisma`、旧计算器、E1 定义／命令、旧 partial unique migration、13 组目录和测试引用链只读核对。41 个候选路径经存在性与重复检查（27 个既有、14 个明确标为新，零意外缺失）；`pnpm docs:readtax:check`、`pnpm docs:counts:check`、本稿 Prettier 与 `git diff --check` 已通过。#1351 合并提交 `d4c0f188` 的 main CI `35994894996` completed/success；该结果不验证本轮未提交计划稿。未访问任何数据库，未创建 migration 或 CLI，未选择实际 `timeCategoryCode`、操作者及正式分值。计划 PR 和实施 PR 均未由本次授权自动获准。

## 13. 第一层隔离能力实施授权（2026-09-25）

维护者确认按第 8–11 节实施，且第 10 节 41 个精确路径为写集上限。#1355 的纯转换器已合入 main；本轮只补隔离能力，不把 13 组、31 条目录解释为已签业务映射。全部真实类型保持 `hold`，不得从目录选择器推断 E1 四类时长、角色、默认结果、生效时间或正式政策身份。隔离库中可使用明确标为测试夹具的虚构类型，验证非空提交、重放与约束；测试成功不代表任何真实旧规则已转换或数值等价已获业务认可。

本轮只允许 `app_test_w98` 隔离验证及测试夹具重建，验证后提交、推送、创建 Draft PR。migration SQL 与审计目录定稿后分别另请维护者确认 3b／4b 重签；未重签前不得伪造签字结论。不得查询或转换真实业务数据，不操作生产，不启用 Gate，不删除或重算旧数据，也不自动 Ready 或合并。

### 13.1 本工作树验证与补充写集

维护者已确认第 132 条 SQL SHA-256 `9bbb043c06e024f926b1056075966d5b5c81254888fe6525b47cf0c20296efe5` 的 3b，以及权限码 269、审计 174 总计／169 活跃的 4b；签字已登记并由 `cutover:check` 对拍。`app_test_w98` 完成 132 条冷回放、131→132 含旧规则与政策版本的非空升级 2/2，以及固定合成夹具 dry-run／提交／重放 2/2。首次迁移负例被来源唯一键先行拦截，已仅更换该负例的测试指纹，使其实际命中版本复合外键；migration SQL 和生产代码未因此变更。

维护者另确认将第 10 节漏列的 19 份旧 migration E2E 扩入本轮写集，仅刷新当前总数／冷回放标题 131→132，保留各自历史升级目标、业务断言与生产代码。`docs/ai-harness/ROUTE_AUTHZ.md` 的单项红区令牌已由维护者发放，已用既有生成器刷新摘要，仍是 658 个端点。`cutover:check` 此前除该派生摘要外，仍报告原有 5 条 `it.todo`；刷新后须重跑对拍，且无论如何不宣称 T0-A Gate 可开。

首轮全量单测 424 套中 423 套通过，1 套旧结构测试失败：`settlement-draft.service.spec.ts` 禁止 activities 模块直接读取 `ContributionRule`，而本轮转换服务的来源查询触发了该约束。维护者随后批准第 13.2 节属主查询原语方案；修复后全量单测 425 套、9060 条通过，5 条历史 `todo` 保持原状。原结构断言逐字保留，未靠改写语法规避；E2 `w98` 转换用例重跑 2/2 通过。

### 13.2 属主查询原语（2026-09-27 已批准并在本工作树实施）

精确新增 `src/modules/contribution-rules/contribution-rule-conversion-source.query.ts` 与同名 `.spec.ts`，并修改 `src/modules/contribution-rules/contribution-rules.module.ts` 导出该 provider；第 10 节已列的 `activities.module.ts` 导入属主模块，E2 转换服务与夹具 CLI 只调用公开 provider。查询原语接收调用者既有 `Prisma.TransactionClient` 与固定夹具类型，按 `activityTypeCode`、`ACTIVE`、`deletedAt: null` 过滤，按角色码和 ID 排序，返回 E2 来源指纹需要的原字段；不自行开启事务、判权、写入或缓存。调用者仍负责两轮 GLOBAL Human 权限复核、来源锁、锁后重读和同事务政策／收据／审计提交。属主单测覆盖过滤、排序、字段投影和同一事务对象透传；原 `settlement-draft.service.spec.ts` 结构断言逐字保留。此方案未改 schema、migration、seed、API、DTO、权限、Gate 或旧规则业务行为；第 132 条 3b SQL 摘要不受影响。

### 13.3 OpenAPI 生成顺序（2026-09-27 已批准）

属主模块接入后，离线 OpenAPI 生成器的模块遍历顺序改变。维护者仅批准扩展 `docs/handoff/openapi.json`：运行既有生成器刷新条目排列，不改接口、DTO、鉴权声明或契约断言。刷新前后 JSON 深度语义相等，路径均为 514 条、schema 均为 936 项；`pnpm docs:openapi:check` 通过。这是顺序差异，不是 tag 或字段变更。

`cutover:check` 随后指出前端 client 的输入摘要陈旧。维护者又精确批准 `docs/handoff/clients/shared/types.ts` 与六个 surface 各自的 `types.ts`、`client.ts` 共 13 个生成路径；运行 `pnpm docs:feclient` 后逐文件 diff 仅有同一行 `inputDigest` 更新，类型和调用签名未变。生成器、业务代码、接口及断言均未因此改动。

### 13.4 Draft PR 首轮 CI 回归

#1356 首轮 SHA `9e159bab` 的 Change set、Incident replay、Harness selftests、Diff guards、Docker image build、Fast checks、Golden journeys 与 Contract + E2E (1) 通过；Contract + E2E (2)–(5) 中 (2)、(3)、(4)、(5) 报红。已在原获批写集内修正四类兼容问题：D7-2、D8-1、E1-1 冷回放把历史 E1-3 错绑到“当前最后一条”，现固定为第 131 条（数组索引 130）；C2 D1 当前回放计数 `131→132`；通用 `resetDb` 不再在旧 schema 上无条件引用 E2 收据表，改由已存在的同事务清理 helper 按表存在性处理；E2 新 E2E 始终切入其业务能力限定的 w98，而不误用 CI 分片默认 worker。D7-2 5/5、D8-1 3/3、E1/C2/E2 合计 12/12、旧服务段迁移 5/5 的 w98 定向测试通过。

旧 D6 触发器测试首轮失败，是其回调未清空 E1 政策选择三表，helper 的 fail-closed 守护正确拒绝。维护者先批准将三表加入原受控 TRUNCATE，保留断言和超时；w98 实测被 `Activity`、`ActivityRuleSnapshot` 等外键结构以 PostgreSQL `0A000` 拒绝。只读 FK 递归盘点显示 `CASCADE` 会覆盖约 98 张**隔离测试库**关联表；相关禁止 TRUNCATE 触发器均在原 helper 的同事务禁用／恢复清单中。维护者随后明确批准仅在 w98 隔离库的同一受控清理 SQL 末尾加 `CASCADE`。旧 D6 5/5 通过，原断言和超时未改；不涉及真实业务库。

以上是本地修复与定向证据，不代表 #1356 新 SHA 的全量 CI 已通过；红区 trusted approval 仍需维护者在本轮提交对应的 workflow 中逐次批准。Gate 仍 NO-GO。
