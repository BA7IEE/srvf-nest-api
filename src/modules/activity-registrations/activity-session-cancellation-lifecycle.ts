import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { deriveRegistrationStatusSummary } from './participation-revision-state-machine';

type PrismaTx = Prisma.TransactionClient;

type LockedRegistration = {
  id: string;
  memberId: string;
  statusCode: string;
  statusSummaryCode: string | null;
  currentRevision: number;
  currentFormVersionId: string | null;
};

/**
 * 一条语句里最多塞多少行 VALUES。Prisma bind 参数上限 32767,本文件最宽的一条是 5 列 VALUES
 * 外加 4 个标量,500 行留足余量。
 */
const WRITE_CHUNK_SIZE = 500;

/** 由身份属主(activities)算出的每个报名头前后状态,本模块只负责把表头投影跟上。 */
export interface SessionCancellationRegistrationDeltaInput {
  registrationId: string;
  memberId: string;
  statusCodesBefore: readonly string[];
  statusCodesAfter: readonly string[];
}

/**
 * 场次取消后,把**活动级永久报名头**的投影跟上(§3.6 聚合规则)。
 *
 * ## 职责边界
 *
 * 只写 `ActivityRegistration` / `ActivityRegistrationRevision` —— 这两张表的 `ownerModule`
 * 按 `harness/domain-map.json` 就是本模块。参与身份那一半(`ActivityParticipationIdentity` /
 * `ActivityParticipationRevision`,属主是 activities)在
 * `src/modules/activities/activity-session-participation-cancellation.ts`,由它算出本函数的入参。
 *
 * 拆成两半不是为了好看:合在一处时其中一侧必然是跨属主写,
 * `docs:boundaries:newdebt:check` 当场判新增架构债(实测)。
 *
 * ## 顺序与失败语义
 *
 * 本函数在身份侧写完之后跑,但两者同事务同 Activity 根锁 ——
 * 这里任何一条 fail-closed 都会把身份侧那批写一起回滚,不存在半截状态。
 * 「取消前的表头投影必须与取消前的身份状态自洽」这条断言用的是**入参里的 before**,
 * 因此它检的仍然是身份被改之前的那份事实。
 */
export async function reprojectRegistrationHeadsAfterSessionCancellation(
  tx: PrismaTx,
  input: {
    activityId: string;
    registrations: readonly SessionCancellationRegistrationDeltaInput[];
    actorUserId: string;
    cancelledAt: Date;
    cancelReason: string;
  },
): Promise<{ reprojectedRegistrationCount: number }> {
  if (input.registrations.length === 0) return { reprojectedRegistrationCount: 0 };
  const deltaById = new Map(input.registrations.map((delta) => [delta.registrationId, delta]));
  if (deltaById.size !== input.registrations.length) failClosed();

  const registrationIds = [...deltaById.keys()].sort();
  const registrations = await lockRegistrations(tx, input.activityId, registrationIds);
  if (registrations.length !== registrationIds.length) failClosed();

  const projected = registrations.map((registration) => {
    const delta = deltaById.get(registration.id);
    if (!delta || delta.memberId !== registration.memberId) failClosed();
    // 取消**前**的表头投影必须与取消前的身份状态自洽 —— 对不上说明有别的写路径漂了,
    // 此时把新投影盖上去只会把漂移固化成「已对账」。
    const before = deriveRegistrationStatusSummary(delta.statusCodesBefore);
    if (
      registration.statusCode !== before.statusCode ||
      registration.statusSummaryCode !== before.statusSummaryCode
    ) {
      failClosed();
    }
    return { registration, next: deriveRegistrationStatusSummary(delta.statusCodesAfter) };
  });

  const priorRevisionByRegistrationId = await lockAndVerifyRegistrationRevisions(tx, registrations);
  await writeRegistrationRevisions(tx, registrations, priorRevisionByRegistrationId, input);
  await updateRegistrationHeaders(tx, projected, input);
  return { reprojectedRegistrationCount: registrations.length };
}

async function writeRegistrationRevisions(
  tx: PrismaTx,
  registrations: readonly LockedRegistration[],
  priorRevisionByRegistrationId: ReadonlyMap<string, string>,
  input: { actorUserId: string; cancelledAt: Date; cancelReason: string },
): Promise<void> {
  for (const batch of chunk(registrations)) {
    const created = await tx.activityRegistrationRevision.createMany({
      data: batch.map((registration) => ({
        registrationId: registration.id,
        revision: registration.currentRevision + 1,
        formVersionId: registration.currentFormVersionId,
        answersHash: null,
        sourceCode: 'admin',
        submittedByUserId: input.actorUserId,
        submittedAt: input.cancelledAt,
        priorRevisionId: priorRevisionByRegistrationId.get(registration.id) ?? null,
        reason: input.cancelReason,
      })),
    });
    if (created.count !== batch.length) failClosed();
  }
}

async function updateRegistrationHeaders(
  tx: PrismaTx,
  projected: ReadonlyArray<{
    registration: LockedRegistration;
    next: { statusCode: string; statusSummaryCode: string };
  }>,
  input: { actorUserId: string; cancelledAt: Date; cancelReason: string },
): Promise<void> {
  for (const batch of chunk(projected)) {
    const values = Prisma.join(
      batch.map(
        (row) =>
          Prisma.sql`(${row.registration.id}::text, ${row.registration.currentRevision}::int, ${row.registration.currentRevision + 1}::int, ${row.next.statusCode}::text, ${row.next.statusSummaryCode}::text)`,
      ),
    );
    // 原生 UPDATE 绕过 Prisma 的 `@updatedAt` ⇒ 必须显式写 updatedAt。
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "ActivityRegistration" AS r
      SET "currentRevision" = v.next_revision,
          "statusCode" = v.status_code,
          "statusSummaryCode" = v.status_summary_code,
          "cancelledByUserId" = CASE WHEN v.status_code = 'cancelled'
            THEN ${input.actorUserId} ELSE r."cancelledByUserId" END,
          "cancelledAt" = CASE WHEN v.status_code = 'cancelled'
            THEN ${input.cancelledAt} ELSE r."cancelledAt" END,
          "cancelReason" = CASE WHEN v.status_code = 'cancelled'
            THEN ${input.cancelReason} ELSE r."cancelReason" END,
          "updatedAt" = ${input.cancelledAt}
      FROM (VALUES ${values})
        AS v(id, expected_revision, next_revision, status_code, status_summary_code)
      WHERE r."id" = v.id
        AND r."currentRevision" = v.expected_revision
        AND r."deletedAt" IS NULL
    `);
    if (updated !== batch.length) failClosed();
  }
}

async function lockRegistrations(
  tx: PrismaTx,
  activityId: string,
  registrationIds: readonly string[],
): Promise<LockedRegistration[]> {
  return tx.$queryRaw<LockedRegistration[]>(Prisma.sql`
    SELECT "id", "memberId", "statusCode", "statusSummaryCode",
           "currentRevision", "currentFormVersionId"
    FROM "ActivityRegistration"
    WHERE "activityId" = ${activityId}
      AND "id" IN (${Prisma.join(registrationIds)})
      AND "deletedAt" IS NULL
    ORDER BY "id" ASC
    FOR UPDATE
  `);
}

async function lockAndVerifyRegistrationRevisions(
  tx: PrismaTx,
  registrations: readonly LockedRegistration[],
): Promise<Map<string, string>> {
  const revisioned = registrations.filter((registration) => registration.currentRevision > 0);
  if (revisioned.length === 0) return new Map();
  const revisions = await tx.$queryRaw<
    Array<{ id: string; registrationId: string; revision: number }>
  >(Prisma.sql`
    SELECT "id", "registrationId", "revision"
    FROM "ActivityRegistrationRevision"
    WHERE (${Prisma.join(
      revisioned.map(
        (registration) =>
          Prisma.sql`("registrationId" = ${registration.id} AND "revision" = ${registration.currentRevision})`,
      ),
      ' OR ',
    )})
    ORDER BY "registrationId" ASC
    FOR UPDATE
  `);
  if (revisions.length !== revisioned.length) failClosed();
  const byRegistrationId = new Map<string, string>();
  for (const revision of revisions) {
    if (byRegistrationId.has(revision.registrationId)) failClosed();
    byRegistrationId.set(revision.registrationId, revision.id);
  }
  if (byRegistrationId.size !== revisioned.length) failClosed();
  return byRegistrationId;
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
