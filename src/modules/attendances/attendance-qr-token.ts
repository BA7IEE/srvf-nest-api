import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const ATTENDANCE_QR_TOKEN_CONTEXT = 'srvf:attendance-qr:v1';
export const ATTENDANCE_QR_TOKEN_VERSION = 1;

export type AttendanceQrActionCode = 'check_in' | 'check_out';

export interface AttendanceQrTokenPayload {
  v: 1;
  credentialId: string;
  activityId: string;
  sessionId: string;
  actionCode: AttendanceQrActionCode;
  credentialVersion: number;
  validFrom: string;
  validUntil: string;
}

export interface AttendanceQrTokenInput {
  credentialId: string;
  activityId: string;
  sessionId: string;
  actionCode: AttendanceQrActionCode;
  credentialVersion: number;
  validFrom: Date;
  validUntil: Date;
}

export class AttendanceQrTokenInvalidError extends Error {
  constructor() {
    super('attendance QR token is invalid');
    this.name = 'AttendanceQrTokenInvalidError';
  }
}

function deriveSigningKey(jwtSecret: string): Buffer {
  if (jwtSecret.length === 0) throw new AttendanceQrTokenInvalidError();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(jwtSecret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(ATTENDANCE_QR_TOKEN_CONTEXT, 'utf8'),
      32,
    ),
  );
}

function toIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new AttendanceQrTokenInvalidError();
  return value.toISOString();
}

export function toAttendanceQrTokenPayload(
  input: AttendanceQrTokenInput,
): AttendanceQrTokenPayload {
  if (
    input.credentialId.length === 0 ||
    input.activityId.length === 0 ||
    input.sessionId.length === 0 ||
    !Number.isSafeInteger(input.credentialVersion) ||
    input.credentialVersion < 1 ||
    (input.actionCode !== 'check_in' && input.actionCode !== 'check_out')
  ) {
    throw new AttendanceQrTokenInvalidError();
  }
  const validFrom = toIso(input.validFrom);
  const validUntil = toIso(input.validUntil);
  if (new Date(validFrom).getTime() > new Date(validUntil).getTime()) {
    throw new AttendanceQrTokenInvalidError();
  }
  return {
    v: ATTENDANCE_QR_TOKEN_VERSION,
    credentialId: input.credentialId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    actionCode: input.actionCode,
    credentialVersion: input.credentialVersion,
    validFrom,
    validUntil,
  };
}

// The order here is contractual: it is both the UTF-8 signed payload and the parser's canonical
// representation. JSON object insertion order is intentionally explicit rather than incidental.
export function canonicalizeAttendanceQrPayload(payload: AttendanceQrTokenPayload): string {
  const canonical = toAttendanceQrTokenPayload({
    credentialId: payload.credentialId,
    activityId: payload.activityId,
    sessionId: payload.sessionId,
    actionCode: payload.actionCode,
    credentialVersion: payload.credentialVersion,
    validFrom: new Date(payload.validFrom),
    validUntil: new Date(payload.validUntil),
  });
  if (payload.v !== ATTENDANCE_QR_TOKEN_VERSION) throw new AttendanceQrTokenInvalidError();
  return JSON.stringify({
    v: canonical.v,
    credentialId: canonical.credentialId,
    activityId: canonical.activityId,
    sessionId: canonical.sessionId,
    actionCode: canonical.actionCode,
    credentialVersion: canonical.credentialVersion,
    validFrom: canonical.validFrom,
    validUntil: canonical.validUntil,
  });
}

export function signAttendanceQrToken(input: AttendanceQrTokenInput, jwtSecret: string): string {
  const payload = canonicalizeAttendanceQrPayload(toAttendanceQrTokenPayload(input));
  const payloadPart = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', deriveSigningKey(jwtSecret))
    .update(payload, 'utf8')
    .digest();
  return `${payloadPart}.${signature.toString('base64url')}`;
}

function isPayload(value: unknown): value is AttendanceQrTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === ATTENDANCE_QR_TOKEN_VERSION &&
    typeof record.credentialId === 'string' &&
    typeof record.activityId === 'string' &&
    typeof record.sessionId === 'string' &&
    (record.actionCode === 'check_in' || record.actionCode === 'check_out') &&
    typeof record.credentialVersion === 'number' &&
    Number.isSafeInteger(record.credentialVersion) &&
    typeof record.validFrom === 'string' &&
    typeof record.validUntil === 'string'
  );
}

export function verifyAttendanceQrToken(
  token: string,
  jwtSecret: string,
): AttendanceQrTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new AttendanceQrTokenInvalidError();
  }
  const [payloadPart, signaturePart] = parts;
  let payload: string;
  let providedSignature: Buffer;
  try {
    payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
    providedSignature = Buffer.from(signaturePart, 'base64url');
  } catch {
    throw new AttendanceQrTokenInvalidError();
  }
  const expectedSignature = createHmac('sha256', deriveSigningKey(jwtSecret))
    .update(payload, 'utf8')
    .digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new AttendanceQrTokenInvalidError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new AttendanceQrTokenInvalidError();
  }
  if (!isPayload(parsed) || canonicalizeAttendanceQrPayload(parsed) !== payload) {
    throw new AttendanceQrTokenInvalidError();
  }
  return parsed;
}

export function digestAttendanceQrToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
