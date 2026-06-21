import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-5b App /api/app/v1/my/* registrations write e2e。
// 沿 docs/app-api-p2-5-registrations-review.md §13.5 + §13.6 共 30+ 用例:
//   - 通用 9 类(success / unauth / member-not-linked / inactive / soft-deleted /
//     scope-self / sensitive-field-not-returned / admin-as-member / path-stability)
//   - 写专项 11 项(activity-not-found / draft / cancelled / completed / not-public /
//     duplicate-submit / capacity-exceeded / invalid-state-cancel / not-owner-cancel /
//     audit-write / admin-as-member-cancel)
//
// 准入沿 §7.1 / §7.3:canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 /
// Admin 无 member);**不**沿 D-P2-3-1 admin-without-member 例外(沿 §7.4)。
//
// D-P2-5-8 锁定:**非 published(draft / cancelled / completed / 软删 / 不存在)
// 统一 ACTIVITY_NOT_FOUND=20001**;published + isPublicRegistration=false → 20120。
//
// 复用既有 audit event(沿 §12.1):POST → registration.create + viaPath='self';
// PATCH cancel → registration.review + action='cancel' + cancelledByPath='self'。
//
// **关键铁律断言**:
//   - sensitive fields(memberId / reviewedBy / cancelledByUserId)永不出现在 App 响应
//   - MEMBER_NOT_FOUND=15001 不透出到 App path(由 AppIdentityResolver 拦截)
//   - 取消他人 / 不存在 / 软删 registration 统一 21001 / 404 防侧信道
// 注:旧 v2 队员自助写路径已在 API surface 迁移(Route B)中删除,行为改由本 App 套件覆盖。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

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

// 禁返字段(沿 §8.2.1 / §8.2.2 + 风险 14.1)
const REG_FORBIDDEN_KEYS = [
  'memberId',
  'memberNo',
  'memberDisplayName',
  'reviewedBy',
  'cancelledByUserId',
  'deletedAt',
  'member',
];

describe('App /api/app/v1/my/* (P2-5b 写 2 endpoint)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let childOrgId: string;
  let activityTypeCode: string;

  // 单调递增计数器,确保跨 it 用例的 username / memberNo / activity title 不撞键。
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
      data: { typeId: nodeDict.id, code: 'p25b-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p25b-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'P2-5b Root', nodeTypeCode: 'p25b-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'P2-5b Child', nodeTypeCode: 'p25b-child', parentId: rootOrg.id },
      select: { id: true },
    });
    childOrgId = childOrg.id;

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'p25b-training', label: '训练' },
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
    opts: {
      isPublicRegistration?: boolean;
      capacity?: number | null;
      registrationDeadline?: Date;
    } = {},
  ): Promise<{ id: string }> {
    const base = {
      title: `P2-5b ${state} ${titleSuffix}`,
      activityTypeCode,
      organizationId: childOrgId,
      startAt: new Date('2026-07-01T08:00:00.000Z'),
      endAt: new Date('2026-07-01T12:00:00.000Z'),
      location: '梧桐山',
      coverImageUrl: 'https://example.test/cover.png',
      capacity: opts.capacity === undefined ? 30 : opts.capacity,
      isPublicRegistration: opts.isPublicRegistration ?? true,
      // 默认 2026-06-25(晚于当前 2026-06-21,不触发截止闸);需要测截止时显式传过去时刻。
      registrationDeadline: opts.registrationDeadline ?? new Date('2026-06-25T23:59:59.000Z'),
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
    deleted?: boolean;
  }): Promise<{ id: string }> {
    return prisma.activityRegistration.create({
      data: {
        memberId: opts.memberId,
        activityId: opts.activityId,
        statusCode: opts.statusCode,
        deletedAt: opts.deleted === true ? new Date() : null,
        ...(opts.statusCode === 'cancelled' ? { cancelledAt: new Date() } : {}),
        ...(opts.statusCode === 'pass' || opts.statusCode === 'reject'
          ? { reviewedAt: new Date() }
          : {}),
      },
      select: { id: true },
    });
  }

  const APP_POST = '/api/app/v1/my/registrations';
  const appPatchCancel = (id: string): string => `/api/app/v1/my/registrations/${id}/cancel`;

  const post = (path: string, body: object, authHeader?: string) => {
    const r = request(httpServer(app)).post(path).send(body);
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  const patch = (path: string, body: object, authHeader?: string) => {
    const r = request(httpServer(app)).patch(path).send(body);
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  // =====================================================
  // 1. POST /my/registrations — success + 字段集
  // =====================================================

  describe('POST /my/registrations — success + 字段集', () => {
    it('success: 200 + 字段集恰好 11 + 不返 sensitive + statusCode=pending', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-c-${u}`,
        memberNo: `P25B-C-${u}`,
      });
      const act = await createActivity('published', `c-${u}`);

      const res = await post(APP_POST, { activityId: act.id }, authHeader);
      // POST 沿 NestJS 默认返 201(沿 admin POST 范式;OpenAPI 文档由 @ApiWrappedOkResponse 标 200,实际运行 201)
      expect(res.status).toBe(201);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      const data = body.data;
      expect(Object.keys(data).sort()).toEqual(APP_MY_REG_DETAIL_KEYS);
      for (const f of REG_FORBIDDEN_KEYS) {
        expect(data).not.toHaveProperty(f);
      }
      expect(data.activityId).toBe(act.id);
      expect(data.statusCode).toBe('pending');
      expect(data.extras).toBeNull();

      // DB 落地核对(memberId 必须 = 当前用户 memberId,反越权)
      const dbRow = await prisma.activityRegistration.findFirst({
        where: { activityId: act.id, memberId, deletedAt: null },
        select: { id: true, statusCode: true },
      });
      expect(dbRow).not.toBeNull();
      expect(dbRow!.statusCode).toBe('pending');
    });

    it('截止后(deadline 已过)→ 自助报名拒 ACTIVITY_REGISTRATION_DEADLINE_PASSED', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-dl-${u}`,
        memberNo: `P25B-DL-${u}`,
      });
      // published + public,但报名截止已过 → 经 createMy → assertActivityRegistrable 截止闸(20123)。
      const act = await createActivity('published', `dl-${u}`, {
        registrationDeadline: new Date('2020-01-01T00:00:00.000Z'),
      });
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
      );
    });

    it('success with extras: extras 透传(不嵌套校验,沿 D-P2-5-12)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-cx-${u}`,
        memberNo: `P25B-CX-${u}`,
      });
      const act = await createActivity('published', `cx-${u}`);
      const res = await post(
        APP_POST,
        { activityId: act.id, extras: { dietary: 'vegetarian', note: 'arrive early' } },
        authHeader,
      );
      expect(res.status).toBe(201);
      const data = (res.body as ResBody).data;
      expect(data.extras).toEqual({ dietary: 'vegetarian', note: 'arrive early' });
    });

    it('forbidden field memberId in body → 400 BAD_REQUEST(forbidNonWhitelisted)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-fnw-${u}`,
        memberNo: `P25B-FNW-${u}`,
      });
      const act = await createActivity('published', `fnw-${u}`);
      expectBizError(
        await post(APP_POST, { activityId: act.id, memberId: 'other' }, authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });

    it('missing activityId → 400', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-na-${u}`,
        memberNo: `P25B-NA-${u}`,
      });
      expectBizError(await post(APP_POST, {}, authHeader), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
    });
  });

  // =====================================================
  // 2. PATCH /my/registrations/:id/cancel — success
  // =====================================================

  describe('PATCH /my/registrations/:id/cancel — success', () => {
    it('pending → cancelled 200 + 字段集 11 + 不返 sensitive', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-x-${u}`,
        memberNo: `P25B-X-${u}`,
      });
      const act = await createActivity('published', `x-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });

      const res = await patch(appPatchCancel(reg.id), { cancelReason: 'plan change' }, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(Object.keys(data).sort()).toEqual(APP_MY_REG_DETAIL_KEYS);
      for (const f of REG_FORBIDDEN_KEYS) {
        expect(data).not.toHaveProperty(f);
      }
      expect(data.statusCode).toBe('cancelled');
      expect(data.cancelReason).toBe('plan change');
      expect(data.cancelledAt).not.toBeNull();
    });

    it('pass → cancelled 200', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-xp-${u}`,
        memberNo: `P25B-XP-${u}`,
      });
      const act = await createActivity('published', `xp-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pass' });
      const res = await patch(appPatchCancel(reg.id), {}, authHeader);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(data.statusCode).toBe('cancelled');
      // cancelReason 可选,未传保持 null
      expect(data.cancelReason).toBeNull();
    });

    it('cancelReason 可选(沿 D-P2-5-9):body 不带也接受', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-xn-${u}`,
        memberNo: `P25B-XN-${u}`,
      });
      const act = await createActivity('published', `xn-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });
      const res = await patch(appPatchCancel(reg.id), {}, authHeader);
      expect(res.status).toBe(200);
    });

    it('cancelReason maxLength 超 500 → 400', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-xl-${u}`,
        memberNo: `P25B-XL-${u}`,
      });
      const act = await createActivity('published', `xl-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });
      expectBizError(
        await patch(appPatchCancel(reg.id), { cancelReason: 'x'.repeat(501) }, authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });

    it('forbidden field statusCode in body → 400', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-xfnw-${u}`,
        memberNo: `P25B-XFNW-${u}`,
      });
      const act = await createActivity('published', `xfnw-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });
      expectBizError(
        await patch(appPatchCancel(reg.id), { statusCode: 'cancelled' }, authHeader),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    });
  });

  // =====================================================
  // 3. unauthenticated → 401(2 endpoints × 2 cases)
  // =====================================================

  describe('unauthenticated → 401', () => {
    it('POST no token → 401', async () => {
      expectBizError(await post(APP_POST, { activityId: 'cabcdef12345' }), BizCode.UNAUTHORIZED);
    });
    it('POST bad token → 401', async () => {
      const r = await post(APP_POST, { activityId: 'cabcdef12345' }, 'Bearer not-a-real-token');
      expectBizError(r, BizCode.UNAUTHORIZED);
    });
    it('PATCH no token → 401', async () => {
      expectBizError(await patch(appPatchCancel('cabcdef12345'), {}), BizCode.UNAUTHORIZED);
    });
    it('PATCH bad token → 401', async () => {
      const r = await patch(appPatchCancel('cabcdef12345'), {}, 'Bearer not-a-real-token');
      expectBizError(r, BizCode.UNAUTHORIZED);
    });
  });

  // =====================================================
  // 4. canUseApp=false → 403(2 endpoints × 4 reasons;不透 MEMBER_NOT_FOUND=15001)
  // =====================================================

  describe('canUseApp=false → 403(MEMBER_NOT_FOUND 不可透出)', () => {
    it('POST: User.memberId=null → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25b-nl-${u}`);
      const act = await createActivity('published', `nl-${u}`);
      expectBizError(await post(APP_POST, { activityId: act.id }, authHeader), BizCode.FORBIDDEN);
    });

    it('POST: Member.status=INACTIVE → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-ina-${u}`,
        memberNo: `P25B-IA-${u}`,
        memberStatus: MemberStatus.INACTIVE,
      });
      const act = await createActivity('published', `ina-${u}`);
      expectBizError(await post(APP_POST, { activityId: act.id }, authHeader), BizCode.FORBIDDEN);
    });

    it('POST: Member.deletedAt != null → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-mdel-${u}`,
        memberNo: `P25B-MDEL-${u}`,
        memberDeleted: true,
      });
      const act = await createActivity('published', `mdel-${u}`);
      expectBizError(await post(APP_POST, { activityId: act.id }, authHeader), BizCode.FORBIDDEN);
    });

    it.each([
      ['ADMIN', Role.ADMIN],
      ['SUPER_ADMIN', Role.SUPER_ADMIN],
    ] as const)('POST: %s 无 memberId → 403', async (_label, role) => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25b-adm-${role.toLowerCase()}-${u}`, role);
      const act = await createActivity('published', `adm-${u}`);
      expectBizError(await post(APP_POST, { activityId: act.id }, authHeader), BizCode.FORBIDDEN);
    });

    it('PATCH: User.memberId=null → 403(不透 21001)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25b-pnl-${u}`);
      expectBizError(
        await patch(appPatchCancel('cabcdef12345'), {}, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('PATCH: Member.status=INACTIVE → 403', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-pina-${u}`,
        memberNo: `P25B-PIA-${u}`,
        memberStatus: MemberStatus.INACTIVE,
      });
      expectBizError(
        await patch(appPatchCancel('cabcdef12345'), {}, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it.each([
      ['ADMIN', Role.ADMIN],
      ['SUPER_ADMIN', Role.SUPER_ADMIN],
    ] as const)('PATCH: %s 无 memberId → 403', async (_label, role) => {
      const u = nextSeq();
      const { authHeader } = await setupUnlinkedUser(`p25b-padm-${role.toLowerCase()}-${u}`, role);
      expectBizError(
        await patch(appPatchCancel('cabcdef12345'), {}, authHeader),
        BizCode.FORBIDDEN,
      );
    });
  });

  // =====================================================
  // 5. D-P2-5-8 published-only 防侧信道(关键铁律)
  // =====================================================

  describe('D-P2-5-8 published-only:非 published 活动统一 ACTIVITY_NOT_FOUND=20001', () => {
    it('activity not found → 20001', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-anf-${u}`,
        memberNo: `P25B-ANF-${u}`,
      });
      expectBizError(
        await post(APP_POST, { activityId: 'cnoexistent00000' }, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('activity draft → 20001(关键铁律:不暴露 draft 存在)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-dr-${u}`,
        memberNo: `P25B-DR-${u}`,
      });
      const act = await createActivity('draft', `dr-${u}`);
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('activity cancelled → 20001(关键铁律:**不**触达 ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN=20121)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-ac-${u}`,
        memberNo: `P25B-AC-${u}`,
      });
      const act = await createActivity('cancelled', `ac-${u}`);
      const res = await post(APP_POST, { activityId: act.id }, authHeader);
      // 严格断言 20001 而非 20121(沿评审稿 §9.3 行为矩阵)
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
      expect((res.body as ResBody).code).toBe(20001);
      expect((res.body as ResBody).code).not.toBe(20121);
    });

    it('activity completed → 20001', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-cp-${u}`,
        memberNo: `P25B-CP-${u}`,
      });
      const act = await createActivity('completed', `cp-${u}`);
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('activity soft-deleted (published 状态但 deletedAt!=null) → 20001', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-sd-${u}`,
        memberNo: `P25B-SD-${u}`,
      });
      const act = await createActivity('published', `sd-${u}`);
      await prisma.activity.update({
        where: { id: act.id },
        data: { deletedAt: new Date() },
      });
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });

    it('published + isPublicRegistration=false → 20120(沿 §9.3 边界 + §16.B.7 默认)', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-np-${u}`,
        memberNo: `P25B-NP-${u}`,
      });
      const act = await createActivity('published', `np-${u}`, { isPublicRegistration: false });
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
      );
    });
  });

  // =====================================================
  // 6. write conflicts:duplicate / capacity / state machine / owner
  // =====================================================

  describe('write conflicts', () => {
    it('duplicate submit → 21002', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-dup-${u}`,
        memberNo: `P25B-DUP-${u}`,
      });
      const act = await createActivity('published', `dup-${u}`);
      // 先造一条 active registration
      await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS,
      );
    });

    it('capacity exceeded → 21032', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-cap-${u}`,
        memberNo: `P25B-CAP-${u}`,
      });
      // 容量 = 1,且已有 1 名 pass 占用
      const act = await createActivity('published', `cap-${u}`, { capacity: 1 });
      const occupant = await createMember({ memberNo: `P25B-OCC-${u}` });
      await createRegistration({
        memberId: occupant.id,
        activityId: act.id,
        statusCode: 'pass',
      });
      expectBizError(
        await post(APP_POST, { activityId: act.id }, authHeader),
        BizCode.ACTIVITY_CAPACITY_EXCEEDED,
      );
    });

    it('cancel reject 状态 → 21030', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-cr-${u}`,
        memberNo: `P25B-CR-${u}`,
      });
      const act = await createActivity('published', `cr-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'reject' });
      expectBizError(
        await patch(appPatchCancel(reg.id), {}, authHeader),
        BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      );
    });

    it('cancel already cancelled → 21030', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-cc-${u}`,
        memberNo: `P25B-CC-${u}`,
      });
      const act = await createActivity('published', `cc-${u}`);
      const reg = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'cancelled',
      });
      expectBizError(
        await patch(appPatchCancel(reg.id), {}, authHeader),
        BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      );
    });

    it('cancel 他人 registration → 21001 / 404 防侧信道', async () => {
      const u = nextSeq();
      const me = await setupLinkedUser({
        username: `p25b-meo-${u}`,
        memberNo: `P25B-MEO-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25b-oth-${u}`,
        memberNo: `P25B-OTH-${u}`,
      });
      const act = await createActivity('published', `oth-${u}`);
      const otherReg = await createRegistration({
        memberId: other.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      expectBizError(
        await patch(appPatchCancel(otherReg.id), {}, me.authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
      // 反向验证:他人 registration 仍是 pending(未被改动)
      const stillPending = await prisma.activityRegistration.findFirst({
        where: { id: otherReg.id },
        select: { statusCode: true },
      });
      expect(stillPending!.statusCode).toBe('pending');
    });

    it('cancel 不存在 id → 21001 / 404', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-nfid-${u}`,
        memberNo: `P25B-NFID-${u}`,
      });
      expectBizError(
        await patch(appPatchCancel('cnonexistent00000'), {}, authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
    });

    it('cancel 软删 registration → 21001 / 404', async () => {
      const u = nextSeq();
      const { memberId, authHeader } = await setupLinkedUser({
        username: `p25b-sdr-${u}`,
        memberNo: `P25B-SDR-${u}`,
      });
      const act = await createActivity('published', `sdr-${u}`);
      const reg = await createRegistration({
        memberId,
        activityId: act.id,
        statusCode: 'pending',
        deleted: true,
      });
      expectBizError(
        await patch(appPatchCancel(reg.id), {}, authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
    });

    it('PATCH: IdParamDto 校验失败 → 400', async () => {
      const u = nextSeq();
      const { authHeader } = await setupLinkedUser({
        username: `p25b-ider-${u}`,
        memberNo: `P25B-IDE-${u}`,
      });
      expectBizError(await patch(appPatchCancel('x'), {}, authHeader), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
    });
  });

  // =====================================================
  // 7. scope-self / admin-as-member(沿 D-5.2)
  // =====================================================

  describe('scope-self / admin-as-member', () => {
    it('POST: ADMIN + linked member 走 self perspective,memberId = adminUser.memberId', async () => {
      const u = nextSeq();
      const admin = await setupLinkedUser({
        username: `p25b-aac-${u}`,
        role: Role.ADMIN,
        memberNo: `P25B-AAC-${u}`,
      });
      // 制造另一个 member,确保即便有 admin role 也不会创建到他人
      const other = await createMember({ memberNo: `P25B-AACO-${u}` });
      const act = await createActivity('published', `aac-${u}`);

      const res = await post(APP_POST, { activityId: act.id }, admin.authHeader);
      expect(res.status).toBe(201);

      const dbRow = await prisma.activityRegistration.findFirst({
        where: { activityId: act.id, deletedAt: null },
        select: { memberId: true },
      });
      expect(dbRow!.memberId).toBe(admin.memberId);
      expect(dbRow!.memberId).not.toBe(other.id);
    });

    it('PATCH: ADMIN 不能通过 App path 取消他人 registration → 21001 / 404', async () => {
      const u = nextSeq();
      const admin = await setupLinkedUser({
        username: `p25b-axo-${u}`,
        role: Role.ADMIN,
        memberNo: `P25B-AXO-${u}`,
      });
      const other = await setupLinkedUser({
        username: `p25b-axo-o-${u}`,
        memberNo: `P25B-AXOO-${u}`,
      });
      const act = await createActivity('published', `axo-${u}`);
      const otherReg = await createRegistration({
        memberId: other.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });

      expectBizError(
        await patch(appPatchCancel(otherReg.id), {}, admin.authHeader),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
      // 反向验证:他人 registration 状态未变
      const stillPending = await prisma.activityRegistration.findFirst({
        where: { id: otherReg.id },
        select: { statusCode: true },
      });
      expect(stillPending!.statusCode).toBe('pending');
    });

    it('PATCH: ADMIN 取消本人 registration 成功', async () => {
      const u = nextSeq();
      const admin = await setupLinkedUser({
        username: `p25b-axs-${u}`,
        role: Role.ADMIN,
        memberNo: `P25B-AXS-${u}`,
      });
      const act = await createActivity('published', `axs-${u}`);
      const reg = await createRegistration({
        memberId: admin.memberId,
        activityId: act.id,
        statusCode: 'pending',
      });
      const res = await patch(appPatchCancel(reg.id), {}, admin.authHeader);
      expect(res.status).toBe(200);
      expect((res.body as ResBody).data.statusCode).toBe('cancelled');
    });
  });

  // =====================================================
  // 8. audit_logs(沿 §12.1:复用 registration.create / registration.review)
  // =====================================================

  describe('audit_logs(复用既有 event;不新增 surface=app)', () => {
    it('POST 成功后写入 registration.create + viaPath=self;不含 raw L3', async () => {
      await truncateAuditLogsTestOnly(app);
      const u = nextSeq();
      const { userId, memberId, authHeader } = await setupLinkedUser({
        username: `p25b-au1-${u}`,
        memberNo: `P25B-AU1-${u}`,
      });
      const act = await createActivity('published', `au1-${u}`);

      const before = await prisma.auditLog.count();
      const res = await post(APP_POST, { activityId: act.id }, authHeader);
      // POST 沿 NestJS 默认返 201(沿 admin POST 范式;OpenAPI 文档由 @ApiWrappedOkResponse 标 200,实际运行 201)
      expect(res.status).toBe(201);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before + 1);

      const log = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
      expect(log).not.toBeNull();
      expect(log!.event).toBe('registration.create');
      expect(log!.actorUserId).toBe(userId);
      expect(log!.actorRoleSnap).toBe(Role.USER);
      expect(log!.resourceType).toBe('activity_registration');
      expect(log!.success).toBe(true);

      // AuditContext: 服务端在 context Json 字段下分 before / after / extra(沿
      // audit-logs.types.ts AuditContext);本期复用既有结构,**不**读 log.extra(无此列)。
      const ctx = log!.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra.operation).toBe('create');
      expect(extra.viaPath).toBe('self'); // 关键:沿现状 createMy viaPath='self'
      expect(extra.activityId).toBe(act.id);
      expect(extra.targetMemberId).toBe(memberId);

      // 沿评审稿 §12.3:audit 序列化不得含 raw L3(refreshToken / tokenHash / passwordHash / bcrypt prefix)
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain('refreshToken');
      expect(serialized).not.toContain('tokenHash');
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('$2'); // bcrypt hash 前缀
    });

    it('PATCH cancel 成功后写入 registration.review + action=cancel + cancelledByPath=self', async () => {
      await truncateAuditLogsTestOnly(app);
      const u = nextSeq();
      const { userId, memberId, authHeader } = await setupLinkedUser({
        username: `p25b-au2-${u}`,
        memberNo: `P25B-AU2-${u}`,
      });
      const act = await createActivity('published', `au2-${u}`);
      const reg = await createRegistration({ memberId, activityId: act.id, statusCode: 'pending' });

      const before = await prisma.auditLog.count();
      const res = await patch(appPatchCancel(reg.id), { cancelReason: 'plan' }, authHeader);
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before + 1);

      const log = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
      expect(log).not.toBeNull();
      expect(log!.event).toBe('registration.review');
      expect(log!.actorUserId).toBe(userId);
      expect(log!.resourceType).toBe('activity_registration');
      expect(log!.resourceId).toBe(reg.id);

      const ctx = log!.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra.operation).toBe('review');
      expect(extra.action).toBe('cancel');
      expect(extra.priorStatusCode).toBe('pending');
      expect(extra.nextStatusCode).toBe('cancelled');
      expect(extra.cancelledByPath).toBe('self');
      expect(extra.cancelReason).toBe('plan');
      expect(extra.targetMemberId).toBe(memberId);

      // 沿评审稿 §12.4:不扩展 surface='app' 字段
      expect(extra).not.toHaveProperty('surface');
    });
  });
});
