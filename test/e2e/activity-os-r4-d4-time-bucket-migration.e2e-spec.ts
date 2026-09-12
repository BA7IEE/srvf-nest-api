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
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';
import {
  assertTestDatabaseUrl,
  assertDroppableTestDbName,
  dropWorkerDatabase,
} from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260913090000_activity_os_r4_d4_time_bucket_settlement';
const D3_MIGRATION = '20260912090000_activity_os_r4_d3_time_allocation_revision';
const D3_CHECKSUM = 'caee91d1e8f2d1dae5e79d7789cd3473e886f23693ec200fd057f6a23d71ca54';

// These fixed historical SQL fixtures are copied from the approved D3 migration test. They
// deliberately do not use today's Prisma model to query a schema predating its six new columns.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const SELECTION_AT = '2099-08-01T00:00:00.000Z';
const ALLOCATION_AT = '2099-09-02T00:00:00.000Z';
const CHECK_IN_AT = '2099-09-01T08:45:00.000Z';
const CHECK_OUT_AT = '2099-09-01T09:45:00.000Z';

const policyDocument = fingerprintTimePolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  effectiveFrom: '2098-01-01T00:00:00.000Z',
  effectiveUntil: '2101-01-01T00:00:00.000Z',
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

interface AllocationSlice {
  readonly categoryCode: 'volunteer_service' | 'training' | 'organization' | 'non_creditable';
  readonly startAt: string;
  readonly endAt: string;
}

function target() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('D4 migration tests require an isolated worker');
  const database = deriveTestDbName();
  assertDroppableTestDbName(database);
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/' + database)
    throw new Error('D4 migration worker and configured database do not match');
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
function recreate() {
  const { database, worker } = target();
  const engine = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' },
  ).trim();
  if (!engine.startsWith('unix://')) throw new Error('D4 migration requires a local Docker socket');
  const active = execFileSync(
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
      input: 'SELECT count(*) FROM pg_stat_activity WHERE datname = ' + literal(database),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  if (active !== '0') throw new Error('D4 migration worker is in use; refusing reconstruction');
  dropWorkerDatabase(worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
  if (sql('SELECT current_database()') !== database)
    throw new Error('D4 migration connected target mismatch');
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
      'D4 isolated migration deploy failed; inspect the approved worker migration state',
    );
  }
}
function literal(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
function selectionDocument() {
  return {
    schemaVersion: 1,
    items: {
      'activity:-:-': {
        scope: { layerCode: 'activity', sessionId: null, positionId: null },
        selection: {
          mode: 'explicit',
          pointer: {
            policyId: 'd3-policy',
            versionId: 'd3-policy-version',
            definitionHash: policyDocument.definitionHash,
          },
        },
      },
    },
  };
}

function allocationManifest(slices: readonly AllocationSlice[]) {
  return {
    schemaVersion: 1,
    slices: Object.fromEntries(
      slices.map((slice, ordinal) => [
        String(ordinal),
        {
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: 'service_segment',
          startAt: slice.startAt,
          endAt: slice.endAt,
        },
      ]),
    ),
  };
}

function allocationParent(
  id: string,
  input: Partial<{
    revision: number;
    previousAllocationRevisionId: string | null;
    sourceSegmentRevision: number;
    sourcePositionId: string | null;
    ruleSnapshotId: string;
    ruleSnapshotHash: string;
    selectionHash: string;
    evaluatorVersion: number;
    recognitionModeCode: 'automatic' | 'manual';
    manualReason: string | null;
    slices: readonly AllocationSlice[];
  }> = {},
): string {
  const slices = input.slices ?? [
    {
      categoryCode: 'volunteer_service' as const,
      startAt: CHECK_IN_AT,
      endAt: CHECK_OUT_AT,
    },
  ];
  const row = {
    revision: 1,
    previousAllocationRevisionId: null as string | null,
    sourceSegmentRevision: 1,
    sourcePositionId: 'd3-position' as string | null,
    ruleSnapshotId: 'd3-snapshot',
    ruleSnapshotHash: HASH_C,
    selectionHash: HASH_B,
    evaluatorVersion: 1,
    recognitionModeCode: 'automatic' as const,
    manualReason: null as string | null,
    ...input,
  };
  const nullable = (value: string | null) => (value === null ? 'NULL' : literal(value));
  return `INSERT INTO "ParticipantTimeAllocationRevision" (
    id, "createdAt", "activityId", "sessionId", "memberId", "participationIdentityId",
    "segmentKey", revision, "previousAllocationRevisionId", "sourceSegmentId",
    "sourceSegmentRevision", "sourcePositionId", "ruleSnapshotId", "ruleSnapshotHash",
    "timePolicySelectionRevisionId", "selectionHash", "policyId", "policyVersionId",
    "definitionHash", "evaluatorVersion", "recognitionModeCode", "manualReason",
    "allocationJson", "allocationHash", "sliceCount", "createdByUserId"
  ) VALUES (
    ${literal(id)}, ${literal(ALLOCATION_AT)}::timestamp, 'd3-activity', 'd3-session', 'd3-member', 'd3-identity',
    'd3-segment-key', ${row.revision}, ${nullable(row.previousAllocationRevisionId)}, 'd3-segment',
    ${row.sourceSegmentRevision}, ${nullable(row.sourcePositionId)}, ${literal(row.ruleSnapshotId)}, ${literal(row.ruleSnapshotHash)},
    'd3-selection', ${literal(row.selectionHash)}, 'd3-policy', 'd3-policy-version',
    ${literal(policyDocument.definitionHash)}, ${row.evaluatorVersion}, ${literal(row.recognitionModeCode)}, ${nullable(row.manualReason)},
    ${literal(JSON.stringify(allocationManifest(slices)))}::jsonb, ${literal(HASH_D)}, ${slices.length}, 'd3-user'
  )`;
}

function allocationSlice(
  id: string,
  allocationRevisionId: string,
  ordinal: number,
  slice: AllocationSlice,
): string {
  return `INSERT INTO "ParticipantTimeAllocationSlice" (
    id, "allocationRevisionId", "activityId", ordinal, "categoryCode", "intervalKindCode", "startAt", "endAt"
  ) VALUES (
    ${literal(id)}, ${literal(allocationRevisionId)}, 'd3-activity', ${ordinal}, ${literal(slice.categoryCode)},
    'service_segment', ${literal(slice.startAt)}::timestamp, ${literal(slice.endAt)}::timestamp
  )`;
}

function allocationEvidence(
  id: string,
  allocationRevisionId: string,
  attachmentId: string,
  ordinal = 0,
): string {
  return `INSERT INTO "ParticipantTimeAllocationEvidence" (
    id, "allocationRevisionId", "activityId", "attachmentId", ordinal
  ) VALUES (${literal(id)}, ${literal(allocationRevisionId)}, 'd3-activity', ${literal(attachmentId)}, ${ordinal})`;
}

function allocationReceipt(
  id: string,
  allocationRevisionId: string,
  input: Partial<{
    revision: number;
    evidenceCount: number;
    sliceCount: number;
    operationKey: string;
  }> = {},
): string {
  const row = {
    revision: 1,
    evidenceCount: 0,
    sliceCount: 1,
    operationKey: id + '-operation',
    ...input,
  };
  const result = {
    schemaVersion: 1,
    activityId: 'd3-activity',
    allocationRevisionId,
    revision: row.revision,
    sourceSegmentId: 'd3-segment',
    sourceSegmentRevision: 1,
    recognitionModeCode: 'automatic',
    allocationHash: HASH_D,
    sliceCount: row.sliceCount,
    evidenceCount: row.evidenceCount,
    createdAt: ALLOCATION_AT,
  };
  return `INSERT INTO "ParticipantTimeAllocationCommandReceipt" (
    id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
    "allocationRevisionId", "resultJson", "createdAt"
  ) VALUES (
    ${literal(id)}, 'd3-user', 'd3-activity', 'recognize_time_allocation', ${literal(row.operationKey)}, ${literal(HASH_E)},
    ${literal(allocationRevisionId)}, ${literal(JSON.stringify(result))}::jsonb, ${literal(ALLOCATION_AT)}::timestamp
  )`;
}

function completeAllocation(
  id: string,
  input: Partial<{
    revision: number;
    previousAllocationRevisionId: string | null;
    evidenceAttachmentId: string | null;
    slices: readonly AllocationSlice[];
  }> = {},
): string {
  const slices = input.slices ?? [
    {
      categoryCode: 'volunteer_service' as const,
      startAt: CHECK_IN_AT,
      endAt: CHECK_OUT_AT,
    },
  ];
  const evidence = input.evidenceAttachmentId ?? null;
  return [
    allocationParent(id, { ...input, slices }),
    ...slices.map((slice, ordinal) =>
      allocationSlice(`${id}-slice-${ordinal}`, id, ordinal, slice),
    ),
    ...(evidence === null ? [] : [allocationEvidence(`${id}-evidence`, id, evidence)]),
    allocationReceipt(`${id}-receipt`, id, {
      revision: input.revision ?? 1,
      evidenceCount: evidence === null ? 0 : 1,
      sliceCount: slices.length,
    }),
  ].join(';\n');
}

function seedD3Anchors(): string {
  const selection = selectionDocument();
  const selectionReceipt = {
    activityId: 'd3-activity',
    selectionRevisionId: 'd3-selection',
    revision: 1,
    selectionHash: HASH_B,
    createdAt: SELECTION_AT,
  };
  const snapshotConfig = {
    sessions: [
      {
        sessionId: 'd3-session',
        positions: [{ positionId: 'd3-position', attendanceRoleCode: 'service' }],
      },
    ],
    timePolicyPointers: {
      selectionRevisionId: 'd3-selection',
      selectionRevision: 1,
      selectionHash: HASH_B,
      selection,
    },
  };
  const policyReceipt = {
    schemaVersion: 1,
    operationCode: 'create_version',
    policyId: 'd3-policy',
    versionId: 'd3-policy-version',
    definitionHash: policyDocument.definitionHash,
    resultStatusCode: 'draft',
    createdAt: SELECTION_AT,
  };
  return `
    INSERT INTO "User" (id, username, "passwordHash", "updatedAt")
      VALUES ('d3-user', 'd3-user', 'fixture', CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id, "updatedAt", name, "nodeTypeCode")
      VALUES ('d3-org', CURRENT_TIMESTAMP, 'D3 迁移测试组织', 'team');
    INSERT INTO "Member" (
      id, "memberNo", "realName", "memberSinceDate", "memberOriginCode", "updatedAt"
    ) VALUES (
      'd3-member', 'd3-member', 'D3 迁移测试成员', '2099-01-01'::timestamp, 'fixture', CURRENT_TIMESTAMP
    );
    INSERT INTO "Activity" (
      id, "updatedAt", title, "activityTypeCode", "organizationId", "startAt", "endAt", location, "statusCode", "initiatorMemberId"
    ) VALUES (
      'd3-activity', CURRENT_TIMESTAMP, 'D3 迁移测试活动', 'fixture', 'd3-org',
      '2099-09-01T08:00:00.000Z'::timestamp, '2099-09-01T10:00:00.000Z'::timestamp, '测试地点', 'draft', 'd3-member'
    );
    INSERT INTO "ActivitySession" (
      id, "updatedAt", "activityId", code, name, "startAt", "endAt", "locationText",
      "checkInOpenAt", "checkInCloseAt", "checkOutOpenAt", "checkOutCloseAt",
      "locationRequired", "locationPolicySourceCode", "statusCode"
    ) VALUES (
      'd3-session', CURRENT_TIMESTAMP, 'd3-activity', 'd3-session', 'D3 迁移测试场次',
      '2099-09-01T08:00:00.000Z'::timestamp, '2099-09-01T10:00:00.000Z'::timestamp, '测试地点',
      '2099-09-01T08:00:00.000Z'::timestamp, '2099-09-01T09:00:00.000Z'::timestamp,
      '2099-09-01T09:00:00.000Z'::timestamp, '2099-09-01T10:00:00.000Z'::timestamp,
      false, 'session', 'scheduled'
    );
    INSERT INTO "ActivitySessionPosition" (
      id, "updatedAt", "activityId", "sessionId", code, name, "attendanceRoleCode"
    ) VALUES ('d3-position', CURRENT_TIMESTAMP, 'd3-activity', 'd3-session', 'd3-position', 'D3 服务岗位', 'service');
    INSERT INTO "ActivityRegistration" (id, "updatedAt", "activityId", "memberId", "statusCode")
      VALUES ('d3-registration', CURRENT_TIMESTAMP, 'd3-activity', 'd3-member', 'pass');
    INSERT INTO "ActivityParticipationIdentity" (
      id, "updatedAt", "activityId", "sessionId", "registrationId", "memberId", "currentStatusCode", "currentPositionId"
    ) VALUES (
      'd3-identity', CURRENT_TIMESTAMP, 'd3-activity', 'd3-session', 'd3-registration', 'd3-member', 'pass', 'd3-position'
    );
    INSERT INTO "AttendancePunchEvent" (
      id, "activityId", "sessionId", "positionId", "participationIdentityId", "memberId",
      "eventTypeCode", "sourceCode", "occurredAt", "receivedAt", "operatorUserId", "eventKey", "requestHash", "evidenceRevision"
    ) VALUES
      ('d3-check-in', 'd3-activity', 'd3-session', 'd3-position', 'd3-identity', 'd3-member',
       'check_in', 'self_qr', ${literal(CHECK_IN_AT)}::timestamp, ${literal(CHECK_IN_AT)}::timestamp, 'd3-user', 'd3-check-in-key', ${literal(HASH_A)}, 0),
      ('d3-check-out', 'd3-activity', 'd3-session', NULL, 'd3-identity', 'd3-member',
       'check_out', 'self_qr', ${literal(CHECK_OUT_AT)}::timestamp, ${literal(CHECK_OUT_AT)}::timestamp, 'd3-user', 'd3-check-out-key', ${literal(HASH_B)}, 0);
    INSERT INTO "ParticipantServiceSegmentRevision" (
      id, "updatedAt", "participationIdentityId", "segmentKey", revision, "sourceCheckInEventId", "sourceCloseEventId",
      "resultCode", "statusCode", "checkInAt", "checkOutAt", "serviceHours", "lateFlag", "earlyLeaveFlag"
    ) VALUES (
      'd3-segment', CURRENT_TIMESTAMP, 'd3-identity', 'd3-segment-key', 1, 'd3-check-in', 'd3-check-out',
      'valid', 'committed', ${literal(CHECK_IN_AT)}::timestamp, ${literal(CHECK_OUT_AT)}::timestamp, 1.00, false, false
    );
    INSERT INTO "TimePolicy" (id, code, name, "updatedAt")
      VALUES ('d3-policy', 'd3_policy', 'D3 迁移测试政策', CURRENT_TIMESTAMP);
    INSERT INTO "TimePolicyVersion" (
      id, "policyId", version, "schemaVersion", "definitionJson", "definitionHash", "evaluatorVersion",
      "effectiveFrom", "effectiveUntil", "statusCode", "updatedAt"
    ) VALUES (
      'd3-policy-version', 'd3-policy', 1, 1, ${literal(JSON.stringify(policyDocument.definition))}::jsonb,
      ${literal(policyDocument.definitionHash)}, 1, '2098-01-01T00:00:00.000Z'::timestamp,
      '2101-01-01T00:00:00.000Z'::timestamp, 'draft', CURRENT_TIMESTAMP
    );
    INSERT INTO "TimePolicyCommandReceipt" (
      id, "actorUserId", "operationCode", "operationKey", "requestHash", "policyId", "versionId", "definitionHash", "resultJson"
    ) VALUES (
      'd3-policy-receipt', 'd3-user', 'create_version', 'd3-policy-create', ${literal(HASH_C)}, 'd3-policy',
      'd3-policy-version', ${literal(policyDocument.definitionHash)}, ${literal(JSON.stringify(policyReceipt))}::jsonb
    );
    UPDATE "TimePolicyVersion"
      SET "statusCode" = 'active', "activatedAt" = ${literal(SELECTION_AT)}::timestamp
      WHERE id = 'd3-policy-version';
    INSERT INTO "ActivityTimePolicySelectionRevision" (
      id, "activityId", revision, "schemaVersion", "selectionHash", "selectionJson", "itemCount",
      "templateId", "templateDefinitionHash", "originCode", "creationReceiptId", "seriesOccurrenceId",
      "publishReviewId", "proposalSelectionHash", "createdAt", "createdByUserId"
    ) VALUES (
      'd3-selection', 'd3-activity', 1, 1, ${literal(HASH_B)}, ${literal(JSON.stringify(selection))}::jsonb, 1,
      NULL, NULL, 'select', NULL, NULL, NULL, NULL, ${literal(SELECTION_AT)}::timestamp, 'd3-user'
    );
    INSERT INTO "ActivityTimePolicySelectionItem" (
      id, "selectionRevisionId", "activityId", "layerCode", "sessionId", "positionId", mode,
      "policyId", "versionId", "definitionHash"
    ) VALUES (
      'd3-selection-item', 'd3-selection', 'd3-activity', 'activity', NULL, NULL, 'explicit',
      'd3-policy', 'd3-policy-version', ${literal(policyDocument.definitionHash)}
    );
    UPDATE "Activity"
      SET "timePolicySelectionRevision" = 1, "currentTimePolicySelectionRevisionId" = 'd3-selection'
      WHERE id = 'd3-activity';
    INSERT INTO "ActivityTimePolicySelectionCommandReceipt" (
      id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash",
      "selectionRevisionId", "resultJson", "createdAt"
    ) VALUES (
      'd3-selection-receipt', 'd3-user', 'd3-activity', 'patch_time_policy_selection', 'd3-selection-write',
      ${literal(HASH_D)}, 'd3-selection', ${literal(JSON.stringify(selectionReceipt))}::jsonb, ${literal(SELECTION_AT)}::timestamp
    );
    INSERT INTO "activity_publish_reviews" (
      id, "activityId", "requestType", "requestVersion", "baseRevision", status, snapshot, "directPublish",
      "submittedByUserId", "submittedAt", "reviewedByUserId", "reviewedAt", "updatedAt"
    ) VALUES (
      'd3-review', 'd3-activity', 'initial', 1, 0, 'approved', '{}'::jsonb, true,
      'd3-user', ${literal(SELECTION_AT)}::timestamp, 'd3-user', ${literal(SELECTION_AT)}::timestamp, CURRENT_TIMESTAMP
    );
    INSERT INTO "ActivityRuleSnapshot" (
      id, "createdAt", "activityId", "workflowRevision", "timePolicySelectionRevisionId", "resolvedConfig", "snapshotHash", "createdByReviewId"
    ) VALUES (
      'd3-snapshot', ${literal(SELECTION_AT)}::timestamp, 'd3-activity', 0, 'd3-selection',
      ${literal(JSON.stringify(snapshotConfig))}::jsonb, ${literal(HASH_C)}, 'd3-review'
    );
    INSERT INTO "attachments" (
      id, "updatedAt", key, "originalName", mime, size, "uploadedBy", "ownerType", "ownerId", tags
    ) VALUES
      ('d3-attachment', CURRENT_TIMESTAMP, 'd3/attachment', 'd3.txt', 'text/plain', 1, 'd3-user', 'activity', 'd3-activity', ARRAY[]::text[]),
      ('d3-foreign-attachment', CURRENT_TIMESTAMP, 'd3/foreign-attachment', 'foreign.txt', 'text/plain', 1, 'd3-user', 'activity', 'foreign-activity', ARRAY[]::text[])
  `;
}

describe('D4 time-bucket migration replay and nonempty upgrade', () => {
  const root = path.resolve('prisma');
  const schema = path.join(root, 'schema.prisma');
  const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  beforeAll(() => {
    target();
  });
  afterAll(() => {
    // Leave a complete current schema for the next suite on this worker, even after a failed
    // historical-upgrade assertion. No fixed shared database name and no migrate reset/db push.
    recreate();
    deploy(schema);
  }, 120000);

  function checksums(): string[] {
    return sql(
      'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    ).split('\n');
  }

  it('replays all 121 migrations with exact checksums and four immutable tables', () => {
    recreate();
    deploy(schema);
    expect(names).toHaveLength(121);
    expect(names.at(-1)).toBe(MIGRATION);
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
    expect(
      createHash('sha256')
        .update(readFileSync(path.join(root, 'migrations', D3_MIGRATION, 'migration.sql')))
        .digest('hex'),
    ).toBe(D3_CHECKSUM);
    expect(
      sql(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ActivitySettlementTimeRevision','ParticipantSettlementTimeBucket','ParticipantSettlementTimeBucketSource','ActivitySettlementTimeCommandReceipt')",
      ),
    ).toBe('4');
    expect(
      sql(
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('astr_immutable','pstb_immutable','pstbs_immutable','astcr_immutable') AND NOT tgisinternal",
      ),
    ).toBe('4');
    expect(
      sql(
        "SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('\"ActivitySettlementTimeRevision\"'::regclass,'\"ParticipantSettlementTimeBucket\"'::regclass,'\"ParticipantSettlementTimeBucketSource\"'::regclass,'\"ActivitySettlementTimeCommandReceipt\"'::regclass) AND (confdeltype<>'r' OR confupdtype<>'r')",
      ),
    ).toBe('0');
    expect(
      sql(
        "SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('\"ActivitySettlementTimeRevision\"'::regclass,'\"ParticipantSettlementTimeBucket\"'::regclass,'\"ParticipantSettlementTimeBucketSource\"'::regclass,'\"ActivitySettlementTimeCommandReceipt\"'::regclass)",
      ),
    ).toBe('15');
  }, 120000);

  it('preserves a complete committed D3 chain byte-for-byte through 120→121 and still accepts V1 commands', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d4-pre121-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(schema, path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      expect(names.indexOf(MIGRATION)).toBe(120);
      expect(names[119]).toBe(D3_MIGRATION);
      for (const name of names.slice(0, 120))
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(120);
      sql(
        'BEGIN; ' +
          seedD3Anchors() +
          '; ' +
          completeAllocation('d4-legacy-allocation') +
          '; COMMIT;',
      );
      const previousChecksums = checksums();
      const allocationBefore = sql(
        'SELECT to_jsonb(a)::text FROM "ParticipantTimeAllocationRevision" a WHERE id=\'d4-legacy-allocation\'',
      );
      const slicesBefore = sql(
        'SELECT jsonb_agg(to_jsonb(s) ORDER BY ordinal)::text FROM "ParticipantTimeAllocationSlice" s',
      );
      const receiptBefore = sql(
        'SELECT to_jsonb(r)::text FROM "ParticipantTimeAllocationCommandReceipt" r WHERE "allocationRevisionId"=\'d4-legacy-allocation\'',
      );
      const segmentBefore = sql(
        'SELECT to_jsonb(s)::text FROM "ParticipantServiceSegmentRevision" s WHERE id=\'d3-segment\'',
      );
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        { recursive: true, force: false, errorOnExist: true },
      );
      deploy(path.join(temporary, 'schema.prisma'));
      expect(checksums()).toHaveLength(121);
      expect(checksums().slice(0, 120)).toEqual(previousChecksums);
      expect(
        sql(
          "SELECT (to_jsonb(a) - ARRAY['settlementDraftVersionId','settlementEvidenceSealId','settlementEvidenceRevision','settlementPopulationRevision','settlementWorkflowRevision','settlementDraftContentHash'])::text FROM \"ParticipantTimeAllocationRevision\" a WHERE id='d4-legacy-allocation'",
        ),
      ).toBe(allocationBefore);
      expect(
        sql(
          'SELECT num_nonnulls("settlementDraftVersionId","settlementEvidenceSealId","settlementEvidenceRevision","settlementPopulationRevision","settlementWorkflowRevision","settlementDraftContentHash") FROM "ParticipantTimeAllocationRevision" WHERE id=\'d4-legacy-allocation\'',
        ),
      ).toBe('0');
      expect(
        sql(
          'SELECT jsonb_agg(to_jsonb(s) ORDER BY ordinal)::text FROM "ParticipantTimeAllocationSlice" s',
        ),
      ).toBe(slicesBefore);
      expect(
        sql(
          'SELECT to_jsonb(r)::text FROM "ParticipantTimeAllocationCommandReceipt" r WHERE "allocationRevisionId"=\'d4-legacy-allocation\'',
        ),
      ).toBe(receiptBefore);
      expect(
        sql(
          'SELECT to_jsonb(s)::text FROM "ParticipantServiceSegmentRevision" s WHERE id=\'d3-segment\'',
        ),
      ).toBe(segmentBefore);
      sql(
        'BEGIN; ' +
          completeAllocation('d4-legacy-v1-after', {
            revision: 2,
            previousAllocationRevisionId: 'd4-legacy-allocation',
          }) +
          '; COMMIT;',
      );
      expect(
        sql(
          'SELECT count(*) FROM "ParticipantTimeAllocationRevision" WHERE "settlementDraftVersionId" IS NULL',
        ),
      ).toBe('2');
      expect(
        sql(
          'SELECT count(*) FROM "ParticipantTimeAllocationCommandReceipt" WHERE "operationCode"=\'recognize_time_allocation\'',
        ),
      ).toBe('2');
      for (const table of [
        'ActivitySettlementTimeRevision',
        'ParticipantSettlementTimeBucket',
        'ParticipantSettlementTimeBucketSource',
        'ActivitySettlementTimeCommandReceipt',
      ]) {
        expect(sql('SELECT count(*) FROM "' + table + '"')).toBe('0');
      }
    } finally {
      // Only this mkdtemp fixture copy is removed, never business data or a repository root.
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);
});
