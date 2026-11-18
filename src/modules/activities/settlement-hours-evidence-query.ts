import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { assertManualHoursWithinEvidence } from './settlement-manual-hours-policy';
import { rebuildServiceSegments } from './settlement-segment-projector';

/** Caller holds Activity → run locks. No independent transaction or writes. */
export async function validateManualHoursEvidence(
  tx: Prisma.TransactionClient,
  activityId: string,
  items: readonly {
    participationIdentityId: string;
    recognizedServiceHours: Prisma.Decimal | number;
  }[],
): Promise<void> {
  if (items.length === 0) return;
  const identities = await tx.activityParticipationIdentity.findMany({
    where: {
      activityId,
      populationIncluded: true,
      id: { in: items.map((item) => item.participationIdentityId) },
    },
    select: {
      id: true,
      session: {
        select: {
          startAt: true,
          endAt: true,
          lateGraceMinutes: true,
          earlyLeaveThresholdMinutes: true,
        },
      },
      punchEvents: {
        select: {
          id: true,
          eventTypeCode: true,
          occurredAt: true,
          supersedesEventId: true,
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  for (const item of items) {
    const identity = byId.get(item.participationIdentityId);
    if (!identity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const session = identity.session;
    assertManualHoursWithinEvidence(
      new Prisma.Decimal(item.recognizedServiceHours),
      rebuildServiceSegments(identity.punchEvents, {
        sessionStartAt: session.startAt,
        sessionEndAt: session.endAt,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
      }),
    );
  }
}
