import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { CorrectionApplicationService } from './correction-application.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import type {
  AppCommitActivityTimeCorrectionDto,
  AppPrepareActivityTimeCorrectionDto,
  AppReviewActivityTimeCorrectionDto,
  AppSubmitActivityTimeCorrectionDto,
} from './dto/app/app-activity-time-correction.dto';

const HASH = 'a'.repeat(64);
const actor: CurrentUserPayload = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const meta = { requestId: 'request', ip: null, ua: null };

const submitDto: AppSubmitActivityTimeCorrectionDto = {
  participationIdentityId: null,
  requestTypeCode: 'time',
  requestedChangeJson: {
    schemaVersion: 2,
    results: [],
    segments: [],
    timeCorrection: {
      baseSettlementVersionId: 'base-version',
      baseTimeLedgerHash: HASH,
      reason: '更正时间事实',
      items: [{ rootEntryId: 'root-entry', recognizedSeconds: 0 }],
    },
  },
  reason: '更正时间事实',
  operationKey: 'human-correction-submit-1',
};

function fixture() {
  const corrections = {
    submit: jest.fn<Promise<unknown>, [unknown, ...unknown[]]>(),
    resubmit: jest.fn<Promise<unknown>, [unknown, ...unknown[]]>(),
    review: jest.fn<Promise<unknown>, [unknown, ...unknown[]]>(),
    prepare: jest.fn<Promise<unknown>, [unknown, ...unknown[]]>(),
    commit: jest.fn<Promise<unknown>, [unknown, ...unknown[]]>(),
  };
  const prisma = {
    attendanceCorrectionRequest: { findFirst: jest.fn<Promise<unknown>, []>() },
    correctionTimeSourceProof: { findUnique: jest.fn<Promise<unknown>, []>() },
    $transaction: jest.fn<Promise<unknown>, [readonly Promise<unknown>[]]>(
      async (operations: readonly Promise<unknown>[]) => await Promise.all(operations),
    ),
  };
  return {
    corrections,
    prisma,
    service: new ActivityTimeCorrectionCommandService(
      prisma as unknown as PrismaService,
      corrections as unknown as CorrectionApplicationService,
    ),
  };
}

describe('D7-2 Human fact-correction command boundary', () => {
  it('canonicalizes a Human submit and never forwards a client request hash or actor field', async () => {
    const f = fixture();
    f.corrections.submit.mockResolvedValue({
      correctionRequestId: 'request-1',
      requestVersion: 0,
      activityId: 'activity',
      settlementRunId: 'run',
      baseSettlementVersionId: 'base-version',
      baseResultRevisionId: null,
      baseClosureRevision: 2,
      statusCode: 'pending',
      replayed: false,
    });

    await expect(f.service.submit('activity', submitDto, actor, meta)).resolves.toMatchObject({
      requestId: 'request-1',
      requestVersion: 0,
      replayed: false,
    });
    expect(f.corrections.submit).toHaveBeenCalledWith(expect.anything(), actor, meta, {
      human: true,
    });
    const input = f.corrections.submit.mock.calls[0]?.[0];
    if (!isRecord(input)) throw new Error('submit input must be a record');
    expect(input.activityId).toBe('activity');
    expect(isRecord(input.requestedChangeJson) && input.requestedChangeJson.schemaVersion).toBe(2);
    expect(input.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.requestHash).not.toBe(HASH);
    expect(input).not.toHaveProperty('actorUserId');
  });

  it('binds review to the rendered request version and fingerprints the full review action', async () => {
    const f = fixture();
    f.corrections.review.mockResolvedValue({
      outcome: 'reviewed',
      correctionRequestId: 'request-1',
      statusCode: 'approved',
      runStatus: 'correction_open',
      reviewedByUserId: actor.id,
      replayed: false,
    });
    const dto: AppReviewActivityTimeCorrectionDto = {
      actionCode: 'approve',
      expectedRequestVersion: 3,
      note: '证据充分',
    };

    await expect(
      f.service.review('activity', 'request-1', dto, actor, meta),
    ).resolves.toMatchObject({
      outcome: 'reviewed',
      requestId: 'request-1',
    });
    expect(f.corrections.review).toHaveBeenCalledWith(expect.anything(), actor, meta, {
      human: true,
      expectedActivityId: 'activity',
      expectedRequestVersion: 3,
    });
    const input = f.corrections.review.mock.calls[0]?.[0];
    if (!isRecord(input)) throw new Error('review input must be a record');
    expect(input.correctionRequestId).toBe('request-1');
    expect(input.operationHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derives prepare output hashes from frozen records rather than the request body', async () => {
    const f = fixture();
    f.corrections.prepare.mockResolvedValue({
      correctionRequestId: 'request-1',
      correctionApplicationId: 'application-1',
      newPostingBatchId: 'batch-1',
      newSettlementVersionId: 'version-2',
      replayed: false,
    });
    f.prisma.attendanceCorrectionRequest.findFirst.mockReturnValue(
      Promise.resolve({ requestHash: HASH }),
    );
    f.prisma.correctionTimeSourceProof.findUnique.mockReturnValue(
      Promise.resolve({ sourceSetHash: 'b'.repeat(64) }),
    );
    const dto: AppPrepareActivityTimeCorrectionDto = {
      expectedBaseSettlementVersionId: 'base-version',
      operationKey: 'human-correction-prepare-1',
    };

    await expect(f.service.prepare('activity', 'request-1', dto, actor, meta)).resolves.toEqual({
      requestId: 'request-1',
      applicationId: 'application-1',
      postingBatchId: 'batch-1',
      settlementVersionId: 'version-2',
      requestHash: HASH,
      sourceProofHash: 'b'.repeat(64),
      replayed: false,
    });
    expect(f.corrections.prepare).toHaveBeenCalledWith(expect.anything(), actor, meta, {
      human: true,
      expectedActivityId: 'activity',
      expectedBaseSettlementVersionId: 'base-version',
    });
    const input = f.corrections.prepare.mock.calls[0]?.[0];
    if (!isRecord(input)) throw new Error('prepare input must be a record');
    expect(input.correctionRequestId).toBe('request-1');
    expect(input.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires the exact prepared application and batch on Human commit', async () => {
    const f = fixture();
    f.corrections.commit.mockResolvedValue({
      correctionRequestId: 'request-1',
      correctionApplicationId: 'application-1',
      ledger: { postingBatchId: 'batch-1', settlementVersionId: 'version-2', settlementVersion: 2 },
      correctionStatus: 'applied',
      applicationStatus: 'committed',
      replayed: true,
    });
    const dto: AppCommitActivityTimeCorrectionDto = {
      expectedBaseSettlementVersionId: 'base-version',
      operationKey: 'human-correction-commit-1',
      correctionApplicationId: 'application-1',
      postingBatchId: 'batch-1',
    };

    await expect(
      f.service.commit('activity', 'request-1', dto, actor, meta),
    ).resolves.toMatchObject({
      postingBatchId: 'batch-1',
      replayed: true,
    });
    expect(f.corrections.commit).toHaveBeenCalledWith(
      expect.objectContaining({ correctionRequestId: 'request-1' }),
      actor,
      meta,
      {
        human: true,
        expectedActivityId: 'activity',
        expectedBaseSettlementVersionId: 'base-version',
        expectedCorrectionApplicationId: 'application-1',
        expectedPostingBatchId: 'batch-1',
      },
    );
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
