import { Test } from '@nestjs/testing';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { loadTestEnv } from '../../../test/setup/load-env';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerPostingService } from './ledger-posting.service';

describe('native contribution dependencies in the deployed worker graphs', () => {
  beforeAll(() => loadTestEnv());

  it.each(['notification', 'storage'] as const)(
    '%s supplies the real native collaborator to both ledger services without connecting to a database',
    async (kind) => {
      const { ActivityBatchWorkerModule } = await import('./activity-batch-worker.module');
      const workerModule =
        kind === 'notification'
          ? (await import('../notifications/notification-outbox-worker.module'))
              .NotificationOutboxWorkerModule
          : (await import('../attachments/storage-consistency-worker.module'))
              .StorageConsistencyWorkerModule;
      const connect = jest.fn();
      const moduleRef = await Test.createTestingModule({ imports: [workerModule] })
        .overrideProvider(appConfig.KEY)
        .useValue({
          ...appConfig(),
          contributionSettlementMode: 'active',
          activityV11Workflow: { enabled: true, readonlyMaintenance: false },
        })
        .overrideProvider(PrismaService)
        .useValue({ $connect: connect, $disconnect: jest.fn() })
        .compile();
      try {
        const graph = moduleRef.select(ActivityBatchWorkerModule);
        const native = graph.get(ActivityContributionSettlementService, { strict: true });
        expect(
          moduleRef.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
        ).toBe('active');
        expect(
          Reflect.get(graph.get(LedgerPreparationService, { strict: true }), 'contributions'),
        ).toBe(native);
        expect(
          Reflect.get(graph.get(LedgerPostingService, { strict: true }), 'contributions'),
        ).toBe(native);
        expect(() => native.assertNativeWriteAllowed()).not.toThrow();
        expect(connect).not.toHaveBeenCalled();
      } finally {
        await moduleRef.close();
      }
    },
    30_000,
  );
});
