import type { INestApplication } from '@nestjs/common';
import { MemberStatus } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
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
  let prisma: PrismaService;
  let auth: string;
  let memberId: string;
  let sameActivityId: string;
  let raceActivityAId: string;
  let raceActivityBId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const org = await prisma.organization.create({
      data: { name: 'Batch4 Command Concurrency', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
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
    await app.close();
  });

  function post(activityId: string, operationKey: string) {
    return request(httpServer(app))
      .post(`/api/app/v1/activities/${activityId}/registrations`)
      .set('Authorization', auth)
      .send({ operationKey, formVersion: null, answers: [], preferences: [] });
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
});
