import { AttendanceQrPresenter } from './attendance-qr-presenter';

describe('attendance QR presenter', () => {
  it('returns only safe metadata and never accepts a token or digest field', () => {
    const dto = new AttendanceQrPresenter().present({
      id: 'credential-1',
      activityId: 'activity-1',
      sessionId: 'session-1',
      actionCode: 'check_in',
      credentialVersion: 1,
      statusCode: 'active',
      validFrom: new Date('2099-12-15T07:30:00.000Z'),
      validUntil: new Date('2099-12-15T08:30:00.000Z'),
      issuedAt: new Date('2099-12-15T07:00:00.000Z'),
      revokedAt: null,
    });
    expect(Object.keys(dto).sort()).toEqual([
      'actionCode',
      'activityId',
      'credentialId',
      'credentialVersion',
      'issuedAt',
      'revokedAt',
      'sessionId',
      'statusCode',
      'validFrom',
      'validUntil',
    ]);
  });
});
