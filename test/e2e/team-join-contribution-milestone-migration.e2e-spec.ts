import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  assertConnectedTestDatabase,
  assertDroppableTestDbName,
  assertLocalPostgresServer,
  assertTestDatabaseUrl,
} from '../setup/test-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';
import { deriveWorkerTestDbName } from '../setup/worktree-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { r5CiSourceBinding, R5_CI_DATABASE, R5_CI_ROLES } from '../helpers/r5-ci-source-binding';
import { HUMAN_CORRECTION_BASE_CATALOG_SQL } from '../../src/modules/activities/human-correction-trusted-catalog';

const MIGRATION = '20261117190000_team_join_contribution_milestones';
const BASELINE_COUNT = 155;
const SCRATCH_WORKER = 87;
const directory = resolve(__dirname, '../../prisma/migrations');
const candidate = readFileSync(resolve(directory, MIGRATION, 'migration.sql'), 'utf8');
const scratch = deriveWorkerTestDbName(SCRATCH_WORKER);
const container = 'u-nest-api-postgres';

function checkScope() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  assertDroppableTestDbName(scratch);
  assertNamedTestDatabaseScope([scratch]);
  assertLocalPostgresServer();
}

function psqlArgs(database: string) {
  if (database !== scratch && database !== 'postgres')
    throw new Error('A9 migration scope mismatch');
  return [
    'exec',
    '-i',
    container,
    'psql',
    '--no-psqlrc',
    '-q',
    '-tA',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    database,
  ];
}

function sql(body: string, database = scratch) {
  checkScope();
  return execFileSync('docker', psqlArgs(database), {
    input: body,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

describe('A9 migration: populated 155 upgrade, atomic failure, no historical backfill', () => {
  let db: PrismaClient | undefined;
  let owned = false;

  beforeAll(async () => {
    checkScope();
    // CREATE fails if another process owns this name. Never steal or force-drop
    // an existing database, restart the shared container, or change role flags.
    sql(`CREATE DATABASE "${scratch}"`, 'postgres');
    owned = true;
    const files = readdirSync(directory)
      .filter((name) => /^\d{14}_/u.test(name))
      .sort();
    expect(files.indexOf(MIGRATION)).toBe(BASELINE_COUNT);
    const baseline = files.slice(0, BASELINE_COUNT);
    expect(baseline.at(-1)).toBe('20261031223000_r5_correction_set_materialization');
    sql(
      baseline
        .map((name) => readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'))
        .join('\n'),
    );
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${scratch}`;
    url.searchParams.set('connection_limit', '1');
    db = new PrismaClient({ datasourceUrl: url.toString(), errorFormat: 'minimal' });
    await db.$connect();
    await assertConnectedTestDatabase(db, scratch);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (owned) {
      sql(`DROP DATABASE "${scratch}"`, 'postgres');
      owned = false;
    }
  });

  it('preserves old applications; failed DDL rolls back; new protocol cannot relabel history', async () => {
    if (!db) throw new Error('A9 migration database not initialized');
    const member = await db.member.create({
      data: {
        ...memberIdentityData('A9 migration historical applicant'),
        memberNo: 'a9-migration-old',
        gradeCode: 'volunteer',
      },
      select: { id: true },
    });
    const cycle = await db.teamJoinCycle.create({
      data: { year: 2026, name: 'A9 migration historical cycle', statusCode: 'closed' },
      select: { id: true },
    });
    const applicationId = 'ca90000000000000000000001';
    // Baseline schema deliberately has no new column. Use the old persisted
    // shape, not a generated-client field default or a synthetic history receipt.
    await db.$executeRaw`
      INSERT INTO team_join_applications
        (id, "memberId", "cycleId", "statusCode", "targetOrganizationIds", "createdAt", "updatedAt")
      VALUES (${applicationId}, ${member.id}, ${cycle.id}, 'joining', '[]'::jsonb, NOW(), NOW())
    `;
    const old = await db.$queryRaw`
      SELECT to_jsonb(a) AS value FROM team_join_applications a WHERE a.id = ${applicationId}
    `;
    const roleShape = () =>
      sql(`
      SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolcreaterole,rolcreatedb,
        rolcanlogin,rolinherit,rolreplication,rolbypassrls) ORDER BY rolname)::text
      FROM pg_roles WHERE rolname LIKE 'r5_%';
      SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member)::text,'[]')
      FROM pg_auth_members m
      WHERE m.roleid IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'r5_%');
    `);
    const beforeRoles = roleShape();
    const fault = candidate.replace(/\nCOMMIT;\s*$/u, '\nSELECT 1/0;\nCOMMIT;\n');
    expect(fault).not.toBe(candidate);
    const failed = spawnSync('docker', psqlArgs(scratch), {
      input: fault,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('division by zero');
    expect(sql(`SELECT to_regclass('public."TeamJoinContributionMilestone"') IS NULL`)).toBe('t');
    expect(
      sql(`SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='team_join_applications'
      AND column_name='contributionNoticeProtocol'`),
    ).toBe('0');
    expect(
      await db.$queryRaw`
      SELECT to_jsonb(a) AS value FROM team_join_applications a WHERE a.id = ${applicationId}
    `,
    ).toEqual(old);
    expect(roleShape()).toBe(beforeRoles);

    sql(candidate);
    // The expected definitions are derived from pinned repository source.
    // Compare the actual PostgreSQL DDL result without accepting it as a pin.
    const observed = JSON.parse(
      sql('SET search_path=pg_catalog;\n' + HUMAN_CORRECTION_BASE_CATALOG_SQL),
    ) as { functions: Record<string, unknown>[] };
    const source = r5CiSourceBinding({
      database: R5_CI_DATABASE,
      databaseOid: 10,
      cluster: '12345',
      roles: Object.fromEntries(
        Object.values(R5_CI_ROLES).map((name, index) => [name, 20 + index]),
      ),
    });
    const milestoneFunction = (row: Record<string, unknown>) =>
      String(row.signature).startsWith('public.team_join_');
    expect(observed.functions.filter(milestoneFunction)).toEqual(
      source.base.functions.filter(milestoneFunction),
    );
    expect(
      await db.$queryRaw`
      SELECT to_jsonb(a) - 'contributionNoticeProtocol' AS value
      FROM team_join_applications a WHERE a.id = ${applicationId}
    `,
    ).toEqual(old);
    expect(
      (
        await db.teamJoinApplication.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).contributionNoticeProtocol,
    ).toBeNull();
    expect(await db.teamJoinContributionMilestone.count()).toBe(0);
    expect(roleShape()).toBe(beforeRoles);
    await expect(
      db.teamJoinApplication.update({
        where: { id: applicationId },
        data: { contributionNoticeProtocol: 1 },
      }),
    ).rejects.toThrow('immutable application contribution notice protocol');

    const freshMember = await db.member.create({
      data: {
        ...memberIdentityData('A9 migration new applicant'),
        memberNo: 'a9-migration-new',
        gradeCode: 'volunteer',
      },
      select: { id: true },
    });
    const data = {
      memberId: freshMember.id,
      cycleId: cycle.id,
      statusCode: 'joining',
      targetOrganizationIds: [],
      contributionNoticeProtocol: 2,
    };
    await expect(db.teamJoinApplication.create({ data })).rejects.toThrow(
      'team_join_contribution_notice_protocol_check',
    );
    const fresh = await db.teamJoinApplication.create({
      data: { ...data, contributionNoticeProtocol: 1 },
    });
    await expect(
      db.teamJoinApplication.update({
        where: { id: fresh.id },
        data: { contributionNoticeProtocol: null },
      }),
    ).rejects.toThrow('immutable application contribution notice protocol');
    await expect(db.$executeRaw`TRUNCATE TABLE "TeamJoinContributionMilestone"`).rejects.toThrow(
      'immutable contribution milestone fact',
    );
    expect(
      sql(`
      SELECT has_table_privilege('r5_boundary_caller_h7c6','public."TeamJoinContributionMilestone"','SELECT')
        AND has_table_privilege('r5_boundary_caller_h7c6','public."TeamJoinContributionMilestone"','INSERT')
        AND NOT has_table_privilege('r5_boundary_caller_h7c6','public."TeamJoinContributionMilestone"','UPDATE,DELETE,TRUNCATE,TRIGGER')
        AND has_column_privilege('r5_boundary_caller_h7c6','public.team_join_applications','contributionNoticeProtocol','UPDATE')
        AND NOT has_column_privilege('r5_boundary_caller_h7c6','public.team_join_applications','statusCode','UPDATE')
    `),
    ).toBe('t');
  });
});
