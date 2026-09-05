import type { Prisma } from '@prisma/client';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

export const EMERGENCY_FOLLOW_UP_CODES = [
  'session',
  'position',
  'detailed_location',
  'equipment',
  'attendance',
  'outcome',
  'incident_relation',
] as const;
export type EmergencyFollowUpCode = (typeof EMERGENCY_FOLLOW_UP_CODES)[number];
export type EmergencyFollowUpStatus = 'pending' | 'verified' | 'unrepresentable';

export function emergencyFollowUpStatuses(facts: {
  session: boolean;
  position: boolean;
  detailedLocation: boolean;
}): Record<EmergencyFollowUpCode, EmergencyFollowUpStatus> {
  return {
    session: facts.session ? 'verified' : 'pending',
    position: facts.position ? 'verified' : 'pending',
    detailed_location: facts.detailedLocation ? 'verified' : 'pending',
    equipment: 'unrepresentable',
    attendance: 'pending',
    outcome: 'unrepresentable',
    incident_relation: 'unrepresentable',
  };
}

export async function createEmergencyFollowUps(
  tx: Prisma.TransactionClient,
  emergencyInitiationId: string,
  actorUserId: string,
  at: Date,
): Promise<void> {
  const statuses = emergencyFollowUpStatuses({
    session: false,
    position: false,
    detailedLocation: false,
  });
  await tx.activityEmergencyFollowUpItem.createMany({
    data: EMERGENCY_FOLLOW_UP_CODES.map((itemCode) => ({
      emergencyInitiationId,
      itemCode,
      statusCode: statuses[itemCode],
      resolvedAt: statuses[itemCode] === 'pending' ? null : at,
      resolvedByUserId: statuses[itemCode] === 'pending' ? null : actorUserId,
    })),
  });
}

/** Caller holds Activity FOR UPDATE. Only activities-owned, current facts may verify an item. */
export async function reconcileEmergencyFollowUps(
  tx: Prisma.TransactionClient,
  activityId: string,
  actorUserId: string,
): Promise<void> {
  const origin = await tx.activityEmergencyInitiation.findUnique({
    where: { activityId },
    select: { id: true },
  });
  if (!origin) return;
  const [sessions, positions, places] = await Promise.all([
    tx.activitySession.findMany({
      where: notDeletedWhere({ activityId, statusCode: 'scheduled' }),
      select: { id: true, longitude: true, latitude: true },
    }),
    tx.activitySessionPosition.findMany({
      where: notDeletedWhere({ activityId, session: notDeletedWhere({ statusCode: 'scheduled' }) }),
      select: { id: true },
    }),
    tx.activityPlace.count({
      where: {
        activityId,
        roleCode: 'primary',
        longitude: { not: null },
        latitude: { not: null },
        OR: [{ sessionId: null }, { session: notDeletedWhere({ statusCode: 'scheduled' }) }],
      },
    }),
  ]);
  const facts = emergencyFollowUpStatuses({
    session: sessions.length > 0,
    position: positions.length > 0,
    detailedLocation:
      places > 0 || sessions.some((s) => s.longitude !== null && s.latitude !== null),
  });
  const at = new Date();
  // Unsupported/attendance facts have no writer here; never infer fulfilment from a note or a count.
  for (const itemCode of ['session', 'position', 'detailed_location'] as const) {
    const statusCode = facts[itemCode];
    await tx.activityEmergencyFollowUpItem.updateMany({
      where: { emergencyInitiationId: origin.id, itemCode, statusCode: { not: statusCode } },
      data: {
        statusCode,
        resolvedAt: statusCode === 'verified' ? at : null,
        resolvedByUserId: statusCode === 'verified' ? actorUserId : null,
      },
    });
  }
}
