import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { ContributionShadowEvidenceWriteService } from '../../src/modules/attendances/contribution-shadow-evidence.write.service';
import { createTestApp } from '../setup/test-app';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { hashLegacySource } from '../../src/modules/attendances/contribution-shadow-evidence.write.service';
import { loadTestEnv } from '../setup/load-env';
import { withTimeLedgerFixtureCleanup } from '../setup/time-ledger-fixture-cleanup';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const USE_DEDICATED_W98 = process.env.SRVF_E3_D2_W98 === '1';

function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('source proof test requires a worker database');
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
  let errorText = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    errorText = String(error.stderr);
  }
  expect(errorText).toContain(marker);
}

describe('E3-2 D2 source proof migration', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      if (deriveTestDbName() !== 'app_test_w98') throw new Error('unexpected isolated target');
      dropWorkerDatabase('98');
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
        { stdio: 'pipe' },
      );
      execFileSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
        {
          env: process.env,
          stdio: 'pipe',
        },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  }, 120_000);

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

  it('cold-replays 135 migrations with an empty anchor table and default-off audit bit', () => {
    expect(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')).toBe(
      '135',
    );
    expect(sql('SELECT count(*) FROM "ContributionShadowLegacySourceAnchor"')).toBe('0');
    expect(
      sql(`SELECT column_default FROM information_schema.columns
        WHERE table_name='audit_logs' AND column_name='shadowProofRequired'`),
    ).toBe('false');
  });

  it('matches the audit timestamp default at millisecond precision in a non-UTC session', () => {
    expect(
      sql(`BEGIN;
        SET LOCAL TIME ZONE 'Asia/Shanghai';
        INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
          VALUES ('d2-time-probe','attendance_sheet','probe','attendance-sheet.submit','{}'::jsonb);
        SELECT ("createdAt" AT TIME ZONE 'UTC') =
          (transaction_timestamp()::timestamp(3) AT TIME ZONE 'UTC')
          FROM audit_logs WHERE id='d2-time-probe';
        ROLLBACK;`),
    ).toBe('t');
  });

  it('TypeScript and PostgreSQL calculate the same canonical source hash', () => {
    const input = {
      windowId: 'window-1',
      auditLogId: 'audit-1',
      sheetId: 'sheet-1',
      sheetVersion: 2,
      activityId: 'activity-1',
      recordId: 'record-1',
      memberId: 'member-1',
      activityTypeCode: '救援',
      attendanceRoleCode: 'volunteer',
      legacyServiceHours: new Prisma.Decimal('1.50'),
      legacyPoints: new Prisma.Decimal('2.00'),
      source: {
        sourceKindCode: 'matched' as const,
        legacyRuleId: 'rule-1',
        durationThreshold: new Prisma.Decimal('2.00'),
        pointsBelow: new Prisma.Decimal('2.00'),
        pointsAbove: new Prisma.Decimal('3.00'),
      },
    };
    const pgHash = sql(`SELECT cslsa_source_hash_fn(jsonb_populate_record(
      NULL::"ContributionShadowLegacySourceAnchor", jsonb_build_object(
        'windowId','window-1','auditLogId','audit-1','sheetId','sheet-1','sheetVersion',2,
        'activityId','activity-1','recordId','record-1','memberId','member-1',
        'activityTypeCode','救援','attendanceRoleCode','volunteer',
        'legacyServiceHours',1.50,'sourceKindCode','matched','legacyRuleId','rule-1',
        'durationThreshold',2.00,'pointsBelow',2.00,'pointsAbove',3.00,'legacyPoints',2.00
      )))`);
    expect(pgHash).toBe(hashLegacySource(input));
  });

  it('accepts complete matched and hold-only no_match sources in one old-write transaction', () => {
    const sourceHash = hashLegacySource({
      windowId: 'd2-window',
      auditLogId: 'd2-audit',
      sheetId: 'd2-sheet',
      sheetVersion: 1,
      activityId: 'd2-activity',
      recordId: 'd2-record',
      memberId: 'd2-member',
      activityTypeCode: 'd2_fixture',
      attendanceRoleCode: 'member',
      legacyServiceHours: new Prisma.Decimal('1.00'),
      legacyPoints: new Prisma.Decimal('2.00'),
      source: {
        sourceKindCode: 'matched',
        legacyRuleId: 'd2-rule',
        durationThreshold: new Prisma.Decimal('0.50'),
        pointsBelow: new Prisma.Decimal('2.00'),
        pointsAbove: null,
      },
    });
    const noMatchHash = hashLegacySource({
      windowId: 'd2-window',
      auditLogId: 'd2-audit',
      sheetId: 'd2-sheet',
      sheetVersion: 1,
      activityId: 'd2-activity',
      recordId: 'd2-no-match-record',
      memberId: 'd2-member',
      activityTypeCode: 'd2_fixture',
      attendanceRoleCode: 'support',
      legacyServiceHours: new Prisma.Decimal('1.00'),
      legacyPoints: new Prisma.Decimal('0.00'),
      source: {
        sourceKindCode: 'no_match',
        legacyRuleId: null,
        durationThreshold: null,
        pointsBelow: null,
        pointsAbove: null,
      },
    });
    expect(
      sql(`BEGIN;
      INSERT INTO "User" (id,username,"passwordHash","updatedAt")
        VALUES ('d2-user','d2-user','fixture',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt")
        VALUES ('d2-org','D2 fixture','team',CURRENT_TIMESTAMP);
      INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
        VALUES ('d2-member','D2001','Fixture Member',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
      INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
        VALUES ('d2-activity','D2 fixture','d2_fixture','d2-org','2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
        VALUES ('d2-sheet','d2-activity','d2-user','pending_review',CURRENT_TIMESTAMP,1);
      INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
        "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
        VALUES ('d2-record','d2-sheet','d2-member','member','2099-01-02','2099-01-02 01:00',
          1.00,'present',2.00,CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
        "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
        VALUES ('d2-no-match-record','d2-sheet','d2-member','support',
          '2099-01-02 02:00','2099-01-02 03:00',1.00,'present',0.00,CURRENT_TIMESTAMP);
      INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","durationThreshold","pointsBelow","updatedAt")
        VALUES ('d2-rule','d2_fixture','member',0.50,2.00,CURRENT_TIMESTAMP);
      INSERT INTO "ContributionShadowObservationWindow"
        (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
         "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
        VALUES ('d2-window','2099-01-01','2099-01-03','d2-user',
          repeat('a',64),repeat('a',64),'d2-fixture','sha256',1);
      INSERT INTO audit_logs
        (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
        VALUES ('d2-audit','2099-01-01 12:00','attendance_sheet','d2-sheet',
          'attendance-sheet.submit',jsonb_build_object(
            'after',jsonb_build_object('sheet',jsonb_build_object('activityId','d2-activity','version',1),
              'records',jsonb_build_array(jsonb_build_object('id','d2-record','memberId','d2-member',
                'roleCode','member','serviceHours','1','contributionPoints','2'),
                jsonb_build_object('id','d2-no-match-record','memberId','d2-member',
                  'roleCode','support','serviceHours','1','contributionPoints','0'))),
            'extra',jsonb_build_object('operation','submit','recordsCount',2)),true);
      DO $wrong_digest$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowLegacySourceAnchor"
            (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
             "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
             "durationThreshold","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
            VALUES ('d2-wrong','d2-window','d2-audit','d2-sheet',1,'d2-activity','d2-record','d2-member',
              'd2_fixture','member',1.00,'matched','d2-rule',0.50,2.00,2.00,'sha256',1,repeat('a',64));
          RAISE EXCEPTION 'bad digest was accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow source digest mismatch' THEN RAISE; END IF;
        END;
      END $wrong_digest$;
      UPDATE "ContributionRule" SET "pointsBelow"=3.00 WHERE id='d2-rule';
      DO $rule_drift$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowLegacySourceAnchor"
            (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
             "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
             "durationThreshold","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
            VALUES ('d2-drift','d2-window','d2-audit','d2-sheet',1,'d2-activity','d2-record','d2-member',
              'd2_fixture','member',1.00,'matched','d2-rule',0.50,2.00,2.00,'sha256',1,'${sourceHash}');
          RAISE EXCEPTION 'changed legacy rule was accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow legacy rule drift' THEN RAISE; END IF;
        END;
      END $rule_drift$;
      UPDATE "ContributionRule" SET "pointsBelow"=2.00 WHERE id='d2-rule';
      INSERT INTO "ContributionShadowLegacySourceAnchor"
        (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
         "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
         "durationThreshold","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
        VALUES ('d2-anchor','d2-window','d2-audit','d2-sheet',1,'d2-activity','d2-record','d2-member',
          'd2_fixture','member',1.00,'matched','d2-rule',0.50,2.00,2.00,'sha256',1,'${sourceHash}');
      INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
        VALUES ('d2-support-rule','d2_fixture','support',1.00,CURRENT_TIMESTAMP);
      DO $no_match_rule$
      BEGIN
        BEGIN
          INSERT INTO "ContributionShadowLegacySourceAnchor"
            (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
             "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode",
             "legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
            VALUES ('d2-false-no-match','d2-window','d2-audit','d2-sheet',1,'d2-activity',
              'd2-no-match-record','d2-member','d2_fixture','support',1.00,'no_match',
              0.00,'sha256',1,'${noMatchHash}');
          RAISE EXCEPTION 'no_match with an active rule was accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow no_match observed active rule' THEN RAISE; END IF;
        END;
      END $no_match_rule$;
      DELETE FROM "ContributionRule" WHERE id='d2-support-rule';
      INSERT INTO "ContributionShadowLegacySourceAnchor"
        (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
         "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode",
         "legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
        VALUES ('d2-no-match-anchor','d2-window','d2-audit','d2-sheet',1,'d2-activity',
          'd2-no-match-record','d2-member','d2_fixture','support',1.00,'no_match',
          0.00,'sha256',1,'${noMatchHash}');
      SET CONSTRAINTS ALL IMMEDIATE;
      DO $immutable$
      BEGIN
        BEGIN
          UPDATE audit_logs SET "resourceId"='other' WHERE id='d2-audit';
          RAISE EXCEPTION 'proof audit update was accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow proof audit flag is immutable' THEN RAISE; END IF;
        END;
        BEGIN
          DELETE FROM "ContributionShadowLegacySourceAnchor" WHERE id='d2-anchor';
          RAISE EXCEPTION 'source deletion was accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'contribution shadow evidence is append-only' THEN RAISE; END IF;
        END;
      END $immutable$;
      SELECT count(*) FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='d2-audit';
      ROLLBACK;`),
    ).toBe('2');
  });

  it('preserves an ordinary old audit insert and forbids false-to-true upgrade', () => {
    expect(
      sql(`BEGIN;
      INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
        VALUES ('d2-legacy-audit','attendance_sheet','sheet-1','attendance-sheet.submit','{}'::jsonb);
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "shadowProofRequired" FROM audit_logs WHERE id='d2-legacy-audit';
      ROLLBACK;`),
    ).toBe('f');
    rejected(
      `BEGIN;
      INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
        VALUES ('d2-legacy-audit','attendance_sheet','sheet-1','attendance-sheet.submit','{}'::jsonb);
      UPDATE audit_logs SET "shadowProofRequired"=true WHERE id='d2-legacy-audit';`,
      'shadow proof audit flag is immutable',
    );
  });

  it('rejects committing proof-required audit without the complete anchor set', () => {
    rejected(
      `BEGIN;
      INSERT INTO audit_logs (id,"resourceType","resourceId",event,context,"shadowProofRequired")
        VALUES ('d2-incomplete','attendance_sheet','sheet-1','attendance-sheet.submit',
          '{"after":{"records":[{"id":"record-1"}]}}'::jsonb,true);
      SET CONSTRAINTS ALL IMMEDIATE;`,
      'shadow audit source set incomplete',
    );
  });

  it('allows only guarded w98 fixture cleanup and restores the anchor no-truncate trigger', async () => {
    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(
        (tx) =>
          withTimeLedgerFixtureCleanup(tx, async (guarded) => {
            await guarded.$executeRawUnsafe(
              'TRUNCATE TABLE "ContributionShadowMappingApplication", "ContributionShadowLegacySourceAnchor" RESTART IDENTITY',
            );
          }),
        { timeout: 30_000 },
      );
      expect(
        sql(`SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='ContributionShadowLegacySourceAnchor' AND t.tgname='cslsa_no_truncate'`),
      ).toBe('O');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('keeps the 2,000-record source insert and deferred set guard within the old 7-second ceiling', () => {
    const elapsed = Number(
      sql(`BEGIN;
      INSERT INTO "User" (id,username,"passwordHash","updatedAt")
        VALUES ('d2-bulk-user','d2-bulk-user','fixture',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt")
        VALUES ('d2-bulk-org','D2 bulk fixture','team',CURRENT_TIMESTAMP);
      INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
        VALUES ('d2-bulk-member','D2999','Bulk Fixture Member',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
      INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
        VALUES ('d2-bulk-activity','D2 bulk fixture','d2_bulk','d2-bulk-org',
          '2099-01-02','2099-12-31','test','draft',CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
        VALUES ('d2-bulk-sheet','d2-bulk-activity','d2-bulk-user','pending_review',CURRENT_TIMESTAMP,1);
      INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
        VALUES ('d2-bulk-rule','d2_bulk','member',2.00,CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
        "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
        SELECT 'd2-bulk-record-' || n,'d2-bulk-sheet','d2-bulk-member','member',
          '2099-01-02'::timestamp + n * interval '1 hour',
          '2099-01-02'::timestamp + (n + 1) * interval '1 hour',
          1.00,'present',2.00,CURRENT_TIMESTAMP FROM generate_series(0,1999) AS g(n);
      INSERT INTO "ContributionShadowObservationWindow"
        (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
         "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
        VALUES ('d2-bulk-window','2099-01-01','2099-12-31','d2-bulk-user',
          repeat('a',64),repeat('a',64),'d2-bulk','sha256',1);
      INSERT INTO audit_logs
        (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
        SELECT 'd2-bulk-audit','2099-01-01 12:00','attendance_sheet','d2-bulk-sheet',
          'attendance-sheet.submit',jsonb_build_object(
            'after',jsonb_build_object('sheet',jsonb_build_object('activityId','d2-bulk-activity','version',1),
              'records',(SELECT jsonb_agg(jsonb_build_object('id',id,'memberId',"memberId",
                'roleCode',"roleCode",'serviceHours','1','contributionPoints','2') ORDER BY id)
                FROM "AttendanceRecord" WHERE "sheetId"='d2-bulk-sheet')),
            'extra',jsonb_build_object('operation','submit','recordsCount',2000)),true;
      CREATE TEMP TABLE d2_bulk_anchor (LIKE "ContributionShadowLegacySourceAnchor" INCLUDING DEFAULTS);
      INSERT INTO d2_bulk_anchor
        (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
         "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
         "pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
        SELECT 'anchor-' || r.id,'d2-bulk-window','d2-bulk-audit','d2-bulk-sheet',1,
          'd2-bulk-activity',r.id,r."memberId",'d2_bulk','member',r."serviceHours",
          'matched','d2-bulk-rule',2.00,r."contributionPoints",'sha256',1,repeat('0',64)
          FROM "AttendanceRecord" r WHERE r."sheetId"='d2-bulk-sheet';
      UPDATE d2_bulk_anchor a SET "legacySourceHash" = cslsa_source_hash_fn(
        jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",to_jsonb(a)));
      CREATE TEMP TABLE d2_bulk_timing (started TIMESTAMPTZ);
      INSERT INTO d2_bulk_timing VALUES (clock_timestamp());
      INSERT INTO "ContributionShadowLegacySourceAnchor"
        (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
         "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
         "pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
        SELECT id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId",
          "activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId",
          "pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash"
          FROM d2_bulk_anchor;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT round(extract(epoch from clock_timestamp() - started) * 1000)::text FROM d2_bulk_timing;
      ROLLBACK;`),
    );
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeLessThan(7000);
  }, 120_000);

  it('preserves existing attendance and audit facts across nonempty 133→134 upgrade', () => {
    if (!USE_DEDICATED_W98) return;
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    dropWorkerDatabase('98');
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-e3-d2-pre134-'));
    try {
      const root = join(process.cwd(), 'prisma');
      const predecessor = '20260928095832_activity_os_r5_e3_shadow_evidence';
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(root, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(root, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(root, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= predecessor)
        .map((entry) => entry.name)
        .sort();
      expect(names).toHaveLength(133);
      expect(names.at(-1)).toBe(predecessor);
      for (const name of names) {
        cpSync(join(root, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = join(temporary, 'schema.prisma');
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
        env: process.env,
        stdio: 'pipe',
      });
      sql(`BEGIN;
        INSERT INTO "User" (id,username,"passwordHash","updatedAt")
          VALUES ('d2-old-user','d2-old-user','fixture',CURRENT_TIMESTAMP);
        INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt")
          VALUES ('d2-old-org','D2 old fixture','team',CURRENT_TIMESTAMP);
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          VALUES ('d2-old-member','D2002','Old Fixture Member',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
        INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
          VALUES ('d2-old-activity','D2 old fixture','d2_fixture','d2-old-org',
            '2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('d2-old-sheet','d2-old-activity','d2-old-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
          "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
          VALUES ('d2-old-record','d2-old-sheet','d2-old-member','member',
            '2099-01-02','2099-01-02 01:00',1.00,'present',2.00,CURRENT_TIMESTAMP);
        INSERT INTO audit_logs (id,"resourceType","resourceId",event,context)
          VALUES ('d2-old-audit','attendance_sheet','d2-old-sheet','attendance-sheet.submit','{}'::jsonb);
        COMMIT;`);
      const before = sql(`SELECT
        (SELECT id || ':' || username FROM "User" WHERE id='d2-old-user') || ':' ||
        (SELECT "memberId" || ':' || "contributionPoints"::text FROM "AttendanceRecord" WHERE id='d2-old-record') || ':' ||
        (SELECT event FROM audit_logs WHERE id='d2-old-audit')`);
      const successor = '20260929222500_activity_os_r5_e3_shadow_source_proof';
      cpSync(join(root, 'migrations', successor), join(temporary, 'migrations', successor), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
        env: process.env,
        stdio: 'pipe',
      });
      expect(sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`)).toBe(
        '134',
      );
      expect(
        sql(`SELECT
        (SELECT id || ':' || username FROM "User" WHERE id='d2-old-user') || ':' ||
        (SELECT "memberId" || ':' || "contributionPoints"::text FROM "AttendanceRecord" WHERE id='d2-old-record') || ':' ||
        (SELECT event FROM audit_logs WHERE id='d2-old-audit')`),
      ).toBe(before);
      expect(sql(`SELECT "shadowProofRequired" FROM audit_logs WHERE id='d2-old-audit'`)).toBe('f');
      expect(sql(`SELECT count(*) FROM "ContributionShadowLegacySourceAnchor"`)).toBe('0');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);

  it('real submit/edit preserve CUIDs, roll back source failure and complete a 2,000-record old write within 7 seconds', async () => {
    const previousMode = process.env.ACTIVITY_E3_CONTRIBUTION_SHADOW_MODE;
    process.env.ACTIVITY_E3_CONTRIBUTION_SHADOW_MODE = 'shadow';
    let app: INestApplication | undefined;
    try {
      app = await createTestApp();
      const prisma = app.get(PrismaService);
      const service = app.get(AttendancesService);
      const user = await prisma.user.create({
        data: {
          username: 'd2-runtime-user',
          passwordHash: 'unused-fixture',
          role: Role.ADMIN,
        },
      });
      const seed = await seedBizAdminPermissionsAndRole(app);
      await grantBizAdminToUser(app, user.id, seed.bizAdminRoleId);
      const actor = {
        id: user.id,
        username: user.username,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      };
      const member = await prisma.member.create({
        data: {
          memberNo: 'D2-RUNTIME',
          ...memberIdentityData('Source Proof Fixture'),
        },
      });
      const organization = await prisma.organization.create({
        data: {
          name: 'D2 Runtime',
          nodeTypeCode: 'team',
        },
      });
      for (const [code, values] of [
        ['attendance_role', ['member', 'support']],
        ['attendance_status', ['present']],
      ] as const) {
        const type = await prisma.dictType.upsert({
          where: { code },
          create: { code, label: code },
          update: {},
        });
        for (const value of values)
          await prisma.dictItem.upsert({
            where: { typeId_code: { typeId: type.id, code: value } },
            create: { typeId: type.id, code: value, label: value },
            update: {},
          });
      }
      const activity = await prisma.activity.create({
        data: {
          title: 'D2 Runtime',
          activityTypeCode: 'd2_runtime',
          organizationId: organization.id,
          startAt: new Date('2026-01-01T07:00:00.000Z'),
          endAt: new Date('2026-01-01T18:00:00.000Z'),
          location: 'fixture',
          statusCode: 'published',
        },
      });
      await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'd2_runtime',
          attendanceRoleCode: 'member',
          pointsBelow: '1.50',
        },
      });
      const [window] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "ContributionShadowObservationWindow"
          (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest",
           "signedMappingVersion","hashAlgorithmCode","canonicalVersion")
        VALUES ('d2-runtime-window',clock_timestamp() + interval '100 milliseconds',
          clock_timestamp() + interval '1 hour',${user.id},${'a'.repeat(64)},${'b'.repeat(64)},
          'isolated-fixture-hold','sha256',1)
        RETURNING id
      `;
      // Poll the actual database eligibility boundary; registration must precede start.
      const readinessStarted = Date.now();
      for (;;) {
        const [state] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
          SELECT (transaction_timestamp()::timestamp(3) AT TIME ZONE 'UTC') >= "startsAt" AS ready
          FROM "ContributionShadowObservationWindow" WHERE id=${window.id}
        `;
        if (state.ready) break;
        if (Date.now() - readinessStarted > 5000) throw new Error('fixture window did not start');
      }
      const records = [
        {
          memberId: member.id,
          roleCode: 'member',
          checkInAt: '2026-01-01T08:00:00.000Z',
          checkOutAt: '2026-01-01T10:00:00.000Z',
          attendanceStatusCode: 'present',
        },
        {
          memberId: member.id,
          roleCode: 'support',
          checkInAt: '2026-01-01T10:00:00.000Z',
          checkOutAt: '2026-01-01T12:00:00.000Z',
          attendanceStatusCode: 'present',
        },
      ];
      const meta = { requestId: 'd2-runtime-fixture', ip: null, ua: null };
      const sheet = await service.submit(activity.id, { records }, actor, meta);
      for (const version of [1, 2]) {
        if (version === 2) await service.edit(sheet.id, { records }, actor, meta);
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: {
            resourceId: sheet.id,
            event: version === 1 ? 'attendance-sheet.submit' : 'attendance-sheet.edit',
          },
        });
        expect(audit.shadowProofRequired).toBe(true);
        const anchors = await prisma.contributionShadowLegacySourceAnchor.findMany({
          where: { auditLogId: audit.id },
          orderBy: { attendanceRoleCode: 'asc' },
        });
        expect(anchors).toHaveLength(2);
        expect(anchors.map((row) => row.sourceKindCode)).toEqual(['matched', 'no_match']);
        expect(anchors.map((row) => row.legacyPoints.toFixed(2))).toEqual(['1.50', '0.00']);
        for (const anchor of anchors) {
          expect(anchor.recordId).toMatch(/^c[a-z0-9]{24}$/);
          expect(anchor.windowId).toBe(window.id);
          expect(anchor.sheetVersion).toBe(version);
          const record = await prisma.attendanceRecord.findUniqueOrThrow({
            where: { id: anchor.recordId },
          });
          expect(record.sheetId).toBe(sheet.id);
          expect(record.memberId).toBe(member.id);
          expect(record.roleCode).toBe(anchor.attendanceRoleCode);
          expect(record.contributionPoints?.equals(anchor.legacyPoints)).toBe(true);
        }
      }
      const auditCount = await prisma.auditLog.count({ where: { resourceId: sheet.id } });
      const ids = (
        await prisma.attendanceRecord.findMany({
          where: { sheetId: sheet.id, deletedAt: null },
          orderBy: { id: 'asc' },
        })
      ).map((row) => row.id);
      const failure = jest
        .spyOn(app.get(ContributionShadowEvidenceWriteService), 'writeMatchedLegacySources')
        .mockRejectedValueOnce(new Error('isolated source failure'));
      try {
        await expect(service.edit(sheet.id, { records }, actor, meta)).rejects.toThrow(
          'isolated source failure',
        );
      } finally {
        failure.mockRestore();
      }
      expect(
        (await prisma.attendanceSheet.findUniqueOrThrow({ where: { id: sheet.id } })).version,
      ).toBe(2);
      expect(await prisma.auditLog.count({ where: { resourceId: sheet.id } })).toBe(auditCount);
      expect(
        (
          await prisma.attendanceRecord.findMany({
            where: { sheetId: sheet.id, deletedAt: null },
            orderBy: { id: 'asc' },
          })
        ).map((row) => row.id),
      ).toEqual(ids);
      expect(
        await prisma.contributionShadowLegacySourceAnchor.count({ where: { sheetId: sheet.id } }),
      ).toBe(4);
      expect(await prisma.contributionShadowComparisonReceipt.count()).toBe(0);

      const bulkMembers = Array.from({ length: 2000 }, (_, index) => ({
        id: `d2-runtime-bulk-member-${index}`,
        memberNo: `D2-RUNTIME-BULK-${index}`,
        ...memberIdentityData('Bulk Source Fixture'),
      }));
      await prisma.member.createMany({ data: bulkMembers });
      const bulkActivity = await prisma.activity.create({
        data: {
          title: 'D2 Runtime Bulk',
          activityTypeCode: 'd2_runtime',
          organizationId: organization.id,
          startAt: new Date('2026-01-01T07:00:00.000Z'),
          endAt: new Date('2026-01-01T18:00:00.000Z'),
          location: 'fixture',
          statusCode: 'published',
        },
      });
      const bulkRecords = bulkMembers.map((row) => ({ ...records[0], memberId: row.id }));
      const started = performance.now();
      const bulkSheet = await service.submit(
        bulkActivity.id,
        { records: bulkRecords },
        actor,
        meta,
      );
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(7000);
      const bulkAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          resourceId: bulkSheet.id,
          event: 'attendance-sheet.submit',
        },
      });
      const bulkAnchors = await prisma.contributionShadowLegacySourceAnchor.findMany({
        where: { auditLogId: bulkAudit.id },
      });
      expect(bulkAnchors).toHaveLength(2000);
      expect(new Set(bulkAnchors.map((row) => row.recordId)).size).toBe(2000);
      expect(new Set(bulkAnchors.map((row) => row.memberId))).toEqual(
        new Set(bulkMembers.map((row) => row.id)),
      );
      expect(
        bulkAnchors.every(
          (row) =>
            row.recordId.match(/^c[a-z0-9]{24}$/) &&
            row.sourceKindCode === 'matched' &&
            row.legacyPoints.equals('1.50'),
        ),
      ).toBe(true);
      expect(await prisma.contributionShadowComparisonReceipt.count()).toBe(0);
    } finally {
      await app?.close();
      if (previousMode === undefined) delete process.env.ACTIVITY_E3_CONTRIBUTION_SHADOW_MODE;
      else process.env.ACTIVITY_E3_CONTRIBUTION_SHADOW_MODE = previousMode;
    }
  }, 120_000);
});
