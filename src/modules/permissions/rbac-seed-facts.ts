/**
 * 跨运行时共享的 RBAC seed 事实。
 *
 * 方向恒为 seed → src：`prisma/seed.ts` 消费这里的事实，生产权限策略与 seed e2e
 * 也直接消费同一对象；本模块不得反向导入 `prisma/seed.ts`。
 *
 * 权限码书写契约：本文件内的权限码只能写成 `code: '<literal>'` 或
 * `*_CODE = '<literal>'`；禁止模板、拼接或其他计算构造。`docs-counts` 的 AST/镜像正则、
 * RBAC 地图与 RBAC 检查器均读取 seed 事实闭包，违反此形态必须同步解析器并重新拍板。
 */
export interface RbacPermissionSeedFact {
  readonly code: string;
  readonly module: string;
  readonly action: string;
  readonly resourceType: string;
  readonly description: string;
}

function readonlyPermissionFacts(
  permissions: readonly RbacPermissionSeedFact[],
): readonly RbacPermissionSeedFact[] {
  return Object.freeze(permissions.map((permission) => Object.freeze({ ...permission })));
}

function readonlyCodes(codes: readonly string[]): readonly string[] {
  return Object.freeze([...codes]);
}

export const RBAC_SEED_FACTS = Object.freeze({
  permissions: Object.freeze({
    // V2.x C-6 RBAC 实施 PR #8：14 条 rbac.* 权限点全集。
    rbac: readonlyPermissionFacts([
      {
        code: 'rbac.permission.read',
        module: 'rbac',
        action: 'read',
        resourceType: 'permission',
        description: '查看权限点',
      },
      {
        code: 'rbac.permission.create',
        module: 'rbac',
        action: 'create',
        resourceType: 'permission',
        description: '创建权限点',
      },
      {
        code: 'rbac.permission.update',
        module: 'rbac',
        action: 'update',
        resourceType: 'permission',
        description: '更新权限点',
      },
      {
        code: 'rbac.permission.delete',
        module: 'rbac',
        action: 'delete',
        resourceType: 'permission',
        description: '删除权限点',
      },
      {
        code: 'rbac.role.read',
        module: 'rbac',
        action: 'read',
        resourceType: 'role',
        description: '查看角色',
      },
      {
        code: 'rbac.role.create',
        module: 'rbac',
        action: 'create',
        resourceType: 'role',
        description: '创建角色',
      },
      {
        code: 'rbac.role.update',
        module: 'rbac',
        action: 'update',
        resourceType: 'role',
        description: '更新角色',
      },
      {
        code: 'rbac.role.delete',
        module: 'rbac',
        action: 'delete',
        resourceType: 'role',
        description: '软删角色',
      },
      {
        code: 'rbac.role-permission.create',
        module: 'rbac',
        action: 'create',
        resourceType: 'role-permission',
        description: '角色加权限点',
      },
      {
        code: 'rbac.role-permission.delete',
        module: 'rbac',
        action: 'delete',
        resourceType: 'role-permission',
        description: '撤角色权限点',
      },
      {
        code: 'rbac.user-role.read',
        module: 'rbac',
        action: 'read',
        resourceType: 'user-role',
        description: '查看用户角色',
      },
      {
        code: 'rbac.user-role.create',
        module: 'rbac',
        action: 'create',
        resourceType: 'user-role',
        description: '分配用户角色',
      },
      {
        code: 'rbac.user-role.delete',
        module: 'rbac',
        action: 'delete',
        resourceType: 'user-role',
        description: '撤用户角色',
      },
      {
        code: 'rbac.config.reload',
        module: 'rbac',
        action: 'reload',
        resourceType: 'config',
        description: '触发 RBAC 缓存失效',
      },
    ]),
  }),
  contract: Object.freeze({
    // 控制面仅 SUPER_ADMIN 可授予的权限码；ops-admin / biz-admin 均不得绑定。
    //
    // ⚠️ `*.reset.credentials` 是一个**家族**,不是一串互不相干的码:每接入一个新 provider
    // 的凭证重置端点,那条码都必须同步登记进本表,否则持 `rbac.role-permission.create` 的
    // ops-admin 可把它自授给任意角色,再调对应 reset 端点覆盖该 provider 的 secret。
    // 第六轮评审 E-B1 实测:`wecom-setting.reset.credentials` 就是这样漏的(T2 后加,没同步)。
    // 现由 `reserved-super-admin-permission-codes.spec.ts` 的「家族全登记」判据机器执法 ——
    // 该判据从 src/ + prisma/ 动态扫 `*.reset.credentials`,漏一条即红并点名。
    reservedSuperAdminOnlyPermissionCodes: readonlyCodes([
      'user.update.role',
      'storage-setting.reset.credentials',
      'sms-setting.reset.credentials',
      'wechat-setting.reset.credentials',
      'realname-setting.reset.credentials',
      'wecom-setting.reset.credentials',
      'member.delete.record',
    ]),
  }),
});
