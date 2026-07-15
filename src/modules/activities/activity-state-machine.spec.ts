import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { ActivityStateMachine, type ActivityStateAction } from './activity-state-machine';

// ActivityStateMachine 组件级全矩阵 unit spec(B 档 test-only;沿 PR #199 characterization)。
// 行为权威仍是 activities-state-transition.e2e-spec.ts(HTTP 层真实状态流转);
// 本 spec 锁纯决策表本身:4 态 × {update, publish, cancel, complete} + create 的 16+ 判定点,
// 含两个易回归语义:
//   - update 的 nextStatusCode 仅 echo currentStatusCode(类型完整性设计,service 不消费);
//   - `completed` 只由管理端 `complete` 端点推进(published → completed)。因此本表**仅
//     `complete` 一条** action 产出 nextStatusCode='completed',
//     publish / cancel 仍绝不产出。
// wrong-state 错误码统一 ACTIVITY_STATUS_INVALID(20030;沿 PR #199 A2/B2/C2 + v0.40.0 complete)。
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

  describe('update / publish / cancel / complete × 4 态全矩阵', () => {
    type Case = [
      action: ActivityStateAction,
      current: (typeof STATUSES)[number],
      expected: ReturnType<typeof allow> | ReturnType<typeof deny>,
    ];

    const cases: Case[] = [
      // update:状态机恒放行；终态字段白名单由 service 承担
      ['update', 'draft', allow('draft')],
      ['update', 'published', allow('published')],
      ['update', 'completed', allow('completed')],
      ['update', 'cancelled', allow('cancelled')],
      // publish:仅 draft → published
      ['publish', 'draft', allow('published')],
      ['publish', 'published', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['publish', 'completed', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['publish', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      // cancel:仅 draft / published 可取消
      ['cancel', 'draft', allow('cancelled')],
      ['cancel', 'published', allow('cancelled')],
      ['cancel', 'completed', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['cancel', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      // complete(v0.40.0):仅 published → completed;其他态拒
      ['complete', 'draft', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['complete', 'published', allow('completed')],
      ['complete', 'completed', deny(BizCode.ACTIVITY_STATUS_INVALID)],
      ['complete', 'cancelled', deny(BizCode.ACTIVITY_STATUS_INVALID)],
    ];

    it.each(cases)('%s @ %s', (action, current, expected) => {
      expect(machine.decide(action, current)).toEqual(expected);
    });

    it('矩阵穷尽(4 带态 action × 4 态 = 16)', () => {
      expect(cases).toHaveLength(4 * STATUSES.length);
    });

    it('publish / cancel 无任何路径产出 completed;completed 仅由 complete 产出(published→completed)', () => {
      // update 的 echo(update@completed → 回显 'completed')不算态迁移产出,排除在外。
      // v0.40.0:complete 是唯一经本状态机产出 completed 的 action(published → completed);
      // publish / cancel 仍绝不产出 completed。
      const publishCancelNexts = cases
        .filter(([action]) => action === 'publish' || action === 'cancel')
        .map(([action, current]) => machine.decide(action, current))
        .filter((d): d is { allowed: true; nextStatusCode: string } => d.allowed)
        .map((d) => d.nextStatusCode);
      expect(publishCancelNexts.length).toBeGreaterThan(0);
      expect(publishCancelNexts).not.toContain('completed');
      // complete 正向:仅 published 起态产出 completed
      expect(machine.decide('complete', 'published')).toEqual(allow('completed'));
    });
  });
});
