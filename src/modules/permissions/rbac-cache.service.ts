import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// V2.x C-6 RBAC 实施 PR #4:RBAC 缓存骨架(skeleton)。
// 沿 D7 v1.1 §9 缓存策略 + D5 / D6 / F8 v1.0 锁。
//
// **本 PR 范围**(沿任务 #7):
// - 仅落地 Map + TTL 最小内存结构 + invalidate 入口
// - **不**做完整 rbac.can() 实施(留 PR #6)
// - **不**接 reload 接口(留 PR #7)
// - **不**引入新依赖(node-cache / lru-cache 等;沿任务边界)
//
// 当前阶段:
// - get / set 接口已定义但**实际不被任何上层调用**(RbacService.can() 未实施)
// - invalidate 接口由 RolePermissionsService 在授权/撤权后调用
// - cache state 实际为空(因为没有 set);invalidate 调用是 no-op,但代码路径已串联,
//   PR #6 实施 rbac.can() 时无需返工调用链
//
// **TTL**:本 PR 硬编码默认 30 分钟(沿 D6 v1.0 锁;`RBAC_CACHE_TTL_SECONDS=1800`);
// 后续 PR #6 接入 rbac.can() 时把 TTL 改为从 `RBAC_CACHE_TTL_SECONDS` env 读
// (沿 baseline §7 配置归属归 `src/config/app.config.ts`)。
const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  permissions: Set<string>;
  expiresAt: number;
}

@Injectable()
export class RbacCacheService {
  private readonly logger = new Logger(RbacCacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(private readonly prisma: PrismaService) {
    // TODO(PR #6):从 RBAC_CACHE_TTL_SECONDS env 读(沿 baseline §7 + D6 v1.0)
    this.ttlMs = DEFAULT_TTL_MS;
  }

  // ============ get / set(skeleton;由 PR #6 rbac.can() 调用)============

  // 获取用户的缓存权限点集;过期或 miss 时返 null,调用方需查 DB 后 set()。
  get(userId: string): Set<string> | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(userId);
      return null;
    }
    return entry.permissions;
  }

  set(userId: string, permissions: Set<string>): void {
    this.cache.set(userId, {
      permissions,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  // ============ invalidate 入口(本 PR 由 RolePermissionsService 调用)============

  invalidateUser(userId: string): void {
    this.cache.delete(userId);
  }

  // 批量清"持有该角色的所有 users"的 cache(沿 D7 v1.1 §9.4)。
  // 失败仅 logger.warn,不抛(沿 v1 lastLoginAt 顺手更新失败不阻断业务的范式)。
  async invalidateAllUsersWithRole(roleId: string): Promise<void> {
    try {
      const userIds = await this.prisma.userRole.findMany({
        where: { roleId },
        select: { userId: true },
      });
      for (const { userId } of userIds) {
        this.cache.delete(userId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { errMessage: message, roleId },
        '[RbacCache] invalidateAllUsersWithRole failed; cache state may be stale',
      );
    }
  }

  // 全量失效(沿 D7 v1.1 §9.4 "DELETE permission → 全量失效";本 PR 未用,留 PR #7)
  invalidateAll(): void {
    this.cache.clear();
  }

  // 测试辅助 — 暴露当前 cache size,e2e 可断言 invalidate 已生效
  // (生产代码不调;e2e 路径专用,沿 PrismaService 测试范式)
  size(): number {
    return this.cache.size;
  }
}
