import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

import { fingerprintContributionPolicyVersion } from '../../src/modules/activities/activity-contribution-policy-definition';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { timeLedgerFixtureTriggerSql } from '../setup/time-ledger-fixture-cleanup';
import { deriveTestDbName } from '../setup/worktree-db';

const WORKER = 98;
const dedicatedW98 = process.env.SRVF_E1_1_W98 === '1';
const metadata = fingerprintContributionPolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  effectiveFrom: '2099-09-22T00:00:00.000Z',
  effectiveUntil: null,
  definition: {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
    roleRules: [
      {
        attendanceRoleCode: 'service',
        categoryRules: [
          {
            timeCategoryCode: 'volunteer_service',
            durationBands: [
              {
                maxSecondsInclusive: 3599,
                recognizedPoints: '0.50',
                explanationCode: 'service_under_hour',
              },
              {
                maxSecondsInclusive: null,
                recognizedPoints: '1.00',
                explanationCode: 'service_hour_plus',
              },
            ],
          },
        ],
      },
    ],
  },
});

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
  INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES
    ('cp-test-user','cp-test-user','fixture',CURRENT_TIMESTAMP),
    ('cp-test-user-2','cp-test-user-2','fixture',CURRENT_TIMESTAMP);
  INSERT INTO "ContributionPolicy" (id,code,name,description,"updatedAt") VALUES
    ('cp-test-policy','cp_test_policy','Policy','Policy description',CURRENT_TIMESTAMP),
    ('cp-test-other','cp_test_other','Other',NULL,CURRENT_TIMESTAMP);
  INSERT INTO "ContributionPolicyVersion"
    (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion",
     "effectiveFrom","statusCode","createdByUserId","updatedAt")
  VALUES
    ('cp-test-version','cp-test-policy',1,1,${literal(JSON.stringify(metadata.definition))},
     '${metadata.definitionHash}',1,'2099-09-22','draft','cp-test-user',CURRENT_TIMESTAMP);
`;

function receipt(
  options: {
    id?: string;
    operationCode?: 'create_policy' | 'create_version' | 'activate_version' | 'retire_version';
    operationKey?: string;
    policyId?: string;
    versionId?: string | null;
    definitionHash?: string | null;
    evaluatorVersion?: number | null;
    resultExtra?: Record<string, unknown>;
  } = {},
): string {
  const operationCode = options.operationCode ?? 'create_version';
  const versioned = operationCode !== 'create_policy';
  const policyId = options.policyId ?? 'cp-test-policy';
  const versionId =
    options.versionId === undefined ? (versioned ? 'cp-test-version' : null) : options.versionId;
  const definitionHash =
    options.definitionHash === undefined
      ? versioned
        ? metadata.definitionHash
        : null
      : options.definitionHash;
  const evaluatorVersion =
    options.evaluatorVersion === undefined ? (versioned ? 1 : null) : options.evaluatorVersion;
  const status =
    operationCode === 'create_policy'
      ? null
      : operationCode === 'create_version'
        ? 'draft'
        : operationCode === 'activate_version'
          ? 'active'
          : 'retired';
  const result = {
    schemaVersion: 1,
    operationCode,
    policyId,
    versionId,
    definitionHash,
    evaluatorVersion,
    resultStatusCode: status,
    createdAt: '2099-09-22T00:00:00.000Z',
    ...options.resultExtra,
  };
  const sqlValue = (value: string | number | null) =>
    value === null ? 'NULL' : typeof value === 'number' ? String(value) : literal(value);
  return `INSERT INTO "ContributionPolicyCommandReceipt"
    (id,"actorUserId","operationCode","operationKey","requestHash","policyId","versionId",
     "definitionHash","evaluatorVersion","resultJson") VALUES
    (${literal(options.id ?? 'cp-test-receipt')},'cp-test-user',${literal(operationCode)},
     ${literal(options.operationKey ?? 'operation')},'${'b'.repeat(64)}',${literal(policyId)},
     ${sqlValue(versionId)},${sqlValue(definitionHash)},${sqlValue(evaluatorVersion)},
     ${literal(JSON.stringify(result))});`;
}

function sql(statement: string): string {
  return raw(`BEGIN; ${base} ${statement}; ROLLBACK;`);
}

function rejected(statement: string, code = '23514'): void {
  try {
    sql(statement);
    throw new Error('violation was accepted');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    expect(String(error.stderr)).toContain(code);
  }
}

function fixtureCleanup(): void {
  const triggerSql = timeLedgerFixtureTriggerSql();
  raw(`BEGIN;
    ${triggerSql.before}
    TRUNCATE "ActivityContributionPolicySelectionCommandReceipt",
      "ActivityContributionPolicySelectionItem",
      "ActivityContributionPolicySelectionRevision",
      "Activity" CASCADE;
    ${triggerSql.after}
    DELETE FROM "User" WHERE id IN ('cp-test-user','cp-test-user-2');
    COMMIT;`);
}

describe('E1-1 contribution policy physical foundation', () => {
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
  };

  beforeAll(() => {
    if (dedicatedW98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      dropWorkerDatabase(WORKER);
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
        { stdio: 'pipe' },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('E1-1 isolated migration deploy failed (connection details suppressed)');
    }
    fixtureCleanup();
  }, 180_000);

  afterAll(() => {
    try {
      fixtureCleanup();
      if (dedicatedW98) dropWorkerDatabase(WORKER);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
    }
  }, 180_000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it.each(['version', 'receipt'])(
    'serializes conflicting %s inserts across independent connections',
    async (kind) => {
      expect(raw('SELECT count(*) FROM "ContributionPolicy"')).toBe('0');
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
          : `INSERT INTO "ContributionPolicyVersion"
              (id,"policyId",version,"schemaVersion","definitionJson","definitionHash",
               "evaluatorVersion","effectiveFrom","statusCode","createdByUserId","updatedAt")
             SELECT 'cp-race-version',"policyId",2,"schemaVersion","definitionJson",
                    "definitionHash","evaluatorVersion","effectiveFrom",'draft',
                    "createdByUserId",CURRENT_TIMESTAMP
             FROM "ContributionPolicyVersion" WHERE id='cp-test-version'`;
      const contenderStatement = statement
        .replace("'cp-test-receipt'", "'cp-race-receipt-2'")
        .replace("'cp-race-version'", "'cp-race-version-2'");
      const winner = first.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(statement);
          inserted();
          await gate;
        },
        { timeout: 15_000 },
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
            { timeout: 15_000 },
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
                `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() ` +
                  `AND pid=${contenderPid} AND wait_event_type='Lock')`,
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
        expect(
          raw(
            kind === 'receipt'
              ? 'SELECT count(*) FROM "ContributionPolicyCommandReceipt"'
              : 'SELECT count(*) FROM "ContributionPolicyVersion" WHERE version=2',
          ),
        ).toBe('1');
      } finally {
        release();
        await Promise.allSettled([winner, contender]);
        await first.$disconnect();
        await second.$disconnect();
        fixtureCleanup();
      }
    },
    30_000,
  );

  it('retains legal versions, receipts and actor-anchored lifecycle', () => {
    expect(
      sql(
        `${receipt()} ` +
          `UPDATE "ContributionPolicyVersion" SET "statusCode"='active',` +
          `"activatedAt"='2099-09-23',"activatedByUserId"='cp-test-user' ` +
          `WHERE id='cp-test-version'; ` +
          `UPDATE "ContributionPolicyVersion" SET "statusCode"='retired',` +
          `"retiredAt"='2099-09-24',"retiredByUserId"='cp-test-user-2' ` +
          `WHERE id='cp-test-version'; ` +
          `SELECT "statusCode" || chr(9) || "retiredByUserId" FROM "ContributionPolicyVersion"`,
      ),
    ).toBe('retired\tcp-test-user-2');
  });

  it('allows display fields and updatedAt changes without changing policy semantics', () => {
    expect(
      sql(
        `UPDATE "ContributionPolicy" SET name='Renamed',description=NULL WHERE id='cp-test-policy'; ` +
          `UPDATE "ContributionPolicyVersion" SET "updatedAt"=CURRENT_TIMESTAMP ` +
          `WHERE id='cp-test-version'; SELECT name FROM "ContributionPolicy" WHERE id='cp-test-policy'`,
      ),
    ).toBe('Renamed');
  });

  it.each(['ContributionPolicy', 'ContributionPolicyVersion', 'ContributionPolicyCommandReceipt'])(
    'rejects deletion of %s',
    (table) => rejected(`${receipt()} DELETE FROM "${table}"`),
  );

  it.each([
    `UPDATE "ContributionPolicy" SET code='changed' WHERE id='cp-test-policy'`,
    `UPDATE "ContributionPolicyVersion" SET version=2 WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "createdByUserId"='cp-test-user-2' WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "definitionHash"='${'c'.repeat(64)}' WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "definitionJson"='{}' WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "effectiveFrom"='2100-01-01' WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "statusCode"='retired',"activatedAt"='2099-09-23',` +
      `"activatedByUserId"='cp-test-user',"retiredAt"='2099-09-24',` +
      `"retiredByUserId"='cp-test-user-2' WHERE id='cp-test-version'`,
    `UPDATE "ContributionPolicyVersion" SET "statusCode"='active',` +
      `"activatedAt"='2099-09-23' WHERE id='cp-test-version'`,
  ])('rejects immutable fields or illegal lifecycle edge: %s', (statement) => rejected(statement));

  it('rejects actor drift, reactivation and changed activation facts', () => {
    const activate =
      `UPDATE "ContributionPolicyVersion" SET "statusCode"='active',` +
      `"activatedAt"='2099-09-23',"activatedByUserId"='cp-test-user' ` +
      `WHERE id='cp-test-version';`;
    rejected(
      `${activate} UPDATE "ContributionPolicyVersion" SET "activatedByUserId"='cp-test-user-2' ` +
        `WHERE id='cp-test-version'`,
    );
    rejected(
      `${activate} UPDATE "ContributionPolicyVersion" SET "statusCode"='retired',` +
        `"activatedByUserId"='cp-test-user-2',"retiredAt"='2099-09-24',` +
        `"retiredByUserId"='cp-test-user-2' WHERE id='cp-test-version'`,
    );
    rejected(
      `${activate} UPDATE "ContributionPolicyVersion" SET "statusCode"='retired',` +
        `"retiredAt"='2099-09-24',"retiredByUserId"='cp-test-user-2' ` +
        `WHERE id='cp-test-version'; UPDATE "ContributionPolicyVersion" SET "statusCode"='active',` +
        `"retiredAt"=NULL,"retiredByUserId"=NULL WHERE id='cp-test-version'`,
    );
  });

  it.each([
    ['cp-test-other', 'cp-test-version', metadata.definitionHash, 1],
    ['cp-test-policy', 'cp-missing-version', metadata.definitionHash, 1],
    ['cp-test-policy', 'cp-test-version', 'c'.repeat(64), 1],
    ['cp-test-policy', 'cp-test-version', metadata.definitionHash, 2],
  ])('rejects mixed exact anchor %s/%s/%s/%s', (policyId, versionId, hash, evaluator) => {
    rejected(
      receipt({ policyId, versionId, definitionHash: hash, evaluatorVersion: evaluator }),
      evaluator === 2 ? '23514' : '23503',
    );
  });

  it.each([
    { schemaVersion: '1' },
    { operationCode: 'activate_version' },
    { resultStatusCode: 'active' },
    { policyId: 'cp-test-other' },
    { versionId: null },
    { definitionHash: null },
    { evaluatorVersion: null },
    { createdAt: '2099-02-30T00:00:00.000Z' },
    { createdAt: null },
    { createdAt: '2099-09-22T00:00:00Z' },
  ])('rejects invalid receipt result %j', (resultExtra) => {
    rejected(receipt({ resultExtra }));
  });

  it('accepts create-policy receipts and rejects receipt edits or duplicate operation keys', () => {
    expect(
      sql(
        `${receipt({ operationCode: 'create_policy' })} SELECT count(*) FROM "ContributionPolicyCommandReceipt"`,
      ),
    ).toBe('1');
    rejected(`${receipt()} UPDATE "ContributionPolicyCommandReceipt" SET "operationKey"='changed'`);
    rejected(`${receipt()} ${receipt({ id: 'cp-test-receipt-2' })}`, '23505');
  });

  it('rejects blank or control operation keys and malformed definition roots', () => {
    rejected(receipt({ operationKey: '   ' }));
    rejected(receipt({ operationKey: 'bad\nkey' }));
    rejected(
      `UPDATE "ContributionPolicyVersion" SET "definitionJson"='{}' WHERE id='cp-test-version'`,
    );
  });

  it.each(['ContributionPolicy', 'ContributionPolicyVersion', 'ContributionPolicyCommandReceipt'])(
    'rejects TRUNCATE of %s',
    (table) => rejected(`TRUNCATE "${table}" CASCADE`),
  );

  it('keeps transaction rollback free of partial receipts', () => {
    expect(sql(`${receipt()} SELECT count(*) FROM "ContributionPolicyCommandReceipt"`)).toBe('1');
    expect(
      raw(`SELECT count(*) FROM "ContributionPolicyCommandReceipt" WHERE id='cp-test-receipt'`),
    ).toBe('0');
  });
});
