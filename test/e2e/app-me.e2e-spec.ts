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
//
// Phase 2 P2-2(2026-05-20)追加 GET / PATCH /me/profile 用例(沿
// docs/app-api-p2-2-profile-review.md §9):GET 8 + PATCH 12 + path stability 1。
// 字段集恰好 9(沿 §2.4);PATCH 白名单恰好 2(沿 §3.1);空 body / forbidden field → 400;
// canUseApp=false → 403;P2-2 不新增 BizCode(沿 §6.1)。

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

// Phase 2 P2-2:AppSelfProfileDto 字段集**恰好 9**(沿评审稿 §2.4 v0.1 锁定)。
const APP_PROFILE_KEYS = [
  'avatarKey',
  'displayName',
  'hasMemberProfile',
  'memberId',
  'memberNo',
  'memberStatus',
  'nickname',
  'userId',
  'username',
].sort();

// Phase 2 P2-2 GET /me/profile / PATCH /me/profile 严禁出现字段(沿评审稿 §2.4 + §3.3)。
// 含 L3 / L2 完整 / L2 医疗 / 紧急联系人 / 组织部门 / Admin 内部审批 / 系统字段 /
// 派生 canUseApp / appAccessReason / profileCompletion。
const PROFILE_FORBIDDEN_KEYS = [
  ...FORBIDDEN_KEYS,
  'email',
  'role',
  'status',
  'roles',
  'gradeCode',
  'realName',
  'mobile',
  'mobileMasked',
  'documentNumber',
  'documentNumberMasked',
  'bloodType',
  'bloodTypeCode',
  'medicalNotes',
  'emergencyContacts',
  'organizationId',
  'organizationName',
  'departmentId',
  'departmentName',
  'joinedDate',
  'canUseApp',
  'appAccessReason',
  'profileCompletion',
  'reviewerNote',
  'verifiedBy',
  'verifiedAt',
  'createdAt',
  'updatedAt',
  'lastLoginAt',
];

function assertNoProfileForbiddenKeys(obj: Record<string, unknown>): void {
  for (const key of PROFILE_FORBIDDEN_KEYS) {
    expect(obj).not.toHaveProperty(key);
  }
}

// Phase 2 P2-2 PATCH 禁止字段按类别参数化(沿评审稿 §9.2.5 ~ §9.2.8;每类 ≥ 3 字段)。
// 字段一律带合法类型值,挑战"DTO 白名单 + 全局 ValidationPipe forbidNonWhitelisted"双重防御。
const FORBIDDEN_FIELD_CATEGORIES: ReadonlyArray<{
  category: string;
  field: string;
  value: unknown;
}> = [
  // Member 业务字段(沿 §3.3 第 1 组)
  { category: 'member', field: 'realName', value: '王小明' },
  { category: 'member', field: 'mobile', value: '13800000000' },
  { category: 'member', field: 'documentNumber', value: '440300199001011234' },
  { category: 'member', field: 'bloodTypeCode', value: 'A' },
  { category: 'member', field: 'medicalNotes', value: '过敏史' },
  { category: 'member', field: 'memberNo', value: 'V9999' },
  { category: 'member', field: 'displayName', value: '改个名' },
  { category: 'member', field: 'gradeCode', value: 'L2' },
  // Account 字段(沿 §3.3 第 4 组;走独立 endpoint)
  { category: 'account', field: 'username', value: 'newname' },
  { category: 'account', field: 'email', value: 'new@example.com' },
  { category: 'account', field: 'password', value: 'Passw0rd2!' },
  { category: 'account', field: 'newPassword', value: 'Passw0rd2!' },
  { category: 'account', field: 'id', value: 'fake-id' },
  { category: 'account', field: 'userId', value: 'fake-user-id' },
  { category: 'account', field: 'memberId', value: 'fake-member-id' },
  { category: 'account', field: 'lastLoginAt', value: new Date().toISOString() },
  // Role / Permission / Status / 审批字段(沿 §3.3 第 5 / 第 6 组)
  { category: 'role', field: 'role', value: 'ADMIN' },
  { category: 'role', field: 'permissions', value: ['user.read.account'] },
  { category: 'role', field: 'status', value: 'DISABLED' },
  { category: 'role', field: 'deletedAt', value: new Date().toISOString() },
  { category: 'role', field: 'reviewerNote', value: 'note' },
  { category: 'role', field: 'verifiedBy', value: 'admin' },
  { category: 'role', field: 'verifiedAt', value: new Date().toISOString() },
  { category: 'role', field: 'internalNote', value: 'internal' },
  // Emergency contacts / Organization / Department(沿 §3.3 第 2 / 第 3 组)
  { category: 'org', field: 'emergencyContacts', value: [{ contactName: 'Alice' }] },
  { category: 'org', field: 'contactName', value: 'Alice' },
  { category: 'org', field: 'contactPhone', value: '13900000000' },
  { category: 'org', field: 'organizationId', value: 'cl9z3a8b00000orgxxxxxxxx' },
  { category: 'org', field: 'departmentId', value: 'cl9z3a8b00000deptxxxxxxx' },
];

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
  // GET /api/app/v1/me/profile(Phase 2 P2-2;沿评审稿 §9.1)
  // =====================================================

  describe('GET /api/app/v1/me/profile (P2-2)', () => {
    async function createMemberProfile(memberId: string): Promise<void> {
      // 单字段写入仅为派生 hasMemberProfile=true(沿评审稿 §8.2 单字段 select 派生);
      // 业务字段一律填占位值,不在 P2-2 GET 返回。
      await prisma.memberProfile.create({
        data: {
          memberId,
          realName: '真实姓名',
          genderCode: 'male',
          birthDate: new Date('1990-01-01'),
          documentTypeCode: 'id_card',
          documentNumber: '440300199001011234',
          mobile: '13800000000',
          email: 'profile@example.com',
          exerciseMethods: [],
          firstAidSkills: [],
          joinedDate: new Date('2020-01-01'),
          joinSourceCode: 'recommend',
          privacyConsentSigned: true,
        },
      });
    }

    it('success(有 MemberProfile)→ 200,字段集 = 9 + hasMemberProfile=true', async () => {
      const { userId, memberId, authHeader } = await setupLinkedUser({
        username: 'p22_get_with_profile',
        memberNo: 'P22-G1',
        displayName: '阿明队员',
        nickname: '阿明',
      });
      await createMemberProfile(memberId);

      const res = await get('/api/app/v1/me/profile', authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      expect(body.message).toBe('ok');
      expect(Object.keys(body.data).sort()).toEqual(APP_PROFILE_KEYS);
      expect(body.data.userId).toBe(userId);
      expect(body.data.memberId).toBe(memberId);
      expect(body.data.memberNo).toBe('P22-G1');
      expect(body.data.displayName).toBe('阿明队员');
      expect(body.data.nickname).toBe('阿明');
      expect(body.data.memberStatus).toBe('ACTIVE');
      expect(body.data.hasMemberProfile).toBe(true);
      assertNoProfileForbiddenKeys(body.data);
    });

    it('success(无 MemberProfile)→ 200,hasMemberProfile=false', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p22_get_no_profile',
        memberNo: 'P22-G2',
      });

      const res = await get('/api/app/v1/me/profile', authHeader);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(Object.keys(body.data).sort()).toEqual(APP_PROFILE_KEYS);
      expect(body.data.hasMemberProfile).toBe(false);
      assertNoProfileForbiddenKeys(body.data);
    });

    it.each([
      ['no token', undefined],
      ['bad token', 'Bearer not-a-real-token'],
    ])('unauthenticated: %s → 401', async (_label, authHeader) => {
      expectBizError(await get('/api/app/v1/me/profile', authHeader), BizCode.UNAUTHORIZED);
    });

    it('member not linked: User.memberId=null → 403 FORBIDDEN', async () => {
      const { authHeader } = await setupUnlinkedUser('p22_get_not_linked');
      expectBizError(await get('/api/app/v1/me/profile', authHeader), BizCode.FORBIDDEN);
    });

    it('member inactive: Member.status=INACTIVE → 403 FORBIDDEN', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p22_get_inactive',
        memberNo: 'P22-G3',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });
      expectBizError(await get('/api/app/v1/me/profile', authHeader), BizCode.FORBIDDEN);
    });

    it('member deleted: Member.deletedAt!=null → 403 FORBIDDEN', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p22_get_deleted',
        memberNo: 'P22-G4',
      });
      await prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });
      expectBizError(await get('/api/app/v1/me/profile', authHeader), BizCode.FORBIDDEN);
    });

    it('admin-as-member: ADMIN + linked active → 字段集与 USER 完全一致(不扩大)', async () => {
      // 沿 D-5.2:Admin 不因 role 扩大 AppSelf 字段可见性
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p22_get_admin',
        role: Role.ADMIN,
        memberNo: 'P22-G5',
      });
      const res = await get('/api/app/v1/me/profile', authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual(APP_PROFILE_KEYS);
      expect(data.memberId).toBe(memberId);
      expect(data).not.toHaveProperty('role');
      assertNoProfileForbiddenKeys(data);
    });

    it('scope self: 仅返本人 profile(造他人 active member,登录 A 调 /me/profile)', async () => {
      const { memberId: memberA, authHeader: authHeaderA } = await setupLinkedUser({
        username: 'p22_get_scope_a',
        memberNo: 'P22-G6-A',
        displayName: 'A 队员',
      });
      // 造他人 active member B 但不绑定登录用户;调用应仅返 A 自身
      const memberB = await createActiveMember('P22-G6-B', 'B 队员');
      expect(memberB.id).not.toBe(memberA);

      const res = await get('/api/app/v1/me/profile', authHeaderA);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.memberId).toBe(memberA);
      expect(data.memberNo).toBe('P22-G6-A');
      expect(data.displayName).toBe('A 队员');
    });
  });

  // =====================================================
  // PATCH /api/app/v1/me/profile(Phase 2 P2-2;沿评审稿 §9.2)
  // =====================================================

  describe('PATCH /api/app/v1/me/profile (P2-2)', () => {
    const patch = (
      path: string,
      body: Record<string, unknown>,
      authHeader?: string,
    ): request.Test => {
      const r = request(httpServer(app)).patch(path).send(body);
      return authHeader ? r.set('Authorization', authHeader) : r;
    };

    it('success: update nickname only → 200 + DB user.nickname 已写', async () => {
      const { userId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_nick',
        memberNo: 'P22-P1',
        nickname: '旧昵称',
      });
      const res = await patch('/api/app/v1/me/profile', { nickname: '新昵称' }, authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual(APP_PROFILE_KEYS);
      expect(data.nickname).toBe('新昵称');
      assertNoProfileForbiddenKeys(data);

      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(dbUser.nickname).toBe('新昵称');
    });

    it('success: update avatarKey only → 200 + DB user.avatarKey 已写', async () => {
      const { userId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_avatar',
        memberNo: 'P22-P2',
      });
      const res = await patch(
        '/api/app/v1/me/profile',
        { avatarKey: 'user/avatars/clxxx.png' },
        authHeader,
      );
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(data.avatarKey).toBe('user/avatars/clxxx.png');
      assertNoProfileForbiddenKeys(data);

      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(dbUser.avatarKey).toBe('user/avatars/clxxx.png');
    });

    it('success: update both → 200 + 两字段都已写', async () => {
      const { userId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_both',
        memberNo: 'P22-P3',
      });
      const res = await patch(
        '/api/app/v1/me/profile',
        { nickname: 'NN', avatarKey: 'a/b/c.png' },
        authHeader,
      );
      expect(res.status).toBe(200);
      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(dbUser.nickname).toBe('NN');
      expect(dbUser.avatarKey).toBe('a/b/c.png');
    });

    it('empty body → 400 BAD_REQUEST(沿 §3.4 A 档)', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p22_patch_empty',
        memberNo: 'P22-P4',
      });
      const res = await patch('/api/app/v1/me/profile', {}, authHeader);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    describe('forbidden field by category → 400 BAD_REQUEST(参数化;沿 §3.3 + §9.2.5 ~ §9.2.8)', () => {
      // 参数化 case 共享单一 user(沿 .env.test LOGIN_THROTTLE_LIMIT=50 不超阈值)。
      // 每次请求都被 ValidationPipe 拦在 controller 之前,DB 写入路径永远走不到,所以
      // 共享 user 不影响"forbidden field 不写入 DB"的反向断言语义。
      let sharedAuthHeader: string;
      let sharedUserId: string;

      beforeAll(async () => {
        const setup = await setupLinkedUser({
          username: 'p22_patch_forbidden_shared',
          memberNo: 'P22-FF-SHARED',
          nickname: '原昵称',
        });
        sharedAuthHeader = setup.authHeader;
        sharedUserId = setup.userId;
      });

      it.each(FORBIDDEN_FIELD_CATEGORIES)(
        '$category/$field 单独传入应被拒绝',
        async ({ field, value }) => {
          const res = await patch(
            '/api/app/v1/me/profile',
            { [field]: value, nickname: '应该不会被写入' },
            sharedAuthHeader,
          );
          expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });

          // 反向断言:即使带了合法的 nickname,因为禁字段拒整笔请求,nickname 也不应被写入
          const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: sharedUserId } });
          expect(dbUser.nickname).toBe('原昵称');
        },
      );
    });

    it('unauthenticated → 401', async () => {
      expectBizError(
        await patch('/api/app/v1/me/profile', { nickname: 'x' }),
        BizCode.UNAUTHORIZED,
      );
    });

    it('member not linked → 403 FORBIDDEN', async () => {
      const { authHeader } = await setupUnlinkedUser('p22_patch_not_linked');
      expectBizError(
        await patch('/api/app/v1/me/profile', { nickname: 'x' }, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('member inactive → 403 FORBIDDEN', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_inactive',
        memberNo: 'P22-P5',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });
      expectBizError(
        await patch('/api/app/v1/me/profile', { nickname: 'x' }, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('member deleted → 403 FORBIDDEN', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_deleted',
        memberNo: 'P22-P6',
      });
      await prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });
      expectBizError(
        await patch('/api/app/v1/me/profile', { nickname: 'x' }, authHeader),
        BizCode.FORBIDDEN,
      );
    });

    it('admin-as-member: ADMIN + linked → 改 nickname 成功;sensitive 字段不返(沿 D-5.2)', async () => {
      const { userId, authHeader } = await setupLinkedUser({
        username: 'p22_patch_admin',
        role: Role.ADMIN,
        memberNo: 'P22-P7',
      });
      const res = await patch('/api/app/v1/me/profile', { nickname: 'AdminNick' }, authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      expect(Object.keys(data).sort()).toEqual(APP_PROFILE_KEYS);
      expect(data.nickname).toBe('AdminNick');
      expect(data).not.toHaveProperty('role');
      assertNoProfileForbiddenKeys(data);

      const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(dbUser.nickname).toBe('AdminNick');
      expect(dbUser.role).toBe(Role.ADMIN); // role 不被改
    });
  });

  // =====================================================
  // path stability:旧 /api/users/me 行为不受影响(沿 §9.2 #9 + §3.2)
  // =====================================================

  describe('path stability', () => {
    const patchRaw = (
      path: string,
      body: Record<string, unknown>,
      authHeader: string,
    ): request.Test =>
      request(httpServer(app)).patch(path).send(body).set('Authorization', authHeader);

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

    it('P2-2 path stability: 旧 PATCH /api/users/me 改 nickname → 仍按 UserResponseDto 返(沿 §9.2.12)', async () => {
      const { authHeader } = await setupLinkedUser({
        username: 'p22_path_legacy_patch',
        memberNo: 'PS-2',
        nickname: '旧',
      });
      const res = await patchRaw('/api/users/me', { nickname: '改' }, authHeader);
      expect(res.status).toBe(200);
      const { data } = res.body as ResBody;
      // 旧 contract UserResponseDto:id / username / email / nickname / avatarKey / role /
      // status / createdAt / lastLoginAt / updatedAt;不应返 App 字段(memberId / memberNo 等)
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('role');
      expect(data).toHaveProperty('status');
      expect(data.nickname).toBe('改');
      expect(data).not.toHaveProperty('memberId');
      expect(data).not.toHaveProperty('memberNo');
      expect(data).not.toHaveProperty('hasMemberProfile');
    });
  });
});
