import { AttendancePunchPresenter } from './attendance-punch-presenter';

describe('attendance punch presenter', () => {
  it('returns safe evidence facts without raw coordinates or QR material', () => {
    const dto = new AttendancePunchPresenter().presentReceipt(
      {
        eventId: 'event-1',
        eventTypeCode: 'check_in',
        occurredAt: new Date('2099-12-15T08:00:00.000Z'),
        segmentStatusCode: 'open',
        distanceMeters: 12.3456,
        geoVerified: true,
        lowAccuracy: false,
        nextAllowedAction: 'check_out',
      },
      new Date('2099-12-15T08:00:00.000Z'),
    );
    expect(dto).toEqual(
      expect.objectContaining({
        eventId: 'event-1',
        distanceMeters: '12.35',
        nextAllowedAction: 'check_out',
      }),
    );
    expect(Object.keys(dto)).not.toEqual(
      expect.arrayContaining(['longitude', 'latitude', 'qrToken']),
    );
  });
});
