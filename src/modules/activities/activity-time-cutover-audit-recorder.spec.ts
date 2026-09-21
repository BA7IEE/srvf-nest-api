import { Role, UserStatus } from '@prisma/client';

import { ActivityTimeCutoverAuditRecorder } from './activity-time-cutover-audit-recorder';

describe('D8-1 cutover audit', () => {
  it('writes one safe event in the caller transaction', async () => {
    const log = jest
      .fn<
        Promise<void>,
        [
          {
            event: string;
            actorUserId: string;
            resourceId: string;
            tx: unknown;
            extra: Record<string, unknown>;
          },
        ]
      >()
      .mockResolvedValue(undefined);
    const recorder = new ActivityTimeCutoverAuditRecorder({ log } as never);
    const tx = {} as never;
    await recorder.log(
      tx,
      {
        id: 'actor',
        username: 'actor',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      { requestId: 'request', ip: null, ua: null },
      {
        id: 'activity-time-v1',
        operationKey: 'not-audited',
        deployedMainSha: 'a'.repeat(40),
        evidenceBundleHash: 'b'.repeat(64),
        actorUserId: 'actor',
        cutoverAt: '2026-09-21T00:00:00.000Z',
        formatVersion: 1,
        contentHash: 'c'.repeat(64),
        replayed: false,
      },
    );
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0][0];
    expect(logged).toMatchObject({
      event: 'activity.time-cutover.command',
      actorUserId: 'actor',
      resourceId: 'activity-time-v1',
      tx,
    });
    expect(logged.extra).toMatchObject({ replayed: false, result: 'committed' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /operationKey|requestHash|contentHash|password|token/i,
    );
  });
});
