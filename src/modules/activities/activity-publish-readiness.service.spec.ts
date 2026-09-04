import { computeActivityTemplateDefinitionHash } from './activity-template-definition';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  ActivityPublishReadinessService,
  evaluateActivityPublishReadiness,
  type ActivityPublishReadinessFacts,
} from './activity-publish-readiness.service';

const REFERENCE_TIME = new Date('2099-04-01T00:00:00.000Z');

type ReadinessActivity = ActivityPublishReadinessFacts['activity'];
type ReadinessTemplate = ActivityPublishReadinessFacts['template'];
type ReadinessSession = ActivityPublishReadinessFacts['sessions'][number];
type ReadinessPosition = ReadinessSession['positions'][number];

function position(overrides: Partial<ReadinessPosition> = {}): ReadinessPosition {
  return {
    id: 'position-a',
    capacity: 5,
    locationRequired: null,
    radiusMeters: null,
    ...overrides,
  };
}

function session(overrides: Partial<ReadinessSession> = {}): ReadinessSession {
  return {
    id: 'session-a',
    statusCode: 'scheduled',
    startAt: new Date('2099-05-01T08:00:00.000Z'),
    endAt: new Date('2099-05-01T10:00:00.000Z'),
    capacity: 10,
    longitude: null,
    latitude: null,
    locationRequired: false,
    radiusMeters: null,
    positions: [position()],
    ...overrides,
  };
}

function legacyTemplate(overrides: Partial<NonNullable<ReadinessTemplate>> = {}) {
  return {
    familyId: null,
    schemaVersion: null,
    definitionJson: null,
    definitionHash: null,
    defaultRegistrationModeCode: null,
    ...overrides,
  };
}

function futureDefinition() {
  return {
    activity: {
      allocationModeCode: 'first_come',
      description: '仅用于 hash 解析的模板说明',
      capacity: 30,
      genderRequirementCode: 'all',
      registrationNotes: '准时到场',
      isPublicRegistration: false,
      requiresInsurance: false,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: null,
      archiveWaitingDays: 7,
    },
    sessions: [
      {
        code: 'morning',
        name: '上午场',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: '集合点',
        capacity: 20,
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 30,
        checkOutOpenOffsetMinutes: -30,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 10,
        earlyLeaveThresholdMinutes: 10,
        sortOrder: 0,
        positions: [
          {
            code: 'support',
            name: '保障',
            attendanceRoleCode: 'support',
            capacity: 5,
            startOffsetMinutes: 0,
            endOffsetMinutes: 120,
            genderRequirementCode: 'all',
            locationRequired: null,
            description: null,
            equipmentNotes: null,
            sortOrder: 0,
          },
        ],
      },
    ],
  };
}

function futureTemplate(overrides: Partial<NonNullable<ReadinessTemplate>> = {}) {
  const definitionJson = futureDefinition();
  return {
    familyId: 'family-b4',
    schemaVersion: 1,
    definitionJson,
    definitionHash: computeActivityTemplateDefinitionHash({
      schemaVersion: 1,
      definition: definitionJson,
    }),
    defaultRegistrationModeCode: 'open_apply',
    ...overrides,
  };
}

function facts(
  input: {
    readonly activity?: Partial<ReadinessActivity>;
    readonly template?: ReadinessTemplate;
    readonly sessions?: readonly ReadinessSession[];
    readonly registrationFormValid?: boolean;
    readonly qualificationRuleSet?: ActivityPublishReadinessFacts['qualificationRuleSet'];
    readonly insuranceEnforcementEnabled?: boolean;
  } = {},
): ActivityPublishReadinessFacts {
  return {
    activity: {
      title: '常规救援活动',
      activityTypeCode: 'rescue_mission',
      startAt: new Date('2099-05-01T07:00:00.000Z'),
      endAt: new Date('2099-05-01T12:00:00.000Z'),
      registrationDeadline: new Date('2099-04-30T12:00:00.000Z'),
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      requiresInsurance: false,
      organizationResolvable: true,
      initiatorResolvable: true,
      ...input.activity,
    },
    template: input.template === undefined ? legacyTemplate() : input.template,
    sessions: input.sessions ?? [session()],
    registrationFormValid: input.registrationFormValid ?? true,
    qualificationRuleSet: input.qualificationRuleSet ?? {
      valid: true,
      invalidRuleSetId: null,
    },
    insuranceEnforcementEnabled: input.insuranceEnforcementEnabled ?? true,
  };
}

function compact(result: ReturnType<typeof evaluateActivityPublishReadiness>) {
  return {
    blockers: result.blockers.map(({ code, fieldPath }) => ({ code, fieldPath })),
    warnings: result.warnings.map(({ code, fieldPath }) => ({ code, fieldPath })),
    suggestions: result.suggestions.map(({ code, fieldPath }) => ({ code, fieldPath })),
    summary: result.resolvedSummary.map(({ domain, status, issueCodes }) => ({
      domain,
      status,
      issueCodes,
    })),
  };
}

describe('ActivityPublishReadinessService (Activity OS R2 / B4)', () => {
  it('始终完整报告四个不可表示 blocker，并且没有墙钟或运行环境噪声', () => {
    const first = evaluateActivityPublishReadiness(facts(), REFERENCE_TIME);
    const second = evaluateActivityPublishReadiness(facts(), REFERENCE_TIME);

    expect(first).toEqual(second);
    expect(first.blockers).toEqual([
      {
        code: 'METRIC_SET_UNREPRESENTABLE',
        severity: 'blocker',
        fieldPath: 'metrics.requiredSet',
        message: '当前活动没有可解析的必需指标集。',
        resolutionHint: '在 Release 3 建立 Metric Definition / Set Version 后重新判定。',
      },
      {
        code: 'CONTRIBUTION_POLICY_UNREPRESENTABLE',
        severity: 'blocker',
        fieldPath: 'policy.contribution',
        message: '当前活动没有可解析的有效贡献政策指针。',
        resolutionHint: '在 Release 5 建立 ContributionPolicy / Version 与活动选择关系后重新判定。',
      },
      {
        code: 'TIME_POLICY_UNREPRESENTABLE',
        severity: 'blocker',
        fieldPath: 'policy.time',
        message: '当前活动没有可解析的有效时长政策指针。',
        resolutionHint: '在 Release 4 建立 TimePolicy / Version 与活动选择关系后重新判定。',
      },
      {
        code: 'SAFETY_REQUIREMENTS_UNREPRESENTABLE',
        severity: 'blocker',
        fieldPath: 'safety.requirements',
        message: '当前活动没有可判定的风险与安全要求事实。',
        resolutionHint: '在独立安全 / Incident 评审定义风险分类、安全说明和装备要求后重新判定。',
      },
    ]);
    expect(first.warnings).toEqual([
      expect.objectContaining({
        code: 'CATEGORY_MANUAL_GOVERNANCE_PENDING',
        fieldPath: 'activity.activityTypeCode',
      }),
    ]);
    expect(first.resolvedSummary).toEqual([
      {
        domain: 'basic',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'categoryTemplate',
        status: 'attention',
        issueCodes: ['CATEGORY_MANUAL_GOVERNANCE_PENDING'],
      },
      {
        domain: 'timeCapacity',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'locationAttendance',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'registration',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'form',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'qualification',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'visibilityAudienceInsurance',
        status: 'clear',
        issueCodes: [],
      },
      {
        domain: 'terminalPolicyOutcomeSafety',
        status: 'unrepresentable',
        issueCodes: [
          'METRIC_SET_UNREPRESENTABLE',
          'CONTRIBUTION_POLICY_UNREPRESENTABLE',
          'TIME_POLICY_UNREPRESENTABLE',
          'SAFETY_REQUIREMENTS_UNREPRESENTABLE',
        ],
      },
    ]);
  });

  it('按固定域、fieldPath、code 排序，并只回显固定安全问题字典', () => {
    const input = facts({
      activity: {
        title: '不应进入结果的标题和地址：某人证件信息',
        activityTypeCode: 'assistance',
        registrationDeadline: new Date('2099-03-31T23:59:59.000Z'),
        registrationModeCode: 'not-a-mode',
        visibilityCode: null,
        requiresInsurance: true,
        organizationResolvable: false,
        initiatorResolvable: false,
      },
      template: null,
      sessions: [
        session({
          id: 'session-z',
          startAt: new Date('2099-05-01T11:00:00.000Z'),
          endAt: new Date('2099-05-01T10:00:00.000Z'),
          capacity: 2,
          locationRequired: true,
          radiusMeters: 20,
          positions: [
            position({ id: 'position-z', capacity: 3, locationRequired: true, radiusMeters: 20 }),
          ],
        }),
        session({
          id: 'session-a',
          capacity: 2,
          locationRequired: false,
          radiusMeters: 80,
          positions: [
            position({
              id: 'position-a',
              capacity: null,
              locationRequired: false,
              radiusMeters: 80,
            }),
          ],
        }),
      ],
      registrationFormValid: false,
      qualificationRuleSet: { valid: false, invalidRuleSetId: 'rule-set-b4-1' },
      insuranceEnforcementEnabled: false,
    });

    const forward = evaluateActivityPublishReadiness(input, REFERENCE_TIME);
    const reversed = evaluateActivityPublishReadiness(
      facts({ ...input, sessions: [...input.sessions].reverse() }),
      REFERENCE_TIME,
    );

    expect(compact(forward)).toEqual(compact(reversed));
    expect(compact(forward)).toEqual(
      expect.objectContaining({
        blockers: [
          {
            code: 'BASIC_RESPONSIBLE_INITIATOR_MISSING',
            fieldPath: 'activity.initiatorMemberId',
          },
          { code: 'BASIC_ORGANIZATION_UNRESOLVED', fieldPath: 'activity.organizationId' },
          { code: 'CATEGORY_NOT_FORMAL', fieldPath: 'activity.activityTypeCode' },
          {
            code: 'TEMPLATE_VERSION_UNRESOLVED',
            fieldPath: 'activity.selectedTemplateVersionId',
          },
          {
            code: 'REGISTRATION_DEADLINE_INVALID',
            fieldPath: 'activity.registrationDeadline',
          },
          {
            code: 'POSITION_CAPACITY_EXCEEDS_SESSION',
            fieldPath: 'sessions[session-a].positions[position-a].capacity',
          },
          {
            code: 'POSITION_CAPACITY_EXCEEDS_SESSION',
            fieldPath: 'sessions[session-z].positions[position-z].capacity',
          },
          { code: 'SESSION_TIME_INVALID', fieldPath: 'sessions[session-z].startAt' },
          {
            code: 'CHECKIN_RADIUS_INCOMPLETE',
            fieldPath: 'sessions[session-a].radiusMeters',
          },
          { code: 'LOCATION_COORDINATE_REQUIRED', fieldPath: 'sessions[session-z].location' },
          {
            code: 'CHECKIN_RADIUS_INCOMPLETE',
            fieldPath: 'sessions[session-z].radiusMeters',
          },
          {
            code: 'VISIBILITY_OR_REGISTRATION_MODE_INCOMPLETE',
            fieldPath: 'activity.visibilityCode',
          },
          { code: 'REGISTRATION_FORM_INVALID', fieldPath: 'registrationForm' },
          {
            code: 'QUALIFICATION_RULE_SCOPE_INVALID',
            fieldPath: 'qualificationRuleSets[rule-set-b4-1]',
          },
          { code: 'METRIC_SET_UNREPRESENTABLE', fieldPath: 'metrics.requiredSet' },
          {
            code: 'CONTRIBUTION_POLICY_UNREPRESENTABLE',
            fieldPath: 'policy.contribution',
          },
          { code: 'TIME_POLICY_UNREPRESENTABLE', fieldPath: 'policy.time' },
          { code: 'SAFETY_REQUIREMENTS_UNREPRESENTABLE', fieldPath: 'safety.requirements' },
        ],
        warnings: [
          {
            code: 'CATEGORY_MANUAL_GOVERNANCE_PENDING',
            fieldPath: 'activity.activityTypeCode',
          },
          {
            code: 'INSURANCE_REQUIREMENT_UNVERIFIABLE',
            fieldPath: 'activity.requiresInsurance',
          },
        ],
      }),
    );
    const serialized = JSON.stringify(forward);
    expect(serialized).not.toContain('不应进入结果');
    expect(serialized).not.toContain('证件信息');
  });

  it('尊重 A5 的 future / legacy 解析边界，并对缺失或 hash 失配 fail-closed', () => {
    const future = evaluateActivityPublishReadiness(
      facts({ template: futureTemplate() }),
      REFERENCE_TIME,
    );
    const legacy = evaluateActivityPublishReadiness(
      facts({ template: legacyTemplate() }),
      REFERENCE_TIME,
    );
    const missing = evaluateActivityPublishReadiness(facts({ template: null }), REFERENCE_TIME);
    const hashMismatch = evaluateActivityPublishReadiness(
      facts({ template: futureTemplate({ definitionHash: '0'.repeat(64) }) }),
      REFERENCE_TIME,
    );

    expect(future.blockers.map((entry) => entry.code)).not.toContain('TEMPLATE_DEFINITION_INVALID');
    expect(legacy.blockers.map((entry) => entry.code)).not.toContain('TEMPLATE_DEFINITION_INVALID');
    expect(missing.blockers).toContainEqual(
      expect.objectContaining({ code: 'TEMPLATE_VERSION_UNRESOLVED' }),
    );
    expect(hashMismatch.blockers).toContainEqual(
      expect.objectContaining({ code: 'TEMPLATE_DEFINITION_INVALID' }),
    );
  });

  it('只按当前 Session / Position 定位事实判断，不把零坐标或不完整半径当作有效', () => {
    const coordinateReady = evaluateActivityPublishReadiness(
      facts({
        sessions: [
          session({
            longitude: '116.3971280',
            latitude: '39.9165270',
            locationRequired: true,
            radiusMeters: 100,
          }),
        ],
      }),
      REFERENCE_TIME,
    );
    const positionRequiresLocation = evaluateActivityPublishReadiness(
      facts({
        sessions: [
          session({
            longitude: '116.3971280',
            latitude: '39.9165270',
            locationRequired: false,
            radiusMeters: null,
            positions: [position({ locationRequired: true, radiusMeters: 100 })],
          }),
        ],
      }),
      REFERENCE_TIME,
    );
    const zeroCoordinate = evaluateActivityPublishReadiness(
      facts({
        sessions: [
          session({
            longitude: '0',
            latitude: '0',
            locationRequired: true,
            radiusMeters: 100,
          }),
        ],
      }),
      REFERENCE_TIME,
    );

    expect(coordinateReady.blockers.map((entry) => entry.code)).not.toContain(
      'LOCATION_COORDINATE_REQUIRED',
    );
    expect(coordinateReady.blockers.map((entry) => entry.code)).not.toContain(
      'CHECKIN_RADIUS_INCOMPLETE',
    );
    expect(positionRequiresLocation.blockers.map((entry) => entry.code)).not.toContain(
      'LOCATION_COORDINATE_REQUIRED',
    );
    expect(positionRequiresLocation.blockers.map((entry) => entry.code)).not.toContain(
      'CHECKIN_RADIUS_INCOMPLETE',
    );
    expect(zeroCoordinate.blockers).toContainEqual(
      expect.objectContaining({
        code: 'LOCATION_COORDINATE_REQUIRED',
        fieldPath: 'sessions[session-a].location',
      }),
    );
  });

  it('对坏表单和资格配置只回传固定问题，不泄露原始内容或异常', () => {
    const result = evaluateActivityPublishReadiness(
      facts({
        registrationFormValid: false,
        qualificationRuleSet: { valid: false, invalidRuleSetId: 'rule-set-b4-safe-id' },
      }),
      REFERENCE_TIME,
    );
    const serialized = JSON.stringify(result);

    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'REGISTRATION_FORM_INVALID',
        fieldPath: 'registrationForm',
      }),
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'QUALIFICATION_RULE_SCOPE_INVALID',
        fieldPath: 'qualificationRuleSets[rule-set-b4-safe-id]',
      }),
    );
    expect(serialized).not.toContain('身份证');
    expect(serialized).not.toContain('报名答案');
  });

  it('在同一只读事务中保持 A5 的显式 retired 指针优先，不按状态拒绝它', async () => {
    const explicit = makeServiceSubject('template-retired');
    await explicit.service.evaluate('activity-b4', REFERENCE_TIME);

    expect(explicit.tx.activityTemplate.findUnique).toHaveBeenCalledWith({
      where: { id: 'template-retired' },
      select: {
        familyId: true,
        schemaVersion: true,
        definitionJson: true,
        definitionHash: true,
        defaultRegistrationModeCode: true,
      },
    });
    expect(explicit.tx.activityTemplate.findFirst).not.toHaveBeenCalled();
    expect(explicit.tx.activity.findFirst).toHaveBeenCalledTimes(1);
    const calls = explicit.tx.activity.findFirst.mock.calls as unknown as readonly [unknown][];
    const activityFindCall = calls[0]?.[0] as {
      readonly where: { readonly id: string; readonly deletedAt: null };
      readonly select: {
        readonly sessions: {
          readonly where: { readonly deletedAt: null };
          readonly orderBy: readonly unknown[];
        };
      };
    };
    expect(activityFindCall.where).toEqual({ id: 'activity-b4', deletedAt: null });
    expect(activityFindCall.select.sessions.where).toEqual({ deletedAt: null });
    expect(activityFindCall.select.sessions.orderBy).toEqual([
      { sortOrder: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('在没有显式 Version 时使用 A5 的 active legacy fallback 与固定排序', async () => {
    const fallback = makeServiceSubject(null);
    await fallback.service.evaluate('activity-b4', REFERENCE_TIME);

    expect(fallback.tx.activityTemplate.findUnique).not.toHaveBeenCalled();
    expect(fallback.tx.activityTemplate.findFirst).toHaveBeenCalledWith({
      where: { activityTypeCode: 'rescue_mission', statusCode: 'active' },
      orderBy: [{ version: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      select: {
        familyId: true,
        schemaVersion: true,
        definitionJson: true,
        definitionHash: true,
        defaultRegistrationModeCode: true,
      },
    });
  });

  it('只将既有 canonical 业务失败映射为固定问题，未知故障保持失败', async () => {
    const canonicalFailure = makeServiceSubject(null);
    canonicalFailure.registrationForms.currentTarget.mockRejectedValue(
      new BizException(BizCode.BAD_REQUEST),
    );
    canonicalFailure.qualificationRules.currentTarget.mockRejectedValue(
      new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID),
    );
    canonicalFailure.tx.activityQualificationRuleSet.findMany.mockResolvedValue([
      { id: 'rule-b4' },
    ]);

    const canonicalResult = await canonicalFailure.service.evaluate('activity-b4', REFERENCE_TIME);
    expect(canonicalResult.blockers).toContainEqual(
      expect.objectContaining({ code: 'REGISTRATION_FORM_INVALID', fieldPath: 'registrationForm' }),
    );
    expect(canonicalResult.blockers).toContainEqual(
      expect.objectContaining({
        code: 'QUALIFICATION_RULE_SCOPE_INVALID',
        fieldPath: 'qualificationRuleSets[rule-b4]',
      }),
    );

    const infrastructureFailure = makeServiceSubject(null);
    infrastructureFailure.registrationForms.currentTarget.mockRejectedValue(
      new Error('database connection interrupted'),
    );
    await expect(
      infrastructureFailure.service.evaluate('activity-b4', REFERENCE_TIME),
    ).rejects.toThrow('database connection interrupted');
  });
});

function loadedActivity(selectedTemplateVersionId: string | null) {
  return {
    title: '只读装载活动',
    activityTypeCode: 'rescue_mission',
    organizationId: 'organization-b4',
    initiatorMemberId: 'member-b4',
    selectedTemplateVersionId,
    startAt: new Date('2099-05-01T07:00:00.000Z'),
    endAt: new Date('2099-05-01T12:00:00.000Z'),
    registrationDeadline: new Date('2099-04-30T12:00:00.000Z'),
    registrationModeCode: 'open_apply',
    visibilityCode: 'internal',
    requiresInsurance: false,
    statusCode: 'draft',
    sessions: [
      {
        id: 'session-b4',
        statusCode: 'scheduled',
        startAt: new Date('2099-05-01T08:00:00.000Z'),
        endAt: new Date('2099-05-01T10:00:00.000Z'),
        capacity: 10,
        longitude: null,
        latitude: null,
        locationRequired: false,
        radiusMeters: null,
        positions: [
          {
            id: 'position-b4',
            capacity: 5,
            locationRequired: null,
            radiusMeters: null,
          },
        ],
      },
    ],
  };
}

function legacyTemplateRow() {
  return {
    familyId: null,
    schemaVersion: null,
    definitionJson: null,
    definitionHash: null,
    defaultRegistrationModeCode: null,
  };
}

function makeServiceSubject(selectedTemplateVersionId: string | null) {
  const tx = {
    activity: {
      findFirst: jest.fn().mockResolvedValue(loadedActivity(selectedTemplateVersionId)),
    },
    organization: {
      findFirst: jest.fn().mockResolvedValue({ parentId: 'organization-parent', status: 'ACTIVE' }),
    },
    member: {
      findFirst: jest.fn().mockResolvedValue({ gradeCode: 'level-1', users: [{ id: 'user-b4' }] }),
    },
    activityTemplate: {
      findUnique: jest.fn().mockResolvedValue(legacyTemplateRow()),
      findFirst: jest.fn().mockResolvedValue(legacyTemplateRow()),
    },
    activityQualificationRuleSet: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const registrationForms = { currentTarget: jest.fn().mockResolvedValue(null) };
  const qualificationRules = { currentTarget: jest.fn().mockResolvedValue({ ruleSets: [] }) };
  const insuranceRequirements = { isEnforcementEnabled: jest.fn().mockReturnValue(true) };
  const service = new ActivityPublishReadinessService(
    prisma as never,
    registrationForms as never,
    qualificationRules as never,
    insuranceRequirements as never,
  );

  return {
    service,
    tx,
    prisma,
    registrationForms,
    qualificationRules,
    insuranceRequirements,
  };
}
