import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import { isActivityInitiatorResolvable } from '../members/member-publish-readiness.primitive';
import { isActivityOrganizationResolvable } from '../organizations/organization-publish-readiness.primitive';
import { matchesActivityTemplateDefinitionHash } from './activity-template-definition';
import { parseActivityTemplateDefinitionV1 } from './activity-template-definition-v1';
import { parseActivityTemplateDefinitionV2 } from './activity-template-definition-v2';
import { parseActivityTemplateDefinitionV3 } from './activity-template-definition-v3';
import { parseActivityTemplateDefinitionV4 } from './activity-template-definition-v4';
import {
  assertMetricSelectionReference,
  readActivityMetricSelection,
} from './activity-metric-selection';
import type { MetricSetRow } from './activity-metric-presenter';
import { projectPlaceCoordinate } from './activity-place-coordinate-projection';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  parseActivityTimePolicySelectionDocument,
  resolveActivityTimePolicySelection,
  type ActivityTimePolicySelectionScope,
} from './activity-time-policy-selection';
import { LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY } from './activity-type-migration.registry';
import { QualificationRuleSetVersionService } from './qualification-rule-set-version.service';
import { RegistrationFormVersionService } from './registration-form-version.service';

type PrismaTx = Prisma.TransactionClient;

export const ACTIVITY_READINESS_DOMAINS = [
  'basic',
  'categoryTemplate',
  'timeCapacity',
  'locationAttendance',
  'registration',
  'form',
  'qualification',
  'visibilityAudienceInsurance',
  'terminalPolicyOutcomeSafety',
] as const;

export type ActivityReadinessDomain = (typeof ACTIVITY_READINESS_DOMAINS)[number];
export type ActivityReadinessSeverity = 'blocker' | 'warning' | 'suggestion';
export type ActivityReadinessStatus = 'clear' | 'attention' | 'blocked' | 'unrepresentable';
export type ActivityReadinessMetricSelectionStatus =
  | 'unconfigured'
  | 'not_required'
  | 'required_active'
  | 'required_historical'
  | 'invalid';
export type ActivityReadinessTimePolicySelectionIssue =
  | 'unconfigured'
  | 'target_invalid'
  | 'reference_unavailable'
  | 'coverage_incomplete';

interface TimePolicyReadinessRevision {
  readonly id: string;
  readonly activityId: string;
  readonly revision: number;
  readonly selectionHash: string;
  readonly selectionJson: Prisma.JsonValue;
  readonly itemCount: number;
}

interface TimePolicyReadinessPosition {
  readonly id: string;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly attendanceRoleCode: string;
}

interface TimePolicyReadinessSession {
  readonly id: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly positions: readonly TimePolicyReadinessPosition[];
}

export interface ActivityPublishReadinessIssue {
  readonly code: string;
  readonly severity: ActivityReadinessSeverity;
  readonly fieldPath: string;
  readonly message: string;
  readonly resolutionHint: string;
}

export interface ActivityPublishReadinessDomainSummary {
  readonly domain: ActivityReadinessDomain;
  readonly status: ActivityReadinessStatus;
  readonly issueCodes: readonly string[];
}

export interface ActivityPublishReadinessResult {
  readonly blockers: readonly ActivityPublishReadinessIssue[];
  readonly warnings: readonly ActivityPublishReadinessIssue[];
  readonly suggestions: readonly ActivityPublishReadinessIssue[];
  readonly resolvedSummary: readonly ActivityPublishReadinessDomainSummary[];
}

/**
 * Facts deliberately contain no Prisma records, raw Form / Qualification content, member profile,
 * place text, insurance proof, or template name.  It is the whole input to the deterministic
 * evaluator and can therefore be tested without a database or wall clock.
 */
export interface ActivityPublishReadinessFacts {
  readonly activity: {
    readonly title: string;
    readonly activityTypeCode: string;
    readonly startAt: Date;
    readonly endAt: Date;
    readonly registrationDeadline: Date | null;
    readonly registrationModeCode: string | null;
    readonly visibilityCode: string | null;
    readonly requiresInsurance: boolean;
    readonly statusCode: string;
    readonly organizationResolvable: boolean;
    readonly initiatorResolvable: boolean;
  };
  readonly template: {
    readonly familyId: string | null;
    readonly schemaVersion: number | null;
    readonly definitionJson: unknown;
    readonly definitionHash: string | null;
    readonly defaultRegistrationModeCode: string | null;
  } | null;
  readonly sessions: readonly {
    readonly id: string;
    readonly statusCode: string;
    readonly startAt: Date;
    readonly endAt: Date;
    readonly capacity: number | null;
    readonly longitude: string | null;
    readonly latitude: string | null;
    readonly locationRequired: boolean;
    readonly radiusMeters: number | null;
    readonly positions: readonly {
      readonly id: string;
      readonly capacity: number | null;
      readonly startAt: Date | null;
      readonly endAt: Date | null;
      readonly attendanceRoleCode: string;
      readonly locationRequired: boolean | null;
      readonly radiusMeters: number | null;
    }[];
  }[];
  readonly registrationFormValid: boolean;
  readonly qualificationRuleSet: {
    readonly valid: boolean;
    /**
     * Only set when the existing canonical resolver rejected persisted rules.  It is a persisted
     * RuleSet id, not an exception-derived value.
     */
    readonly invalidRuleSetId: string | null;
  };
  /** Bounded semantic result of the exact current selection + catalogue closure, never raw data. */
  readonly metricSelection: ActivityReadinessMetricSelectionStatus;
  /** Empty only when every live target has a current, valid and interval-covering policy pointer. */
  readonly timePolicySelectionIssues: readonly ActivityReadinessTimePolicySelectionIssue[];
  readonly insuranceEnforcementEnabled: boolean;
}

interface IssueDefinition {
  readonly domain: ActivityReadinessDomain;
  readonly severity: ActivityReadinessSeverity;
  readonly message: string;
  readonly resolutionHint: string;
}

const ISSUE_DEFINITIONS = {
  BASIC_TITLE_MISSING: {
    domain: 'basic',
    severity: 'blocker',
    message: '活动标题不能为空。',
    resolutionHint: '补充非空标题。',
  },
  BASIC_ORGANIZATION_UNRESOLVED: {
    domain: 'basic',
    severity: 'blocker',
    message: '发起组织不存在、不可用或无法解析。',
    resolutionHint: '选择一个当前可用的发起组织。',
  },
  BASIC_RESPONSIBLE_INITIATOR_MISSING: {
    domain: 'basic',
    severity: 'blocker',
    message: '活动缺少可解析的负责人。',
    resolutionHint: '指定当前有效的发起负责人。',
  },
  CATEGORY_NOT_FORMAL: {
    domain: 'categoryTemplate',
    severity: 'blocker',
    message: '当前活动类型不能映射到正式业务分类。',
    resolutionHint: '完成分类治理，不得按标题猜测分类。',
  },
  CATEGORY_MANUAL_GOVERNANCE_PENDING: {
    domain: 'categoryTemplate',
    severity: 'warning',
    message: '该分类仍带有需要人工完成的治理事项。',
    resolutionHint: '按分类目录记录的事项完成核验并留存后续治理证据。',
  },
  TEMPLATE_VERSION_UNRESOLVED: {
    domain: 'categoryTemplate',
    severity: 'blocker',
    message: '当前模板解析器无法确定此活动的模板版本。',
    resolutionHint: '修复显式指针或既有 legacy fallback 所需事实。',
  },
  TEMPLATE_DEFINITION_INVALID: {
    domain: 'categoryTemplate',
    severity: 'blocker',
    message: '已解析模板版本无法通过当前定义与 hash 校验。',
    resolutionHint: '修复模板定义或选择一份可解析的版本。',
  },
  SESSION_REQUIRED: {
    domain: 'timeCapacity',
    severity: 'blocker',
    message: '活动没有可发布的有效场次。',
    resolutionHint: '至少保留一个有效场次。',
  },
  SESSION_TIME_INVALID: {
    domain: 'timeCapacity',
    severity: 'blocker',
    message: '场次时间窗口不合法或不落在活动时间内。',
    resolutionHint: '修正场次开始和结束时间。',
  },
  REGISTRATION_DEADLINE_INVALID: {
    domain: 'timeCapacity',
    severity: 'blocker',
    message: '报名截止时间不符合当前发布时序。',
    resolutionHint: '将截止时间调整到活动开始前的有效窗口。',
  },
  POSITION_CAPACITY_EXCEEDS_SESSION: {
    domain: 'timeCapacity',
    severity: 'blocker',
    message: '岗位容量超过所属场次容量。',
    resolutionHint: '降低岗位容量或提高场次容量，并复核总容量。',
  },
  LOCATION_COORDINATE_REQUIRED: {
    domain: 'locationAttendance',
    severity: 'blocker',
    message: '定位活动缺少当前签到真相所需的成对坐标。',
    resolutionHint: '为该场次补齐合法坐标，或取消定位要求。',
  },
  CHECKIN_RADIUS_INCOMPLETE: {
    domain: 'locationAttendance',
    severity: 'blocker',
    message: '定位签到要求与签到半径配置不完整或互相矛盾。',
    resolutionHint: '让定位要求、坐标和半径满足现有闭集。',
  },
  VISIBILITY_OR_REGISTRATION_MODE_INCOMPLETE: {
    domain: 'registration',
    severity: 'blocker',
    message: '可见性或报名方式缺少当前可解释的配置。',
    resolutionHint: '补齐当前受控闭集中的可见性和报名方式。',
  },
  REGISTRATION_FORM_INVALID: {
    domain: 'form',
    severity: 'blocker',
    message: '当前报名表定义无法通过既有 canonical 解析。',
    resolutionHint: '使用既有表单受控面修复定义，不改写历史 hash。',
  },
  QUALIFICATION_RULE_SCOPE_INVALID: {
    domain: 'qualification',
    severity: 'blocker',
    message: '资格规则集的作用域、版本或引用无法由当前正式模型解析。',
    resolutionHint: '在既有资格规则受控面修复作用域和有效版本。',
  },
  INSURANCE_REQUIREMENT_UNVERIFIABLE: {
    domain: 'visibilityAudienceInsurance',
    severity: 'warning',
    message: '已要求保险，但当前事实无法证明保险门槛配置可被既有流程验证。',
    resolutionHint: '先修复既有保险配置和生命周期事实；不要在 B4 新造保险策略。',
  },
  TIME_POLICY_UNREPRESENTABLE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前活动没有可解析的有效时长政策指针。',
    resolutionHint: '在 Release 4 建立 TimePolicy / Version 与活动选择关系后重新判定。',
  },
  TIME_POLICY_TARGET_INVALID: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前时长政策选择中的场次或岗位目标无法与活动链一致解析。',
    resolutionHint: '通过既有时长政策选择受控面修复目标范围后重新判定。',
  },
  TIME_POLICY_REFERENCE_UNAVAILABLE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前时长政策选择引用的政策版本已不可用或其冻结身份不一致。',
    resolutionHint: '重新选择当前有效且哈希一致的时长政策版本。',
  },
  TIME_POLICY_COVERAGE_INCOMPLETE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前时长政策选择未覆盖活动、场次或岗位的完整有效时间段。',
    resolutionHint: '补齐每个目标的有效政策选择，或选择覆盖其实际时段的版本。',
  },
  CONTRIBUTION_POLICY_UNREPRESENTABLE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前活动没有可解析的有效贡献政策指针。',
    resolutionHint: '在 Release 5 建立 ContributionPolicy / Version 与活动选择关系后重新判定。',
  },
  METRIC_SELECTION_MISSING: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前活动尚未配置指标选择。',
    resolutionHint: '通过既有活动指标选择受控面明确选择“无需指标”或一份精确指标集。',
  },
  METRIC_SELECTION_INVALID: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前活动的指标选择或其精确引用无法完整解析。',
    resolutionHint: '修复既有活动指标选择与目录引用，不按最新版本猜测替代。',
  },
  METRIC_REFERENCE_UNAVAILABLE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '草稿活动引用的指标集当前已不可用于新的发布事实。',
    resolutionHint: '在既有指标选择受控面重新选择当前有效的精确指标集。',
  },
  SAFETY_REQUIREMENTS_UNREPRESENTABLE: {
    domain: 'terminalPolicyOutcomeSafety',
    severity: 'blocker',
    message: '当前活动没有可判定的风险与安全要求事实。',
    resolutionHint: '在独立安全 / Incident 评审定义风险分类、安全说明和装备要求后重新判定。',
  },
} as const satisfies Record<string, IssueDefinition>;

type ReadinessIssueCode = keyof typeof ISSUE_DEFINITIONS;

const DOMAIN_ORDER = new Map(
  ACTIVITY_READINESS_DOMAINS.map((domain, index) => [domain, index] as const),
);
const REGISTRATION_MODE_CODES = new Set(['open_apply', 'invitation_only', 'admin_only', 'paused']);
const VISIBILITY_CODES = new Set(['internal', 'invitation']);

class ReadinessIssueValue implements ActivityPublishReadinessIssue {
  readonly code: string;
  readonly severity: ActivityReadinessSeverity;
  readonly fieldPath: string;
  readonly message: string;
  readonly resolutionHint: string;

  constructor(code: ReadinessIssueCode, fieldPath: string) {
    const definition = ISSUE_DEFINITIONS[code];
    this.code = code;
    this.severity = definition.severity;
    this.fieldPath = fieldPath;
    this.message = definition.message;
    this.resolutionHint = definition.resolutionHint;
  }
}

function issue(code: ReadinessIssueCode, fieldPath: string): ActivityPublishReadinessIssue {
  return new ReadinessIssueValue(code, fieldPath);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIssues(
  left: ActivityPublishReadinessIssue,
  right: ActivityPublishReadinessIssue,
): number {
  const leftDomain = ISSUE_DEFINITIONS[left.code as ReadinessIssueCode].domain;
  const rightDomain = ISSUE_DEFINITIONS[right.code as ReadinessIssueCode].domain;
  const domainComparison =
    (DOMAIN_ORDER.get(leftDomain) ?? Number.MAX_SAFE_INTEGER) -
    (DOMAIN_ORDER.get(rightDomain) ?? Number.MAX_SAFE_INTEGER);
  if (domainComparison !== 0) return domainComparison;
  const fieldPathComparison = compareText(left.fieldPath, right.fieldPath);
  return fieldPathComparison !== 0 ? fieldPathComparison : compareText(left.code, right.code);
}

function addIssue(
  issues: ActivityPublishReadinessIssue[],
  code: ReadinessIssueCode,
  fieldPath: string,
): void {
  if (issues.some((existing) => existing.code === code && existing.fieldPath === fieldPath)) {
    return;
  }
  issues.push(issue(code, fieldPath));
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function isExpectedFormResolutionFailure(error: unknown): boolean {
  return error instanceof BizException && error.biz === BizCode.BAD_REQUEST;
}

function isExpectedQualificationResolutionFailure(error: unknown): boolean {
  return (
    error instanceof BizException &&
    (error.biz === BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID ||
      error.biz === BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID)
  );
}

function isWithinInclusiveInterval(value: Date, intervalStart: Date, intervalEnd: Date): boolean {
  return value.getTime() >= intervalStart.getTime() && value.getTime() <= intervalEnd.getTime();
}

function hasUsableCoordinate(longitude: string | null, latitude: string | null): boolean {
  const projected = projectPlaceCoordinate({
    longitude,
    latitude,
    coordinateSystemCode: 'wgs84',
  });
  if (projected.kind !== 'projectable') return false;
  return Number(projected.longitude) !== 0 || Number(projected.latitude) !== 0;
}

function templateDefinitionIsValid(
  template: NonNullable<ActivityPublishReadinessFacts['template']>,
): boolean {
  // Legacy rows are the A5 fallback surface. They did not have a canonical definition/hash when
  // written, so applying future-version validation to them would fabricate a B4 failure.
  if (template.familyId === null) return true;
  if (
    (template.schemaVersion !== 1 &&
      template.schemaVersion !== 2 &&
      template.schemaVersion !== 3 &&
      template.schemaVersion !== 4) ||
    template.definitionJson === null ||
    template.definitionHash === null
  ) {
    return false;
  }
  try {
    if (
      !matchesActivityTemplateDefinitionHash(
        {
          schemaVersion: template.schemaVersion,
          definition: template.definitionJson,
        },
        template.definitionHash,
      )
    ) {
      return false;
    }
    if (template.schemaVersion === 1) {
      parseActivityTemplateDefinitionV1(template.definitionJson);
    } else if (template.schemaVersion === 2) {
      parseActivityTemplateDefinitionV2(template.definitionJson);
    } else if (template.schemaVersion === 3) {
      parseActivityTemplateDefinitionV3(template.definitionJson);
    } else {
      parseActivityTemplateDefinitionV4(template.definitionJson);
    }
    return true;
  } catch {
    return false;
  }
}

function sortSessions(
  sessions: ActivityPublishReadinessFacts['sessions'],
): ActivityPublishReadinessFacts['sessions'] {
  return [...sessions]
    .sort((left, right) => compareText(left.id, right.id))
    .map((session) => ({
      ...session,
      positions: [...session.positions].sort((left, right) => compareText(left.id, right.id)),
    }));
}

function completedIssueSummary(
  issues: readonly ActivityPublishReadinessIssue[],
): readonly ActivityPublishReadinessDomainSummary[] {
  return ACTIVITY_READINESS_DOMAINS.map((domain) => {
    const domainIssues = issues
      .filter(
        (candidate) => ISSUE_DEFINITIONS[candidate.code as ReadinessIssueCode].domain === domain,
      )
      .sort(compareIssues);
    const issueCodes = [...new Set(domainIssues.map((candidate) => candidate.code))];
    const status: ActivityReadinessStatus =
      domain === 'terminalPolicyOutcomeSafety'
        ? 'unrepresentable'
        : domainIssues.some((candidate) => candidate.severity === 'blocker')
          ? 'blocked'
          : domainIssues.length > 0
            ? 'attention'
            : 'clear';
    return { domain, status, issueCodes };
  });
}

/**
 * Pure, deterministic B4 evaluator.  It intentionally returns the four unrepresentable terminal
 * blockers even if every current Activity fact is otherwise coherent.  This is a gate-off result,
 * not a replacement for the existing publish workflow.
 */
export function evaluateActivityPublishReadiness(
  facts: ActivityPublishReadinessFacts,
  referenceTime: Date,
): ActivityPublishReadinessResult {
  if (!isValidDate(referenceTime)) {
    throw new TypeError('referenceTime must be a valid Date');
  }

  const issues: ActivityPublishReadinessIssue[] = [];
  const { activity } = facts;

  if (activity.title.trim().length === 0) addIssue(issues, 'BASIC_TITLE_MISSING', 'activity.title');
  if (!activity.organizationResolvable) {
    addIssue(issues, 'BASIC_ORGANIZATION_UNRESOLVED', 'activity.organizationId');
  }
  if (!activity.initiatorResolvable) {
    addIssue(issues, 'BASIC_RESPONSIBLE_INITIATOR_MISSING', 'activity.initiatorMemberId');
  }

  const category = LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY.find(
    (entry) => entry.legacyActivityTypeCode === activity.activityTypeCode,
  );
  if (!category || category.categoryCode === 'pending_classification') {
    addIssue(issues, 'CATEGORY_NOT_FORMAL', 'activity.activityTypeCode');
  }
  if (category && category.manualGovernance.trim().length > 0) {
    addIssue(issues, 'CATEGORY_MANUAL_GOVERNANCE_PENDING', 'activity.activityTypeCode');
  }

  if (facts.template === null) {
    addIssue(issues, 'TEMPLATE_VERSION_UNRESOLVED', 'activity.selectedTemplateVersionId');
  } else if (!templateDefinitionIsValid(facts.template)) {
    addIssue(issues, 'TEMPLATE_DEFINITION_INVALID', 'activity.selectedTemplateVersionId');
  }

  const sessions = sortSessions(facts.sessions).filter(
    (session) => session.statusCode === 'scheduled',
  );
  if (sessions.length === 0) {
    addIssue(issues, 'SESSION_REQUIRED', 'sessions');
  }

  const activityIntervalIsValid =
    isValidDate(activity.startAt) &&
    isValidDate(activity.endAt) &&
    activity.startAt.getTime() < activity.endAt.getTime();
  for (const session of sessions) {
    if (
      !isValidDate(session.startAt) ||
      !isValidDate(session.endAt) ||
      session.startAt.getTime() >= session.endAt.getTime() ||
      !activityIntervalIsValid ||
      !isWithinInclusiveInterval(session.startAt, activity.startAt, activity.endAt) ||
      !isWithinInclusiveInterval(session.endAt, activity.startAt, activity.endAt)
    ) {
      addIssue(issues, 'SESSION_TIME_INVALID', 'sessions[' + session.id + '].startAt');
    }

    for (const position of session.positions) {
      if (
        session.capacity !== null &&
        (position.capacity === null || position.capacity > session.capacity)
      ) {
        addIssue(
          issues,
          'POSITION_CAPACITY_EXCEEDS_SESSION',
          'sessions[' + session.id + '].positions[' + position.id + '].capacity',
        );
      }
    }

    const requiresCoordinate =
      session.locationRequired ||
      session.positions.some((position) => position.locationRequired ?? session.locationRequired);
    if (requiresCoordinate) {
      if (!hasUsableCoordinate(session.longitude, session.latitude)) {
        addIssue(issues, 'LOCATION_COORDINATE_REQUIRED', 'sessions[' + session.id + '].location');
      }
    }
    const sessionRadiusInvalid =
      (session.locationRequired &&
        (session.radiusMeters === null ||
          !Number.isInteger(session.radiusMeters) ||
          session.radiusMeters < 50 ||
          session.radiusMeters > 10_000)) ||
      (!session.locationRequired && session.radiusMeters !== null);
    const positionRadiusInvalid = session.positions.some((position) => {
      const effectiveRequired = position.locationRequired ?? session.locationRequired;
      const effectiveRadius = position.radiusMeters ?? session.radiusMeters;
      return (
        (effectiveRequired &&
          (effectiveRadius === null ||
            !Number.isInteger(effectiveRadius) ||
            effectiveRadius < 50 ||
            effectiveRadius > 10_000)) ||
        (!effectiveRequired && position.radiusMeters !== null)
      );
    });
    if (sessionRadiusInvalid || positionRadiusInvalid) {
      addIssue(issues, 'CHECKIN_RADIUS_INCOMPLETE', 'sessions[' + session.id + '].radiusMeters');
    }
  }

  if (
    activity.registrationDeadline !== null &&
    (!isValidDate(activity.registrationDeadline) ||
      !activityIntervalIsValid ||
      activity.registrationDeadline.getTime() < referenceTime.getTime() ||
      activity.registrationDeadline.getTime() >= activity.startAt.getTime())
  ) {
    addIssue(issues, 'REGISTRATION_DEADLINE_INVALID', 'activity.registrationDeadline');
  }

  const resolvedRegistrationMode =
    activity.registrationModeCode ?? facts.template?.defaultRegistrationModeCode ?? 'open_apply';
  if (
    activity.visibilityCode === null ||
    !VISIBILITY_CODES.has(activity.visibilityCode) ||
    !REGISTRATION_MODE_CODES.has(resolvedRegistrationMode)
  ) {
    addIssue(issues, 'VISIBILITY_OR_REGISTRATION_MODE_INCOMPLETE', 'activity.visibilityCode');
  }

  if (!facts.registrationFormValid) {
    addIssue(issues, 'REGISTRATION_FORM_INVALID', 'registrationForm');
  }
  if (!facts.qualificationRuleSet.valid) {
    addIssue(
      issues,
      'QUALIFICATION_RULE_SCOPE_INVALID',
      'qualificationRuleSets[' + (facts.qualificationRuleSet.invalidRuleSetId ?? 'unknown') + ']',
    );
  }
  if (activity.requiresInsurance && !facts.insuranceEnforcementEnabled) {
    addIssue(issues, 'INSURANCE_REQUIREMENT_UNVERIFIABLE', 'activity.requiresInsurance');
  }

  if (facts.timePolicySelectionIssues.includes('unconfigured')) {
    // Keep the historical code and wording so old, genuinely unconfigured Activity rows retain
    // their exact externally visible readiness contract.
    addIssue(issues, 'TIME_POLICY_UNREPRESENTABLE', 'policy.time');
  }
  if (facts.timePolicySelectionIssues.includes('target_invalid')) {
    addIssue(issues, 'TIME_POLICY_TARGET_INVALID', 'policy.time.selection');
  }
  if (facts.timePolicySelectionIssues.includes('reference_unavailable')) {
    addIssue(issues, 'TIME_POLICY_REFERENCE_UNAVAILABLE', 'policy.time.references');
  }
  if (facts.timePolicySelectionIssues.includes('coverage_incomplete')) {
    addIssue(issues, 'TIME_POLICY_COVERAGE_INCOMPLETE', 'policy.time.coverage');
  }
  addIssue(issues, 'CONTRIBUTION_POLICY_UNREPRESENTABLE', 'policy.contribution');
  if (facts.metricSelection === 'unconfigured') {
    addIssue(issues, 'METRIC_SELECTION_MISSING', 'metrics.requiredSet');
  } else if (facts.metricSelection === 'invalid') {
    addIssue(issues, 'METRIC_SELECTION_INVALID', 'metrics.requiredSet');
  } else if (facts.metricSelection === 'required_historical' && activity.statusCode === 'draft') {
    addIssue(issues, 'METRIC_REFERENCE_UNAVAILABLE', 'metrics.requiredSet');
  }
  addIssue(issues, 'SAFETY_REQUIREMENTS_UNREPRESENTABLE', 'safety.requirements');

  const sorted = [...issues].sort(compareIssues);
  return {
    blockers: sorted.filter((candidate) => candidate.severity === 'blocker'),
    warnings: sorted.filter((candidate) => candidate.severity === 'warning'),
    suggestions: sorted.filter((candidate) => candidate.severity === 'suggestion'),
    resolvedSummary: completedIssueSummary(sorted),
  };
}

@Injectable()
export class ActivityPublishReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registrationForms: RegistrationFormVersionService,
    private readonly qualificationRules: QualificationRuleSetVersionService,
    private readonly insuranceRequirements: InsuranceRequirementService,
  ) {}

  async evaluate(activityId: string, referenceTime: Date): Promise<ActivityPublishReadinessResult> {
    if (!isValidDate(referenceTime)) {
      throw new TypeError('referenceTime must be a valid Date');
    }
    const facts = await this.prisma.$transaction((tx) => this.loadFacts(tx, activityId));
    return evaluateActivityPublishReadiness(facts, referenceTime);
  }

  private async loadFacts(
    tx: PrismaTx,
    activityId: string,
  ): Promise<ActivityPublishReadinessFacts> {
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: {
        title: true,
        activityTypeCode: true,
        organizationId: true,
        initiatorMemberId: true,
        selectedTemplateVersionId: true,
        startAt: true,
        endAt: true,
        registrationDeadline: true,
        registrationModeCode: true,
        visibilityCode: true,
        requiresInsurance: true,
        statusCode: true,
        metricRequirementCode: true,
        selectedMetricSetVersionId: true,
        selectedMetricSetDefinitionHash: true,
        metricSelectionRevision: true,
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
        currentTimePolicySelectionRevision: {
          select: {
            id: true,
            activityId: true,
            revision: true,
            selectionHash: true,
            selectionJson: true,
            itemCount: true,
          },
        },
        selectedMetricSetVersion: {
          include: {
            items: {
              include: { metricDefinition: true },
              take: 101,
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
        sessions: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            statusCode: true,
            startAt: true,
            endAt: true,
            capacity: true,
            longitude: true,
            latitude: true,
            locationRequired: true,
            radiusMeters: true,
            positions: {
              where: { deletedAt: null },
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                capacity: true,
                startAt: true,
                endAt: true,
                attendanceRoleCode: true,
                locationRequired: true,
                radiusMeters: true,
              },
            },
          },
        },
      },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const template = await this.resolveTemplate(
      tx,
      activity.selectedTemplateVersionId,
      activity.activityTypeCode,
    );
    const organizationResolvable = await isActivityOrganizationResolvable(
      tx,
      activity.organizationId,
    );
    const initiatorResolvable = await isActivityInitiatorResolvable(tx, activity.initiatorMemberId);
    const metricSelection = this.metricSelectionStatus({
      metricRequirementCode: activity.metricRequirementCode,
      selectedMetricSetVersionId: activity.selectedMetricSetVersionId,
      selectedMetricSetDefinitionHash: activity.selectedMetricSetDefinitionHash,
      metricSelectionRevision: activity.metricSelectionRevision,
      selectedMetricSetVersion: activity.selectedMetricSetVersion,
    });
    const timePolicySelectionIssues = await this.timePolicySelectionIssues(tx, activityId, {
      startAt: activity.startAt,
      endAt: activity.endAt,
      revision: activity.timePolicySelectionRevision,
      currentRevisionId: activity.currentTimePolicySelectionRevisionId,
      currentRevision: activity.currentTimePolicySelectionRevision,
      sessions: activity.sessions,
    });

    let registrationFormValid = true;
    try {
      await this.registrationForms.currentTarget(tx, activityId, activity.statusCode);
    } catch (error) {
      if (!isExpectedFormResolutionFailure(error)) throw error;
      registrationFormValid = false;
    }

    const qualificationStatus = activity.statusCode === 'draft' ? 'draft' : 'active';
    const qualificationRuleSets = await tx.activityQualificationRuleSet.findMany({
      where: { activityId, statusCode: qualificationStatus },
      orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    let qualificationRuleSetValid = true;
    try {
      await this.qualificationRules.currentTarget(tx, activityId, activity.statusCode);
    } catch (error) {
      if (!isExpectedQualificationResolutionFailure(error)) throw error;
      qualificationRuleSetValid = false;
    }

    return {
      activity: {
        title: activity.title,
        activityTypeCode: activity.activityTypeCode,
        startAt: activity.startAt,
        endAt: activity.endAt,
        registrationDeadline: activity.registrationDeadline,
        registrationModeCode: activity.registrationModeCode,
        visibilityCode: activity.visibilityCode,
        requiresInsurance: activity.requiresInsurance,
        statusCode: activity.statusCode,
        organizationResolvable,
        // B4 intentionally does not replay the actor-specific cross-organization authorization
        // decision made when the draft was created. Its responsibility fact is the live initiator.
        initiatorResolvable,
      },
      template: template
        ? {
            familyId: template.familyId,
            schemaVersion: template.schemaVersion,
            definitionJson: template.definitionJson,
            definitionHash: template.definitionHash,
            defaultRegistrationModeCode: template.defaultRegistrationModeCode,
          }
        : null,
      sessions: activity.sessions.map((session) => ({
        id: session.id,
        statusCode: session.statusCode,
        startAt: session.startAt,
        endAt: session.endAt,
        capacity: session.capacity,
        longitude: session.longitude?.toString() ?? null,
        latitude: session.latitude?.toString() ?? null,
        locationRequired: session.locationRequired,
        radiusMeters: session.radiusMeters,
        positions: session.positions.map((position) => ({
          id: position.id,
          capacity: position.capacity,
          startAt: position.startAt,
          endAt: position.endAt,
          attendanceRoleCode: position.attendanceRoleCode,
          locationRequired: position.locationRequired,
          radiusMeters: position.radiusMeters,
        })),
      })),
      registrationFormValid,
      qualificationRuleSet: {
        valid: qualificationRuleSetValid,
        invalidRuleSetId: qualificationRuleSetValid ? null : (qualificationRuleSets[0]?.id ?? null),
      },
      metricSelection,
      timePolicySelectionIssues,
      insuranceEnforcementEnabled: this.insuranceRequirements.isEnforcementEnabled(),
    };
  }

  private async resolveTemplate(
    tx: PrismaTx,
    selectedTemplateVersionId: string | null,
    activityTypeCode: string,
  ): Promise<{
    readonly familyId: string | null;
    readonly schemaVersion: number | null;
    readonly definitionJson: unknown;
    readonly definitionHash: string | null;
    readonly defaultRegistrationModeCode: string | null;
  } | null> {
    const select = {
      familyId: true,
      schemaVersion: true,
      definitionJson: true,
      definitionHash: true,
      defaultRegistrationModeCode: true,
    } as const;
    if (selectedTemplateVersionId !== null) {
      // A5 requires an explicit (including retired) selected Version to win. Do not mask a
      // missing explicit target by falling back to another active template.
      return tx.activityTemplate.findUnique({
        where: { id: selectedTemplateVersionId },
        select,
      });
    }
    return tx.activityTemplate.findFirst({
      where: { activityTypeCode, statusCode: 'active' },
      orderBy: [{ version: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      select,
    });
  }

  private metricSelectionStatus(input: {
    readonly metricRequirementCode: string | null;
    readonly selectedMetricSetVersionId: string | null;
    readonly selectedMetricSetDefinitionHash: string | null;
    readonly metricSelectionRevision: number;
    readonly selectedMetricSetVersion: MetricSetRow | null;
  }): ActivityReadinessMetricSelectionStatus {
    try {
      const selection = readActivityMetricSelection(
        {
          metricRequirementCode: input.metricRequirementCode,
          selectedMetricSetVersionId: input.selectedMetricSetVersionId,
          selectedMetricSetDefinitionHash: input.selectedMetricSetDefinitionHash,
          metricSelectionRevision: input.metricSelectionRevision,
        },
        input.selectedMetricSetVersion,
      );
      if (selection === null) return 'unconfigured';
      if (selection.metricRequirementCode === 'not_required') return 'not_required';
      try {
        assertMetricSelectionReference(selection, input.selectedMetricSetVersion);
        return 'required_active';
      } catch {
        // readActivityMetricSelection already proved the bounded historic closure; this second
        // strict check only distinguishes active from retired for the draft readiness rule.
        return 'required_historical';
      }
    } catch {
      return 'invalid';
    }
  }

  /**
   * Reads only the immutable selection anchor and its referenced catalogue rows, then reduces
   * them to bounded facts for the pure evaluator.  No policy definition, target title or other
   * potentially sensitive payload escapes this method.
   */
  private async timePolicySelectionIssues(
    tx: PrismaTx,
    activityId: string,
    input: {
      readonly startAt: Date;
      readonly endAt: Date;
      readonly revision: number;
      readonly currentRevisionId: string | null;
      readonly currentRevision: TimePolicyReadinessRevision | null;
      readonly sessions: readonly TimePolicyReadinessSession[];
    },
  ): Promise<readonly ActivityReadinessTimePolicySelectionIssue[]> {
    if (input.revision === 0 && input.currentRevisionId === null) return ['unconfigured'];
    const revision = input.currentRevision;
    if (
      !Number.isInteger(input.revision) ||
      input.revision < 1 ||
      input.currentRevisionId === null ||
      revision === null ||
      revision.id !== input.currentRevisionId ||
      revision.activityId !== activityId ||
      revision.revision !== input.revision
    ) {
      return ['target_invalid'];
    }

    let selection;
    try {
      selection = parseActivityTimePolicySelectionDocument(revision.selectionJson);
      if (
        activityTimePolicySelectionHash(selection) !== revision.selectionHash ||
        Object.keys(selection.items).length !== revision.itemCount
      ) {
        return ['target_invalid'];
      }
    } catch {
      return ['target_invalid'];
    }

    const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
    const positionsById = new Map<
      string,
      { readonly sessionId: string; readonly position: TimePolicyReadinessPosition }
    >();
    for (const session of input.sessions) {
      for (const position of session.positions) {
        if (positionsById.has(position.id)) return ['target_invalid'];
        positionsById.set(position.id, { sessionId: session.id, position });
      }
    }
    for (const item of Object.values(selection.items)) {
      if (item.scope.layerCode === 'session' && !sessionsById.has(item.scope.sessionId!)) {
        return ['target_invalid'];
      }
      if (item.scope.layerCode === 'position') {
        const position = positionsById.get(item.scope.positionId!);
        if (!position || position.sessionId !== item.scope.sessionId) return ['target_invalid'];
      }
    }

    let resolved;
    try {
      resolved = resolveActivityTimePolicySelection(
        selection,
        input.sessions.map((session) => ({
          sessionId: session.id,
          positionIds: session.positions.map((position) => position.id),
        })),
      );
    } catch {
      return ['target_invalid'];
    }

    const intervalByScope = this.timePolicyIntervals(input.startAt, input.endAt, input.sessions);
    const issues = new Set<ActivityReadinessTimePolicySelectionIssue>();
    const pointers = new Map<
      string,
      { readonly policyId: string; readonly definitionHash: string }
    >();
    for (const entry of resolved) {
      if (entry.pointer === null || entry.sourceScope === null) {
        issues.add('coverage_incomplete');
        continue;
      }
      const interval = intervalByScope.get(activityTimePolicySelectionScopeKey(entry.scope));
      if (
        !interval ||
        !isValidDate(interval.startAt) ||
        !isValidDate(interval.endAt) ||
        interval.startAt >= interval.endAt
      ) {
        issues.add('coverage_incomplete');
        continue;
      }
      pointers.set(entry.pointer.versionId, {
        policyId: entry.pointer.policyId,
        definitionHash: entry.pointer.definitionHash,
      });
    }

    const versionIds = [...pointers.keys()].sort();
    const versions = versionIds.length
      ? await tx.timePolicyVersion.findMany({
          where: { id: { in: versionIds } },
          select: {
            id: true,
            policyId: true,
            definitionHash: true,
            schemaVersion: true,
            evaluatorVersion: true,
            definitionJson: true,
            effectiveFrom: true,
            effectiveUntil: true,
            statusCode: true,
          },
        })
      : [];
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    for (const entry of resolved) {
      if (entry.pointer === null) continue;
      const expected = pointers.get(entry.pointer.versionId)!;
      const version = versionsById.get(entry.pointer.versionId);
      if (
        !version ||
        version.policyId !== expected.policyId ||
        version.definitionHash !== expected.definitionHash ||
        version.statusCode !== 'active'
      ) {
        issues.add('reference_unavailable');
        continue;
      }
      try {
        if (
          fingerprintTimePolicyVersion({
            schemaVersion: version.schemaVersion,
            evaluatorVersion: version.evaluatorVersion,
            definition: version.definitionJson,
            effectiveFrom: version.effectiveFrom.toISOString(),
            effectiveUntil: version.effectiveUntil?.toISOString() ?? null,
          }).definitionHash !== entry.pointer.definitionHash
        ) {
          issues.add('reference_unavailable');
          continue;
        }
      } catch {
        issues.add('reference_unavailable');
        continue;
      }
      const interval = intervalByScope.get(activityTimePolicySelectionScopeKey(entry.scope));
      if (
        !interval ||
        version.effectiveFrom > interval.startAt ||
        (version.effectiveUntil !== null && version.effectiveUntil < interval.endAt)
      ) {
        issues.add('coverage_incomplete');
      }
    }

    const order: readonly ActivityReadinessTimePolicySelectionIssue[] = [
      'target_invalid',
      'reference_unavailable',
      'coverage_incomplete',
    ];
    return order.filter((issue) => issues.has(issue));
  }

  private timePolicyIntervals(
    startAt: Date,
    endAt: Date,
    sessions: readonly TimePolicyReadinessSession[],
  ): ReadonlyMap<string, { readonly startAt: Date; readonly endAt: Date }> {
    const intervals = new Map<string, { readonly startAt: Date; readonly endAt: Date }>();
    const add = (
      scope: ActivityTimePolicySelectionScope,
      interval: { startAt: Date; endAt: Date },
    ) => {
      intervals.set(activityTimePolicySelectionScopeKey(scope), interval);
    };
    add({ layerCode: 'activity', sessionId: null, positionId: null }, { startAt, endAt });
    for (const session of sessions) {
      const sessionScope = {
        layerCode: 'session' as const,
        sessionId: session.id,
        positionId: null,
      };
      const sessionInterval = { startAt: session.startAt, endAt: session.endAt };
      add(sessionScope, sessionInterval);
      for (const position of session.positions) {
        // Position-local intervals are optional, but only as an all-or-nothing inherited pair.
        // A malformed half-pair remains a coverage problem; existing graph Readiness reports the
        // broader activity shape independently.
        const interval =
          position.startAt === null || position.endAt === null
            ? sessionInterval
            : { startAt: position.startAt, endAt: position.endAt };
        if (position.attendanceRoleCode.trim().length === 0) {
          // Do not make an empty role look like a successfully resolved evaluator target.
          intervals.delete(
            activityTimePolicySelectionScopeKey({
              layerCode: 'position',
              sessionId: session.id,
              positionId: position.id,
            }),
          );
          continue;
        }
        add({ layerCode: 'position', sessionId: session.id, positionId: position.id }, interval);
      }
    }
    return intervals;
  }
}
