import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

// ActivityRegistration 状态机(纯决策类,单一职责)。
// 沿 PR #196 characterization 锁定的现状行为,从 `ActivityRegistrationsService` 中
// 极小抽出(仅"搬家",不动业务行为);不持有任何依赖,不接触 DB / audit / event / DTO。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 给定 action + 当前 statusCode → 返回 decision(allowed + nextStatusCode | biz)
// - ❌ 不写 DB / 不写 audit / 不抛异常(由调用方根据 decision 抛 BizException)
// - ❌ 不接触 capacity / uniqueness / ownership / activity status
// - ❌ 不接触 reviewer / reviewedAt / reviewNote / cancelledAt / cancelledByUserId / cancelReason
// - ❌ 不接触 cancelledByPath(`admin` vs `self`;由 service 层根据调用入口写)
//
// **action 语义(对应 PR #196 characterization cases)**:
// - approve:      pending → pass(其他态拒;沿 PR #196 A1 + A2 ×3)
// - reject:       pending → reject(其他态拒;沿 PR #196 B1 + B2 ×3)
// - cancel:       pending|pass → cancelled(reject/cancelled/其他态拒;沿 PR #196 C1+C2+C3 ×2 + D1+D2+D3 ×2)
//   注:`cancelAdmin` 与 `cancelMy` 共用同一 `cancel` action;路径差异(admin vs self)由调用方
//      service 通过 `auditLogs.log` extra.cancelledByPath 字段记录,**不进** StateMachine。
//
// 错误码统一沿现状:wrong state → `BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID`(沿 PR #196 全部
// wrong-state cases:approve A2 / reject B2 / cancelAdmin C3 / cancelMy D3)。

export const ACTIVITY_REGISTRATION_STATUS = {
  PENDING: 'pending',
  PASS: 'pass',
  REJECT: 'reject',
  CANCELLED: 'cancelled',
} as const;

export type ActivityRegistrationStatusCode =
  (typeof ACTIVITY_REGISTRATION_STATUS)[keyof typeof ACTIVITY_REGISTRATION_STATUS];

export const ACTIVITY_REGISTRATION_TRANSITION_ACTIONS = ['approve', 'reject', 'cancel'] as const;

export type ActivityRegistrationTransitionAction =
  (typeof ACTIVITY_REGISTRATION_TRANSITION_ACTIONS)[number];

export type ActivityRegistrationTransitionDecision =
  | { allowed: true; nextStatusCode: ActivityRegistrationStatusCode }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class ActivityRegistrationStateMachine {
  decide(
    action: ActivityRegistrationTransitionAction,
    currentStatusCode: string,
  ): ActivityRegistrationTransitionDecision {
    switch (action) {
      case 'approve':
        if (currentStatusCode === ACTIVITY_REGISTRATION_STATUS.PENDING) {
          return { allowed: true, nextStatusCode: ACTIVITY_REGISTRATION_STATUS.PASS };
        }
        return { allowed: false, biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID };
      case 'reject':
        if (currentStatusCode === ACTIVITY_REGISTRATION_STATUS.PENDING) {
          return { allowed: true, nextStatusCode: ACTIVITY_REGISTRATION_STATUS.REJECT };
        }
        return { allowed: false, biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID };
      case 'cancel':
        if (
          currentStatusCode === ACTIVITY_REGISTRATION_STATUS.PENDING ||
          currentStatusCode === ACTIVITY_REGISTRATION_STATUS.PASS
        ) {
          return { allowed: true, nextStatusCode: ACTIVITY_REGISTRATION_STATUS.CANCELLED };
        }
        return { allowed: false, biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID };
    }
  }
}
