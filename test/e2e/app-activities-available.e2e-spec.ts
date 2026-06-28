import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-4a App /api/app/v1/activities/available 列表 e2e。
// 沿 docs/app-api-p2-4-activities-review.md §10.2 九类 it block;字段集恰好 11 项(沿 §4.1)。
//
// 准入沿 §6.1:JwtAuthGuard + AppIdentityResolver.resolve + canUseApp;
// canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 / Admin 无 member);
// 不沿 P2-3 admin-without-member 例外(沿 §6.2)。
//
// 可见性沿 D-P2-4-1 = A(v0.1 锁定):仅 statusCode='published' AND deletedAt IS NULL;
// draft / cancelled / completed / 软删 一律不返;query 严格 page / pageSize(沿 §9.1)。
//
// 旧 /api/admin/v1/activities* 行为**逐字不变**(沿 §11.4 + 风险表 13.12)。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// 字段集恰好 11 项(沿评审稿 §4.1 v0.1 锁定)。
const APP_AVAILABLE_LIST_ITEM_KEYS = [
  'activityTypeCode',
  'capacity',
  'coverImageUrl',
  'createdAt',
  'endAt',
  'id',
  'location',
  'registrationDeadline',
  'startAt',
  'statusCode',
  'title',
].sort();

// 字段反向集合(沿评审稿 §4.2 v0.1 锁定 17 项 + admin/audit 字段)。
const FORBIDDEN_KEYS_ON_LIST_ITEM = [
  'description',
  'organizationId',
  'genderRequirementCode',
  'isPublicRegistration',
  'registrationNotes',
  'registrationSchema',
  'galleryImageUrls',
  'content',
  'locationLongitude',
  'locationLatitude',
  'updatedAt',
  'deletedAt',
  'publishedBy',
  'publishedAt',
  'cancelledBy',
  'cancelledAt',
  'cancelReason',
];

describe('App GET /api/app/v1/activities/available (P2-4a)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let childOrgId: string;
  let activityTypeCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 字典 + 组织 fixture(沿 activities.e2e-spec.ts 范式;Activity FK 依赖)。
    const nodeTypeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'p2-4a-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'p2-4a-child', label: '子' },
    });

    const root = await prisma.organization.create({
      data: { name: 'P2-4a Root', nodeTypeCode: 'p2-4a-root', parentId: null },
      select: { id: true },
    });
    const child = await prisma.organization.create({
      data: { name: 'P2-4a Child', nodeTypeCode: 'p2-4a-child', parentId: root.id },
      select: { id: true },
    });
    childOrgId = child.id;

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const actTypeActive = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'p2-4a-training', label: '训练' },
      select: { code: true },
    });
    activityTypeCode = actTypeActive.code;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============== helpers ==============

  async function createActiveMember(
    memberNo: string,
    displayName = '队员',
  ): Promise<{ id: string }> {
    return prisma.member.create({
      data: { memberNo, displayName, gradeCode: 'L1', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
  }

  async function setupLinkedUser(opts: {
    username: string;
    role?: Role;
    memberNo: string;
  }): Promise<{ userId: string; memberId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
    });
    const member = await createActiveMember(opts.memberNo);
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, opts.username);
    return { userId: user.id, memberId: member.id, authHeader };
  }

  async function setupUnlinkedUser(
    username: string,
    role: Role = Role.USER,
  ): Promise<{ authHeader: string }> {
    await createTestUser(app, { username, role });
    return loginAs(app, username);
  }

  // 直接通过 Prisma 写 Activity 各状态;不走 controller 创建路径(避免依赖 admin 流程)。
  async function createActivity(
    state: 'draft' | 'published' | 'cancelled' | 'completed' | 'softDeleted',
    titleSuffix: string,
  ): Promise<{ id: string }> {
    const base = {
      title: `P2-4a ${state} ${titleSuffix}`,
      activityTypeCode,
      organizationId: childOrgId,
      startAt: new Date('2026-07-01T08:00:00.000Z'),
      endAt: new Date('2026-07-01T12:00:00.000Z'),
      location: '梧桐山',
      coverImageUrl: 'https://example.test/cover.png',
      capacity: 30,
      // 固定远未来,与 wall-clock 解耦(镜像 #452 app-my-registrations-write 同款 fixture 修复)。
      // available 可见性仅 statusCode='published' + 未软删,不按截止闸过滤,原近未来默认值当前不 failing;
      // 但属硬编码潜在时间炸弹 → 改远未来杜绝墙钟越过误触。test/** fixture 修复,零业务行为变更。
      registrationDeadline: new Date('2099-12-31T23:59:59.000Z'),
    };
    if (state === 'draft') {
      return prisma.activity.create({
        data: { ...base, statusCode: 'draft' },
        select: { id: true },
      });
    }
    if (state === 'published') {
      return prisma.activity.create({
        data: { ...base, statusCode: 'published', publishedAt: new Date() },
        select: { id: true },
      });
    }
    if (state === 'cancelled') {
      return prisma.activity.create({
        data: {
          ...base,
          statusCode: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: 'test cancel',
        },
        select: { id: true },
      });
    }
    if (state === 'completed') {
      return prisma.activity.create({
        data: { ...base, statusCode: 'completed' },
        select: { id: true },
      });
    }
    // softDeleted: published + deletedAt
    return prisma.activity.create({
      data: { ...base, statusCode: 'published', deletedAt: new Date() },
      select: { id: true },
    });
  }

  const get = (path: string, authHeader?: string) => {
    const r = request(httpServer(app)).get(path);
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  // =====================================================
  // 1. success + 字段集 + 仅 published
  // =====================================================

  describe('success + 字段集恰好 11 项', () => {
    it('200 + 所有 items statusCode=published + 字段集恰好 11', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24a_success_user',
        memberNo: 'P24A-S1',
      });
      // 至少 2 个 published,确保 list 非空
      await createActivity('published', 'A');
      await createActivity('published', 'B');

      const res = await get('/api/app/v1/activities/available', authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      expect(body.message).toBe('ok');

      const data = body.data as {
        items: Array<Record<string, unknown>>;
        total: number;
        page: number;
        pageSize: number;
      };
      expect(typeof data.total).toBe('number');
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(20);
      expect(data.items.length).toBeGreaterThanOrEqual(2);

      for (const item of data.items) {
        expect(Object.keys(item).sort()).toEqual(APP_AVAILABLE_LIST_ITEM_KEYS);
        expect(item.statusCode).toBe('published');
        for (const forbiddenKey of FORBIDDEN_KEYS_ON_LIST_ITEM) {
          expect(item).not.toHaveProperty(forbiddenKey);
        }
      }
    });
  });

  // =====================================================
  // 2. draft / cancelled / completed / 软删 全部不返
  // =====================================================

  describe('可见性: draft / cancelled / completed / soft-deleted 不返', () => {
    // 注:username 必须全小写(auth.service 登录前 trim().toLowerCase());label 同步小写
    // 避免 `softDeleted` 这类驼峰映射出大小写不一致账号查不到。
    it.each([
      ['draft', 'draft'],
      ['cancelled', 'cancelled'],
      ['completed', 'completed'],
      ['softdeleted', 'softDeleted'],
    ] as const)('%s 状态活动不出现在 list', async (label, state) => {
      const { authHeader } = await setupLinkedUser({
        username: `p24a_invisible_${label}`,
        memberNo: `P24A-INV-${label.substring(0, 3).toUpperCase()}`,
      });
      const invisible = await createActivity(state, `inv-${label}`);

      const res = await get('/api/app/v1/activities/available?pageSize=100', authHeader);
      expect(res.status).toBe(200);
      const data = res.body.data as { items: Array<{ id: string; statusCode: string }> };
      const ids = data.items.map((it) => it.id);
      expect(ids).not.toContain(invisible.id);
      // 同时正向断言:任何返回项的 statusCode 都是 published(双重保险)
      for (const it of data.items) {
        expect(it.statusCode).toBe('published');
      }
    });
  });

  // =====================================================
  // 3. unauthenticated 401
  // =====================================================

  describe('unauthenticated → 401', () => {
    it.each([
      ['no token', undefined],
      ['bad token', 'Bearer not-a-real-token'],
    ])('%s → 401', async (_label, authHeader) => {
      expectBizError(
        await get('/api/app/v1/activities/available', authHeader),
        BizCode.UNAUTHORIZED,
      );
    });
  });

  // =====================================================
  // 4. member not linked → 403
  // =====================================================

  describe('member not linked / inactive / deleted → 403', () => {
    it('User.memberId=null → 403', async () => {
      const { authHeader } = await setupUnlinkedUser('p24a_user_nolink');
      expectBizError(await get('/api/app/v1/activities/available', authHeader), BizCode.FORBIDDEN);
    });

    it('Member.status=INACTIVE → 403', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p24a_inactive',
        memberNo: 'P24A-IA',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });
      expectBizError(await get('/api/app/v1/activities/available', authHeader), BizCode.FORBIDDEN);
    });

    it('Member.deletedAt!=null → 403', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p24a_deleted',
        memberNo: 'P24A-DEL',
      });
      await prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });
      expectBizError(await get('/api/app/v1/activities/available', authHeader), BizCode.FORBIDDEN);
    });
  });

  // =====================================================
  // 5. admin without member → 403(不沿 P2-3 例外)
  // =====================================================

  describe('admin without member → 403', () => {
    it.each([
      ['ADMIN 无 memberId → 403', Role.ADMIN],
      ['SUPER_ADMIN 无 memberId → 403', Role.SUPER_ADMIN],
    ] as const)('%s', async (_label, role) => {
      const { authHeader } = await setupUnlinkedUser(
        `p24a_admin_nomem_${role.toLowerCase()}`,
        role,
      );
      expectBizError(await get('/api/app/v1/activities/available', authHeader), BizCode.FORBIDDEN);
    });
  });

  // =====================================================
  // 6. admin-as-member → 200(可见集 = USER 兼队员零差异;沿 D-5.2)
  // =====================================================

  describe('admin-as-member → 200', () => {
    it('ADMIN + memberId + Member.ACTIVE → 200 + 仅 published(同 USER 兼队员)', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24a_admin_member',
        role: Role.ADMIN,
        memberNo: 'P24A-ADM',
      });
      // 同时造一个 draft,确认 admin 走 App 端点同样不见
      const draftInvisible = await createActivity('draft', 'admin-visible-test');
      await createActivity('published', 'admin-c');

      const res = await get('/api/app/v1/activities/available?pageSize=100', authHeader);
      expect(res.status).toBe(200);
      const data = res.body.data as { items: Array<{ id: string; statusCode: string }> };
      for (const item of data.items) {
        expect(item.statusCode).toBe('published');
      }
      expect(data.items.map((it) => it.id)).not.toContain(draftInvisible.id);
    });
  });

  // =====================================================
  // 7. pagination + forbidNonWhitelisted
  // =====================================================

  describe('pagination + forbidNonWhitelisted', () => {
    it('page=2 / pageSize=5 → 200 + total/page/pageSize 正确', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24a_page_user',
        memberNo: 'P24A-PG',
      });
      // 造足够多 published 活动确认分页字段语义
      for (let i = 0; i < 7; i++) {
        await createActivity('published', `pg-${i}`);
      }

      const res = await get('/api/app/v1/activities/available?page=2&pageSize=5', authHeader);
      expect(res.status).toBe(200);
      const data = res.body.data as {
        items: unknown[];
        total: number;
        page: number;
        pageSize: number;
      };
      expect(data.page).toBe(2);
      expect(data.pageSize).toBe(5);
      expect(data.total).toBeGreaterThanOrEqual(7);
    });

    it('pageSize=101 → 400(沿 PaginationQueryDto.@Max(100))', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24a_pgmax_user',
        memberNo: 'P24A-PGMAX',
      });
      expectBizError(
        await get('/api/app/v1/activities/available?pageSize=101', authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });

    // 沿 §9.1 v0 严格 2 参数;query 任何额外字段命中 forbidNonWhitelisted → 400
    it.each([
      ['statusCode=draft', 'statusCode=draft'],
      ['activityTypeCode', `activityTypeCode=${'training'}`],
      ['keyword', 'keyword=demo'],
      ['organizationId', 'organizationId=clxxx'],
      ['fromDate', 'fromDate=2026-01-01'],
      ['isPublicRegistration', 'isPublicRegistration=true'],
    ])('forbidNonWhitelisted query %s → 400', async (_label, qs) => {
      const { authHeader } = await setupLinkedUser({
        username: `p24a_q_${Math.random().toString(36).slice(2, 8)}`,
        memberNo: `P24A-Q-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      });
      expectBizError(
        await get(`/api/app/v1/activities/available?${qs}`, authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });
  });

  // =====================================================
  // 8. 旧 /api/admin/v1/activities 行为不变(沿 §11.4 + 风险表 13.12)
  // =====================================================

  describe('legacy /api/admin/v1/activities 行为不变', () => {
    it('ADMIN GET /api/admin/v1/activities 仍返既有 ActivityListItemDto 字段集', async () => {
      // 既有 ActivityListItemDto 字段集(沿 src/modules/activities/activities.dto.ts)
      const ADMIN_LEGACY_KEYS = [
        'id',
        'title',
        'activityTypeCode',
        'organizationId',
        'startAt',
        'endAt',
        'location',
        'description',
        'capacity',
        'genderRequirementCode',
        'registrationDeadline',
        'statusCode',
        'isPublicRegistration',
        // 保险 T3(2026-06-13,评审稿 insurance-module-review.md E-19):admin ListItem DTO
        // 加性新增 requiresInsurance,本锁同步 +1 字段(goal 明令的 DTO 变更之镜像,
        // 与 contract snapshot 同性质;App 侧字段集锁零修改 = App DTO 不动的反向证据)。
        'requiresInsurance',
        'coverImageUrl',
        'locationLongitude',
        'locationLatitude',
        'createdAt',
        'updatedAt',
      ].sort();

      // 用一个新 ADMIN 账号(不绑定 member),只为验证旧路径权限 + 字段集
      await createTestUser(app, { username: 'p24a_legacy_admin', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'p24a_legacy_admin');
      // 保证至少一条 published 活动可见
      await createActivity('published', 'legacy-1');

      const res = await get('/api/admin/v1/activities?pageSize=5', authHeader);
      expect(res.status).toBe(200);
      const data = res.body.data as { items: Array<Record<string, unknown>> };
      expect(data.items.length).toBeGreaterThan(0);
      for (const item of data.items) {
        // 字段集 = legacy(包含 organizationId / description / updatedAt 等 App 不返字段)
        expect(Object.keys(item).sort()).toEqual(ADMIN_LEGACY_KEYS);
      }
    });

    it('USER GET /api/admin/v1/activities Q-A7 仍仅返 published / completed', async () => {
      // 既有 USER 走 legacy 看 published + completed(沿 activities.service.ts Q-A7)
      await createTestUser(app, { username: 'p24a_legacy_user', role: Role.USER });
      const { authHeader } = await loginAs(app, 'p24a_legacy_user');
      await createActivity('published', 'legacy-u-pub');
      await createActivity('completed', 'legacy-u-cmp');
      await createActivity('draft', 'legacy-u-draft');

      const res = await get('/api/admin/v1/activities?pageSize=100', authHeader);
      expect(res.status).toBe(200);
      const data = res.body.data as { items: Array<{ statusCode: string }> };
      for (const it of data.items) {
        expect(['published', 'completed']).toContain(it.statusCode);
      }
    });
  });
});
