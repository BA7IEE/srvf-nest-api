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
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const MIGRATION = '20260912090000_activity_os_r4_d3_time_allocation_revision';
const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_D3_W98 === '1';
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
  if (!worker) throw new Error('D3 migration test requires an isolated worker database');
  return { worker, database: deriveTestDbName() };
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
      '-v',
      'VERBOSITY=verbose',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function recreate(): void {
  const { database } = target();
  dropWorkerDatabase(target().worker);
  execFileSync('docker', ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', database], {
    stdio: 'pipe',
  });
}

function deploy(schema: string): void {
  target();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schema], {
    env: process.env,
    stdio: 'pipe',
  });
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rejected(statement: string, code: string, marker: string): void {
  let failure = '';
  try {
    sql(statement);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    failure = String(error.stderr);
  }
  expect(failure).toContain(code);
  expect(failure).toContain(marker);
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

function seedSnapshotWithoutSourceTarget(): string {
  const selection = selectionDocument();
  const snapshotConfig = {
    sessions: [
      {
        sessionId: 'd3-other-session',
        positions: [{ positionId: 'd3-other-position', attendanceRoleCode: 'service' }],
      },
    ],
    timePolicyPointers: {
      selectionRevisionId: 'd3-selection',
      selectionRevision: 1,
      selectionHash: HASH_B,
      selection,
    },
  };
  return `INSERT INTO "ActivityRuleSnapshot" (
    id, "createdAt", "activityId", "workflowRevision", "timePolicySelectionRevisionId", "resolvedConfig", "snapshotHash", "createdByReviewId"
  ) VALUES (
    'd3-snapshot-without-source', ${literal(SELECTION_AT)}::timestamp, 'd3-activity', 1, 'd3-selection',
    ${literal(JSON.stringify(snapshotConfig))}::jsonb, ${literal(HASH_C)}, 'd3-review'
  )`;
}

function seedLegacy(): void {
  sql(`BEGIN;
    INSERT INTO "User" (id, username, "passwordHash", "updatedAt")
      VALUES ('d3-legacy-user', 'd3-legacy-user', 'fixture', CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id, "updatedAt", name, "nodeTypeCode")
      VALUES ('d3-legacy-org', CURRENT_TIMESTAMP, 'D3 历史组织', 'team');
    INSERT INTO "Activity" (
      id, "updatedAt", title, "activityTypeCode", "organizationId", "startAt", "endAt", location, "statusCode"
    ) VALUES (
      'd3-legacy-activity', CURRENT_TIMESTAMP, 'D3 历史活动', 'fixture', 'd3-legacy-org',
      '2099-01-01T00:00:00.000Z'::timestamp, '2099-01-01T02:00:00.000Z'::timestamp, '测试地点', 'draft'
    );
    COMMIT;`);
}

function legacyFacts(): string[] {
  return [
    sql(
      'SELECT id || chr(9) || username || chr(9) || "passwordHash" FROM "User" WHERE id = \'d3-legacy-user\'',
    ),
    sql(
      'SELECT id || chr(9) || name || chr(9) || "nodeTypeCode" FROM "Organization" WHERE id = \'d3-legacy-org\'',
    ),
    sql(
      'SELECT id || chr(9) || title || chr(9) || "organizationId" || chr(9) || "statusCode" FROM "Activity" WHERE id = \'d3-legacy-activity\'',
    ),
  ];
}

describe('D3 immutable time-allocation migration', () => {
  const root = path.resolve('prisma');
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  beforeAll(() => {
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${WORKER}`;
    }
    target();
  });

  afterAll(() => {
    if (USE_DEDICATED_W98) {
      try {
        dropWorkerDatabase(WORKER);
      } finally {
        restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
        restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
        restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
      }
      return;
    }
    recreate();
    deploy(path.join(root, 'schema.prisma'));
  }, 120000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('replays all 120 migrations from empty and exposes only the D3 append-only surface', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(120);
    expect(names.at(-1)).toBe(MIGRATION);
    expect(
      sql(
        'SELECT migration_name || chr(9) || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
      ).split('\n'),
    ).toEqual(
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
      sql(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ParticipantTimeAllocationRevision', 'ParticipantTimeAllocationSlice', 'ParticipantTimeAllocationEvidence', 'ParticipantTimeAllocationCommandReceipt')",
      ),
    ).toBe('4');
    expect(
      sql(
        "SELECT count(*) FROM pg_proc WHERE proname IN ('ptar_parent_anchor_guard', 'ptar_slice_guard', 'ptar_evidence_guard', 'ptar_receipt_guard', 'ptar_parent_complete_guard')",
      ),
    ).toBe('5');
  }, 120000);

  it('preserves pre-120 Activity facts through a non-empty upgrade and then accepts a complete D3 chain', () => {
    recreate();
    const temporary = mkdtempSync(path.join(tmpdir(), 'srvf-d3-pre120-'));
    try {
      mkdirSync(path.join(temporary, 'migrations'));
      copyFileSync(path.join(root, 'schema.prisma'), path.join(temporary, 'schema.prisma'));
      copyFileSync(
        path.join(root, 'migrations/migration_lock.toml'),
        path.join(temporary, 'migrations/migration_lock.toml'),
      );
      const names = readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(names.indexOf(MIGRATION)).toBe(119);
      for (const name of names.slice(0, 119)) {
        cpSync(path.join(root, 'migrations', name), path.join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      const schema = path.join(temporary, 'schema.prisma');
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '119',
      );
      seedLegacy();
      const before = legacyFacts();
      cpSync(
        path.join(root, 'migrations', MIGRATION),
        path.join(temporary, 'migrations', MIGRATION),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
      deploy(schema);
      expect(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).toBe(
        '120',
      );
      expect(legacyFacts()).toEqual(before);

      sql(`BEGIN; ${seedD3Anchors()}; ${completeAllocation('d3-allocation')}; COMMIT;`);
      expect(
        sql(
          'SELECT revision || chr(9) || "sliceCount" || chr(9) || "recognitionModeCode" FROM "ParticipantTimeAllocationRevision" WHERE id = \'d3-allocation\'',
        ),
      ).toBe('1\t1\tautomatic');
      expect(sql('SELECT count(*) FROM "ParticipantTimeAllocationCommandReceipt"')).toBe('1');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120000);

  it('enforces complete immutable chains, source anchors, manifest, evidence and receipt guards', () => {
    recreate();
    deploy(path.join(root, 'schema.prisma'));
    sql(`BEGIN;
      ${seedD3Anchors()};
      ${completeAllocation('d3-allocation')};
      ${completeAllocation('d3-allocation-evidence', {
        revision: 2,
        previousAllocationRevisionId: 'd3-allocation',
        evidenceAttachmentId: 'd3-attachment',
      })};
      COMMIT;`);
    expect(sql('SELECT count(*) FROM "ParticipantTimeAllocationRevision"')).toBe('2');
    expect(sql('SELECT count(*) FROM "ParticipantTimeAllocationEvidence"')).toBe('1');

    rejected(
      `BEGIN; ${allocationParent('d3-bad-source-position', { sourcePositionId: null })}; COMMIT;`,
      '23514',
      'ptar_source_position_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-bad-snapshot', { ruleSnapshotHash: HASH_E })}; COMMIT;`,
      '23514',
      'ptar_snapshot_guard',
    );
    rejected(
      `BEGIN;
        ${seedSnapshotWithoutSourceTarget()};
        ${allocationParent('d3-snapshot-without-source', {
          ruleSnapshotId: 'd3-snapshot-without-source',
          revision: 3,
          previousAllocationRevisionId: 'd3-allocation-evidence',
        })};
      COMMIT;`,
      '23514',
      'ptar_snapshot_target_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-bad-selection', { selectionHash: HASH_E })}; COMMIT;`,
      '23514',
      'ptar_selection_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-bad-policy', { evaluatorVersion: 2 })}; COMMIT;`,
      '23514',
      'ptar_policy_anchor_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-manual-not-enabled', {
        recognitionModeCode: 'manual',
        manualReason: '人工认定',
      })}; COMMIT;`,
      '23514',
      'ptar_manual_policy_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-skipped-revision', { revision: 3 })}; COMMIT;`,
      '23514',
      'ptar_revision_chain_guard',
    );
    rejected(
      `BEGIN; ${allocationParent('d3-incomplete', {
        revision: 3,
        previousAllocationRevisionId: 'd3-allocation-evidence',
      })}; COMMIT;`,
      '23514',
      'ptar_complete_guard',
    );
    rejected(
      `BEGIN;
        ${allocationParent('d3-manifest-mismatch', {
          revision: 3,
          previousAllocationRevisionId: 'd3-allocation-evidence',
        })};
        ${allocationSlice('d3-manifest-mismatch-slice', 'd3-manifest-mismatch', 0, {
          categoryCode: 'training',
          startAt: CHECK_IN_AT,
          endAt: CHECK_OUT_AT,
        })};
      COMMIT;`,
      '23514',
      'ptas_manifest_guard',
    );
    const overlapping = [
      {
        categoryCode: 'volunteer_service' as const,
        startAt: CHECK_IN_AT,
        endAt: '2099-09-01T09:20:00.000Z',
      },
      {
        categoryCode: 'training' as const,
        startAt: '2099-09-01T09:10:00.000Z',
        endAt: CHECK_OUT_AT,
      },
    ];
    rejected(
      `BEGIN;
        ${allocationParent('d3-overlap', {
          revision: 3,
          previousAllocationRevisionId: 'd3-allocation-evidence',
          slices: overlapping,
        })};
        ${allocationSlice('d3-overlap-0', 'd3-overlap', 0, overlapping[0])};
        ${allocationSlice('d3-overlap-1', 'd3-overlap', 1, overlapping[1])};
      COMMIT;`,
      '23514',
      'ptas_overlap_guard',
    );
    rejected(
      `BEGIN;
        ${allocationParent('d3-wrong-evidence', {
          revision: 3,
          previousAllocationRevisionId: 'd3-allocation-evidence',
        })};
        ${allocationEvidence('d3-wrong-evidence-row', 'd3-wrong-evidence', 'd3-foreign-attachment')};
      COMMIT;`,
      '23514',
      'ptae_owner_guard',
    );
    rejected(
      `BEGIN;
        ${allocationParent('d3-partial', {
          revision: 3,
          previousAllocationRevisionId: 'd3-allocation-evidence',
          slices: [
            {
              categoryCode: 'volunteer_service',
              startAt: CHECK_IN_AT,
              endAt: '2099-09-01T09:20:00.000Z',
            },
          ],
        })};
        ${allocationSlice('d3-partial-slice', 'd3-partial', 0, {
          categoryCode: 'volunteer_service',
          startAt: CHECK_IN_AT,
          endAt: '2099-09-01T09:20:00.000Z',
        })};
        ${allocationReceipt('d3-partial-receipt', 'd3-partial', { revision: 3 })};
      COMMIT;`,
      '23514',
      'ptacr_allow_split_guard',
    );
    rejected(
      `INSERT INTO "ParticipantTimeAllocationSlice" (
        id, "allocationRevisionId", "activityId", ordinal, "categoryCode", "intervalKindCode", "startAt", "endAt"
      ) VALUES (
        'd3-late-slice', 'd3-allocation', 'd3-activity', 1, 'volunteer_service', 'service_segment',
        ${literal(CHECK_IN_AT)}::timestamp, ${literal(CHECK_OUT_AT)}::timestamp
      )`,
      '23514',
      'ptas_parent_sealed_guard',
    );
    rejected(
      `UPDATE "ParticipantTimeAllocationRevision" SET "allocationHash" = ${literal(HASH_E)} WHERE id = 'd3-allocation'`,
      '55000',
      'participant time allocation history is immutable',
    );
    rejected(
      `DELETE FROM "ParticipantTimeAllocationCommandReceipt" WHERE id = 'd3-allocation-receipt'`,
      '55000',
      'participant time allocation history is immutable',
    );
    rejected(
      `DELETE FROM "attachments" WHERE id = 'd3-attachment'`,
      '23503',
      'ptae_attachment_fkey',
    );
  }, 120000);
});
