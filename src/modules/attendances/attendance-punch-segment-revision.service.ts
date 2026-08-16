import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttendanceSegmentProjectorService } from '../activities/attendance-segment-projector.service';

type PrismaTx = Prisma.TransactionClient;

interface PunchProjectionEvent {
  id: string;
  eventTypeCode: string;
  occurredAt: Date;
  supersedesEventId: string | null;
}

interface CurrentSegment {
  id: string;
  segmentKey: string;
  revision: number;
  sourceCheckInEventId: string;
  sourceCloseEventId: string | null;
  resultCode: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  serviceHours: Prisma.Decimal | null;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue | null;
}

@Injectable()
export class AttendancePunchSegmentRevisionService {
  constructor(private readonly projector: AttendanceSegmentProjectorService) {}

  async rebuild(args: {
    tx: PrismaTx;
    identityId: string;
    events: PunchProjectionEvent[];
    session: {
      startAt: Date;
      endAt: Date;
      lateGraceMinutes: number;
      earlyLeaveThresholdMinutes: number;
    };
    operationEventType: 'check_in' | 'check_out' | 'early_departure_close' | 'void' | 'replace';
  }): Promise<void> {
    const projection = this.projector.rebuild(args.events, {
      sessionStartAt: args.session.startAt,
      sessionEndAt: args.session.endAt,
      lateGraceMinutes: args.session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: args.session.earlyLeaveThresholdMinutes,
    });
    if (projection.chainAnomalies.length > 0) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }

    const current = (await args.tx.participantServiceSegmentRevision.findMany({
      where: { participationIdentityId: args.identityId, statusCode: { not: 'superseded' } },
      select: {
        id: true,
        segmentKey: true,
        revision: true,
        sourceCheckInEventId: true,
        sourceCloseEventId: true,
        resultCode: true,
        checkInAt: true,
        checkOutAt: true,
        serviceHours: true,
        lateFlag: true,
        earlyLeaveFlag: true,
        exceptionFlagsJson: true,
      },
      orderBy: [{ segmentKey: 'asc' }, { revision: 'desc' }],
    })) as CurrentSegment[];
    const currentByKey = new Map(current.map((row) => [row.segmentKey, row]));
    const projectedKeys = new Set(projection.segments.map((segment) => segment.segmentKey));

    for (const segment of projection.segments) {
      const prior = currentByKey.get(segment.segmentKey);
      if (prior && this.sameSegment(prior, segment)) continue;
      if (prior) {
        await args.tx.participantServiceSegmentRevision.update({
          where: { id: prior.id },
          data: { statusCode: 'superseded' },
        });
      }
      await args.tx.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: args.identityId,
          segmentKey: segment.segmentKey,
          revision: prior ? prior.revision + 1 : 1,
          sourceCheckInEventId: segment.sourceCheckInEventId,
          sourceCloseEventId: segment.sourceCloseEventId,
          resultCode: segment.resultCode,
          statusCode: 'draft',
          checkInAt: segment.checkInAt,
          checkOutAt: segment.checkOutAt,
          serviceHours: segment.serviceHours,
          lateFlag: segment.lateFlag,
          earlyLeaveFlag: segment.earlyLeaveFlag,
          exceptionFlagsJson: segment.exceptionFlags,
          baseRevisionId: prior?.id ?? null,
          effectiveBatchId: null,
        },
      });
    }

    for (const prior of current) {
      if (projectedKeys.has(prior.segmentKey)) continue;
      await args.tx.participantServiceSegmentRevision.update({
        where: { id: prior.id },
        data: { statusCode: 'superseded' },
      });
      await args.tx.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: args.identityId,
          segmentKey: prior.segmentKey,
          revision: prior.revision + 1,
          sourceCheckInEventId: prior.sourceCheckInEventId,
          sourceCloseEventId: prior.sourceCloseEventId,
          resultCode: args.operationEventType === 'replace' ? 'replaced' : 'voided',
          statusCode: 'draft',
          checkInAt: prior.checkInAt,
          checkOutAt: prior.checkOutAt,
          serviceHours: prior.serviceHours,
          lateFlag: prior.lateFlag,
          earlyLeaveFlag: prior.earlyLeaveFlag,
          exceptionFlagsJson: prior.exceptionFlagsJson ?? [],
          baseRevisionId: prior.id,
          effectiveBatchId: null,
        },
      });
    }
  }

  private sameSegment(
    current: CurrentSegment,
    projected: {
      sourceCheckInEventId: string;
      sourceCloseEventId: string | null;
      resultCode: string;
      checkInAt: Date;
      checkOutAt: Date | null;
      serviceHours: number | null;
      lateFlag: boolean;
      earlyLeaveFlag: boolean;
      exceptionFlags: string[];
    },
  ): boolean {
    return (
      current.sourceCheckInEventId === projected.sourceCheckInEventId &&
      current.sourceCloseEventId === projected.sourceCloseEventId &&
      current.resultCode === projected.resultCode &&
      current.checkInAt.getTime() === projected.checkInAt.getTime() &&
      current.checkOutAt?.getTime() === projected.checkOutAt?.getTime() &&
      (current.serviceHours === null
        ? projected.serviceHours === null
        : projected.serviceHours !== null &&
          current.serviceHours.toFixed(2) === projected.serviceHours.toFixed(2)) &&
      current.lateFlag === projected.lateFlag &&
      current.earlyLeaveFlag === projected.earlyLeaveFlag &&
      JSON.stringify(current.exceptionFlagsJson ?? []) === JSON.stringify(projected.exceptionFlags)
    );
  }
}
