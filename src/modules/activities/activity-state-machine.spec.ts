import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { ActivityStateMachine, type ActivityStateAction } from './activity-state-machine';

// ActivityStateMachine 组件级全矩阵 unit spec(B 档 test-only;沿 PR #199 characterization)。
// 行为权威仍是 activities-state-transition.e2e-spec.ts(HTTP 层真实状态流转);
// 本 spec 锁纯决策表本身:4 态 × {update, publish, cancel} + create 的 12+ 判定点,
// 含两个易回归语义:
//   - update 的 nextStatusCode 仅 echo currentStatusCode(类型完整性设计,service 不消费);
//   - `completed` 推进**不在**本状态机闭集内(由 attendances.submit 跨模块推动,D11 / D-S10),
//     因此本表没有任何 action 产出 nextStatusCode='completed'。
// wrong-state 错误码统一 ACTIVITY_STATUS_INVALID(20030;沿 PR #199 A2/B2/C2)。
// 与 activities.service.spec.ts 边界互补(该 spec mock 状态机返回值,不复刻内部矩阵)。

const STATUSES = ['draft', 'published', 'completed', 'cancelled'] as const;

const allow = (nextStatusCode: string) => ({ allowed: true, nextStatusCode });
const deny = (biz: BizCodeEntry) => ({ allowed: false, biz });

describe('ActivityStateMachine', () => {
  let machine: ActivityStateMachine;

  beforeEach(() => {
    machine = new ActivityStateMachine();
  });

  describe('create(initial,不依赖 currentStatusCode)', () => {
    it('缺省参数(service create 路径)→ draft', () => {
      expect(machine.decide('create')).toEqual(allow('draft'));
    });

    it.each(STATUSES)('current=%s 时也恒为 draft(create 无视当前态)', (current) => {
      expect(machine.decide('create', current)).toEqual(allow('draft'));
    });
  });

  describe('update / publish / cancel × 4 态全矩阵', () => {
    type Case = [
      action: ActivityStateAction,
      current: (typeof STATUSES)[number],
      expected: ReturnType<typeof allow> | ReturnType<typeof deny>,
    ];

    const cases: Case[] = [
      // update:仅 cancelled 拒(Q-A12);允许时 echo current,不产生态迁移
      ['update', 'draft', allow('draft')],
      ['update', 'published', allow('published')],
      ['update', 'completed', allow('completed')],
      ['update', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      // publish:仅 draft → published
      ['publish', 'draft', allow('published')],
      ['publish', 'published', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['publish', 'completed', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['publish', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      // cancel:非 cancelled 均可 → cancelled;cancelled 拒重复
      ['cancel', 'draft', allow('cancelled')],
      ['cancel', 'published', allow('cancelled')],
      ['cancel', 'completed', allow('cancelled')],
      ['cancel', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
    ];

    it.each(cases)('%s @ %s', (action, current, expected) => {
      expect(machine.decide(action, current)).toEqual(expected);
    });

    it('矩阵穷尽(3 带态 action × 4 态 = 12)', () => {
      expect(cases).toHaveLength(3 * STATUSES.length);
    });

    it('态迁移 action(publish / cancel)无任何路径产出 completed(推进权在 attendances 模块)', () => {
      // update 的 echo(update@completed → 回显 'completed')不算态迁移产出,排除在外。
      const transitionNexts = cases
        .filter(([action]) => action !== 'update')
        .map(([action, current]) => machine.decide(action, current))
        .filter((d): d is { allowed: true; nextStatusCode: string } => d.allowed)
        .map((d) => d.nextStatusCode);
      expect(transitionNexts.length).toBeGreaterThan(0);
      expect(transitionNexts).not.toContain('completed');
    });
  });
});
