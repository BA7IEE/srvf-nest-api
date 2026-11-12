import { Prisma } from '@prisma/client';
import type { ParticipationIdentityFact } from './activity-participation-projection';

type PostedResultRow = {
  activityId: string;
  currentPostedVersion: number | null;
  versionId: string | null;
  expectedCount: number | null;
  batchId: string | null;
  resultId: string | null;
  identityId: string | null;
  resultCode: string | null;
  identityActivityId: string | null;
};

export interface ReadParticipationIdentityFact extends ParticipationIdentityFact {
  registrationId: string;
  registrationDeletedAt: Date | null;
  currentStatusCode: string;
  populationIncluded: boolean;
  member: { memberNo: string; realName: string; nickname: string | null };
}

/** Activities owner retains the data read; caller supplies its authorized filter and transaction. */
export async function listParticipationOverviewActivitiesInTx(
  tx: Prisma.TransactionClient,
  where: Prisma.ActivityWhereInput,
): Promise<Array<{ id: string; statusCode: string; startAt: Date }>> {
  return tx.activity.findMany({
    where,
    select: { id: true, statusCode: true, startAt: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  });
}

/** Caller authorizes the activity IDs and supplies the same REPEATABLE READ transaction. */
export async function readPostedParticipationFactsInTx(
  tx: Prisma.TransactionClient,
  activityIds: readonly string[],
): Promise<ReadParticipationIdentityFact[]> {
  const ids = [...new Set(activityIds)];
  if (ids.length === 0) return [];
  const [rows, identities] = await Promise.all([
    tx.$queryRaw<PostedResultRow[]>(Prisma.sql`
      SELECT a.id AS "activityId", r."currentPostedVersion", v.id AS "versionId",
             v."sessionParticipationCount" AS "expectedCount", b.id AS "batchId",
             rr.id AS "resultId", rr."participationIdentityId" AS "identityId",
             rr."resultCode", i."activityId" AS "identityActivityId"
      FROM "Activity" a
      LEFT JOIN "AttendanceSettlementRun" r ON r."activityId" = a.id
      LEFT JOIN "AttendanceSettlementVersion" v
        ON v."settlementRunId" = r.id AND r."currentPostedVersion" = v.version
      LEFT JOIN "LedgerPostingBatch" b
        ON b."settlementRunId" = r.id AND b."settlementVersionId" = v.id
       AND b."statusCode" = 'committed'
      LEFT JOIN "ParticipantSettlementResultRevision" rr
        ON rr."settlementVersionId" = v.id AND rr."statusCode" = 'committed'
      LEFT JOIN "ActivityParticipationIdentity" i ON i.id = rr."participationIdentityId"
      WHERE a.id IN (${Prisma.join(ids)}) AND a."deletedAt" IS NULL
      ORDER BY a.id, rr."participationIdentityId"
    `),
    tx.activityParticipationIdentity.findMany({
      where: { activityId: { in: ids } },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        memberId: true,
        registrationId: true,
        currentRevision: true,
        currentStatusCode: true,
        populationIncluded: true,
        revisions: {
          orderBy: { revision: 'asc' },
          select: { revision: true, statusCode: true, sourceCode: true },
        },
        member: { select: { memberNo: true, realName: true, nickname: true } },
        registration: { select: { deletedAt: true } },
      },
      orderBy: [{ activityId: 'asc' }, { memberId: 'asc' }, { sessionId: 'asc' }],
    }),
  ]);

  const requested = new Set(ids);
  const seenActivities = new Set<string>();
  const anchors = new Map<
    string,
    { versionId: string; batchId: string; expectedCount: number; results: number }
  >();
  const results = new Map<string, { activityId: string; resultCode: string }>();
  for (const row of rows) {
    if (!requested.has(row.activityId)) throw new Error('unexpected participation activity');
    seenActivities.add(row.activityId);
    if (row.currentPostedVersion === null) {
      if (row.versionId !== null || row.batchId !== null || row.resultId !== null)
        throw new Error('invalid unposted participation anchor');
      continue;
    }
    if (
      row.versionId === null ||
      row.batchId === null ||
      row.expectedCount === null ||
      !Number.isSafeInteger(row.expectedCount) ||
      row.expectedCount < 0
    )
      throw new Error('invalid posted participation anchor');
    const existing = anchors.get(row.activityId);
    if (
      existing !== undefined &&
      (existing.versionId !== row.versionId ||
        existing.batchId !== row.batchId ||
        existing.expectedCount !== row.expectedCount)
    ) {
      throw new Error('conflicting posted participation anchors');
    }
    const current = existing ?? {
      versionId: row.versionId,
      batchId: row.batchId,
      expectedCount: row.expectedCount,
      results: 0,
    };
    anchors.set(row.activityId, current);
    if (row.resultId === null) {
      if (row.identityId !== null || row.resultCode !== null || row.identityActivityId !== null)
        throw new Error('invalid empty participation result');
      continue;
    }
    if (
      row.identityId === null ||
      row.resultCode === null ||
      row.identityActivityId !== row.activityId ||
      results.has(row.identityId)
    ) {
      throw new Error('invalid posted participation result');
    }
    results.set(row.identityId, { activityId: row.activityId, resultCode: row.resultCode });
    current.results += 1;
  }
  if (
    seenActivities.size !== requested.size ||
    [...anchors.values()].some((a) => a.results !== a.expectedCount)
  ) {
    throw new Error('incomplete posted participation snapshot');
  }

  const seenIdentities = new Set<string>();
  const facts = identities.map((row) => {
    if (!requested.has(row.activityId) || seenIdentities.has(row.id))
      throw new Error('invalid participation identity');
    if (
      !Number.isSafeInteger(row.currentRevision) ||
      row.currentRevision < 0 ||
      row.revisions.length !== row.currentRevision ||
      row.revisions.some((revision, index) => revision.revision !== index + 1)
    ) {
      throw new Error('invalid participation revision pointer');
    }
    seenIdentities.add(row.id);
    const result = results.get(row.id);
    if (result !== undefined && result.activityId !== row.activityId)
      throw new Error('cross-activity participation result');
    return {
      activityId: row.activityId,
      identityId: row.id,
      sessionId: row.sessionId,
      memberId: row.memberId,
      registrationId: row.registrationId,
      registrationDeletedAt: row.registration.deletedAt,
      currentStatusCode: row.currentStatusCode,
      populationIncluded: row.populationIncluded,
      revisions: row.revisions,
      resultCode: result?.resultCode ?? null,
      member: row.member,
    };
  });
  for (const identityId of results.keys()) {
    if (!seenIdentities.has(identityId)) throw new Error('posted participation identity missing');
  }
  return facts;
}
