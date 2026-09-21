import { Role, UserStatus, type ActivityTimeCutoverReceipt } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
  activityTimeCutoverReceiptHash,
  normalizeActivityTimeCutoverRequest,
} from './activity-time-cutover-command';
import { ActivityTimeCutoverService } from './activity-time-cutover.service';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const request = {
  operationKey: 'cutover-operation',
  deployedMainSha: 'a'.repeat(40),
  evidenceBundleHash: 'b'.repeat(64),
};

function storedReceipt(): ActivityTimeCutoverReceipt {
  const normalized = normalizeActivityTimeCutoverRequest(actor.id, request);
  const row = {
    id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
    operationKey: normalized.operationKey,
    requestHash: normalized.requestHash,
    deployedMainSha: normalized.deployedMainSha,
    evidenceBundleHash: normalized.evidenceBundleHash,
    actorUserId: actor.id,
    cutoverAt: new Date('2026-09-21T10:00:00.000Z'),
    formatVersion: 1,
    contentHash: '',
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
  };
  return { ...row, contentHash: activityTimeCutoverReceiptHash(row) };
}

describe('D8-1 cutover service', () => {
  function fixture(prior: ActivityTimeCutoverReceipt | null) {
    const receipt = storedReceipt();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([receipt]),
      activityTimeCutoverReceipt: { findUnique: jest.fn().mockResolvedValue(prior) },
    };
    const prisma = {
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    };
    const gate = {
      isV11Enabled: jest.fn().mockReturnValue(true),
      isReadonlyMaintenance: jest.fn().mockReturnValue(true),
    };
    const command = { lockAndAuthorize: jest.fn().mockResolvedValue(actor) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      receipt,
      tx,
      gate,
      command,
      audit,
      service: new ActivityTimeCutoverService(
        prisma as never,
        gate as never,
        command as never,
        audit as never,
      ),
    };
  }

  it('creates one DB-clock receipt and audits only the first success', async () => {
    const f = fixture(null);
    await expect(
      f.service.execute({
        currentUser: actor,
        request,
        auditMeta: { requestId: 'request', ip: null, ua: null },
      }),
    ).resolves.toMatchObject({ id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID, replayed: false });
    expect(f.command.lockAndAuthorize).toHaveBeenCalledWith(f.tx, actor);
    expect(f.audit.log).toHaveBeenCalledTimes(1);
  });

  it('returns an exact replay without a second insert or audit', async () => {
    const prior = storedReceipt();
    const f = fixture(prior);
    const result = await f.service.execute({
      currentUser: actor,
      request,
      auditMeta: { requestId: 'request', ip: null, ua: null },
    });
    expect(result.replayed).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.audit.log).not.toHaveBeenCalled();
  });

  it('rejects execute unless both the v1.1 and readonly facts are true', async () => {
    const f = fixture(null);
    f.gate.isReadonlyMaintenance.mockReturnValue(false);
    await expect(
      f.service.execute({
        currentUser: actor,
        request,
        auditMeta: { requestId: 'request', ip: null, ua: null },
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_CUTOVER_NOT_READY });
    expect(f.command.lockAndAuthorize).not.toHaveBeenCalled();
  });

  it('rejects reuse of the singleton by another request', async () => {
    const f = fixture({ ...storedReceipt(), operationKey: 'other' });
    await expect(
      f.service.execute({
        currentUser: actor,
        request,
        auditMeta: { requestId: 'request', ip: null, ua: null },
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_CUTOVER_COMMAND_CONFLICT });
  });
});
