import {
  acquireScratchDatabaseLease,
  type ScratchLeaseSession,
} from '../helpers/scratch-database-lease';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { loadTestEnv } from '../setup/load-env';
import { resetDb } from '../setup/reset-db';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveWorkerTestDbName, deriveTestDbName } from '../setup/worktree-db';
import {
  timeLedgerFixtureTriggerSql,
  withTimeLedgerFixtureCleanup,
} from '../setup/time-ledger-fixture-cleanup';

describe('D3 controlled cleanup and conservative reconciliation (w98 only)', () => {
  let scratchLease: ScratchLeaseSession | undefined;
  const original = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let prisma: PrismaService;
  const app = { get: () => prisma } as unknown as INestApplication;
  const protectedTables = [
    ['ContributionShadowWindowRegistrationReceipt', 'cswr_no_truncate'],
    ['ContributionShadowDispositionApprovalReceipt', 'csda_no_truncate'],
  ] as const;

  beforeAll(async () => {
    scratchLease = await acquireScratchDatabaseLease();
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (deriveTestDbName() !== deriveWorkerTestDbName(98)) throw new Error('D3 requires exact w98');
    await scratchLease.dropDatabase();
    await scratchLease.createDatabase();
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
    prisma = new PrismaService();
    await prisma.$connect();
    await resetDb(app);
  }, 120_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
      if (scratchLease) await scratchLease.dropDatabase();
    } finally {
      if (original.worker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = original.worker;
      if (original.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original.url;
      await scratchLease?.release();
    }
  });

  async function guardStates() {
    const rows = await prisma.$queryRaw<Array<{ name: string; state: string }>>`
      SELECT tgname AS name,tgenabled::text AS state FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN ('cswr_no_truncate','csda_no_truncate') ORDER BY tgname`;
    expect(rows).toEqual([
      { name: 'csda_no_truncate', state: 'O' },
      { name: 'cswr_no_truncate', state: 'O' },
    ]);
  }

  it('resetDb restores both no-truncate guards and a failed cleanup rolls back all temporary guard changes', async () => {
    await guardStates();
    await expect(
      prisma.$transaction(
        (tx) =>
          withTimeLedgerFixtureCleanup(tx, () => {
            throw new Error('synthetic cleanup failure');
          }),
        { timeout: 30_000 },
      ),
    ).rejects.toThrow('synthetic cleanup failure');
    await guardStates();
    for (const [table] of protectedTables) {
      await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)).rejects.toThrow();
    }
    await resetDb(app);
    await guardStates();
  });

  it('rejects a missing guard rather than silently skipping the existing table', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'DROP TRIGGER csda_no_truncate ON "ContributionShadowDispositionApprovalReceipt"',
          );
          await withTimeLedgerFixtureCleanup(tx, async () => undefined);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow('Expected fixture trigger is missing');
    await guardStates();
  });

  it('both the transaction helper and psql fragment reject a half-present pair and roll back the rename', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "ContributionShadowDispositionApprovalReceipt" RENAME TO "d3_test_hidden_approval"',
          );
          await withTimeLedgerFixtureCleanup(tx, async () => undefined);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow('Incomplete shadow reconciliation fixture tables');
    const { before } = timeLedgerFixtureTriggerSql(deriveTestDbName());
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "ContributionShadowDispositionApprovalReceipt" RENAME TO "d3_test_hidden_approval"',
          );
          await tx.$executeRawUnsafe(before);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow('Incomplete shadow reconciliation fixture tables');
    await guardStates();
  });

  it('unknown operations and source shape anomalies remain unresolved and never become implicit N', async () => {
    await prisma.$executeRaw`INSERT INTO "User" (id,username,"passwordHash","updatedAt")
      VALUES ('d3-read-human','d3-read-human','fixture',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId",
      "deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
      VALUES ('d3-legacy-window','2099-01-01','2099-01-02','d3-read-human',repeat('a',64),repeat('b',64),'d3-legacy-v1','sha256',1)`;
    await prisma.$executeRaw`INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
      VALUES ('d3-read-unknown','2099-01-01 01:00','attendance_sheet','d3-no-sheet','attendance-sheet.edit','{"extra":{"operation":"unknown"}}'),
      ('d3-read-malformed','2099-01-01 02:00','attendance_sheet','d3-no-sheet','attendance-sheet.submit','{"extra":{"operation":"submit"}}')`;
    const [{ summary }] = await prisma.$queryRaw<
      Array<{ summary: unknown }>
    >`SELECT csd3_read_summary_fn('d3-legacy-window') AS summary`;
    expect(summary).toMatchObject({
      candidateCount: 2,
      attemptCount: 0,
      rawMissingStartCount: 2,
      sourceOrChainAnomalyCount: 2,
      rawUnresolvedCount: 2,
      netUnresolvedCount: 2,
      notApplicableCount: 0,
    });
    const rows = await prisma.$queryRaw<
      Array<{ value: unknown }>
    >`SELECT value FROM csd3_read_candidates_fn('d3-legacy-window') value`;
    expect(rows).toHaveLength(2);
    for (const { value } of rows)
      expect(value).toMatchObject({
        primaryClassification: 'source_or_chain_anomaly',
        signatureStatus: 'unsigned',
        rawUnresolved: true,
        netUnresolved: true,
        notApplicable: false,
      });
    await resetDb(app);
    expect(await prisma.contributionShadowObservationWindow.count()).toBe(0);
    await guardStates();
  });

  it('audit cleanup restores the new guards and rolls back all guard changes if truncation fails', async () => {
    await prisma.$executeRaw`INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
      VALUES ('d3-cleanup-audit','fixture','fixture','attendance-sheet.edit','{}'::jsonb)`;
    await truncateAuditLogsTestOnly(app);
    expect(await prisma.auditLog.count({ where: { id: 'd3-cleanup-audit' } })).toBe(0);
    await guardStates();
    const failingPrisma = new Proxy(prisma, {
      get(target, key) {
        if (key !== '$transaction') {
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (callback: Parameters<PrismaService['$transaction']>[0]) =>
          target.$transaction(
            async (tx) => {
              if (typeof callback !== 'function') throw new Error('Expected interactive cleanup');
              const failingTx = new Proxy(tx, {
                get(transaction, property) {
                  if (property === '$executeRawUnsafe')
                    return (query: string, ...args: unknown[]) => {
                      if (query.startsWith('TRUNCATE TABLE'))
                        throw new Error('Synthetic audit cleanup failure');
                      return transaction.$executeRawUnsafe(query, ...args);
                    };
                  const value: unknown = Reflect.get(transaction, property);
                  return typeof value === 'function' ? value.bind(transaction) : value;
                },
              });
              return callback(failingTx);
            },
            { timeout: 30_000 },
          );
      },
    });
    await expect(
      truncateAuditLogsTestOnly({ get: () => failingPrisma } as unknown as INestApplication),
    ).rejects.toThrow('Synthetic audit cleanup failure');
    await guardStates();
  });

  it('audit cleanup rejects a missing trigger or half-present pair, preserving existing guard states', async () => {
    const [definition] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='"ContributionShadowDispositionApprovalReceipt"'::regclass
        AND tgname='csda_no_truncate' AND NOT tgisinternal`;
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER csda_no_truncate ON "ContributionShadowDispositionApprovalReceipt"',
    );
    try {
      await expect(truncateAuditLogsTestOnly(app)).rejects.toThrow(
        'Shadow fixture no-truncate trigger missing or invalid',
      );
    } finally {
      await prisma.$executeRawUnsafe(definition.definition);
    }
    await guardStates();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "ContributionShadowDispositionApprovalReceipt" RENAME TO "d3_hidden_audit_approval"',
    );
    try {
      await expect(truncateAuditLogsTestOnly(app)).rejects.toThrow(
        'Incomplete shadow reconciliation fixture tables',
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "d3_hidden_audit_approval" RENAME TO "ContributionShadowDispositionApprovalReceipt"',
      );
    }
    await guardStates();
  });

  it('audit cleanup supports the actual pre-D3 schema with neither new table, then restores current migrations', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-d3-audit-history-'));
    try {
      const root = join(process.cwd(), 'prisma');
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(root, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(root, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(root, 'migrations'), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name <= '20260930120000_activity_os_r5_e3_shadow_mapping_proof',
        )
        .map((entry) => entry.name);
      expect(names).toHaveLength(135);
      for (const name of names)
        cpSync(join(root, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
        });
      await prisma.$disconnect();
      await scratchLease!.dropDatabase();
      await scratchLease!.createDatabase();
      execFileSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', join(temporary, 'schema.prisma')],
        { env: process.env, stdio: 'pipe' },
      );
      prisma = new PrismaService();
      await prisma.$connect();
      const [tables] = await prisma.$queryRaw<Array<{ absent: boolean }>>`
        SELECT to_regclass('public."ContributionShadowWindowRegistrationReceipt"') IS NULL
          AND to_regclass('public."ContributionShadowDispositionApprovalReceipt"') IS NULL AS absent`;
      expect(tables.absent).toBe(true);
      await prisma.$executeRaw`INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
        VALUES ('d3-history-cleanup','fixture','fixture','attendance-sheet.edit','{}'::jsonb)`;
      await truncateAuditLogsTestOnly(app);
      expect(await prisma.auditLog.count({ where: { id: 'd3-history-cleanup' } })).toBe(0);
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: process.env,
        stdio: 'pipe',
      });
      await guardStates();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
