import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P1-B characterization tests(第四单)— Legacy `/api/v2/users/me/*` registrations 端点行为锁定。
//
// 目标:在 P1-C step 3 物理拆 `activity-registrations.controller.ts` 同文件双 `@Controller` 之前,
// 显式锁定 Mobile Legacy 入口的现状行为,作为拆分前的回归保护。
//
// 沿 docs/api-surface-policy.md §5 项 3 + §6 项 4-5 + §7 P1-B(第四单)。
//
// 目标端点:
//   - POST   /api/v2/users/me/activities/:activityId/registration  (`ActivityRegistrationsMeController.createMy`)
//   - GET    /api/v2/users/me/registrations                        (`ActivityRegistrationsMeController.listMy`)
// (同文件还有 GET /me/registrations/:id 与 PATCH /me/registrations/:id/cancel,本 spec 不重复覆盖)
//
// 与既有 spec 的关系(本文件**只补缺口**,不重复覆盖):
//   - test/e2e/activity-registrations.e2e-spec.ts(1084 LOC)已极广覆盖功能路径:
//     POST 成功 / 重复报名 / 私有活动 / 取消活动 / 容量已满 / 越权 404 / 取消流 等。
//   - test/e2e/app-my-registrations-{read,write}.e2e-spec.ts 覆盖 App API 对等端点。
//   - 本文件补的 4 个 P1-B 缺口:
//     1. **两 path 完全无 header 的 UNAUTHORIZED**(既有 spec 已锁 POST 路径 @ L261;**GET 未覆盖**)
//     2. **GET /me/registrations 跨用户隔离的显式 key-级反向断言**(既有 spec 用业务 status 覆盖语义,
//        但未对"列表中**不出现** otherUser 报名"做反向 key 断言)
//     3. **GET /me/registrations Query validation**(分页 page=0 / pageSize=0 / pageSize=101 /
//        page=abc;PaginationQueryDto Min/Max,既有 spec 未显式覆盖)
//     4. **L3 凭证字段非泄漏**(响应 items 不含 passwordHash / refreshToken / tokenHash /
//        secretKey* / secretId* / storageSecret)
//
// **未覆盖的 POST 成功路径**:沿用户授权"如果报名创建条件比预期复杂,只锁 GET 列表 + 未登录 +
// validation,报告未覆盖 POST 成功原因"。Activity 创建需 Organization + dict(node_type +
// activity_type)+ publish 状态机 + 状态码字典等多步前置;既有
// activity-registrations.e2e-spec.ts:245-259 已锁定 POST 成功路径(USER 自助 201 + cancel
// 清理流)。本 spec 通过 prisma 直接 seed ActivityRegistration 行(绕过 POST 状态机),
// 专注 GET 列表 + L3 + validation。

const L3_FORBIDDEN_FIELDS = [
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'secretKey',
  'secretKeyEncrypted',
  'secretId',
  'secretIdEncrypted',
  'storageSecret',
] as const;

function assertNoL3FieldLeak(data: Record<string, unknown> | undefined | null): void {
  for (const f of L3_FORBIDDEN_FIELDS) {
    expect(data).not.toHaveProperty(f);
  }
}

const PLACEHOLDER_ACTIVITY_ID = 'clxxx0000000000000000aaa'; // 24-char cuid 占位,仅未登录 POST 用

describe('Legacy activity registrations me endpoints (P1-B characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let userAAuth: string;
  let userBAuth: string;
  let memberAId: string;
  let memberBId: string;
  let activity1Id: string;
  let activity2Id: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 2 users
    await createTestUser(app, { username: 'p1bareg-a', role: Role.USER });
    await createTestUser(app, { username: 'p1bareg-b', role: Role.USER });

    // 2 members
    const ma = await prisma.member.create({
      data: { memberNo: 'p1b-areg-m-a', displayName: 'AReg Member A' },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'p1b-areg-m-b', displayName: 'AReg Member B' },
      select: { id: true },
    });
    memberBId = mb.id;

    // 链接 user.memberId(沿 activity-registrations.e2e:87 范式)
    await prisma.user.update({
      where: { username: 'p1bareg-a' },
      data: { memberId: memberAId },
    });
    await prisma.user.update({
      where: { username: 'p1bareg-b' },
      data: { memberId: memberBId },
    });

    userAAuth = (await loginAs(app, 'p1bareg-a')).authHeader;
    userBAuth = (await loginAs(app, 'p1bareg-b')).authHeader;

    // 必要 dict + organization(Activity.organizationId 是 FK)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p1b-areg-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'P1B AReg Root', nodeTypeCode: 'p1b-areg-root', parentId: null },
      select: { id: true },
    });

    // 2 Activity(prisma 直接 create;`(activityId, memberId)` 是 partial unique,
    // 要让 userA 有 2 条报名必须用 2 个 activity)
    const act1 = await prisma.activity.create({
      data: {
        title: 'P1B AReg Activity 1',
        activityTypeCode: 'p1b-areg-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-06-01T08:00:00.000Z'),
        endAt: new Date('2026-06-01T12:00:00.000Z'),
        location: '演示地点 1',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activity1Id = act1.id;
    const act2 = await prisma.activity.create({
      data: {
        title: 'P1B AReg Activity 2',
        activityTypeCode: 'p1b-areg-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-06-02T08:00:00.000Z'),
        endAt: new Date('2026-06-02T12:00:00.000Z'),
        location: '演示地点 2',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activity2Id = act2.id;

    // 3 ActivityRegistration:userA 2 条(act1 + act2)、userB 1 条(act1);prisma 直接
    // seed 绕过 POST 状态机,同时满足 `(activityId, memberId)` partial unique
    await prisma.activityRegistration.create({
      data: { activityId: activity1Id, memberId: memberAId, statusCode: 'pending' },
    });
    await prisma.activityRegistration.create({
      data: { activityId: activity2Id, memberId: memberAId, statusCode: 'pass' },
    });
    await prisma.activityRegistration.create({
      data: { activityId: activity1Id, memberId: memberBId, statusCode: 'pending' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ A. 未登录 ============
  describe('A. 未登录 → UNAUTHORIZED', () => {
    it('POST /api/v2/users/me/activities/:activityId/registration 无 header → 40100', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${PLACEHOLDER_ACTIVITY_ID}/registration`)
        .send({});
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('GET /api/v2/users/me/registrations 无 header → 40100(本 spec 独有覆盖)', async () => {
      const res = await request(httpServer(app)).get('/api/v2/users/me/registrations');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ B. GET 列表跨用户隔离(显式 key 反向断言) ============
  describe('B. GET /me/registrations 跨用户隔离', () => {
    it('userA → 200,只见 userA(memberA)的 2 条;**不见 userB(memberB)的报名**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(res.body.data.total).toBe(2);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.items).toHaveLength(2);

      // 正向断言:每条 memberId === memberAId
      for (const item of res.body.data.items as Array<{ memberId: string }>) {
        expect(item.memberId).toBe(memberAId);
      }

      // 反向断言:**显式 key 反查 memberB 不在列表中**(既有 spec 未做)
      const memberIds = (res.body.data.items as Array<{ memberId: string }>).map((i) => i.memberId);
      expect(memberIds).not.toContain(memberBId);
    });

    it('userB → 200,只见 userB(memberB)的 1 条;**不见 userA(memberA)的报名**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userBAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].memberId).toBe(memberBId);

      const memberIds = (res.body.data.items as Array<{ memberId: string }>).map((i) => i.memberId);
      expect(memberIds).not.toContain(memberAId);
    });
  });

  // ============ C. 分页 ============
  describe('C. 分页 page / pageSize / total / items', () => {
    it('默认参数 → 200,page=1,pageSize=20,userA total=2,items=2', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('pageSize=1 → 200,page=1 取 1 条,total=2', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?pageSize=1')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(1);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('page=2&pageSize=1 → 200,取剩余 1 条,total 稳定', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?page=2&pageSize=1')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.pageSize).toBe(1);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(1);
    });
  });

  // ============ D. Query validation ============
  describe('D. Query validation(PaginationQueryDto Min/Max + @Type(Number))', () => {
    it('page=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?page=0')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?pageSize=0')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=101(> Max(100)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?pageSize=101')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('page=abc(非数字) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations?page=abc')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ E. L3 凭证字段非泄漏 ============
  describe('E. response items 不得泄漏 L3 凭证字段', () => {
    it('每个 item 不含 passwordHash / refreshToken / tokenHash / secretKey* / secretId* / storageSecret', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items as Array<Record<string, unknown>>) {
        assertNoL3FieldLeak(item);
      }

      // 序列化反向兜底:整体响应字符串不得包含任何 L3 字段名子串
      const serialized = JSON.stringify(res.body);
      for (const f of L3_FORBIDDEN_FIELDS) {
        expect(serialized).not.toContain(`"${f}"`);
      }
    });
  });

  // ============ F. P1-B framing:Legacy ≠ App API alias ============
  describe('F. P1-B framing:Legacy `/v2/users/me/registrations` 非 App API alias', () => {
    it('legacy 端点存在且返回 ActivityRegistrationListItemDto 形态(含 memberId / statusCode 等 v2 字段)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      // ActivityRegistrationListItemDto 顶层字段(沿 activity-registrations.dto.ts §L82)
      // 含 memberId / statusCode / registeredAt 等 v2 admin-like 字段;
      // App API 对等端点 AppMyRegistrationListItemDto **不返** memberId(沿 docs P2-5a 评审稿 D-5)
      expect(res.body.data.items[0]).toHaveProperty('id');
      expect(res.body.data.items[0]).toHaveProperty('activityId');
      expect(res.body.data.items[0]).toHaveProperty('memberId'); // legacy 返,App API 不返
      expect(res.body.data.items[0]).toHaveProperty('statusCode');
      expect(res.body.data.items[0]).toHaveProperty('registeredAt');
    });
  });
});
