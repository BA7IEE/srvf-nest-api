import { MembershipStatus } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { MembershipTermStateMachine } from './membership-term-state-machine';

describe('MembershipTermStateMachine', () => {
  const startedAt = new Date('2026-07-18T00:00:00.000Z');

  it('拒绝 endedAt 早于 startedAt', () => {
    expect(() =>
      MembershipTermStateMachine.assertValid({
        status: MembershipStatus.ACTIVE,
        startedAt,
        endedAt: new Date('2026-07-17T23:59:59.999Z'),
      }),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('拒绝 ENDED 却没有 endedAt', () => {
    expect(() =>
      MembershipTermStateMachine.assertValid({
        status: MembershipStatus.ENDED,
        startedAt,
        endedAt: null,
      }),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('未来任期撤销取 startedAt 为 endedAt，不制造结束早于开始', () => {
    expect(
      MembershipTermStateMachine.end(
        { status: MembershipStatus.ACTIVE, startedAt, endedAt: null },
        new Date('2026-07-17T00:00:00.000Z'),
      ),
    ).toEqual({ status: MembershipStatus.ENDED, startedAt, endedAt: startedAt });
  });

  it('仅 ACTIVE 可结束', () => {
    expect(() =>
      MembershipTermStateMachine.end(
        { status: MembershipStatus.ENDED, startedAt, endedAt: startedAt },
        new Date('2026-07-19T00:00:00.000Z'),
      ),
    ).toThrow(new BizException(BizCode.BAD_REQUEST));
  });

  it('当前有效 where 同时约束状态、软删与任期边界', () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    expect(MembershipTermStateMachine.effectiveWhere(now)).toEqual({
      deletedAt: null,
      status: MembershipStatus.ACTIVE,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: now } }],
    });
  });
});
