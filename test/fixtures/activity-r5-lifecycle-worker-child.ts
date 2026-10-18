import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../../src/database/prisma.service';
import appConfig from '../../src/config/app.config';
import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { assertConnectedTestDatabase } from '../setup/test-db';

// A real, short-lived worker process. Never starts a polling loop or a notification sender.
async function main() {
  const [command, batchId] = process.argv.slice(2);
  if (!['reserve', 'drain'].includes(command) || !batchId)
    throw new Error('Invalid lifecycle worker command');
  const context = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = context.get(PrismaService);
    await assertConnectedTestDatabase(db);
    const mode = context.get<ReturnType<typeof appConfig>>(
      appConfig.KEY,
    ).contributionSettlementMode;
    if (mode !== 'active') throw new Error('Lifecycle worker must use active mode');
    const activityModule = context.select(ActivityBatchWorkerModule);
    const result =
      command === 'reserve'
        ? await activityModule
            .get(LedgerPreparationService, { strict: true })
            .ensurePrepareJob(batchId)
        : await activityModule.get(ActivityBatchWorker, { strict: true }).drainOnce();
    const batch = await db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batchId } });
    process.stdout.write(
      JSON.stringify({ pid: process.pid, mode, result, status: batch.statusCode }),
    );
  } finally {
    await context.close();
  }
}

void main().catch(() => {
  // Do not forward Prisma diagnostics, SQL parameters or connection details through child stderr.
  process.stderr.write('R5 lifecycle worker failed\n');
  process.exitCode = 1;
});
