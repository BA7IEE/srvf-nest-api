import { PrismaClient } from '@prisma/client';
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

import { memberIdentityData } from '../helpers/member-identity.fixture';
import { loadTestEnv } from '../setup/load-env';
import {
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260922194000_activity_os_r5_e1_contribution_policy_foundation';
const LATEST_MIGRATION = '20260923190000_activity_os_r5_e1_3_contribution_policy_selection';
const PREVIOUS_MIGRATION_COUNT = 129;
const FOUNDATION_MIGRATION_COUNT = 130;
const CURRENT_MIGRATION_COUNT = 132;
const WORKER = 98;
const prismaRoot = path.resolve(__dirname, '..', '..', 'prisma');
const schema = path.join(prismaRoot, 'schema.prisma');

function target(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const database = deriveTestDbName();
  assertDroppableTestDbName(database);
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== `/${database}`) {
    throw new Error('E1-1 migration worker and configured database do not match');
  }
  return database;
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
      target(),
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function recreate(): void {
  const database = target();
  dropWorkerDatabase(WORKER);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
  if (sql('SELECT current_database()') !== database) {
    throw new Error('E1-1 migration connected target mismatch');
  }
}

function deploy(schemaPath: string): void {
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {
    throw new Error('E1-1 isolated migration deploy failed (connection details suppressed)');
  }
}

function migrationNames(): string[] {
  return readdirSync(path.join(prismaRoot, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function appliedNames(): string[] {
  const value = sql(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ' +
      'AND rolled_back_at IS NULL ORDER BY started_at, migration_name',
  );
  return value.length === 0 ? [] : value.split('\n');
}

async function seedExistingFacts(): Promise<void> {
  const db = new PrismaClient();
  try {
    const user = await db.user.create({
      data: { id: 'e11-actor', username: 'e11-actor', passwordHash: 'fixture' },
    });
    const organization = await db.organization.create({
      data: { id: 'e11-org', name: 'E1-1 migration fixture', nodeTypeCode: 'team' },
    });
    const activity = { id: 'e11-activity' };
    // This fixture runs against the pre-E1-3 schema; the current Prisma Client
    // includes columns that do not exist until migration 131.
    await db.$executeRaw`
      INSERT INTO "Activity" ("id", "updatedAt", "title", "activityTypeCode", "organizationId", "startAt", "endAt", "location", "statusCode")
      VALUES (${activity.id}, ${new Date()}, ${'E1-1 migration fixture'}, ${'e11_activity'}, ${organization.id},
              ${new Date('2099-09-22T09:00:00.000Z')}, ${new Date('2099-09-22T17:00:00.000Z')},
              ${'fixture'}, ${'draft'})
    `;
    const member = await db.member.create({
      data: { id: 'e11-member', memberNo: 'E11-MEMBER', ...memberIdentityData('E1-1 Member') },
    });
    const session = await db.activitySession.create({
      data: {
        id: 'e11-session',
        activityId: activity.id,
        code: 'e11_session',
        name: 'E1-1 session',
        startAt: new Date('2099-09-22T09:00:00.000Z'),
        endAt: new Date('2099-09-22T17:00:00.000Z'),
        locationText: 'fixture',
        checkInOpenAt: new Date('2099-09-22T08:00:00.000Z'),
        checkInCloseAt: new Date('2099-09-22T10:00:00.000Z'),
        checkOutOpenAt: new Date('2099-09-22T16:00:00.000Z'),
        checkOutCloseAt: new Date('2099-09-22T18:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
      },
    });
    const registration = await db.activityRegistration.create({
      data: {
        id: 'e11-registration',
        activityId: activity.id,
        memberId: member.id,
        statusCode: 'pending',
      },
    });
    const identity = await db.activityParticipationIdentity.create({
      data: {
        id: 'e11-identity',
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pass',
      },
    });
    const seal = await db.evidenceSeal.create({
      data: {
        id: 'e11-seal',
        activityId: activity.id,
        sealRevision: 0,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date('2099-09-22T18:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: 'e11-seal-hash',
        statusCode: 'active',
        sealedAt: new Date('2099-09-22T18:00:00.000Z'),
      },
    });
    const run = await db.attendanceSettlementRun.create({
      data: { id: 'e11-run', activityId: activity.id, statusCode: 'posted' },
    });
    const version = await db.attendanceSettlementVersion.create({
      data: {
        id: 'e11-settlement-version',
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: 'e11-version-hash',
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        statusCode: 'approved',
      },
    });
    const result = await db.participantSettlementResultRevision.create({
      data: {
        id: 'e11-result',
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: '1.00',
        recognizedContributionPoints: '1.00',
        calculatedServiceHours: '1.00',
        calculatedContributionPoints: '1.00',
        statusCode: 'committed',
      },
    });
    const batch = await db.ledgerPostingBatch.create({
      data: {
        id: 'e11-batch',
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'committed',
        requestKey: 'e11-batch-request',
      },
    });
    await db.participationLedgerEntry.create({
      data: {
        id: 'e11-ledger-entry',
        postingBatchId: batch.id,
        entryKey: 'e11-entry',
        operationKey: 'e11-operation',
        memberId: member.id,
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        resultRevisionId: result.id,
        ledgerDate: new Date('2099-09-22T00:00:00.000Z'),
        entryTypeCode: 'contribution_credit',
        serviceHoursDelta: '0.00',
        recognizedPointsDelta: '1.00',
        creditedPointsDelta: '1.00',
        cappedOutPointsDelta: '0.00',
      },
    });
    await db.contributionRule.create({
      data: {
        id: 'e11-contribution-rule',
        activityTypeCode: 'e11_activity',
        attendanceRoleCode: 'service',
        pointsBelow: '1.00',
        createdByUserId: user.id,
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO "ActivityTimeCutoverReceipt" ` +
        `(id,"operationKey","requestHash","deployedMainSha","evidenceBundleHash","actorUserId","contentHash") VALUES (` +
        `'activity-time-v1','e11-cutover','${'a'.repeat(64)}','${'b'.repeat(40)}','${'c'.repeat(64)}','${user.id}','${'0'.repeat(64)}')`,
    );
  } finally {
    await db.$disconnect();
  }
}

function snapshotExistingFacts(): string[] {
  return [
    sql(`SELECT row_to_json(t)::text FROM "ContributionRule" t WHERE id='e11-contribution-rule'`),
    sql(
      `SELECT row_to_json(t)::text FROM "ParticipationLedgerEntry" t WHERE id='e11-ledger-entry'`,
    ),
    sql(
      `SELECT row_to_json(t)::text FROM "ActivityTimeCutoverReceipt" t WHERE id='activity-time-v1'`,
    ),
  ];
}

describe('E1-1 contribution policy migration', () => {
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
  };

  beforeAll(() => {
    process.env.JEST_WORKER_ID = String(WORKER);
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  afterAll(() => {
    try {
      dropWorkerDatabase(WORKER);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
    }
  });

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('cold replays 132 exact migrations and installs the contribution policy surface', () => {
    recreate();
    deploy(schema);
    const names = migrationNames();
    expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
    expect(names[FOUNDATION_MIGRATION_COUNT - 1]).toBe(MIGRATION);
    expect(names.at(-1)).toBe(LATEST_MIGRATION);
    expect(appliedNames()).toEqual(names);
    const records = sql(
      'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" ' +
        'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name',
    ).split('\n');
    expect(records).toEqual(
      names.map(
        (name) =>
          `${name}\t${createHash('sha256')
            .update(readFileSync(path.join(prismaRoot, 'migrations', name, 'migration.sql')))
            .digest('hex')}`,
      ),
    );
    expect(
      sql(
        `SELECT array_agg(table_name ORDER BY table_name)::text FROM information_schema.tables ` +
          `WHERE table_schema='public' AND table_name IN (` +
          `'ContributionPolicy','ContributionPolicyVersion','ContributionPolicyCommandReceipt')`,
      ),
    ).toBe('{ContributionPolicy,ContributionPolicyCommandReceipt,ContributionPolicyVersion}');
  }, 180_000);

  it('preserves populated legacy rules, ledger facts and the D8 receipt across 129 to 130', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-e1-1-pre130-'));
    try {
      const temporaryMigrations = path.join(temporary, 'migrations');
      mkdirSync(temporaryMigrations);
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(prismaRoot, 'migrations', 'migration_lock.toml'),
        path.join(temporaryMigrations, 'migration_lock.toml'),
      );
      const names = migrationNames();
      expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
      for (const name of names.slice(0, PREVIOUS_MIGRATION_COUNT)) {
        cpSync(path.join(prismaRoot, 'migrations', name), path.join(temporaryMigrations, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      const temporarySchema = path.join(temporary, 'schema.prisma');
      deploy(temporarySchema);
      expect(appliedNames()).toHaveLength(PREVIOUS_MIGRATION_COUNT);
      await seedExistingFacts();
      const before = snapshotExistingFacts();
      for (const fact of before) expect(fact.length).toBeGreaterThan(0);

      cpSync(
        path.join(prismaRoot, 'migrations', MIGRATION),
        path.join(temporaryMigrations, MIGRATION),
        { recursive: true, errorOnExist: true, force: false },
      );
      deploy(temporarySchema);
      expect(appliedNames()).toHaveLength(FOUNDATION_MIGRATION_COUNT);
      expect(snapshotExistingFacts()).toEqual(before);
      expect(
        sql(
          `SELECT (SELECT count(*) FROM "ContributionPolicy")::text || chr(9) || ` +
            `(SELECT count(*) FROM "ContributionPolicyVersion")::text || chr(9) || ` +
            `(SELECT count(*) FROM "ContributionPolicyCommandReceipt")::text`,
        ),
      ).toBe('0\t0\t0');
      deploy(temporarySchema);
      expect(snapshotExistingFacts()).toEqual(before);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});
