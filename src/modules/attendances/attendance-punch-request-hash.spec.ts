import {
  createAttendancePunchRequestHash,
  createManagedOnlineAttendancePunchRequestHash,
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

describe('managed online attendance punch request hash', () => {
  const managed = {
    activityId: 'activity-1',
    sessionId: 'session-1',
    actorUserId: 'operator-1',
    participationIdentityId: 'identity-1',
    actionCode: 'check_in' as const,
    sourceCode: 'staff_scan' as const,
    eventKey: 'event-1',
    longitude: 116.1234567,
    latitude: 39.1234567,
    accuracy: 10,
    reason: '  现场\n确认  ',
  };

  it('uses the B6 canonical payload, including the event key and normalized reason', () => {
    expect(createManagedOnlineAttendancePunchRequestHash(managed)).toBe(
      createManagedOnlineAttendancePunchRequestHash({ ...managed, reason: '现场 确认' }),
    );
  });

  it.each([
    ['event key', { eventKey: 'event-2' }],
    ['actor', { actorUserId: 'operator-2' }],
    ['identity', { participationIdentityId: 'identity-2' }],
    ['location', { longitude: 116.1234566 }],
  ])('mutation: changing %s changes the B6 managed request hash', (_name, mutation) => {
    expect(createManagedOnlineAttendancePunchRequestHash({ ...managed, ...mutation })).not.toBe(
      createManagedOnlineAttendancePunchRequestHash(managed),
    );
  });

  it('binds a frozen historical time for import, without changing real-time staff hashes', () => {
    const imported = {
      ...managed,
      sourceCode: 'import' as const,
      occurredAt: new Date('2099-12-15T08:00:00.000Z'),
    };
    expect(
      createManagedOnlineAttendancePunchRequestHash({
        ...imported,
        occurredAt: new Date('2099-12-15T08:00:01.000Z'),
      }),
    ).not.toBe(createManagedOnlineAttendancePunchRequestHash(imported));
    expect(() =>
      createManagedOnlineAttendancePunchRequestHash({ ...imported, occurredAt: null }),
    ).toThrow('attendance import occurredAt is invalid');
  });
});
