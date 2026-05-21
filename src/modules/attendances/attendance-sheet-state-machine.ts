import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { ATTENDANCE_SHEET_STATUS } from './attendances.dto';

// V2 第一阶段批次 3B / 4-B AttendanceSheet 状态机(纯决策类,单一职责)。
// 沿 PR #176 / PR #181 / PR #182 characterization 锁定的现状行为,从 `AttendancesService` 中
// 极小抽出(仅"搬家",不动业务行为);不持有任何依赖,不接触 DB / audit / event / DTO。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 给定 action + 当前 statusCode → 返回 decision(allowed + nextStatusCode | biz)
// - ❌ 不写 DB / 不写 audit / 不抛异常(由调用方根据 decision 抛 BizException)
// - ❌ 不接触 Activity status / Contribution / TimeOverlap / DTO presenter
// - ❌ 不接触 previousSnapshot / version / records cascade

export const ATTENDANCE_SHEET_TRANSITION_ACTIONS = [
  'edit',
  'softDelete',
  'approve',
  'reject',
  'finalApprove',
  'finalReject',
] as const;

export type AttendanceSheetTransitionAction = (typeof ATTENDANCE_SHEET_TRANSITION_ACTIONS)[number];

export type AttendanceSheetStatusCode =
  | typeof ATTENDANCE_SHEET_STATUS.PENDING
  | typeof ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW
  | typeof ATTENDANCE_SHEET_STATUS.APPROVED
  | typeof ATTENDANCE_SHEET_STATUS.REJECTED
  | typeof ATTENDANCE_SHEET_STATUS.FINAL_REJECTED;

export type AttendanceSheetTransitionDecision =
  | { allowed: true; nextStatusCode: AttendanceSheetStatusCode }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class AttendanceSheetStateMachine {
  decide(
    action: AttendanceSheetTransitionAction,
    currentStatusCode: string,
  ): AttendanceSheetTransitionDecision {
    switch (action) {
      case 'edit':
      case 'softDelete':
        return this.rejectEditLike(currentStatusCode);
      case 'approve':
        if (currentStatusCode === ATTENDANCE_SHEET_STATUS.PENDING) {
          return { allowed: true, nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW };
        }
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID };
      case 'reject':
        if (currentStatusCode === ATTENDANCE_SHEET_STATUS.PENDING) {
          return { allowed: true, nextStatusCode: ATTENDANCE_SHEET_STATUS.REJECTED };
        }
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID };
      case 'finalApprove':
        if (currentStatusCode === ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW) {
          return { allowed: true, nextStatusCode: ATTENDANCE_SHEET_STATUS.APPROVED };
        }
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID };
      case 'finalReject':
        if (currentStatusCode === ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW) {
          return { allowed: true, nextStatusCode: ATTENDANCE_SHEET_STATUS.FINAL_REJECTED };
        }
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID };
    }
  }

  private rejectEditLike(currentStatusCode: string): AttendanceSheetTransitionDecision {
    switch (currentStatusCode) {
      case ATTENDANCE_SHEET_STATUS.PENDING:
        return { allowed: true, nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING };
      case ATTENDANCE_SHEET_STATUS.APPROVED:
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE };
      case ATTENDANCE_SHEET_STATUS.REJECTED:
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE };
      case ATTENDANCE_SHEET_STATUS.FINAL_REJECTED:
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE };
      case ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW:
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID };
      default:
        return { allowed: false, biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID };
    }
  }
}
