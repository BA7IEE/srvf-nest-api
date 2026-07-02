import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
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

// Slow-4 T3(2026-06-11):attendances 模块(2 个 Admin class,10 端点)RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收
// (① SA 短路 / ② ADMIN+biz-admin 照常 / ③ ADMIN 无 biz-admin 30100 / ④ USER 30100)。
// list / detail / review-detail 共用 attendance.read.sheet(D4=A 判例);
// 终审两码独立(ADMIN 级终审沿 P1-5 方案 A)。
// 业务行为细节(状态机 / 时间重叠 / 贡献值)由 attendances*.e2e-spec.ts 系列锁定。

describe('attendances RBAC 权限边界(Slow-4 T3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;
  let submitterUserId: string;
  let admBizUserId: string;

  let activityId: string;
  let memberId: string;
  let attendanceRoleCode: string;
  let attendanceStatusCode: string;
  let recordHourSeq = 0;

  // prisma 直造指定状态的 Sheet + 1 条 record(contributionPoints 已填,满足 R31;
  // 各 sheet 时间窗错开避免 R16 重叠校验干扰 edit/submit 路径)。
  // PR9:submitterOverride —— 默认 submitter 是 SA;SA 自己终审的用例(① 短路)因自审约束
  // (22074,SA 亦拒)须换他人提交的单,短路语义本身不变。
  const createSheetAt = async (statusCode: string, submitterOverride?: string): Promise<string> => {
    recordHourSeq += 2;
    const start = new Date(Date.UTC(2026, 8, 1, recordHourSeq % 20, 0, 0));
    const end = new Date(Date.UTC(2026, 8, 1, (recordHourSeq % 20) + 1, 0, 0));
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: submitterOverride ?? submitterUserId,
        statusCode,
        records: {
          create: [
            {
              memberId,
              roleCode: attendanceRoleCode,
              checkInAt: start,
              checkOutAt: end,
              serviceHours: new Prisma.Decimal('1.00'),
              attendanceStatusCode,
              contributionPoints: new Prisma.Decimal('1.50'),
            },
          ],
        },
      },
      select: { id: true },
    });
    return sheet.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const sa = await createTestUser(app, { username: 'atrb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'atrb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'atrb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'atrb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'atrb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'atrb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'atrb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'atrb-user')).authHeader;
    submitterUserId = sa.id;
    admBizUserId = admBiz.id;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    // org / 活动 / member / 考勤字典(submit 路径的字典校验依赖)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'atrb-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'ATRB Root', nodeTypeCode: 'atrb-root', parentId: null },
      select: { id: true },
    });
    const act = await prisma.activity.create({
      data: {
        title: 'ATRB Activity',
        activityTypeCode: 'atrb-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-09-01T00:00:00.000Z'),
        endAt: new Date('2026-09-02T00:00:00.000Z'),
        location: '边界演示',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activityId = act.id;
    const m = await prisma.member.create({
      data: { memberNo: 'atrb-m-1', displayName: 'ATRB M1' },
      select: { id: true },
    });
    memberId = m.id;

    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    const role = await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: 'atrb-role', label: '队员' },
      select: { code: true },
    });
    attendanceRoleCode = role.code;
    const statusDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    const st = await prisma.dictItem.create({
      data: { typeId: statusDict.id, code: 'atrb-present', label: '出勤' },
      select: { code: true },
    });
    attendanceStatusCode = st.code;
  });

  afterAll(async () => {
    await app.close();
  });

  const sheetsBase = (): string => `/api/admin/v1/activities/${activityId}/attendance-sheets`;
  const resBase = (): string => `/api/admin/v1/attendance-sheets`;
  const submitPayload = (): Record<string, unknown> => {
    recordHourSeq += 2;
    const h = recordHourSeq % 20;
    return {
      records: [
        {
          memberId,
          roleCode: attendanceRoleCode,
          checkInAt: new Date(Date.UTC(2026, 8, 2, h, 0, 0)).toISOString(),
          checkOutAt: new Date(Date.UTC(2026, 8, 2, h + 1, 0, 0)).toISOString(),
          attendanceStatusCode,
        },
      ],
    };
  };

  describe('Collection:POST submit / GET list', () => {
    it('submit(attendance.create.sheet):③④ 30100(合法 body)/ ② 201 / ① 201', async () => {
      expectBizError(
        await request(httpServer(app))
          .post(sheetsBase())
          .set('Authorization', admDefaultAuth)
          .send(submitPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(sheetsBase())
          .set('Authorization', userAuth)
          .send(submitPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .post(sheetsBase())
            .set('Authorization', admBizAuth)
            .send(submitPayload())
        ).status,
      ).toBe(201);
      expect(
        (
          await request(httpServer(app))
            .post(sheetsBase())
            .set('Authorization', saAuth)
            .send(submitPayload())
        ).status,
      ).toBe(201);
    });
    it('list(attendance.read.sheet):①② 200 / ③④ 30100', async () => {
      expect(
        (await request(httpServer(app)).get(sheetsBase()).set('Authorization', saAuth)).status,
      ).toBe(200);
      expect(
        (await request(httpServer(app)).get(sheetsBase()).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(sheetsBase()).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(sheetsBase()).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('Resource:detail / review-detail(attendance.read.sheet 共用)', () => {
    it('①② 200 / ③④ 30100(detail 与 review-detail)', async () => {
      const sheetId = await createSheetAt('pending');
      for (const path of [`${resBase()}/${sheetId}`, `${resBase()}/${sheetId}/review-detail`]) {
        expect((await request(httpServer(app)).get(path).set('Authorization', saAuth)).status).toBe(
          200,
        );
        expect(
          (await request(httpServer(app)).get(path).set('Authorization', admBizAuth)).status,
        ).toBe(200);
        expectBizError(
          await request(httpServer(app)).get(path).set('Authorization', admDefaultAuth),
          BizCode.RBAC_FORBIDDEN,
        );
        expectBizError(
          await request(httpServer(app)).get(path).set('Authorization', userAuth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    });
  });

  describe('Resource:edit / delete(attendance.{update,delete}.sheet)', () => {
    it('edit:③④ 30100 / ② 200(pending Sheet,{} 合法不替换 records)', async () => {
      const sheetId = await createSheetAt('pending');
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${sheetId}`)
            .set('Authorization', admBizAuth)
            .send({})
        ).status,
      ).toBe(200);
    });
    it('delete:③④ 30100 / ②① 200(各独立 pending Sheet)', async () => {
      const s1 = await createSheetAt('pending');
      expectBizError(
        await request(httpServer(app))
          .delete(`${resBase()}/${s1}`)
          .set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).delete(`${resBase()}/${s1}`).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .delete(`${resBase()}/${s1}`)
            .set('Authorization', admBizAuth)
        ).status,
      ).toBe(200);
      const s2 = await createSheetAt('pending');
      expect(
        (await request(httpServer(app)).delete(`${resBase()}/${s2}`).set('Authorization', saAuth))
          .status,
      ).toBe(200);
    });
  });

  describe('Resource:approve / reject / final-approve / final-reject(独立码)', () => {
    it('approve:③④ 30100 / ② 200(pending,records contributionPoints 已填)', async () => {
      const sheetId = await createSheetAt('pending');
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/approve`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/approve`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${sheetId}/approve`)
            .set('Authorization', admBizAuth)
            .send({})
        ).status,
      ).toBe(200);
    });
    it('reject:③④ 30100 / ② 200(pending)', async () => {
      const sheetId = await createSheetAt('pending');
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/reject`)
          .set('Authorization', admDefaultAuth)
          .send({ reviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/reject`)
          .set('Authorization', userAuth)
          .send({ reviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${sheetId}/reject`)
            .set('Authorization', admBizAuth)
            .send({ reviewNote: '边界驳回' })
        ).status,
      ).toBe(200);
    });
    it('final-approve:③④ 30100 / ② 200 / ① 200(pending_final_review;ADMIN 级终审)', async () => {
      const sheetId = await createSheetAt('pending_final_review');
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/final-approve`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/final-approve`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${sheetId}/final-approve`)
            .set('Authorization', admBizAuth)
            .send({})
        ).status,
      ).toBe(200);
      // PR9:s2 换 admBiz 提交(默认 submitter 是 SA 本人 —— 自审约束 22074 对 SA 亦拒;
      // ① 短路语义仍被锁:SA 终审**他人**提交的单 200)
      const s2 = await createSheetAt('pending_final_review', admBizUserId);
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${s2}/final-approve`)
            .set('Authorization', saAuth)
            .send({})
        ).status,
      ).toBe(200);
    });
    it('final-reject:③④ 30100 / ② 200(pending_final_review;finalReviewNote 必填)', async () => {
      const sheetId = await createSheetAt('pending_final_review');
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/final-reject`)
          .set('Authorization', admDefaultAuth)
          .send({ finalReviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${resBase()}/${sheetId}/final-reject`)
          .set('Authorization', userAuth)
          .send({ finalReviewNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${resBase()}/${sheetId}/final-reject`)
            .set('Authorization', admBizAuth)
            .send({ finalReviewNote: '边界终审驳回' })
        ).status,
      ).toBe(200);
    });
  });
});
