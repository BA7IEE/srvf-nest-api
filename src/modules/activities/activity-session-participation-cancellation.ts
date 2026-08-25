import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

type PrismaTx = Prisma.TransactionClient;

type LockedIdentity = {
  id: string;
  registrationId: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  version: number;
  revisionStatusCode: string | null;
  revisionPositionId: string | null;
};

const CANCELLABLE_IDENTITY_STATUSES = new Set(['pending', 'waitlisted']);
const PRESERVED_EMPTY_IDENTITY_STATUSES = new Set([
  'cancelled',
  'rejected',
  'not_selected',
  'review_expired',
  'waitlist_expired',
]);
const PRESERVED_PARTICIPATING_IDENTITY_STATUSES = new Set(['attended', 'settled']);

/**
 * 一条语句里最多塞多少行 VALUES。Prisma bind 参数上限 32767,本文件最宽的一条是 4 列 VALUES,
 * 500 行留足余量。
 */
const WRITE_CHUNK_SIZE = 500;

/** 一个被波及的报名头在本次取消**前后**的全部身份状态,交给属主模块重投影表头。 */
export interface SessionCancellationRegistrationDelta {
  registrationId: string;
  memberId: string;
  statusCodesBefore: string[];
  statusCodesAfter: string[];
}

export interface SessionParticipationCancellationResult {
  /** 本次真正被改成 cancelled 的身份行 id。 */
  cancelledIdentityIds: string[];
  /** 被取消场次里**仍然在册**的队员(未终态的身份),即通知收件集合。 */
  affectedMemberIds: string[];
  /** 需要由 `activity-registrations`(报名头属主)重投影的报名头。 */
  registrationDeltas: SessionCancellationRegistrationDelta[];
  /** 有身份行从「计入结算人口」变成不计入。 */
  populationChanged: boolean;
}

/**
 * 按**场次**关闭未决的参与身份 —— `activity-cancellation-lifecycle.ts`(整活动取消)的
 * 场次级兄弟:同一套状态口径、同一份不变量断言,区别只在**查询按 sessionId 收窄**。
 *
 * 调用方已持 Activity 根锁,且场次状态已落库。
 *
 * ## 为什么本文件在 `activities/` 而不是 `activity-registrations/`
 *
 * `harness/domain-map.json` 把 `ActivityParticipationIdentity` / `ActivityParticipationRevision`
 * 的 `ownerModule` 判给 **activities**,把 `ActivityRegistration` / `ActivityRegistrationRevision`
 * 判给 **activity-registrations**。整活动取消那条既有链把两侧写在一个文件里,因此在
 * `harness/architecture-debt.json` 里留着跨属主写的债务身份;本刀按属主**拆成两半**,
 * 两边都是属主写 ⇒ 零新增架构债(实测:合在一处时 `docs:boundaries:newdebt:check` 当场红)。
 * 报名头那半在 `activity-registrations/activity-session-cancellation-lifecycle.ts`。
 *
 * ## 口径:哪些身份会被退掉
 *
 * 与整活动取消**逐条一致**:
 * - `pending` / `waitlisted`(未决,按不变量必然**不持有**任何容量占位)⇒ 追加 cancelled 修订。
 * - `pass` / `attended` / `settled` ⇒ **保留**为不可变的历史事实,零写。
 * - 已终态的(cancelled / rejected / not_selected / *_expired)⇒ 断言投影为空后跳过。
 *
 * ⭐ `pass` 这一支在发布审核链路上**结构不可达**:`ActivityCapacityBucketProjector.apply()`
 * 的目标集只取 `statusCode='scheduled'` 的场次,取消后该场次的桶掉出目标集,而它对
 * 「掉出目标集且 occupied ≠ 0 的桶」是 `failClosed()` —— 也就是说**只要该场次还有人占着名额,
 * 整笔取消审批已经被拒了**,根本走不到这里。现存证据:
 * `test/e2e/activity-batch4-capacity-projection.e2e-spec.ts`
 * 「rejects cancellation of a session whose retained historical bucket still has occupancy」。
 * 保留这一支是为了那条闸将来被改动时不静默漏写,不是当前有活路径。
 * ⇒ 因此本函数**不做任何容量 DML**:能走到这里的身份按不变量都不持有占位。
 *
 * ## 为什么全程批量写
 *
 * 一个场次的报名可能上千,而本链路挂在发布审核那条 `$transaction` 上
 * (`activity-publish-review.service.ts` 不带 options ⇒ **Prisma 默认 5s**,不是
 * `MEMBER_TX_TIMEOUT_MS` 的 7000ms)。因此:一次 `createMany` + 一条
 * `UPDATE ... FROM (VALUES ...)`(行级 CAS 塞进 VALUES),**不逐条 await**;
 * 也不用 advisory lock 逐人取锁(PG 共享锁表保底 12800,万人级会 `out of shared memory`)。
 */
export async function cancelSessionParticipationIdentities(
  tx: PrismaTx,
  input: {
    activityId: string;
    sessionIds: readonly string[];
    actorUserId: string;
    cancelledAt: Date;
    cancelReason: string;
  },
): Promise<SessionParticipationCancellationResult> {
  const empty: SessionParticipationCancellationResult = {
    cancelledIdentityIds: [],
    affectedMemberIds: [],
    registrationDeltas: [],
    populationChanged: false,
  };
  const sessionIds = [...new Set(input.sessionIds)].sort();
  if (sessionIds.length === 0) return empty;

  const sessionIdentities = await lockIdentitiesBySessions(tx, input.activityId, sessionIds);
  if (sessionIdentities.length === 0) return empty;

  const cancellable: LockedIdentity[] = [];
  const stillEnrolled: LockedIdentity[] = [];
  for (const identity of sessionIdentities) {
    assertIdentityShape(identity, input.activityId);
    if (CANCELLABLE_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
      assertUnresolvedIdentity(identity);
      cancellable.push(identity);
      stillEnrolled.push(identity);
      continue;
    }
    if (identity.currentStatusCode === 'pass') {
      assertPreservedPassIdentity(identity);
      stillEnrolled.push(identity);
      continue;
    }
    if (PRESERVED_PARTICIPATING_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
      assertPreservedParticipatingIdentity(identity);
      stillEnrolled.push(identity);
      continue;
    }
    if (PRESERVED_EMPTY_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
      assertUnresolvedIdentity(identity);
      continue;
    }
    failClosed();
  }

  const affectedMemberIds = [...new Set(stillEnrolled.map((identity) => identity.memberId))].sort();
  if (cancellable.length === 0) return { ...empty, affectedMemberIds };

  // 报名头是**活动级**投影(一活动一队员一个永久头),重投影必须看这些头的**全部**身份 ——
  // 只看被取消场次的那几行,会把「他在别的场次还在册」算丢。一次查完,不按头逐条查。
  const registrationIds = [
    ...new Set(cancellable.map((identity) => identity.registrationId)),
  ].sort();
  const allIdentities = await lockIdentitiesByRegistrations(tx, input.activityId, registrationIds);
  const identitiesByRegistrationId = new Map<string, LockedIdentity[]>();
  for (const identity of allIdentities) {
    assertIdentityShape(identity, input.activityId);
    const group = identitiesByRegistrationId.get(identity.registrationId) ?? [];
    group.push(identity);
    identitiesByRegistrationId.set(identity.registrationId, group);
  }

  const cancelledIdentityIdSet = new Set(cancellable.map((identity) => identity.id));
  const registrationDeltas: SessionCancellationRegistrationDelta[] = [];
  for (const registrationId of registrationIds) {
    const group = identitiesByRegistrationId.get(registrationId) ?? [];
    const memberId = group[0]?.memberId;
    if (group.length === 0 || memberId === undefined) failClosed();
    if (group.some((identity) => identity.memberId !== memberId)) failClosed();
    registrationDeltas.push({
      registrationId,
      memberId,
      statusCodesBefore: group.map((identity) => identity.currentStatusCode),
      statusCodesAfter: group.map((identity) =>
        cancelledIdentityIdSet.has(identity.id) ? 'cancelled' : identity.currentStatusCode,
      ),
    });
  }

  await writeParticipationRevisions(tx, cancellable, input);
  await updateIdentityPointers(tx, cancellable, input.cancelledAt);

  return {
    cancelledIdentityIds: cancellable.map((identity) => identity.id),
    affectedMemberIds,
    registrationDeltas,
    populationChanged: cancellable.some((identity) => identity.populationIncluded),
  };
}

async function writeParticipationRevisions(
  tx: PrismaTx,
  cancellable: readonly LockedIdentity[],
  input: { actorUserId: string; cancelledAt: Date; cancelReason: string },
): Promise<void> {
  for (const batch of chunk(cancellable)) {
    const created = await tx.activityParticipationRevision.createMany({
      data: batch.map((identity) => ({
        identityId: identity.id,
        revision: identity.currentRevision + 1,
        statusCode: 'cancelled',
        // 与整活动取消同处置:当前岗位指针清空,但**不可变修订**保留历史岗位事实。
        positionId: identity.revisionPositionId,
        waitlistRank: null,
        cancelledByUserId: input.actorUserId,
        cancelledAt: input.cancelledAt,
        cancelReason: input.cancelReason,
        effectiveAt: input.cancelledAt,
        createdByUserId: input.actorUserId,
        sourceCode: 'admin',
      })),
    });
    if (created.count !== batch.length) failClosed();
  }
}

async function updateIdentityPointers(
  tx: PrismaTx,
  cancellable: readonly LockedIdentity[],
  cancelledAt: Date,
): Promise<void> {
  for (const batch of chunk(cancellable)) {
    const values = Prisma.join(
      batch.map(
        (identity) =>
          Prisma.sql`(${identity.id}::text, ${identity.currentRevision}::int, ${identity.version}::int, ${identity.currentRevision + 1}::int)`,
      ),
    );
    // 原生 UPDATE 绕过 Prisma 的 `@updatedAt` ⇒ 必须显式写 updatedAt。
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "ActivityParticipationIdentity" AS i
      SET "currentRevision" = v.next_revision,
          "currentStatusCode" = 'cancelled',
          "currentPositionId" = NULL,
          "capacityReservationId" = NULL,
          "populationIncluded" = FALSE,
          "version" = i."version" + 1,
          "updatedAt" = ${cancelledAt}
      FROM (VALUES ${values}) AS v(id, expected_revision, expected_version, next_revision)
      WHERE i."id" = v.id
        AND i."currentRevision" = v.expected_revision
        AND i."version" = v.expected_version
    `);
    if (updated !== batch.length) failClosed();
  }
}

async function lockIdentitiesBySessions(
  tx: PrismaTx,
  activityId: string,
  sessionIds: readonly string[],
): Promise<LockedIdentity[]> {
  // ⭐ 「只影响该场次」的被测维度就在这条 where 上:`i."sessionId" IN (...)`。
  //    去掉它(只按 activityId 取)= 别的场次的人一起被退 —— 变异对拍打的正是这一处。
  return tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
    SELECT
      i."id", i."registrationId", i."activityId", i."memberId", i."sessionId",
      i."currentRevision", i."currentStatusCode", i."currentPositionId",
      i."capacityReservationId", i."populationIncluded", i."version",
      r."statusCode" AS "revisionStatusCode",
      r."positionId" AS "revisionPositionId"
    FROM "ActivityParticipationIdentity" i
    LEFT JOIN "ActivityParticipationRevision" r
      ON r."identityId" = i."id" AND r."revision" = i."currentRevision"
    WHERE i."activityId" = ${activityId}
      AND i."sessionId" IN (${Prisma.join(sessionIds)})
    ORDER BY i."id" ASC
    FOR UPDATE OF i
  `);
}

async function lockIdentitiesByRegistrations(
  tx: PrismaTx,
  activityId: string,
  registrationIds: readonly string[],
): Promise<LockedIdentity[]> {
  return tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
    SELECT
      i."id", i."registrationId", i."activityId", i."memberId", i."sessionId",
      i."currentRevision", i."currentStatusCode", i."currentPositionId",
      i."capacityReservationId", i."populationIncluded", i."version",
      r."statusCode" AS "revisionStatusCode",
      r."positionId" AS "revisionPositionId"
    FROM "ActivityParticipationIdentity" i
    LEFT JOIN "ActivityParticipationRevision" r
      ON r."identityId" = i."id" AND r."revision" = i."currentRevision"
    WHERE i."activityId" = ${activityId}
      AND i."registrationId" IN (${Prisma.join(registrationIds)})
    ORDER BY i."id" ASC
    FOR UPDATE OF i
  `);
}

function assertIdentityShape(identity: LockedIdentity, activityId: string): void {
  if (
    identity.activityId !== activityId ||
    identity.currentRevision < 1 ||
    identity.revisionStatusCode !== identity.currentStatusCode
  ) {
    failClosed();
  }
}

function assertUnresolvedIdentity(identity: LockedIdentity): void {
  if (
    identity.currentPositionId !== null ||
    identity.capacityReservationId !== null ||
    identity.populationIncluded
  ) {
    failClosed();
  }
}

function assertPreservedPassIdentity(identity: LockedIdentity): void {
  if (
    !identity.populationIncluded ||
    identity.capacityReservationId === null ||
    identity.revisionPositionId !== identity.currentPositionId
  ) {
    failClosed();
  }
}

function assertPreservedParticipatingIdentity(identity: LockedIdentity): void {
  if (!identity.populationIncluded || identity.revisionPositionId !== identity.currentPositionId) {
    failClosed();
  }
}

function chunk<T>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += WRITE_CHUNK_SIZE) {
    batches.push(rows.slice(index, index + WRITE_CHUNK_SIZE));
  }
  return batches;
}

function failClosed(): never {
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}
