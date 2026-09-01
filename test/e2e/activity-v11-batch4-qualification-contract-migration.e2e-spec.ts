import { PrismaClient } from '@prisma/client';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { assertDroppableTestDbName, dropWorkerDatabase } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const POSTGRES_CONTAINER = 'u-nest-api-postgres';
const SCRATCH_WORKER_ID = 83;
const MIGRATION_NAME = '20260809223000_activity_v11_batch4_qualification_contract_guards';
const MIGRATION_PATH = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;
const MIGRATION_82_COUNT = 82;
// ⚠️ 与上面的 MIGRATION_82_COUNT 是**两件事**:那个是第 83 刀之前的历史世代基线(冷库重放的起点),
// 恒为 82、随仓库增长**不变**;这个是仓库当前的 migration 总数,每加一刀就要 +1。
// 混改任何一个都会让「冷库 82→83 重放」那组用例的语义整个走样(issue #1055 T1 加第 91 刀时复核过)。
const CURRENT_MIGRATION_COUNT = 102;
// 这两例分别完整执行一次和五次冷库 82→83 重放；不能由 Jest 默认 30 秒截断。
const COLD_MIGRATION_REPLAY_TIMEOUT_MS = 180_000;

interface QualificationFixture {
  activityId: string;
  sessionId: string;
  positionId: string;
  otherActivityId: string;
  otherSessionId: string;
  otherPositionId: string;
}

interface LegacyStorageFixture extends QualificationFixture {
  ruleSetId: string;
  ruleId: string;
  snapshotId: string;
}

interface ObjectDefinition {
  name: string;
  definition: string;
}

interface TableObjectDefinitions {
  constraints: ObjectDefinition[];
  indexes: ObjectDefinition[];
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlJson(value: unknown): string {
  return `${sqlValue(JSON.stringify(value))}::jsonb`;
}

function scratchDatabaseUrl(databaseName: string): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for qualification migration E2E');
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
    {
      input: `\\set VERBOSITY verbose\n${sql}`,
      encoding: 'utf8',
    },
  );
  expect(result.status).not.toBe(0);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function successfulMigrationCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT COUNT(*)
       FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL`,
    ),
  );
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

function deployMigrationsThrough82(databaseName: string): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const migrationNames = readdirSync(sourceMigrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migration83Index = migrationNames.indexOf(MIGRATION_NAME);
  if (migration83Index !== MIGRATION_82_COUNT) {
    throw new Error(`expected ${MIGRATION_NAME} at migration index 82; got ${migration83Index}`);
  }

  const temporaryPrismaRoot = mkdtempSync(path.join(tmpdir(), 'srvf-qualification-82-prisma-'));
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const migrationName of migrationNames.slice(0, migration83Index)) {
      cpSync(
        path.join(sourceMigrationsRoot, migrationName),
        path.join(temporaryMigrationsRoot, migrationName),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
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

function recreateMigration82Scratch(): string {
  const databaseName = recreateEmptyScratchDatabase();
  try {
    deployMigrationsThrough82(databaseName);
    if (
      successfulMigrationCount(databaseName) !== MIGRATION_82_COUNT ||
      qualificationArtifactCount(databaseName) !== 0
    ) {
      throw new Error('failed to build an empty true-82 qualification migration scratch database');
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

function tableObjectDefinitions(databaseName: string): TableObjectDefinitions {
  return JSON.parse(
    runPsql(
      databaseName,
      `SELECT json_build_object(
         'constraints', COALESCE((
           SELECT json_agg(
             json_build_object('name', constraint_meta.conname, 'definition', pg_get_constraintdef(constraint_meta.oid))
             ORDER BY constraint_meta.conname
           )
           FROM pg_constraint constraint_meta
           WHERE constraint_meta.conrelid IN (
             '"ActivitySessionPosition"'::regclass,
             '"ActivityQualificationRuleSet"'::regclass,
             '"ActivityQualificationRule"'::regclass,
             '"QualificationEvaluationSnapshot"'::regclass
           )
         ), '[]'::json),
         'indexes', COALESCE((
           SELECT json_agg(
             json_build_object('name', index_class.relname, 'definition', pg_get_indexdef(index_meta.indexrelid))
             ORDER BY index_class.relname
           )
           FROM pg_index index_meta
           JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
           WHERE index_meta.indrelid IN (
             '"ActivitySessionPosition"'::regclass,
             '"ActivityQualificationRuleSet"'::regclass,
             '"ActivityQualificationRule"'::regclass,
             '"QualificationEvaluationSnapshot"'::regclass
           )
         ), '[]'::json)
       )::text`,
    ),
  ) as TableObjectDefinitions;
}

function preserveLegacyDefinitions(
  before: TableObjectDefinitions,
  after: TableObjectDefinitions,
): TableObjectDefinitions {
  const legacyConstraintNames = new Set(before.constraints.map((definition) => definition.name));
  const legacyIndexNames = new Set(before.indexes.map((definition) => definition.name));
  return {
    constraints: after.constraints.filter((definition) =>
      legacyConstraintNames.has(definition.name),
    ),
    indexes: after.indexes.filter((definition) => legacyIndexNames.has(definition.name)),
  };
}

function qualificationArtifactCount(databaseName: string): number {
  return Number(
    runPsql(
      databaseName,
      `SELECT COUNT(*)
       FROM (
         SELECT column_name AS artifact
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             (table_name = 'ActivityQualificationRule' AND column_name = 'warnScore')
             OR (table_name = 'QualificationEvaluationSnapshot' AND column_name = 'evaluationPhaseCode')
           )
         UNION ALL
         SELECT conname
         FROM pg_constraint
         WHERE conname IN (
           'activity_session_position_activity_session_id_key',
           'activity_qualification_rule_set_scope_pointer_key',
           'activity_qualification_rule_set_scope_shape_check',
           'activity_qualification_rule_set_status_code_check',
           'activity_qualification_rule_set_activity_session_position_fkey',
           'activity_session_position_qualification_rule_set_scope_fkey',
           'activity_qualification_rule_operator_value_json_check',
           'activity_qualification_rule_warn_score_check',
           'qualification_evaluation_snapshot_phase_code_check',
           'qualification_evaluation_snapshot_phase_anchor_check'
         )
         UNION ALL
         SELECT relname
         FROM pg_class
         WHERE relname IN (
           'activity_qualification_rule_set_scope_version_unique',
           'activity_qualification_rule_set_scope_active_unique'
         )
         UNION ALL
         SELECT tgname
         FROM pg_trigger
         WHERE NOT tgisinternal
           AND tgname IN (
             'trg_activity_qualification_rule_set_10_freeze',
             'trg_activity_qualification_rule_10_parent_freeze',
             'trg_qualification_evaluation_snapshot_10_append_only'
           )
         UNION ALL
         SELECT proname
         FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname IN (
             'activity_qualification_string_array_json_valid',
             'activity_qualification_age_range_json_valid',
             'activity_qualification_rule_set_freeze_guard',
             'activity_qualification_rule_parent_freeze_guard',
             'qualification_evaluation_snapshot_append_only_guard'
           )
       ) artifacts`,
    ),
  );
}

async function createQualificationFixture(
  databaseName: string,
  suffix: string,
): Promise<QualificationFixture> {
  const prisma = new PrismaClient({ datasourceUrl: scratchDatabaseUrl(databaseName) });
  const startAt = new Date('2099-06-01T09:00:00.000Z');
  const endAt = new Date('2099-06-01T17:00:00.000Z');
  try {
    const organization = await prisma.organization.create({
      data: { name: `qualification83 organization ${suffix}`, nodeTypeCode: 'qualification-83' },
      select: { id: true },
    });
    const activity = { id: `qualification83-activity-${suffix}` };
    runPsql(
      databaseName,
      `INSERT INTO "Activity"
         ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
       VALUES (${sqlValue(activity.id)},${sqlValue(`qualification83 activity ${suffix}`)},
         'qualification-83',${sqlValue(organization.id)},${sqlValue(startAt.toISOString())},
         ${sqlValue(endAt.toISOString())},'qualification migration fixture','draft',CURRENT_TIMESTAMP);`,
    );
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `qualification83-session-${suffix}`,
        name: `qualification83 session ${suffix}`,
        startAt,
        endAt,
        locationText: 'qualification migration fixture',
        checkInOpenAt: new Date('2099-06-01T08:00:00.000Z'),
        checkInCloseAt: new Date('2099-06-01T10:00:00.000Z'),
        checkOutOpenAt: new Date('2099-06-01T16:00:00.000Z'),
        checkOutCloseAt: new Date('2099-06-01T18:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `qualification83-position-${suffix}`,
        name: `qualification83 position ${suffix}`,
        attendanceRoleCode: 'volunteer',
      },
      select: { id: true },
    });
    const otherActivity = { id: `qualification83-other-activity-${suffix}` };
    runPsql(
      databaseName,
      `INSERT INTO "Activity"
         ("id","title","activityTypeCode","organizationId","startAt","endAt","location","statusCode","updatedAt")
       VALUES (${sqlValue(otherActivity.id)},${sqlValue(`qualification83 other activity ${suffix}`)},
         'qualification-83',${sqlValue(organization.id)},${sqlValue(startAt.toISOString())},
         ${sqlValue(endAt.toISOString())},'qualification migration fixture other','draft',CURRENT_TIMESTAMP);`,
    );
    const otherSession = await prisma.activitySession.create({
      data: {
        activityId: otherActivity.id,
        code: `qualification83-other-session-${suffix}`,
        name: `qualification83 other session ${suffix}`,
        startAt,
        endAt,
        locationText: 'qualification migration fixture other',
        checkInOpenAt: new Date('2099-06-01T08:00:00.000Z'),
        checkInCloseAt: new Date('2099-06-01T10:00:00.000Z'),
        checkOutOpenAt: new Date('2099-06-01T16:00:00.000Z'),
        checkOutCloseAt: new Date('2099-06-01T18:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const otherPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: otherActivity.id,
        sessionId: otherSession.id,
        code: `qualification83-other-position-${suffix}`,
        name: `qualification83 other position ${suffix}`,
        attendanceRoleCode: 'volunteer',
      },
      select: { id: true },
    });
    return {
      activityId: activity.id,
      sessionId: session.id,
      positionId: position.id,
      otherActivityId: otherActivity.id,
      otherSessionId: otherSession.id,
      otherPositionId: otherPosition.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function createQualificationSnapshotAnchors(
  databaseName: string,
  fixture: QualificationFixture,
  suffix: string,
): Promise<{ identityId: string; registrationRevisionId: string }> {
  const prisma = new PrismaClient({ datasourceUrl: scratchDatabaseUrl(databaseName) });
  try {
    const member = await prisma.member.create({
      data: {
        memberNo: `qualification83-member-${suffix}`,
        ...memberIdentityData(`qualification83 member ${suffix}`),
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: fixture.activityId, memberId: member.id, statusCode: 'pending' },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: fixture.activityId,
        sessionId: fixture.sessionId,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pending',
      },
      select: { id: true },
    });
    const registrationRevision = await prisma.activityRegistrationRevision.create({
      data: {
        registrationId: registration.id,
        revision: 1,
        sourceCode: 'self',
        submittedAt: new Date('2099-05-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    return { identityId: identity.id, registrationRevisionId: registrationRevision.id };
  } finally {
    await prisma.$disconnect();
  }
}

async function createLegacyStorageFixture(
  databaseName: string,
  suffix: string,
): Promise<LegacyStorageFixture> {
  const fixture = await createQualificationFixture(databaseName, suffix);
  const ruleSetId = `qualification83-ruleset-${suffix}`;
  const ruleId = `qualification83-rule-${suffix}`;
  const snapshotId = `qualification83-snapshot-${suffix}`;
  runPsql(
    databaseName,
    `INSERT INTO "ActivityQualificationRuleSet"
       ("id","activityId","sessionId","positionId","version","statusCode","updatedAt")
     VALUES (${sqlValue(ruleSetId)},${sqlValue(fixture.activityId)},${sqlValue(fixture.sessionId)},
       ${sqlValue(fixture.positionId)},1,'draft',CURRENT_TIMESTAMP);
     INSERT INTO "ActivityQualificationRule"
       ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","updatedAt")
     VALUES (${sqlValue(ruleId)},${sqlValue(ruleSetId)},'grade','block','eq',CURRENT_TIMESTAMP);
     INSERT INTO "QualificationEvaluationSnapshot"
       ("id","ruleSetVersionId","evaluatedAt","resultCode")
     VALUES (${sqlValue(snapshotId)},${sqlValue(ruleSetId)},TIMESTAMP '2099-05-01 00:00:00','pass');
     UPDATE "ActivitySessionPosition"
     SET "qualificationRuleSetId" = ${sqlValue(ruleSetId)}
     WHERE "id" = ${sqlValue(fixture.positionId)};`,
  );
  return { ...fixture, ruleSetId, ruleId, snapshotId };
}

function insertRuleSet(
  databaseName: string,
  id: string,
  fixture: QualificationFixture,
  version: number,
  statusCode: string,
  sessionId: string | null = null,
  positionId: string | null = null,
): void {
  runPsql(
    databaseName,
    `INSERT INTO "ActivityQualificationRuleSet"
       ("id","activityId","sessionId","positionId","version","statusCode","updatedAt")
     VALUES (${sqlValue(id)},${sqlValue(fixture.activityId)},
       ${sessionId === null ? 'NULL' : sqlValue(sessionId)},
       ${positionId === null ? 'NULL' : sqlValue(positionId)},
       ${version},${sqlValue(statusCode)},CURRENT_TIMESTAMP);`,
  );
}

function insertValidRule(databaseName: string, id: string, ruleSetId: string): void {
  runPsql(
    databaseName,
    `INSERT INTO "ActivityQualificationRule"
       ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","valueJson","warnScore","updatedAt")
     VALUES (${sqlValue(id)},${sqlValue(ruleSetId)},'grade','block','in',
       '{"codes":["fixture"]}'::jsonb,NULL,CURRENT_TIMESTAMP);`,
  );
}

function insertDisplaySnapshot(databaseName: string, id: string, ruleSetId: string): void {
  runPsql(
    databaseName,
    `INSERT INTO "QualificationEvaluationSnapshot"
       ("id","ruleSetVersionId","evaluatedAt","resultCode","evaluationPhaseCode")
     VALUES (${sqlValue(id)},${sqlValue(ruleSetId)},TIMESTAMP '2099-05-01 00:00:00','pass','display');`,
  );
}

function qualificationRows(databaseName: string, fixture: LegacyStorageFixture): string {
  return runPsql(
    databaseName,
    `SELECT json_build_object(
       'position', (SELECT to_jsonb(position) FROM "ActivitySessionPosition" position WHERE "id" = ${sqlValue(fixture.positionId)}),
       'ruleSet', (SELECT to_jsonb(rule_set) FROM "ActivityQualificationRuleSet" rule_set WHERE "id" = ${sqlValue(fixture.ruleSetId)}),
       'rule', (SELECT to_jsonb(rule) FROM "ActivityQualificationRule" rule WHERE "id" = ${sqlValue(fixture.ruleId)}),
       'snapshot', (SELECT to_jsonb(snapshot) FROM "QualificationEvaluationSnapshot" snapshot WHERE "id" = ${sqlValue(fixture.snapshotId)})
     )::text`,
  );
}

function removeMarkedBlock(source: string, beginMarker: string, endMarker: string): string {
  const start = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`expected migration marker pair ${beginMarker} / ${endMarker}`);
  }
  const afterEnd = end + endMarker.length;
  return `${source.slice(0, start)}${source.slice(afterEnd)}`;
}

function deployMutatedMigration(
  databaseName: string,
  mutationName: string,
  mutate: (source: string) => string,
): void {
  const prismaRoot = path.resolve(process.cwd(), 'prisma');
  const sourceMigrationsRoot = path.join(prismaRoot, 'migrations');
  const sourceMigrationPath = path.join(prismaRoot, 'migrations', MIGRATION_NAME, 'migration.sql');
  const source = readFileSync(sourceMigrationPath, 'utf8');
  const mutated = mutate(source);
  if (mutated === source) {
    throw new Error(`${mutationName} did not alter the real ${MIGRATION_NAME} source`);
  }

  const temporaryPrismaRoot = mkdtempSync(
    path.join(tmpdir(), `srvf-qualification-${mutationName}-`),
  );
  const temporaryMigrationsRoot = path.join(temporaryPrismaRoot, 'migrations');
  const temporarySchemaPath = path.join(temporaryPrismaRoot, 'schema.prisma');
  try {
    mkdirSync(temporaryMigrationsRoot);
    copyFileSync(path.join(prismaRoot, 'schema.prisma'), temporarySchemaPath);
    copyFileSync(
      path.join(sourceMigrationsRoot, 'migration_lock.toml'),
      path.join(temporaryMigrationsRoot, 'migration_lock.toml'),
    );
    for (const entry of readdirSync(sourceMigrationsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        cpSync(
          path.join(sourceMigrationsRoot, entry.name),
          path.join(temporaryMigrationsRoot, entry.name),
          {
            recursive: true,
            force: false,
            errorOnExist: true,
          },
        );
      }
    }
    writeFileSync(path.join(temporaryMigrationsRoot, MIGRATION_NAME, 'migration.sql'), mutated);
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

describe('第 83 migration qualification contract guards', () => {
  afterAll(() => {
    dropWorkerDatabase(SCRATCH_WORKER_ID);
  });

  it('contains one atomic, storage-empty, zero-business-DML migration contract', async () => {
    const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(
      /LOCK TABLE "ActivitySessionPosition"[\s\S]*LOCK TABLE "ActivityQualificationRuleSet"[\s\S]*LOCK TABLE "ActivityQualificationRule"[\s\S]*LOCK TABLE "QualificationEvaluationSnapshot"/,
    );
    for (const dml of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(migration).not.toMatch(new RegExp(`^\\s*${dml}\\b`, 'im'));
    }
    expect(migration).toContain(
      'position_pointer_count=%s, rule_set_count=%s, rule_count=%s, snapshot_count=%s',
    );
    expect(migration).toContain('NULLS NOT DISTINCT');
    expect(migration).toContain('activity_qualification_rule_set_scope_active_unique');
  });

  it('upgrades a true empty 82 database to 83 and leaves legacy FKs/indexes byte-for-byte intact', () => {
    const databaseName = recreateMigration82Scratch();
    try {
      const legacyDefinitions = tableObjectDefinitions(databaseName);
      deployCurrentMigrations(databaseName);

      expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
      expect(qualificationArtifactCount(databaseName)).toBe(22);
      expect(
        preserveLegacyDefinitions(legacyDefinitions, tableObjectDefinitions(databaseName)),
      ).toEqual(legacyDefinitions);

      const columns = JSON.parse(
        runPsql(
          databaseName,
          `SELECT COALESCE(json_agg(row_to_json(column_meta) ORDER BY table_name, column_name), '[]'::json)::text
           FROM (
             SELECT table_name, column_name, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND (
                 (table_name = 'ActivityQualificationRule' AND column_name = 'warnScore')
                 OR (table_name = 'QualificationEvaluationSnapshot' AND column_name = 'evaluationPhaseCode')
               )
           ) column_meta`,
        ),
      ) as Array<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>;
      expect(columns).toEqual([
        {
          table_name: 'ActivityQualificationRule',
          column_name: 'warnScore',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          table_name: 'QualificationEvaluationSnapshot',
          column_name: 'evaluationPhaseCode',
          is_nullable: 'NO',
          column_default: null,
        },
      ]);

      const foreignKeys = JSON.parse(
        runPsql(
          databaseName,
          `SELECT COALESCE(json_agg(row_to_json(foreign_key) ORDER BY name), '[]'::json)::text
           FROM (
             SELECT conname AS name, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
             WHERE conname IN (
               'activity_qualification_rule_set_activity_session_position_fkey',
               'activity_session_position_qualification_rule_set_scope_fkey'
             )
           ) foreign_key`,
        ),
      ) as ObjectDefinition[];
      expect(foreignKeys).toHaveLength(2);
      expect(foreignKeys[0]?.definition).toContain(
        'FOREIGN KEY ("activityId", "sessionId", "positionId")',
      );
      expect(foreignKeys[0]?.definition).toContain(
        'REFERENCES "ActivitySessionPosition"("activityId", "sessionId", id)',
      );
      expect(foreignKeys[1]?.definition).toContain(
        'FOREIGN KEY ("activityId", "sessionId", id, "qualificationRuleSetId")',
      );
      expect(foreignKeys[1]?.definition).toContain(
        'REFERENCES "ActivityQualificationRuleSet"("activityId", "sessionId", "positionId", id)',
      );

      const indexes = JSON.parse(
        runPsql(
          databaseName,
          `SELECT COALESCE(json_agg(row_to_json(index_meta) ORDER BY name), '[]'::json)::text
           FROM (
             SELECT index_class.relname AS name, pg_get_indexdef(index_meta.indexrelid) AS definition
             FROM pg_index index_meta
             JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
             WHERE index_class.relname IN (
               'activity_qualification_rule_set_scope_version_unique',
               'activity_qualification_rule_set_scope_active_unique'
             )
           ) index_meta`,
        ),
      ) as ObjectDefinition[];
      expect(indexes).toHaveLength(2);
      for (const index of indexes) expect(index.definition).toContain('NULLS NOT DISTINCT');
      const indexDefinitions = new Map(indexes.map((index) => [index.name, index.definition]));
      expect(
        indexDefinitions.get('activity_qualification_rule_set_scope_version_unique'),
      ).toContain(', version)');
      expect(indexDefinitions.get('activity_qualification_rule_set_scope_active_unique')).toContain(
        'WHERE ("statusCode" = \'active\'::text)',
      );
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });

  it(`replays all current ${CURRENT_MIGRATION_COUNT} migrations from a literally empty database`, () => {
    const databaseName = recreateEmptyScratchDatabase();
    try {
      deployCurrentMigrations(databaseName);
      expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
      expect(qualificationArtifactCount(databaseName)).toBe(22);
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });

  it(
    'cold current database enforces the D83 exact qualification wires, de-duplicates arrays, and permits nullable identity for submit/review',
    async () => {
      const databaseName = recreateEmptyScratchDatabase();
      try {
        deployCurrentMigrations(databaseName);
        const fixture = await createQualificationFixture(databaseName, 'exact-wire');
        const ruleSetId = 'exact-wire-ruleset';
        insertRuleSet(databaseName, ruleSetId, fixture, 1, 'draft');

        const insertRule = (
          id: string,
          ruleTypeCode: string,
          operator: string,
          valueJson: string,
        ) =>
          runPsql(
            databaseName,
            `INSERT INTO "ActivityQualificationRule"
             ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","valueJson","updatedAt")
           VALUES (${sqlValue(id)},${sqlValue(ruleSetId)},${sqlValue(ruleTypeCode)},'block',
             ${sqlValue(operator)},${valueJson},CURRENT_TIMESTAMP);`,
          );

        for (const [id, ruleTypeCode, operator, valueJson] of [
          ['exact-grade', 'grade', 'in', sqlJson({ codes: ['undergraduate', 'postgraduate'] })],
          [
            'exact-organization',
            'organization',
            'in_subtree',
            sqlJson({ organizationIds: ['team-a', 'team-b'] }),
          ],
          [
            'exact-certificate',
            'certificate',
            'has_any',
            sqlJson({ standardIds: ['first-aid', 'cpr'] }),
          ],
          ['exact-age-both', 'age', 'between', sqlJson({ minYears: 18, maxYears: 65 })],
          ['exact-age-min', 'age', 'between', sqlJson({ minYears: 18 })],
          ['exact-age-max', 'age', 'between', sqlJson({ maxYears: 65 })],
          ['exact-training', 'training', 'has_any', sqlJson({ standardIds: ['safety', 'fire'] })],
          ['exact-gender', 'gender', 'in', sqlJson({ codes: ['female', 'male'] })],
          ['exact-insurance', 'insurance', 'covers_activity', 'NULL'],
        ]) {
          insertRule(id, ruleTypeCode, operator, valueJson);
        }

        for (const [id, ruleTypeCode, operator, valueJson] of [
          ['bad-grade-duplicate', 'grade', 'in', sqlJson({ codes: ['same', 'same'] })],
          ['bad-organization-old-wire', 'organization', 'in', sqlJson({ codes: ['team-a'] })],
          [
            'bad-organization-duplicate',
            'organization',
            'in_subtree',
            sqlJson({ organizationIds: ['team-a', 'team-a'] }),
          ],
          ['bad-certificate-old-wire', 'certificate', 'in', sqlJson({ codes: ['first-aid'] })],
          [
            'bad-certificate-duplicate',
            'certificate',
            'has_any',
            sqlJson({ standardIds: ['first-aid', 'first-aid'] }),
          ],
          ['bad-age-old-keys', 'age', 'between', sqlJson({ min: 18, max: 65 })],
          ['bad-age-empty', 'age', 'between', sqlJson({})],
          ['bad-age-reversed', 'age', 'between', sqlJson({ minYears: 65, maxYears: 18 })],
          ['bad-training-old-wire', 'training', 'in', sqlJson({ codes: ['safety'] })],
          ['bad-gender-duplicate', 'gender', 'in', sqlJson({ codes: ['female', 'female'] })],
          ['bad-insurance-old-operator', 'insurance', 'covered', 'NULL'],
          ['bad-insurance-value', 'insurance', 'covers_activity', sqlJson({ codes: ['basic'] })],
        ]) {
          const failure = runPsqlFailure(
            databaseName,
            `INSERT INTO "ActivityQualificationRule"
             ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","valueJson","updatedAt")
           VALUES (${sqlValue(id)},${sqlValue(ruleSetId)},${sqlValue(ruleTypeCode)},'block',
             ${sqlValue(operator)},${valueJson},CURRENT_TIMESTAMP);`,
          );
          expect(failure).toContain('activity_qualification_rule_operator_value_json_check');
        }

        const anchors = await createQualificationSnapshotAnchors(
          databaseName,
          fixture,
          'exact-wire',
        );
        const insertSnapshot = (
          id: string,
          evaluationPhaseCode: string,
          identityId: string | null,
          registrationRevisionId: string | null,
        ) =>
          `INSERT INTO "QualificationEvaluationSnapshot"
           ("id","identityId","registrationRevisionId","ruleSetVersionId","evaluatedAt","resultCode","evaluationPhaseCode")
         VALUES (${sqlValue(id)},${identityId === null ? 'NULL' : sqlValue(identityId)},
           ${registrationRevisionId === null ? 'NULL' : sqlValue(registrationRevisionId)},
           ${sqlValue(ruleSetId)},TIMESTAMP '2099-05-01 00:00:00','pass',${sqlValue(evaluationPhaseCode)});`;

        for (const [id, phase, identityId, registrationRevisionId] of [
          ['exact-display', 'display', null, null],
          ['exact-submit-null-identity', 'submit', null, anchors.registrationRevisionId],
          ['exact-submit-identity', 'submit', anchors.identityId, anchors.registrationRevisionId],
          ['exact-review-null-identity', 'review', null, anchors.registrationRevisionId],
          ['exact-review-identity', 'review', anchors.identityId, anchors.registrationRevisionId],
        ] as Array<[string, string, string | null, string | null]>) {
          runPsql(databaseName, insertSnapshot(id, phase, identityId, registrationRevisionId));
        }

        for (const [id, phase, identityId, registrationRevisionId] of [
          ['bad-display-revision', 'display', null, anchors.registrationRevisionId],
          ['bad-submit-no-revision', 'submit', null, null],
          ['bad-review-no-revision', 'review', anchors.identityId, null],
        ] as Array<[string, string, string | null, string | null]>) {
          const failure = runPsqlFailure(
            databaseName,
            insertSnapshot(id, phase, identityId, registrationRevisionId),
          );
          expect(failure).toContain('qualification_evaluation_snapshot_phase_anchor_check');
        }
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it('fails closed for any pre-existing qualification storage and returns counts only', async () => {
    const databaseName = recreateMigration82Scratch();
    try {
      const fixture = await createLegacyStorageFixture(databaseName, 'preflight');
      const legacyDefinitions = tableObjectDefinitions(databaseName);
      const rowsBefore = qualificationRows(databaseName, fixture);
      const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
      const failure = runPsqlFailure(databaseName, migration);

      expect(failure).toContain('55000');
      expect(failure).toContain('qualification contract migration storage preflight violation');
      expect(failure).toContain(
        'position_pointer_count=1, rule_set_count=1, rule_count=1, snapshot_count=1',
      );
      for (const id of [
        fixture.positionId,
        fixture.ruleSetId,
        fixture.ruleId,
        fixture.snapshotId,
      ]) {
        expect(failure).not.toContain(id);
      }
      expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_82_COUNT);
      expect(qualificationArtifactCount(databaseName)).toBe(0);
      expect(tableObjectDefinitions(databaseName)).toEqual(legacyDefinitions);
      expect(qualificationRows(databaseName, fixture)).toBe(rowsBefore);
    } finally {
      dropWorkerDatabase(SCRATCH_WORKER_ID);
    }
  });

  it(
    'rolls back all 83 DDL, including late trigger/index work, when the final statement fails',
    async () => {
      const databaseName = recreateMigration82Scratch();
      try {
        const legacyDefinitions = tableObjectDefinitions(databaseName);
        const migration = await readFile(path.resolve(process.cwd(), MIGRATION_PATH), 'utf8');
        const failingMigration = migration.replace(
          /\nCOMMIT;\s*$/,
          `\nDO $qualification83_late_failure$\nBEGIN\n  RAISE EXCEPTION 'qualification 83 late DDL failure';\nEND\n$qualification83_late_failure$;\n\nCOMMIT;\n`,
        );
        if (failingMigration === migration) {
          throw new Error(
            'qualification 83 COMMIT marker disappeared before late-failure injection',
          );
        }

        const failure = runPsqlFailure(databaseName, failingMigration);
        expect(failure).toContain('qualification 83 late DDL failure');
        expect(successfulMigrationCount(databaseName)).toBe(MIGRATION_82_COUNT);
        expect(qualificationArtifactCount(databaseName)).toBe(0);
        expect(tableObjectDefinitions(databaseName)).toEqual(legacyDefinitions);
      } finally {
        dropWorkerDatabase(SCRATCH_WORKER_ID);
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );

  it(
    `five independent D83 migration mutations each rebuild a cold current ${CURRENT_MIGRATION_COUNT} database and make its protected violation pass`,
    async () => {
      const fullCompositeFk = `ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_activity_session_position_fkey"
  FOREIGN KEY ("activityId", "sessionId", "positionId")
  REFERENCES "ActivitySessionPosition" ("activityId", "sessionId", "id")
  MATCH SIMPLE
  ON DELETE RESTRICT
  ON UPDATE CASCADE;`;
      const singleColumnFk = `ALTER TABLE "ActivityQualificationRuleSet"
  ADD CONSTRAINT "activity_qualification_rule_set_activity_session_position_fkey"
  FOREIGN KEY ("positionId")
  REFERENCES "ActivitySessionPosition" ("id")
  MATCH SIMPLE
  ON DELETE RESTRICT
  ON UPDATE CASCADE;`;
      const triggerBlock = `CREATE TRIGGER trg_activity_qualification_rule_set_10_freeze
BEFORE UPDATE OR DELETE ON "ActivityQualificationRuleSet"
FOR EACH ROW EXECUTE FUNCTION activity_qualification_rule_set_freeze_guard();

CREATE TRIGGER trg_activity_qualification_rule_10_parent_freeze
BEFORE INSERT OR UPDATE OR DELETE ON "ActivityQualificationRule"
FOR EACH ROW EXECUTE FUNCTION activity_qualification_rule_parent_freeze_guard();

CREATE TRIGGER trg_qualification_evaluation_snapshot_10_append_only
BEFORE UPDATE OR DELETE ON "QualificationEvaluationSnapshot"
FOR EACH ROW EXECUTE FUNCTION qualification_evaluation_snapshot_append_only_guard();`;
      const mutations: Array<{
        name: string;
        mutate: (source: string) => string;
        proveViolationPasses: (
          databaseName: string,
          fixture: QualificationFixture,
        ) => Promise<void>;
      }> = [
        {
          name: 'scope-check',
          mutate: (source) =>
            removeMarkedBlock(
              source,
              '-- qualification-83:scope-check:begin',
              '-- qualification-83:scope-check:end',
            ),
          proveViolationPasses: async (databaseName, fixture) => {
            insertRuleSet(
              databaseName,
              'mutation-scope-legal',
              fixture,
              1,
              'draft',
              fixture.sessionId,
              fixture.positionId,
            );
            insertRuleSet(
              databaseName,
              'mutation-scope-illegal',
              fixture,
              2,
              'draft',
              null,
              fixture.positionId,
            );
          },
        },
        {
          name: 'composite-fk',
          mutate: (source) => {
            if (!source.includes(fullCompositeFk)) {
              throw new Error(
                'full composite FK source line disappeared before composite-FK mutation',
              );
            }
            return source.replace(fullCompositeFk, singleColumnFk);
          },
          proveViolationPasses: async (databaseName, fixture) => {
            insertRuleSet(
              databaseName,
              'mutation-fk-legal',
              fixture,
              1,
              'draft',
              fixture.sessionId,
              fixture.positionId,
            );
            insertRuleSet(
              databaseName,
              'mutation-fk-cross-activity',
              fixture,
              2,
              'draft',
              fixture.sessionId,
              fixture.otherPositionId,
            );
          },
        },
        {
          name: 'operator-value-check',
          mutate: (source) =>
            removeMarkedBlock(
              source,
              '-- qualification-83:operator-value-check:begin',
              '-- qualification-83:operator-value-check:end',
            ),
          proveViolationPasses: async (databaseName, fixture) => {
            const ruleSetId = 'mutation-operator-ruleset';
            insertRuleSet(databaseName, ruleSetId, fixture, 1, 'draft');
            insertValidRule(databaseName, 'mutation-operator-legal', ruleSetId);
            runPsql(
              databaseName,
              `INSERT INTO "ActivityQualificationRule"
               ("id","ruleSetId","ruleTypeCode","enforcementCode","operator","valueJson","warnScore","updatedAt")
             VALUES ('mutation-operator-illegal',${sqlValue(ruleSetId)},'grade','block','eq',NULL,NULL,CURRENT_TIMESTAMP);`,
            );
          },
        },
        {
          name: 'active-partial-unique',
          mutate: (source) =>
            removeMarkedBlock(
              source,
              '-- qualification-83:active-unique:begin',
              '-- qualification-83:active-unique:end',
            ),
          proveViolationPasses: async (databaseName, fixture) => {
            insertRuleSet(databaseName, 'mutation-active-legal', fixture, 1, 'active');
            insertRuleSet(databaseName, 'mutation-active-duplicate', fixture, 2, 'active');
          },
        },
        {
          name: 'freeze-and-snapshot-triggers',
          mutate: (source) => {
            if (!source.includes(triggerBlock)) {
              throw new Error(
                'qualification immutable trigger source lines disappeared before trigger mutation',
              );
            }
            return source.replace(triggerBlock, '-- mutation: immutable triggers removed');
          },
          proveViolationPasses: async (databaseName, fixture) => {
            const ruleSetId = 'mutation-freeze-ruleset';
            const ruleId = 'mutation-freeze-rule';
            const snapshotId = 'mutation-freeze-snapshot';
            insertRuleSet(databaseName, ruleSetId, fixture, 1, 'draft');
            insertValidRule(databaseName, ruleId, ruleSetId);
            runPsql(
              databaseName,
              `UPDATE "ActivityQualificationRuleSet" SET "statusCode" = 'active'
             WHERE "id" = ${sqlValue(ruleSetId)};`,
            );
            insertDisplaySnapshot(databaseName, snapshotId, ruleSetId);
            runPsql(
              databaseName,
              `UPDATE "ActivityQualificationRule" SET "message" = 'mutation changed'
             WHERE "id" = ${sqlValue(ruleId)};
             UPDATE "QualificationEvaluationSnapshot" SET "resultCode" = 'warn'
             WHERE "id" = ${sqlValue(snapshotId)};`,
            );
          },
        },
      ];

      for (const mutation of mutations) {
        const databaseName = recreateEmptyScratchDatabase();
        try {
          deployMutatedMigration(databaseName, mutation.name, mutation.mutate);
          expect(successfulMigrationCount(databaseName)).toBe(CURRENT_MIGRATION_COUNT);
          const fixture = await createQualificationFixture(databaseName, mutation.name);
          await mutation.proveViolationPasses(databaseName, fixture);
        } finally {
          dropWorkerDatabase(SCRATCH_WORKER_ID);
        }
      }
    },
    COLD_MIGRATION_REPLAY_TIMEOUT_MS,
  );
});
