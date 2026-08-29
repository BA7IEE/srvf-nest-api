import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { parseIdempotencyKey } from './idempotency-key.decorator';
import { defineIntegrationOperation } from './integration-idempotency.service';

describe('IdempotencyKey header parser', () => {
  it.each(['abcdefgh', 'ABC_1234', 'sync.job:2026-08-30'])('accepts %s', (value) => {
    expect(parseIdempotencyKey(value)).toBe(value);
  });

  it.each([undefined, ['abcdefgh'], 'short', 'contains space', 'x'.repeat(129)])(
    'rejects missing or malformed value %#',
    (value) => {
      try {
        parseIdempotencyKey(value);
        throw new Error('expected parseIdempotencyKey to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BizException);
        expect((error as BizException).biz).toBe(BizCode.BAD_REQUEST);
      }
    },
  );
});

describe('Integration operation registry', () => {
  it('accepts a server-owned lowercase literal and rejects malformed names', () => {
    expect(defineIntegrationOperation('attendance.sheet.create')).toBe('attendance.sheet.create');
    expect(() => defineIntegrationOperation('Client.Operation')).toThrow(
      'server-owned lowercase constant',
    );
  });
});
