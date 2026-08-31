import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, Prisma, PrincipalType, Role } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { DirectPrincipalAuthzService } from '../../src/modules/integration-authz/direct-principal-authz.service';
import { RoleBindingsService } from '../../src/modules/role-bindings/role-bindings.service';
import { RolePermissionsService } from '../../src/modules/permissions/role-permissions.service';
import { RbacRolesService } from '../../src/modules/permissions/rbac-roles.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const execFileAsync = promisify(execFile);
const ROOT = resolve(__dirname, '../..');

/**
 * C2: Service Principal Role 不变量。
 *
 * 关键并发不能用 mock：两个 Nest 应用、三个独立 Prisma 连接和真实 `roles FOR UPDATE`
 * 屏障共同验证 RolePermission 改写与 SP Binding 创建/恢复会在同一条角色行上串行化。
 */

const META: AuditMeta = {
  requestId: 'service-principal-role-invariant-e2e',
  ip: '127.0.0.1',
  ua: 'jest/service-principal-role-invariant',
};
const WAIT_TIMEOUT_MS = 1_200;

interface TransactionBarrier {
  ready: Promise<void>;
  release: () => void;
  done: Promise<void>;
}

interface PreflightReport {
  readonly undeletedSpBindingCount: number;
  readonly selfScopeViolationCount: number;
  readonly deletedRoleViolationCount: number;
  readonly systemManagedRoleViolationCount: number;
  readonly ineligiblePermissionViolationCount: number;
  readonly affectedRoleIds: readonly string[];
  readonly affectedBindingIds: readonly string[];
  readonly affectedPermissionCodes: readonly string[];
}

interface PreflightRun {
  readonly exitCode: number;
  readonly report: PreflightReport;
}

interface PreflightProcessError extends Error {
  readonly code?: number;
  readonly stdout?: string;
}

describe('Service Principal Role 资格不变量(C2)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let barrierPrisma: PrismaService;
  let rolePermissionsA: RolePermissionsService;
  let roleBindingsA: RoleBindingsService;
  let roleBindingsB: RoleBindingsService;
  let rbacRolesA: RbacRolesService;
  let directPrincipalAuthzA: DirectPrincipalAuthzService;
  let actor: CurrentUserPayload;
  let sequence = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    barrierPrisma = new PrismaService();
    await barrierPrisma.$connect();
    rolePermissionsA = appA.get(RolePermissionsService);
    roleBindingsA = appA.get(RoleBindingsService);
    roleBindingsB = appB.get(RoleBindingsService);
    rbacRolesA = appA.get(RbacRolesService);
    directPrincipalAuthzA = appA.get(DirectPrincipalAuthzService);

    const user = await prismaA.user.create({
      data: { username: 'sp-role-invariant-admin', passwordHash: 'probe', role: Role.SUPER_ADMIN },
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    };
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close(), barrierPrisma.$disconnect()]);
  });

  function next(label: string): string {
    sequence += 1;
    return `spc2-${label}-${sequence}`;
  }

  async function runInvariantPreflight(): Promise<PreflightRun> {
    try {
      const { stdout } = await execFileAsync(
        'pnpm',
        ['exec', 'tsx', 'scripts/check-service-principal-role-invariant.ts'],
        { cwd: ROOT, env: process.env },
      );
      return { exitCode: 0, report: JSON.parse(stdout) as PreflightReport };
    } catch (error: unknown) {
      const failed = error as PreflightProcessError;
      if (typeof failed.code !== 'number' || typeof failed.stdout !== 'string') throw error;
      return { exitCode: failed.code, report: JSON.parse(failed.stdout) as PreflightReport };
    }
  }

  async function createRole(label: string): Promise<{ id: string; permissionRevision: number }> {
    return prismaA.rbacRole.create({
      data: { code: next(`role-${label}`), displayName: `SP C2 ${label}` },
      select: { id: true, permissionRevision: true },
    });
  }

  async function createPermission(
    label: string,
    servicePrincipalAllowed: boolean,
  ): Promise<{ id: string; code: string }> {
    const code = `${next(label)}.read.record`;
    return prismaA.permission.create({
      data: {
        code,
        module: 'spc2',
        action: label,
        resourceType: 'record',
        servicePrincipalAllowed,
      },
      select: { id: true, code: true },
    });
  }

  async function createServicePrincipal(label: string): Promise<{ id: string }> {
    return prismaA.servicePrincipal.create({
      data: {
        clientId: `srvf_sp_${next(label)}`,
        name: `SP C2 ${label}`,
        createdByUserId: actor.id,
      },
      select: { id: true },
    });
  }

  async function createDirectSpBinding(input: {
    roleId: string;
    servicePrincipalId: string;
    status?: BindingStatus;
    startedAt?: Date;
    endedAt?: Date | null;
  }): Promise<{ id: string }> {
    return prismaA.roleBinding.create({
      data: {
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        principalId: input.servicePrincipalId,
        roleId: input.roleId,
        scopeType: BindingScopeType.GLOBAL,
        status: input.status ?? BindingStatus.ACTIVE,
        startedAt: input.startedAt ?? new Date('2026-01-01T00:00:00.000Z'),
        endedAt: input.endedAt ?? null,
        createdByUserId: actor.id,
      },
      select: { id: true },
    });
  }

  async function currentRevision(roleId: string): Promise<number> {
    const role = await prismaA.rbacRole.findUniqueOrThrow({
      where: { id: roleId },
      select: { permissionRevision: true },
    });
    return role.permissionRevision;
  }

  async function currentPermissionCodes(roleId: string): Promise<Set<string>> {
    const rows = await prismaA.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    return new Set(rows.map((row) => row.permission.code));
  }

  async function assertNoSpRoleInvariantViolation(roleId: string): Promise<void> {
    const bindings = await prismaB.roleBinding.findMany({
      where: {
        roleId,
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        deletedAt: null,
      },
      select: {
        id: true,
        scopeType: true,
        role: {
          select: {
            deletedAt: true,
            code: true,
            rolePermissions: {
              select: { permission: { select: { code: true, servicePrincipalAllowed: true } } },
            },
          },
        },
      },
    });
    const violations = bindings.flatMap((binding) => {
      const permissions = binding.role.rolePermissions.map((row) => row.permission);
      if (
        binding.scopeType === BindingScopeType.SELF ||
        binding.role.deletedAt !== null ||
        permissions.some((permission) => !permission.servicePrincipalAllowed)
      ) {
        return [binding.id];
      }
      return [];
    });
    expect(violations).toEqual([]);
  }

  async function waitForRoleLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const [row] = await prismaA.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "roles"%FOR UPDATE%'
      `);
      if ((row?.n ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${expected} waiter(s) on the shared roles FOR UPDATE lock`);
  }

  function holdRoleLock(roleId: string): TransactionBarrier {
    let signalReady!: () => void;
    let releaseBarrier!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const done = barrierPrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "roles" WHERE id = ${roleId} FOR UPDATE`;
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => releaseBarrier(), done };
  }

  it('只读预检在干净库为 0', async () => {
    await expect(runInvariantPreflight()).resolves.toEqual({
      exitCode: 0,
      report: {
        undeletedSpBindingCount: 0,
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 0,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 0,
        affectedRoleIds: [],
        affectedBindingIds: [],
        affectedPermissionCodes: [],
      },
    });
  });

  it('无 SP Binding 时，普通角色仍可加入不合格 Permission', async () => {
    const role = await createRole('ordinary');
    const ineligible = await createPermission('ordinary-ineligible', false);

    await expect(
      rolePermissionsA.replace(
        actor,
        role.id,
        { permissionCodes: [ineligible.code], expectedRevision: role.permissionRevision },
        META,
      ),
    ).resolves.toBeDefined();
    expect(await currentPermissionCodes(role.id)).toEqual(new Set([ineligible.code]));
  });

  it('任一未软删 SP Binding 存在时，RolePermission 最终集不得含不合格 Permission', async () => {
    const role = await createRole('bound-reject');
    const ineligible = await createPermission('bound-reject-ineligible', false);
    const servicePrincipal = await createServicePrincipal('bound-reject');
    await createDirectSpBinding({ roleId: role.id, servicePrincipalId: servicePrincipal.id });

    await expect(
      rolePermissionsA.replace(
        actor,
        role.id,
        { permissionCodes: [ineligible.code], expectedRevision: 0 },
        META,
      ),
    ).rejects.toMatchObject({
      biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
    });
    expect(await currentPermissionCodes(role.id)).toEqual(new Set());
  });

  it('SUSPENDED、未来生效和已过期但未软删的 SP Binding 同样阻止不合格最终集', async () => {
    const variants = [
      {
        label: 'suspended',
        status: BindingStatus.SUSPENDED,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        label: 'future',
        status: BindingStatus.ACTIVE,
        startedAt: new Date('2099-01-01T00:00:00.000Z'),
      },
      {
        label: 'expired',
        status: BindingStatus.ACTIVE,
        startedAt: new Date('2000-01-01T00:00:00.000Z'),
        endedAt: new Date('2001-01-01T00:00:00.000Z'),
      },
    ];

    for (const variant of variants) {
      const role = await createRole(variant.label);
      const ineligible = await createPermission(`${variant.label}-ineligible`, false);
      const servicePrincipal = await createServicePrincipal(variant.label);
      await createDirectSpBinding({
        roleId: role.id,
        servicePrincipalId: servicePrincipal.id,
        status: variant.status,
        startedAt: variant.startedAt,
        ...(variant.endedAt === undefined ? {} : { endedAt: variant.endedAt }),
      });

      await expect(
        rolePermissionsA.replace(
          actor,
          role.id,
          { permissionCodes: [ineligible.code], expectedRevision: 0 },
          META,
        ),
      ).rejects.toMatchObject({
        biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
      });
    }
  });

  it('SP Binding 绑定到全部合格的最终权限集可以通过', async () => {
    const role = await createRole('eligible-set');
    const eligible = await createPermission('eligible-set-permission', true);
    const servicePrincipal = await createServicePrincipal('eligible-set');
    await createDirectSpBinding({ roleId: role.id, servicePrincipalId: servicePrincipal.id });

    await expect(
      rolePermissionsA.replace(
        actor,
        role.id,
        { permissionCodes: [eligible.code], expectedRevision: 0 },
        META,
      ),
    ).resolves.toBeDefined();
    await assertNoSpRoleInvariantViolation(role.id);
  });

  it('先撤销 SP Binding 后 Role 可以删除，预检保持零违规', async () => {
    const role = await createRole('delete-after-revoke');
    const servicePrincipal = await createServicePrincipal('delete-after-revoke');
    const binding = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: servicePrincipal.id,
    });

    await roleBindingsA.remove(actor, binding.id, META);
    await expect(rbacRolesA.softDelete(actor, role.id, META)).resolves.toMatchObject({
      id: role.id,
    });

    await expect(
      prismaA.roleBinding.findUnique({ where: { id: binding.id }, select: { deletedAt: true } }),
    ).resolves.toEqual({ deletedAt: expect.any(Date) });
    await expect(
      prismaA.rbacRole.findUnique({ where: { id: role.id }, select: { deletedAt: true } }),
    ).resolves.toEqual({ deletedAt: expect.any(Date) });

    const preflight = await runInvariantPreflight();
    expect(preflight).toEqual({
      exitCode: 0,
      report: expect.objectContaining({
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 0,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 0,
        affectedRoleIds: [],
        affectedBindingIds: [],
        affectedPermissionCodes: [],
      }),
    });
  });

  it('历史脏状态：Role 已软删但 SP Binding 未撤销时，运行时拒绝且预检精准报 deletedRoleViolation', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const injectedDeletedAt = new Date('2026-08-31T12:34:56.000Z');
    const role = await createRole('historical-deleted-role');
    const permission = await createPermission('historical-deleted-role-permission', true);
    const servicePrincipal = await createServicePrincipal('historical-deleted-role');
    await prismaA.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const binding = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: servicePrincipal.id,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      directPrincipalAuthzA.explainDirect(
        { principalType: PrincipalType.SERVICE_PRINCIPAL, principalId: servicePrincipal.id },
        permission.code,
        now,
      ),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
      matched: [{ bindingId: binding.id, roleId: role.id }],
    });

    const auditBefore = await prismaA.auditLog.count();
    try {
      // 只为模拟旧版本、人工 SQL 或历史迁移遗留的脏状态；生产路径必须走领域 Service。
      await prismaA.rbacRole.update({
        where: { id: role.id },
        data: { deletedAt: injectedDeletedAt },
      });

      await expect(
        directPrincipalAuthzA.explainDirect(
          { principalType: PrincipalType.SERVICE_PRINCIPAL, principalId: servicePrincipal.id },
          permission.code,
          now,
        ),
      ).resolves.toEqual({ allowed: false, matched: [], reason: 'no-bindings' });

      const preflight = await runInvariantPreflight();
      expect(preflight.exitCode).toBe(1);
      expect(preflight.report).toMatchObject({
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 1,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 0,
        affectedRoleIds: [role.id],
        affectedBindingIds: [binding.id],
        affectedPermissionCodes: [],
      });
      expect(preflight.report.undeletedSpBindingCount).toBeGreaterThan(0);

      const [observedRole, observedBinding, auditAfter] = await Promise.all([
        prismaA.rbacRole.findUnique({ where: { id: role.id }, select: { deletedAt: true } }),
        prismaA.roleBinding.findUnique({ where: { id: binding.id }, select: { deletedAt: true } }),
        prismaA.auditLog.count(),
      ]);
      expect(observedRole).toEqual({ deletedAt: injectedDeletedAt });
      expect(observedBinding).toEqual({ deletedAt: null });
      expect(auditAfter).toBe(auditBefore);
    } finally {
      await prismaA.rbacRole.update({ where: { id: role.id }, data: { deletedAt: null } });
    }

    await assertNoSpRoleInvariantViolation(role.id);
    await expect(runInvariantPreflight()).resolves.toMatchObject({
      exitCode: 0,
      report: {
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 0,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 0,
        affectedRoleIds: [],
        affectedBindingIds: [],
        affectedPermissionCodes: [],
      },
    });
  });

  it.each([
    {
      label: 'Binding 先取得 Role 锁',
      first: 'binding' as const,
      rejectedBizCode: BizCode.ROLE_HAS_SERVICE_PRINCIPAL_BINDINGS.code,
    },
    {
      label: 'Role 删除先取得 Role 锁',
      first: 'delete' as const,
      rejectedBizCode: BizCode.ROLE_BINDING_ROLE_INELIGIBLE_FOR_SERVICE_PRINCIPAL.code,
    },
  ])('真实并发 C：$label → 恰好一方成功且预检保持零违规', async (race) => {
    const role = await createRole(`race-role-delete-${race.first}`);
    const servicePrincipal = await createServicePrincipal(`race-role-delete-${race.first}`);
    const barrier = holdRoleLock(role.id);
    await barrier.ready;

    // 两套 Nest / Prisma 实例必须真的独立，否则这不是跨请求并发。
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

    let bindingCreate: Promise<unknown>;
    let roleDelete: Promise<unknown>;
    if (race.first === 'binding') {
      bindingCreate = roleBindingsB.create(
        actor,
        {
          principalType: PrincipalType.SERVICE_PRINCIPAL,
          principalId: servicePrincipal.id,
          roleId: role.id,
          scopeType: BindingScopeType.GLOBAL,
        },
        META,
      );
      await waitForRoleLockWaiters(1);
      roleDelete = rbacRolesA.softDelete(actor, role.id, META);
    } else {
      roleDelete = rbacRolesA.softDelete(actor, role.id, META);
      await waitForRoleLockWaiters(1);
      bindingCreate = roleBindingsB.create(
        actor,
        {
          principalType: PrincipalType.SERVICE_PRINCIPAL,
          principalId: servicePrincipal.id,
          roleId: role.id,
          scopeType: BindingScopeType.GLOBAL,
        },
        META,
      );
    }

    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await waitForRoleLockWaiters(2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled([bindingCreate, roleDelete]);
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ biz: { code: race.rejectedBizCode } });
    await assertNoSpRoleInvariantViolation(role.id);

    const preflight = await runInvariantPreflight();
    expect(preflight).toEqual({
      exitCode: 0,
      report: expect.objectContaining({
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 0,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 0,
        affectedRoleIds: [],
        affectedBindingIds: [],
        affectedPermissionCodes: [],
      }),
    });
  });

  it('脏权限集可通过删除不合格 Permission 修复，但 no-op 与 preview 都必须暴露漂移且零副作用', async () => {
    const role = await createRole('dirty-cleanup');
    const eligible = await createPermission('dirty-cleanup-eligible', true);
    const ineligible = await createPermission('dirty-cleanup-ineligible', false);
    const servicePrincipal = await createServicePrincipal('dirty-cleanup');
    await prismaA.rolePermission.create({ data: { roleId: role.id, permissionId: ineligible.id } });
    await createDirectSpBinding({ roleId: role.id, servicePrincipalId: servicePrincipal.id });
    const revisionBefore = await currentRevision(role.id);
    const auditBefore = await prismaA.auditLog.count({
      where: { resourceType: 'role_permission', resourceId: role.id },
    });

    const preflight = await runInvariantPreflight();
    expect(preflight.exitCode).toBe(1);
    expect(preflight.report).toEqual(
      expect.objectContaining({
        undeletedSpBindingCount: expect.any(Number),
        selfScopeViolationCount: 0,
        deletedRoleViolationCount: 0,
        systemManagedRoleViolationCount: 0,
        ineligiblePermissionViolationCount: 1,
        affectedRoleIds: [role.id],
        affectedBindingIds: [expect.any(String)],
        affectedPermissionCodes: [ineligible.code],
      }),
    );
    expect(preflight.report.undeletedSpBindingCount).toBeGreaterThan(0);

    await expect(
      rolePermissionsA.replace(
        actor,
        role.id,
        { permissionCodes: [ineligible.code], expectedRevision: revisionBefore },
        META,
      ),
    ).rejects.toMatchObject({
      biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
    });
    const preview = await rolePermissionsA.previewReplace(actor, role.id, {
      permissionCodes: [ineligible.code],
      expectedRevision: revisionBefore,
    });
    expect(preview).toMatchObject({
      valid: false,
      blockingIssues: [
        { bizCode: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
      ],
      outcome: null,
    });
    expect(await currentRevision(role.id)).toBe(revisionBefore);
    expect(
      await prismaA.auditLog.count({
        where: { resourceType: 'role_permission', resourceId: role.id },
      }),
    ).toBe(auditBefore);

    await expect(
      rolePermissionsA.replace(
        actor,
        role.id,
        { permissionCodes: [eligible.code], expectedRevision: revisionBefore },
        META,
      ),
    ).resolves.toBeDefined();
    expect(await currentPermissionCodes(role.id)).toEqual(new Set([eligible.code]));
    await assertNoSpRoleInvariantViolation(role.id);
  });

  it('新建 SP Binding 会复核完整资格门，batch 路径同样复用该校验', async () => {
    const eligibleRole = await createRole('create-eligible');
    const eligible = await createPermission('create-eligible-permission', true);
    await prismaA.rolePermission.create({
      data: { roleId: eligibleRole.id, permissionId: eligible.id },
    });
    const eligibleSp = await createServicePrincipal('create-eligible');
    await expect(
      roleBindingsA.create(
        actor,
        {
          principalType: PrincipalType.SERVICE_PRINCIPAL,
          principalId: eligibleSp.id,
          roleId: eligibleRole.id,
          scopeType: BindingScopeType.GLOBAL,
        },
        META,
      ),
    ).resolves.toMatchObject({ roleId: eligibleRole.id });

    const dirtyRole = await createRole('create-dirty');
    const ineligible = await createPermission('create-dirty-ineligible', false);
    await prismaA.rolePermission.create({
      data: { roleId: dirtyRole.id, permissionId: ineligible.id },
    });
    const dirtySp = await createServicePrincipal('create-dirty');
    const batch = await roleBindingsA.createBatch(
      actor,
      {
        items: [
          {
            principalType: PrincipalType.SERVICE_PRINCIPAL,
            principalId: dirtySp.id,
            roleId: dirtyRole.id,
            scopeType: BindingScopeType.GLOBAL,
          },
        ],
      },
      META,
    );
    expect(batch).toMatchObject({
      summary: { total: 1, ok: 0, blocked: 1, alreadyExists: 0 },
      items: [
        {
          outcome: 'blocked',
          bizCode: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code,
        },
      ],
    });
  });

  it('SP Binding 恢复、提前开始和延长结束均会重新检查脏角色；USER 绑定不受 SP 门误伤', async () => {
    const role = await createRole('reactivation');
    const ineligible = await createPermission('reactivation-ineligible', false);
    const servicePrincipal = await createServicePrincipal('reactivation');
    await prismaA.rolePermission.create({ data: { roleId: role.id, permissionId: ineligible.id } });

    const suspended = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: servicePrincipal.id,
      status: BindingStatus.SUSPENDED,
    });
    await expect(
      roleBindingsA.update(actor, suspended.id, { status: BindingStatus.ACTIVE }, META),
    ).rejects.toMatchObject({
      biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
    });

    const future = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: (await createServicePrincipal('future-recovery')).id,
      startedAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    await expect(
      roleBindingsA.update(actor, future.id, { startedAt: '2026-01-01T00:00:00.000Z' }, META),
    ).rejects.toMatchObject({
      biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
    });

    const expired = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: (await createServicePrincipal('expired-recovery')).id,
      startedAt: new Date('2000-01-01T00:00:00.000Z'),
      endedAt: new Date('2001-01-01T00:00:00.000Z'),
    });
    await expect(
      roleBindingsA.update(actor, expired.id, { endedAt: '2099-01-01T00:00:00.000Z' }, META),
    ).rejects.toMatchObject({
      biz: { code: BizCode.ROLE_BINDING_INELIGIBLE_PERMISSION_FOR_SERVICE_PRINCIPAL.code },
    });

    const user = await prismaA.user.create({
      data: { username: next('human-zero-drift'), passwordHash: 'probe', role: Role.USER },
    });
    await expect(
      roleBindingsA.create(
        actor,
        {
          principalType: PrincipalType.USER,
          principalId: user.id,
          roleId: role.id,
          scopeType: BindingScopeType.GLOBAL,
        },
        META,
      ),
    ).resolves.toMatchObject({ principalType: PrincipalType.USER });
  });

  it('真实并发 A：不合格 Permission 改写 × SP Binding 创建只能有一个成功', async () => {
    const role = await createRole('race-create');
    const ineligible = await createPermission('race-create-ineligible', false);
    const servicePrincipal = await createServicePrincipal('race-create');
    const barrier = holdRoleLock(role.id);
    await barrier.ready;
    const permissionWrite = rolePermissionsA.replace(
      actor,
      role.id,
      { permissionCodes: [ineligible.code], expectedRevision: 0 },
      META,
    );
    await waitForRoleLockWaiters(1);
    const bindingCreate = roleBindingsB.create(
      actor,
      {
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        principalId: servicePrincipal.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
      },
      META,
    );

    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await waitForRoleLockWaiters(2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled([permissionWrite, bindingCreate]);
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await assertNoSpRoleInvariantViolation(role.id);
  });

  it('真实并发 B：不合格 Permission 改写 × SUSPENDED Binding 恢复只能有一个成功', async () => {
    const role = await createRole('race-reactivation');
    const ineligible = await createPermission('race-reactivation-ineligible', false);
    const servicePrincipal = await createServicePrincipal('race-reactivation');
    const binding = await createDirectSpBinding({
      roleId: role.id,
      servicePrincipalId: servicePrincipal.id,
      status: BindingStatus.SUSPENDED,
    });
    const barrier = holdRoleLock(role.id);
    await barrier.ready;
    const permissionWrite = rolePermissionsA.replace(
      actor,
      role.id,
      { permissionCodes: [ineligible.code], expectedRevision: 0 },
      META,
    );
    await waitForRoleLockWaiters(1);
    const bindingActivation = roleBindingsB.update(
      actor,
      binding.id,
      { status: BindingStatus.ACTIVE },
      META,
    );

    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await waitForRoleLockWaiters(2);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled([permissionWrite, bindingActivation]);
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await assertNoSpRoleInvariantViolation(role.id);
  });
});
