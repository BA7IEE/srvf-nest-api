import {
  createAttendancePunchRequestHash,
  normalizeAttendancePunchReason,
  type AttendancePunchRequestHashInput,
} from './attendance-punch-request-hash';

const base: AttendancePunchRequestHashInput = {
  operatorUserId: 'user-1',
  memberId: 'member-1',
  participationIdentityId: 'identity-1',
  activityId: 'activity-1',
  sessionId: 'session-1',
  positionId: 'position-1',
  eventTypeCode: 'check_in',
  sourceCode: 'self_qr',
  deviceId: null,
  occurredAt: new Date('2099-12-15T08:00:00.000Z'),
  longitude: 116.1234567,
  latitude: 39.1234567,
  accuracy: 10,
  qrCredentialVersion: 1,
  supersedesEventId: null,
  reason: null,
};

describe('attendance punch request hash', () => {
  it('normalizes equivalent reasons and decimal input deterministically', () => {
    expect(normalizeAttendancePunchReason('  离场\n原因  ')).toBe('离场 原因');
    expect(createAttendancePunchRequestHash({ ...base, reason: '  离场\n原因  ' })).toBe(
      createAttendancePunchRequestHash({ ...base, reason: '离场 原因' }),
    );
  });

  it.each([
    ['member', { memberId: 'member-2' }],
    ['session', { sessionId: 'session-2' }],
    ['action', { eventTypeCode: 'check_out' as const }],
    ['source', { sourceCode: 'correction' as const }],
    ['device', { deviceId: 'device-2' }],
    ['server time', { occurredAt: new Date('2099-12-15T08:00:01.000Z') }],
    ['location', { longitude: 116.1234566 }],
    ['QR version', { qrCredentialVersion: 2 }],
  ])('mutation: changing %s changes the canonical request hash', (_name, mutation) => {
    expect(createAttendancePunchRequestHash({ ...base, ...mutation })).not.toBe(
      createAttendancePunchRequestHash(base),
    );
  });
});
