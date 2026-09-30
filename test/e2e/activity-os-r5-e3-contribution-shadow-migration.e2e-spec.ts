import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260928095832_activity_os_r5_e3_shadow_evidence';
const USE_DEDICATED_W98 = process.env.SRVF_E3_D1_W98 === '1';
const ROOT = join(process.cwd(), 'prisma');
const HASH = 'a'.repeat(64);

function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID)
    throw new Error('E3-2 D1 migration test requires worker database');
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function rejected(statement: string, marker: string): void {
  let message = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    message = String(error.stderr);
  }
  expect(message).toContain(marker);
}

function recreate(): void {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  dropWorkerDatabase(process.env.JEST_WORKER_ID!);
  execFileSync(
    'docker',
    ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
    { stdio: 'pipe' },
  );
}

function deploy(schema = join(ROOT, 'schema.prisma')): void {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}

// Historical D1 replay remains pinned to the exact 133rd migration even after
// additive successors land. Do not change its 132→133 assertions.
function deployThroughD1(): void {
  const temporary = mkdtempSync(join(tmpdir(), 'srvf-e3-d1-frozen-'));
  try {
    mkdirSync(join(temporary, 'migrations'));
    copyFileSync(join(ROOT, 'schema.prisma'), join(temporary, 'schema.prisma'));
    copyFileSync(
      join(ROOT, 'migrations', 'migration_lock.toml'),
      join(temporary, 'migrations', 'migration_lock.toml'),
    );
    const names = readdirSync(join(ROOT, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name <= MIGRATION)
      .map((entry) => entry.name)
      .sort();
    if (names.length !== 133 || names.at(-1) !== MIGRATION) {
      throw new Error('D1 historical migration set changed');
    }
    for (const name of names) {
      cpSync(join(ROOT, 'migrations', name), join(temporary, 'migrations', name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    deploy(join(temporary, 'schema.prisma'));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe('E3-2 D1 additive shadow evidence migration', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (USE_DEDICATED_W98) {
      recreate();
      deployThroughD1();
    }
  });
  afterAll(() => {
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase('98');
      } finally {
        if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = previous.worker;
        if (previous.url === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous.url;
      }
    }
  });

  it('has the exact 133rd migration and five empty append-only tables', () => {
    const digest = createHash('sha256')
      .update(readFileSync(join('prisma', 'migrations', MIGRATION, 'migration.sql')))
      .digest('hex');
    expect(
      sql(`SELECT migration_name || ':' || checksum FROM _prisma_migrations
        WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`),
    ).toBe(`${MIGRATION}:${digest}`);
    expect(sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`)).toBe(
      '133',
    );
    expect(
      sql(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN (
          'ContributionShadowObservationWindow','ContributionShadowAttemptReceipt',
          'ContributionShadowComparisonReceipt','ContributionShadowTerminalReceipt',
          'ContributionShadowDispositionReceipt')`),
    ).toBe('5');
    expect(
      sql(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname IN (
          'csow_no_truncate','csar_no_truncate','cscr_no_truncate',
          'cstr_no_truncate','csdr_no_truncate')`),
    ).toBe('5');
  });

  it('rejects backdated and overlapping windows, with no residual row', () => {
    rejected(
      `INSERT INTO "ContributionShadowObservationWindow"
        (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
         "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
       VALUES ('e3-past',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',
         'missing-user','${HASH}','${HASH}','e3-fixture','sha256',1)`,
      'observation window must be registered before start',
    );
    rejected(
      `BEGIN;
       INSERT INTO "User" (id,username,"passwordHash","updatedAt")
         VALUES ('e3-user','e3-user','fixture',CURRENT_TIMESTAMP);
       INSERT INTO "ContributionShadowObservationWindow"
         (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
          "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
         VALUES ('e3-window-1','2099-01-01','2099-01-03','e3-user',
           '${HASH}','${HASH}','e3-fixture','sha256',1);
       INSERT INTO "ContributionShadowObservationWindow"
         (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
          "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
         VALUES ('e3-window-2','2099-01-02','2099-01-04','e3-user',
           '${HASH}','${HASH}','e3-fixture','sha256',1);`,
      'csow_no_overlap',
    );
    expect(sql(`SELECT count(*) FROM "ContributionShadowObservationWindow"`)).toBe('0');
  });

  it('anchors one complete hold result and unresolved disposition, then rolls it all back', () => {
    const output = sql(`BEGIN;
      INSERT INTO "User" (id,username,"passwordHash","updatedAt")
        VALUES ('e3-user','e3-user','fixture',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt")
        VALUES ('e3-org','E3 fixture','team',CURRENT_TIMESTAMP);
      INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
        VALUES ('e3-member','E3001','Fixture Member',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
      INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
        VALUES ('e3-activity','E3 fixture','e3_fixture','e3-org',
          '2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
        VALUES ('e3-sheet','e3-activity','e3-user','pending_review',CURRENT_TIMESTAMP,1);
      INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
        "serviceHours","attendanceStatusCode","updatedAt")
        VALUES ('e3-record','e3-sheet','e3-member','member','2099-01-02','2099-01-02 01:00',
          1.00,'present',CURRENT_TIMESTAMP);
      INSERT INTO "audit_logs" (id,"createdAt","resourceType","resourceId",event,context)
        VALUES ('e3-audit','2099-01-01 12:00','attendance_sheet','e3-sheet','attendance-sheet.submit',
          jsonb_build_object(
            'after',jsonb_build_object('sheet',jsonb_build_object('activityId','e3-activity','version',1),
              'records',jsonb_build_array(jsonb_build_object('id','e3-record','memberId','e3-member'))),
            'extra',jsonb_build_object('operation','submit','recordsCount',1)));
      INSERT INTO "ContributionShadowObservationWindow"
        (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
         "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
        VALUES ('e3-window','2099-01-01','2099-01-03','e3-user',
          '${HASH}','${HASH}','e3-fixture','sha256',1);
      INSERT INTO "ContributionShadowAttemptReceipt"
        (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey",
         "committedFactHash","signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
        VALUES ('e3-attempt','e3-window','e3-audit','e3-sheet','e3-activity',1,
          encode(sha256(convert_to('e3-2-d1:v1:e3-window:e3-audit:1','UTF8')),'hex'),
          '${HASH}','e3-fixture',1,'sha256',1);
      DO $terminal_shape$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowTerminalReceipt"
            (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount",
             "equalCount","mismatchCount","holdCount","errorCount")
            VALUES ('e3-early-complete','e3-attempt','complete',1,0,0,0,0,0);
          RAISE EXCEPTION 'incomplete complete terminal accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM NOT LIKE '%cstr_counts_check%' THEN RAISE; END IF;
        END;
        BEGIN
          INSERT INTO "ContributionShadowTerminalReceipt"
            (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount",
             "equalCount","mismatchCount","holdCount","errorCount","failureCode")
            VALUES ('e3-early-failed','e3-attempt','failed',1,0,0,0,0,0,'fixture_failure');
          RAISE EXCEPTION 'rollback accepted failed terminal' USING ERRCODE='P0001';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          IF SQLERRM <> 'rollback accepted failed terminal' THEN RAISE; END IF;
        END;
      END $terminal_shape$;
      DO $incomplete_proof$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowComparisonReceipt"
            (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
             comparable,"factHash","legacySourceHash","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-unproved','e3-attempt','e3-record','e3-sheet','e3-member','e3-activity',
              'equal',TRUE,'${HASH}','${HASH}','sha256',1);
          RAISE EXCEPTION 'unproved comparable result accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow comparable proof is incomplete' THEN RAISE; END IF;
        END;
      END $incomplete_proof$;
      INSERT INTO "ContributionShadowComparisonReceipt"
        (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
         comparable,"factHash","legacySourceHash","hashAlgorithmCode","canonicalVersion")
        VALUES ('e3-comparison','e3-attempt','e3-record','e3-sheet','e3-member','e3-activity',
          'mapping_hold',FALSE,'${HASH}','${HASH}','sha256',1);
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount",
         "equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('e3-terminal','e3-attempt','complete',1,1,0,0,1,0);
      INSERT INTO "ContributionShadowDispositionReceipt"
        (id,"windowId","auditLogId","attemptId",revision,"decisionCode","evidenceHash",
         "signedByUserId","hashAlgorithmCode","canonicalVersion")
        VALUES ('e3-disposition','e3-window','e3-audit','e3-attempt',1,'unresolved',
          '${HASH}','e3-user','sha256',1);
      DO $revision_shape$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowDispositionReceipt"
            (id,"windowId","auditLogId","attemptId",revision,"previousDispositionId",
             "decisionCode","evidenceHash","signedByUserId","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-revision-2','e3-window','e3-audit','e3-attempt',2,
              'e3-disposition','unresolved','${HASH}','e3-user','sha256',1);
          RAISE EXCEPTION 'rollback valid revision' USING ERRCODE='P0001';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          IF SQLERRM <> 'rollback valid revision' THEN RAISE; END IF;
        END;
        BEGIN
          INSERT INTO "ContributionShadowDispositionReceipt"
            (id,"windowId","auditLogId","attemptId",revision,"previousDispositionId",
             "decisionCode","evidenceHash","signedByUserId","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-skipped-revision','e3-window','e3-audit','e3-attempt',3,
              'e3-disposition','unresolved','${HASH}','e3-user','sha256',1);
          RAISE EXCEPTION 'skipped disposition revision accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow disposition predecessor mismatch' THEN RAISE; END IF;
        END;
      END $revision_shape$;
      DO $guard$
      BEGIN
        BEGIN
          UPDATE "ContributionShadowComparisonReceipt" SET "classificationCode"='equal'
            WHERE id='e3-comparison';
          RAISE EXCEPTION 'mutable comparison accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN NULL;
        END;
        BEGIN
          DELETE FROM "ContributionShadowDispositionReceipt" WHERE id='e3-disposition';
          RAISE EXCEPTION 'disposition delete accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN NULL;
        END;
        BEGIN
          INSERT INTO "ContributionShadowComparisonReceipt"
            (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
             comparable,"factHash","legacySourceHash","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-late','e3-attempt','e3-record','e3-sheet','e3-member','e3-activity',
              'mapping_hold',FALSE,'${HASH}','${HASH}','sha256',1);
          RAISE EXCEPTION 'post-terminal comparison accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow comparison after terminal' THEN RAISE; END IF;
        END;
        BEGIN
          INSERT INTO "ContributionShadowDispositionReceipt"
            (id,"windowId","auditLogId","attemptId",revision,"previousDispositionId",
             "decisionCode","evidenceHash","signedByUserId","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-unsupported-decision','e3-window','e3-audit','e3-attempt',2,
              'e3-disposition','confirmed_gap','${HASH}','e3-user','sha256',1);
          RAISE EXCEPTION 'unsigned disposition accepted' USING ERRCODE='P0001';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow disposition requires signed decision proof' THEN RAISE; END IF;
        END;
      END $guard$;
      SELECT (SELECT count(*) FROM "ContributionShadowAttemptReceipt") || ':' ||
             (SELECT "holdCount" FROM "ContributionShadowTerminalReceipt") || ':' ||
             (SELECT "decisionCode" FROM "ContributionShadowDispositionReceipt");
      ROLLBACK;`);
    expect(output.split('\n').at(-1)).toBe('1:1:unresolved');
    expect(sql(`SELECT count(*) FROM "ContributionShadowAttemptReceipt"`)).toBe('0');
  });

  it('rejects database-level mutation and truncate even on empty tables', () => {
    rejected(`TRUNCATE TABLE "ContributionShadowObservationWindow" CASCADE`, 'append-only');
    rejected(`TRUNCATE TABLE "ContributionShadowComparisonReceipt"`, 'append-only');
  });

  it('cleans the audit test fixture and restores all append-only triggers', async () => {
    sql(`INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
         VALUES ('e3-cleanup-audit',CURRENT_TIMESTAMP,'test','e3-cleanup','test', '{}'::jsonb)`);
    const prisma = new PrismaService();
    await prisma.$connect();
    try {
      const app = { get: () => prisma } as unknown as INestApplication;
      await truncateAuditLogsTestOnly(app);
    } finally {
      await prisma.$disconnect();
    }
    expect(sql(`SELECT count(*) FROM audit_logs WHERE id='e3-cleanup-audit'`)).toBe('0');
    expect(
      sql(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tgname IN (
          'csow_no_truncate','csar_no_truncate','cscr_no_truncate',
          'cstr_no_truncate','csdr_no_truncate')`),
    ).toBe('5');
    rejected(`TRUNCATE TABLE "ContributionShadowAttemptReceipt" CASCADE`, 'append-only');
  });

  it('preserves a nonempty 132-migration database across the additive upgrade', () => {
    recreate();
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-e3-d1-pre133-'));
    try {
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(ROOT, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(ROOT, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(ROOT, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= MIGRATION)
        .map((entry) => entry.name)
        .sort();
      expect(names).toHaveLength(133);
      expect(names.at(-1)).toBe(MIGRATION);
      for (const name of names.slice(0, -1)) {
        cpSync(join(ROOT, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = join(temporary, 'schema.prisma');
      deploy(schema);
      sql(`BEGIN;
        INSERT INTO "User" (id,username,"passwordHash","updatedAt")
          VALUES ('e3-old-user','e3-old-user','fixture',CURRENT_TIMESTAMP);
        INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt")
          VALUES ('e3-old-org','E3 old fixture','team',CURRENT_TIMESTAMP);
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          VALUES ('e3-old-member','E3002','Old Fixture Member',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
        INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
          VALUES ('e3-old-activity','E3 old fixture','e3_fixture','e3-old-org',
            '2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('e3-old-sheet','e3-old-activity','e3-old-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
          "serviceHours","attendanceStatusCode","updatedAt")
          VALUES ('e3-old-record','e3-old-sheet','e3-old-member','member',
            '2099-01-02','2099-01-02 01:00',1.00,'present',CURRENT_TIMESTAMP);
        COMMIT;`);
      const before = sql(`SELECT
        (SELECT id || ':' || username FROM "User" WHERE id='e3-old-user') || ':' ||
        (SELECT "activityId" FROM "AttendanceSheet" WHERE id='e3-old-sheet') || ':' ||
        (SELECT "memberId" FROM "AttendanceRecord" WHERE id='e3-old-record')`);
      cpSync(join(ROOT, 'migrations', MIGRATION), join(temporary, 'migrations', MIGRATION), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      deploy(schema);
      expect(
        sql(`SELECT
          (SELECT id || ':' || username FROM "User" WHERE id='e3-old-user') || ':' ||
          (SELECT "activityId" FROM "AttendanceSheet" WHERE id='e3-old-sheet') || ':' ||
          (SELECT "memberId" FROM "AttendanceRecord" WHERE id='e3-old-record')`),
      ).toBe(before);
      expect(sql(`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).toBe(
        '133',
      );
      expect(sql(`SELECT count(*) FROM "ContributionShadowAttemptReceipt"`)).toBe('0');
      sql(`DELETE FROM "AttendanceRecord" WHERE id='e3-old-record';
        DELETE FROM "AttendanceSheet" WHERE id='e3-old-sheet';
        DELETE FROM "Activity" WHERE id='e3-old-activity';
        DELETE FROM "Member" WHERE id='e3-old-member';
        DELETE FROM "Organization" WHERE id='e3-old-org';
        DELETE FROM "User" WHERE id='e3-old-user'`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);

  it('serializes concurrent overlapping windows and rejects the later insert', async () => {
    sql(`INSERT INTO "User" (id,username,"passwordHash","updatedAt")
      VALUES ('e3-race-user','e3-race-user','fixture',CURRENT_TIMESTAMP)`);
    const prisma = new PrismaService();
    await prisma.$connect();
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirst!: () => void;
    const firstInserted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    let signalSecondPid!: (pid: number) => void;
    const secondPid = new Promise<number>((resolve) => {
      signalSecondPid = resolve;
    });
    try {
      const first = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`INSERT INTO "ContributionShadowObservationWindow"
            (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
             "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-race-first','2099-02-01','2099-02-03','e3-race-user',
              '${HASH}','${HASH}','e3-fixture','sha256',1)`);
          signalFirst();
          await release;
        },
        { timeout: 30_000 },
      );
      await firstInserted;
      const second = prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
            'SELECT pg_backend_pid() AS pid',
          );
          signalSecondPid(rows[0].pid);
          await tx.$executeRawUnsafe(`INSERT INTO "ContributionShadowObservationWindow"
            (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
             "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
            VALUES ('e3-race-second','2099-02-02','2099-02-04','e3-race-user',
              '${HASH}','${HASH}','e3-fixture','sha256',1)`);
        },
        { timeout: 30_000 },
      );
      const pid = await secondPid;
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (!blocked && Date.now() < deadline) {
        const rows = await prisma.$queryRawUnsafe<Array<{ blocked: boolean }>>(
          'SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked',
          pid,
        );
        blocked = rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      releaseFirst();
      await first;
      await expect(second).rejects.toThrow(/23P01|exclusion constraint/);
      expect(
        sql(`SELECT count(*) FROM "ContributionShadowObservationWindow" WHERE id LIKE 'e3-race-%'`),
      ).toBe('1');
    } finally {
      releaseFirst();
      try {
        const app = { get: () => prisma } as unknown as INestApplication;
        await truncateAuditLogsTestOnly(app);
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='e3-race-user'`);
      } finally {
        await prisma.$disconnect();
      }
    }
  }, 60_000);
});
