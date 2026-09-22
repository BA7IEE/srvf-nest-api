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
import { PrismaClient } from '@prisma/client';
import {
  assertTestDatabaseUrl,
  assertDroppableTestDbName,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260914120000_activity_os_r4_d6_time_ledger';
function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('D6 migration tests require an isolated worker');
  const database = deriveTestDbName();
  assertDroppableTestDbName(database);
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/' + database)
    throw new Error('D6 migration worker and configured database do not match');
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
function maintenanceSql(statement: string): string {
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
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
function connectionCount(database: string): string {
  return maintenanceSql(
    'SELECT count(*) FROM pg_stat_activity WHERE datname = ' + literal(database),
  );
}
function connectionDiagnostics(database: string): string {
  return maintenanceSql(`SELECT json_build_object(
    'connections', count(*),
    'clientBackends', count(*) FILTER (WHERE backend_type = 'client backend'),
    'autovacuumWorkers', count(*) FILTER (WHERE backend_type = 'autovacuum worker'),
    'otherBackends', count(*) FILTER (WHERE backend_type NOT IN ('client backend', 'autovacuum worker')),
    'active', count(*) FILTER (WHERE state = 'active'),
    'idle', count(*) FILTER (WHERE state = 'idle'),
    'idleInTransaction', count(*) FILTER (WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')),
    'waitingOnLock', count(*) FILTER (WHERE wait_event_type = 'Lock'),
    'startedUnder5Seconds', count(*) FILTER (WHERE clock_timestamp() - backend_start < interval '5 seconds'),
    'started5To30Seconds', count(*) FILTER (WHERE clock_timestamp() - backend_start >= interval '5 seconds' AND clock_timestamp() - backend_start < interval '30 seconds'),
    'started30To120Seconds', count(*) FILTER (WHERE clock_timestamp() - backend_start >= interval '30 seconds' AND clock_timestamp() - backend_start < interval '120 seconds'),
    'startedOver120Seconds', count(*) FILTER (WHERE clock_timestamp() - backend_start >= interval '120 seconds'),
    'applicationNamePresent', count(*) FILTER (WHERE NULLIF(application_name, '') IS NOT NULL),
    'applicationNameAbsent', count(*) FILTER (WHERE NULLIF(application_name, '') IS NULL),
    'transactionOpen', count(*) FILTER (WHERE xact_start IS NOT NULL),
    'transactionOpenOver5Seconds', count(*) FILTER (WHERE xact_start IS NOT NULL AND clock_timestamp() - xact_start >= interval '5 seconds')
  ) FROM pg_stat_activity
  WHERE datname = ${literal(database)}`);
}
function recreate() {
  const { database, worker } = target();
  const engine = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' },
  ).trim();
  if (!engine.startsWith('unix://')) throw new Error('D6 migration requires a local Docker socket');
  let active = connectionCount(database);
  // The first maintenance probe can catch a connection that has already gone away by the
  // time diagnostics run. Recheck from the same database before deciding whether it is safe.
  if (active !== '0') active = connectionCount(database);
  if (active !== '0') {
    // Counts only: never log SQL text, identities, addresses or connection strings.
    let diagnostics = 'unavailable';
    try {
      diagnostics = connectionDiagnostics(database);
    } catch {
      // A failed diagnostic must not replace or bypass the original refusal.
    }
    throw new Error(
      'D6 migration worker is in use; refusing reconstruction; connection counts=' + diagnostics,
    );
  }
  dropWorkerDatabase(worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
  if (sql('SELECT current_database()') !== database)
    throw new Error('D6 migration connected target mismatch');
}
function deploy(schema: string) {
  target();
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {
    // Never expose a child-process environment or database URL in assertion output.
    throw new Error(
      'D6 isolated migration deploy failed; inspect the approved worker migration state',
    );
  }
}
function literal(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

async function seedLegacy() {
  const db = new PrismaClient();
  const at = new Date('2020-03-01T08:00:00Z');
  const end = new Date('2020-03-01T09:00:00Z');
  try {
    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { username: 'd6-migration-user', passwordHash: 'fixture' },
      });
      const org = await tx.organization.create({
        data: { name: 'D6 fixture', nodeTypeCode: 'team' },
      });
      const member = await tx.member.create({
        data: {
          memberNo: 'd6-migration-member',
          realName: '测试成员',
          memberSinceDate: at,
          memberOriginCode: 'fixture',
        },
      });
      const activity = await tx.activity.create({
        data: {
          title: 'D6 historical fixture',
          activityTypeCode: 'fixture',
          organizationId: org.id,
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
          contentHash: 'fixture-seal',
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
          contentHash: 'fixture-version',
          personCount: 1,
          sessionParticipationCount: 1,
          serviceSegmentCount: 1,
          createdByUserId: user.id,
          submittedAt: end,
          statusCode: 'approved',
          operationKey: 'fixture-submit',
        },
      });
      const result = await tx.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identity.id,
          revision: 0,
          resultCode: 'present',
          recognizedServiceHours: 1,
          recognizedContributionPoints: 1,
          calculatedServiceHours: 1,
          calculatedContributionPoints: 1,
          statusCode: 'committed',
        },
      });
      const batch = await tx.ledgerPostingBatch.create({
        data: {
          settlementRunId: run.id,
          settlementVersionId: version.id,
          batchRevision: 1,
          statusCode: 'committed',
          requestKey: 'fixture-batch',
          totalCount: 1,
          preparedCount: 1,
          preparedByUserId: user.id,
          committedByUserId: user.id,
          preparedAt: end,
          committedAt: end,
        },
      });
      for (const stageCode of ['first', 'final']) {
        await tx.settlementReviewAction.create({
          data: {
            settlementVersionId: version.id,
            stageCode,
            actionCode: 'approve',
            actorUserId: user.id,
            actedAt: end,
            note: '历史审核 "quoted" 中文',
            operationKey: 'fixture-review-' + stageCode,
          },
        });
      }
      for (const entryTypeCode of ['service_credit', 'contribution_credit']) {
        await tx.participationLedgerEntry.create({
          data: {
            postingBatchId: batch.id,
            entryKey: 'fixture-entry-' + entryTypeCode,
            operationKey: 'fixture-entry-op-' + entryTypeCode,
            memberId: member.id,
            activityId: activity.id,
            sessionId: session.id,
            participationIdentityId: identity.id,
            resultRevisionId: result.id,
            ledgerDate: at,
            entryTypeCode,
            serviceHoursDelta: entryTypeCode === 'service_credit' ? 1 : 0,
            recognizedPointsDelta: entryTypeCode === 'contribution_credit' ? 1 : 0,
            creditedPointsDelta: entryTypeCode === 'contribution_credit' ? 1 : 0,
            cappedOutPointsDelta: 0,
          },
        });
      }
      await tx.memberContributionDayState.create({
        data: {
          memberId: member.id,
          ledgerDate: at,
          committedCreditedPoints: 1,
          latestBatchId: batch.id,
        },
      });
    });
  } finally {
    await db.$disconnect();
  }
}

describe('D6 migration cold replay and nonempty legacy upgrade', () => {
  const root = path.resolve('prisma');
  const schema = path.join(root, 'schema.prisma');
  const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const tables = [
    'ParticipationLedgerEntry',
    'SettlementReviewAction',
    'MemberContributionDayState',
    'LedgerPostingBatch',
    'AttendanceSettlementVersion',
    'AttendanceSettlementRun',
    'ParticipantSettlementResultRevision',
  ];
  const checksums = () =>
    sql(
      'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    ).split('\n');
  const snapshot = () =>
    tables.map((table) =>
      sql('SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM "' + table + '" t'),
    );
  afterAll(() => {
    recreate();
    deploy(schema);
  }, 120000);

  it('replays 129 exact SQL files and leaves both D6 tables empty', () => {
    recreate();
    deploy(schema);
    expect(names).toHaveLength(129);
    expect(names[121]).toBe(MIGRATION);
    expect(checksums()).toEqual(
      names.map(
        (name) =>
          name +
          '\t' +
          createHash('sha256')
            .update(readFileSync(path.join(root, 'migrations', name, 'migration.sql')))
            .digest('hex'),
      ),
    );
    expect(sql('SELECT count(*) FROM "ParticipationTimeLedgerManifest"')).toBe('0');
    expect(sql('SELECT count(*) FROM "ParticipationTimeLedgerEntry"')).toBe('0');
  }, 120000);

  it('preserves nonempty legacy ledger and reviews byte-for-byte through 121 to 122', async () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d6-pre122-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names.indexOf(MIGRATION)).toBe(121);
      for (const name of names.slice(0, 121))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(121);
      await seedLegacy();
      // Nonempty denominators are checked independently before comparing snapshots.
      expect(tables.map((table) => Number(sql('SELECT count(*) FROM "' + table + '"')))).toEqual([
        2, 2, 1, 1, 1, 1, 1,
      ]);
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
      expect(checksums()).toHaveLength(122);
      expect(checksums().slice(0, 121)).toEqual(oldChecksums);
      expect(snapshot()).toEqual(before);
      expect(sql('SELECT count(*) FROM "ParticipationTimeLedgerManifest"')).toBe('0');
      expect(sql('SELECT count(*) FROM "ParticipationTimeLedgerEntry"')).toBe('0');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      deploy(schema);
    }
  }, 120000);
});
