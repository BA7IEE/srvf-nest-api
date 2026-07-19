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
