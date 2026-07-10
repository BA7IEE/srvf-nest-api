import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

// Activity lifecycle 状态机(纯决策类,单一职责)。
// 沿 PR #199 characterization tests 锁定的现状行为,从 `ActivitiesService` 中
// 极小抽出(仅"搬家",不动业务行为);不持有任何依赖,不接触 DB / audit / event / DTO。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 给定 action + 当前 statusCode → 返回 decision(allowed + nextStatusCode | biz)
// - ❌ 不写 DB / 不写 audit / 不抛异常(由调用方根据 decision 抛 BizException)
// - ❌ 不接触 dictionary / organization / start-end / Q-A12 之外的业务校验
// - ⚠️ `completed` 推进有**两条并存通路**(v0.40.0 参与域生命周期收口③起):
//      ① `attendances.service.submit` 首张 sheet 提交时**直写** statusCode='completed'
//         (沿 `attendance-audit-recorder.ts` `activityPushedToCompleted`,**不经本状态机**,
//         attendances.service.ts:571-577 零 diff);
//      ② 管理端 `complete` 端点**经本状态机**(published → completed;v0.40.0 新增)。
//      两者语义等价(published → completed 单向),并存不冲突。
//
// **action 语义(对应 PR #199 characterization cases + v0.40.0 complete)**:
// - create:  → draft(initial;沿 service create 路径初始状态)
// - update:  cancelled → 拒(Q-A12,沿 PR #199 C2);其他态允许 + **不**改 statusCode
//            (沿 service line 437 + PR #199 C1 ×3 锁 draft/published/completed update OK;
//             nextStatusCode echo currentStatusCode 仅为类型完整,service 不使用 update 的 nextStatusCode)
// - publish:  draft → published;其他态拒(沿 service line 573 + PR #199 A1 / A2 ×3)
// - cancel:   非 cancelled → cancelled;cancelled 拒重复(沿 service line 620 + PR #199 B1 ×3 / B2)
// - complete: published → completed(v0.40.0 管理端手动完结;其他态拒)
//
// 错误码统一沿现状:wrong state → `BizCode.ACTIVITY_STATUS_INVALID`
// (沿 PR #199 A2 / B2 / C2 全部 wrong-state cases 锁定 + v0.40.0 complete)。
//
// 与 `attendance-sheet-state-machine.ts` (PR #183) + `activity-registration-state-machine.ts`
// (PR #197) 范式一致:仅 `decide(action, currentStatusCode?)` 一个公开方法;
// `allowed: true` 总是带 `nextStatusCode`(update echo currentStatusCode,沿 attendance edit
// on PENDING 返回 nextStatusCode=PENDING 的同等范式),避免调用方 `!` 非空断言。

export const ACTIVITY_STATE_ACTIONS = [
  'create',
  'update',
  'publish',
  'cancel',
  'complete',
] as const;

export type ActivityStateAction = (typeof ACTIVITY_STATE_ACTIONS)[number];

export type ActivityStateDecision =
  | { allowed: true; nextStatusCode: string }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class ActivityStateMachine {
  decide(action: ActivityStateAction, currentStatusCode = ''): ActivityStateDecision {
    switch (action) {
      case 'create':
        return { allowed: true, nextStatusCode: 'draft' };
      case 'update':
        if (currentStatusCode === 'cancelled') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: currentStatusCode };
      case 'publish':
        if (currentStatusCode !== 'draft') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'published' };
      case 'cancel':
        if (currentStatusCode === 'cancelled') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'cancelled' };
      case 'complete':
        // v0.40.0 参与域生命周期收口③:管理端手动完结,仅 published → completed;其他态拒。
        if (currentStatusCode !== 'published') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'completed' };
    }
  }
}
