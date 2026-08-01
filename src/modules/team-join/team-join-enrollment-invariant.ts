import { MembershipType, Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { lockMembersForWrite } from '../../common/prisma/member-advisory-lock.util';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { LIVE_APPLICATION_STATUS_CODES, isUnenrolledVolunteer } from './team-join.constants';

type PrismaTx = Prisma.TransactionClient;

/**
 * 入队不变量的**唯一 transition 闸**(M2;并发复审 P1)。
 *
 * ── 要守的不变量 ────────────────────────────────────────────────────────────────
 * 一条 live 入队申请(`joining` / `pending_evaluation` / `approved`)想走到终态,只有两条路:
 * final join(→ `joined`)或综合评估淘汰(→ `rejected`)。**两条都要求该队员此刻仍是
 * 「未入队志愿者」** —— final join 的步骤 6 用 `isUnenrolledVolunteer` 把关。
 * 所以「未入队志愿者」不是一个可以随便改的属性,它是那条申请的**存在前提**。
 *
 * ── 不守会怎样 ──────────────────────────────────────────────────────────────────
 * 任何别的写方(改级别、设/清部门、建/改/结束/迁移归属、离队)把它翻成 false,那条申请
 * 就成了 frozen 行:evaluate 还能一路把它推到 `approved`(管理台显示「待入队」),而
 * final join 从此永远 28210 —— 没有任何现存通路能让它离开 live 状态,只能人工拆库。
 * 这与 B-F5 修掉的那一类是同一个形状,只是入口从 team-join 内部换成了 members /
 * member-departments 侧。
 *
 * ── 为什么是「拒绝」而不是「顺手终结」 ───────────────────────────────────────────
 * 维护者 2026-08-01 拍板:**不自动终结、不静默放行**。改级别的管理员未必知道这个人正在
 * 走入队流程;替他把申请判死是替业务做决定。返一个说得清的业务错误,把选择权交回去 ——
 * 要么把人一键入队,要么综合评估淘汰,两条都是既有的、有留痕的正规通路。
 *
 * ── 锁序(改这里之前先读完) ─────────────────────────────────────────────────────
 * 本闸**必须排在 `lockMemberLifecycle`(Member 行 `FOR UPDATE`)之前** ——
 * 也就是调用方事务的第一步,offboard 那种已有全局 invariant 锁的路径则紧随其后。
 * 全仓唯一同时用两把锁的地方是 final join,它的顺序是
 * 「member 键 → Member 行锁」;调用方若先取 Member 行锁再进本闸,就与 final join 恰好
 * 反向 —— 终审持键等 Member 行锁、调用方持 Member 行锁等键,稳定 40P01。
 *
 * 取键本身也是必需的,不只是排序问题:没有它,`submit` 可以整个跑在本闸的「读申请」与
 * 调用方的「写身份」之间 —— 读时确实没有 live 申请,写完成时已经有了。
 */
export async function assertEnrollmentIdentityChangeAllowed(
  tx: PrismaTx,
  memberId: string,
  now: Date,
): Promise<void> {
  await lockMembersForWrite(tx, [memberId]);

  const member = await tx.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: { gradeCode: true },
  });
  // 不存在 / 已软删:没有身份可谈,交回调用方自己的 NOT_FOUND 语义,本闸不越权造错误。
  if (!member) return;

  const activeDepts = await tx.memberOrganizationMembership.findMany({
    where: {
      ...MembershipTermStateMachine.effectiveWhere(now),
      memberId,
      membershipType: MembershipType.PRIMARY,
    },
    select: { organization: { select: { code: true } } },
  });
  // 已经不是「未入队志愿者」了(已入队 / 从来不是志愿者)⇒ 没有本不变量可破。
  // 判定走与 final join、自助发起**同一个**纯函数,三处零漂移。
  if (!isUnenrolledVolunteer({ gradeCode: member.gradeCode }, activeDepts)) return;

  const liveApplications = await tx.teamJoinApplication.count({
    where: {
      memberId,
      deletedAt: null,
      statusCode: { in: [...LIVE_APPLICATION_STATUS_CODES] },
    },
  });
  if (liveApplications > 0) {
    throw new BizException(BizCode.TEAM_JOIN_MEMBER_HAS_LIVE_APPLICATION);
  }
}
