import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-5a App /api/app/v1/my/* registrations e2e。
// 沿 docs/app-api-p2-5-registrations-review.md §13.3 + §13.4 共 ~30 用例:
//   - 通用 9 类(success / unauth / member-not-linked / inactive / soft-deleted /
//     scope-self / sensitive-field-not-returned / admin-as-member / path-stability)
//   - `/my/activities` 6 项特殊用例(multiple-reg-same-activity / all-cancelled / only-reject /
//     activity-cancelled-after-register / filter-by-registrationStatusCode / empty-list)
//
// 准入沿 §7.1 / §7.3:canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 /
// Admin 无 member);**不**沿 D-P2-3-1 admin-without-member 例外。
//
// 数据范围沿 §7.6 + §11.6:where 永远含 memberId = currentUser.memberId;
// admin-as-member 走 linked-member self perspective(D-5.2);**不**因 role 看到他人。
//
// **关键铁律断言**:
//   - sensitive fields(memberId / reviewedBy / cancelledByUserId / member.memberNo /
//     member.displayName / deletedAt)永不出现在 App 响应
//   - MEMBER_NOT_FOUND=15001 永不透出到 App path(由 AppIdentityResolver 拦截)
//   - 旧 /api/v2/users/me/* 行为**逐字不变**(沿 §5.3 + §15.2 + 风险 14.13)

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// 字段集:AppMyRegistrationListItemDto 恰好 11 项(沿评审稿 §8.2.1 + §16.B.2 不返 memberId)
const APP_MY_REG_LIST_KEYS = [
  'activityCoverImageUrl',
  'activityEndAt',
  'activityId',
  'activityStartAt',
  'activityTitle',
  'cancelledAt',
  'createdAt',
  'id',
  'registeredAt',
  'reviewedAt',
  'statusCode',
].sort();

// AppMyRegistrationDto 恰好 11 项(沿评审稿 §8.2.2 + §16.B.2 不返 memberId)
const APP_MY_REG_DETAIL_KEYS = [
  'activityId',
  'cancelReason',
  'cancelledAt',
  'createdAt',
  'extras',
  'id',
  'registeredAt',
  'reviewNote',
  'reviewedAt',
  'statusCode',
  'updatedAt',
].sort();

// AppMyActivityListItemDto 恰好 11 项(沿评审稿 §8.2.3)
const APP_MY_ACT_LIST_KEYS = [
  'activityId',
  'activityTypeCode',
  'coverImageUrl',
  'endAt',
  'location',
  'myRegisteredAt',
  'myRegistrationId',
  'myRegistrationStatusCode',
  'startAt',
  'statusCode',
  'title',
].sort();

// 禁返字段(沿 §8.2.1 / §8.2.2 / §8.2.3 + 风险 14.1)
const REG_FORBIDDEN_KEYS = [
  'memberId',
  'memberNo',
  'memberDisplayName',
  'reviewedBy',
  'cancelledByUserId',
  'deletedAt',
  'member',
];

const ACT_FORBIDDEN_KEYS = [
  'capacity',
  'registrationDeadline',
  'description',
  'registrationNotes',
  'organizationId',
  'genderRequirementCode',
  'isPublicRegistration',
  'registrationSchema',
  'galleryImageUrls',
  'content',
  'locationLongitude',
  'locationLatitude',
  'publishedBy',
  'publishedAt',
  'cancelledBy',
  'cancelledAt',
  'cancelReason',
  'deletedAt',
  'updatedAt',
  'myRegistrationCount',
];

describe('App /api/app/v1/my/* (P2-5a 只读 3 endpoint)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let childOrgId: string;
  let activityTypeCode: string;

  // 单调递增计数器,确保跨 it 用例的 username / memberNo 不撞键。
  let seq = 0;
  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p25a-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p25a-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'P2-5a Root', nodeTypeCode: 'p25a-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'P2-5a Child', nodeTypeCode: 'p25a-child', parentId: rootOrg.id },
      select: { id: true },
    });
    childOrgId = childOrg.id;

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'p25a-training', label: '训练' },
      select: { code: true },
    });
    activityTypeCode = ti.code;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============== helpers ==============

  async function createMember(opts: {
    memberNo: string;
    status?: MemberStatus;
    deleted?: boolean;
  }): Promise<{ id: string }> {
    return prisma.member.create({
      data: {
        memberNo: opts.memberNo,
        displayName: 'Tester',
        status: opts.status ?? MemberStatus.ACTIVE,
        deletedAt: opts.deleted === true ? new Date() : null,
      },
      select: { id: true },
    });
  }

  async function setupLinkedUser(opts: {
    username: string;
    role?: Role;
    memberNo: string;
    memberStatus?: MemberStatus;
    memberDeleted?: boolean;
  }): Promise<{ userId: string; memberId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
    });
    const member = await createMember({
      memberNo: opts.memberNo,
      status: opts.memberStatus,
      deleted: opts.memberDeleted,
    });
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

  async function createActivity(
    state: 'draft' | 'published' | 'cancelled' | 'completed',
    titleSuffix: string,
  ): Promise<{ id: string }> {
    const base = {
      title: `P2-5a ${state} ${titleSuffix}`,
      activityTypeCode,
      organizationId: childOrgId,
      startAt: new Date('2026-07-01T08:00:00.000Z'),
      endAt: new Date('2026-07-01T12:00:00.000Z'),
      location: '梧桐山',
      coverImageUrl: 'https://example.test/cover.png',
      capacity: 30,
      registrationDeadline: new Date('2026-06-25T23:59:59.000Z'),
    };
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
    if (state === 'published') {
      return prisma.activity.create({
        data: { ...base, statusCode: 'published', publishedAt: new Date() },
        select: { id: true },
      });
    }
    return prisma.activity.create({ data: { ...base, statusCode: 'draft' }, select: { id: true } });
  }

  async function createRegistration(opts: {
    memberId: string;
    activityId: string;
    statusCode: 'pending' | 'pass' | 'reject' | 'cancelled';
    reviewNote?: string;
    cancelReason?: string;
    deleted?: boolean;
    extras?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    return prisma.activityRegistration.create({
      data: {
        memberId: opts.memberId,
        activityId: opts.activityId,
        statusCode: opts.statusCode,
        reviewNote: opts.reviewNote ?? null,
        cancelReason: opts.cancelReason ?? null,
        ...(opts.extras !== undefined
          ? { extras: opts.extras as Prisma.InputJsonValue }
          : {}),
        deletedAt: opts.deleted === true ? new Date() : null,
        ...(opts.statusCode === 'cancelled' ? { cancelledAt: new Date() } : {}),
        ...(opts.statusCode === 'pass' || opts.statusCode === 'reject'
          ? { reviewedAt: new Date() }
          : {}),
      },
      select: { id: true },
    });
  }

  const get = (path: string, authHeader?: string) => {
    const r = request(httpServer(app)).get(path);
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  // =====================================================
  // 1. GET /my/registrations success + 字段集
  // =====================================================

  describe('GET /my/registrations — success + 字段集', () => {
    it('200 + 字段集恰好 11 + 仅本人 + 不含 sensitive 字段', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-list-${u}`,
        memberNo: `P25A-L-${u}`,
      });
      const act1 = await createActivity('published', `list-a-${u}`);
      const act2 = await createActivity('published', `list-b-${u}`);
      await createRegistration({ memberId, activityId: act1.id, statusCode: 'pending' });
      await createRegistration({
        memberId,
        activityId: act2.id,
        statusCode: 'pass',
        reviewNote: 'looks good',
      });

      const res = await get('/api/app/v1/my/registrations', authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      const data = body.data as {
        items: Array<Record<string, unknown>>;
        total: number;
        page: number;
        pageSize: number;
      };
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(20);
      expect(data.items.length).toBeGreaterThanOrEqual(2);

      for (const item of data.items) {
        expect(Object.keys(item).sort()).toEqual(APP_MY_REG_LIST_KEYS);
        for (const forbidden of REG_FORBIDDEN_KEYS) {
          expect(item).not.toHaveProperty(forbidden);
        }
        // 派生字段一定有值
        expect(typeof item.activityTitle).toBe('string');
        expect(item.activityStartAt).toBeDefined();
      }
    });

    it('filter ?statusCode=pass 仅返 pass', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-flt-${u}`,
        memberNo: `P25A-F-${u}`,
      });
      const a = await createActivity('published', `flt-a-${u}`);
      const b = await createActivity('published', `flt-b-${u}`);
      await createRegistration({ memberId, activityId: a.id, statusCode: 'pending' });
      await createRegistration({ memberId, activityId: b.id, statusCode: 'pass' });

      const res = await get('/api/app/v1/my/registrations?statusCode=pass', authHeader);
      expect(res.status).toBe(200);
      const items = (res.body as ResBody).data.items as Array<{ statusCode: string }>;
      expect(items.length).toBeGreaterThanOrEqual(1);
      for (const it of items) {
        expect(it.statusCode).toBe('pass');
      }
    });

    it('pageSize=101 → 400', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-pg-${u}`,
        memberNo: `P25A-PG-${u}`,
      });
      expectBizError(
        await get('/api/app/v1/my/registrations?pageSize=101', authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });

    it('未声明 query 字段(activityId)→ 400(forbidNonWhitelisted;沿 §16.B.4 不支持 activityId filter)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-fnw-${u}`,
        memberNo: `P25A-FNW-${u}`,
      });
      expectBizError(
        await get('/api/app/v1/my/registrations?activityId=cabcdef12345', authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });

    it('scope-self:不能看到他人 registration', async () => {
      const u = nextSeq();
      const me = await setupLinkedUser({
        username: `p25a-self-${u}`,
        memberNo: `P25A-SELF-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25a-other-${u}`,
        memberNo: `P25A-OTHER-${u}`,
      });
      const act = await createActivity('published', `self-${u}`);
      await createRegistration({
        memberId: me.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      const otherReg = await createRegistration({
        memberId: other.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });

      const res = await get('/api/app/v1/my/registrations?pageSize=100', me.authHeader);
      expect(res.status).toBe(200);
      const items = (res.body as ResBody).data.items as Array<{ id: string }>;
      const ids = items.map((it) => it.id);
      expect(ids).not.toContain(otherReg.id);
    });

    it('admin-as-member:ADMIN + memberId 走 self perspective,看不到他人', async () => {
      const u = nextSeq();
      const admin = await setupLinkedUser({
        username: `p25a-adm-${u}`,
        role: Role.ADMIN,
        memberNo: `P25A-ADM-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25a-other2-${u}`,
        memberNo: `P25A-O2-${u}`,
      });
      const act = await createActivity('published', `adm-${u}`);
      await createRegistration({
        memberId: admin.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      const otherReg = await createRegistration({
        memberId: other.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });

      const res = await get('/api/app/v1/my/registrations?pageSize=100', admin.authHeader);
      expect(res.status).toBe(200);
      const items = (res.body as ResBody).data.items as Array<{ id: string }>;
      expect(items.map((it) => it.id)).not.toContain(otherReg.id);
    });

    it('软删 registration 不出现在列表', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-sdel-${u}`,
        memberNo: `P25A-SDEL-${u}`,
      });
      const act = await createActivity('published', `sdel-${u}`);
      const live = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      const act2 = await createActivity('published', `sdel-b-${u}`);
      const deleted = await createRegistration({
        memberId,
        activityId: act2.id,
        statusCode: 'pending',
        deleted: true,
      });

      const res = await get('/api/app/v1/my/registrations?pageSize=100', authHeader);
      const items = (res.body as ResBody).data.items as Array<{ id: string }>;
      const ids = items.map((it) => it.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(deleted.id);
    });
  });

  // =====================================================
  // 2. GET /my/registrations/:id success + owner
  // =====================================================

  describe('GET /my/registrations/:id — detail', () => {
    it('200 + 字段集恰好 11 + 不含 sensitive', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-det-${u}`,
        memberNo: `P25A-DET-${u}`,
      });
      const act = await createActivity('published', `det-${u}`);
      const reg = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'reject',
        reviewNote: 'docs incomplete',
        extras: { foo: 'bar' },
      });

      const res = await get(`/api/app/v1/my/registrations/${reg.id}`, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(Object.keys(data).sort()).toEqual(APP_MY_REG_DETAIL_KEYS);
      for (const forbidden of REG_FORBIDDEN_KEYS) {
        expect(data).not.toHaveProperty(forbidden);
      }
      expect(data.id).toBe(reg.id);
      expect(data.statusCode).toBe('reject');
      // L1 对本人:reviewNote 可返
      expect(data.reviewNote).toBe('docs incomplete');
      // extras 透传(沿 D-P2-5-12 不嵌套校验)
      expect(data.extras).toEqual({ foo: 'bar' });
    });

    it('他人 registration → 404 ACTIVITY_REGISTRATION_NOT_FOUND(防侧信道)', async () => {
      const u = nextSeq();
      const me = await setupLinkedUser({
        username: `p25a-ownme-${u}`,
        memberNo: `P25A-OWNME-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25a-ownot-${u}`,
        memberNo: `P25A-OWNOT-${u}`,
      });
      const act = await createActivity('published', `own-${u}`);
      const otherReg = await createRegistration({
        memberId: other.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });

      expectBizError(
        await get(`/api/app/v1/my/registrations/${otherReg.id}`, me.authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
    });

    it('不存在的 id → 404', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-nf-${u}`,
        memberNo: `P25A-NF-${u}`,
      });
      expectBizError(
        await get('/api/app/v1/my/registrations/cnonexistent00000', authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
    });

    it('软删 registration → 404', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-dets-${u}`,
        memberNo: `P25A-DETS-${u}`,
      });
      const act = await createActivity('published', `dets-${u}`);
      const reg = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
        deleted: true,
      });
      expectBizError(
        await get(`/api/app/v1/my/registrations/${reg.id}`, authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
    });

    it('IdParamDto 校验 → 400', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-iderr-${u}`,
        memberNo: `P25A-IDE-${u}`,
      });
      expectBizError(await get('/api/app/v1/my/registrations/x', authHeader), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
    });
  });

  // =====================================================
  // 3. GET /my/activities — success + derivation rules
  // =====================================================

  describe('GET /my/activities — 汇总', () => {
    it('200 + 字段集恰好 11 + 排除 forbidden', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-mya-${u}`,
        memberNo: `P25A-MYA-${u}`,
      });
      const act1 = await createActivity('published', `mya-a-${u}`);
      const act2 = await createActivity('published', `mya-b-${u}`);
      await createRegistration({ memberId, activityId: act1.id, statusCode: 'pending' });
      await createRegistration({ memberId, activityId: act2.id, statusCode: 'pass' });

      const res = await get('/api/app/v1/my/activities', authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data as {
        items: Array<Record<string, unknown>>;
        total: number;
      };
      expect(data.items.length).toBeGreaterThanOrEqual(2);
      expect(data.total).toBeGreaterThanOrEqual(2);
      for (const item of data.items) {
        expect(Object.keys(item).sort()).toEqual(APP_MY_ACT_LIST_KEYS);
        for (const f of ACT_FORBIDDEN_KEYS) {
          expect(item).not.toHaveProperty(f);
        }
      }
    });

    it('同活动多 registration → 取最新有效优先级 active > reject > cancelled', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-prio-${u}`,
        memberNo: `P25A-PRIO-${u}`,
      });
      const act = await createActivity('published', `prio-${u}`);
      // 老 cancelled
      await createRegistration({ memberId, activityId: act.id, statusCode: 'cancelled' });
      // 新 pending(active)
      const active = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
      });

      const res = await get('/api/app/v1/my/activities', authHeader);
      const items = (res.body as ResBody).data.items as Array<{
        activityId: string;
        myRegistrationId: string;
        myRegistrationStatusCode: string;
      }>;
      const row = items.find((it) => it.activityId === act.id);
      expect(row).toBeDefined();
      expect(row?.myRegistrationStatusCode).toBe('pending');
      expect(row?.myRegistrationId).toBe(active.id);
    });

    it('仅 cancelled 历史 → myRegistrationStatusCode=cancelled', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-canc-${u}`,
        memberNo: `P25A-CANC-${u}`,
      });
      const act = await createActivity('published', `canc-${u}`);
      const old = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'cancelled',
      });
      const res = await get('/api/app/v1/my/activities', authHeader);
      const row = (
        (res.body as ResBody).data.items as Array<{
          activityId: string;
          myRegistrationId: string;
          myRegistrationStatusCode: string;
        }>
      ).find((it) => it.activityId === act.id);
      expect(row?.myRegistrationStatusCode).toBe('cancelled');
      expect(row?.myRegistrationId).toBe(old.id);
    });

    it('仅 reject 历史 → myRegistrationStatusCode=reject', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-rej-${u}`,
        memberNo: `P25A-REJ-${u}`,
      });
      const act = await createActivity('published', `rej-${u}`);
      await createRegistration({ memberId, activityId: act.id, statusCode: 'reject' });
      const res = await get('/api/app/v1/my/activities', authHeader);
      const row = (
        (res.body as ResBody).data.items as Array<{
          activityId: string;
          myRegistrationStatusCode: string;
        }>
      ).find((it) => it.activityId === act.id);
      expect(row?.myRegistrationStatusCode).toBe('reject');
    });

    it('报名后活动被 cancelled:Activity.statusCode=cancelled + myRegistrationStatusCode 保留', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-actc-${u}`,
        memberNo: `P25A-ACTC-${u}`,
      });
      const act = await createActivity('published', `actc-${u}`);
      await createRegistration({ memberId, activityId: act.id, statusCode: 'pass' });
      // admin 取消活动
      await prisma.activity.update({
        where: { id: act.id },
        data: { statusCode: 'cancelled', cancelledAt: new Date() },
      });

      const res = await get('/api/app/v1/my/activities', authHeader);
      const row = (
        (res.body as ResBody).data.items as Array<{
          activityId: string;
          statusCode: string;
          myRegistrationStatusCode: string;
        }>
      ).find((it) => it.activityId === act.id);
      expect(row).toBeDefined();
      expect(row?.statusCode).toBe('cancelled');
      expect(row?.myRegistrationStatusCode).toBe('pass');
    });

    it('filter ?registrationStatusCode=pass 仅返 pass', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-flt2-${u}`,
        memberNo: `P25A-F2-${u}`,
      });
      const a = await createActivity('published', `flt2-a-${u}`);
      const b = await createActivity('published', `flt2-b-${u}`);
      await createRegistration({ memberId, activityId: a.id, statusCode: 'pending' });
      await createRegistration({ memberId, activityId: b.id, statusCode: 'pass' });

      const res = await get('/api/app/v1/my/activities?registrationStatusCode=pass', authHeader);
      const items = (res.body as ResBody).data.items as Array<{
        activityId: string;
        myRegistrationStatusCode: string;
      }>;
      for (const it of items) {
        expect(it.myRegistrationStatusCode).toBe('pass');
      }
      // 至少看到 b
      expect(items.map((it) => it.activityId)).toContain(b.id);
      // 不包含 a(它是 pending)
      expect(items.map((it) => it.activityId)).not.toContain(a.id);
    });

    it('empty-list:无任何 registration → items=[] / total=0', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-empty-${u}`,
        memberNo: `P25A-EMP-${u}`,
      });
      const res = await get('/api/app/v1/my/activities', authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data as {
        items: unknown[];
        total: number;
        page: number;
        pageSize: number;
      };
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(20);
    });

    it('全部 registration 软删 → 该活动不出现', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-asd-${u}`,
        memberNo: `P25A-ASD-${u}`,
      });
      const act = await createActivity('published', `asd-${u}`);
      await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
        deleted: true,
      });
      const res = await get('/api/app/v1/my/activities', authHeader);
      const items = (res.body as ResBody).data.items as Array<{ activityId: string }>;
      expect(items.map((it) => it.activityId)).not.toContain(act.id);
    });

    it('admin-as-member:仅本人活动汇总;不因 role 看到他人', async () => {
      const u = nextSeq();
      const admin = await setupLinkedUser({
        username: `p25a-admact-${u}`,
        role: Role.ADMIN,
        memberNo: `P25A-AA-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25a-othact-${u}`,
        memberNo: `P25A-OA-${u}`,
      });
      const mine = await createActivity('published', `mine-${u}`);
      const theirs = await createActivity('published', `theirs-${u}`);
      await createRegistration({
        memberId: admin.memberId,
        activityId: mine.id,
        statusCode: 'pending',
      });
      await createRegistration({
        memberId: other.memberId,
        activityId: theirs.id,
        statusCode: 'pending',
      });

      const res = await get('/api/app/v1/my/activities?pageSize=100', admin.authHeader);
      const ids = ((res.body as ResBody).data.items as Array<{ activityId: string }>).map(
        (it) => it.activityId,
      );
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });
  });

  // =====================================================
  // 4. unauthenticated → 401(3 endpoints × 2 cases)
  // =====================================================

  describe('unauthenticated → 401', () => {
    const PATHS = [
      '/api/app/v1/my/registrations',
      '/api/app/v1/my/registrations/cabcdef12345678',
      '/api/app/v1/my/activities',
    ];
    it.each(PATHS)('no token: %s → 401', async (path) => {
      expectBizError(await get(path), BizCode.UNAUTHORIZED);
    });
    it.each(PATHS)('bad token: %s → 401', async (path) => {
      expectBizError(await get(path, 'Bearer not-a-real-token'), BizCode.UNAUTHORIZED);
    });
  });

  // =====================================================
  // 5. canUseApp=false → 403(3 endpoints × 4 reasons)
  // =====================================================

  describe('canUseApp=false → 403(MEMBER_NOT_FOUND 不可透出)', () => {
    it('User.memberId=null → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25a-nl-${u}`);
      for (const path of ['/api/app/v1/my/registrations', '/api/app/v1/my/activities']) {
        expectBizError(await get(path, authHeader), BizCode.FORBIDDEN);
      }
    });

    it('Member.status=INACTIVE → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-ina-${u}`,
        memberNo: `P25A-IA-${u}`,
        memberStatus: MemberStatus.INACTIVE,
      });
      for (const path of ['/api/app/v1/my/registrations', '/api/app/v1/my/activities']) {
        expectBizError(await get(path, authHeader), BizCode.FORBIDDEN);
      }
    });

    it('Member.deletedAt != null → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25a-mdel-${u}`,
        memberNo: `P25A-MDEL-${u}`,
        memberDeleted: true,
      });
      for (const path of ['/api/app/v1/my/registrations', '/api/app/v1/my/activities']) {
        expectBizError(await get(path, authHeader), BizCode.FORBIDDEN);
      }
    });

    it.each([
      ['ADMIN 无 memberId → 403', Role.ADMIN],
      ['SUPER_ADMIN 无 memberId → 403', Role.SUPER_ADMIN],
    ] as const)('admin without member: %s', async (_label, role) => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25a-adm-${role.toLowerCase()}-${u}`, role);
      expectBizError(await get('/api/app/v1/my/registrations', authHeader), BizCode.FORBIDDEN);
      expectBizError(await get('/api/app/v1/my/activities', authHeader), BizCode.FORBIDDEN);
    });

    it('canUseApp=false 走 detail 也是 403,**不**透 ACTIVITY_REGISTRATION_NOT_FOUND', async () => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25a-detnl-${u}`);
      expectBizError(
        await get('/api/app/v1/my/registrations/cabcdef12345678', authHeader),
        BizCode.FORBIDDEN,
      );
    });
  });

  // =====================================================
  // 6. 旧 /api/v2/users/me/* 行为不变(沿 §5.3 + 风险 14.13)
  // =====================================================

  describe('legacy /api/v2/users/me/* 行为逐字不变', () => {
    it('GET /api/v2/users/me/registrations 仍返 admin DTO 字段集(含 memberId / memberNo / memberDisplayName)', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-lg-${u}`,
        memberNo: `P25A-LG-${u}`,
      });
      const act = await createActivity('published', `lg-${u}`);
      await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });

      const res = await get('/api/v2/users/me/registrations', authHeader);
      expect(res.status).toBe(200);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(1);
      const item = items[0];
      // legacy 应当含 memberId / memberNo / memberDisplayName(admin DTO)
      expect(item).toHaveProperty('memberId');
      expect(item).toHaveProperty('memberNo');
      expect(item).toHaveProperty('memberDisplayName');
    });

    it('GET /api/v2/users/me/registrations/:id 仍返 admin DTO(含 reviewedBy / cancelledByUserId)', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25a-lgd-${u}`,
        memberNo: `P25A-LGD-${u}`,
      });
      const act = await createActivity('published', `lgd-${u}`);
      const reg = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      const res = await get(`/api/v2/users/me/registrations/${reg.id}`, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(data).toHaveProperty('memberId');
      expect(data).toHaveProperty('reviewedBy');
      expect(data).toHaveProperty('cancelledByUserId');
    });
  });
});
