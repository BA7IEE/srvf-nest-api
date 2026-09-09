import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Public owner boundary for C3-1. Caller must authorize and hold the Activity row lock.
 * Never opens another transaction or returns credentials, locations or free-text evidence.
 */
@Injectable()
export class AttendanceMetricSourceQueryService {
  async readActivityPunchProjectionInputTrusted(
    tx: Prisma.TransactionClient,
    activityId: string,
    maximumEvents: number,
  ) {
    if (maximumEvents !== 20000) throw new RangeError('unsupported metric event budget');
    const events = await tx.attendancePunchEvent.findMany({
      where: { activityId },
      orderBy: { id: 'asc' },
      take: maximumEvents + 1,
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        participationIdentityId: true,
        eventTypeCode: true,
        occurredAt: true,
        supersedesEventId: true,
      },
    });
    if (events.length > maximumEvents) throw new RangeError('metric event limit exceeded');
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.activityId !== activityId) throw new TypeError('metric event activity mismatch');
      const count = (counts.get(event.participationIdentityId) ?? 0) + 1;
      if (count > 1000) throw new RangeError('metric identity event limit exceeded');
      counts.set(event.participationIdentityId, count);
    }
    return events;
  }

  async readCommittedCorrectionAnchorsTrusted(
    tx: Prisma.TransactionClient,
    activityId: string,
    batchIds: readonly string[],
  ) {
    if (batchIds.length > 10000) throw new RangeError('metric batch limit exceeded');
    const ids = [...new Set(batchIds)];
    if (!ids.length) return [];
    // Do not filter request.activityId here: doing so would turn a corrupt cross-activity
    // application into an apparently ordinary batch with no correction association.
    const applications = await tx.correctionApplication.findMany({
      where: { newPostingBatchId: { in: ids } },
      take: ids.length + 1,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        statusCode: true,
        newPostingBatchId: true,
        newSettlementVersionId: true,
        correctionRequestId: true,
        correctionRequest: {
          select: {
            id: true,
            statusCode: true,
            activityId: true,
            settlementRunId: true,
            baseSettlementVersionId: true,
          },
        },
      },
    });
    if (applications.length > ids.length)
      throw new TypeError('ambiguous metric correction associations');
    const batches = new Set<string>();
    for (const application of applications) {
      if (
        !ids.includes(application.newPostingBatchId) ||
        batches.has(application.newPostingBatchId) ||
        application.correctionRequest.activityId !== activityId
      )
        throw new TypeError('invalid metric correction association');
      batches.add(application.newPostingBatchId);
    }
    return applications;
  }
}
