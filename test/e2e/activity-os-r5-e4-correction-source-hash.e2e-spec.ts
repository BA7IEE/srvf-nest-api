import {
  closeE13Fixture,
  createE4Fixture,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  approvedE4TimeCorrection,
  injectE4NullCorrectionHash,
} from '../helpers/activity-r5-correction-hash.fixture';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';

const owner = installE4ValidationDatabase({
  baselineMigrationCount: 136,
  settlementMode: 'active',
  boundMigrationProcesses: true,
});
const stage = async <T>(_label: string, work: () => Promise<T>) => work();
describe('147 correction source hash constraint on real PostgreSQL', () => {
  let f: E4Fixture;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    await owner.deployPolicyBandMigrations(60_000);
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterAll(async () => {
    jest.restoreAllMocks();
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });
  it('upgrades nonempty146 atomically, rejects NULL with complete rollback, and commits valid V3 once', async () => {
    const c = await approvedE4TimeCorrection(f);
    const beforeUpgrade = await nativeLaunchBusinessFingerprint(f.db, stage);
    const functions = () =>
      f.db
        .$queryRaw`SELECT oid::text,prosrc,proconfig,prosecdef,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`;
    const beforeFunctions = await functions();
    await owner.deployCorrectionHashMigrations(60_000);
    expect(await nativeLaunchBusinessFingerprint(f.db, stage)).toEqual(beforeUpgrade);
    expect(await functions()).toEqual(beforeFunctions);
    await owner.deployCorrectionHashMigrations(60_000);
    expect(await nativeLaunchBusinessFingerprint(f.db, stage)).toEqual(beforeUpgrade);
    expect(
      await f.db
        .$queryRaw`SELECT checksum FROM _prisma_migrations WHERE migration_name='20261018000000_activity_contribution_correction_source_hash_required' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    ).toEqual([{ checksum: '2c68710f16c74577e39002ca078a59835e4cc819407b93dcb6188d96dc1c7d2c' }]);
    const before = await nativeLaunchBusinessFingerprint(f.db, stage);
    const injection = injectE4NullCorrectionHash(f);
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
      phase: 'migration147',
      nullRejected: true,
      rollbackTables: before.tables,
      validV3Committed: true,
      replayed: true,
    });
  }, 120_000);
});
