import { Role, UserStatus, type ActivityTimeCutoverReceipt } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
  ActivityTimeCutoverCommand,
  activityTimeCutoverReceiptHash,
  activityTimeCutoverRequestHash,
  normalizeActivityTimeCutoverRequest,
  verifyActivityTimeCutoverReceipt,
} from './activity-time-cutover-command';

const actor = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function receipt(): ActivityTimeCutoverReceipt {
  const row = {
    id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
    operationKey: 'cutover-1',
    requestHash: '1'.repeat(64),
    deployedMainSha: '2'.repeat(40),
    evidenceBundleHash: '3'.repeat(64),
    actorUserId: actor.id,
    cutoverAt: new Date('2026-09-21T10:11:12.345Z'),
    formatVersion: 1,
    contentHash: '',
    createdAt: new Date('2026-09-21T10:11:12.345Z'),
  };
  return { ...row, contentHash: activityTimeCutoverReceiptHash(row) };
}

describe('D8-1 cutover command contract', () => {
  it('normalizes a bounded request and binds its hash to the actor and anchors', () => {
    const input = normalizeActivityTimeCutoverRequest(actor.id, {
      operationKey: 'cutover-1',
      deployedMainSha: 'a'.repeat(40),
      evidenceBundleHash: 'b'.repeat(64),
    });
    expect(input.requestHash).toBe(
      activityTimeCutoverRequestHash({
        actorUserId: actor.id,
        operationKey: 'cutover-1',
        deployedMainSha: 'a'.repeat(40),
        evidenceBundleHash: 'b'.repeat(64),
      }),
    );
    expect(input.requestHash).not.toBe(
      activityTimeCutoverRequestHash({ ...input, actorUserId: 'other' }),
    );
  });

  it.each([
    { operationKey: '', deployedMainSha: 'a'.repeat(40), evidenceBundleHash: 'b'.repeat(64) },
    { operationKey: ' x ', deployedMainSha: 'a'.repeat(40), evidenceBundleHash: 'b'.repeat(64) },
    { operationKey: 'x', deployedMainSha: 'A'.repeat(40), evidenceBundleHash: 'b'.repeat(64) },
    { operationKey: 'x', deployedMainSha: 'a'.repeat(40), evidenceBundleHash: 'b'.repeat(63) },
  ])('rejects invalid request shape %#', (request) => {
    expect(() => normalizeActivityTimeCutoverRequest(actor.id, request)).toThrow();
  });

  it('recomputes the DB receipt hash including the database clock instant', () => {
    const row = receipt();
    expect(verifyActivityTimeCutoverReceipt(row)).toMatchObject({
      id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      cutoverAt: '2026-09-21T10:11:12.345Z',
      replayed: false,
    });
    expect(() =>
      verifyActivityTimeCutoverReceipt({
        ...row,
        cutoverAt: new Date(row.cutoverAt.getTime() + 1),
      }),
    ).toThrow();
  });

  it('locks and re-reads an active actor with the explicit GLOBAL permission', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: actor.id }]),
      user: { findFirst: jest.fn().mockResolvedValue(actor) },
    };
    const rbac = {
      getUserPermissionCodes: jest
        .fn()
        .mockResolvedValue(new Set(['activity.settlement-final-review.record'])),
      can: jest.fn().mockResolvedValue(true),
    };
    const command = new ActivityTimeCutoverCommand(rbac as never);
    await expect(command.lockAndAuthorize(tx as never, actor)).resolves.toEqual(actor);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(rbac.getUserPermissionCodes).toHaveBeenCalledWith(actor.id, undefined, tx);
  });

  it('does not let an SA short circuit an absent explicit GLOBAL grant', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: actor.id }]),
      user: { findFirst: jest.fn().mockResolvedValue({ ...actor, role: Role.SUPER_ADMIN }) },
    };
    const command = new ActivityTimeCutoverCommand({
      getUserPermissionCodes: jest.fn().mockResolvedValue(new Set()),
      can: jest.fn().mockResolvedValue(true),
    } as never);
    await expect(
      command.lockAndAuthorize(tx as never, { ...actor, role: Role.SUPER_ADMIN }),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
  });
});
