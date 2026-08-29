import { INestApplication } from '@nestjs/common';
import { BindingScopeType } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { DirectPrincipalAuthzService } from '../../src/modules/integration-authz/direct-principal-authz.service';
import { RoleBindingScopeCoveragePolicy } from '../../src/modules/integration-authz/role-binding-scope-coverage.policy';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * Integration Foundation v1 PR4(规格书 §15.3/§17/§60):Principal-neutral Authz。
 *
 * 五组:
 *   ① SP direct binding 判权:有绑定+角色含码+资格门开 → allow;
 *   ② 资格门运行时执法:角色含码但 servicePrincipalAllowed=false → 结构性看不见;
 *   ③ 零旁路:SP 无 SUPER_ADMIN 短路 / 无 Member/Position 虚拟 grant / SELF 恒不覆盖;
 *   ④ scope coverage 共享 Policy:五种 scopeType 逐个判(GLOBAL 恒真/ORGANIZATION 精确/
 *      TREE 含根+后代/ACTIVITY 精确/RESOURCE 双键);
 *   ⑤ characterization:现有 User 路径零漂移(RbacService.can 对 USER 照常)。
 */

describe('Integration Foundation v1 PR4 —— Principal-neutral Authz', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: DirectPrincipalAuthzService;
  let coverage: RoleBindingScopeCoveragePolicy;

  let spId: string;
  let userId: string;
  let roleId: string;
  let orgId: string;
  let childOrgId: string;
  const actor = {
    id: '',
    username: 'if-pr4-ops',
    role: 'SUPER_ADMIN' as const,
    status: 'ACTIVE' as const,
    memberId: null,
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    authz = app.get(DirectPrincipalAuthzService);
    coverage = app.get(RoleBindingScopeCoveragePolicy);

    const user = await prisma.user.create({
      data: { username: 'if-pr4-ops', passwordHash: 'probe', role: 'SUPER_ADMIN' },
    });
    actor.id = user.id;
    userId = user.id;

    const sp = await prisma.servicePrincipal.create({
      data: {
        clientId: 'srvf_sp_pr4_probe',
        name: 'PR4 探针',
        createdByUserId: user.id,
      },
    });
    spId = sp.id;

    const org = await prisma.organization.create({
      data: { name: 'PR4 根组织', nodeTypeCode: 'functional-dept' },
    });
    orgId = org.id;
    const child = await prisma.organization.create({
      data: { name: 'PR4 子组织', nodeTypeCode: 'functional-dept', parentId: orgId },
    });
    childOrgId = child.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: orgId, descendantId: orgId, depth: 0 },
        { ancestorId: orgId, descendantId: childOrgId, depth: 1 },
        { ancestorId: childOrgId, descendantId: childOrgId, depth: 0 },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeRoleWithCode(
    code: string,
    permissionCode: string,
    allowed: boolean,
  ): Promise<string> {
    const perm =
      (await prisma.permission.findUnique({ where: { code: permissionCode } })) ??
      (await prisma.permission.create({
        data: {
          code: permissionCode,
          module: permissionCode.split('.')[0],
          action: permissionCode.split('.')[1],
          resourceType: permissionCode.split('.')[2],
        },
      }));
    if (perm.servicePrincipalAllowed !== allowed) {
      await prisma.permission.update({
        where: { id: perm.id },
        data: { servicePrincipalAllowed: allowed },
      });
    }
    const role = await prisma.rbacRole.create({
      data: { code, displayName: code },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    return role.id;
  }

  it('① SP direct binding:绑定+含码+资格门开 → allow(附 matched grants)', async () => {
    roleId = await makeRoleWithCode('pr4-allow-role', 'pr4.test.read', true);
    await prisma.roleBinding.create({
      data: {
        principalType: 'SERVICE_PRINCIPAL',
        principalId: spId,
        roleId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        startedAt: new Date(),
        createdByUserId: userId,
      },
    });
    const decision = await authz.explainDirect(
      { principalType: 'SERVICE_PRINCIPAL', principalId: spId },
      'pr4.test.read',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.matched).toHaveLength(1);
    expect(decision.matched[0].roleCode).toBe('pr4-allow-role');
    expect(decision.matched[0].scopeType).toBe(BindingScopeType.GLOBAL);
    expect(decision.reason).toBe('allowed');
  });

  it('② 资格门运行时执法:含码但 servicePrincipalAllowed=false → 结构性看不见', async () => {
    // 把权限的资格门关掉(模拟「向已绑定的 Role 后续扩权/运营面改库」)
    await prisma.permission.update({
      where: { code: 'pr4.test.read' },
      data: { servicePrincipalAllowed: false },
    });
    const decision = await authz.explainDirect(
      { principalType: 'SERVICE_PRINCIPAL', principalId: spId },
      'pr4.test.read',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('eligibility-blocked');
    // 还原
    await prisma.permission.update({
      where: { code: 'pr4.test.read' },
      data: { servicePrincipalAllowed: true },
    });
  });

  it('③ 零旁路:无绑定 → no-bindings;不存在码 → no-eligible-permission', async () => {
    const empty = await authz.explainDirect(
      { principalType: 'SERVICE_PRINCIPAL', principalId: 'sp_nonexistent' },
      'pr4.test.read',
    );
    expect(empty.allowed).toBe(false);
    expect(empty.reason).toBe('no-bindings');

    const noPerm = await authz.explainDirect(
      { principalType: 'SERVICE_PRINCIPAL', principalId: spId },
      'pr4.absent.code',
    );
    expect(noPerm.allowed).toBe(false);
    expect(noPerm.reason).toBe('no-eligible-permission');
  });

  it('④ scope coverage:GLOBAL 恒真 / ORG 精确 / TREE 含后代 / ACTIVITY 精确 / SELF 恒假', async () => {
    const g = (
      scopeType: BindingScopeType,
      overrides: Partial<Parameters<typeof coverage.covers>[0]> = {},
    ) =>
      ({
        scopeType,
        scopeOrgId: overrides.scopeOrgId ?? null,
        scopeActivityId: overrides.scopeActivityId ?? null,
        scopeResourceType: overrides.scopeResourceType ?? null,
        scopeResourceId: overrides.scopeResourceId ?? null,
      }) as const;

    // GLOBAL
    expect(await coverage.covers(g(BindingScopeType.GLOBAL), {})).toBe(true);
    // ORGANIZATION:精确匹配 / 不匹配
    expect(
      await coverage.covers(g(BindingScopeType.ORGANIZATION, { scopeOrgId: orgId }), {
        organizationId: orgId,
      }),
    ).toBe(true);
    expect(
      await coverage.covers(g(BindingScopeType.ORGANIZATION, { scopeOrgId: orgId }), {
        organizationId: childOrgId,
      }),
    ).toBe(false);
    // TREE:含根+后代 / 树外 false
    expect(
      await coverage.covers(g(BindingScopeType.ORGANIZATION_TREE, { scopeOrgId: orgId }), {
        organizationId: childOrgId,
      }),
    ).toBe(true);
    expect(
      await coverage.covers(g(BindingScopeType.ORGANIZATION_TREE, { scopeOrgId: orgId }), {
        organizationId: orgId,
      }),
    ).toBe(true);
    expect(
      await coverage.covers(g(BindingScopeType.ORGANIZATION_TREE, { scopeOrgId: childOrgId }), {
        organizationId: orgId,
      }),
    ).toBe(false);
    // ACTIVITY
    expect(
      await coverage.covers(g(BindingScopeType.ACTIVITY, { scopeActivityId: 'act1' }), {
        activityId: 'act1',
      }),
    ).toBe(true);
    expect(
      await coverage.covers(g(BindingScopeType.ACTIVITY, { scopeActivityId: 'act1' }), {
        activityId: 'act2',
      }),
    ).toBe(false);
    // RESOURCE:双键
    expect(
      await coverage.covers(
        g(BindingScopeType.RESOURCE, { scopeResourceType: 'member', scopeResourceId: 'm1' }),
        { resourceType: 'member', resourceId: 'm1' },
      ),
    ).toBe(true);
    expect(
      await coverage.covers(
        g(BindingScopeType.RESOURCE, { scopeResourceType: 'member', scopeResourceId: 'm1' }),
        { resourceType: 'member', resourceId: 'm2' },
      ),
    ).toBe(false);
    // SELF 恒假
    expect(await coverage.covers(g(BindingScopeType.SELF), {})).toBe(false);
  });

  it('⑤ characterization:现有 User 判权零漂移(SUPER_ADMIN can / RbacService 路径)', async () => {
    // 最简正向:同一权限码,USER direct binding 也能通过现有 RbacService。
    // SP 权限的资格门对 USER 判权**不构成过滤**(那是 SP-only 的门)—— 结构性证明:
    // 关掉资格门后 USER 路径不受影响。
    await prisma.permission.update({
      where: { code: 'pr4.test.read' },
      data: { servicePrincipalAllowed: false },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        startedAt: new Date(),
        createdByUserId: userId,
      },
    });
    // SP 被资格门挡(② 已证);USER 不受影响 —— RbacService.getUserPermissionCodes 不过滤该字段。
    const { RbacService } = await import('../../src/modules/permissions/rbac.service');
    const rbac = app.get(RbacService);
    const codes = await rbac.getUserPermissionCodes(userId);
    expect(codes.has('pr4.test.read')).toBe(true);
    // SP 侧仍拒
    const spDecision = await authz.explainDirect(
      { principalType: 'SERVICE_PRINCIPAL', principalId: spId },
      'pr4.test.read',
    );
    expect(spDecision.allowed).toBe(false);
  });
});
