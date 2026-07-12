import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { RbacCacheService } from './rbac-cache.service';

describe('RbacCacheService', () => {
  it('falls back to invalidateAll when role-holder lookup fails (finding #17)', async () => {
    const prisma = {
      roleBinding: { findMany: jest.fn().mockRejectedValue(new Error('db unavailable')) },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn().mockReturnValue({ rbacCache: { ttlSeconds: 1800 } }),
    } as unknown as ConfigService;
    const cache = new RbacCacheService(prisma, config);
    cache.set('user-a', new Set(['rbac.permission.read']));
    cache.set('user-b', new Set(['activity.read.record']));

    await expect(cache.invalidateAllUsersWithRole('role-a')).resolves.toBeUndefined();

    expect(cache.size()).toBe(0);
  });
});
