import { Prisma } from '@prisma/client';
import {
  pureHumanAuthority,
  pureHumanItemStore,
} from '../../../test/helpers/human-correction-authority-pure';
import {
  HumanCorrectionItemAuthority,
  draftGenerateExhaustionStatement,
} from './human-correction-item-authority';
import {
  HUMAN_CORRECTION_ITEM_KEY,
  HUMAN_CORRECTION_UNAPPLIED,
  HumanCorrectionAuthorityUnavailableError,
  HumanCorrectionLeaseLostError,
  humanCorrectionItemHash,
  humanCorrectionJobHash,
  type HumanCorrectionJobFence,
  type HumanCorrectionJobPayload,
} from './human-correction-intent';
import { lockHumanCorrectionJob } from './correction-background-job';
import {
  SETTLEMENT_DRAFT_GENERATE_JOB_TYPE,
  SETTLEMENT_DRAFT_GENERATE_JOB_ACTION,
} from './settlement-draft-dispatch.service';

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
  actorUserId: 'B',
  operationKey: 'operation',
  commitRequestHash: 'commit',
  sourceRequestHash: 'source',
  sourceProofHash: 'proof',
  segmentCount: 1000,
};
function fixture() {
  const client = {};
  const profile = pureHumanAuthority(client),
    store = pureHumanItemStore(profile, payload);
  const query = jest.fn((input: unknown, ...values: unknown[]) => {
    const p = profile.query(input);
    if (p.handled) return Promise.resolve(p.value);
    const locked = store.lockQuery(input, values);
    if (locked.handled) return Promise.resolve(locked.value);
    if (profile.sql(input).includes('FROM "ActivityBatchJob"'))
      return Promise.resolve([
        {
          id: 'job',
          payload,
          requestHash: humanCorrectionJobHash(payload),
          createdByUserId: 'B',
          payloadVersion: 1,
        },
      ]);
    throw new Error('unexpected authority query');
  });
  const execute = jest.fn((input: unknown) => {
    if (profile.execute(input)) return Promise.resolve(0);
    profile.requireP();
    return Promise.resolve(0);
  });
  const tx = {
    activityBatchJobItem: store.items,
    $queryRaw: query,
    $executeRaw: execute,
  } as unknown as Prisma.TransactionClient;
  const fence: HumanCorrectionJobFence = {
    jobId: 'job',
    leaseOwner: 'worker',
    leaseGeneration: 2,
    payload,
    intentItemId: 'intent',
    intentHash: humanCorrectionItemHash('job', payload),
    itemEpoch: 1,
  };
  return { client, profile, store, tx, query, execute, fence, authority: profile.authority };
}

describe('Human protected Item authority (pure model, NOT PG authentication)', () => {
  it('refuses missing trusted connection before SQL or Item writes', async () => {
    const f = fixture(),
      disabled = new HumanCorrectionItemAuthority();
    expect(() => disabled.assertClient(f.profile.binding.client)).toThrow(
      HumanCorrectionAuthorityUnavailableError,
    );
    await expect(disabled.readInTx(f.tx, 'job', payload)).rejects.toBeInstanceOf(
      HumanCorrectionAuthorityUnavailableError,
    );
    expect(f.query).not.toHaveBeenCalled();
    expect(f.store.items.create).not.toHaveBeenCalled();
  });
  it('refuses a different client instead of selecting an administrator fallback', () => {
    const f = fixture();
    expect(() => f.authority.assertClient(pureHumanAuthority({}).binding.client)).toThrow(
      HumanCorrectionAuthorityUnavailableError,
    );
  });
  it.each(['session', 'current', 'qualification'] as const)(
    'rejects wrong %s identity before entering P',
    async (field) => {
      const f = fixture();
      if (field === 'session') f.profile.state.sessionRole = 'postgres';
      else if (field === 'current') f.profile.state.currentRole = 'postgres';
      else f.profile.state.qualified = false;
      await expect(f.authority.acceptInTx(f.tx, 'job', payload, false)).rejects.toBeInstanceOf(
        HumanCorrectionAuthorityUnavailableError,
      );
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.store.items.create).not.toHaveBeenCalled();
    },
  );
  it('qualifies session and membership rather than treating current_user=C as permanent deprivileging', async () => {
    const f = fixture();
    await f.authority.readInTx(f.tx, 'job', payload);
    const sql = f.profile.sql(f.query.mock.calls[0][0]);
    expect(sql).toContain('session_user::text');
    expect(sql).toContain('set_option AND inherit_option AND NOT admin_option');
    expect(sql).toContain("pg_has_role(c.oid,p.oid,'SET')");
    expect(sql).toContain('has_any_column_privilege');
    expect(f.profile.state.identities).toEqual(['pure_caller', 'pure_authority', 'pure_caller']);
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });
  it('requires a callable source qualifier, not only nonempty review strings', async () => {
    const f = fixture();
    Reflect.deleteProperty(f.profile.binding, 'qualifyInTx');
    await expect(f.authority.acceptInTx(f.tx, 'job', payload, false)).rejects.toBeInstanceOf(
      HumanCorrectionAuthorityUnavailableError,
    );
    expect(f.query).not.toHaveBeenCalled();
    expect(f.store.items.create).not.toHaveBeenCalled();
  });
  it('binds qualification to this tx, cluster and frozen catalog/preflight instead of accepting a mismatched receipt', async () => {
    const f = fixture();
    f.profile.qualification.mockResolvedValue({
      ...f.profile.binding.source,
      clusterSystemIdentifier: '1000',
      databaseName: 'pure_clone',
      databaseOid: '100',
    });
    await expect(f.authority.acceptInTx(f.tx, 'job', payload, false)).rejects.toBeInstanceOf(
      HumanCorrectionAuthorityUnavailableError,
    );
    expect(f.profile.qualification).toHaveBeenCalledWith(f.tx);
    expect(f.store.items.create).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('qualification failure cannot silently fall back to an unchecked P operation', async () => {
    const f = fixture();
    f.profile.qualification.mockRejectedValue(new Error('source mismatch'));
    await expect(f.authority.acceptInTx(f.tx, 'job', payload, false)).rejects.toBeInstanceOf(
      HumanCorrectionAuthorityUnavailableError,
    );
    expect(f.store.items.create).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('sets the existing 4s lock ceiling on the same metadata tx without extending the native budget', async () => {
    const f = fixture();
    await f.authority.assertCallerInTx(f.tx);
    expect(f.profile.state.lockTimeoutMs).toBe(4000);
    expect(f.execute.mock.calls.map((c) => f.profile.sql(c[0]))).toContain(
      "SET LOCAL lock_timeout = '4s'",
    );
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });
  it('binds a protected v2 intent to the Job id as well as the complete original B payload', () => {
    expect(humanCorrectionItemHash('job', payload)).not.toBe(
      humanCorrectionItemHash('renamed-job', payload),
    );
    expect(humanCorrectionItemHash('job', payload)).not.toBe(
      humanCorrectionItemHash('job', { ...payload, actorUserId: 'A' }),
    );
    expect(humanCorrectionItemHash('job', payload)).not.toBe(
      humanCorrectionItemHash('job', { ...payload, operationKey: 'other' }),
    );
  });
  it.each([
    { itemKey: 'commit' },
    { itemKey: 'generate' },
    { itemKey: 'identity:any' },
    { payloadHash: humanCorrectionJobHash(payload) },
    { resourceId: 'other' },
    { resourceType: 'activity' },
  ])('never upgrades a generic/old/corrupt Item to Human authority %#', async (change) => {
    const f = fixture();
    Object.assign(f.store.row, change);
    await expect(f.authority.readInTx(f.tx, 'job', payload, true)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.store.items.create).not.toHaveBeenCalled();
    expect(f.store.items.updateMany).not.toHaveBeenCalled();
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });
  it('rejects ON UPDATE CASCADE reattachment despite unchanged protected Item id/hash', async () => {
    const f = fixture();
    f.store.row.jobId = 'renamed-job';
    await expect(f.authority.readInTx(f.tx, 'renamed-job', payload, true)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.store.items.updateMany).not.toHaveBeenCalled();
  });
  it('accepts only through P, then derives a dispatch epoch from the protected pending CAS', async () => {
    const f = fixture();
    const accepted = await f.authority.acceptInTx(f.tx, 'job', payload, false);
    expect(accepted).toMatchObject({ id: 'intent', itemEpoch: 0, statusCode: 'pending' });
    const started = await f.authority.startInTx(f.tx, accepted, payload);
    expect(started).toMatchObject({
      itemEpoch: 1,
      statusCode: 'processing',
      intentHash: accepted.intentHash,
    });
    expect(f.store.items.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'intent',
        jobId: 'job',
        itemKey: HUMAN_CORRECTION_ITEM_KEY,
        payloadHash: accepted.intentHash,
        attempts: 0,
        statusCode: 'pending',
      }) as unknown,
      data: expect.objectContaining({
        attempts: { increment: 1 },
        statusCode: 'processing',
      }) as unknown,
    });
    expect(f.profile.state.writes.every((r) => r === 'pure_authority')).toBe(true);
  });
  it('does not issue a second permit for a processing Item even when Job generation is replaced', async () => {
    const f = fixture();
    const intent = await f.authority.readInTx(f.tx, 'job', payload, true);
    expect(await f.authority.startInTx(f.tx, intent, payload)).toBeNull();
    expect(f.store.items.updateMany).not.toHaveBeenCalled();
  });
  it('the real native guard holds the protected Item lock on the same supplied transaction', async () => {
    const f = fixture();
    await lockHumanCorrectionJob(f.tx, f.fence, f.authority);
    const texts = f.query.mock.calls.map((c) => f.profile.sql(c[0]));
    expect(texts.find((s) => s.includes('FROM "ActivityBatchJobItem"'))).toContain('FOR UPDATE');
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });
  it.each([
    { intentItemId: 'other' },
    { itemEpoch: 2 },
    { itemEpoch: 0 },
    { intentHash: 'forged' },
  ])('rejects a stale or rewritten native Item fence %#', async (change) => {
    const f = fixture();
    await expect(
      lockHumanCorrectionJob(f.tx, { ...f.fence, ...change }, f.authority),
    ).rejects.toBeInstanceOf(HumanCorrectionLeaseLostError);
    expect(f.store.items.updateMany).not.toHaveBeenCalled();
  });
  it('the native guard cannot be enabled merely by supplying the old writable Job fence', async () => {
    const f = fixture();
    await expect(lockHumanCorrectionJob(f.tx, f.fence)).rejects.toBeInstanceOf(
      HumanCorrectionAuthorityUnavailableError,
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it('confirmed-unapplied recovery fences the old attempt before retry, then marker creates a newer epoch', async () => {
    const f = fixture();
    const original = await f.authority.readInTx(f.tx, 'job', payload, true);
    const failed = await f.authority.confirmUnappliedInTx(f.tx, original, payload);
    expect(failed).toMatchObject({
      statusCode: 'failed',
      itemEpoch: 2,
      lastErrorCode: HUMAN_CORRECTION_UNAPPLIED,
    });
    await expect(f.authority.assertAttemptInTx(f.tx, f.fence)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    const pending = await f.authority.retryInTx(f.tx, failed, payload);
    expect(pending).toMatchObject({ statusCode: 'pending', itemEpoch: 2 });
    await expect(f.authority.assertAttemptInTx(f.tx, f.fence)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    const newer = await f.authority.startInTx(f.tx, pending, payload);
    expect(newer).toMatchObject({ statusCode: 'processing', itemEpoch: 3 });
    await expect(f.authority.finishInTx(f.tx, f.fence)).rejects.toBeInstanceOf(
      HumanCorrectionLeaseLostError,
    );
    expect(f.store.row).toMatchObject({ statusCode: 'processing', attempts: 3 });
  });
  it.each(['pending', 'processing', 'failed'] as const)(
    'does not sign %s as this attempt success just because business was independently applied',
    async (status) => {
      const f = fixture();
      f.store.row.statusCode = status;
      const intent = await f.authority.readInTx(f.tx, 'job', payload, true);
      await expect(f.authority.confirmAppliedInTx(f.tx, intent, payload)).rejects.toThrow(
        'AppliedIntentUnconfirmed',
      );
      expect(f.store.items.updateMany).not.toHaveBeenCalled();
    },
  );
  it('a failed P role restoration rejects the method, never reports a successful acceptance', async () => {
    const f = fixture();
    f.profile.state.restoreFails = true;
    await expect(f.authority.acceptInTx(f.tx, 'job', payload, false)).rejects.toThrow(
      'PURE_RESTORE_FAILURE',
    );
    // The row model is not a DB rollback simulator; only callback rejection is claimed.
  });
  it('rejects a changed generic sweep before any role switch or DML', async () => {
    const f = fixture(),
      now = new Date('2026-10-31T00:00:00Z');
    const changed = Prisma.sql`UPDATE "ActivityBatchJobItem" SET "statusCode"='pending' WHERE true`;
    await expect(
      f.authority.sweepDraftGenerateDeadInTx(f.profile.binding.client, f.tx, now, 5, changed),
    ).rejects.toBeInstanceOf(HumanCorrectionAuthorityUnavailableError);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('the fixed old sweep uses P without accepting an arbitrary SQL/key/type callback', async () => {
    const f = fixture();
    const now = new Date('2026-10-31T00:00:00Z');
    await f.authority.sweepDraftGenerateDeadInTx(f.profile.binding.client, f.tx, now, 5);
    const statement = draftGenerateExhaustionStatement(now, 5);
    expect(statement.values).toEqual([
      now,
      SETTLEMENT_DRAFT_GENERATE_JOB_TYPE,
      SETTLEMENT_DRAFT_GENERATE_JOB_ACTION,
      5,
      now,
    ]);
    expect(statement.sql).toContain('WITH expired AS');
    expect(statement.sql).toContain('"itemKey" = \'generate\'');
    expect(statement.sql).not.toContain(HUMAN_CORRECTION_ITEM_KEY);
    expect(f.profile.state.currentRole).toBe('pure_caller');
  });
});
