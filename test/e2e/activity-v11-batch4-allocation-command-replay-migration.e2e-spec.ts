import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const SCRATCH_WORKER_ID = 86;
const SHADOW_WORKER_ID = 87;
const MIGRATION_NAME = '20260813100000_activity_v11_batch4_allocation_command_replay_projection';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const MIGRATION_85_COUNT = 85;
const MIGRATION_86_COUNT = 86;
// ⚠️ 与上面的 MIGRATION_<N>_COUNT 是**两件事**:那些是固定的历史世代基线(冷库重放的起点),
// 随仓库增长**永不变**;这个是仓库当前的 migration 总数,每加一刀就要 +1。
// 混改任何一个都会把冷库重放用例的语义整个改坏(issue #1055 T1 加第 91 刀时逐个复核过)。
const CURRENT_MIGRATION_COUNT = 110;
const COLD_REPLAY_TIMEOUT_MS = 300_000;
const RESPONSE_SCHEMA_VERSION = 'allocation-command-response-v1';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const ACCEPTED_AT = '2099-08-13 08:30:00';

// `migrate diff` 的两条来源都必须只留下这份已知 Prisma 映射差异；B6 的 offline
// 复合 relation map 也在这里逐项钉死，不能以“当前 diff”名义放宽为任意输出。
// 2026-08-21 业务复合锚点闭合(第六轮评审 A-2 + B-03)后这份基线由 23 条降为 19 条:
// OfflinePackageParticipant 的 identity / position 与 OfflinePunchReviewItem 的
// formal_event / identity 四条外键被整条 DROP 并重建为复合外键,不再需要"改名",
// 于是从已知漂移里消失。**这是减少、不是放宽** —— 其余 19 条一字未动。
// D86 本身不能新增、删除或重命名任何 schema / migration 物理对象。
const EXPECTED_PRISMA_CURRENT_DIFF = `-- DropForeignKey
ALTER TABLE "ActivityQualificationRuleSet" DROP CONSTRAINT "ActivityQualificationRuleSet_positionId_fkey";

-- DropForeignKey
ALTER TABLE "ActivitySessionPosition" DROP CONSTRAINT "ActivitySessionPosition_qualificationRuleSetId_fkey";

-- DropIndex
DROP INDEX "activity_qualification_rule_set_scope_version_unique";

-- RenameForeignKey
ALTER TABLE "ActivityQualificationRuleSet" RENAME CONSTRAINT "activity_qualification_rule_set_activity_session_position_fkey" TO "ActivityQualificationRuleSet_activityId_sessionId_position_fkey";

-- RenameForeignKey
ALTER TABLE "ActivitySessionPosition" RENAME CONSTRAINT "activity_session_position_qualification_rule_set_scope_fkey" TO "ActivitySessionPosition_activityId_sessionId_id_qualificat_fkey";

-- RenameForeignKey
ALTER TABLE "AttendancePunchEvent" RENAME CONSTRAINT "AttendancePunchEvent_offline_package_anchor_fkey" TO "AttendancePunchEvent_offlinePackageId_activityId_sessionId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePackageParticipant" RENAME CONSTRAINT "OfflinePackageParticipant_activity_session_fkey" TO "OfflinePackageParticipant_activityId_sessionId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePackageParticipant" RENAME CONSTRAINT "OfflinePackageParticipant_member_fkey" TO "OfflinePackageParticipant_memberId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePackageParticipant" RENAME CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey" TO "OfflinePackageParticipant_offlinePackageId_activityId_sess_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePackageParticipant" RENAME CONSTRAINT "OfflinePackageParticipant_revision_fkey" TO "OfflinePackageParticipant_participationRevisionId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_activity_session_fkey" TO "OfflinePunchReviewItem_activityId_sessionId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_package_anchor_fkey" TO "OfflinePunchReviewItem_offlinePackageId_activityId_session_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_reviewer_member_fkey" TO "OfflinePunchReviewItem_reviewedByMemberId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_reviewer_user_fkey" TO "OfflinePunchReviewItem_reviewedByUserId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_revision_fkey" TO "OfflinePunchReviewItem_participationRevisionId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_staged_member_fkey" TO "OfflinePunchReviewItem_stagedByMemberId_fkey";

-- RenameForeignKey
ALTER TABLE "OfflinePunchReviewItem" RENAME CONSTRAINT "OfflinePunchReviewItem_staged_user_fkey" TO "OfflinePunchReviewItem_stagedByUserId_fkey";

-- RenameIndex
ALTER INDEX "notification_outbox_intents_status_availableAt_leaseExpiresAt_i" RENAME TO "notification_outbox_intents_status_availableAt_leaseExpires_idx";

-- RenameIndex
ALTER INDEX "storage_object_operations_responseSnapshotExpiresAt_responsePur" RENAME TO "storage_object_operations_responseSnapshotExpiresAt_respons_idx";`;

const D86_CONSTRAINTS = [
  'activity_allocation_batch_void_shape_check',
  'activity_allocation_batch_id_activity_unique',
  'activity_allocation_batch_id_activity_session_unique',
  'activity_allocation_candidate_id_batch_identity_unique',
  'activity_participation_identity_id_activity_session_member_key',
  'activity_participation_revision_id_batch_identity_unique',
  'activity_capacity_bucket_id_activity_unique',
  'capacity_reservation_id_identity_bucket_unique',
  'capacity_reservation_id_member_activity_bucket_unique',
  'ActivityAllocationCommandReceipt_pkey',
  'activity_allocation_command_receipt_command_code_check',
  'activity_allocation_command_receipt_operation_key_shape_check',
  'activity_allocation_command_receipt_request_hash_check',
  'activity_allocation_cmd_receipt_response_schema_version_check',
  'activity_allocation_command_receipt_response_hash_check',
  'activity_allocation_command_receipt_response_shape_check',
  'activity_allocation_command_receipt_activity_command_key',
  'activity_allocation_command_receipt_batch_command_key',
  'activity_allocation_command_receipt_batch_anchor_fkey',
  'activity_allocation_command_receipt_actor_fkey',
  'ActivityAllocationApplicationProjection_pkey',
  'activity_allocation_application_projection_candidate_key',
  'activity_allocation_application_projection_batch_identity_key',
  'activity_allocation_app_projection_result_status_check',
  'activity_allocation_app_projection_active_res_shape_check',
  'activity_allocation_app_projection_inactive_clear_check',
  'activity_allocation_app_projection_position_shape_check',
  'activity_allocation_application_projection_batch_anchor_fkey',
  'activity_allocation_app_projection_candidate_anchor_fkey',
  'activity_allocation_app_projection_identity_anchor_fkey',
  'activity_allocation_app_projection_revision_anchor_fkey',
  'activity_allocation_app_projection_position_anchor_fkey',
  'activity_allocation_app_projection_activity_reservation_fkey',
  'activity_allocation_app_projection_session_reservation_fkey',
  'activity_allocation_app_projection_position_reservation_fkey',
  'activity_allocation_app_projection_activity_bucket_fkey',
  'activity_allocation_app_projection_session_bucket_fkey',
  'activity_allocation_app_projection_position_bucket_fkey',
] as const;

const D86_TRIGGERS = [
  'trg_activity_allocation_command_receipt_10_immutable',
  'trg_activity_allocation_application_projection_10_immutable',
] as const;

const D86_FUNCTIONS = [
  'activity_allocation_command_receipt_response_valid',
  'activity_allocation_command_receipt_immutable_guard',
  'activity_allocation_application_projection_immutable_guard',
] as const;

interface Fixture {
  activityId: string;
  sessionId: string;
  secondSessionId: string;
  positionId: string;
  actorUserId: string;
  memberId: string;
  memberId2: string;
  registrationId: string;
  registrationId2: string;
  registrationRevisionId: string;
  registrationRevisionId2: string;
  identityId: string;
  identityId2: string;
  sameMemberSecondSessionIdentityId: string;
  activityPersonBucketId: string;
  sessionBucketId: string;
  secondSessionBucketId: string;
  positionBucketId: string;
  activityPersonReservationId: string;
  member2ActivityPersonReservationId: string;
  sessionReservationId: string;
  positionReservationId: string;
  identity2SessionReservationId: string;
  identity2PositionReservationId: string;
  sameMemberSecondSessionReservationId: string;
}

interface BatchOptions {
  activityId?: string;
  sessionId?: string;
  statusCode?: string;
  committedAt?: string | null;
  voidReason?: string | null;
  voidedAt?: string | null;
}

interface CandidateOptions {
  allocationBatchId: string;
  participationIdentityId?: string;
  registrationId?: string;
  registrationRevisionId?: string;
  resultCode?: 'allocated' | 'waitlisted' | 'not_selected' | null;
  waitlistRank?: number | null;
}

interface D87CandidateAnchors {
  activityId: string;
  sessionId: string;
  waitlistPositionId: string | null;
}

interface RevisionOptions {
  allocationBatchId: string;
  participationIdentityId?: string;
  statusCode: 'pass' | 'waitlisted' | 'not_selected';
  revision: number;
  positionId?: string | null;
}

interface ReceiptOptions {
  activityId?: string;
  operationKey?: string;
  requestHash?: string;
  responseHash?: string;
  responseReceipt?: Record<string, string>;
}

interface ProjectionOptions {
  activityId?: string;
  sessionId?: string;
  memberId?: string;
  allocationBatchId: string;
  allocationCandidateId: string;
  participationIdentityId?: string;
  appliedParticipationRevisionId: string;
  appliedResultCode: 'allocated' | 'waitlisted' | 'not_selected';
  appliedStatusCode?: 'pass' | 'waitlisted' | 'not_selected';
  populationIncluded?: boolean;
  positionId?: string | null;
  expectedIdentityCapacityReservationId?: string | null;
  activityPersonReservationId?: string | null;
  activityPersonBucketId?: string | null;
  sessionReservationId?: string | null;
  sessionBucketId?: string | null;
  positionReservationId?: string | null;
  positionBucketId?: string | null;
}

interface ProjectionSubject {
  batchId: string;
  candidateId: string;
  revisionId: string;
  identityId: string;
}

interface MutationCase {
  name: string;
  beginMarker: string;
  endMarker: string;
  setup: (databaseName: string, fixture: Fixture) => void;
  probe: (fixture: Fixture) => { sql: string; sqlState: string; constraintOrKey: string };
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullable(value: string | null | undefined): string {
  return value == null ? 'NULL' : sqlValue(value);
}

function sqlBoolean(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function valueOr<T extends object, K extends keyof T>(options: T, key: K, fallback: T[K]): T[K] {
  return hasOwn(options, String(key)) ? options[key] : fallback;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for allocation D86 migration E2E');
  if (
    databaseName !== deriveWorkerTestDbName(SCRATCH_WORKER_ID) &&
    databaseName !== deriveWorkerTestDbName(SHADOW_WORKER_ID)
  ) {
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

function recreateEmptyShadowDatabase(): string {
  const databaseName = deriveWorkerTestDbName(SHADOW_WORKER_ID);
  assertDroppableTestDbName(databaseName);
  dropWorkerDatabase(SHADOW_WORKER_ID);
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

function deployMigrationsThrough85(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const names = migrationNames();
  const migration86Index = names.indexOf(MIGRATION_NAME);
  if (migration86Index + 1 !== MIGRATION_86_COUNT) {
    throw new Error(
      `expected D86 to be migration ${MIGRATION_86_COUNT}; got ${migration86Index + 1}`,
    );
  }
  const baselineEnd = migration86Index;
  if (baselineEnd !== MIGRATION_85_COUNT) {
    throw new Error(`expected an exact 85-migration baseline; got ${baselineEnd}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-allocation-d86-85-'));
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

function recreateMigration85Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough85(databaseName);
    if (successfulMigrationCount(databaseName) !== MIGRATION_85_COUNT) {
      throw new Error('failed to build a true 85-migration scratch database');
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

function commandBatchStatus(commandCode: 'prepare' | 'commit' | 'void'): string {
  return { prepare: 'preparing', commit: 'committed', void: 'voided' }[commandCode];
}

// 这是 runtime 哈希输入的唯一 canonical serialization：不对 JSONB 的对象键顺序作任何假设。
function canonicalReceiptPayload(
  activityId: string,
  allocationBatchId: string,
  commandCode: 'prepare' | 'commit' | 'void',
): string {
  return JSON.stringify({
    activityId,
    allocationBatchId,
    batchStatusCode: commandBatchStatus(commandCode),
    commandCode,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
  });
}

function responseHash(
  activityId: string,
  allocationBatchId: string,
  commandCode: 'prepare' | 'commit' | 'void',
): string {
  return createHash('sha256')
    .update(canonicalReceiptPayload(activityId, allocationBatchId, commandCode), 'utf8')
    .digest('hex');
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
    activityId: `allocation-d86-activity-${suffix}`,
    sessionId: `allocation-d86-session-${suffix}`,
    secondSessionId: `allocation-d86-session-${suffix}-2`,
    positionId: `allocation-d86-position-${suffix}`,
    actorUserId: `allocation-d86-actor-${suffix}`,
    memberId: `allocation-d86-member-${suffix}-1`,
    memberId2: `allocation-d86-member-${suffix}-2`,
    registrationId: `allocation-d86-registration-${suffix}-1`,
    registrationId2: `allocation-d86-registration-${suffix}-2`,
    registrationRevisionId: `allocation-d86-registration-revision-${suffix}-1`,
    registrationRevisionId2: `allocation-d86-registration-revision-${suffix}-2`,
    identityId: `allocation-d86-identity-${suffix}-1`,
    identityId2: `allocation-d86-identity-${suffix}-2`,
    sameMemberSecondSessionIdentityId: `allocation-d86-identity-${suffix}-3`,
    activityPersonBucketId: `allocation-d86-bucket-activity-${suffix}`,
    sessionBucketId: `allocation-d86-bucket-session-${suffix}`,
    secondSessionBucketId: `allocation-d86-bucket-session-${suffix}-2`,
    positionBucketId: `allocation-d86-bucket-position-${suffix}`,
    activityPersonReservationId: `allocation-d86-reservation-activity-${suffix}`,
    member2ActivityPersonReservationId: `allocation-d86-reservation-activity-${suffix}-2`,
    sessionReservationId: `allocation-d86-reservation-session-${suffix}`,
    positionReservationId: `allocation-d86-reservation-position-${suffix}`,
    identity2SessionReservationId: `allocation-d86-reservation-session-${suffix}-2`,
    identity2PositionReservationId: `allocation-d86-reservation-position-${suffix}-2`,
    sameMemberSecondSessionReservationId: `allocation-d86-reservation-session-${suffix}-3`,
  };
  const organizationId = `allocation-d86-organization-${suffix}`;
  runPsql(
    databaseName,
    `INSERT INTO "Organization" ("id","name","nodeTypeCode","updatedAt") VALUES
       (${sqlValue(organizationId)},${sqlValue(`Allocation D86 ${suffix}`)},'team',CURRENT_TIMESTAMP);
     INSERT INTO "Activity"
       ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
     VALUES
       (${sqlValue(fixture.activityId)},${sqlValue(`Allocation D86 ${suffix}`)},'allocation-d86',
        ${sqlValue(organizationId)},TIMESTAMP '2099-08-13 08:00:00',
        TIMESTAMP '2099-08-13 18:00:00','test','draft',CURRENT_TIMESTAMP);
     INSERT INTO "Member" ("id","memberNo",${memberIdentity.columns},"updatedAt") VALUES
       (${sqlValue(fixture.memberId)},${sqlValue(`D86-${suffix}-1`)},${memberIdentity.values('D86 Member 1')},CURRENT_TIMESTAMP),
       (${sqlValue(fixture.memberId2)},${sqlValue(`D86-${suffix}-2`)},${memberIdentity.values('D86 Member 2')},CURRENT_TIMESTAMP);
     INSERT INTO "User" ("id","username","passwordHash","updatedAt") VALUES
       (${sqlValue(fixture.actorUserId)},${sqlValue(`d86-actor-${suffix}`)},'test-password-hash',CURRENT_TIMESTAMP);
     INSERT INTO "ActivitySession"
       ("id","updatedAt","activityId","code","name","startAt","endAt","locationText",
        "checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt",
        "locationRequired","locationPolicySourceCode","statusCode")
     VALUES
       (${sqlValue(fixture.sessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},'session',
        'Allocation D86 Session',TIMESTAMP '2099-08-13 09:00:00',TIMESTAMP '2099-08-13 17:00:00',
        'test',TIMESTAMP '2099-08-13 08:00:00',TIMESTAMP '2099-08-13 10:00:00',
        TIMESTAMP '2099-08-13 16:00:00',TIMESTAMP '2099-08-13 18:00:00',FALSE,'system','scheduled'),
       (${sqlValue(fixture.secondSessionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},'session-2',
        'Allocation D86 Second Session',TIMESTAMP '2099-08-13 09:00:00',TIMESTAMP '2099-08-13 17:00:00',
        'test',TIMESTAMP '2099-08-13 08:00:00',TIMESTAMP '2099-08-13 10:00:00',
        TIMESTAMP '2099-08-13 16:00:00',TIMESTAMP '2099-08-13 18:00:00',FALSE,'system','scheduled');
     INSERT INTO "ActivitySessionPosition"
       ("id","updatedAt","activityId","sessionId","code","name","attendanceRoleCode","capacity")
     VALUES
       (${sqlValue(fixture.positionId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},'position','Allocation D86 Position','volunteer',8);
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
       ("id","updatedAt","activityId","sessionId","registrationId","memberId","capacityReservationId","currentStatusCode") VALUES
       (${sqlValue(fixture.identityId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationId)},${sqlValue(fixture.memberId)},
        ${sqlValue(fixture.sessionReservationId)},'pending'),
       (${sqlValue(fixture.identityId2)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.sessionId)},${sqlValue(fixture.registrationId2)},${sqlValue(fixture.memberId2)},
        ${sqlValue(fixture.identity2SessionReservationId)},'pending'),
       (${sqlValue(fixture.sameMemberSecondSessionIdentityId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        ${sqlValue(fixture.secondSessionId)},${sqlValue(fixture.registrationId)},${sqlValue(fixture.memberId)},
        ${sqlValue(fixture.sameMemberSecondSessionReservationId)},'pending');
     INSERT INTO "ActivityCapacityBucket"
       ("id","updatedAt","activityId","scopeTypeCode","scopeId","capacity") VALUES
       (${sqlValue(fixture.activityPersonBucketId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        'activity_person',${sqlValue(fixture.activityId)},8),
       (${sqlValue(fixture.sessionBucketId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        'session_participation',${sqlValue(fixture.sessionId)},8),
       (${sqlValue(fixture.secondSessionBucketId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        'session_participation',${sqlValue(fixture.secondSessionId)},8),
       (${sqlValue(fixture.positionBucketId)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},
        'position_participation',${sqlValue(fixture.positionId)},8);
     INSERT INTO "CapacityReservation"
       ("id","updatedAt","identityId","bucketId","reservationType","memberId","activityId","status") VALUES
       (${sqlValue(fixture.activityPersonReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId)},
        ${sqlValue(fixture.activityPersonBucketId)},'activity_person',${sqlValue(fixture.memberId)},
        ${sqlValue(fixture.activityId)},'active'),
       (${sqlValue(fixture.member2ActivityPersonReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId2)},
        ${sqlValue(fixture.activityPersonBucketId)},'activity_person',${sqlValue(fixture.memberId2)},
        ${sqlValue(fixture.activityId)},'active'),
       (${sqlValue(fixture.sessionReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId)},
        ${sqlValue(fixture.sessionBucketId)},'session_participation',NULL,NULL,'active'),
       (${sqlValue(fixture.positionReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId)},
        ${sqlValue(fixture.positionBucketId)},'position_participation',NULL,NULL,'active'),
       (${sqlValue(fixture.identity2SessionReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId2)},
        ${sqlValue(fixture.sessionBucketId)},'session_participation',NULL,NULL,'active'),
       (${sqlValue(fixture.identity2PositionReservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.identityId2)},
        ${sqlValue(fixture.positionBucketId)},'position_participation',NULL,NULL,'active'),
       (${sqlValue(fixture.sameMemberSecondSessionReservationId)},CURRENT_TIMESTAMP,
        ${sqlValue(fixture.sameMemberSecondSessionIdentityId)},${sqlValue(fixture.secondSessionBucketId)},
        'session_participation',NULL,NULL,'active');`,
  );
  return fixture;
}

function identityRegistration(
  fixture: Fixture,
  identityId: string,
): {
  registrationId: string;
  registrationRevisionId: string;
} {
  if (identityId === fixture.identityId) {
    return {
      registrationId: fixture.registrationId,
      registrationRevisionId: fixture.registrationRevisionId,
    };
  }
  if (identityId === fixture.identityId2) {
    return {
      registrationId: fixture.registrationId2,
      registrationRevisionId: fixture.registrationRevisionId2,
    };
  }
  if (identityId === fixture.sameMemberSecondSessionIdentityId) {
    return {
      registrationId: fixture.registrationId,
      registrationRevisionId: fixture.registrationRevisionId,
    };
  }
  throw new Error(`unknown fixture identity ${identityId}`);
}

function batchSql(fixture: Fixture, id: string, options: BatchOptions = {}): string {
  const statusCode = options.statusCode ?? 'preparing';
  const committedAt = valueOr(
    options,
    'committedAt',
    statusCode === 'committed' ? ACCEPTED_AT : null,
  );
  const voidReason = valueOr(
    options,
    'voidReason',
    statusCode === 'voided' ? 'test void reason' : null,
  );
  const voidedAt = valueOr(options, 'voidedAt', statusCode === 'voided' ? ACCEPTED_AT : null);
  return `INSERT INTO "ActivityAllocationBatch"
    ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
     "algorithmVersionCode","randomCommitment","randomSeedReveal","statusCode","operationKey",
     "committedAt","voidReason","voidedAt")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(options.activityId ?? fixture.activityId)},
     ${sqlValue(options.sessionId ?? fixture.sessionId)},'first_come',${sqlValue(HASH_A)},
     'allocation-v1',NULL,NULL,${sqlValue(statusCode)},${sqlValue(`operation-${id}`)},
     ${sqlNullable(committedAt)},${sqlNullable(voidReason)},${sqlNullable(voidedAt)})`;
}

function legacyBatchSql(fixture: Fixture, id: string): string {
  return `INSERT INTO "ActivityAllocationBatch"
    ("id","updatedAt","activityId","sessionId","modeCode","candidateSnapshotHash",
     "algorithmVersionCode","randomCommitment","randomSeedReveal","statusCode","operationKey","committedAt")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(fixture.activityId)},${sqlValue(fixture.sessionId)},
     'first_come',${sqlValue(HASH_A)},'allocation-v1',NULL,NULL,'preparing',
     ${sqlValue(`operation-${id}`)},NULL)`;
}

function candidateSql(
  fixture: Fixture,
  id: string,
  options: CandidateOptions,
  d87Anchors?: D87CandidateAnchors,
): string {
  const identityId = options.participationIdentityId ?? fixture.identityId;
  const registration = identityRegistration(fixture, identityId);
  const resultCode = valueOr(options, 'resultCode', null);
  const waitlistRank = valueOr(options, 'waitlistRank', resultCode === 'waitlisted' ? 1 : null);
  const d87Columns = d87Anchors ? ',"activityId","sessionId","waitlistPositionId"' : '';
  const d87Values = d87Anchors
    ? `,${sqlValue(d87Anchors.activityId)},${sqlValue(d87Anchors.sessionId)},${sqlNullable(d87Anchors.waitlistPositionId)}`
    : '';
  return `INSERT INTO "ActivityAllocationCandidate"
    ("id","updatedAt","allocationBatchId"${d87Columns},"participationIdentityId","registrationId",
     "registrationRevisionId","acceptedAt","qualificationSnapshotHash","qualificationScore",
     "tieBreakKey","lotteryOrder","resultCode","waitlistRank","explanation")
   VALUES
    (${sqlValue(id)},CURRENT_TIMESTAMP,${sqlValue(options.allocationBatchId)}${d87Values},${sqlValue(identityId)},
     ${sqlValue(options.registrationId ?? registration.registrationId)},
     ${sqlValue(options.registrationRevisionId ?? registration.registrationRevisionId)},
     TIMESTAMP '${ACCEPTED_AT}',${sqlValue(HASH_D)},NULL,${sqlValue(`tie-${id}`)},NULL,
     ${sqlNullable(resultCode)},${waitlistRank === null ? 'NULL' : String(waitlistRank)},'{}'::jsonb)`;
}

function currentCandidateSql(fixture: Fixture, id: string, options: CandidateOptions): string {
  const identityId = options.participationIdentityId ?? fixture.identityId;
  const identity = identityProjectionFacts(fixture, identityId);
  const resultCode = valueOr(options, 'resultCode', null);
  return candidateSql(fixture, id, options, {
    activityId: fixture.activityId,
    sessionId: identity.sessionId,
    waitlistPositionId: resultCode === 'waitlisted' ? fixture.positionId : null,
  });
}

function revisionSql(fixture: Fixture, id: string, options: RevisionOptions): string {
  const identityId = options.participationIdentityId ?? fixture.identityId;
  return `INSERT INTO "ActivityParticipationRevision"
    ("id","identityId","revision","statusCode","positionId","allocationBatchId","effectiveAt","sourceCode")
   VALUES
    (${sqlValue(id)},${sqlValue(identityId)},${options.revision},${sqlValue(options.statusCode)},
     ${sqlNullable(valueOr(options, 'positionId', null))},${sqlValue(options.allocationBatchId)},
     TIMESTAMP '${ACCEPTED_AT}','allocation-d86-test')`;
}

function receiptSql(
  fixture: Fixture,
  id: string,
  allocationBatchId: string,
  commandCode: 'prepare' | 'commit' | 'void',
  options: ReceiptOptions = {},
): string {
  const activityId = options.activityId ?? fixture.activityId;
  const calculatedHash = responseHash(activityId, allocationBatchId, commandCode);
  const responseHashValue = options.responseHash ?? calculatedHash;
  const responseReceipt = options.responseReceipt ?? {
    activityId,
    allocationBatchId,
    commandCode,
    batchStatusCode: commandBatchStatus(commandCode),
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    responseHash: responseHashValue,
  };
  return `INSERT INTO "ActivityAllocationCommandReceipt"
    ("id","activityId","allocationBatchId","commandCode","operationKey","requestHash",
     "responseSchemaVersion","responseHash","responseReceipt","actorUserId")
   VALUES
    (${sqlValue(id)},${sqlValue(activityId)},${sqlValue(allocationBatchId)},${sqlValue(commandCode)},
     ${sqlValue(options.operationKey ?? `operation-${id}`)},${sqlValue(options.requestHash ?? HASH_B)},
     ${sqlValue(RESPONSE_SCHEMA_VERSION)},${sqlValue(responseHashValue)},
     ${sqlValue(JSON.stringify(responseReceipt))}::jsonb,${sqlValue(fixture.actorUserId)})`;
}

function projectionStatus(
  resultCode: ProjectionOptions['appliedResultCode'],
): 'pass' | 'waitlisted' | 'not_selected' {
  return resultCode === 'allocated' ? 'pass' : resultCode;
}

function identityProjectionFacts(
  fixture: Fixture,
  identityId: string,
): {
  memberId: string;
  sessionId: string;
  expectedIdentityCapacityReservationId: string;
  activityPersonReservationId: string;
  activityPersonBucketId: string;
  sessionReservationId: string;
  sessionBucketId: string;
} {
  if (identityId === fixture.identityId) {
    return {
      memberId: fixture.memberId,
      sessionId: fixture.sessionId,
      expectedIdentityCapacityReservationId: fixture.sessionReservationId,
      activityPersonReservationId: fixture.activityPersonReservationId,
      activityPersonBucketId: fixture.activityPersonBucketId,
      sessionReservationId: fixture.sessionReservationId,
      sessionBucketId: fixture.sessionBucketId,
    };
  }
  if (identityId === fixture.identityId2) {
    return {
      memberId: fixture.memberId2,
      sessionId: fixture.sessionId,
      expectedIdentityCapacityReservationId: fixture.identity2SessionReservationId,
      activityPersonReservationId: fixture.member2ActivityPersonReservationId,
      activityPersonBucketId: fixture.activityPersonBucketId,
      sessionReservationId: fixture.identity2SessionReservationId,
      sessionBucketId: fixture.sessionBucketId,
    };
  }
  if (identityId === fixture.sameMemberSecondSessionIdentityId) {
    return {
      memberId: fixture.memberId,
      sessionId: fixture.secondSessionId,
      expectedIdentityCapacityReservationId: fixture.sameMemberSecondSessionReservationId,
      activityPersonReservationId: fixture.activityPersonReservationId,
      activityPersonBucketId: fixture.activityPersonBucketId,
      sessionReservationId: fixture.sameMemberSecondSessionReservationId,
      sessionBucketId: fixture.secondSessionBucketId,
    };
  }
  throw new Error(`unknown projection identity ${identityId}`);
}

function createWrongActivityPersonReservation(
  databaseName: string,
  fixture: Fixture,
): { activityId: string; reservationId: string } {
  const activityId = `${fixture.activityId}-wrong-activity`;
  const reservationId = `${fixture.activityPersonReservationId}-wrong-activity`;
  runPsql(
    databaseName,
    `INSERT INTO "Activity"
       ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
     SELECT ${sqlValue(activityId)},'Allocation D86 Wrong Activity',"activityTypeCode","organizationId",
            "startAt","endAt","location",'draft',CURRENT_TIMESTAMP
     FROM "Activity" WHERE "id" = ${sqlValue(fixture.activityId)};
     INSERT INTO "CapacityReservation"
       ("id","updatedAt","identityId","bucketId","reservationType","memberId","activityId","status")
     VALUES
       (${sqlValue(reservationId)},CURRENT_TIMESTAMP,${sqlValue(fixture.sameMemberSecondSessionIdentityId)},
        ${sqlValue(fixture.activityPersonBucketId)},'activity_person',${sqlValue(fixture.memberId)},
        ${sqlValue(activityId)},'active');`,
  );
  return { activityId, reservationId };
}

function projectionSql(fixture: Fixture, id: string, options: ProjectionOptions): string {
  const active = options.appliedResultCode === 'allocated';
  const identityId = options.participationIdentityId ?? fixture.identityId;
  const identity = identityProjectionFacts(fixture, identityId);
  const defaultValue = <T>(key: keyof ProjectionOptions, fallback: T): T =>
    (hasOwn(options, key) ? options[key] : fallback) as T;
  const memberId = defaultValue('memberId', identity.memberId);
  const positionId = defaultValue('positionId', null);
  const expectedIdentityCapacityReservationId = defaultValue(
    'expectedIdentityCapacityReservationId',
    active ? identity.expectedIdentityCapacityReservationId : null,
  );
  const activityPersonReservationId = defaultValue(
    'activityPersonReservationId',
    active ? identity.activityPersonReservationId : null,
  );
  const activityPersonBucketId = defaultValue(
    'activityPersonBucketId',
    active ? identity.activityPersonBucketId : null,
  );
  const sessionReservationId = defaultValue(
    'sessionReservationId',
    active ? identity.sessionReservationId : null,
  );
  const sessionBucketId = defaultValue('sessionBucketId', active ? identity.sessionBucketId : null);
  const positionReservationId = defaultValue('positionReservationId', null);
  const positionBucketId = defaultValue('positionBucketId', null);
  return `INSERT INTO "ActivityAllocationApplicationProjection"
    ("id","appliedAt","activityId","sessionId","allocationBatchId","allocationCandidateId",
     "participationIdentityId","memberId","appliedParticipationRevisionId","appliedResultCode","appliedStatusCode",
     "positionId","populationIncluded","expectedIdentityCapacityReservationId",
     "activityPersonReservationId","activityPersonBucketId","sessionReservationId","sessionBucketId",
     "positionReservationId","positionBucketId")
   VALUES
    (${sqlValue(id)},TIMESTAMP '${ACCEPTED_AT}',${sqlValue(options.activityId ?? fixture.activityId)},
     ${sqlValue(options.sessionId ?? identity.sessionId)},${sqlValue(options.allocationBatchId)},
     ${sqlValue(options.allocationCandidateId)},${sqlValue(identityId)},${sqlValue(memberId)},
     ${sqlValue(options.appliedParticipationRevisionId)},${sqlValue(options.appliedResultCode)},
     ${sqlValue(options.appliedStatusCode ?? projectionStatus(options.appliedResultCode))},
     ${sqlNullable(positionId)},${sqlBoolean(options.populationIncluded ?? active)},
     ${sqlNullable(expectedIdentityCapacityReservationId)},${sqlNullable(activityPersonReservationId)},
     ${sqlNullable(activityPersonBucketId)},${sqlNullable(sessionReservationId)},${sqlNullable(sessionBucketId)},
     ${sqlNullable(positionReservationId)},${sqlNullable(positionBucketId)})`;
}

function insertProjectionSubject(
  databaseName: string,
  fixture: Fixture,
  suffix: string,
  resultCode: ProjectionOptions['appliedResultCode'],
  identityId = fixture.identityId,
  revision = 1,
  includeD87Anchors = false,
): ProjectionSubject {
  const batchId = `batch-${suffix}`;
  const candidateId = `candidate-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const identity = identityProjectionFacts(fixture, identityId);
  runPsql(
    databaseName,
    batchSql(fixture, batchId, { statusCode: 'committed', sessionId: identity.sessionId }),
  );
  runPsql(
    databaseName,
    (includeD87Anchors ? currentCandidateSql : candidateSql)(fixture, candidateId, {
      allocationBatchId: batchId,
      participationIdentityId: identityId,
      resultCode,
    }),
  );
  runPsql(
    databaseName,
    revisionSql(fixture, revisionId, {
      allocationBatchId: batchId,
      participationIdentityId: identityId,
      statusCode: projectionStatus(resultCode),
      revision,
    }),
  );
  return { batchId, candidateId, revisionId, identityId };
}

function insertCurrentProjectionSubject(
  databaseName: string,
  fixture: Fixture,
  suffix: string,
  resultCode: ProjectionOptions['appliedResultCode'],
  identityId = fixture.identityId,
  revision = 1,
): ProjectionSubject {
  return insertProjectionSubject(
    databaseName,
    fixture,
    suffix,
    resultCode,
    identityId,
    revision,
    true,
  );
}

function d86ArtifactCount(databaseName: string): number {
  const constraints = D86_CONSTRAINTS.map(sqlValue).join(',');
  const triggers = D86_TRIGGERS.map(sqlValue).join(',');
  const functions = D86_FUNCTIONS.map(sqlValue).join(',');
  return Number(
    runPsql(
      databaseName,
      `SELECT
        (SELECT COUNT(*) FROM pg_class WHERE relkind = 'r' AND relname IN
          ('ActivityAllocationCommandReceipt','ActivityAllocationApplicationProjection')) +
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'ActivityAllocationBatch' AND column_name IN ('voidReason','voidedAt')) +
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'ActivityAllocationApplicationProjection' AND column_name = 'memberId'
          AND is_nullable = 'NO') +
        (SELECT COUNT(*) FROM pg_constraint WHERE conname IN (${constraints})) +
        (SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${triggers})) +
        (SELECT COUNT(*) FROM pg_proc WHERE proname IN (${functions}))`,
    ),
  );
}

function physicalConstraintNames(databaseName: string): string[] {
  const raw = runPsql(
    databaseName,
    `SELECT conname FROM pg_constraint
     WHERE conname IN (${D86_CONSTRAINTS.map(sqlValue).join(',')})
     ORDER BY conname`,
  );
  return raw === '' ? [] : raw.split('\n');
}

function physicalNameLengths(databaseName: string): Array<{ name: string; bytes: number }> {
  const raw = runPsql(
    databaseName,
    `SELECT conname || ':' || octet_length(conname)
     FROM pg_constraint WHERE conname IN (${D86_CONSTRAINTS.map(sqlValue).join(',')})
     ORDER BY conname`,
  );
  return raw === ''
    ? []
    : raw.split('\n').map((line) => {
        const [name, bytes] = line.split(':');
        return { name, bytes: Number(bytes) };
      });
}

function allocationRows(databaseName: string): string {
  return runPsql(
    databaseName,
    `SELECT json_build_object(
       'batches', (SELECT json_agg(to_jsonb(b) ORDER BY b.id) FROM "ActivityAllocationBatch" b),
       'candidates', (SELECT json_agg(to_jsonb(c) ORDER BY c.id) FROM "ActivityAllocationCandidate" c),
       'revisions', (SELECT json_agg(to_jsonb(r) ORDER BY r.id) FROM "ActivityParticipationRevision" r)
     )::text`,
  );
}

function migrationDiffFromDatabase(databaseName: string): string {
  return execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      scratchDatabaseUrl(databaseName),
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function introspectedSchema(databaseName: string): string {
  return execFileSync(
    'pnpm',
    ['exec', 'prisma', 'db', 'pull', '--url', scratchDatabaseUrl(databaseName), '--print'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scratchDatabaseUrl(databaseName) },
      encoding: 'utf8',
      maxBuffer: 10_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function migrationDiffFromMigrations(): string {
  const shadowDatabaseName = recreateEmptyShadowDatabase();
  try {
    return execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-migrations',
        'prisma/migrations',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--shadow-database-url',
        scratchDatabaseUrl(shadowDatabaseName),
        '--script',
      ],
      {
        cwd: process.cwd(),
        // --from-migrations 会清空 shadow；datasource 不能与 shadow 指向同一库，
        // 否则 Prisma 在完成 shadow 生命周期后会再读取一个已被清理的 datasource。
        env: {
          ...process.env,
          DATABASE_URL: scratchDatabaseUrl(deriveWorkerTestDbName(SCRATCH_WORKER_ID)),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } finally {
    dropWorkerDatabase(SHADOW_WORKER_ID);
  }
}

const mutationCases: MutationCase[] = [
  {
    name: 'receipt activity-command-operation key uniqueness mutation',
    beginMarker: '-- allocation-d86:receipt-key-unique:begin',
    endMarker: '-- allocation-d86:receipt-key-unique:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-receipt-key-a'));
      runPsql(databaseName, batchSql(fixture, 'batch-receipt-key-b'));
      runPsql(
        databaseName,
        receiptSql(fixture, 'receipt-receipt-key-a', 'batch-receipt-key-a', 'prepare', {
          operationKey: 'same-operation-key',
        }),
      );
    },
    probe: (fixture) => ({
      sql: receiptSql(fixture, 'receipt-receipt-key-b', 'batch-receipt-key-b', 'prepare', {
        operationKey: 'same-operation-key',
        requestHash: HASH_C,
      }),
      sqlState: '23505',
      constraintOrKey: 'activity_allocation_command_receipt_activity_command_key',
    }),
  },
  {
    name: 'receipt activity-batch composite anchor mutation',
    beginMarker: '-- allocation-d86:receipt-batch-anchor:begin',
    endMarker: '-- allocation-d86:receipt-batch-anchor:end',
    setup: (databaseName, fixture) => {
      runPsql(databaseName, batchSql(fixture, 'batch-receipt-anchor'));
    },
    probe: (fixture) => ({
      sql: receiptSql(fixture, 'receipt-wrong-activity', 'batch-receipt-anchor', 'prepare', {
        activityId: 'wrong-activity-anchor',
      }),
      sqlState: '23503',
      constraintOrKey: 'activity_allocation_command_receipt_batch_anchor_fkey',
    }),
  },
  {
    name: 'void fact shape mutation',
    beginMarker: '-- allocation-d86:void-shape:begin',
    endMarker: '-- allocation-d86:void-shape:end',
    setup: () => undefined,
    probe: (fixture) => ({
      sql: batchSql(fixture, 'batch-void-blank-reason', {
        statusCode: 'voided',
        voidReason: '   ',
      }),
      sqlState: '23514',
      constraintOrKey: 'activity_allocation_batch_void_shape_check',
    }),
  },
  {
    name: 'projection candidate one-to-one mutation',
    beginMarker: '-- allocation-d86:projection-one-to-one:begin',
    endMarker: '-- allocation-d86:projection-one-to-one:end',
    setup: (databaseName, fixture) => {
      const subject = insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-projection-one-to-one',
        'allocated',
      );
      runPsql(
        databaseName,
        projectionSql(fixture, 'projection-one-to-one-first', {
          allocationBatchId: subject.batchId,
          allocationCandidateId: subject.candidateId,
          appliedParticipationRevisionId: subject.revisionId,
          appliedResultCode: 'allocated',
        }),
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-one-to-one-second', {
        allocationBatchId: 'batch-mutation-projection-one-to-one',
        allocationCandidateId: 'candidate-mutation-projection-one-to-one',
        appliedParticipationRevisionId: 'revision-mutation-projection-one-to-one',
        appliedResultCode: 'allocated',
      }),
      sqlState: '23505',
      constraintOrKey: 'activity_allocation_application_projection_candidate_key',
    }),
  },
  {
    name: 'projection candidate-batch-identity composite anchor mutation',
    beginMarker: '-- allocation-d86:projection-candidate-anchor:begin',
    endMarker: '-- allocation-d86:projection-candidate-anchor:end',
    setup: (databaseName, fixture) => {
      runPsql(
        databaseName,
        batchSql(fixture, 'batch-candidate-anchor-a', { statusCode: 'committed' }),
      );
      runPsql(
        databaseName,
        batchSql(fixture, 'batch-candidate-anchor-b', { statusCode: 'committed' }),
      );
      runPsql(
        databaseName,
        candidateSql(fixture, 'candidate-candidate-anchor-a', {
          allocationBatchId: 'batch-candidate-anchor-a',
          resultCode: 'waitlisted',
        }),
      );
      runPsql(
        databaseName,
        revisionSql(fixture, 'revision-candidate-anchor-b', {
          allocationBatchId: 'batch-candidate-anchor-b',
          statusCode: 'waitlisted',
          revision: 1,
        }),
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-candidate-anchor-wrong-batch', {
        allocationBatchId: 'batch-candidate-anchor-b',
        allocationCandidateId: 'candidate-candidate-anchor-a',
        appliedParticipationRevisionId: 'revision-candidate-anchor-b',
        appliedResultCode: 'waitlisted',
      }),
      sqlState: '23503',
      constraintOrKey: 'activity_allocation_app_projection_candidate_anchor_fkey',
    }),
  },
  {
    name: 'allocated pointer and reservation shape mutation',
    beginMarker: '-- allocation-d86:projection-active-reservation-shape:begin',
    endMarker: '-- allocation-d86:projection-active-reservation-shape:end',
    setup: (databaseName, fixture) => {
      insertProjectionSubject(databaseName, fixture, 'mutation-active-shape', 'allocated');
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-missing-session-pointer', {
        allocationBatchId: 'batch-mutation-active-shape',
        allocationCandidateId: 'candidate-mutation-active-shape',
        appliedParticipationRevisionId: 'revision-mutation-active-shape',
        appliedResultCode: 'allocated',
        expectedIdentityCapacityReservationId: null,
        sessionReservationId: null,
        sessionBucketId: null,
      }),
      sqlState: '23514',
      constraintOrKey: 'activity_allocation_app_projection_active_res_shape_check',
    }),
  },
  {
    name: 'inactive projection clears every reservation fact mutation',
    beginMarker: '-- allocation-d86:projection-inactive-clear-shape:begin',
    endMarker: '-- allocation-d86:projection-inactive-clear-shape:end',
    setup: (databaseName, fixture) => {
      insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-inactive-shape',
        'waitlisted',
        fixture.identityId2,
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-waitlist-residual-reservation', {
        allocationBatchId: 'batch-mutation-inactive-shape',
        allocationCandidateId: 'candidate-mutation-inactive-shape',
        participationIdentityId: fixture.identityId2,
        appliedParticipationRevisionId: 'revision-mutation-inactive-shape',
        appliedResultCode: 'waitlisted',
        sessionReservationId: fixture.identity2SessionReservationId,
        sessionBucketId: fixture.sessionBucketId,
      }),
      sqlState: '23514',
      constraintOrKey: 'activity_allocation_app_projection_inactive_clear_check',
    }),
  },
  {
    name: 'projection identity member anchor mutation',
    beginMarker: '-- allocation-d86:projection-identity-member-anchor:begin',
    endMarker: '-- allocation-d86:projection-identity-member-anchor:end',
    setup: (databaseName, fixture) => {
      insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-identity-member-anchor',
        'allocated',
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-identity-member-anchor', {
        allocationBatchId: 'batch-mutation-identity-member-anchor',
        allocationCandidateId: 'candidate-mutation-identity-member-anchor',
        appliedParticipationRevisionId: 'revision-mutation-identity-member-anchor',
        appliedResultCode: 'allocated',
        memberId: fixture.memberId2,
        activityPersonReservationId: fixture.member2ActivityPersonReservationId,
      }),
      sqlState: '23503',
      constraintOrKey: 'activity_allocation_app_projection_identity_anchor_fkey',
    }),
  },
  {
    name: 'projection activity-person member/activity reservation anchor mutation',
    beginMarker: '-- allocation-d86:projection-activity-person-reservation-anchor:begin',
    endMarker: '-- allocation-d86:projection-activity-person-reservation-anchor:end',
    setup: (databaseName, fixture) => {
      insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-activity-person-anchor',
        'allocated',
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-activity-person-anchor', {
        allocationBatchId: 'batch-mutation-activity-person-anchor',
        allocationCandidateId: 'candidate-mutation-activity-person-anchor',
        appliedParticipationRevisionId: 'revision-mutation-activity-person-anchor',
        appliedResultCode: 'allocated',
        activityPersonReservationId: fixture.member2ActivityPersonReservationId,
      }),
      sqlState: '23503',
      constraintOrKey: 'activity_allocation_app_projection_activity_reservation_fkey',
    }),
  },
  {
    name: 'projection session identity reservation anchor mutation',
    beginMarker: '-- allocation-d86:projection-session-reservation-anchor:begin',
    endMarker: '-- allocation-d86:projection-session-reservation-anchor:end',
    setup: (databaseName, fixture) => {
      insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-session-reservation-anchor',
        'allocated',
      );
    },
    probe: (fixture) => ({
      sql: projectionSql(fixture, 'projection-session-reservation-anchor', {
        allocationBatchId: 'batch-mutation-session-reservation-anchor',
        allocationCandidateId: 'candidate-mutation-session-reservation-anchor',
        appliedParticipationRevisionId: 'revision-mutation-session-reservation-anchor',
        appliedResultCode: 'allocated',
        expectedIdentityCapacityReservationId: fixture.identity2SessionReservationId,
        sessionReservationId: fixture.identity2SessionReservationId,
      }),
      sqlState: '23503',
      constraintOrKey: 'activity_allocation_app_projection_session_reservation_fkey',
    }),
  },
  {
    name: 'projection immutable trigger mutation',
    beginMarker: '-- allocation-d86:projection-immutable-trigger:begin',
    endMarker: '-- allocation-d86:projection-immutable-trigger:end',
    setup: (databaseName, fixture) => {
      const subject = insertProjectionSubject(
        databaseName,
        fixture,
        'mutation-projection-immutable',
        'allocated',
      );
      runPsql(
        databaseName,
        projectionSql(fixture, 'projection-mutation-immutable', {
          allocationBatchId: subject.batchId,
          allocationCandidateId: subject.candidateId,
          appliedParticipationRevisionId: subject.revisionId,
          appliedResultCode: 'allocated',
        }),
      );
    },
    probe: () => ({
      sql: `UPDATE "ActivityAllocationApplicationProjection"
            SET "appliedAt" = TIMESTAMP '2099-08-13 09:30:00'
            WHERE "id" = 'projection-mutation-immutable'`,
      sqlState: '55000',
      constraintOrKey: 'activity_allocation_application_projection_immutable',
    }),
  },
];

describe('Activity v1.1 batch4 allocation command replay migration', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
    dropWorkerDatabase(SHADOW_WORKER_ID);
  });

  it('contains one atomic DDL transaction, no business DML, fixed response hash input, and exact composite schema relations', () => {
    const migration = migrationSource();
    const executable = migration.replace(/^\s*--.*$/gm, '');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
    expect(executable).not.toContain('IF EXISTS');
    const lockOrder = [
      'LOCK TABLE "User"',
      'LOCK TABLE "Activity"',
      'LOCK TABLE "ActivitySession"',
      'LOCK TABLE "ActivitySessionPosition"',
      'LOCK TABLE "ActivityParticipationIdentity"',
      'LOCK TABLE "ActivityParticipationRevision"',
      'LOCK TABLE "ActivityCapacityBucket"',
      'LOCK TABLE "CapacityReservation"',
      'LOCK TABLE "ActivityAllocationBatch"',
      'LOCK TABLE "ActivityAllocationCandidate"',
    ].map((needle) => migration.indexOf(needle));
    expect(lockOrder.every((offset) => offset >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b));

    const canonical = canonicalReceiptPayload('activity-a', 'batch-a', 'prepare');
    expect(canonical).toBe(
      '{"activityId":"activity-a","allocationBatchId":"batch-a","batchStatusCode":"preparing","commandCode":"prepare","responseSchemaVersion":"allocation-command-response-v1"}',
    );
    expect(responseHash('activity-a', 'batch-a', 'prepare')).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
    expect(canonical).not.toContain('responseHash');
    expect(migration).toContain('JSONB 对象本身不承诺键顺序');

    const schema = readFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain(
      '@relation("AllocationBatchCommandReceipts", fields: [allocationBatchId, activityId], references: [id, activityId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_command_receipt_batch_anchor_fkey")',
    );
    expect(schema).toContain(
      '@relation("AllocationCandidateApplicationProjection", fields: [allocationCandidateId, allocationBatchId, participationIdentityId, activityId, sessionId], references: [id, allocationBatchId, participationIdentityId, activityId, sessionId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_app_projection_candidate_anchor_fkey")',
    );
    expect(schema).toContain(
      '@@unique([id, activityId, sessionId, memberId], map: "activity_participation_identity_id_activity_session_member_key")',
    );
    expect(schema).toContain(
      '@@unique([id, memberId, activityId, bucketId], map: "capacity_reservation_id_member_activity_bucket_unique")',
    );
    expect(schema).toContain(
      '@relation("AllocationApplicationProjectionIdentity", fields: [participationIdentityId, activityId, sessionId, memberId], references: [id, activityId, sessionId, memberId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_app_projection_identity_anchor_fkey")',
    );
    expect(schema).toContain(
      '@relation("AllocationApplicationProjectionActivityPersonReservation", fields: [activityPersonReservationId, memberId, activityId, activityPersonBucketId], references: [id, memberId, activityId, bucketId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_app_projection_activity_reservation_fkey")',
    );
    expect(schema).toContain(
      '@relation("AllocationApplicationProjectionSessionReservation", fields: [sessionReservationId, participationIdentityId, sessionBucketId], references: [id, identityId, bucketId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_app_projection_session_reservation_fkey")',
    );
    expect(schema).toContain(
      '@relation("AllocationApplicationProjectionPositionReservation", fields: [positionReservationId, participationIdentityId, positionBucketId], references: [id, identityId, bucketId], onDelete: Restrict, onUpdate: Restrict, map: "activity_allocation_app_projection_position_reservation_fkey")',
    );
    expect(schema).not.toContain('activity_allocation_app_projection_candidate_anchor_unique');
  });

  it(
    'upgrades a true D85 database through current D87 with no D86 migration/schema drift and exposes D86 relations by introspection',
    () => {
      const databaseName = recreateMigration85Scratch();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        const sourceDiff = migrationDiffFromMigrations();
        const after = migrationDiffFromDatabase(databaseName);
        expect(sourceDiff).toBe(EXPECTED_PRISMA_CURRENT_DIFF);
        expect(after).toBe(EXPECTED_PRISMA_CURRENT_DIFF);
        const pulled = introspectedSchema(databaseName);
        expect(pulled).toContain('model ActivityAllocationCommandReceipt');
        expect(pulled).toContain('model ActivityAllocationApplicationProjection');
        expect(pulled).toContain('activity_allocation_command_receipt_batch_anchor_fkey');
        expect(pulled).toContain('activity_allocation_app_projection_candidate_anchor_fkey');
        expect(d86ArtifactCount(databaseName)).toBe(
          2 + 2 + 1 + D86_CONSTRAINTS.length + D86_TRIGGERS.length + D86_FUNCTIONS.length,
        );
        expect(physicalConstraintNames(databaseName)).toEqual([...D86_CONSTRAINTS].sort());
        expect(physicalNameLengths(databaseName).every(({ bytes }) => bytes <= 63)).toBe(true);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    `replays all ${CURRENT_MIGRATION_COUNT} migrations from empty and accepts prepare, commit, void receipts plus every legal projection shape`,
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
        const fixture = createFixture(databaseName, 'legal-shapes');

        runPsql(databaseName, batchSql(fixture, 'batch-receipt-prepare'));
        runPsql(
          databaseName,
          batchSql(fixture, 'batch-receipt-commit', { statusCode: 'committed' }),
        );
        runPsql(databaseName, batchSql(fixture, 'batch-receipt-void', { statusCode: 'voided' }));
        runPsql(
          databaseName,
          receiptSql(fixture, 'receipt-prepare', 'batch-receipt-prepare', 'prepare'),
        );
        runPsql(
          databaseName,
          receiptSql(fixture, 'receipt-commit', 'batch-receipt-commit', 'commit'),
        );
        runPsql(databaseName, receiptSql(fixture, 'receipt-void', 'batch-receipt-void', 'void'));

        const allocatedNoPosition = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-allocated-no-position',
          'allocated',
          fixture.identityId,
          1,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-allocated-no-position', {
            allocationBatchId: allocatedNoPosition.batchId,
            allocationCandidateId: allocatedNoPosition.candidateId,
            appliedParticipationRevisionId: allocatedNoPosition.revisionId,
            appliedResultCode: 'allocated',
          }),
        );
        const allocatedPosition = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-allocated-position',
          'allocated',
          fixture.identityId,
          2,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-allocated-position', {
            allocationBatchId: allocatedPosition.batchId,
            allocationCandidateId: allocatedPosition.candidateId,
            appliedParticipationRevisionId: allocatedPosition.revisionId,
            appliedResultCode: 'allocated',
            positionId: fixture.positionId,
            positionReservationId: fixture.positionReservationId,
            positionBucketId: fixture.positionBucketId,
          }),
        );
        const sharedActivityPersonFirstSession = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-shared-activity-person-first-session',
          'allocated',
          fixture.identityId,
          3,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-shared-activity-person-first-session', {
            allocationBatchId: sharedActivityPersonFirstSession.batchId,
            allocationCandidateId: sharedActivityPersonFirstSession.candidateId,
            appliedParticipationRevisionId: sharedActivityPersonFirstSession.revisionId,
            appliedResultCode: 'allocated',
          }),
        );
        const sharedActivityPersonSecondSession = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-shared-activity-person-second-session',
          'allocated',
          fixture.sameMemberSecondSessionIdentityId,
          1,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-shared-activity-person-second-session', {
            allocationBatchId: sharedActivityPersonSecondSession.batchId,
            allocationCandidateId: sharedActivityPersonSecondSession.candidateId,
            participationIdentityId: sharedActivityPersonSecondSession.identityId,
            appliedParticipationRevisionId: sharedActivityPersonSecondSession.revisionId,
            appliedResultCode: 'allocated',
          }),
        );
        expect(
          runPsql(
            databaseName,
            `SELECT COUNT(*) || ':' || COUNT(DISTINCT p."activityPersonReservationId") || ':' ||
                    COUNT(DISTINCT p."sessionReservationId") || ':' ||
                    COUNT(*) FILTER (WHERE p."expectedIdentityCapacityReservationId" = i."capacityReservationId")
             FROM "ActivityAllocationApplicationProjection" p
             JOIN "ActivityParticipationIdentity" i ON i."id" = p."participationIdentityId"
             WHERE p."id" IN
               ('projection-shared-activity-person-first-session',
                'projection-shared-activity-person-second-session')`,
          ),
        ).toBe('2:1:2:2');
        const waitlisted = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-waitlisted',
          'waitlisted',
          fixture.identityId2,
          1,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-waitlisted', {
            allocationBatchId: waitlisted.batchId,
            allocationCandidateId: waitlisted.candidateId,
            participationIdentityId: waitlisted.identityId,
            appliedParticipationRevisionId: waitlisted.revisionId,
            appliedResultCode: 'waitlisted',
          }),
        );
        const notSelected = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'legal-not-selected',
          'not_selected',
          fixture.identityId2,
          2,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-not-selected', {
            allocationBatchId: notSelected.batchId,
            allocationCandidateId: notSelected.candidateId,
            participationIdentityId: notSelected.identityId,
            appliedParticipationRevisionId: notSelected.revisionId,
            appliedResultCode: 'not_selected',
          }),
        );
        expect(
          runPsql(
            databaseName,
            `SELECT COUNT(*) || ':' || COUNT(*) FILTER (WHERE "populationIncluded")
             FROM "ActivityAllocationApplicationProjection"`,
          ),
        ).toBe('6:4');
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'rejects receipt replay conflicts, unsafe receipt JSON, void shape violations, and both immutable tables',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        const fixture = createFixture(databaseName, 'receipt-and-void');
        runPsql(databaseName, batchSql(fixture, 'batch-receipt-key-a'));
        runPsql(databaseName, batchSql(fixture, 'batch-receipt-key-b'));
        runPsql(
          databaseName,
          receiptSql(fixture, 'receipt-key-a', 'batch-receipt-key-a', 'prepare', {
            operationKey: 'same-key',
          }),
        );
        expectSqlFailure(
          databaseName,
          receiptSql(fixture, 'receipt-key-b', 'batch-receipt-key-b', 'prepare', {
            operationKey: 'same-key',
            requestHash: HASH_C,
          }),
          '23505',
          'activity_allocation_command_receipt_activity_command_key',
        );
        expectSqlFailure(
          databaseName,
          receiptSql(fixture, 'receipt-batch-command', 'batch-receipt-key-a', 'prepare', {
            operationKey: 'other-key',
          }),
          '23505',
          'activity_allocation_command_receipt_batch_command_key',
        );
        expectSqlFailure(
          databaseName,
          receiptSql(fixture, 'receipt-wrong-anchor', 'batch-receipt-key-b', 'prepare', {
            activityId: 'wrong-activity',
          }),
          '23503',
          'activity_allocation_command_receipt_batch_anchor_fkey',
        );
        expectSqlFailure(
          databaseName,
          receiptSql(fixture, 'receipt-operation-tail-space', 'batch-receipt-key-b', 'prepare', {
            operationKey: `x${' '.repeat(128)}`,
          }),
          '23514',
          'activity_allocation_command_receipt_operation_key_shape_check',
        );
        const unsafeResponse = {
          activityId: fixture.activityId,
          allocationBatchId: 'batch-receipt-key-b',
          commandCode: 'prepare',
          batchStatusCode: 'preparing',
          responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
          responseHash: responseHash(fixture.activityId, 'batch-receipt-key-b', 'prepare'),
          randomSeedReveal: HASH_A,
        };
        expectSqlFailure(
          databaseName,
          receiptSql(fixture, 'receipt-unsafe-json', 'batch-receipt-key-b', 'prepare', {
            responseReceipt: unsafeResponse,
          }),
          '23514',
          'activity_allocation_command_receipt_response_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'batch-void-blank', { statusCode: 'voided', voidReason: '  ' }),
          '23514',
          'activity_allocation_batch_void_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'batch-void-long', {
            statusCode: 'voided',
            voidReason: 'v'.repeat(501),
          }),
          '23514',
          'activity_allocation_batch_void_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'batch-void-tail-space', {
            statusCode: 'voided',
            voidReason: `v${' '.repeat(500)}`,
          }),
          '23514',
          'activity_allocation_batch_void_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'batch-preparing-void-fact', {
            voidReason: 'unexpected',
            voidedAt: ACCEPTED_AT,
          }),
          '23514',
          'activity_allocation_batch_void_shape_check',
        );
        expectSqlFailure(
          databaseName,
          batchSql(fixture, 'batch-committed-void-fact', {
            statusCode: 'committed',
            voidReason: 'unexpected',
            voidedAt: ACCEPTED_AT,
          }),
          '23514',
          'activity_allocation_batch_void_shape_check',
        );
        expectSqlFailure(
          databaseName,
          `UPDATE "ActivityAllocationCommandReceipt" SET "requestHash" = ${sqlValue(HASH_C)}
           WHERE "id" = 'receipt-key-a'`,
          '55000',
          'activity_allocation_command_receipt_immutable',
        );
        expectSqlFailure(
          databaseName,
          `DELETE FROM "ActivityAllocationCommandReceipt" WHERE "id" = 'receipt-key-a'`,
          '55000',
          'activity_allocation_command_receipt_immutable',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'rejects projection batch, candidate, identity, revision and reservation shape violations while preserving candidate preparing mutability',
    () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        const fixture = createFixture(databaseName, 'projection-violations');
        const missingPointer = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'missing-pointer',
          'allocated',
          fixture.identityId,
          1,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-missing-pointer', {
            allocationBatchId: missingPointer.batchId,
            allocationCandidateId: missingPointer.candidateId,
            appliedParticipationRevisionId: missingPointer.revisionId,
            appliedResultCode: 'allocated',
            expectedIdentityCapacityReservationId: null,
            sessionReservationId: null,
            sessionBucketId: null,
          }),
          '23514',
          'activity_allocation_app_projection_active_res_shape_check',
        );
        const wrongPopulation = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'wrong-population',
          'allocated',
          fixture.identityId,
          2,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-population', {
            allocationBatchId: wrongPopulation.batchId,
            allocationCandidateId: wrongPopulation.candidateId,
            appliedParticipationRevisionId: wrongPopulation.revisionId,
            appliedResultCode: 'allocated',
            populationIncluded: false,
          }),
          '23514',
          'activity_allocation_app_projection_result_status_check',
        );
        const positionHalf = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'position-half',
          'allocated',
          fixture.identityId,
          3,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-position-half', {
            allocationBatchId: positionHalf.batchId,
            allocationCandidateId: positionHalf.candidateId,
            appliedParticipationRevisionId: positionHalf.revisionId,
            appliedResultCode: 'allocated',
            positionId: fixture.positionId,
          }),
          '23514',
          'activity_allocation_app_projection_position_shape_check',
        );
        const reservationHalf = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'reservation-half',
          'allocated',
          fixture.identityId,
          4,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-reservation-half', {
            allocationBatchId: reservationHalf.batchId,
            allocationCandidateId: reservationHalf.candidateId,
            appliedParticipationRevisionId: reservationHalf.revisionId,
            appliedResultCode: 'allocated',
            sessionBucketId: null,
          }),
          '23514',
          'activity_allocation_app_projection_active_res_shape_check',
        );
        const inactiveResidual = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'inactive-residual',
          'waitlisted',
          fixture.identityId2,
          1,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-inactive-residual', {
            allocationBatchId: inactiveResidual.batchId,
            allocationCandidateId: inactiveResidual.candidateId,
            participationIdentityId: fixture.identityId2,
            appliedParticipationRevisionId: inactiveResidual.revisionId,
            appliedResultCode: 'waitlisted',
            sessionReservationId: fixture.identity2SessionReservationId,
            sessionBucketId: fixture.sessionBucketId,
          }),
          '23514',
          'activity_allocation_app_projection_inactive_clear_check',
        );

        runPsql(databaseName, batchSql(fixture, 'batch-anchor-a', { statusCode: 'committed' }));
        runPsql(databaseName, batchSql(fixture, 'batch-anchor-b', { statusCode: 'committed' }));
        runPsql(
          databaseName,
          currentCandidateSql(fixture, 'candidate-anchor-a', {
            allocationBatchId: 'batch-anchor-a',
            resultCode: 'waitlisted',
          }),
        );
        runPsql(
          databaseName,
          revisionSql(fixture, 'revision-anchor-b', {
            allocationBatchId: 'batch-anchor-b',
            statusCode: 'waitlisted',
            revision: 5,
          }),
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-candidate-batch', {
            allocationBatchId: 'batch-anchor-b',
            allocationCandidateId: 'candidate-anchor-a',
            appliedParticipationRevisionId: 'revision-anchor-b',
            appliedResultCode: 'waitlisted',
          }),
          '23503',
          'activity_allocation_app_projection_candidate_anchor_fkey',
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-revision-batch', {
            allocationBatchId: 'batch-anchor-a',
            allocationCandidateId: 'candidate-anchor-a',
            appliedParticipationRevisionId: 'revision-anchor-b',
            appliedResultCode: 'waitlisted',
          }),
          '23503',
          'activity_allocation_app_projection_revision_anchor_fkey',
        );

        const wrongMemberReservation = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'wrong-member-activity-person-reservation',
          'allocated',
          fixture.identityId,
          7,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-member-activity-person-reservation', {
            allocationBatchId: wrongMemberReservation.batchId,
            allocationCandidateId: wrongMemberReservation.candidateId,
            appliedParticipationRevisionId: wrongMemberReservation.revisionId,
            appliedResultCode: 'allocated',
            activityPersonReservationId: fixture.member2ActivityPersonReservationId,
          }),
          '23503',
          'activity_allocation_app_projection_activity_reservation_fkey',
        );

        const wrongActivityReservation = createWrongActivityPersonReservation(
          databaseName,
          fixture,
        );
        const wrongActivity = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'wrong-activity-activity-person-reservation',
          'allocated',
          fixture.identityId,
          8,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-activity-activity-person-reservation', {
            allocationBatchId: wrongActivity.batchId,
            allocationCandidateId: wrongActivity.candidateId,
            appliedParticipationRevisionId: wrongActivity.revisionId,
            appliedResultCode: 'allocated',
            activityPersonReservationId: wrongActivityReservation.reservationId,
          }),
          '23503',
          'activity_allocation_app_projection_activity_reservation_fkey',
        );

        const wrongSessionReservation = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'wrong-session-reservation',
          'allocated',
          fixture.identityId,
          9,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-session-reservation', {
            allocationBatchId: wrongSessionReservation.batchId,
            allocationCandidateId: wrongSessionReservation.candidateId,
            appliedParticipationRevisionId: wrongSessionReservation.revisionId,
            appliedResultCode: 'allocated',
            expectedIdentityCapacityReservationId: fixture.identity2SessionReservationId,
            sessionReservationId: fixture.identity2SessionReservationId,
          }),
          '23503',
          'activity_allocation_app_projection_session_reservation_fkey',
        );

        const wrongPositionReservation = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'wrong-position-reservation',
          'allocated',
          fixture.identityId,
          10,
        );
        expectSqlFailure(
          databaseName,
          projectionSql(fixture, 'projection-wrong-position-reservation', {
            allocationBatchId: wrongPositionReservation.batchId,
            allocationCandidateId: wrongPositionReservation.candidateId,
            appliedParticipationRevisionId: wrongPositionReservation.revisionId,
            appliedResultCode: 'allocated',
            positionId: fixture.positionId,
            positionReservationId: fixture.identity2PositionReservationId,
            positionBucketId: fixture.positionBucketId,
          }),
          '23503',
          'activity_allocation_app_projection_position_reservation_fkey',
        );

        runPsql(databaseName, batchSql(fixture, 'batch-preparing-mutability'));
        runPsql(
          databaseName,
          currentCandidateSql(fixture, 'candidate-preparing-mutability', {
            allocationBatchId: 'batch-preparing-mutability',
          }),
        );
        runPsql(
          databaseName,
          `UPDATE "ActivityAllocationCandidate" SET "tieBreakKey" = 'changed-in-preparing'
           WHERE "id" = 'candidate-preparing-mutability'`,
        );
        expect(
          runPsql(
            databaseName,
            `SELECT COUNT(*) FROM pg_trigger
             WHERE tgrelid = '"ActivityAllocationCandidate"'::regclass AND NOT tgisinternal`,
          ),
        ).toBe('0');

        const immutable = insertCurrentProjectionSubject(
          databaseName,
          fixture,
          'projection-immutable',
          'allocated',
          fixture.identityId,
          6,
        );
        runPsql(
          databaseName,
          projectionSql(fixture, 'projection-immutable', {
            allocationBatchId: immutable.batchId,
            allocationCandidateId: immutable.candidateId,
            appliedParticipationRevisionId: immutable.revisionId,
            appliedResultCode: 'allocated',
          }),
        );
        expectSqlFailure(
          databaseName,
          `UPDATE "ActivityAllocationApplicationProjection" SET "appliedAt" = TIMESTAMP '2099-08-13 09:30:00'
           WHERE "id" = 'projection-immutable'`,
          '55000',
          'activity_allocation_application_projection_immutable',
        );
        expectSqlFailure(
          databaseName,
          `DELETE FROM "ActivityAllocationApplicationProjection" WHERE "id" = 'projection-immutable'`,
          '55000',
          'activity_allocation_application_projection_immutable',
        );
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'fails atomically on nonempty D85 allocation facts without backfill or business identifiers',
    () => {
      const databaseName = recreateMigration85Scratch();
      try {
        const fixture = createFixture(databaseName, 'nonempty');
        runPsql(databaseName, legacyBatchSql(fixture, 'legacy-batch'));
        const rowsBefore = allocationRows(databaseName);
        const failure = runPsqlFailure(databaseName, migrationSource());
        expect(failure).toContain('23514');
        expect(failure).toContain('batches=1, candidates=0, revisions=0');
        expect(failure).not.toContain('legacy-batch');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_85_COUNT);
        expect(d86ArtifactCount(databaseName)).toBe(0);
        expect(allocationRows(databaseName)).toBe(rowsBefore);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it(
    'rolls back every D86 table, column, constraint, function, and trigger when late DDL fails',
    () => {
      const databaseName = recreateMigration85Scratch();
      try {
        const source = migrationSource();
        const failing = source.replace(
          /\nCOMMIT;\s*$/,
          `\nDO $allocation_d86_late_failure$\nBEGIN\n  RAISE EXCEPTION 'allocation D86 late failure';\nEND\n$allocation_d86_late_failure$;\n\nCOMMIT;\n`,
        );
        expect(failing).not.toBe(source);
        const failure = runPsqlFailure(databaseName, failing);
        expect(failure).toContain('allocation D86 late failure');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_85_COUNT);
        expect(d86ArtifactCount(databaseName)).toBe(0);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );

  it.each(mutationCases)(
    '$name first rejects its positive control and then turns only that control green',
    ({ beginMarker, endMarker, setup, probe }) => {
      let databaseName = recreateMigration85Scratch();
      try {
        runPsql(databaseName, migrationSource());
        let fixture = createFixture(databaseName, 'mutation-control');
        setup(databaseName, fixture);
        const control = probe(fixture);
        expectSqlFailure(databaseName, control.sql, control.sqlState, control.constraintOrKey);

        databaseName = recreateMigration85Scratch();
        const mutated = removeMarkedBlock(migrationSource(), beginMarker, endMarker);
        expect(mutated).not.toBe(migrationSource());
        runPsql(databaseName, mutated);
        fixture = createFixture(databaseName, 'mutation-mutated');
        setup(databaseName, fixture);
        const recovered = probe(fixture);
        runPsql(databaseName, recovered.sql);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_REPLAY_TIMEOUT_MS,
  );
});
