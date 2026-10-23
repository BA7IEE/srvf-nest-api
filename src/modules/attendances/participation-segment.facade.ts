import { Injectable } from '@nestjs/common';
import type {
  ActivityParticipationIdentity,
  AttendancePunchEvent,
  ParticipantServiceSegmentRevision,
  Prisma,
} from '@prisma/client';
import { AttendanceAccessService } from './attendance-access.service';

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

type CurrentSegmentRow = Pick<
  ParticipantServiceSegmentRevision,
  | 'id'
  | 'participationIdentityId'
  | 'segmentKey'
  | 'revision'
  | 'sourceCheckInEventId'
  | 'sourceCloseEventId'
  | 'resultCode'
  | 'statusCode'
  | 'checkInAt'
  | 'checkOutAt'
  | 'lateFlag'
  | 'earlyLeaveFlag'
  | 'exceptionFlagsJson'
> & {
  identity: Pick<ActivityParticipationIdentity, 'id' | 'activityId' | 'sessionId' | 'memberId'>;
  sourceCheckInEvent: Pick<
    AttendancePunchEvent,
    'id' | 'activityId' | 'sessionId' | 'participationIdentityId' | 'memberId' | 'positionId'
  > | null;
  sourceCloseEvent: Pick<
    AttendancePunchEvent,
    'id' | 'activityId' | 'sessionId' | 'participationIdentityId' | 'memberId'
  > | null;
};

/**
 * Internal trusted reader for the persisted current participation-segment facts.
 * The caller owns authorization and any lock required by its later write flow.
 */
@Injectable()
export class ParticipationSegmentFacade {
  constructor(private readonly access: AttendanceAccessService) {}

  /**
   * Narrow D3 bridge: consumers that already own their authorization may serialize their later
   * allocation write with the same Activity aggregate lock as attendance writers.  It deliberately
   * exposes neither an attendance writer nor any mutable service-segment operation.
   */
  async lockActivityForTimeAllocationWrite(
    tx: Prisma.TransactionClient,
    activityId: string,
  ): Promise<void> {
    await this.access.lockActivityForAttendanceWrite(activityId, tx);
  }

  async readActivityCurrentSegmentsTrusted(
    tx: Prisma.TransactionClient,
    activityId: string,
  ): Promise<readonly CurrentParticipationSegment[]> {
    if (!activityId) throw new TypeError('activity id is required');

    // Keep the bounded relation projection in one query. Separate ORM relation queries rebuild
    // the same 10000-row relation graph in the client engine. Every anchor is still checked below;
    // do not filter mismatched punch anchors out of the result or hide an over-limit row.
    const rows = await tx.$queryRaw<CurrentSegmentRow[]>`
      SELECT s.id, s."participationIdentityId", s."segmentKey", s.revision,
        s."sourceCheckInEventId", s."sourceCloseEventId", s."resultCode", s."statusCode",
        s."checkInAt", s."checkOutAt", s."lateFlag", s."earlyLeaveFlag", s."exceptionFlagsJson",
        json_build_object('id', i.id, 'activityId', i."activityId", 'sessionId', i."sessionId", 'memberId', i."memberId") AS identity,
        CASE WHEN ci.id IS NULL THEN NULL ELSE json_build_object('id', ci.id,
          'activityId', ci."activityId", 'sessionId', ci."sessionId",
          'participationIdentityId', ci."participationIdentityId", 'memberId', ci."memberId", 'positionId', ci."positionId") END AS "sourceCheckInEvent",
        CASE WHEN ce.id IS NULL THEN NULL ELSE json_build_object('id', ce.id,
          'activityId', ce."activityId", 'sessionId', ce."sessionId",
          'participationIdentityId', ce."participationIdentityId", 'memberId', ce."memberId") END AS "sourceCloseEvent"
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      LEFT JOIN "AttendancePunchEvent" ci ON ci.id = s."sourceCheckInEventId"
      LEFT JOIN "AttendancePunchEvent" ce ON ce.id = s."sourceCloseEventId"
      WHERE i."activityId" = ${activityId} AND s."statusCode" <> 'superseded'
      ORDER BY s."participationIdentityId" ASC, s."segmentKey" ASC, s.revision ASC
      LIMIT ${PARTICIPATION_SEGMENT_FACADE_LIMITS.segments + 1}
    `;
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
