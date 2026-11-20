import { materializeActivityTemplateTimePolicySelection } from './activity-template-definition-v4';
import { createActivityTimePolicySelectionDocument } from './activity-time-policy-selection';
import {
  createActivityContributionPolicySelectionDocument,
  emptyActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import {
  matchesSimpleReviewProfile,
  type SimpleReviewFacts,
  type SimpleReviewTemplate,
} from './activity-simple-review-profile';

function fixture(): { template: SimpleReviewTemplate; facts: SimpleReviewFacts } {
  const template: SimpleReviewTemplate = {
    activity: {
      allocationModeCode: 'first_come',
      requiresInsurance: true,
      archiveWaitingDays: 0,
      isPublicRegistration: false,
      defaultLocationRequired: false,
    },
    sessions: [
      {
        code: 'main',
        name: '场次',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: '蓝图地点',
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 20,
        checkOutOpenOffsetMinutes: -20,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 5,
        earlyLeaveThresholdMinutes: 6,
        sortOrder: 3,
        positions: [
          {
            code: 'volunteer',
            name: '岗位',
            attendanceRoleCode: 'volunteer',
            description: '模板职责',
            equipmentNotes: '模板装备',
            locationRequired: false,
            sortOrder: 4,
          },
        ],
      },
    ],
    registrationForm: null,
    metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
  };
  const facts: SimpleReviewFacts = {
    activity: {
      title: '本次活动',
      activityTypeCode: 'training',
      allocationModeCode: 'first_come',
      organizationId: 'org1',
      startAt: '2099-01-01T00:00:00.000Z',
      endAt: '2099-01-01T02:00:00.000Z',
      location: '本次地点',
      description: '本次说明',
      capacity: 2,
      genderRequirementCode: null,
      registrationDeadline: null,
      registrationNotes: null,
      isPublicRegistration: false,
      requiresInsurance: true,
      registrationSchema: null,
      coverImageUrl: null,
      galleryImageUrls: null,
      content: null,
      locationLongitude: null,
      locationLatitude: null,
      registrationModeCode: null,
      visibilityCode: null,
      defaultCheckInRadiusMeters: null,
      defaultLocationRequired: false,
      archiveWaitingDays: 0,
    },
    sessions: [
      {
        sessionId: 's1',
        clientRef: null,
        code: 'main',
        name: '场次',
        startAt: '2099-01-01T00:00:00.000Z',
        endAt: '2099-01-01T02:00:00.000Z',
        locationText: '本次地点',
        meetingPoint: null,
        executionPoint: null,
        evacuationPoint: null,
        longitude: null,
        latitude: null,
        capacity: 2,
        checkInOpenAt: '2099-01-01T00:00:00.000Z',
        checkInCloseAt: '2099-01-01T00:20:00.000Z',
        checkOutOpenAt: '2099-01-01T01:40:00.000Z',
        checkOutCloseAt: '2099-01-01T02:00:00.000Z',
        preparationStartAt: null,
        locationRequired: false,
        radiusMeters: null,
        locationPolicySourceCode: 'template',
        accuracyWarningMeters: 100,
        lateGraceMinutes: 5,
        earlyLeaveThresholdMinutes: 6,
        statusCode: 'scheduled',
        sortOrder: 3,
        positions: [
          {
            positionId: 'p1',
            clientRef: null,
            code: 'volunteer',
            name: '岗位',
            attendanceRoleCode: 'volunteer',
            capacity: 2,
            startAt: null,
            endAt: null,
            genderRequirementCode: null,
            qualificationRuleSetId: null,
            locationRequired: false,
            radiusMeters: null,
            leaderMemberId: null,
            description: '模板职责',
            equipmentNotes: '模板装备',
            sortOrder: 4,
            cancelled: false,
          },
        ],
      },
    ],
    registrationForm: null,
    qualificationRuleSets: { ruleSets: [] },
    metricRequirementCode: 'not_required',
    metricSetPointer: null,
    timePolicyPointers: null,
    contributionPolicyPointers: null,
  };
  return { template, facts };
}

// Each professional field is varied alone; grouped HTTP tests must not mask omissions here.
const activityChanges = [
  ['genderRequirementCode', 'female'],
  ['isPublicRegistration', true],
  ['requiresInsurance', false],
  ['registrationSchema', {}],
  ['content', {}],
  ['locationLongitude', '120'],
  ['locationLatitude', '30'],
  ['registrationModeCode', 'invitation_only'],
  ['visibilityCode', 'invitation'],
  ['defaultCheckInRadiusMeters', 250],
  ['defaultLocationRequired', true],
  ['archiveWaitingDays', 7],
] as const;
const sessionChanges = [
  ['locationText', '另一个地点'],
  ['meetingPoint', '集合'],
  ['executionPoint', '执行'],
  ['evacuationPoint', '撤离'],
  ['longitude', '120'],
  ['latitude', '30'],
  ['locationRequired', true],
  ['radiusMeters', 250],
  ['locationPolicySourceCode', 'session'],
  ['accuracyWarningMeters', 50],
  ['lateGraceMinutes', 12],
  ['earlyLeaveThresholdMinutes', 13],
  ['sortOrder', 9],
] as const;
const positionChanges = [
  ['genderRequirementCode', 'female'],
  ['locationRequired', true],
  ['radiusMeters', 250],
  ['leaderMemberId', 'member1'],
  ['description', '新增职责'],
  ['equipmentNotes', '新增装备'],
  ['sortOrder', 9],
] as const;

describe('simple review profile field/default matrix', () => {
  it('accepts exact template defaults including false, zero and nonempty instructions', () => {
    const { template, facts } = fixture();
    expect(matchesSimpleReviewProfile(facts, template)).toBe(true);
  });
  it.each(activityChanges)('rejects the individual hidden activity change %s', (field, value) => {
    const { template, facts } = fixture();
    Object.assign(facts.activity, { [field]: value });
    expect(matchesSimpleReviewProfile(facts, template)).toBe(false);
  });
  it.each(sessionChanges)('rejects the individual hidden session change %s', (field, value) => {
    const { template, facts } = fixture();
    Object.assign(facts.sessions[0], { [field]: value });
    expect(matchesSimpleReviewProfile(facts, template)).toBe(false);
  });
  it.each(positionChanges)('rejects the individual hidden position change %s', (field, value) => {
    const { template, facts } = fixture();
    Object.assign(facts.sessions[0].positions[0], { [field]: value });
    expect(matchesSimpleReviewProfile(facts, template)).toBe(false);
  });
  it('permits the visible instance fields; this check supplements the existing shape/hash guards', () => {
    const { template, facts } = fixture();
    facts.activity.title = '新的已展示标题';
    facts.activity.description = '新的已展示说明';
    facts.sessions[0].name = '新的已展示场次名';
    facts.sessions[0].positions[0].name = '新的已展示岗位名';
    expect(matchesSimpleReviewProfile(facts, template)).toBe(true);
  });
});

describe('simple review profile referenced defaults', () => {
  it('accepts an exact template form and rejects an added or altered form', () => {
    const { template, facts } = fixture();
    const definition = {
      fields: [
        {
          fieldCode: 'extra',
          typeCode: 'short_text' as const,
          label: '模板题',
          helpText: null,
          required: true,
          visibilityCode: 'self_only' as const,
          exportable: false,
          sortOrder: 0,
          minValue: null,
          maxValue: null,
          minLength: null,
          maxLength: null,
          maxSelections: null,
          options: null,
        },
      ],
    };
    facts.registrationForm = { definition, schemaHash: 'a'.repeat(64) };
    expect(matchesSimpleReviewProfile(facts, template)).toBe(false);
    const governedTemplate = { ...template, registrationForm: structuredClone(definition) };
    expect(matchesSimpleReviewProfile(facts, governedTemplate)).toBe(true);
    facts.registrationForm.definition.fields[0].label = '另加的题目';
    expect(matchesSimpleReviewProfile(facts, governedTemplate)).toBe(false);
  });
  it('binds metric requirements and exact version pointer to the template', () => {
    const { template, facts } = fixture();
    const pointer = {
      id: 'set1',
      code: 'metric_set',
      version: 1,
      schemaVersion: 1 as const,
      definitionHash: 'a'.repeat(64),
    };
    const selected = {
      ...template,
      metricSelection: { metricRequirementCode: 'required' as const, metricSetPointer: pointer },
    };
    const current = {
      ...facts,
      metricRequirementCode: 'required' as const,
      metricSetPointer: { ...pointer },
    };
    expect(matchesSimpleReviewProfile(current, selected)).toBe(true);
    current.metricSetPointer = { ...pointer, definitionHash: 'b'.repeat(64) };
    expect(matchesSimpleReviewProfile(current, selected)).toBe(false);
  });
});

describe('simple review profile policy scope defaults', () => {
  it('accepts template time selection but rejects a new activity override, even of the same policy', () => {
    const { template, facts } = fixture();
    const pointer = {
      policyId: 'time_policy',
      versionId: 'time_version',
      definitionHash: 'a'.repeat(64),
    };
    const defaultSelection = { mode: 'explicit' as const, pointer };
    const selected = {
      ...template,
      timePolicySelection: {
        default: defaultSelection,
        sessionOverrides: [],
        positionOverrides: [],
      },
    };
    const selection = materializeActivityTemplateTimePolicySelection(selected.timePolicySelection, [
      { id: 's1', code: 'main', positions: [{ id: 'p1', code: 'volunteer' }] },
    ]);
    const current = {
      ...facts,
      timePolicyPointers: {
        schemaVersion: 1 as const,
        selectionRevision: 1,
        proposalSelectionHash: 'a'.repeat(64),
        selection,
        resolved: [],
        referenceKinds: {},
      },
    };
    expect(matchesSimpleReviewProfile(current, selected)).toBe(true);
    current.timePolicyPointers.selection = createActivityTimePolicySelectionDocument(
      [
        {
          scope: { layerCode: 'template', sessionId: null, positionId: null },
          selection: defaultSelection,
        },
        {
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          selection: defaultSelection,
        },
      ],
      { allowTemplate: true },
    );
    expect(matchesSimpleReviewProfile(current, selected)).toBe(false);
  });
  it('retains contribution template defaults but rejects an explicit activity override', () => {
    const { template, facts } = fixture();
    const defaultSelection = {
      mode: 'explicit' as const,
      pointer: {
        policyId: 'contribution_policy',
        versionId: 'contribution_version',
        definitionHash: 'b'.repeat(64),
        evaluatorVersion: 1 as const,
      },
    };
    const selected = {
      ...template,
      contributionPolicySelection: { activityDefault: defaultSelection, positionOverrides: [] },
    };
    const current = {
      ...facts,
      contributionPolicyPointers: {
        schemaVersion: 1 as const,
        selectionRevision: 1,
        proposalSelectionHash: 'a'.repeat(64),
        selection: emptyActivityContributionPolicySelectionDocument(),
        resolved: [],
        referenceKinds: {},
      },
    };
    expect(matchesSimpleReviewProfile(current, selected)).toBe(true);
    current.contributionPolicyPointers.selection =
      createActivityContributionPolicySelectionDocument([
        {
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          selection: defaultSelection,
        },
      ]);
    expect(matchesSimpleReviewProfile(current, selected)).toBe(false);
  });
});
