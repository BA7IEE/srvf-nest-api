/**
 * Service Principal 角色资格不变量的存量只读预检。
 *
 * 用法:
 *   DATABASE_URL=<目标环境连接> pnpm exec tsx scripts/check-service-principal-role-invariant.ts
 *
 * 这不是修复工具:只读取 role_bindings / roles / role_permissions / permissions，
 * 发现漂移时列出受影响对象并以非 0 退出。修复必须另立人工审查任务，不能由本脚本猜测
 * 应撤销 Binding、移除权限还是重建角色。
 *
 * 统计口径:
 *   - 扫描所有未软删的 SERVICE_PRINCIPAL Binding，不按 status 或有效期过滤；
 *   - self / deleted role / system-managed 的计数按 Binding 计；
 *   - ineligiblePermissionViolationCount 按唯一 (roleId, permissionCode) 映射计，
 *     同一角色被多个 SP 绑定时仍只需要修一次该权限映射。
 */
import { BindingScopeType, PrismaClient } from '@prisma/client';

import {
  SYSTEM_MANAGED_ROLE_CODES,
  SYSTEM_MANAGED_ROLE_CODE_SET,
} from '../src/modules/permissions/system-managed-role-codes';

export interface ServicePrincipalRoleInvariantBinding {
  readonly id: string;
  readonly roleId: string;
  readonly scopeType: BindingScopeType;
  readonly role: {
    readonly code: string;
    readonly deletedAt: Date | null;
    readonly rolePermissions: ReadonlyArray<{
      readonly permission: {
        readonly code: string;
        readonly servicePrincipalAllowed: boolean;
      };
    }>;
  } | null;
}

export interface ServicePrincipalRoleInvariantReport {
  readonly undeletedSpBindingCount: number;
  readonly selfScopeViolationCount: number;
  readonly deletedRoleViolationCount: number;
  readonly systemManagedRoleViolationCount: number;
  readonly ineligiblePermissionViolationCount: number;
  readonly affectedRoleIds: readonly string[];
  readonly affectedBindingIds: readonly string[];
  readonly affectedPermissionCodes: readonly string[];
}

/**
 * 纯分析器，供 CLI 与薄测试共用。角色 relation 在正常 schema 下由 FK 保证存在；
 * 若读到缺失 relation，仍按角色不可用处理，不能把数据损坏误报成合规。
 */
export function analyzeServicePrincipalRoleInvariant(
  bindings: readonly ServicePrincipalRoleInvariantBinding[],
): ServicePrincipalRoleInvariantReport {
  let selfScopeViolationCount = 0;
  let deletedRoleViolationCount = 0;
  let systemManagedRoleViolationCount = 0;

  const ineligiblePermissionPairs = new Set<string>();
  const affectedRoleIds = new Set<string>();
  const affectedBindingIds = new Set<string>();
  const affectedPermissionCodes = new Set<string>();

  for (const binding of bindings) {
    let bindingHasViolation = false;

    if (binding.scopeType === BindingScopeType.SELF) {
      selfScopeViolationCount += 1;
      bindingHasViolation = true;
    }

    const role = binding.role;
    if (!role || role.deletedAt !== null) {
      deletedRoleViolationCount += 1;
      bindingHasViolation = true;
    }

    if (role && SYSTEM_MANAGED_ROLE_CODE_SET.has(role.code)) {
      systemManagedRoleViolationCount += 1;
      bindingHasViolation = true;
    }

    for (const rolePermission of role?.rolePermissions ?? []) {
      const { permission } = rolePermission;
      if (permission.servicePrincipalAllowed) continue;

      ineligiblePermissionPairs.add(`${binding.roleId}\u0000${permission.code}`);
      affectedPermissionCodes.add(permission.code);
      bindingHasViolation = true;
    }

    if (!bindingHasViolation) continue;

    affectedRoleIds.add(binding.roleId);
    affectedBindingIds.add(binding.id);
  }

  return {
    undeletedSpBindingCount: bindings.length,
    selfScopeViolationCount,
    deletedRoleViolationCount,
    systemManagedRoleViolationCount,
    ineligiblePermissionViolationCount: ineligiblePermissionPairs.size,
    affectedRoleIds: [...affectedRoleIds].sort(),
    affectedBindingIds: [...affectedBindingIds].sort(),
    affectedPermissionCodes: [...affectedPermissionCodes].sort(),
  };
}

export function hasServicePrincipalRoleInvariantViolation(
  report: ServicePrincipalRoleInvariantReport,
): boolean {
  return (
    report.selfScopeViolationCount > 0 ||
    report.deletedRoleViolationCount > 0 ||
    report.systemManagedRoleViolationCount > 0 ||
    report.ineligiblePermissionViolationCount > 0
  );
}

function reportsEqual(
  actual: ServicePrincipalRoleInvariantReport,
  expected: ServicePrincipalRoleInvariantReport,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * 薄运行器的自证矩阵。判据与样本留在受保护的 `scripts/check-*.ts`，避免把强度旋钮
 * 散落进普通 spec；CLI 的真实 Prisma 查询与退出码由 C2 E2E 另行覆盖。
 */
export function selfCheckServicePrincipalRoleInvariantAnalysis(): string[] {
  const failures: string[] = [];
  const cleanReport = analyzeServicePrincipalRoleInvariant([
    {
      id: 'binding-clean',
      roleId: 'role-clean',
      scopeType: BindingScopeType.GLOBAL,
      role: {
        code: 'custom-role',
        deletedAt: null,
        rolePermissions: [
          { permission: { code: 'custom.read.record', servicePrincipalAllowed: true } },
        ],
      },
    },
  ]);
  const expectedCleanReport: ServicePrincipalRoleInvariantReport = {
    undeletedSpBindingCount: 1,
    selfScopeViolationCount: 0,
    deletedRoleViolationCount: 0,
    systemManagedRoleViolationCount: 0,
    ineligiblePermissionViolationCount: 0,
    affectedRoleIds: [],
    affectedBindingIds: [],
    affectedPermissionCodes: [],
  };
  if (
    !reportsEqual(cleanReport, expectedCleanReport) ||
    hasServicePrincipalRoleInvariantViolation(cleanReport)
  ) {
    failures.push('合格数据不应被报为 Service Principal Role 资格漂移');
  }

  const violationReport = analyzeServicePrincipalRoleInvariant([
    {
      id: 'binding-self',
      roleId: 'role-self',
      scopeType: BindingScopeType.SELF,
      role: { code: 'custom-self', deletedAt: null, rolePermissions: [] },
    },
    {
      id: 'binding-deleted',
      roleId: 'role-deleted',
      scopeType: BindingScopeType.GLOBAL,
      role: {
        code: 'custom-deleted',
        deletedAt: new Date('2026-08-31T00:00:00.000Z'),
        rolePermissions: [],
      },
    },
    {
      id: 'binding-system',
      roleId: 'role-system',
      scopeType: BindingScopeType.GLOBAL,
      role: { code: SYSTEM_MANAGED_ROLE_CODES[0], deletedAt: null, rolePermissions: [] },
    },
    {
      id: 'binding-bad-a',
      roleId: 'role-bad',
      scopeType: BindingScopeType.GLOBAL,
      role: {
        code: 'custom-bad',
        deletedAt: null,
        rolePermissions: [
          { permission: { code: 'custom.write.record', servicePrincipalAllowed: false } },
        ],
      },
    },
    {
      id: 'binding-bad-b',
      roleId: 'role-bad',
      scopeType: BindingScopeType.GLOBAL,
      role: {
        code: 'custom-bad',
        deletedAt: null,
        rolePermissions: [
          { permission: { code: 'custom.write.record', servicePrincipalAllowed: false } },
        ],
      },
    },
  ]);
  const expectedViolationReport: ServicePrincipalRoleInvariantReport = {
    undeletedSpBindingCount: 5,
    selfScopeViolationCount: 1,
    deletedRoleViolationCount: 1,
    systemManagedRoleViolationCount: 1,
    ineligiblePermissionViolationCount: 1,
    affectedRoleIds: ['role-bad', 'role-deleted', 'role-self', 'role-system'],
    affectedBindingIds: [
      'binding-bad-a',
      'binding-bad-b',
      'binding-deleted',
      'binding-self',
      'binding-system',
    ],
    affectedPermissionCodes: ['custom.write.record'],
  };
  if (
    !reportsEqual(violationReport, expectedViolationReport) ||
    !hasServicePrincipalRoleInvariantViolation(violationReport)
  ) {
    failures.push('预检必须逐类报告违例，并对同一坏权限映射去重');
  }

  return failures;
}

async function readUndeletedServicePrincipalBindings(
  prisma: PrismaClient,
): Promise<ServicePrincipalRoleInvariantBinding[]> {
  return prisma.roleBinding.findMany({
    where: {
      principalType: 'SERVICE_PRINCIPAL',
      deletedAt: null,
    },
    select: {
      id: true,
      roleId: true,
      scopeType: true,
      role: {
        select: {
          code: true,
          deletedAt: true,
          rolePermissions: {
            select: {
              permission: {
                select: {
                  code: true,
                  servicePrincipalAllowed: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://***');
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL 未设置，拒绝运行只读预检');
  }

  const prisma = new PrismaClient();
  try {
    const bindings = await readUndeletedServicePrincipalBindings(prisma);
    const report = analyzeServicePrincipalRoleInvariant(bindings);
    console.log(JSON.stringify(report, null, 2));

    if (hasServicePrincipalRoleInvariantViolation(report)) {
      console.error(
        '\n检测到 Service Principal 角色资格漂移。请另立人工审查任务处理；本脚本不会自动修复。',
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`预检未完成:${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
