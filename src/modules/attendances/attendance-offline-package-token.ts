import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { JwtConfig } from '../../config/jwt.config';

export const ATTENDANCE_OFFLINE_PACKAGE_TOKEN_CONTEXT = 'srvf:attendance-offline-package:v1';
export const ATTENDANCE_OFFLINE_EVENT_TOKEN_CONTEXT = 'srvf:attendance-offline-event:v1';

export interface AttendanceOfflinePackageTokenPayload {
  v: 1;
  purpose: 'attendance-offline-package';
  packageId: string;
  activityId: string;
  sessionId: string;
  operatorUserId: string;
  operatorMemberId: string;
  deviceId: string;
  packageVersion: number;
  packageKeyVersion: 0;
  validFrom: string;
  validUntil: string;
  uploadUntil: string;
  sequenceStart: number;
  chainAnchorHash: string;
  ruleSnapshotHash: string;
  workflowRevision: number;
  participantSnapshotHash: string;
}

export interface AttendanceOfflineEventPayloadInput {
  packageId: string;
  sequence: number;
  priorHash: string;
  eventKey: string;
  actionCode: 'check_in' | 'check_out';
  deviceTime: Date;
  memberCredential: string;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
}

export interface AttendanceOfflineEventProof {
  canonicalPayload: string;
  eventPayloadHash: string;
  memberCredentialDigest: string;
  signatureDigest: string;
  chainHash: string;
}

export class AttendanceOfflinePackageTokenInvalidError extends Error {
  constructor() {
    super('attendance offline package token is invalid');
    this.name = 'AttendanceOfflinePackageTokenInvalidError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function lowerHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function legalString(value: string, maximum = 4096): boolean {
  return value.length > 0 && value.length <= maximum;
}

function iso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AttendanceOfflinePackageTokenInvalidError();
  }
  return value;
}

function finiteDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new AttendanceOfflinePackageTokenInvalidError();
  return value.toISOString();
}

function decimal(value: number | null, digits: number): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new AttendanceOfflinePackageTokenInvalidError();
  return value.toFixed(digits);
}

function deriveKey(secret: string, context: string): Buffer {
  if (secret.length === 0) throw new AttendanceOfflinePackageTokenInvalidError();
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(context, 'utf8'),
      32,
    ),
  );
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPackagePayload(value: unknown): value is AttendanceOfflinePackageTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.v === 1 &&
    row.purpose === 'attendance-offline-package' &&
    typeof row.packageId === 'string' &&
    typeof row.activityId === 'string' &&
    typeof row.sessionId === 'string' &&
    typeof row.operatorUserId === 'string' &&
    typeof row.operatorMemberId === 'string' &&
    typeof row.deviceId === 'string' &&
    typeof row.packageVersion === 'number' &&
    row.packageKeyVersion === 0 &&
    typeof row.validFrom === 'string' &&
    typeof row.validUntil === 'string' &&
    typeof row.uploadUntil === 'string' &&
    typeof row.sequenceStart === 'number' &&
    typeof row.chainAnchorHash === 'string' &&
    typeof row.ruleSnapshotHash === 'string' &&
    typeof row.workflowRevision === 'number' &&
    typeof row.participantSnapshotHash === 'string'
  );
}

export function canonicalizeAttendanceOfflinePackagePayload(
  payload: AttendanceOfflinePackageTokenPayload,
): string {
  if (
    payload.v !== 1 ||
    payload.purpose !== 'attendance-offline-package' ||
    !legalString(payload.packageId, 64) ||
    !legalString(payload.activityId, 64) ||
    !legalString(payload.sessionId, 64) ||
    !legalString(payload.operatorUserId, 64) ||
    !legalString(payload.operatorMemberId, 64) ||
    !legalString(payload.deviceId, 128) ||
    !Number.isSafeInteger(payload.packageVersion) ||
    payload.packageVersion < 1 ||
    payload.packageKeyVersion !== 0 ||
    !Number.isSafeInteger(payload.sequenceStart) ||
    payload.sequenceStart < 1 ||
    !Number.isSafeInteger(payload.workflowRevision) ||
    payload.workflowRevision < 0 ||
    !lowerHex64(payload.chainAnchorHash) ||
    !lowerHex64(payload.ruleSnapshotHash) ||
    !lowerHex64(payload.participantSnapshotHash)
  ) {
    throw new AttendanceOfflinePackageTokenInvalidError();
  }
  const validFrom = iso(payload.validFrom);
  const validUntil = iso(payload.validUntil);
  const uploadUntil = iso(payload.uploadUntil);
  if (!(validFrom < validUntil && validUntil < uploadUntil)) {
    throw new AttendanceOfflinePackageTokenInvalidError();
  }
  return JSON.stringify({
    v: 1,
    purpose: 'attendance-offline-package',
    packageId: payload.packageId,
    activityId: payload.activityId,
    sessionId: payload.sessionId,
    operatorUserId: payload.operatorUserId,
    operatorMemberId: payload.operatorMemberId,
    deviceId: payload.deviceId,
    packageVersion: payload.packageVersion,
    packageKeyVersion: 0,
    validFrom,
    validUntil,
    uploadUntil,
    sequenceStart: payload.sequenceStart,
    chainAnchorHash: payload.chainAnchorHash,
    ruleSnapshotHash: payload.ruleSnapshotHash,
    workflowRevision: payload.workflowRevision,
    participantSnapshotHash: payload.participantSnapshotHash,
  });
}

export function canonicalizeAttendanceOfflineEventPayload(
  input: AttendanceOfflineEventPayloadInput,
): { canonicalPayload: string; memberCredentialDigest: string } {
  if (
    !legalString(input.packageId, 64) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !lowerHex64(input.priorHash) ||
    !legalString(input.eventKey, 128) ||
    !['check_in', 'check_out'].includes(input.actionCode) ||
    !legalString(input.memberCredential) ||
    (input.longitude !== null && (input.longitude < -180 || input.longitude > 180)) ||
    (input.latitude !== null && (input.latitude < -90 || input.latitude > 90)) ||
    (input.longitude === null) !== (input.latitude === null) ||
    (input.accuracy !== null && input.accuracy < 0)
  ) {
    throw new AttendanceOfflinePackageTokenInvalidError();
  }
  const memberCredentialDigest = sha256(input.memberCredential);
  return {
    memberCredentialDigest,
    canonicalPayload: JSON.stringify({
      v: 'attendance-offline-event/v1',
      packageId: input.packageId,
      sequence: input.sequence,
      priorHash: input.priorHash,
      eventKey: input.eventKey,
      actionCode: input.actionCode,
      deviceTime: finiteDate(input.deviceTime),
      memberCredentialDigest,
      location: {
        longitude: decimal(input.longitude, 7),
        latitude: decimal(input.latitude, 7),
        accuracy: decimal(input.accuracy, 2),
      },
    }),
  };
}

export function signAttendanceOfflineEvent(
  packageToken: string,
  input: AttendanceOfflineEventPayloadInput,
): string {
  const { canonicalPayload } = canonicalizeAttendanceOfflineEventPayload(input);
  return createHmac('sha256', deriveKey(packageToken, ATTENDANCE_OFFLINE_EVENT_TOKEN_CONTEXT))
    .update(canonicalPayload, 'utf8')
    .digest('base64url');
}

export function verifyAttendanceOfflineEvent(
  packageToken: string,
  input: AttendanceOfflineEventPayloadInput,
  signature: string,
): AttendanceOfflineEventProof & { signatureValid: boolean } {
  const { canonicalPayload, memberCredentialDigest } =
    canonicalizeAttendanceOfflineEventPayload(input);
  const expected = createHmac(
    'sha256',
    deriveKey(packageToken, ATTENDANCE_OFFLINE_EVENT_TOKEN_CONTEXT),
  )
    .update(canonicalPayload, 'utf8')
    .digest();
  let provided: Buffer;
  let canonicalSignature = false;
  try {
    provided = Buffer.from(signature, 'base64url');
    canonicalSignature = provided.toString('base64url') === signature;
  } catch {
    provided = Buffer.alloc(0);
  }
  const eventPayloadHash = sha256(canonicalPayload);
  const signatureDigest = sha256(signature);
  const chainHash = createAttendanceOfflineChainHash({
    packageId: input.packageId,
    sequence: input.sequence,
    priorHash: input.priorHash,
    eventPayloadHash,
    signatureDigest,
  });
  return {
    canonicalPayload,
    eventPayloadHash,
    memberCredentialDigest,
    signatureDigest,
    chainHash,
    signatureValid: canonicalSignature && safeEqual(provided, expected),
  };
}

export function createAttendanceOfflineChainHash(input: {
  packageId: string;
  sequence: number;
  priorHash: string;
  eventPayloadHash: string;
  signatureDigest: string;
}): string {
  if (
    !legalString(input.packageId, 64) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !lowerHex64(input.priorHash) ||
    !lowerHex64(input.eventPayloadHash) ||
    !lowerHex64(input.signatureDigest)
  ) {
    throw new AttendanceOfflinePackageTokenInvalidError();
  }
  return sha256(JSON.stringify({ v: 'attendance-offline-chain/v1', ...input }));
}

@Injectable()
export class AttendanceOfflinePackageTokenService {
  private readonly jwtSecret: string;

  constructor(config: ConfigService) {
    const jwt = config.get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt.config 未加载');
    this.jwtSecret = jwt.secret;
  }

  sign(payload: AttendanceOfflinePackageTokenPayload): string {
    const canonical = canonicalizeAttendanceOfflinePackagePayload(payload);
    const payloadPart = Buffer.from(canonical, 'utf8').toString('base64url');
    const signaturePart = createHmac(
      'sha256',
      deriveKey(this.jwtSecret, ATTENDANCE_OFFLINE_PACKAGE_TOKEN_CONTEXT),
    )
      .update(canonical, 'utf8')
      .digest('base64url');
    return `${payloadPart}.${signaturePart}`;
  }

  verify(token: string): AttendanceOfflinePackageTokenPayload {
    const [payloadPart, signaturePart, extra] = token.split('.');
    if (!payloadPart || !signaturePart || extra !== undefined) {
      throw new AttendanceOfflinePackageTokenInvalidError();
    }
    let canonical: string;
    let provided: Buffer;
    try {
      const payloadBytes = Buffer.from(payloadPart, 'base64url');
      canonical = payloadBytes.toString('utf8');
      provided = Buffer.from(signaturePart, 'base64url');
      if (
        payloadBytes.toString('base64url') !== payloadPart ||
        provided.toString('base64url') !== signaturePart
      ) {
        throw new AttendanceOfflinePackageTokenInvalidError();
      }
    } catch {
      throw new AttendanceOfflinePackageTokenInvalidError();
    }
    const expected = createHmac(
      'sha256',
      deriveKey(this.jwtSecret, ATTENDANCE_OFFLINE_PACKAGE_TOKEN_CONTEXT),
    )
      .update(canonical, 'utf8')
      .digest();
    if (!safeEqual(provided, expected)) throw new AttendanceOfflinePackageTokenInvalidError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonical);
    } catch {
      throw new AttendanceOfflinePackageTokenInvalidError();
    }
    if (
      !isPackagePayload(parsed) ||
      canonicalizeAttendanceOfflinePackagePayload(parsed) !== canonical
    ) {
      throw new AttendanceOfflinePackageTokenInvalidError();
    }
    return parsed;
  }

  digest(token: string): string {
    return sha256(token);
  }
}
