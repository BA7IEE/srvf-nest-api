import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 85;
const MIGRATION_NAME = '20260812180000_activity_v11_batch4_allocation_determinism_guards';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const MIGRATION_84_COUNT = 84;
const MIGRATION_85_COUNT = 85;
// ⚠️ 与上面的 MIGRATION_<N>_COUNT 是**两件事**:那些是固定的历史世代基线(冷库重放的起点),
// 随仓库增长**永不变**;这个是仓库当前的 migration 总数,每加一刀就要 +1。
// 混改任何一个都会把冷库重放用例的语义整个改坏(issue #1055 T1 加第 91 刀时逐个复核过)。
const CURRENT_MIGRATION_COUNT = 95;
const COLD_REPLAY_TIMEOUT_MS = 300_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const ACCEPTED_AT = '2099-08-12 08:30:00';

interface Fixture {
  activityId: string;
  sessionId: string;
  memberId: string;
  memberId2: string;
  registrationId: string;
  registrationId2: string;
  registrationRevisionId: string;
  registrationRevisionId2: string;
  identityId: string;
  identityId2: string;
}

interface BatchOptions {
  modeCode?: string;
  statusCode?: string;
  candidateSnapshotHash?: string | null;
  algorithmVersionCode?: string | null;
  randomCommitment?: string | null;
  randomSeedReveal?: string | null;
  committedAt?: string | null;
}

interface CandidateOptions {
  allocationBatchId?: string;
  participationIdentityId?: string;
  registrationId?: string;
  registrationRevisionId?: string;
  acceptedAt?: string;
  qualificationSnapshotHash?: string;
  qualificationScore?: number | null;
  tieBreakKey?: string | null;
  lotteryOrder?: number | null;
  resultCode?: string | null;
  waitlistRank?: number | null;
  explanation?: string | null;
}

interface MutationCase {
  name: string;
  beginMarker: string;
  endMarker: string;
  setup: (fixture: Fixture) => string[];
  probes: (fixture: Fixture) => Array<{
    sql: string;
    sqlState: string;
    constraintOrKey: string;
  }>;
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullable(value: string | null): string {
  return value === null ? 'NULL' : sqlValue(value);
}

function sqlNumber(value: number | null): string {
  return value === null ? 'NULL' : String(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for allocation D85 migration E2E');
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing non-derived scratch database ${databaseName}`);
  }
  const parsed = new URL(source);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function runPsql(databaseName: string, sql: string): string {
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing psql against non-derived scratch database ${databaseName}`);
  }
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '--no-psqlrc',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function runPsqlFailure(databaseName: string, sql: string): string {
  if (databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID)) {
    throw new Error(`refusing psql against non-derived scratch database ${databaseName}`);
  }
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '--no-psqlrc',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    { input: `\\set VERBOSITY verbose\n${sql}`, encoding: 'utf8' },
  );
  expect(result.status).not.toBe(0);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function expectSqlFailure(
  databaseName: string,
  sql: string,
  sqlState: string,
  constraintOrKey: string,
): void {
  const failure = runPsqlFailure(databaseName, sql);
  expect(failure).toContain(sqlState);
  expect(failure).toContain(constraintOrKey);
}

function recreateEmptyScratchDatabase(): string {
  const databaseName = deriveWorkerTestDbName(SCRATCH_WORKER_ID);
  assertDroppableTestDbName(databaseName);
  dropWorkerDatabase(SCRATCH_WORKER_ID);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'createdb', '-U', 'postgres', databaseName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return databaseName;
}

function migrationNames(): string[] {
  return readdirSync(path.resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function deployMigrationsThrough84(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const names = migrationNames();
  const migration85Index = names.indexOf(MIGRATION_NAME);
  const baselineEnd = migration85Index === -1 ? names.length : migration85Index;
  if (baselineEnd !== MIGRATION_84_COUNT) {
    throw new Error(`expected an exact 84-migration baseline; got ${baselineEnd}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-allocation-d85-84-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const name of names.slice(0, baselineEnd)) {
      cpSync(path.join(sourceMigrationsRoot, name), path.join(temporaryMigrationsRoot, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', temporarySchemaPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(temporaryPrismaRoot, { recursive: true, force: true });
  }
}

function deployMigrationsThrough85(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const names = migrationNames();
  const migration85Index = names.indexOf(MIGRATION_NAME);
  const baselineEnd = migration85Index + 1;
  if (migration85Index < 0 || baselineEnd !== MIGRATION_85_COUNT) {
    throw new Error(`expected an exact 85-migration historical chain; got ${baselineEnd}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-allocation-d85-85-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const name of names.slice(0, baselineEnd)) {
      cpSync(path.join(sourceMigrationsRoot, name), path.join(temporaryMigrationsRoot, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', temporarySchemaPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(temporaryPrismaRoot, { recursive: true, force: true });
  }
}

function recreateMigration84Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough84(databaseName);
    if (successfulMigrationCount(databaseName) !== MIGRATION_84_COUNT) {
      throw new Error('failed to build a true 84-migration scratch database');
    }
  } catch (error) {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
    throw error;
  }
  return databaseName;
}

function deployCurrentMigrations(databaseName: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function successfulMigrationCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT COUNT(*) FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    ),
  );
}

function migrationSource(): string {
  return readFileSync(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
}

function removeMarkedBlock(source: string, beginMarker: string, endMarker: string): string {
  const start = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`expected migration marker pair ${beginMarker} / ${endMarker}`);
  }
  return `${source.slice(0, start)}${source.slice(end + endMarker.length)}`;
}

// issue #1048 T1:本 spec 会把**同一份夹具**灌进两种 schema 世代 ——
// `deployCurrentMigrations()` 建的当前库(`Member` 已是 realName / memberSinceDate /
// memberOriginCode)与 `deployMigrationsThrough{N}()` 建的历史回放库(那时还是 displayName)。
// 单一硬编码列名服务不了两者:写死新列名,历史回放库直接 42703「column does not exist」;
// 写死旧列名,当前库同样炸。故按目标库**实际存在的列**选,夹具自己适配世代。
function memberIdentityColumns(databaseName: string): {
  columns: string;
  values: (name: string) => string;
} {
  const hasRealName =
    runPsql(
      databaseName,
      `SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Member' AND column_name = 'realName';`,
    ).trim() === '1';
  return hasRealName
    ? {
        columns: '"realName","memberSinceDate","memberOriginCode"',
        values: (name: string) => `${sqlValue(name)},DATE '2020-01-01','manual'`,
      }
    : { columns: '"displayName"', values: (name: string) => sqlValue(name) };
}

function createFixture(databaseName: string, suffix: string): Fixture {
  const memberIdentity = memberIdentityColumns(databaseName);
  const fixture: Fixture = {
    activityId: `allocation-d85-activity-${suffix}`,
    sessionId: `allocation-d85-session-${suffix}`,
    memberId: `allocation-d85-member-${suffix}-1`,
    memberId2: `allocation-d85-member-${suffix}-2`,
    registrationId: `allocation-d85-registration-${suffix}-1`,
    registrationId2: `allocation-d85-registration-${suffix}-2`,
    registrationRevisionId: `allocation-d85-registration-revision-${suffix}-1`,
    registrationRevisionId2: `allocation-d85-registration-revision-${suffix}-2`,
    identityId: `allocation-d85-identity-${suffix}-1`,
    identityId2: `allocation-d85-identity-${suffix}-2`,
  };
  const organizationId = `allocation-d85-organization-${suffix}`;
  runPsql(
    databaseName,
    `INSERT INTO "Organization" ("id","name","nodeTypeCode","updatedAt") VALUES
       (${sqlValue(organizationId)},${sqlValue(`Allocation D85 ${suffix}`)},'team',CURRENT_TIMESTAMP);
     INSERT INTO "Activity"
       ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
     VALUES
       (${sqlValue(fixture.activityId)},${sqlValue(`Allocation D85 ${suffix}`)},'allocation-d85',
        ${sqlValue(organizationId)},TIMESTAMP '2099-08-12 08:00:00',
        TIMESTAMP '2099-08-12 18:00:00','test','draft',CURRENT_TIMESTAMP);
     INSERT INTO "Member" ("id","memberNo",${memberIdentity.columns},"updatedAt") VALUES
       (${sqlValue(fixture.memberId)},${sqlValue(`D85-${suffix}-1`)},${memberIdentity.values('D85 Member 1')},CURRENT_TIMESTAMP),
       (${sqlValue(fixture.memberId2)},${sqlValue(`D85-${suffix}-2`)},${memberIdentity.values('D85 Member 2')},CURRENT_TIMESTAMP);
     INSERT INTO "ActivitySession"
       ("id","updatedAt","activityId","code","name","startAt","endAt","locationText",
        "checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt",
        "locationRequired","locationPolicySourceCode","statusCode")
     VALUES
       (${sqlValue(fixture.sessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},'session',
        'Allocation D85 Session',TIMESTAMP '2099-08-12 09:00:00',TIMESTAMP '2099-08-12 17:00:00',
        'test',TIMESTAMP '2099-08-12 08:00:00',TIMESTAMP '2099-08-12 10:00:00',
        TIMESTAMP '2099-08-12 16:00:00',TIMESTAMP '2099-08-12 18:00:00',FALSE,'system','scheduled');
     INSERT INTO "ActivityRegistration"
       ("id","updatedAt","activityId","memberId","statusCode") VALUES
       (${sqlValue(fixture.registrationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.memberId)},'pending'),
       (${sqlValue(fixture.registrationId2)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.memberId2)},'pending');
     INSERT INTO "ActivityRegistrationRevision"
       ("id","registrationId","revision","sourceCode","submittedAt") VALUES
       (${sqlValue(fixture.registrationRevisionId)},${sqlValue(fixture.registrationId)},1,'self',
        TIMESTAMP '${ACCEPTED_AT}'),
       (${sqlValue(fixture.registrationRevisionId2)},${sqlValue(fixture.registrationId2)},1,'self',
        TIMESTAMP '${ACCEPTED_AT}');
     INSERT INTO "ActivityParticipationIdentity"
       ("id","updatedAt","activityId","sessionId","registrationId","memberId","currentStatusCode") VALUES
       (${sqlValue(fixture.identityId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationId)},${sqlValue(fixture.memberId)},'pending'),
       (${sqlValue(fixture.identityId2)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationId2)},${sqlValue(fixture.memberId2)},'pending');`,
  );
  return fixture;
}

function batchSql(
  fixture: Fixture,
  id: string,
  options: BatchOptions = {},
  includeD86VoidFacts = false,
): string {
  const modeCode = options.modeCode ?? 'first_come';
  const statusCode = options.statusCode ?? 'preparing';
  const candidateSnapshotHash = hasOwn(options, 'candidateSnapshotHash')
    ? (options.candidateSnapshotHash ?? null)
    : HASH_A;
  const algorithmVersionCode = hasOwn(options, 'algorithmVersionCode')
    ? (options.algorithmVersionCode ?? null)
    : 'allocation-v1';
  const randomCommitment = hasOwn(options, 'randomCommitment')
    ? (options.randomCommitment ?? null)
    : modeCode === 'lottery'
      ? HASH_B
      : null;
  const randomSeedReveal = hasOwn(options, 'randomSeedReveal')
    ? (options.randomSeedReveal ?? null)
    : modeCode === 'lottery' && statusCode === 'committed'
      ? HASH_C
      : null;
  const committedAt = hasOwn(options, 'committedAt')
    ? (options.committedAt ?? null)
    : statusCode === 'committed'
      ? '2099-08-12 18:00:00'
      : null;
  const currentVoidColumns = includeD86VoidFacts ? ',"voidReason","voidedAt"' : '';
  const currentVoidValues = includeD86VoidFacts
    ? `,${sqlNullable(statusCode === 'voided' ? 'allocation determinism test void' : null)},` +
      `${sqlNullable(statusCode === 'voided' ? '2099-08-12 18:00:00' : null)}`
    : '';
  return `INSERT INTO "ActivityAllocationBatch"
    ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
     "algorithmVersionCode","randomCommitment","randomSeedReveal","statusCode","operationKey","committedAt"${currentVoidColumns})
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},${sqlValue(fixture.sessionId)},
     ${sqlValue(modeCode)},${sqlNullable(candidateSnapshotHash)},${sqlNullable(algorithmVersionCode)},
     ${sqlNullable(randomCommitment)},${sqlNullable(randomSeedReveal)},${sqlValue(statusCode)},
     ${sqlValue(`operation-${id}`)},${sqlNullable(committedAt)}${currentVoidValues})`;
}

function candidateSql(fixture: Fixture, id: string, options: CandidateOptions = {}): string {
  const allocationBatchId = options.allocationBatchId ?? 'batch-main';
  const participationIdentityId = options.participationIdentityId ?? fixture.identityId;
  const registrationId = options.registrationId ?? fixture.registrationId;
  const registrationRevisionId = options.registrationRevisionId ?? fixture.registrationRevisionId;
  const acceptedAt = options.acceptedAt ?? ACCEPTED_AT;
  const qualificationSnapshotHash = options.qualificationSnapshotHash ?? HASH_D;
  const qualificationScore = hasOwn(options, 'qualificationScore')
    ? (options.qualificationScore ?? null)
    : null;
  const tieBreakKey = hasOwn(options, 'tieBreakKey') ? (options.tieBreakKey ?? null) : `tie-${id}`;
  const lotteryOrder = hasOwn(options, 'lotteryOrder') ? (options.lotteryOrder ?? null) : null;
  const resultCode = hasOwn(options, 'resultCode') ? (options.resultCode ?? null) : null;
  const waitlistRank = hasOwn(options, 'waitlistRank') ? (options.waitlistRank ?? null) : null;
  const explanation = hasOwn(options, 'explanation')
    ? (options.explanation ?? null)
    : '{"rules":[]}';
  return `INSERT INTO "ActivityAllocationCandidate"
    ("id","updatedAt","allocationBatchId","participationIdentityId","registrationId",
     "registrationRevisionId","acceptedAt","qualificationSnapshotHash","qualificationScore",
     "tieBreakKey","lotteryOrder","resultCode","waitlistRank","explanation")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(allocationBatchId)},
     ${sqlValue(participationIdentityId)},${sqlValue(registrationId)},
     ${sqlValue(registrationRevisionId)},TIMESTAMP ${sqlValue(acceptedAt)},
     ${sqlValue(qualificationSnapshotHash)},${sqlNumber(qualificationScore)},
     ${sqlNullable(tieBreakKey)},${sqlNumber(lotteryOrder)},${sqlNullable(resultCode)},
     ${sqlNumber(waitlistRank)},${explanation === null ? 'NULL' : `${sqlValue(explanation)}::jsonb`})`;
}

function d85Artifacts(databaseName: string): string[] {
  const raw = runPsql(
    databaseName,
    `SELECT artifact FROM (
       SELECT 'column:' || table_name || '.' || column_name AS artifact
       FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'ActivityAllocationBatch'
          AND column_name IN ('algorithmVersionCode','randomSeedReveal'))
         OR
         (table_name = 'ActivityAllocationCandidate'
          AND column_name IN ('registrationId','registrationRevisionId','acceptedAt','qualificationSnapshotHash'))
       )
       UNION ALL
       SELECT 'constraint:' || constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND constraint_name IN (
         'activity_participation_identity_id_registration_id_unique',
         'activity_allocation_candidate_identity_registration_fkey',
         'activity_allocation_candidate_registration_revision_fkey',
         'activity_allocation_batch_algorithm_version_code_check',
         'activity_allocation_batch_candidate_snapshot_hash_check',
         'activity_allocation_batch_lottery_seed_shape_check',
         'activity_allocation_batch_status_committed_at_check',
         'activity_allocation_candidate_qualification_snapshot_hash_check',
         'activity_allocation_candidate_qualification_score_range_check',
         'activity_allocation_candidate_lottery_order_one_based_check',
         'activity_allocation_candidate_waitlist_rank_one_based_check',
         'activity_allocation_candidate_result_rank_shape_check',
         'activity_allocation_candidate_tie_break_key_nonempty_check',
         'activity_allocation_candidate_explanation_object_check',
         'activity_allocation_candidate_batch_tie_break_key'
       )
       UNION ALL
       SELECT 'index:' || indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'activity_allocation_candidate_batch_lottery_order_unique',
         'activity_allocation_candidate_batch_waitlist_rank_unique',
         'activity_allocation_candidate_registration_revision_idx'
       )
     ) artifacts ORDER BY artifact`,
  );
  return raw === '' ? [] : raw.split('\n');
}

function oldCandidateForeignKey(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT conname FROM pg_constraint
     WHERE conrelid = '"ActivityAllocationCandidate"'::regclass
       AND conname = 'ActivityAllocationCandidate_participationIdentityId_fkey'`,
  );
}

function d85ArtifactCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT
        (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND (
           (table_name = 'ActivityAllocationBatch' AND column_name IN ('algorithmVersionCode','randomSeedReveal'))
           OR (table_name = 'ActivityAllocationCandidate'
               AND column_name IN ('registrationId','registrationRevisionId','acceptedAt','qualificationSnapshotHash'))
         ))
        +
        (SELECT COUNT(*) FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND constraint_name LIKE 'activity_allocation_%determinism_never_matches%')`,
    ),
  );
}

function allocationRows(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT json_build_object(
       'batches', (SELECT json_agg(to_jsonb(b) ORDER BY b.id) FROM "ActivityAllocationBatch" b),
       'candidates', (SELECT json_agg(to_jsonb(c) ORDER BY c.id) FROM "ActivityAllocationCandidate" c)
     )::text`,
  );
}

function allocationXmins(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT json_build_object(
       'batches', (SELECT json_agg(xmin::text ORDER BY id) FROM "ActivityAllocationBatch"),
       'candidates', (SELECT json_agg(xmin::text ORDER BY id) FROM "ActivityAllocationCandidate")
     )::text`,
  );
}

function insertLegacyAllocationRows(
  databaseName: string,
  fixture: Fixture,
  withCandidate: boolean,
): void {
  runPsql(
    databaseName,
    `INSERT INTO "ActivityAllocationBatch"
       ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
        "statusCode","operationKey")
     VALUES ('legacy-batch',CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
       ${sqlValue(fixture.sessionId)},'first_come','legacy-snapshot','preparing','legacy-operation');
     ${
       withCandidate
         ? `INSERT INTO "ActivityAllocationCandidate"
              ("id","updatedAt","allocationBatchId","participationIdentityId","tieBreakKey","explanation")
            VALUES ('legacy-candidate',CURRENT_TIMESTAMP,'legacy-batch',${sqlValue(fixture.identityId)},
              'legacy-tie','{}'::jsonb);`
         : ''
     }`,
  );
}

const mutationCases: MutationCase[] = [
  {
    name: 'identity + registration composite FK mutation',
    beginMarker: '-- allocation-d85:identity-registration-fk:begin',
    endMarker: '-- allocation-d85:identity-registration-fk:end',
    setup: (fixture) => [batchSql(fixture, 'batch-main')],
    probes: (fixture) => [
      {
        sql: candidateSql(fixture, 'candidate-wrong-identity-head', {
          registrationId: fixture.registrationId2,
          registrationRevisionId: fixture.registrationRevisionId2,
        }),
        sqlState: '23503',
        constraintOrKey: 'activity_allocation_candidate_identity_registration_fkey',
      },
    ],
  },
  {
    name: 'registration + revision composite FK mutation',
    beginMarker: '-- allocation-d85:registration-revision-fk:begin',
    endMarker: '-- allocation-d85:registration-revision-fk:end',
    setup: (fixture) => [batchSql(fixture, 'batch-main')],
    probes: (fixture) => [
      {
        sql: candidateSql(fixture, 'candidate-wrong-revision-head', {
          registrationRevisionId: fixture.registrationRevisionId2,
        }),
        sqlState: '23503',
        constraintOrKey: 'activity_allocation_candidate_registration_revision_fkey',
      },
    ],
  },
  {
    name: 'lottery seed shape mutation',
    beginMarker: '-- allocation-d85:lottery-seed-shape:begin',
    endMarker: '-- allocation-d85:lottery-seed-shape:end',
    setup: () => [],
    probes: (fixture) => [
      {
        sql: batchSql(fixture, 'batch-lottery-without-commitment', {
          modeCode: 'lottery',
          randomCommitment: null,
        }),
        sqlState: '23514',
        constraintOrKey: 'activity_allocation_batch_lottery_seed_shape_check',
      },
    ],
  },
  {
    name: 'lottery order and waitlist rank unique mutation',
    beginMarker: '-- allocation-d85:rank-order-unique:begin',
    endMarker: '-- allocation-d85:rank-order-unique:end',
    setup: (fixture) => [
      batchSql(fixture, 'batch-main', { modeCode: 'lottery' }),
      batchSql(fixture, 'batch-rank'),
      candidateSql(fixture, 'candidate-order-first', {
        lotteryOrder: 1,
      }),
      candidateSql(fixture, 'candidate-rank-first', {
        allocationBatchId: 'batch-rank',
        resultCode: 'waitlisted',
        waitlistRank: 1,
      }),
    ],
    probes: (fixture) => [
      {
        sql: candidateSql(fixture, 'candidate-order-second', {
          participationIdentityId: fixture.identityId2,
          registrationId: fixture.registrationId2,
          registrationRevisionId: fixture.registrationRevisionId2,
          lotteryOrder: 1,
        }),
        sqlState: '23505',
        constraintOrKey: 'activity_allocation_candidate_batch_lottery_order_unique',
      },
      {
        sql: candidateSql(fixture, 'candidate-rank-second', {
          allocationBatchId: 'batch-rank',
          participationIdentityId: fixture.identityId2,
          registrationId: fixture.registrationId2,
          registrationRevisionId: fixture.registrationRevisionId2,
          resultCode: 'waitlisted',
          waitlistRank: 1,
        }),
        sqlState: '23505',
        constraintOrKey: 'activity_allocation_candidate_batch_waitlist_rank_unique',
      },
    ],
  },
  {
    name: 'result and score shape mutation',
    beginMarker: '-- allocation-d85:result-score-shape:begin',
    endMarker: '-- allocation-d85:result-score-shape:end',
    setup: (fixture) => [batchSql(fixture, 'batch-main'), batchSql(fixture, 'batch-result')],
    probes: (fixture) => [
      {
        sql: candidateSql(fixture, 'candidate-score-overflow', { qualificationScore: 101 }),
        sqlState: '23514',
        constraintOrKey: 'activity_allocation_candidate_qualification_score_range_check',
      },
      {
        sql: candidateSql(fixture, 'candidate-result-without-rank', {
          allocationBatchId: 'batch-result',
          resultCode: 'waitlisted',
        }),
        sqlState: '23514',
        constraintOrKey: 'activity_allocation_candidate_result_rank_shape_check',
      },
    ],
  },
];

describe('Activity v1.1 batch4 allocation determinism migration', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });

  it('contains one strict atomic DDL transaction and exact Prisma composite relations', async () => {
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
    expect(executable).not.toContain('IF EXISTS');
    const lockOrder = [
      'LOCK TABLE "ActivityParticipationIdentity"',
      'LOCK TABLE "ActivityRegistrationRevision"',
      'LOCK TABLE "ActivityAllocationBatch"',
      'LOCK TABLE "ActivityAllocationCandidate"',
    ].map((needle) => migration.indexOf(needle));
    expect(lockOrder.every((offset) => offset >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b));

    const schema = await readFile(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain(
      '@relation(fields: [participationIdentityId, registrationId, activityId, sessionId], references: [id, registrationId, activityId, sessionId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_candidate_identity_registration_fkey")',
    );
    expect(schema).toContain(
      '@relation(fields: [registrationId, registrationRevisionId], references: [registrationId, id], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_candidate_registration_revision_fkey")',
    );
    expect(schema).toContain(
      '@@unique([id, registrationId], map: "activity_participation_identity_id_registration_id_unique")',
    );
  });

  it(
    'upgrades a true 84 database and installs the exact D85 columns, constraints and indexes',
    () => {
      const databaseName = recreateMigration84Scratch();
      try {
        expect(oldCandidateForeignKey(databaseName)).toBe(
          'ActivityAllocationCandidate_participationIdentityId_fkey',
        );
        deployMigrationsThrough85(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_85_COUNT);
        expect(oldCandidateForeignKey(databaseName)).toBe('');
        expect(d85Artifacts(databaseName)).toEqual([
          'column:ActivityAllocationBatch.algorithmVersionCode',
          'column:ActivityAllocationBatch.randomSeedReveal',
          'column:ActivityAllocationCandidate.acceptedAt',
          'column:ActivityAllocationCandidate.qualificationSnapshotHash',
          'column:ActivityAllocationCandidate.registrationId',
          'column:ActivityAllocationCandidate.registrationRevisionId',
          'constraint:activity_allocation_batch_algorithm_version_code_check',
          'constraint:activity_allocation_batch_candidate_snapshot_hash_check',
          'constraint:activity_allocation_batch_lottery_seed_shape_check',
          'constraint:activity_allocation_batch_status_committed_at_check',
          'constraint:activity_allocation_candidate_batch_tie_break_key',
          'constraint:activity_allocation_candidate_explanation_object_check',
          'constraint:activity_allocation_candidate_identity_registration_fkey',
          'constraint:activity_allocation_candidate_lottery_order_one_based_check',
          'constraint:activity_allocation_candidate_qualification_score_range_check',
          'constraint:activity_allocation_candidate_qualification_snapshot_hash_check',
          'constraint:activity_allocation_candidate_registration_revision_fkey',
          'constraint:activity_allocation_candidate_result_rank_shape_check',
          'constraint:activity_allocation_candidate_tie_break_key_nonempty_check',
          'constraint:activity_allocation_candidate_waitlist_rank_one_based_check',
          'constraint:activity_participation_identity_id_registration_id_unique',
          'index:activity_allocation_candidate_batch_lottery_order_unique',
          'index:activity_allocation_candidate_batch_waitlist_rank_unique',
          'index:activity_allocation_candidate_registration_revision_idx',
        ]);
        const columns = JSON.parse(
          runPsql(
            databaseName,
            `SELECT json_agg(json_build_object(
               'table', table_name, 'column', column_name, 'nullable', is_nullable,
               'default', column_default
             ) ORDER BY table_name,column_name)::text
             FROM information_schema.columns WHERE table_schema='public' AND (
               (table_name='ActivityAllocationBatch' AND column_name IN ('algorithmVersionCode','randomSeedReveal'))
               OR (table_name='ActivityAllocationCandidate'
                   AND column_name IN ('registrationId','registrationRevisionId','acceptedAt',
                                       'qualificationSnapshotHash','explanation'))
             )`,
          ),
        ) as unknown[];
        expect(columns).toEqual([
          {
            table: 'ActivityAllocationBatch',
            column: 'algorithmVersionCode',
            nullable: 'NO',
            default: null,
          },
          {
            table: 'ActivityAllocationBatch',
            column: 'randomSeedReveal',
            nullable: 'YES',
            default: null,
          },
          {
            table: 'ActivityAllocationCandidate',
            column: 'acceptedAt',
            nullable: 'NO',
            default: null,
          },
          {
            table: 'ActivityAllocationCandidate',
            column: 'explanation',
            nullable: 'NO',
            default: null,
          },
          {
            table: 'ActivityAllocationCandidate',
            column: 'qualificationSnapshotHash',
            nullable: 'NO',
            default: null,
          },
          {
            table: 'ActivityAllocationCandidate',
            column: 'registrationId',
            nullable: 'NO',
            default: null,
          },
          {
            table: 'ActivityAllocationCandidate',
            column: 'registrationRevisionId',
            nullable: 'NO',
            default: null,
          },
        ]);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    `replays all current ${CURRENT_MIGRATION_COUNT} migrations from empty and enforces batch hashes, versions and seed lifecycle`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        const fixture = createFixture(databaseName, 'batch-shapes');
        runPsql(databaseName, batchSql(fixture, 'batch-first'));
        runPsql(
          databaseName,
          batchSql(fixture, 'batch-rank', {
            modeCode: 'qualification_rank',
            statusCode: 'committed',
          }),
        );
        runPsql(
          databaseName,
          batchSql(fixture, 'batch-lottery-preparing', { modeCode: 'lottery' }),
        );
        runPsql(
          databaseName,
          batchSql(fixture, 'batch-lottery-committed', {
            modeCode: 'lottery',
            statusCode: 'committed',
          }),
        );
        runPsql(
          databaseName,
          batchSql(
            fixture,
            'batch-lottery-voided-before-commit',
            {
              modeCode: 'lottery',
              statusCode: 'voided',
            },
            true,
          ),
        );
        runPsql(
          databaseName,
          batchSql(
            fixture,
            'batch-lottery-voided-after-commit',
            {
              modeCode: 'lottery',
              statusCode: 'voided',
              randomSeedReveal: HASH_C,
              committedAt: '2099-08-12 18:00:00',
            },
            true,
          ),
        );

        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-version-empty', { algorithmVersionCode: '' }),
          '23514',
          'activity_allocation_batch_algorithm_version_code_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-version-long', { algorithmVersionCode: 'v'.repeat(65) }),
          '23514',
          'activity_allocation_batch_algorithm_version_code_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-snapshot-hash', { candidateSnapshotHash: HASH_A.toUpperCase() }),
          '23514',
          'activity_allocation_batch_candidate_snapshot_hash_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-lottery-commitment', {
            modeCode: 'lottery',
            randomCommitment: null,
          }),
          '23514',
          'activity_allocation_batch_lottery_seed_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-lottery-early-reveal', {
            modeCode: 'lottery',
            randomSeedReveal: HASH_C,
          }),
          '23514',
          'activity_allocation_batch_lottery_seed_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-lottery-missing-reveal', {
            modeCode: 'lottery',
            statusCode: 'committed',
            randomSeedReveal: null,
          }),
          '23514',
          'activity_allocation_batch_lottery_seed_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-non-lottery-seed', { randomCommitment: HASH_B }),
          '23514',
          'activity_allocation_batch_lottery_seed_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-preparing-commit-time', {
            committedAt: '2099-08-12 18:00:00',
          }),
          '23514',
          'activity_allocation_batch_status_committed_at_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'bad-committed-without-time', {
            statusCode: 'committed',
            committedAt: null,
          }),
          '23514',
          'activity_allocation_batch_committed_shape_check',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'enforces candidate same-head anchors, exact hashes, scores, result shape and stable unique orders',
    () => {
      const databaseName = recreateMigration84Scratch();
      try {
        deployMigrationsThrough85(databaseName);
        const fixture = createFixture(databaseName, 'candidate-shapes');
        runPsql(databaseName, batchSql(fixture, 'batch-main', { modeCode: 'lottery' }));
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-allocated', {
            qualificationScore: 100,
            lotteryOrder: 1,
            resultCode: 'allocated',
          }),
        );
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-waitlisted', {
            participationIdentityId: fixture.identityId2,
            registrationId: fixture.registrationId2,
            registrationRevisionId: fixture.registrationRevisionId2,
            qualificationScore: 0,
            lotteryOrder: 2,
            resultCode: 'waitlisted',
            waitlistRank: 1,
          }),
        );

        const newBatch = (id: string) => runPsql(databaseName, batchSql(fixture, id));
        newBatch('batch-wrong-identity-head');
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'bad-identity-head', {
            allocationBatchId: 'batch-wrong-identity-head',
            registrationId: fixture.registrationId2,
            registrationRevisionId: fixture.registrationRevisionId2,
          }),
          '23503',
          'activity_allocation_candidate_identity_registration_fkey',
        );
        newBatch('batch-wrong-revision-head');
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'bad-revision-head', {
            allocationBatchId: 'batch-wrong-revision-head',
            registrationRevisionId: fixture.registrationRevisionId2,
          }),
          '23503',
          'activity_allocation_candidate_registration_revision_fkey',
        );

        const candidateCheck = (
          label: string,
          options: CandidateOptions,
          constraint: string,
        ): void => {
          const batchId = `batch-${label}`;
          newBatch(batchId);
          expectSqlFailure(
            databaseName,
            candidateSql(fixture, `candidate-${label}`, { allocationBatchId: batchId, ...options }),
            '23514',
            constraint,
          );
        };
        candidateCheck(
          'hash-uppercase',
          { qualificationSnapshotHash: HASH_D.toUpperCase() },
          'activity_allocation_candidate_qualification_snapshot_hash_check',
        );
        candidateCheck(
          'score-low',
          { qualificationScore: -0.0001 },
          'activity_allocation_candidate_qualification_score_range_check',
        );
        candidateCheck(
          'score-high',
          { qualificationScore: 100.0001 },
          'activity_allocation_candidate_qualification_score_range_check',
        );
        candidateCheck(
          'lottery-order-zero',
          { lotteryOrder: 0 },
          'activity_allocation_candidate_lottery_order_one_based_check',
        );
        candidateCheck(
          'waitlist-rank-zero',
          { resultCode: 'waitlisted', waitlistRank: 0 },
          'activity_allocation_candidate_waitlist_rank_one_based_check',
        );
        candidateCheck(
          'waitlisted-without-rank',
          { resultCode: 'waitlisted' },
          'activity_allocation_candidate_result_rank_shape_check',
        );
        candidateCheck(
          'allocated-with-rank',
          { resultCode: 'allocated', waitlistRank: 1 },
          'activity_allocation_candidate_result_rank_shape_check',
        );
        candidateCheck(
          'empty-tie',
          { tieBreakKey: '' },
          'activity_allocation_candidate_tie_break_key_nonempty_check',
        );
        candidateCheck(
          'array-explanation',
          { explanation: '[]' },
          'activity_allocation_candidate_explanation_object_check',
        );

        newBatch('batch-tie-unique');
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-tie-first', {
            allocationBatchId: 'batch-tie-unique',
            tieBreakKey: 'same-tie',
          }),
        );
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-tie-second', {
            allocationBatchId: 'batch-tie-unique',
            participationIdentityId: fixture.identityId2,
            registrationId: fixture.registrationId2,
            registrationRevisionId: fixture.registrationRevisionId2,
            tieBreakKey: 'same-tie',
          }),
          '23505',
          'activity_allocation_candidate_batch_tie_break_key',
        );

        runPsql(databaseName, batchSql(fixture, 'batch-order-unique', { modeCode: 'lottery' }));
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-order-first', {
            allocationBatchId: 'batch-order-unique',
            lotteryOrder: 1,
          }),
        );
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-order-second', {
            allocationBatchId: 'batch-order-unique',
            participationIdentityId: fixture.identityId2,
            registrationId: fixture.registrationId2,
            registrationRevisionId: fixture.registrationRevisionId2,
            lotteryOrder: 1,
          }),
          '23505',
          'activity_allocation_candidate_batch_lottery_order_unique',
        );

        newBatch('batch-rank-unique');
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-rank-first', {
            allocationBatchId: 'batch-rank-unique',
            resultCode: 'waitlisted',
            waitlistRank: 1,
          }),
        );
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-rank-second', {
            allocationBatchId: 'batch-rank-unique',
            participationIdentityId: fixture.identityId2,
            registrationId: fixture.registrationId2,
            registrationRevisionId: fixture.registrationRevisionId2,
            resultCode: 'waitlisted',
            waitlistRank: 1,
          }),
          '23505',
          'activity_allocation_candidate_batch_waitlist_rank_unique',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it.each([
    ['one legacy batch', false, 'batches=1, candidates=0'],
    ['one legacy batch plus candidate', true, 'batches=1, candidates=1'],
  ] as const)(
    'fails atomically on %s instead of guessing a D85 backfill',
    (_label, withCandidate, expectedCounts) => {
      const databaseName = recreateMigration84Scratch();
      try {
        const fixture = createFixture(
          databaseName,
          `nonempty-${withCandidate ? 'candidate' : 'batch'}`,
        );
        insertLegacyAllocationRows(databaseName, fixture, withCandidate);
        const rowsBefore = allocationRows(databaseName);
        const xminsBefore = allocationXmins(databaseName);
        const failure = runPsqlFailure(databaseName, migrationSource());
        expect(failure).toContain('23514');
        expect(failure).toContain(expectedCounts);
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_84_COUNT);
        expect(d85ArtifactCount(databaseName)).toBe(0);
        expect(oldCandidateForeignKey(databaseName)).toBe(
          'ActivityAllocationCandidate_participationIdentityId_fkey',
        );
        expect(allocationRows(databaseName)).toBe(rowsBefore);
        expect(allocationXmins(databaseName)).toBe(xminsBefore);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'rolls back every D85 artifact and restores the old FK when the final DDL step fails',
    () => {
      const databaseName = recreateMigration84Scratch();
      try {
        const source = migrationSource();
        const failing = source.replace(
          /\nCOMMIT;\s*$/,
          `\nDO $allocation_d85_late_failure$\nBEGIN\n  RAISE EXCEPTION 'allocation D85 late failure';\nEND\n$allocation_d85_late_failure$;\n\nCOMMIT;\n`,
        );
        expect(failing).not.toBe(source);
        const failure = runPsqlFailure(databaseName, failing);
        expect(failure).toContain('allocation D85 late failure');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_84_COUNT);
        expect(d85ArtifactCount(databaseName)).toBe(0);
        expect(oldCandidateForeignKey(databaseName)).toBe(
          'ActivityAllocationCandidate_participationIdentityId_fkey',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it.each(mutationCases)(
    '$name first rejects every control probe and then turns only that probe green',
    ({ beginMarker, endMarker, setup, probes }) => {
      let databaseName = recreateMigration84Scratch();
      try {
        runPsql(databaseName, migrationSource());
        let fixture = createFixture(databaseName, 'mutation-control');
        for (const sql of setup(fixture)) runPsql(databaseName, sql);
        for (const probe of probes(fixture)) {
          expectSqlFailure(databaseName, probe.sql, probe.sqlState, probe.constraintOrKey);
        }

        databaseName = recreateMigration84Scratch();
        const mutated = removeMarkedBlock(migrationSource(), beginMarker, endMarker);
        expect(mutated).not.toBe(migrationSource());
        runPsql(databaseName, mutated);
        fixture = createFixture(databaseName, 'mutation-mutated');
        for (const sql of setup(fixture)) runPsql(databaseName, sql);
        for (const probe of probes(fixture)) runPsql(databaseName, probe.sql);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );
});
