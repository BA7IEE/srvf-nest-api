import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { InsuranceRequirementService } from '../../src/modules/insurances/insurance-requirement.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const FUTURE = {
  startAt: new Date('2099-12-01T08:00:00.000Z'),
  endAt: new Date('2099-12-01T12:00:00.000Z'),
  deadline: new Date('2099-11-30T23:59:59.000Z'),
};

describe('activity batch4 registration command concurrency', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let auth: string;
  let adminAuth: string;
  let memberId: string;
  let organizationId: string;
  let sameActivityId: string;
  let raceActivityAId: string;
  let raceActivityBId: string;
  let previousInsuranceGate: string | undefined;

  beforeAll(async () => {
    previousInsuranceGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    const admin = await createTestUser(app, {
      username: 'batch4-command-concurrency-admin',
      role: Role.ADMIN,
    });
    await grantBizAdminToUser(app, admin.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, admin.username)).authHeader;
    const org = await prisma.organization.create({
      data: { name: 'Batch4 Command Concurrency', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    organizationId = org.id;
    const user = await createTestUser(app, { username: 'batch4-command-concurrency' });
    const member = await prisma.member.create({
      data: {
        memberNo: 'B4CMD-CONCURRENCY',
        displayName: 'Command Concurrency',
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    auth = (await loginAs(app, user.username)).authHeader;

    const createActivity = (title: string) =>
      prisma.activity.create({
        data: {
          title,
          activityTypeCode: 'training',
          organizationId: org.id,
          startAt: FUTURE.startAt,
          endAt: FUTURE.endAt,
          registrationDeadline: FUTURE.deadline,
          location: 'Concurrency Field',
          statusCode: 'published',
          isPublicRegistration: true,
          publishedAt: new Date(),
        },
        select: { id: true },
      });
    const [same, raceA, raceB] = await Promise.all([
      createActivity('Same-key same-hash'),
      createActivity('Same-key race A'),
      createActivity('Same-key race B'),
    ]);
    sameActivityId = same.id;
    raceActivityAId = raceA.id;
    raceActivityBId = raceB.id;
  });

  afterAll(async () => {
    await Promise.all([app.close(), appB.close()]);
    if (previousInsuranceGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousInsuranceGate;
  });

  function post(activityId: string, operationKey: string) {
    return request(httpServer(app))
      .post(`/api/app/v1/activities/${activityId}/registrations`)
      .set('Authorization', auth)
      .send({ operationKey, formVersion: null, answers: [], preferences: [] });
  }

  async function waitForBlockedQuery(blockerPid: number, queryPattern: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
        SELECT pid
        FROM pg_stat_activity
        WHERE CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND datname = current_database()
          AND pid <> pg_backend_pid()
          AND query LIKE ${queryPattern}
      `);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`未观察到 PostgreSQL blocked query: ${queryPattern}`);
  }

  async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timeout`)), 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('serializes same activity/key/hash retries to the original immutable receipt', async () => {
    const operationKey = 'batch4-command-concurrent-same-0001';
    const [left, right] = await Promise.all([
      post(sameActivityId, operationKey),
      post(sameActivityId, operationKey),
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(left.body.data).toEqual(right.body.data);
    expect(
      await prisma.activityRegistrationRevision.count({
        where: { requestKey: operationKey, registration: { activityId: sameActivityId, memberId } },
      }),
    ).toBe(1);
  });

  it('maps cross-activity P2002 winner/loser to receipt-or-21003 without a Prisma leak', async () => {
    const operationKey = 'batch4-command-concurrent-conflict-0001';
    const [left, right] = await Promise.all([
      post(raceActivityAId, operationKey),
      post(raceActivityBId, operationKey),
    ]);
    const responses = [left, right];
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(conflict.body).toMatchObject({
      code: BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT.code,
      data: null,
    });
    expect(JSON.stringify(conflict.body)).not.toMatch(/prisma|p2002|unique constraint/i);
    expect(
      await prisma.activityRegistrationRevision.count({ where: { requestKey: operationKey } }),
    ).toBe(1);
  });

  it('uses two Nest pools to prove canonical Member/User shared locks cannot deadlock a team coverage write', async () => {
    const policy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: 'Canonical Lock Order Insurance',
        policyNumber: 'B4-COMMAND-LOCK-ORDER-0001',
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2100-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    await prisma.teamInsuranceCoverage.create({
      data: { policyId: policy.id, memberId },
    });
    const activity = await prisma.activity.create({
      data: {
        title: 'Canonical Member Shared Lock Order',
        activityTypeCode: 'training',
        organizationId,
        startAt: FUTURE.startAt,
        endAt: FUTURE.endAt,
        registrationDeadline: FUTURE.deadline,
        location: 'Concurrency Field',
        statusCode: 'published',
        isPublicRegistration: true,
        publishedAt: new Date(),
        requiresInsurance: true,
      },
      select: { id: true },
    });
    const requirement = app.get(InsuranceRequirementService);
    const originalRequire = requirement.requireForActivityRegistration.bind(requirement);
    const auditLogsB = appB.get(AuditLogsService);
    const originalLog = auditLogsB.log.bind(auditLogsB);
    let releaseRegistration = (): void => undefined;
    let releaseCoverageWriter = (): void => undefined;
    let registrationReached!: (pid: number) => void;
    let coverageWriterReached!: (pid: number) => void;
    const releaseRegistrationPromise = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const releaseCoverageWriterPromise = new Promise<void>((resolve) => {
      releaseCoverageWriter = resolve;
    });
    const registrationReachedPromise = new Promise<number>((resolve) => {
      registrationReached = resolve;
    });
    const coverageWriterReachedPromise = new Promise<number>((resolve) => {
      coverageWriterReached = resolve;
    });
    const registrationBarrier = jest
      .spyOn(requirement, 'requireForActivityRegistration')
      .mockImplementation(async (...args) => {
        const rows = await args[2].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        registrationReached(rows[0].pid);
        await releaseRegistrationPromise;
        return originalRequire(...args);
      });
    const coverageWriterBarrier = jest
      .spyOn(auditLogsB, 'log')
      .mockImplementation(async (...args) => {
        const input = args[0];
        if (
          input.event === 'team-insurance-coverage.remove' &&
          input.resourceId === policy.id &&
          input.tx
        ) {
          const rows = await input.tx.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`SELECT pg_backend_pid() AS pid`,
          );
          coverageWriterReached(rows[0].pid);
          await releaseCoverageWriterPromise;
        }
        return originalLog(...args);
      });
    const requests: Array<Promise<request.Response>> = [];

    try {
      const registration = post(activity.id, 'batch4-command-lock-order-0001').then((res) => res);
      requests.push(registration);
      const registrationPid = await withTimeout(
        registrationReachedPromise,
        'canonical registration Member/User shared-lock barrier',
      );

      const removal = request(httpServer(appB))
        .delete(`/api/admin/v1/team-insurance-policies/${policy.id}/members/${memberId}`)
        .set('Authorization', adminAuth)
        .then((res) => res);
      requests.push(removal);
      const coverageWriterPid = await withTimeout(
        coverageWriterReachedPromise,
        'team coverage writer Policy/Coverage/Member barrier',
      );
      expect(app.getHttpServer()).not.toBe(appB.getHttpServer());
      expect(prisma).not.toBe(prismaB);
      expect(registrationPid).not.toBe(coverageWriterPid);

      // The canonical transaction has held Member/User FOR SHARE since before its source call.
      // The production coverage writer nevertheless reached its audit barrier after
      // Policy FOR UPDATE -> Coverage FOR UPDATE -> Member FOR SHARE.  Once the registration
      // continues, it blocks only on the writer's Policy lock; no Member edge points back.
      releaseRegistration();
      await waitForBlockedQuery(coverageWriterPid, '%FROM "team_insurance_policies"%FOR SHARE%');
      releaseCoverageWriter();

      const [registrationRes, removalRes] = await Promise.all([registration, removal]);
      expect(removalRes.status).toBe(200);
      expectBizError(registrationRes, BizCode.INSURANCE_REQUIRED);
      expect(JSON.stringify([registrationRes.body, removalRes.body])).not.toMatch(/40P01|P2028/i);
    } finally {
      releaseRegistration();
      releaseCoverageWriter();
      await Promise.allSettled(requests);
      registrationBarrier.mockRestore();
      coverageWriterBarrier.mockRestore();
    }

    expect(
      await prisma.activityRegistration.count({ where: { activityId: activity.id, memberId } }),
    ).toBe(0);
  });
});
