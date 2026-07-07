import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 队员账号闭环 v2(批量开号,2026-07-07;goal「队员账号闭环 v2(完整生命周期)」;
// 冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md §1.2 E-10/E-11)e2e。
//
// 覆盖:
// - 权限边界(未登录 / USER / ops-admin 成功;复用 member.grant.account,0 新码)
// - DTO 校验:空 items / 超 200 条 → 400
// - 混合批(部分成功 + 部分失败:member 不存在 / 已有账号 / phone 冲突)→ 逐行结果 +
//   skip-on-error(失败行不影响后续行,证明各自独立事务而非整批回滚)
// - 逐行成功写入各自的 member.account-granted audit 事件(非批量汇总一条)
// - 响应形状:items[] + summary{total,ok,blocked}

const MEMBER_ACCOUNT_CODE = 'member.grant.account';

async function seedMemberAccountCodeAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  const [module, action, resourceType] = MEMBER_ACCOUNT_CODE.split('.');
  await prisma.permission.upsert({
    where: { code: MEMBER_ACCOUNT_CODE },
    update: {},
    create: { code: MEMBER_ACCOUNT_CODE, module, action, resourceType },
  });
  const perm = await prisma.permission.findUniqueOrThrow({
    where: { code: MEMBER_ACCOUNT_CODE },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: [{ roleId: opsAdminRoleId, permissionId: perm.id }],
    skipDuplicates: true,
  });
}

describe('队员账号闭环 v2:POST /api/admin/v1/members/accounts/bulk-grant', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let opsAdminAuth: string;
  let userAuth: string;

  let memberSeq = 0;
  async function newMember(
    status: MemberStatus = MemberStatus.ACTIVE,
  ): Promise<{ id: string; memberNo: string }> {
    memberSeq += 1;
    const memberNo = `mabg-e2e-${memberSeq}`;
    return prisma.member.create({
      data: { memberNo, displayName: `MABG-${memberSeq}`, status },
      select: { id: true, memberNo: true },
    });
  }

  function bulkGrant(items: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post('/api/admin/v1/members/accounts/bulk-grant');
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ items });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    await createTestUser(app, { username: 'mabg-su', role: Role.SUPER_ADMIN });
    const opsAdmin = await createTestUser(app, { username: 'mabg-ops', role: Role.ADMIN });
    await createTestUser(app, { username: 'mabg-user', role: Role.USER });

    opsAdminAuth = (await loginAs(app, 'mabg-ops')).authHeader;
    userAuth = (await loginAs(app, 'mabg-user')).authHeader;

    const rbacSeed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedMemberAccountCodeAndBind(prisma, rbacSeed.opsAdminRoleId);
    await grantOpsAdminToUser(app, opsAdmin.id, rbacSeed.opsAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      expectBizError(
        await bulkGrant([{ memberId: member.id, phone: '13900007001' }]),
        BizCode.UNAUTHORIZED,
      );
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      expectBizError(
        await bulkGrant([{ memberId: member.id, phone: '13900007002' }], userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('DTO 校验', () => {
    it('空 items → 400', async () => {
      const res = await bulkGrant([], opsAdminAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('超过 200 条 → 400', async () => {
      const items = Array.from({ length: 201 }, (_, i) => ({
        memberId: 'cl0000000000000000nonexist',
        phone: `1390000${String(i).padStart(4, '0')}`,
      }));
      const res = await bulkGrant(items, opsAdminAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('单行 phone 格式错 → 400(DTO 层校验,整请求拒绝,不进入逐行处理)', async () => {
      const member = await newMember();
      const res = await bulkGrant([{ memberId: member.id, phone: 'bad-phone' }], opsAdminAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  describe('混合批:部分成功 + 部分失败(skip-on-error,各自独立事务)', () => {
    it('member 不存在 / 已有账号 / phone 冲突三类失败均不阻断其余行成功', async () => {
      const okMember1 = await newMember();
      const okMember2 = await newMember();
      const alreadyHasAccountMember = await newMember();
      const occupiedPhoneUser = await createTestUser(app, { username: 'mabg-phone-occupied' });
      await prisma.user.update({
        where: { id: occupiedPhoneUser.id },
        data: { phone: '13900007010' },
      });
      const phoneConflictMember = await newMember();

      // 队员已有绑定账号(用真实 grant 建立前置状态,非 mock)。
      const preGranted = await request(httpServer(app))
        .post(`/api/admin/v1/members/${alreadyHasAccountMember.id}/account`)
        .set('Authorization', opsAdminAuth)
        .send({ phone: '13900007011' });
      expect(preGranted.status).toBe(201);

      const res = await bulkGrant(
        [
          { memberId: okMember1.id, phone: '13900007020' }, // 成功
          { memberId: 'cl0000000000000000nonexist', phone: '13900007021' }, // MEMBER_NOT_FOUND
          { memberId: alreadyHasAccountMember.id, phone: '13900007022' }, // MEMBER_HAS_LINKED_USER
          { memberId: okMember2.id, phone: '13900007023' }, // 成功(紧跟在失败行之后,证明未被前面的失败阻断)
          { memberId: phoneConflictMember.id, phone: '13900007010' }, // PHONE_ALREADY_BOUND
        ],
        opsAdminAuth,
      );

      expect(res.status).toBe(201);
      const items = res.body.data.items as Array<{
        memberId: string;
        status: string;
        userId?: string | null;
        reason?: string | null;
      }>;
      expect(items).toHaveLength(5);

      expect(items[0]).toMatchObject({ memberId: okMember1.id, status: 'ok' });
      expect(typeof items[0].userId).toBe('string');

      expect(items[1]).toMatchObject({ memberId: 'cl0000000000000000nonexist', status: 'blocked' });
      expect(items[1].reason).toBe(BizCode.MEMBER_NOT_FOUND.message);

      expect(items[2]).toMatchObject({
        memberId: alreadyHasAccountMember.id,
        status: 'blocked',
      });
      expect(items[2].reason).toBe(BizCode.MEMBER_HAS_LINKED_USER.message);

      expect(items[3]).toMatchObject({ memberId: okMember2.id, status: 'ok' });
      expect(typeof items[3].userId).toBe('string');

      expect(items[4]).toMatchObject({ memberId: phoneConflictMember.id, status: 'blocked' });
      expect(items[4].reason).toBe(BizCode.PHONE_ALREADY_BOUND.message);

      expect(res.body.data.summary).toEqual({ total: 5, ok: 2, blocked: 3 });

      // 两个成功行确实各自建了账号(独立事务证据:第 2/3 行失败未影响 1/4 行落库)。
      const created1 = await prisma.user.findFirstOrThrow({
        where: { memberId: okMember1.id, deletedAt: null },
      });
      expect(created1.phone).toBe('13900007020');
      const created2 = await prisma.user.findFirstOrThrow({
        where: { memberId: okMember2.id, deletedAt: null },
      });
      expect(created2.phone).toBe('13900007023');

      // 逐行成功各自写入 member.account-granted audit(非一条批量汇总事件)。
      const audit1 = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'member.account-granted', resourceId: okMember1.id },
      });
      expect(audit1.resourceType).toBe('member');
      const audit2 = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'member.account-granted', resourceId: okMember2.id },
      });
      expect(audit2.resourceType).toBe('member');
    });

    it('全部成功:summary 正确统计', async () => {
      const m1 = await newMember();
      const m2 = await newMember();
      const res = await bulkGrant(
        [
          { memberId: m1.id, phone: '13900007030' },
          { memberId: m2.id, phone: '13900007031' },
        ],
        opsAdminAuth,
      );
      expect(res.status).toBe(201);
      expect(res.body.data.summary).toEqual({ total: 2, ok: 2, blocked: 0 });
    });

    it('全部失败:summary 正确统计,响应仍 201(非异常)', async () => {
      const res = await bulkGrant(
        [
          { memberId: 'cl0000000000000000nonexist1', phone: '13900007040' },
          { memberId: 'cl0000000000000000nonexist2', phone: '13900007041' },
        ],
        opsAdminAuth,
      );
      expect(res.status).toBe(201);
      expect(res.body.data.summary).toEqual({ total: 2, ok: 0, blocked: 2 });
    });
  });
});
