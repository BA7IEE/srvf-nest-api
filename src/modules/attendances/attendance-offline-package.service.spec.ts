import { Role, UserStatus } from '@prisma/client';

import type { PrismaService } from '../../database/prisma.service';
import type { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import type { AttendanceOfflinePackageTokenService } from './attendance-offline-package-token';
import { AttendanceOfflinePackageService } from './attendance-offline-package.service';
import type { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import type { AttendancePunchCommandService } from './attendance-punch-command.service';

describe('AttendanceOfflinePackageService fail-closed token boundary', () => {
  const currentUser = {
    id: 'user-manager',
    username: 'manager',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member-manager',
  };
  const input = {
    activityId: 'activity-1',
    packageId: 'package-1',
    packageToken: 'raw-package-token',
    sequence: 1,
    priorHash: '1'.repeat(64),
    eventKey: 'event-1',
    actionCode: 'check_in' as const,
    deviceTime: new Date('2099-08-17T01:00:00.000Z'),
    memberCredential: 'raw-member-credential',
    longitude: null,
    latitude: null,
    accuracy: null,
    signature: 'raw-event-signature',
  };
  const auditMeta = { requestId: 'request-1', ip: null, ua: null };
  const validFrom = new Date('2099-08-17T00:00:00.000Z');
  const validUntil = new Date('2099-08-17T02:00:00.000Z');
  const uploadUntil = new Date('2099-08-18T02:00:00.000Z');
  const packagePayload = {
    v: 1 as const,
    purpose: 'attendance-offline-package' as const,
    packageId: input.packageId,
    activityId: input.activityId,
    sessionId: 'session-1',
    operatorUserId: currentUser.id,
    operatorMemberId: currentUser.memberId,
    deviceId: 'device-1',
    packageVersion: 1,
    packageKeyVersion: 0,
    validFrom: validFrom.toISOString(),
    validUntil: validUntil.toISOString(),
    uploadUntil: uploadUntil.toISOString(),
    sequenceStart: 1,
    chainAnchorHash: input.priorHash,
    ruleSnapshotHash: '2'.repeat(64),
    workflowRevision: 1,
    participantSnapshotHash: '3'.repeat(64),
  };
  const packageRow = {
    id: input.packageId,
    activityId: input.activityId,
    sessionId: packagePayload.sessionId,
    operatorUserId: currentUser.id,
    operatorMemberId: currentUser.memberId,
    deviceId: packagePayload.deviceId,
    packageVersion: 1,
    packageKeyVersion: 0,
    statusCode: 'active',
    tokenDigest: 'token-digest',
    ruleSnapshotId: 'rule-snapshot-1',
    ruleSnapshotHash: packagePayload.ruleSnapshotHash,
    workflowRevision: 1,
    participantSnapshotHash: packagePayload.participantSnapshotHash,
    validFrom,
    validUntil,
    uploadUntil,
    sequenceStart: 1,
    nextExpectedSequence: 1,
    chainAnchorHash: input.priorHash,
    lastAcceptedHash: input.priorHash,
    lastAcceptedAt: null,
    issuedAt: validFrom,
    issueOperationKey: 'issue-1',
    issueRequestHash: '4'.repeat(64),
    revokedByUserId: null,
    revokedAt: null,
    revokeReason: null,
    revokeOperationKey: null,
    revokeRequestHash: null,
  };

  function makeService(
    overrides: {
      verifyPackage?: jest.Mock;
      verifyMember?: jest.Mock;
    } = {},
  ) {
    const mutation = jest.fn();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: input.activityId, statusCode: 'published' }])
      .mockResolvedValueOnce([{ id: 'responsibility-1' }])
      .mockResolvedValueOnce([{ id: input.packageId }]);
    const findPackage = jest.fn(() => Promise.resolve(packageRow));
    const tx = {
      $queryRaw: queryRaw,
      offlinePackage: { findFirst: findPackage, update: mutation },
      offlinePunchReviewItem: { create: mutation },
      attendancePunchEvent: { create: mutation },
    };
    const transaction = jest.fn((run: (value: typeof tx) => unknown) => Promise.resolve(run(tx)));
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    const packageTokens = {
      verify:
        overrides.verifyPackage ??
        jest.fn(() => {
          throw new Error('bad package');
        }),
      digest: jest.fn(() => packageRow.tokenDigest),
    } as unknown as AttendanceOfflinePackageTokenService;
    const verifyMember = overrides.verifyMember ?? jest.fn();
    const memberCredentials = {
      verifyAt: verifyMember,
    } as unknown as AttendanceMemberCredentialService;
    const service = new AttendanceOfflinePackageService(
      prisma,
      packageTokens,
      memberCredentials,
      { offlinePunchWithinTransaction: mutation } as unknown as AttendancePunchCommandService,
      { logOffline: mutation } as unknown as AttendancePunchAuditRecorder,
    );
    return { service, transaction, queryRaw, findPackage, mutation, verifyMember };
  }

  it('authorizes and locks the package before mapping a forged token to 22097 without mutation', async () => {
    const { service, transaction, queryRaw, findPackage, mutation, verifyMember } = makeService();

    await expect(service.upload(input, currentUser, auditMeta)).rejects.toMatchObject({
      biz: { code: 22097 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(findPackage).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
    expect(verifyMember).not.toHaveBeenCalled();
  });

  it('maps an unverifiable 60-second credential to 22097 after read-only authorization', async () => {
    const { service, transaction, queryRaw, findPackage, mutation, verifyMember } = makeService({
      verifyPackage: jest.fn(() => packagePayload),
      verifyMember: jest.fn(() => {
        throw new Error('bad member credential');
      }),
    });

    await expect(service.upload(input, currentUser, auditMeta)).rejects.toMatchObject({
      biz: { code: 22097 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(findPackage).toHaveBeenCalledTimes(1);
    expect(verifyMember).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
  });
});
