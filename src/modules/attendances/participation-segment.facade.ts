import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const PARTICIPATION_SEGMENT_FACADE_LIMITS = Object.freeze({
  identities: 2000,
  segments: 10000,
});

export interface CurrentParticipationSegment {
  readonly id: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly sourcePositionId: string | null;
  readonly segmentKey: string;
  readonly revision: number;
  readonly sourceCheckInEventId: string;
  readonly sourceCloseEventId: string | null;
  readonly resultCode: 'valid' | 'early_departure_zero' | 'voided' | 'replaced';
  readonly statusCode: 'draft' | 'committed';
  readonly checkInAt: Date;
  readonly checkOutAt: Date | null;
  readonly lateFlag: boolean;
  readonly earlyLeaveFlag: boolean;
  readonly exceptionFlagsJson: Prisma.JsonValue | null;
}

function isCurrentResultCode(value: string): value is CurrentParticipationSegment['resultCode'] {
  return (
    value === 'valid' ||
    value === 'early_departure_zero' ||
    value === 'voided' ||
    value === 'replaced'
  );
}

function isCurrentStatusCode(value: string): value is CurrentParticipationSegment['statusCode'] {
  return value === 'draft' || value === 'committed';
}

/**
 * Internal trusted reader for the persisted current participation-segment facts.
 * The caller owns authorization and any lock required by its later write flow.
 */
@Injectable()
export class ParticipationSegmentFacade {
  async readActivityCurrentSegmentsTrusted(
    tx: Prisma.TransactionClient,
    activityId: string,
  ): Promise<readonly CurrentParticipationSegment[]> {
    if (!activityId) throw new TypeError('activity id is required');

    const rows = await tx.participantServiceSegmentRevision.findMany({
      where: {
        identity: { activityId },
        statusCode: { not: 'superseded' },
      },
      take: PARTICIPATION_SEGMENT_FACADE_LIMITS.segments + 1,
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }, { revision: 'asc' }],
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        sourceCheckInEventId: true,
        sourceCloseEventId: true,
        resultCode: true,
        statusCode: true,
        checkInAt: true,
        checkOutAt: true,
        lateFlag: true,
        earlyLeaveFlag: true,
        exceptionFlagsJson: true,
        identity: {
          select: {
            id: true,
            activityId: true,
            sessionId: true,
            memberId: true,
          },
        },
        sourceCheckInEvent: {
          select: {
            id: true,
            activityId: true,
            sessionId: true,
            participationIdentityId: true,
            memberId: true,
            positionId: true,
          },
        },
        sourceCloseEvent: {
          select: {
            id: true,
            activityId: true,
            sessionId: true,
            participationIdentityId: true,
            memberId: true,
          },
        },
      },
    });
    if (rows.length > PARTICIPATION_SEGMENT_FACADE_LIMITS.segments)
      throw new RangeError('participation segment limit exceeded');

    const identities = new Set<string>();
    const segments: CurrentParticipationSegment[] = [];
    for (const row of rows) {
      const identity = row.identity;
      if (
        row.participationIdentityId !== identity.id ||
        identity.activityId !== activityId ||
        !identity.sessionId ||
        !identity.memberId
      )
        throw new TypeError('participation segment identity chain mismatch');
      if (!isCurrentStatusCode(row.statusCode))
        throw new TypeError('participation segment status is not current');
      if (!isCurrentResultCode(row.resultCode))
        throw new TypeError('participation segment result is not supported');

      const checkIn = row.sourceCheckInEvent;
      if (
        !checkIn ||
        checkIn.id !== row.sourceCheckInEventId ||
        checkIn.participationIdentityId !== identity.id ||
        checkIn.activityId !== identity.activityId ||
        checkIn.sessionId !== identity.sessionId ||
        checkIn.memberId !== identity.memberId
      )
        throw new TypeError('participation segment check-in anchor mismatch');

      if (row.sourceCloseEventId !== null) {
        const close = row.sourceCloseEvent;
        if (
          !close ||
          close.id !== row.sourceCloseEventId ||
          close.participationIdentityId !== identity.id ||
          close.activityId !== identity.activityId ||
          close.sessionId !== identity.sessionId ||
          close.memberId !== identity.memberId
        )
          throw new TypeError('participation segment close anchor mismatch');
      }

      identities.add(identity.id);
      segments.push({
        id: row.id,
        activityId: identity.activityId,
        sessionId: identity.sessionId,
        participationIdentityId: identity.id,
        memberId: identity.memberId,
        sourcePositionId: checkIn.positionId,
        segmentKey: row.segmentKey,
        revision: row.revision,
        sourceCheckInEventId: row.sourceCheckInEventId,
        sourceCloseEventId: row.sourceCloseEventId,
        resultCode: row.resultCode,
        statusCode: row.statusCode,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        lateFlag: row.lateFlag,
        earlyLeaveFlag: row.earlyLeaveFlag,
        exceptionFlagsJson: row.exceptionFlagsJson,
      });
    }
    if (identities.size > PARTICIPATION_SEGMENT_FACADE_LIMITS.identities)
      throw new RangeError('participation identity limit exceeded');

    return segments;
  }
}
