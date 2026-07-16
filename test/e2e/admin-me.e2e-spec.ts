import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Admin surface 本人身份只读端点 GET /api/admin/v1/me e2e(2026-06-14;goal「Admin surface
// 本人身份端点」DoD #5)。覆盖 5 类用例:
//   ① 有 token → 200 + 本人 9 字段且字段集精确
//   ② 响应不含任何 L3 / member 业务 / raw permission 字段
//   ③ 无 token → 401
//   ④ 普通 USER token 也返 200 + 自己的身份(D3 锁:入口仅 JwtAuthGuard,不挂 @Roles)
//   ⑤ 被禁用 / 软删用户被 JwtStrategy 挡(401)
// 另含:错 token → 401 / linked member 时仅返 memberId 不泄 member 业务字段 / email·nickname 可空。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// AdminMeResponseDto 字段集**恰好 9**(沿 goal D2:只返身份,不内联角色/权限)。
const ADMIN_ME_KEYS = [
  'avatarKey',
  'email',
  'lastLoginAt',
  'memberId',
  'nickname',
  'role',
  'status',
  'userId',
  'username',
].sort();

// 绝禁出现:L3(密码/令牌/凭证)+ member 业务字段(属 App 自视角,§9.3)+
// App 派生字段(canUseApp / appAccessReason)+ raw RBAC permission(§9.4)+ 系统字段。
const FORBIDDEN_KEYS = [
  // L3
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'accessToken',
  'secretId',
  'secretKey',
  'secretIdEncrypted',
  'secretKeyEncrypted',
  // member 业务字段(只允许 memberId 这一 User 本体外键)
  'memberNo',
  'displayName',
  'gradeCode',
  'memberStatus',
  // App 自视角派生字段
  'canUseApp',
  'appAccessReason',
  // raw RBAC permission(权限走 system/v1/rbac/me/permissions)
  'permissions',
  'permissionCodes',
  'roles',
  // 系统 / 软删字段(不在 9 字段集内)
  'deletedAt',
  'createdAt',
  'updatedAt',
];

function assertNoForbiddenKeys(obj: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(obj).not.toHaveProperty(key);
  }
}

describe('Admin /api/admin/v1/me 本人身份只读 bootstrap(2026-06-14)', () => {
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

  const get = (authHeader?: string) => {
    const r = request(httpServer(app)).get('/api/admin/v1/me');
    return authHeader ? r.set('Authorization', authHeader) : r;
  };

  async function setupUser(opts: {
    username: string;
    role?: Role;
    email?: string | null;
    nickname?: string | null;
  }): Promise<{ userId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
      email: opts.email,
      nickname: opts.nickname,
    });
    const { authHeader } = await loginAs(app, opts.username);
    return { userId: user.id, authHeader };
  }

  // =====================================================
  // ① success + 字段集精确 + ② 无禁字段
  // =====================================================

  it('① SUPER_ADMIN 持 token → 200,字段集恰好 9 + ② 无 L3/member/permission 字段', async () => {
    const { userId, authHeader } = await setupUser({
      username: 'admin_me_sa',
      role: Role.SUPER_ADMIN,
      email: 'admin_me_sa@example.com',
      nickname: '超管小王',
    });

    let res = await get(authHeader);
    expect(res.status).toBe(200);
    await waitFor(
      async () => {
        if (typeof (res.body as ResBody).data.lastLoginAt === 'string') return true;
        res = await get(authHeader);
        expect(res.status).toBe(200);
        return typeof (res.body as ResBody).data.lastLoginAt === 'string';
      },
      {
        timeoutMs: 5_000,
        intervalMs: 250,
        message: 'GET /api/admin/v1/me 未在 5s 内返回 string lastLoginAt',
      },
    );

    const body = res.body as ResBody;
    expect(body.code).toBe(0);
    expect(body.message).toBe('ok');
    expect(Object.keys(body.data).sort()).toEqual(ADMIN_ME_KEYS);
    expect(body.data.userId).toBe(userId);
    expect(body.data.username).toBe('admin_me_sa');
    expect(body.data.email).toBe('admin_me_sa@example.com');
    expect(body.data.nickname).toBe('超管小王');
    expect(body.data.role).toBe('SUPER_ADMIN');
    expect(body.data.status).toBe('ACTIVE');
    expect(body.data.memberId).toBeNull(); // 未绑 member
    // lastLoginAt:loginAs 走真实登录旁路写;有界重取后终态必须为 ISO 字符串
    expect(typeof body.data.lastLoginAt).toBe('string');
    assertNoForbiddenKeys(body.data);
  });

  it('ADMIN 持 token → 200,字段集恰好 9', async () => {
    const { authHeader } = await setupUser({ username: 'admin_me_admin', role: Role.ADMIN });
    const res = await get(authHeader);
    expect(res.status).toBe(200);
    const { data } = res.body as ResBody;
    expect(Object.keys(data).sort()).toEqual(ADMIN_ME_KEYS);
    expect(data.role).toBe('ADMIN');
    assertNoForbiddenKeys(data);
  });

  // =====================================================
  // ④ 普通 USER 也返 200 + 自己的身份(D3 锁)
  // =====================================================

  it('④ 普通 USER 持 token → 200 + 自己的身份(D3:不挂 @Roles,任意登录用户可达)', async () => {
    const { userId, authHeader } = await setupUser({ username: 'admin_me_plain_user' });
    const res = await get(authHeader);
    expect(res.status).toBe(200);
    const { data } = res.body as ResBody;
    expect(Object.keys(data).sort()).toEqual(ADMIN_ME_KEYS);
    expect(data.userId).toBe(userId);
    expect(data.username).toBe('admin_me_plain_user');
    expect(data.role).toBe('USER');
    assertNoForbiddenKeys(data);
  });

  it('email / nickname 未设置时为 null(可空字段)', async () => {
    const { authHeader } = await setupUser({
      username: 'admin_me_nullable',
      email: null,
      nickname: null,
    });
    const res = await get(authHeader);
    expect(res.status).toBe(200);
    const { data } = res.body as ResBody;
    expect(data.email).toBeNull();
    expect(data.nickname).toBeNull();
    expect(data.avatarKey).toBeNull();
  });

  // =====================================================
  // linked member:仅返 memberId,不泄 member 业务字段
  // =====================================================

  it('已绑 active member → memberId 返该 member id,但**不**泄任何 member 业务字段', async () => {
    const { userId, authHeader } = await setupUser({
      username: 'admin_me_linked',
      role: Role.ADMIN,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: 'ADM-ME-1',
        displayName: '兼职队员',
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
    });
    await prisma.user.update({ where: { id: userId }, data: { memberId: member.id } });

    const res = await get(authHeader);
    expect(res.status).toBe(200);
    const { data } = res.body as ResBody;
    expect(Object.keys(data).sort()).toEqual(ADMIN_ME_KEYS);
    expect(data.memberId).toBe(member.id);
    // 仅 memberId(User 本体外键);member 业务字段一律不返
    expect(data).not.toHaveProperty('memberNo');
    expect(data).not.toHaveProperty('displayName');
    expect(data).not.toHaveProperty('gradeCode');
    expect(data).not.toHaveProperty('memberStatus');
    assertNoForbiddenKeys(data);
  });

  // =====================================================
  // ③ 无 token / 错 token → 401
  // =====================================================

  it('③ 无 Authorization 头 → 401', async () => {
    expectBizError(await get(), BizCode.UNAUTHORIZED);
  });

  it('错误 token → 401', async () => {
    expectBizError(await get('Bearer not-a-real-token'), BizCode.UNAUTHORIZED);
  });

  // =====================================================
  // ⑤ 被禁用 / 软删用户被 JwtStrategy 挡(401)
  // =====================================================

  it('⑤ 用户登录后被禁用(status=DISABLED)→ 持原 token 调用被 JwtStrategy 挡(401)', async () => {
    const { userId, authHeader } = await setupUser({ username: 'admin_me_to_disable' });
    // 先确认可用
    expect((await get(authHeader)).status).toBe(200);
    await prisma.user.update({ where: { id: userId }, data: { status: UserStatus.DISABLED } });
    expectBizError(await get(authHeader), BizCode.UNAUTHORIZED);
  });

  it('⑤ 用户登录后被软删(deletedAt!=null)→ 持原 token 调用被 JwtStrategy 挡(401)', async () => {
    const { userId, authHeader } = await setupUser({ username: 'admin_me_to_delete' });
    expect((await get(authHeader)).status).toBe(200);
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    expectBizError(await get(authHeader), BizCode.UNAUTHORIZED);
  });
});
