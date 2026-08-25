import { Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

/** 场次取消联动作废时写进 `revokeReason` 的固定文案。 */
export const ATTENDANCE_QR_SESSION_CANCELLED_REVOKE_REASON = '场次已取消';

export interface RevokedSessionQrCredential {
  id: string;
  sessionId: string;
  actionCode: string;
  credentialVersion: number;
}

/**
 * 按**场次**批量作废仍然 active 的签到二维码凭证。事务内原语,调用方已持 Activity 根锁。
 *
 * ## 为什么不是直接调 `AttendanceQrCredentialService.revoke()`
 *
 * `revoke()` 是**人工单条**作废命令,它的四条前提与「场次取消联动」逐条不成立 ——
 * 这是结构性理由,不是「现成的不好用」:
 *
 * 1. `revoke()` 体内自己开 `this.prisma.$transaction(...)`。从审批事务里调它会开出**另一条
 *    独立事务**:外层回滚时凭证已经作废且不会被撤回 —— 原子性直接破掉。
 * 2. `revoke()` 里有 `assertManagedAttendance(tx, activityId, currentUser)`:要求**当前用户**
 *    有该活动的考勤管理权。发布审核的审批人不必然是考勤管理员,这条会把正常审批打回。
 * 3. `revoke()` 在凭证已经是 `revoked` 时抛 `ATTENDANCE_QR_REVOKED`。联动作废必须对
 *    「这个场次已经没有 active 凭证」保持幂等,不能因此把整笔审批打回。
 * 4. `revoke()` 按 `credentialId` 单条取锁 + 单条更新 ⇒ 逐条调用就是 N+1。
 *
 * 因此本函数是 `revoke()` 在**同一模块内**的批量兄弟原语,而不是第二套撤销:凭证行的写形态
 * (`statusCode` / `revokedByUserId` / `revokedAt` / `revokeReason`)与 `revoke()` 逐字一致,
 * 且沿用 `issue()` 里「顶掉上一条 active 凭证」既有的同形写法(那里同样没有绕回 `revoke()`)。
 *
 * 审计:与 `issue()` 顶掉旧凭证时的处置一致 —— **不逐条写 QR 审计行**,由发起这次联动的命令
 * (场次取消 effect)写一条聚合审计。否则一次取消会按凭证数量放大审计写入。
 */
export async function revokeSessionQrCredentialsInTransactionTrusted(
  tx: PrismaTx,
  input: {
    activityId: string;
    sessionIds: readonly string[];
    revokedByUserId: string;
    revokedAt: Date;
    revokeReason?: string;
  },
): Promise<RevokedSessionQrCredential[]> {
  const sessionIds = [...new Set(input.sessionIds)].sort();
  if (sessionIds.length === 0) return [];
  const revokeReason = input.revokeReason ?? ATTENDANCE_QR_SESSION_CANCELLED_REVOKE_REASON;

  // 与 `revoke()` 同一条序列化前提(Activity 根锁已在调用方持有),这里再按稳定 id 序取凭证行锁,
  // 避免与并发的 issue / revoke 互相插队。查询按 (activityId, sessionId) 收窄 —— 这正是
  // 「只影响该场次」的被测维度:换成只按 activityId 取,别的场次的码会一起被作废。
  const locked = await tx.$queryRaw<RevokedSessionQrCredential[]>(Prisma.sql`
    SELECT "id", "sessionId", "actionCode", "credentialVersion"
    FROM "AttendanceQrCredential"
    WHERE "activityId" = ${input.activityId}
      AND "sessionId" IN (${Prisma.join(sessionIds)})
      AND "statusCode" = 'active'
    ORDER BY "id" ASC
    FOR UPDATE
  `);
  if (locked.length === 0) return [];

  const updated = await tx.attendanceQrCredential.updateMany({
    where: { id: { in: locked.map((row) => row.id) }, statusCode: 'active' },
    data: {
      statusCode: 'revoked',
      revokedByUserId: input.revokedByUserId,
      revokedAt: input.revokedAt,
      revokeReason,
    },
  });
  if (updated.count !== locked.length) {
    // 行锁已经持有 + where 仍带 statusCode='active' ⇒ 结构上不可能少更新。真发生了就是仪器坏了。
    throw new Error(
      `attendance qr session revocation lost rows: locked=${locked.length} updated=${updated.count}`,
    );
  }
  return locked;
}
