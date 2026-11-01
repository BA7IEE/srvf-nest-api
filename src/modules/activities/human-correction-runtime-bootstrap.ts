import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import {
  Injectable,
  type FactoryProvider,
  type OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { DatabaseConfig } from '../../config/database.config';
import {
  HUMAN_CORRECTION_CLIENT,
  HumanCorrectionRuntimeClient,
} from './human-correction-runtime-client';
import {
  parseHumanCorrectionRuntimeConfig,
  type HumanCorrectionRuntimeConfig,
} from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { ActivityBatchWorker } from './activity-batch.worker';
import {
  HUMAN_CORRECTION_BACKGROUND_BUDGET,
  HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
  type HumanCorrectionBackgroundBudget,
} from './human-correction-background-budget';
import {
  HUMAN_CORRECTION_INSTALLED_CONNECTION,
  humanCorrectionTrustedConnectionProvider,
  type HumanCorrectionInstalledConnection,
} from './human-correction-trusted-connection';
import {
  HUMAN_CORRECTION_TRUSTED_CONNECTION,
  type HumanCorrectionTrustedConnection,
} from './human-correction-item-authority';

const MAX_INSTALLED_RECORD_BYTES = 2 * 1024 * 1024;

export class HumanCorrectionRuntimeSetupError extends Error {
  constructor(readonly stage: string) {
    super(`Human correction runtime setup rejected: ${stage}`);
  }
}

function runtimeConfig(config: ConfigService): HumanCorrectionRuntimeConfig {
  const value = config.get<HumanCorrectionRuntimeConfig>('app.humanCorrectionBackground');
  if (!value || (value.mode !== 'off' && value.mode !== 'first-launch'))
    throw new HumanCorrectionRuntimeSetupError('APP_CONFIG_NOT_LOADED');
  if (value.mode === 'off') return HUMAN_RUNTIME_OFF;
  try {
    return parseHumanCorrectionRuntimeConfig(
      value.mode,
      value.installedRecordPath,
      value.installedRecordSha256,
    );
  } catch {
    throw new HumanCorrectionRuntimeSetupError('OPERATOR_CONFIG');
  }
}
const HUMAN_RUNTIME_OFF: HumanCorrectionRuntimeConfig = Object.freeze({ mode: 'off' });

/** An operator's non-secret source/installation record. The digest pins bytes;
 * it is not authentication. Actual identity/source are checked by the original
 * provider on the SAME dedicated Human client and every business transaction. */
export function loadHumanCorrectionInstalledConnection(
  config: ConfigService,
): HumanCorrectionInstalledConnection | null {
  const profile = runtimeConfig(config);
  if (profile.mode === 'off') return null;
  let fd: number | undefined;
  try {
    const pathInfo = lstatSync(profile.installedRecordPath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || (pathInfo.mode & 0o022) !== 0)
      throw new Error('record must be a protected regular file');
    fd = openSync(
      profile.installedRecordPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      (before.mode & 0o022) !== 0 ||
      before.size < 2 ||
      before.size > MAX_INSTALLED_RECORD_BYTES
    )
      throw new Error('record size');
    const bytes = Buffer.alloc(MAX_INSTALLED_RECORD_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      (after.mode & 0o022) !== 0 ||
      size !== before.size ||
      size > MAX_INSTALLED_RECORD_BYTES ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('record changed while reading');
    const content = bytes.subarray(0, size);
    if (createHash('sha256').update(content).digest('hex') !== profile.installedRecordSha256)
      throw new Error('record digest');
    return JSON.parse(content.toString('utf8')) as HumanCorrectionInstalledConnection;
  } catch {
    // No file contents, connection string, filesystem error or credential leaks.
    throw new HumanCorrectionRuntimeSetupError('INSTALLED_RECORD');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const installedProvider: FactoryProvider<HumanCorrectionInstalledConnection | null> = {
  provide: HUMAN_CORRECTION_INSTALLED_CONNECTION,
  inject: [ConfigService],
  useFactory: loadHumanCorrectionInstalledConnection,
};

const clientProvider: FactoryProvider<PrismaService | null> = {
  provide: HUMAN_CORRECTION_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    if (runtimeConfig(config).mode === 'off') return null;
    return new HumanCorrectionRuntimeClient(
      config.get<DatabaseConfig>('database')?.humanCorrectionUrl,
    );
  },
};

const scopedConnectionProvider = {
  ...humanCorrectionTrustedConnectionProvider,
  inject: [HUMAN_CORRECTION_CLIENT, HUMAN_CORRECTION_INSTALLED_CONNECTION],
};

const budgetProvider: FactoryProvider<HumanCorrectionBackgroundBudget> = {
  provide: HUMAN_CORRECTION_BACKGROUND_BUDGET,
  inject: [ConfigService, HUMAN_CORRECTION_TRUSTED_CONNECTION],
  useFactory: (config: ConfigService, connection: HumanCorrectionTrustedConnection | null) => {
    if (runtimeConfig(config).mode === 'off') return HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF;
    if (connection === null) throw new HumanCorrectionRuntimeSetupError('MISSING_CONNECTION');
    return Object.freeze({ bulkCommit: true, bulkPrepare: true });
  },
};

/** HTTP listen and createApplicationContext await this hook before accepting
 * work. This startup probe does not replace qualification on each business tx.
 * Prisma's existing default bounded interactive transaction limits apply. */
@Injectable()
export class HumanCorrectionRuntimeBootstrap implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    @Inject(HUMAN_CORRECTION_CLIENT)
    private readonly prisma: PrismaService | null,
    @Optional()
    @Inject(HUMAN_CORRECTION_TRUSTED_CONNECTION)
    private readonly connection: HumanCorrectionTrustedConnection | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (runtimeConfig(this.config).mode === 'off') return;
    try {
      if (!this.prisma || !this.connection || this.connection.client !== this.prisma)
        throw new HumanCorrectionRuntimeSetupError('CLIENT_BINDING');
      const connection = this.connection;
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await connection.qualifyInTx(tx);
      });
    } catch (error) {
      // Nest's rejected initialization promise can also reject app.close().
      // No work has been accepted yet; close this same shared pool explicitly.
      try {
        await this.prisma?.$disconnect();
      } catch {
        throw new HumanCorrectionRuntimeSetupError('STARTUP_CLEANUP');
      }
      if (error instanceof HumanCorrectionRuntimeSetupError) throw error;
      throw new HumanCorrectionRuntimeSetupError('STARTUP_QUALIFICATION');
    }
  }
}

/** The pure core-provider export stays unchanged for explicit test bootstraps.
 * This list belongs ONLY to the dedicated Human module, never ordinary DB DI. */
export const humanCorrectionRuntimeProviders = [
  installedProvider,
  clientProvider,
  scopedConnectionProvider,
  budgetProvider,
  HumanCorrectionRuntimeBootstrap,
];

/** Reuse an existing worker binary/slot without starting unrelated scanners
 * under the narrowly qualified Human connection. This flag is operator-only. */
export async function runHumanCorrectionWorkerIfSelected(
  config: ConfigService,
  worker: Pick<ActivityBatchWorker, 'executionScope' | 'run'>,
  args: readonly string[],
): Promise<boolean> {
  const enabled = runtimeConfig(config).mode === 'first-launch';
  const selected = args.includes('--human-correction-only');
  if (!enabled && !selected) return false;
  if (!enabled || args.length !== 1 || args[0] !== '--human-correction-only')
    throw new HumanCorrectionRuntimeSetupError('HUMAN_WORKER_ARGUMENTS');
  if (worker.executionScope !== 'human-correction')
    throw new HumanCorrectionRuntimeSetupError('HUMAN_WORKER_SCOPE');
  await worker.run();
  return true;
}
