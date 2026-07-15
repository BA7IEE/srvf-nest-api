import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import {
  ACTIVITY_REGISTRATION_STATUS,
  ActivityRegistrationStateMachine,
  type ActivityRegistrationTransitionAction,
} from './activity-registration-state-machine';

// ActivityRegistrationStateMachine 组件级全矩阵 unit spec(B 档 test-only;沿 PR #196 characterization)。
// 行为权威仍是 activity-registrations-state-transition.e2e-spec.ts(HTTP 层真实状态流转);
// 本 spec 锁纯决策表本身:5 态 × 5 action = 25 判定点全矩阵,含四个易回归语义:
//   - cancel 在 pass 之后及候补中仍允许(pending|pass|waitlisted → cancelled);
//   - cancelAdmin / cancelMy 共用同一 cancel action(路径差异走 audit extra.cancelledByPath,
//     不进状态机——本表对二者天然同判)。
//   - reopen 仅 reject → pending(v0.40.0 审批后悔药;刻意不开 reject → pass 直通)。
//   - promote 仅 waitlisted → pending(内部递补;刻意不开 waitlisted → pass 直通)。
// wrong-state 错误码统一 ACTIVITY_REGISTRATION_STATUS_INVALID(21030;沿 PR #196 A2/B2/C3/D3 + v0.40.0 reopen)。
// 与 activity-registrations.service.spec.ts 边界互补(该 spec mock 状态机返回值,不复刻内部矩阵)。

const { PENDING, PASS, REJECT, CANCELLED, WAITLISTED } = ACTIVITY_REGISTRATION_STATUS;
const STATUSES = [PENDING, PASS, REJECT, CANCELLED, WAITLISTED] as const;

const allow = (nextStatusCode: string) => ({ allowed: true, nextStatusCode });
const deny = (biz: BizCodeEntry) => ({ allowed: false, biz });

describe('ActivityRegistrationStateMachine', () => {
  let machine: ActivityRegistrationStateMachine;

  beforeEach(() => {
    machine = new ActivityRegistrationStateMachine();
  });

  type Case = [
    action: ActivityRegistrationTransitionAction,
    current: (typeof STATUSES)[number],
    expected: ReturnType<typeof allow> | ReturnType<typeof deny>,
  ];

  const cases: Case[] = [
    // approve:仅 pending → pass
    ['approve', PENDING, allow(PASS)],
    ['approve', PASS, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['approve', REJECT, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['approve', CANCELLED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['approve', WAITLISTED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    // reject:pending|waitlisted → reject
    ['reject', PENDING, allow(REJECT)],
    ['reject', PASS, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reject', REJECT, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reject', CANCELLED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reject', WAITLISTED, allow(REJECT)],
    // cancel:pending|pass|waitlisted → cancelled;reject / cancelled 拒
    ['cancel', PENDING, allow(CANCELLED)],
    ['cancel', PASS, allow(CANCELLED)],
    ['cancel', REJECT, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['cancel', CANCELLED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['cancel', WAITLISTED, allow(CANCELLED)],
    // reopen:仅 reject → pending(v0.40.0 审批后悔药);pending / pass / cancelled 拒
    ['reopen', PENDING, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reopen', PASS, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reopen', REJECT, allow(PENDING)],
    ['reopen', CANCELLED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['reopen', WAITLISTED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    // promote:仅 waitlisted → pending；其余态拒
    ['promote', PENDING, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['promote', PASS, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['promote', REJECT, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['promote', CANCELLED, deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID)],
    ['promote', WAITLISTED, allow(PENDING)],
  ];

  it.each(cases)('%s @ %s', (action, current, expected) => {
    expect(machine.decide(action, current)).toEqual(expected);
  });

  it('矩阵穷尽(5 action × 5 态 = 25)', () => {
    expect(cases).toHaveLength(5 * STATUSES.length);
  });

  it('未知状态串对任何 action 均拒(防脏数据放行)', () => {
    for (const action of ['approve', 'reject', 'cancel', 'reopen', 'promote'] as const) {
      expect(machine.decide(action, 'garbage')).toEqual(
        deny(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID),
      );
    }
  });
});
