import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import { RbacCacheService } from './rbac-cache.service';
import { RbacService } from './rbac.service';
import type { RbacResource } from './rbac.service';

// V2.x C-6 RBAC 实施 PR #6:RbacService 单元测试。
// 沿 D7 v1.1 §7.1 判权优先级 + §8.2 实现伪代码 + §8.3 ownership 字段映射。
//
// 覆盖:
// 1. SUPER_ADMIN 短路:can() / judge() 任何 action 直返 true / super_admin_pass
// 2. ADMIN / USER 走 RBAC 表(本 PR seed 未实施,聚合返空集 — 这本身是正确行为)
// 3. 精确 action 匹配:命中 → has_permission;未命中 → no_permission
// 4. .self ownership:
//    - 缺 resource → no_permission
//    - ownerType=user + 自己 → self_match;ownerType=user + 他人 → no_permission
//    - ownerType=member + user.memberId 匹配 → self_match
//    - ownerType=member + user.memberId=null → no_permission(fail-close)
// 5. cache 行为:miss → 查 DB + set;hit → 不查 DB
// 6. getMyPermissions:
//    - SUPER_ADMIN → Permission.code 全集 + effectiveRoles 走 user_roles
//    - 非 SUPER_ADMIN → permissions 走 getUserPermissionCodes(走缓存)

function makeUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'user-1',
    username: 'tester',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

interface UserRoleAggregateRow {
  role: {
    rolePermissions: Array<{ permission: { code: string } }>;
  };
}

interface EffectiveRoleRow {
  role: { code: string; displayName: string };
}

function makePrismaMock() {
  return {
    userRole: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
    },
    permission: {
      findMany: jest.fn<Promise<Array<{ code: string }>>, [unknown]>().mockResolvedValue([]),
    },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

// 极简 RbacCacheService 真实实例 + 注入 mock prisma(rbac-cache 自己有 prisma 但本测试不触发其方法)。
// TTL 通过 ConfigService mock 提供。
function makeRbacCache(prismaMock: PrismaMock): RbacCacheService {
  const configServiceMock = {
    get: jest.fn().mockReturnValue({
      rbacCache: { ttlSeconds: 1800 },
    }),
  };
  return new RbacCacheService(
    prismaMock as unknown as PrismaService,
    configServiceMock as unknown as ConstructorParameters<typeof RbacCacheService>[1],
  );
}

function setupService(): {
  prisma: PrismaMock;
  cache: RbacCacheService;
  service: RbacService;
} {
  const prisma = makePrismaMock();
  const cache = makeRbacCache(prisma);
  const service = new RbacService(prisma as unknown as PrismaService, cache);
  return { prisma, cache, service };
}

describe('RbacService', () => {
  describe('SUPER_ADMIN 短路', () => {
    it('can(): SUPER_ADMIN 任何 action 直返 true,不查 RBAC 表', async () => {
      const { prisma, service } = setupService();
      const user = makeUser({ role: Role.SUPER_ADMIN });

      const allowed = await service.can(user, 'rbac.role.read');

      expect(allowed).toBe(true);
      expect(prisma.userRole.findMany).not.toHaveBeenCalled();
      expect(prisma.permission.findMany).not.toHaveBeenCalled();
    });

    it('judge(): SUPER_ADMIN reason=super_admin_pass', async () => {
      const { service } = setupService();
      const user = makeUser({ role: Role.SUPER_ADMIN });

      const result = await service.judge(user, 'attachment.upload.cert.self');

      expect(result).toEqual({ allowed: true, reason: 'super_admin_pass' });
    });
  });

  describe('精确 action 匹配(非 SUPER_ADMIN)', () => {
    it('未命中 → no_permission', async () => {
      const { prisma, service } = setupService();
      const userRoleRows: UserRoleAggregateRow[] = [
        {
          role: {
            rolePermissions: [{ permission: { code: 'attachment.view.cert.other' } }],
          },
        },
      ];
      prisma.userRole.findMany.mockResolvedValueOnce(userRoleRows);

      const result = await service.judge(makeUser({ role: Role.ADMIN }), 'rbac.role.delete');

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });

    it('命中且非 .self → has_permission', async () => {
      const { prisma, service } = setupService();
      const userRoleRows: UserRoleAggregateRow[] = [
        { role: { rolePermissions: [{ permission: { code: 'rbac.role.read' } }] } },
      ];
      prisma.userRole.findMany.mockResolvedValueOnce(userRoleRows);

      const result = await service.judge(makeUser({ role: Role.ADMIN }), 'rbac.role.read');

      expect(result).toEqual({ allowed: true, reason: 'has_permission' });
    });

    it('ADMIN 无 RBAC 角色(seed 未实施)→ 聚合返空集 → no_permission', async () => {
      const { prisma, service } = setupService();
      prisma.userRole.findMany.mockResolvedValueOnce([]);

      const result = await service.judge(makeUser({ role: Role.ADMIN }), 'rbac.role.read');

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });
  });

  describe('.self ownership 判定(沿 D7 §8.3)', () => {
    const SELF_ACTION = 'attachment.upload.cert.self';

    function withPermission(prisma: PrismaMock, code: string) {
      const rows: UserRoleAggregateRow[] = [
        { role: { rolePermissions: [{ permission: { code } }] } },
      ];
      prisma.userRole.findMany.mockResolvedValueOnce(rows);
    }

    it('缺 resource → no_permission(fail-close)', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);

      const result = await service.judge(makeUser({ role: Role.USER }), SELF_ACTION);

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });

    it('ownerType=user + 自己 → self_match', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ id: 'user-self-id', role: Role.USER });

      const result = await service.judge(user, SELF_ACTION, {
        ownerType: 'user',
        ownerId: 'user-self-id',
      });

      expect(result).toEqual({ allowed: true, reason: 'self_match' });
    });

    it('ownerType=user + 他人 → no_permission', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ id: 'user-self-id', role: Role.USER });

      const result = await service.judge(user, SELF_ACTION, {
        ownerType: 'user',
        ownerId: 'someone-else',
      });

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });

    it('ownerType=member + user.memberId 匹配 → self_match', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ role: Role.USER, memberId: 'mem-1' });

      const result = await service.judge(user, SELF_ACTION, {
        ownerType: 'member',
        ownerId: 'mem-1',
      });

      expect(result).toEqual({ allowed: true, reason: 'self_match' });
    });

    it('ownerType=member + user.memberId=null → no_permission(fail-close)', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ role: Role.USER, memberId: null });

      const result = await service.judge(user, SELF_ACTION, {
        ownerType: 'member',
        ownerId: 'mem-1',
      });

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });

    it('ownerType=member + memberId 不匹配 → no_permission', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ role: Role.USER, memberId: 'mem-a' });

      const result = await service.judge(user, SELF_ACTION, {
        ownerType: 'member',
        ownerId: 'mem-b',
      });

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });

    it('未知 ownerType → no_permission(fail-close)', async () => {
      const { prisma, service } = setupService();
      withPermission(prisma, SELF_ACTION);
      const user = makeUser({ role: Role.USER });
      const badResource = { ownerType: 'unknown', ownerId: 'x' } as unknown as RbacResource;

      const result = await service.judge(user, SELF_ACTION, badResource);

      expect(result).toEqual({ allowed: false, reason: 'no_permission' });
    });
  });

  describe('cache 行为', () => {
    it('miss → 查 DB + set;同一 user 第二次调用直接 hit(不再查 DB)', async () => {
      const { prisma, service } = setupService();
      const userRoleRows: UserRoleAggregateRow[] = [
        { role: { rolePermissions: [{ permission: { code: 'rbac.role.read' } }] } },
      ];
      prisma.userRole.findMany.mockResolvedValueOnce(userRoleRows);

      const codes1 = await service.getUserPermissionCodes('user-cache-1');
      expect(codes1.has('rbac.role.read')).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);

      const codes2 = await service.getUserPermissionCodes('user-cache-1');
      expect(codes2.has('rbac.role.read')).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
    });

    it('invalidateUser 后再查 → cache miss → 重新查 DB', async () => {
      const { prisma, cache, service } = setupService();
      const userRoleRows: UserRoleAggregateRow[] = [
        { role: { rolePermissions: [{ permission: { code: 'rbac.role.read' } }] } },
      ];
      prisma.userRole.findMany.mockResolvedValue(userRoleRows);

      await service.getUserPermissionCodes('user-inv-1');
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);

      cache.invalidateUser('user-inv-1');

      await service.getUserPermissionCodes('user-inv-1');
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('getMyPermissions()', () => {
    it('SUPER_ADMIN → permissions=Permission.code 全集(已排序)+ effectiveRoles=user_roles 查询', async () => {
      const { prisma, service } = setupService();
      prisma.permission.findMany.mockResolvedValueOnce([
        { code: 'attachment.upload.cert' },
        { code: 'rbac.role.read' },
      ]);
      const effectiveRows: EffectiveRoleRow[] = [];
      prisma.userRole.findMany.mockResolvedValueOnce(effectiveRows);

      const result = await service.getMyPermissions(makeUser({ role: Role.SUPER_ADMIN }));

      expect(result.permissions).toEqual(['attachment.upload.cert', 'rbac.role.read']);
      expect(result.effectiveRoles).toEqual([]);
      // SUPER_ADMIN 不应触发 getUserPermissionCodes 内部的 userRole.findMany 聚合查询
      // 但本测试还查了 effectiveRoles → userRole.findMany 调用 1 次
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.permission.findMany).toHaveBeenCalledTimes(1);
    });

    it('USER → permissions 走聚合(已排序)+ effectiveRoles 返角色摘要', async () => {
      const { prisma, service } = setupService();

      // 第一次 findMany 调用是 getUserPermissionCodes 聚合(rolePermissions 嵌套)
      const aggregateRows: UserRoleAggregateRow[] = [
        {
          role: {
            rolePermissions: [
              { permission: { code: 'b-code' } },
              { permission: { code: 'a-code' } },
            ],
          },
        },
      ];
      // 第二次 findMany 调用是 getEffectiveRoles
      const effectiveRows: EffectiveRoleRow[] = [
        { role: { code: 'role-a', displayName: '业务角色 A' } },
      ];
      prisma.userRole.findMany
        .mockResolvedValueOnce(aggregateRows)
        .mockResolvedValueOnce(effectiveRows);

      const result = await service.getMyPermissions(makeUser({ role: Role.USER, id: 'user-me' }));

      expect(result.permissions).toEqual(['a-code', 'b-code']);
      expect(result.effectiveRoles).toEqual([{ code: 'role-a', displayName: '业务角色 A' }]);
      expect(prisma.permission.findMany).not.toHaveBeenCalled();
    });

    it('ADMIN 无 RBAC 角色(seed 未实施)→ permissions=[] + effectiveRoles=[]', async () => {
      const { prisma, service } = setupService();
      prisma.userRole.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await service.getMyPermissions(makeUser({ role: Role.ADMIN }));

      expect(result.permissions).toEqual([]);
      expect(result.effectiveRoles).toEqual([]);
    });
  });
});
