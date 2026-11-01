import type { Type } from '@nestjs/common';
import { pureHumanRuntimeTransportFixture } from '../../../test/helpers/human-correction-authority-pure';
import { HumanCorrectionWorkerModule } from './human-correction-worker.module';
import {
  HumanCorrectionExecutionModule,
  getHumanCorrectionService,
} from './human-correction-execution.module';
import { HUMAN_CORRECTION_CLIENT } from './human-correction-runtime-client';
import { HUMAN_CORRECTION_INSTALLED_CONNECTION } from './human-correction-trusted-connection';
import { HumanCorrectionAuthorityUnavailableError } from './human-correction-intent';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { CorrectionApplicationService } from './correction-application.service';
import { ActivityBatchWorker } from './activity-batch.worker';
import { Test } from '@nestjs/testing';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { loadTestEnv } from '../../../test/setup/load-env';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerPostingService } from './ledger-posting.service';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from '../../config/database.config';
import jwtConfig from '../../config/jwt.config';
import { Role, UserStatus } from '@prisma/client';
import { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import { CorrectionTimeAllocationService } from './correction-time-allocation.service';
import {
  HUMAN_CORRECTION_BACKGROUND_BUDGET,
  HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
  type HumanCorrectionBackgroundBudget,
} from './human-correction-background-budget';

describe('actual independent worker budget injection, without database', () => {
  beforeAll(() => loadTestEnv());
  it.each([
    ['standalone', false],
    ['standalone', true],
    ['notification', false],
    ['notification', true],
    ['storage', false],
    ['storage', true],
  ] as const)(
    '%s candidate=%s constructs its actual local service and selects the bounded profile',
    async (kind, candidate) => {
      const { ActivityBatchWorkerModule } = await import('./activity-batch-worker.module');
      // Both existing CLI Human selections dispatch to this same minimal root.
      // Ordinary roots remain separate and explicitly OFF.
      const imports = candidate
        ? [HumanCorrectionWorkerModule]
        : kind === 'standalone'
          ? [
              ConfigModule.forRoot({
                isGlobal: true,
                load: [appConfig, databaseConfig, jwtConfig],
              }),
              ActivityBatchWorkerModule,
            ]
          : [
              kind === 'notification'
                ? (await import('../notifications/notification-outbox-worker.module'))
                    .NotificationOutboxWorkerModule
                : (await import('../attachments/storage-consistency-worker.module'))
                    .StorageConsistencyWorkerModule,
            ];
      const stop = new Error('OFFLINE_DI_TRANSACTION_BOUNDARY');
      const connect = jest.fn();
      const transaction = jest.fn(() => Promise.reject(stop));
      const transport = pureHumanRuntimeTransportFixture();
      const prisma = Object.assign(transport.client, {
        $connect: connect,
        $disconnect: jest.fn(),
        $transaction: transaction,
        attendanceCorrectionRequest: {
          findUnique: jest.fn(() => Promise.resolve({ activityId: 'activity' })),
        },
      });
      let builder = Test.createTestingModule({ imports })
        .overrideProvider(appConfig.KEY)
        .useValue({
          ...appConfig(),
          contributionSettlementMode: 'active',
          activityV11Workflow: { enabled: true, readonlyMaintenance: false },
          humanCorrectionBackground: candidate
            ? {
                mode: 'first-launch',
                installedRecordPath: '/pure/installed.json',
                installedRecordSha256: '1'.repeat(64),
              }
            : { mode: 'off' },
        });
      if (candidate) {
        // Replace SQL transport / non-secret fixture input only. The real
        // trusted factory, budget selector and services are NOT overridden.
        builder = builder
          .overrideProvider(HUMAN_CORRECTION_CLIENT)
          .useValue(prisma)
          .overrideProvider(HUMAN_CORRECTION_INSTALLED_CONNECTION)
          .useValue(transport.record);
      } else builder = builder.overrideProvider(PrismaService).useValue(prisma);
      const moduleRef = await builder.compile();
      try {
        const graph = moduleRef.select(
          candidate ? HumanCorrectionExecutionModule : ActivityBatchWorkerModule,
        );
        const local = <T extends object>(token: Type<T>): T =>
          candidate ? getHumanCorrectionService(graph, token) : graph.get(token, { strict: true });
        const service = local(CorrectionApplicationService);
        const command = local(ActivityTimeCorrectionCommandService);
        const background = local(ActivityTimeCorrectionBackgroundService);
        const worker = local(ActivityBatchWorker);
        expect(Reflect.get(worker, 'humanCorrections')).toBe(background);
        expect(Reflect.get(background, 'commands')).toBe(command);
        expect(Reflect.get(command, 'corrections')).toBe(service);
        expect(Reflect.get(service, 'prisma')).toBe(prisma);
        const profile = graph.get<HumanCorrectionBackgroundBudget>(
          HUMAN_CORRECTION_BACKGROUND_BUDGET,
          { strict: true },
        );
        expect(profile).toEqual(
          candidate
            ? { bulkCommit: true, bulkPrepare: true }
            : HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
        );
        if (!candidate) expect(profile).toBe(HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF);
        expect(Reflect.get(service, 'backgroundBudget')).toBe(profile);
        expect(Reflect.get(command, 'backgroundBudget')).toBe(profile);
        expect(worker.executionScope).toBe(candidate ? 'human-correction' : 'general');
        // Only select the real method's transaction options. Offline substitutes
        // stop before its callback; this is not actor/ACL/SQL or COMMIT evidence.
        const items = local(HumanCorrectionItemAuthority);
        expect(items.hasConnectionBinding).toBe(candidate);
        jest
          .spyOn(local(CorrectionTimeAllocationService), 'prevalidateFrozenSourceProof')
          .mockResolvedValue(undefined);
        const payload = {
          action: 'human_correction_commit' as const,
          schemaVersion: 3 as const,
          segmentCount: 1000,
          activityId: 'activity',
          requestId: 'request',
          applicationId: 'application',
          settlementRunId: 'run',
          newSettlementVersionId: 'new-version',
          rootManifestId: 'root',
          postingBatchId: 'batch',
          baseSettlementVersionId: 'base',
          actorUserId: 'actor',
          operationKey: 'op',
          commitRequestHash: 'hash',
          sourceRequestHash: 'source',
          sourceProofHash: null,
        };
        const fence = {
          jobId: 'job',
          leaseOwner: 'worker',
          leaseGeneration: 7,
          intentItemId: 'item',
          intentHash: 'offline',
          itemEpoch: 5,
          payload,
        };
        const actor = {
          id: 'actor',
          username: 'offline',
          role: Role.USER,
          status: UserStatus.ACTIVE,
          memberId: 'member',
        };
        for (const mode of ['bulk', 'small', 'synchronous', 'standard'] as const) {
          transaction.mockClear();
          const options =
            mode === 'standard'
              ? undefined
              : {
                  human: true as const,
                  ...(mode === 'synchronous'
                    ? {}
                    : {
                        backgroundJob: {
                          ...fence,
                          payload: { ...payload, segmentCount: mode === 'small' ? 999 : 1000 },
                        },
                      }),
                };
          if (!candidate && (mode === 'bulk' || mode === 'small')) {
            await expect(
              service.commit(
                { correctionRequestId: 'request', operationKey: 'op', requestHash: 'hash' },
                actor,
                { requestId: 'offline', ip: null, ua: null },
                options,
              ),
            ).rejects.toBeInstanceOf(HumanCorrectionAuthorityUnavailableError);
            expect(transaction).not.toHaveBeenCalled();
            continue;
          }
          await expect(
            service.commit(
              { correctionRequestId: 'request', operationKey: 'op', requestHash: 'hash' },
              actor,
              { requestId: 'offline', ip: null, ua: null },
              options,
            ),
          ).rejects.toBe(stop);
          expect(transaction).toHaveBeenCalledTimes(1);
          expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'ReadCommitted',
            timeout: mode === 'standard' ? 7000 : mode === 'bulk' && candidate ? 60000 : 15000,
          });
        }
        expect(connect).not.toHaveBeenCalled();
      } finally {
        jest.restoreAllMocks();
        await moduleRef.close();
      }
    },
    30000,
  );
});

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
        const background = graph.get(ActivityTimeCorrectionBackgroundService, { strict: true });
        const command = graph.get(ActivityTimeCorrectionCommandService, { strict: true });
        const access = graph.get(ActivityTimeCorrectionAccessService, { strict: true });
        const corrections = graph.get(CorrectionApplicationService, { strict: true });
        expect(
          Reflect.get(graph.get(ActivityBatchWorker, { strict: true }), 'humanCorrections'),
        ).toBe(background);
        expect(Reflect.get(background, 'commands')).toBe(command);
        expect(Reflect.get(background, 'access')).toBe(access);
        expect(Reflect.get(command, 'corrections')).toBe(corrections);
        expect(Reflect.get(corrections, 'humanAccess')).toBe(access);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        await moduleRef.close();
      }
    },
    30_000,
  );
});
