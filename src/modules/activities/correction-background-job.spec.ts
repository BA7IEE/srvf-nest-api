import {
  pureHumanAuthority,
  pureHumanItemStore,
} from '../../../test/helpers/human-correction-authority-pure';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  finishHumanCorrectionJob,
  HUMAN_CORRECTION_JOB_TYPE,
  humanCorrectionJobHash,
  HumanCorrectionLeaseLostError,
  lockHumanCorrectionJobRow,
  humanCorrectionItemHash,
  HUMAN_CORRECTION_ITEM_KEY,
  parseHumanCorrectionJobPayload,
  type HumanCorrectionJobFence,
  type HumanCorrectionJobPayload,
} from './correction-background-job';

const payload: HumanCorrectionJobPayload = {
  action: 'human_correction_commit',
  schemaVersion: 3,
  activityId: 'activity',
  requestId: 'request',
  applicationId: 'application',
  settlementRunId: 'run',
  newSettlementVersionId: 'new-version',
  rootManifestId: 'root',
  postingBatchId: 'batch',
  baseSettlementVersionId: 'base',
  actorUserId: 'actor',
  operationKey: 'operation',
  commitRequestHash: 'commit-hash',
  sourceRequestHash: 'source-hash',
  sourceProofHash: 'proof-hash',
  segmentCount: 1000,
};
const fence: HumanCorrectionJobFence = {
  jobId: 'job',
  leaseOwner: 'worker',
  leaseGeneration: 4,
  payload,
  intentItemId: 'intent',
  intentHash: humanCorrectionItemHash('job', payload),
  itemEpoch: 1,
};
const row = () => ({
  id: fence.jobId,
  payload,
  requestHash: humanCorrectionJobHash(payload),
  createdByUserId: payload.actorUserId,
  payloadVersion: 1,
});
const client = (value: object) => value as Prisma.TransactionClient;

function completion(itemCount = 1, jobCount = 1) {
  const boundClient = {};
  const profile = pureHumanAuthority(boundClient);
  const store = pureHumanItemStore(profile, payload);
  const item = jest.fn(async (args: Parameters<typeof store.items.updateMany>[0]) =>
    itemCount === 0 ? { count: 0 } : store.items.updateMany(args),
  );
  const job = jest.fn().mockResolvedValue({ count: jobCount });
  const tx = client({
    activityBatchJobItem: { ...store.items, updateMany: item },
    activityBatchJob: { updateMany: job },
    $queryRaw: jest.fn((input: unknown, ...values: unknown[]) => {
      const q = profile.query(input);
      if (q.handled) return Promise.resolve(q.value);
      const locked = store.lockQuery(input, values);
      if (locked.handled) return Promise.resolve(locked.value);
      throw new Error('unexpected completion query');
    }),
    $executeRaw: jest.fn((input: unknown) => {
      if (!profile.execute(input)) throw new Error('unexpected completion execute');
      return Promise.resolve(0);
    }),
  });
  return { tx, item, job, authority: profile.authority, store, profile };
}

describe('Human correction background job', () => {
  it('requires a complete payload and binds actor, targets and source hashes to the fingerprint', () => {
    expect(parseHumanCorrectionJobPayload(payload)).toEqual(payload);
    const original = humanCorrectionJobHash(payload);
    for (const change of [
      { actorUserId: 'other' },
      { activityId: 'other' },
      { requestId: 'other' },
      { applicationId: 'other' },
      { settlementRunId: 'other' },
      { newSettlementVersionId: 'other' },
      { rootManifestId: 'other' },
      { postingBatchId: 'other' },
      { baseSettlementVersionId: 'other' },
      { operationKey: 'other' },
      { commitRequestHash: 'other' },
      { sourceRequestHash: 'other' },
      { sourceProofHash: null },
      { schemaVersion: 2 as const },
      { segmentCount: 999 },
    ])
      expect(humanCorrectionJobHash({ ...payload, ...change })).not.toBe(original);
  });

  it.each([
    null,
    [],
    {},
    { ...payload, action: 'other' },
    { ...payload, actorUserId: '' },
    { ...payload, unrecognizedWriteTarget: 'other' },
    { ...payload, sourceProofHash: 2 },
    { ...payload, schemaVersion: 4 },
    { ...payload, schemaVersion: 2, segmentCount: 1 },
    { ...payload, segmentCount: 0 },
    { ...payload, segmentCount: -1 },
    { ...payload, segmentCount: 1.5 },
  ])('rejects invalid payload %#', (value) => {
    expect(() => parseHumanCorrectionJobPayload(value)).toThrow();
  });

  it('accepts a V2 time correction with no changed segments or V3 proof', () => {
    const v2 = { ...payload, schemaVersion: 2 as const, segmentCount: 0, sourceProofHash: null };
    expect(parseHumanCorrectionJobPayload(v2)).toEqual(v2);
  });

  it('locks exactly the processing job with actor target, lease owner, generation and unexpired SQL fence', async () => {
    const query = jest.fn().mockResolvedValue([row()]);
    await lockHumanCorrectionJobRow(client({ $queryRaw: query }), fence);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, ...values] = query.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = sql.join('?');
    expect(text).toContain('"statusCode"=\'processing\'');
    expect(text).toContain('"leaseOwner"=?');
    expect(text).toContain('"leaseGeneration"=?');
    expect(text).toContain('"leaseExpiresAt">clock_timestamp() FOR UPDATE');
    expect(values).toEqual(['job', 'activity', HUMAN_CORRECTION_JOB_TYPE, 'batch', 'worker', 4]);
  });

  it.each([{ rows: [] }, { rows: [row(), row()] }])(
    'rejects missing or nonunique fenced row %#',
    async ({ rows }) => {
      await expect(
        lockHumanCorrectionJobRow(client({ $queryRaw: jest.fn().mockResolvedValue(rows) }), fence),
      ).rejects.toBeInstanceOf(HumanCorrectionLeaseLostError);
    },
  );

  it.each([
    { createdByUserId: 'other' },
    { payloadVersion: 2 },
    { requestHash: 'other' },
    { payload: { ...payload, actorUserId: 'other' } },
    { payload: { ...payload, applicationId: 'other' } },
    { payload: { ...payload, sourceProofHash: 'other' } },
  ])('rejects mismatched persisted identity or hash %#', async (change) => {
    const query = jest.fn().mockResolvedValue([{ ...row(), ...change }]);
    await expect(
      lockHumanCorrectionJobRow(client({ $queryRaw: query }), fence),
    ).rejects.toMatchObject({ biz: BizCode.CORRECTION_OPERATION_KEY_CONFLICT });
  });

  it('marks the protected commit item and job succeeded through the supplied transaction with both fences', async () => {
    const f = completion();
    await finishHumanCorrectionJob(f.tx, fence, f.authority);
    expect(f.item).toHaveBeenCalledWith({
      where: {
        id: 'intent',
        jobId: 'job',
        itemKey: HUMAN_CORRECTION_ITEM_KEY,
        statusCode: 'processing',
        payloadHash: humanCorrectionItemHash('job', payload),
        attempts: 1,
        resourceType: 'CorrectionApplication',
        resourceId: 'application',
      },
      data: {
        statusCode: 'succeeded',
        lastErrorCode: null,
        safeMessage: null,
        resultReference: 'application',
      },
    });
    expect(f.job).toHaveBeenCalledWith({
      where: {
        id: 'job',
        jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
        statusCode: 'processing',
        leaseOwner: 'worker',
        leaseGeneration: 4,
      },
      data: expect.objectContaining({
        statusCode: 'succeeded',
        succeeded: 1,
        failed: 0,
        skipped: 0,
      }) as unknown,
    });
    expect(f.item.mock.invocationCallOrder[0]).toBeLessThan(f.job.mock.invocationCallOrder[0]);
    expect(f.store.row.statusCode).toBe('succeeded');
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });

  it('never publishes job success when its protected item fence is lost', async () => {
    const f = completion(0);
    await expect(finishHumanCorrectionJob(f.tx, fence, f.authority)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.job).not.toHaveBeenCalled();
  });

  it('rejects a lost job fence so the enclosing transaction must roll back the item update', async () => {
    const f = completion(1, 0);
    await expect(finishHumanCorrectionJob(f.tx, fence, f.authority)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.item).toHaveBeenCalledTimes(1);
    expect(f.job).toHaveBeenCalledTimes(1);
  });
});
