import type { ConfigType } from '@nestjs/config';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import {
  type InsuranceEligibilityDecision,
  InsuranceRequirementService,
} from './insurance-requirement.service';

describe('InsuranceRequirementService evidence fail-closed validation', () => {
  function baseDecision(): InsuranceEligibilityDecision {
    return {
      requiredFrom: new Date('2099-07-01T00:00:00.000Z'),
      requiredThrough: new Date('2099-07-02T00:00:00.000Z'),
      source: {
        kind: 'member_insurance',
        memberId: 'member-1',
        memberInsuranceId: 'insurance-1',
        sourceRevision: 3,
        sourceReviewedByUserId: 'reviewer-1',
        sourceReviewedAt: new Date('2099-06-01T00:00:00.000Z'),
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
      },
    };
  }

  function makeHarness() {
    const evidence = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn<Promise<{ id: string }>, [{ data: Record<string, unknown> }]>()
        .mockResolvedValue({ id: 'evidence-1' }),
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'registration-1', memberId: 'member-1' }]),
      insuranceEligibilityEvidence: evidence,
    };
    const service = new InsuranceRequirementService(
      {} as PrismaService,
      { insurance: { enforcementEnabled: true } } as ConfigType<typeof appConfig>,
    );
    return { service, tx, evidence };
  }

  it.each([
    [
      'required interval reversed',
      (decision: InsuranceEligibilityDecision) => {
        decision.requiredFrom = new Date('2099-07-03T00:00:00.000Z');
      },
    ],
    [
      'coverage incomplete',
      (decision: InsuranceEligibilityDecision) => {
        decision.source.coverageEnd = new Date('2099-07-01T00:00:00.000Z');
      },
    ],
    [
      'source/member mismatch',
      (decision: InsuranceEligibilityDecision) => {
        decision.source.memberId = 'member-other';
      },
    ],
    [
      'self revision missing',
      (decision: InsuranceEligibilityDecision) => {
        (decision.source as { sourceRevision: number | null }).sourceRevision = null;
      },
    ],
    [
      'self reviewer missing',
      (decision: InsuranceEligibilityDecision) => {
        (decision.source as { sourceReviewedByUserId: string | null }).sourceReviewedByUserId =
          null;
      },
    ],
    [
      'self reviewedAt missing',
      (decision: InsuranceEligibilityDecision) => {
        (decision.source as { sourceReviewedAt: Date | null }).sourceReviewedAt = null;
      },
    ],
  ] as const)('%s produces zero evidence', async (_name, mutate) => {
    const { service, tx, evidence } = makeHarness();
    const decision = baseDecision();
    mutate(decision);

    await expect(
      service.createActivityRegistrationEvidence(
        'registration-1',
        'member-1',
        decision,
        tx as never,
      ),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect(evidence.findFirst).not.toHaveBeenCalled();
    expect(evidence.create).not.toHaveBeenCalled();
  });

  it('valid self decision writes exactly the minimal evidence shape', async () => {
    const { service, tx, evidence } = makeHarness();
    await service.createActivityRegistrationEvidence(
      'registration-1',
      'member-1',
      baseDecision(),
      tx as never,
    );

    expect(evidence.create).toHaveBeenCalledTimes(1);
    const data = evidence.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'activityRegistrationId',
        'memberInsuranceId',
        'ownerKind',
        'requiredFrom',
        'requiredThrough',
        'sourceCoverageEnd',
        'sourceCoverageStart',
        'sourceKind',
        'sourceReviewedAt',
        'sourceReviewedByUserId',
        'sourceRevision',
        'teamInsuranceCoverageId',
        'teamJoinApplicationId',
      ].sort(),
    );
  });
});

describe('InsuranceRequirementService activity lifecycle freeze', () => {
  const current = {
    id: 'activity-1',
    requiresInsurance: false,
    startAt: new Date('2099-07-01T00:00:00.000Z'),
    endAt: new Date('2099-07-02T00:00:00.000Z'),
  };

  function makeHarness(enabled: boolean) {
    const findFirst = jest.fn().mockResolvedValue(null);
    const tx = { activityRegistration: { findFirst } };
    const service = new InsuranceRequirementService(
      {} as PrismaService,
      { insurance: { enforcementEnabled: enabled } } as ConfigType<typeof appConfig>,
    );
    return { service, tx, findFirst };
  }

  it('gate=false: protected-value changes add zero registration queries', async () => {
    const { service, tx, findFirst } = makeHarness(false);

    await service.assertActivityInsuranceLifecycleMutable(
      current,
      { ...current, requiresInsurance: true },
      tx as never,
    );

    expect(findFirst).not.toHaveBeenCalled();
  });

  it('gate=true: false→false schedule change remains the legacy path with zero guard query', async () => {
    const { service, tx, findFirst } = makeHarness(true);

    await service.assertActivityInsuranceLifecycleMutable(
      current,
      { ...current, startAt: new Date('2099-07-01T01:00:00.000Z') },
      tx as never,
    );

    expect(findFirst).not.toHaveBeenCalled();
  });

  it('gate=true: semantically identical insured values add zero guard query', async () => {
    const { service, tx, findFirst } = makeHarness(true);
    const insured = { ...current, requiresInsurance: true };

    await service.assertActivityInsuranceLifecycleMutable(
      insured,
      {
        ...insured,
        startAt: new Date(insured.startAt),
        endAt: new Date(insured.endAt),
      },
      tx as never,
    );

    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['requiresInsurance false→true', current, { ...current, requiresInsurance: true }],
    ['requiresInsurance true→false', { ...current, requiresInsurance: true }, current],
    [
      'insured startAt change',
      { ...current, requiresInsurance: true },
      {
        ...current,
        requiresInsurance: true,
        startAt: new Date('2099-07-01T01:00:00.000Z'),
      },
    ],
    [
      'insured endAt change',
      { ...current, requiresInsurance: true },
      {
        ...current,
        requiresInsurance: true,
        endAt: new Date('2099-07-02T01:00:00.000Z'),
      },
    ],
  ] as const)(
    '%s with a live non-cancelled registration is rejected',
    async (_name, before, next) => {
      const { service, tx, findFirst } = makeHarness(true);
      findFirst.mockResolvedValue({ id: 'registration-1' });

      await expect(
        service.assertActivityInsuranceLifecycleMutable(before, next, tx as never),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          activityId: 'activity-1',
          deletedAt: null,
          statusCode: { not: 'cancelled' },
        },
        select: { id: true },
      });
    },
  );

  it('protected change is allowed when no live non-cancelled registration exists', async () => {
    const { service, tx, findFirst } = makeHarness(true);

    await service.assertActivityInsuranceLifecycleMutable(
      current,
      { ...current, requiresInsurance: true },
      tx as never,
    );

    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('InsuranceRequirementService approval evidence revalidation', () => {
  const activity = {
    requiresInsurance: true,
    startAt: new Date('2099-07-01T00:00:00.000Z'),
    endAt: new Date('2099-07-02T00:00:00.000Z'),
  };
  const registration = { id: 'registration-1', memberId: 'member-1' };
  const selfEvidence = {
    id: 'evidence-1',
    sourceKind: 'member_insurance',
    memberInsuranceId: 'insurance-1',
    teamInsuranceCoverageId: null,
    ownerKind: 'activity_registration',
    activityRegistrationId: 'registration-1',
    teamJoinApplicationId: null,
    sourceRevision: 3,
    sourceReviewedByUserId: 'reviewer-1',
    sourceReviewedAt: new Date('2099-06-01T00:00:00.000Z'),
    requiredFrom: new Date('2099-07-01T00:00:00.000Z'),
    requiredThrough: new Date('2099-07-02T00:00:00.000Z'),
    sourceCoverageStart: new Date('2099-01-01T00:00:00.000Z'),
    sourceCoverageEnd: new Date('2099-12-31T00:00:00.000Z'),
    activityRegistration: {
      id: 'registration-1',
      memberId: 'member-1',
      deletedAt: null,
    },
  };

  function makeHarness(enabled = true) {
    const findMany = jest.fn().mockResolvedValue([selfEvidence]);
    const $queryRaw = jest.fn();
    const tx = {
      insuranceEligibilityEvidence: { findMany },
      $queryRaw,
    };
    const service = new InsuranceRequirementService(
      {} as PrismaService,
      { insurance: { enforcementEnabled: enabled } } as ConfigType<typeof appConfig>,
    );
    return { service, tx, findMany, $queryRaw };
  }

  function sqlText(call: unknown): string {
    const args = call as [{ strings?: string[] }];
    return (args[0]?.strings ?? []).join(' ');
  }

  it.each([
    ['gate disabled', false, activity],
    ['activity does not require insurance', true, { ...activity, requiresInsurance: false }],
  ] as const)('%s adds zero evidence/source queries', async (_name, enabled, testedActivity) => {
    const { service, tx, findMany, $queryRaw } = makeHarness(enabled);

    await service.revalidateActivityRegistrationApproval(registration, testedActivity, tx as never);

    expect(findMany).not.toHaveBeenCalled();
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['missing evidence', []],
    ['duplicate evidence', [selfEvidence, { ...selfEvidence, id: 'evidence-2' }]],
  ] as const)('%s fails before source locks', async (_name, evidences) => {
    const { service, tx, findMany, $queryRaw } = makeHarness();
    findMany.mockResolvedValue(evidences);

    await expect(
      service.revalidateActivityRegistrationApproval(registration, activity, tx as never),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    [
      'owner member mismatch',
      { activityRegistration: { ...selfEvidence.activityRegistration, memberId: 'member-2' } },
    ],
    ['required interval mismatch', { requiredThrough: new Date('2099-07-03T00:00:00.000Z') }],
    ['self revision missing', { sourceRevision: null }],
    ['self reviewer missing', { sourceReviewedByUserId: null }],
    ['self reviewedAt missing', { sourceReviewedAt: null }],
  ] as const)('%s fails closed before locking a source', async (_name, override) => {
    const { service, tx, findMany, $queryRaw } = makeHarness();
    findMany.mockResolvedValue([{ ...selfEvidence, ...override }]);

    await expect(
      service.revalidateActivityRegistrationApproval(registration, activity, tx as never),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('self evidence locks Member then the exact reviewed source snapshot', async () => {
    const { service, tx, $queryRaw } = makeHarness();
    $queryRaw.mockResolvedValueOnce([{ id: 'member-1' }]).mockResolvedValueOnce([
      {
        id: 'insurance-1',
        memberId: 'member-1',
        coverageStart: selfEvidence.sourceCoverageStart,
        coverageEnd: selfEvidence.sourceCoverageEnd,
        version: 3,
        reviewedByUserId: 'reviewer-1',
        reviewedAt: selfEvidence.sourceReviewedAt,
      },
    ]);

    await service.revalidateActivityRegistrationApproval(registration, activity, tx as never);

    expect($queryRaw).toHaveBeenCalledTimes(2);
    const memberSql = sqlText($queryRaw.mock.calls[0]);
    expect(memberSql).toContain('FROM "Member"');
    expect(memberSql).toContain('FOR SHARE');
    const sourceSql = sqlText($queryRaw.mock.calls[1]);
    expect(sourceSql).toContain('FROM "member_insurances"');
    expect(sourceSql).toContain('"version" =');
    expect(sourceSql).toContain('"reviewedByUserId" =');
    expect(sourceSql).toContain('"reviewedAt" =');
    expect(sourceSql).toContain('"coverageStart" IS NOT DISTINCT FROM');
    expect(sourceSql).toContain('"coverageEnd" =');
    expect(sourceSql).toContain('FOR SHARE');
  });

  it('inactive/deleted member rejects before the self source can be used', async () => {
    const { service, tx, $queryRaw } = makeHarness();
    $queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.revalidateActivityRegistrationApproval(registration, activity, tx as never),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('lost exact self source rejects without falling back to another source', async () => {
    const { service, tx, $queryRaw } = makeHarness();
    $queryRaw.mockResolvedValueOnce([{ id: 'member-1' }]).mockResolvedValueOnce([]);

    await expect(
      service.revalidateActivityRegistrationApproval(registration, activity, tx as never),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('team evidence locks exact Policy → Coverage → Member and never selects an alternative', async () => {
    const { service, tx, findMany, $queryRaw } = makeHarness();
    const alternativeSelection = jest.spyOn(
      service as unknown as {
        lockEligibilitySource: (...args: unknown[]) => Promise<unknown>;
      },
      'lockEligibilitySource',
    );
    const teamEvidence = {
      ...selfEvidence,
      sourceKind: 'team_insurance_coverage',
      memberInsuranceId: null,
      teamInsuranceCoverageId: 'coverage-1',
      sourceRevision: null,
      sourceReviewedByUserId: null,
      sourceReviewedAt: null,
    };
    findMany.mockResolvedValue([teamEvidence]);
    $queryRaw
      .mockResolvedValueOnce([{ policyId: 'policy-1', coverageId: 'coverage-1' }])
      .mockResolvedValueOnce([
        {
          id: 'policy-1',
          coverageStart: teamEvidence.sourceCoverageStart,
          coverageEnd: teamEvidence.sourceCoverageEnd,
        },
      ])
      .mockResolvedValueOnce([{ id: 'coverage-1', memberId: 'member-1' }])
      .mockResolvedValueOnce([{ id: 'member-1' }]);

    await service.revalidateActivityRegistrationApproval(registration, activity, tx as never);

    expect($queryRaw).toHaveBeenCalledTimes(4);
    const candidateSql = sqlText($queryRaw.mock.calls[0]);
    expect(candidateSql).toContain('FROM "team_insurance_coverages"');
    expect(candidateSql).toContain('WHERE "id" =');
    expect(candidateSql).not.toContain('ORDER BY');
    const policySql = sqlText($queryRaw.mock.calls[1]);
    expect(policySql).toContain('FROM "team_insurance_policies"');
    expect(policySql).toContain('FOR SHARE');
    const coverageSql = sqlText($queryRaw.mock.calls[2]);
    expect(coverageSql).toContain('FROM "team_insurance_coverages"');
    expect(coverageSql).toContain('FOR SHARE');
    const memberSql = sqlText($queryRaw.mock.calls[3]);
    expect(memberSql).toContain('FROM "Member"');
    expect(memberSql).toContain('FOR SHARE');
    expect(alternativeSelection).not.toHaveBeenCalled();
  });

  it('team source snapshot mismatch rejects before Coverage/Member and does not fall back', async () => {
    const { service, tx, findMany, $queryRaw } = makeHarness();
    findMany.mockResolvedValue([
      {
        ...selfEvidence,
        sourceKind: 'team_insurance_coverage',
        memberInsuranceId: null,
        teamInsuranceCoverageId: 'coverage-1',
        sourceRevision: null,
        sourceReviewedByUserId: null,
        sourceReviewedAt: null,
      },
    ]);
    $queryRaw
      .mockResolvedValueOnce([{ policyId: 'policy-1', coverageId: 'coverage-1' }])
      .mockResolvedValueOnce([]);

    await expect(
      service.revalidateActivityRegistrationApproval(registration, activity, tx as never),
    ).rejects.toEqual(new BizException(BizCode.INSURANCE_REQUIRED));
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });
});
