import { Prisma, Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ContributionProofSummary } from './activity-contribution-settlement-presenter';
import { AdminSettlementReadService } from './admin-settlement-read.service';
import { SettlementReviewQueryService } from './settlement-review-query.service';
import {
  ACTIVITY_SETTLEMENT_ACTION,
  ActivitySettlementHttpService,
  buildActivitySettlementRequestHash,
} from './activity-settlement-http.service';

describe('Admin settlement sensitive-read boundary', () => {
  const meta = { requestId: 'review-read-test', ip: null, ua: null };
  const user = {
    id: 'reader',
    username: 'reader',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  function setup() {
    const core = { reviewDetail: jest.fn(), reviewWorkbench: jest.fn() };
    const query = { results: jest.fn() };
    const audit = { record: jest.fn() };
    type Dependencies = ConstructorParameters<typeof AdminSettlementReadService>;
    const service = new AdminSettlementReadService(
      core as unknown as Dependencies[0],
      query as unknown as Dependencies[1],
      audit as unknown as Dependencies[2],
    );
    return { core, query, audit, service };
  }
  it('authorization rejection precedes per-person queries and successful-read audit', async () => {
    const f = setup();
    f.core.reviewDetail.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
    await expect(
      f.service.reviewDetail('version', { page: 1, pageSize: 20 }, user, meta),
    ).rejects.toThrow(BizException);
    expect(f.query.results).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });
  it('audit failure prevents returning the successfully queried list; filters contain names only', async () => {
    const f = setup();
    f.core.reviewWorkbench.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    f.audit.record.mockRejectedValue(new Error('audit unavailable'));
    await expect(
      f.service.list({ page: 1, pageSize: 20, q: 'private-search' }, user, meta),
    ).rejects.toThrow('audit unavailable');
    expect(f.audit.record).toHaveBeenCalledWith(
      user,
      'collection',
      'settlement-list',
      0,
      ['q'],
      meta,
    );
  });
  it('a draft is not projected as frozen participant results', async () => {
    const f = setup();
    f.core.reviewDetail.mockResolvedValue({ version: { id: 'draft', statusCode: 'draft' } });
    const detail = await f.service.reviewDetail('draft', { page: 1, pageSize: 20 }, user, meta);
    expect(detail.results).toBeNull();
    expect(f.query.results).not.toHaveBeenCalled();
    expect(f.audit.record).toHaveBeenCalledWith(
      user,
      'draft',
      'settlement-review-detail',
      0,
      [],
      meta,
    );
  });
});

describe('Admin frozen time sources', () => {
  function source(id: string, native = false) {
    return {
      id,
      settlementRunId: 'run',
      contributionRegimeCode: native ? 'policy_v1' : 'legacy',
      settlementTimeRevisions: [] as Array<{ id: string }>,
      settlementContributionRevisions: [] as Array<{
        id: string;
        effectiveTimeSettlementVersionId: string;
      }>,
      correctionApplied: [] as Array<{
        statusCode: string;
        newPostingBatch: { statusCode: string };
        correctionRequest: { baseSettlementVersionId: string };
      }>,
    };
  }
  function fixture(initial = source('requested')) {
    const versions = new Map<string, ReturnType<typeof source>>([[initial.id, initial]]);
    const db = {
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
      participantSettlementResultRevision: {
        findMany: jest.fn().mockResolvedValue([{ participationIdentityId: 'person' }]),
        count: jest.fn().mockResolvedValue(1),
      },
      attendanceSettlementVersion: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(initial),
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string; settlementRunId: string } }) => {
            const row = versions.get(where.id);
            return Promise.resolve(row?.settlementRunId === where.settlementRunId ? row : null);
          }),
      },
      participantSettlementTimeBucket: {
        findMany: jest.fn().mockResolvedValue([
          {
            participationIdentityId: 'person',
            categoryCode: 'training',
            calculatedSeconds: 4500,
            recognizedSeconds: 3600,
          },
        ]),
      },
      participationTimeCorrectionManifest: { findFirst: jest.fn().mockResolvedValue(null) },
      participantContributionEvaluation: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const query = new SettlementReviewQueryService(
      db as unknown as ConstructorParameters<typeof SettlementReviewQueryService>[0],
    );
    return {
      db,
      versions,
      query,
      read: () => query.results(initial.id, { page: 1, pageSize: 20 }),
    };
  }
  it('native time is independent of legacy contribution rules', async () => {
    const version = source('submitted');
    version.settlementTimeRevisions = [{ id: 'frozen-time' }];
    const f = fixture(version);
    const result = await f.read();
    expect(result.timeState).toBe('ready');
    expect(result.timeBuckets[0]).toMatchObject({
      categoryCode: 'training',
      recognizedSeconds: 3600,
    });
    expect(result.contributionReady).toBe(false);
  });
  it.each(['committed', 'preparing'])(
    'unchanged-time correction %s follows only its explicit base and honors commit timing',
    async (status) => {
      const version = source('correction');
      version.correctionApplied = [
        {
          statusCode: status,
          newPostingBatch: { statusCode: status },
          correctionRequest: { baseSettlementVersionId: 'base' },
        },
      ];
      const f = fixture(version);
      const base = source('base');
      base.settlementTimeRevisions = [{ id: 'base-time' }];
      f.versions.set(base.id, base);
      const newer = source('newer-unrelated');
      newer.settlementTimeRevisions = [{ id: 'newer-time' }];
      f.versions.set(newer.id, newer);
      const result = await f.read();
      expect(result.timeState).toBe(status === 'committed' ? 'ready' : 'pending');
      if (status === 'committed') {
        expect(result.timeBuckets[0].recognizedSeconds).toBe(3600);
        expect(f.db.participantSettlementTimeBucket.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { timeRevisionId: 'base-time', participationIdentityId: { in: ['person'] } },
          }),
        );
      } else {
        expect(result.timeBuckets).toEqual([]);
        expect(f.db.participantSettlementTimeBucket.findMany).not.toHaveBeenCalled();
      }
    },
  );
  it('formal correction credit is the replacement, never added to the original hours', async () => {
    const f = fixture(source('corrected', true));
    f.db.participationTimeCorrectionManifest.findFirst.mockResolvedValue({
      contentHash: 'frozen',
      commitReceipt: { contentHash: 'frozen' },
      postingBatch: { statusCode: 'committed' },
      entries: [
        { participationIdentityId: 'person', categoryCode: 'training', secondsDelta: 1800 },
      ],
    });
    expect((await f.read()).timeBuckets).toEqual([
      {
        participationIdentityId: 'person',
        categoryCode: 'training',
        calculatedSeconds: null,
        recognizedSeconds: 1800,
      },
    ]);
  });
  it('a committed manifest with missing receipt fails closed', async () => {
    const f = fixture(source('invalid', true));
    f.db.participationTimeCorrectionManifest.findFirst.mockResolvedValue({
      contentHash: 'frozen',
      commitReceipt: null,
      postingBatch: { statusCode: 'committed' },
      entries: [],
    });
    await expect(f.read()).rejects.toThrow(BizException);
  });
  it('cross-run or cyclic source references fail closed instead of borrowing current state', async () => {
    const version = source('correction', true);
    version.settlementContributionRevisions = [
      { id: 'proof', effectiveTimeSettlementVersionId: 'outside' },
    ];
    const f = fixture(version);
    f.versions.set('outside', { ...source('outside'), settlementRunId: 'other-run' });
    await expect(f.read()).rejects.toThrow(BizException);
    const cyclic = source('outside', true);
    cyclic.settlementContributionRevisions = [
      { id: 'other-proof', effectiveTimeSettlementVersionId: version.id },
    ];
    f.versions.set('outside', cyclic);
    await expect(f.read()).rejects.toThrow(BizException);
  });
});

describe('buildActivitySettlementRequestHash', () => {
  it('递归忽略 HTTP JSON object 的键序，但保留数组和动作语义', () => {
    const first = buildActivitySettlementRequestHash('settlement-first-approve', {
      activityId: 'activity-1',
      expectation: {
        evidenceSealId: 'seal-1',
        workflowRevision: 7,
      },
    });
    const reordered = buildActivitySettlementRequestHash('settlement-first-approve', {
      expectation: {
        workflowRevision: 7,
        evidenceSealId: 'seal-1',
      },
      activityId: 'activity-1',
    });

    expect(reordered).toBe(first);
    expect(
      buildActivitySettlementRequestHash('settlement-final-approve', {
        activityId: 'activity-1',
        expectation: {
          evidenceSealId: 'seal-1',
          workflowRevision: 7,
        },
      }),
    ).not.toBe(first);
  });
});

describe('E4 settlement HTTP read proof wiring', () => {
  const actor = {
    id: 'actor',
    memberId: 'member',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };

  function summary(pending = false): ContributionProofSummary {
    return {
      regimeCode: 'policy_v1',
      pending,
      revisionId: pending ? null : 'contribution-revision',
      sourceKindCode: pending ? null : 'time_revision',
      selectionHash: pending ? null : 'a'.repeat(64),
      sourceSetHash: pending ? null : 'b'.repeat(64),
      evaluationSetHash: pending ? null : 'c'.repeat(64),
      recognizedPointsTotal: pending ? null : '0.00',
      evaluationCount: pending ? null : 1,
      hasMore: false,
      evaluations: pending
        ? []
        : [
            {
              participationIdentityId: 'identity',
              policyVersionId: 'zero-policy-version',
              definitionHash: 'd'.repeat(64),
              evaluatorVersion: 1,
              attendanceRoleCode: 'participant',
              timeCategoryCode: 'volunteer_service',
              durationSeconds: 3600,
              calculatedPoints: '0.00',
              recognizedPoints: '0.00',
              explanationCode: 'zero_policy',
            },
          ],
    };
  }

  function setup(withContributions = true) {
    const version = {
      id: 'requested-version',
      version: 1,
      statusCode: 'submitted',
      evidenceSealId: 'seal',
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash: 'e'.repeat(64),
      contributionRegimeCode: 'policy_v1',
      personCount: 1,
      sessionParticipationCount: 1,
      serviceSegmentCount: 1,
      submittedAt: new Date('2026-10-01T12:00:00.000Z'),
      priorVersionId: null,
      returnFromStage: null,
      returnReason: null,
      resultRevisions: [],
    };
    const run = {
      id: 'run',
      statusCode: 'drafting',
      currentDraftVersion: 1 as number | null,
      currentSubmittedVersion: null,
      currentPostedVersion: null,
      currentClosureRevision: null,
    };
    const db = {
      activity: {
        findFirst: jest.fn().mockResolvedValue({
          workflowRevision: 0,
          evidenceState: { evidenceRevision: 0, populationRevision: 0 },
          settlementRun: run,
        }),
      },
      attendanceSettlementVersion: {
        findFirst: jest
          .fn()
          .mockImplementation((args: { select?: { settlementRun?: unknown } }) =>
            Promise.resolve(
              args.select?.settlementRun ? { settlementRun: { activityId: 'activity' } } : version,
            ),
          ),
        findMany: jest.fn().mockResolvedValue([version]),
      },
      evidenceSeal: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'seal',
          sealRevision: 1,
          statusCode: 'active',
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          manualReviewPendingCount: 0,
        }),
      },
      activitySettlementClosureRevision: { findFirst: jest.fn().mockResolvedValue(null) },
      activityParticipationIdentity: { count: jest.fn().mockResolvedValue(0) },
      participantServiceSegmentRevision: { count: jest.fn().mockResolvedValue(0) },
      participantSettlementResultRevision: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const authz = { explain: jest.fn().mockResolvedValue({ allow: true }) };
    const rbac = { can: jest.fn().mockResolvedValue(false) };
    const contributions = {
      readSummaryInTx: jest
        .fn<Promise<ContributionProofSummary>, unknown[]>()
        .mockResolvedValue(summary()),
    };
    const timeQueries = {
      readDraftContributionSummaryInTx: jest
        .fn()
        .mockImplementation((tx: unknown, _activityId: string, id: string, hash: string) =>
          contributions.readSummaryInTx(tx, id, {
            draftContentHash: hash,
            sourceSetHash: 'd'.repeat(64),
          }),
        ),
    };
    type Dependencies = ConstructorParameters<typeof ActivitySettlementHttpService>;
    const reviews = { firstReview: jest.fn(), finalReview: jest.fn() };
    const service = new ActivitySettlementHttpService(
      db as unknown as Dependencies[0],
      authz as unknown as Dependencies[1],
      rbac as unknown as Dependencies[2],
      {} as Dependencies[3],
      {} as Dependencies[4],
      {} as Dependencies[5],
      reviews as unknown as Dependencies[6],
      {} as Dependencies[7],
      withContributions ? (contributions as unknown as Dependencies[8]) : undefined,
      timeQueries as unknown as Dependencies[9],
    );
    return { db, authz, rbac, contributions, service, version, run, reviews };
  }

  it('does not add native evidence to legacy workbench or version detail', async () => {
    const f = setup();
    f.version.contributionRegimeCode = 'legacy';
    const workbench = await f.service.workbench('activity', actor);
    const detail = await f.service.versionDetail('activity', 'requested-version', actor);
    expect(workbench).not.toHaveProperty('contributionProof');
    expect(detail).not.toHaveProperty('contributionProof');
    expect(workbench.gaps).toEqual([]);
    expect(detail.version.id).toBe('requested-version');
    expect(detail.diff).toEqual({
      priorVersionId: null,
      addedItemCount: 0,
      removedItemCount: 0,
      changedItemCount: 0,
    });
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('reads native draft evidence with the exact draft hash and retains explicit zero-policy proof', async () => {
    const f = setup();
    f.version.statusCode = 'draft';
    const result = await f.service.workbench('activity', actor);
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.db, 'requested-version', {
      draftContentHash: 'e'.repeat(64),
      sourceSetHash: 'd'.repeat(64),
    });
    expect(result.contributionProof).toEqual(summary());
    expect(result.gaps).toEqual([]);
    expect(result.contributionProof?.pending).toBe(false);
    expect(result.contributionProof?.evaluationCount).toBe(1);
    expect(result.contributionProof?.evaluations[0]).toMatchObject({
      recognizedPoints: '0.00',
      explanationCode: 'zero_policy',
      policyVersionId: 'zero-policy-version',
    });
  });

  it('does not turn pending evidence into an implicit zero-policy result', async () => {
    const f = setup();
    f.contributions.readSummaryInTx.mockResolvedValue(summary(true));
    const result = await f.service.workbench('activity', actor);
    expect(result.gaps).toEqual([{ gapCode: 'contribution_pending', count: 1 }]);
    expect(result.contributionProof).toEqual(summary(true));
    expect(result.contributionProof?.recognizedPointsTotal).toBeNull();
    expect(result.contributionProof?.evaluations).toEqual([]);
  });

  it('fails closed on both native read surfaces when the optional collaborator is absent', async () => {
    const f = setup(false);
    const workbench = await f.service.workbench('activity', actor);
    const detail = await f.service.versionDetail('activity', 'requested-version', actor);
    expect(workbench.gaps).toEqual([{ gapCode: 'contribution_pending', count: 1 }]);
    expect(workbench.contributionProof).toEqual(summary(true));
    expect(detail.contributionProof).toEqual(summary(true));
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('pins a draft version detail to its own content hash', async () => {
    const f = setup();
    f.version.statusCode = 'draft';
    const result = await f.service.versionDetail('activity', 'requested-version', actor);
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.db, 'requested-version', {
      draftContentHash: 'e'.repeat(64),
      sourceSetHash: 'd'.repeat(64),
    });
    expect(result.contributionProof).toEqual(summary());
  });

  it('uses the explicitly requested immutable review version, not the current draft or policy', async () => {
    const f = setup();
    f.run.currentDraftVersion = null;
    const result = await f.service.reviewDetail('requested-version', actor);
    expect(f.authz.explain).toHaveBeenCalledWith(actor, ACTIVITY_SETTLEMENT_ACTION.attendanceRead, {
      type: 'activity',
      id: 'activity',
    });
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledTimes(1);
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(
      f.db,
      'requested-version',
      undefined,
    );
    expect(f.db.attendanceSettlementVersion.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: 'requested-version',
          settlementRun: { activityId: 'activity', activity: { deletedAt: null } },
        },
      }),
    );
    expect(result.version.id).toBe('requested-version');
    expect(result.contributionProof).toEqual(summary());
    expect(result.gaps).toEqual([{ gapCode: 'draft_missing', count: 1 }]);
  });

  it('does not load workbench or contribution evidence after an activity permission denial', async () => {
    const f = setup();
    f.authz.explain.mockResolvedValue({ allow: false, reason: 'permission_missing' });
    await expect(f.service.workbench('activity', actor)).rejects.toThrow(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('resolves only the activity anchor before denying access to review evidence', async () => {
    const f = setup();
    f.authz.explain.mockResolvedValue({ allow: false, reason: 'permission_missing' });
    await expect(f.service.reviewDetail('requested-version', actor)).rejects.toThrow(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );
    expect(f.db.attendanceSettlementVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(f.db.evidenceSeal.findMany).not.toHaveBeenCalled();
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });
  it.each(['first', 'final'] as const)(
    'passes current actor, exact %s action/version and same tx to lock-after authorization',
    async (stage) => {
      const f = setup();
      const current = { ...actor, role: Role.ADMIN };
      const tx = {
        user: { findFirst: jest.fn().mockResolvedValue(current) },
      } as unknown as Prisma.TransactionClient;
      const callback = jest.fn((...args: unknown[]) => {
        const authorize = args[3] as (tx: Prisma.TransactionClient) => Promise<typeof actor>;
        return authorize(tx);
      });
      f.reviews.firstReview.mockImplementation(callback);
      f.reviews.finalReview.mockImplementation(callback);
      const expectation = {
        evidenceSealId: 'seal',
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: 'e'.repeat(64),
      };
      await expect(
        f.service.review(
          'requested-version',
          stage,
          'approve',
          { operationKey: 'review', expectation },
          actor,
          { requestId: 'test', ip: null, ua: null },
        ),
      ).resolves.toEqual(current);
      expect(f.authz.explain).toHaveBeenLastCalledWith(
        current,
        stage === 'first'
          ? ACTIVITY_SETTLEMENT_ACTION.firstReview
          : ACTIVITY_SETTLEMENT_ACTION.finalReview,
        { type: 'attendance_settlement_version', id: 'requested-version' },
        tx,
      );
      expect(callback).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['first', 'final'] as const)(
    'rejects an inactive user in the %s lock-after callback',
    async (stage) => {
      const f = setup();
      const tx = {
        user: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as Prisma.TransactionClient;
      const callback = jest.fn((...args: unknown[]) =>
        (args[3] as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx),
      );
      f.reviews.firstReview.mockImplementation(callback);
      f.reviews.finalReview.mockImplementation(callback);
      await expect(
        f.service.review(
          'requested-version',
          stage,
          'approve',
          {
            operationKey: 'review',
            expectation: {
              evidenceSealId: 'seal',
              evidenceRevision: 0,
              populationRevision: 0,
              workflowRevision: 0,
              contentHash: 'e'.repeat(64),
            },
          },
          actor,
          { requestId: 'test', ip: null, ua: null },
        ),
      ).rejects.toMatchObject({ biz: BizCode.UNAUTHORIZED });
      expect(f.authz.explain).toHaveBeenCalledTimes(1);
    },
  );
});
