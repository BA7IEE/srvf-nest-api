import { Role } from '@prisma/client';

import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';

describe('ActivityRegistrationAuditRecorder canonical command audit', () => {
  it('reuses registration.create and records only revision/source/count/hash payload', async () => {
    const auditLogs = {
      log: jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined),
    };
    const recorder = new ActivityRegistrationAuditRecorder(auditLogs as never);
    const tx = {} as never;

    await recorder.logCommandCreate({
      registrationId: 'registration-1',
      actorUserId: 'user-1',
      actorRoleSnap: Role.USER,
      revision: 2,
      source: 'self',
      answerCount: 4,
      preferenceCount: 3,
      requestHash: 'a'.repeat(64),
      auditMeta: { requestId: 'request-1', ip: '127.0.0.1', ua: 'jest' },
      tx,
    });

    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'registration.create',
        resourceType: 'activity_registration',
        resourceId: 'registration-1',
        tx,
        extra: {
          revision: 2,
          source: 'self',
          answerCount: 4,
          preferenceCount: 3,
          requestHash: 'a'.repeat(64),
        },
      }),
    );
    const payload = auditLogs.log.mock.calls[0]?.[0];
    if (!payload) throw new Error('expected canonical audit payload');
    const extra = payload.extra;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error('expected canonical audit extra object');
    }
    expect(Object.keys(extra).sort()).toEqual([
      'answerCount',
      'preferenceCount',
      'requestHash',
      'revision',
      'source',
    ]);
    expect(JSON.stringify(extra)).not.toMatch(/attachmentId|token|originalName|key|url|valueText/i);
    expect(payload).not.toHaveProperty('before');
    expect(payload).not.toHaveProperty('after');
  });
});
