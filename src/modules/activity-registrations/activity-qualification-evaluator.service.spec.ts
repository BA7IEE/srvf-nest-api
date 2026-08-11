import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CertificateQualificationFacts } from '../certificates/certificate-qualification.service';
import type { MemberQualificationFacts } from '../member-profiles/member-qualification-facts.service';
import {
  ActivityQualificationEvaluatorService,
  type ActivityQualificationTarget,
} from './activity-qualification-evaluator.service';

const ACTIVITY = {
  id: 'activity-1',
  startAt: new Date('2199-08-11T08:00:00.000Z'),
  endAt: new Date('2199-08-12T18:00:00.000Z'),
};

type RuleOverrides = Partial<{
  id: string;
  ruleTypeCode: string;
  enforcementCode: string;
  operator: string;
  valueJson: unknown;
  warnScore: number | null;
  message: string | null;
  sortOrder: number;
}>;

function rule(overrides: RuleOverrides = {}) {
  return {
    id: 'rule-' + (overrides.id ?? 'grade'),
    ruleTypeCode: 'grade',
    enforcementCode: 'block',
    operator: 'in',
    valueJson: { codes: ['L1'] },
    warnScore: null,
    message: '资格条件未满足',
    sortOrder: 1,
    ...overrides,
  };
}

function ruleSet(
  id: string,
  scope: { sessionId?: string | null; positionId?: string | null } = {},
  rules = [rule()],
) {
  return {
    id,
    version: 1,
    sessionId: scope.sessionId ?? null,
    positionId: scope.positionId ?? null,
    rules,
  };
}

function defaultFacts(overrides: Partial<MemberQualificationFacts> = {}): MemberQualificationFacts {
  return {
    memberId: 'member-1',
    gradeCode: 'L1',
    profile: {
      genderCode: 'female',
      birthDate: new Date('2181-08-11T00:00:00.000Z'),
    },
    activeOrganizationIds: ['team-a'],
    activeOrganizationAncestorIds: ['division-a', 'root'],
    ...overrides,
  };
}

function defaultCertificates(
  overrides: Partial<CertificateQualificationFacts> = {},
): CertificateQualificationFacts {
  return {
    coveringCertificates: [
      {
        certificateId: 'cert-1',
        standardId: 'standard-a',
        issuedAt: new Date('2199-01-01T00:00:00.000Z'),
        expiredAt: null,
      },
    ],
    coveringStandardIds: ['standard-a'],
    ...overrides,
  };
}

function expectBizCode(fn: () => Promise<unknown>, code: number): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected BizCode ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz.code).toBe(code);
    },
  );
}

function makeHarness(input: {
  ruleSets: ReturnType<typeof ruleSet>[];
  facts?: MemberQualificationFacts;
  certificates?: CertificateQualificationFacts;
  insured?: boolean;
  positionRows?: Array<{ id: string; sessionId: string; qualificationRuleSetId: string | null }>;
}) {
  const facts = input.facts ?? defaultFacts();
  const certificates = input.certificates ?? defaultCertificates();
  const positionRows =
    input.positionRows ??
    input.ruleSets
      .filter((candidate) => candidate.positionId !== null)
      .map((candidate) => ({
        id: candidate.positionId!,
        sessionId: candidate.sessionId!,
        qualificationRuleSetId: candidate.id,
      }));
  const sessionIds = [
    ...new Set(
      input.ruleSets.flatMap((candidate) => (candidate.sessionId ? [candidate.sessionId] : [])),
    ),
  ];
  const tx = {
    activityQualificationRuleSet: {
      findMany: jest.fn().mockResolvedValue(input.ruleSets),
    },
    activitySession: {
      findMany: jest.fn().mockImplementation((args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args.where?.id?.in ?? sessionIds;
        return Promise.resolve(ids.filter((id) => sessionIds.includes(id)).map((id) => ({ id })));
      }),
    },
    activitySessionPosition: {
      findMany: jest.fn().mockImplementation((args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args.where?.id?.in;
        return Promise.resolve(
          ids ? positionRows.filter((row) => ids.includes(row.id)) : positionRows,
        );
      }),
    },
    qualificationEvaluationSnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
    },
  };
  const memberFacts = {
    readForQualification: jest.fn().mockResolvedValue(facts),
    hasActiveMembershipInRequiredSubtree: jest.fn(
      (current: MemberQualificationFacts, requiredOrganizationIds: readonly string[]) =>
        current.activeOrganizationIds.some((id) => requiredOrganizationIds.includes(id)) ||
        current.activeOrganizationAncestorIds.some((id) => requiredOrganizationIds.includes(id)),
    ),
  };
  const certificateFacts = {
    readCoveringFacts: jest.fn().mockResolvedValue(certificates),
    hasAnyCoveringStandard: jest.fn(
      (current: CertificateQualificationFacts, standardIds: readonly string[]) =>
        standardIds.some((id) => current.coveringStandardIds.includes(id)),
    ),
  };
  const insuranceRequirement = {
    isMemberInsuredForActivity: jest.fn().mockResolvedValue(input.insured ?? true),
  };
  return {
    service: new ActivityQualificationEvaluatorService(
      memberFacts as never,
      certificateFacts as never,
      insuranceRequirement as never,
    ),
    tx,
    memberFacts,
    certificateFacts,
    insuranceRequirement,
  };
}

async function evaluate(
  service: ActivityQualificationEvaluatorService,
  tx: ReturnType<typeof makeHarness>['tx'],
  targets: readonly ActivityQualificationTarget[] = [],
) {
  return service.evaluate({ activity: ACTIVITY, memberId: 'member-1', targets, tx: tx as never });
}

describe('ActivityQualificationEvaluatorService', () => {
  it('evaluates all seven frozen D83 rule types through their owner fact ports', async () => {
    const harness = makeHarness({
      ruleSets: [
        ruleSet('rules-activity', {}, [
          rule({ id: 'grade', valueJson: { codes: ['L0', 'L1'] } }),
          rule({ id: 'gender', ruleTypeCode: 'gender', valueJson: { codes: ['female'] } }),
          rule({
            id: 'organization',
            ruleTypeCode: 'organization',
            operator: 'in_subtree',
            valueJson: { organizationIds: ['division-a'] },
          }),
          rule({
            id: 'certificate',
            ruleTypeCode: 'certificate',
            operator: 'has_any',
            valueJson: { standardIds: ['standard-a'] },
          }),
          rule({
            id: 'training',
            ruleTypeCode: 'training',
            operator: 'has_any',
            valueJson: { standardIds: ['standard-a'] },
          }),
          rule({
            id: 'age',
            ruleTypeCode: 'age',
            operator: 'between',
            valueJson: { minYears: 18, maxYears: 18 },
          }),
          rule({
            id: 'insurance',
            ruleTypeCode: 'insurance',
            operator: 'covers_activity',
            valueJson: null,
          }),
        ]),
      ],
    });

    const result = await evaluate(harness.service, harness.tx);

    expect(result.resultCode).toBe('pass');
    expect(result.activity).toEqual({ resultCode: 'pass', unmetRules: [] });
    expect(harness.memberFacts.readForQualification).toHaveBeenCalledTimes(1);
    expect(harness.certificateFacts.readCoveringFacts).toHaveBeenCalledTimes(1);
    expect(harness.insuranceRequirement.isMemberInsuredForActivity).toHaveBeenCalledTimes(1);
  });

  it('keeps AND across rules and inheritance: a lower-scope pass cannot overwrite an activity fail', async () => {
    const harness = makeHarness({
      ruleSets: [
        ruleSet('rules-activity', {}, [
          rule({ id: 'activity-block', valueJson: { codes: ['L2'] } }),
        ]),
        ruleSet('rules-session', { sessionId: 'session-1' }, [
          rule({
            id: 'session-warn',
            ruleTypeCode: 'gender',
            enforcementCode: 'warn',
            valueJson: { codes: ['male'] },
            warnScore: 20,
          }),
        ]),
        ruleSet('rules-position', { sessionId: 'session-1', positionId: 'position-1' }, [
          rule({
            id: 'position-pass',
            ruleTypeCode: 'certificate',
            operator: 'has_any',
            valueJson: { standardIds: ['standard-a'] },
          }),
        ]),
      ],
    });

    const result = await evaluate(harness.service, harness.tx, [
      { sessionId: 'session-1', positionId: 'position-1' },
    ]);

    expect(result.activity.resultCode).toBe('fail');
    expect(result.sessions.get('session-1')).toMatchObject({ resultCode: 'fail' });
    expect(result.positions.get('position-1')).toMatchObject({ resultCode: 'fail' });
    expect(result.positions.get('position-1')?.unmetRules).toEqual([
      expect.objectContaining({ ruleId: 'activity-block', resultCode: 'fail' }),
      expect.objectContaining({ ruleId: 'session-warn', resultCode: 'warn', warnScore: 20 }),
    ]);
    expect(() => harness.service.assertNoBlock(result)).toThrow(BizException);
  });

  it('uses the activity Beijing start date for the age boundary', async () => {
    const harness = makeHarness({
      ruleSets: [
        ruleSet('rules-age', {}, [
          rule({
            id: 'age-boundary',
            ruleTypeCode: 'age',
            operator: 'between',
            valueJson: { minYears: 18, maxYears: 18 },
          }),
        ]),
      ],
    });

    await expect(evaluate(harness.service, harness.tx)).resolves.toMatchObject({
      resultCode: 'pass',
    });
  });

  it('fails closed for a non-D83 wire alias and for active scope drift', async () => {
    const aliasHarness = makeHarness({
      ruleSets: [ruleSet('rules-alias', {}, [rule({ operator: 'contains_any' })])],
    });
    await expectBizCode(
      () => evaluate(aliasHarness.service, aliasHarness.tx),
      BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID.code,
    );

    const driftHarness = makeHarness({
      ruleSets: [ruleSet('rules-position', { sessionId: 'session-1', positionId: 'position-1' })],
      positionRows: [
        { id: 'position-1', sessionId: 'session-1', qualificationRuleSetId: 'different-ruleset' },
      ],
    });
    await expectBizCode(
      () =>
        evaluate(driftHarness.service, driftHarness.tx, [
          { sessionId: 'session-1', positionId: 'position-1' },
        ]),
      BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID.code,
    );
  });

  it('writes safe immutable snapshots once per applicable RuleSet with stable fact hashes', async () => {
    const harness = makeHarness({
      ruleSets: [
        ruleSet('rules-activity', {}, [rule({ id: 'grade', valueJson: { codes: ['L1'] } })]),
        ruleSet('rules-session', { sessionId: 'session-1' }, [
          rule({ id: 'session-grade', valueJson: { codes: ['L1'] } }),
        ]),
      ],
    });
    const first = await evaluate(harness.service, harness.tx, [
      { sessionId: 'session-1', positionId: null },
    ]);
    const second = await evaluate(harness.service, harness.tx, [
      { sessionId: 'session-1', positionId: null },
    ]);

    expect(first.snapshotCandidates.map((candidate) => candidate.inputFactsHash)).toEqual(
      second.snapshotCandidates.map((candidate) => candidate.inputFactsHash),
    );
    await harness.service.appendSnapshots({
      evaluation: first,
      phase: 'display',
      registrationRevisionId: null,
      tx: harness.tx as never,
    });
    expect(harness.tx.qualificationEvaluationSnapshot.create).toHaveBeenCalledTimes(2);
    const createCalls = harness.tx.qualificationEvaluationSnapshot.create.mock
      .calls as unknown as Array<
      [
        {
          data: {
            identityId: string | null;
            registrationRevisionId: string | null;
            evaluationPhaseCode: string;
            detailsJson: {
              schemaVersion: number;
              ruleSetVersionId: string;
              rules: Array<{ ruleId: string; resultCode: string }>;
            };
          };
        },
      ]
    >;
    const displayData = createCalls[0]?.[0]?.data;
    if (!displayData) throw new Error('expected display snapshot write');
    expect(displayData).toMatchObject({
      identityId: null,
      registrationRevisionId: null,
      evaluationPhaseCode: 'display',
      detailsJson: {
        schemaVersion: 1,
        ruleSetVersionId: 'rules-activity',
        rules: [{ ruleId: 'grade', resultCode: 'pass' }],
      },
    });
    expect(JSON.stringify(displayData.detailsJson)).not.toContain('L1');
    expect(JSON.stringify(displayData.detailsJson)).not.toContain('female');
    expect(JSON.stringify(displayData.detailsJson)).not.toContain('2181');

    harness.memberFacts.readForQualification.mockResolvedValue(defaultFacts({ gradeCode: 'L2' }));
    const changed = await evaluate(harness.service, harness.tx, [
      { sessionId: 'session-1', positionId: null },
    ]);
    expect(changed.snapshotCandidates.map((candidate) => candidate.inputFactsHash)).not.toEqual(
      first.snapshotCandidates.map((candidate) => candidate.inputFactsHash),
    );
  });

  it('does not append any snapshot when the aggregate qualification result is fail', async () => {
    const harness = makeHarness({
      ruleSets: [
        ruleSet('rules-activity', {}, [
          rule({ id: 'activity-block', valueJson: { codes: ['L2'] } }),
        ]),
      ],
    });

    const evaluation = await evaluate(harness.service, harness.tx);
    expect(evaluation.resultCode).toBe('fail');
    expect(evaluation.snapshotCandidates).toHaveLength(1);
    expect(evaluation.snapshotCandidates[0]?.inputFactsHash).toMatch(/^[a-f0-9]{64}$/);

    await harness.service.appendSnapshots({
      evaluation,
      phase: 'display',
      registrationRevisionId: null,
      tx: harness.tx as never,
    });

    expect(harness.tx.qualificationEvaluationSnapshot.create).not.toHaveBeenCalled();
  });
});
