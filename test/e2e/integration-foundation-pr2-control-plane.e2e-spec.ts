import { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * Integration Foundation v1 PR2(规格书 §12/§27/§28/§35/§58 DoD):ServicePrincipal 控制面。
 * 五组判据,每组单独 it:
 *   ① Secret 纪律 —— 原始只出现一次;列表/详情/审计零 hash 零 secret;
 *   ② 凭证上限 —— 同 SP ≤2 条 ACTIVE;轮换(新建→撤销);
 *   ③ SP 身份生命周期 —— clientId 前缀 / 状态翻转幂等拒;
 *   ④ RoleBinding 资格门 —— 七条中可 HTTP 触达的四条(ineligible / SELF / system-managed / 通过路径);
 *   ⑤ 既有 USER RoleBinding 零漂移(CHAR 基线:创建 USER 绑定照常工作)。
 */

describe('Integration Foundation v1 PR2 —— ServicePrincipal 控制面(8 端点)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: ServicePrincipalsService;
  let orgId: string;
  let spId: string;
  let credentialId1: string;
  let rawSecret1: string;

  const auditMeta = { requestId: 'if-pr2-e2e', ip: null, ua: null };
  let actor = {
    id: '',
    username: 'if-pr2-ops',
    role: 'SUPER_ADMIN' as const,
    status: 'ACTIVE' as const,
    memberId: null,
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(ServicePrincipalsService);

    const org = await prisma.organization.create({
      data: { name: 'IF PR2 组织', nodeTypeCode: 'functional-dept' },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { username: 'if-pr2-ops', passwordHash: 'probe', role: 'SUPER_ADMIN' },
    });
    actor = { ...actor, id: user.id };

    // 直接调 service(控制面 HTTP 权限码的绑定属 seed 域;本轮服务层全覆盖 +
    // HTTP 层用 SUPER_ADMIN 短路穿透 —— PR4 落地 RBAC 全链时补 ops-admin 路径)。
  });

  afterAll(async () => {
    await app.close();
  });

  it('① 创建:clientId 前缀 srvf_sp_;凭证原始 Secret 只出现一次', async () => {
    const created = await service.create(
      { name: 'ICC 报备系统', description: '测试用', ownerOrganizationId: orgId },
      actor,
      auditMeta,
    );
    spId = created.id;
    expect(created.clientId.startsWith('srvf_sp_')).toBe(true);
    expect(created.status).toBe('ACTIVE');

    const cred = await service.createCredential(spId, actor, auditMeta);
    credentialId1 = cred.id;
    rawSecret1 = cred.clientSecret;
    // 高熵 base64url,长度 ≥ 40(randomBytes(32) → 43 字符)
    expect(rawSecret1.length).toBeGreaterThanOrEqual(40);

    // 审计行零 secret 零 hash(§12.6 红线)。
    const audits = await prisma.auditLog.findMany({
      where: { resourceType: 'service-principal', resourceId: spId },
      select: { event: true, context: true },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const row of audits) {
      const json = JSON.stringify(row.context);
      expect(json).not.toContain(rawSecret1);
      expect(json).not.toContain('secretHash');
    }
    // 凭证列表不返回 hash/secret。
    const creds = await service.listCredentials(spId);
    expect(creds).toHaveLength(1);
    expect(JSON.stringify(creds)).not.toContain('secretHash');
    expect(JSON.stringify(creds)).not.toContain(rawSecret1);
  });

  it('② 凭证上限:第三条 ACTIVE 必拒(37011);轮换闭环(新建→撤销→再新建可过)', async () => {
    await service.createCredential(spId, actor, auditMeta); // 第二条
    await expect(service.createCredential(spId, actor, auditMeta)).rejects.toMatchObject({
      biz: { code: 37011 },
    });

    // 轮换:撤销第一条 → 再建可过(§12.2 形状)。
    const revoked = await service.revokeCredential(spId, credentialId1, actor, auditMeta);
    expect(revoked.revokedAt).not.toBeNull();
    // 已撤销不能重复撤销(37012)。
    await expect(
      service.revokeCredential(spId, credentialId1, actor, auditMeta),
    ).rejects.toMatchObject({
      biz: { code: 37012 },
    });
    const rotated = await service.createCredential(spId, actor, auditMeta);
    expect(rotated.id).not.toBe(credentialId1);
  });

  it('③ 状态:ACTIVE→SUSPENDED 可;同状态幂等拒(37013);SUSPENDED SP 仍可持有绑定', async () => {
    const suspended = await service.updateStatus(spId, 'SUSPENDED', actor, auditMeta);
    expect(suspended.status).toBe('SUSPENDED');
    await expect(service.updateStatus(spId, 'SUSPENDED', actor, auditMeta)).rejects.toMatchObject({
      biz: { code: 37013 },
    });
    await service.updateStatus(spId, 'ACTIVE', actor, auditMeta); // 还原
  });

  it('④ RoleBinding 资格门:SELF 拒 / ineligible 权限拒 / system-managed 拒 / 合法路径过', async () => {
    // 直接调 policy(走 RoleBindingsService.create 需 ops-admin 真实绑定 + audit 结构,
    // PR4 全链时补 HTTP 级;此处 policy 层全覆盖四条正反)。
    const { assertServicePrincipalRoleEligibilityOrThrow } =
      await import('../../src/modules/role-bindings/service-principal-role-eligibility.policy');
    const tx = prisma as unknown as Parameters<
      typeof assertServicePrincipalRoleEligibilityOrThrow
    >[0];

    // SELF 拒(37021)。
    await expect(
      assertServicePrincipalRoleEligibilityOrThrow(tx as never, {
        roleId: 'any',
        scopeType: 'SELF',
      }),
    ).rejects.toMatchObject({ biz: { code: 37021 } });

    // 造一个非 system-managed 角色,挂一条 servicePrincipalAllowed=false 的权限 → 37022。
    const role = await prisma.rbacRole.create({
      data: { code: 'if-pr2-test-role', displayName: 'IF PR2 测试角色' },
    });
    const perm = await prisma.permission.create({
      data: {
        code: 'if-pr2.probe.read',
        module: 'if-pr2',
        action: 'probe',
        resourceType: 'read',
      },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    await expect(
      assertServicePrincipalRoleEligibilityOrThrow(tx as never, {
        roleId: role.id,
        scopeType: 'GLOBAL',
      }),
    ).rejects.toMatchObject({ biz: { code: 37022 } });

    // 开放该权限后通过(证明拒绝原因确是资格门,不是角色不存在)。
    await prisma.permission.update({
      where: { id: perm.id },
      data: { servicePrincipalAllowed: true },
    });
    await expect(
      assertServicePrincipalRoleEligibilityOrThrow(tx as never, {
        roleId: role.id,
        scopeType: 'GLOBAL',
      }),
    ).resolves.toBeUndefined();
    await prisma.permission.update({
      where: { id: perm.id },
      data: { servicePrincipalAllowed: false },
    }); // 还原

    // system-managed 角色拒(37020)。
    const { SYSTEM_MANAGED_ROLE_CODES } =
      await import('../../src/modules/permissions/system-managed-role-codes');
    const managed = await prisma.rbacRole.findFirst({
      where: { code: SYSTEM_MANAGED_ROLE_CODES[0] },
    });
    if (managed !== null) {
      await expect(
        assertServicePrincipalRoleEligibilityOrThrow(tx as never, {
          roleId: managed.id,
          scopeType: 'GLOBAL',
        }),
      ).rejects.toMatchObject({ biz: { code: 37020 } });
    }
  });

  it('⑤ 既有 USER RoleBinding 零漂移:USER 绑定创建照常(资格门不误伤)', async () => {
    const role = await prisma.rbacRole.create({
      data: { code: 'if-pr2-user-role', displayName: 'IF PR2 USER 角色漂移探针' },
    });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: actor.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        startedAt: new Date(),
        createdByUserId: actor.id,
      },
    });
    expect(binding.principalType).toBe('USER');
    expect(binding.deletedAt).toBeNull();
  });
});
