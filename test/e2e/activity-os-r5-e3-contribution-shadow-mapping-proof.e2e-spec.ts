import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { createTestApp } from '../setup/test-app';
import { PrismaService } from '../../src/database/prisma.service';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import appConfig from '../../src/config/app.config';
import databaseConfig from '../../src/config/database.config';
import {
  timeLedgerFixtureTriggerSql,
  withTimeLedgerFixtureCleanup,
} from '../setup/time-ledger-fixture-cleanup';
import {
  evaluateContributionPolicy,
  fingerprintContributionPolicyVersion,
} from '../../src/modules/activities/activity-contribution-policy-definition';
import {
  parseShadowMappingRegistrationManifest,
  SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT,
} from '../../src/modules/activities/activity-contribution-shadow-mapping-registration.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { ActivityContributionShadowMappingProofQuery } from '../../src/modules/activities/activity-contribution-shadow-mapping-proof.query';
import {
  evaluateShadowFrozenSource,
  prepareShadowEvidence,
  prepareShadowAttempt,
  prepareShadowComparisonSet,
  ShadowComparisonBudget,
  ContributionShadowService,
  resolveShadowMappingAtSource,
  resolveShadowSelectionAtSource,
} from '../../src/modules/attendances/contribution-shadow.service';
import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
} from '../../src/modules/activities/activity-contribution-policy-selection';
import {
  ContributionShadowEvidenceWriteService,
  type ShadowComparisonInput,
  type ShadowMappingApplicationInput,
} from '../../src/modules/attendances/contribution-shadow-evidence.write.service';

function manifestFixture() {
  return {
    schemaVersion: 1,
    commandKey: 'fixture-command',
    approvalReference: 'isolated-fixture-only',
    approvals: [
      {
        approvalNumber: 'fixture-approval',
        mappingVersion: 'fixture-v1',
        activityId: 'fixture-activity',
        activityTypeCode: 'service',
        attendanceRoleCode: 'volunteer',
        sessionPositionId: 'fixture-position',
        policyRoleCode: 'volunteer',
        categoryCode: 'volunteer_service',
        policyVersionId: 'fixture-policy',
        policyDefinitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
        durationSourceCode: 'legacy_stored_hours_2',
        effectiveFrom: '2099-10-01T00:00:00.000Z',
        effectiveUntil: null as string | null,
        eventKindCode: 'approve',
        previousApprovalId: null as string | null,
      },
    ],
  };
}

function manifestSqlHash(value: unknown): string {
  return sql(
    `SELECT csm_manifest_hash_fn('${JSON.stringify(value).replaceAll("'", "''")}'::jsonb)`,
  );
}

function manifestApplicationHash(value: unknown): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: {
      domain: 'SRVF:E3-2:shadow-mapping-registration:v1',
      manifest: parseShadowMappingRegistrationManifest(value),
    },
  });
}

function approvalRowFixture(value = manifestFixture()) {
  return {
    id: 'fixture-approval-id',
    ...value.approvals[0],
    manifestHash: manifestApplicationHash(value),
    approvalReference: value.approvalReference,
    approvedByUserId: 'fixture-human',
    registeredByUserId: 'fixture-human',
    approvedAt: '2099-09-01T00:00:00.000Z',
    createdAt: '2099-09-01T00:00:00.000Z',
  };
}

function approvalMatchesManifest(
  row: unknown,
  manifest = manifestFixture(),
  index = 0,
  actor: string | null = 'fixture-human',
  registrationTime: string | null = '2099-09-01T00:00:00.000Z',
): string {
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const text = (value: string | null) =>
    value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
  return sql(`SELECT csm_approval_matches_manifest_fn(
    jsonb_populate_record(NULL::"ContributionShadowMappingApproval", ${literal(row)}),
    ${literal(manifest)}, ${index}, ${text(actor)}, ${text(registrationTime)}::timestamptz)`);
}

const dedicated = process.env.SRVF_E3_D2_MAPPING_W98 === '1';

function policyFixture() {
  return {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'default' },
    roleRules: [
      {
        attendanceRoleCode: 'member',
        categoryRules: [
          {
            timeCategoryCode: 'volunteer_service',
            durationBands: [
              { maxSecondsInclusive: 0, recognizedPoints: '0.00', explanationCode: 'zero' },
              { maxSecondsInclusive: 60, recognizedPoints: '1.25', explanationCode: 'short' },
              { maxSecondsInclusive: 3600, recognizedPoints: '10.00', explanationCode: 'hour' },
              { maxSecondsInclusive: null, recognizedPoints: '999.99', explanationCode: 'long' },
            ],
          },
        ],
      },
    ],
  };
}

function evaluateSql(
  definition: unknown,
  duration: number,
  role = 'member',
  category = 'volunteer_service',
) {
  const literal = JSON.stringify(definition).replaceAll("'", "''");
  return JSON.parse(
    sql(
      `SELECT csm_policy_evaluate_fn('${literal}'::jsonb, '${role.replaceAll("'", "''")}', '${category}', ${duration})`,
    ),
  ) as unknown;
}

function mappingInputsFixture() {
  const policy = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: policyFixture(),
    effectiveFrom: '2099-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  return {
    approval: {
      approvedAt: '2099-01-01T00:00:00.000Z',
      effectiveFrom: '2099-02-01T00:00:00.000Z',
      effectiveUntil: null as string | null,
      eventKindCode: 'approve',
      mappingVersion: 'mapping-1',
      activityId: 'activity-1',
      activityTypeCode: 'fixture',
      attendanceRoleCode: 'old_role',
      policyRoleCode: 'member',
      categoryCode: 'volunteer_service',
      durationSourceCode: 'legacy_stored_hours_2',
      policyVersionId: 'policy-1',
      policyDefinitionHash: policy.definitionHash,
      evaluatorVersion: 1,
    },
    source: {
      windowId: 'window-1',
      activityId: 'activity-1',
      activityTypeCode: 'fixture',
      attendanceRoleCode: 'old_role',
      sourceKindCode: 'matched',
      legacyServiceHours: '1.01',
    },
    observation: {
      id: 'window-1',
      signedMappingVersion: 'mapping-1',
      startsAt: '2099-01-01T00:00:00.000Z',
      endsAt: '2099-12-31T00:00:00.000Z',
    },
    policy: {
      id: 'policy-1',
      definitionHash: policy.definitionHash,
      schemaVersion: 1,
      evaluatorVersion: 1,
      definitionJson: policyFixture(),
      effectiveFrom: policy.effectiveFrom,
      effectiveUntil: policy.effectiveUntil,
    },
    auditTime: '2099-03-01T00:00:00.000Z',
  };
}

function evaluateMappingInputs(value: ReturnType<typeof mappingInputsFixture>): unknown {
  const row = (table: string, data: unknown) =>
    `jsonb_populate_record(NULL::"${table}", '${JSON.stringify(data).replaceAll("'", "''")}'::jsonb)`;
  return JSON.parse(
    sql(`SELECT csm_mapping_inputs_result_fn(
    ${row('ContributionShadowMappingApproval', value.approval)},
    ${row('ContributionShadowLegacySourceAnchor', value.source)},
    ${row('ContributionShadowObservationWindow', value.observation)},
    ${row('ContributionPolicyVersion', value.policy)},
    '${value.auditTime}'::timestamptz)`),
  ) as unknown;
}

function policyFingerprintSql(policy: unknown): string {
  const literal = JSON.stringify(policy).replaceAll("'", "''");
  return sql(
    `SELECT csm_policy_fingerprint_fn(jsonb_populate_record(NULL::"ContributionPolicyVersion", '${literal}'::jsonb))`,
  );
}

function registrationReferencesFixture() {
  const manifest = manifestFixture();
  const item = manifest.approvals[0];
  item.activityId = 'ref-activity';
  item.activityTypeCode = 'service';
  item.sessionPositionId = 'ref-position';
  item.policyRoleCode = 'member';
  item.policyVersionId = 'ref-version';
  const policy = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: policyFixture(),
    effectiveFrom: '2099-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  item.policyDefinitionHash = policy.definitionHash;
  const definition = JSON.stringify(policy.definition).replaceAll("'", "''");
  const fixtureSql = `
    INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('ref-user','ref-user','fixture',CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt") VALUES ('ref-org','Reference fixture','team',CURRENT_TIMESTAMP);
    INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt") VALUES
      ('ref-activity','Reference fixture','service','ref-org','2099-10-01','2099-10-02','test','draft',CURRENT_TIMESTAMP),
      ('ref-other-activity','Other fixture','service','ref-org','2099-10-01','2099-10-02','test','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivitySession" (id,"activityId",code,name,"startAt","endAt","locationText","checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt","locationRequired","locationPolicySourceCode","statusCode","updatedAt") VALUES
      ('ref-session','ref-activity','ref_session','Reference fixture','2099-10-01 01:00','2099-10-01 02:00','test','2099-10-01','2099-10-01 01:00','2099-10-01 02:00','2099-10-01 03:00',false,'activity','scheduled',CURRENT_TIMESTAMP);
    INSERT INTO "ActivitySessionPosition" (id,"activityId","sessionId",code,name,"attendanceRoleCode","updatedAt") VALUES
      ('ref-position','ref-activity','ref-session','ref_position','Reference fixture','member',CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicy" (id,code,name,"updatedAt") VALUES ('ref-policy','ref_policy','Reference fixture',CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicyVersion" (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion","effectiveFrom","statusCode","createdByUserId","updatedAt") VALUES
      ('ref-version','ref-policy',1,1,'${definition}'::jsonb,'${policy.definitionHash}',1,'2099-01-01','draft','ref-user',CURRENT_TIMESTAMP);`;
  return { manifest, fixtureSql };
}

function registrationHumanFixtureSql() {
  return `
    INSERT INTO roles (id,code,"displayName","updatedAt") VALUES ('ref-role','shadow-fixture','Isolated fixture',CURRENT_TIMESTAMP);
    INSERT INTO permissions (id,code,module,action,"resourceType","updatedAt") VALUES
      ('ref-permission','contribution-shadow-mapping.register.approval','contribution-shadow-mapping','register','approval',CURRENT_TIMESTAMP);
    INSERT INTO role_permissions (id,"roleId","permissionId") VALUES ('ref-role-permission','ref-role','ref-permission');
    INSERT INTO role_bindings (id,"principalType","principalId","roleId","scopeType","startedAt","updatedAt") VALUES
      ('ref-binding','USER','ref-user','ref-role','GLOBAL','2000-01-01',CURRENT_TIMESTAMP);`;
}

function actualSourceApprovalFixture(ambiguous = false, legacyPoints = 2) {
  const { manifest, fixtureSql } = registrationReferencesFixture();
  if (ambiguous) {
    manifest.approvals.push({ ...manifest.approvals[0], approvalNumber: 'ref-second' });
  }
  const literal = JSON.stringify(manifest).replaceAll("'", "''");
  const ids = ambiguous ? '["ref-approval","ref-second-approval"]' : '["ref-approval"]';
  return fixtureStatement(`${fixtureSql} ${registrationHumanFixtureSql()}
    ${registrationAuthorityFixtureSql(manifest)}
    SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
    DO $fixture$ BEGIN
      PERFORM csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','${ids}'::jsonb);
    END $fixture$;
    RESET SESSION AUTHORIZATION;
    INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
      VALUES ('ref-member','REF135','Isolated fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
    INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
      VALUES ('ref-sheet','ref-activity','ref-user','pending_review',CURRENT_TIMESTAMP,1);
    INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt","serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
      VALUES ('ref-record','ref-sheet','ref-member','volunteer','2099-10-01','2099-10-01 01:00',1.00,'present',${legacyPoints},CURRENT_TIMESTAMP);
    INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
      VALUES ('ref-rule','service','volunteer',${legacyPoints},CURRENT_TIMESTAMP);
    INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
      VALUES ('ref-window','2099-10-01','2099-10-03','ref-user',repeat('a',64),repeat('a',64),'fixture-v1','sha256',1);
    INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
      VALUES ('ref-source-audit','2099-10-01 12:00','attendance_sheet','ref-sheet','attendance-sheet.submit',
        jsonb_build_object('after',jsonb_build_object('sheet',jsonb_build_object('activityId','ref-activity','version',1),
          'records',jsonb_build_array(jsonb_build_object('id','ref-record','memberId','ref-member','roleCode','volunteer','serviceHours','1','contributionPoints','${legacyPoints}'))),
          'extra',jsonb_build_object('operation','submit','recordsCount',1)),true);
    INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
      VALUES ('ref-source','ref-window','ref-source-audit','ref-sheet',1,'ref-activity','ref-record','ref-member','service','volunteer',1.00,'matched','ref-rule',${legacyPoints},${legacyPoints},'sha256',1,
        cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",jsonb_build_object(
          'windowId','ref-window','auditLogId','ref-source-audit','sheetId','ref-sheet','sheetVersion',1,'activityId','ref-activity','recordId','ref-record','memberId','ref-member',
          'activityTypeCode','service','attendanceRoleCode','volunteer','legacyServiceHours',1.00,'sourceKindCode','matched','legacyRuleId','ref-rule','pointsBelow',${legacyPoints},'legacyPoints',${legacyPoints}))));`);
}

function actualSelectionFixtureSql(createdAt = '2099-09-01T00:00:00.000Z', revision = 1) {
  const { manifest } = registrationReferencesFixture();
  const pointer = {
    policyId: 'ref-policy',
    versionId: 'ref-version',
    definitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
  };
  const document = createActivityContributionPolicySelectionDocument([
    {
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    },
    {
      scope: { layerCode: 'position', sessionId: 'ref-session', positionId: 'ref-position' },
      selection: { mode: 'explicit', pointer },
    },
  ]);
  const hash = activityContributionPolicySelectionHash(document);
  const selectionId = revision === 1 ? 'ref-selection' : `ref-selection-${revision}`;
  const result = JSON.stringify({
    activityId: 'ref-activity',
    selectionRevisionId: selectionId,
    revision,
    selectionHash: hash,
    createdAt,
  });
  return `INSERT INTO "ActivityContributionPolicySelectionRevision"
    (id,"activityId",revision,"schemaVersion","selectionHash","selectionJson","itemCount","originCode","createdAt","createdByUserId")
    VALUES ('${selectionId}','ref-activity',${revision},1,'${hash}','${JSON.stringify(document).replaceAll("'", "''")}'::jsonb,2,'select','${createdAt}','ref-user');
    INSERT INTO "ActivityContributionPolicySelectionItem"
    (id,"selectionRevisionId","activityId","layerCode","sessionId","positionId",mode,"policyId","versionId","definitionHash","evaluatorVersion") VALUES
    ('${selectionId}-root','${selectionId}','ref-activity','activity',NULL,NULL,'inherit',NULL,NULL,NULL,NULL),
    ('${selectionId}-position','${selectionId}','ref-activity','position','ref-session','ref-position','explicit','ref-policy','ref-version','${pointer.definitionHash}',1);
    UPDATE "Activity" SET "contributionPolicySelectionRevision"=${revision},"currentContributionPolicySelectionRevisionId"='${selectionId}' WHERE id='ref-activity';
    INSERT INTO "ActivityContributionPolicySelectionCommandReceipt"
    (id,"actorUserId","activityId","operationCode","operationKey","requestHash","selectionRevisionId","resultJson","createdAt")
    VALUES ('${selectionId}-receipt','ref-user','ref-activity','patch_contribution_policy_selection','${selectionId}-key',repeat('a',64),'${selectionId}','${result}'::jsonb,'${createdAt}');`;
}

function applicationInsertSql(change: Record<string, string | number> = {}) {
  const { manifest } = registrationReferencesFixture();
  const row: Record<string, string | number> = {
    id: 'ref-application',
    approvalId: 'ref-approval',
    legacySourceAnchorId: 'ref-source',
    windowId: 'ref-window',
    auditLogId: 'ref-source-audit',
    sheetId: 'ref-sheet',
    sheetVersion: 1,
    recordId: 'ref-record',
    memberId: 'ref-member',
    activityId: 'ref-activity',
    selectionItemId: 'ref-selection-position',
    policyVersionId: 'ref-version',
    policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
    durationSeconds: 3600,
    policyPoints: '10.00',
    explanationCode: 'hour',
    ...change,
  };
  return `INSERT INTO "ContributionShadowMappingApplication"
    (${Object.keys(row)
      .map((column) => `"${column}"`)
      .join(',')})
    VALUES (${Object.values(row)
      .map((value) => (typeof value === 'number' ? value : `'${value.replaceAll("'", "''")}'`))
      .join(',')});`;
}

function attemptInsertSql() {
  return `INSERT INTO "ContributionShadowAttemptReceipt"
    (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey","committedFactHash","signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
    VALUES ('ref-attempt','ref-window','ref-source-audit','ref-sheet','ref-activity',1,
      encode(sha256(convert_to('e3-2-d1:v1:ref-window:ref-source-audit:1','UTF8')),'hex'),
      repeat('a',64),'fixture-v1',1,'sha256',1);`;
}

function comparisonInsertSql(change: Record<string, string | number> = {}) {
  const { manifest } = registrationReferencesFixture();
  const row: Record<string, string | number> = {
    id: 'ref-comparison',
    attemptId: 'ref-attempt',
    recordId: 'ref-record',
    sheetId: 'ref-sheet',
    memberId: 'ref-member',
    activityId: 'ref-activity',
    classificationCode: 'points_mismatch',
    factHash: 'a'.repeat(64),
    legacyRuleId: 'ref-rule',
    policySourceHash: 'b'.repeat(64),
    selectionRevisionId: 'ref-selection',
    selectionItemId: 'ref-selection-position',
    policyVersionId: 'ref-version',
    policyId: 'ref-policy',
    definitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
    legacyServiceHours: '1.00',
    durationSeconds: 3600,
    legacyPoints: '2.00',
    policyPoints: '10.00',
    hashAlgorithmCode: 'sha256',
    canonicalVersion: 1,
    ...change,
  };
  return `INSERT INTO "ContributionShadowComparisonReceipt"
    (${Object.keys(row)
      .map((column) => `"${column}"`)
      .join(',')},comparable,"legacySourceHash")
    VALUES (${Object.values(row)
      .map((value) => (typeof value === 'number' ? value : `'${value.replaceAll("'", "''")}'`))
      .join(',')},
      true,(SELECT "legacySourceHash" FROM "ContributionShadowLegacySourceAnchor" WHERE id='ref-source'));`;
}

// Most role/ACL probes roll back; the final cross-transaction persistence probe
// commits these exact fixtures and removes them after dropping only this worker. The
// separately authorized final probe temporarily enables only runtime LOGIN,
// verifies real authentication, then revokes it. No real mapping is registered.
function registrationAuthorityFixtureSql(manifest: ReturnType<typeof manifestFixture>) {
  const owner = 'srvf_shadow_owner_w98_fixture';
  const registrar = 'srvf_shadow_registrar_w98_fixture';
  const runtime = 'srvf_shadow_runtime_w98_fixture';
  const authority = JSON.stringify({
    databaseName: deriveTestDbName(),
    manifestHash: manifestApplicationHash(manifest),
    actorUserId: 'ref-user',
    approvalReference: manifest.approvalReference,
    ownerRole: owner,
    registrarRole: registrar,
    runtimeRole: runtime,
    manifest,
  }).replaceAll("'", "''");
  const script = readFileSync(
    join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
    'utf8',
  );
  return fixtureStatement(`SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
    SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script}
    SET LOCAL srvf.shadow_registration_authority = '${authority}';
    SET LOCAL srvf.shadow_acl_action = 'bind'; ${script}`);
}

function checkRegistrationReferences(manifest: unknown, fixtureSql: string): string {
  return sql(`BEGIN; ${fixtureSql}
    SELECT csm_assert_registration_references_fn('${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb);
    SELECT 'references-checked'; ROLLBACK;`);
}

function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('mapping proof requires an isolated worker');
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
    ],
    { input: fixtureStatement(statement), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

// Instantiate only the fixed test SQL template. Never execute its production
// role branch on a worker database; all three names are unique to this worker.
function fixtureDatabase(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const database = deriveTestDbName();
  if (!process.env.JEST_WORKER_ID || !/^app_test(?:_[a-z0-9_]+)?_w[1-9][0-9]*$/.test(database)) {
    throw new Error('mapping fixture requires an exact derived worker database');
  }
  return database;
}

function fixtureSuffix(): string {
  const database = fixtureDatabase();
  return database === 'app_test_w98'
    ? 'w98'
    : createHash('sha256').update(database).digest('hex').slice(0, 16);
}

function fixtureRole(kind: 'owner' | 'registrar' | 'runtime'): string {
  return `srvf_shadow_${kind}_${fixtureSuffix()}_fixture`;
}

function fixtureStatement(statement: string): string {
  return statement
    .replaceAll('app_test_w98', fixtureDatabase())
    .replaceAll('_w98_fixture', `_${fixtureSuffix()}_fixture`);
}

describe('E3-2 D2 mapping schema construction', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let committedAclFixture = false;
  beforeAll(() => {
    if (dedicated) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      if (deriveTestDbName() !== 'app_test_w98') throw new Error('unexpected mapping proof target');
      dropWorkerDatabase('98');
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', 'app_test_w98'],
        { stdio: 'pipe' },
      );
      execFileSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
        { env: process.env, stdio: 'pipe' },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  }, 120_000);

  afterAll(() => {
    if (!dedicated && !committedAclFixture) return;
    try {
      dropWorkerDatabase(process.env.JEST_WORKER_ID!);
      if (committedAclFixture) {
        // These three names were asserted absent before this suite created them.
        // This suite's fixture DB has now gone, so no owned object is cascaded
        // or reassigned. Do not use DROP OWNED or touch any real role/database.
        execFileSync(
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
          {
            input: fixtureStatement(
              'DROP ROLE srvf_shadow_runtime_w98_fixture, srvf_shadow_registrar_w98_fixture, srvf_shadow_owner_w98_fixture;',
            ),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        committedAclFixture = false;
      }
      if (!dedicated) {
        execFileSync(
          'docker',
          ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', fixtureDatabase()],
          { stdio: 'pipe' },
        );
        execFileSync(
          'pnpm',
          ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
          { env: process.env, stdio: 'pipe' },
        );
      }
    } finally {
      if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previous.worker;
      if (previous.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.url;
    }
  });

  it('cold-replays 135 migrations and leaves all new evidence tables empty', () => {
    expect(
      sql(
        'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
    ).toBe('135');
    for (const table of [
      'ContributionShadowMappingApproval',
      'ContributionShadowMappingApplication',
      'ContributionShadowMappingRegistrationReceipt',
    ]) {
      expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
    }
  });

  it('leaves registration authority disabled and denies caller-supplied approval settings', () => {
    expect(sql('SELECT csm_registration_authority_fn() IS NULL')).toBe('t');
    const manifest = JSON.stringify(manifestFixture()).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.mapping_approved = 'true';
      SELECT csm_register_mapping_fn('${manifest}'::jsonb,'ref-user','ref-receipt','ref-audit','["ref-approval"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('prereads actual registered approval and immutable legacy source, independently evaluating policy', () => {
    const actual = sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`);
    expect(JSON.parse(actual)).toMatchObject({
      approvalId: 'ref-approval',
      legacySourceAnchorId: 'ref-source',
      activityId: 'ref-activity',
      recordId: 'ref-record',
      memberId: 'ref-member',
      sessionPositionId: 'ref-position',
      policyVersionId: 'ref-version',
      evaluatorVersion: 1,
      durationSeconds: 3600,
      recognizedPoints: '10.00',
      explanationCode: 'hour',
    });
    expect(sql('SELECT csm_registration_authority_fn() IS NULL')).toBe('t');
  });

  it.each([
    ['missing-source', 'ref-approval'],
    ['ref-source', 'missing-approval'],
  ])(
    'rejects missing real anchors rather than accepting supplied rows: %s / %s',
    (source, approval) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT csm_source_approval_result_fn('${source}','${approval}'); ROLLBACK;`),
      ).toThrow('shadow mapping source or approval unavailable');
    },
  );

  it('does not guess among multiple applicable approved mappings', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture(true)}
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`),
    ).toThrow('shadow mapping approval set is ambiguous or unavailable');
  });

  it('preserves historical approval evidence after operational registration authority is closed', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SET LOCAL srvf.shadow_acl_action = 'close'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT csm_source_approval_result_fn('ref-source','ref-approval')->>'recognizedPoints'; ROLLBACK;`),
    ).toBe('t\n10.00');
  });

  it.each([
    `UPDATE "ActivitySessionPosition" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-position'`,
    `UPDATE "ActivitySession" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-session'`,
  ])(
    'rejects an unavailable real session/position despite unchanged approval content: %s',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${change};
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`),
      ).toThrow('shadow mapping actual position unavailable');
    },
  );

  it('does not resolve shadow source IDs against caller-created temporary tables', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      CREATE TEMP TABLE "ContributionShadowLegacySourceAnchor" (LIKE public."ContributionShadowLegacySourceAnchor");
      CREATE TEMP TABLE "ContributionShadowMappingApproval" (LIKE public."ContributionShadowMappingApproval");
      SELECT csm_source_approval_result_fn('ref-source','ref-approval')->>'recognizedPoints'; ROLLBACK;`),
    ).toBe('10.00');
  });

  it('materializes a legitimate application through the isolated nonowner runtime with locked SQL proof', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "policyPoints"::text || ':' || "durationSeconds"::text || ':' || "explanationCode"
        FROM "ContributionShadowMappingApplication" WHERE id='ref-application'; ROLLBACK;`),
    ).toBe('10.00:3600:hour');
  });

  it.each([2, 10])(
    'accepts only the database-proven classification and terminal buckets for old points %s',
    (legacyPoints) => {
      const equal = legacyPoints === 10;
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture(false, legacyPoints)} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()}
      ${comparisonInsertSql({ legacyPoints, classificationCode: equal ? 'equal' : 'points_mismatch' })}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,${equal ? 1 : 0},${equal ? 0 : 1},0,0);
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "classificationCode" FROM "ContributionShadowComparisonReceipt" WHERE id='ref-comparison'; ROLLBACK;`),
      ).toBe(equal ? 'equal' : 'points_mismatch');
    },
  );

  it.each<Record<string, string | number>>([
    { policyPoints: '2.00', classificationCode: 'equal' },
    { legacyPoints: '10.00', classificationCode: 'equal' },
    { legacyServiceHours: '2.00' },
    { durationSeconds: 3599 },
    { legacyRuleId: 'other-rule' },
    { classificationCode: 'equal' },
  ])(
    'rejects forged comparison values despite valid 64-character auxiliary hashes: %p',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()} ${comparisonInsertSql(change)} ROLLBACK;`),
      ).toThrow('shadow comparison differs from immutable application proof');
    },
  );

  it('keeps comparable denied when only a source anchor and matching policy IDs exist without an application', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      ${attemptInsertSql()} ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('shadow comparison requires immutable legacy-source proof');
  });

  it('retains the original comparison set bound after a legitimate comparison', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()} ${comparisonInsertSql()}
      ${comparisonInsertSql({ id: 'ref-extra' })} ROLLBACK;`),
    ).toThrow('shadow comparison exceeds expected set');
  });

  it('runtime appends a full evidence chain without old attendance writes or raw audit reads', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,0,1,0,0);
      SELECT has_table_privilege(CURRENT_USER,'public."AttendanceSheet"','INSERT,UPDATE,DELETE')
        OR has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT,UPDATE,DELETE')
        OR has_table_privilege(CURRENT_USER,'public.audit_logs','SELECT,INSERT,UPDATE,DELETE');
      SELECT count(*) FROM "ContributionShadowTerminalReceipt" WHERE "attemptId"='ref-attempt';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
    ).toBe('f\n1');
  });

  it('generates application proof time in the database, never as an INSERT timestamp parameter', async () => {
    const field = Prisma.dmmf.datamodel.models
      .find((model) => model.name === 'ContributionShadowMappingApplication')
      ?.fields.find((item) => item.name === 'createdAt');
    expect(field?.default).toEqual({ name: 'dbgenerated', args: ['CURRENT_TIMESTAMP'] });
    const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const inserts: string[] = [];
    client.$on('query', (event) => {
      if (event.query.startsWith('INSERT INTO "public"."ContributionShadowMappingApplication"'))
        inserts.push(event.query);
    });
    const rollback = new Error('rollback database clock fixture');
    const { manifest } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $database_clock_fixture$ BEGIN
            ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
          END $database_clock_fixture$;`);
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          await tx.contributionShadowMappingApplication.createMany({
            data: [
              {
                id: 'ref-database-clock-application',
                approvalId: 'ref-approval',
                legacySourceAnchorId: 'ref-source',
                windowId: 'ref-window',
                auditLogId: 'ref-source-audit',
                sheetId: 'ref-sheet',
                sheetVersion: 1,
                recordId: 'ref-record',
                memberId: 'ref-member',
                activityId: 'ref-activity',
                selectionItemId: 'ref-selection-position',
                policyVersionId: 'ref-version',
                policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
                evaluatorVersion: 1,
                durationSeconds: 3600,
                policyPoints: '10.00',
                explanationCode: 'hour',
              },
            ],
          });
          const times = await tx.$queryRaw<Array<{ databaseClock: boolean }>>`
            SELECT "createdAt" = transaction_timestamp()::TIMESTAMPTZ(3) AS "databaseClock"
            FROM "ContributionShadowMappingApplication" WHERE id = 'ref-database-clock-application'
          `;
          expect(times).toEqual([{ databaseClock: true }]);
          expect(inserts).toHaveLength(1);
          expect(inserts[0]).not.toContain('"createdAt"');
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
  });

  it.each([false, true])(
    'executes the real Prisma batch writer under the isolated session identity (forged=%s)',
    async (forged) => {
      const client = new PrismaClient();
      const rollback = new Error('rollback-only runtime writer fixture');
      const { manifest } = registrationReferencesFixture();
      const application: ShadowMappingApplicationInput = {
        approvalId: 'ref-approval',
        legacySourceAnchorId: 'ref-source',
        windowId: 'ref-window',
        auditLogId: 'ref-source-audit',
        sheetId: 'ref-sheet',
        sheetVersion: 1,
        recordId: 'ref-record',
        memberId: 'ref-member',
        activityId: 'ref-activity',
        selectionItemId: 'ref-selection-position',
        policyVersionId: 'ref-version',
        policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
        evaluatorVersion: 1,
        durationSeconds: 3600,
        policyPoints: '10.00',
        explanationCode: 'hour',
      };
      try {
        const operation = client.$transaction(
          async (tx) => {
            // A single trusted, static DO statement keeps fixture DDL and all three
            // NOLOGIN roles rollback-only. This is not a real LOGIN acceptance test.
            await tx.$executeRawUnsafe(`DO $runtime_writer_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
          END $runtime_writer_fixture$;`);
            await tx.$executeRawUnsafe(
              fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
            );
            const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
              where: { id: 'ref-source' },
            });
            await tx.$executeRawUnsafe(attemptInsertSql());
            const comparison: ShadowComparisonInput = {
              recordId: 'ref-record',
              sheetId: 'ref-sheet',
              memberId: 'ref-member',
              activityId: 'ref-activity',
              classificationCode: forged ? 'equal' : 'points_mismatch',
              comparable: true,
              factHash: 'a'.repeat(64),
              legacySourceHash: source.legacySourceHash,
              policySourceHash: 'b'.repeat(64),
              legacyRuleId: 'ref-rule',
              selectionRevisionId: 'ref-selection',
              selectionItemId: 'ref-selection-position',
              policyVersionId: 'ref-version',
              policyId: 'ref-policy',
              definitionHash: application.policyDefinitionHash,
              evaluatorVersion: 1,
              legacyServiceHours: '1.00',
              durationSeconds: 3600,
              legacyPoints: '2.00',
              policyPoints: forged ? '2.00' : '10.00',
              failureCode: null,
              hashAlgorithmCode: 'sha256',
              canonicalVersion: 1,
            };
            const terminal =
              await new ContributionShadowEvidenceWriteService().writeCompleteComparisonSet(
                tx,
                {
                  id: 'ref-attempt',
                  windowId: 'ref-window',
                  auditLogId: 'ref-source-audit',
                  sheetId: 'ref-sheet',
                  sheetVersion: 1,
                  activityId: 'ref-activity',
                  expectedRecordCount: 1,
                },
                [application],
                [comparison],
              );
            expect(terminal).toMatchObject({
              statusCode: 'complete',
              writtenRecordCount: 1,
              equalCount: 0,
              mismatchCount: 1,
            });
            await tx.$executeRawUnsafe('RESET SESSION AUTHORIZATION');
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            throw rollback;
          },
          { timeout: 5000 },
        );
        if (forged)
          await expect(operation).rejects.toThrow(
            'shadow comparison differs from immutable application proof',
          );
        else await expect(operation).rejects.toBe(rollback);
      } finally {
        await client.$disconnect();
      }
      expect(
        sql(`SELECT count(*) FROM "ContributionShadowMappingApplication";
      SELECT count(*) FROM "ContributionShadowComparisonReceipt";
      SELECT count(*) FROM "ContributionShadowTerminalReceipt";
      SELECT count(*) FROM pg_roles WHERE rolname IN ('srvf_shadow_owner_w98_fixture',
        'srvf_shadow_registrar_w98_fixture','srvf_shadow_runtime_w98_fixture');`),
      ).toBe('0\n0\n0\n0');
    },
  );

  it('trusted owner cannot impersonate runtime for comparable evidence after a real application exists', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; ${attemptInsertSql()} ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping proof runtime is not yet verified');
  });

  it('registrar has no direct comparison receipt INSERT authority', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()}
      RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('permission denied for table ContributionShadowComparisonReceipt');
  });

  it('retains exact terminal bucket checks through the nonowner runtime', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,1,0,0,0); ROLLBACK;`),
    ).toThrow('shadow terminal buckets mismatch');
  });

  it('retains comparison-after-terminal rejection through the nonowner runtime', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,0,1,0,0);
      ${comparisonInsertSql({ id: 'ref-late' })} ROLLBACK;`),
    ).toThrow('shadow comparison after terminal');
  });

  it('owns protected trigger functions only with NOLOGIN owner, fixed search path and zero runtime direct EXECUTE', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('csm_assert_runtime_fn','csm_application_insert_guard_fn',
        'csar_insert_guard_fn','cscr_insert_guard_fn','cstr_insert_guard_fn')
        AND pg_get_userbyid(p.proowner)='srvf_shadow_owner_w98_fixture' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
        AND NOT has_function_privilege('srvf_shadow_runtime_w98_fixture',p.oid,'EXECUTE');
      ROLLBACK;`),
    ).toBe('5');
  });

  it.each<Record<string, string | number>>([
    { durationSeconds: 3601 },
    { policyPoints: '9.99' },
    { explanationCode: 'forged' },
    { memberId: 'forged-member' },
    { sheetVersion: 2 },
    { auditLogId: 'ref-register-audit' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { evaluatorVersion: 2 },
    { createdAt: '2000-01-01T00:00:00Z' },
    { createdAt: '2099-01-01T00:00:00Z' },
  ])(
    'rejects directly forged application content using independently recomputed SQL proof: %p',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql(change)} ROLLBACK;`),
      ).toThrow('shadow mapping application differs from database proof');
    },
  );

  it.each(['ref-selection-root', 'missing-selection'])(
    'does not guess a pointer from missing or inherited selection %s',
    (item) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql({ selectionItemId: item })} ROLLBACK;`),
      ).toThrow('shadow mapping immutable selection mismatch');
    },
  );

  it('rejects a selection revision created after the old source instant', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z')}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping immutable selection mismatch');
  });

  it('rejects a stale selection superseded before the exact old source instant', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      ${actualSelectionFixtureSql('2099-09-15T00:00:00.000Z', 2)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping immutable selection mismatch');
  });

  it('records a failed terminal under the append-only runtime identity without fabricating comparisons or overwriting replay', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback failed terminal fixture');
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $failed_terminal_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
        END $failed_terminal_fixture$;`);
          const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
            where: { id: 'ref-source' },
          });
          const input = prepareShadowAttempt(
            {
              windowId: source.windowId,
              auditLogId: source.auditLogId,
              sheetId: source.sheetId,
              activityId: source.activityId,
              sheetVersion: source.sheetVersion,
              signedMappingVersion: 'fixture-v1',
            },
            [source.recordId],
            [source],
          );
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          const writer = new ContributionShadowEvidenceWriteService();
          const started = await writer.readOrCreateAttempt(tx, input);
          const failed = await writer.writeFailedTerminal(tx, started.attempt);
          expect(failed.replayed).toBe(false);
          expect(failed.terminal).toMatchObject({
            statusCode: 'failed',
            expectedRecordCount: 1,
            writtenRecordCount: 0,
            equalCount: 0,
            mismatchCount: 0,
            holdCount: 0,
            errorCount: 0,
            failureCode: 'shadow_comparison_failed',
          });
          const replay = await writer.writeFailedTerminal(tx, started.attempt);
          expect(replay).toEqual({ terminal: failed.terminal, replayed: true });
          const reopened = await writer.readOrCreateAttempt(tx, input);
          expect(reopened.replayed).toBe(true);
          expect(reopened.attempt.terminal).toEqual(failed.terminal);
          expect(await tx.contributionShadowComparisonReceipt.count()).toBe(0);
          expect(await tx.contributionShadowTerminalReceipt.count()).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowAttemptReceipt" WHERE "auditLogId"='ref-source-audit'`,
      ),
    ).toBe('0');
  });

  it('prepares frozen-source comparison candidates from actual rows and agrees with independent database evaluation', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback frozen evaluation fixture');
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $frozen_evaluation_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
        END $frozen_evaluation_fixture$;`);
          const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
            where: { id: 'ref-source' },
          });
          const audit = await tx.auditLog.findUniqueOrThrow({
            where: { id: source.auditLogId },
            select: { createdAt: true },
          });
          const query = new ActivityContributionShadowMappingProofQuery();
          const mappingHistory = await query.readComparisonMappingHistory(tx, {
            activityId: source.activityId,
            sourceTime: audit.createdAt,
          });
          const mapping = resolveShadowMappingAtSource(mappingHistory, {
            activityId: source.activityId,
            activityTypeCode: source.activityTypeCode,
            attendanceRoleCode: source.attendanceRoleCode,
            mappingVersion: 'fixture-v1',
            sourceTime: audit.createdAt,
          });
          expect(mapping).not.toBeNull();
          const positions = await query.readComparisonPositions(tx, {
            activityId: source.activityId,
            positionIds: [mapping!.sessionPositionId],
          });
          expect(positions).toHaveLength(1);
          const selectionRevision = await query.readSelectionAtSource(tx, {
            activityId: source.activityId,
            sourceTime: audit.createdAt,
          });
          const selection = resolveShadowSelectionAtSource(
            selectionRevision,
            positions[0],
            audit.createdAt,
          );
          const versions = await query.readComparisonPolicyVersions(tx, [
            {
              id: mapping!.policyVersionId,
              definitionHash: mapping!.policyDefinitionHash,
              evaluatorVersion: mapping!.evaluatorVersion,
            },
          ]);
          expect(versions).toHaveLength(1);
          const evaluated = evaluateShadowFrozenSource({
            source,
            sourceTime: audit.createdAt,
            signedMappingVersion: 'fixture-v1',
            mapping,
            selectionItem: selection,
            policyVersion: versions[0],
          });
          expect(evaluated).toEqual({
            classification: 'points_mismatch',
            comparable: true,
            legacyPoints: '2.00',
            policyPoints: '10.00',
            policyExplanationCode: 'hour',
            durationSeconds: 3600,
          });
          const database = await tx.$queryRaw<
            Array<{ points: string; explanation: string; seconds: number }>
          >`
          SELECT proof->>'recognizedPoints' AS points, proof->>'explanationCode' AS explanation,
            (proof->>'durationSeconds')::INTEGER AS seconds
          FROM (SELECT csm_application_result_fn(${source.id}, ${mapping!.id}, ${selection!.id}) AS proof) evaluated
        `;
          expect(database).toEqual([
            {
              points: evaluated.policyPoints,
              explanation: evaluated.policyExplanationCode,
              seconds: evaluated.durationSeconds,
            },
          ]);
          const prepared = prepareShadowEvidence({
            source,
            sourceTime: audit.createdAt,
            signedMappingVersion: 'fixture-v1',
            mapping,
            selectionItem: selection,
            policyVersion: versions[0],
          });
          expect(prepared.application).not.toBeNull();
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          const writer = new ContributionShadowEvidenceWriteService();
          const attemptInput = prepareShadowAttempt(
            {
              windowId: 'ref-window',
              auditLogId: 'ref-source-audit',
              sheetId: 'ref-sheet',
              sheetVersion: 1,
              activityId: 'ref-activity',
              signedMappingVersion: 'fixture-v1',
            },
            ['ref-record'],
            [source],
          );
          const batch = prepareShadowComparisonSet({
            context: {
              windowId: source.windowId,
              auditLogId: source.auditLogId,
              sheetId: source.sheetId,
              activityId: source.activityId,
              sheetVersion: source.sheetVersion,
              signedMappingVersion: 'fixture-v1',
            },
            expectedRecordIds: ['ref-record'],
            sources: [source],
            sourceTime: audit.createdAt,
            mappingHistory,
            selectionRevision,
            positions,
            policyVersions: versions,
          });
          expect(batch.attempt).toEqual(attemptInput);
          expect(batch.applications).toEqual([prepared.application]);
          expect(batch.comparisons).toEqual([prepared.comparison]);
          const started = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(started.replayed).toBe(false);
          expect(started.attempt.terminal).toBeNull();
          const incompleteReplay = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(incompleteReplay.replayed).toBe(true);
          expect(incompleteReplay.attempt.id).toBe(started.attempt.id);
          await expect(
            writer.readOrCreateAttempt(tx, { ...attemptInput, committedFactHash: 'f'.repeat(64) }),
          ).rejects.toThrow('shadow attempt evidence mismatch');
          const terminal = await writer.writeCompleteComparisonSet(
            tx,
            started.attempt,
            batch.applications,
            batch.comparisons,
          );
          expect(terminal).toMatchObject({
            statusCode: 'complete',
            writtenRecordCount: 1,
            mismatchCount: 1,
            equalCount: 0,
            holdCount: 0,
            errorCount: 0,
          });
          const completedReplay = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(completedReplay.replayed).toBe(true);
          expect(completedReplay.attempt.terminal).toEqual(terminal);
          expect(await tx.contributionShadowAttemptReceipt.count()).toBe(1);
          expect(await tx.contributionShadowComparisonReceipt.count()).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(`SELECT count(*) FROM "ContributionShadowLegacySourceAnchor" WHERE id='ref-source'`),
    ).toBe('0');
  });

  it('reads approved position candidates through real Prisma only within the same actual activity', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback comparison position read fixture');
    const { fixtureSql } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $comparison_positions_read$ BEGIN
            ${fixtureSql}
          END $comparison_positions_read$;`);
          const query = new ActivityContributionShadowMappingProofQuery();
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-activity',
              positionIds: Array.from({ length: 2000 }, () => 'ref-position'),
            }),
          ).toEqual([
            {
              id: 'ref-position',
              activityId: 'ref-activity',
              sessionId: 'ref-session',
              attendanceRoleCode: 'member',
              session: { id: 'ref-session', activityId: 'ref-activity' },
            },
          ]);
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-other-activity',
              positionIds: ['ref-position'],
            }),
          ).toEqual([]);
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-activity',
              positionIds: ['absent-position'],
            }),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(sql(`SELECT count(*) FROM "ActivitySessionPosition" WHERE id='ref-position'`)).toBe('0');
  });

  it('reads exact historical selection and policy references through the real Prisma query without using the current pointer', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback historical selection read fixture');
    const { manifest, fixtureSql } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $historical_selection_read$ BEGIN
            ${fixtureSql}
            ${actualSelectionFixtureSql()}
            SET CONSTRAINTS ALL IMMEDIATE;
            SET CONSTRAINTS ALL DEFERRED;
            ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z', 2)}
            SET CONSTRAINTS ALL IMMEDIATE;
          END $historical_selection_read$;`);
          const query = new ActivityContributionShadowMappingProofQuery();
          const selection = await query.readSelectionAtSource(tx, {
            activityId: 'ref-activity',
            sourceTime: new Date('2099-10-01T12:00:00.000Z'),
          });
          expect(selection?.id).toBe('ref-selection');
          expect(selection?.revision).toBe(1);
          expect(selection?.items.map((item) => item.mode).sort()).toEqual(['explicit', 'inherit']);
          expect(
            resolveShadowSelectionAtSource(
              selection,
              { id: 'ref-position', activityId: 'ref-activity', sessionId: 'ref-session' },
              new Date('2099-10-01T12:00:00.000Z'),
            )?.id,
          ).toBe('ref-selection-position');
          expect(
            await query.readSelectionAtSource(tx, {
              activityId: 'ref-activity',
              sourceTime: new Date('2099-08-31T23:59:59.999Z'),
            }),
          ).toBeNull();
          expect(
            (
              await query.readSelectionAtSource(tx, {
                activityId: 'ref-activity',
                sourceTime: new Date('2099-09-01T00:00:00.000Z'),
              })
            )?.id,
          ).toBe('ref-selection');
          expect(
            (
              await query.readSelectionAtSource(tx, {
                activityId: 'ref-activity',
                sourceTime: new Date('2099-11-01T00:00:00.000Z'),
              })
            )?.id,
          ).toBe('ref-selection-2');
          expect(
            await query.readSelectionAtSource(tx, {
              activityId: 'ref-other-activity',
              sourceTime: new Date('2099-10-01T12:00:00.000Z'),
            }),
          ).toBeNull();
          const pointer = {
            id: 'ref-version',
            definitionHash: manifest.approvals[0].policyDefinitionHash,
            evaluatorVersion: 1,
          };
          expect(
            (await query.readComparisonPolicyVersions(tx, [pointer, pointer])).map((p) => p.id),
          ).toEqual(['ref-version']);
          expect(
            await query.readComparisonPolicyVersions(tx, [
              { ...pointer, definitionHash: 'a'.repeat(64) },
            ]),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(
        `SELECT count(*) FROM "ActivityContributionPolicySelectionRevision" WHERE "activityId"='ref-activity'`,
      ),
    ).toBe('0');
  });

  it('does not let a later selection rewrite the historical source-time choice', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z', 2)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "selectionItemId" FROM "ContributionShadowMappingApplication" WHERE id='ref-application'; ROLLBACK;`),
    ).toBe('ref-selection-position');
  });

  it.each([
    `UPDATE "ContributionShadowMappingApplication" SET "policyPoints"=0 WHERE id='ref-application'`,
    `DELETE FROM "ContributionShadowMappingApplication" WHERE id='ref-application'`,
  ])('keeps a materialized proof immutable even for the trusted test owner: %s', (mutation) => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; ${mutation}; ROLLBACK;`),
    ).toThrow('shadow mapping evidence is immutable');
  });

  it('registrar cannot directly materialize application evidence or bypass its runtime identity', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('permission denied for table ContributionShadowMappingApplication');
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping proof runtime is not yet verified');
  });

  it('keeps runtime proof available after registrar EXECUTE is closed, without granting business writes', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET LOCAL srvf.shadow_acl_action='close'; ${script}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      SELECT count(*) FROM "ContributionShadowMappingApplication";
      SELECT has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT');
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
    ).toBe('1\nf');
  });

  it('database Human gate requires a real current GLOBAL grant without SUPER_ADMIN bypass', () => {
    const { fixtureSql } = registrationReferencesFixture();
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toBe('USER');
    expect(() =>
      sql(`BEGIN; ${fixtureSql}
      UPDATE "User" SET role = 'SUPER_ADMIN' WHERE id = 'ref-user';
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toThrow('shadow mapping registration Human grant unavailable');
  });

  it.each([
    `UPDATE "User" SET status = 'DISABLED' WHERE id = 'ref-user'`,
    `UPDATE "User" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-user'`,
    `UPDATE role_bindings SET status = 'ENDED' WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "startedAt" = '2099-01-01' WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "endedAt" = '2001-01-01' WHERE id = 'ref-binding'`,
    `UPDATE roles SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-role'`,
    `UPDATE permissions SET "servicePrincipalAllowed" = TRUE WHERE id = 'ref-permission'`,
  ])('database Human gate fails closed for current invalid identity or grant %s', (change) => {
    const { fixtureSql } = registrationReferencesFixture();
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()} ${change};
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toThrow('shadow mapping registration Human grant unavailable');
  });

  it('registers synthetic approval, audit and immutable receipt atomically through a nonowner role', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT (csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','["ref-approval"]')->>'approvalCount')::INTEGER;
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt";
      SELECT count(*) FROM audit_logs WHERE event = 'activity.contribution-shadow.mapping-register';
      ROLLBACK;`),
    ).toBe('1\n1\n1\n1');
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname IN
      ('srvf_shadow_owner_w98_fixture','srvf_shadow_registrar_w98_fixture','srvf_shadow_runtime_w98_fixture')`),
    ).toBe('0');
    expect(sql(`SELECT count(*) FROM "ContributionShadowMappingApproval"`)).toBe('0');
  });

  it('closes the typed registration audit with server requestId and null ip/ua in the same transaction', () => {
    expect(SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT).toBe(
      'activity.contribution-shadow.mapping-register',
    );
    const actual = JSON.parse(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT jsonb_build_object('event',event,'context',context)
        FROM audit_logs WHERE id='ref-register-audit'; ROLLBACK;`),
    );
    expect(actual).toEqual({
      event: SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT,
      context: {
        requestId: 'shadow-mapping-registration:ref-register-audit',
        ip: null,
        ua: null,
        extra: {
          manifestHash: manifestApplicationHash(registrationReferencesFixture().manifest),
          approvalCount: 1,
        },
      },
    });
  });

  it('replays the exact command without another approval, audit or receipt', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','["ref-approval"]')->>'id';
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ignored-receipt','ignored-audit','["ignored-approval"]')->>'id';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM audit_logs WHERE event = 'activity.contribution-shadow.mapping-register';
      ROLLBACK;`),
    ).toBe('ref-receipt\nref-receipt\n1\n1');
  });

  it.each([
    [
      'srvf_shadow_runtime_w98_fixture',
      `SELECT csm_register_mapping_fn('{}','ref-user','r','a','[]')`,
      'permission denied for function csm_register_mapping_fn',
    ],
    [
      'srvf_shadow_registrar_w98_fixture',
      `INSERT INTO "ContributionShadowMappingApproval" DEFAULT VALUES`,
      'permission denied for table ContributionShadowMappingApproval',
    ],
    [
      'srvf_shadow_runtime_w98_fixture',
      `SET ROLE srvf_shadow_registrar_w98_fixture`,
      'permission denied to set role',
    ],
    [
      'srvf_shadow_registrar_w98_fixture',
      `SET ROLE srvf_shadow_owner_w98_fixture`,
      'permission denied to set role',
    ],
  ])('keeps %s out of ungranted capability: %s', (role, statement, message) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION ${role}; ${statement}; ROLLBACK;`),
    ).toThrow(message);
  });

  it('rejects a manifest substitution even when the registrar can execute the function', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const changed = { ...manifest, approvalReference: 'not-approved' };
    const literal = JSON.stringify(changed).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('rejects an actor substitution rather than trusting the SQL actor-id parameter', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'forged-user','r','a','["p"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('freezes the registration audit rather than accepting later context edits', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]');
      RESET SESSION AUTHORIZATION;
      UPDATE audit_logs SET context = '{}' WHERE id = 'a'; ROLLBACK;`),
    ).toThrow('shadow mapping evidence is immutable');
  });

  it('revokes PUBLIC execution on every authority or privileged registration helper', () => {
    expect(
      sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE n.nspname = 'public' AND p.proname IN ('csm_registration_authority_fn',
        'csm_assert_registration_authority_fn','csm_assert_registration_human_fn',
        'csm_register_mapping_fn','csm_pending_insert_guard_fn','csm_approval_receipt_closure_fn')
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`),
    ).toBe('0');
  });

  it('ACL close withdraws the function grant and binding without deleting evidence', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]')->>'id';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SET LOCAL srvf.shadow_acl_action = 'close'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT has_function_privilege('srvf_shadow_registrar_w98_fixture',
        'csm_register_mapping_fn(jsonb,text,text,text,jsonb)','EXECUTE');
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt";
      ROLLBACK;`),
    ).toBe('r\nt\nf\n1\n1');
  });

  it('ACL script refuses missing target before creating roles', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script} ROLLBACK;`),
    ).toThrow('shadow ACL explicit target and action required');
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname LIKE 'srvf_shadow_%_w98_fixture'`),
    ).toBe('0');
  });

  it('ACL script refuses bootstrap reuse instead of replacing an existing role', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
      SET LOCAL srvf.shadow_acl_action = 'bootstrap';
      CREATE ROLE srvf_shadow_owner_w98_fixture NOLOGIN; ${script} ROLLBACK;`),
    ).toThrow('shadow ACL roles already exist; no implicit reuse or replacement');
  });

  it('registrar cannot reinstall authority with caller-controlled settings or the ACL script', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SET LOCAL srvf.shadow_acl_action = 'bind'; ${script} ROLLBACK;`),
    ).toThrow('permission denied for function csm_assert_registration_human_fn');
  });

  it('registrar can read current identity but not password hashes or other user fields', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT id FROM "User" WHERE id = 'ref-user' AND "deletedAt" IS NULL AND status = 'ACTIVE';
      RESET SESSION AUTHORIZATION; ROLLBACK;`),
    ).toBe('ref-user');
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT "passwordHash" FROM "User"; ROLLBACK;`),
    ).toThrow('permission denied for table User');
  });

  it('bootstrap alone grants neither a binding nor registrar execution or login', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
      SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT has_function_privilege('srvf_shadow_registrar_w98_fixture',
        'csm_register_mapping_fn(jsonb,text,text,text,jsonb)','EXECUTE');
      SELECT bool_and(NOT rolcanlogin) FROM pg_roles WHERE rolname LIKE 'srvf_shadow_%_w98_fixture';
      ROLLBACK;`),
    ).toBe('t\nf\nt');
  });

  // Digest equality proves content equality only, never Human approval or registrar authority.
  it('computes the same manifest digest independently in PostgreSQL and the application', () => {
    const value = manifestFixture();
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    value.approvalReference = '中文😀\\"单引号\'证据';
    value.approvals[0].attendanceRoleCode = '中文😀成员';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(manifestSqlHash(reordered)).toBe(manifestApplicationHash(value));
  });

  it.each(['revoke', 'replace'])('validates a %s manifest with an explicit predecessor', (kind) => {
    const value = manifestFixture();
    value.approvals[0].eventKindCode = kind;
    value.approvals[0].previousApprovalId = 'fixture-predecessor';
    value.approvals[0].effectiveUntil = '2100-01-01T00:00:00.000Z';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
  });

  it('preserves manifest array order and normalizes integral JSON numbers like the application', () => {
    const value = manifestFixture();
    value.approvals.push({ ...value.approvals[0], approvalNumber: 'fixture-second' });
    const first = manifestSqlHash(value);
    expect(first).toBe(manifestApplicationHash(value));
    value.approvals.reverse();
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    expect(manifestSqlHash(value)).not.toBe(first);
    const raw = JSON.stringify(value).replace('"schemaVersion":1', '"schemaVersion":1.0');
    expect(sql(`SELECT csm_manifest_hash_fn('${raw}'::jsonb)`)).toBe(
      manifestApplicationHash(value),
    );
  });

  it('accepts a real leap day without weakening strict UTC timestamps', () => {
    const value = manifestFixture();
    value.approvals[0].effectiveFrom = '2096-02-29T00:00:00.000Z';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
  });

  it('independently recomputes the complete policy envelope fingerprint, including UTC effective dates', () => {
    const value = mappingInputsFixture();
    expect(policyFingerprintSql(value.policy)).toBe(value.policy.definitionHash);
    const definition = policyFixture();
    definition.roleRules[0].attendanceRoleCode = '中文😀成员';
    const expected = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: '2096-02-29T01:02:03.456Z',
      effectiveUntil: '2100-01-01T00:00:00.001Z',
    });
    const policy = {
      ...value.policy,
      definitionJson: definition,
      effectiveFrom: expected.effectiveFrom,
      effectiveUntil: expected.effectiveUntil,
    };
    expect(policyFingerprintSql(policy)).toBe(expected.definitionHash);
    const literal = JSON.stringify(policy).replaceAll("'", "''");
    expect(
      sql(`BEGIN; SET LOCAL TIME ZONE 'Asia/Shanghai';
      SELECT csm_policy_fingerprint_fn(jsonb_populate_record(NULL::"ContributionPolicyVersion", '${literal}'::jsonb)); ROLLBACK;`),
    ).toBe(expected.definitionHash);
  });

  it('rejects matching arbitrary hashes or changed policy content even when all supplied keys agree', () => {
    const value = mappingInputsFixture();
    value.policy.definitionHash = 'b'.repeat(64);
    value.approval.policyDefinitionHash = value.policy.definitionHash;
    expect(() => evaluateMappingInputs(value)).toThrow();
    const tampered = mappingInputsFixture();
    tampered.policy.definitionJson.roleRules[0].categoryRules[0].durationBands[2].recognizedPoints =
      '11.00';
    expect(() => evaluateMappingInputs(tampered)).toThrow();
    const changedInterval = mappingInputsFixture();
    changedInterval.policy.effectiveFrom = '2099-01-02T00:00:00.000Z';
    expect(() => evaluateMappingInputs(changedInterval)).toThrow();
  });

  it.each([
    { schemaVersion: 2 },
    { evaluatorVersion: 2 },
    { effectiveFrom: null },
    { effectiveUntil: '2099-01-01T00:00:00.000Z' },
  ])('rejects an invalid policy fingerprint envelope %p', (change) => {
    expect(() => policyFingerprintSql({ ...mappingInputsFixture().policy, ...change })).toThrow();
  });

  it('checks actual activity, position and policy rows without granting registration authority', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(checkRegistrationReferences(manifest, fixtureSql)).toBe('references-checked');
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApproval"')).toBe('0');
    expect(sql('SELECT count(*) FROM "Activity" WHERE id = \'ref-activity\'')).toBe('0');
  });

  it.each([
    { activityId: 'missing-activity' },
    { activityId: 'ref-other-activity' },
    { activityTypeCode: 'wrong-type' },
    { sessionPositionId: 'missing-position' },
    { policyVersionId: 'missing-version' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { policyRoleCode: 'missing-role' },
    { categoryCode: 'training' },
    { eventKindCode: 'replace', previousApprovalId: 'missing-predecessor' },
  ])('rejects a registration with unavailable or mismatched real references %p', (change) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const invalid = { ...manifest, approvals: [{ ...manifest.approvals[0], ...change }] };
    const expected =
      'policyVersionId' in change || 'policyDefinitionHash' in change
        ? 'shadow registration policy reference unavailable'
        : 'policyRoleCode' in change || 'categoryCode' in change
          ? 'shadow registration policy definition or rule unavailable'
          : 'previousApprovalId' in change
            ? 'shadow registration predecessor unavailable'
            : 'shadow registration activity or position reference unavailable';
    expect(() => checkRegistrationReferences(invalid, fixtureSql)).toThrow(expected);
    expect(sql('SELECT count(*) FROM "Activity" WHERE id = \'ref-activity\'')).toBe('0');
  });

  it.each([
    ['Activity', 'ref-activity'],
    ['ActivitySession', 'ref-session'],
    ['ActivitySessionPosition', 'ref-position'],
  ])('rejects a soft-deleted reference in %s using the actual reference guard', (table, id) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(() =>
      checkRegistrationReferences(
        manifest,
        `${fixtureSql}
      UPDATE "${table}" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = '${id}';`,
      ),
    ).toThrow('shadow registration activity or position reference unavailable');
  });

  it('rejects persisted policy content whose stored hash passes format checks but does not match', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(fixtureSql).toContain('1.25');
    const tampered = fixtureSql.replace('1.25', '1.26');
    expect(() => checkRegistrationReferences(manifest, tampered)).toThrow(
      'shadow registration policy definition or rule unavailable',
    );
    expect(sql('SELECT count(*) FROM "ContributionPolicyVersion" WHERE id = \'ref-version\'')).toBe(
      '0',
    );
  });

  it('reads real public references even when a same-name temporary Activity table is present', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const withTemp = `${fixtureSql}
      CREATE TEMP TABLE "Activity" (LIKE public."Activity" INCLUDING ALL);
      INSERT INTO pg_temp."Activity" SELECT * FROM public."Activity";
      UPDATE pg_temp."Activity" SET "activityTypeCode" = 'forged-type' WHERE id = 'ref-activity';`;
    expect(checkRegistrationReferences(manifest, withTemp)).toBe('references-checked');
    const forged = {
      ...manifest,
      approvals: [{ ...manifest.approvals[0], activityTypeCode: 'forged-type' }],
    };
    expect(() => checkRegistrationReferences(forged, withTemp)).toThrow(
      'shadow registration activity or position reference unavailable',
    );
  });

  it('matches every approval field, the independent digest, actor and database registration instant', () => {
    expect(approvalMatchesManifest(approvalRowFixture())).toBe('t');
    const manifest = manifestFixture();
    manifest.approvals[0].eventKindCode = 'replace';
    manifest.approvals[0].previousApprovalId = 'fixture-predecessor';
    manifest.approvals[0].effectiveUntil = '2100-01-01T00:00:00.000Z';
    expect(approvalMatchesManifest(approvalRowFixture(manifest), manifest)).toBe('t');
  });

  it.each([
    { approvalNumber: 'forged' },
    { mappingVersion: 'forged' },
    { activityId: 'other-activity' },
    { activityTypeCode: 'other-type' },
    { attendanceRoleCode: 'other-role' },
    { sessionPositionId: 'other-position' },
    { policyRoleCode: 'other-policy-role' },
    { categoryCode: 'training' },
    { policyVersionId: 'other-policy' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { evaluatorVersion: 2 },
    { durationSourceCode: 'guessed_span' },
    { effectiveFrom: '2099-10-02T00:00:00.000Z' },
    { effectiveUntil: '2100-01-01T00:00:00.000Z' },
    { eventKindCode: 'revoke' },
    { previousApprovalId: 'forged' },
    { manifestHash: 'b'.repeat(64) },
    { approvalReference: 'forged' },
    { approvedByUserId: 'other-human' },
    { registeredByUserId: 'other-human' },
    { approvedAt: '2099-08-31T23:59:59.999Z' },
    { createdAt: '2099-09-01T00:00:00.001Z' },
    { manifestHash: null },
  ])(
    'rejects altered approval content without treating supplied rows as authority: %p',
    (change) => {
      expect(approvalMatchesManifest({ ...approvalRowFixture(), ...change })).toBe('f');
    },
  );

  it('rejects missing identity/time or an out-of-range manifest index', () => {
    const row = approvalRowFixture();
    expect(approvalMatchesManifest(row, manifestFixture(), -1)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 1)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 0, null)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 0, 'fixture-human', null)).toBe('f');
  });

  it.each([
    { evaluatorVersion: 2 },
    { durationSourceCode: 'guessed_span' },
    { categoryCode: 'unknown' },
    { eventKindCode: 'hold' },
    { eventKindCode: ['replace'], previousApprovalId: 'fixture-predecessor' },
    { previousApprovalId: 'forged-predecessor' },
    { eventKindCode: 'revoke' },
    { effectiveFrom: '2100-02-29T00:00:00.000Z' },
    { effectiveFrom: '2099-10-01T24:00:00.000Z' },
    { effectiveFrom: '2099-10-01T00:00:00Z' },
    { effectiveUntil: '2099-10-01T00:00:00.000Z' },
    { policyDefinitionHash: 'A'.repeat(64) },
    { approvedByUserId: 'forged' },
    { attendanceRoleCode: '😀'.repeat(33) },
    { attendanceRoleCode: ' padded' },
    { attendanceRoleCode: 'control\u0001' },
    { approvalNumber: 'x'.repeat(129) },
    { activityId: null },
  ])('rejects an invalid manifest item in both independent validators: %p', (change) => {
    const value = manifestFixture();
    const invalid = { ...value, approvals: [{ ...value.approvals[0], ...change }] };
    expect(() => parseShadowMappingRegistrationManifest(invalid)).toThrow();
    expect(() => manifestSqlHash(invalid)).toThrow();
  });

  it.each(['extra-field', 'empty-approvals', 'duplicate', 'wrong-version', 'bad-command'])(
    'rejects invalid manifest root: %s',
    (kind) => {
      const value = manifestFixture();
      let invalid: unknown = value;
      if (kind === 'extra-field') invalid = { ...value, approvedByUserId: 'forged' };
      if (kind === 'empty-approvals') invalid = { ...value, approvals: [] };
      if (kind === 'duplicate')
        invalid = { ...value, approvals: [value.approvals[0], value.approvals[0]] };
      if (kind === 'wrong-version') invalid = { ...value, schemaVersion: 2 };
      if (kind === 'bad-command') invalid = { ...value, commandKey: 'x'.repeat(129) };
      expect(() => parseShadowMappingRegistrationManifest(invalid)).toThrow();
      expect(() => manifestSqlHash(invalid)).toThrow();
    },
  );

  it('installs exact same-activity/source/version foreign keys', () => {
    const constraints = sql(
      "SELECT conname FROM pg_constraint WHERE conname IN ('csma_position_fk','csma_policy_fk','csma_previous_fk','csmap_approval_fk','csmap_source_fk','csmap_selection_fk','csmap_policy_fk','csmrr_registrar_fk','csmrr_audit_fk') AND contype='f' ORDER BY conname",
    ).split('\n');
    expect(constraints).toEqual([
      'csma_policy_fk',
      'csma_position_fk',
      'csma_previous_fk',
      'csmap_approval_fk',
      'csmap_policy_fk',
      'csmap_selection_fk',
      'csmap_source_fk',
      'csmrr_audit_fk',
      'csmrr_registrar_fk',
    ]);
    expect(
      sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='csmap_source_fk'"),
    ).toContain(
      'FOREIGN KEY ("legacySourceAnchorId", "windowId", "auditLogId", "sheetId", "sheetVersion", "recordId", "memberId", "activityId")',
    );
  });

  it.each([0, 1, 59, 60, 61, 3599, 3600, 3601, 9007199254740991])(
    'database evaluation matches the existing evaluator at %s seconds',
    (durationSeconds) => {
      const definition = policyFixture();
      expect(evaluateSql(definition, durationSeconds)).toEqual(
        evaluateContributionPolicy(definition, {
          attendanceRoleCode: 'member',
          timeCategoryCode: 'volunteer_service',
          durationSeconds,
        }),
      );
    },
  );

  it.each([
    ['missing', 'volunteer_service'],
    ['member', 'training'],
  ])('keeps default evaluation for an absent role/category (%s/%s)', (role, category) => {
    expect(evaluateSql(policyFixture(), 60, role, category)).toEqual({
      recognizedPoints: '0.00',
      explanationCode: 'default',
    });
  });

  it.each(['队员', '😀'.repeat(32)])('matches valid Unicode role %s', (role) => {
    const definition = policyFixture();
    definition.roleRules[0].attendanceRoleCode = role;
    expect(evaluateSql(definition, 61, role)).toEqual(
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: role,
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 61,
      }),
    );
  });

  it('compares the largest safe threshold without floating-point rounding', () => {
    const definition = policyFixture();
    definition.roleRules[0].categoryRules[0].durationBands[2].maxSecondsInclusive = 9007199254740991;
    expect(evaluateSql(definition, 9007199254740991)).toEqual(
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 9007199254740991,
      }),
    );
  });

  it.each([
    [
      'extra root key',
      (value: ReturnType<typeof policyFixture>) => Object.assign(value, { extra: true }),
    ],
    [
      'duplicate role',
      (value: ReturnType<typeof policyFixture>) => value.roleRules.push(value.roleRules[0]),
    ],
    [
      'duplicate category',
      (value: ReturnType<typeof policyFixture>) =>
        value.roleRules[0].categoryRules.push(value.roleRules[0].categoryRules[0]),
    ],
    [
      'noncanonical points',
      (value: ReturnType<typeof policyFixture>) => {
        value.defaultResult.recognizedPoints = '01.00';
      },
    ],
    [
      'fractional threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = 0.5;
      },
    ],
    [
      'unsafe threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = 9007199254740992;
      },
    ],
    [
      'descending threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[2].maxSecondsInclusive = 60;
      },
    ],
    [
      'missing final null',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[3].maxSecondsInclusive = 9999;
      },
    ],
    [
      'invalid unselected role',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules.push({ attendanceRoleCode: ' unused', categoryRules: [] });
      },
    ],
    [
      'empty bands',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands.splice(0);
      },
    ],
    [
      'early null threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = null;
      },
    ],
    [
      'negative threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[0].maxSecondsInclusive = -1;
      },
    ],
    [
      'invalid unselected band',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[3].explanationCode = 'Bad-Code';
      },
    ],
    [
      'extra band key',
      (value: ReturnType<typeof policyFixture>) => {
        Object.assign(value.roleRules[0].categoryRules[0].durationBands[3], { extra: 1 });
      },
    ],
    [
      'too many bands',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands = Array.from(
          { length: 17 },
          (_, index) => ({
            maxSecondsInclusive: index === 16 ? null : index,
            recognizedPoints: '0.00',
            explanationCode: 'zero',
          }),
        );
      },
    ],
    [
      'too many roles',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules = Array.from({ length: 65 }, (_, index) => ({
          attendanceRoleCode: `role_${index}`,
          categoryRules: [],
        }));
      },
    ],
    [
      'UTF-16 length overflow',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = '😀'.repeat(33);
      },
    ],
    [
      'Unicode edge whitespace',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = '\uFEFFmember';
      },
    ],
    [
      'control character',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = 'member\u0085x';
      },
    ],
  ] as const)('rejects complete-policy corruption: %s', (_name, corrupt) => {
    const definition = policyFixture();
    corrupt(definition);
    expect(() =>
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 60,
      }),
    ).toThrow();
    let rejected = '';
    try {
      evaluateSql(definition, 60);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('invalid contribution policy metadata');
  });

  // Synthetic composite rows exercise the pure contract, NOT registration authority or ACL.
  it.each([
    ['0.01', 36, '1.25', 'short'],
    ['1.00', 3600, '10.00', 'hour'],
    ['1.01', 3636, '999.99', 'long'],
    ['999.99', 3599964, '999.99', 'long'],
  ])(
    'derives seconds from proven stored hours %s, never from wall-clock spans',
    (hours, seconds, points, explanation) => {
      const value = mappingInputsFixture();
      value.source.legacyServiceHours = String(hours);
      expect(evaluateMappingInputs(value)).toEqual({
        durationSeconds: seconds,
        recognizedPoints: points,
        explanationCode: explanation,
      });
    },
  );

  it.each([
    [
      'approval after old write',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.approvedAt = '2099-03-02T00:00:00.000Z';
      },
    ],
    [
      'not yet effective',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.effectiveFrom = '2099-03-02T00:00:00.000Z';
      },
    ],
    [
      'right-open effective boundary',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.effectiveUntil = v.auditTime;
      },
    ],
    [
      'revocation is not approval',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.eventKindCode = 'revoke';
      },
    ],
    [
      'window ID mismatch',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.source.windowId = 'different';
      },
    ],
    [
      'window version mismatch',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.mappingVersion = 'different';
      },
    ],
    [
      'right-open observation boundary',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.observation.endsAt = v.auditTime;
      },
    ],
    [
      'cross activity',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.activityId = 'different';
      },
    ],
    [
      'cross type',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.activityTypeCode = 'different';
      },
    ],
    [
      'cross legacy role',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.attendanceRoleCode = 'different';
      },
    ],
    [
      'no-match source remains hold',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.source.sourceKindCode = 'no_match';
      },
    ],
    [
      'wall-clock duration substitution',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.durationSourceCode = 'checkin_span';
      },
    ],
    [
      'policy version mismatch',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyVersionId = 'different';
      },
    ],
    [
      'policy hash mismatch',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyDefinitionHash = 'b'.repeat(64);
      },
    ],
    [
      'unfrozen evaluator',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.policy.evaluatorVersion = 2;
      },
    ],
    [
      'missing policy role cannot use default',
      'policy role or category missing',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyRoleCode = 'missing';
      },
    ],
    [
      'missing category cannot use default',
      'policy role or category missing',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.categoryCode = 'training';
      },
    ],
  ] as const)('rejects mapping input mismatch: %s', (_name, marker, corrupt) => {
    const value = mappingInputsFixture();
    corrupt(value);
    let rejected = '';
    try {
      evaluateMappingInputs(value);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain(marker);
  });

  // Construction-stage assertion only. Replace with the authorized real positive/negative
  // registration/evaluator suite when those guards are implemented; this is NOT D2 acceptance.
  it.each([
    'ContributionShadowMappingApproval',
    'ContributionShadowMappingApplication',
    'ContributionShadowMappingRegistrationReceipt',
  ])('currently rejects unfinished evidence writes to %s', (table) => {
    let rejected = '';
    try {
      sql(`INSERT INTO "${table}" ("id") VALUES ('isolated-construction-fixture')`);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('shadow mapping proof runtime is not yet verified');
    expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
  });

  it.each([
    ['ContributionShadowMappingApproval', 'csma_no_truncate'],
    ['ContributionShadowMappingApplication', 'csmap_no_truncate'],
    ['ContributionShadowMappingRegistrationReceipt', 'csmrr_no_truncate'],
  ])('blocks unguarded table clearing of %s', (table, trigger) => {
    expect(
      sql(`SELECT t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname='${table}' AND t.tgname='${trigger}'`),
    ).toContain('BEFORE TRUNCATE');
    let rejected = '';
    try {
      sql(`BEGIN; TRUNCATE TABLE "${table}" CASCADE; ROLLBACK;`);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('shadow mapping evidence is immutable');
  });

  function mappingTriggerStates() {
    return sql(`SELECT c.relname || ':' || t.tgenabled::text FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname IN
      ('csma_no_truncate','csmap_no_truncate','csmrr_no_truncate') ORDER BY c.relname`);
  }
  const mappingTruncate =
    'TRUNCATE TABLE "ContributionShadowMappingApplication", "ContributionShadowMappingRegistrationReceipt", "ContributionShadowMappingApproval" RESTART IDENTITY';

  it.each(['ENABLE', 'DISABLE', 'ENABLE REPLICA', 'ENABLE ALWAYS'])(
    'audit cleanup preserves exact mapping trigger mode %s and clears all evidence children',
    async (clause) => {
      const app = await createTestApp();
      const before = mappingTriggerStates();
      try {
        sql(
          `ALTER TABLE "ContributionShadowMappingApplication" ${clause} TRIGGER "csmap_no_truncate";`,
        );
        const configured = mappingTriggerStates();
        await truncateAuditLogsTestOnly(app);
        expect(mappingTriggerStates()).toBe(configured);
        expect(
          sql(`SELECT (SELECT count(*) FROM audit_logs) +
          (SELECT count(*) FROM "ContributionShadowMappingApproval") +
          (SELECT count(*) FROM "ContributionShadowMappingApplication") +
          (SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt")`),
        ).toBe('0');
      } finally {
        sql(
          'ALTER TABLE "ContributionShadowMappingApplication" ENABLE TRIGGER "csmap_no_truncate";',
        );
        await app.close();
      }
      expect(mappingTriggerStates()).toBe(before);
    },
  );

  it('audit cleanup fails closed on a missing mapping guard and rolls back base guard changes', async () => {
    const states = () =>
      sql(`SELECT string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'cs%_no_truncate'`);
    const before = states();
    const app = await createTestApp();
    const prisma = app.get(PrismaService);
    try {
      await prisma.$executeRawUnsafe(
        'ALTER TRIGGER "csmap_no_truncate" ON "ContributionShadowMappingApplication" RENAME TO "csmap_missing_fixture"',
      );
      const configured = states();
      await expect(truncateAuditLogsTestOnly(app)).rejects.toThrow(
        'Shadow fixture no-truncate trigger missing or invalid',
      );
      expect(states()).toBe(configured);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TRIGGER "csmap_missing_fixture" ON "ContributionShadowMappingApplication" RENAME TO "csmap_no_truncate"',
      );
      await app.close();
    }
    expect(states()).toBe(before);
  });

  it('restores all mapping guards after raw SQL fixture cleanup', () => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    sql(`BEGIN; ${guarded.before} ${mappingTruncate}; ${guarded.after} COMMIT;`);
    expect(mappingTriggerStates()).toBe(before);
  });

  it.each([
    ['ENABLE', 'O'],
    ['DISABLE', 'D'],
    ['ENABLE REPLICA', 'R'],
    ['ENABLE ALWAYS', 'A'],
  ])('preserves the exact pre-cleanup trigger mode %s', (clause, mode) => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    expect(
      sql(`BEGIN;
      ALTER TABLE "ContributionShadowMappingApplication" ${clause} TRIGGER "csmap_no_truncate";
      ${guarded.before} ${mappingTruncate}; ${guarded.after}
      SELECT t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname='ContributionShadowMappingApplication' AND t.tgname='csmap_no_truncate';
      ROLLBACK;`),
    ).toBe(mode);
    expect(mappingTriggerStates()).toBe(before);
  });

  it('restores all mapping guards after transaction fixture cleanup', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(
        (tx) =>
          withTimeLedgerFixtureCleanup(tx, async (guarded) => {
            await guarded.$executeRawUnsafe(mappingTruncate);
          }),
        { timeout: 30_000 },
      );
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rolls back temporary guard changes when fixture cleanup fails', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await expect(
        prisma.$transaction(
          (tx) =>
            withTimeLedgerFixtureCleanup(tx, async () => {
              throw new Error('deliberate isolated fixture failure');
            }),
          { timeout: 30_000 },
        ),
      ).rejects.toThrow('deliberate isolated fixture failure');
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rejects a present mapping table whose expected guard is missing', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              'DROP TRIGGER "csmap_no_truncate" ON "ContributionShadowMappingApplication"',
            );
            await withTimeLedgerFixtureCleanup(tx, async () => undefined);
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow('Expected fixture trigger is missing');
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('does not treat a partially present mapping family as an old schema', () => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    let rejected = '';
    try {
      sql(
        `BEGIN; ALTER TABLE "ContributionShadowMappingRegistrationReceipt" RENAME TO "isolated_missing_mapping_receipt"; ${guarded.before} ROLLBACK;`,
      );
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('Incomplete shadow mapping fixture tables');
    expect(mappingTriggerStates()).toBe(before);
  });

  it('preserves a nonempty source/audit/attendance chain across 134→135', async () => {
    if (!dedicated) return;
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (deriveTestDbName() !== 'app_test_w98') throw new Error('unexpected upgrade target');
    dropWorkerDatabase('98');
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', 'app_test_w98'],
      { stdio: 'pipe' },
    );
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-e3-d2-pre135-'));
    try {
      const root = join(process.cwd(), 'prisma');
      const predecessor = '20260929222500_activity_os_r5_e3_shadow_source_proof';
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(root, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(root, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(root, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= predecessor)
        .map((entry) => entry.name)
        .sort();
      expect(names).toHaveLength(134);
      expect(names.at(-1)).toBe(predecessor);
      for (const name of names)
        cpSync(join(root, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      const deploy = () =>
        execFileSync(
          'pnpm',
          ['exec', 'prisma', 'migrate', 'deploy', '--schema', join(temporary, 'schema.prisma')],
          { env: process.env, stdio: 'pipe' },
        );
      deploy();
      sql(`BEGIN;
        INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('up-user','up-user','fixture',CURRENT_TIMESTAMP);
        INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt") VALUES ('up-org','Upgrade fixture','team',CURRENT_TIMESTAMP);
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          VALUES ('up-member','UP135','Upgrade fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
        INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
          VALUES ('up-activity','Upgrade fixture','upgrade_fixture','up-org','2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('up-sheet','up-activity','up-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt","serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
          VALUES ('up-record','up-sheet','up-member','member','2099-01-02','2099-01-02 01:00',1.00,'present',2.00,CURRENT_TIMESTAMP);
        INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
          VALUES ('up-rule','upgrade_fixture','member',2.00,CURRENT_TIMESTAMP);
        INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
          VALUES ('up-window','2099-01-01','2099-01-03','up-user',repeat('a',64),repeat('a',64),'up-mapping','sha256',1);
        INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
          VALUES ('up-audit','2099-01-01 12:00','attendance_sheet','up-sheet','attendance-sheet.submit',
            jsonb_build_object('after',jsonb_build_object('sheet',jsonb_build_object('activityId','up-activity','version',1),
              'records',jsonb_build_array(jsonb_build_object('id','up-record','memberId','up-member','roleCode','member','serviceHours','1','contributionPoints','2'))),
              'extra',jsonb_build_object('operation','submit','recordsCount',1)),true);
        INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
          VALUES ('up-source','up-window','up-audit','up-sheet',1,'up-activity','up-record','up-member','upgrade_fixture','member',1.00,'matched','up-rule',2.00,2.00,'sha256',1,
            cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor", jsonb_build_object(
              'windowId','up-window','auditLogId','up-audit','sheetId','up-sheet','sheetVersion',1,'activityId','up-activity','recordId','up-record','memberId','up-member',
              'activityTypeCode','upgrade_fixture','attendanceRoleCode','member','legacyServiceHours',1.00,'sourceKindCode','matched','legacyRuleId','up-rule','pointsBelow',2.00,'legacyPoints',2.00))));
        COMMIT;`);
      const evidence = () =>
        sql(`SELECT jsonb_build_object(
        'source',(SELECT to_jsonb(s) FROM "ContributionShadowLegacySourceAnchor" s WHERE id='up-source'),
        'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE id='up-audit'),
        'record',(SELECT to_jsonb(r) FROM "AttendanceRecord" r WHERE id='up-record'),
        'sheet',(SELECT to_jsonb(s) FROM "AttendanceSheet" s WHERE id='up-sheet'))`);
      const before = evidence();
      const successor = '20260930120000_activity_os_r5_e3_shadow_mapping_proof';
      cpSync(join(root, 'migrations', successor), join(temporary, 'migrations', successor), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      deploy();
      expect(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')).toBe(
        '135',
      );
      expect(evidence()).toBe(before);
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingApproval"')).toBe('0');
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt"')).toBe('0');
      const client = new PrismaClient();
      try {
        const query = new ActivityContributionShadowMappingProofQuery();
        const manifest = manifestFixture();
        manifest.approvals[0].activityId = 'up-activity';
        manifest.approvals[0].activityTypeCode = 'upgrade_fixture';
        const references = await client.$transaction((tx) =>
          query.readRegistrationReferences(tx, manifest),
        );
        expect(references).toEqual({
          activities: [{ id: 'up-activity', activityTypeCode: 'upgrade_fixture' }],
          sessionPositions: [],
          policies: [],
          previousApprovals: [],
        });
        manifest.approvals[0].activityId = 'missing-activity';
        const missing = await client.$transaction((tx) =>
          query.readRegistrationReferences(tx, manifest),
        );
        expect(missing.activities).toEqual([]);
        expect(
          await client.$transaction((tx) =>
            query.readMappingEvents(tx, {
              activityId: 'up-activity',
              mappingVersion: 'up-mapping',
              sourceTime: new Date('2099-01-01T12:00:00.000Z'),
            }),
          ),
        ).toEqual([]);
        // Reading a registration reference never approves it or changes historical evidence.
        expect(evidence()).toBe(before);
      } finally {
        await client.$disconnect();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);

  it('checks a string containment fast path against legacy text membership and measures the fixed 2,000-record JSON scan', () => {
    const evidence = JSON.parse(
      sql(`BEGIN;
      DO $membership_probe$
      DECLARE records jsonb; variants jsonb; item jsonb; wanted text; old_found boolean;
        fast_found boolean; mismatches integer := 0; began timestamptz;
        scan_ms numeric; contain_ms numeric; total integer := 0;
      BEGIN
        variants := '[[],[null],[1],["text"],[[{"id":"1","memberId":"member"}]],
          [{"id":"1","memberId":"member"}],[{"id":1,"memberId":"member"}],
          [{"id":true,"memberId":"member"}],[{"id":null,"memberId":"member"}],
          [{"id":"1"}],[{"id":"1","memberId":1}],
          [{"id":["1"],"memberId":"member"}],[{"id":"1","memberId":["member"]}],
          [{"id":["1"],"memberId":["member"]}],[{"id":{"a":1},"memberId":"member"}]]'::jsonb;
        FOR item IN SELECT value FROM jsonb_array_elements(variants) LOOP
          FOREACH wanted IN ARRAY ARRAY['1','true','missing'] LOOP
            SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(item) e(value)
              WHERE value->>'id'=wanted AND value->>'memberId'='member') INTO old_found;
            fast_found := item @> jsonb_build_array(jsonb_build_object('id',wanted,'memberId','member'));
            IF fast_found AND NOT old_found THEN mismatches := mismatches+1; END IF;
          END LOOP;
        END LOOP;
        SELECT jsonb_agg(jsonb_build_object('id','bulk-record-'||n,'memberId','bulk-member-'||n) ORDER BY n)
          INTO records FROM generate_series(1,2000) n;
        began := clock_timestamp();
        FOR i IN 1..2000 LOOP
          SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(records) e(value)
            WHERE value->>'id'='bulk-record-'||i AND value->>'memberId'='bulk-member-'||i) INTO old_found;
          IF old_found THEN total := total+1; END IF;
        END LOOP;
        scan_ms := extract(epoch FROM clock_timestamp()-began)*1000;
        IF total <> 2000 THEN RAISE EXCEPTION 'membership probe scan count mismatch'; END IF;
        total := 0;
        began := clock_timestamp();
        FOR i IN 1..2000 LOOP
          fast_found := records @> jsonb_build_array(jsonb_build_object('id','bulk-record-'||i,'memberId','bulk-member-'||i));
          IF fast_found THEN total := total+1; END IF;
        END LOOP;
        contain_ms := extract(epoch FROM clock_timestamp()-began)*1000;
        IF total <> 2000 THEN RAISE EXCEPTION 'membership probe containment count mismatch'; END IF;
        PERFORM set_config('srvf.shadow_fixture_membership_probe',jsonb_build_object(
          'unexpectedFastAccepts',mismatches,'matchedRecords',total,
          'scanMs',round(scan_ms),'containMs',round(contain_ms))::text,true);
      END $membership_probe$;
      SELECT current_setting('srvf.shadow_fixture_membership_probe'); ROLLBACK;`),
    ) as {
      unexpectedFastAccepts: number;
      matchedRecords: number;
      scanMs: number;
      containMs: number;
    };
    expect(evidence.unexpectedFastAccepts).toBe(0);
    expect(evidence.matchedRecords).toBe(2000);
    // Fixed fixture counts/times only, never SQL, parameters, raw audit or identity.
    console.info('[shadow-w98-json-membership] ' + JSON.stringify(evidence));
  });

  it.each([
    '[]',
    '[null]',
    '[1]',
    '["text"]',
    '[{"id":"1","memberId":"member"}]',
    '[{"id":1,"memberId":"member"}]',
    '[{"id":true,"memberId":"member"}]',
    '[{"id":"1","memberId":1}]',
    '[{"id":1,"memberId":1}]',
    '[{"id":"1"},{"memberId":"member"}]',
    '[[{"id":"1","memberId":"member"}]]',
    '[{"id":["1"],"memberId":["member"]}]',
    '[{"id":{"a":1},"memberId":"member"}]',
  ])('preserves original membership on fast hit or fallback for %s', (records) => {
    const result = sql(`SELECT bool_and(old_found IS NOT DISTINCT FROM new_found) FROM (
      SELECT EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
        WHERE value->>'id'=wanted_id AND value->>'memberId'=wanted_member) AS old_found,
        CASE WHEN jsonb_typeof('${records}'::jsonb)='array' AND '${records}'::jsonb @>
          jsonb_build_array(jsonb_build_object('id',wanted_id,'memberId',wanted_member))
          THEN TRUE ELSE EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
            WHERE value->>'id'=wanted_id AND value->>'memberId'=wanted_member) END AS new_found
      FROM unnest(ARRAY['1','true','missing']) wanted_id
        CROSS JOIN unnest(ARRAY['member','1','missing']) wanted_member) compared;`);
    expect(result).toBe('t');
  });

  it.each(['{}', '"scalar"', '1', 'null'])(
    'retains the original non-array error on %s',
    (records) => {
      expect(() =>
        sql(`SELECT CASE WHEN jsonb_typeof('${records}'::jsonb)='array' AND
      '${records}'::jsonb @> '[{"id":"1","memberId":"member"}]'::jsonb THEN TRUE ELSE
      EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
        WHERE value->>'id'='1' AND value->>'memberId'='member') END;`),
      ).toThrow();
    },
  );

  // Deliberately last: previous probes and 134→135 upgrade retain their original
  // rollback semantics. Only these authorized fixtures survive until afterAll.
  it('keeps a committed start after rollback, recovers read-only failed replay, and compares 2,000 frozen records within one budget', async () => {
    fixtureDatabase();
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname IN (
      'srvf_shadow_runtime_w98_fixture','srvf_shadow_registrar_w98_fixture','srvf_shadow_owner_w98_fixture')`),
    ).toBe('0');
    sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} COMMIT;`);
    committedAclFixture = true;
    const primary = new PrismaClient();
    const connection = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
      connection.pathname !== `/${fixtureDatabase()}`
    )
      throw new Error('LOGIN fixture requires exact local worker connection');
    const password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    connection.username = fixtureRole('runtime');
    connection.password = password;
    connection.searchParams.set('connect_timeout', '1');
    connection.searchParams.set('pool_timeout', '1');
    connection.searchParams.set('connection_limit', '1');
    const runtimeProvider = new ContributionShadowService(
      { ...appConfig(), contributionShadowMode: 'shadow' },
      { ...databaseConfig(), contributionShadowUrl: connection.toString() },
    );
    const runtime = await runtimeProvider.withRuntimeClient(async (client) => client);
    if (!runtime) throw new Error('isolated runtime provider unexpectedly disabled');
    const writer = new ContributionShadowEvidenceWriteService();
    const legacyEvidence = () =>
      sql(`SELECT jsonb_build_object(
      'source',(SELECT to_jsonb(s) FROM "ContributionShadowLegacySourceAnchor" s WHERE id='ref-source'),
      'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE id='ref-source-audit'),
      'record',(SELECT to_jsonb(r) FROM "AttendanceRecord" r WHERE id='ref-record'),
      'sheet',(SELECT to_jsonb(s) FROM "AttendanceSheet" s WHERE id='ref-sheet'))`);
    const before = legacyEvidence();
    const inRuntime = <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: ReturnType<ShadowComparisonBudget['transactionOptions']>,
    ) =>
      runtime.$transaction(async (tx) => {
        const identity = await tx.$queryRaw<
          Array<{ identity: string; oldWrite: boolean; auditRead: boolean }>
        >`
          SELECT SESSION_USER::TEXT AS identity,
            has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT,UPDATE,DELETE') AS "oldWrite",
            has_table_privilege(CURRENT_USER,'public.audit_logs','SELECT') AS "auditRead"
        `;
        expect(identity).toEqual([
          { identity: fixtureRole('runtime'), oldWrite: false, auditRead: false },
        ]);
        return work(tx);
      }, options);
    try {
      await primary
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('srvf.shadow_login_fixture_password',${password},TRUE)`;
          await tx.$executeRawUnsafe(
            fixtureStatement(`DO $fixture_login$ BEGIN
          EXECUTE format('ALTER ROLE srvf_shadow_runtime_w98_fixture LOGIN PASSWORD %L',
            current_setting('srvf.shadow_login_fixture_password'));
          GRANT CONNECT ON DATABASE app_test_w98 TO srvf_shadow_runtime_w98_fixture;
        END $fixture_login$;`),
          );
        })
        .catch(() => {
          throw new Error('isolated LOGIN fixture setup failed');
        });
      const invalidConnection = new URL(connection.toString());
      invalidConnection.password = randomUUID();
      const invalid = new PrismaClient({ datasourceUrl: invalidConnection.toString() });
      try {
        // A trust-authenticated socket is not proof of independent credentials.
        const wrongPasswordAccepted = await invalid.$connect().then(
          () => true,
          () => false,
        );
        expect(wrongPasswordAccepted).toBe(false);
      } finally {
        await invalid.$disconnect();
      }
      await runtime.$connect().catch(() => {
        throw new Error('isolated runtime LOGIN failed');
      });
      for (const statement of [
        'UPDATE public."AttendanceRecord" SET "roleCode"="roleCode" WHERE FALSE',
        'SELECT id FROM public.audit_logs LIMIT 0',
      ]) {
        const denied = await runtime.$executeRawUnsafe(statement).then(
          () => false,
          (error: unknown) =>
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2010' &&
            error.meta?.code === '42501',
        );
        expect(denied).toBe(true);
      }
      const prepared = await primary.$transaction(async (tx) => {
        const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
          where: { id: 'ref-source' },
        });
        const audit = await tx.auditLog.findUniqueOrThrow({
          where: { id: source.auditLogId },
          select: { createdAt: true },
        });
        const query = new ActivityContributionShadowMappingProofQuery();
        const mappingHistory = await query.readComparisonMappingHistory(tx, {
          activityId: source.activityId,
          sourceTime: audit.createdAt,
        });
        const selectionRevision = await query.readSelectionAtSource(tx, {
          activityId: source.activityId,
          sourceTime: audit.createdAt,
        });
        const positions = await query.readComparisonPositions(tx, {
          activityId: source.activityId,
          positionIds: mappingHistory.map((event) => event.sessionPositionId),
        });
        const policyVersions = await query.readComparisonPolicyVersions(
          tx,
          mappingHistory.map((event) => ({
            id: event.policyVersionId,
            definitionHash: event.policyDefinitionHash,
            evaluatorVersion: event.evaluatorVersion,
          })),
        );
        return prepareShadowComparisonSet({
          context: {
            windowId: source.windowId,
            auditLogId: source.auditLogId,
            sheetId: source.sheetId,
            activityId: source.activityId,
            sheetVersion: source.sheetVersion,
            signedMappingVersion: 'fixture-v1',
          },
          expectedRecordIds: [source.recordId],
          sources: [source],
          sourceTime: audit.createdAt,
          mappingHistory,
          selectionRevision,
          positions,
          policyVersions,
        });
      });
      expect(prepared.comparisons).toHaveLength(1);
      expect(prepared.comparisons[0].classificationCode).toBe('points_mismatch');
      const started = await inRuntime((tx) => writer.readOrCreateAttempt(tx, prepared.attempt));
      expect(started.replayed).toBe(false);
      expect(started.attempt.terminal).toBeNull();
      expect(await primary.contributionShadowAttemptReceipt.count()).toBe(1);

      const injected = new Error('isolated fault before comparison commit');
      await expect(
        inRuntime(async (tx) => {
          const terminal = await writer.writeCompleteComparisonSet(
            tx,
            started.attempt,
            prepared.applications,
            prepared.comparisons,
          );
          expect(terminal).toMatchObject({
            statusCode: 'complete',
            writtenRecordCount: 1,
            mismatchCount: 1,
          });
          throw injected;
        }),
      ).rejects.toBe(injected);
      expect(await primary.contributionShadowAttemptReceipt.count()).toBe(1);
      expect(await primary.contributionShadowMappingApplication.count()).toBe(0);
      expect(await primary.contributionShadowComparisonReceipt.count()).toBe(0);
      expect(await primary.contributionShadowTerminalReceipt.count()).toBe(0);
      expect(legacyEvidence()).toBe(before);

      const failed = await inRuntime((tx) => writer.writeFailedTerminal(tx, started.attempt));
      expect(failed.replayed).toBe(false);
      expect(failed.terminal).toMatchObject({
        statusCode: 'failed',
        expectedRecordCount: 1,
        writtenRecordCount: 0,
        equalCount: 0,
        mismatchCount: 0,
        holdCount: 0,
        errorCount: 0,
        failureCode: 'shadow_comparison_failed',
      });
      const replay = await inRuntime((tx) => writer.readOrCreateAttempt(tx, prepared.attempt));
      expect(replay.replayed).toBe(true);
      expect(replay.attempt.id).toBe(started.attempt.id);
      expect(replay.attempt.terminal).toEqual(failed.terminal);
      const recoveryReplay = await inRuntime((tx) =>
        writer.writeFailedTerminal(tx, started.attempt),
      );
      expect(recoveryReplay).toEqual({ terminal: failed.terminal, replayed: true });
      expect(await primary.contributionShadowTerminalReceipt.count()).toBe(1);
      expect(legacyEvidence()).toBe(before);

      // Fresh synthetic old outcome, distinct audit/sheet/Record IDs. Every
      // record has its own member: this does not manufacture overlapping facts
      // for one person or replace missing source proof with a result hash.
      sql(`BEGIN;
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          SELECT 'bulk-member-'||n,'BULK135-'||n,'Isolated bulk fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP
          FROM generate_series(1,2000) n;
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('bulk-sheet','ref-activity','ref-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
          "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
          SELECT 'bulk-record-'||n,'bulk-sheet','bulk-member-'||n,'volunteer','2099-10-01'::timestamptz,
            '2099-10-01 01:00'::timestamptz,1.00,'present',2.00,CURRENT_TIMESTAMP
          FROM generate_series(1,2000) n;
        INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
          SELECT 'bulk-audit','2099-10-01 12:00','attendance_sheet','bulk-sheet','attendance-sheet.submit',
            jsonb_build_object('after',jsonb_build_object(
              'sheet',jsonb_build_object('activityId','ref-activity','version',1),
              'records',jsonb_agg(jsonb_build_object('id',id,'memberId',"memberId",'roleCode',"roleCode",
                'serviceHours','1','contributionPoints','2') ORDER BY id)),
              'extra',jsonb_build_object('operation','submit','recordsCount',2000)),true
          FROM "AttendanceRecord" WHERE "sheetId"='bulk-sheet';
        INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion",
          "activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours",
          "sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
          SELECT 'bulk-source-'||id,'ref-window','bulk-audit','bulk-sheet',1,'ref-activity',id,"memberId",
            'service','volunteer',1.00,'matched','ref-rule',2.00,2.00,'sha256',1,
            cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",jsonb_build_object(
              'windowId','ref-window','auditLogId','bulk-audit','sheetId','bulk-sheet','sheetVersion',1,
              'activityId','ref-activity','recordId',id,'memberId',"memberId",'activityTypeCode','service',
              'attendanceRoleCode','volunteer','legacyServiceHours',1.00,'sourceKindCode','matched',
              'legacyRuleId','ref-rule','pointsBelow',2.00,'legacyPoints',2.00)))
          FROM "AttendanceRecord" WHERE "sheetId"='bulk-sheet';
        COMMIT;`);
      // Cold runtime connection belongs to this one countdown, not fixture prep.
      await runtime.$disconnect();
      const budget = new ShadowComparisonBudget();
      const began = performance.now();
      let stage = 'prepare';
      const phaseTimes = { beforeComparisonMs: 0, comparisonTimeoutMs: 0, poolWaitMs: 0 };
      let rollbackPlanProbe: (() => void) | undefined;
      try {
        const bulk = await primary.$transaction(async (tx) => {
          const sources = await tx.contributionShadowLegacySourceAnchor.findMany({
            where: { auditLogId: 'bulk-audit' },
          });
          const audit = await tx.auditLog.findUniqueOrThrow({
            where: { id: 'bulk-audit' },
            select: { createdAt: true },
          });
          const query = new ActivityContributionShadowMappingProofQuery();
          const mappingHistory = await query.readComparisonMappingHistory(tx, {
            activityId: 'ref-activity',
            sourceTime: audit.createdAt,
          });
          const selectionRevision = await query.readSelectionAtSource(tx, {
            activityId: 'ref-activity',
            sourceTime: audit.createdAt,
          });
          const positions = await query.readComparisonPositions(tx, {
            activityId: 'ref-activity',
            positionIds: mappingHistory.map((event) => event.sessionPositionId),
          });
          const policyVersions = await query.readComparisonPolicyVersions(
            tx,
            mappingHistory.map((event) => ({
              id: event.policyVersionId,
              definitionHash: event.policyDefinitionHash,
              evaluatorVersion: event.evaluatorVersion,
            })),
          );
          return prepareShadowComparisonSet({
            context: {
              windowId: 'ref-window',
              auditLogId: 'bulk-audit',
              sheetId: 'bulk-sheet',
              activityId: 'ref-activity',
              sheetVersion: 1,
              signedMappingVersion: 'fixture-v1',
            },
            expectedRecordIds: sources.map((source) => source.recordId),
            sources,
            sourceTime: audit.createdAt,
            mappingHistory,
            selectionRevision,
            positions,
            policyVersions,
          });
        }, budget.transactionOptions());
        expect(bulk.applications).toHaveLength(2000);
        expect(bulk.comparisons).toHaveLength(2000);
        expect(bulk.comparisons.every((row) => row.classificationCode === 'points_mismatch')).toBe(
          true,
        );
        stage = 'start';
        const bulkStart = await runtimeProvider.withBoundedRuntimeClient(
          budget,
          (client, options) => {
            expect(client).toBe(runtime);
            return inRuntime((tx) => writer.readOrCreateAttempt(tx, bulk.attempt), options);
          },
        );
        if (!bulkStart) throw new Error('isolated runtime unexpectedly disabled');
        if (process.env.SRVF_E3_D2_BULK_EXPLAIN_W98 === '1') {
          rollbackPlanProbe = () => {
            const insert = (
              table: 'ContributionShadowMappingApplication' | 'ContributionShadowComparisonReceipt',
              rows: Array<Record<string, unknown>>,
            ) => {
              const columns = Object.keys(rows[0]);
              if (columns.some((column) => !/^[A-Za-z][A-Za-z0-9]*$/.test(column)))
                throw new Error('isolated plan probe column mismatch');
              const names = columns.map((column) => `"${column}"`).join(',');
              const projection = columns.map((column) => `r."${column}"`).join(',');
              const data = JSON.stringify(rows).replaceAll("'", "''");
              return `INSERT INTO "${table}" (${names}) SELECT ${projection}
                FROM jsonb_populate_recordset(NULL::"${table}",'${data}'::jsonb) r;`;
            };
            // Explicit opt-in, rollback-only SQL plan probe, not a retried
            // application command or a changed five-second business timeout.
            const plan = JSON.parse(
              sql(`BEGIN;
              SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
              ${insert(
                'ContributionShadowMappingApplication',
                bulk.applications.map((row) => ({ ...row, id: randomUUID() })),
              )}
              EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
              ${insert(
                'ContributionShadowComparisonReceipt',
                bulk.comparisons.map((row) => ({
                  ...row,
                  id: randomUUID(),
                  attemptId: bulkStart.attempt.id,
                })),
              )}
              ROLLBACK;`),
            ) as Array<{
              'Execution Time': number;
              Triggers?: Array<{ 'Trigger Name': string; Time: number; Calls: number }>;
            }>;
            console.info(
              '[shadow-w98-comparison-plan] ' +
                JSON.stringify({
                  executionMs: plan[0]['Execution Time'],
                  triggers: (plan[0].Triggers ?? []).map((trigger) => ({
                    name: trigger['Trigger Name'],
                    durationMs: trigger.Time,
                    calls: trigger.Calls,
                  })),
                }),
            );
            expect(
              sql(`SELECT count(*) FROM "ContributionShadowComparisonReceipt"
              WHERE "attemptId"='${bulkStart.attempt.id.replaceAll("'", "''")}'`),
            ).toBe('0');
            expect(
              sql(
                `SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='bulk-audit'`,
              ),
            ).toBe('0');
          };
        }
        phaseTimes.beforeComparisonMs = Math.round(performance.now() - began);
        stage = 'comparison';
        const bulkTerminal = await runtimeProvider.withBoundedRuntimeClient(
          budget,
          (client, options) => {
            expect(client).toBe(runtime);
            phaseTimes.comparisonTimeoutMs = options.timeout;
            phaseTimes.poolWaitMs = options.maxWait;
            return inRuntime(
              (tx) =>
                writer.writeCompleteComparisonSet(
                  tx,
                  bulkStart.attempt,
                  bulk.applications,
                  bulk.comparisons,
                ),
              options,
            );
          },
        );
        expect(bulkTerminal).toMatchObject({
          statusCode: 'complete',
          expectedRecordCount: 2000,
          writtenRecordCount: 2000,
          mismatchCount: 2000,
          equalCount: 0,
          holdCount: 0,
          errorCount: 0,
        });
        expect(performance.now() - began).toBeLessThan(5000);
        console.info(
          `[shadow-w98-bulk] status=complete elapsedMs=${Math.round(performance.now() - began)} records=2000`,
        );
        expect(legacyEvidence()).toBe(before);
      } catch (error) {
        const code =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028'
            ? 'P2028'
            : 'other';
        console.info(
          `[shadow-w98-bulk] stage=${stage} elapsedMs=${Math.round(performance.now() - began)} class=${code}`,
        );
        console.info('[shadow-w98-bulk] phases=' + JSON.stringify(phaseTimes));
        rollbackPlanProbe?.();
        throw new Error('isolated 2,000-record shadow comparison failed its unchanged budget');
      }
    } finally {
      await runtimeProvider.onModuleDestroy();
      await primary.$executeRawUnsafe(
        fixtureStatement('ALTER ROLE srvf_shadow_runtime_w98_fixture NOLOGIN PASSWORD NULL'),
      );
      await primary.$executeRawUnsafe(
        fixtureStatement(
          'REVOKE CONNECT ON DATABASE app_test_w98 FROM srvf_shadow_runtime_w98_fixture',
        ),
      );
      await primary.$disconnect();
    }
  }, 120_000);
});
