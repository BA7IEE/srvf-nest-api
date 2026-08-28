import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { digestAttendanceQrToken, signAttendanceQrToken } from './attendance-qr-token';
import { nextAttendanceQrCredentialVersion } from './attendance-qr-state-machine';

type PrismaTx = Prisma.TransactionClient;

/** 改期联动作废重签时写进 `revokeReason` 的固定文案(AC-010,维护者 2026-08-28 拍板「作废旧码重签」)。 */
export const ATTENDANCE_QR_SESSION_RESCHEDULED_REVOKE_REASON = '场次改期';

export interface ReissuedSessionQrCredential {
  id: string;
  sessionId: string;
  actionCode: string;
  credentialVersion: number;
  validFrom: Date;
  validUntil: Date;
}

/**
 * 按**场次**批量「作废重签」签到二维码凭证(AC-010 改期联动)。
 * 事务内原语,调用方已持 Activity 根锁;与 `revokeSessionQrCredentialsInTransactionTrusted`
 * 同一模块的兄弟原语,头注的四条结构性理由(独立事务 / 判权 / 幂等 / N+1)在这里逐条同样成立。
 *
 * 语义 = 维护者 2026-08-28 拍板的「作废旧码重签」:
 *   1. 该场次仍 active 的凭证全部作废(revokeReason = 场次改期),行形态与 `issue()`
 *      顶掉旧凭证的写法逐字一致;
 *   2. 按改期后的**当前**场次时间窗(checkIn 与 checkOut 四列)为 check_in / check_out
 *      各重签一条新凭证 —— 版本在该 (session, action) 内单调 +1,有效期从新窗口冻结,
 *      与 `issue()` 同一把尺子;**必须在 applySessions 落库之后调用**,否则冻结的还是旧窗口。
 *
 * 幂等:整个 effect 由变更审核的 versionKey 承载(审批事务只 apply 一次);
 * 函数自身对「该场次没有 active 凭证」安全(只重签、不凭空多签 —— 没签过的场次跳过)。
 *
 * 审计:与取消联动同款处置 —— 不逐条写 QR 审计行,由调用方(effect)写一条聚合审计。
 */
export async function reissueSessionQrCredentialsInTransactionTrusted(
  tx: PrismaTx,
  input: {
    activityId: string;
    sessionIds: readonly string[];
    issuedByUserId: string;
    issuedAt: Date;
    jwtSecret: string;
    /** 稳定的批次键(审核 versionKey),让 operationKey / requestHash 可追溯、可对账。 */
    versionKey: string;
  },
): Promise<ReissuedSessionQrCredential[]> {
  const sessionIds = [...new Set(input.sessionIds)].sort();
  if (sessionIds.length === 0) return [];

  const sessions = await tx.activitySession.findMany({
    where: { activityId: input.activityId, id: { in: sessionIds } },
    select: {
      id: true,
      checkInOpenAt: true,
      checkInCloseAt: true,
      checkOutOpenAt: true,
      checkOutCloseAt: true,
    },
    orderBy: { id: 'asc' },
  });

  // 只处理「确实有凭证历史」的场次 —— 没签过码的改期不凭空造码。
  const latestRows = await tx.attendanceQrCredential.groupBy({
    by: ['sessionId', 'actionCode'],
    where: { activityId: input.activityId, sessionId: { in: sessionIds } },
    _max: { credentialVersion: true },
  });
  const hasHistory = new Set(latestRows.map((row) => row.sessionId));
  const targets = sessions.filter((session) => hasHistory.has(session.id));

  const created: ReissuedSessionQrCredential[] = [];
  for (const session of targets) {
    // ① 作废该场次仍 active 的凭证(行形态与取消联动原语一致,不另立第二种写法)。
    await tx.attendanceQrCredential.updateMany({
      where: {
        activityId: input.activityId,
        sessionId: session.id,
        statusCode: 'active',
      },
      data: {
        statusCode: 'revoked',
        revokedByUserId: input.issuedByUserId,
        revokedAt: input.issuedAt,
        revokeReason: ATTENDANCE_QR_SESSION_RESCHEDULED_REVOKE_REASON,
      },
    });

    // ② 按新窗口为两个动作各重签一条。
    for (const actionCode of ['check_in', 'check_out'] as const) {
      const latest = latestRows.find(
        (row) => row.sessionId === session.id && row.actionCode === actionCode,
      );
      const credentialVersion = nextAttendanceQrCredentialVersion(
        latest?._max.credentialVersion ?? null,
      );
      const validFrom = actionCode === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt;
      const validUntil =
        actionCode === 'check_in' ? session.checkInCloseAt : session.checkOutCloseAt;
      const id = randomUUID();
      const token = signAttendanceQrToken(
        {
          credentialId: id,
          activityId: input.activityId,
          sessionId: session.id,
          actionCode,
          credentialVersion,
          validFrom,
          validUntil,
        },
        input.jwtSecret,
      );
      const operationKey = `session-reschedule:${input.activityId}:${input.versionKey}:${session.id}:${actionCode}`;
      await tx.attendanceQrCredential.create({
        data: {
          id,
          activityId: input.activityId,
          sessionId: session.id,
          actionCode,
          credentialVersion,
          statusCode: 'active',
          tokenDigest: digestAttendanceQrToken(token),
          signingKeyVersion: 0,
          validFrom,
          validUntil,
          issuedByUserId: input.issuedByUserId,
          issuedAt: input.issuedAt,
          operationKey,
          requestHash: createHash('sha256').update(operationKey, 'utf8').digest('hex'),
        },
        select: { id: true },
      });
      created.push({
        id,
        sessionId: session.id,
        actionCode,
        credentialVersion,
        validFrom,
        validUntil,
      });
    }
  }
  return created;
}
