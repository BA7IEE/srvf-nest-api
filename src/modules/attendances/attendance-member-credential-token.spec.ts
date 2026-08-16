import {
  ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS,
  AttendanceMemberCredentialInvalidError,
  canonicalizeAttendanceMemberCredentialPayload,
  signAttendanceMemberCredential,
  verifyAttendanceMemberCredential,
} from './attendance-member-credential-token';

const SECRET = 'batch6-attendance-member-credential-test-secret-at-least-32-bytes';
const issuedAt = new Date('2099-12-15T08:00:00.000Z');
const input = {
  userId: 'user-0001',
  memberId: 'member-0001',
  issuedAt,
  expiresAt: new Date(issuedAt.getTime() + ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS),
  nonce: 'batch6-member-credential-nonce',
};

describe('attendance member credential token', () => {
  it('signs and verifies the exact canonical UTF-8 payload under its own HKDF context', () => {
    const token = signAttendanceMemberCredential(input, SECRET);
    expect(verifyAttendanceMemberCredential(token, SECRET, issuedAt)).toEqual({
      v: 1,
      purpose: 'attendance-member-credential',
      userId: input.userId,
      memberId: input.memberId,
      credentialVersion: 0,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      nonce: input.nonce,
    });
  });

  it('red-first: rejects a credential whose lifetime is not exactly the frozen 60-second TTL', () => {
    expect(() =>
      signAttendanceMemberCredential(
        { ...input, expiresAt: new Date(issuedAt.getTime() + ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS + 1) },
        SECRET,
      ),
    ).toThrow(AttendanceMemberCredentialInvalidError);
  });

  it('mutation: rejects reordered, tampered, and expired payloads', () => {
    const token = signAttendanceMemberCredential(input, SECRET);
    const [, signaturePart] = token.split('.');
    const canonical = canonicalizeAttendanceMemberCredentialPayload({
      v: 1,
      purpose: 'attendance-member-credential',
      userId: input.userId,
      memberId: input.memberId,
      credentialVersion: 0,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      nonce: input.nonce,
    });
    const reordered = JSON.stringify({
      userId: input.userId,
      v: 1,
      purpose: 'attendance-member-credential',
      memberId: input.memberId,
      credentialVersion: 0,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      nonce: input.nonce,
    });
    expect(Buffer.from(canonical, 'utf8').toString('base64url')).toBe(token.split('.')[0]);
    expect(() =>
      verifyAttendanceMemberCredential(
        `${Buffer.from(reordered, 'utf8').toString('base64url')}.${signaturePart}`,
        SECRET,
        issuedAt,
      ),
    ).toThrow(AttendanceMemberCredentialInvalidError);
    expect(() => verifyAttendanceMemberCredential(`${token}x`, SECRET, issuedAt)).toThrow(
      AttendanceMemberCredentialInvalidError,
    );
    expect(() =>
      verifyAttendanceMemberCredential(token, SECRET, new Date(input.expiresAt.getTime() + 1)),
    ).toThrow(AttendanceMemberCredentialInvalidError);
  });
});
