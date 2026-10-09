import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ContributionProofSummary } from './activity-contribution-settlement-presenter';
import {
  ACTIVITY_SETTLEMENT_ACTION,
  ActivitySettlementHttpService,
  buildActivitySettlementRequestHash,
} from './activity-settlement-http.service';

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
    const contributions = { readSummaryInTx: jest.fn().mockResolvedValue(summary()) };
    type Dependencies = ConstructorParameters<typeof ActivitySettlementHttpService>;
    const service = new ActivitySettlementHttpService(
      db as unknown as Dependencies[0],
      authz as unknown as Dependencies[1],
      rbac as unknown as Dependencies[2],
      {} as Dependencies[3],
      {} as Dependencies[4],
      {} as Dependencies[5],
      {} as Dependencies[6],
      {} as Dependencies[7],
      withContributions ? (contributions as unknown as Dependencies[8]) : undefined,
    );
    return { db, authz, rbac, contributions, service, version, run };
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
});
