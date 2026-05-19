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

// Phase 2 P2-1 App /api/app/v1/me* 三 endpoint e2e。
// 沿 docs/app-api-phase-2-review.md §9.2 至少 9 类用例:success / unauthenticated /
// member-not-linked / member-inactive / member-deleted / scope-self / sensitive-field /
// admin-as-member / contract snapshot(由 openapi.contract-spec.ts 兜底)/ path-stability。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

const APP_ME_KEYS = [
  'appAccessReason',
  'avatarKey',
  'canUseApp',
  'displayName',
  'email',
  'gradeCode',
  'memberId',
  'memberNo',
  'memberStatus',
  'nickname',
  'role',
  'status',
  'userId',
  'username',
].sort();

const APP_ME_ACCOUNT_KEYS = [
  'appAccessReason',
  'canUseApp',
  'email',
  'lastLoginAt',
  'linkedMemberId',
  'status',
  'userId',
  'username',
].sort();

const CAPABILITY_TOP_KEYS = [
  'account',
  'activities',
  'attendance',
  'certificates',
  'managed',
  'tasks',
];

// L3 / admin internal / raw RBAC 字段绝禁出现(沿 Phase 0.6 §2.4 + §6.5 + Phase 2 §10.7)。
const FORBIDDEN_KEYS = [
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'accessToken',
  'secretId',
  'secretKey',
  'secretIdEncrypted',
  'secretKeyEncrypted',
  'deletedAt',
  'publishedBy',
  'cancelledBy',
  'internalNote',
  'permissionCodes',
  'permissions',
];

function assertNoForbiddenKeys(obj: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(obj).not.toHaveProperty(key);
  }
}

// canUseApp=true 时全业务 cap=true;tasks / managed 恒 false(命名空间预留)
const ALL_CAPS_WHEN_USABLE = {
  activities: {
    canViewAvailableActivities: true,
    canRegisterActivity: true,
    canCancelOwnRegistration: true,
  },
  attendance: { canViewOwnAttendance: true },
  certificates: { canViewOwnCertificates: true },
  tasks: { canViewTasks: false },
  managed: {
    canViewManagedActivities: false,
    canReviewManagedRegistrations: false,
    canReviewManagedAttendance: false,
  },
};

// canUseApp=false 时业务 cap 全 false(§4.3 #4);tasks / managed 同样 false
const ALL_CAPS_WHEN_BLOCKED = {
  activities: {
    canViewAvailableActivities: false,
    canRegisterActivity: false,
    canCancelOwnRegistration: false,
  },
  attendance: { canViewOwnAttendance: false },
  certificates: { canViewOwnCertificates: false },
  tasks: { canViewTasks: false },
  managed: {
    canViewManagedActivities: false,
    canReviewManagedRegistrations: false,
    canReviewManagedAttendance: false,
  },
};

describe('App /api/app/v1/me 三 endpoint(Phase 2 P2-1)', () => {
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

  // ============== helpers ==============

  async function createActiveMember(
    memberNo: string,
    displayName = '测试队员',
  ): Promise<{ id: string; memberNo: string; displayName: string }> {
    const m = await prisma.member.create({
      data: { memberNo, displayName, gradeCode: 'L1', status: MemberStatus.ACTIVE },
    });
    return { id: m.id, memberNo: m.memberNo, displayName: m.displayName };
  }

  async function setupLinkedUser(opts: {
    username: string;
    role?: Role;
    memberNo: string;
    displayName?: string;
    email?: string;
    nickname?: string;
  }): Promise<{ userId: string; memberId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
      email: opts.email,
      nickname: opts.nickname,
    });
    const member = await createActiveMember(opts.memberNo, opts.displayName);
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

  const get = (path: string, authHeader?: string) => {
    const r = request(httpServer(app)).get(path);
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  // =====================================================
  // GET /api/app/v1/me
  // =====================================================

  describe('GET /api/app/v1/me', () => {
    it('success: USER + active linked member → 200,字段集 = 14 + canUseApp=true', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_me_user1',
        memberNo: 'V-A1',
        displayName: '阿明队员',
        nickname: '阿明',
      });

      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      expect(body.message).toBe('ok');
      expect(Object.keys(body.data).sort()).toEqual(APP_ME_KEYS);
      expect(body.data.canUseApp).toBe(true);
      expect(body.data.appAccessReason).toBeNull();
      expect(body.data.memberId).toBe(memberId);
      expect(body.data.memberNo).toBe('V-A1');
      expect(body.data.displayName).toBe('阿明队员');
      expect(body.data.gradeCode).toBe('L1');
      expect(body.data.memberStatus).toBe('ACTIVE');
      expect(body.data.username).toBe('app_me_user1');
      expect(body.data.role).toBe('USER');
      expect(body.data.status).toBe('ACTIVE');
      assertNoForbiddenKeys(body.data);
    });

    it('unauthenticated: 无 Authorization 头 → 401', async () => {
      expectBizError(await get('/api/app/v1/me'), BizCode.UNAUTHORIZED);
    });

    it('unauthenticated: 错误 token → 401', async () => {
      expectBizError(await get('/api/app/v1/me', 'Bearer not-a-real-token'), BizCode.UNAUTHORIZED);
    });

    it('member not linked: User 无 memberId → canUseApp=false + reason=MEMBER_NOT_LINKED', async () => {
      const { authHeader } = await setupUnlinkedUser('app_me_unlinked');
      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.canUseApp).toBe(false);
      expect(data.appAccessReason).toBe('MEMBER_NOT_LINKED');
      expect(data.memberId).toBeNull();
      expect(data.memberNo).toBeNull();
      expect(data.displayName).toBeNull();
      expect(data.gradeCode).toBeNull();
      expect(data.memberStatus).toBeNull();
    });

    it('member inactive: linked + Member.status=INACTIVE → canUseApp=false + reason=MEMBER_INACTIVE', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_me_inactive',
        memberNo: 'V-IA',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });

      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.canUseApp).toBe(false);
      expect(data.appAccessReason).toBe('MEMBER_INACTIVE');
      expect(data.memberId).toBe(memberId);
      // INACTIVE 队员档案仍可暴露给本人,canUseApp 由前端控制 UI 入口
      expect(data.memberStatus).toBe('INACTIVE');
    });

    it('member deleted: linked + Member.deletedAt!=null → canUseApp=false + reason=MEMBER_DELETED', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_me_deleted',
        memberNo: 'V-DEL',
      });
      await prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });

      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.canUseApp).toBe(false);
      expect(data.appAccessReason).toBe('MEMBER_DELETED');
    });

    it('admin-as-member: ADMIN 持 memberId → 仅返本人 self perspective(字段集不扩大)', async () => {
      // 沿 D-5.2 + §10.3:ADMIN 不因 role 扩大 AppSelf 字段可见性
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_me_admin1',
        role: Role.ADMIN,
        memberNo: 'A-ADM',
        displayName: '兼职队员',
      });

      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual(APP_ME_KEYS);
      expect(data.role).toBe('ADMIN'); // UI hint;非授权依据
      expect(data.canUseApp).toBe(true);
      expect(data.memberId).toBe(memberId);
      assertNoForbiddenKeys(data);
    });

    it('admin without member: SUPER_ADMIN 无 memberId → canUseApp=false + reason=MEMBER_NOT_LINKED', async () => {
      const { authHeader } = await setupUnlinkedUser('app_me_admin_nomember', Role.SUPER_ADMIN);
      const res = await get('/api/app/v1/me', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.canUseApp).toBe(false);
      expect(data.appAccessReason).toBe('MEMBER_NOT_LINKED');
      expect(data.role).toBe('SUPER_ADMIN');
    });
  });

  // =====================================================
  // GET /api/app/v1/me/account
  // =====================================================

  describe('GET /api/app/v1/me/account', () => {
    it('success: linked active member → 200,字段集 = 8;不返 role', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_me_acc_ok',
        memberNo: 'A-1',
        email: 'app_me_acc_ok@example.com',
      });

      const res = await get('/api/app/v1/me/account', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual(APP_ME_ACCOUNT_KEYS);
      expect(data.username).toBe('app_me_acc_ok');
      expect(data.linkedMemberId).toBe(memberId);
      expect(data.canUseApp).toBe(true);
      expect(data.appAccessReason).toBeNull();
      expect(data).not.toHaveProperty('role'); // account 视角不返 role
      expect(typeof data.lastLoginAt === 'string' || data.lastLoginAt === null).toBe(true);
      assertNoForbiddenKeys(data);
    });

    it('unauthenticated: → 401', async () => {
      expectBizError(await get('/api/app/v1/me/account'), BizCode.UNAUTHORIZED);
    });

    it('member not linked: → canUseApp=false + linkedMemberId=null', async () => {
      const { authHeader } = await setupUnlinkedUser('app_me_acc_no_link');
      const res = await get('/api/app/v1/me/account', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.canUseApp).toBe(false);
      expect(data.appAccessReason).toBe('MEMBER_NOT_LINKED');
      expect(data.linkedMemberId).toBeNull();
    });
  });

  // =====================================================
  // GET /api/app/v1/me/capabilities
  // =====================================================

  describe('GET /api/app/v1/me/capabilities', () => {
    it('success: linked active member → account.canUseApp=true + 业务 cap=true + tasks/managed=false', async () => {
      const { authHeader } = await setupLinkedUser({ username: 'app_cap_ok', memberNo: 'C-1' });
      const res = await get('/api/app/v1/me/capabilities', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual([...CAPABILITY_TOP_KEYS].sort());

      expect(data.account).toEqual({
        canUseApp: true,
        reason: null,
        canEditProfile: true,
        canChangePassword: true,
      });
      expect(data.activities).toEqual(ALL_CAPS_WHEN_USABLE.activities);
      expect(data.attendance).toEqual(ALL_CAPS_WHEN_USABLE.attendance);
      expect(data.certificates).toEqual(ALL_CAPS_WHEN_USABLE.certificates);
      expect(data.tasks).toEqual(ALL_CAPS_WHEN_USABLE.tasks);
      expect(data.managed).toEqual(ALL_CAPS_WHEN_USABLE.managed);

      // 沿 D-5.3:不暴露 raw RBAC permission codes
      expect(data).not.toHaveProperty('permissions');
      expect(data).not.toHaveProperty('permissionCodes');
      expect(data).not.toHaveProperty('roles');
      assertNoForbiddenKeys(data);
    });

    it('member not linked: → 所有业务 cap=false + account.reason=MEMBER_NOT_LINKED', async () => {
      const { authHeader } = await setupUnlinkedUser('app_cap_unlinked');
      const res = await get('/api/app/v1/me/capabilities', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.account).toEqual({
        canUseApp: false,
        reason: 'MEMBER_NOT_LINKED',
        canEditProfile: false,
        canChangePassword: false,
      });
      expect(data.activities).toEqual(ALL_CAPS_WHEN_BLOCKED.activities);
      expect(data.attendance).toEqual(ALL_CAPS_WHEN_BLOCKED.attendance);
      expect(data.certificates).toEqual(ALL_CAPS_WHEN_BLOCKED.certificates);
      expect(data.tasks).toEqual(ALL_CAPS_WHEN_BLOCKED.tasks);
      expect(data.managed).toEqual(ALL_CAPS_WHEN_BLOCKED.managed);
    });

    it('member inactive: → canUseApp=false + reason=MEMBER_INACTIVE + 业务 cap 全 false', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'app_cap_inactive',
        memberNo: 'C-IA',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });

      const res = await get('/api/app/v1/me/capabilities', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      const account = data.account as { canUseApp: boolean; reason: string | null };
      expect(account.canUseApp).toBe(false);
      expect(account.reason).toBe('MEMBER_INACTIVE');
      expect(data.activities).toEqual(ALL_CAPS_WHEN_BLOCKED.activities);
    });

    it('admin-as-member: ADMIN + linked active member → cap 字段集与 USER 完全一致(不扩大)', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'app_cap_admin_member',
        role: Role.ADMIN,
        memberNo: 'C-ADM',
      });

      const res = await get('/api/app/v1/me/capabilities', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      // 字段集与 USER 视角完全一致;无 ADMIN 专属 capability(沿 D-5.2)
      expect(Object.keys(data).sort()).toEqual([...CAPABILITY_TOP_KEYS].sort());
      expect(data).not.toHaveProperty('admin');
      expect(data).not.toHaveProperty('permissions');
      expect(data).not.toHaveProperty('permissionCodes');
      const managed = data.managed as { canViewManagedActivities: boolean };
      expect(managed.canViewManagedActivities).toBe(false);
    });

    it('unauthenticated: → 401', async () => {
      expectBizError(await get('/api/app/v1/me/capabilities'), BizCode.UNAUTHORIZED);
    });
  });

  // =====================================================
  // path stability:旧 /api/users/me 行为不受影响(沿 §9.2 #9 + §3.2)
  // =====================================================

  describe('path stability', () => {
    it('同一登录态:旧 /api/users/me 与新 /api/app/v1/me 共存,响应字段集互不影响', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'path_stability_user',
        memberNo: 'PS-1',
      });

      const [legacy, appMe] = await Promise.all([
        get('/api/users/me', authHeader),
        get('/api/app/v1/me', authHeader),
      ]);
      expect(legacy.status).toBe(200);
      expect(appMe.status).toBe(200);

      // 旧 path 字段集严格 = UserResponseDto(由 users-me.e2e-spec 已断言),
      // 本 spec 仅复核新旧字段集不相同 + 旧 path 不返 App 字段
      const legacyData = (legacy.body as ResBody).data;
      const appData = (appMe.body as ResBody).data;
      expect(Object.keys(legacyData).sort()).not.toEqual(Object.keys(appData).sort());
      expect(legacyData).not.toHaveProperty('canUseApp');
      expect(legacyData).not.toHaveProperty('memberId');
      expect(legacyData).not.toHaveProperty('memberNo');
    });
  });
});
