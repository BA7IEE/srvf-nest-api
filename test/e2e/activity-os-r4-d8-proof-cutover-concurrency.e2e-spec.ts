import { execFileSync } from 'node:child_process';
import { BindingScopeType, PrincipalType, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  ACTIVITY_TIME_CUTOVER_PERMISSION,
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
} from '../../src/modules/activities/activity-time-cutover-command';
import { ActivityTimeCutoverService } from '../../src/modules/activities/activity-time-cutover.service';
import {
  closeD13Fixture,
  createD13Draft,
  createD13Fixture,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const REQUEST = {
  operationKey: 'd8-1-concurrency',
  deployedMainSha: 'c'.repeat(40),
  evidenceBundleHash: 'd'.repeat(64),
};

describe('D8-1 cutover linearization fence', () => {
  let fixture: D13Fixture;
  let actor: CurrentUserPayload;
  let settlement: { runId: string; versionId: string };
  const dedicatedW98 = process.env.SRVF_D8_1_W98 === '1';
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousReadonly = process.env.ACTIVITY_WORKFLOW_READONLY;
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
    const activity = await createD13Draft(fixture);
    const seal = await fixture.db.evidenceSeal.create({
      data: {
        activityId: activity.activityId,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date('2099-09-01T10:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: 'e'.repeat(64),
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: new Date('2099-09-01T10:00:00.000Z'),
      },
    });
    const run = await fixture.db.attendanceSettlementRun.create({
      data: { activityId: activity.activityId, statusCode: 'drafting' },
    });
    const version = await fixture.db.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: 'f'.repeat(64),
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId: actor.id,
        statusCode: 'draft',
      },
    });
    settlement = { runId: run.id, versionId: version.id };
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

  function executeCutover() {
    return fixture.app.get(ActivityTimeCutoverService).execute({
      currentUser: actor,
      request: REQUEST,
      auditMeta: { requestId: 'd8-concurrency', ip: null, ua: null },
    });
  }

  it('waits for an earlier shared batch fence before committing the exclusive cutover', async () => {
    let release!: () => void;
    let acquired!: (pid: number) => void;
    const unlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve) => {
      acquired = resolve;
    });
    const holder = fixture.db.$transaction(
      async (tx) => {
        const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid
        `;
        await tx.ledgerPostingBatch.create({
          data: {
            settlementRunId: settlement.runId,
            settlementVersionId: settlement.versionId,
            batchRevision: 1,
            statusCode: 'failed',
            requestKey: fixture.key('earlier_batch'),
            failureCount: 1,
            failedAt: new Date(),
          },
        });
        acquired(connection.pid);
        await unlocked;
      },
      { timeout: 15_000 },
    );
    const holderPid = await ready;
    const cutover = executeCutover();
    void cutover.catch(() => undefined);
    let observed = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await fixture.db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `;
        if (row.waiting) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
    } finally {
      release();
      await holder;
    }
    await expect(cutover).resolves.toMatchObject({
      id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      replayed: false,
    });
    expect(await fixture.db.ledgerPostingBatch.count({ where: { statusCode: 'failed' } })).toBe(1);
  });

  it('rejects an in-flight batch and prevents an unbound post-cutover committed root', async () => {
    const open = await fixture.db.ledgerPostingBatch.create({
      data: {
        settlementRunId: settlement.runId,
        settlementVersionId: settlement.versionId,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: fixture.key('open_batch'),
      },
    });
    await expect(executeCutover()).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_CUTOVER_NOT_READY,
    });
    await fixture.db.ledgerPostingBatch.update({
      where: { id: open.id },
      data: { statusCode: 'failed', failedAt: new Date(), failureCount: 1 },
    });
    await expect(executeCutover()).resolves.toMatchObject({ replayed: false });
    await expect(
      fixture.db.ledgerPostingBatch.create({
        data: {
          settlementRunId: settlement.runId,
          settlementVersionId: settlement.versionId,
          batchRevision: 2,
          statusCode: 'committed',
          requestKey: fixture.key('unbound_commit'),
          committedAt: new Date(),
          committedByUserId: actor.id,
        },
      }),
    ).rejects.toThrow('post-cutover ordinary batch has no classified root manifest');
  });
});
