import { createHash } from 'node:crypto';

export interface AttendancePunchRequestHashInput {
  operatorUserId: string;
  memberId: string;
  participationIdentityId: string;
  activityId: string;
  sessionId: string;
  positionId: string | null;
  eventTypeCode: 'check_in' | 'check_out' | 'early_departure_close' | 'void' | 'replace';
  sourceCode: 'self_qr' | 'correction';
  deviceId: string | null;
  occurredAt: Date;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
  qrCredentialVersion: number | null;
  supersedesEventId: string | null;
  reason: string | null;
}

export function normalizeAttendancePunchReason(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length === 0 ? null : normalized;
}

function decimal(value: number | null, digits: number): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new Error('attendance punch location is not finite');
  return value.toFixed(digits);
}

export function createAttendancePunchRequestHash(input: AttendancePunchRequestHashInput): string {
  if (!Number.isFinite(input.occurredAt.getTime())) {
    throw new Error('attendance punch occurredAt is invalid');
  }
  const payload = JSON.stringify({
    v: 'attendance-punch-request/v1',
    operatorUserId: input.operatorUserId,
    memberId: input.memberId,
    participationIdentityId: input.participationIdentityId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    positionId: input.positionId,
    eventTypeCode: input.eventTypeCode,
    sourceCode: input.sourceCode,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt.toISOString(),
    location: {
      longitude: decimal(input.longitude, 7),
      latitude: decimal(input.latitude, 7),
      accuracy: decimal(input.accuracy, 2),
    },
    qrCredentialVersion: input.qrCredentialVersion,
    supersedesEventId: input.supersedesEventId,
    reason: normalizeAttendancePunchReason(input.reason),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
