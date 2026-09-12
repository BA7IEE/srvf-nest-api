import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';

const metadata = fingerprintTimePolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  effectiveFrom: '2099-09-10T00:00:00.000Z',
  effectiveUntil: null,
  definition: {
    defaultCategory: 'volunteer_service',
    roleMappings: [],
    allowSplit: false,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'exclude' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 1 },
    evidence: { requiredSources: [], requireManualRecognition: false },
    manualAdjustment: { enabled: false },
  },
});
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function raw(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('isolated worker required');
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
      '-v',
      'VERBOSITY=verbose',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}
const base = `
  INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('tp-test-user','tp-test-user','fixture',CURRENT_TIMESTAMP);
  INSERT INTO "TimePolicy" (id,code,name,"updatedAt") VALUES ('tp-test-policy','tp_test_policy','Policy',CURRENT_TIMESTAMP),('tp-test-other','tp_test_other','Other',CURRENT_TIMESTAMP);
  INSERT INTO "TimePolicyVersion" (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion","effectiveFrom","statusCode","updatedAt")
  VALUES ('tp-test-version','tp-test-policy',1,1,${literal(JSON.stringify(metadata.definition))},'${metadata.definitionHash}',1,'2099-09-10','draft',CURRENT_TIMESTAMP);
`;
function receipt(
  policyId = 'tp-test-policy',
  versionId = 'tp-test-version',
  hash = metadata.definitionHash,
  extra: Record<string, unknown> = {},
) {
  const result = {
    schemaVersion: 1,
    operationCode: 'create_version',
    policyId,
    versionId,
    definitionHash: hash,
    resultStatusCode: 'draft',
    createdAt: '2099-09-10T00:00:00.000Z',
    ...extra,
  };
  return `INSERT INTO "TimePolicyCommandReceipt" (id,"actorUserId","operationCode","operationKey","requestHash","policyId","versionId","definitionHash","resultJson") VALUES ('tp-test-receipt','tp-test-user','create_version','operation','${'b'.repeat(64)}',${literal(policyId)},${literal(versionId)},${literal(hash)},${literal(JSON.stringify(result))});`;
}
function sql(statement: string): string {
  return raw(`BEGIN; ${base} ${statement}; ROLLBACK;`);
}
function rejected(statement: string, code = '23514') {
  try {
    sql(statement);
    throw new Error('violation was accepted');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    expect(String(error.stderr)).toContain(code);
  }
}

describe('D1-1 time policy physical foundation', () => {
  beforeAll(() => {
    // A preceding migration rehearsal can leave this worker at an older schema.
    // Establish this suite's own current-schema precondition; never rely on test order.
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (!process.env.JEST_WORKER_ID) throw new Error('isolated worker required');
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('D1-1 isolated migration deploy failed (connection details suppressed)');
    }
  });

  it.each(['version', 'receipt'])(
    'serializes conflicting %s inserts across independent connections',
    async (kind) => {
      // All persistent rows in these three new tables belong to this isolated test fixture.
      expect(raw('SELECT count(*) FROM "TimePolicy"')).toBe('0');
      raw(`BEGIN; ${base} COMMIT;`);
      const first = new PrismaClient();
      const second = new PrismaClient();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      let contenderPid: number | undefined;
      const statement =
        kind === 'receipt'
          ? receipt()
          : `INSERT INTO "TimePolicyVersion" (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion","effectiveFrom","statusCode","updatedAt") SELECT 'tp-race-version',"policyId",2,"schemaVersion","definitionJson","definitionHash","evaluatorVersion","effectiveFrom",'draft',CURRENT_TIMESTAMP FROM "TimePolicyVersion" WHERE id='tp-test-version'`;
      const contenderStatement = statement
        .replace("'tp-test-receipt'", "'tp-race-receipt-2'")
        .replace("'tp-race-version'", "'tp-race-version-2'");
      const winner = first.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(statement);
          inserted();
          await gate;
        },
        { timeout: 15000 },
      );
      let contender: Promise<unknown> | undefined;
      try {
        await ready;
        contender = second
          .$transaction(
            async (tx) => {
              const rows = await tx.$queryRawUnsafe<{ pid: number }[]>(
                'SELECT pg_backend_pid() AS pid',
              );
              contenderPid = rows[0].pid;
              await tx.$executeRawUnsafe(contenderStatement);
            },
            { timeout: 15000 },
          )
          .then(
            () => 'accepted',
            (error: unknown) => error,
          );
        let waiting = false;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (contenderPid !== undefined) {
            waiting =
              raw(
                `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=${contenderPid} AND wait_event_type='Lock')`,
              ) === 't';
            if (waiting) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        release();
        await winner;
        const result = await contender;
        expect(result).not.toBe('accepted');
        expect(String(result)).toContain('23505');
        const count =
          kind === 'receipt'
            ? 'SELECT count(*) FROM "TimePolicyCommandReceipt"'
            : 'SELECT count(*) FROM "TimePolicyVersion" WHERE version=2';
        expect(raw(count)).toBe('1');
      } finally {
        release();
        await Promise.allSettled([winner, contender]);
        await first.$disconnect();
        await second.$disconnect();
        raw(
          `BEGIN; TRUNCATE "ActivitySettlementTimeCommandReceipt", "ParticipantSettlementTimeBucketSource", "ParticipantSettlementTimeBucket", "ActivitySettlementTimeRevision", "ParticipantTimeAllocationCommandReceipt", "ParticipantTimeAllocationEvidence", "ParticipantTimeAllocationSlice", "ParticipantTimeAllocationRevision", "ActivityTimePolicySelectionItem", "TimePolicyCommandReceipt", "TimePolicyVersion", "TimePolicy"; DELETE FROM "User" WHERE id='tp-test-user'; COMMIT;`,
        );
      }
    },
    30000,
  );
  it('retains legal versions, receipts and lifecycle', () => {
    expect(
      sql(
        `${receipt()} UPDATE "TimePolicyVersion" SET "statusCode"='active',"activatedAt"='2099-09-11' WHERE id='tp-test-version'; UPDATE "TimePolicyVersion" SET "statusCode"='retired',"retiredAt"='2099-09-12' WHERE id='tp-test-version'; SELECT "statusCode" FROM "TimePolicyVersion" WHERE id='tp-test-version'`,
      ),
    ).toBe('retired');
  });
  it('allows display name and updatedAt changes without changing semantics', () => {
    expect(
      sql(
        `UPDATE "TimePolicy" SET name='Renamed' WHERE id='tp-test-policy'; UPDATE "TimePolicyVersion" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id='tp-test-version'; SELECT name FROM "TimePolicy" WHERE id='tp-test-policy'`,
      ),
    ).toBe('Renamed');
  });
  it.each(['TimePolicy', 'TimePolicyVersion', 'TimePolicyCommandReceipt'])(
    'rejects deletion of %s',
    (table) => rejected(`${receipt()} DELETE FROM "${table}"`),
  );
  it.each([
    `UPDATE "TimePolicy" SET code='changed' WHERE id='tp-test-policy'`,
    `UPDATE "TimePolicyVersion" SET version=2 WHERE id='tp-test-version'`,
    `UPDATE "TimePolicyVersion" SET "definitionHash"='${'c'.repeat(64)}' WHERE id='tp-test-version'`,
    `UPDATE "TimePolicyVersion" SET "definitionJson"='{}' WHERE id='tp-test-version'`,
    `UPDATE "TimePolicyVersion" SET "effectiveFrom"='2100-01-01' WHERE id='tp-test-version'`,
    `UPDATE "TimePolicyVersion" SET "statusCode"='retired',"activatedAt"='2099-09-11',"retiredAt"='2099-09-12' WHERE id='tp-test-version'`,
    `UPDATE "TimePolicyVersion" SET "activatedAt"='2099-09-11' WHERE id='tp-test-version'`,
  ])('rejects immutable fields or illegal edge: %s', (statement) => rejected(statement));
  it('rejects reactivation and altered activation timestamps', () => {
    const activate = `UPDATE "TimePolicyVersion" SET "statusCode"='active',"activatedAt"='2099-09-11' WHERE id='tp-test-version';`;
    rejected(
      `${activate} UPDATE "TimePolicyVersion" SET "activatedAt"='2099-09-12' WHERE id='tp-test-version'`,
    );
    rejected(
      `${activate} UPDATE "TimePolicyVersion" SET "statusCode"='retired',"retiredAt"='2099-09-12' WHERE id='tp-test-version'; UPDATE "TimePolicyVersion" SET "statusCode"='active',"retiredAt"=NULL WHERE id='tp-test-version'`,
    );
  });
  it.each([
    ['tp-test-other', 'tp-test-version', metadata.definitionHash],
    ['tp-test-policy', 'tp-missing-version', metadata.definitionHash],
    ['tp-test-policy', 'tp-test-version', 'c'.repeat(64)],
  ])('rejects mixed anchor %s/%s/%s', (policy, version, hash) =>
    rejected(receipt(policy, version, hash), '23503'),
  );
  it.each([
    { schemaVersion: '1' },
    { actorUserId: 'forbidden' },
    { resultStatusCode: 'active' },
    { policyId: 'tp-test-other' },
    { versionId: null },
    { definitionHash: null },
    { createdAt: '2099-02-30T00:00:00.000Z' },
    { createdAt: null },
    { createdAt: '2099-09-10T00:00:00Z' },
  ])('rejects invalid result %j', (extra) =>
    rejected(receipt('tp-test-policy', 'tp-test-version', metadata.definitionHash, extra)),
  );
  it('rejects receipt edits and duplicate operation keys', () => {
    rejected(`${receipt()} UPDATE "TimePolicyCommandReceipt" SET "operationKey"='changed'`);
    rejected(
      `${receipt()} ${receipt().replace("'tp-test-receipt'", "'tp-test-receipt-2'")}`,
      '23505',
    );
  });
  it('rejects blank or control operation keys', () => {
    rejected(receipt().replace("'operation'", "'   '"));
    rejected(receipt().replace("'operation'", "E'bad\\nkey'"));
  });
  it('keeps fixture changes rollback-only', () => {
    expect(
      sql(
        `${receipt()} SELECT count(*) FROM "TimePolicyCommandReceipt" WHERE id='tp-test-receipt'`,
      ),
    ).toBe('1');
    expect(raw(`SELECT count(*) FROM "TimePolicyCommandReceipt" WHERE id='tp-test-receipt'`)).toBe(
      '0',
    );
  });
});
