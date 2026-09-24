# Activity OS Release 5 / E2 旧 ContributionRule 转换：评审与精确授权清单

> 状态：仅评审草稿，2026-09-24。E1-3 已随 #1349 合入 main，未部署。本稿不授权实施转换、运行数据库命令、操作生产或启用 Gate；E2 不继承 E1-3 的实施授权。

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

## 3. 待评审方案 A：先形成候选与证明，不切换读写

1. 先做**只读盘点**：按状态、软删、活动类型、角色、阈值和上下分值分组；输出脱敏数量、异常分类与来源指纹。盘点脚本、目标数据库和结果保存位置须先另行审批，本轮不运行。
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

本稿**不提交实施写集**：活动类型→时长分类、默认结果和时长来源尚未拍板，此时给出“完整实施路径数”会是假精确。下一轮先仅授权下列**只读定稿工作**，其输入和交付物明确，不含数据库操作：

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

## 6. 本轮允许写集与验证

原 E2 评审稿已随 #1350 合入 main。本次续稿仅编辑本文件，新增上述 13 组、31 条评审映射；不改 `NEXT_TASKS`、`FROZEN_DRAFTS`、TypeScript、Prisma、测试或门禁。已用目录逐条核对组选择器、条数及人工治理原文，并通过 `pnpm docs:readtax:check`、`pnpm docs:counts:check`、本稿 Prettier 检查和 `git diff --check`。此处的文档定稿不构成 E2 实施、数据库盘点或转换授权。
