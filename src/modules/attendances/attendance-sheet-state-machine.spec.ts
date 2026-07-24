import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { ATTENDANCE_SHEET_STATUS } from './attendances.dto';
import {
  ATTENDANCE_SHEET_TRANSITION_ACTIONS,
  AttendanceSheetStateMachine,
  type AttendanceSheetTransitionAction,
} from './attendance-sheet-state-machine';

// PR-8 returned 闭环全矩阵：6 态 × 10 action + 未知态 × 10 = 70 判定点。
const { PENDING, PENDING_FINAL_REVIEW, RETURNED, APPROVED, REJECTED, FINAL_REJECTED } =
  ATTENDANCE_SHEET_STATUS;
const STATUSES = [
  PENDING,
  PENDING_FINAL_REVIEW,
  RETURNED,
  APPROVED,
  REJECTED,
  FINAL_REJECTED,
] as const;
const UNKNOWN = 'garbage';

const allow = (nextStatusCode: string) => ({ allowed: true, nextStatusCode });
const deny = (biz: BizCodeEntry) => ({ allowed: false, biz });

function nonEditableBiz(status: string): BizCodeEntry {
  switch (status) {
    case APPROVED:
      return BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE;
    case REJECTED:
      return BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE;
    case FINAL_REJECTED:
      return BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE;
    default:
      return BizCode.ATTENDANCE_SHEET_STATUS_INVALID;
  }
}

function expected(action: AttendanceSheetTransitionAction, status: string) {
  switch (action) {
    case 'edit':
      return status === PENDING || status === RETURNED
        ? allow(status)
        : deny(nonEditableBiz(status));
    case 'softDelete':
      return status === PENDING ? allow(PENDING) : deny(nonEditableBiz(status));
    case 'approve':
      return status === PENDING
        ? allow(PENDING_FINAL_REVIEW)
        : deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    case 'firstReturn':
      return status === PENDING ? allow(RETURNED) : deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    case 'reject':
      return status === PENDING ? allow(REJECTED) : deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    case 'finalApprove':
      return status === PENDING_FINAL_REVIEW
        ? allow(APPROVED)
        : deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    case 'finalReturn':
      return status === PENDING_FINAL_REVIEW
        ? allow(RETURNED)
        : deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    case 'finalReject':
      return status === PENDING_FINAL_REVIEW
        ? allow(FINAL_REJECTED)
        : deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    case 'resubmit':
      return status === RETURNED
        ? allow(PENDING)
        : deny(BizCode.ATTENDANCE_SHEET_RESUBMIT_STATUS_INVALID);
    case 'reopen':
      return status === APPROVED ? allow(PENDING) : deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
  }
}

describe('AttendanceSheetStateMachine', () => {
  const machine = new AttendanceSheetStateMachine();
  const cases = ATTENDANCE_SHEET_TRANSITION_ACTIONS.flatMap((action) =>
    [...STATUSES, UNKNOWN].map((status) => [action, status, expected(action, status)] as const),
  );

  it.each(cases)('%s @ %s', (action, current, decision) => {
    expect(machine.decide(action, current)).toEqual(decision);
  });

  it('矩阵穷尽(10 action × (6 态 + 未知态) = 70)', () => {
    expect(cases).toHaveLength(10 * (STATUSES.length + 1));
  });

  it('returned 只可编辑或重提；记录不被删除的语义由 service/e2e 锁定', () => {
    const allowed = ATTENDANCE_SHEET_TRANSITION_ACTIONS.filter(
      (action) => machine.decide(action, RETURNED).allowed,
    );
    expect(allowed).toEqual(['edit', 'resubmit']);
  });

  it('唯一可达 approved 的路径是 finalApprove @ pending_final_review', () => {
    const reachApproved = cases
      .filter(([action, current]) => {
        const decision = machine.decide(action, current);
        return decision.allowed && decision.nextStatusCode === APPROVED;
      })
      .map(([action, current]) => `${action}@${current}`);
    expect(reachApproved).toEqual([`finalApprove@${PENDING_FINAL_REVIEW}`]);
  });
});
