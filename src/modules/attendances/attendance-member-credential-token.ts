import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_CONTEXT =
  'srvf:attendance-member-credential:v1';
export const ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_VERSION = 1;
export const ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS = 60_000;

export interface AttendanceMemberCredentialPayload {
  v: 1;
  purpose: 'attendance-member-credential';
  userId: string;
  memberId: string;
  credentialVersion: 0;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface AttendanceMemberCredentialInput {
  userId: string;
  memberId: string;
  issuedAt: Date;
  expiresAt: Date;
  nonce?: string;
}

export class AttendanceMemberCredentialInvalidError extends Error {
  constructor() {
    super('attendance member credential is invalid');
    this.name = 'AttendanceMemberCredentialInvalidError';
  }
}

function deriveSigningKey(jwtSecret: string): Buffer {
  if (jwtSecret.length === 0) throw new AttendanceMemberCredentialInvalidError();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(jwtSecret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_CONTEXT, 'utf8'),
      32,
    ),
  );
}

function toIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new AttendanceMemberCredentialInvalidError();
  return value.toISOString();
}

function validNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,}$/u.test(value);
}

export function toAttendanceMemberCredentialPayload(
  input: AttendanceMemberCredentialInput,
): AttendanceMemberCredentialPayload {
  if (input.userId.length === 0 || input.memberId.length === 0) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const issuedAt = toIso(input.issuedAt);
  const expiresAt = toIso(input.expiresAt);
  const issuedAtMs = new Date(issuedAt).getTime();
  const expiresAtMs = new Date(expiresAt).getTime();
  if (expiresAtMs - issuedAtMs !== ATTENDANCE_MEMBER_CREDENTIAL_TTL_MS) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const nonce = input.nonce ?? randomBytes(16).toString('base64url');
  if (!validNonce(nonce)) throw new AttendanceMemberCredentialInvalidError();
  return {
    v: ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_VERSION,
    purpose: 'attendance-member-credential',
    userId: input.userId,
    memberId: input.memberId,
    credentialVersion: 0,
    issuedAt,
    expiresAt,
    nonce,
  };
}

// Explicit insertion order is the signed UTF-8 payload; do not depend on serializer key order.
export function canonicalizeAttendanceMemberCredentialPayload(
  payload: AttendanceMemberCredentialPayload,
): string {
  if (
    payload.v !== ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_VERSION ||
    payload.purpose !== 'attendance-member-credential' ||
    payload.credentialVersion !== 0
  ) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const canonical = toAttendanceMemberCredentialPayload({
    userId: payload.userId,
    memberId: payload.memberId,
    issuedAt: new Date(payload.issuedAt),
    expiresAt: new Date(payload.expiresAt),
    nonce: payload.nonce,
  });
  return JSON.stringify({
    v: canonical.v,
    purpose: canonical.purpose,
    userId: canonical.userId,
    memberId: canonical.memberId,
    credentialVersion: canonical.credentialVersion,
    issuedAt: canonical.issuedAt,
    expiresAt: canonical.expiresAt,
    nonce: canonical.nonce,
  });
}

export function signAttendanceMemberCredential(
  input: AttendanceMemberCredentialInput,
  jwtSecret: string,
): string {
  const payload = canonicalizeAttendanceMemberCredentialPayload(
    toAttendanceMemberCredentialPayload(input),
  );
  const payloadPart = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', deriveSigningKey(jwtSecret)).update(payload, 'utf8').digest();
  return `${payloadPart}.${signature.toString('base64url')}`;
}

function isPayload(value: unknown): value is AttendanceMemberCredentialPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === ATTENDANCE_MEMBER_CREDENTIAL_TOKEN_VERSION &&
    record.purpose === 'attendance-member-credential' &&
    typeof record.userId === 'string' &&
    typeof record.memberId === 'string' &&
    record.credentialVersion === 0 &&
    typeof record.issuedAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    typeof record.nonce === 'string'
  );
}

export function verifyAttendanceMemberCredential(
  token: string,
  jwtSecret: string,
  now = new Date(),
): AttendanceMemberCredentialPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const [payloadPart, signaturePart] = parts;
  let payload: string;
  let providedSignature: Buffer;
  try {
    payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
    providedSignature = Buffer.from(signaturePart, 'base64url');
  } catch {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const expectedSignature = createHmac('sha256', deriveSigningKey(jwtSecret))
    .update(payload, 'utf8')
    .digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new AttendanceMemberCredentialInvalidError();
  }
  if (!isPayload(parsed) || canonicalizeAttendanceMemberCredentialPayload(parsed) !== payload) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  const nowMs = now.getTime();
  const issuedAtMs = new Date(parsed.issuedAt).getTime();
  const expiresAtMs = new Date(parsed.expiresAt).getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    nowMs < issuedAtMs ||
    nowMs > expiresAtMs
  ) {
    throw new AttendanceMemberCredentialInvalidError();
  }
  return parsed;
}
