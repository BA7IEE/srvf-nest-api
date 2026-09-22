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
import * as path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

import { loadTestEnv } from '../setup/load-env';
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const D7_2_FACT_MIGRATION = '20260915180000_activity_os_r4_d7_2_fact_correction';
const BINDING_GUARD_MIGRATION = '20260917194000_activity_os_r4_d7_2_binding_guard_set';
const ALLOCATION_GUARD_MIGRATION = '20260920090000_activity_os_r4_d7_2_allocation_guard_set';
const MIGRATION = '20260920110000_activity_os_r4_d7_2_correction_receipt_guard_set';
const D8_1_MIGRATION = '20260921180000_activity_os_r4_d8_proof_cutover';
const E1_1_MIGRATION = '20260922194000_activity_os_r5_e1_contribution_policy_foundation';
const PREVIOUS_MIGRATION_COUNT = 124;
const D7_2_FACT_MIGRATION_COUNT = 125;
const BINDING_GUARD_MIGRATION_COUNT = 126;
const ALLOCATION_GUARD_MIGRATION_COUNT = 127;
const CORRECTION_RECEIPT_GUARD_MIGRATION_COUNT = 128;
const CURRENT_MIGRATION_COUNT = 130;
const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_D7_2_W98 === '1';
const LEGACY_V1_REQUEST_ID = 'd7-2-migration-v1-request';
const LEGACY_V1_BATCH_ID = 'd7-2-migration-v1-batch';

function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('D7-2 migration tests require an isolated worker');
  const database = deriveTestDbName();
  assertDroppableTestDbName(database);
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== `/${database}`) {
    throw new Error('D7-2 migration worker and configured database do not match');
  }
  return { database, worker };
}

function sql(statement: string): string {
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
      target().database,
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function recreate(): void {
  const { database, worker } = target();
  const engine = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' },
  ).trim();
  if (!engine.startsWith('unix://'))
    throw new Error('D7-2 migration requires a local Docker socket');
  const active = execFileSync(
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
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input:
        `SELECT count(*) FROM pg_stat_activity WHERE datname = ${quote(database)} ` +
        "AND backend_type = 'client backend'",
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  if (active !== '0') {
    const summary = sql(
      "SELECT backend_type, COALESCE(state, 'unknown'), count(*) FROM pg_stat_activity " +
        'WHERE datname = current_database() AND pid <> pg_backend_pid() ' +
        'GROUP BY backend_type, state ORDER BY backend_type, state',
    );
    throw new Error(
      `D7-2 migration worker is in use; refusing reconstruction; backend summary: ${summary}`,
    );
  }
  dropWorkerDatabase(worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
  if (sql('SELECT current_database()') !== database) {
    throw new Error('D7-2 migration connected target mismatch');
  }
}

function deploy(schema: string): void {
  target();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}

async function seedLegacyFact(): Promise<void> {
  const db = new PrismaClient();
  const at = new Date('2020-03-01T08:00:00.000Z');
  const end = new Date('2020-03-01T09:00:00.000Z');
  try {
    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { username: 'd7-2-migration-user', passwordHash: 'fixture' },
      });
      const organization = await tx.organization.create({
        data: { name: 'D7-2 migration organization', nodeTypeCode: 'team' },
      });
      const member = await tx.member.create({
        data: {
          memberNo: 'd7-2-migration-member',
          realName: '测试成员',
          memberSinceDate: at,
          memberOriginCode: 'fixture',
        },
      });
      const activity = await tx.activity.create({
        data: {
          title: 'D7-2 migration activity',
          activityTypeCode: 'fixture',
          organizationId: organization.id,
          startAt: at,
          endAt: end,
          location: 'fixture',
          statusCode: 'published',
        },
      });
      const session = await tx.activitySession.create({
        data: {
          activityId: activity.id,
          code: 'fixture',
          name: 'fixture',
          startAt: at,
          endAt: end,
          locationText: 'fixture',
          checkInOpenAt: at,
          checkInCloseAt: end,
          checkOutOpenAt: at,
          checkOutCloseAt: end,
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
      });
      const registration = await tx.activityRegistration.create({
        data: { activityId: activity.id, memberId: member.id, statusCode: 'pass' },
      });
      const identity = await tx.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registration.id,
          memberId: member.id,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
      });
      const seal = await tx.evidenceSeal.create({
        data: {
          activityId: activity.id,
          sealRevision: 1,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: end,
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: 1,
          populationCountBySession: {},
          contentHash: 'd7-2-migration-seal',
          statusCode: 'active',
          sealedByUserId: user.id,
          sealedAt: end,
        },
      });
      const run = await tx.attendanceSettlementRun.create({
        data: {
          activityId: activity.id,
          statusCode: 'posting',
          currentDraftVersion: 1,
          currentSubmittedVersion: 1,
        },
      });
      const version = await tx.attendanceSettlementVersion.create({
        data: {
          settlementRunId: run.id,
          version: 1,
          evidenceSealId: seal.id,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: 'd7-2-migration-version',
          personCount: 1,
          sessionParticipationCount: 1,
          serviceSegmentCount: 1,
          createdByUserId: user.id,
          submittedAt: end,
          statusCode: 'approved',
          operationKey: 'd7-2-migration-submit',
        },
      });
      const requestedChangeJson = {
        schemaVersion: 2,
        results: [],
        segments: [],
        timeCorrection: {
          baseSettlementVersionId: version.id,
          baseTimeLedgerHash: 'a'.repeat(64),
          reason: 'legacy fact',
          items: [{ rootEntryId: 'legacy-root', recognizedSeconds: 0 }],
        },
      };
      // This intentionally writes through the 124-column shape. The current
      // generated client selects the D7-2-only resubmission column on create,
      // which cannot exist before the migration under test is applied.
      await tx.$executeRaw(
        Prisma.sql`
          INSERT INTO "AttendanceCorrectionRequest" (
            "id", "createdAt", "updatedAt", "activityId", "settlementRunId",
            "participationIdentityId", "baseSettlementVersionId", "baseResultRevisionId",
            "baseClosureRevision", "requestTypeCode", "requestedChangeJson", "reason",
            "attachmentIds", "statusCode", "submittedByUserId", "submittedAt",
            "reviewedByUserId", "reviewedAt", "reviewNote", "operationKey", "requestHash"
          ) VALUES (
            ${'d7-2-migration-request'}, ${end}, ${end}, ${activity.id}, ${run.id},
            ${identity.id}, ${version.id}, ${null}, ${0}, ${'time'},
            ${JSON.stringify(requestedChangeJson)}::jsonb, ${'legacy fact'}, ${JSON.stringify([])}::jsonb,
            ${'returned'}, ${user.id}, ${end}, ${user.id}, ${end}, ${'legacy review'},
            ${'d7-2-migration-request'}, ${'b'.repeat(64)}
          )
        `,
      );
      const legacyV1ChangeJson = {
        schemaVersion: 1,
        results: [
          {
            participationIdentityId: identity.id,
            resultCode: 'present',
            recognizedServiceHours: '1.00',
            recognizedContributionPoints: '0.00',
            adjustmentReason: 'legacy V1 fact',
            lateFlag: false,
            earlyLeaveFlag: false,
          },
        ],
        segments: [],
      };
      await tx.$executeRaw(
        Prisma.sql`
          INSERT INTO "AttendanceCorrectionRequest" (
            "id", "createdAt", "updatedAt", "activityId", "settlementRunId",
            "participationIdentityId", "baseSettlementVersionId", "baseResultRevisionId",
            "baseClosureRevision", "requestTypeCode", "requestedChangeJson", "reason",
            "attachmentIds", "statusCode", "submittedByUserId", "submittedAt",
            "reviewedByUserId", "reviewedAt", "reviewNote", "operationKey", "requestHash"
          ) VALUES (
            ${LEGACY_V1_REQUEST_ID}, ${end}, ${end}, ${activity.id}, ${run.id},
            ${null}, ${version.id}, ${null}, ${0}, ${'time'},
            ${JSON.stringify(legacyV1ChangeJson)}::jsonb, ${'legacy V1 fact'}, ${JSON.stringify([])}::jsonb,
            ${'approved'}, ${user.id}, ${end}, ${user.id}, ${end}, ${'legacy V1 review'},
            ${LEGACY_V1_REQUEST_ID}, ${'c'.repeat(64)}
          )
        `,
      );
    });
  } finally {
    await db.$disconnect();
  }
}

describe('D7-2 immutable fact-correction migration', () => {
  const root = path.resolve('prisma');
  const schema = path.join(root, 'schema.prisma');
  const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const legacyTables = [
    'User',
    'Activity',
    'AttendanceSettlementRun',
    'AttendanceSettlementVersion',
  ];
  const previousEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${WORKER}`;
    }
    target();
  });

  afterAll(() => {
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase(WORKER);
      } finally {
        restoreEnvironment('JEST_WORKER_ID', previousEnvironment.worker);
        restoreEnvironment('DATABASE_URL', previousEnvironment.databaseUrl);
        restoreEnvironment('STORAGE_LOCAL_ROOT', previousEnvironment.storageRoot);
      }
      return;
    }
    recreate();
    deploy(schema);
  }, 180000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function checksums(): string[] {
    return sql(
      'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" ' +
        'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    ).split('\n');
  }

  function snapshot() {
    return legacyTables.map((table) =>
      sql(`SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM "${table}" t`),
    );
  }

  function exerciseLegacyV1NoTimeCorrectionPath(): void {
    sql(
      `INSERT INTO "LedgerPostingBatch" (
        "id", "createdAt", "updatedAt", "settlementRunId", "settlementVersionId",
        "batchRevision", "statusCode", "requestKey", "preparedByUserId"
      ) SELECT ${quote(LEGACY_V1_BATCH_ID)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        q."settlementRunId", q."baseSettlementVersionId", 1, 'preparing',
        'd7-2-migration-v1-batch', q."submittedByUserId"
      FROM "AttendanceCorrectionRequest" q WHERE q.id = ${quote(LEGACY_V1_REQUEST_ID)}`,
    );
    expect(
      sql(`SELECT count(*) FROM "LedgerPostingBatch" WHERE id = ${quote(LEGACY_V1_BATCH_ID)}`),
    ).toBe('1');
    sql(`
      BEGIN;
      WITH application AS (
        INSERT INTO "CorrectionApplication" (
          "id", "createdAt", "updatedAt", "correctionRequestId", "newSettlementVersionId",
          "newResultRevisionIds", "newPostingBatchId", "statusCode"
        ) SELECT 'd7-2-migration-v1-application', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
          q.id, q."baseSettlementVersionId", '[]'::jsonb, ${quote(LEGACY_V1_BATCH_ID)}, 'preparing'
        FROM "AttendanceCorrectionRequest" q WHERE q.id = ${quote(LEGACY_V1_REQUEST_ID)}
        RETURNING id
      )
      INSERT INTO "CorrectionSegmentPreparationReceipt" ("applicationId", "preparedSegmentCount")
      SELECT id, 0 FROM application;
      COMMIT;
    `);
    expect(
      sql(
        `SELECT count(*) FROM "CorrectionApplication"
         WHERE "newPostingBatchId" = ${quote(LEGACY_V1_BATCH_ID)}`,
      ),
    ).toBe('1');
    sql(
      `UPDATE "LedgerPostingBatch" SET "statusCode" = 'ready', "preparedAt" = CURRENT_TIMESTAMP,
        "preparedCount" = 1 WHERE id = ${quote(LEGACY_V1_BATCH_ID)}`,
    );
    expect(
      sql(
        `SELECT b."statusCode" || chr(9) || (
          SELECT count(*)::text FROM "ParticipationTimeCorrectionManifest" m
          WHERE m."postingBatchId" = b.id
        ) FROM "LedgerPostingBatch" b WHERE b.id = ${quote(LEGACY_V1_BATCH_ID)}`,
      ),
    ).toBe('ready\t0');
  }

  it('cold replays all 130 migrations and installs the four immutable fact tables', () => {
    recreate();
    deploy(schema);
    expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
    expect(names[CORRECTION_RECEIPT_GUARD_MIGRATION_COUNT - 1]).toBe(MIGRATION);
    expect(names[128]).toBe(D8_1_MIGRATION);
    expect(names[CURRENT_MIGRATION_COUNT - 1]).toBe(E1_1_MIGRATION);
    expect(checksums()).toEqual(
      names.map(
        (name) =>
          `${name}\t${createHash('sha256')
            .update(readFileSync(path.join(root, 'migrations', name, 'migration.sql')))
            .digest('hex')}`,
      ),
    );
    expect(
      sql(
        'SELECT array_agg(relname ORDER BY relname)::text FROM pg_class ' +
          "WHERE relkind = 'r' AND relname IN " +
          "('CorrectionPendingTimeAllocation', 'CorrectionPendingTimeAllocationEvidence', " +
          "'CorrectionTimeSourceProof', 'CorrectionTimeAllocationBinding')",
      ),
    ).toBe(
      '{CorrectionPendingTimeAllocation,CorrectionPendingTimeAllocationEvidence,' +
        'CorrectionTimeAllocationBinding,CorrectionTimeSourceProof}',
    );
    expect(
      sql(
        'SELECT array_agg(tgname ORDER BY tgname)::text FROM pg_trigger ' +
          "WHERE tgname IN ('cpta_immutable', 'cptae_immutable', 'ctsp_immutable', " +
          "'ctab_immutable', 'cpta_no_truncate', 'cptae_no_truncate', 'ctsp_no_truncate', 'ctab_no_truncate')",
      ),
    ).toBe(
      '{cpta_immutable,cpta_no_truncate,cptae_immutable,cptae_no_truncate,' +
        'ctab_immutable,ctab_no_truncate,ctsp_immutable,ctsp_no_truncate}',
    );
  }, 180000);

  it('upgrades a nonempty 124-migration database without rewriting legacy facts', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d7-2-pre125-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, PREVIOUS_MIGRATION_COUNT)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(PREVIOUS_MIGRATION_COUNT);
      await seedLegacyFact();
      expect(sql('SELECT count(*) FROM "AttendanceCorrectionRequest"')).toBe('2');
      const before = snapshot();
      const oldChecksums = checksums();
      cpSync(
        path.join(root, 'migrations', D7_2_FACT_MIGRATION),
        path.join(temporary, 'migrations', D7_2_FACT_MIGRATION),
        { recursive: true, errorOnExist: true, force: false },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(D7_2_FACT_MIGRATION_COUNT);
      expect(checksums().slice(0, PREVIOUS_MIGRATION_COUNT)).toEqual(oldChecksums);
      expect(snapshot()).toEqual(before);
      expect(
        sql(
          'SELECT "statusCode" || chr(9) || COALESCE("resubmittedFromRequestId", \'NULL\') ' +
            'FROM "AttendanceCorrectionRequest"',
        ),
      ).toBe('returned\tNULL\napproved\tNULL');
      expect(
        sql(
          `SELECT "statusCode" || chr(9) || ("requestedChangeJson"->>'schemaVersion')
           FROM "AttendanceCorrectionRequest" WHERE id = ${quote(LEGACY_V1_REQUEST_ID)}`,
        ),
      ).toBe('approved\t1');
      exerciseLegacyV1NoTimeCorrectionPath();
      expect(
        sql(
          'SELECT count(*) FROM "CorrectionPendingTimeAllocation" UNION ALL ' +
            'SELECT count(*) FROM "CorrectionPendingTimeAllocationEvidence" UNION ALL ' +
            'SELECT count(*) FROM "CorrectionTimeSourceProof" UNION ALL ' +
            'SELECT count(*) FROM "CorrectionTimeAllocationBinding"',
        ).split('\n'),
      ).toEqual(['0', '0', '0', '0']);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);

  it('upgrades a nonempty 125-migration database without rewriting facts and installs a statement binding guard', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d7-2-binding-pre126-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, D7_2_FACT_MIGRATION_COUNT)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(D7_2_FACT_MIGRATION_COUNT);
      await seedLegacyFact();
      const before = snapshot();
      const oldChecksums = checksums();
      cpSync(
        path.join(root, 'migrations', BINDING_GUARD_MIGRATION),
        path.join(temporary, 'migrations', BINDING_GUARD_MIGRATION),
        { recursive: true, errorOnExist: true, force: false },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(BINDING_GUARD_MIGRATION_COUNT);
      expect(checksums().slice(0, D7_2_FACT_MIGRATION_COUNT)).toEqual(oldChecksums);
      expect(snapshot()).toEqual(before);
      expect(
        sql(
          "SELECT tgtype::integer::text || chr(9) || COALESCE(tgnewtable, '') " +
            'FROM pg_trigger ' +
            'WHERE tgrelid = \'"CorrectionTimeAllocationBinding"\'::regclass ' +
            "AND tgname = 'ctab_insert_guard'",
        ),
      ).toBe('4\tctab_new_rows');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);

  it('upgrades a nonempty 126-migration database without rewriting facts and installs a statement allocation guard', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d7-2-allocation-pre127-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, BINDING_GUARD_MIGRATION_COUNT)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(BINDING_GUARD_MIGRATION_COUNT);
      await seedLegacyFact();
      const before = snapshot();
      const oldChecksums = checksums();
      cpSync(
        path.join(root, 'migrations', ALLOCATION_GUARD_MIGRATION),
        path.join(temporary, 'migrations', ALLOCATION_GUARD_MIGRATION),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(ALLOCATION_GUARD_MIGRATION_COUNT);
      expect(checksums().slice(0, BINDING_GUARD_MIGRATION_COUNT)).toEqual(oldChecksums);
      expect(snapshot()).toEqual(before);
      expect(
        sql(
          "SELECT tgtype::integer::text || chr(9) || COALESCE(tgnewtable, '') " +
            'FROM pg_trigger ' +
            'WHERE tgrelid = \'"ParticipantTimeAllocationRevision"\'::regclass ' +
            "AND tgname = 'ptar_correction_insert_guard'",
        ),
      ).toBe('4\tptar_new_rows');
      expect(
        sql(
          'SELECT (tgqual IS NOT NULL)::text FROM pg_trigger ' +
            'WHERE tgrelid = \'"ParticipantTimeAllocationRevision"\'::regclass ' +
            "AND tgname = 'ptar_parent_anchor_guard'",
        ),
      ).toBe('true');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);

  it('upgrades a nonempty 127-migration database without rewriting facts and installs a statement correction receipt guard', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d7-2-receipt-pre128-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, ALLOCATION_GUARD_MIGRATION_COUNT)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(ALLOCATION_GUARD_MIGRATION_COUNT);
      await seedLegacyFact();
      const before = snapshot();
      const oldChecksums = checksums();
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(CORRECTION_RECEIPT_GUARD_MIGRATION_COUNT);
      expect(checksums().slice(0, ALLOCATION_GUARD_MIGRATION_COUNT)).toEqual(oldChecksums);
      expect(snapshot()).toEqual(before);
      expect(
        sql(
          "SELECT tgtype::integer::text || chr(9) || COALESCE(tgnewtable, '') " +
            'FROM pg_trigger ' +
            'WHERE tgrelid = \'"ParticipantTimeAllocationCommandReceipt"\'::regclass ' +
            "AND tgname = 'ptacr_correction_receipt_insert_guard'",
        ),
      ).toBe('4\tptacr_new_rows');
      expect(
        sql(
          'SELECT (tgqual IS NOT NULL)::text FROM pg_trigger ' +
            'WHERE tgrelid = \'"ParticipantTimeAllocationCommandReceipt"\'::regclass ' +
            "AND tgname = 'ptacr_receipt_guard'",
        ),
      ).toBe('true');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180000);
});
