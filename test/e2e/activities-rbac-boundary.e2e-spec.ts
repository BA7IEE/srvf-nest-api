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

// Slow-4 T3(2026-06-11):activities 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收:
// - 列表 + 详情**无码化**(仅登录,[auth]):四种身份(SA / ADMIN±biz-admin / USER)全部可读
//   (原 @Roles 含 USER = 全角色放行,等价仅登录;DoD-4 ④ "activities 2 端点仍可读");
// - 5 个写端点:① SA 短路 / ② ADMIN+biz-admin 照常 / ③ ADMIN 无 biz-admin 30100 / ④ USER 30100。
// 业务行为细节(状态机 / Q-A7 过滤)由 activities.e2e-spec.ts 锁定,本 spec 只锁判权矩阵。

describe('activities RBAC 权限边界(Slow-4 T3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;

  let childOrgId: string;
  let activityTypeCode: string;
  let publishedActivityId: string;

  const createDraft = async (title: string): Promise<string> => {
    const res = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', saAuth)
      .send({
        title,
        activityTypeCode,
        organizationId: childOrgId,
        startAt: '2026-08-01T08:00:00.000Z',
        endAt: '2026-08-01T12:00:00.000Z',
        location: '边界演示',
      });
    return res.body.data.id as string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'arb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'arb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'arb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'arb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'arb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'arb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'arb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'arb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    // org + activity_type 字典(create 校验依赖)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: nodeDict.id, code: 'arb-root', label: '根' } });
    await prisma.dictItem.create({ data: { typeId: nodeDict.id, code: 'arb-child', label: '子' } });
    const rootOrg = await prisma.organization.create({
      data: { name: 'ARB Root', nodeTypeCode: 'arb-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'ARB Child', nodeTypeCode: 'arb-child', parentId: rootOrg.id },
      select: { id: true },
    });
    childOrgId = childOrg.id;
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const t = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'arb-type', label: '边界类型' },
      select: { code: true },
    });
    activityTypeCode = t.code;

    // 一个 published 活动(读路径四身份可见)
    publishedActivityId = await createDraft('ARB-PUB');
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${publishedActivityId}/publish`)
      .set('Authorization', saAuth);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET list / GET detail(无码化,仅登录;DoD-4 ④)', () => {
    it('list:SA / ADMIN+biz-admin / ADMIN 无 biz-admin / USER 全部 200', async () => {
      for (const auth of [saAuth, admBizAuth, admDefaultAuth, userAuth]) {
        const res = await request(httpServer(app))
          .get('/api/admin/v1/activities')
          .set('Authorization', auth);
        expect(res.status).toBe(200);
      }
    });
    it('detail(published):四种身份全部 200(Q-A7 过滤在 service 内,行为不变)', async () => {
      for (const auth of [saAuth, admBizAuth, admDefaultAuth, userAuth]) {
        const res = await request(httpServer(app))
          .get(`/api/admin/v1/activities/${publishedActivityId}`)
          .set('Authorization', auth);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('POST(activity.create.record)', () => {
    it('③④ 30100(合法 body)/ ② 201 / ① 201', async () => {
      const payload = {
        title: 'ARB-X',
        activityTypeCode,
        organizationId: childOrgId,
        startAt: '2026-08-02T08:00:00.000Z',
        endAt: '2026-08-02T12:00:00.000Z',
        location: 'X',
      };
      expectBizError(
        await request(httpServer(app))
          .post('/api/admin/v1/activities')
          .set('Authorization', admDefaultAuth)
          .send(payload),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post('/api/admin/v1/activities')
          .set('Authorization', userAuth)
          .send(payload),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .post('/api/admin/v1/activities')
            .set('Authorization', admBizAuth)
            .send({ ...payload, title: 'ARB-BIZ' })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(httpServer(app))
            .post('/api/admin/v1/activities')
            .set('Authorization', saAuth)
            .send({ ...payload, title: 'ARB-SA' })
        ).status,
      ).toBe(201);
    });
  });

  describe('PATCH / DELETE / publish / cancel(activity.{update,delete,publish,cancel}.record)', () => {
    it('PATCH:①② 200 / ③④ 30100', async () => {
      const id = await createDraft('ARB-PATCH');
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}`)
          .set('Authorization', admDefaultAuth)
          .send({ title: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}`)
          .set('Authorization', userAuth)
          .send({ title: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/activities/${id}`)
            .set('Authorization', admBizAuth)
            .send({ title: 'ARB-PATCH-BIZ' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/activities/${id}`)
            .set('Authorization', saAuth)
            .send({ title: 'ARB-PATCH-SA' })
        ).status,
      ).toBe(200);
    });

    it('publish:③④ 30100 / ② 200;cancel:③④ 30100 / ② 200;DELETE:③④ 30100 / ①② 200', async () => {
      const id = await createDraft('ARB-FLOW');
      // publish 判权
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}/publish`)
          .set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}/publish`)
          .set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/activities/${id}/publish`)
            .set('Authorization', admBizAuth)
        ).status,
      ).toBe(200);
      // cancel 判权
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}/cancel`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${id}/cancel`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/activities/${id}/cancel`)
            .set('Authorization', admBizAuth)
            .send({ cancelReason: '边界取消' })
        ).status,
      ).toBe(200);
      // DELETE 判权(cancelled 仍允许软删,D3)
      expectBizError(
        await request(httpServer(app))
          .delete(`/api/admin/v1/activities/${id}`)
          .set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .delete(`/api/admin/v1/activities/${id}`)
          .set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .delete(`/api/admin/v1/activities/${id}`)
            .set('Authorization', admBizAuth)
        ).status,
      ).toBe(200);
      const id2 = await createDraft('ARB-DEL-SA');
      expect(
        (
          await request(httpServer(app))
            .delete(`/api/admin/v1/activities/${id2}`)
            .set('Authorization', saAuth)
        ).status,
      ).toBe(200);
    });
  });
});
