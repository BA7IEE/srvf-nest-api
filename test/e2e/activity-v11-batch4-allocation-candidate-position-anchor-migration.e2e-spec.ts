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
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 88;
const MIGRATION_NAME = '20260813150000_activity_v11_batch4_allocation_candidate_position_anchor';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const MIGRATION_86_COUNT = 86;
// ⚠️ 与上面的 MIGRATION_<N>_COUNT 是**两件事**:那些是固定的历史世代基线(冷库重放的起点),
// 随仓库增长**永不变**;这个是仓库当前的 migration 总数,每加一刀就要 +1。
// 混改任何一个都会把冷库重放用例的语义整个改坏(issue #1055 T1 加第 91 刀时逐个复核过)。
const CURRENT_MIGRATION_COUNT = 110;
const COLD_REPLAY_TIMEOUT_MS = 300_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const ACCEPTED_AT = '2099-08-13 08:30:00';

interface Fixture {
  activityId: string;
  otherActivityId: string;
  sessionId: string;
  otherSessionId: string;
  otherActivitySessionId: string;
  positionAId: string;
  positionBId: string;
  otherSessionPositionId: string;
  otherActivityPositionId: string;
  memberIds: [string, string, string];
  registrationIds: [string, string, string];
  registrationRevisionIds: [string, string, string];
  identityIds: [string, string, string];
}

interface BatchOptions {
  activityId?: string;
  sessionId?: string;
  modeCode?: 'first_come' | 'lottery';
  statusCode?: 'preparing' | 'committed';
}

interface CandidateOptions {
  allocationBatchId: string;
  identitySlot?: 0 | 1 | 2;
  activityId?: string;
  sessionId?: string;
  waitlistPositionId?: string | null;
  tieBreakKey?: string;
  lotteryOrder?: number | null;
  resultCode?: 'allocated' | 'waitlisted' | 'not_selected' | null;
  waitlistRank?: number | null;
}

interface MutationCase {
  name: string;
  beginMarker: string;
  endMarker: string;
  setup: (databaseName: string, fixture: Fixture) => void;
  proveCorrect: (databaseName: string, fixture: Fixture) => void;
  proveMutated: (databaseName: string, fixture: Fixture) => void;
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
  if (!source) throw new Error('DATABASE_URL is required for allocation D87 migration E2E');
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

function deployMigrationsThrough86(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const names = migrationNames();
  const migration87Index = names.indexOf(MIGRATION_NAME);
  const baselineEnd = migration87Index === -1 ? names.length : migration87Index;
  if (baselineEnd !== MIGRATION_86_COUNT) {
    throw new Error(`expected an exact 86-migration baseline; got ${baselineEnd}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-allocation-d87-86-'));
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

function recreateMigration86Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough86(databaseName);
    if (successfulMigrationCount(databaseName) !== MIGRATION_86_COUNT) {
      throw new Error('failed to build a true 86-migration scratch database');
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
    activityId: `allocation-d87-activity-${suffix}`,
    otherActivityId: `allocation-d87-other-activity-${suffix}`,
    sessionId: `allocation-d87-session-${suffix}`,
    otherSessionId: `allocation-d87-other-session-${suffix}`,
    otherActivitySessionId: `allocation-d87-other-activity-session-${suffix}`,
    positionAId: `allocation-d87-position-a-${suffix}`,
    positionBId: `allocation-d87-position-b-${suffix}`,
    otherSessionPositionId: `allocation-d87-position-other-session-${suffix}`,
    otherActivityPositionId: `allocation-d87-position-other-activity-${suffix}`,
    memberIds: [0, 1, 2].map((index) => `allocation-d87-member-${suffix}-${index}`) as [
      string,
      string,
      string,
    ],
    registrationIds: [0, 1, 2].map((index) => `allocation-d87-registration-${suffix}-${index}`) as [
      string,
      string,
      string,
    ],
    registrationRevisionIds: [0, 1, 2].map(
      (index) => `allocation-d87-registration-revision-${suffix}-${index}`,
    ) as [string, string, string],
    identityIds: [0, 1, 2].map((index) => `allocation-d87-identity-${suffix}-${index}`) as [
      string,
      string,
      string,
    ],
  };
  const organizationId = `allocation-d87-organization-${suffix}`;
  runPsql(
    databaseName,
    `INSERT INTO "Organization" ("id","name","nodeTypeCode","updatedAt") VALUES
       (${sqlValue(organizationId)},${sqlValue(`Allocation D87 ${suffix}`)},'team',CURRENT_TIMESTAMP);
     INSERT INTO "Activity"
       ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
     VALUES
       (${sqlValue(fixture.activityId)},${sqlValue(`Allocation D87 ${suffix}`)},'allocation-d87',
        ${sqlValue(organizationId)},TIMESTAMP '2099-08-13 08:00:00',
        TIMESTAMP '2099-08-13 18:00:00','test','draft',CURRENT_TIMESTAMP),
       (${sqlValue(fixture.otherActivityId)},${sqlValue(`Allocation D87 other ${suffix}`)},'allocation-d87',
        ${sqlValue(organizationId)},TIMESTAMP '2099-08-14 08:00:00',
        TIMESTAMP '2099-08-14 18:00:00','test','draft',CURRENT_TIMESTAMP);
     INSERT INTO "Member" ("id","memberNo",${memberIdentity.columns},"updatedAt") VALUES
       (${sqlValue(fixture.memberIds[0])},${sqlValue(`D87-${suffix}-0`)},${memberIdentity.values('D87 Member 0')},CURRENT_TIMESTAMP),
       (${sqlValue(fixture.memberIds[1])},${sqlValue(`D87-${suffix}-1`)},${memberIdentity.values('D87 Member 1')},CURRENT_TIMESTAMP),
       (${sqlValue(fixture.memberIds[2])},${sqlValue(`D87-${suffix}-2`)},${memberIdentity.values('D87 Member 2')},CURRENT_TIMESTAMP);
     INSERT INTO "ActivitySession"
       ("id","updatedAt","activityId","code","name","startAt","endAt","locationText",
        "checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt",
        "locationRequired","locationPolicySourceCode","statusCode")
     VALUES
       (${sqlValue(fixture.sessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},'session',
        'Allocation D87 Session',TIMESTAMP '2099-08-13 09:00:00',TIMESTAMP '2099-08-13 17:00:00',
        'test',TIMESTAMP '2099-08-13 08:00:00',TIMESTAMP '2099-08-13 10:00:00',
        TIMESTAMP '2099-08-13 16:00:00',TIMESTAMP '2099-08-13 18:00:00',FALSE,'system','scheduled'),
       (${sqlValue(fixture.otherSessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},'session-2',
        'Allocation D87 Other Session',TIMESTAMP '2099-08-13 09:00:00',TIMESTAMP '2099-08-13 17:00:00',
        'test',TIMESTAMP '2099-08-13 08:00:00',TIMESTAMP '2099-08-13 10:00:00',
        TIMESTAMP '2099-08-13 16:00:00',TIMESTAMP '2099-08-13 18:00:00',FALSE,'system','scheduled'),
       (${sqlValue(fixture.otherActivitySessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.otherActivityId)},'session',
        'Allocation D87 Other Activity Session',TIMESTAMP '2099-08-14 09:00:00',TIMESTAMP '2099-08-14 17:00:00',
        'test',TIMESTAMP '2099-08-14 08:00:00',TIMESTAMP '2099-08-14 10:00:00',
        TIMESTAMP '2099-08-14 16:00:00',TIMESTAMP '2099-08-14 18:00:00',FALSE,'system','scheduled');
     INSERT INTO "ActivitySessionPosition"
       ("id","updatedAt","activityId","sessionId","code","name","attendanceRoleCode","capacity")
     VALUES
       (${sqlValue(fixture.positionAId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},'position-a','Allocation D87 Position A','volunteer',8),
       (${sqlValue(fixture.positionBId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},'position-b','Allocation D87 Position B','volunteer',8),
       (${sqlValue(fixture.otherSessionPositionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.otherSessionId)},'position-other-session','Allocation D87 Other Session Position','volunteer',8),
       (${sqlValue(fixture.otherActivityPositionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.otherActivityId)},
        ${sqlValue(fixture.otherActivitySessionId)},'position-other-activity','Allocation D87 Other Activity Position','volunteer',8);
     INSERT INTO "ActivityRegistration"
       ("id","updatedAt","activityId","memberId","statusCode") VALUES
       (${sqlValue(fixture.registrationIds[0])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.memberIds[0])},'pending'),
       (${sqlValue(fixture.registrationIds[1])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.memberIds[1])},'pending'),
       (${sqlValue(fixture.registrationIds[2])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.memberIds[2])},'pending');
     INSERT INTO "ActivityRegistrationRevision"
       ("id","registrationId","revision","sourceCode","submittedAt") VALUES
       (${sqlValue(fixture.registrationRevisionIds[0])},${sqlValue(fixture.registrationIds[0])},1,'self',TIMESTAMP '${ACCEPTED_AT}'),
       (${sqlValue(fixture.registrationRevisionIds[1])},${sqlValue(fixture.registrationIds[1])},1,'self',TIMESTAMP '${ACCEPTED_AT}'),
       (${sqlValue(fixture.registrationRevisionIds[2])},${sqlValue(fixture.registrationIds[2])},1,'self',TIMESTAMP '${ACCEPTED_AT}');
     INSERT INTO "ActivityParticipationIdentity"
       ("id","updatedAt","activityId","sessionId","registrationId","memberId","currentStatusCode") VALUES
       (${sqlValue(fixture.identityIds[0])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationIds[0])},${sqlValue(fixture.memberIds[0])},'pending'),
       (${sqlValue(fixture.identityIds[1])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationIds[1])},${sqlValue(fixture.memberIds[1])},'pending'),
       (${sqlValue(fixture.identityIds[2])},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationIds[2])},${sqlValue(fixture.memberIds[2])},'pending');`,
  );
  return fixture;
}

function batchSql(fixture: Fixture, id: string, options: BatchOptions = {}): string {
  const modeCode = options.modeCode ?? 'first_come';
  const statusCode = options.statusCode ?? 'preparing';
  return `INSERT INTO "ActivityAllocationBatch"
    ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
     "algorithmVersionCode","randomCommitment","randomSeedReveal","statusCode","operationKey","committedAt")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(options.activityId ?? fixture.activityId)},
     ${sqlValue(options.sessionId ?? fixture.sessionId)},${sqlValue(modeCode)},${sqlValue(HASH_A)},
     'allocation-v1',${sqlNullable(modeCode === 'lottery' ? HASH_B : null)},
     ${sqlNullable(modeCode === 'lottery' && statusCode === 'committed' ? HASH_C : null)},
     ${sqlValue(statusCode)},${sqlValue(`operation-${id}`)},
     ${sqlNullable(statusCode === 'committed' ? '2099-08-13 18:00:00' : null)})`;
}

function legacyCandidateSql(fixture: Fixture, id: string, allocationBatchId: string): string {
  return `INSERT INTO "ActivityAllocationCandidate"
    ("id","updatedAt","allocationBatchId","participationIdentityId","registrationId",
     "registrationRevisionId","acceptedAt","qualificationSnapshotHash","tieBreakKey","explanation")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(allocationBatchId)},${sqlValue(fixture.identityIds[0])},
     ${sqlValue(fixture.registrationIds[0])},${sqlValue(fixture.registrationRevisionIds[0])},
     TIMESTAMP '${ACCEPTED_AT}',${sqlValue(HASH_C)},${sqlValue(`tie-${id}`)},'{}'::jsonb)`;
}

function candidateSql(fixture: Fixture, id: string, options: CandidateOptions): string {
  const slot = options.identitySlot ?? 0;
  const resultCode = hasOwn(options, 'resultCode') ? (options.resultCode ?? null) : null;
  const waitlistRank = hasOwn(options, 'waitlistRank')
    ? (options.waitlistRank ?? null)
    : resultCode === 'waitlisted'
      ? 1
      : null;
  const waitlistPositionId = hasOwn(options, 'waitlistPositionId')
    ? (options.waitlistPositionId ?? null)
    : resultCode === 'waitlisted'
      ? fixture.positionAId
      : null;
  const lotteryOrder = hasOwn(options, 'lotteryOrder') ? (options.lotteryOrder ?? null) : null;
  return `INSERT INTO "ActivityAllocationCandidate"
    ("id","updatedAt","allocationBatchId","activityId","sessionId","waitlistPositionId",
     "participationIdentityId","registrationId","registrationRevisionId","acceptedAt",
     "qualificationSnapshotHash","tieBreakKey","lotteryOrder","resultCode","waitlistRank","explanation")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(options.allocationBatchId)},
     ${sqlValue(options.activityId ?? fixture.activityId)},${sqlValue(options.sessionId ?? fixture.sessionId)},
     ${sqlNullable(waitlistPositionId)},${sqlValue(fixture.identityIds[slot])},
     ${sqlValue(fixture.registrationIds[slot])},${sqlValue(fixture.registrationRevisionIds[slot])},
     TIMESTAMP '${ACCEPTED_AT}',${sqlValue(HASH_C)},${sqlValue(options.tieBreakKey ?? `tie-${id}`)},
     ${sqlNumber(lotteryOrder)},${sqlNullable(resultCode)},${sqlNumber(waitlistRank)},'{}'::jsonb)`;
}

function d87ArtifactCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT
        (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ActivityAllocationCandidate'
           AND column_name IN ('activityId','sessionId','waitlistPositionId')) +
        (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = '"ActivityAllocationCandidate"'::regclass
           AND conname IN (
             'activity_allocation_candidate_batch_anchor_fkey',
             'activity_allocation_candidate_waitlist_position_fkey'
           )) +
        (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
           'activity_allocation_candidate_batch_position_rank_unique',
           'activity_allocation_candidate_batch_position_rank_idx'
         ))`,
    ),
  );
}

function legacyArtifactSnapshot(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT string_agg(name, ',' ORDER BY name) FROM (
       SELECT conname AS name FROM pg_constraint
       WHERE conrelid = '"ActivityAllocationCandidate"'::regclass
         AND conname IN (
           'ActivityAllocationCandidate_allocationBatchId_fkey',
           'activity_allocation_candidate_result_rank_shape_check'
         )
       UNION ALL
       SELECT indexname AS name FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'activity_allocation_candidate_batch_waitlist_rank_unique',
         'activity_allocation_candidate_batch_rank_idx'
       )
     ) legacy`,
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

function assertCurrentArtifacts(databaseName: string): void {
  expect(
    runPsql(
      databaseName,
      `SELECT column_name || ':' || is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ActivityAllocationCandidate'
         AND column_name IN ('activityId','sessionId','waitlistPositionId')
       ORDER BY column_name`,
    ),
  ).toBe('activityId:NO\nsessionId:NO\nwaitlistPositionId:YES');
  expect(
    runPsql(
      databaseName,
      `SELECT conname || ':' || pg_get_constraintdef(oid)
       FROM pg_constraint
       WHERE conrelid = '"ActivityAllocationCandidate"'::regclass
         AND conname IN (
           'activity_allocation_candidate_batch_anchor_fkey',
           'activity_allocation_candidate_waitlist_position_fkey'
         )
       ORDER BY conname`,
    ),
  ).toBe(
    'activity_allocation_candidate_batch_anchor_fkey:FOREIGN KEY ("allocationBatchId", "activityId", "sessionId") REFERENCES "ActivityAllocationBatch"(id, "activityId", "sessionId") ON UPDATE RESTRICT ON DELETE RESTRICT\n' +
      'activity_allocation_candidate_waitlist_position_fkey:FOREIGN KEY ("activityId", "sessionId", "waitlistPositionId") REFERENCES "ActivitySessionPosition"("activityId", "sessionId", id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  );
  expect(
    runPsql(
      databaseName,
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"ActivityAllocationCandidate"'::regclass
         AND conname = 'ActivityAllocationCandidate_allocationBatchId_fkey'`,
    ),
  ).toBe('');
  expect(
    runPsql(
      databaseName,
      `SELECT indexname || ':' || indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'activity_allocation_candidate_batch_position_rank_unique',
         'activity_allocation_candidate_batch_position_rank_idx'
       ) ORDER BY indexname`,
    ),
  ).toBe(
    'activity_allocation_candidate_batch_position_rank_idx:CREATE INDEX activity_allocation_candidate_batch_position_rank_idx ON public."ActivityAllocationCandidate" USING btree ("allocationBatchId", "waitlistPositionId", "waitlistRank")\n' +
      'activity_allocation_candidate_batch_position_rank_unique:CREATE UNIQUE INDEX activity_allocation_candidate_batch_position_rank_unique ON public."ActivityAllocationCandidate" USING btree ("allocationBatchId", "waitlistPositionId", "waitlistRank") WHERE ("waitlistRank" IS NOT NULL)',
  );
  expect(
    runPsql(
      databaseName,
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
         'activity_allocation_candidate_batch_waitlist_rank_unique',
         'activity_allocation_candidate_batch_rank_idx'
       )`,
    ),
  ).toBe('');
  expect(d87ArtifactCount(databaseName)).toBe(7);
}

const mutationCases: MutationCase[] = [
  {
    name: 'old global waitlist unique mutation',
    beginMarker: '-- allocation-d87:old-global-waitlist-unique-drop:begin',
    endMarker: '-- allocation-d87:old-global-waitlist-unique-drop:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-mutation-global-unique'));
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-global-unique-a', {
          allocationBatchId: 'batch-mutation-global-unique',
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: fixture.positionAId,
        }),
      );
    },
    proveCorrect: (databaseName, fixture) => {
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-global-unique-b', {
          allocationBatchId: 'batch-mutation-global-unique',
          identitySlot: 1,
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: fixture.positionBId,
        }),
      );
    },
    proveMutated: (databaseName, fixture) => {
      expectSqlFailure(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-global-unique-b', {
          allocationBatchId: 'batch-mutation-global-unique',
          identitySlot: 1,
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: fixture.positionBId,
        }),
        '23505',
        'activity_allocation_candidate_batch_waitlist_rank_unique',
      );
    },
  },
  {
    name: 'waitlist position composite FK mutation',
    beginMarker: '-- allocation-d87:position-anchor:begin',
    endMarker: '-- allocation-d87:position-anchor:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-mutation-position-anchor'));
    },
    proveCorrect: (databaseName, fixture) => {
      expectSqlFailure(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-position-anchor', {
          allocationBatchId: 'batch-mutation-position-anchor',
          resultCode: 'waitlisted',
          waitlistPositionId: fixture.otherSessionPositionId,
        }),
        '23503',
        'activity_allocation_candidate_waitlist_position_fkey',
      );
    },
    proveMutated: (databaseName, fixture) => {
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-position-anchor', {
          allocationBatchId: 'batch-mutation-position-anchor',
          resultCode: 'waitlisted',
          waitlistPositionId: fixture.otherSessionPositionId,
        }),
      );
    },
  },
  {
    name: 'result closure mutation',
    beginMarker: '-- allocation-d87:result-shape:begin',
    endMarker: '-- allocation-d87:result-shape:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-mutation-result-shape'));
    },
    proveCorrect: (databaseName, fixture) => {
      expectSqlFailure(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-result-shape', {
          allocationBatchId: 'batch-mutation-result-shape',
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: null,
        }),
        '23514',
        'activity_allocation_candidate_result_rank_shape_check',
      );
    },
    proveMutated: (databaseName, fixture) => {
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-result-shape', {
          allocationBatchId: 'batch-mutation-result-shape',
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: null,
        }),
      );
    },
  },
  {
    name: 'candidate batch composite anchor mutation',
    beginMarker: '-- allocation-d87:batch-anchor:begin',
    endMarker: '-- allocation-d87:batch-anchor:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-mutation-batch-anchor'));
    },
    proveCorrect: (databaseName, fixture) => {
      expectSqlFailure(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-batch-anchor', {
          allocationBatchId: 'batch-mutation-batch-anchor',
          activityId: fixture.otherActivityId,
          sessionId: fixture.otherActivitySessionId,
        }),
        '23503',
        'activity_allocation_candidate_batch_anchor_fkey',
      );
    },
    proveMutated: (databaseName, fixture) => {
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-mutation-batch-anchor', {
          allocationBatchId: 'batch-mutation-batch-anchor',
          activityId: fixture.otherActivityId,
          sessionId: fixture.otherActivitySessionId,
        }),
      );
    },
  },
];

describe('Activity v1.1 batch4 allocation candidate position anchor migration', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });

  it('contains one strict DDL transaction, count-only preflight first, and exact Prisma anchors', () => {
    const migration = migrationSource();
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
    expect(executable).not.toContain('IF EXISTS');
    const preflightEnd = migration.indexOf('$allocation_d87_preflight$;');
    expect(preflightEnd).toBeGreaterThan(0);
    expect(migration.indexOf('ALTER TABLE')).toBeGreaterThan(preflightEnd);
    expect(migration.slice(0, preflightEnd)).toContain('SELECT COUNT(*)');
    expect(migration.slice(0, preflightEnd)).not.toMatch(/SELECT\s+"?id"?/i);
    const lockOrder = [
      'LOCK TABLE "Activity"',
      'LOCK TABLE "ActivitySession"',
      'LOCK TABLE "ActivitySessionPosition"',
      'LOCK TABLE "ActivityAllocationBatch"',
      'LOCK TABLE "ActivityAllocationCandidate"',
    ].map((needle) => migration.indexOf(needle));
    expect(lockOrder.every((offset) => offset >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b));
    expect(migration).not.toContain('activity_allocation_candidate_batch_lottery_order_unique');
    expect(migration).not.toContain('activity_allocation_candidate_batch_tie_break_key');

    const schema = readFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('activityId                String');
    expect(schema).toContain('sessionId                 String');
    expect(schema).toContain('waitlistPositionId        String?');
    expect(schema).toContain(
      '@relation(fields: [allocationBatchId, activityId, sessionId], references: [id, activityId, sessionId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_candidate_batch_anchor_fkey")',
    );
    expect(schema).toContain(
      '@relation("AllocationCandidateWaitlistPosition", fields: [activityId, sessionId, waitlistPositionId], references: [activityId, sessionId, id], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_candidate_waitlist_position_fkey")',
    );
    expect(schema).toContain(
      '@@index([allocationBatchId, waitlistPositionId, waitlistRank], map: "activity_allocation_candidate_batch_position_rank_idx")',
    );
  });

  it(
    'upgrades a true D86 database to 87 and installs only the exact D87 columns, anchors, and queue indexes',
    () => {
      const databaseName = recreateMigration86Scratch();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        assertCurrentArtifacts(databaseName);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    `replays all ${CURRENT_MIGRATION_COUNT} migrations from empty and permits rank one independently in two positions`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        assertCurrentArtifacts(databaseName);
        const fixture = createFixture(databaseName, 'two-position-rank-one');
        runPsql(databaseName, batchSql(fixture, 'batch-two-position-rank-one'));
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-position-a-rank-one', {
            allocationBatchId: 'batch-two-position-rank-one',
            resultCode: 'waitlisted',
            waitlistRank: 1,
            waitlistPositionId: fixture.positionAId,
          }),
        );
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-position-b-rank-one', {
            allocationBatchId: 'batch-two-position-rank-one',
            identitySlot: 1,
            resultCode: 'waitlisted',
            waitlistRank: 1,
            waitlistPositionId: fixture.positionBId,
          }),
        );
        expect(
          runPsql(
            databaseName,
            `SELECT "waitlistPositionId" || ':' || "waitlistRank" FROM "ActivityAllocationCandidate"
             WHERE "allocationBatchId" = 'batch-two-position-rank-one'
             ORDER BY "waitlistPositionId"`,
          ),
        ).toBe(`${fixture.positionAId}:1\n${fixture.positionBId}:1`);
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-position-a-rank-one-duplicate', {
            allocationBatchId: 'batch-two-position-rank-one',
            identitySlot: 2,
            resultCode: 'waitlisted',
            waitlistRank: 1,
            waitlistPositionId: fixture.positionAId,
          }),
          '23505',
          'activity_allocation_candidate_batch_position_rank_unique',
        );
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-position-a-rank-two', {
            allocationBatchId: 'batch-two-position-rank-one',
            identitySlot: 2,
            resultCode: 'waitlisted',
            waitlistRank: 2,
            waitlistPositionId: fixture.positionAId,
          }),
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'enforces both composite anchors, the closed result shape, one-based rank, lottery order, and tie key',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        const fixture = createFixture(databaseName, 'negative-controls');

        for (const [suffix, positionId] of [
          ['wrong-session-position', fixture.otherSessionPositionId],
          ['wrong-activity-position', fixture.otherActivityPositionId],
        ] as const) {
          const batchId = `batch-${suffix}`;
          runPsql(databaseName, batchSql(fixture, batchId));
          expectSqlFailure(
            databaseName,
            candidateSql(fixture, `candidate-${suffix}`, {
              allocationBatchId: batchId,
              resultCode: 'waitlisted',
              waitlistPositionId: positionId,
            }),
            '23503',
            'activity_allocation_candidate_waitlist_position_fkey',
          );
        }

        runPsql(databaseName, batchSql(fixture, 'batch-wrong-batch-session'));
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-wrong-batch-session', {
            allocationBatchId: 'batch-wrong-batch-session',
            sessionId: fixture.otherSessionId,
          }),
          '23503',
          'activity_allocation_candidate_batch_anchor_fkey',
        );
        runPsql(databaseName, batchSql(fixture, 'batch-wrong-batch-activity'));
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-wrong-batch-activity', {
            allocationBatchId: 'batch-wrong-batch-activity',
            activityId: fixture.otherActivityId,
            sessionId: fixture.otherActivitySessionId,
          }),
          '23503',
          'activity_allocation_candidate_batch_anchor_fkey',
        );

        const legalShapes: Array<{
          suffix: string;
          resultCode: CandidateOptions['resultCode'];
          waitlistRank: number | null;
          waitlistPositionId: string | null;
        }> = [
          { suffix: 'preparing', resultCode: null, waitlistRank: null, waitlistPositionId: null },
          {
            suffix: 'allocated',
            resultCode: 'allocated',
            waitlistRank: null,
            waitlistPositionId: null,
          },
          {
            suffix: 'not-selected',
            resultCode: 'not_selected',
            waitlistRank: null,
            waitlistPositionId: null,
          },
          {
            suffix: 'waitlisted',
            resultCode: 'waitlisted',
            waitlistRank: 1,
            waitlistPositionId: fixture.positionAId,
          },
        ];
        for (const shape of legalShapes) {
          const batchId = `batch-legal-${shape.suffix}`;
          runPsql(databaseName, batchSql(fixture, batchId));
          runPsql(
            databaseName,
            candidateSql(fixture, `candidate-legal-${shape.suffix}`, {
              allocationBatchId: batchId,
              resultCode: shape.resultCode,
              waitlistRank: shape.waitlistRank,
              waitlistPositionId: shape.waitlistPositionId,
            }),
          );
        }

        const invalidShapes: Array<{
          suffix: string;
          resultCode: CandidateOptions['resultCode'];
          waitlistRank: number | null;
          waitlistPositionId: string | null;
        }> = [
          {
            suffix: 'waitlisted-missing-rank',
            resultCode: 'waitlisted',
            waitlistRank: null,
            waitlistPositionId: fixture.positionAId,
          },
          {
            suffix: 'waitlisted-missing-position',
            resultCode: 'waitlisted',
            waitlistRank: 1,
            waitlistPositionId: null,
          },
          {
            suffix: 'allocated-rank',
            resultCode: 'allocated',
            waitlistRank: 1,
            waitlistPositionId: null,
          },
          {
            suffix: 'allocated-position',
            resultCode: 'allocated',
            waitlistRank: null,
            waitlistPositionId: fixture.positionAId,
          },
          {
            suffix: 'not-selected-rank',
            resultCode: 'not_selected',
            waitlistRank: 1,
            waitlistPositionId: null,
          },
          {
            suffix: 'not-selected-position',
            resultCode: 'not_selected',
            waitlistRank: null,
            waitlistPositionId: fixture.positionAId,
          },
          {
            suffix: 'preparing-rank',
            resultCode: null,
            waitlistRank: 1,
            waitlistPositionId: null,
          },
          {
            suffix: 'preparing-position',
            resultCode: null,
            waitlistRank: null,
            waitlistPositionId: fixture.positionAId,
          },
        ];
        for (const shape of invalidShapes) {
          const batchId = `batch-invalid-${shape.suffix}`;
          runPsql(databaseName, batchSql(fixture, batchId));
          expectSqlFailure(
            databaseName,
            candidateSql(fixture, `candidate-invalid-${shape.suffix}`, {
              allocationBatchId: batchId,
              resultCode: shape.resultCode,
              waitlistRank: shape.waitlistRank,
              waitlistPositionId: shape.waitlistPositionId,
            }),
            '23514',
            'activity_allocation_candidate_result_rank_shape_check',
          );
        }

        runPsql(databaseName, batchSql(fixture, 'batch-rank-zero'));
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-rank-zero', {
            allocationBatchId: 'batch-rank-zero',
            resultCode: 'waitlisted',
            waitlistRank: 0,
            waitlistPositionId: fixture.positionAId,
          }),
          '23514',
          'activity_allocation_candidate_waitlist_rank_one_based_check',
        );

        runPsql(
          databaseName,
          batchSql(fixture, 'batch-lottery-invariant', { modeCode: 'lottery' }),
        );
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-lottery-first', {
            allocationBatchId: 'batch-lottery-invariant',
            lotteryOrder: 1,
          }),
        );
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-lottery-second', {
            allocationBatchId: 'batch-lottery-invariant',
            identitySlot: 1,
            lotteryOrder: 1,
          }),
          '23505',
          'activity_allocation_candidate_batch_lottery_order_unique',
        );

        runPsql(databaseName, batchSql(fixture, 'batch-tie-invariant'));
        runPsql(
          databaseName,
          candidateSql(fixture, 'candidate-tie-first', {
            allocationBatchId: 'batch-tie-invariant',
            tieBreakKey: 'shared-tie-key',
          }),
        );
        expectSqlFailure(
          databaseName,
          candidateSql(fixture, 'candidate-tie-second', {
            allocationBatchId: 'batch-tie-invariant',
            identitySlot: 1,
            tieBreakKey: 'shared-tie-key',
          }),
          '23505',
          'activity_allocation_candidate_batch_tie_break_key',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'fails before DDL on a nonempty Candidate table without backfill, identifiers, or row rewrites',
    () => {
      const databaseName = recreateMigration86Scratch();
      try {
        const fixture = createFixture(databaseName, 'nonempty-preflight');
        runPsql(databaseName, batchSql(fixture, 'legacy-batch'));
        runPsql(databaseName, legacyCandidateSql(fixture, 'legacy-candidate', 'legacy-batch'));
        const rowsBefore = allocationRows(databaseName);
        const xminsBefore = allocationXmins(databaseName);
        const failure = runPsqlFailure(databaseName, migrationSource());
        expect(failure).toContain('23514');
        expect(failure).toContain('candidates=1');
        expect(failure).not.toContain('legacy-candidate');
        expect(failure).not.toContain(fixture.identityIds[0]);
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_86_COUNT);
        expect(d87ArtifactCount(databaseName)).toBe(0);
        expect(legacyArtifactSnapshot(databaseName)).toBe(
          'ActivityAllocationCandidate_allocationBatchId_fkey,activity_allocation_candidate_batch_rank_idx,activity_allocation_candidate_batch_waitlist_rank_unique,activity_allocation_candidate_result_rank_shape_check',
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
    'rolls back every D87 column, FK, check, and index replacement when late DDL fails',
    () => {
      const databaseName = recreateMigration86Scratch();
      try {
        const source = migrationSource();
        const failing = source.replace(
          /\nCOMMIT;\s*$/,
          `\nDO $allocation_d87_late_failure$\nBEGIN\n  RAISE EXCEPTION 'allocation D87 late failure';\nEND\n$allocation_d87_late_failure$;\n\nCOMMIT;\n`,
        );
        expect(failing).not.toBe(source);
        const failure = runPsqlFailure(databaseName, failing);
        expect(failure).toContain('allocation D87 late failure');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_86_COUNT);
        expect(d87ArtifactCount(databaseName)).toBe(0);
        expect(legacyArtifactSnapshot(databaseName)).toBe(
          'ActivityAllocationCandidate_allocationBatchId_fkey,activity_allocation_candidate_batch_rank_idx,activity_allocation_candidate_batch_waitlist_rank_unique,activity_allocation_candidate_result_rank_shape_check',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it.each(mutationCases)(
    '$name keeps the positive control green, makes the mutation red, then restores green',
    ({ beginMarker, endMarker, setup, proveCorrect, proveMutated }) => {
      let databaseName = recreateMigration86Scratch();
      try {
        runPsql(databaseName, migrationSource());
        let fixture = createFixture(databaseName, 'mutation-control');
        setup(databaseName, fixture);
        proveCorrect(databaseName, fixture);

        databaseName = recreateMigration86Scratch();
        const mutated = removeMarkedBlock(migrationSource(), beginMarker, endMarker);
        expect(mutated).not.toBe(migrationSource());
        runPsql(databaseName, mutated);
        fixture = createFixture(databaseName, 'mutation-red');
        setup(databaseName, fixture);
        proveMutated(databaseName, fixture);

        databaseName = recreateMigration86Scratch();
        runPsql(databaseName, migrationSource());
        fixture = createFixture(databaseName, 'mutation-restored');
        setup(databaseName, fixture);
        proveCorrect(databaseName, fixture);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );
});
