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

// P1-B characterization tests — Legacy `GET /api/v2/attachments/me/uploaded` 行为锁定。
//
// 目标:在 P1-C step 2 物理拆 `attachments.controller.ts` 中 `me/uploaded` 方法之前,
// 显式锁定 mobile-like endpoint 的现状行为,作为拆分前的回归保护。
//
// 沿 docs/api-surface-policy.md §5 项 4 + §6 项 8 + §7 P1-B(第二单)。
//
// 端点契约现状(沿 attachments.controller.ts:173 + attachments.service.ts:634):
//   - @Get('me/uploaded')
//   - @ApiTags('Mobile - Attachments')  ← method-level dual tag(class Admin - Attachments + method Mobile)
//   - Guard 仅 JwtAuthGuard,**不**进 RBAC 范围(沿"本人查自己"豁免;D7 §5.1 端点 7)
//   - Query: PaginationQueryDto(page Min(1) / pageSize Min(1) Max(100))
//   - Service: where = { uploadedBy: currentUser.id },orderBy createdAt desc
//   - Response: PageResultDto<AttachmentResponseDto>(items / total / page / pageSize)
//
// 与既有 spec 的关系:
//   - test/e2e/attachments.e2e-spec.ts:712-770 已有 2 个简略用例(SUPER 看 2 条 / selfUser 看 1 条)
//   - 本文件**只补缺口**,不重复覆盖既有断言;P1-B characterization 补的 4 个缺口:
//     1. 未登录 → 401
//     2. 跨用户隔离的**显式反向断言**(userA 调用结果中不存在 userB 的记录;既有 spec 只断 total)
//     3. 分页行为(多页 + total 稳定 + page/pageSize echo)
//     4. L3 凭证字段非泄漏 + Query validation(page=0 / pageSize=0 / pageSize=101 / 非数字)

const FAKE_OWNER_ID = 'clxxx0000000000000000aaa'; // 24 字符占位 cuid;attachment.ownerId 无 FK 约束

// 沿 docs/api-surface-policy.md §2.1 ❌ "App API 永远不返回 L3 凭证字段"。
// Root/Admin Legacy /me/uploaded 端点亦应满足同等约束。
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

describe('Legacy attachments/me/uploaded endpoint (P1-B characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ A. 未登录 ============
  describe('A. 未登录 → UNAUTHORIZED', () => {
    it('GET /api/v2/attachments/me/uploaded 无 header → 40100 + HTTP 401 + data=null', async () => {
      const res = await request(httpServer(app)).get('/api/v2/attachments/me/uploaded');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('GET /api/v2/attachments/me/uploaded 错 Bearer → 40100', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ B. 跨用户隔离反向断言 ============
  describe('B. uploadedBy 自动过滤 → 跨用户隔离', () => {
    let userAId: string;
    let userBId: string;
    let userAAuth: string;
    let userBAuth: string;

    beforeAll(async () => {
      await prisma.attachment.deleteMany({});
      const userA = await createTestUser(app, { username: 'p1battache-a', role: Role.USER });
      const userB = await createTestUser(app, { username: 'p1battache-b', role: Role.USER });
      userAId = userA.id;
      userBId = userB.id;
      ({ authHeader: userAAuth } = await loginAs(app, 'p1battache-a'));
      ({ authHeader: userBAuth } = await loginAs(app, 'p1battache-b'));

      await prisma.attachment.createMany({
        data: [
          {
            key: 'p1b-iso-a1',
            originalName: 'a1.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: userAId,
            ownerType: 'member',
            ownerId: FAKE_OWNER_ID,
          },
          {
            key: 'p1b-iso-a2',
            originalName: 'a2.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: userAId,
            ownerType: 'member',
            ownerId: FAKE_OWNER_ID,
          },
          {
            key: 'p1b-iso-b1',
            originalName: 'b1.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: userBId,
            ownerType: 'member',
            ownerId: FAKE_OWNER_ID,
          },
        ],
      });
    });

    it('userA → 200,只见 userA 自己上传的 2 条;**不见 userB 的任何记录**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(res.body.data.total).toBe(2);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.items).toHaveLength(2);

      // 正向断言:每条都是 userA 上传的
      for (const item of res.body.data.items as Array<{ uploadedBy: string; key: string }>) {
        expect(item.uploadedBy).toBe(userAId);
      }

      // 反向断言:不存在任何 userB 上传的记录(显式 key 反查;既有 spec 未覆盖)
      const keys = (res.body.data.items as Array<{ key: string }>).map((i) => i.key);
      expect(keys).not.toContain('p1b-iso-b1');
    });

    it('userB → 200,只见 userB 自己上传的 1 条;**不见 userA 的任何记录**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded')
        .set('Authorization', userBAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].uploadedBy).toBe(userBId);
      expect(res.body.data.items[0].key).toBe('p1b-iso-b1');

      const keys = (res.body.data.items as Array<{ key: string }>).map((i) => i.key);
      expect(keys).not.toContain('p1b-iso-a1');
      expect(keys).not.toContain('p1b-iso-a2');
    });
  });

  // ============ C. 分页 ============
  describe('C. 分页 page / pageSize / total / items', () => {
    let userAuth: string;

    beforeAll(async () => {
      await prisma.attachment.deleteMany({});
      const user = await createTestUser(app, { username: 'p1battache-page', role: Role.USER });
      ({ authHeader: userAuth } = await loginAs(app, 'p1battache-page'));

      await prisma.attachment.createMany({
        data: [1, 2, 3].map((n) => ({
          key: `p1b-page-${n}`,
          originalName: `p${n}.jpg`,
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: user.id,
          ownerType: 'member',
          ownerId: FAKE_OWNER_ID,
        })),
      });
    });

    it('默认参数 → 200,total=3,page=1,pageSize=20,items=3', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded')
        .set('Authorization', userAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
      expect(res.body.data.items).toHaveLength(3);
    });

    it('pageSize=2 → 200,page=1 取前 2 条,total=3 不变', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?pageSize=2')
        .set('Authorization', userAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(2);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('page=2&pageSize=2 → 200,取剩余 1 条,total=3 稳定', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?page=2&pageSize=2')
        .set('Authorization', userAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.pageSize).toBe(2);
      expect(res.body.data.items).toHaveLength(1);
    });
  });

  // ============ D. L3 字段非泄漏 ============
  describe('D. response items 不得泄漏 L3 凭证字段', () => {
    let userAuth: string;

    beforeAll(async () => {
      await prisma.attachment.deleteMany({});
      const user = await createTestUser(app, { username: 'p1battache-l3', role: Role.USER });
      ({ authHeader: userAuth } = await loginAs(app, 'p1battache-l3'));

      await prisma.attachment.create({
        data: {
          key: 'p1b-l3-1',
          originalName: 'l3.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: user.id,
          ownerType: 'member',
          ownerId: FAKE_OWNER_ID,
        },
      });
    });

    it('每个 item 不含 passwordHash / refreshToken / tokenHash / secretKey* / secretId* / storageSecret', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded')
        .set('Authorization', userAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items as Array<Record<string, unknown>>) {
        assertNoL3FieldLeak(item);
      }

      // 序列化反向兜底:整体响应字符串不得包含任何 L3 字段名子串(防止透露 schema)
      const serialized = JSON.stringify(res.body);
      for (const f of L3_FORBIDDEN_FIELDS) {
        expect(serialized).not.toContain(`"${f}"`);
      }
    });
  });

  // ============ E. Query validation ============
  describe('E. Query validation(PaginationQueryDto Min/Max + @Type(Number))', () => {
    let userAuth: string;

    beforeAll(async () => {
      await createTestUser(app, { username: 'p1battache-val', role: Role.USER });
      ({ authHeader: userAuth } = await loginAs(app, 'p1battache-val'));
    });

    it('page=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?page=0')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?pageSize=0')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=101(> Max(100)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?pageSize=101')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('page=abc(非数字) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachments/me/uploaded?page=abc')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
