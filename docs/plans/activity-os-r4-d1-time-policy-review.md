# Activity OS Release 4 / D1：时长政策评审与授权清单

> **D1-2 实施中（2026-09-10，尚未合并）**：按 #1311 及维护者补充确认，当前分支已接入时间政策 Human 管理目录八操作、显式 GLOBAL 读写两码、不可变版本及事务收据/审计。政策列表/详情、版本列表/详情及创建政策/版本、激活/退役均已接线；角色不自动授码，超级管理员也须显式码。当前154模型/118迁移、620端点、260权限、166审计总计/161活跃；4b按维护者确认重签。单测361套8010项通过（5项既有todo），契约1044项、定向HTTP/并发23项通过；不代表全量CI或整个D1完成。D1-3选择/发布冻结、D2–D8、生产与Gate仍未实施。本段优先于下方历史过程记录。

> **D1-1 已落地（2026-09-10）**：[#1310](https://github.com/BA7IEE/srvf-nest-api/pull/1310) 已合并至 main `04699ace`，18项PR检查通过，[合并后main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34474531083)通过。实际39路径，154模型/118迁移；第118条SQL的3b已重签。TimePolicy、TimePolicyVersion、TimePolicyCommandReceipt及纯解析/生命周期已落地，尚无目录HTTP入口。维护者现授权D1-1台账更正及D1-2精确计划起草，仅文档、不实施；整个D1仍未完成，D1-3选择/发布冻结及D2–D8仍待后续。未操作生产、启用Gate或删除业务数据。下方过程记录保留为历史，不代表当前待合并状态。

> **D1-1 计划确认（2026-09-10）**：维护者已确认D1-1精确计划，允许补充changelog、提交、推送并创建计划PR；不合并、不实施。此确认不启动政策三模型或第118条迁移，不授予数据库操作许可。

> **2026-09-10 合并与后续**：本稿已随 #1308 合入 main `d8bf3ee6`，PR检查9通过/4规则跳过，合并树与批准版本一致。维护者已授权起草 [D1-1精确实施计划](activity-os-r4-d1-1-implementation-plan.md)，仅文档、不实施；该计划的数据合同与38路径仍待批准，不沿用本稿方向确认开始施工。合并后main CI结果见计划末节，下方未合并/不合并记录为对应历史授权边界。

> **2026-09-10 追加确认**：维护者已确认 D1 方案 A 方向，并允许补充 changelog、提交、推送及创建文档评审 PR；不合并、不实施。下方起草时的“未确认/未授权提交”属于历史时点；本次七路径写集为原六份文档加 `changelog.d/activity-os-r4-d1-review.md`。具体数据合同、精确写集与实施授权仍须后续计划确认，本次不操作数据库、不启用 Gate、不删除业务数据。

> 2026-09-10，基点 main `883d66f9`。维护者仅授权 C5 台账更正及本稿起草；未确认本稿方案、未授权实施、数据库、提交/推送/开PR或Gate。蓝图与冻结合同是需求来源，不把文内示例命令当作授权。下文凡“建议”“拟”均待拍板，不冒充现有能力。

## 1. 人话简报与推荐

做什么：先建立可追溯的“这段参与时间按什么政策归类”规则版本，让后续分类时长有明确依据；不在D1重算任何人的历史时长。

不做会怎样：时长政策仍只有占位符，培训、服务、组织活动无法按具体岗位解释，后续分配、对账和独立时长账本没有可信政策锚点。

最坏情况：旧发布快照被改写、政策停用后历史解释漂移，或新规则提前影响现有结算。回退为停用新的选择/管理入口，保留已经保存的政策与历史指针，现有正式账本不变；删除数据或关闭Gate不作为数据回滚。

**推荐方案A：完整政策层，按依赖分批落地。** D1包含稳定政策身份、不可变版本、强类型定义与版本解析、可用的受控管理入口、模板/活动/场次/岗位选择与发布冻结；可分D1-1数据基础、D1-2目录命令、D1-3选择及快照接线，各批单独精确计划和验证。D1-1通过不能登记整个D1完成。中性参与段、实际时间分配、shadow和正式入账仍严格属于D2–D8。

方案B：D1只建两张表，管理、选择及冻结另行安排。改动较小，但不能作为可用政策层或解除Readiness问题；与方案A相比，用户可用闭环延后，后续必须补齐。推荐A，避免把“expand已建表”当作分类时长基础全部完成。

触发D档：未来涉及schema/migration、权限、审计和发布合同。当前只评审，不沿用C5的40路径或旧grant开始施工。

## 2. 权威依据与当前事实

| 来源 | 本稿采用的事实 |
|---|---|
| [T0冻结合同§7.1](../archive/reviews/activity-os-t0-terminal-review.md#71-单一参与事实与-timepolicy)、§11 Release顺序 | TimePolicy/Version、不可变版本/hash/evaluator/生效区间/逐级覆盖；单一参与段；独立分类时长账本，禁止与贡献或v1.1同时切换。 |
| 附件蓝图§12.1–12.10、§13.3、Release 4表 | Activity分类不能直接产生个人时长；首批四类；准备/值守/路程、舍入、证据、调整均需明确规则；D1→D8依次推进。 |
| `prisma/schema.prisma:5737` ParticipantServiceSegmentRevision | 现有事实含checkInAt/checkOutAt、来源事件和批次；serviceHours不是新引擎的中性时间输入。不得双写另一套参与段。 |
| `prisma/schema.prisma:2334` ActivityRuleSnapshot | 已有按activityId/workflowRevision唯一的resolvedConfig/snapshotHash；新政策应进入新版本冻结合同，不改旧快照。 |
| `prisma/schema.prisma:4595,4745` ActivitySession/ActivitySessionPosition | 有活动/场次/岗位锚及现有可覆盖配置；新选择关系必须物理保证同活动/同场次，不能凭散落ID声称同链。 |
| `activity-template-definition-v3.ts` | 当前模板V3在V2上增加metricSelection；新增政策选择建议新V4分支，保留V1–V3定义/hash解释。数据库版本模型实际为ActivityTemplate，不另造同义TemplateVersion表。 |
| `activity-publish-proposal-v2.service.ts:251,1851` 与 `activity-publish-proposal-v7.ts` | 既有V6/V7的timePolicyPointers仍为null；V7用于指标选择，不得回改V7承载时长政策。建议新V8提案，具体语法留精确计划。 |
| `activity-publish-readiness.service.ts:236,579` | TIME_POLICY_UNREPRESENTABLE目前明确报告不可表示；不得仅凭有目录表将其消除。应在D1-3真实选择、解析、冻结链验收后按实际情况判定。 |
| 本轮schema扫描 | 识别151个model，阳性对照ActivityRuleSnapshot存在；未找到TimePolicy/TimeAllocation/TimeBucket/ParticipationTimeLedger模型。此结论不表示所有时长功能不存在。 |
| [#1307](https://github.com/BA7IEE/srvf-nest-api/pull/1307) | C5已合入883d66f9，18项PR检查及可信审批通过，合并树与3fe29414一致。合并后main CI独立记录于C5实施计划；不以PR绿替代main结果。 |

## 3. D1终态与不变量

1. 管理员能通过受控入口建立明确政策与版本、激活/退役并查询保留历史；应用能保存和解释明确选择，不靠“最新版”或旧活动类型猜测。
2. 同一活动可因场次/岗位/实际行为适用不同分类；training不能从活动名称推导，贡献分数也不能反推volunteer_service。
3. 活跃配置变化只影响新的选择；已批准发布的最终政策、hash、evaluatorVersion与解释仍可重建。历史记录和业务数据永久保留，不创建清理任务。
4. 新层不读取旧serviceHours作为实际秒数，不产生Allocation、Bucket、Time Ledger，不改现有结算/贡献/证明结果。
5. D1结束时要有真实管理/选择/发布HTTP测试及历史兼容证据，不以纯JSON解析或闲置schema替代可调用能力。D2消费D1的精确政策锚，不反过来要求D1先复制参与段。

## 4. 方案A的候选数据合同

### 4.1 政策身份与版本

建议 TimePolicy 使用稳定id和不可复用code；名称等展示元数据与版本语义分开。TimePolicyVersion保存policyId、正整数version、schemaVersion、definitionJson、definitionHash、evaluatorVersion、effectiveFrom/effectiveUntil、生命周期及创建/激活/退役审计锚。字段的最终名称、索引、触发器和时间权威登记在精确计划列全。

- `(policyId, version)`唯一；`(id, policyId, definitionHash)`作为引用侧需要时的精确复合锚。状态拟draft→active→retired，不回退、不复活；版本内容从创建起不可原地修改，修订另建版本，草稿也不硬删。
- hash复用已存在canonical/hash工具，但先强类型解析；语义输入须包括schemaVersion、definition、生效区间及evaluatorVersion。展示/审计时间不参与语义hash。禁止自造另一套排序或浮点canonical规则。
- 版本号由受控命令在政策身份锁内分配/验证，不用不受锁保护的max+1；并发同operationKey同payload返回原收据，不同payload拒绝。状态、审计、收据同事务提交。
- 生效区间建议UTC时间、左闭右开；effectiveUntil可空且非空时必须大于effectiveFrom。新选择须覆盖被选层级的计划区间；同政策多个版本可以区间重叠，因为选择固定id/hash，不提供按时间猜“最新active”的隐式解析。
- 退役禁止新的选择；已冻结版本仍按原定义解释，不因当前退役、名称或新版本改变历史。待批准提案引用在批准时已失效则拒绝并重新提案，不偷偷替换版本。
- 所有政策、版本、选择历史和命令收据保留；删除用户/退队不得级联删除。哪些创建者身份需审计引用、读取掩码和保存要求在§7统一列明，不在普通DTO暴露身份。

### 4.2 强类型definition（候选业务语义，须确认）

| 字段组 | 推荐闭合语义 |
|---|---|
| 默认类别 | 必选volunteer_service/training/organization/non_creditable之一；不是按Activity.category自动推导。legacy_unclassified仅供历史治理，不给普通新政策选择器提供。 |
| 岗位映射 | 使用已登记稳定岗位/attendanceRole键而非名称；规则键唯一、有界，精确计划确认最终采用哪种键与解析作用域。跨模板/场次同名不得碰撞或误套；未知映射键在发布解析时拒绝，不忽略。 |
| 是否拆分 | 显式布尔；false时同一参与区间单一分类，true仅允许后续D3在真实参与段内分割，不授权重叠计时或人为延长时间。 |
| 准备、值守、路程 | 三类显式处理项：排除/按指定类别认定/需人工认定。无证据或无法确认区间时不自动认定；“排除”不得删除原始参与事实。不得按计划时长或固定路程补出实际时间。 |
| 舍入 | 建议整数秒为计算基准，显式量子与floor模式，不默认四舍五入/向上进位；按同一参与身份、同一类别聚合后一次舍入。不得让分段累加或舍入导致总秒数超过实际参与时间；量子上限与不足量子处理在精确计划确认。 |
| 证据 | 显式要求来源类别与是否需人工认定；政策定义只描述证据类型，不存人员资料或附件内容。没有来源不得自动放宽。附件归属/存储可用性在实际认定事务验证，D1不新增附件owner类型。 |
| 人工调整 | 显式允许/禁止、理由必填与证据要求；允许不等于持有认定权限，不允许突破实际参与区间/互斥/总量约束。具体人员的自由文本理由归D3隐私合同，不在D1先占敏感字段。 |
| evaluatorVersion | 固定已登记解释器标识，与definition兼容矩阵绑定；未知版本拒绝。D1可提供纯规则解析/解释测试，不对真实成员产出正式秒数。无任意JS、动态SQL、表达式引擎或AI解释。 |

候选输入必须闭合键、长度/数组/整数范围、重复键、空值和非法组合；上表尚不是可直接落库的最终JSON grammar。最终字段、预算和样例必须在D1-1精确计划逐项落定，未落定不得实施。合法非志愿分类也是明确政策，不能用“无需时长”null替代全部分类。

### 4.3 选择、逐级覆盖与冻结

建议按模板→Activity→Session→SessionPosition解析，最近的显式**完整版本引用**覆盖上层，不做字段级JSON拼接。inherit与explicit必须区分；explicit保存policyId/versionId/definitionHash，空引用不能被猜成默认政策。没有最终版本时保持Readiness缺项。

模板侧在新V4定义中表达默认和下层选择；复制时校验完整定义与作用域。活动侧需保留选择revision用于并发控制；ActivitySessionPosition才是有场次锚的岗位目标，不能混用旧ActivityPosition。字段直挂还是独立选择表、是否需要不可变选择修订与专用收据，由D1-3精确计划比较后确定；无论采用哪种，都须数据库同链约束，不接受“service先查过”替代复合锚。

新发布提案建议V8：冻结各层原始选择、最终解析的policy/version/hash/evaluator、生效解释和覆盖来源；审核页changeDiff必须可解释且不透传敏感字段。只为新提案升级；V2–V7在途审核、历史hash和批准行为保持原合同，不能批量升级旧JSON。新RuleSnapshot承载最终政策锚及重建所需语义；不是修改已存在的旧快照。

批准后政策切换必须走既有变更提案/审批，不提供绕审核直写已发布活动的选择命令。V8 Readiness只在指针、生命周期、时间覆盖与同链校验均有效时消除时长政策缺项；贡献政策等其他问题保持。D1不把Readiness变成新的结算/归档硬门。

## 5. 拟定访问面与事务边界

以下是评审建议，不是新增路由或权限的授权：

| 面 | 操作与建议权限 | 主体、范围及限制 |
|---|---|---|
| Admin政策目录 | create policy/version、activate、retire；拟activity-time-policy.manage.version；list/detail拟activity-time-policy.read.catalog | Human、显式GLOBAL权限；不因SUPER_ADMIN角色自动授予，不新增机器或委托入口。分页、有界详情，历史可读。 |
| App managed活动 | 草稿选择/继承与查询；拟activity.time-policy.select/read | 当前User/Member有效、显式组织scope、draft initiator或对应阶段owner；Service层逐请求判权，机器/仅结算/仅成果权限不直通。 |
| 发布与变更审批 | 冻结/重验政策，复用既有审批命令的访问入口 | 新选择能力不替代发布/审批资格；旧审核权限不得被静默扩大。审批人重验当前资格与版本有效性。 |

拟命令均operationKey、expectedRevision/hash、专用不可变收据，重放仍重验主体资格；查询不产审计业务写。create/activate/retire/select等事件及资源字段在精确计划登记，不提前报权限/审计新增数量，不沿用成果事件伪装时长治理。

写入前读→必要锁→锁后重验→事实/审计/收据同事务；锁序必须与活动发布、模板目录、组织资格和用户属主实际调用链一致。目录只锁本政策/版本；跨活动批量、全库扫描及无界for循环不在候选命令中。最终RC/timeout/maxWait、输入上限和事务内查询预算须实测落定，不能先把C5的20/30秒照抄过来。

## 6. 分批实施建议与交付边界

| 批次 | 必须交付 | 不得冒充完成 |
|---|---|---|
| D1-1 数据与定义 | TimePolicy/Version及必要收据基础、完整强类型grammar、hash/evaluator兼容、数据库生命周期/引用约束、冷回放与非空升级、纯测试 | 不宣称有可用管理/选择入口或Readiness已解除。 |
| D1-2 目录控制面 | 明确Human目录API、显式DTO/权限/审计、命令幂等与并发、保留历史查询、实际HTTP与客户端交接 | 不宣称已冻结活动政策或已产生分类时长。 |
| D1-3 选择与发布 | 四级引用/覆盖、同链约束、模板V4和新提案V8、旧版本兼容、Readiness与受控变更接线、真实HTTP/锁等待回归 | 不计算正式参与秒数，不替代D2–D8；不能以少支持一层覆盖换取全绿。 |

每批先出精确路径与探针，再由维护者确认implementation；迁移是否分批、实际编号/文件名及签字次数以当时仓库和精确计划为准。当前117迁移不是“已经批准第118条”。若支持完整D1需要更多模型或跨模块原语，必须在精确计划列全，而非施工中靠通配授权。

后续顺序维持D2中性参与段Facade→D3时间分配revision→D4类别桶/结算工作台→D5shadow对账→D6独立Time Ledger→D7更正冲回→D8证明与正式cutover；Release 5贡献政策与Release 6以后的范围不并入D1。

## 7. 保留、兼容与回退

用途是保存经批准的规则及其历史解释，不采集新个人敏感资料。目录普通DTO仅提供规则与版本信息；创建/激活身份只按既有审计访问控制查看，不给App展示完整User/Member或附件来源。政策、选择历史、收据永久保留；退队撤销当前访问，不删除历史资产。任何新增自由文本/身份字段在精确计划再次回答用途、查看角色与掩码、保存期限三问。

不自动把旧timePolicySelector转换为生效版本，不从旧serviceHours或contributionPoints批量分类；registry中的training/role_based等目前只是治理选择器。历史需专项人工治理，legacy_unclassified不用于对外志愿服务证明。

兼容期现有结算、混合账本、serviceHours投影保持原样；D5以前不产生shadow计算结果，D8以前不正式切换。政策版本退役仅禁止新选，不能作为“撤销既有历史时长”的操作。D1回退停止新入口与新选择，保留事实；不DROP、不清库、不撤回旧已批准快照、不重开被锁业务行为。

## 8. 精确计划必须覆盖的探针

- 仪器：正向找到现有Snapshot/参与段；schema零命中经模型解析复核；清晰区分旧选择器与真实政策版本。
- 定义：四类、所有处理项/证据/人工调整组合；未知键、错类型、重复映射、超限、未知evaluator拒绝；0/floor/边界时间与canonical确定性。
- 数据：不可变语义、状态转换、code不可复用、同链FK、并发版本号、重复操作同/异payload、回滚无半条审计/收据；空库及带现有117迁移业务夹具升级。
- 选择：模板/活动/场次/岗位四层正反例、不同场次同岗位code、引用错活动/错policy/hash；inherit与explicit、不随最新版漂移；生效区间边界和退休版本历史解释。
- 授权：当前用户禁用/退队、组织失效、无码/越组织/非owner、SA无码、机器/委托、仅结算/成果权；真实双连接等待后复验。
- 发布：新V8保存/预览/提交/批准/变更/拒绝，V2–V7历史/在途原断言不变；模板V1–V3兼容；退役/撤权/修订竞争不悄悄改hash；全部最终政策进入新RuleSnapshot。
- 不改正式事实：管理与选择前后，参与段、旧结算、时长/贡献账本及证明读数不变；新层既不能伪造参与，也不能让旧Gate打开。
- 收口：实际有界输入满额、SQL数量与锁预算；定向回归、contract逐行增量、OpenAPI与客户端、权限/审计/状态机/计数/部署清单/签字联动；全量CI与合并后CI分开记录。

数据库测试仅在未来精确授权的隔离库执行；本稿不授权app_test、w98或任何重建/迁移。禁止自动migrate dev/reset/db push，旧E2E断言适配和红区grant须逐项明确。

## 9. 本轮精确文档写集及下一次授权

本轮仅六份：本稿（新增）；C5 implementation plan、NEXT_TASKS、FROZEN_DRAFTS、activities/CLAUDE.md、handoff/miniapp.md（只订正C5与当前D1阶段）。不改冻结archive、current-state、schema、生产代码、测试、客户端或裁判，不补changelog、不提交/推送/开PR。

下一次可一次确认：**确认D1方案A方向；允许补充changelog、提交、推送并创建文档评审PR；不合并、不实施。** 该确认不等于D1-1/2/3实施授权。之后的精确计划必须一次列齐真实写集、红区命令、目标库、迁移/权限/审计/快照/旧测试影响及签字，维护者执行grant后才进入实施；本稿不预写尚未核验的授权命令。

本次未做：所有D1实施、数据库操作、生产、Gate、业务数据删除、整体跨模型复审、提交推送或创建PR。C5合入不等于Release 4/整个T0或生产完成。
