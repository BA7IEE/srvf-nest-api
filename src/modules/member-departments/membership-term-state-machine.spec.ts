import { MembershipStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { MembershipTermStateMachine } from './membership-term-state-machine';

describe('MembershipTermStateMachine', () => {
  const startedAt = new Date('2026-07-18T00:00:00.000Z');
  const now = new Date('2026-07-18T12:00:00.000Z');

  it('拒绝 ACTIVE 携带任意 endedAt，防止过期后仍占 partial-unique 槽位', () => {
    expect(() =>
      MembershipTermStateMachine.assertValid(
        { status: MembershipStatus.ACTIVE, startedAt, endedAt: now },
        now,
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('拒绝尚未开始的 ACTIVE 任期', () => {
    expect(() =>
      MembershipTermStateMachine.assertValid(
        {
          status: MembershipStatus.ACTIVE,
          startedAt: new Date('2026-07-19T00:00:00.000Z'),
          endedAt: null,
        },
        now,
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('拒绝 ENDED 缺时间、结束早于开始或结束晚于当前时刻', () => {
    for (const endedAt of [
      null,
      new Date('2026-07-17T23:59:59.999Z'),
      new Date('2026-07-19T00:00:00.000Z'),
    ]) {
      expect(() =>
        MembershipTermStateMachine.assertValid(
          { status: MembershipStatus.ENDED, startedAt, endedAt },
          now,
        ),
      ).toThrow(new BizException(BizCode.BAD_REQUEST));
    }
  });

  it('SUSPENDED 不接受 endedAt', () => {
    expect(() =>
      MembershipTermStateMachine.assertValid(
        { status: MembershipStatus.SUSPENDED, startedAt, endedAt: now },
        now,
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('ACTIVE → ENDED 使用真实当前时刻并释放 ACTIVE 槽位', () => {
    expect(
      MembershipTermStateMachine.end(
        { status: MembershipStatus.ACTIVE, startedAt, endedAt: null },
        now,
      ),
    ).toEqual({ status: MembershipStatus.ENDED, startedAt, endedAt: now });
  });

  it('拒绝非 ACTIVE 或尚未开始的任期结束', () => {
    expect(() =>
      MembershipTermStateMachine.end(
        { status: MembershipStatus.ENDED, startedAt, endedAt: startedAt },
        now,
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
    expect(() =>
      MembershipTermStateMachine.end(
        {
          status: MembershipStatus.ACTIVE,
          startedAt: new Date('2026-07-19T00:00:00.000Z'),
          endedAt: null,
        },
        now,
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('当前有效 where 同时约束状态、软删与任期边界', () => {
    expect(MembershipTermStateMachine.effectiveWhere(now)).toEqual({
      deletedAt: null,
      status: MembershipStatus.ACTIVE,
      startedAt: { lte: now },
      endedAt: null,
    });
  });
});
