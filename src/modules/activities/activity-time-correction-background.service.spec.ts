import { pureHumanAuthority } from '../../../test/helpers/human-correction-authority-pure';
import { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Test } from '@nestjs/testing';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import {
  CorrectionApplicationService,
  type CorrectionCommitResult,
} from './correction-application.service';
import {
  humanCorrectionJobHash,
  finishHumanCorrectionJob,
  humanCorrectionItemHash,
  parseHumanCorrectionJobPayload,
  type HumanCorrectionJobPayload,
} from './correction-background-job';
import type { AppCommitActivityTimeCorrectionDto } from './dto/app/app-activity-time-correction.dto';

const activityId = 'activity-original';
const requestId = 'request-original';
const originalActor: CurrentUserPayload = {
  id: 'reviewer-original',
  username: 'reviewer',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-original',
};
const dto: AppCommitActivityTimeCorrectionDto = {
  correctionApplicationId: 'application-original',
  postingBatchId: 'batch-original',
  expectedBaseSettlementVersionId: 'base-original',
  operationKey: 'commit-original',
};
const UNCONFIRMED = 'HUMAN_CORRECTION_OUTCOME_UNCONFIRMED';
const UNAPPLIED = 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED';

function targetFixture() {
  return {
    id: dto.correctionApplicationId,
    statusCode: 'preparing',
    correctionRequestId: requestId,
    newPostingBatchId: dto.postingBatchId,
    newSettlementVersionId: 'version-new',
    correctionRequest: {
      id: requestId,
      activityId,
      settlementRunId: 'run-original',
      baseSettlementVersionId: dto.expectedBaseSettlementVersionId,
      requestHash: 'a'.repeat(64),
      statusCode: 'applying',
      requestedChangeJson: {
        schemaVersion: 3,
        results: [],
        segments: [
          {
            participationIdentityId: 'identity-original',
            segmentKey: 'segment-original',
            checkInAt: '2026-10-30T01:00:00.000Z',
            checkOutAt: '2026-10-30T02:00:00.000Z',
            resultCode: 'valid',
            serviceHours: '1.00',
          },
        ],
        allocations: [
          {
            participationIdentityId: 'identity-original',
            segmentKey: 'segment-original',
            baseSegmentRevisionId: 'segment-base',
            baseAllocationRevisionId: 'allocation-base',
            recognitionModeCode: 'automatic',
            manualReason: null,
            slices: [],
            evidenceAttachmentIds: [],
          },
        ],
        timeCorrection: {
          baseSettlementVersionId: dto.expectedBaseSettlementVersionId,
          baseTimeLedgerHash: 'b'.repeat(64),
          reason: 'Correct the reviewed time facts',
          items: [{ rootEntryId: 'root-original', recognizedSeconds: 3600 }],
        },
      },
    },
    newPostingBatch: {
      statusCode: 'ready',
      preparedByUserId: originalActor.id,
      timeCorrectionManifests: [{ rootManifestId: 'root-original' }],
      committedByUserId: null as string | null,
    },
    timeSourceProof: { sourceSetHash: 'c'.repeat(64) },
  };
}

interface JobRow extends Record<string, unknown> {
  id: string;
  jobTypeCode: string;
  activityId: string;
  postingBatchId: string;
  operationKey: string;
  statusCode: string;
  payload: HumanCorrectionJobPayload;
  payloadVersion: number;
  requestHash: string;
  createdByUserId: string;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
}
interface ItemRow extends Record<string, unknown> {
  id: string;
  resourceType: string;
  resourceId: string;
  lastErrorCode: string | null;
  safeMessage: string | null;
  resultReference: string | null;
  jobId: string;
  itemKey: string;
  statusCode: string;
  payloadHash: string;
  attempts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partial(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

// Apply the supplied predicates so lost-fence and narrowed-query bugs are not
// hidden by a mock that always returns the same successful row.
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR')
      return Array.isArray(value) && value.some((entry) => isRecord(entry) && matches(row, entry));
    const actual = row[key];
    if (!isRecord(value)) return actual === value;
    if ('in' in value) return Array.isArray(value.in) && value.in.includes(actual);
    if ('not' in value) return actual !== value.not;
    return isRecord(actual) && matches(actual, value);
  });
}

function patch(row: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (isRecord(value) && typeof value.increment === 'number') {
      const previous = row[key];
      if (typeof previous !== 'number') throw new Error('numeric update requires a numeric row');
      row[key] = previous + value.increment;
    } else row[key] = value;
  }
}

function rawQuery(input: unknown, values: readonly unknown[]) {
  if (Array.isArray(input)) return { sql: input.join('?'), values };
  if (
    input instanceof Object &&
    'sql' in input &&
    'values' in input &&
    typeof input.sql === 'string' &&
    Array.isArray(input.values)
  )
    return { sql: input.sql, values: input.values };
  throw new Error('unexpected raw-query input');
}

async function fixture(disabled = false) {
  const state: {
    target: ReturnType<typeof targetFixture>;
    job: JobRow | null;
    item: ItemRow | null;
    activeUser: CurrentUserPayload | null;
    rootLockFailure: Error | null;
  } = {
    target: targetFixture(),
    job: null,
    item: null,
    activeUser: { ...originalActor },
    rootLockFailure: null,
  };
  const job = () => {
    if (!state.job) throw new Error('enqueue must create the job first');
    return state.job;
  };
  const item = () => {
    if (!state.item) throw new Error('enqueue must create the item first');
    return state.item;
  };
  const findJob = ({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(state.job && matches(state.job, where) ? structuredClone(state.job) : null);
  const jobs = {
    findUnique: jest.fn(findJob),
    findFirst: jest.fn(findJob),
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(state.job && matches(state.job, where) ? [structuredClone(state.job)] : []),
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const payload = parseHumanCorrectionJobPayload(data.payload);
      state.job = {
        id: 'job-original',
        jobTypeCode: String(data.jobTypeCode),
        activityId: String(data.activityId),
        postingBatchId: String(data.postingBatchId),
        operationKey: String(data.operationKey),
        statusCode: String(data.statusCode),
        payload: structuredClone(payload),
        payloadVersion: 1,
        requestHash: String(data.requestHash),
        createdByUserId: String(data.createdByUserId),
        leaseOwner: null,
        leaseGeneration: 0,
        leaseExpiresAt: null,
        lastErrorCode: null,
      };
      return Promise.resolve(structuredClone(state.job));
    }),
    update: jest.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!state.job || !matches(state.job, where)) throw new Error('job update missed');
        patch(state.job, data);
        return Promise.resolve(structuredClone(state.job));
      },
    ),
    updateMany: jest.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!state.job || !matches(state.job, where)) return Promise.resolve({ count: 0 });
        patch(state.job, data);
        return Promise.resolve({ count: 1 });
      },
    ),
  };
  const items = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      profile.requireP();
      state.item = {
        id: 'intent-original',
        jobId: String(data.jobId),
        itemKey: String(data.itemKey),
        statusCode: String(data.statusCode),
        payloadHash: String(data.payloadHash),
        attempts: Number(data.attempts),
        resourceType: String(data.resourceType),
        resourceId: String(data.resourceId),
        lastErrorCode: null,
        safeMessage: null,
        resultReference: typeof data.resultReference === 'string' ? data.resultReference : null,
      };
      return Promise.resolve(structuredClone(state.item));
    }),
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      profile.requireP();
      return Promise.resolve(
        state.item && matches(state.item, where) ? [structuredClone(state.item)] : [],
      );
    }),
    updateMany: jest.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        profile.requireP();
        if (!state.item || !matches({ ...state.item, job: state.job }, where))
          return Promise.resolve({ count: 0 });
        patch(state.item, data);
        return Promise.resolve({ count: 1 });
      },
    ),
  };
  const tx = {
    activityBatchJob: jobs,
    activityBatchJobItem: items,
    correctionApplication: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === state.target.id ? structuredClone(state.target) : null),
      ),
    },
    user: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          state.activeUser && matches({ ...state.activeUser, deletedAt: null }, where)
            ? structuredClone(state.activeUser)
            : null,
        ),
      ),
    },
    $executeRaw: jest.fn((input: unknown) => {
      if (!profile.execute(input)) throw new Error('unexpected authority execute');
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn((input: unknown, ...values: unknown[]) => {
      const modeled = profile.query(input);
      if (modeled.handled) return Promise.resolve(modeled.value);
      const query = rawQuery(input, values);
      if (query.sql.includes('FROM "ActivityBatchJobItem"')) {
        profile.requireP();
        return Promise.resolve(
          state.item &&
            state.item.jobId === query.values[0] &&
            state.item.itemKey === query.values[1]
            ? [structuredClone(state.item)]
            : [],
        );
      }
      if (query.sql.includes('FROM "Activity"')) {
        if (state.rootLockFailure) throw state.rootLockFailure;
        return Promise.resolve(query.values[0] === activityId ? [{ id: activityId }] : []);
      }
      if (!query.sql.includes('FROM "ActivityBatchJob"')) throw new Error('unexpected query');
      if (!state.job || query.values[0] !== state.job.id) return Promise.resolve([]);
      if (query.sql.includes('SELECT id,payload')) {
        return Promise.resolve(
          query.values[1] === state.job.activityId &&
            query.values[2] === state.job.jobTypeCode &&
            query.values[3] === state.job.postingBatchId &&
            query.values[4] === state.job.leaseOwner &&
            query.values[5] === state.job.leaseGeneration &&
            state.job.statusCode === 'processing' &&
            state.job.leaseExpiresAt &&
            state.job.leaseExpiresAt.getTime() > Date.now()
            ? [structuredClone(state.job)]
            : [],
        );
      }
      if (query.sql.includes('"leaseGeneration"')) {
        return Promise.resolve(
          query.values[1] === state.job.jobTypeCode &&
            state.job.statusCode === 'processing' &&
            query.values[2] === state.job.leaseOwner &&
            query.values[3] === state.job.leaseGeneration
            ? [{ id: state.job.id }]
            : [],
        );
      }
      return Promise.resolve([{ id: state.job.id }]);
    }),
  };
  // Executes every callback, but intentionally does not emulate PostgreSQL
  // transactions, row locks or rollback. These tests establish orchestration only.
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } finally {
        profile.state.currentRole = profile.binding.callerRole.name;
      }
    }),
  };
  const profile = pureHumanAuthority(prisma);
  const domain = {
    commit: jest.fn<
      ReturnType<CorrectionApplicationService['commit']>,
      Parameters<CorrectionApplicationService['commit']>
    >(),
    prepare: jest.fn(),
  };
  const access = {
    authorizeCommit: jest.fn((_tx: unknown, user: CurrentUserPayload) => Promise.resolve(user)),
  };
  const workflow = { assertV11WriteAllowed: jest.fn() };
  const module = await Test.createTestingModule({
    providers: [
      ActivityTimeCorrectionBackgroundService,
      {
        provide: HumanCorrectionItemAuthority,
        useValue: disabled ? new HumanCorrectionItemAuthority() : profile.authority,
      },
      { provide: ActivityWorkflowGate, useValue: workflow },
      ActivityTimeCorrectionCommandService,
      { provide: PrismaService, useValue: prisma },
      { provide: CorrectionApplicationService, useValue: domain },
      { provide: ActivityTimeCorrectionAccessService, useValue: access },
    ],
  }).compile();
  const service = module.get(ActivityTimeCorrectionBackgroundService);
  const commands = module.get(ActivityTimeCorrectionCommandService);
  const commitCommand = jest.spyOn(commands, 'commit');
  const prepareCommand = jest.spyOn(commands, 'prepare');
  const applied = () => {
    state.target.statusCode = 'committed';
    state.target.correctionRequest.statusCode = 'applied';
    state.target.newPostingBatch.statusCode = 'committed';
    state.target.newPostingBatch.committedByUserId = originalActor.id;
  };
  const result: CorrectionCommitResult = {
    activityId,
    correctionRequestId: requestId,
    correctionApplicationId: dto.correctionApplicationId,
    ledger: {
      activityId,
      postingBatchId: dto.postingBatchId,
      settlementRunId: 'run-original',
      settlementVersionId: 'version-new',
      settlementVersion: 2,
      batchStatus: 'committed',
      runStatus: 'posted',
      memberCount: 1,
      dayStateCount: 1,
      entryCount: 2,
      committedAt: new Date('2026-10-30T03:00:00Z'),
      replayed: false,
    },
    supersededResultRevisionCount: 1,
    supersededSegmentRevisionCount: 1,
    supersededClosureRevision: null,
    activityClosurePointerCleared: true,
    correctionStatus: 'applied',
    applicationStatus: 'committed',
    replayed: false,
  };
  const complete = async () => {
    applied();
    const jobRow = job();
    const intent = item();
    await finishHumanCorrectionJob(
      tx as unknown as Prisma.TransactionClient,
      {
        jobId: jobRow.id,
        leaseOwner: String(jobRow.leaseOwner),
        leaseGeneration: jobRow.leaseGeneration,
        payload: jobRow.payload,
        intentItemId: intent.id,
        intentHash: intent.payloadHash,
        itemEpoch: intent.attempts,
      },
      profile.authority,
    );
  };
  const enqueue = () => service.enqueue(activityId, requestId, dto, originalActor);
  const detail = () => service.detail(activityId, requestId, job().id, originalActor);
  const retry = () => service.retry(activityId, requestId, job().id, originalActor);
  const claim = () => {
    Object.assign(job(), {
      statusCode: 'processing',
      leaseOwner: 'worker-original',
      leaseGeneration: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    return { jobId: job().id, activityId, leaseOwner: 'worker-original', leaseGeneration: 2 };
  };
  return {
    service,
    profile,
    workflow,
    prisma,
    tx,
    state,
    jobs,
    items,
    domain,
    access,
    commands,
    commitCommand,
    prepareCommand,
    applied,
    complete,
    result,
    enqueue,
    detail,
    retry,
    claim,
    job,
    item,
  };
}

describe('Human correction durable acceptance and recovery (no database)', () => {
  it('refuses durable acceptance while the existing settlement gate is closed, before any job or transaction write', async () => {
    const f = await fixture();
    f.workflow.assertV11WriteAllowed.mockImplementation(() => {
      throw new BizException(BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE);
    });
    await expect(f.enqueue()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    });
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps a confirmed failed task unchanged when maintenance starts before manual retry', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.domain.commit.mockRejectedValue(new Error('business failed'));
    await expect(f.service.process(input)).resolves.toBe(false);
    const failed = structuredClone(f.job());
    f.workflow.assertV11WriteAllowed.mockImplementation(() => {
      throw new BizException(BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE);
    });
    await expect(f.retry()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    });
    expect(f.job()).toEqual(failed);
  });

  it('accepts and executes the existing V2 zero-segment time correction without requiring a V3 proof', async () => {
    const f = await fixture();
    Reflect.set(f.state.target.correctionRequest, 'requestedChangeJson', {
      schemaVersion: 2,
      results: [],
      segments: [],
      timeCorrection: {
        baseSettlementVersionId: dto.expectedBaseSettlementVersionId,
        baseTimeLedgerHash: 'b'.repeat(64),
        reason: 'Correct reviewed time facts',
        items: [{ rootEntryId: 'root-original', recognizedSeconds: 3600 }],
      },
    });
    Reflect.set(f.state.target, 'timeSourceProof', null);
    await expect(f.enqueue()).resolves.toMatchObject({
      stage: 'queued',
      applied: false,
      segmentCount: 0,
    });
    expect(f.job().payload).toMatchObject({
      schemaVersion: 2,
      sourceProofHash: null,
      segmentCount: 0,
    });
    await expect(f.detail()).resolves.toMatchObject({ stage: 'queued', applied: false });
    const input = f.claim();
    f.domain.commit.mockImplementation(async () => {
      await f.complete();
      return f.result;
    });
    await expect(f.service.process(input)).resolves.toBe(true);
    expect(f.commitCommand).toHaveBeenCalledTimes(1);
    await expect(f.detail()).resolves.toMatchObject({ stage: 'applied', completedUnits: 1 });
  });

  it('returns the same job for the same key and intent without preparing or committing business', async () => {
    const f = await fixture();
    const first = await f.enqueue();
    expect(await f.enqueue()).toEqual(first);
    expect(first).toMatchObject({
      stage: 'queued',
      applied: false,
      completedUnits: 0,
      totalUnits: 1,
    });
    expect(f.jobs.create).toHaveBeenCalledTimes(1);
    expect(f.access.authorizeCommit).toHaveBeenCalledTimes(2);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.prepareCommand).not.toHaveBeenCalled();
    expect(f.domain.prepare).not.toHaveBeenCalled();
    expect(f.job().requestHash).toBe(humanCorrectionJobHash(f.job().payload));
  });

  it.each([
    'actor',
    'source',
    'proof',
    'batch',
    'application',
    'base',
    'root',
    'run',
    'new-version',
  ] as const)('rejects a reused key after %s changes', async (change) => {
    const f = await fixture();
    await f.enqueue();
    const input = { ...dto };
    let user = originalActor;
    if (change === 'actor') {
      user = { ...originalActor, id: 'other-reviewer' };
      f.state.target.newPostingBatch.preparedByUserId = user.id;
    } else if (change === 'source') f.state.target.correctionRequest.requestHash = 'd'.repeat(64);
    else if (change === 'proof') f.state.target.timeSourceProof.sourceSetHash = 'e'.repeat(64);
    else if (change === 'root')
      f.state.target.newPostingBatch.timeCorrectionManifests[0].rootManifestId = 'other-root';
    else if (change === 'run') f.state.target.correctionRequest.settlementRunId = 'other-run';
    else if (change === 'new-version') f.state.target.newSettlementVersionId = 'other-version';
    else if (change === 'batch') {
      input.postingBatchId = 'batch-other';
      f.state.target.newPostingBatchId = input.postingBatchId;
    } else if (change === 'application') {
      input.correctionApplicationId = 'application-other';
      f.state.target.id = input.correctionApplicationId;
    } else {
      input.expectedBaseSettlementVersionId = 'base-other';
      f.state.target.correctionRequest.baseSettlementVersionId =
        input.expectedBaseSettlementVersionId;
    }
    await expect(f.service.enqueue(activityId, requestId, input, user)).rejects.toMatchObject({
      biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
    });
    expect(f.jobs.create).toHaveBeenCalledTimes(1);
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it.each(['source', 'proof', 'batch', 'base', 'preparer', 'root', 'run', 'new-version'] as const)(
    'rechecks authoritative %s bindings on detail',
    async (change) => {
      const f = await fixture();
      await f.enqueue();
      if (change === 'source') f.state.target.correctionRequest.requestHash = 'd'.repeat(64);
      else if (change === 'proof') f.state.target.timeSourceProof.sourceSetHash = 'e'.repeat(64);
      else if (change === 'root')
        f.state.target.newPostingBatch.timeCorrectionManifests[0].rootManifestId = 'other-root';
      else if (change === 'run') f.state.target.correctionRequest.settlementRunId = 'other-run';
      else if (change === 'new-version') f.state.target.newSettlementVersionId = 'other-version';
      else if (change === 'batch') f.state.target.newPostingBatchId = 'other-batch';
      else if (change === 'base')
        f.state.target.correctionRequest.baseSettlementVersionId = 'other-base';
      else f.state.target.newPostingBatch.preparedByUserId = 'other-preparer';
      await expect(f.detail()).rejects.toMatchObject({
        biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
      });
    },
  );

  it('denies a different actor without treating knowledge of the job ID as authorization', async () => {
    const f = await fixture();
    await f.enqueue();
    f.access.authorizeCommit.mockClear();
    await expect(
      f.service.detail(activityId, requestId, f.job().id, {
        ...originalActor,
        id: 'other-reviewer',
      }),
    ).rejects.toMatchObject({ biz: BizCode.NOT_FOUND });
    expect(f.access.authorizeCommit).not.toHaveBeenCalled();
  });

  it('denies detail when the original actor loses current authorization', async () => {
    const f = await fixture();
    await f.enqueue();
    const revoked = new BizException(BizCode.RBAC_FORBIDDEN);
    f.access.authorizeCommit.mockRejectedValue(revoked);
    await expect(f.detail()).rejects.toBe(revoked);
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it('reports 100% from the applied application/request/batch anchors, even before job bookkeeping', async () => {
    const f = await fixture();
    await f.enqueue();
    f.applied();
    expect(f.job().statusCode).toBe('pending');
    await expect(f.detail()).resolves.toMatchObject({
      stage: 'applied',
      applied: true,
      completedUnits: 1,
      totalUnits: 1,
      retryAllowed: false,
    });
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it('never reports a succeeded job as applied while business remains preparing', async () => {
    const f = await fixture();
    await f.enqueue();
    f.job().statusCode = 'succeeded';
    await expect(f.detail()).resolves.toMatchObject({
      stage: 'verifying',
      applied: false,
      completedUnits: 0,
      retryAllowed: false,
    });
  });

  it.each(['application', 'request', 'batch', 'committer'] as const)(
    'does not report 100%% for inconsistent committed %s evidence',
    async (change) => {
      const f = await fixture();
      await f.enqueue();
      f.applied();
      f.job().statusCode = 'succeeded';
      if (change === 'application') f.state.target.statusCode = 'preparing';
      else if (change === 'request') f.state.target.correctionRequest.statusCode = 'applying';
      else if (change === 'batch') f.state.target.newPostingBatch.statusCode = 'ready';
      else f.state.target.newPostingBatch.committedByUserId = 'other-reviewer';
      await expect(f.detail()).resolves.toMatchObject({
        applied: false,
        completedUnits: 0,
        retryAllowed: false,
      });
    },
  );

  it('reconciles a reclaimed processing item without invoking commit again', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.item().statusCode = 'processing';
    await expect(f.service.process(input)).resolves.toBe(false);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.job()).toMatchObject({
      statusCode: 'failed',
      lastErrorCode: UNAPPLIED,
      leaseGeneration: 3,
    });
    await expect(f.detail()).resolves.toMatchObject({
      stage: 'failed',
      retryAllowed: true,
      completedUnits: 0,
    });
  });

  it('does not invoke business when the original worker actor has lost authorization', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.access.authorizeCommit.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
    await expect(f.service.process(input)).resolves.toBe(false);
    expect(f.tx.user.findFirst).toHaveBeenCalledWith(
      partial({
        where: partial({ id: originalActor.id, status: UserStatus.ACTIVE }),
      }),
    );
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.domain.commit).not.toHaveBeenCalled();
  });

  it('keeps P2028 verifying and forbids retry when an independent root lock is unavailable', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    const expired = new Prisma.PrismaClientKnownRequestError('transaction outcome unknown', {
      code: 'P2028',
      clientVersion: 'test',
    });
    f.domain.commit.mockImplementation(() => {
      f.state.rootLockFailure = new Error('root held by the original transaction');
      return Promise.reject(expired);
    });
    await expect(f.service.process(input)).resolves.toBe(false);
    expect(f.job()).toMatchObject({ statusCode: 'processing', lastErrorCode: UNCONFIRMED });
    expect(f.item().statusCode).toBe('processing');
    await expect(f.detail()).resolves.toMatchObject({
      stage: 'verifying',
      completedUnits: 0,
      retryAllowed: false,
    });
    // Making the observer lock available still does not turn UNKNOWN into a
    // confirmed-unapplied receipt or authorize the manual retry endpoint.
    f.state.rootLockFailure = null;
    await expect(f.retry()).rejects.toMatchObject({ biz: BizCode.CORRECTION_APPLY_STATUS_INVALID });
    expect(f.domain.commit).toHaveBeenCalledTimes(1);
    expect(f.item().statusCode).toBe('processing');
  });

  it('allows only explicit manual retry after reconciliation confirms no publication', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.domain.commit.mockRejectedValue(new Error('worker response failed'));
    await expect(f.service.process(input)).resolves.toBe(false);
    expect(f.job()).toMatchObject({
      statusCode: 'failed',
      lastErrorCode: UNAPPLIED,
      leaseGeneration: 3,
    });
    expect(f.item().statusCode).toBe('failed');
    await expect(f.detail()).resolves.toMatchObject({ stage: 'failed', retryAllowed: true });
    expect(f.domain.commit).toHaveBeenCalledTimes(1);
    await expect(f.retry()).resolves.toMatchObject({
      stage: 'queued',
      completedUnits: 0,
      retryAllowed: false,
      attempt: 2,
    });
    expect(f.job()).toMatchObject({ statusCode: 'pending', lastErrorCode: null, leaseOwner: null });
    expect(f.item().statusCode).toBe('pending');
    expect(f.domain.commit).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost commit response to success only when authoritative business is committed', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.domain.commit.mockImplementation(async () => {
      await f.complete(); // Actual finish helper, still a pure row/role model.
      throw new Error('commit response lost');
    });
    await expect(f.service.process(input)).resolves.toBe(true);
    expect(f.domain.commit).toHaveBeenCalledTimes(1);
    expect(f.job()).toMatchObject({
      statusCode: 'succeeded',
      lastErrorCode: null,
      leaseOwner: null,
    });
    expect(f.item()).toMatchObject({
      statusCode: 'succeeded',
      resultReference: dto.correctionApplicationId,
    });
    await expect(f.detail()).resolves.toMatchObject({
      stage: 'applied',
      completedUnits: 1,
      retryAllowed: false,
    });
  });

  it('does not mutate state for an already stale lease generation', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.job().leaseGeneration += 1;
    const before = structuredClone({ job: f.job(), item: f.item() });
    f.jobs.update.mockClear();
    f.jobs.updateMany.mockClear();
    f.items.updateMany.mockClear();
    await expect(f.service.process(input)).resolves.toBe(false);
    expect({ job: f.job(), item: f.item() }).toEqual(before);
    expect(f.jobs.update).not.toHaveBeenCalled();
    expect(f.jobs.updateMany).not.toHaveBeenCalled();
    expect(f.items.updateMany).not.toHaveBeenCalled();
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it('rechecks the fence after a generation changes between initial read and transactional lock', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    f.jobs.findUnique.mockImplementationOnce(() => {
      const old = structuredClone(f.job());
      f.job().leaseGeneration += 1;
      return Promise.resolve(old);
    });
    f.jobs.updateMany.mockClear();
    f.items.updateMany.mockClear();
    await expect(f.service.process(input)).resolves.toBe(false);
    expect(f.job().leaseGeneration).toBe(3);
    expect(f.items.updateMany).not.toHaveBeenCalled();
    expect(f.jobs.updateMany).not.toHaveBeenCalled();
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it('calls the original Human command with the current original actor, exact DTO and fence, without prepare', async () => {
    const f = await fixture();
    await f.enqueue();
    const input = f.claim();
    const payload = structuredClone(f.job().payload);
    f.state.activeUser = { ...originalActor, username: 'current-original-identity' };
    f.domain.commit.mockImplementation(async () => {
      await f.complete();
      return f.result;
    });
    await expect(f.service.process(input)).resolves.toBe(true);
    const fence = {
      ...input,
      payload,
      intentItemId: f.item().id,
      intentHash: humanCorrectionItemHash(input.jobId, payload),
      itemEpoch: 1,
    };
    const audit = {
      requestId: `human-correction-job:${input.jobId}:${input.leaseGeneration}`,
      ip: null,
      ua: 'activity-batch-worker',
    };
    expect(f.commitCommand).toHaveBeenCalledTimes(1);
    expect(f.commitCommand).toHaveBeenCalledWith(
      activityId,
      requestId,
      dto,
      f.state.activeUser,
      audit,
      fence,
    );
    expect(f.domain.commit).toHaveBeenCalledWith(
      f.commands.toHumanCommitInput(activityId, requestId, dto, originalActor),
      f.state.activeUser,
      audit,
      {
        human: true,
        backgroundJob: fence,
        expectedActivityId: activityId,
        expectedBaseSettlementVersionId: dto.expectedBaseSettlementVersionId,
        expectedCorrectionApplicationId: dto.correctionApplicationId,
        expectedPostingBatchId: dto.postingBatchId,
      },
    );
    expect(f.access.authorizeCommit).toHaveBeenCalledWith(
      f.tx,
      f.state.activeUser,
      activityId,
      dto.expectedBaseSettlementVersionId,
    );
    expect(f.prepareCommand).not.toHaveBeenCalled();
    expect(f.domain.prepare).not.toHaveBeenCalled();
  });
});

/** Security characterization, NOT a passing authentication claim. The second
 * case models the proposed SQL write capabilities by supplying forged stored
 * rows. No GRANT/SQL/HTTP/real business transaction is executed. The real queue
 * service and Human command run, and business is stopped at the domain seam.
 */
describe('Human queue origin: API versus proposed shared SQL capabilities', () => {
  const apiA: CurrentUserPayload = {
    ...originalActor,
    id: 'unauthorized-A',
    username: 'A',
    memberId: 'member-A',
  };

  async function originFixture() {
    const f = await fixture();
    f.access.authorizeCommit.mockImplementation((_tx, user) => {
      if (user.id !== originalActor.id) throw new BizException(BizCode.RBAC_FORBIDDEN);
      return Promise.resolve(user);
    });
    return f;
  }

  function supplyForgedRows(f: Awaited<ReturnType<typeof fixture>>) {
    const operation = f.commands.toHumanCommitInput(activityId, requestId, dto, originalActor);
    const payload: HumanCorrectionJobPayload = {
      action: 'human_correction_commit',
      schemaVersion: 3,
      activityId,
      requestId,
      applicationId: dto.correctionApplicationId,
      settlementRunId: f.state.target.correctionRequest.settlementRunId,
      newSettlementVersionId: f.state.target.newSettlementVersionId,
      rootManifestId: f.state.target.newPostingBatch.timeCorrectionManifests[0].rootManifestId,
      postingBatchId: dto.postingBatchId,
      baseSettlementVersionId: dto.expectedBaseSettlementVersionId,
      actorUserId: originalActor.id,
      operationKey: operation.operationKey,
      commitRequestHash: operation.requestHash,
      sourceRequestHash: f.state.target.correctionRequest.requestHash,
      sourceProofHash: f.state.target.timeSourceProof.sourceSetHash,
      segmentCount: 1,
    };
    const hash = humanCorrectionJobHash(payload); // Public integrity hash, no authentication secret.
    f.state.job = {
      id: 'sql-supplied-job',
      jobTypeCode: 'human_correction_commit',
      activityId,
      postingBatchId: dto.postingBatchId,
      operationKey: `human_correction_commit:${dto.operationKey}`,
      statusCode: 'pending',
      payload,
      payloadVersion: 1,
      requestHash: hash,
      createdByUserId: originalActor.id,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
    f.state.item = {
      id: 'sql-forged-item',
      resourceType: 'CorrectionApplication',
      resourceId: dto.correctionApplicationId,
      lastErrorCode: null,
      safeMessage: null,
      resultReference: null,
      jobId: f.state.job.id,
      itemKey: 'commit',
      statusCode: 'pending',
      payloadHash: hash,
      attempts: 0,
    };
  }

  it('normal API acceptance cannot replace authenticated A with preparer B', async () => {
    const f = await originFixture();
    await expect(f.service.enqueue(activityId, requestId, dto, apiA)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.access.authorizeCommit).toHaveBeenCalledWith(
      f.tx,
      apiA,
      activityId,
      dto.expectedBaseSettlementVersionId,
    );
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.commitCommand).not.toHaveBeenCalled();
  });

  it('rejects old coherent Job/Item without a protected v2 acceptance instead of dispatching B', async () => {
    const f = await originFixture();
    supplyForgedRows(f);
    f.domain.commit.mockRejectedValue(new Error('REVIEW_STOP_BEFORE_BUSINESS_DATABASE'));
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.jobs.create).not.toHaveBeenCalled(); // No genuine enqueue was called to make these rows.
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.domain.commit).not.toHaveBeenCalled();
    expect(f.access.authorizeCommit).not.toHaveBeenCalled();
    expect(f.state.target.statusCode).toBe('preparing'); // No real or simulated business COMMIT.
  });

  it('a denied Item marker still prevents native dispatch even with a supplied Job model', async () => {
    const f = await originFixture();
    supplyForgedRows(f);
    f.items.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('permission denied for table ActivityBatchJobItem', {
        code: 'P2010',
        clientVersion: '6.19.3',
        meta: { code: '42501' },
      }),
    );
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.domain.commit).not.toHaveBeenCalled();
  });
});

describe('Human protected Item epoch integration (pure orchestration)', () => {
  it('defaults to refusing an absent trusted connection before any transaction or enqueue', async () => {
    const f = await fixture(true);
    await expect(f.enqueue()).rejects.toThrow('HumanCorrectionAuthorityUnavailable');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.items.create).not.toHaveBeenCalled();
  });
  it('rejects an administrator session mislabeled as a trusted caller before Job creation', async () => {
    const f = await fixture();
    f.profile.state.sessionRole = 'postgres';
    await expect(f.enqueue()).rejects.toThrow('HumanCorrectionAuthorityUnavailable');
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.items.create).not.toHaveBeenCalled();
  });
  it('never adopts or backfills an otherwise coherent precreated writable Job without its protected Item', async () => {
    const source = await fixture();
    await source.enqueue();
    const f = await fixture();
    f.state.job = structuredClone(source.job());
    await expect(f.enqueue()).rejects.toMatchObject({
      biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
    });
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.items.create).not.toHaveBeenCalled();
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
  });
  it('rejects old generic Item promotion even when all writable Job fields name authorized B', async () => {
    const source = await fixture();
    await source.enqueue();
    const f = await fixture();
    f.state.job = structuredClone(source.job());
    f.state.item = { ...structuredClone(source.item()), itemKey: 'generate' };
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.items.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a cascaded Job-id reattachment instead of deriving new authority from the changed FK', async () => {
    const f = await fixture();
    await f.enqueue();
    const accepted = structuredClone(f.item());
    f.job().id = 'rewritten-job';
    f.item().jobId = 'rewritten-job';
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.item().id).toBe(accepted.id);
    expect(f.item().payloadHash).toBe(accepted.payloadHash);
    expect(f.commitCommand).not.toHaveBeenCalled();
    expect(f.items.updateMany).not.toHaveBeenCalled();
  });
  it('does not allow forged Job failed/UNAPPLIED flags to authorize retry or advance the protected epoch', async () => {
    const f = await fixture();
    await f.enqueue();
    const before = structuredClone(f.item());
    Object.assign(f.job(), { statusCode: 'failed', lastErrorCode: UNAPPLIED });
    await expect(f.retry()).rejects.toMatchObject({ biz: BizCode.CORRECTION_APPLY_STATUS_INVALID });
    expect(f.item()).toEqual(before);
    await expect(f.detail()).resolves.toMatchObject({
      applied: false,
      attempt: 0,
      retryAllowed: false,
    });
  });
  it('derives dispatch and progress epoch from Item rather than an attacker-selected Job generation', async () => {
    const f = await fixture();
    await f.enqueue();
    const claim = f.claim();
    f.job().leaseGeneration = 900;
    f.domain.commit.mockImplementation(async () => {
      await f.complete();
      return f.result;
    });
    await expect(f.service.process({ ...claim, leaseGeneration: 900 })).resolves.toBe(true);
    expect(f.commitCommand.mock.calls[0][5]).toMatchObject({
      leaseGeneration: 900,
      itemEpoch: 1,
      intentItemId: f.item().id,
    });
    await expect(f.detail()).resolves.toMatchObject({ attempt: 1, stage: 'applied' });
  });
  it('leaves the entire protected Item unchanged on UNKNOWN and refuses manual retry', async () => {
    const f = await fixture();
    await f.enqueue();
    let atDispatch: ItemRow | undefined;
    f.domain.commit.mockImplementation(() => {
      atDispatch = structuredClone(f.item());
      f.state.rootLockFailure = new Error('still active');
      return Promise.reject(new Error('P2028 UNKNOWN'));
    });
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.item()).toEqual(atDispatch);
    expect(f.item()).toMatchObject({ attempts: 1, statusCode: 'processing' });
    f.state.rootLockFailure = null;
    await expect(f.retry()).rejects.toMatchObject({ biz: BizCode.CORRECTION_APPLY_STATUS_INVALID });
    expect(f.item()).toEqual(atDispatch);
  });
});

describe('Human queue success attribution', () => {
  it('keeps the protected attempt UNKNOWN when only business anchors became committed', async () => {
    const f = await fixture();
    await f.enqueue();
    let atDispatch: ItemRow | undefined;
    f.domain.commit.mockImplementation(() => {
      atDispatch = structuredClone(f.item());
      f.applied();
      return Promise.reject(new Error('not a proven atomic finish'));
    });
    await expect(f.service.process(f.claim())).resolves.toBe(false);
    expect(f.item()).toEqual(atDispatch);
    expect(f.item().statusCode).toBe('processing');
    // The read surface still reports the independently committed BUSINESS
    // fact. That is not a native worker/XID or protected Item success proof.
    await expect(f.detail()).resolves.toMatchObject({
      applied: true,
      completedUnits: 1,
      retryAllowed: false,
    });
    expect(f.jobs.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ statusCode: 'succeeded' }) as unknown,
      }),
    );
  });
});
