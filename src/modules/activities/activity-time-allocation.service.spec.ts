import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import type { ActivityTimeAllocationAccessService } from './activity-time-allocation-access.service';
import type { ActivityTimeAllocationAuditRecorder } from './activity-time-allocation-audit-recorder';
import {
  activityTimeAllocationRequestHash,
  parseActivityTimeAllocationCommand,
} from './activity-time-allocation-command';
import { ActivityTimeAllocationService } from './activity-time-allocation.service';

const user: CurrentUserPayload = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const input = {
  operationKey: 'allocation-operation',
  sourceSegmentId: 'segment',
  expectedRevision: 0,
  recognitionModeCode: 'automatic',
  evidenceAttachmentIds: [],
};
const meta = { requestId: 'request', ip: null, ua: null };

describe('D3 time-allocation service transaction boundary', () => {
  function fixture(receipt: Record<string, unknown> | null) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      participantTimeAllocationCommandReceipt: { findUnique: jest.fn().mockResolvedValue(receipt) },
      participantTimeAllocationRevision: { findFirst: jest.fn() },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const access = {
      authorize: jest.fn().mockResolvedValue({ actor: user, activity: { id: 'activity' } }),
    };
    const segments = {
      lockActivityForTimeAllocationWrite: jest.fn().mockResolvedValue(undefined),
      readActivityCurrentSegmentsTrusted: jest.fn().mockResolvedValue([]),
    };
    const attachments = {};
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityTimeAllocationService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityTimeAllocationAccessService,
      segments as unknown as ParticipationSegmentFacade,
      attachments as AttachmentsService,
      audit as unknown as ActivityTimeAllocationAuditRecorder,
    );
    return { tx, prisma, access, segments, attachments, audit, service };
  }

  const result = {
    schemaVersion: 1,
    activityId: 'activity',
    allocationRevisionId: 'allocation',
    revision: 1,
    sourceSegmentId: 'segment',
    sourceSegmentRevision: 1,
    recognitionModeCode: 'automatic',
    allocationHash: 'a'.repeat(64),
    sliceCount: 1,
    evidenceCount: 0,
    createdAt: '2026-09-12T08:00:00.000Z',
  } as const;

  function replayReceipt(requestHash: string) {
    return {
      requestHash,
      activityId: 'activity',
      allocationRevisionId: 'allocation',
      resultJson: result,
      allocationRevision: { id: 'allocation', activityId: 'activity', createdByUserId: 'actor' },
    };
  }

  it('replays an exact same-key/same-hash receipt after reauthorization without new writes or audit', async () => {
    const hash = activityTimeAllocationRequestHash(
      'activity',
      'actor',
      parseActivityTimeAllocationCommand(input),
    );
    const f = fixture(replayReceipt(hash));

    await expect(f.service.recognize('activity', input, user, meta)).resolves.toEqual(result);

    expect(f.access.authorize).toHaveBeenCalledTimes(3);
    expect(f.segments.lockActivityForTimeAllocationWrite).toHaveBeenCalledWith(f.tx, 'activity');
    expect(f.tx.participantTimeAllocationCommandReceipt.findUnique).toHaveBeenCalledWith({
      where: {
        actorUserId_operationCode_operationKey: {
          actorUserId: 'actor',
          operationCode: 'recognize_time_allocation',
          operationKey: 'allocation-operation',
        },
      },
      include: {
        allocationRevision: { select: { id: true, activityId: true, createdByUserId: true } },
      },
    });
    expect(f.segments.readActivityCurrentSegmentsTrusted).not.toHaveBeenCalled();
    expect(f.tx.participantTimeAllocationRevision.findFirst).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it('rejects same-key/different-payload receipt reuse without touching allocation state', async () => {
    const f = fixture(replayReceipt('b'.repeat(64)));
    await expect(f.service.recognize('activity', input, user, meta)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT),
    );
    expect(f.segments.readActivityCurrentSegmentsTrusted).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it('rejects an open or non-current source before policy lookup and leaves no allocation/receipt/audit write', async () => {
    const f = fixture(null);
    f.segments.readActivityCurrentSegmentsTrusted.mockResolvedValue([
      {
        id: 'segment',
        statusCode: 'draft',
        resultCode: 'valid',
        checkInAt: new Date('2026-09-12T08:00:00.000Z'),
        checkOutAt: null,
      },
    ]);
    await expect(f.service.recognize('activity', input, user, meta)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE),
    );
    expect(f.tx.participantTimeAllocationRevision.findFirst).not.toHaveBeenCalled();
    expect(f.audit.log).not.toHaveBeenCalled();
  });
});
