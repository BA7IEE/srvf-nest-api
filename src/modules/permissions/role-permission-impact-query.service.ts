/**
 * 角色权限集变更的影响查询(P1-32 PR 5;冻结稿 §11.2「只读,禁止写数据库」)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **只取数,不下结论,而且只取本域自己的事实**
 *
 * 「谁通过哪一源持有这个角色」的口径来自 `authz.service.collectGrants()` 的三源归集
 * (3a 直接绑定 / 3b 职务推导 / 3c 分管推导)。本文件是那份口径的**投影**:
 * 用**同一批共享谓词**取数,把读数交给纯函数
 * [`role-permission-impact.ts`](role-permission-impact.ts) 汇总。
 * 精确性怎么定义、EXACT 什么时候成立,全在那个纯文件里 —— 放那边是为了让判据
 * 能**直接跑它**并反算真值,而不是靠读这里的查询代码来确信。
 *
 * 🔴 **本文件只许读 platform-access 自有的模型。**
 *    `harness/domain-map.json` 的 `allowedEdges` 里 **`platform-access → identity-org`
 *    一条都没有**(方向恒为 identity-org → platform-access)。所以这里读不到
 *    `OrganizationPositionAssignment` / `OrganizationSupervisionAssignment` / `User` ——
 *    「那条授予对应哪个账号」不是本域的事实。
 *    执行位:`scripts/check-role-permission-impact.ts` 的 `impact-cross-domain-read` 规则
 *    从 domain-map 现取 `modelOwnership`,逐个核对本文件碰过的每一个 Prisma 模型;
 *    读了别的域的模型当场红并点名(它**不写死模型清单**,domain-map 改了自己跟上)。
 *
 * ⚠️ **任期边界不在本文件里重写**:有效性 where 来自 `role-binding-validity.ts` ——
 *    那里是「RoleBinding / assignment / supervision 共用同一条任期边界」的落点。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ **跑在事务外**
 *
 * 调用方是 `previewReplace()`,在 `runReplaceSet()` 的角色行锁**释放之后**才调本服务。
 * 刻意不进那个事务:影响统计是给人看的参考读数,把它塞进临界区只会延长持锁时间,
 * 而仓内生产事务有 5s 预算(`activity-ledger-posting-scale` 2026-08-23 刚撞红过)。
 * 代价:影响读数与 delta 之间存在毫秒级窗口 —— 而预览本来就**不是授权证明**
 * (冻结稿 §2.8),真提交在锁内重算,期间变了返 30111。
 */
import { Injectable } from '@nestjs/common';
import { BindingScopeType, PolicyStatus, PrincipalType } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { effectiveRoleBindingWhere } from './role-binding-validity';
import {
  SUPERVISION_DERIVED_ROLE_CODE,
  emptyPrincipalCounts,
  emptyScopeCounts,
  observedSource,
  summarizeRolePermissionImpact,
  unobservableSource,
} from './role-permission-impact';
import type {
  RolePermissionImpactSourceFacts,
  RolePermissionImpactSummary,
} from './role-permission-impact';

@Injectable()
export class RolePermissionImpactQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 算出这个角色当前的影响面。
   *
   * ⚠️ 角色 code 在本服务内部现取:分管源要用它判断「本次编辑的是不是分管推导那个固定角色」,
   *    让调用方传进来等于把这个内部口径漏到接口上(调用方并不知道 code 是拿来干什么的)。
   */
  async summarize(roleId: string): Promise<RolePermissionImpactSummary> {
    // 两源共用同一个 `now`:分两次取"当前时间"会让它们落在不同时刻,
    // 边界任期(恰好此刻到期)可能在一个源里算进、另一个源里算出。
    const now = new Date();
    const role = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: { code: true },
    });
    const [roleBinding, positionPolicy] = await Promise.all([
      this.directFacts(roleId, now),
      this.positionFacts(roleId),
    ]);
    return summarizeRolePermissionImpact({
      roleBinding: roleBinding.facts,
      positionPolicy,
      supervision: this.supervisionFacts(role?.code ?? null),
      scopeCounts: roleBinding.scopeCounts,
      principalCounts: roleBinding.principalCounts,
    });
  }

  // ============ 3a 直接绑定(`RoleBinding` —— platform-access 自有)============

  private async directFacts(
    roleId: string,
    now: Date,
  ): Promise<{
    facts: RolePermissionImpactSourceFacts;
    scopeCounts: Record<BindingScopeType, number>;
    principalCounts: Record<PrincipalType, number>;
  }> {
    // 与 authz 3a 同口径:未软删 + ACTIVE + 在任期内 + 角色未软删。
    const where = { ...effectiveRoleBindingWhere(now), roleId, role: { deletedAt: null } };

    const [grantCount, byScope, byPrincipal] = await Promise.all([
      this.prisma.roleBinding.count({ where }),
      this.prisma.roleBinding.groupBy({ by: ['scopeType'], where, _count: { _all: true } }),
      this.prisma.roleBinding.groupBy({ by: ['principalType'], where, _count: { _all: true } }),
    ]);

    // 骨架先铺全 0 再回填:缺键会让前端读到 undefined,而「某个 scope 没有绑定」
    // 与「这个字段不存在」在 JSON 里长得一样。
    const scopeCounts = emptyScopeCounts();
    for (const row of byScope) scopeCounts[row.scopeType] = row._count._all;
    const principalCounts = emptyPrincipalCounts();
    for (const row of byPrincipal) principalCounts[row.principalType] = row._count._all;

    return { facts: observedSource(grantCount), scopeCounts, principalCounts };
  }

  // ============ 3b 职务推导(`OrganizationPositionRolePolicy` —— platform-access 自有)============

  private async positionFacts(roleId: string): Promise<RolePermissionImpactSourceFacts> {
    // policy 行数被职务数量天然限住(每职务 × 每角色至多一行,`@@unique([positionId, roleId])`),
    // 所以这一批整取;`conditionJson` 的过滤在内存里做 —— Prisma 对可空 Json 列的
    // `null` 语义有 DbNull / JsonNull 之分,写进 where 容易得到一个**看起来对**的错筛选。
    const policies = await this.prisma.organizationPositionRolePolicy.findMany({
      where: { roleId, deletedAt: null, status: PolicyStatus.ACTIVE, role: { deletedAt: null } },
      select: { conditionJson: true },
    });
    // 与 authz 3b 逐字同口径:带条件的 policy **保守跳过**(fail-close,条件评估器未落地)。
    return observedSource(policies.filter((policy) => policy.conditionJson === null).length);
  }

  // ============ 3c 分管推导(**零查询**)============

  /**
   * ⭐ 分管推导恒定只产出一个固定角色(authz 3c)。编辑别的角色时本源**结构性**为 0,
   *    这是精确的 0,不是「没查到」—— 所以这里一次库都不查。
   *
   * ⚠️ 真是那个角色时:分管行(`OrganizationSupervisionAssignment`)归 identity-org,
   *    本域数不出来 ⇒ **如实标不可观测**,而不是继续报 0 装作精确。
   *    今天这条分支不可达(那是内建角色,权限集只读,编辑先返 30108),留着是为了
   *    「哪天可达了」不会静默说谎。
   */
  private supervisionFacts(roleCode: string | null): RolePermissionImpactSourceFacts {
    return roleCode === SUPERVISION_DERIVED_ROLE_CODE ? unobservableSource() : observedSource(0);
  }
}
