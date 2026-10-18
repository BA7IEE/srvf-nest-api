type SmsWindow = 'idempotent' | 'daily-limit' | 'interval';
type MessageHint = 'NONE' | 'TX_EXPIRED' | 'TX_CONFLICT' | 'RESERVATION_INVARIANT' | 'UNCLASSIFIED';

const messageHints: readonly [MessageHint, RegExp][] = [
  ['TX_EXPIRED', /\bP2028\b|expired transaction|transaction.*(?:already closed|timeout)/iu],
  ['TX_CONFLICT', /\bP2034\b|write conflict|deadlock|could not serialize/iu],
  ['RESERVATION_INVARIANT', /pending reservation|active slot disappeared|active slot churned/iu],
];

/** Only numeric protocol fields and fixed labels leave this diagnostic boundary. */
export function smsFirstResponseEvidence(
  response: { status: unknown; body: unknown },
  window: SmsWindow,
) {
  const body =
    typeof response.body === 'object' && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  const httpStatus =
    typeof response.status === 'number' &&
    Number.isInteger(response.status) &&
    response.status >= 100 &&
    response.status <= 599
      ? response.status
      : null;
  const code =
    typeof body.code === 'number' &&
    Number.isInteger(body.code) &&
    body.code >= 0 &&
    body.code <= 99_999
      ? body.code
      : null;
  const message = typeof body.message === 'string' ? body.message.slice(0, 2048) : '';
  const hint: MessageHint = message
    ? (messageHints.find(([, pattern]) => pattern.test(message))?.[0] ?? 'UNCLASSIFIED')
    : 'NONE';
  return {
    kind: 'SMS_FIRST_RESPONSE_FIXED_EVIDENCE' as const,
    window,
    httpStatus,
    code,
    hasData: body.data !== null && body.data !== undefined,
    messageHint: hint,
  };
}
