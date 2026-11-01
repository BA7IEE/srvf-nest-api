import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';
import { loadTestEnv } from '../test/setup/load-env';
import { HumanCorrectionWorkerModule } from './modules/activities/human-correction-worker.module';
import { ActivityBatchWorkerModule } from './modules/activities/activity-batch-worker.module';
import { ActivityBatchWorker } from './modules/activities/activity-batch.worker';
import { StorageConsistencyWorkerModule } from './modules/attachments/storage-consistency-worker.module';
import { StorageConsistencyWorker } from './modules/attachments/storage-consistency.worker';
import { AttachmentStorageOrchestrator } from './modules/attachments/attachment-storage-orchestrator';
import { NotificationOutboxWorkerModule } from './modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxWorker } from './modules/notifications/notification-outbox.worker';
import { StorageObjectLedgerService } from './modules/storage/storage-object-ledger.service';

/** Execute the two real CLI dispatch functions. Context transport is mocked;
 * normal module lifecycle/core qualification have their separate init tests. */
describe.each(['notification', 'storage'] as const)('actual %s CLI dispatch', (kind) => {
  beforeAll(() => loadTestEnv());
  afterEach(() => jest.restoreAllMocks());
  async function setup(enabled: boolean, scope = 'human-correction') {
    const humanRun = jest.fn().mockResolvedValue(undefined);
    const unrelatedRun = jest.fn().mockResolvedValue(undefined);
    const manual = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn().mockResolvedValue(undefined);
    const strictGet = jest.fn((token: unknown, options: unknown) => {
      expect(options).toEqual({ strict: true });
      if (token === ActivityBatchWorker) return { executionScope: scope, run: humanRun };
      if (token === StorageConsistencyWorker) return { run: unrelatedRun, drainOnce: manual };
      if (token === NotificationOutboxWorker) return { run: unrelatedRun };
      if (token === AttachmentStorageOrchestrator)
        return {
          prepareManualRelocate: manual,
          prepareManualAttestAbsent: manual,
          executeEventKey: manual,
        };
      throw new Error('unexpected token');
    });
    const select = jest.fn((module: unknown) => {
      expect([
        ActivityBatchWorkerModule,
        HumanCorrectionWorkerModule,
        StorageConsistencyWorkerModule,
        NotificationOutboxWorkerModule,
      ]).toContain(module);
      return { get: strictGet };
    });
    const cfg = new ConfigService({
      app: {
        humanCorrectionBackground: enabled
          ? {
              mode: 'first-launch',
              installedRecordPath: '/record.json',
              installedRecordSha256: '1'.repeat(64),
            }
          : { mode: 'off' },
      },
    });
    const app = {
      enableShutdownHooks: jest.fn(),
      select,
      close,
      get: jest.fn((token: unknown) => {
        if (token === ConfigService) return cfg;
        if (token === StorageObjectLedgerService)
          return { assertStrictStartGate: manual, purgeExpiredDeleteReplays: manual };
        throw new Error('unexpected global token');
      }),
    };
    jest
      .spyOn(NestFactory, 'createApplicationContext')
      .mockResolvedValue(app as unknown as INestApplicationContext);
    const bootstrap =
      kind === 'notification'
        ? (await import('./notification-outbox-worker')).bootstrapNotificationOutboxWorker
        : (await import('./storage-consistency-worker')).bootstrapStorageConsistencyWorker;
    return { bootstrap, humanRun, unrelatedRun, manual, close, select };
  }
  it('selected Human mode executes only the strictly selected activity loop', async () => {
    const f = await setup(true);
    await f.bootstrap(['--human-correction-only']);
    expect(f.humanRun).toHaveBeenCalledTimes(1);
    expect(f.unrelatedRun).not.toHaveBeenCalled();
    expect(f.manual).not.toHaveBeenCalled();
    expect(f.select).toHaveBeenCalledWith(HumanCorrectionWorkerModule);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('off mode preserves both original loops', async () => {
    const f = await setup(false, 'generic');
    await f.bootstrap([]);
    expect(f.humanRun).toHaveBeenCalledTimes(1);
    expect(f.unrelatedRun).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    [false, ['--human-correction-only']],
    [true, []],
    [true, ['--human-correction-only', '--once']],
    [true, ['--human-correction-only', '--strict-gate']],
    [true, ['--human-correction-only', '--purge-replays']],
    [true, ['--human-correction-only', '--relocate=operation']],
    [true, ['--human-correction-only', '--attest-absent=operation']],
  ] as const)('rejects mode=%s args=%j before any loop/manual action', async (enabled, args) => {
    const f = await setup(enabled);
    await expect(f.bootstrap(args)).rejects.toThrow('HUMAN_WORKER_ARGUMENTS');
    expect(f.humanRun).not.toHaveBeenCalled();
    expect(f.unrelatedRun).not.toHaveBeenCalled();
    expect(f.manual).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('wrong worker scope fails before any work', async () => {
    const f = await setup(true, 'generic');
    await expect(f.bootstrap(['--human-correction-only'])).rejects.toThrow('HUMAN_WORKER_SCOPE');
    expect(f.humanRun).not.toHaveBeenCalled();
    expect(f.unrelatedRun).not.toHaveBeenCalled();
    expect(f.manual).not.toHaveBeenCalled();
  });
});
