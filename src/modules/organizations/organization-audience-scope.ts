import { MemberStatus, OrganizationStatus, type Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';

type PrismaTx = Prisma.TransactionClient;

/**
 * 组织受众范围原语 —— **属主侧导出的 tx 原语**(维护者 2026-08-25 拍板的活动通知组织定向)。
 *
 * ## 为什么这些函数长在 `organizations/` 而不是调用方那里
 *
 * `Organization` / `OrganizationClosure` / `MemberOrganizationMembership` 三张表全属
 * `identity-org` 域(前两张属主 `organizations`,第三张属主 `member-departments`,
 * 同域同 `structure` 子域)。活动域(`participation`)直接读它们是跨域读 ——
 * 架构债棘轮(`docs:boundaries:newdebt:check`)会当场判「新增代码债」并拒绝。
 * 本刀实测过:把这两段查询留在 `activities/` 里,棘轮点名三条 identity-org 违规。
 *
 * v4 §6 给的正解是「走属主导出的 public API / Query API / **tx 原语**」——
 * 这个文件就是那条 tx 原语。**不是**为了绕开检查换个地方写同一段代码:
 * 组织树怎么展开、什么叫「有效任职」,本来就该由组织域说了算,而不是每个
 * 想按组织圈人的业务域各自解释一遍。
 *
 * ## 为什么是纯 tx 函数而不是 `@Injectable`
 *
 * 调用方(活动通知的收件人冻结)必须在**它自己的业务事务内**算收件人 ——
 * 冻结的第一条锁就是「intent 与其收件人快照同事务」。持 `PrismaService` 的 service
 * 会另开连接、把冻结那条锁变成祈祷。沿 `activity-publish-review-access.ts` /
 * `auth-session-lock` 同一范式:不持 `PrismaService`、以调用方的 `tx` 为入参,
 * 因此不产生隐式锁序,也不必登记进任何 NestJS module。
 */

/**
 * 校验勾选的组织存在且未软删 —— **少解析出一个就整批拒绝**。
 *
 * 为什么必须有:组织 id 打错时子树展开得到空集,与受众标签求交后收件人为空 ——
 * 通知**一个人都不发**却照样返回 200。那是「静默少发一整批人」,与受众标签码
 * 解析失败(`resolveActiveAudienceTagIds`)同一类事故,故同一处置。
 *
 * ⚠️ 只校验**勾选的**组织;后代不逐个校验 —— 后代由 `organization_closure` 负责
 * (它在建 / 移动节点时整段重建),重复校验会造出第二份真相。
 */
export async function assertActiveOrganizationIds(
  tx: PrismaTx,
  organizationIds: readonly string[],
): Promise<void> {
  if (organizationIds.length === 0) return;
  const found = await tx.organization.findMany({
    where: { id: { in: [...organizationIds] }, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== new Set(organizationIds).size) throw new BizException(BizCode.BAD_REQUEST);
}

/**
 * 「勾上级包含下级」——**真子树查询**,不是编码前缀匹配。
 *
 * 组织是树,而树关系的唯一权威源是闭包表 `organization_closure`
 * (`ancestorId → descendantId`,含 depth-0 自身行,由 20260701 建表 migration 一次性回填、
 * 由 `OrganizationsService` 在建 / 移动节点时整段重建)。本函数走的是全仓**既有的同一条**
 * 子树口径 —— 与 `OrganizationsService.queryDescendantOrgIds` /
 * `ActivityPublishReviewQueryService` 的 `includeDescendants` /
 * `AuthzService` 的 `ORGANIZATION_TREE` 展开 / 分管与任职两处 `includeDescendants`
 * 逐字同形(`where: { ancestorId: … }, select: { descendantId: true }`)。
 *
 * ⚠️ **不许**按 `Organization.code` 做 `startsWith` / `contains` 前缀匹配:编码前缀是命名约定
 * 而不是树结构,改名、跨父移动、同前缀的兄弟节点三种情况下它都会给出错答案,而且错得静悄悄。
 *
 * ⚠️ 有效任职复用 `MembershipTermStateMachine.effectiveWhere(at)`(未软删 + ACTIVE +
 * 已生效 + 未终止),**不重造第二套**。时刻取调用方传进来的业务事件时刻 `at`,不取新墙钟 ——
 * 收件人冻结的确定性盖章依赖这一点:取新墙钟会让同一事件重放算出另一批人。
 */
export async function resolveOrganizationSubtreeMemberIds(
  tx: PrismaTx,
  organizationIds: readonly string[],
  at: Date,
): Promise<Set<string>> {
  if (organizationIds.length === 0) return new Set();
  const closure = await tx.organizationClosure.findMany({
    where: { ancestorId: { in: [...organizationIds] } },
    select: { descendantId: true },
  });
  const subtreeOrganizationIds = [...new Set(closure.map((row) => row.descendantId))].sort();
  // 闭包表恒含 depth-0 自身行 ⇒ 空集只可能是「勾的组织根本不存在」。此时既不静默放行成全员,
  // 也不在这里抛错(校验是 `assertActiveOrganizationIds` 的职责),返回空集让交集自然为空。
  if (subtreeOrganizationIds.length === 0) return new Set();
  const memberships = await tx.memberOrganizationMembership.findMany({
    where: {
      ...MembershipTermStateMachine.effectiveWhere(at),
      organizationId: { in: subtreeOrganizationIds },
    },
    select: { memberId: true },
  });
  return new Set(memberships.map((membership) => membership.memberId));
}

/**
 * 在一组**精确组织上界**内筛出当前可联系的会员。
 *
 * 这是 emergency 显式点人 / 组织子树候选集的共同末道过滤：会员本人必须 ACTIVE 且未软删，
 * 并且在调用方已经判定可用的组织集合中至少有一条当前有效任职；任职所指组织也必须仍然
 * ACTIVE 且未软删。这里刻意不展开组织子树——`authorizedOrganizationIds` 是调用方已经算定的
 * 精确上界，擅自展开会把无权组织中的人重新放进来。
 *
 * 与本文件其他函数一样只接受根事务的 `tx`，让候选校验与通知收件人冻结保持同一事务。
 */
export async function resolveActiveMemberIdsWithinExactOrganizationScope(
  tx: PrismaTx,
  candidateMemberIds: readonly string[],
  authorizedOrganizationIds: readonly string[],
  at: Date,
): Promise<Set<string>> {
  if (candidateMemberIds.length === 0 || authorizedOrganizationIds.length === 0) return new Set();
  const rows = await tx.member.findMany({
    where: notDeletedWhere({
      id: { in: [...candidateMemberIds] },
      status: MemberStatus.ACTIVE,
      memberOrganizationMemberships: {
        some: {
          ...MembershipTermStateMachine.effectiveWhere(at),
          organizationId: { in: [...authorizedOrganizationIds] },
          organization: notDeletedWhere({ status: OrganizationStatus.ACTIVE }),
        },
      },
    }),
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}
