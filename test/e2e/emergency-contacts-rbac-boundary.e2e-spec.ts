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

// Slow-4 T2(2026-06-11):emergency-contacts 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收
// (① SA 短路 / ② ADMIN+biz-admin 照常 / ③ ADMIN 无 biz-admin 30100 / ④ USER 30100)。
// 业务行为细节由 emergency-contacts.e2e-spec.ts 锁定,本 spec 只锁判权矩阵。

describe('emergency-contacts RBAC 权限边界(Slow-4 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;

  let memberA: string;
  let relationCode: string;
  let contactId: string; // ② PATCH/DELETE 用(SA 预创建)

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'ecrb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'ecrb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'ecrb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'ecrb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'ecrb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'ecrb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'ecrb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'ecrb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    const relType = await prisma.dictType.create({
      data: { code: 'emergency_relation', label: 'Emergency Relation' },
      select: { id: true },
    });
    const rel = await prisma.dictItem.create({
      data: { typeId: relType.id, code: 'ecrb-rel-family', label: 'family' },
      select: { code: true },
    });
    relationCode = rel.code;

    const a = await prisma.member.create({
      data: { memberNo: 'ecrb-m-a', displayName: 'A' },
      select: { id: true },
    });
    memberA = a.id;

    const c = await prisma.emergencyContact.create({
      data: {
        memberId: memberA,
        contactName: '边界联系人',
        relationCode,
        phonePrimary: '13800000010',
      },
      select: { id: true },
    });
    contactId = c.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const createPayload = (): Record<string, unknown> => ({
    contactName: '新联系人',
    relationCode,
    phonePrimary: '13800000011',
  });

  describe('GET(emergency-contact.read.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const base = `/api/admin/v1/members/${memberA}/emergency-contacts`;
      expect((await request(httpServer(app)).get(base).set('Authorization', saAuth)).status).toBe(
        200,
      );
      expect(
        (await request(httpServer(app)).get(base).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(base).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(base).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('POST(emergency-contact.create.record)', () => {
    it('①② 通过 / ③④ 30100(合法 body)', async () => {
      const base = `/api/admin/v1/members/${memberA}/emergency-contacts`;
      expect(
        (
          await request(httpServer(app))
            .post(base)
            .set('Authorization', saAuth)
            .send(createPayload())
        ).status,
      ).toBe(201);
      expect(
        (
          await request(httpServer(app))
            .post(base)
            .set('Authorization', admBizAuth)
            .send(createPayload())
        ).status,
      ).toBe(201);
      expectBizError(
        await request(httpServer(app))
          .post(base)
          .set('Authorization', admDefaultAuth)
          .send(createPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(base)
          .set('Authorization', userAuth)
          .send(createPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('PATCH /:id(emergency-contact.update.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const url = `/api/admin/v1/members/${memberA}/emergency-contacts/${contactId}`;
      expect(
        (
          await request(httpServer(app))
            .patch(url)
            .set('Authorization', saAuth)
            .send({ contactName: 'SA 改名' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer(app))
            .patch(url)
            .set('Authorization', admBizAuth)
            .send({ contactName: 'Biz 改名' })
        ).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app))
          .patch(url)
          .set('Authorization', admDefaultAuth)
          .send({ contactName: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(url)
          .set('Authorization', userAuth)
          .send({ contactName: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('DELETE /:id(emergency-contact.delete.record)', () => {
    it('③④ 30100(判权先于资源探测,假 id 也 30100)/ ②① 通过', async () => {
      const fakeUrl = `/api/admin/v1/members/${memberA}/emergency-contacts/cl000000000000000000xxxx`;
      expectBizError(
        await request(httpServer(app)).delete(fakeUrl).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).delete(fakeUrl).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      // ② ADMIN+biz-admin 软删预创建的 contact
      const okBiz = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', admBizAuth);
      expect(okBiz.status).toBe(200);
      // ① SA 软删一条新建的
      const c2 = await prisma.emergencyContact.create({
        data: {
          memberId: memberA,
          contactName: 'SA 删除目标',
          relationCode,
          phonePrimary: '13800000012',
        },
        select: { id: true },
      });
      const okSa = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/emergency-contacts/${c2.id}`)
        .set('Authorization', saAuth);
      expect(okSa.status).toBe(200);
    });
  });

  // ============ 十项收口刀D:read.record 收窄为脱敏,明文走 emergency-contact.read.sensitive ============
  describe('刀D 敏感分级', () => {
    it('仅持 read.record(无 sensitive)→ list 掩码;biz-admin(fixture 含 sensitive)→ 明文', async () => {
      // 手工造只持 read.record 的角色 + GLOBAL RoleBinding(镜像 grantBizAdminToUser 形状)
      const recordOnly = await createTestUser(app, {
        username: 'ecrb-record-only',
        role: Role.ADMIN,
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'emergency-contact.read.record' },
        select: { id: true },
      });
      const role = await prisma.rbacRole.create({
        data: { code: 'ecrb-record-only-role', displayName: 'record-only' },
        select: { id: true },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: recordOnly.id,
          roleId: role.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
      const recordOnlyAuth = (await loginAs(app, 'ecrb-record-only')).authHeader;

      // 前序 ④ 用例已把共享 contactId 软删,这里自建一条专用联系人再断言
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/emergency-contacts`)
        .set('Authorization', saAuth)
        .send({ contactName: '刀D联系人', relationCode, phonePrimary: '13800000099' })
        .expect(201);
      const freshId = created.body.data.id as string;

      const masked = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/emergency-contacts`)
        .set('Authorization', recordOnlyAuth)
        .expect(200);
      const m = masked.body.data.find((c: { id: string }) => c.id === freshId);
      expect(m.phonePrimary).toContain('*'); // 掩码(138****XXXX)

      const plain = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/emergency-contacts`)
        .set('Authorization', admBizAuth)
        .expect(200);
      const pRow = plain.body.data.find((c: { id: string }) => c.id === freshId);
      expect(pRow.phonePrimary).not.toContain('*'); // biz-admin 全绑含 sensitive → 明文
      expect(pRow.phonePrimary).toMatch(/^\d+$/);
    });
  });
});
