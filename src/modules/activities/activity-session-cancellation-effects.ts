import { Prisma, type Role } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { reprojectRegistrationHeadsAfterSessionCancellation } from '../activity-registrations/activity-session-cancellation-lifecycle';
import { revokeSessionQrCredentialsInTransactionTrusted } from '../attendances/attendance-qr-session-revocation';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityNotificationProducer } from './activity-notification-producer';
import { freezeRegistrationRoster } from './activity-recipient-freeze';
import { cancelSessionParticipationIdentities } from './activity-session-participation-cancellation';

type PrismaTx = Prisma.TransactionClient;

/** 场次取消联动退报名时写进修订链的固定文案。 */
export const SESSION_CANCELLED_REGISTRATION_CANCEL_REASON = '场次已取消';

export interface ActivitySessionCancellationEffectResult {
  cancelledIdentityCount: number;
  revokedCredentialCount: number;
  notifiedMemberCount: number;
  populationRevisionBumped: boolean;
}

const EMPTY_RESULT: ActivitySessionCancellationEffectResult = {
  cancelledIdentityCount: 0,
  revokedCredentialCount: 0,
  notifiedMemberCount: 0,
  populationRevisionBumped: false,
};

/**
 * ADV-018 / AC-010:**单个场次取消**的四格联动 —— 人员、二维码、通知、结算人口。
 *
 * 合同 AC-010 原文:「单个场次取消或改期只影响该场次的名额、二维码、人员、通知和结算人口」。
 * 名额那格由 `ActivityCapacityBucketProjector` 早已落地(取消场次的桶掉出目标集、留作
 * 不可变历史);本类接的是剩下四格,全部**复用既有原语**,不新造能力:
 *
 * | 格 | 复用的既有原语 |
 * |---|---|
 * | 人员 | `cancelSessionParticipationIdentities` + `reprojectRegistrationHeadsAfterSessionCancellation`(整活动取消原语的场次级兄弟,口径逐条一致;按属主拆两半) |
 * | 二维码 | `revokeSessionQrCredentialsInTransactionTrusted`(`revoke()` 的事务内批量兄弟) |
 * | 通知 | `freezeRegistrationRoster` + `ActivityNotificationProducer`(**不新增**第 7 个依据常量) |
 * | 结算人口 | §3.17 的 `ActivityEvidenceState` 人口版本指针 |
 *
 * ## 事务与幂等
 *
 * 调用方(`ActivityPublishProposalV2Service.apply()`)在发布审核那条 `$transaction` 内、
 * **Activity 根锁**之下调用本类 —— 四件事同一把锁、同一笔事务,要么全成要么全不成。
 * 幂等由两层保证:①审批入口的 `operationKey` 重放守卫在进入 apply 之前就返回;
 * ②本类只对**本次由 scheduled 变成 cancelled** 的场次做事(见 caller 的 `newlyCancelledSessionIds`),
 * 且每个原语自身对「已经作废 / 已经终态」都是零写。
 *
 * ## 收件人依据为什么不新增第 7 个 FREEZE_BASIS 常量
 *
 * `FREEZE_BASIS_REGISTRATION_ROSTER` 描述的是**依据的种类**(收件人取自报名名册),
 * 场次只是这份名册的**收窄维度**,而收窄维度按 `activity-recipient-freeze.ts` 既有范式
 * 落在 `basisRef` 上(组织定向那一刀也是先在 `basisRef` 加 `org:` 前缀,只有在
 * 「标签 AND 组织」两个正交维度求交、语义确实变了时才升出新常量)。这里依据种类没变,
 * 因此 `basisRef` 写 `session:<id>`,常量沿用 —— 新增常量反而会把存量在飞 intent 的
 * `basisKind` 语义搅浑。
 *
 * ## 为什么是「函数 + 显式依赖」而不是新的 `@Injectable()` provider
 *
 * 新 provider 必须登进 `activities.module.ts`,而 `harness/domain-map.json` 的 `inputDigest`
 * **覆盖全部 `*.module.ts`**(见 `scripts/check-boundaries.ts` 的 `metadataInputs()`)——
 * 动一行 module 就要改红区里的 domain-map,需要维护者授权。本刀零红区,故把编排写成
 * 收显式依赖的函数,由既有 provider(`ActivityPublishProposalV2Service`)注入并调用:
 * 给既有 provider 加构造参数不改 module 文件。
 */
export interface ActivitySessionCancellationDeps {
  notificationProducer: ActivityNotificationProducer;
  auditLogs: AuditLogsService;
}

export const activitySessionCancellationEffects = {
  async applyInTransactionTrusted(
    tx: PrismaTx,
    deps: ActivitySessionCancellationDeps,
    input: {
      activityId: string;
      /** 本次审批里刚从 scheduled 变成 cancelled 的场次。空 = 零写零通知。 */
      cancelledSessionIds: readonly string[];
      /** 稳定的批次键(审核 id),让重放落在同一个 eventKey / cohortKey 上。 */
      versionKey: string;
      at: Date;
      actorUserId: string;
      actorRoleSnap: Role;
      auditMeta: AuditMeta;
    },
  ): Promise<ActivitySessionCancellationEffectResult> {
    const cancelledSessionIds = [...new Set(input.cancelledSessionIds)].sort();
    if (cancelledSessionIds.length === 0) return EMPTY_RESULT;

    const sessions = await tx.activitySession.findMany({
      where: { activityId: input.activityId, id: { in: cancelledSessionIds } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    const activity = await tx.activity.findUniqueOrThrow({
      where: { id: input.activityId },
      select: { title: true },
    });

    // ① 人员:退掉该场次未决的参与身份(别的场次的身份行一条都不进这个查询),
    //    再由报名头属主把活动级投影跟上。
    const participation = await cancelSessionParticipationIdentities(tx, {
      activityId: input.activityId,
      sessionIds: cancelledSessionIds,
      actorUserId: input.actorUserId,
      cancelledAt: input.at,
      cancelReason: SESSION_CANCELLED_REGISTRATION_CANCEL_REASON,
    });
    await reprojectRegistrationHeadsAfterSessionCancellation(tx, {
      activityId: input.activityId,
      registrations: participation.registrationDeltas,
      actorUserId: input.actorUserId,
      cancelledAt: input.at,
      cancelReason: SESSION_CANCELLED_REGISTRATION_CANCEL_REASON,
    });

    // ② 二维码:作废该场次仍 active 的签到码(别的场次的码不在 where 里)。
    const revoked = await revokeSessionQrCredentialsInTransactionTrusted(tx, {
      activityId: input.activityId,
      sessionIds: cancelledSessionIds,
      revokedByUserId: input.actorUserId,
      revokedAt: input.at,
    });

    // ③ 通知:只发给报了这个场次的人(维护者 2026-08-25 拍板)。
    const cohort = await freezeRegistrationRoster(tx, {
      cohortKey: `activity-session-cancel:${input.activityId}:${input.versionKey}`,
      aggregateType: 'activity',
      aggregateIds: [input.activityId],
      basisRef: cancelledSessionIds.map((sessionId) => `session:${sessionId}`),
      memberIds: participation.affectedMemberIds,
      at: input.at,
    });
    await deps.notificationProducer.enqueueSessionCancellation(tx, {
      activityId: input.activityId,
      activityTitle: activity.title,
      versionKey: input.versionKey,
      sessionNames: sessions.map((session) => session.name),
      cohort,
    });

    // ④ 结算人口。
    await incrementPopulationRevision(tx, input.activityId, input.at);

    // 审计:一次取消写**一条**聚合行(沿 `issue()` 顶掉旧凭证不单独写 QR 审计的既有处置),
    // 不按凭证数 / 报名数放大写入。事件名沿用 activity.publish 伞事件,动作在 extra.operation。
    await deps.auditLogs.log({
      event: 'activity.publish',
      actorUserId: input.actorUserId,
      actorRoleSnap: input.actorRoleSnap,
      resourceType: 'activity',
      resourceId: input.activityId,
      meta: input.auditMeta,
      extra: {
        operation: 'activity-session-cancel',
        sessionIds: cancelledSessionIds,
        cancelledIdentityCount: participation.cancelledIdentityIds.length,
        revokedCredentialCount: revoked.length,
        notifiedMemberCount: cohort.memberIds.length,
      },
      tx,
    });

    return {
      cancelledIdentityCount: participation.cancelledIdentityIds.length,
      revokedCredentialCount: revoked.length,
      notifiedMemberCount: cohort.memberIds.length,
      populationRevisionBumped: true,
    };
  },
};

/**
 * §3.17 人口版本指针递增。
 *
 * §3.17 逐字点名四个递增来源:PunchEvent、ParticipationRevision、**场次取消／终止**、
 * 人工复核正式化,全部要求**同事务**。这里不看「有没有人从人口里掉出去」——
 * 场次被取消这件事本身就改变了应结算人口的构成(该场次不再贡献任何人次),
 * 哪怕这一刻它名下只有未决报名。
 *
 * ⚠️ 这是**活动级**指针,不是场次级。全仓没有场次级人口版本列,合同也没要求有:
 * 场次维度的人口事实由 `EvidenceSeal.populationCountBySession`(Json 快照)承载
 * ⇒ 本刀**不动 schema**。
 *
 * ⚠️ 已知重复:`ActivityRegistrationLifecycleService.incrementPopulationRevisionInTransactionTrusted`
 * 是同一份 CAS 递增。**本刀刻意不合并** —— 那份写在 `activity-registrations` 里,
 * 是跨属主写(`ActivityEvidenceState` 的 ownerModule 是 activities),已按 `XW-0126 / XW-0127`
 * 登记在 `harness/architecture-debt.json`;把它挪走会让 `docs:boundaries:ids:check`
 * 判「登记在案的 call site 不再存在」而红,修它要改债务台账 = 红区授权。
 * 本刀零红区 ⇒ 在属主侧写一份(**零新增架构债**),把合并留给清 XW-0126 / XW-0127 那一刀。
 */
async function incrementPopulationRevision(
  tx: PrismaTx,
  activityId: string,
  now: Date,
): Promise<void> {
  const states = await tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`
    SELECT "id", "version"
    FROM "ActivityEvidenceState"
    WHERE "activityId" = ${activityId}
    FOR UPDATE
  `);
  if (states.length > 1) failClosed();
  const state = states[0];
  if (!state) {
    await tx.activityEvidenceState.create({
      data: { activityId, populationRevision: 1, version: 1, lastPopulationAt: now },
      select: { id: true },
    });
    return;
  }
  const updated = await tx.activityEvidenceState.updateMany({
    where: { id: state.id, version: state.version },
    data: {
      populationRevision: { increment: 1 },
      version: { increment: 1 },
      lastPopulationAt: now,
    },
  });
  if (updated.count !== 1) failClosed();
}

function failClosed(): never {
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}
