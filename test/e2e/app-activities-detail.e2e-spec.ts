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

// Phase 2 P2-4b App /api/app/v1/activities/:id 详情 e2e。
// 沿 docs/app-api-p2-4-activities-review.md §10.3 八类 it block;字段集恰好 13 项(沿 §5.1)。
//
// 准入沿 §6.1:JwtAuthGuard + AppIdentityResolver.resolve + canUseApp;
// canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 / Admin 无 member);
// 不沿 P2-3 admin-without-member 例外(沿 §6.2)。
//
// 可见性沿 D-P2-4-1 = A(v0.1 锁定):仅 statusCode='published' AND deletedAt IS NULL;
// draft / cancelled / completed / 软删 / 不存在 id 统一 → 404 ACTIVITY_NOT_FOUND
// (沿 D-P2-4-3 v0.1 锁定;避免存在性侧信道)。
//
// 旧 /api/admin/v1/activities/:id 行为**逐字不变**(沿 §11.4 + 风险表 13.12)。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// 字段集恰好 13 项(沿评审稿 §5.1 v0.1 锁定)。
const APP_DETAIL_KEYS = [
  'activityTypeCode',
  'capacity',
  'coverImageUrl',
  'createdAt',
  'description',
  'endAt',
  'id',
  'location',
  'registrationDeadline',
  'registrationNotes',
  'startAt',
  'statusCode',
  'title',
].sort();

// 字段反向集合(沿评审稿 §5.2 v0.1 锁定 + admin/audit 字段)。
const FORBIDDEN_KEYS_ON_DETAIL = [
  'registrationSchema',
  'galleryImageUrls',
  'content',
  'locationLongitude',
  'locationLatitude',
  'updatedAt',
  'organizationId',
  'genderRequirementCode',
  'isPublicRegistration',
  'deletedAt',
  'publishedBy',
  'publishedAt',
  'cancelledBy',
  'cancelledAt',
  'cancelReason',
];

describe('App GET /api/app/v1/activities/:id (P2-4b)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let childOrgId: string;
  let activityTypeCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 字典 + 组织 fixture(沿 app-activities-available.e2e-spec.ts 范式)。
    const nodeTypeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'p2-4b-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'p2-4b-child', label: '子' },
    });

    const root = await prisma.organization.create({
      data: { name: 'P2-4b Root', nodeTypeCode: 'p2-4b-root', parentId: null },
      select: { id: true },
    });
    const child = await prisma.organization.create({
      data: { name: 'P2-4b Child', nodeTypeCode: 'p2-4b-child', parentId: root.id },
      select: { id: true },
    });
    childOrgId = child.id;

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const actTypeActive = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'p2-4b-training', label: '训练' },
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
      title: `P2-4b ${state} ${titleSuffix}`,
      activityTypeCode,
      organizationId: childOrgId,
      startAt: new Date('2026-07-01T08:00:00.000Z'),
      endAt: new Date('2026-07-01T12:00:00.000Z'),
      location: '梧桐山',
      description: 'P2-4b 详情测试用活动描述',
      registrationNotes: 'P2-4b 报名须知',
      coverImageUrl: 'https://example.test/cover.png',
      capacity: 30,
      registrationDeadline: new Date('2026-06-25T23:59:59.000Z'),
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
  // 1. success published + 字段集恰好 13 项
  // =====================================================

  describe('success + 字段集恰好 13 项', () => {
    it('200 + statusCode=published + 字段集恰好 13', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24b_success_user',
        memberNo: 'P24B-S1',
      });
      const activity = await createActivity('published', 'success');

      const res = await get(`/api/app/v1/activities/${activity.id}`, authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      expect(body.message).toBe('ok');

      const data = body.data;
      expect(Object.keys(data).sort()).toEqual(APP_DETAIL_KEYS);
      expect(data.id).toBe(activity.id);
      expect(data.statusCode).toBe('published');

      for (const forbiddenKey of FORBIDDEN_KEYS_ON_DETAIL) {
        expect(data).not.toHaveProperty(forbiddenKey);
      }
    });
  });

  // =====================================================
  // 2. draft / cancelled / completed / 软删 / 不存在 → 404
  // =====================================================

  describe('不可见统一 → 404 ACTIVITY_NOT_FOUND', () => {
    // 注:username 必须全小写(auth.service 登录前 trim().toLowerCase())。
    it.each([
      ['draft', 'draft'],
      ['cancelled', 'cancelled'],
      ['completed', 'completed'],
      ['softdeleted', 'softDeleted'],
    ] as const)('%s 状态 → 404', async (label, state) => {
      const { authHeader } = await setupLinkedUser({
        username: `p24b_inv_${label}`,
        memberNo: `P24B-INV-${label.substring(0, 3).toUpperCase()}`,
      });
      const invisible = await createActivity(state, `inv-${label}`);
      expectBizError(
        await get(`/api/app/v1/activities/${invisible.id}`, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('不存在的 id → 404', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24b_notfound',
        memberNo: 'P24B-NF',
      });
      // 长度 ≥ 8 通过 IdParamDto,确保命中 service 而非 ValidationPipe
      expectBizError(
        await get('/api/app/v1/activities/cnonexistent00000', authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
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
      // 即使 id 命中不存在,也必须先走 JwtAuthGuard
      expectBizError(
        await get('/api/app/v1/activities/cl9z3a8b00000abcd1234efgh', authHeader),
        BizCode.UNAUTHORIZED,
      );
    });
  });

  // =====================================================
  // 4. member not linked / inactive / deleted → 403
  // =====================================================

  describe('member not linked / inactive / deleted → 403', () => {
    it('User.memberId=null → 403', async () => {
      const { authHeader } = await setupUnlinkedUser('p24b_user_nolink');
      const activity = await createActivity('published', 'access-nolink');
      expectBizError(
        await get(`/api/app/v1/activities/${activity.id}`, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('Member.status=INACTIVE → 403', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p24b_inactive',
        memberNo: 'P24B-IA',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });
      const activity = await createActivity('published', 'access-inactive');
      expectBizError(
        await get(`/api/app/v1/activities/${activity.id}`, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('Member.deletedAt!=null → 403', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p24b_deleted',
        memberNo: 'P24B-DEL',
      });
      await prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });
      const activity = await createActivity('published', 'access-deleted');
      expectBizError(
        await get(`/api/app/v1/activities/${activity.id}`, authHeader),
        BizCode.FORBIDDEN,
      );
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
        `p24b_admin_nomem_${role.toLowerCase()}`,
        role,
      );
      const activity = await createActivity('published', `access-admin-nomem-${role}`);
      expectBizError(
        await get(`/api/app/v1/activities/${activity.id}`, authHeader),
        BizCode.FORBIDDEN,
      );
    });
  });

  // =====================================================
  // 6. admin-as-member → 200(沿 D-5.2 self perspective)
  // =====================================================

  describe('admin-as-member → 200', () => {
    it('ADMIN + memberId + Member.ACTIVE → 200 + 字段集与 USER 兼队员一致', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24b_admin_member',
        role: Role.ADMIN,
        memberNo: 'P24B-ADM',
      });
      const activity = await createActivity('published', 'admin-member');

      const res = await get(`/api/app/v1/activities/${activity.id}`, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(Object.keys(data).sort()).toEqual(APP_DETAIL_KEYS);
      expect(data.statusCode).toBe('published');
    });

    it('ADMIN 兼队员看 draft 同样 → 404(self perspective;不因 role 扩大范围)', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p24b_admin_draft',
        role: Role.ADMIN,
        memberNo: 'P24B-ADM-DR',
      });
      const draft = await createActivity('draft', 'admin-draft-invisible');
      expectBizError(
        await get(`/api/app/v1/activities/${draft.id}`, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });
  });

  // =====================================================
  // 7. IdParamDto 反向 → 400
  // =====================================================

  describe('IdParamDto 校验 → 400', () => {
    it.each([
      ['长度 < 8', 'ab12'],
      ['长度 > 64', 'a'.repeat(65)],
    ])('id %s → 400', async (_label, badId) => {
      const { authHeader } = await setupLinkedUser({
        username: `p24b_id_${Math.random().toString(36).slice(2, 8)}`,
        memberNo: `P24B-ID-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      });
      expectBizError(
        await get(`/api/app/v1/activities/${badId}`, authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });
  });

  // =====================================================
  // 8. 旧 /api/admin/v1/activities/:id 行为不变(沿 §11.4 + 风险表 13.12)
  // =====================================================

  describe('legacy /api/admin/v1/activities/:id 行为不变', () => {
    it('ADMIN GET /api/admin/v1/activities/:id draft 仍 200 + 看到全字段(含 organizationId)', async () => {
      await createTestUser(app, { username: 'p24b_legacy_admin', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'p24b_legacy_admin');
      const draft = await createActivity('draft', 'legacy-admin-draft');

      const res = await get(`/api/admin/v1/activities/${draft.id}`, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      // 旧 admin 视角看到 organizationId(App 视角永不返,沿 §5.2)
      expect(data).toHaveProperty('organizationId');
      expect(data.statusCode).toBe('draft');
    });

    it('USER GET /api/admin/v1/activities/:id draft 仍 404(沿 v2 Q-A7)', async () => {
      await createTestUser(app, { username: 'p24b_legacy_user', role: Role.USER });
      const { authHeader } = await loginAs(app, 'p24b_legacy_user');
      const draft = await createActivity('draft', 'legacy-user-draft');
      expectBizError(
        await get(`/api/admin/v1/activities/${draft.id}`, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('ADMIN GET /api/admin/v1/activities/:id cancelled 仍 200 + 看到 cancelReason', async () => {
      await createTestUser(app, { username: 'p24b_legacy_admin_cx', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'p24b_legacy_admin_cx');
      const cancelled = await createActivity('cancelled', 'legacy-admin-cancelled');

      const res = await get(`/api/admin/v1/activities/${cancelled.id}`, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(data.cancelReason).toBe('test cancel');
      expect(data.statusCode).toBe('cancelled');
    });
  });
});
