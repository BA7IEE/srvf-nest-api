import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Slow-4 T3(2026-06-11):activity-registrations 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收
// v0.61.0 PR-11 contract:biz-admin 仅保留 read，create/approve/reject/cancel/reopen 翻 30100。
// list / export 共用 activity-registration.read.record(D4=A 判例)。
// 业务行为细节(状态机 / capacity / partial unique)由 activity-registrations.e2e-spec.ts 锁定。

describe('activity-registrations RBAC 权限边界(Slow-4 T3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;

  let activityId: string;
  let memberSeq = 0;

  // 每次造一个新 member + pending 报名(approve / reject / cancel 的独立目标)
  const createPendingRegistration = async (): Promise<string> => {
    memberSeq += 1;
    const m = await prisma.member.create({
      data: { memberNo: `rrb-m-${memberSeq}`, displayName: `M${memberSeq}` },
      select: { id: true },
    });
    const r = await prisma.activityRegistration.create({
      data: { activityId, memberId: m.id, statusCode: 'pending' },
      select: { id: true },
    });
    return r.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'rrb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'rrb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'rrb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'rrb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'rrb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'rrb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'rrb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'rrb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });

    // org + 活动(published + 公开报名;FK 经 prisma 直造,绕开字典依赖)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: nodeDict.id, code: 'rrb-root', label: '根' } });
    const rootOrg = await prisma.organization.create({
      data: { name: 'RRB Root', nodeTypeCode: 'rrb-root', parentId: null },
      select: { id: true },
    });
    const act = await prisma.activity.create({
      data: {
        title: 'RRB Activity',
        activityTypeCode: 'rrb-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-08-01T08:00:00.000Z'),
        endAt: new Date('2026-08-01T12:00:00.000Z'),
        location: '边界演示',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activityId = act.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = (): string => `/api/admin/v1/activities/${activityId}/registrations`;

  describe('read 族:list / export(activity-registration.read.record 共用)', () => {
    it('list:①② 200 / ③④ 30100', async () => {
      expect((await request(httpServer(app)).get(base()).set('Authorization', saAuth)).status).toBe(
        200,
      );
      expect(
        (await request(httpServer(app)).get(base()).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(base()).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(base()).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
    it('export:①② 200 / ③④ 30100', async () => {
      const url = `${base()}/export`;
      expect((await request(httpServer(app)).get(url).set('Authorization', saAuth)).status).toBe(
        200,
      );
      expect(
        (await request(httpServer(app)).get(url).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(url).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(url).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('POST 代报名(activity-registration.create.record)', () => {
    it('②③④ 30100(合法 body)/ ① 201', async () => {
      const mDeny = await prisma.member.create({
        data: { memberNo: 'rrb-m-deny', displayName: 'Deny' },
        select: { id: true },
      });
      expectBizError(
        await request(httpServer(app))
          .post(base())
          .set('Authorization', admDefaultAuth)
          .send({ memberId: mDeny.id }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(base())
          .set('Authorization', userAuth)
          .send({ memberId: mDeny.id }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(base())
          .set('Authorization', admBizAuth)
          .send({ memberId: mDeny.id }),
        BizCode.RBAC_FORBIDDEN,
      );
      const mSa = await prisma.member.create({
        data: { memberNo: 'rrb-m-sa', displayName: 'SA' },
        select: { id: true },
      });
      expect(
        (
          await request(httpServer(app))
            .post(base())
            .set('Authorization', saAuth)
            .send({ memberId: mSa.id })
        ).status,
      ).toBe(201);
    });
  });

  describe('approve / reject / cancel(独立码;每用例独立 pending 报名)', () => {
    it('approve:②③④ 30100 / ① 200', async () => {
      const target = await createPendingRegistration();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/approve`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/approve`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/approve`)
          .set('Authorization', admBizAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      const target2 = await createPendingRegistration();
      expect(
        (
          await request(httpServer(app))
            .patch(`${base()}/${target2}/approve`)
            .set('Authorization', saAuth)
            .send({})
        ).status,
      ).toBe(200);
    });
    it('reject:②③④ 30100', async () => {
      const target = await createPendingRegistration();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/reject`)
          .set('Authorization', admDefaultAuth)
          .send({ reviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/reject`)
          .set('Authorization', userAuth)
          .send({ reviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/reject`)
          .set('Authorization', admBizAuth)
          .send({ reviewNote: '边界驳回' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
    it('cancel:②③④ 30100', async () => {
      const target = await createPendingRegistration();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/cancel`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/cancel`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/cancel`)
          .set('Authorization', admBizAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });
});
