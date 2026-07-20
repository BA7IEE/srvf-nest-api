import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const BASE = '/api/admin/v1/notifications';

describe('notification publishGeneration · two-app PostgreSQL fence', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let auth: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    prisma = appA.get(PrismaService);
    await resetDb(appA);
    const dict = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dict.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
        { typeId: dict.id, code: 'emergency', label: '紧急召集', status: 'ACTIVE' },
      ],
    });
    await createTestUser(appA, {
      username: 'notification_generation_sa',
      role: Role.SUPER_ADMIN,
    });
    auth = (await loginAs(appA, 'notification_generation_sa')).authHeader;
  });

  afterAll(async () => {
    await appB.close();
    await appA.close();
  });

  async function createDraft(channels: string[] = ['in-app', 'wechat']): Promise<string> {
    const response = await request(httpServer(appA)).post(BASE).set('Authorization', auth).send({
      title: 'generation title',
      body: 'generation body',
      notificationTypeCode: 'general',
      visibilityCode: 'member',
      channels,
    });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  it('同一 draft 并发 publish 只成功一次，generation 0→1 且仅一条 v2 root', async () => {
    const id = await createDraft();
    const [left, right] = await Promise.all([
      request(httpServer(appA)).post(`${BASE}/${id}/publish`).set('Authorization', auth).send({}),
      request(httpServer(appB)).post(`${BASE}/${id}/publish`).set('Authorization', auth).send({}),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    expect([left.body.code, right.body.code].sort((a, b) => a - b)).toEqual([0, 31030]);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      statusCode: 'published',
      publishGeneration: 1,
    });
    const roots = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateId: id, eventType: 'notification.wechat-broadcast' },
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      eventKey: `wechat-broadcast:${id}:1`,
      payloadVersion: 2,
      payload: { notificationId: id, publishGeneration: 1 },
    });
  });

  it('published Effect PATCH 自动回 draft；republish +1；pinned/集合等价保持 published', async () => {
    const id = await createDraft(['wechat', 'in-app', 'wechat']);
    await request(httpServer(appA))
      .post(`${BASE}/${id}/publish`)
      .set('Authorization', auth)
      .send({});
    const changed = await request(httpServer(appA))
      .patch(`${BASE}/${id}`)
      .set('Authorization', auth)
      .send({ title: 'generation title v2' });
    expect(changed.body.data).toMatchObject({ statusCode: 'draft' });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      publishGeneration: 1,
    });

    await request(httpServer(appA))
      .post(`${BASE}/${id}/publish`)
      .set('Authorization', auth)
      .send({});
    const semanticNoop = await request(httpServer(appA))
      .patch(`${BASE}/${id}`)
      .set('Authorization', auth)
      .send({ pinned: true, channels: ['wechat', 'in-app', 'wechat'] });
    expect(semanticNoop.body.data).toMatchObject({ statusCode: 'published', pinned: true });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      publishGeneration: 2,
    });
  });

  it('system-directed 仍可 list/detail，但 mutation=31030、sendSms=31013 且零 outbox', async () => {
    const created = await prisma.notification.create({
      data: {
        title: 'system directed',
        body: 'immutable from admin surface',
        notificationTypeCode: 'general',
        statusCode: 'published',
        visibilityCode: 'member',
        audienceType: 'directed',
        sourceType: 'system',
        channels: ['in-app', 'sms'],
        publishedAt: new Date(),
      },
    });
    expect(
      (await request(httpServer(appA)).get(`${BASE}/${created.id}`).set('Authorization', auth))
        .status,
    ).toBe(200);
    expectBizError(
      await request(httpServer(appA))
        .patch(`${BASE}/${created.id}`)
        .set('Authorization', auth)
        .send({ pinned: true }),
      BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
    );
    expectBizError(
      await request(httpServer(appA)).delete(`${BASE}/${created.id}`).set('Authorization', auth),
      BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
    );
    expectBizError(
      await request(httpServer(appA))
        .post(`${BASE}/${created.id}/send-sms`)
        .set('Authorization', auth)
        .send({ confirmed: false }),
      BizCode.NOTIFICATION_SMS_NOT_SENDABLE,
    );
    expect(
      await prisma.notificationOutboxIntent.count({ where: { aggregateId: created.id } }),
    ).toBe(0);
  });
});
