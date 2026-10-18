import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  postE4Ledger,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';

// Explicit diagnostic only: the default *.e2e-spec.ts suite never treats acceptance of
// the baseline defect as a regression contract. Both phases use the actual PostgreSQL
// schema, complete correction transaction, immutable sources and original guard functions.
installE4ValidationDatabase({ settlementMode: 'active' });
const candidate = readFileSync(
  resolve(__dirname, '../../docs/plans/activity-os-r5-source-hash-required.proposed.sql'),
  'utf8',
).match(/ALTER TABLE[\s\S]*?;/u)?.[0];
if (!candidate) throw new Error('Exact source-hash constraint candidate missing');
const stage = async <T>(_label: string, work: () => Promise<T>) => work();

describe('146 NULL source-hash reproduction and proposed 147 validation', () => {
  let f: E4Fixture;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  async function approvedTimeCorrection() {
    const source = await createE4Source(f);
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    await postE4Ledger(f, submitted);
    const segment = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
      where: {
        participationIdentityId: source.identity.id,
        statusCode: 'committed',
        resultCode: 'valid',
      },
      orderBy: { revision: 'desc' },
    });
    const allocation = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { sourceSegmentId: segment.id },
      orderBy: { revision: 'desc' },
    });
    const recognized = await f.app.get(ActivityTimeAllocationService).recognize(
      source.activityId,
      {
        operationKey: f.key('null_allocation'),
        sourceSegmentId: segment.id,
        expectedRevision: allocation.revision,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    const original = await f.db.participationTimeLedgerManifest.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    const roots = await f.db.participationTimeLedgerEntry.findMany({
      where: { manifestId: original.id },
    });
    const correction = f.app.get(CorrectionApplicationService);
    const requested = await correction.submit(
      {
        activityId: source.activityId,
        participationIdentityId: source.identity.id,
        requestTypeCode: 'time',
        requestedChangeJson: {
          schemaVersion: 3,
          results: [],
          segments: [
            {
              participationIdentityId: source.identity.id,
              segmentKey: segment.segmentKey,
              checkInAt: source.startsAt.toISOString(),
              checkOutAt: new Date(source.startsAt.getTime() + 1800_000).toISOString(),
              resultCode: 'valid',
              serviceHours: '0.50',
            },
          ],
          timeCorrection: {
            baseSettlementVersionId: submitted.settlementVersionId,
            baseTimeLedgerHash: original.contentHash,
            reason: 'NULL constraint diagnostic',
            items: roots.map((root) => ({
              rootEntryId: root.id,
              recognizedSeconds:
                root.categoryCode === 'volunteer_service' ? 1800 : root.recognizedSeconds,
            })),
          },
          allocations: [
            {
              participationIdentityId: source.identity.id,
              segmentKey: segment.segmentKey,
              baseSegmentRevisionId: segment.id,
              baseAllocationRevisionId: recognized.allocationRevisionId,
              recognitionModeCode: 'automatic',
              manualReason: null,
              slices: [],
              evidenceAttachmentIds: [],
            },
          ],
        },
        reason: 'NULL constraint diagnostic',
        operationKey: f.key('null_request'),
        requestHash: 'e'.repeat(64),
      },
      e4Actor(f.creator, true),
      E4_META,
      { human: true },
    );
    await correction.review(
      { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    return {
      correction,
      input: {
        correctionRequestId: requested.correctionRequestId,
        operationKey: f.key('null_prepare'),
        requestHash: 'f'.repeat(64),
      },
    };
  }

  function injectNull() {
    const service = f.app.get(ActivityContributionSettlementService);
    const original = service.prepareCorrectionInTx.bind(service);
    return jest
      .spyOn(service, 'prepareCorrectionInTx')
      .mockImplementationOnce(async (tx, ...args) => {
        const create = tx.activitySettlementContributionRevision.create.bind(
          tx.activitySettlementContributionRevision,
        );
        const interception = jest
          .spyOn(tx.activitySettlementContributionRevision, 'create')
          .mockImplementationOnce((input) => {
            input.data.correctionSourceSetHash = null;
            return create(input);
          });
        try {
          return await original(tx, ...args);
        } finally {
          interception.mockRestore();
        }
      });
  }

  it('reproduces a committed NULL correction hash on 146 and refuses dirty upgrade atomically', async () => {
    const c = await approvedTimeCorrection();
    const injection = injectNull();
    const prepared = await c.correction.prepare(c.input, e4Actor(f.finalReviewer), E4_META);
    injection.mockRestore();
    const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    expect(root.sourceKindCode).toBe('correction_time_proof');
    expect(root.correctionSourceSetHash).toBeNull();
    // This is an independent post-COMMIT call through the installed full validator.
    await f.db.$queryRaw`SELECT e4_assert_complete(${root.id})::TEXT`;
    const before = await nativeLaunchBusinessFingerprint(f.db, stage);
    await expect(f.db.$executeRawUnsafe(candidate)).rejects.toMatchObject({
      meta: { code: '23514' },
    });
    expect(
      await f.db
        .$queryRaw`SELECT conname FROM pg_constraint WHERE conrelid='public."ActivitySettlementContributionRevision"'::regclass AND conname='e4_revision_correction_source_hash_required'`,
    ).toEqual([]);
    expect(await nativeLaunchBusinessFingerprint(f.db, stage)).toEqual(before);
    console.info('E4_NULL_SOURCE_HASH', {
      phase: '146',
      committedNull: true,
      fullValidatorAccepted: true,
      dirtyUpgradeRejected: true,
      tables: before.tables,
    });
  }, 120_000);

  it('rejects NULL with the proposed validated constraint, rolls back the complete command and preserves valid V3', async () => {
    const c = await approvedTimeCorrection();
    await f.db.$executeRawUnsafe(candidate);
    const before = await nativeLaunchBusinessFingerprint(f.db, stage);
    const injection = injectNull();
    await expect(c.correction.prepare(c.input, e4Actor(f.finalReviewer), E4_META)).rejects.toThrow(
      'e4_revision_correction_source_hash_required',
    );
    injection.mockRestore();
    expect(await nativeLaunchBusinessFingerprint(f.db, stage)).toEqual(before);
    const prepared = await c.correction.prepare(c.input, e4Actor(f.finalReviewer), E4_META);
    const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    const proof = await f.db.correctionTimeSourceProof.findUniqueOrThrow({
      where: { id: root.correctionTimeSourceProofId! },
    });
    expect(root.correctionSourceSetHash).toBe(proof.sourceSetHash);
    await f.db.$queryRaw`SELECT e4_assert_complete(${root.id})::TEXT`;
    const committed = await c.correction.commit(c.input, e4Actor(f.finalReviewer), E4_META);
    expect(committed).toMatchObject({
      correctionStatus: 'applied',
      applicationStatus: 'committed',
      replayed: false,
      ledger: {
        postingBatchId: prepared.newPostingBatchId,
        settlementVersionId: prepared.newSettlementVersionId,
        batchStatus: 'committed',
        committedAt: expect.any(Date) as unknown,
      },
    });
    const batch = await f.db.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: prepared.newPostingBatchId },
    });
    expect(batch.statusCode).toBe('committed');
    expect(batch.committedAt).toEqual(committed.ledger.committedAt);
    expect(committed.ledger.entryCount).toBe(4);
    expect(await f.db.participationLedgerEntry.count({ where: { postingBatchId: batch.id } })).toBe(
      4,
    );
    expect((await c.correction.commit(c.input, e4Actor(f.finalReviewer), E4_META)).replayed).toBe(
      true,
    );
    const constraint = await f.db.$queryRaw<
      { validated: boolean }[]
    >`SELECT convalidated AS validated FROM pg_constraint WHERE conrelid='public."ActivitySettlementContributionRevision"'::regclass AND conname='e4_revision_correction_source_hash_required'`;
    expect(constraint).toEqual([{ validated: true }]);
    console.info('E4_NULL_SOURCE_HASH', {
      phase: 'proposed147',
      nullRejected: true,
      rollbackTables: before.tables,
      validV3Committed: true,
      replayed: true,
    });
  }, 120_000);
});
