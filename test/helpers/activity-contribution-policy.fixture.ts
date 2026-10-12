import {
  e4HistoricalMigrationPrefix,
  E4_MIGRATION_137,
  E4_MIGRATION_138,
  E4_MIGRATION_139,
  E4_MIGRATION_140,
} from './e4-migration-prefix';
import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role, UserStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  fingerprintContributionPolicyVersion,
  type ContributionPolicyDefinition,
} from '../../src/modules/activities/activity-contribution-policy-definition';
import type { ActivityContributionPolicyPointer } from '../../src/modules/activities/activity-contribution-policy-selection';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from './member-identity.fixture';
import { httpServer } from './http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { installScratchDatabaseLease } from './scratch-database-lease';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { resolveE4ValidationScope } from './e4-d1-result-capture';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import { createD13ActivePolicy, explicitTimePolicyChange } from './activity-time-policy.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';
import {
  activityContributionPolicySelectionScopeKey,
  parseActivityContributionPolicySelectionDocument,
} from '../../src/modules/activities/activity-contribution-policy-selection';

export const E13_APP = '/api/app/v1/my/managed-activities';
export const E13_ADMIN = '/api/admin/v1';

export type E4ValidationLifecycleMode = 'NORMAL' | 'INSTALL_RETAIN';

/**
 * The retained-install path is intentionally opt-in and available only to the
 * explicitly scoped w98 lifecycle, including the isolated GitHub opt-in.
 * It is not a new default cleanup policy or another worker's lifecycle.
 */
export function resolveE4ValidationLifecycleMode(
  requested = process.env.SRVF_E4_N1_LIFECYCLE,
  dedicated = process.env.SRVF_E4_W98 === '1',
): E4ValidationLifecycleMode {
  if (requested === undefined || requested === '') return 'NORMAL';
  if (requested !== 'install-retain' || !dedicated)
    throw new Error('E4 retained install lifecycle requires the dedicated local w98 scope');
  return 'INSTALL_RETAIN';
}

/** Other E4 suites keep their established normal lifecycle even when a
 * retained-install selector is present for the one exact staging suite. */
export function e4ValidationLifecycleModeForInstall(
  allowInstallRetain: boolean,
  requested = process.env.SRVF_E4_N1_LIFECYCLE,
  dedicated = process.env.SRVF_E4_W98 === '1',
): E4ValidationLifecycleMode {
  return allowInstallRetain ? resolveE4ValidationLifecycleMode(requested, dedicated) : 'NORMAL';
}

/** Pure policy seam for offline tests; the lease finalizer remains registered
 * after this database finalizer in installE4ValidationDatabase(). */
export function e4ValidationLifecyclePlan(mode: E4ValidationLifecycleMode) {
  return {
    initialize: 'RECREATE' as const,
    databaseFinalizer: mode === 'INSTALL_RETAIN' ? ('RETAIN' as const) : ('DROP' as const),
    leaseFinalizer: 'RELEASE' as const,
  };
}

export type E4N1InstallRetainStage =
  | 'INSTALLED_CATALOG'
  | 'FIXTURE'
  | 'MAXIMUM_SOURCE'
  | 'PREPARE'
  | 'SUBMIT'
  | 'RETAINED_ROOT'
  | 'FINAL_CATALOG'
  | 'FIXTURE_CLOSE';

export type E4N1InstallRetainFailureReason =
  | 'V11_DISABLED'
  | 'READONLY_MAINTENANCE'
  | 'TIMEOUT'
  | 'UNKNOWN';

/**
 * The retained-install stage creates an in-process Nest application after the
 * install lifecycle has loaded `.env.test`, where the v1.1 gate is correctly
 * off by default.  This temporary test-process-only override mirrors the
 * established S13 fixture initialization.  It never changes production
 * configuration, does not clear read-only maintenance, and restores the
 * caller's exact value before the stage returns.
 */
export async function withE4N1InstallRetainFixtureGate<T>(
  work: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (env.SRVF_E4_W98 !== '1' || env.SRVF_E4_N1_LIFECYCLE !== 'install-retain')
    throw new Error('E4 N1 fixture gate requires the dedicated local w98 retained lifecycle');
  const previous = env.ACTIVITY_V11_WORKFLOW_ENABLED;
  env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
  try {
    return await work();
  } finally {
    if (previous === undefined) delete env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else env.ACTIVITY_V11_WORKFLOW_ENABLED = previous;
  }
}

function e4N1InstallRetainFailureReason(error: unknown): E4N1InstallRetainFailureReason {
  const bizCode =
    error !== null &&
    typeof error === 'object' &&
    'biz' in error &&
    typeof error.biz === 'object' &&
    error.biz !== null &&
    'code' in error.biz
      ? error.biz.code
      : undefined;
  if (bizCode === BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.code) return 'V11_DISABLED';
  if (bizCode === BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.code)
    return 'READONLY_MAINTENANCE';
  if (error instanceof Error && /(?:deadline|timeout)/iu.test(error.message)) return 'TIMEOUT';
  return 'UNKNOWN';
}

/** Converts a stage exception to a fixed diagnostic without echoing SQL,
 * fixture identifiers, request data, or an arbitrary exception message. */
export function e4N1InstallRetainFailure(
  stage: E4N1InstallRetainStage,
  error: unknown,
): {
  phase: E4N1InstallRetainStage;
  reason: E4N1InstallRetainFailureReason;
  message: string;
} {
  const reason = e4N1InstallRetainFailureReason(error);
  return {
    phase: stage,
    reason,
    message: `E4_N1_INSTALL_STAGE_FAILURE phase=${stage} reason=${reason}`,
  };
}

/** E4 local validation touches only this checkout's explicitly approved w98.
 * CI uses its existing assigned worker/global setup; no template or other-worker mutation here. */
export function installE4ValidationDatabase(options?: {
  baselineMigrationCount?: 136;
  historicalMigration137?: true;
  allowInstallRetain?: boolean;
}) {
  const dedicated = process.env.SRVF_E4_W98 === '1';
  if (process.env.SRVF_E4_GITHUB_ISOLATED !== undefined) resolveE4ValidationScope();
  const lifecycleMode = e4ValidationLifecycleModeForInstall(options?.allowInstallRetain === true);
  const lifecyclePlan = e4ValidationLifecyclePlan(lifecycleMode);
  const baseline = options?.baselineMigrationCount === 136;
  const historical137 = options?.historicalMigration137 === true;
  if (options?.baselineMigrationCount !== undefined && !baseline)
    throw new Error('E4 fixed baseline option differs');
  if (lifecycleMode === 'INSTALL_RETAIN' && (!dedicated || options?.allowInstallRetain !== true))
    throw new Error('E4 retained install lifecycle is not enabled by this exact validation suite');
  if (lifecycleMode === 'INSTALL_RETAIN' && baseline)
    throw new Error('E4 retained install lifecycle cannot use the 136 baseline owner');
  const lifecycle = installScratchDatabaseLease(dedicated);
  let temporary: string | undefined;
  let worker: number | undefined;
  let initialized = false;
  let historicalSchema: string | undefined;
  const deploy = (schema?: string) => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    try {
      execFileSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', ...(schema ? ['--schema', schema] : [])],
        {
          env: process.env,
          stdio: 'pipe',
        },
      );
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      const safe = stderr
        .split('\n')
        .filter((line) =>
          /^(?:Error: P[0-9]+|Database error code:|ERROR: |LINE [0-9]+:|CONTEXT: )/u.test(line),
        )
        .join('\n');
      throw new Error(
        'E4 isolated migration deploy failed' + (safe ? '\n' + safe : ' (details not echoed)'),
      );
    }
  };
  const deployHistoricalMigrations = (count: 137 | 138 | 139 | 140) => {
    if (!baseline || !initialized) throw new Error('E4 baseline owner is not initialized');
    if (!temporary || !historicalSchema) throw new Error('E4 historical schema missing');
    const successors = [
      E4_MIGRATION_137,
      E4_MIGRATION_138,
      E4_MIGRATION_139,
      E4_MIGRATION_140,
    ].slice(0, count - 136);
    for (const name of successors) {
      const directory = join(temporary, 'migrations', name);
      mkdirSync(directory, { recursive: true });
      copyFileSync(
        resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'),
        join(directory, 'migration.sql'),
      );
    }
    deploy(historicalSchema);
  };
  const previous = {
    worker: process.env.JEST_WORKER_ID,
    url: process.env.DATABASE_URL,
    storage: process.env.STORAGE_LOCAL_ROOT,
    mode: process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE,
  };
  beforeAll(async () => {
    if (dedicated) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = './tmp/storage-w98';
      assertTestDatabaseUrl(process.env.DATABASE_URL);
    }
    if (dedicated || baseline || historical137) {
      worker = Number(process.env.JEST_WORKER_ID);
      if (!Number.isInteger(worker) || worker < 1) throw new Error('E4 isolated worker required');
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      if (new URL(process.env.DATABASE_URL!).pathname !== '/' + deriveTestDbName())
        throw new Error('E4 worker and configured database mismatch');
      if (
        process.env.SRVF_E4_GITHUB_ISOLATED === '1' &&
        deriveTestDbName() !== resolveE4ValidationScope()
      )
        throw new Error('E4 isolated GitHub derived scope differs');
      let baselineSchema: string | undefined;
      if (baseline || historical137) {
        const root = resolve(__dirname, '../../prisma');
        const names = readdirSync(join(root, 'migrations'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        const prefix = e4HistoricalMigrationPrefix(names);
        temporary = mkdtempSync(join(tmpdir(), 'srvf-e4-pre137-'));
        mkdirSync(join(temporary, 'migrations'));
        baselineSchema = join(temporary, 'schema.prisma');
        historicalSchema = baselineSchema;
        copyFileSync(join(root, 'schema.prisma'), baselineSchema);
        copyFileSync(
          join(root, 'migrations/migration_lock.toml'),
          join(temporary, 'migrations/migration_lock.toml'),
        );
        for (const name of prefix.slice(0, baseline ? 136 : 137)) {
          const relative = 'prisma/migrations/' + name + '/migration.sql';
          if (name !== E4_MIGRATION_137) {
            const historical = execFileSync(
              'git',
              ['show', '5c296d62c8dbdd1800b47d679c7681c6ad99ef09:' + relative],
              { cwd: resolve(root, '..') },
            );
            const current = readFileSync(join(root, 'migrations', name, 'migration.sql'));
            if (
              createHash('sha256').update(current).digest('hex') !==
              createHash('sha256').update(historical).digest('hex')
            )
              throw new Error('E4 historical migration bytes changed: ' + name);
          }
          mkdirSync(join(temporary, 'migrations', name));
          copyFileSync(
            join(root, 'migrations', name, 'migration.sql'),
            join(temporary, 'migrations', name, 'migration.sql'),
          );
        }
      }
      await lifecycle.drop(worker);
      await lifecycle.create(deriveTestDbName());
      initialized = true;
      deploy(baselineSchema);
    }
    process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE = 'fixture';
  }, 120_000);
  afterAll(async () => {
    try {
      if (dedicated && worker !== undefined && lifecyclePlan.databaseFinalizer === 'DROP')
        await lifecycle.drop(worker);
      // CI retains its assigned worker, restored to the current schema even after a failed fixture.
      else if ((baseline || historical137) && initialized) deploy();
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: false });
      for (const [name, value] of [
        ['JEST_WORKER_ID', previous.worker],
        ['DATABASE_URL', previous.url],
        ['STORAGE_LOCAL_ROOT', previous.storage],
        ['ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE', previous.mode],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 120_000);
  // This hook is registered after the database finalizer above, so both normal
  // DROP and explicit retain paths release the same original lease afterward.
  lifecycle.finish();
  return {
    deployCurrentMigrations() {
      deployHistoricalMigrations(137);
    },
    deployScalarMigrations() {
      deployHistoricalMigrations(138);
    },
    deployReferenceMigrations() {
      deployHistoricalMigrations(139);
    },
    deployEvaluationMigrations() {
      deployHistoricalMigrations(140);
    },
    deployLatestMigrations() {
      if (!baseline || !initialized) throw new Error('E4 baseline owner is not initialized');
      deploy();
    },
    async recreateCurrentMigrations() {
      if (!baseline || !initialized || worker === undefined)
        throw new Error('E4 baseline owner is not initialized');
      // Only after the nonempty snapshot/no-op proof; the same owner keeps the same lease.
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      if (new URL(process.env.DATABASE_URL!).pathname !== '/' + deriveTestDbName())
        throw new Error('E4 worker and configured database mismatch');
      await lifecycle.drop(worker);
      await lifecycle.create(deriveTestDbName());
      if (!historicalSchema) throw new Error('E4 historical schema missing');
      deploy(historicalSchema);
    },
  };
}

export interface E13Fixture {
  readonly app: INestApplication;
  readonly db: PrismaService;
  readonly creator: { readonly id: string; readonly memberId: string; readonly auth: string };
  readonly reviewer: { readonly id: string; readonly memberId: string; readonly auth: string };
  readonly organizationId: string;
  readonly key: (label: string) => string;
}

export interface E13Draft {
  readonly activityId: string;
  readonly sessionId: string;
  readonly positionId: string | null;
}

export interface E13PolicyEffectiveWindow {
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

const CONTRIBUTION_POLICY_SELECTION_PERMISSIONS = [
  'activity.contribution-policy.read',
  'activity.contribution-policy.select',
] as const;

const REVIEWER_PERMISSIONS = [
  'activity-review.read.request',
  'activity-review.return.request',
  'activity.publish.record',
] as const;

const DEFAULT_POLICY_DEFINITION: ContributionPolicyDefinition = {
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
};

async function grantOrganizationPermissions(
  fixture: Pick<E13Fixture, 'db' | 'organizationId' | 'key'>,
  userId: string,
  codes: readonly string[],
): Promise<void> {
  for (const code of codes) {
    await fixture.db.permission.upsert({
      where: { code },
      create: {
        code,
        module: code.startsWith('activity-review') ? 'activity-review' : 'activity',
        action: code.startsWith('activity-review')
          ? (code.split('.').at(-1) ?? 'read')
          : 'contribution-policy',
        resourceType: code.startsWith('activity-review')
          ? 'request'
          : code.endsWith('.read')
            ? 'read'
            : 'select',
      },
      update: {},
    });
  }
  const role = await fixture.db.rbacRole.create({
    data: { code: fixture.key('role'), displayName: 'E1-3 精确授权测试角色' },
  });
  const permissions = await fixture.db.permission.findMany({
    where: { code: { in: [...codes] } },
    select: { id: true },
  });
  if (permissions.length !== codes.length) throw new Error('E1-3 permission fixture is incomplete');
  await fixture.db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  await fixture.db.roleBinding.create({
    data: {
      principalType: PrincipalType.USER,
      principalId: userId,
      roleId: role.id,
      scopeType: BindingScopeType.ORGANIZATION,
      scopeOrgId: fixture.organizationId,
    },
  });
}

export async function createE13Fixture(): Promise<E13Fixture> {
  const app = await createTestApp();
  try {
    await resetDb(app);
    const db = app.get(PrismaService);
    const prefix = `e13_${randomBytes(5).toString('hex')}`;
    let sequence = 0;
    const key = (label: string): string => `${prefix}_${label}_${++sequence}`;

    const creatorUser = await createTestUser(app, {
      username: key('creator'),
      role: Role.SUPER_ADMIN,
    });
    const reviewerUser = await createTestUser(app, { username: key('reviewer'), role: Role.USER });
    const creatorMember = await db.member.create({
      data: {
        memberNo: key('creator_member'),
        ...memberIdentityData('E1-3 发起人'),
        gradeCode: 'level-3',
      },
    });
    const reviewerMember = await db.member.create({
      data: {
        memberNo: key('reviewer_member'),
        ...memberIdentityData('E1-3 审核人'),
        gradeCode: 'level-3',
      },
    });
    await db.user.update({ where: { id: creatorUser.id }, data: { memberId: creatorMember.id } });
    await db.user.update({ where: { id: reviewerUser.id }, data: { memberId: reviewerMember.id } });

    const root = await db.organization.create({
      data: { name: key('root'), nodeTypeCode: key('root_type') },
    });
    const organization = await db.organization.create({
      data: { name: key('organization'), nodeTypeCode: key('team_type'), parentId: root.id },
    });
    await db.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    await db.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId: organization.id },
    });
    await db.memberOrganizationMembership.create({
      data: { memberId: reviewerMember.id, organizationId: organization.id },
    });

    const type = await db.dictType.create({
      data: { code: 'activity_type', label: 'E1-3 活动类型' },
    });
    await db.dictItem.create({
      data: { typeId: type.id, code: 'event_support', label: '活动保障' },
    });
    const attendanceRole = await db.dictType.create({
      data: { code: 'attendance_role', label: 'E1-3 考勤角色' },
    });
    await db.dictItem.create({
      data: { typeId: attendanceRole.id, code: 'service', label: 'E1-3 服务岗位' },
    });

    const fixture = {
      app,
      db,
      organizationId: organization.id,
      key,
    } satisfies Pick<E13Fixture, 'app' | 'db' | 'organizationId' | 'key'>;
    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creatorUser.id, bizAdmin.bizAdminRoleId);
    await grantOrganizationPermissions(
      fixture,
      creatorUser.id,
      CONTRIBUTION_POLICY_SELECTION_PERMISSIONS,
    );
    await grantOrganizationPermissions(fixture, reviewerUser.id, REVIEWER_PERMISSIONS);

    return {
      ...fixture,
      creator: {
        id: creatorUser.id,
        memberId: creatorMember.id,
        auth: (await loginAs(app, creatorUser.username)).authHeader,
      },
      reviewer: {
        id: reviewerUser.id,
        memberId: reviewerMember.id,
        auth: (await loginAs(app, reviewerUser.username)).authHeader,
      },
    };
  } catch (error) {
    try {
      await app.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Fixture initialization and cleanup failed');
    }
    throw error;
  }
}

export async function closeE13Fixture(fixture: E13Fixture | undefined): Promise<void> {
  await fixture?.app.close();
}

export async function createE13ActivePolicy(
  fixture: E13Fixture,
  definition: ContributionPolicyDefinition = DEFAULT_POLICY_DEFINITION,
  window: E13PolicyEffectiveWindow = {
    effectiveFrom: '2098-01-01T00:00:00.000Z',
    effectiveUntil: '2101-01-01T00:00:00.000Z',
  },
): Promise<ActivityContributionPolicyPointer> {
  const document = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    definition,
    evaluatorVersion: 1,
    effectiveFrom: window.effectiveFrom,
    effectiveUntil: window.effectiveUntil,
  });
  const policy = await fixture.db.contributionPolicy.create({
    data: { code: fixture.key('policy'), name: 'E1-3 贡献政策' },
  });
  const draftVersion = await fixture.db.contributionPolicyVersion.create({
    data: {
      policyId: policy.id,
      version: 1,
      schemaVersion: document.schemaVersion,
      definitionJson: document.definition as unknown as Prisma.InputJsonValue,
      definitionHash: document.definitionHash,
      evaluatorVersion: document.evaluatorVersion,
      effectiveFrom: new Date(document.effectiveFrom),
      effectiveUntil: document.effectiveUntil === null ? null : new Date(document.effectiveUntil),
      statusCode: 'draft',
      createdByUserId: fixture.creator.id,
      activatedAt: null,
    },
  });
  const version = await fixture.db.contributionPolicyVersion.update({
    where: { id: draftVersion.id },
    data: {
      statusCode: 'active',
      activatedAt: new Date(),
      activatedByUserId: fixture.creator.id,
    },
  });
  return {
    policyId: policy.id,
    versionId: version.id,
    definitionHash: version.definitionHash,
    evaluatorVersion: version.evaluatorVersion,
  };
}

export async function createE13Draft(
  fixture: E13Fixture,
  options: { withPosition?: boolean } = {},
): Promise<E13Draft> {
  const activity = await request(httpServer(fixture.app))
    .post(`${E13_ADMIN}/activities`)
    .set('Authorization', fixture.creator.auth)
    .send({
      title: fixture.key('activity'),
      activityTypeCode: 'event_support',
      allocationModeCode: 'first_come',
      organizationId: fixture.organizationId,
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T10:00:00.000Z',
      registrationDeadline: '2099-08-31T12:00:00.000Z',
      location: 'E1-3 集合点',
      visibilityCode: 'internal',
      isPublicRegistration: true,
    })
    .expect(201);
  const activityId = activity.body.data.id as string;
  // The legacy Admin creator intentionally has no App initiator identity.  E1-3's managed surface
  // is explicitly limited to the active initiating member, so this fixture models that persisted
  // ownership fact before exercising its standalone selection command.
  await fixture.db.activity.update({
    where: { id: activityId },
    data: { initiatorMemberId: fixture.creator.memberId },
  });
  const session = await request(httpServer(fixture.app))
    .post(`${E13_APP}/${activityId}/sessions`)
    .set('Authorization', fixture.creator.auth)
    .send({
      code: fixture.key('session'),
      name: 'E1-3 场次',
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T10:00:00.000Z',
      locationText: 'E1-3 集合点',
      checkInOpenAt: '2099-09-01T07:30:00.000Z',
      checkInCloseAt: '2099-09-01T08:30:00.000Z',
      checkOutOpenAt: '2099-09-01T09:00:00.000Z',
      checkOutCloseAt: '2099-09-01T10:00:00.000Z',
      locationRequired: false,
    })
    .expect(201);
  const sessionId = session.body.data.sessionId as string;
  if (!options.withPosition) return { activityId, sessionId, positionId: null };
  const position = await request(httpServer(fixture.app))
    .post(`${E13_APP}/${activityId}/sessions/${sessionId}/positions`)
    .set('Authorization', fixture.creator.auth)
    .send({
      code: fixture.key('position'),
      name: 'E1-3 岗位',
      attendanceRoleCode: 'service',
      capacity: 10,
      startAt: '2099-09-01T08:30:00.000Z',
      endAt: '2099-09-01T09:30:00.000Z',
    })
    .expect(201);
  return { activityId, sessionId, positionId: position.body.data.positionId as string };
}

/** V9 keeps the existing V7 metric contract. This helper uses the real App command rather than
 * mutating Activity fields, so a contribution-policy proposal is exercised with a publishable metric
 * selection exactly as a client would prepare it. */
export async function selectE13MetricNotRequired(
  fixture: E13Fixture,
  activityId: string,
): Promise<void> {
  await request(httpServer(fixture.app))
    .put(`${E13_APP}/${activityId}/metric-selection`)
    .set('Authorization', fixture.creator.auth)
    .send({
      operationKey: fixture.key('metric_not_required'),
      expectedRevision: 0,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
    })
    .expect(200);
}

export function explicitContributionPolicyChange(
  pointer: ActivityContributionPolicyPointer,
  scope: {
    layerCode: 'activity' | 'position';
    sessionId: string | null;
    positionId: string | null;
  },
) {
  return { scope, selection: { mode: 'explicit' as const, pointer } };
}

export function inheritContributionPolicyChange(scope: {
  layerCode: 'activity' | 'position';
  sessionId: string | null;
  positionId: string | null;
}) {
  return { scope, selection: { mode: 'inherit' as const, pointer: null } };
}

// Native E4 fixtures append to, and never rewrite, the established E1-3 fixtures above.
export interface E4Fixture extends E13Fixture {
  readonly finalReviewer: E13Fixture['reviewer'];
}
export const E4_META = { requestId: 'e4-isolated-validation', ip: null, ua: null };
export function e4Actor(identity: E13Fixture['creator'], creator = false): CurrentUserPayload {
  return {
    id: identity.id,
    memberId: identity.memberId,
    role: creator ? Role.SUPER_ADMIN : Role.USER,
    status: UserStatus.ACTIVE,
    username: 'e4-validation',
  };
}
export async function createE4Fixture(): Promise<E4Fixture> {
  const fixture = await createE13Fixture();
  try {
    await grantOrganizationPermissions(fixture, fixture.creator.id, [
      'activity.time-policy.read',
      'activity.time-policy.select',
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.time-allocation.recognize',
      'activity.settlement-submit.record',
    ]);
    await grantOrganizationPermissions(fixture, fixture.reviewer.id, [
      'activity.settlement-first-review.record',
    ]);
    const user = await createTestUser(fixture.app, { username: fixture.key('final') });
    const member = await fixture.db.member.create({
      data: {
        memberNo: fixture.key('final_member'),
        ...memberIdentityData('E4 终审人'),
        gradeCode: 'level-3',
      },
    });
    await fixture.db.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await fixture.db.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId: fixture.organizationId },
    });
    const permission = await fixture.db.permission.upsert({
      where: { code: 'activity.settlement-final-review.record' },
      create: {
        code: 'activity.settlement-final-review.record',
        module: 'activity',
        action: 'record',
        resourceType: 'settlement-final-review',
      },
      update: {},
    });
    const role = await fixture.db.rbacRole.create({
      data: { code: fixture.key('final_role'), displayName: 'E4 explicit GLOBAL fixture' },
    });
    await fixture.db.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: user.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
    return {
      ...fixture,
      finalReviewer: {
        id: user.id,
        memberId: member.id,
        auth: (await loginAs(fixture.app, user.username)).authHeader,
      },
    };
  } catch (error) {
    await closeE13Fixture(fixture);
    throw error;
  }
}

const E4_TIME_DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: true,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 60 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
};

/** Real E1 and D1 selection commands, a fixed historical publish fixture, then real D4 writes.
 * Fixture construction is outside timed business operations and does not replace any DB guard. */
export async function createE4Source(
  fixture: E4Fixture,
  options: {
    definition?: ContributionPolicyDefinition;
    timeDefinition?: TimePolicyDefinition;
    startsAt?: Date;
    endsAt?: Date;
    recognizedServiceHours?: number;
    withoutFrozenContribution?: boolean;
    batch?: boolean;
    beforeSeal?: (draft: E13Draft & { positionId: string }) => Promise<void>;
    manualSlices?: readonly ActivityTimeAllocationSliceInput[];
  } = {},
) {
  const draft = await createE13Draft(fixture, { withPosition: true });
  if (!draft.positionId) throw new Error('E4 source position required');
  const startsAt = options.startsAt ?? new Date('2020-03-01T08:00:00.000Z');
  const endsAt = options.endsAt ?? new Date('2020-03-01T09:00:00.000Z');
  const window = {
    effectiveFrom: '1900-01-01T00:00:00.000Z',
    effectiveUntil: '2101-01-01T00:00:00.000Z',
  };
  const contributionPointer = await createE13ActivePolicy(fixture, options.definition, window);
  const selectionResponse = await request(httpServer(fixture.app))
    .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
    .set('Authorization', fixture.creator.auth)
    .send({
      operationKey: fixture.key('contribution_selection'),
      expectedRevision: 0,
      changes: [
        explicitContributionPolicyChange(contributionPointer, {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
        }),
      ],
    })
    .expect(200);
  const contributionSelection =
    await fixture.db.activityContributionPolicySelectionRevision.findUniqueOrThrow({
      where: { id: selectionResponse.body.data.selectionRevisionId as string },
    });
  const timePointer = await createD13ActivePolicy(
    fixture,
    options.timeDefinition ?? E4_TIME_DEFINITION,
    window,
  );
  const timeResponse = await request(httpServer(fixture.app))
    .patch(`${E13_APP}/${draft.activityId}/time-policy-selection`)
    .set('Authorization', fixture.creator.auth)
    .send({
      operationKey: fixture.key('time_selection'),
      expectedRevision: 0,
      changes: [
        explicitTimePolicyChange(timePointer, {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
        }),
      ],
    })
    .expect(200);
  const timeSelection = await fixture.db.activityTimePolicySelectionRevision.findUniqueOrThrow({
    where: { id: timeResponse.body.data.selectionRevisionId as string },
  });
  const actor = e4Actor(fixture.creator, true);
  await fixture.db.activity.update({
    where: { id: draft.activityId },
    data: { startAt: startsAt, endAt: endsAt, statusCode: 'published' },
  });
  await fixture.db.activitySession.update({
    where: { id: draft.sessionId },
    data: {
      startAt: startsAt,
      endAt: endsAt,
      checkInOpenAt: startsAt,
      checkInCloseAt: endsAt,
      checkOutOpenAt: startsAt,
      checkOutCloseAt: endsAt,
    },
  });
  await fixture.db.activitySessionPosition.update({
    where: { id: draft.positionId },
    data: { startAt: startsAt, endAt: endsAt },
  });
  await fixture.db.activityResponsibilityAssignment.create({
    data: {
      activityId: draft.activityId,
      memberId: actor.memberId!,
      responsibilityType: 'owner',
      canManageRegistrations: true,
      canManageAttendance: true,
      status: 'active',
      assignedByUserId: actor.id,
      source: 'publish',
    },
  });
  const review = await fixture.db.activityPublishReview.create({
    data: {
      activityId: draft.activityId,
      requestType: 'initial',
      requestVersion: 1,
      baseRevision: 0,
      status: 'approved',
      snapshot: {},
      directPublish: true,
      submittedByUserId: actor.id,
      submittedAt: startsAt,
      reviewedByUserId: actor.id,
      reviewedAt: startsAt,
    },
  });
  const selectionDocument = parseActivityContributionPolicySelectionDocument(
    contributionSelection.selectionJson,
  );
  const scopes = [
    { layerCode: 'activity' as const, sessionId: null, positionId: null },
    { layerCode: 'position' as const, sessionId: draft.sessionId, positionId: draft.positionId },
  ];
  const snapshot = await fixture.db.activityRuleSnapshot.create({
    data: {
      activityId: draft.activityId,
      workflowRevision: 0,
      timePolicySelectionRevisionId: timeSelection.id,
      contributionPolicySelectionRevisionId: options.withoutFrozenContribution
        ? null
        : contributionSelection.id,
      resolvedConfig: {
        sessions: [
          {
            sessionId: draft.sessionId,
            positions: [{ positionId: draft.positionId, attendanceRoleCode: 'service' }],
          },
        ],
        timePolicyPointers: {
          selectionRevisionId: timeSelection.id,
          selectionRevision: timeSelection.revision,
          selectionHash: timeSelection.selectionHash,
          selection: timeSelection.selectionJson,
        },
        contributionPolicyPointers: options.withoutFrozenContribution
          ? null
          : {
              schemaVersion: 1,
              selectionRevisionId: contributionSelection.id,
              selectionRevision: contributionSelection.revision,
              selectionHash: contributionSelection.selectionHash,
              proposalSelectionHash: contributionSelection.selectionHash,
              selection: selectionDocument,
              resolved: scopes.map((scope) => ({
                scope,
                pointer: contributionPointer,
                sourceLayerCode: 'activity',
                ...window,
              })),
              referenceKinds: Object.fromEntries(
                scopes.map((scope) => [
                  activityContributionPolicySelectionScopeKey(scope),
                  {
                    sessionRefKind: scope.sessionId === null ? null : 'id',
                    positionRefKind: scope.positionId === null ? null : 'id',
                  },
                ]),
              ),
            },
      } as unknown as Prisma.InputJsonValue,
      snapshotHash: 'a'.repeat(64),
      createdByReviewId: review.id,
      createdAt: new Date('2019-12-01T00:00:00.000Z'),
    },
  });
  const registration = await fixture.db.activityRegistration.create({
    data: { activityId: draft.activityId, memberId: fixture.creator.memberId, statusCode: 'pass' },
  });
  const identity = await fixture.db.activityParticipationIdentity.create({
    data: {
      activityId: draft.activityId,
      sessionId: draft.sessionId,
      registrationId: registration.id,
      memberId: fixture.creator.memberId,
      currentStatusCode: 'pass',
      currentPositionId: draft.positionId,
      populationIncluded: true,
    },
  });
  const events: string[] = [];
  for (const [eventTypeCode, occurredAt] of [
    ['check_in', startsAt],
    ['check_out', endsAt],
  ] as const) {
    const event = await fixture.db.attendancePunchEvent.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        positionId: draft.positionId,
        participationIdentityId: identity.id,
        memberId: identity.memberId,
        eventTypeCode,
        sourceCode: 'self_qr',
        occurredAt,
        receivedAt: occurredAt,
        operatorUserId: actor.id,
        eventKey: fixture.key(eventTypeCode),
        requestHash: 'b'.repeat(64),
        evidenceRevision: 0,
      },
    });
    events.push(event.id);
  }
  await fixture.db.participantServiceSegmentRevision.create({
    data: {
      participationIdentityId: identity.id,
      segmentKey: '0001',
      revision: 1,
      sourceCheckInEventId: events[0],
      sourceCloseEventId: events[1],
      resultCode: 'valid',
      statusCode: 'draft',
      checkInAt: startsAt,
      checkOutAt: endsAt,
      serviceHours: (endsAt.getTime() - startsAt.getTime()) / 3_600_000,
      lateFlag: false,
      earlyLeaveFlag: false,
    },
  });
  await options.beforeSeal?.({ ...draft, positionId: draft.positionId });
  await fixture.app.get(EvidenceSealService).seal(draft.activityId, actor, E4_META);
  let generated: Pick<
    Awaited<ReturnType<SettlementDraftService['generate']>>,
    | 'settlementRunId'
    | 'settlementVersionId'
    | 'settlementVersion'
    | 'evidenceSealId'
    | 'contentHash'
    | 'blockedItemCount'
  >;
  if (options.batch) {
    const response = await request(httpServer(fixture.app))
      .post(`${E13_APP}/${draft.activityId}/settlement/generate`)
      .set('Authorization', fixture.creator.auth)
      .send({ operationKey: fixture.key('capacity_generate') })
      .expect(200);
    expect(response.body.data.outcome).toBe('job');
    const processed = await fixture.app.get(ActivityBatchWorker).drainOnce();
    expect(processed).toMatchObject({
      jobId: response.body.data.jobId,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    const job = await fixture.db.activityBatchJob.findUniqueOrThrow({
      where: { id: response.body.data.jobId as string },
    });
    expect({ status: job.statusCode, error: job.lastErrorCode }).toEqual({
      status: 'succeeded',
      error: null,
    });
    if (!job.settlementVersionId) throw new Error('E4 batch draft result required');
    const version = await fixture.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: job.settlementVersionId },
    });
    const resolved = await fixture.db.participantSettlementResultRevision.count({
      where: { settlementVersionId: version.id, exceptionFlagsJson: { equals: Prisma.DbNull } },
    });
    generated = {
      settlementRunId: version.settlementRunId,
      settlementVersionId: version.id,
      settlementVersion: version.version,
      evidenceSealId: version.evidenceSealId,
      contentHash: version.contentHash,
      blockedItemCount: version.sessionParticipationCount - resolved,
    };
  } else {
    generated = await fixture.app
      .get(SettlementDraftService)
      .generate(draft.activityId, actor, E4_META);
  }
  if (options.recognizedServiceHours !== undefined) {
    // Existing independent recognition command: E4 never derives legacy hours from policy points.
    await fixture.app.get(SettlementDraftService).updateItem({
      activityId: draft.activityId,
      participationIdentityId: identity.id,
      expectedDraftVersion: generated.settlementVersion,
      resultCode: 'present',
      recognizedServiceHours: options.recognizedServiceHours,
      recognizedContributionPoints: 0,
      reason: '按既有认定合同明确服务小时，贡献值仍由政策证明导出',
    });
    const current = await fixture.db.attendanceSettlementVersion.findFirstOrThrow({
      where: { settlementRunId: generated.settlementRunId, statusCode: 'draft' },
      orderBy: { version: 'desc' },
    });
    generated = {
      ...generated,
      settlementVersionId: current.id,
      settlementVersion: current.version,
      contentHash: current.contentHash,
    };
  }
  const seal = await fixture.db.evidenceSeal.findUniqueOrThrow({
    where: { id: generated.evidenceSealId },
  });
  const segment = await fixture.db.participantServiceSegmentRevision.findFirstOrThrow({
    where: { participationIdentityId: identity.id, statusCode: 'draft' },
    orderBy: { revision: 'desc' },
  });
  const expectation = {
    expectedDraftVersion: generated.settlementVersion,
    expectedEvidenceSealId: seal.id,
    expectedEvidenceRevision: seal.evidenceRevision,
    expectedPopulationRevision: seal.populationRevision,
    expectedWorkflowRevision: seal.workflowRevision,
  };
  await fixture.app.get(ActivityTimeSettlementService).allocate(
    draft.activityId,
    {
      ...expectation,
      operationKey: fixture.key('recognize'),
      sourceSegmentId: segment.id,
      expectedRevision: 0,
      recognitionModeCode: options.manualSlices ? 'manual' : 'automatic',
      ...(options.manualSlices
        ? {
            manualReason: 'E4 满额来源的真实四类别分配',
            slices: options.manualSlices.map(({ categoryCode, startAt, endAt }) => ({
              categoryCode,
              startAt,
              endAt,
            })),
          }
        : {}),
      evidenceAttachmentIds: [],
    },
    actor,
    E4_META,
  );
  return {
    ...draft,
    identity,
    segment,
    snapshot,
    contributionPointer,
    generated,
    expectation,
    startsAt,
    endsAt,
  };
}

/** Same guarded shape as the existing D4 maximum-source fixture, with actual E1 frozen policy.
 * All evidence precedes seal/generation; every allocation has complete children and receipt.
 * No trigger is disabled and no fixture cost is counted as a business-operation measurement. */
export async function createMaximumE4Source(f: E4Fixture) {
  const start = new Date('2020-03-01T08:00:00.000Z');
  const end = new Date('2020-03-01T09:00:00.000Z');
  const slicesFor = (startsAt: Date, endsAt: Date): ActivityTimeAllocationSliceInput[] =>
    (
      [
        'volunteer_service',
        'training',
        'organization',
        'non_creditable',
        'volunteer_service',
      ] as const
    ).map((categoryCode, index) => ({
      categoryCode,
      intervalKindCode: 'service_segment',
      startAt: new Date(
        startsAt.getTime() + ((endsAt.getTime() - startsAt.getTime()) * index) / 5,
      ).toISOString(),
      endAt: new Date(
        startsAt.getTime() + ((endsAt.getTime() - startsAt.getTime()) * (index + 1)) / 5,
      ).toISOString(),
    }));
  const p = await createE4Source(f, {
    startsAt: start,
    endsAt: end,
    batch: true,
    manualSlices: slicesFor(start, end),
    beforeSeal: async (draft) => {
      for (let offset = 0; offset < 1999; offset += 100) {
        const people = Array.from({ length: Math.min(100, 1999 - offset) }, (_, index) => ({
          index: offset + index,
          memberId: f.key('capacity_member'),
          registrationId: f.key('capacity_registration'),
          identityId: f.key('capacity_identity'),
        }));
        const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
        const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = [];
        for (const person of people) {
          for (let index = 0; index < (person.index === 0 ? 9 : 5); index++) {
            const startsAt = new Date(start.getTime() + index * 60001);
            const endsAt = new Date(startsAt.getTime() + 60000);
            const eventIds = [f.key('capacity_in'), f.key('capacity_out')];
            for (const [eventIndex, occurredAt] of [startsAt, endsAt].entries()) {
              events.push({
                id: eventIds[eventIndex],
                activityId: draft.activityId,
                sessionId: draft.sessionId,
                positionId: draft.positionId,
                participationIdentityId: person.identityId,
                memberId: person.memberId,
                eventTypeCode: eventIndex === 0 ? 'check_in' : 'check_out',
                sourceCode: 'self_qr',
                occurredAt,
                receivedAt: occurredAt,
                operatorUserId: f.creator.id,
                eventKey: f.key('capacity_event'),
                requestHash: 'b'.repeat(64),
                evidenceRevision: 0,
              });
            }
            segments.push({
              id: f.key('capacity_segment'),
              participationIdentityId: person.identityId,
              segmentKey: String(index + 1).padStart(4, '0'),
              revision: 1,
              sourceCheckInEventId: eventIds[0],
              sourceCloseEventId: eventIds[1],
              resultCode: 'valid',
              statusCode: 'draft',
              checkInAt: startsAt,
              checkOutAt: endsAt,
              serviceHours: 0.02,
              lateFlag: false,
              earlyLeaveFlag: false,
            });
          }
        }
        await f.db.$transaction(
          async (tx) => {
            await tx.member.createMany({
              data: people.map((person) => ({
                id: person.memberId,
                memberNo: person.memberId,
                ...memberIdentityData('E4 maximum-source fixture'),
              })),
            });
            await tx.activityRegistration.createMany({
              data: people.map((person) => ({
                id: person.registrationId,
                activityId: draft.activityId,
                memberId: person.memberId,
                statusCode: 'pass',
              })),
            });
            await tx.activityParticipationIdentity.createMany({
              data: people.map((person) => ({
                id: person.identityId,
                activityId: draft.activityId,
                sessionId: draft.sessionId,
                registrationId: person.registrationId,
                memberId: person.memberId,
                currentStatusCode: 'pass',
                populationIncluded: true,
                currentPositionId: draft.positionId,
              })),
            });
            await tx.attendancePunchEvent.createMany({ data: events });
            await tx.participantServiceSegmentRevision.createMany({ data: segments });
          },
          { timeout: 30000 },
        );
      }
    },
  });
  const sources = await f.db.participantServiceSegmentRevision.findMany({
    where: {
      identity: { activityId: p.activityId },
      statusCode: 'draft',
      participationIdentityId: { not: p.identity.id },
    },
    include: { identity: { select: { memberId: true } } },
  });
  expect(sources).toHaveLength(9999);
  const prototype = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
    where: {
      sourceSegmentId: p.segment.id,
      settlementDraftVersionId: p.generated.settlementVersionId,
    },
  });
  const receipt = await f.db.participantTimeAllocationCommandReceipt.findFirstOrThrow({
    where: { allocationRevisionId: prototype.id },
  });
  for (let offset = 0; offset < sources.length; offset += 100) {
    const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
    const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
    const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
    for (const source of sources.slice(offset, offset + 100)) {
      if (!source.checkInAt || !source.checkOutAt)
        throw new Error('E4 current closed source required');
      const id = f.key('capacity_allocation');
      const input = slicesFor(source.checkInAt, source.checkOutAt);
      const { manifest, allocationHash } = buildActivityTimeAllocationManifest(input);
      parents.push({
        ...prototype,
        id,
        sliceCount: input.length,
        participationIdentityId: source.participationIdentityId,
        memberId: source.identity.memberId,
        segmentKey: source.segmentKey,
        sourceSegmentId: source.id,
        sourceSegmentRevision: source.revision,
        allocationJson: {
          schemaVersion: manifest.schemaVersion,
          slices: Object.fromEntries(
            Object.entries(manifest.slices).map(([key, value]) => [key, { ...value }]),
          ),
        },
        allocationHash,
      });
      input.forEach((slice, ordinal) =>
        slices.push({
          id: f.key('capacity_slice'),
          allocationRevisionId: id,
          activityId: p.activityId,
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: slice.intervalKindCode,
          startAt: new Date(slice.startAt),
          endAt: new Date(slice.endAt),
        }),
      );
      receipts.push({
        ...receipt,
        id: f.key('capacity_receipt'),
        allocationRevisionId: id,
        operationKey: f.key('capacity_operation'),
        resultJson: {
          schemaVersion: 1,
          activityId: p.activityId,
          allocationRevisionId: id,
          revision: 1,
          sourceSegmentId: source.id,
          sourceSegmentRevision: source.revision,
          recognitionModeCode: 'manual',
          allocationHash,
          sliceCount: input.length,
          evidenceCount: 0,
          createdAt: prototype.createdAt.toISOString(),
        },
      });
    }
    await f.db.$transaction(
      async (tx) => {
        await tx.participantTimeAllocationRevision.createMany({ data: parents });
        await tx.participantTimeAllocationSlice.createMany({ data: slices });
        await tx.participantTimeAllocationCommandReceipt.createMany({ data: receipts });
      },
      { timeout: 30000 },
    );
  }
  return p;
}

export async function prepareE4Time(
  f: E4Fixture,
  source: Awaited<ReturnType<typeof createE4Source>>,
  operationLabel: 'prepare' | 's13_prepare' = 'prepare',
) {
  return f.app.get(ActivityTimeSettlementService).prepare(
    source.activityId,
    {
      expectedDraftVersion: source.expectation.expectedDraftVersion,
      expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
      operationKey: f.key(operationLabel),
      expectedTimeRevision: 0,
    },
    e4Actor(f.creator, true),
    E4_META,
  );
}
export async function submitE4Time(
  f: E4Fixture,
  source: Awaited<ReturnType<typeof createE4Source>>,
  prepared: TimeSettlementReceiptResult,
  operationLabel: 'submit' | 's13_submit' = 'submit',
) {
  return f.app.get(ActivityTimeSettlementService).submit(
    source.activityId,
    {
      expectedDraftVersion: source.expectation.expectedDraftVersion,
      expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
      operationKey: f.key(operationLabel),
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    },
    e4Actor(f.creator, true),
    E4_META,
  );
}
export async function postE4Ledger(f: E4Fixture, submitted: TimeSettlementReceiptResult) {
  const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: submitted.settlementVersionId },
  });
  const expectation = {
    evidenceSealId: version.evidenceSealId,
    evidenceRevision: version.evidenceRevision,
    populationRevision: version.populationRevision,
    workflowRevision: version.workflowRevision,
    contentHash: version.contentHash,
  };
  const review = f.app.get(SettlementReviewService);
  await review.firstReview(
    {
      activityId: submitted.activityId,
      actionCode: 'approve',
      expectation,
      operationKey: f.key('first_review'),
      requestHash: 'c'.repeat(64),
    },
    e4Actor(f.reviewer),
    E4_META,
  );
  const final = await review.finalReview(
    {
      activityId: submitted.activityId,
      actionCode: 'approve',
      expectation,
      operationKey: f.key('final_review'),
      requestHash: 'd'.repeat(64),
    },
    e4Actor(f.finalReviewer),
    E4_META,
  );
  if (!final.ledgerPostingBatchId)
    throw new Error('E4 final review must create a preparation batch');
  const preparation = f.app.get(LedgerPreparationService);
  const job = await preparation.ensurePrepareJob(final.ledgerPostingBatchId);
  const items = await f.db.activityBatchJobItem.findMany({
    where: { jobId: job.jobId },
    orderBy: { itemKey: 'asc' },
  });
  for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
  const ready = await preparation.finalize(job.jobId);
  if (ready.batchStatus !== 'ready') throw new Error('E4 ledger preparation did not become ready');
  const committed = await f.app.get(LedgerPostingService).commitBatch(
    {
      postingBatchId: final.ledgerPostingBatchId,
      operationKey: f.key('commit'),
    },
    e4Actor(f.finalReviewer),
    E4_META,
  );
  return { batchId: final.ledgerPostingBatchId, committed };
}
