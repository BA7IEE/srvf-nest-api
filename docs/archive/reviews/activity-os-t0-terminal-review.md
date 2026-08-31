# Activity OS T0-A：终态边界、数据所有权、Integration 安全与 AI 独立性冻结合同

> 状态：待维护者评审。本文是 Activity OS 的 T0-A 交付物，不是 schema、migration、运行时实现或生产变更授权。
>
> 输入：2026-09-01 下发的《SRVF 活动域终态蓝图与分阶段落地方案》。
> 基线：origin/main 的 3cf3786ee38e75e8eeff23d1d6e1fac764a7d520；本合同只对该基线及其已通过的 required CI 作出冻结结论。
>
> 解锁关系：T0-A 评审通过后，才可另立 T0-B；T0-A 和 T0-B 均通过后，才可另立 Release 1 / A1。任何后续实施仍须遵守 AGENTS、红区、migration、契约、生产 Gate 和维护者审批流程。

## 0. 本次范围与禁止域

本次只把后续实施必须遵守的边界、数据所有权、迁移路径、接口合同和测试设计写入仓内。它不把外部蓝图中的“未来要做”自动变成同一 PR 的写权限。

本次明确未做：

- 不修改 Prisma schema，不新建 migration，不回填或删除数据。
- 不注册 AiModule，不引入 AI SDK、pgvector、PostGIS、Redis、queue、cache 或第三个 cron。
- 不新增权限码、Integration 业务端点、运行时 Feature Gate、Controller、Service 或测试断言。
- 不开启 Activity v1.1、Integration 或任何 Activity OS Gate，不做部署、cutover、migration deploy。
- 不修改既有快照、E2E、契约或历史归档正文。

## 1. 代码基线与现状引用链

以下是冻结时已核验的事实。它们用于识别兼容边界，不构成“可以顺手重构”的授权。

| 事实 | 基线证据 | 对后续的约束 |
|---|---|---|
| 活动主模型已存在 | prisma/schema.prisma 的 Activity、ActivityTemplate、ActivityRuleSnapshot | 新模型只能 additive；不得推倒 Activity v1.1。 |
| 当前模板按 activityTypeCode 查 active 最新版本 | activity-publish-proposal-v2.service.ts 的 findTemplate | 新路径须以显式 selectedTemplateVersionId 为主；旧记录保留 fallback。 |
| 发布快照兼容 v2 至 v5 | activity-publish-proposal-v2.service.ts 与对应 spec | v6 只能给新提案使用，不能改变在途 v2 至 v5 的 hash 或解释。 |
| 正式报名表能力已存在 | RegistrationFormVersion、RegistrationFormField、RegistrationFormAnswer、RegistrationUploadSession | 复用并复制活动自己的表单版本，不建第二套报名表。 |
| 参与事实和结算链已存在 | AttendancePunchEvent、ParticipantServiceSegmentRevision、ParticipationLedgerEntry、MemberContributionDayState | 不建立平行可独立修改的参与段；不把时长与贡献继续混为一个长期真相。 |
| 现有活动类型为 9 个父类下 31 个子类 | prisma/seed.ts 的 activity type seed | Release 1 的 registry 必须覆盖 31/31，不能按标题猜分类。 |
| Integration 现有活动业务面仅一个参考读接口 | integration-activity-types.controller.ts | 该接口保持只读、Service Token only、direct GLOBAL、dict.read.item、禁止 Delegated；未来写面另案。 |
| AI 当前尚未注册模块，但 README 仍含 SDK 和 pgvector 的过时预设 | src/modules/ai/README.md | 这不是 T0-A 的改动项；T0-B 必须单独改正并建立机器边界。 |
| Integration 已有唯一业务 Gate | config-env 与 Integration 运维文档中的 INTEGRATION_API_ENABLED | 不增加第二个 Integration 半开关。 |

### 1.1 当前字段、产生阶段和责任人矩阵

这里的“责任人”指正式业务动作或领域属主，不把技术调用者、AI 或报表读面伪装成事实所有者。

| 当前字段 / 对象组 | 产生阶段 | 正式责任人 / 属主 | 主要消费者 | 冻结的后续规则 |
|---|---|---|---|---|
| Activity 的 title、activityTypeCode、organizationId、开始/结束时间、location、容量、报名与可见配置、状态和 workflowRevision | 草稿创建、修改、发布审核、取消/终止/归档 | Activity 草稿和生命周期动作的真实操作人；activities 域 | 场次、岗位、报名、发布、读面 | 保留旧字段和语义；新 category、模板指针、地点等只能 additive。 |
| ActivityTemplate 的 code、activityTypeCode、version、statusCode 和默认配置 | 模板配置与版本发布 | 模板管理责任人；activities 域 | 草稿实例化、发布解析 | 当前按 type 查最新版仅是旧路径；新路径显式选择 Version。 |
| ActivityPublishReview 的 snapshot、requestVersion、审核人和审核意见；ActivityRuleSnapshot 的 resolvedConfig、snapshotHash | 提交发布审核、审核通过 | 提交人、审核人；发布审核域 | 发布决定、后续结算与追溯 | 现有 v2 至 v5 不改；v6 新增而不回写。 |
| RegistrationFormVersion、Field、Answer、UploadSession | 从活动草稿生成表单、报名提交 | 活动发布人定义蓝图；报名人提供本次特有答案；registrations 域 | 资格、审核、导出 | 正式档案优先，不重复采集；敏感答案不进入 AI。 |
| AttendancePunchEvent | 现场签到、签退、人工补录、离线回传或更正 | 实际操作人；attendances 域 | 参与段、证据、结算 | append-only 的唯一现场事实写入表；不建立第二套可编辑事实。 |
| ParticipantServiceSegmentRevision | 从 PunchEvent 重建或作认定修订 | 自动计算加获授权人工认定；参与/结算域 | 时长计算、结算版本 | 先抽中性 Facade；不和新 ParticipationSegment 长期双写。 |
| AttendanceSettlement、PostingBatch、ParticipationLedgerEntry、MemberContributionDayState | 结算、审核、入账、冲回和更正 | 结算审核人与账本流程；活动结算域 | 队员贡献、证明、报表 | 已 committed 账本 append-only；未来分类时长与贡献解耦。 |
| ContributionRule | 现有类型和出勤角色规则配置 | 贡献规则属主；contribution-rules 域 | 当前贡献结算 | 先映射为候选 Policy Version 并 shadow；不改写既有正式积分。 |
| 组织、成员、证书、保险、任职和权限 | 身份与组织域的独立生命周期 | 对应身份/组织域的授权动作 | Activity 资格、可见性、授权 target | Activity 仅引用，不复制第二份身份、证书、保险或授权真相。 |

## 2. 六层真相与数据所有权矩阵

系统先记录现实，再由制度解释；投影与智能能力永远不是事实或正式账本的反向来源。

| 层 | 拥有的对象 | 可变性 | 允许的下游 | 禁止事项 |
|---|---|---|---|---|
| 定义层 | 分类、Facet、模板 Family/Version、表单蓝图、资格/时长/贡献政策、指标集、地点预设 | 新版本替代旧版本；旧版本不改 | 计划层 | 用新规则重写已发布活动或历史账本。 |
| 计划层 | Activity 草稿、场次、岗位、计划地点、受众、报名和政策选择 | 发布前可编辑 | 事实层、发布快照 | 把模板更新自动传播到已发布活动。 |
| 事实层 | 报名修订、参与身份、候补、打卡、人工补录、实际参与段、原始执行记录 | 追加优先；更正有来源 | 认定层 | 报表、AI、成果反写事实。 |
| 认定层 | 资格、时长分配、贡献计算、成果确认、审核与调整理由 | 不可变版本或 revision 链 | 账本层 | AI 直接作正式认定。 |
| 账本层 | 正式时长、贡献、冲回、更正、可证明记录 | append-only；仅 credit、reversal、correction | 投影与报告 | 原地覆盖已 committed 分录。 |
| 投影与报告层 | 详情页、画像、统计、报表、证明、AI 总结、驾驶舱 | 可重建 | 渠道呈现 | 回写事实、认定或账本。 |

单向关系固定为：定义 → 计划 → 事实 → 认定 → 账本 → 投影与报告。

## 3. Activity、Incident、Resource 的边界

| 域 | 负责 | 不负责 |
|---|---|---|
| Activity 与能力建设 | 招募、场次、岗位、资格、报名、考勤、参与、时长和贡献结算 | 现场事件态势、搜索区域、线索、实际资产库存和调度。 |
| Incident 现场行动 | Incident、任务、行动周期、搜索区域、线索、态势、行动日志和事件结果 | 报名容量、岗位排班和活动参与结算。 |
| Resource 与后勤 | 资产、物资、场地、预约、分配、使用、归还、检查和维护 | 在模板 JSON 中伪造实际车牌、设备序列号或库存扣减。 |

未来关系采用多对多、带有效期和来源的 ActivityIncidentLink，而不是单一 activity.incidentId。模板只声明 ResourceRequirement；实际资产由 ResourceReservation、ResourceAssignment、ResourceUsageRecord 所属的资源域决定。

## 4. 分类、语义属性与 31 个旧类型迁移矩阵

正式一级分类固定为九类：emergency_response、duty_readiness、training_exercise、event_support、outreach_communication、public_service、cooperation_exchange、organization_operation、logistics_support。没有正式“其他”；证据不足时使用 pending_classification，治理完成后才进入正式统计。

Facet 采用受控维度 environment、action、capability、cooperation、target、format。未来 ActivitySemanticAssignment 必须标识 planned 或 actual、template/user/legacy/system/ai_confirmed 来源和 workflowRevision；自由标签仅用于检索，不进入正式统计。

Release 1 / A1 必须建立唯一的 LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY。seed 内每个旧子类型有且只有一条；少、重、重复映射都必须 CI 失败。下表的 Family / Policy 是冻结的选择器名称，不是现有 schema 值、模板或策略版本；实施时每个选择器必须解析到明确的 Family、Facet、Outcome、TimePolicyVersion 和 ContributionPolicyVersion。人工治理列非空时，未完成治理前不得把该项自动带入正式统计、时长或贡献。

| 旧 activityTypeCode | category | Family 方向 | Facet / Outcome | TimePolicy | ContributionPolicy | 待人工治理 |
|---|---|---|---|---|---|---|
| rescue_mission | emergency_response | incident_response | action=rescue；Incident link | incident_response | incident_response | 核验关联 Incident 与正式结果。 |
| disaster_relief | emergency_response | disaster_relief | action=relief；target=受灾群众；Incident link | incident_response | incident_response | 核验关联 Incident 与正式结果。 |
| assistance | pending_classification | blank_manual | 补业务目的、对象、是否现场行动 | none_until_classified | none_until_classified | 必填，禁止标题猜测。 |
| assembled_no_action | emergency_response | emergency_assembly | outcome=assembled_no_action | manual_recognition | manual_recognition | 结果不得自动推出时长或贡献。 |
| event_support | event_support | event_support | format=event_support | role_based | event_support | 核验岗位与受益对象。 |
| team_activity_support | organization_operation | team_support | format=team_support；必要时 event_support facet | role_based | organization_operation | 抽样核验是否实际为对外保障。 |
| external_lecture | outreach_communication | outreach_lecture | format=lecture；cooperation=external | role_based | outreach | 核验讲师、学员、保障身份。 |
| external_promotion_federation | outreach_communication | external_promotion | cooperation=external；target=公众 | role_based | outreach | 核验外部主体与活动目的。 |
| external_training | training_exercise | external_training | format=training；cooperation=external | training | training | 核验学员、讲师、保障身份。 |
| external_promotion_department | outreach_communication | external_promotion | cooperation=external；target=公众 | role_based | outreach | 核验外部主体与活动目的。 |
| team_training | training_exercise | team_training | format=training | training | training | 核验学员、讲师、保障身份。 |
| external_course | training_exercise | external_course | format=training；cooperation=external | training | training | 核验课程和实际参与身份。 |
| no_contribution_training | training_exercise | team_training | format=training | training | zero | 无贡献是政策结果，不删除培训事实。 |
| competition_exchange | cooperation_exchange | competition_exchange | format=competition | role_based | cooperation_exchange | 核验参赛、组织、保障身份。 |
| key_meeting | organization_operation | key_meeting | format=meeting | organization | organization_operation | 核验是否为正式组织运行。 |
| external_joint_drill | training_exercise | joint_drill | cooperation=external_joint；format=drill | training | training | 核验联合主体、岗位和科目。 |
| internal_multi_dept_drill | training_exercise | joint_drill | cooperation=internal_joint；format=drill | training | training | 核验联合部门、岗位和科目。 |
| futian_ustation | duty_readiness | station_duty | PlacePreset=福田 U 站 | duty | duty | 核验站点、岗位和实际值守段。 |
| wutongshan_duty | duty_readiness | station_duty | PlacePreset=梧桐山 | duty | duty | 核验站点、岗位和实际值守段。 |
| icc_duty | duty_readiness | station_duty | PlacePreset=ICC | duty | duty | 核验站点、岗位和实际值守段。 |
| helicopter_duty | duty_readiness | aviation_duty | capability=aviation；固定地点 / 岗位 | duty | duty | 专业资格、地点和安全要求必核。 |
| department_duty | duty_readiness | department_duty | 组织和地点预设 | duty | duty | 核验所属组织、地点和岗位。 |
| daily_supplies | logistics_support | supply_logistics | action=supplies | logistics | logistics | 核验物资事实归资源域。 |
| event_support_supplies | logistics_support | supply_logistics | action=supplies；event_support context | logistics | logistics | 核验保障上下文；不把物资当成果真相。 |
| rescue_relief_supplies | logistics_support | supply_logistics | action=supplies；emergency_response context | logistics | logistics | 核验 Incident link 和资源事实。 |
| interview | outreach_communication | outreach_interview | format=interview | role_based | outreach | 核验采访对象、发布责任和参与身份。 |
| general_meeting | organization_operation | general_meeting | format=meeting | organization | organization_operation | 核验是否为正式组织运行。 |
| psychological_assessment | pending_classification | blank_manual | 敏感健康 / 心理数据 | none_until_classified | none_until_classified | 必须先通过用途、可见性、掩码和留存治理。 |
| department_team_building | organization_operation | team_building | format=team_building | role_based | organization_operation | 核验组织运行与非计入情形。 |
| transportation | pending_classification | blank_manual | action=transportation；类别取决于业务目的 | none_until_classified | none_until_classified | 必填，运输不能自行充当 category。 |
| special_social_service | public_service | special_social_service | target 及正式证据 | public_service | public_service | 核验服务对象、证据和特殊限制。 |

历史 Activity 的 activityTypeCode 不删除、不篡改；兼容期只读。新 Activity 的主路径是 categoryCode、selectedTemplateVersionId 和 semanticAssignments。

## 5. Template Family、Version、Series 与兼容合同

未来数据形状的语义固定如下，具体 schema 另由 Release 1 的 additive PR 设计：

| 概念 | 责任 | 不可做 |
|---|---|---|
| ActivityTemplateFamily | 稳定身份、分类、所有者/范围、生命周期 | 用 version 行承载“这个模板是什么”的长期身份。 |
| ActivityTemplateVersion | 不可变定义、schemaVersion、definitionHash、生效区间 | 修改激活版本的定义。 |
| Activity | 某一期具体活动和其显式 selectedTemplateVersionId | 依赖 activityTypeCode 自动取最新版本作为新主路径。 |
| ActivitySeries / Revision | 周期、时区、模板版本、有效期、默认组织/负责人/资源要求、生成窗口 | 修改已发布实例；为此新增第三个 cron。 |

草稿采用 copy-on-create：模板蓝图复制成 Activity 自己的可编辑对象。发布采用 snapshot-on-publish：解析模板、活动、场次和岗位覆盖后的最终值进入审核快照。模板、系列和地点预设之后的变化都不能改变已发布 Activity。

周期活动首批只能人工生成未来 N 期、打开系列按需补齐，或由已受控的外部调度以幂等命令生成；不新增 cron。

## 6. Place、报名表、Readiness 与 Snapshot v6

### 6.1 Place 与坐标

一期只做点位。ActivityPlace 的语义包含活动/场次、角色、名称、文字地址、说明、经纬度、坐标系、提供方、可见性、签到资格、半径、预设来源和 workflowRevision。

角色固定为 primary、meeting、execution、evacuation、parking、other。用户通过搜索或地图选点得到坐标和标准地址，不手填经纬度；旧字段仍按 WGS84 语义投影。可见性至少区分 public、accepted、staff、command。地图不可用时草稿可保存文字地点，非定位活动可发布，定位签到活动须在发布前补坐标。搜索区域、路线、危险区属于未来 Incident 地理对象，不进入 ActivityPlace，也不提前引入 geometryJson 或 PostGIS。

### 6.2 自定义报名表敏感数据治理

复用现有 RegistrationFormVersion、RegistrationFormField、RegistrationFormAnswer、RegistrationUploadSession。模板仅保存蓝图；创建 Activity 时生成其独立 draft 版本，发布时激活并冻结。

部门、年龄、证书、保险、既有训练等优先读正式档案和资格规则，不重复采集。活动特有问题须额外定义 purposeCode、dataClassCode、retentionPolicyCode、maskingPolicyCode、prefillSourceCode。新增敏感字段前必须回答业务用途、查看角色与掩码、保存期限与退队清理；默认不导出、最小可见、不进普通 Audit、不进 AI 上下文，不复制高敏感档案。

不做任意 JavaScript、表达式、发布人自定义 SQL、AI 自动新增敏感问题或无限条件跳转。新题型必须同时定义校验、存储、展示、掩码、导出、版本兼容和留存。

### 6.3 Publish Readiness

未来 ActivityPublishReadinessService 返回 code、severity、fieldPath、message、resolutionHint，且为确定性判决；AI 只能解释，不能替代。

| 检查域 | 最小 blocker |
|---|---|
| 基本信息 | 标题、组织或负责人缺失。 |
| 分类与模板 | 无正式 category；模板版本失效或无法解析。 |
| 时间、地点、岗位 | 时间不合法；定位活动缺坐标；岗位容量超过场次容量。 |
| 报名与资格 | 截止时间不合法；受众/资格规则矛盾或引用失效。 |
| 表单与考勤 | 必填字段非法；定位签到规则或半径不完整。 |
| 政策与成果 | 无有效时长/贡献政策；高风险模板缺安全说明；必需指标集缺失。 |

### 6.4 Snapshot v6 canonical 合同

v6 只为新提案新增 categoryCode、plannedSemanticAssignments、selectedTemplateVersionId、activityPlaces、timePolicyPointers、contributionPolicyPointers、metricSetPointer、contentVisibilitySummary 等解析后的必要指针和配置。不得复制高敏感表单答案。

v2 至 v5 必须继续可解析和审批，在途审核 hash 不变化。v6 之后的结构修改只能新增 v7，禁止回改 v6。

## 7. 参与时长、贡献政策、成果与指标

### 7.1 单一参与事实与 TimePolicy

实际时间由 Member × Activity × Session × Position × 实际参与区间产生。当前 AttendancePunchEvent → ParticipantServiceSegmentRevision 是唯一参与段事实；先建立中性 Participation Segment Facade，再让新政策消费它，禁止长久在线双写第二套 ParticipationSegment。

首批时长类别：volunteer_service、training、organization、non_creditable；历史治理用 legacy_unclassified，不能直接开具对外志愿服务证明。TimePolicy / TimePolicyVersion 采用稳定身份、不可变版本、definitionHash、evaluatorVersion、生效区间和逐级覆盖。最终版本在 RuleSnapshot 冻结。

ParticipantTimeAllocationRevision 的分配必须位于参与段内，互斥类别不重叠，总量不超过实际参与时间；修改只新增 revision，自动值与认定值不同时写明理由。AI 只能提出候选。

分类正式时长落入独立 ParticipationTimeLedgerEntry，遵守 append-only、幂等、冲回、更正、committed batch 只读。兼容期旧 serviceHours 仅作为 volunteer_service 投影，不能成为新时长真相。

### 7.2 ContributionPolicy

贡献与时长完全正交：contributionPoints 大于零不能推出志愿服务时长大于零，反向亦然。ContributionPolicy / Version 也使用稳定身份、不可变版本、强类型 definition、独立 evaluator 和版本化解释输出。

旧 ContributionRule 先转为候选 Policy Version，进行 shadow 并算和差异治理；只切计算器，不改既有正式分数账本协议。已入账结果只能走 Correction。不得引入万能表达式、任意 JavaScript、动态 SQL、任意代码表达式或 AI 运行时解释规则。

### 7.3 Outcome / Metric

成果与时长结算正交。未来 ActivityMetricDefinition、ActivityMetricSetVersion、ActivityOutcomeRevision、ActivityMetricValueRevision 负责正式成果；每个正式值须有 sourceCode、sourceReference、证据附件、计算规则版本、确认人和确认时间。

可用来源为 system、manual、import、ai_suggested_confirmed。AI 建议只有经人工确认才成为 Outcome Revision，且成果不能伪造参与事实。

## 8. Application Facade、Integration 与授权合同

不为形式引入 CQRS 框架或通用 Command Bus。先稳定以下 application façade：

| 写命令 | 查询 |
|---|---|
| CreateActivityFromTemplate、CreateActivitySeries、GenerateSeriesInstances、UpdateActivityDraft、SubmitActivityPublishReview、ApplyActivityChange、RecordActivityOutcome、RecognizeParticipationTime、PostTimeLedger、ApplyAttendanceCorrection | ListAvailableActivityTemplates、GetActivityReadiness、GetManagedActivityDetail、GetParticipationTimeSummary、GetActivityOutcome、GetActivityStatistics |

每条写命令必须明确权限、事务边界、幂等、业务校验、审计和安全 DTO。Admin、App、Integration、AI 都只能调用 façade，不能深引私有 Service 或暴露 Prisma row。

### 8.1 Integration 端点授权矩阵模板

未来新增的每一个 Integration 端点必须在实现前填齐以下矩阵，作为设计评审和测试输入：

| endpoint | principal admission | permission | SP allowed | delegated allowed | allowed scope | target resolver | idempotency operation | audit event | sensitive fields |
|---|---|---|---|---|---|---|---|---|---|
| 待新增端点 | Service / Delegated / 禁止 | 显式权限码 | true/false | true/false | GLOBAL / org 等 | 服务端实现和证据 | 已注册 operation 或只读 | 统一 Audit 事件 | DTO 掩码和禁止项 |

现有 GET /api/integration/v1/reference/activity-types 是唯一已存在的活动相关业务面：Service Token only、direct GLOBAL RoleBinding、dict.read.item、只读、Delegated 禁止。它不构成未来 Activity 写端点的先例或授权。

### 8.2 Direct Service、Delegated 与可信 scope target

| 场景 | 路径 | 冻结结论 |
|---|---|---|
| 公共参考目录、模板元数据、非人化探针 | Service Token | 仍要求 direct RoleBinding 和 scope。 |
| 代表负责人创建或修改草稿 | Delegated Token | 必须同时通过真人 Authz、Grant、SP Binding 与三者 scope 交集。 |
| 正式发布、时长认定、贡献调整、账本更正 | Human 流程 | 首批 Integration 不开放。 |
| 系列生成等后台动作 | 原则 Delegated | 真正 SYSTEM 动作另立设计，Service Token 不冒充真人。 |

创建资源时不得相信调用方填写的授权 target。服务端先验证 organizationId 的存在、active 状态和可发起资格，再构造可信 target，完成 User / Grant / SP 三腿检查后才进入事务。

### 8.3 SP、Credential、Grant 的治理和下线顺序

每个 Agent 使用专用非 system-managed 自定义角色、最小权限、明确 scope、独立负责人和撤销预案。SP 只能使用显式 direct RoleBinding，SELF scope 禁止，角色的每项权限都要允许 Service Principal。

下线顺序固定为：停止调用 → 撤销 Credential → 撤销 Grant → 撤销或软删 RoleBinding → 确认零引用 → 再考虑退役自定义 Role。不得先删角色并期待隐式撤权。

Credential 只在创建响应中出现一次，存入受控 Secret Manager；浏览器、App、小程序不得持有。Integration JWT Secret 与 Human JWT Secret、AI Provider Key 必须分离。Token 不携带权限码、角色或 scope 真相，授权撤销后下一请求立即失效。

所有 Integration 写命令必须具备 Idempotency-Key、已注册 operation、覆盖业务输入的 request hash、同事务 receipt 和最小响应快照；同 key 同 hash 重放首次结果、同 key 异 hash 拒绝。审计必须复用规范化 request-id 和可信代理链 IP，不记录 Token、Secret、hash、完整 Prompt、完整模型响应或 Idempotency-Key。

## 9. AI 零依赖、手工路径与外部依赖降级

AI 是交互渠道，不是 Activity、Settlement、Ledger 或 Incident 的组成部分。核心业务不 import、调用或等待 AI Provider，也不把 AI 调用放入创建、发布、报名、打卡、结算、认定、账本或更正事务。

| AI 辅助能力 | 无 AI 时的正式等价路径 |
|---|---|
| 模板推荐 | 手工搜索和选择模板。 |
| 草稿或文案生成 | 模板或空白表单，加人工编辑。 |
| 岗位建议 | 手工配置岗位。 |
| 缺项解释 | 确定性 ReadinessService。 |
| 成果提取候选 | 负责人手工填写。 |
| 自然语言统计 | 固定报表和标准筛选器。 |
| 自动提醒 | 待办和通知系统。 |

产品内人机协作只给建议，由真人确认后通过 Human API 调用 façade；外部 Agent 只走 Client Credential、固定 Grant、Delegated Token 和 Integration API，不调用 Human-only 路由，不伪造 request.user，也不在请求体声明被代表人。

AiSuggestion 如未来需要，是可选域；核心 Activity、Outcome、Settlement、Ledger 不得对它建立 NOT NULL 外键。AI 只读取有权 Query DTO、脱敏结构化上下文、白名单统计和允许的模板/规则投影；禁止自由 SQL、Prisma Client、整表导出、原始敏感资料、Token、Secret、Signed URL 和默认发送敏感报名答案。

核心 health 不检查 AI Provider。AI 的超时、429、500、非法输出、无网络、Provider 删除、预算耗尽或自身 Gate 关闭，只影响辅助操作；不得产生半成品、长事务或正式账本写入。

| 外部依赖故障 | 最低可用降级 |
|---|---|
| AI | 全程手工流程。 |
| 地图 | 保存文字地点；定位活动补坐标后发布。 |
| COS / Storage | 草稿继续保存；附件恢复后补传。 |
| SMS | 站内信和人工联系继续。 |
| 微信 / 企业微信 | App、Web 和站内信继续。 |
| OCR | 人工录入和审核。 |
| 推送通道 | Outbox 重试，不回滚已发布活动。 |

目标测试入口为 pnpm test:business:no-ai：无 AI Key、阻断外网、未注册 AiModule 或使用 Noop Adapter、AI Assist 完全不可用时，模板、创建、发布、报名、表单、资格、候补、考勤、离线补录、时长、贡献、成果、更正、报表仍须跑通。此处只冻结测试设计，不在 T0-A 新增命令或测试。

## 10. Gate、迁移、兼容窗口与 cutover 顺序

### 10.1 Gate

现有 ACTIVITY_V11_WORKFLOW_ENABLED 与 INTEGRATION_API_ENABLED 是独立生产变更，不能互相顺带开启。Activity OS 后续如需要控制面、时长或贡献模式，只能按 off / shadow / active 的单一语义设计，默认关闭；shadow 不写正式账本。

Integration 永远只使用 INTEGRATION_API_ENABLED 作为业务 Gate。新端点的渐进开放依靠端点部署、servicePrincipalAllowed、delegatedAccessAllowed、专用 RoleBinding、Grant allowlist、scope、非生产探针和生产配置审批，而不是新增半开关。

同一维护窗口不得同时切 Activity v1.1、分类时长和贡献三套正式真相。已产生正式新账本后，关闭 Gate 不是数据回滚；Gate 关闭也不能改变历史含义。

### 10.2 旧 / 新 API 和数据兼容窗口

| 旧能力 | 兼容规则 | 退出条件 |
|---|---|---|
| activityTypeCode | 历史记录保持，未有显式模板指针时只读 fallback | 无 legacy 新写、对账和契约迁移均完成后另案。 |
| 当前 ActivityTemplate 行 | 映射为未来 Family 的 Version 行 | 新创建显式选择版本，迁移验证通过后再讨论 contract。 |
| v2 至 v5 Snapshot | 原样解析、审批和 hash 兼容 | 永不因 v6 回改。 |
| serviceHours / 混合 ParticipationLedgerEntry | 作为旧时长兼容读和贡献账本 | 新时长账稳定、分段证明聚合通过后另立远期 contract。 |
| ContributionRule | 转候选 Policy Version 并 shadow | 差异归零或有批准清单，旧规则才只读化。 |

### 10.3 非空库 migration rehearsal 与 shadow 对账

后续每条 schema PR 的固定顺序为 expand → shadow → compare → cutover → contract。禁止一次性改写历史、长期双读双写、按标题文本猜分类、AI 批量迁移，以及一个窗口内切两套正式真相。

| 业务轴 | rehearsal / shadow 目标 | 放行前证据 |
|---|---|---|
| Category / Facet | 31/31 registry 覆盖，旧值只读投影 | dry-run、抽样人工核验、漏重映射 CI。 |
| Template | Family/Version 映射，legacy fallback 可读 | 非空库 rehearsal、创建/发布契约、回滚演练。 |
| Time | 中性 Facade、Policy 计算和分类 bucket | 与旧服务时长对账、差异清单、明确切换日期。 |
| Contribution | 旧规则与 Policy Version 并算 | 差异归零或维护者批准清单；不改既有已入账分数。 |
| Place / Form / Outcome | 新对象只 additive，旧投影继续可用 | PII 访问、掩码、快照、历史活动和故障降级测试。 |

## 11. Release 1 至 7 的最终 PR 边界

每个 PR 只处理一条业务轴，逐档立项并遵守 characterization、contract、E2E、migration rehearsal 和 handoff。Release 6 的 Incident 与资源按真实优先级另立项目；Release 7 可以永久不开，Release 1 至 6 必须无 AI 完整运行。

| Release | 允许的边界 |
|---|---|
| 1：目录和模板 | A1 分类/Facet/legacy registry；A2 Family/Version expand；A3 canonicalizer/hash/lifecycle；A4 显式 templateVersion；A5 fallback/只读投影；A6 from-template 事务；A7 Series 生成；A8 contract/handoff/E2E/gate。 |
| 2：创建与发布控制 | B1 Place；B2 坐标系和旧投影；B3 Form blueprint/治理；B4 Readiness；B5 Snapshot v6；B6 三种创建 API；B7 前端交接和控制面灰度。 |
| 3：成果与报告 | C1 指标定义/集版本；C2 Outcome/Value revision；C3 自动指标与人工确认；C4 结束工作台；C5 报表 DTO。 |
| 4：分类时长 | D1 TimePolicy；D2 中性 Segment Facade；D3 Allocation revision；D4 Bucket/工作台；D5 shadow；D6 Time Ledger；D7 correction/reversal；D8 证明与正式 cutover。 |
| 5：贡献政策 | E1 Policy/Version；E2 旧规则转换；E3 shadow；E4 结算接线；E5 正式切换和旧规则只读。 |
| 6：Incident 与资源 | Incident operations 与资源调度分别按业务优先级立项，不并入活动控制面大 PR。 |
| 7：AI Assist | 先边界、脱敏和 No-AI 验收，后模板推荐、草稿、文案、成果候选、统计、Integration 读面，最后才讨论 Delegated 草稿命令。 |

## 12. 测试与验收设计

后续实施必须补的验证面如下；T0-A 不修改既有测试。

| 面 | 必测内容 |
|---|---|
| 历史兼容 | 无 templateVersionId 的旧 Activity、31 类型、v2 至 v5 快照、旧表单、旧 serviceHours、旧 ContributionRule、已 committed ledger、归档/取消/终止活动、发布后改期和单场取消。 |
| 数据不变量 | 同一实际时间不重复认定；认定不超过参与时间；正式分录不可原地改；模板/Series/PlacePreset 更新不改历史；AI 删除不影响业务；贡献不反推时长；成果不伪造参与事实。 |
| Integration | 授权矩阵每一列、三腿授权、可信 target、幂等、Credential/Grant/Binding 撤销后下一请求拒绝、审计脱敏。 |
| 无 AI / 外部故障 | No-AI 金路径；AI、地图、Storage、SMS、微信/企微、OCR、推送分别故障且不扩大故障面。 |
| 规模 | 延续 30、500、2000 档；10000 档仅在真实业务需求和瓶颈证据出现后另行解锁。 |

## 13. T0-A 交付核对表

| # | T0-A 必交付物 | 本合同位置 | 状态 |
|---|---|---|---|
| 1 | 基线代码引用链 | §1 | 已冻结。 |
| 2 | 字段、产生阶段和责任人矩阵 | §1、§2 | 已冻结。 |
| 3 | 六层真相数据所有权 | §2 | 已冻结。 |
| 4 | Activity / Incident / Resource 边界 | §3 | 已冻结。 |
| 5 | 31 类型迁移矩阵 | §4 | 已冻结。 |
| 6 | Family / Version / Series | §5 | 已冻结。 |
| 7 | Category / Semantic Facet | §4 | 已冻结。 |
| 8 | Place 和坐标 | §6.1 | 已冻结。 |
| 9 | 报名表敏感数据治理 | §6.2 | 已冻结。 |
| 10 | Publish Readiness | §6.3 | 已冻结。 |
| 11 | Snapshot v6 canonical | §6.4 | 已冻结。 |
| 12 | TimePolicy / ContributionPolicy | §7 | 已冻结。 |
| 13 | Outcome / Metric | §7.3 | 已冻结。 |
| 14 | Application Facade | §8 | 已冻结。 |
| 15 | Integration 授权矩阵模板 | §8.1 | 已冻结。 |
| 16 | Direct / Delegated 边界 | §8.2 | 已冻结。 |
| 17 | 创建可信 scope target | §8.2 | 已冻结。 |
| 18 | SP / Credential / Grant 下线 | §8.3 | 已冻结。 |
| 19 | AI 零依赖和手工路径 | §9 | 已冻结。 |
| 20 | 外部依赖降级 | §9 | 已冻结。 |
| 21 | Gate 和 cutover | §10.1 | 已冻结。 |
| 22 | Release 1 至 7 PR 边界 | §11 | 已冻结。 |
| 23 | 旧 / 新 API 兼容窗口 | §10.2 | 已冻结。 |
| 24 | 非空库 rehearsal / shadow | §10.3 | 已冻结。 |

## 14. 唯一下一步

维护者评审本合同。评审通过后，单独执行 T0-B：修正 AI README 和相关主动文档、建立 AI 零依赖与 Integration 审查机器边界、设计 No-AI 测试入口、刷新派生文档并完成所需检查。T0-B 前不得启动 Release 1 / A1。
