import { Role, UserStatus, Prisma } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { StorageConsistencyWorkerModule } from '../../src/modules/attachments/storage-consistency-worker.module';
import { PrismaService } from '../../src/database/prisma.service';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
import request from 'supertest';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityResponsibilityGrantProjector } from '../../src/modules/activities/activity-responsibility-grant-projector';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftBatchService,
  SettlementDraftLeaseLostError,
} from '../../src/modules/activities/settlement-draft-batch.service';
import {
  createD13Fixture,
  closeD13Fixture,
  createD13Draft,
  D13_APP,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { waitFor } from '../helpers/wait-for';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig, { type AppConfig } from '../../src/config/app.config';

describe('large settlement draft: real HTTP and PostgreSQL worker receipts', () => {
  let f: D13Fixture;
  let resourceBuild: string | undefined;
  afterAll(async () => {
    if (resourceBuild) await rm(resourceBuild, { recursive: true, force: true });
  });
  const oldGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createD13Fixture();
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await closeD13Fixture(f);
    if (oldGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = oldGate;
  });

  async function compiledProbeRoot(): Promise<string> {
    if (!resourceBuild) {
      const projectRoot = resolve(__dirname, '../..');
      const temporaryRoot = resolve(projectRoot, 'tmp');
      await mkdir(temporaryRoot, { recursive: true });
      resourceBuild = await mkdtemp(resolve(temporaryRoot, 'draft-resource-build-'));
      await promisify(execFile)(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '-p',
          'tsconfig.build.json',
          '--outDir',
          resourceBuild,
          '--incremental',
          'false',
        ],
        { cwd: projectRoot, timeout: 120000, maxBuffer: 1024 * 1024 },
      );
    }
    return resourceBuild;
  }

  async function preparePopulation(population: number) {
    const draft = await createD13Draft(f, { withPosition: true });
    const start = new Date('2020-03-01T08:00:00.000Z');
    const end = new Date('2020-03-01T09:00:00.000Z');
    await f.db.activity.update({
      where: { id: draft.activityId },
      data: { startAt: start, endAt: end, statusCode: 'published' },
    });
    await f.db.activitySession.update({
      where: { id: draft.sessionId },
      data: {
        startAt: start,
        endAt: end,
        checkInOpenAt: start,
        checkInCloseAt: end,
        checkOutOpenAt: start,
        checkOutCloseAt: end,
      },
    });
    await f.db.activityResponsibilityAssignment.create({
      data: {
        activityId: draft.activityId,
        memberId: f.creator.memberId,
        responsibilityType: 'owner',
        canManageAttendance: true,
        canManageRegistrations: true,
        status: 'active',
        assignedByUserId: f.creator.id,
        source: 'publish',
      },
    });
    const people = Array.from({ length: population }, () => ({
      memberId: f.key('member'),
      identityId: f.key('identity'),
      registrationId: f.key('registration'),
    }));
    await f.db.member.createMany({
      data: people.map((p) => ({
        id: p.memberId,
        memberNo: p.memberId,
        ...memberIdentityData('草稿批处理夹具'),
      })),
    });
    await f.db.activityRegistration.createMany({
      data: people.map((p) => ({
        id: p.registrationId,
        activityId: draft.activityId,
        memberId: p.memberId,
        statusCode: 'pass',
      })),
    });
    await f.db.activityParticipationIdentity.createMany({
      data: people.map((p) => ({
        id: p.identityId,
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        memberId: p.memberId,
        registrationId: p.registrationId,
        currentStatusCode: 'pass',
        currentPositionId: draft.positionId,
        populationIncluded: true,
      })),
    });
    await f.app.get(EvidenceSealService).seal(
      draft.activityId,
      {
        id: f.creator.id,
        memberId: f.creator.memberId,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        username: 'batch-fixture',
      },
      { requestId: f.key('seal'), ip: null, ua: null },
    );
    return draft;
  }

  async function enqueue(population = 501, asOrdinaryMember = false) {
    const draft = await preparePopulation(population);
    const operationKey = f.key('generate');
    if (asOrdinaryMember) {
      // The shared historical fixture predates settlement permissions on this production role.
      const ownerRole = await f.db.rbacRole.findUniqueOrThrow({
        where: { code: 'activity-owner' },
      });
      const generatePermission = await f.db.permission.upsert({
        where: { code: 'activity.settlement-generate.record' },
        create: {
          code: 'activity.settlement-generate.record',
          module: 'activity',
          action: 'settlement-generate',
          resourceType: 'record',
        },
        update: {},
      });
      await f.db.rolePermission.createMany({
        data: [{ roleId: ownerRole.id, permissionId: generatePermission.id }],
        skipDuplicates: true,
      });
      await f.db.activityResponsibilityAssignment.updateMany({
        where: { activityId: draft.activityId, memberId: f.creator.memberId, status: 'active' },
        data: { memberId: f.reviewer.memberId },
      });
      const assignment = await f.db.activityResponsibilityAssignment.findFirstOrThrow({
        where: { activityId: draft.activityId, memberId: f.reviewer.memberId, status: 'active' },
      });
      await f.db.$transaction((tx) =>
        f.app.get(ActivityResponsibilityGrantProjector).projectOwner({
          tx,
          assignmentId: assignment.id,
          activityId: draft.activityId,
          memberId: f.reviewer.memberId,
          actorUserId: f.creator.id,
          now: new Date(),
        }),
      );
      expect(await f.db.user.findUniqueOrThrow({ where: { id: f.reviewer.id } })).toMatchObject({
        role: Role.USER,
        memberId: f.reviewer.memberId,
        status: UserStatus.ACTIVE,
      });
    }
    const response = await request(httpServer(f.app))
      .post(`${D13_APP}/${draft.activityId}/settlement/generate`)
      .set('Authorization', asOrdinaryMember ? f.reviewer.auth : f.creator.auth)
      .send({ operationKey });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 200, code: 0 });
    expect(response.body.data.outcome).toBe('job');
    const job = await f.db.activityBatchJob.findUniqueOrThrow({ where: { operationKey } });
    return { ...draft, job, operationKey };
  }

  async function versionCount(activityId: string) {
    return f.db.attendanceSettlementVersion.count({ where: { settlementRun: { activityId } } });
  }

  async function draftAuditCount(activityId: string) {
    return f.db.auditLog.count({
      where: {
        resourceId: activityId,
        event: 'activity.publish',
        context: { path: ['extra', 'operation'], equals: 'settlement-draft-generate' },
      },
    });
  }

  it.each(['active', 'responsibility-revoked', 'organization-inactive'] as const)(
    'ordinary member execution rechecks current eligibility: %s',
    async (change) => {
      const p = await enqueue(501, true);
      expect(p.job.createdByUserId).toBe(f.reviewer.id);
      if (change === 'responsibility-revoked') {
        expect(
          await f.db.$transaction(async (tx) => {
            const now = new Date();
            const revoked = await tx.activityResponsibilityAssignment.updateMany({
              where: { activityId: p.activityId, memberId: f.reviewer.memberId, status: 'active' },
              data: { status: 'revoked', endedAt: now, endedByUserId: f.creator.id },
            });
            expect(revoked.count).toBe(1);
            return f.app.get(ActivityResponsibilityGrantProjector).endAssignmentBindings({
              tx,
              activityId: p.activityId,
              memberId: f.reviewer.memberId,
              responsibilityType: 'owner',
              canManageRegistrations: true,
              canManageAttendance: true,
              now,
            });
          }),
        ).toBe(1);
      }
      if (change === 'organization-inactive') {
        await f.db.organization.update({
          where: { id: f.organizationId },
          data: { status: 'INACTIVE' },
        });
      }
      const allowed = change === 'active';
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: allowed ? 1 : 0,
        itemsFailed: allowed ? 0 : 1,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({
        statusCode: allowed ? 'succeeded' : 'failed',
        succeeded: allowed ? 1 : 0,
        failed: allowed ? 0 : 1,
      });
      expect(job.items).toHaveLength(1);
      expect(job.items[0].statusCode).toBe(allowed ? 'succeeded' : 'failed');
      expect(await versionCount(p.activityId)).toBe(allowed ? 1 : 0);
      expect(await draftAuditCount(p.activityId)).toBe(allowed ? 1 : 0);
      if (!allowed) {
        expect(job.lastErrorCode).toBe(String(BizCode.RBAC_FORBIDDEN.code));
        expect(job.settlementVersionId).toBeNull();
        expect(job.items[0].resultReference).toBeNull();
      }
    },
    120000,
  );

  it.each(
    (
      [
        'user-disabled',
        'member-disabled',
        'binding-changed',
        'grant-ended',
        'responsibility-revoked',
        'organization-inactive',
      ] as const
    ).flatMap((change) => [
      { change, waitForLock: false },
      { change, waitForLock: true },
    ]),
  )(
    'ordinary member invalidation before or during the Activity lock: %j',
    async ({ change, waitForLock }) => {
      const p = await enqueue(501, true);
      let release!: () => void;
      let held!: (pid: number) => void;
      const ready = new Promise<number>((resolve) => {
        held = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${p.activityId} FOR UPDATE`;
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          held(row.pid);
          await hold;
        },
        { timeout: 15000 },
      );
      const pid = await ready;
      const execute = () =>
        f.app
          .get(ActivityBatchWorker)
          .drainOnce()
          .then(
            (value) => ({ value, error: null }),
            (error: unknown) => ({ value: null, error }),
          );
      let attempt = waitForLock ? execute() : null;
      try {
        if (waitForLock)
          await waitFor(
            async () =>
              (
                await f.db.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
              )[0].blocked,
            { timeoutMs: 5000, message: 'ordinary draft worker did not wait on Activity lock' },
          );
        if (change === 'user-disabled')
          await f.db.user.update({ where: { id: f.reviewer.id }, data: { status: 'DISABLED' } });
        if (change === 'member-disabled')
          await f.db.member.update({
            where: { id: f.reviewer.memberId },
            data: { status: 'INACTIVE' },
          });
        if (change === 'binding-changed')
          await f.db.user.update({ where: { id: f.reviewer.id }, data: { memberId: null } });
        if (change === 'organization-inactive')
          await f.db.organization.update({
            where: { id: f.organizationId },
            data: { status: 'INACTIVE' },
          });
        if (change === 'responsibility-revoked') {
          await f.db.$transaction(async (tx) => {
            const now = new Date();
            const revoked = await tx.activityResponsibilityAssignment.updateMany({
              where: { activityId: p.activityId, memberId: f.reviewer.memberId, status: 'active' },
              data: { status: 'revoked', endedAt: now, endedByUserId: f.creator.id },
            });
            expect(revoked.count).toBe(1);
            expect(
              await f.app.get(ActivityResponsibilityGrantProjector).endAssignmentBindings({
                tx,
                activityId: p.activityId,
                memberId: f.reviewer.memberId,
                responsibilityType: 'owner',
                canManageRegistrations: true,
                canManageAttendance: true,
                now,
              }),
            ).toBe(1);
          });
        }
        if (change === 'grant-ended') {
          const ended = await f.db.roleBinding.updateMany({
            where: {
              principalType: 'MEMBER',
              principalId: f.reviewer.memberId,
              scopeActivityId: p.activityId,
              role: { code: 'activity-owner' },
              status: 'ACTIVE',
            },
            data: { status: 'ENDED', endedAt: new Date() },
          });
          expect(ended.count).toBe(1);
          expect(
            await f.db.activityResponsibilityAssignment.count({
              where: { activityId: p.activityId, memberId: f.reviewer.memberId, status: 'active' },
            }),
          ).toBe(1);
        }
        release();
        await blocker;
        if (!attempt) attempt = execute();
        const result = await attempt;
        expect(result.error).toBeNull();
        expect(result.value).toMatchObject({ jobId: p.job.id, itemsProcessed: 0, itemsFailed: 1 });
        const job = await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: p.job.id },
          include: { items: true },
        });
        expect(job).toMatchObject({
          statusCode: 'failed',
          succeeded: 0,
          failed: 1,
          settlementVersionId: null,
          lastErrorCode: String(BizCode.RBAC_FORBIDDEN.code),
        });
        expect(job.items).toHaveLength(1);
        expect(job.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
        expect(await versionCount(p.activityId)).toBe(0);
        expect(await draftAuditCount(p.activityId)).toBe(0);
      } finally {
        release();
        await blocker;
        await attempt;
      }
    },
    120000,
  );

  it.each(['evidence', 'population', 'workflow', 'seal'] as const)(
    'real %s drift after enqueue refuses the frozen input without partial business state',
    async (kind) => {
      const p = await enqueue();
      if (kind === 'evidence' || kind === 'population') {
        const field = kind === 'evidence' ? 'evidenceRevision' : 'populationRevision';
        await f.db.activityEvidenceState.upsert({
          where: { activityId: p.activityId },
          create: { activityId: p.activityId, [field]: 1 },
          update: { [field]: { increment: 1 } },
        });
      } else if (kind === 'workflow') {
        await f.db.activity.update({
          where: { id: p.activityId },
          data: { workflowRevision: { increment: 1 } },
        });
      } else {
        await f.db.evidenceSeal.updateMany({
          where: { activityId: p.activityId, statusCode: 'active' },
          data: { statusCode: 'superseded' },
        });
      }
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: 0,
        itemsFailed: 1,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({
        statusCode: 'failed',
        succeeded: 0,
        failed: 1,
        settlementVersionId: null,
        lastErrorCode: String(
          (kind === 'seal'
            ? BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED
            : BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE
          ).code,
        ),
      });
      expect(job.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
      expect(await versionCount(p.activityId)).toBe(0);
      expect(await draftAuditCount(p.activityId)).toBe(0);
    },
    120000,
  );

  it('a real replacement seal rejects the old task and a new key generates against the new facts', async () => {
    const p = await enqueue();
    const oldSeal = await f.db.evidenceSeal.findFirstOrThrow({
      where: { activityId: p.activityId, statusCode: 'active' },
    });
    await f.db.activityEvidenceState.upsert({
      where: { activityId: p.activityId },
      create: { activityId: p.activityId, evidenceRevision: 1 },
      update: { evidenceRevision: { increment: 1 } },
    });
    await f.app.get(EvidenceSealService).seal(
      p.activityId,
      {
        id: f.creator.id,
        memberId: f.creator.memberId,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        username: 'batch-fixture',
      },
      { requestId: f.key('reseal'), ip: null, ua: null },
    );
    const newSeal = await f.db.evidenceSeal.findFirstOrThrow({
      where: { activityId: p.activityId, statusCode: 'active' },
    });
    expect(newSeal.id).not.toBe(oldSeal.id);
    expect(newSeal.evidenceRevision).toBe(oldSeal.evidenceRevision + 1);
    expect(await f.db.evidenceSeal.findUniqueOrThrow({ where: { id: oldSeal.id } })).toMatchObject({
      statusCode: 'superseded',
    });
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 0,
      itemsFailed: 1,
    });
    const failed = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(failed).toMatchObject({
      statusCode: 'failed',
      settlementVersionId: null,
      lastErrorCode: String(BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE.code),
    });
    expect(failed.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
    expect(await versionCount(p.activityId)).toBe(0);
    expect(await draftAuditCount(p.activityId)).toBe(0);
    const operationKey = f.key('new-facts');
    const response = await request(httpServer(f.app))
      .post(`${D13_APP}/${p.activityId}/settlement/generate`)
      .set('Authorization', f.creator.auth)
      .send({ operationKey });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 200, code: 0 });
    expect(response.body.data.outcome).toBe('job');
    const next = await f.db.activityBatchJob.findUniqueOrThrow({ where: { operationKey } });
    expect(next.id).not.toBe(p.job.id);
    expect(next.payload).toMatchObject({
      evidenceSealId: newSeal.id,
      evidenceRevision: newSeal.evidenceRevision,
    });
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: next.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    const completed = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: next.id } });
    expect(completed.statusCode).toBe('succeeded');
    expect(completed.settlementVersionId).not.toBeNull();
    expect(
      await f.db.attendanceSettlementVersion.findMany({
        where: { settlementRun: { activityId: p.activityId } },
        select: { id: true, evidenceSealId: true },
      }),
    ).toEqual([{ id: completed.settlementVersionId, evidenceSealId: newSeal.id }]);
    expect(await draftAuditCount(p.activityId)).toBe(1);
    expect(
      await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      }),
    ).toEqual(failed);
  }, 120000);

  it('a queued regeneration cannot modify a run submitted through the real HTTP command', async () => {
    const p = await enqueue();
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    const draft = await f.db.attendanceSettlementVersion.findFirstOrThrow({
      where: { settlementRun: { activityId: p.activityId }, statusCode: 'draft' },
    });
    const operationKey = f.key('queued-regeneration');
    const identities = await f.db.activityParticipationIdentity.findMany({
      where: { activityId: p.activityId, populationIncluded: true },
      select: { id: true },
    });
    expect(identities).toHaveLength(501);
    for (const identity of identities) {
      const edited = await request(httpServer(f.app))
        .patch(`${D13_APP}/${p.activityId}/settlement/items/${identity.id}`)
        .set('Authorization', f.creator.auth)
        .send({
          expectedDraftVersion: draft.version,
          resultCode: 'absent',
          recognizedServiceHours: 0,
          recognizedContributionPoints: 0,
          reason: '隔离测试确认未出席',
        });
      expect({ status: edited.status, code: edited.body.code }).toEqual({ status: 200, code: 0 });
    }
    const queued = await request(httpServer(f.app))
      .post(`${D13_APP}/${p.activityId}/settlement/generate`)
      .set('Authorization', f.creator.auth)
      .send({ operationKey });
    expect({ status: queued.status, code: queued.body.code }).toEqual({ status: 200, code: 0 });
    const job = await f.db.activityBatchJob.findUniqueOrThrow({ where: { operationKey } });
    expect(job.statusCode).toBe('pending');
    const submitted = await request(httpServer(f.app))
      .post(`${D13_APP}/${p.activityId}/settlement/submit`)
      .set('Authorization', f.creator.auth)
      .send({
        operationKey: f.key('submit'),
        expectedDraftVersion: draft.version,
        evidenceSealId: draft.evidenceSealId,
        confirmation: true,
      });
    expect({ status: submitted.status, code: submitted.body.code }).toEqual({
      status: 200,
      code: 0,
    });
    const before = await f.db.attendanceSettlementRun.findUniqueOrThrow({
      where: { activityId: p.activityId },
      include: { versions: true },
    });
    expect(before.statusCode).toBe('pending_first_review');
    expect(before.versions).toHaveLength(2);
    const beforeResults = await f.db.participantSettlementResultRevision.findMany({
      where: { settlementVersion: { settlementRunId: before.id } },
      orderBy: { id: 'asc' },
    });
    expect(beforeResults).toHaveLength(1002);
    expect(await draftAuditCount(p.activityId)).toBe(1);
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: job.id,
      itemsProcessed: 0,
      itemsFailed: 1,
    });
    expect(await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      statusCode: 'failed',
      succeeded: 0,
      failed: 1,
      settlementVersionId: null,
      lastErrorCode: String(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID.code),
    });
    expect(
      await f.db.attendanceSettlementRun.findUniqueOrThrow({
        where: { activityId: p.activityId },
        include: { versions: true },
      }),
    ).toEqual(before);
    expect(
      await f.db.participantSettlementResultRevision.findMany({
        where: { settlementVersion: { settlementRunId: before.id } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforeResults);
    expect(await draftAuditCount(p.activityId)).toBe(1);
  }, 120000);

  it('SIGKILL after uncommitted draft writes rolls back and a fresh process recovers the lease', async () => {
    const p = await enqueue();
    const root = await compiledProbeRoot();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const database = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
    const script = `
      require('reflect-metadata');
      const path = require('node:path');
      const root = process.argv[1], database = process.argv[2], mode = process.argv[3];
      const url = new URL(process.env.DATABASE_URL);
      if (url.pathname !== '/' + database || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))
        throw new Error('CrashProbeDatabaseDenied');
      const {NestFactory} = require('@nestjs/core');
      const {NotificationOutboxWorkerModule} = require(path.join(root,'modules/notifications/notification-outbox-worker.module.js'));
      const {ActivityBatchWorker} = require(path.join(root,'modules/activities/activity-batch.worker.js'));
      const {SettlementDraftService} = require(path.join(root,'modules/activities/settlement-draft.service.js'));
      const {PrismaService} = require(path.join(root,'database/prisma.service.js'));
      (async () => {
        const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule,{logger:false,abortOnError:false});
        try {
          const db = app.get(PrismaService);
          const rows = await db.$queryRawUnsafe('SELECT current_database() AS name');
          if (rows[0].name !== database) throw new Error('CrashProbeDatabaseDenied');
          if (mode === 'crash') {
            const drafts = app.get(SettlementDraftService);
            const original = drafts.generateInTransaction.bind(drafts);
            drafts.generateInTransaction = async (...args) => {
              const result = await original(...args);
              const written = await args[0].attendanceSettlementVersion.count({where:{id:result.settlementVersionId}});
              if (written !== 1) throw new Error('CrashProbeNoWrite');
              await new Promise(() => process.stdout.write('FAULT_AFTER_WRITES\\n', () => process.kill(process.pid,'SIGKILL')));
              return result;
            };
          }
          const result = await app.get(ActivityBatchWorker).drainOnce();
          console.log(JSON.stringify(result));
        } finally { await app.close(); }
      })().catch(() => { console.error('CrashProbeFailed'); process.exitCode=1; });
    `;
    const execute = (mode: string) =>
      promisify(execFile)(process.execPath, ['-e', script, root, database, mode], {
        cwd: resolve(__dirname, '../..'),
        env: process.env,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    const crash = await execute('crash').then(
      () => null,
      (error: unknown) => error,
    );
    expect(crash).toMatchObject({ signal: 'SIGKILL', stdout: 'FAULT_AFTER_WRITES\n' });
    const abandoned = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(abandoned).toMatchObject({
      statusCode: 'processing',
      attempts: 1,
      settlementVersionId: null,
    });
    expect(abandoned.items[0]).toMatchObject({ statusCode: 'pending', resultReference: null });
    expect(await versionCount(p.activityId)).toBe(0);
    expect(await draftAuditCount(p.activityId)).toBe(0);
    // Advance only this isolated fixture's lease; do not wait five minutes or alter the worker budget.
    await f.db.activityBatchJob.update({
      where: { id: p.job.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const recovered = JSON.parse((await execute('recover')).stdout.trim()) as Record<
      string,
      unknown
    >;
    expect(recovered).toMatchObject({ jobId: p.job.id, itemsProcessed: 1, itemsFailed: 0 });
    const completed = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: p.job.id } });
    expect(completed).toMatchObject({
      statusCode: 'succeeded',
      attempts: 2,
      leaseGeneration: abandoned.leaseGeneration + 1,
      succeeded: 1,
      failed: 0,
    });
    expect(completed.settlementVersionId).not.toBeNull();
    expect(await versionCount(p.activityId)).toBe(1);
    expect(await draftAuditCount(p.activityId)).toBe(1);
  }, 180000);

  it('two independently constructed workers compete for one durable task and commit one result', async () => {
    const p = await enqueue();
    const context = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      await assertConnectedTestDatabase(context.get(PrismaService));
      const second = context
        .select(ActivityBatchWorkerModule)
        .get(ActivityBatchWorker, { strict: true });
      const outcomes = await Promise.all([
        f.app.get(ActivityBatchWorker).drainOnce(),
        second.drainOnce(),
      ]);
      expect(outcomes.filter((outcome) => outcome.jobId === p.job.id)).toHaveLength(1);
      expect(outcomes.reduce((sum, outcome) => sum + outcome.itemsProcessed, 0)).toBe(1);
      expect(await versionCount(p.activityId)).toBe(1);
      expect(await draftAuditCount(p.activityId)).toBe(1);
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({ statusCode: 'succeeded', attempts: 1, succeeded: 1, failed: 0 });
      expect(job.items[0]).toMatchObject({
        statusCode: 'succeeded',
        resultReference: job.settlementVersionId,
      });
    } finally {
      await context.close();
    }
  }, 120000);

  it('failure after real draft writes rolls back its version and audit; a later worker retries once', async () => {
    const p = await enqueue();
    const core = f.app.get(SettlementDraftService);
    const original = core.generateInTransaction.bind(core);
    const injected = jest
      .spyOn(core, 'generateInTransaction')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('test-only failure after draft writes');
      });
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 0,
    });
    injected.mockRestore();
    expect(await versionCount(p.activityId)).toBe(0);
    expect(await draftAuditCount(p.activityId)).toBe(0);
    const pending = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(pending).toMatchObject({
      statusCode: 'pending',
      succeeded: 0,
      failed: 0,
      settlementVersionId: null,
      lastErrorCode: 'DraftJobTemporaryFailure',
    });
    expect(pending.items[0]).toMatchObject({ statusCode: 'pending', resultReference: null });
    expect(pending.items[0].safeMessage).not.toContain('test-only');
    await f.db.activityBatchJob.update({
      where: { id: p.job.id },
      data: { availableAt: new Date(0) },
    });
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    expect(await versionCount(p.activityId)).toBe(1);
    expect(await draftAuditCount(p.activityId)).toBe(1);
  }, 120000);

  it('different operation keys reuse identical content but retain each operation audit without replay duplicates', async () => {
    const p = await enqueue();
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    const first = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: p.job.id } });
    expect(await draftAuditCount(p.activityId)).toBe(1);
    const operationKey = f.key('different-generate');
    const response = await request(httpServer(f.app))
      .post(`${D13_APP}/${p.activityId}/settlement/generate`)
      .set('Authorization', f.creator.auth)
      .send({ operationKey });
    expect({ status: response.status, code: response.body.code }).toEqual({ status: 200, code: 0 });
    expect(response.body.data).toMatchObject({ outcome: 'job', replayed: false });
    const second = await f.db.activityBatchJob.findUniqueOrThrow({ where: { operationKey } });
    expect(second.id).not.toBe(first.id);
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: second.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    const completed = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: second.id },
      include: { items: true },
    });
    expect(completed).toMatchObject({
      statusCode: 'succeeded',
      settlementVersionId: first.settlementVersionId,
      succeeded: 1,
      failed: 0,
    });
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({
      statusCode: 'succeeded',
      resultReference: first.settlementVersionId,
    });
    expect(await versionCount(p.activityId)).toBe(1);
    // Maintainer-confirmed G6: independent commands retain separate operation audits.
    expect(await draftAuditCount(p.activityId)).toBe(2);
    for (const receipt of [first, completed]) {
      const replay = await request(httpServer(f.app))
        .post(`${D13_APP}/${p.activityId}/settlement/generate`)
        .set('Authorization', f.creator.auth)
        .send({ operationKey: receipt.operationKey });
      expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 200, code: 0 });
      expect(replay.body.data).toMatchObject({ jobId: receipt.id, replayed: true });
    }
    expect((await f.app.get(ActivityBatchWorker).drainOnce()).jobClaimed).toBe(false);
    expect(await versionCount(p.activityId)).toBe(1);
    expect(await draftAuditCount(p.activityId)).toBe(2);
  }, 120000);

  it('losing the handler response after commit preserves one result across a fresh worker context', async () => {
    const p = await enqueue();
    const handler = f.app.get(SettlementDraftBatchService);
    const original = handler.process.bind(handler);
    const injected = jest.spyOn(handler, 'process').mockImplementationOnce(async (...args) => {
      expect(await original(...args)).toEqual({ succeeded: true });
      // The real transaction has returned: fail only delivery of its success to the caller.
      throw new Error('test-only response lost after committed draft');
    });
    await expect(f.app.get(ActivityBatchWorker).drainOnce()).rejects.toThrow(
      'test-only response lost after committed draft',
    );
    injected.mockRestore();
    const committed = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(committed).toMatchObject({ statusCode: 'succeeded', succeeded: 1, failed: 0 });
    expect(committed.settlementVersionId).not.toBeNull();
    expect(committed.items).toHaveLength(1);
    expect(committed.items[0]).toMatchObject({
      statusCode: 'succeeded',
      resultReference: committed.settlementVersionId,
      attempts: 1,
    });
    const context = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      await assertConnectedTestDatabase(context.get(PrismaService));
      const worker = context.select(ActivityBatchWorkerModule).get(ActivityBatchWorker, {
        strict: true,
      });
      expect((await worker.drainOnce()).jobClaimed).toBe(false);
      const replay = await request(httpServer(f.app))
        .post(`${D13_APP}/${p.activityId}/settlement/generate`)
        .set('Authorization', f.creator.auth)
        .send({ operationKey: p.operationKey });
      expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 200, code: 0 });
      expect(replay.body.data).toMatchObject({ jobId: p.job.id, replayed: true });
      expect(
        await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: p.job.id },
          include: { items: true },
        }),
      ).toEqual(committed);
      expect(await versionCount(p.activityId)).toBe(1);
      expect(await draftAuditCount(p.activityId)).toBe(1);
    } finally {
      await context.close();
    }
  }, 120000);

  it('a user disabled while the real worker waits for the Activity lock cannot generate', async () => {
    const p = await enqueue();
    let release!: () => void, held!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      held = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = f.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${p.activityId} FOR UPDATE`;
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        held(row.pid);
        await hold;
      },
      { timeout: 15000 },
    );
    const pid = await ready;
    const attempt = f.app
      .get(ActivityBatchWorker)
      .drainOnce()
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    try {
      await waitFor(
        async () =>
          (
            await f.db.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
          )[0].blocked,
        { timeoutMs: 5000, message: 'draft worker did not reach the Activity lock' },
      );
      await f.db.user.update({ where: { id: f.creator.id }, data: { status: 'DISABLED' } });
      release();
      await blocker;
      const result = await attempt;
      expect(result.error).toBeNull();
      expect(result.value).toMatchObject({ jobId: p.job.id, itemsProcessed: 0, itemsFailed: 1 });
      expect(await versionCount(p.activityId)).toBe(0);
      expect(await draftAuditCount(p.activityId)).toBe(0);
      expect(
        await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: p.job.id } }),
      ).toMatchObject({ statusCode: 'failed', failed: 1, succeeded: 0 });
    } finally {
      release();
      await blocker;
      await attempt;
    }
  }, 120000);

  it('501 identities complete through the worker; same-key replay retains one version and receipt', async () => {
    const p = await enqueue();
    expect(await versionCount(p.activityId)).toBe(0);
    const result = await f.app.get(ActivityBatchWorker).drainOnce();
    expect(result).toMatchObject({ jobId: p.job.id, itemsProcessed: 1, itemsFailed: 0 });
    const job = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(job).toMatchObject({
      statusCode: 'succeeded',
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(job.items).toHaveLength(1);
    expect(job.items[0]).toMatchObject({
      statusCode: 'succeeded',
      resultReference: job.settlementVersionId,
    });
    if (!job.settlementVersionId) throw new Error('version required');
    const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: job.settlementVersionId },
    });
    expect(version.sessionParticipationCount).toBe(501);
    // No evidence means pending, never silently absent; D4 full-evidence fixture is a separate probe.
    expect(
      await f.db.participantSettlementResultRevision.count({
        where: { settlementVersionId: version.id },
      }),
    ).toBe(0);
    const replay = await request(httpServer(f.app))
      .post(`${D13_APP}/${p.activityId}/settlement/generate`)
      .set('Authorization', f.creator.auth)
      .send({ operationKey: p.operationKey });
    expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 200, code: 0 });
    expect(replay.body.data).toMatchObject({ jobId: job.id, replayed: true });
    expect(await versionCount(p.activityId)).toBe(1);
    expect((await f.app.get(ActivityBatchWorker).drainOnce()).jobClaimed).toBe(false);
  }, 120000);

  it.each([
    'user-disabled',
    'member-disabled',
    'binding-changed',
    'seal-changed',
    'legacy-v1',
  ] as const)(
    '%s after enqueue rejects without a partial draft',
    async (change) => {
      const p = await enqueue();
      if (change === 'user-disabled')
        await f.db.user.update({ where: { id: f.creator.id }, data: { status: 'DISABLED' } });
      if (change === 'member-disabled')
        await f.db.member.update({
          where: { id: f.creator.memberId },
          data: { status: 'INACTIVE' },
        });
      if (change === 'binding-changed')
        await f.db.user.update({ where: { id: f.creator.id }, data: { memberId: null } });
      if (change === 'legacy-v1')
        await f.db.activityBatchJob.update({
          where: { id: p.job.id },
          data: { payloadVersion: 1 },
        });
      if (change === 'seal-changed') {
        if (!p.job.payload || typeof p.job.payload !== 'object' || Array.isArray(p.job.payload))
          throw new Error('object payload required');
        const payload: Prisma.InputJsonObject = { ...p.job.payload, evidenceRevision: 999 };
        await f.db.activityBatchJob.update({ where: { id: p.job.id }, data: { payload } });
      }
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: 0,
        itemsFailed: 1,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({ statusCode: 'failed', failed: 1, succeeded: 0 });
      expect(job.items[0].statusCode).toBe('failed');
      expect(await versionCount(p.activityId)).toBe(0);
      expect(job.lastErrorCode).toMatch(/^(30100|200\d+|DraftJobProofMissing)$/);
    },
    120000,
  );

  it('a replaced lease cannot write either business state or a failure receipt', async () => {
    const p = await enqueue();
    await f.db.activityBatchJob.update({
      where: { id: p.job.id },
      data: {
        statusCode: 'processing',
        leaseOwner: 'new-worker',
        leaseGeneration: 2,
        leaseExpiresAt: new Date(Date.now() + 300000),
        attempts: 2,
      },
    });
    const before = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    await expect(
      f.app.get(SettlementDraftBatchService).process({
        jobId: p.job.id,
        activityId: p.activityId,
        leaseOwner: 'old-worker',
        leaseGeneration: 1,
        maxAttempts: 5,
        retryBackoffMs: 30000,
      }),
    ).rejects.toBeInstanceOf(SettlementDraftLeaseLostError);
    expect(
      await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(await versionCount(p.activityId)).toBe(0);
  }, 120000);

  it.each([40000, 40001])(
    'the independent event read ceiling handles %i historical events without partial writes',
    async (eventCount) => {
      const p = await enqueue();
      const identity = await f.db.activityParticipationIdentity.findFirstOrThrow({
        where: { activityId: p.activityId, populationIncluded: true },
        select: { id: true, memberId: true },
      });
      // Deliberate reconstruction fixture, not a new seal acceptance test: unmatched historical
      // closes project to pending, with zero segments, so no other capacity guard can mask this one.
      for (let offset = 0; offset < eventCount; offset += 500) {
        await f.db.attendancePunchEvent.createMany({
          data: Array.from({ length: Math.min(500, eventCount - offset) }, (_, index) => ({
            activityId: p.activityId,
            sessionId: p.sessionId,
            participationIdentityId: identity.id,
            memberId: identity.memberId,
            eventTypeCode: 'check_out',
            sourceCode: 'staff_scan',
            occurredAt: new Date('2020-03-01T09:00:00.000Z'),
            receivedAt: new Date('2020-03-01T09:00:00.000Z'),
            operatorUserId: f.creator.id,
            eventKey: `${p.operationKey}-event-${offset + index}`,
            requestHash: `${p.operationKey}-hash-${offset + index}`,
            evidenceRevision: 0,
          })),
        });
      }
      expect(await f.db.attendancePunchEvent.count({ where: { activityId: p.activityId } })).toBe(
        eventCount,
      );
      expect(
        await f.db.activityParticipationIdentity.count({
          where: { activityId: p.activityId, populationIncluded: true },
        }),
      ).toBe(501);
      const allowed = eventCount === 40000;
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: allowed ? 1 : 0,
        itemsFailed: allowed ? 0 : 1,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({
        statusCode: allowed ? 'succeeded' : 'failed',
        succeeded: allowed ? 1 : 0,
        failed: allowed ? 0 : 1,
      });
      expect(await versionCount(p.activityId)).toBe(allowed ? 1 : 0);
      expect(await draftAuditCount(p.activityId)).toBe(allowed ? 1 : 0);
      expect(
        await f.db.participantServiceSegmentRevision.count({
          where: { identity: { activityId: p.activityId } },
        }),
      ).toBe(0);
      if (!allowed) {
        expect(job.lastErrorCode).toBe(String(BizCode.SETTLEMENT_DRAFT_POPULATION_TOO_LARGE.code));
        expect(job.settlementVersionId).toBeNull();
        expect(job.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
      }
    },
    120000,
  );

  it.each([10000, 10001])(
    'the independent projected-segment ceiling handles %i closed pairs atomically',
    async (segmentCount) => {
      const p = await enqueue();
      const people = await f.db.activityParticipationIdentity.findMany({
        where: { activityId: p.activityId, populationIncluded: true },
        select: { id: true, memberId: true },
        orderBy: { id: 'asc' },
      });
      expect(people).toHaveLength(501);
      const start = new Date('2020-03-01T08:00:00.000Z');
      const end = new Date(start.getTime() + 24 * 3600_000);
      // Isolated reconstruction input. Each identity has disjoint, genuinely closed spans;
      // the bounded event count is below 40000 and cannot mask the segment ceiling.
      await f.db.activity.update({ where: { id: p.activityId }, data: { endAt: end } });
      await f.db.activitySession.update({ where: { id: p.sessionId }, data: { endAt: end } });
      for (let offset = 0; offset < segmentCount; offset += 250) {
        const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
        for (let i = offset; i < Math.min(segmentCount, offset + 250); i += 1) {
          const person = people[i % people.length];
          const spanStart = start.getTime() + Math.floor(i / people.length) * 3600_000;
          for (const [closing, eventTypeCode] of ['check_in', 'check_out'].entries()) {
            const at = new Date(spanStart + closing * 31 * 60_000);
            events.push({
              activityId: p.activityId,
              sessionId: p.sessionId,
              participationIdentityId: person.id,
              memberId: person.memberId,
              eventTypeCode,
              sourceCode: 'staff_scan',
              occurredAt: at,
              receivedAt: at,
              operatorUserId: f.creator.id,
              eventKey: `${p.operationKey}-${i}-${closing}`,
              requestHash: `${p.operationKey}-hash-${i}-${closing}`,
              evidenceRevision: 0,
            });
          }
        }
        await f.db.attendancePunchEvent.createMany({ data: events });
      }
      expect(await f.db.attendancePunchEvent.count({ where: { activityId: p.activityId } })).toBe(
        segmentCount * 2,
      );
      const allowed = segmentCount === 10000;
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: allowed ? 1 : 0,
        itemsFailed: allowed ? 0 : 1,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({
        statusCode: allowed ? 'succeeded' : 'failed',
        succeeded: allowed ? 1 : 0,
        failed: allowed ? 0 : 1,
      });
      expect(await versionCount(p.activityId)).toBe(allowed ? 1 : 0);
      expect(await draftAuditCount(p.activityId)).toBe(allowed ? 1 : 0);
      expect(
        await f.db.participantServiceSegmentRevision.count({
          where: { identity: { activityId: p.activityId } },
        }),
      ).toBe(allowed ? segmentCount : 0);
      if (!allowed) {
        expect(job.lastErrorCode).toBe(String(BizCode.SETTLEMENT_DRAFT_POPULATION_TOO_LARGE.code));
        expect(job.settlementVersionId).toBeNull();
        expect(job.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
      }
    },
    120000,
  );

  it.each([
    { population: 500, closedSegments: 0, orphanCheckouts: 0 },
    { population: 501, closedSegments: 0, orphanCheckouts: 0 },
    { population: 2000, closedSegments: 0, orphanCheckouts: 0 },
    { population: 2000, closedSegments: 10000, orphanCheckouts: 0 },
    { population: 2000, closedSegments: 10000, orphanCheckouts: 20000 },
  ])(
    'isolated compiled worker resource tier %j includes all database work',
    async ({ population, closedSegments, orphanCheckouts }) => {
      const p =
        population === 500
          ? {
              ...(await preparePopulation(population)),
              operationKey: f.key('sync-resource'),
              job: null,
            }
          : await enqueue(population);
      if (closedSegments) {
        const people = await f.db.activityParticipationIdentity.findMany({
          where: { activityId: p.activityId, populationIncluded: true },
          select: { id: true, memberId: true },
          orderBy: { id: 'asc' },
        });
        expect(people).toHaveLength(population);
        const start = new Date('2020-03-01T08:00:00.000Z');
        const end = new Date(start.getTime() + 6 * 3600_000);
        await f.db.activity.update({ where: { id: p.activityId }, data: { endAt: end } });
        await f.db.activitySession.update({ where: { id: p.sessionId }, data: { endAt: end } });
        for (let offset = 0; offset < closedSegments; offset += 250) {
          const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
          for (let i = offset; i < Math.min(closedSegments, offset + 250); i++) {
            const person = people[i % people.length];
            for (const [closing, eventTypeCode] of ['check_in', 'check_out'].entries()) {
              const at = new Date(
                start.getTime() + Math.floor(i / people.length) * 3600_000 + closing * 31 * 60_000,
              );
              events.push({
                activityId: p.activityId,
                sessionId: p.sessionId,
                participationIdentityId: person.id,
                memberId: person.memberId,
                eventTypeCode,
                sourceCode: 'staff_scan',
                occurredAt: at,
                receivedAt: at,
                operatorUserId: f.creator.id,
                evidenceRevision: 0,
                eventKey: `${p.operationKey}-resource-${i}-${closing}`,
                requestHash: `${p.operationKey}-resource-hash-${i}-${closing}`,
              });
            }
          }
          await f.db.attendancePunchEvent.createMany({ data: events });
        }
        // Reconstruction load, not a new seal acceptance fixture: add unmatched late checkouts
        // after all paired events to exercise the event ceiling without exceeding the segment cap.
        for (let offset = 0; offset < orphanCheckouts; offset += 500) {
          const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
          for (let i = offset; i < Math.min(orphanCheckouts, offset + 500); i++) {
            const person = people[i % people.length];
            const at = new Date(
              start.getTime() + 5 * 3600_000 + Math.floor(i / people.length) * 1000,
            );
            events.push({
              activityId: p.activityId,
              sessionId: p.sessionId,
              participationIdentityId: person.id,
              memberId: person.memberId,
              eventTypeCode: 'check_out',
              sourceCode: 'staff_scan',
              occurredAt: at,
              receivedAt: at,
              operatorUserId: f.creator.id,
              evidenceRevision: 0,
              eventKey: `${p.operationKey}-orphan-${i}`,
              requestHash: `${p.operationKey}-orphan-hash-${i}`,
            });
          }
          await f.db.attendancePunchEvent.createMany({ data: events });
        }
        expect(await f.db.attendancePunchEvent.count({ where: { activityId: p.activityId } })).toBe(
          closedSegments * 2 + orphanCheckouts,
        );
      }
      const script = `
      require('reflect-metadata');
      const path = require('node:path');
      const root = process.argv[1];
      const expectedDatabase = process.argv[2];
      const syncRequest = JSON.parse(process.argv[3]);
      const url = new URL(process.env.DATABASE_URL);
      if (url.pathname !== '/' + expectedDatabase || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))
        throw new Error('ResourceProbeDatabaseDenied');
      const { Test } = require('@nestjs/testing');
      const { PrismaService } = require(path.join(root, 'database/prisma.service.js'));
      const { NotificationOutboxWorkerModule } = require(path.join(root, 'modules/notifications/notification-outbox-worker.module.js'));
      const { ActivityBatchWorker } = require(path.join(root, 'modules/activities/activity-batch.worker.js'));
      const AppModule = syncRequest ? require(path.join(root, 'app.module.js')).AppModule : null;
      const db = new PrismaService({log:[{emit:'event',level:'query'}]});
      let queries = 0;
      db.$on('query', () => queries++);
      (async () => {
        const moduleRef = await Test.createTestingModule({imports:[syncRequest ? AppModule : NotificationOutboxWorkerModule]})
          .overrideProvider(PrismaService).useValue(db).compile();
        const app = syncRequest ? moduleRef.createNestApplication() : moduleRef;
        if (syncRequest) {
          app.useLogger(false);
          const { ConfigService } = require('@nestjs/config');
          const config = app.get(ConfigService).get('app');
          require(path.join(root, 'bootstrap/apply-global-setup.js')).applyGlobalSetup(app, config);
          require(path.join(root, 'bootstrap/apply-swagger.js')).applySwagger(app, config);
        }
        try {
          await app.init();
          if (syncRequest) await app.listen(0, '127.0.0.1');
          const rows = await db.$queryRawUnsafe('SELECT current_database() AS name');
          if (rows[0].name !== expectedDatabase) throw new Error('ResourceProbeDatabaseDenied');
          queries = 0;
          const started = performance.now();
          let result;
          if (syncRequest) {
            const port = app.getHttpServer().address().port;
            const response = await fetch('http://127.0.0.1:' + port + '/api/app/v1/my/managed-activities/' + syncRequest.activityId + '/settlement/generate', {
              method:'POST', headers:{'content-type':'application/json',authorization:process.env.SRVF_RESOURCE_PROBE_AUTH},
              body:JSON.stringify({operationKey:syncRequest.operationKey}),
            });
            const body = await response.json();
            result = {httpStatus:response.status,code:body.code,...body.data};
          } else result = await app.get(ActivityBatchWorker).drainOnce();
          const elapsedMs = performance.now() - started;
          console.log(JSON.stringify({result,queries,elapsedMs,peakRssBytes:process.resourceUsage().maxRSS*1024}));
        } finally { await app.close(); await db.$disconnect(); }
      })().catch(() => { console.error('ResourceProbeFailed'); process.exitCode=1; });
    `;
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      const expectedDatabase = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
      // Separate compiler process: its memory is not charged to the measured worker.
      const probeRoot = await compiledProbeRoot();
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '-e',
          script,
          probeRoot,
          expectedDatabase,
          JSON.stringify(
            population === 500 ? { activityId: p.activityId, operationKey: p.operationKey } : null,
          ),
        ],
        {
          cwd: resolve(__dirname, '../..'),
          env: {
            ...process.env,
            SRVF_RESOURCE_PROBE_AUTH: population === 500 ? f.creator.auth : '',
          },
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      );
      const measured = JSON.parse(stdout.trim()) as {
        result: {
          jobId?: string;
          itemsProcessed?: number;
          itemsFailed?: number;
          httpStatus?: number;
          code?: number;
          outcome?: string;
        };
        queries: number;
        elapsedMs: number;
        peakRssBytes: number;
      };
      if (p.job) {
        expect(measured.result).toMatchObject({
          jobId: p.job.id,
          itemsProcessed: 1,
          itemsFailed: 0,
        });
      } else {
        expect(measured.result).toMatchObject({ httpStatus: 200, code: 0, outcome: 'draft' });
        expect(
          await f.db.activityBatchJob.findUniqueOrThrow({
            where: { operationKey: p.operationKey },
          }),
        ).toMatchObject({
          payloadVersion: 1,
          statusCode: 'succeeded',
        });
      }
      expect(measured.queries).toBeGreaterThan(0);
      expect(measured.elapsedMs).toBeLessThan(30000);
      expect(measured.peakRssBytes).toBeGreaterThan(0);
      expect(measured.peakRssBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
      expect(await versionCount(p.activityId)).toBe(1);
      expect(await draftAuditCount(p.activityId)).toBe(1);
      console.info('Draft worker resource tier', {
        measurementScope: population === 500 ? 'sync-http' : 'worker-drain',
        population,
        closedSegments,
        orphanCheckouts,
        queries: measured.queries,
        elapsedMs: measured.elapsedMs,
        peakRssBytes: measured.peakRssBytes,
      });
      expect(
        await f.db.participantServiceSegmentRevision.count({
          where: { identity: { activityId: p.activityId } },
        }),
      ).toBe(closedSegments);
    },
    180000,
  );

  it('2001 identities fail without truncating a partial version', async () => {
    const p = await enqueue(2001);
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 0,
      itemsFailed: 1,
    });
    const job = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(job).toMatchObject({ statusCode: 'failed', failed: 1, lastErrorCode: '20050' });
    expect(job.items[0]).toMatchObject({ statusCode: 'failed', resultReference: null });
    expect(await versionCount(p.activityId)).toBe(0);
  }, 120000);

  it('an exhausted expired lease leaves a retryable failed item and completes after authorized retry', async () => {
    const p = await enqueue();
    await f.db.activityBatchJob.update({
      where: { id: p.job.id },
      data: {
        statusCode: 'processing',
        attempts: 5,
        leaseOwner: 'dead-worker',
        leaseGeneration: 5,
        leaseExpiresAt: new Date(0),
      },
    });
    expect((await f.app.get(ActivityBatchWorker).drainOnce()).jobClaimed).toBe(false);
    const failed = await f.db.activityBatchJob.findUniqueOrThrow({
      where: { id: p.job.id },
      include: { items: true },
    });
    expect(failed).toMatchObject({ statusCode: 'dead', failed: 1, succeeded: 0 });
    expect(failed.items[0]).toMatchObject({
      statusCode: 'failed',
      lastErrorCode: 'DraftJobAttemptsExhausted',
    });
    const retry = await request(httpServer(f.app))
      .post(`/api/app/v1/my/activity-batch-jobs/${p.job.id}/retry-failed`)
      .set('Authorization', f.creator.auth)
      .send({});
    expect({ status: retry.status, code: retry.body.code }).toEqual({ status: 201, code: 0 });
    expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
      jobId: p.job.id,
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    expect(await versionCount(p.activityId)).toBe(1);
  }, 120000);

  it.each([false, true])(
    'a different authorized retry actor never replaces the original execution identity (restored=%s)',
    async (restored) => {
      const p = await enqueue();
      await f.db.activityResponsibilityAssignment.updateMany({
        where: { activityId: p.activityId, memberId: f.creator.memberId, status: 'active' },
        data: { memberId: f.reviewer.memberId },
      });
      await f.db.user.update({ where: { id: f.creator.id }, data: { status: 'DISABLED' } });
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: 0,
        itemsFailed: 1,
      });
      const failed = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: p.job.id } });
      expect(failed).toMatchObject({ statusCode: 'failed', failed: 1, succeeded: 0 });
      if (restored) {
        await f.db.user.update({ where: { id: f.creator.id }, data: { status: 'ACTIVE' } });
      }
      const retry = await request(httpServer(f.app))
        .post(`/api/app/v1/my/activity-batch-jobs/${p.job.id}/retry-failed`)
        .set('Authorization', f.reviewer.auth)
        .send({});
      expect({ status: retry.status, code: retry.body.code }).toEqual({ status: 201, code: 0 });
      const pending = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: p.job.id } });
      expect(pending).toMatchObject({
        statusCode: 'pending',
        failed: 0,
        succeeded: 0,
        createdByUserId: f.creator.id,
      });
      expect(pending.payload).toEqual(failed.payload);
      await f.db.activityBatchJob.update({
        where: { id: p.job.id },
        data: { availableAt: new Date(0) },
      });
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: restored ? 1 : 0,
        itemsFailed: restored ? 0 : 1,
      });
      expect(await versionCount(p.activityId)).toBe(restored ? 1 : 0);
      expect(await draftAuditCount(p.activityId)).toBe(restored ? 1 : 0);
      const final = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(final).toMatchObject({
        statusCode: restored ? 'succeeded' : 'failed',
        succeeded: restored ? 1 : 0,
        failed: restored ? 0 : 1,
        createdByUserId: f.creator.id,
      });
      expect(final.items).toHaveLength(1);
      expect(final.items[0].statusCode).toBe(restored ? 'succeeded' : 'failed');
      expect(final.payload).toEqual(failed.payload);
    },
    120000,
  );

  it('a missing draft handler leaves no business writes and a healthy worker reclaims the expired lease', async () => {
    const p = await enqueue();
    const broken = await Test.createTestingModule({ imports: [NotificationOutboxWorkerModule] })
      .overrideProvider(SettlementDraftBatchService)
      .useValue(null)
      .compile();
    try {
      await broken.init();
      await assertConnectedTestDatabase(broken.get(PrismaService));
      expect(broken.get(SettlementDraftBatchService)).toBeNull();
      const worker = broken
        .select(ActivityBatchWorkerModule)
        .get(ActivityBatchWorker, { strict: true });
      await expect(worker.drainOnce()).rejects.toThrow('SettlementDraftHandlerUnavailable');
      const abandoned = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(abandoned).toMatchObject({
        statusCode: 'processing',
        succeeded: 0,
        failed: 0,
        settlementVersionId: null,
        attempts: 1,
      });
      expect(abandoned.leaseOwner).not.toBeNull();
      expect(abandoned.items).toHaveLength(1);
      expect(abandoned.items[0]).toMatchObject({ statusCode: 'pending', resultReference: null });
      expect(await versionCount(p.activityId)).toBe(0);
      expect(await draftAuditCount(p.activityId)).toBe(0);
      // Advance only this isolated test fixture's lease; real claim/fence logic is unchanged.
      await f.db.activityBatchJob.update({
        where: { id: p.job.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
        jobId: p.job.id,
        itemsProcessed: 1,
        itemsFailed: 0,
      });
      const completed = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(completed).toMatchObject({
        statusCode: 'succeeded',
        succeeded: 1,
        failed: 0,
        attempts: 2,
        leaseGeneration: abandoned.leaseGeneration + 1,
      });
      expect(completed.settlementVersionId).not.toBeNull();
      expect(completed.items[0]).toMatchObject({
        statusCode: 'succeeded',
        resultReference: completed.settlementVersionId,
      });
      expect(await versionCount(p.activityId)).toBe(1);
      expect(await draftAuditCount(p.activityId)).toBe(1);
    } finally {
      await broken.close();
    }
  }, 120000);

  it('HTTP cancellation before claim prevents any draft and remains visible through the existing detail', async () => {
    const p = await enqueue();
    const cancelled = await request(httpServer(f.app))
      .post(`/api/app/v1/my/activity-batch-jobs/${p.job.id}/cancel`)
      .set('Authorization', f.creator.auth)
      .send({});
    expect({ status: cancelled.status, code: cancelled.body.code }).toEqual({
      status: 201,
      code: 0,
    });
    expect((await f.app.get(ActivityBatchWorker).drainOnce()).jobClaimed).toBe(false);
    expect(await versionCount(p.activityId)).toBe(0);
    const detail = await request(httpServer(f.app))
      .get(`/api/app/v1/my/activity-batch-jobs/${p.job.id}`)
      .set('Authorization', f.creator.auth);
    expect({ status: detail.status, code: detail.body.code }).toEqual({ status: 200, code: 0 });
    expect(detail.body.data.statusCode).toBe('cancelled');
  }, 120000);

  it('cancellation waiting behind real generation cannot overwrite the committed result', async () => {
    const p = await enqueue();
    const core = f.app.get(SettlementDraftService);
    const original = core.generateInTransaction.bind(core);
    let pid: number | null = null;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(core, 'generateInTransaction').mockImplementationOnce(async (...args) => {
      const [row] = await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pid = row.pid;
      await hold;
      return original(...args);
    });
    const worker = f.app.get(ActivityBatchWorker).drainOnce();
    let cancellation: Promise<unknown> | undefined;
    try {
      await waitFor(async () => pid !== null, {
        timeoutMs: 5000,
        message: 'worker did not enter generation under the Activity lock',
      });
      const response = request(httpServer(f.app))
        .post(`/api/app/v1/my/activity-batch-jobs/${p.job.id}/cancel`)
        .set('Authorization', f.creator.auth)
        .send({})
        .then((value) => value);
      cancellation = response;
      await waitFor(
        async () =>
          (
            await f.db.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
          )[0].blocked,
        { timeoutMs: 3000, message: 'cancel did not wait behind generation' },
      );
      release();
      expect(await worker).toMatchObject({ jobId: p.job.id, itemsProcessed: 1, itemsFailed: 0 });
      const cancelled = await response;
      expect({ status: cancelled.status, code: cancelled.body.code }).toEqual({
        status: BizCode.ACTIVITY_STATUS_INVALID.httpStatus,
        code: BizCode.ACTIVITY_STATUS_INVALID.code,
      });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: p.job.id },
        include: { items: true },
      });
      expect(job).toMatchObject({ statusCode: 'succeeded', succeeded: 1, failed: 0 });
      expect(job.settlementVersionId).not.toBeNull();
      expect(job.items).toHaveLength(1);
      expect(job.items[0]).toMatchObject({
        statusCode: 'succeeded',
        resultReference: job.settlementVersionId,
      });
      expect(await versionCount(p.activityId)).toBe(1);
      expect(await draftAuditCount(p.activityId)).toBe(1);
    } finally {
      release();
      await worker.catch(() => undefined);
      await cancellation?.catch(() => undefined);
    }
  }, 120000);

  it.each([
    { enabled: false, readonlyMaintenance: false },
    { enabled: false, readonlyMaintenance: true },
    { enabled: true, readonlyMaintenance: false },
    { enabled: true, readonlyMaintenance: true },
  ])(
    'queued draft honors the real Gate combination %j and stays recoverable',
    async (mode) => {
      const p = await enqueue();
      const config = f.app.get<AppConfig>(appConfig.KEY);
      const original = { ...config.activityV11Workflow };
      const allowed = mode.enabled && !mode.readonlyMaintenance;
      try {
        Object.assign(config.activityV11Workflow, mode);
        expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
          jobId: p.job.id,
          itemsProcessed: allowed ? 1 : 0,
        });
        const job = await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: p.job.id },
          include: { items: true },
        });
        expect(job).toMatchObject({
          statusCode: allowed ? 'succeeded' : 'pending',
          succeeded: allowed ? 1 : 0,
          failed: 0,
        });
        expect(job.items).toHaveLength(1);
        expect(job.items[0].statusCode).toBe(allowed ? 'succeeded' : 'pending');
        expect(await versionCount(p.activityId)).toBe(allowed ? 1 : 0);
        expect(await draftAuditCount(p.activityId)).toBe(allowed ? 1 : 0);
        if (!allowed) {
          expect(job.settlementVersionId).toBeNull();
          expect(job.items[0].resultReference).toBeNull();
          expect(job.lastErrorCode).toBe(
            String(
              mode.readonlyMaintenance
                ? BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.code
                : BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.code,
            ),
          );
          const detail = await request(httpServer(f.app))
            .get(`/api/app/v1/my/activity-batch-jobs/${p.job.id}`)
            .set('Authorization', f.creator.auth);
          expect({ status: detail.status, code: detail.body.code }).toEqual({
            status: 200,
            code: 0,
          });
          expect(detail.body.data.statusCode).toBe('pending');
          Object.assign(config.activityV11Workflow, original);
          await f.db.activityBatchJob.update({
            where: { id: job.id },
            data: { availableAt: new Date(0) },
          });
          expect(await f.app.get(ActivityBatchWorker).drainOnce()).toMatchObject({
            jobId: job.id,
            itemsProcessed: 1,
            itemsFailed: 0,
          });
          expect(await versionCount(p.activityId)).toBe(1);
          expect(await draftAuditCount(p.activityId)).toBe(1);
        }
      } finally {
        Object.assign(config.activityV11Workflow, original);
      }
    },
    120000,
  );

  it.each([NotificationOutboxWorkerModule, StorageConsistencyWorkerModule])(
    '%s constructs the real worker graph and completes its own claimed draft',
    async (rootModule) => {
      const p = await enqueue();
      const context = await NestFactory.createApplicationContext(rootModule, {
        logger: false,
        abortOnError: false,
      });
      try {
        await assertConnectedTestDatabase(context.get(PrismaService));
        const graph = context.select(ActivityBatchWorkerModule);
        expect(graph.get(SettlementDraftBatchService, { strict: true })).toBeInstanceOf(
          SettlementDraftBatchService,
        );
        expect(await graph.get(ActivityBatchWorker, { strict: true }).drainOnce()).toMatchObject({
          jobId: p.job.id,
          itemsProcessed: 1,
          itemsFailed: 0,
        });
        expect(await versionCount(p.activityId)).toBe(1);
      } finally {
        await context.close();
      }
    },
    120000,
  );
});
