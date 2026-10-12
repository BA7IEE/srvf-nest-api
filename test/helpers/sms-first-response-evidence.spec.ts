import { smsFirstResponseEvidence } from './sms-first-response-evidence';

describe('SMS first response evidence fixed whitelist', () => {
  it('retains protocol failure and a fixed transaction hint without response details', () => {
    const evidence = smsFirstResponseEvidence(
      {
        status: 500,
        body: {
          code: 50000,
          message: 'P2028 expired transaction; phone=13912345678 token=private secret=private',
          data: null,
          traceId: 'private',
        },
      },
      'interval',
    );
    expect(evidence).toEqual({
      kind: 'SMS_FIRST_RESPONSE_FIXED_EVIDENCE',
      window: 'interval',
      httpStatus: 500,
      code: 50000,
      hasData: false,
      messageHint: 'TX_EXPIRED',
    });
    expect(JSON.stringify(evidence)).not.toMatch(/13912345678|private|token|secret|traceId/u);
  });

  it.each([
    ['P2034 write conflict', 'TX_CONFLICT'],
    ['admin SMS active slot disappeared for aggregate=private', 'RESERVATION_INVARIANT'],
    ['unknown sensitive SQL values', 'UNCLASSIFIED'],
    ['', 'NONE'],
  ])('classifies a fixed hint without returning message text', (message, messageHint) => {
    expect(
      smsFirstResponseEvidence(
        { status: 503, body: { code: 50000, message, data: null } },
        'interval',
      ).messageHint,
    ).toBe(messageHint);
  });

  it('preserves success facts without including recipient data', () => {
    expect(
      smsFirstResponseEvidence(
        { status: 200, body: { code: 0, data: { phone: 'private' } } },
        'idempotent',
      ),
    ).toEqual({
      kind: 'SMS_FIRST_RESPONSE_FIXED_EVIDENCE',
      window: 'idempotent',
      httpStatus: 200,
      code: 0,
      hasData: true,
      messageHint: 'NONE',
    });
  });

  it.each([null, 'private', { code: 'private' }, { code: 13912345678 }])(
    'rejects nonprotocol values rather than echoing them',
    (body) => {
      const evidence = smsFirstResponseEvidence({ status: 'private', body }, 'daily-limit');
      expect(evidence.httpStatus).toBeNull();
      expect(evidence.code).toBeNull();
      expect(JSON.stringify(evidence)).not.toContain('private');
    },
  );
});
