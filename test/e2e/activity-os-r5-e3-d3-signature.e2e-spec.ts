import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { createTestApp } from '../setup/test-app';
import { httpServer } from '../helpers/http-server';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { ContributionShadowEvidenceQueryService } from '../../src/modules/attendances/contribution-shadow-evidence.query.service';
import { ContributionShadowEvidencePresenter } from '../../src/modules/attendances/contribution-shadow-evidence.presenter';
import { ContributionShadowEvidenceAuditRecorder } from '../../src/modules/attendances/contribution-shadow-evidence.audit-recorder';
import { ContributionShadowEvidenceService } from '../../src/modules/attendances/contribution-shadow-evidence.service';
import { PrismaService } from '../../src/database/prisma.service';
import { loadJwtConfig } from '../../src/config/jwt.config';
import { AuthHumanCommandIdentityService } from '../../src/modules/auth/auth-human-command-identity.service';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { ContributionShadowWindowRegistrationService } from '../../src/modules/attendances/contribution-shadow-window-registration.service';
import { ContributionShadowDispositionRegistrationService } from '../../src/modules/attendances/contribution-shadow-disposition-registration.service';
import {
  shadowReconciliationManifestHash,
  type ShadowWindowRegistrationManifest,
  type ShadowDispositionRegistrationManifest,
} from '../../src/modules/attendances/contribution-shadow-reconciliation-command';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTemplateTestDbName, deriveTestDbName } from '../setup/worktree-db';

// One named role test runs in the dedicated scratch DB, not a worker's business
// fixtures. SQL role names are global to PostgreSQL and must never collide with
// other tests or pretend that SET ROLE proves a real authenticated session_user.
const ACL = readFileSync(
  join(process.cwd(), 'scripts/sql/contribution-shadow-reconciliation-roles.sql'),
  'utf8',
);
const ROLES = [
  'srvf_d3_owner_w98_fixture',
  'srvf_d3_registrar_w98_fixture',
  'srvf_d3_reader_w98_fixture',
  'srvf_d3_login_w98_fixture',
] as const;
const FUNCTIONS = [
  'csd3_hash_fn(text,jsonb)',
  'csd3_manifest_hash_fn(jsonb)',
  'csd3_candidate_evidence_fn(text,text)',
  'csd3_assert_human_fn(text,text)',
  'csd3_authority_fn()',
  'csd3_assert_authority_fn(jsonb,text)',
  'csd3_assert_decision_fn(jsonb,text)',
  'csd3_window_insert_guard_fn()',
  'csd3_approval_insert_guard_fn()',
  'csd3_approval_closure_fn()',
  'csd3_register_fn(jsonb,text,text,text,text)',
  'csd3_read_candidates_fn(text)',
  'csd3_read_candidate_fn(text,text)',
  'csd3_read_summary_fn(text)',
  'csd3_authorize_read_fn(text)',
];

function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (deriveTestDbName() !== 'app_test_w98') throw new Error('D3 role fixture requires exact w98');
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
      'app_test_w98',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function literal(value: unknown): string {
  return "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
}

/** Dedicated scratch DB coordination only; the session holds no business row lock. */
async function acquireD3ScratchLease(): Promise<() => Promise<void>> {
  const child = spawn(
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
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume(); // Never surface connection details from a failed fixture command.
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('D3 scratch lease acquisition timed out'));
    }, 110_000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('D3 scratch lease process failed'));
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('D3 scratch lease ended before acquisition'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-256);
      if (output.includes('D3_W98_LEASE_READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stdin.write(
      "SELECT pg_advisory_lock(hashtextextended('SRVF:test:D3:app_test_w98',0)); SELECT 'D3_W98_LEASE_READY';\n",
    );
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null) {
        reject(new Error('D3 scratch lease unexpectedly ended'));
        return;
      }
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('D3 scratch lease release failed')),
      );
      child.stdin.end('\\q\n');
    });
}

describe('D3 actual LOGIN, collection guards and full-scale first probe (w98 only)', () => {
  let releaseScratchLease: (() => Promise<void>) | undefined;
  const original = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let admin: PrismaService;
  let registrar: PrismaService;
  let windowService: ContributionShadowWindowRegistrationService;
  let dispositionService: ContributionShadowDispositionRegistrationService;
  let token: string;
  let bootstrapped = false;
  let loginCreated = false;
  let windowManifest: ShadowWindowRegistrationManifest;
  let acceptedFirstProbe = false;
  let firstSignManifest: ShadowDispositionRegistrationManifest;
  let registrarUrl: string;

  function bind(
    manifest: ShadowWindowRegistrationManifest | ShadowDispositionRegistrationManifest,
  ) {
    const authority = {
      databaseName: 'app_test_w98',
      manifestHash: shadowReconciliationManifestHash(manifest),
      operation: manifest.operation,
      actorUserId: 'd3-human',
      approvalReference: manifest.approvalReference,
      ownerRole: ROLES[0],
      registrarRole: ROLES[1],
      readerRole: ROLES[2],
      loginRole: ROLES[3],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      manifest,
    };
    sql(`BEGIN; SET LOCAL srvf.d3_acl_database='app_test_w98'; SET LOCAL srvf.d3_acl_action='bind';
      SELECT set_config('srvf.d3_authority',${literal(authority)}::text,true); ${ACL} COMMIT;`);
  }

  beforeAll(async () => {
    if (deriveTemplateTestDbName() !== 'app_test')
      throw new Error('D3 fixture requires the primary checkout');
    releaseScratchLease = await acquireD3ScratchLease();
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    dropWorkerDatabase('98');
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', 'app_test_w98'],
      { stdio: 'pipe' },
    );
    admin = new PrismaService();
    const [{ database }] = await admin.$queryRaw<
      Array<{ database: string }>
    >`SELECT current_database() AS database`;
    expect(database).toBe('app_test_w98');
    // Ordinary reviewed migration deploy, never migrate reset/dev/db push. No
    // template or other worker DB is operated on by this local acceptance path.
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
    expect(
      sql(
        `SELECT count(*) FROM pg_roles WHERE rolname IN (${ROLES.map((r) => "'" + r + "'").join(',')})`,
      ),
    ).toBe('0');
    sql(`BEGIN;
      INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('d3-human','d3-human','fixture',CURRENT_TIMESTAMP);
      INSERT INTO roles (id,code,"displayName","updatedAt") VALUES ('d3-role','d3_fixture','D3 isolated fixture',CURRENT_TIMESTAMP);
      INSERT INTO permissions (id,code,module,action,"resourceType","updatedAt") VALUES
        ('d3-read','contribution-shadow.read.evidence','contribution-shadow','read','evidence',CURRENT_TIMESTAMP),
        ('d3-window','contribution-shadow.register.window','contribution-shadow','register','window',CURRENT_TIMESTAMP),
        ('d3-sign','contribution-shadow.sign.disposition','contribution-shadow','sign','disposition',CURRENT_TIMESTAMP);
      INSERT INTO role_permissions (id,"roleId","permissionId") SELECT 'd3-rp-'||id,'d3-role',id FROM permissions WHERE id IN ('d3-read','d3-window','d3-sign');
      INSERT INTO role_bindings (id,"principalType","principalId","roleId","scopeType","startedAt","updatedAt")
        VALUES ('d3-binding','USER','d3-human','d3-role','GLOBAL','2000-01-01',CURRENT_TIMESTAMP);
      INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt") VALUES ('d3-org','D3 isolated fixture','team',CURRENT_TIMESTAMP);
      INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
        VALUES ('d3-activity','D3 isolated fixture','service','d3-org','2099-10-01','2099-10-02','fixture','draft',CURRENT_TIMESTAMP);
      INSERT INTO "ActivitySession" (id,"activityId",code,name,"startAt","endAt","locationText","checkInOpenAt","checkInCloseAt",
        "checkOutOpenAt","checkOutCloseAt","locationRequired","locationPolicySourceCode","statusCode","updatedAt")
        VALUES ('d3-session','d3-activity','d3_session','D3 fixture','2099-10-01 01:00','2099-10-01 02:00','fixture',
          '2099-10-01','2099-10-01 01:00','2099-10-01 02:00','2099-10-01 03:00',false,'activity','scheduled',CURRENT_TIMESTAMP);
      INSERT INTO "ActivitySessionPosition" (id,"activityId","sessionId",code,name,"attendanceRoleCode","updatedAt")
        VALUES ('d3-position','d3-activity','d3-session','d3_position','D3 fixture','member',CURRENT_TIMESTAMP);
      INSERT INTO "ContributionPolicy" (id,code,name,"updatedAt") VALUES ('d3-policy','d3_fixture','D3 fixture',CURRENT_TIMESTAMP);
      INSERT INTO "ContributionPolicyVersion" (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion",
        "effectiveFrom","statusCode","createdByUserId","updatedAt") VALUES ('d3-version','d3-policy',1,1,
          '{"defaultResult":{"recognizedPoints":"0.00","explanationCode":"default"},"roleRules":[]}',repeat('a',64),1,
          '2000-01-01','draft','d3-human',CURRENT_TIMESTAMP);
      -- A synthetic pre-approved mapping is a setup precondition, NOT mapping
      -- registration acceptance. Only these two setup triggers are restored
      -- before any D3 measured command. Every D3 guard remains enabled.
      ALTER TABLE "ContributionShadowMappingApproval" DISABLE TRIGGER csma_pending_insert_guard;
      ALTER TABLE "ContributionShadowMappingApproval" DISABLE TRIGGER csma_receipt_closure;
      INSERT INTO "ContributionShadowMappingApproval" (id,"approvalNumber","mappingVersion","manifestHash","approvalReference",
        "approvedByUserId","registeredByUserId","activityId","activityTypeCode","attendanceRoleCode","sessionPositionId",
        "policyRoleCode","categoryCode","policyVersionId","policyDefinitionHash","evaluatorVersion","durationSourceCode","effectiveFrom","eventKindCode")
        VALUES ('d3-mapping','D3-FIXTURE-MAPPING','d3-fixture-v1',repeat('a',64),'D3-FIXTURE',
          'd3-human','d3-human','d3-activity','service','volunteer','d3-position','member','volunteer_service',
          'd3-version',repeat('a',64),1,'legacy_stored_hours_2','2000-01-01','approve');
      ALTER TABLE "ContributionShadowMappingApproval" ENABLE TRIGGER csma_pending_insert_guard;
      ALTER TABLE "ContributionShadowMappingApproval" ENABLE TRIGGER csma_receipt_closure;
      COMMIT;`);
    sql(
      `BEGIN; SET LOCAL srvf.d3_acl_database='app_test_w98'; SET LOCAL srvf.d3_acl_action='bootstrap'; ${ACL} COMMIT;`,
    );
    bootstrapped = true;
    const password = randomBytes(32).toString('hex');
    sql(`CREATE ROLE ${ROLES[3]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
      GRANT ${ROLES[1]} TO ${ROLES[3]};`);
    loginCreated = true;
    const url = new URL(process.env.DATABASE_URL!);
    url.username = ROLES[3];
    url.password = password;
    registrarUrl = url.toString();
    registrar = new PrismaService({ datasources: { db: { url: url.toString() } } });
    await registrar.$connect();
    const jwtConfig = loadJwtConfig();
    const jwt = new JwtService({ secret: jwtConfig.secret });
    const identity = new AuthHumanCommandIdentityService(
      jwt,
      new JwtStrategy(new ConfigService({ jwt: jwtConfig }), registrar),
    );
    windowService = new ContributionShadowWindowRegistrationService(
      identity,
      new RbacService(registrar),
    );
    dispositionService = new ContributionShadowDispositionRegistrationService(windowService);
    token = jwt.sign({ sub: 'd3-human', username: 'd3-human' }, { expiresIn: '15m' });
  }, 120_000);

  afterAll(async () => {
    try {
      await registrar?.$disconnect();
      if (bootstrapped) {
        sql(`BEGIN; SET LOCAL srvf.d3_acl_database='app_test_w98'; SET LOCAL srvf.d3_acl_action='close'; ${ACL}
          ${FUNCTIONS.map((signature) => `ALTER FUNCTION public.${signature} OWNER TO postgres;`).join('\n')}
          ALTER TABLE "ContributionShadowWindowRegistrationReceipt" OWNER TO postgres;
          ALTER TABLE "ContributionShadowDispositionApprovalReceipt" OWNER TO postgres;
          ${loginCreated ? `REVOKE ${ROLES[1]} FROM ${ROLES[3]};` : ''}
          DROP OWNED BY ${ROLES.slice(0, 3).join(',')};
          DROP ROLE ${ROLES.slice(0, 3).join(',')}; ${loginCreated ? `DROP ROLE ${ROLES[3]};` : ''} COMMIT;`);
        expect(
          sql(
            `SELECT count(*) FROM pg_roles WHERE rolname IN (${ROLES.map((r) => "'" + r + "'").join(',')})`,
          ),
        ).toBe('0');
      }
    } finally {
      try {
        await admin?.$disconnect();
      } finally {
        if (original.worker === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = original.worker;
        if (original.url === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = original.url;
        await releaseScratchLease?.();
      }
    }
  });

  it('first proves actual LOGIN + full collection chain within the unchanged five-second transaction budget', async () => {
    const [{ login, current, superuser }] = await registrar.$queryRaw<
      Array<{ login: string; current: string; superuser: boolean }>
    >`
      SELECT session_user::text AS login,current_user::text AS current,rolsuper AS superuser FROM pg_roles WHERE rolname=session_user`;
    expect({ login, current, superuser }).toEqual({
      login: ROLES[3],
      current: ROLES[3],
      superuser: false,
    });
    const now = Number(sql(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint`));
    windowManifest = {
      schemaVersion: 1,
      operation: 'register_window',
      commandKey: 'd3-window-command',
      approvalReference: 'D3-FIXTURE-WINDOW',
      windowId: 'd3-window',
      startsAt: new Date(now + 5_000).toISOString(),
      endsAt: new Date(now + 5_001).toISOString(),
      deploymentDigest: 'a'.repeat(64),
      configDigest: 'b'.repeat(64),
      signedMappingVersion: 'd3-fixture-v1',
    };
    bind(windowManifest);
    const [{ hash }] = await admin.$queryRaw<
      Array<{ hash: string }>
    >`SELECT csd3_manifest_hash_fn(${JSON.stringify(windowManifest)}::jsonb) AS hash`;
    expect(hash).toBe(shadowReconciliationManifestHash(windowManifest));
    const registration = await registrar.$transaction(
      (tx) => windowService.registerInTx(tx, token, windowManifest, hash),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000 },
    );
    expect(registration.replayed).toBe(false);
    sql(`BEGIN;
      INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
        VALUES ('d3-member','D3_FIXTURE','D3 isolated fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
      INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
        VALUES ('d3-sheet','d3-activity','d3-human','pending_review',CURRENT_TIMESTAMP,1);
      INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt","serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
        SELECT 'd3-record-'||n,'d3-sheet','d3-member','volunteer','2099-10-01'::timestamp+n*interval '1 hour',
          '2099-10-01'::timestamp+(n+1)*interval '1 hour',1.00,'present',0.00,CURRENT_TIMESTAMP FROM generate_series(1,5) n;
      INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
        SELECT 'd3-audit-'||n,'${windowManifest.startsAt}'::timestamptz AT TIME ZONE 'UTC','attendance_sheet','d3-sheet','attendance-sheet.submit',
          jsonb_build_object('extra',jsonb_build_object('operation','submit','recordsCount',5),'after',jsonb_build_object(
            'sheet',jsonb_build_object('activityId','d3-activity','version',1),'records',
              (SELECT jsonb_agg(jsonb_build_object('id',id,'memberId',"memberId")) FROM "AttendanceRecord" WHERE "sheetId"='d3-sheet')))
          FROM generate_series(1,2000) n;
      INSERT INTO "ContributionShadowAttemptReceipt" (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey",
        "committedFactHash","signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
        SELECT 'd3-attempt-'||n,'d3-window','d3-audit-'||n,'d3-sheet','d3-activity',1,
          encode(sha256(convert_to('e3-2-d1:v1:d3-window:d3-audit-'||n||':1','UTF8')),'hex'),repeat('a',64),'d3-fixture-v1',5,'sha256',1
          FROM generate_series(1,2000) n;
      INSERT INTO "ContributionShadowComparisonReceipt" (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
        comparable,"factHash","legacySourceHash","hashAlgorithmCode","canonicalVersion")
        SELECT 'd3-comparison-'||n||'-'||r,'d3-attempt-'||n,'d3-record-'||r,'d3-sheet','d3-member','d3-activity',
          'mapping_hold',false,repeat('a',64),repeat('b',64),'sha256',1 FROM generate_series(1,2000) n CROSS JOIN generate_series(1,5) r;
      INSERT INTO "ContributionShadowTerminalReceipt" (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount",
        "equalCount","mismatchCount","holdCount","errorCount") SELECT 'd3-terminal-'||n,'d3-attempt-'||n,'complete',5,5,0,0,5,0 FROM generate_series(1,2000) n;
      COMMIT;`);
    const counts = JSON.parse(
      sql(`SELECT jsonb_build_object('candidates',count(*),'comparisons',
      (SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE "attemptId" LIKE 'd3-attempt-%')) FROM audit_logs WHERE id LIKE 'd3-audit-%'`),
    ) as unknown;
    expect(counts).toEqual({ candidates: 2000, comparisons: 10000 });
    // Wait for an actual clock predicate, not a fixed sleep or changed business budget.
    const deadline = performance.now() + 6_000;
    while (sql(`SELECT clock_timestamp() >= '${windowManifest.endsAt}'::timestamptz`) !== 't') {
      if (performance.now() > deadline) throw new Error('D3 fixture window did not close');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const [{ evidence, hash: candidateHash }] = await admin.$queryRaw<
      Array<{ evidence: Prisma.JsonObject; hash: string }>
    >`
      SELECT e AS evidence,csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',e) AS hash
      FROM (SELECT csd3_candidate_evidence_fn('d3-window','d3-audit-1') e) projected`;
    expect(candidateHash).toBe(
      computeActivityTemplateDefinitionHash({
        schemaVersion: 1,
        definition: { domain: 'SRVF:E3-2:shadow-candidate-evidence:v1', manifest: evidence },
      }),
    );
    const signManifest: ShadowDispositionRegistrationManifest = {
      schemaVersion: 1,
      operation: 'sign_disposition',
      commandKey: 'd3-gap-command',
      approvalReference: 'D3-FIXTURE-GAP',
      windowId: 'd3-window',
      auditLogId: 'd3-audit-1',
      expectedPreviousDispositionId: null,
      expectedRevision: 1,
      decisionCode: 'confirmed_gap',
      basisCode: 'observed_gap',
      expectedCandidateEvidenceHash: candidateHash,
    };
    firstSignManifest = signManifest;
    bind(signManifest);
    const started = performance.now();
    const signed = await registrar.$transaction(
      (tx) =>
        dispositionService.registerInTx(
          tx,
          token,
          signManifest,
          shadowReconciliationManifestHash(signManifest),
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000 },
    );
    expect(signed).toMatchObject({
      windowId: 'd3-window',
      auditLogId: 'd3-audit-1',
      revision: 1,
      replayed: false,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(
      sql(`SELECT count(*) FROM "ContributionShadowDispositionReceipt" d JOIN "ContributionShadowDispositionApprovalReceipt" a
      ON a.id=d."approvalReceiptId" AND a."candidateEvidenceHash"=d."evidenceHash" WHERE a.id='${signed.receiptId}'`),
    ).toBe('1');
    expect(
      sql(
        `SELECT count(*) FROM audit_logs WHERE event='activity.contribution-shadow.disposition-sign' AND "resourceId"='${signed.receiptId}'`,
      ),
    ).toBe('1');
    expect(
      sql(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'
      AND tgrelid IN ('"ContributionShadowDispositionApprovalReceipt"'::regclass,'"ContributionShadowWindowRegistrationReceipt"'::regclass,
        '"ContributionShadowMappingApproval"'::regclass,'"ContributionShadowComparisonReceipt"'::regclass)`),
    ).toBe('0');
    acceptedFirstProbe = true;
    console.log(
      `[D3-first-probe] realLogin=true candidates=2000 comparisons=10000 elapsedMs=${Math.round(performance.now() - started)} budgetMs=5000`,
    );
  }, 120_000);

  it('reads 2,000 candidates / 10,000 comparisons with fixed query budgets and no evidence bodies', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const observed = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const queries: string[] = [];
    observed.$on('query', (event) => queries.push(event.query));
    const db = observed as unknown as PrismaService;
    const rbac = new RbacService(db);
    const audit = new AuditLogsService(db, rbac);
    const service = new ContributionShadowEvidenceService(
      db,
      rbac,
      new ContributionShadowEvidenceQueryService(audit),
      new ContributionShadowEvidencePresenter(),
      new ContributionShadowEvidenceAuditRecorder(audit),
    );
    const actor = {
      id: 'd3-human',
      username: 'd3-human',
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const meta = { requestId: 'd3-read-fixture', ip: null, ua: null };
    try {
      await observed.$connect();
      const operations = [
        () => service.listWindows({ page: 1, pageSize: 20 }, actor, meta),
        () => service.summary('d3-window', actor, meta),
        () => service.listCandidates('d3-window', { page: 1, pageSize: 20 }, actor, meta),
        () => service.candidate('d3-window', 'd3-audit-1', actor, meta),
        () =>
          service.listComparisons(
            'd3-window',
            'd3-attempt-1',
            { page: 1, pageSize: 20 },
            actor,
            meta,
          ),
      ];
      for (const [index, operation] of operations.entries()) {
        queries.length = 0;
        const start = performance.now();
        const result = await operation();
        const elapsed = performance.now() - start;
        const domain = queries.filter(
          (query) =>
            !/^BEGIN|^COMMIT|^SET TRANSACTION/i.test(query) &&
            !/"User"|role_bindings|role_permissions|public\.roles|"permissions"|csd3_assert_human_fn|INSERT INTO .*audit_logs/i.test(
              query,
            ),
        ).length;
        expect(elapsed).toBeLessThan(5000);
        expect(queries.length).toBeLessThanOrEqual(40);
        expect(domain).toBeLessThanOrEqual(index === 1 ? 16 : 12);
        const serialized = JSON.stringify(result);
        for (const key of ['candidateEvidence"', 'context"', 'passwordHash', 'realName', 'phone'])
          expect(serialized).not.toContain(key);
        if (index === 1)
          expect(result).toMatchObject({
            candidateCount: 2000,
            attemptCount: 2000,
            terminalCount: 2000,
            rawUnresolvedCount: 2000,
            netUnresolvedCount: 2000,
            notApplicableCount: 0,
            holdCount: 2000,
          });
        if (index === 2) expect(result).toMatchObject({ total: 2000, page: 1, pageSize: 20 });
        if (index === 3)
          expect(result).toMatchObject({
            decisionCode: 'confirmed_gap',
            signatureStatus: 'current',
            notApplicable: false,
            candidateEvidenceHash: firstSignManifest.expectedCandidateEvidenceHash,
          });
        if (index === 4) expect(result).toMatchObject({ total: 5 });
        console.log(
          `[D3-read-probe] operation=${index} elapsedMs=${Math.round(elapsed)} domainQueries=${domain} totalQueries=${queries.length}`,
        );
      }
    } finally {
      await observed.$disconnect();
    }
  }, 60_000);

  it('same command replay retains one approval/disposition/audit and rechecks current qualification', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    bind(firstSignManifest);
    const replay = () =>
      registrar.$transaction(
        (tx) =>
          dispositionService.registerInTx(
            tx,
            token,
            firstSignManifest,
            shadowReconciliationManifestHash(firstSignManifest),
          ),
        { timeout: 5000 },
      );
    await expect(replay()).resolves.toMatchObject({ replayed: true, revision: 1 });
    expect(
      sql(
        `SELECT count(*) FROM audit_logs WHERE event='activity.contribution-shadow.disposition-sign' AND context#>>'{extra,auditLogId}'='d3-audit-1'`,
      ),
    ).toBe('1');
    sql(`UPDATE role_bindings SET status='SUSPENDED' WHERE id='d3-binding'`);
    try {
      await expect(replay()).rejects.toMatchObject({ biz: { code: 40300 } });
    } finally {
      sql(`UPDATE role_bindings SET status='ACTIVE' WHERE id='d3-binding'`);
    }
  });

  it('only individually signed protocol-external candidates enter N; withdrawal and changed evidence restore net gaps', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    sql(`INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
      VALUES ('d3-resubmit-audit','${windowManifest.startsAt}'::timestamptz AT TIME ZONE 'UTC','attendance_sheet','d3-sheet','attendance-sheet.edit',
        '{"extra":{"operation":"resubmit"}}'),('d3-unknown-audit','${windowManifest.startsAt}'::timestamptz AT TIME ZONE 'UTC','attendance_sheet','d3-sheet','attendance-sheet.edit',
        '{"extra":{"operation":"unknown"}}')`);
    const read = () =>
      JSON.parse(sql(`SELECT csd3_read_summary_fn('d3-window')`)) as Record<string, number>;
    const signing = async (
      decisionCode: ShadowDispositionRegistrationManifest['decisionCode'],
      previous: string | null,
      revision: number,
    ) => {
      const hash = sql(
        `SELECT csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn('d3-window','d3-resubmit-audit'))`,
      );
      const manifest: ShadowDispositionRegistrationManifest = {
        schemaVersion: 1,
        operation: 'sign_disposition',
        commandKey: `d3-na-${revision}`,
        approvalReference: `D3-NA-${revision}`,
        windowId: 'd3-window',
        auditLogId: 'd3-resubmit-audit',
        expectedPreviousDispositionId: previous,
        expectedRevision: revision,
        decisionCode,
        basisCode:
          decisionCode === 'unresolved' ? 'withdraw_previous' : 'outside_comparison_contract',
        expectedCandidateEvidenceHash: hash,
      };
      bind(manifest);
      return registrar.$transaction(
        (tx) =>
          dispositionService.registerInTx(
            tx,
            token,
            manifest,
            shadowReconciliationManifestHash(manifest),
          ),
        { timeout: 5000 },
      );
    };
    expect(read()).toMatchObject({
      candidateCount: 2002,
      rawMissingStartCount: 2,
      rawUnresolvedCount: 2002,
      netUnresolvedCount: 2002,
      notApplicableCount: 0,
    });
    const signed = await signing('not_applicable', null, 1);
    expect(read()).toMatchObject({
      rawMissingStartCount: 2,
      rawUnresolvedCount: 2002,
      netMissingStartCount: 1,
      netUnresolvedCount: 2001,
      notApplicableCount: 1,
    });
    const dispositionId = sql(
      `SELECT id FROM "ContributionShadowDispositionReceipt" WHERE "approvalReceiptId"='${signed.receiptId}'`,
    );
    const withdrawn = await signing('unresolved', dispositionId, 2);
    expect(read()).toMatchObject({
      rawMissingStartCount: 2,
      netMissingStartCount: 2,
      netUnresolvedCount: 2002,
      notApplicableCount: 0,
    });
    const previous = sql(
      `SELECT id FROM "ContributionShadowDispositionReceipt" WHERE "approvalReceiptId"='${withdrawn.receiptId}'`,
    );
    await signing('not_applicable', previous, 3);
    // A permitted synthetic audit-source change does not rewrite any immutable
    // approval or receipt. The persisted old hash must remain visible as stale.
    sql(
      `UPDATE audit_logs SET context='{"extra":{"operation":"edit-no-records"}}' WHERE id='d3-resubmit-audit'`,
    );
    expect(read()).toMatchObject({
      staleSignatureCount: 1,
      notApplicableCount: 0,
      netUnresolvedCount: 2002,
    });
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowDispositionApprovalReceipt" WHERE "auditLogId"='d3-resubmit-audit'`,
      ),
    ).toBe('3');
  });

  it('real HTTP exposes exactly five authenticated GETs, bounded pages and independent explicit read permission', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const app = await createTestApp();
    try {
      const paths = [
        '/api/system/v1/contribution-shadow/windows',
        '/api/system/v1/contribution-shadow/windows/d3-window/summary',
        '/api/system/v1/contribution-shadow/windows/d3-window/candidates',
        '/api/system/v1/contribution-shadow/windows/d3-window/candidates/d3-audit-1',
        '/api/system/v1/contribution-shadow/windows/d3-window/attempts/d3-attempt-1/comparisons',
      ];
      for (const path of paths) {
        const response = await request(httpServer(app))
          .get(path)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body).toMatchObject({ code: 0 });
        expect(response.body).toHaveProperty('data');
        const body = JSON.stringify(response.body);
        for (const key of ['candidateEvidence"', 'context"', 'passwordHash', 'realName', 'phone'])
          expect(body).not.toContain(key);
      }
      await request(httpServer(app))
        .get(paths[0])
        .expect(401)
        .expect(({ body }) => expect(body.code).toBe(40100));
      await request(httpServer(app))
        .get(paths[0] + '?pageSize=101')
        .set('Authorization', `Bearer ${token}`)
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe(40000));
      await request(httpServer(app))
        .get('/api/system/v1/contribution-shadow/windows/missing-window/summary')
        .set('Authorization', `Bearer ${token}`)
        .expect(404)
        .expect(({ body }) => expect(body.code).toBe(40400));
      sql(`DELETE FROM role_permissions WHERE id='d3-rp-d3-read'`);
      try {
        await request(httpServer(app))
          .get(paths[1])
          .set('Authorization', `Bearer ${token}`)
          .expect(403)
          .expect(({ body }) => expect(body.code).toBe(40300));
      } finally {
        sql(
          `INSERT INTO role_permissions (id,"roleId","permissionId") VALUES ('d3-rp-d3-read','d3-role','d3-read')`,
        );
      }
      await request(httpServer(app))
        .post(paths[0])
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(404);
    } finally {
      await app.close();
    }
  }, 90_000);

  it('the actual CLI executes and replays only its privately piped, individually bound command', () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    bind(firstSignManifest);
    const directory = mkdtempSync(join(tmpdir(), 'srvf-d3-login-cli-'));
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify(firstSignManifest));
    try {
      const result = spawnSync(
        'pnpm',
        [
          'exec',
          'tsx',
          'scripts/register-contribution-shadow-reconciliation.ts',
          '--manifest',
          file,
          '--expected-manifest-hash',
          shadowReconciliationManifestHash(firstSignManifest),
          '--execute',
        ],
        {
          env: process.env,
          input: JSON.stringify({ registrarDatabaseUrl: registrarUrl, accessToken: token }),
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({
        status: 'registered',
        operation: 'sign_disposition',
        replayed: true,
        revision: 1,
      });
      expect(Object.keys(output).sort()).toEqual([
        'auditLogId',
        'manifestHash',
        'operation',
        'receiptId',
        'replayed',
        'revision',
        'status',
        'windowId',
      ]);
      for (const secret of [registrarUrl, token, 'candidateEvidence', 'password'])
        expect(result.stdout + result.stderr).not.toContain(secret);
      expect(
        sql(`SELECT count(*) FROM audit_logs WHERE event='activity.contribution-shadow.disposition-sign'
        AND context#>>'{extra,auditLogId}'='d3-audit-1'`),
      ).toBe('1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('takes an existing attempt lock before the audit lock and resumes only after the real holder releases it', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const hash = sql(
      `SELECT csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn('d3-window','d3-audit-2'))`,
    );
    const manifest: ShadowDispositionRegistrationManifest = {
      ...firstSignManifest,
      commandKey: 'd3-locked-command',
      approvalReference: 'D3-LOCKED',
      auditLogId: 'd3-audit-2',
      expectedCandidateEvidenceHash: hash,
    };
    bind(manifest);
    let acquired!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: () => void;
    const releaseHolder = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ContributionShadowAttemptReceipt" WHERE id='d3-attempt-2' FOR UPDATE`;
        acquired();
        await releaseHolder;
      },
      { timeout: 5_000 },
    );
    await holderAcquired;
    let pid = 0;
    const contender = registrar.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        pid = row.pid;
        return dispositionService.registerInTx(
          tx,
          token,
          manifest,
          shadowReconciliationManifestHash(manifest),
        );
      },
      { timeout: 5_000 },
    );
    // Attach a handler immediately, including the diagnostic-failure branch.
    void contender.catch(() => undefined);
    try {
      const deadline = performance.now() + 3_000;
      let waiting = false;
      while (!waiting) {
        if (pid !== 0) {
          const [state] = await admin.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity
            WHERE pid=${pid} AND datname=current_database()`;
          waiting = state?.waiting === true;
        }
        if (performance.now() > deadline)
          throw new Error('D3 contender did not reach the actual lock');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // A pre-existing comparison writer may still take FOR SHARE on its
      // audit. This would block/deadlock if signing took audit first.
      await admin.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout='250ms'`;
          await tx.$queryRaw`SELECT id FROM audit_logs WHERE id='d3-audit-2' FOR SHARE`;
        },
        { timeout: 1_000 },
      );
    } finally {
      release();
      await holder;
    }
    await expect(contender).resolves.toMatchObject({ replayed: false, revision: 1 });
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowDispositionApprovalReceipt" WHERE "commandKey"='d3-locked-command'`,
      ),
    ).toBe('1');
  }, 15_000);

  it('rejects independently bound bad anchors, ineligible N, stale revisions and same-key different input without partial writes', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const hash = sql(
      `SELECT csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn('d3-window','d3-audit-3'))`,
    );
    const base: ShadowDispositionRegistrationManifest = {
      ...firstSignManifest,
      auditLogId: 'd3-audit-3',
      expectedCandidateEvidenceHash: hash,
    };
    const patches: Array<Partial<ShadowDispositionRegistrationManifest>> = [
      { expectedCandidateEvidenceHash: '0'.repeat(64) },
      { windowId: 'missing-window' },
      { auditLogId: 'missing-audit' },
      { decisionCode: 'not_applicable', basisCode: 'outside_comparison_contract' },
      { expectedRevision: 2, expectedPreviousDispositionId: 'wrong-predecessor' },
      { commandKey: firstSignManifest.commandKey },
    ];
    for (const [index, patch] of patches.entries()) {
      const manifest = {
        ...base,
        commandKey: `d3-rejected-${index}`,
        approvalReference: `D3-REJECTED-${index}`,
        ...patch,
      };
      bind(manifest);
      await expect(
        registrar.$transaction(
          (tx) =>
            dispositionService.registerInTx(
              tx,
              token,
              manifest,
              shadowReconciliationManifestHash(manifest),
            ),
          { timeout: 5_000 },
        ),
      ).rejects.toThrow();
      expect(
        sql(
          `SELECT count(*) FROM "ContributionShadowDispositionApprovalReceipt" WHERE "auditLogId"='d3-audit-3'`,
        ),
      ).toBe('0');
      expect(
        sql(
          `SELECT count(*) FROM "ContributionShadowDispositionReceipt" WHERE "auditLogId"='d3-audit-3'`,
        ),
      ).toBe('0');
    }
  }, 60_000);

  it('rolls back both receipts when the same-transaction audit fails and keeps immutable evidence protected', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const hash = sql(
      `SELECT csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn('d3-window','d3-audit-4'))`,
    );
    const manifest: ShadowDispositionRegistrationManifest = {
      ...firstSignManifest,
      commandKey: 'd3-audit-rollback',
      approvalReference: 'D3-AUDIT-ROLLBACK',
      auditLogId: 'd3-audit-4',
      expectedCandidateEvidenceHash: hash,
    };
    bind(manifest);
    // The registrar cannot create a trigger or disable guards. A duplicate
    // existing audit id makes the actual final INSERT fail in PostgreSQL.
    await expect(
      registrar.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT csd3_register_fn(${JSON.stringify(manifest)}::jsonb,'d3-human',
        'd3-rollback-approval','d3-rollback-disposition','d3-audit-1')`;
        },
        { timeout: 5_000 },
      ),
    ).rejects.toThrow();
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowDispositionApprovalReceipt" WHERE id='d3-rollback-approval'`,
      ),
    ).toBe('0');
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowDispositionReceipt" WHERE id='d3-rollback-disposition'`,
      ),
    ).toBe('0');
    for (const table of [
      'ContributionShadowDispositionApprovalReceipt',
      'ContributionShadowWindowRegistrationReceipt',
    ]) {
      for (const statement of [
        `UPDATE "${table}" SET "createdAt"=clock_timestamp()`,
        `DELETE FROM "${table}"`,
        `TRUNCATE "${table}" CASCADE`,
      ]) {
        expect(() => sql(`BEGIN; ${statement}; ROLLBACK;`)).toThrow();
      }
    }
  }, 30_000);

  it('only registers prospective nonoverlapping windows with an approved mapping and an exact authority', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    const now = Number(sql(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint`));
    const base: ShadowWindowRegistrationManifest = {
      ...windowManifest,
      commandKey: 'd3-second-window',
      approvalReference: 'D3-SECOND-WINDOW',
      windowId: 'd3-second-window',
      startsAt: new Date(now + 60_000).toISOString(),
      endsAt: new Date(now + 120_000).toISOString(),
    };
    const execute = (manifest: ShadowWindowRegistrationManifest) =>
      registrar.$transaction(
        (tx) =>
          windowService.registerInTx(
            tx,
            token,
            manifest,
            shadowReconciliationManifestHash(manifest),
          ),
        { timeout: 5_000 },
      );
    bind(base);
    await expect(execute(base)).resolves.toMatchObject({
      windowId: 'd3-second-window',
      replayed: false,
    });
    await expect(execute(base)).resolves.toMatchObject({
      windowId: 'd3-second-window',
      replayed: true,
    });
    for (const [index, patch] of [
      { startsAt: windowManifest.startsAt, endsAt: windowManifest.endsAt },
      { signedMappingVersion: 'unsigned-mapping' },
      { startsAt: base.startsAt, endsAt: new Date(now + 90_000).toISOString() },
    ].entries()) {
      const manifest = {
        ...base,
        windowId: `d3-window-rejected-${index}`,
        commandKey: `d3-window-rejected-${index}`,
        ...patch,
      };
      bind(manifest);
      await expect(execute(manifest)).rejects.toThrow();
      expect(
        sql(
          `SELECT count(*) FROM "ContributionShadowObservationWindow" WHERE id='${manifest.windowId}'`,
        ),
      ).toBe('0');
    }
    // Neither a parser result nor a previous command's grant approves this one.
    await expect(
      execute({ ...base, windowId: 'd3-unbound-window', commandKey: 'd3-unbound-window' }),
    ).rejects.toThrow();
    const empty = JSON.parse(sql(`SELECT csd3_read_summary_fn('d3-second-window')`)) as Record<
      string,
      unknown
    >;
    expect(empty).toMatchObject({
      candidateCount: 0,
      rawUnresolvedCount: 0,
      netUnresolvedCount: 0,
    });
    const presenter = new ContributionShadowEvidencePresenter();
    const row = await admin.contributionShadowObservationWindow.findUniqueOrThrow({
      where: { id: 'd3-second-window' },
      include: { registrationReceipt: true },
    });
    expect(presenter.summary(empty, presenter.window(row))).toMatchObject({
      observationStatus: 'zero_visible_candidates',
    });
  }, 40_000);

  it('a genuinely late attempt makes the former signed gap stale without rewriting the approval', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    sql(`INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context)
      SELECT 'd3-late-audit',"createdAt","resourceType","resourceId",event,context FROM audit_logs WHERE id='d3-audit-5'`);
    const hash = sql(
      `SELECT csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn('d3-window','d3-late-audit'))`,
    );
    const manifest: ShadowDispositionRegistrationManifest = {
      ...firstSignManifest,
      commandKey: 'd3-late-gap',
      approvalReference: 'D3-LATE-GAP',
      auditLogId: 'd3-late-audit',
      expectedCandidateEvidenceHash: hash,
    };
    bind(manifest);
    await registrar.$transaction(
      (tx) =>
        dispositionService.registerInTx(
          tx,
          token,
          manifest,
          shadowReconciliationManifestHash(manifest),
        ),
      { timeout: 5_000 },
    );
    const read = () =>
      JSON.parse(
        sql(`SELECT value FROM csd3_read_candidate_fn('d3-window','d3-late-audit') value`),
      ) as unknown;
    expect(read()).toMatchObject({
      missingStart: true,
      signatureStatus: 'current',
      rawUnresolved: true,
    });
    sql(`INSERT INTO "ContributionShadowAttemptReceipt" (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey",
      "committedFactHash","signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
      VALUES ('d3-late-attempt','d3-window','d3-late-audit','d3-sheet','d3-activity',1,
        encode(sha256(convert_to('e3-2-d1:v1:d3-window:d3-late-audit:1','UTF8')),'hex'),repeat('a',64),'d3-fixture-v1',5,'sha256',1)`);
    expect(read()).toMatchObject({
      missingStart: false,
      missingTerminal: true,
      signatureStatus: 'stale_evidence',
      netUnresolved: true,
    });
    expect(
      sql(
        `SELECT "candidateEvidenceHash" FROM "ContributionShadowDispositionApprovalReceipt" WHERE "commandKey"='d3-late-gap'`,
      ),
    ).toBe(hash);
  }, 20_000);

  it('the same real LOGIN can be a reader only after registrar membership is revoked and still cannot inspect raw evidence', async () => {
    if (!acceptedFirstProbe) throw new Error('Full chain acceptance prerequisite failed');
    sql(`REVOKE ${ROLES[1]} FROM ${ROLES[3]}; GRANT ${ROLES[2]} TO ${ROLES[3]}`);
    try {
      await expect(
        registrar.$queryRaw`SELECT csd3_authorize_read_fn('d3-human')::text`,
      ).resolves.toHaveLength(1);
      const [row] = await registrar.$queryRaw<
        Array<{ value: unknown }>
      >`SELECT csd3_read_summary_fn('d3-window') AS value`;
      expect(row.value).toMatchObject({ candidateCount: 2003 });
      await expect(registrar.$queryRaw`SELECT context FROM audit_logs LIMIT 1`).rejects.toThrow();
      await expect(
        registrar.$queryRaw`SELECT "candidateEvidence" FROM "ContributionShadowDispositionApprovalReceipt" LIMIT 1`,
      ).rejects.toThrow();
      await expect(
        registrar.$queryRaw`SELECT csd3_register_fn('{}'::jsonb,'d3-human','x','y','z')`,
      ).rejects.toThrow();
      await expect(registrar.$executeRaw`SET ROLE srvf_d3_owner_w98_fixture`).rejects.toThrow();
    } finally {
      sql(`REVOKE ${ROLES[2]} FROM ${ROLES[3]}; GRANT ${ROLES[1]} TO ${ROLES[3]}`);
    }
  }, 20_000);

  it('rejects direct writes, forged runtime authority and a reader claiming registrar execution', async () => {
    if (!acceptedFirstProbe)
      throw new Error('First full collection probe did not pass; stop downstream acceptance');
    await expect(
      registrar.$executeRaw`INSERT INTO "ContributionShadowDispositionApprovalReceipt" (id) VALUES ('forged')`,
    ).rejects.toThrow();
    await expect(registrar.$queryRaw`SELECT * FROM "User"`).rejects.toThrow();
    await expect(
      registrar.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE srvf_d3_reader_w98_fixture`;
      }),
    ).rejects.toThrow();
    await expect(
      registrar.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('srvf.d3_authority','{}',true)`;
          await tx.$queryRaw`SELECT csd3_register_fn('{}'::jsonb,'d3-human','forged',NULL,'forged-audit')`;
        },
        { timeout: 5_000 },
      ),
    ).rejects.toThrow();
  });
});
