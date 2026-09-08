import { Prisma, PrismaClient } from '@prisma/client';
import databaseConfig from '../src/config/database.config';

export interface CleanupOptions {
  applicationId: string;
  database: string;
  host: string;
  apply: boolean;
  authorizationReference?: string;
  noRetentionHold: boolean;
}

export function parseCleanupOptions(argv: readonly string[]): CleanupOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply' || key === '--confirm-no-retention-hold') {
      if (flags.has(key)) throw new Error('Duplicate flag');
      flags.add(key);
    } else {
      if (
        !['--application-id', '--database', '--host', '--authorization-reference'].includes(key) ||
        values.has(key) ||
        !argv[i + 1] ||
        argv[i + 1].startsWith('--')
      ) {
        throw new Error('Invalid or duplicate option');
      }
      values.set(key, argv[++i]);
    }
  }
  const applicationId = values.get('--application-id') ?? '';
  const database = values.get('--database') ?? '';
  const host = values.get('--host') ?? '';
  const authorizationReference = values.get('--authorization-reference');
  const apply = flags.has('--apply');
  const noRetentionHold = flags.has('--confirm-no-retention-hold');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(applicationId) ||
    !/^[A-Za-z0-9_]{1,63}$/.test(database) ||
    !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(host)
  ) {
    throw new Error('One explicit application, database and host are required');
  }
  if (
    authorizationReference !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(authorizationReference)
  ) {
    throw new Error('Invalid authorization reference');
  }
  if (apply && (!authorizationReference || !noRetentionHold)) {
    throw new Error(
      'Apply requires a separate approval reference and no-retention-hold confirmation',
    );
  }
  return { applicationId, database, host, apply, authorizationReference, noRetentionHold };
}

export function assertCleanupTarget(url: string | undefined, options: CleanupOptions): string {
  if (!url) throw new Error('Database configuration is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid database configuration');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    decodeURIComponent(parsed.pathname.slice(1)) !== options.database ||
    parsed.hostname !== options.host
  ) {
    throw new Error('Configured database does not match the explicitly approved target');
  }
  return url;
}

export async function runCleanup(prisma: PrismaClient, options: CleanupOptions) {
  return prisma.$transaction(
    async (tx) => {
      // Preview is enforced read-only by PostgreSQL, not just by the CLI branch.
      if (!options.apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
      const [target] = await tx.$queryRaw<
        Array<{ database: string }>
      >`SELECT current_database() AS database`;
      if (target?.database !== options.database) throw new Error('Connected database mismatch');
      const application = await tx.correctionApplication.findUnique({
        where: { id: options.applicationId },
        select: {
          statusCode: true,
          newPostingBatch: { select: { statusCode: true } },
          segmentPreparationReceipt: { select: { preparedSegmentCount: true } },
          segmentCleanupReceipt: { select: { deletedSegmentCount: true } },
        },
      });
      if (!application) throw new Error('Application not found');
      const prepared = application.segmentPreparationReceipt?.preparedSegmentCount;
      if (prepared === undefined || prepared > 2000)
        throw new Error('Missing receipt or cleanup limit exceeded');
      const remaining = await tx.correctionPendingSegmentRevision.count({
        where: { applicationId: options.applicationId },
      });
      const preview = {
        mode: 'preview',
        applicationId: options.applicationId,
        database: options.database,
        applicationStatus: application.statusCode,
        batchStatus: application.newPostingBatch.statusCode,
        preparedSegmentCount: prepared,
        remainingSegmentCount: remaining,
        alreadyCleaned: application.segmentCleanupReceipt !== null,
        // Full same-chain checks and human retention approval are still required at apply.
        eligibility: 'requires-transactional-validation-and-human-approval',
      };
      if (!options.apply) return preview;
      if (!options.authorizationReference || !options.noRetentionHold)
        throw new Error('Missing apply approval');
      const [result] = await tx.$queryRaw<
        Array<{
          preparedSegmentCount: number;
          deletedSegmentCount: number;
          replayed: boolean;
        }>
      >(
        Prisma.sql`SELECT * FROM cleanup_correction_pending_segment(${options.applicationId}, ${options.authorizationReference})`,
      );
      if (!result) throw new Error('Cleanup did not return a receipt');
      return {
        mode: 'apply',
        applicationId: options.applicationId,
        database: options.database,
        ...result,
      };
    },
    { timeout: 15000 },
  );
}

async function main() {
  const options = parseCleanupOptions(process.argv.slice(2));
  const url = assertCleanupTarget(databaseConfig().url, options);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    console.log(JSON.stringify(await runCleanup(prisma, options)));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    // Database errors may contain credentials or row contents. Never log them here.
    console.error(
      'Cleanup failed; no automatic retry. Check target, approval and database constraints.',
    );
    process.exitCode = 1;
  });
}
