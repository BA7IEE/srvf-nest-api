import { BindingScopeType, PrincipalType, Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'node:child_process';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ActivityTimeCutoverService } from '../../src/modules/activities/activity-time-cutover.service';
import {
  ACTIVITY_TIME_CUTOVER_PERMISSION,
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
} from '../../src/modules/activities/activity-time-cutover-command';
import {
  closeD13Fixture,
  createD13Fixture,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const REQUEST = {
  operationKey: 'd8-1-cutover-e2e',
  deployedMainSha: 'a'.repeat(40),
  evidenceBundleHash: 'b'.repeat(64),
};

describe('D8-1 activity time cutover command', () => {
  let fixture: D13Fixture;
  let actor: CurrentUserPayload;
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousReadonly = process.env.ACTIVITY_WORKFLOW_READONLY;
  const dedicatedW98 = process.env.SRVF_D8_1_W98 === '1';
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  beforeAll(() => {
    if (!dedicatedW98) return;
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    process.env.STORAGE_LOCAL_ROOT = './tmp/storage-w98';
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    dropWorkerDatabase(98);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
  }, 120_000);

  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_WORKFLOW_READONLY = 'true';
    fixture = await createD13Fixture();
    actor = {
      id: fixture.creator.id,
      memberId: fixture.creator.memberId,
      username: 'd8-cutover-maintainer',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const permission = await fixture.db.permission.upsert({
      where: { code: ACTIVITY_TIME_CUTOVER_PERMISSION },
      update: {},
      create: {
        code: ACTIVITY_TIME_CUTOVER_PERMISSION,
        module: 'activity',
        action: 'record',
        resourceType: 'settlement-final-review',
      },
    });
    const role = await fixture.db.rbacRole.create({
      data: { code: fixture.key('cutover_role'), displayName: 'D8-1 cutover maintainer' },
    });
    await fixture.db.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: actor.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
  }, 120_000);

  afterEach(async () => {
    await closeD13Fixture(fixture);
    restoreEnvironment('ACTIVITY_V11_WORKFLOW_ENABLED', previousV11);
    restoreEnvironment('ACTIVITY_WORKFLOW_READONLY', previousReadonly);
  });

  afterAll(() => {
    if (!dedicatedW98) return;
    try {
      dropWorkerDatabase(98);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
      restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
    }
  }, 120_000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('checks, commits and replays the singleton without duplicating audit', async () => {
    const service = fixture.app.get(ActivityTimeCutoverService);
    await expect(service.check()).resolves.toMatchObject({
      schemaVersion: 1,
      status: 'ready',
      v11Enabled: true,
      maintenanceWindowOpen: true,
      preparingOrReadyBatchCount: 0,
      pendingOrProcessingPrepareJobCount: 0,
      cutoverReceipt: null,
      blockers: [],
    });

    const first = await service.execute({
      currentUser: actor,
      request: REQUEST,
      auditMeta: { requestId: 'd8-first', ip: null, ua: null },
    });
    expect(first).toMatchObject({
      id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      operationKey: REQUEST.operationKey,
      deployedMainSha: REQUEST.deployedMainSha,
      evidenceBundleHash: REQUEST.evidenceBundleHash,
      actorUserId: actor.id,
      formatVersion: 1,
      replayed: false,
    });
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Number.isNaN(Date.parse(first.cutoverAt))).toBe(false);

    const replay = await service.execute({
      currentUser: actor,
      request: REQUEST,
      auditMeta: { requestId: 'd8-replay', ip: null, ua: null },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await fixture.db.auditLog.count({ where: { event: 'activity.time-cutover.command' } }),
    ).toBe(1);
    await expect(service.check()).resolves.toMatchObject({
      status: 'already_cut_over',
      cutoverReceipt: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID, replayed: false },
    });

    await expect(
      service.execute({
        currentUser: actor,
        request: { ...REQUEST, operationKey: 'd8-1-conflict' },
        auditMeta: { requestId: 'd8-conflict', ip: null, ua: null },
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_CUTOVER_COMMAND_CONFLICT });
  });

  it('requires an explicit active GLOBAL final-review grant even for super admin', async () => {
    await fixture.db.roleBinding.updateMany({
      where: { principalId: actor.id, scopeType: BindingScopeType.GLOBAL },
      data: { status: 'SUSPENDED' },
    });
    await expect(
      fixture.app.get(ActivityTimeCutoverService).execute({
        currentUser: actor,
        request: REQUEST,
        auditMeta: { requestId: 'd8-denied', ip: null, ua: null },
      }),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(await fixture.db.activityTimeCutoverReceipt.count()).toBe(0);
  });

  it('keeps the receipt append-only at the database boundary', async () => {
    await fixture.app.get(ActivityTimeCutoverService).execute({
      currentUser: actor,
      request: REQUEST,
      auditMeta: { requestId: 'd8-immutable', ip: null, ua: null },
    });
    await expect(
      fixture.db.activityTimeCutoverReceipt.update({
        where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
        data: { evidenceBundleHash: 'c'.repeat(64) },
      }),
    ).rejects.toThrow('activity time cutover facts are immutable');
    await expect(
      fixture.db.activityTimeCutoverReceipt.delete({
        where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
      }),
    ).rejects.toThrow('activity time cutover facts are immutable');
  });
});
