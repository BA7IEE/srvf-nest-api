import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// finding-4 同类残留:队员轴三条账号削权路径必须与 users / role-bindings / user-roles
// 共用 LastAdminProtectionPolicy 与同一 advisory lock。所有数据均为合成测试值,不含真实 PII。
describe('队员轴最后 active ops-admin 保护', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDb(app);
    sequence = 0;
    await createTestUser(app, { username: 'member-ops-guard-actor', role: Role.SUPER_ADMIN });
    superAdminAuth = (await loginAs(app, 'member-ops-guard-actor')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createOpsAdminRole(): Promise<{ id: string }> {
    return prisma.rbacRole.create({
      data: { code: 'ops-admin', displayName: 'Synthetic Ops Admin Role' },
      select: { id: true },
    });
  }

  async function createLinkedMemberAccount(label: string) {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `T-OPS-${label}-${sequence}`,
        displayName: `Synthetic Member ${sequence}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true, status: true },
    });
    const baseUser = await createTestUser(app, {
      username: `member-ops-${label}-${sequence}`,
      role: Role.USER,
    });
    const user = await prisma.user.update({
      where: { id: baseUser.id },
      data: { memberId: member.id },
      select: { id: true, status: true, deletedAt: true, memberId: true },
    });
    return { member, user };
  }

  async function bindOpsAdmin(userId: string, roleId: string): Promise<void> {
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
      },
    });
  }

  async function expectUserAndBindingPreserved(userId: string, roleId: string): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.deletedAt).toBeNull();

    const binding = await prisma.roleBinding.findFirstOrThrow({
      where: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
    expect(binding.status).toBe(BindingStatus.ACTIVE);
    expect(binding.deletedAt).toBeNull();
  }

  async function countActiveOpsAdminHolders(roleId: string): Promise<number> {
    const bindings = await prisma.roleBinding.findMany({
      where: {
        roleId,
        principalType: PrincipalType.USER,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
      },
      select: { principalId: true },
    });
    const holderIds = bindings
      .map(({ principalId }) => principalId)
      .filter((id): id is string => id !== null);
    return prisma.user.count({
      where: { id: { in: holderIds }, status: UserStatus.ACTIVE, deletedAt: null },
    });
  }

  function updateAccountStatus(memberId: string) {
    return request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/account/status`)
      .set('Authorization', superAdminAuth)
      .send({ status: UserStatus.DISABLED });
  }

  function offboard(memberId: string) {
    return request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/offboard`)
      .set('Authorization', superAdminAuth);
  }

  function reopenAccount(memberId: string, phone: string) {
    return request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/account/reopen`)
      .set('Authorization', superAdminAuth)
      .send({ phone });
  }

  function disableThroughUsersAxis(userId: string) {
    return request(httpServer(app))
      .patch(`/api/admin/v1/users/${userId}/status`)
      .set('Authorization', superAdminAuth)
      .send({ status: UserStatus.DISABLED });
  }

  it('updateAccountStatus：停用最后一个 active ops-admin 队员账号 → 30101，账号与绑定保持', async () => {
    const role = await createOpsAdminRole();
    const target = await createLinkedMemberAccount('status-last');
    await bindOpsAdmin(target.user.id, role.id);

    expectBizError(await updateAccountStatus(target.member.id), BizCode.LAST_OPS_ADMIN_PROTECTED);
    await expectUserAndBindingPreserved(target.user.id, role.id);
  });

  it('offboard：离队将停用最后一个 active ops-admin 队员账号 → 30101，四腿全回滚', async () => {
    const role = await createOpsAdminRole();
    const target = await createLinkedMemberAccount('offboard-last');
    await bindOpsAdmin(target.user.id, role.id);

    expectBizError(await offboard(target.member.id), BizCode.LAST_OPS_ADMIN_PROTECTED);
    await expectUserAndBindingPreserved(target.user.id, role.id);
    expect(
      (await prisma.member.findUniqueOrThrow({ where: { id: target.member.id } })).status,
    ).toBe(MemberStatus.ACTIVE);
  });

  it('reopenAccount：软删最后一个 active ops-admin 旧账号 → 30101，旧号与绑定保持', async () => {
    const role = await createOpsAdminRole();
    const target = await createLinkedMemberAccount('reopen-last');
    await bindOpsAdmin(target.user.id, role.id);

    expectBizError(
      await reopenAccount(target.member.id, '13800001001'),
      BizCode.LAST_OPS_ADMIN_PROTECTED,
    );
    await expectUserAndBindingPreserved(target.user.id, role.id);
    expect(
      await prisma.user.count({ where: { memberId: target.member.id, deletedAt: null } }),
    ).toBe(1);
  });

  it('存在第二个 active ops-admin 时：status / offboard / reopen 三门均放行并始终留一人', async () => {
    const role = await createOpsAdminRole();
    const backup = await createTestUser(app, { username: 'member-ops-backup', role: Role.USER });
    await bindOpsAdmin(backup.id, role.id);

    const statusTarget = await createLinkedMemberAccount('status-backup');
    const offboardTarget = await createLinkedMemberAccount('offboard-backup');
    const reopenTarget = await createLinkedMemberAccount('reopen-backup');
    await bindOpsAdmin(statusTarget.user.id, role.id);
    await bindOpsAdmin(offboardTarget.user.id, role.id);
    await bindOpsAdmin(reopenTarget.user.id, role.id);

    expect((await updateAccountStatus(statusTarget.member.id)).status).toBe(200);
    expect((await offboard(offboardTarget.member.id)).status).toBe(200);
    expect((await reopenAccount(reopenTarget.member.id, '13800001002')).status).toBe(200);

    expect(await countActiveOpsAdminHolders(role.id)).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: backup.id } })).status).toBe(
      UserStatus.ACTIVE,
    );
  });

  it('非 ops-admin 队员账号：status / offboard / reopen 三门行为不变', async () => {
    const statusTarget = await createLinkedMemberAccount('status-plain');
    const offboardTarget = await createLinkedMemberAccount('offboard-plain');
    const reopenTarget = await createLinkedMemberAccount('reopen-plain');

    expect((await updateAccountStatus(statusTarget.member.id)).status).toBe(200);
    expect((await offboard(offboardTarget.member.id)).status).toBe(200);
    expect((await reopenAccount(reopenTarget.member.id, '13800001003')).status).toBe(200);
  });

  it('跨轴并发：members.updateAccountStatus ∥ users.disable 同削最后两名 ops-admin → 恰一成功', async () => {
    const role = await createOpsAdminRole();
    const membersAxisTarget = await createLinkedMemberAccount('concurrent-members');
    const usersAxisTarget = await createLinkedMemberAccount('concurrent-users');
    await bindOpsAdmin(membersAxisTarget.user.id, role.id);
    await bindOpsAdmin(usersAxisTarget.user.id, role.id);

    const responses = await Promise.all([
      updateAccountStatus(membersAxisTarget.member.id),
      disableThroughUsersAxis(usersAxisTarget.user.id),
    ]);
    const successes = responses.filter((res) => res.status === 200);
    const protectedResponses = responses.filter(
      (res) => res.body.code === BizCode.LAST_OPS_ADMIN_PROTECTED.code,
    );

    expect(successes).toHaveLength(1);
    expect(protectedResponses).toHaveLength(1);
    expectBizError(protectedResponses[0], BizCode.LAST_OPS_ADMIN_PROTECTED);
    expect(await countActiveOpsAdminHolders(role.id)).toBe(1);

    const statuses = await prisma.user.findMany({
      where: { id: { in: [membersAxisTarget.user.id, usersAxisTarget.user.id] } },
      orderBy: { id: 'asc' },
      select: { status: true },
    });
    expect(statuses.map(({ status }) => status).sort()).toEqual([
      UserStatus.ACTIVE,
      UserStatus.DISABLED,
    ]);
  });
});
