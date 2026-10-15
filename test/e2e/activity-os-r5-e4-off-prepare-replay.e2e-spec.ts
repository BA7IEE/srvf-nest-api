import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from '../../src/modules/activities/activity-contribution-settlement-query.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { ParticipationTimeLedgerService } from '../../src/modules/activities/participation-time-ledger.service';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { e4FullRowSnapshotSql } from '../helpers/e4-assert143-lifecycle';

// The owning database finalizer runs after the fixture has closed its clients.
installE4ValidationDatabase();

describe('E4 off-mode immutable prepare receipt compatibility', () => {
  let fixture: E4Fixture | undefined;
  const priorGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    fixture = await createE4Fixture();
  }, 120_000);
  afterAll(async () => {
    try {
      await closeE13Fixture(fixture);
    } finally {
      if (priorGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = priorGate;
    }
  });

  it('replays the original uncompleted native job with off configuration without changing any business row', async () => {
    const f = fixture!;
    const source = await createE4Source(f);
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: submitted.settlementVersionId },
    });
    const expectation = {
      evidenceSealId: version.evidenceSealId,
      evidenceRevision: version.evidenceRevision,
      populationRevision: version.populationRevision,
      workflowRevision: version.workflowRevision,
      contentHash: version.contentHash,
    };
    const review = f.app.get(SettlementReviewService);
    await review.firstReview(
      {
        activityId: source.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('first_review'),
        requestHash: 'c'.repeat(64),
      },
      e4Actor(f.reviewer),
      E4_META,
    );
    const final = await review.finalReview(
      {
        activityId: source.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('final_review'),
        requestHash: 'd'.repeat(64),
      },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    expect(final.ledgerPostingBatchId).toBeTruthy();
    const batchId = final.ledgerPostingBatchId!;
    const config = f.app.get<ReturnType<typeof appConfig>>(appConfig.KEY);
    const gate = f.app.get(ActivityWorkflowGate);
    const off = new ActivityContributionSettlementService(
      { ...config, contributionSettlementMode: 'off' },
      f.app.get(ActivityContributionSettlementQueryService),
      gate,
    );
    const consumer = new LedgerPreparationService(
      f.db,
      gate,
      f.app.get(ParticipationTimeLedgerService),
      off,
    );
    const snapshot = async () => {
      const tables = await f.db.$queryRaw<
        { name: string }[]
      >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'_prisma_migrations' ORDER BY relname COLLATE "C"`;
      expect(tables.length).toBeGreaterThanOrEqual(196);
      return JSON.stringify(
        await f.db.$queryRawUnsafe(
          e4FullRowSnapshotSql(
            'public',
            tables.map(({ name }) => name),
          ),
        ),
      );
    };
    const beforeNew = await snapshot();
    await expect(consumer.ensurePrepareJob(batchId)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
    });
    expect((await snapshot()) === beforeNew).toBe(true);
    const original = await f.app.get(LedgerPreparationService).ensurePrepareJob(batchId);
    const beforeReplay = await snapshot();
    await expect(consumer.ensurePrepareJob(batchId)).resolves.toEqual(original);
    expect((await snapshot()) === beforeReplay).toBe(true);
    expect(
      await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: original.jobId },
        select: { statusCode: true, succeeded: true },
      }),
    ).toEqual({ statusCode: 'pending', succeeded: 0 });
    expect(
      await f.db.participationTimeLedgerManifest.count({ where: { postingBatchId: batchId } }),
    ).toBe(1);
    expect(
      await f.db.participationTimeLedgerEntry.count({ where: { postingBatchId: batchId } }),
    ).toBe(0);
    console.info(
      'E4_OFF_PREPARE_REPLAY',
      JSON.stringify({
        actualOffConfiguration: true,
        newWriteRejected: true,
        existingUncompletedReceipt: true,
        fullBusinessRowsUnchanged: true,
        noManifestRepair: true,
      }),
    );
  }, 120_000);
});
