/**
 * Activity OS Release 1 / A1 的旧 activityTypeCode 迁移目录。
 *
 * 本文件冻结的是「旧值将来如何解释」；它不创建 schema、模板、政策版本、
 * ActivitySemanticAssignment 或任何运行时写路径。Family / policy 是 T0-A 合同里的
 * 选择器名称，真正解析到持久化对象由后续 A2/A4 等独立 PR 实现。
 *
 * 人工治理未完成前，任何条目都不得据此自动进入正式统计、时长或贡献。
 */

export const ACTIVITY_CATEGORY_CODES = [
  'emergency_response',
  'duty_readiness',
  'training_exercise',
  'event_support',
  'outreach_communication',
  'public_service',
  'cooperation_exchange',
  'organization_operation',
  'logistics_support',
  'pending_classification',
] as const;

export type ActivityCategoryCode = (typeof ACTIVITY_CATEGORY_CODES)[number];

export const ACTIVITY_SEMANTIC_FACET_DIMENSION_CODES = [
  'environment',
  'action',
  'capability',
  'cooperation',
  'target',
  'format',
] as const;

export type ActivitySemanticFacetDimensionCode =
  (typeof ACTIVITY_SEMANTIC_FACET_DIMENSION_CODES)[number];

export const ACTIVITY_SEMANTIC_FACET_OPTION_CATALOG = [
  { dimensionCode: 'action', optionCode: 'rescue' },
  { dimensionCode: 'action', optionCode: 'relief' },
  { dimensionCode: 'action', optionCode: 'supplies' },
  { dimensionCode: 'action', optionCode: 'transportation' },
  { dimensionCode: 'capability', optionCode: 'aviation' },
  { dimensionCode: 'cooperation', optionCode: 'external' },
  { dimensionCode: 'cooperation', optionCode: 'external_joint' },
  { dimensionCode: 'cooperation', optionCode: 'internal_joint' },
  { dimensionCode: 'target', optionCode: 'disaster_affected_people' },
  { dimensionCode: 'target', optionCode: 'public' },
  { dimensionCode: 'format', optionCode: 'event_support' },
  { dimensionCode: 'format', optionCode: 'team_support' },
  { dimensionCode: 'format', optionCode: 'lecture' },
  { dimensionCode: 'format', optionCode: 'training' },
  { dimensionCode: 'format', optionCode: 'competition' },
  { dimensionCode: 'format', optionCode: 'meeting' },
  { dimensionCode: 'format', optionCode: 'drill' },
  { dimensionCode: 'format', optionCode: 'interview' },
  { dimensionCode: 'format', optionCode: 'team_building' },
] as const satisfies readonly {
  readonly dimensionCode: ActivitySemanticFacetDimensionCode;
  readonly optionCode: string;
}[];

export interface LegacyActivitySemanticFacet {
  readonly dimensionCode: ActivitySemanticFacetDimensionCode;
  readonly optionCode: string;
}

export interface LegacyActivityTypeMigrationEntry {
  readonly legacyActivityTypeCode: string;
  readonly categoryCode: ActivityCategoryCode;
  /** 未来 Template Family 的稳定方向；现在不是 schema 值。 */
  readonly familyDirection: string;
  /** 可机械落到受控 Facet 字典的部分。 */
  readonly facets: readonly LegacyActivitySemanticFacet[];
  /** 未来 Outcome 的选择器；现在不创建 Outcome 字典或持久化对象。 */
  readonly outcomeCode: string | null;
  /** 未来 TimePolicyVersion 的选择器。 */
  readonly timePolicySelector: string;
  /** 未来 ContributionPolicyVersion 的选择器。 */
  readonly contributionPolicySelector: string;
  /** 冻结表中无法假装成 Facet / Outcome 的原始要求，逐字保留。 */
  readonly legacyFacetOrOutcome: string;
  /** 必须人工完成的治理；非空即禁止自动进入正式认定。 */
  readonly manualGovernance: string;
}

export const LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY = [
  {
    legacyActivityTypeCode: 'rescue_mission',
    categoryCode: 'emergency_response',
    familyDirection: 'incident_response',
    facets: [{ dimensionCode: 'action', optionCode: 'rescue' }],
    outcomeCode: null,
    timePolicySelector: 'incident_response',
    contributionPolicySelector: 'incident_response',
    legacyFacetOrOutcome: 'action=rescue；Incident link',
    manualGovernance: '核验关联 Incident 与正式结果。',
  },
  {
    legacyActivityTypeCode: 'disaster_relief',
    categoryCode: 'emergency_response',
    familyDirection: 'disaster_relief',
    facets: [
      { dimensionCode: 'action', optionCode: 'relief' },
      { dimensionCode: 'target', optionCode: 'disaster_affected_people' },
    ],
    outcomeCode: null,
    timePolicySelector: 'incident_response',
    contributionPolicySelector: 'incident_response',
    legacyFacetOrOutcome: 'action=relief；target=受灾群众；Incident link',
    manualGovernance: '核验关联 Incident 与正式结果。',
  },
  {
    legacyActivityTypeCode: 'assistance',
    categoryCode: 'pending_classification',
    familyDirection: 'blank_manual',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'none_until_classified',
    contributionPolicySelector: 'none_until_classified',
    legacyFacetOrOutcome: '补业务目的、对象、是否现场行动',
    manualGovernance: '必填，禁止标题猜测。',
  },
  {
    legacyActivityTypeCode: 'assembled_no_action',
    categoryCode: 'emergency_response',
    familyDirection: 'emergency_assembly',
    facets: [],
    outcomeCode: 'assembled_no_action',
    timePolicySelector: 'manual_recognition',
    contributionPolicySelector: 'manual_recognition',
    legacyFacetOrOutcome: 'outcome=assembled_no_action',
    manualGovernance: '结果不得自动推出时长或贡献。',
  },
  {
    legacyActivityTypeCode: 'event_support',
    categoryCode: 'event_support',
    familyDirection: 'event_support',
    facets: [{ dimensionCode: 'format', optionCode: 'event_support' }],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'event_support',
    legacyFacetOrOutcome: 'format=event_support',
    manualGovernance: '核验岗位与受益对象。',
  },
  {
    legacyActivityTypeCode: 'team_activity_support',
    categoryCode: 'organization_operation',
    familyDirection: 'team_support',
    facets: [{ dimensionCode: 'format', optionCode: 'team_support' }],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'organization_operation',
    legacyFacetOrOutcome: 'format=team_support；必要时 event_support facet',
    manualGovernance: '抽样核验是否实际为对外保障。',
  },
  {
    legacyActivityTypeCode: 'external_lecture',
    categoryCode: 'outreach_communication',
    familyDirection: 'outreach_lecture',
    facets: [
      { dimensionCode: 'format', optionCode: 'lecture' },
      { dimensionCode: 'cooperation', optionCode: 'external' },
    ],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'outreach',
    legacyFacetOrOutcome: 'format=lecture；cooperation=external',
    manualGovernance: '核验讲师、学员、保障身份。',
  },
  {
    legacyActivityTypeCode: 'external_promotion_federation',
    categoryCode: 'outreach_communication',
    familyDirection: 'external_promotion',
    facets: [
      { dimensionCode: 'cooperation', optionCode: 'external' },
      { dimensionCode: 'target', optionCode: 'public' },
    ],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'outreach',
    legacyFacetOrOutcome: 'cooperation=external；target=公众',
    manualGovernance: '核验外部主体与活动目的。',
  },
  {
    legacyActivityTypeCode: 'external_training',
    categoryCode: 'training_exercise',
    familyDirection: 'external_training',
    facets: [
      { dimensionCode: 'format', optionCode: 'training' },
      { dimensionCode: 'cooperation', optionCode: 'external' },
    ],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'training',
    legacyFacetOrOutcome: 'format=training；cooperation=external',
    manualGovernance: '核验学员、讲师、保障身份。',
  },
  {
    legacyActivityTypeCode: 'external_promotion_department',
    categoryCode: 'outreach_communication',
    familyDirection: 'external_promotion',
    facets: [
      { dimensionCode: 'cooperation', optionCode: 'external' },
      { dimensionCode: 'target', optionCode: 'public' },
    ],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'outreach',
    legacyFacetOrOutcome: 'cooperation=external；target=公众',
    manualGovernance: '核验外部主体与活动目的。',
  },
  {
    legacyActivityTypeCode: 'team_training',
    categoryCode: 'training_exercise',
    familyDirection: 'team_training',
    facets: [{ dimensionCode: 'format', optionCode: 'training' }],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'training',
    legacyFacetOrOutcome: 'format=training',
    manualGovernance: '核验学员、讲师、保障身份。',
  },
  {
    legacyActivityTypeCode: 'external_course',
    categoryCode: 'training_exercise',
    familyDirection: 'external_course',
    facets: [
      { dimensionCode: 'format', optionCode: 'training' },
      { dimensionCode: 'cooperation', optionCode: 'external' },
    ],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'training',
    legacyFacetOrOutcome: 'format=training；cooperation=external',
    manualGovernance: '核验课程和实际参与身份。',
  },
  {
    legacyActivityTypeCode: 'no_contribution_training',
    categoryCode: 'training_exercise',
    familyDirection: 'team_training',
    facets: [{ dimensionCode: 'format', optionCode: 'training' }],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'zero',
    legacyFacetOrOutcome: 'format=training',
    manualGovernance: '无贡献是政策结果，不删除培训事实。',
  },
  {
    legacyActivityTypeCode: 'competition_exchange',
    categoryCode: 'cooperation_exchange',
    familyDirection: 'competition_exchange',
    facets: [{ dimensionCode: 'format', optionCode: 'competition' }],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'cooperation_exchange',
    legacyFacetOrOutcome: 'format=competition',
    manualGovernance: '核验参赛、组织、保障身份。',
  },
  {
    legacyActivityTypeCode: 'key_meeting',
    categoryCode: 'organization_operation',
    familyDirection: 'key_meeting',
    facets: [{ dimensionCode: 'format', optionCode: 'meeting' }],
    outcomeCode: null,
    timePolicySelector: 'organization',
    contributionPolicySelector: 'organization_operation',
    legacyFacetOrOutcome: 'format=meeting',
    manualGovernance: '核验是否为正式组织运行。',
  },
  {
    legacyActivityTypeCode: 'external_joint_drill',
    categoryCode: 'training_exercise',
    familyDirection: 'joint_drill',
    facets: [
      { dimensionCode: 'cooperation', optionCode: 'external_joint' },
      { dimensionCode: 'format', optionCode: 'drill' },
    ],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'training',
    legacyFacetOrOutcome: 'cooperation=external_joint；format=drill',
    manualGovernance: '核验联合主体、岗位和科目。',
  },
  {
    legacyActivityTypeCode: 'internal_multi_dept_drill',
    categoryCode: 'training_exercise',
    familyDirection: 'joint_drill',
    facets: [
      { dimensionCode: 'cooperation', optionCode: 'internal_joint' },
      { dimensionCode: 'format', optionCode: 'drill' },
    ],
    outcomeCode: null,
    timePolicySelector: 'training',
    contributionPolicySelector: 'training',
    legacyFacetOrOutcome: 'cooperation=internal_joint；format=drill',
    manualGovernance: '核验联合部门、岗位和科目。',
  },
  {
    legacyActivityTypeCode: 'futian_ustation',
    categoryCode: 'duty_readiness',
    familyDirection: 'station_duty',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'duty',
    contributionPolicySelector: 'duty',
    legacyFacetOrOutcome: 'PlacePreset=福田 U 站',
    manualGovernance: '核验站点、岗位和实际值守段。',
  },
  {
    legacyActivityTypeCode: 'wutongshan_duty',
    categoryCode: 'duty_readiness',
    familyDirection: 'station_duty',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'duty',
    contributionPolicySelector: 'duty',
    legacyFacetOrOutcome: 'PlacePreset=梧桐山',
    manualGovernance: '核验站点、岗位和实际值守段。',
  },
  {
    legacyActivityTypeCode: 'icc_duty',
    categoryCode: 'duty_readiness',
    familyDirection: 'station_duty',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'duty',
    contributionPolicySelector: 'duty',
    legacyFacetOrOutcome: 'PlacePreset=ICC',
    manualGovernance: '核验站点、岗位和实际值守段。',
  },
  {
    legacyActivityTypeCode: 'helicopter_duty',
    categoryCode: 'duty_readiness',
    familyDirection: 'aviation_duty',
    facets: [{ dimensionCode: 'capability', optionCode: 'aviation' }],
    outcomeCode: null,
    timePolicySelector: 'duty',
    contributionPolicySelector: 'duty',
    legacyFacetOrOutcome: 'capability=aviation；固定地点 / 岗位',
    manualGovernance: '专业资格、地点和安全要求必核。',
  },
  {
    legacyActivityTypeCode: 'department_duty',
    categoryCode: 'duty_readiness',
    familyDirection: 'department_duty',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'duty',
    contributionPolicySelector: 'duty',
    legacyFacetOrOutcome: '组织和地点预设',
    manualGovernance: '核验所属组织、地点和岗位。',
  },
  {
    legacyActivityTypeCode: 'daily_supplies',
    categoryCode: 'logistics_support',
    familyDirection: 'supply_logistics',
    facets: [{ dimensionCode: 'action', optionCode: 'supplies' }],
    outcomeCode: null,
    timePolicySelector: 'logistics',
    contributionPolicySelector: 'logistics',
    legacyFacetOrOutcome: 'action=supplies',
    manualGovernance: '核验物资事实归资源域。',
  },
  {
    legacyActivityTypeCode: 'event_support_supplies',
    categoryCode: 'logistics_support',
    familyDirection: 'supply_logistics',
    facets: [{ dimensionCode: 'action', optionCode: 'supplies' }],
    outcomeCode: null,
    timePolicySelector: 'logistics',
    contributionPolicySelector: 'logistics',
    legacyFacetOrOutcome: 'action=supplies；event_support context',
    manualGovernance: '核验保障上下文；不把物资当成果真相。',
  },
  {
    legacyActivityTypeCode: 'rescue_relief_supplies',
    categoryCode: 'logistics_support',
    familyDirection: 'supply_logistics',
    facets: [{ dimensionCode: 'action', optionCode: 'supplies' }],
    outcomeCode: null,
    timePolicySelector: 'logistics',
    contributionPolicySelector: 'logistics',
    legacyFacetOrOutcome: 'action=supplies；emergency_response context',
    manualGovernance: '核验 Incident link 和资源事实。',
  },
  {
    legacyActivityTypeCode: 'interview',
    categoryCode: 'outreach_communication',
    familyDirection: 'outreach_interview',
    facets: [{ dimensionCode: 'format', optionCode: 'interview' }],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'outreach',
    legacyFacetOrOutcome: 'format=interview',
    manualGovernance: '核验采访对象、发布责任和参与身份。',
  },
  {
    legacyActivityTypeCode: 'general_meeting',
    categoryCode: 'organization_operation',
    familyDirection: 'general_meeting',
    facets: [{ dimensionCode: 'format', optionCode: 'meeting' }],
    outcomeCode: null,
    timePolicySelector: 'organization',
    contributionPolicySelector: 'organization_operation',
    legacyFacetOrOutcome: 'format=meeting',
    manualGovernance: '核验是否为正式组织运行。',
  },
  {
    legacyActivityTypeCode: 'psychological_assessment',
    categoryCode: 'pending_classification',
    familyDirection: 'blank_manual',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'none_until_classified',
    contributionPolicySelector: 'none_until_classified',
    legacyFacetOrOutcome: '敏感健康 / 心理数据',
    manualGovernance: '必须先通过用途、可见性、掩码和留存治理。',
  },
  {
    legacyActivityTypeCode: 'department_team_building',
    categoryCode: 'organization_operation',
    familyDirection: 'team_building',
    facets: [{ dimensionCode: 'format', optionCode: 'team_building' }],
    outcomeCode: null,
    timePolicySelector: 'role_based',
    contributionPolicySelector: 'organization_operation',
    legacyFacetOrOutcome: 'format=team_building',
    manualGovernance: '核验组织运行与非计入情形。',
  },
  {
    legacyActivityTypeCode: 'transportation',
    categoryCode: 'pending_classification',
    familyDirection: 'blank_manual',
    facets: [{ dimensionCode: 'action', optionCode: 'transportation' }],
    outcomeCode: null,
    timePolicySelector: 'none_until_classified',
    contributionPolicySelector: 'none_until_classified',
    legacyFacetOrOutcome: 'action=transportation；类别取决于业务目的',
    manualGovernance: '必填，运输不能自行充当 category。',
  },
  {
    legacyActivityTypeCode: 'special_social_service',
    categoryCode: 'public_service',
    familyDirection: 'special_social_service',
    facets: [],
    outcomeCode: null,
    timePolicySelector: 'public_service',
    contributionPolicySelector: 'public_service',
    legacyFacetOrOutcome: 'target 及正式证据',
    manualGovernance: '核验服务对象、证据和特殊限制。',
  },
] as const satisfies readonly LegacyActivityTypeMigrationEntry[];
