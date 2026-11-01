import { pureHumanRuntimeTransportFixture as fixture } from '../../../test/helpers/human-correction-authority-pure';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import {
  HumanCorrectionExecutionModule,
  getHumanCorrectionService,
  HUMAN_CORRECTION_EXECUTION,
  type HumanCorrectionExecution,
} from './human-correction-execution.module';
import { HUMAN_CORRECTION_CLIENT } from './human-correction-runtime-client';
import { HumanCorrectionWorkerModule } from './human-correction-worker.module';
import { StorageSettingsService } from '../storage/storage-settings.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import appConfig, {
  parseHumanCorrectionRuntimeConfig,
  type HumanCorrectionRuntimeConfig,
} from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import jwtConfig from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import { loadTestEnv } from '../../../test/setup/load-env';
import {
  HUMAN_CORRECTION_BACKGROUND_BUDGET,
  HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
} from './human-correction-background-budget';
import {
  HUMAN_CORRECTION_TRUSTED_CONNECTION,
  type HumanCorrectionTrustedConnection,
} from './human-correction-item-authority';
import {
  HumanCorrectionRuntimeBootstrap,
  HumanCorrectionRuntimeSetupError,
  loadHumanCorrectionInstalledConnection,
  humanCorrectionRuntimeProviders,
  runHumanCorrectionWorkerIfSelected,
} from './human-correction-runtime-bootstrap';

const normalUrl =
  'postgresql://ordinary@unit.invalid/app_test_r5_setmat_20261029_q1?connection_limit=4';
const humanUrl =
  'postgresql://r5_human_queue_login_20261030_q1@unit.invalid/app_test_r5_setmat_20261029_q1?connection_limit=1';
function ordinaryTransport(safe = true) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ safe }]),
  };
  const client = {
    $transaction: jest.fn(async (body: (tx: unknown) => Promise<unknown>) => body(tx)),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  } as unknown as PrismaService;
  return { client, tx };
}
function ordinaryDatabaseFixture(client: PrismaService) {
  class OrdinaryDatabaseFixture {}
  Module({ providers: [{ provide: PrismaService, useValue: client }], exports: [PrismaService] })(
    OrdinaryDatabaseFixture,
  );
  return OrdinaryDatabaseFixture;
}

describe('normal Human trusted bootstrap (no database or credential proof)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r5-runtime-bootstrap-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const loadRecord = (profile: HumanCorrectionRuntimeConfig) =>
    loadHumanCorrectionInstalledConnection(
      new ConfigService({ app: { humanCorrectionBackground: profile } }),
    );
  function writeRecord(record: unknown) {
    const file = join(dir, 'installed.json'),
      text = JSON.stringify(record);
    writeFileSync(file, text, { mode: 0o600 });
    return {
      file,
      text,
      profile: parseHumanCorrectionRuntimeConfig('first-launch', file, sha(text)),
    };
  }
  async function container(
    profile: HumanCorrectionRuntimeConfig | undefined,
    client: PrismaService,
  ) {
    return Test.createTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ app: { humanCorrectionBackground: profile } }),
        },
        { provide: PrismaService, useValue: client },
        ...humanCorrectionRuntimeProviders,
        { provide: HUMAN_CORRECTION_CLIENT, useValue: profile?.mode === 'off' ? null : client },
      ],
    }).compile();
  }
  it('defaults off without reading the supplied nonexistent path or adding startup SQL', async () => {
    const f = fixture();
    const profile = parseHumanCorrectionRuntimeConfig(undefined, '/absent/ignored.json', 'invalid');
    const module = await container(profile, f.client);
    try {
      await module.init();
      expect(module.get(HUMAN_CORRECTION_TRUSTED_CONNECTION)).toBeNull();
      expect(module.get(HUMAN_CORRECTION_BACKGROUND_BUDGET)).toBe(
        HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
      );
      expect(f.transaction).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
  it('rejects a missing normal app config rather than silently downgrading startup', async () => {
    const f = fixture();
    await expect(container(undefined, f.client)).rejects.toThrow('APP_CONFIG_NOT_LOADED');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('uses the original core qualifier, same client and same read-only transaction before init completes', async () => {
    const f = fixture(),
      { profile } = writeRecord(f.record);
    const module = await container(profile, f.client);
    try {
      await module.init();
      const connection = module.get<HumanCorrectionTrustedConnection>(
        HUMAN_CORRECTION_TRUSTED_CONNECTION,
      );
      expect(connection.client).toBe(f.client);
      expect(module.get(HUMAN_CORRECTION_BACKGROUND_BUDGET)).toEqual({
        bulkCommit: true,
        bulkPrepare: true,
      });
      expect(f.transaction).toHaveBeenCalledTimes(1);
      expect(f.state.trace[0]).toBe('readonly');
      expect(f.state.trace).toContain('preflight');
      expect(f.state.role).toBe(f.record.callerRole.name);
    } finally {
      await module.close();
    }
  });
  it('awaits qualification rather than returning a ready context while it is pending', async () => {
    const f = fixture(),
      { profile } = writeRecord(f.record);
    let release!: () => void;
    f.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      f.state.entered = resolve;
    });
    const module = await container(profile, f.client);
    let ready = false;
    const init = module.init().then(() => {
      ready = true;
    });
    try {
      await entered;
      expect(ready).toBe(false);
      release();
      await init;
      expect(ready).toBe(true);
    } finally {
      release();
      await module.close();
    }
  });
  it.each(['identity', 'unsafe'] as const)(
    'fails init for %s and suppresses upstream details',
    async (kind) => {
      const f = fixture(),
        { profile } = writeRecord(f.record);
      if (kind === 'identity') f.state.qualified = false;
      else f.state.unsafe = true;
      const disconnect = jest.spyOn(f.client, '$disconnect');
      const module = await container(profile, f.client);
      try {
        await expect(module.init()).rejects.toThrow('STARTUP_QUALIFICATION');
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        await expect(module.close()).rejects.toThrow('STARTUP_QUALIFICATION');
      }
    },
  );
  it('refuses a different client before any startup transaction', async () => {
    const f = fixture(),
      { profile } = writeRecord(f.record);
    const guard = new HumanCorrectionRuntimeBootstrap(
      new ConfigService({ app: { humanCorrectionBackground: profile } }),
      f.client,
      { client: {} } as HumanCorrectionTrustedConnection,
    );
    await expect(guard.onModuleInit()).rejects.toThrow('CLIENT_BINDING');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('rechecks opened-file permissions after a chmod between path check and open', () => {
    const item = writeRecord(fixture().record);
    const originalOpen = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
      chmodSync(item.file, 0o666);
      return originalOpen(...args);
    });
    expect(() => loadRecord(item.profile)).toThrow('INSTALLED_RECORD');
  });
  it('opens nonblocking and rejects a substituted nonregular descriptor before reading', () => {
    const item = writeRecord(fixture().record);
    const open = jest.spyOn(fs, 'openSync');
    const stat = fs.statSync(item.file);
    stat.isFile = () => false;
    jest.spyOn(fs, 'fstatSync').mockReturnValueOnce(stat);
    const read = jest.spyOn(fs, 'readSync');
    expect(() => loadRecord(item.profile)).toThrow('INSTALLED_RECORD');
    expect(open.mock.calls[0]?.[1]).toBe(
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('rechecks descriptor permissions after reading', () => {
    const item = writeRecord(fixture().record);
    const originalRead = fs.readSync;
    jest.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      const n = originalRead(...args);
      chmodSync(item.file, 0o666);
      return n;
    });
    expect(() => loadRecord(item.profile)).toThrow('INSTALLED_RECORD');
  });
  it.each(['digest', 'json', 'symlink', 'writable', 'missing', 'template', 'oversize'] as const)(
    'refuses %s records before any startup SQL',
    async (kind) => {
      const f = fixture(),
        item = writeRecord(f.record);
      let file = item.file,
        text = item.text;
      if (kind === 'json') {
        text = '{invalid';
        writeFileSync(file, text);
      }
      if (kind === 'symlink') {
        const link = join(dir, 'link.json');
        symlinkSync(file, link);
        file = link;
      }
      if (kind === 'writable') chmodSync(file, 0o666);
      if (kind === 'missing') file = join(dir, 'does-not-exist.json');
      if (kind === 'template') {
        text = JSON.stringify({ ...f.record, status: 'NOT_INSTALLED_TEMPLATE' });
        writeFileSync(file, text);
      }
      if (kind === 'oversize') {
        text = 'x'.repeat(2 * 1024 * 1024 + 1);
        writeFileSync(file, text);
      }
      const hash = kind === 'digest' ? '0'.repeat(64) : sha(text);
      const profile = parseHumanCorrectionRuntimeConfig('first-launch', file, hash);
      await expect(container(profile, f.client)).rejects.toThrow();
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['', ' ', 'FIRST-LAUNCH', 'true', 'first-launch '] as const)(
    'rejects mode %j',
    (mode) => {
      expect(() =>
        parseHumanCorrectionRuntimeConfig(mode, '/record.json', '1'.repeat(64)),
      ).toThrow();
    },
  );
  it('requires canonical absolute path and operator digest when enabled', () => {
    expect(() =>
      parseHumanCorrectionRuntimeConfig('first-launch', 'relative.json', '1'.repeat(64)),
    ).toThrow();
    expect(() =>
      parseHumanCorrectionRuntimeConfig('first-launch', '/record.json', 'bad'),
    ).toThrow();
    expect(() =>
      parseHumanCorrectionRuntimeConfig('first-launch', '/record\u0000.json', '1'.repeat(64)),
    ).toThrow();
  });
  it('uses safe error stages without unsafe upstream messages', async () => {
    const f = fixture(),
      { profile } = writeRecord(f.record);
    f.state.unsafe = true;
    const module = await container(profile, f.client);
    try {
      const error: unknown = await module.init().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HumanCorrectionRuntimeSetupError);
      expect((error as Error).message).not.toContain('UNSAFE_UPSTREAM_DETAIL');
    } finally {
      await expect(module.close()).rejects.toThrow('STARTUP_QUALIFICATION');
    }
  });
  it('reports cleanup failure without pretending the startup pool is closed', async () => {
    const f = fixture(),
      { profile } = writeRecord(f.record);
    f.state.qualified = false;
    jest.spyOn(f.client, '$disconnect').mockRejectedValue(new Error('UNSAFE_DISCONNECT_DETAIL'));
    const module = await container(profile, f.client);
    await expect(module.init()).rejects.toThrow('STARTUP_CLEANUP');
    await expect(module.close()).rejects.toThrow('STARTUP_CLEANUP');
  });

  describe('Human-only worker selection', () => {
    const config = (enabled: boolean) =>
      new ConfigService({
        app: {
          humanCorrectionBackground: enabled
            ? parseHumanCorrectionRuntimeConfig('first-launch', '/record.json', '1'.repeat(64))
            : { mode: 'off' },
        },
      });
    it('leaves the old off-mode CLI unchanged', async () => {
      const worker = { executionScope: 'general' as const, run: jest.fn() };
      await expect(
        runHumanCorrectionWorkerIfSelected(config(false), worker, ['--once']),
      ).resolves.toBe(false);
      expect(worker.run).not.toHaveBeenCalled();
    });
    it.each([
      [false, ['--human-correction-only']],
      [true, []],
      [true, ['--human-correction-only', '--once']],
      [true, ['--human-correction-only', '--human-correction-only']],
    ] as const)('refuses mismatched profile/arguments %j %j', async (enabled, args) => {
      const worker = { executionScope: 'human-correction' as const, run: jest.fn() };
      await expect(
        runHumanCorrectionWorkerIfSelected(config(enabled), worker, args),
      ).rejects.toThrow('HUMAN_WORKER_ARGUMENTS');
      expect(worker.run).not.toHaveBeenCalled();
    });
    it('refuses a generic worker even when explicitly selected', async () => {
      const worker = { executionScope: 'general' as const, run: jest.fn() };
      await expect(
        runHumanCorrectionWorkerIfSelected(config(true), worker, ['--human-correction-only']),
      ).rejects.toThrow('HUMAN_WORKER_SCOPE');
      expect(worker.run).not.toHaveBeenCalled();
    });
    it('awaits the sole Human worker', async () => {
      let release!: () => void;
      const run = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const promise = runHumanCorrectionWorkerIfSelected(
        config(true),
        { executionScope: 'human-correction', run },
        ['--human-correction-only'],
      );
      expect(run).toHaveBeenCalledTimes(1);
      release();
      await expect(promise).resolves.toBe(true);
    });
  });

  describe.each(['http', 'worker'] as const)('actual %s module lifecycle', (kind) => {
    beforeAll(() => loadTestEnv());
    it.each([false, true])(
      'configures and initializes its actual providers enabled=%s',
      async (enabled) => {
        const f = fixture(),
          n = ordinaryTransport(),
          item = writeRecord(f.record);
        const cfg = {
          ...appConfig(),
          humanCorrectionBackground: enabled
            ? item.profile
            : parseHumanCorrectionRuntimeConfig(undefined, undefined, undefined),
        };
        const root =
          kind === 'http'
            ? (await import('./activities.module')).ActivitiesModule
            : (await import('./activity-batch-worker.module')).ActivityBatchWorkerModule;
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              ignoreEnvFile: true,
              load: [appConfig, databaseConfig, jwtConfig],
            }),
            root,
          ],
        })
          .overrideProvider(appConfig.KEY)
          .useValue(cfg)
          .overrideProvider(databaseConfig.KEY)
          .useValue({ url: normalUrl, humanCorrectionUrl: humanUrl })
          .overrideModule(DatabaseModule)
          .useModule(ordinaryDatabaseFixture(n.client))
          .overrideProvider(HUMAN_CORRECTION_CLIENT)
          .useValue(enabled ? f.client : null)
          .compile();
        try {
          await module.init();
          const graph = module.select(HumanCorrectionExecutionModule);
          const { CorrectionApplicationService } = await import('./correction-application.service');
          const ordinary = module.get(CorrectionApplicationService);
          const protectedCore = getHumanCorrectionService(graph, CorrectionApplicationService);
          // Exercise Nest's actual non-strict lookup order, without globally
          // overriding PrismaService. P/private providers cannot shadow N.
          expect(module.get(PrismaService)).toBe(n.client);
          expect(Reflect.get(ordinary, 'prisma')).toBe(n.client);
          expect(ordinary).not.toBe(protectedCore);
          expect(Reflect.get(protectedCore, 'prisma')).toBe(enabled ? f.client : null);
          const connection = graph.get<HumanCorrectionTrustedConnection | null>(
            HUMAN_CORRECTION_TRUSTED_CONNECTION,
            { strict: true },
          );
          expect(connection === null).toBe(!enabled);
          if (enabled) {
            expect(connection?.client).toBe(f.client);
            expect(f.state.trace).toContain('preflight');
          } else expect(f.transaction).not.toHaveBeenCalled();
          expect(graph.get(HUMAN_CORRECTION_BACKGROUND_BUDGET, { strict: true })).toEqual({
            bulkCommit: enabled,
            bulkPrepare: enabled,
          });
        } finally {
          await module.close();
        }
      },
    );
  });

  describe.each(['http', 'notification', 'storage'] as const)(
    'actual %s root Storage lifecycle (mock SQL transport, no real P authentication)',
    (kind) => {
      beforeAll(() => loadTestEnv());
      it.each(['test', 'production'] as const)(
        'env=%s preserves the real lifecycle and never substitutes a write or grant',
        async (env) => {
          const f = fixture(),
            n = ordinaryTransport();
          const record = writeRecord(f.record);
          const settings = jest.fn().mockResolvedValue(null);
          const objects = jest.fn().mockResolvedValue(0);
          const operations = jest.fn().mockResolvedValue(0);
          const raw = jest.fn((input: Prisma.Sql) => {
            expect(input.sql).toContain('SELECT COUNT(*)::BIGINT');
            expect(input.sql).toMatch(/FROM "(?:attachments|storage_objects)"/);
            return Promise.resolve([{ count: 0n }]);
          });
          const write = jest.fn(() => {
            throw new Error('unexpected Storage write');
          });
          Object.assign(n.client, {
            storageSettings: { findFirst: settings, create: write, update: write },
            storageObject: { count: objects, create: write, update: write, updateMany: write },
            storageObjectOperation: {
              count: operations,
              create: write,
              update: write,
              updateMany: write,
            },
            $queryRaw: raw,
          });
          const cfg = {
            ...appConfig(),
            env,
            humanCorrectionBackground: record.profile,
            storage: { ...appConfig().storage, consistencyMode: 'STRICT' as const },
          };
          const root =
            kind === 'http'
              ? (await import('../../app.module')).AppModule
              : kind === 'notification'
                ? (await import('../notifications/notification-outbox-worker.module'))
                    .NotificationOutboxWorkerModule
                : (await import('../attachments/storage-consistency-worker.module'))
                    .StorageConsistencyWorkerModule;
          const originalArgv = process.argv;
          process.argv = [
            'node',
            kind === 'storage' ? '/app/dist/storage-consistency-worker.js' : '/app/dist/main.js',
          ];
          const module = await Test.createTestingModule({ imports: [root] })
            .overrideProvider(appConfig.KEY)
            .useValue(cfg)
            .overrideProvider(databaseConfig.KEY)
            .useValue({ url: normalUrl, humanCorrectionUrl: humanUrl })
            .overrideModule(DatabaseModule)
            .useModule(ordinaryDatabaseFixture(n.client))
            .overrideProvider(HUMAN_CORRECTION_CLIENT)
            .useValue(f.client)
            .compile();
          try {
            if (env === 'test') {
              await module.init();
              expect(settings).not.toHaveBeenCalled();
              expect(objects).not.toHaveBeenCalled();
              expect(operations).not.toHaveBeenCalled();
              expect(raw).not.toHaveBeenCalled();
            } else {
              await expect(module.init()).rejects.toThrow('storage_settings 未初始化');
              expect(settings).toHaveBeenCalledTimes(1);
              expect(settings.mock.calls[0]).toEqual([]); // actual Prisma read selects all scalar columns
              expect(objects).toHaveBeenCalledTimes(kind === 'storage' ? 0 : 1);
              expect(operations).toHaveBeenCalledTimes(kind === 'storage' ? 0 : 2);
              expect(raw).toHaveBeenCalledTimes(kind === 'storage' ? 0 : 2);
            }
            expect(f.state.trace).toContain('preflight');
            expect(write).not.toHaveBeenCalled();
          } finally {
            try {
              if (env === 'production')
                await expect(module.close()).rejects.toThrow('storage_settings 未初始化');
              else await module.close();
            } finally {
              // Nest close() rethrows failed initialization before shutdown hooks.
              // The real HTTP root registered its existing two cron jobs before
              // the expected Storage rejection; clean those test-owned timers.
              if (kind === 'http') {
                const scheduler = module.get(SchedulerRegistry);
                for (const name of scheduler.getCronJobs().keys()) scheduler.deleteCronJob(name);
              }
              process.argv = originalArgv;
            }
          }
        },
      );
    },
  );
  describe('separate Human graph admission (actual DI, mock SQL transport)', () => {
    beforeAll(() => loadTestEnv());
    it('initializes the production Human worker without constructing ordinary DB or Storage lifecycle', async () => {
      const f = fixture(),
        item = writeRecord(f.record);
      const cfg = {
        ...appConfig(),
        env: 'production' as const,
        humanCorrectionBackground: item.profile,
      };
      const module = await Test.createTestingModule({ imports: [HumanCorrectionWorkerModule] })
        .overrideProvider(appConfig.KEY)
        .useValue(cfg)
        .overrideProvider(HUMAN_CORRECTION_CLIENT)
        .useValue(f.client)
        .compile();
      try {
        await module.init();
        const scope = module.get<HumanCorrectionExecution>(HUMAN_CORRECTION_EXECUTION);
        expect(scope.client).toBe(f.client);
        expect(scope.worker.executionScope).toBe('human-correction');
        expect(() => module.get(StorageSettingsService)).toThrow();
        expect(() => module.get(DatabaseModule)).toThrow();
        expect(f.state.trace).toContain('preflight');
      } finally {
        await module.close();
      }
    });
    it('routes HTTP Human commands to P and never retries a P rejection on N', async () => {
      const f = fixture(),
        n = ordinaryTransport(),
        item = writeRecord(f.record);
      const cfg = { ...appConfig(), humanCorrectionBackground: item.profile };
      const { ActivitiesModule } = await import('./activities.module');
      const { ActivityTimeCorrectionCommandService } =
        await import('./activity-time-correction-command.service');
      const { CorrectionApplicationService } = await import('./correction-application.service');
      const failure = new Error('synthetic P business rejection');
      const read = jest.fn().mockRejectedValue(failure);
      Object.assign(f.client, { attendanceCorrectionRequest: { findFirst: read } });
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [appConfig, databaseConfig, jwtConfig],
          }),
          ActivitiesModule,
        ],
      })
        .overrideProvider(appConfig.KEY)
        .useValue(cfg)
        .overrideProvider(databaseConfig.KEY)
        .useValue({ url: normalUrl, humanCorrectionUrl: humanUrl })
        .overrideModule(DatabaseModule)
        .useModule(ordinaryDatabaseFixture(n.client))
        .overrideProvider(HUMAN_CORRECTION_CLIENT)
        .useValue(f.client)
        .compile();
      try {
        await module.init();
        const graph = module.select(ActivitiesModule);
        const scope = module.get<HumanCorrectionExecution>(HUMAN_CORRECTION_EXECUTION);
        const commands = graph.get(ActivityTimeCorrectionCommandService, { strict: true });
        expect(commands).toBe(scope.commands);
        expect(
          Reflect.get(graph.get(CorrectionApplicationService, { strict: true }), 'prisma'),
        ).toBe(n.client);
        expect(
          getHumanCorrectionService(
            module.select(HumanCorrectionExecutionModule),
            ActivityTimeCorrectionCommandService,
          ),
        ).toBe(scope.commands);
        expect(Reflect.get(scope.commands, 'prisma')).toBe(f.client);
        const core = Reflect.get(scope.commands, 'corrections') as object;
        expect(Reflect.get(core, 'prisma')).toBe(f.client);
        expect(Reflect.get(Reflect.get(core, 'ledgerPosting') as object, 'prisma')).toBe(f.client);
        const audit = Reflect.get(core, 'audit') as object;
        expect(Reflect.get(Reflect.get(audit, 'auditLogs') as object, 'prisma')).toBe(f.client);
        const normalTransactions = (n.client.$transaction as jest.Mock).mock.calls.length;
        await expect(
          commands.prepare(
            'activity',
            'request',
            { operationKey: 'operation', expectedBaseSettlementVersionId: 'base' },
            { id: 'actor' } as never,
            { requestId: 'request', ip: null, ua: null },
          ),
        ).rejects.toBe(failure);
        expect(read).toHaveBeenCalledTimes(1);
        expect((n.client.$transaction as jest.Mock).mock.calls).toHaveLength(normalTransactions);
      } finally {
        await module.close();
      }
    });
  });
});
