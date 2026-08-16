import {
  AttendanceQrTokenInvalidError,
  canonicalizeAttendanceQrPayload,
  digestAttendanceQrToken,
  signAttendanceQrToken,
  verifyAttendanceQrToken,
} from './attendance-qr-token';

const SECRET = 'batch5-attendance-qr-test-secret-with-at-least-32-characters';
const input = {
  credentialId: 'credential-0001',
  activityId: 'activity-0001',
  sessionId: 'session-0001',
  actionCode: 'check_in' as const,
  credentialVersion: 3,
  validFrom: new Date('2099-12-15T07:30:00.000Z'),
  validUntil: new Date('2099-12-15T08:30:00.000Z'),
};

describe('attendance QR token', () => {
  it('signs and verifies the exact canonical UTF-8 payload under the isolated HKDF context', () => {
    const token = signAttendanceQrToken(input, SECRET);
    expect(verifyAttendanceQrToken(token, SECRET)).toEqual({
      v: 1,
      credentialId: input.credentialId,
      activityId: input.activityId,
      sessionId: input.sessionId,
      actionCode: input.actionCode,
      credentialVersion: input.credentialVersion,
      validFrom: input.validFrom.toISOString(),
      validUntil: input.validUntil.toISOString(),
    });
    expect(digestAttendanceQrToken(token)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('mutation: rejects a reordered payload rather than accepting non-canonical serialization', () => {
    const canonical = canonicalizeAttendanceQrPayload({
      v: 1,
      credentialId: input.credentialId,
      activityId: input.activityId,
      sessionId: input.sessionId,
      actionCode: input.actionCode,
      credentialVersion: input.credentialVersion,
      validFrom: input.validFrom.toISOString(),
      validUntil: input.validUntil.toISOString(),
    });
    const [payloadPart, signaturePart] = signAttendanceQrToken(input, SECRET).split('.');
    expect(payloadPart).toBe(Buffer.from(canonical, 'utf8').toString('base64url'));
    const reordered = JSON.stringify({
      credentialId: input.credentialId,
      v: 1,
      activityId: input.activityId,
      sessionId: input.sessionId,
      actionCode: input.actionCode,
      credentialVersion: input.credentialVersion,
      validFrom: input.validFrom.toISOString(),
      validUntil: input.validUntil.toISOString(),
    });
    const malformed = `${Buffer.from(reordered, 'utf8').toString('base64url')}.${signaturePart}`;
    expect(() => verifyAttendanceQrToken(malformed, SECRET)).toThrow(AttendanceQrTokenInvalidError);
  });

  it('mutation: rejects a token signed with a different source secret', () => {
    const token = signAttendanceQrToken(input, SECRET);
    expect(() => verifyAttendanceQrToken(token, `${SECRET}-other`)).toThrow(
      AttendanceQrTokenInvalidError,
    );
  });
});
