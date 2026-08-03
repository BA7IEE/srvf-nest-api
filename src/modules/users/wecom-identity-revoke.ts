import { Prisma } from '@prisma/client';

import { WECOM_IDENTITY_STATUS } from '../wecom/wecom.types';

// 企业微信接入 T4(2026-08-02):**事务内**撤销某 User 全部 active 企业微信身份的唯一原语
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md D-WC-10 + §9.1)
//
// 为什么抽出来:D-WC-10 让「User 代际终止」这件事有了三个落点 ——
//   ① 管理员清除绑定  users/user-wecom-binding.service.ts `clearUserWecom`
//   ② User 软删        users/users.service.ts            `softDelete`
//   ③ 队员账号重开     members/members.service.ts        `reopenAccount`(旧 User 代际终止)
// 三处的撤销动作必须逐字一致(status / revokedAt / revokedByUserId 三列一起写),
// 而"复制第二套撤销算法"正是本仓反复清理的形状。故落成一个纯函数,和
// [`auth/auth-session-lock.ts`](../auth/auth-session-lock.ts) 的 `lockAuthSessionUser`、
// [`members/member-lifecycle-lock.ts`](../members/member-lifecycle-lock.ts) 同一范式:
// 只吃 `tx`,不吃 Service,跨模块 import 不产生任何 Nest 模块边。
//
// 为什么落在 users 而不是 wecom(§4.2 依赖方向):`wecom` 是**通道层**,
// [`wecom/CLAUDE.md`](../wecom/CLAUDE.md) 明文「`wecom_identities` 的**写**不归本模块,
// 本模块对 User 无感知」。本原语的入参恰恰是两个 userId,归属 users。
//
// ⚠️ 锁序(§9.1 全局固定):`WecomSettings → User → WecomIdentity → WecomAuthAttempt →
// RefreshToken / Audit`。调用方**必须**已经持有目标 User 的行锁
// (`lockAuthSessionUser`),并把本调用排在 refresh 撤销与 Audit **之前**。
// 本函数刻意**不**自己取 User 锁 —— 那会让锁序变成调用方看不见的隐式行为,
// 也会在已持锁的事务里制造第二次取锁。
//
// ⚠️ **软撤销恒定**:D-WC-10 只释放身份槽位,历史行永久保留(`status='revoked'`)。
// 本函数没有、也不得有物理删除分支。
//
// ⚠️ 本原语同时**递增 `User.wecomIdentityVersion`**(P1-27 第一刀 B2,2026-08-03)。
// 三个落点由此自动获得代际,不需要各写一次;`clearUserWecom` 的幂等空转因为在
// `active.length === 0` 就早返回了,天然不制造代际。

export interface RevokedWecomIdentity {
  readonly id: string;
  /** 明文 —— 调用方写 Audit 前必须过 `maskWecomUserId`(§11.3)。 */
  readonly wecomUserId: string;
}

export interface RevokeActiveWecomIdentityResult {
  /** 实际翻成 revoked 的行数;无绑定恒 0(不是错误,调用方据此决定要不要写 Audit)。 */
  readonly count: number;
  readonly revoked: readonly RevokedWecomIdentity[];
}

/**
 * 把该 User 名下全部 active 企业微信身份翻成 revoked,返回计数与被撤行的身份值。
 *
 * 返回「集合」而不是「单行」:`wecom_identity_user_active_unique` 是
 * **(userId, corpId) 维度**的 partial unique —— 单企业配置下每个 User 至多一条 active,
 * 但判据本身不排除多 corpId。写成集合形态,调用方就永远不必猜"会不会有第二条"。
 *
 * 幂等:无 active 行时不发 UPDATE、返回 `{count: 0, revoked: []}`。
 */
export async function revokeActiveWecomIdentityInTx(
  tx: Prisma.TransactionClient,
  input: { userId: string; revokedByUserId: string; revokedAt: Date },
): Promise<RevokeActiveWecomIdentityResult> {
  const active = await tx.wecomIdentity.findMany({
    where: {
      userId: input.userId,
      status: WECOM_IDENTITY_STATUS.ACTIVE,
      revokedAt: null,
    },
    select: { id: true, wecomUserId: true },
  });
  if (active.length === 0) {
    return { count: 0, revoked: [] };
  }

  // where 里重复带上 status / revokedAt:并发下这两条判据是 CAS 的一半,
  // 只按 id 更新等于承认"读到就一定还在"(本仓已清理过多次的形状)。
  // 调用方持 User 行锁时它恒成立,但判据不该依赖调用方做对了什么。
  const updated = await tx.wecomIdentity.updateMany({
    where: {
      id: { in: active.map((row) => row.id) },
      status: WECOM_IDENTITY_STATUS.ACTIVE,
      revokedAt: null,
    },
    data: {
      status: WECOM_IDENTITY_STATUS.REVOKED,
      revokedAt: input.revokedAt,
      revokedByUserId: input.revokedByUserId,
    },
  });

  // 身份代际 +1(P1-27 第一刀 B2,2026-08-03)。
  //
  // 放在这里而不是三个调用方各写一次:D-WC-10 已经把"撤销"收成唯一原语,
  // 代际是撤销的**同一件事实**的另一面,分开写迟早漏一处(而漏掉的那处
  // 恰好就是 ABA 回环重新打开的地方,且没有任何断言会红)。
  // 只在真的撤了行时递增 —— 上面 `active.length === 0` 已经早返回,
  // 走到这里必有 count>0,幂等空转不制造代际(与"空转不写 Audit"同口径)。
  //
  // ⚠️ 这是对 User 行的写。调用方按 §9.1 必须已持有该行的 `FOR UPDATE`
  // (`lockAuthSessionUser`),所以这里既不会自取锁、也不会反序。
  await tx.user.update({
    where: { id: input.userId },
    data: { wecomIdentityVersion: { increment: 1 } },
    select: { id: true },
  });

  return { count: updated.count, revoked: active };
}
