import { ConfigService } from '@nestjs/config';

import {
  AttendanceOfflinePackageTokenInvalidError,
  AttendanceOfflinePackageTokenService,
  signAttendanceOfflineEvent,
  verifyAttendanceOfflineEvent,
  type AttendanceOfflinePackageTokenPayload,
} from './attendance-offline-package-token';

const payload: AttendanceOfflinePackageTokenPayload = {
  v: 1,
  purpose: 'attendance-offline-package',
  packageId: 'offline-package-1',
  activityId: 'activity-1',
  sessionId: 'session-1',
  operatorUserId: 'user-1',
  operatorMemberId: 'member-1',
  deviceId: 'device-1',
  packageVersion: 1,
  packageKeyVersion: 0,
  validFrom: '2099-08-17T01:00:00.000Z',
  validUntil: '2099-08-17T02:00:00.000Z',
  uploadUntil: '2099-08-18T02:00:00.000Z',
  sequenceStart: 1,
  chainAnchorHash: '1'.repeat(64),
  ruleSnapshotHash: '2'.repeat(64),
  workflowRevision: 3,
  participantSnapshotHash: '3'.repeat(64),
};

function nonCanonicalEquivalent(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = value.at(-1);
  if (last === undefined) throw new Error('base64url fixture is empty');
  const index = alphabet.indexOf(last);
  if (index < 0) throw new Error('base64url fixture has an invalid final character');
  return `${value.slice(0, -1)}${alphabet[index ^ 1]}`;
}

describe('AttendanceOfflinePackageTokenService', () => {
  const service = new AttendanceOfflinePackageTokenService(
    new ConfigService({ jwt: { secret: 'offline-token-unit-secret' } }),
  );

  it('deterministically reconstructs the same token and verifies every frozen anchor', () => {
    const first = service.sign(payload);
    const replay = service.sign({ ...payload });

    expect(replay).toBe(first);
    expect(service.verify(first)).toEqual(payload);
    expect(service.digest(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects package-token tampering', () => {
    const token = service.sign(payload);
    const tampered = `${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}`;
    expect(() => service.verify(tampered)).toThrow(AttendanceOfflinePackageTokenInvalidError);
  });

  it('rejects a non-canonical base64url alias of the same package signature bytes', () => {
    const token = service.sign(payload);
    const [payloadPart, signaturePart] = token.split('.');
    const aliasedSignature = nonCanonicalEquivalent(signaturePart);
    expect(Buffer.from(aliasedSignature, 'base64url')).toEqual(
      Buffer.from(signaturePart, 'base64url'),
    );
    expect(() => service.verify(`${payloadPart}.${aliasedSignature}`)).toThrow(
      AttendanceOfflinePackageTokenInvalidError,
    );
  });

  it('signs the canonical event without retaining raw credentials', () => {
    const packageToken = service.sign(payload);
    const event = {
      packageId: payload.packageId,
      sequence: 1,
      priorHash: payload.chainAnchorHash,
      eventKey: 'event-1',
      actionCode: 'check_in' as const,
      deviceTime: new Date('2099-08-17T01:01:00.000Z'),
      memberCredential: 'raw-member-credential',
      longitude: 113.1234567,
      latitude: 23.1234567,
      accuracy: 8.25,
    };
    const signature = signAttendanceOfflineEvent(packageToken, event);
    const proof = verifyAttendanceOfflineEvent(packageToken, event, signature);

    expect(proof.signatureValid).toBe(true);
    expect(proof.canonicalPayload).not.toContain(event.memberCredential);
    expect(proof.eventPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(proof.chainHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      verifyAttendanceOfflineEvent(packageToken, { ...event, eventKey: 'changed' }, signature)
        .signatureValid,
    ).toBe(false);
    const aliasedSignature = nonCanonicalEquivalent(signature);
    expect(Buffer.from(aliasedSignature, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(verifyAttendanceOfflineEvent(packageToken, event, aliasedSignature).signatureValid).toBe(
      false,
    );
  });
});
