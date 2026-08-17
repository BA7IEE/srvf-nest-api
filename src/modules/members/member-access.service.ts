import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { RbacService } from '../permissions/rbac.service';
// T4(D-WC-10):撤销原语归 users(见该文件头注「为什么落在 users 而不是 wecom」)。
// 纯 tx 函数,与既有 `auth/auth-session-lock` 同型 —— 不注入 UsersService、不产生模块环。
import {} from './members.dto';
import {} from './member-lifecycle-lock';
import type { MemberAuditContext } from './member-audit-recorder';
import { memberSafeSelect } from './members-query.service';
import type { SafeMember } from './members-query.service';

export const BCRYPT_SALT_ROUNDS = 10;
export type PrismaTx = Prisma.TransactionClient;
export function auditCtx(
  memberId: string,
  currentUser: CurrentUserPayload,
  auditMeta: AuditMeta,
): MemberAuditContext {
  return { memberId, currentUser, auditMeta };
}

/*
 * 队员路径的**共享准入层**(Phase 6-B 第三域第五刀,§3.2)。
 *
 * 三条被 CRUD 主链与账号族**双方**使用的前置:判权、Member 回读、唯一约束冲突翻译。
 * 不先降为共享底座,被抽出的账号族就得 import 回主 service(循环依赖)。
 *
 * ⚠️ 做成 @Injectable 而非纯函数:要吃 authz / rbac / prisma。
 * 把判权**结果**当跨类入参传,漏传一个实参 = 一条判权凭空消失,而全仓单测可以零红。
 *
 * ⚠️ runWithUniqueConstraintGuard 把 Prisma 的 P2002 翻译成业务错误。
 * 它包住的必须是**真正会撞唯一键的那一次写**,不是整段事务 ——
 * 包大了会把别处的 P2002 误translate成"编号重复"。
 */
@Injectable()
export class MemberAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  // v0.49 部门数据范围:带 member ref 的点动作走三源 scoped authz。资源不存在时仅原本持有
  // GLOBAL RBAC 码者回退到既有业务 NOT_FOUND；scoped 调用者统一 30100，避免跨范围枚举。
  async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  async findMemberOrThrow(id: string, tx?: PrismaTx): Promise<SafeMember> {
    const client = tx ?? this.prisma;
    const found = await client.member.findFirst({
      where: notDeletedWhere({ id }),
      select: memberSafeSelect,
    });
    if (!found) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    return found;
  }

  // P2002 兜底:并发场景下预检查通过但 create 撞唯一约束(沿用 v1 users.service 模式)。
  // 队员账号闭环 v1:补 username / phone / memberId 三个 User 侧唯一约束目标(grantAccount 专用;
  // memberNo 目标服务本模块既有 create())。memberId 分支收尾补齐(2026-07-07,元核验 P3):
  // 两个管理员并发对同一队员开号时,输家的 INSERT 同时违反 username(=memberNo 两者相同)与
  // memberId 两个唯一约束,DB 只报其一且不保证是哪个 —— 未映射的一侧会裸 500;语义同
  // grantAccount 第 462-466 行 existingLink 预检查(该 memberId 槽位已被占用)。
  async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('memberNo')) {
          throw new BizException(BizCode.MEMBER_NO_ALREADY_EXISTS);
        }
        if (target.includes('username')) {
          throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);
        }
        if (target.includes('phone')) {
          throw new BizException(BizCode.PHONE_ALREADY_BOUND);
        }
        // 队员账号闭环 v2(评审稿 §1.2 E-4):memberId 的唯一约束自本迁移起是手写
        // partial unique index(`User_memberId_active_key`),不再是 schema 声明的
        // `@unique`。本仓 position-assignments/supervision-assignments 已验证:手写
        // partial index 的 P2002 `meta.target` 不可靠(可能是列名,也可能是索引字面量
        // 名)。两条 OR 分支任一命中即映射同一 BizCode,不影响其余分支与既有"不含已
        // 映射键 → 原样上抛"单测契约。
        if (target.includes('memberId') || target.includes('User_memberId_active_key')) {
          throw new BizException(BizCode.MEMBER_HAS_LINKED_USER);
        }
      }
      throw err;
    }
  }
}
