import { Role } from '@prisma/client';
import { ActivityTimeAllocationAuditRecorder } from './activity-time-allocation-audit-recorder';

describe('D3 time-allocation audit recorder', () => {
  it('writes the one approved event with only safe recognition summary fields', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const recorder = new ActivityTimeAllocationAuditRecorder(audit as never);
    const tx = {} as never;
    const result = {
      schemaVersion: 1 as const,
      activityId: 'activity',
      allocationRevisionId: 'allocation',
      revision: 2,
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 3,
      recognitionModeCode: 'manual' as const,
      allocationHash: 'a'.repeat(64),
      sliceCount: 2,
      evidenceCount: 1,
      createdAt: '2026-09-12T08:00:00.000Z',
    };

    await recorder.log(
      tx,
      { id: 'actor', username: 'actor', role: Role.USER, status: 'ACTIVE', memberId: 'member' },
      { requestId: 'request', ip: null, ua: null },
      result,
    );

    expect(audit.log).toHaveBeenCalledWith({
      event: 'activity.time-allocation.command',
      actorUserId: 'actor',
      actorRoleSnap: Role.USER,
      resourceType: 'activity',
      resourceId: 'activity',
      tx,
      meta: { requestId: 'request', ip: null, ua: null },
      extra: {
        allocationRevisionId: 'allocation',
        revision: 2,
        sourceSegmentId: 'segment',
        sourceSegmentRevision: 3,
        recognitionModeCode: 'manual',
        sliceCount: 2,
        evidenceCount: 1,
      },
    });
    const [logged] = (audit.log.mock.calls as unknown as Array<[Record<string, unknown>]>)[0];
    expect(JSON.stringify(logged)).not.toContain('operationKey');
    expect(JSON.stringify(logged)).not.toContain('requestHash');
  });
});
