import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { ActivityPublishProposalV2Service } from './activity-publish-proposal-v2.service';
import { ActivityPublishReviewPolicyQueryService } from './activity-publish-review-policy-query.service';
import { ActivityPublishReviewReferencedPoliciesQueryDto } from './activity-publish-review-policy.dto';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';

const user: CurrentUserPayload = {
  id: 'reviewer_user',
  username: 'reviewer_user',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const timeFingerprint = fingerprintTimePolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  effectiveFrom: '2098-01-01T00:00:00.000Z',
  effectiveUntil: '2101-01-01T00:00:00.000Z',
  definition: {
    defaultCategory: 'volunteer_service',
    roleMappings: [],
    allowSplit: false,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'exclude' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 1 },
    evidence: { requiredSources: [], requireManualRecognition: false },
    manualAdjustment: { enabled: false },
  },
});
const contributionFingerprint = fingerprintContributionPolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  effectiveFrom: '2098-01-01T00:00:00.000Z',
  effectiveUntil: null,
  definition: {
    defaultResult: { recognizedPoints: '1.25', explanationCode: 'review_default' },
    roleRules: [],
  },
});

function version(kind: 'time' | 'contribution', suffix = '') {
  const value = kind === 'time' ? timeFingerprint : contributionFingerprint;
  return {
    id: `${kind}_version${suffix}`,
    policyId: `${kind}_policy${suffix}`,
    version: 1,
    schemaVersion: value.schemaVersion,
    evaluatorVersion: value.evaluatorVersion,
    definitionHash: value.definitionHash,
    definitionJson: value.definition,
    effectiveFrom: new Date(value.effectiveFrom),
    effectiveUntil: value.effectiveUntil === null ? null : new Date(value.effectiveUntil),
    statusCode: 'active',
  };
}
function pointer(row: ReturnType<typeof version>, contribution = false) {
  return {
    policyId: row.policyId,
    versionId: row.id,
    definitionHash: row.definitionHash,
    ...(contribution ? { evaluatorVersion: row.evaluatorVersion } : {}),
  };
}
function pointers(row: ReturnType<typeof version>, contribution = false) {
  const p = pointer(row, contribution);
  return {
    selection: { items: { root: { selection: { mode: 'explicit', pointer: p } } } },
    resolved: [
      {
        pointer: p,
        evaluatorVersion: 1,
        effectiveFrom: contribution ? row.effectiveFrom.toISOString() : '2099-09-01T00:00:00.000Z',
        effectiveUntil: contribution
          ? (row.effectiveUntil?.toISOString() ?? null)
          : '2099-09-01T02:00:00.000Z',
      },
    ],
  };
}

/** Isolates read orchestration; the unchanged real snapshot parser and database suite
 * exercise the complete envelope/hash grammar separately. No SQL/auth method is mocked in E2E. */
describe('review-referenced policy read boundary', () => {
  const time = version('time'),
    contribution = version('contribution');
  let service: ActivityPublishReviewPolicyQueryService;
  let tx: {
    activityPublishReview: { findUnique: jest.Mock };
    timePolicyVersion: { findMany: jest.Mock };
    contributionPolicyVersion: { findMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let authz: { explain: jest.Mock };
  let proposals: { parseSnapshot: jest.Mock };
  let snapshot: {
    schemaVersion: number;
    snapshotHash: string;
    baseWorkflowRevision: number;
    base: {
      timePolicyPointers: ReturnType<typeof pointers> | null;
      contributionPolicyPointers: ReturnType<typeof pointers> | null;
    };
    timePolicyPointers: ReturnType<typeof pointers> | null;
    contributionPolicyPointers: ReturnType<typeof pointers> | null;
  };

  beforeEach(async () => {
    snapshot = {
      schemaVersion: 9,
      snapshotHash: 'a'.repeat(64),
      baseWorkflowRevision: 2,
      base: {
        timePolicyPointers: pointers(time),
        contributionPolicyPointers: pointers(contribution, true),
      },
      timePolicyPointers: pointers(time),
      contributionPolicyPointers: pointers(contribution, true),
    };
    tx = {
      activityPublishReview: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'review_123',
          activityId: 'activity_123',
          baseRevision: 2,
          snapshot,
        }),
      },
      timePolicyVersion: { findMany: jest.fn().mockResolvedValue([{ ...time }]) },
      contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue([{ ...contribution }]) },
    };
    prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx))),
    };
    authz = { explain: jest.fn().mockResolvedValue({ allow: true }) };
    proposals = { parseSnapshot: jest.fn().mockImplementation(() => snapshot) };
    const module = await Test.createTestingModule({
      providers: [
        ActivityPublishReviewPolicyQueryService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthzService, useValue: authz },
        { provide: ActivityPublishProposalV2Service, useValue: proposals },
      ],
    }).compile();
    service = module.get(ActivityPublishReviewPolicyQueryService);
  });

  it('uses only review-read authorization in one repeatable-read snapshot and exposes complete hashed definitions', async () => {
    const response = await service.findOne('review_123', user);
    expect(authz.explain).toHaveBeenCalledWith(
      user,
      'activity-review.read.request',
      { type: 'activity_publish_review', id: 'review_123' },
      tx,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(response).toMatchObject({
      reviewId: 'review_123',
      activityId: 'activity_123',
      snapshotSchemaVersion: 9,
      snapshotHash: snapshot.snapshotHash,
    });
    expect(response.timePolicies).toEqual([
      { policyId: time.policyId, versionId: time.id, version: 1, ...timeFingerprint },
    ]);
    expect(response.contributionPolicies).toEqual([
      {
        policyId: contribution.policyId,
        versionId: contribution.id,
        version: 1,
        ...contributionFingerprint,
      },
    ]);
    expect(authz.explain).toHaveBeenCalledTimes(1);
  });

  it.each(['no_permission', 'scope_mismatch'])(
    'denies %s before fetching policy data',
    async (reason) => {
      authz.explain.mockResolvedValue({ allow: false, reason });
      await expect(service.findOne('review_123', user)).rejects.toMatchObject({
        biz: { code: BizCode.RBAC_FORBIDDEN.code },
      });
      expect(tx.activityPublishReview.findUnique).not.toHaveBeenCalled();
      expect(tx.timePolicyVersion.findMany).not.toHaveBeenCalled();
      expect(tx.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
    },
  );

  it('preserves the review-not-found error', async () => {
    authz.explain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND.code },
    });
  });

  it('does not disclose any versions if the review disappears after authorization', async () => {
    tx.activityPublishReview.findUnique.mockResolvedValue(null);
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND.code },
    });
    expect(tx.timePolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it('rejects catalogue identifier query parameters through the existing global pipe', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const metadata = {
      type: 'query' as const,
      metatype: ActivityPublishReviewReferencedPoliciesQueryDto,
    };
    await expect(
      pipe.transform(
        { policyId: 'unreferenced_policy', versionId: 'unreferenced_version' },
        metadata,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({}, metadata)).resolves.toBeInstanceOf(
      ActivityPublishReviewReferencedPoliciesQueryDto,
    );
  });

  it('rejects an invalid frozen snapshot before looking up versions', async () => {
    proposals.parseSnapshot.mockImplementation(() => {
      throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    });
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
    expect(tx.timePolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it('returns no invented policies for a parsed V7 snapshot', async () => {
    snapshot.schemaVersion = 7;
    snapshot.timePolicyPointers = snapshot.base.timePolicyPointers = null;
    snapshot.contributionPolicyPointers = snapshot.base.contributionPolicyPointers = null;
    expect(await service.findOne('review_123', user)).toMatchObject({
      timePolicies: [],
      contributionPolicies: [],
    });
    expect(tx.timePolicyVersion.findMany).not.toHaveBeenCalled();
    expect(tx.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it('includes distinct base and target references, deduplicates repetitions and excludes unreferenced catalogue versions', async () => {
    const second = version('time', '_target'),
      unrelated = version('time', '_unreferenced');
    snapshot.timePolicyPointers = pointers(second);
    tx.timePolicyVersion.findMany.mockResolvedValue([unrelated, second, time]);
    const result = await service.findOne('review_123', user);
    expect(result.timePolicies.map((p) => p.versionId)).toEqual([time.id, second.id].sort());
    expect(JSON.stringify(result)).not.toContain(unrelated.id);
    expect(tx.timePolicyVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { id: time.id, policyId: time.policyId, definitionHash: time.definitionHash },
            { id: second.id, policyId: second.policyId, definitionHash: second.definitionHash },
          ],
        },
      }),
    );
  });

  it('includes explicit but overridden selections, not just resolved winners', async () => {
    const hidden = version('time', '_overridden');
    snapshot.timePolicyPointers!.selection.items.root.selection.pointer = pointer(hidden);
    tx.timePolicyVersion.findMany.mockResolvedValue([time, hidden]);
    expect(
      (await service.findOne('review_123', user)).timePolicies.map((p) => p.versionId),
    ).toEqual([time.id, hidden.id].sort());
  });

  it.each(['time', 'contribution'] as const)(
    'rejects a missing %s version rather than returning partial policy coverage',
    async (kind) => {
      tx[
        kind === 'time' ? 'timePolicyVersion' : 'contributionPolicyVersion'
      ].findMany.mockResolvedValue([]);
      await expect(service.findOne('review_123', user)).rejects.toMatchObject({
        biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
      });
    },
  );

  it.each([
    'policyId',
    'definitionHash',
    'evaluatorVersion',
    'schemaVersion',
    'statusCode',
    'definitionJson',
    'effectiveFrom',
  ] as const)('rejects a time version with inconsistent %s', async (field) => {
    const row = {
      ...time,
      [field]:
        field === 'effectiveFrom'
          ? new Date('2099-01-01T00:00:00.000Z')
          : field === 'definitionJson'
            ? {}
            : field === 'evaluatorVersion' || field === 'schemaVersion'
              ? 2
              : 'mismatch',
    };
    tx.timePolicyVersion.findMany.mockResolvedValue([row]);
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
  });

  it.each([
    'policyId',
    'definitionHash',
    'evaluatorVersion',
    'definitionJson',
    'effectiveFrom',
  ] as const)('rejects a contribution version with inconsistent %s', async (field) => {
    tx.contributionPolicyVersion.findMany.mockResolvedValue([
      {
        ...contribution,
        [field]:
          field === 'effectiveFrom'
            ? new Date('2099-01-01T00:00:00.000Z')
            : field === 'definitionJson'
              ? {}
              : field === 'evaluatorVersion'
                ? 2
                : 'mismatch',
      },
    ]);
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
  });

  it('rejects a frozen time target interval beginning before the referenced version validity', async () => {
    snapshot.timePolicyPointers!.resolved[0].effectiveFrom = '2097-01-01T00:00:00.000Z';
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
  });

  it('rejects a frozen time target interval ending beyond the referenced version validity', async () => {
    snapshot.timePolicyPointers!.resolved[0].effectiveUntil = '2102-01-01T00:00:00.000Z';
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
  });

  it('still requires contribution resolved metadata to equal the immutable version validity', async () => {
    snapshot.contributionPolicyPointers!.resolved[0].effectiveFrom = '2099-09-01T00:00:00.000Z';
    await expect(service.findOne('review_123', user)).rejects.toMatchObject({
      biz: { code: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code },
    });
  });

  it('allows exact immutable retired versions to be inspected without implying they remain approvable', async () => {
    tx.timePolicyVersion.findMany.mockResolvedValue([{ ...time, statusCode: 'retired' }]);
    expect((await service.findOne('review_123', user)).timePolicies[0].definitionHash).toBe(
      time.definitionHash,
    );
  });
});
