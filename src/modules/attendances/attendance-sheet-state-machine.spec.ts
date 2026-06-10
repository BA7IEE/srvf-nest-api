import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { ATTENDANCE_SHEET_STATUS } from './attendances.dto';
import {
  AttendanceSheetStateMachine,
  type AttendanceSheetTransitionAction,
} from './attendance-sheet-state-machine';

// AttendanceSheetStateMachine 组件级全矩阵 unit spec(B 档 test-only;沿 PR #176/#181/#182 characterization)。
// 行为权威仍是 attendances-state-transition / attendances-reject-transition /
// attendances-status-guards e2e(HTTP 层真实状态流转);本 spec 锁纯决策表本身:
// 5 态 × 6 action = 30 判定点 + 未知态 × 6 = 36 全矩阵。
// 本状态机最有价值的锁定点是 **wrong-state 错误码三分映射**:
//   - edit/softDelete 按终态细分:approved → 22040 / rejected → 22041 / final_rejected → 22043,
//     pending_final_review 与未知态 → 22030(STATUS_INVALID);
//   - approve/reject(一审)wrong state → 22030;
//   - finalApprove/finalReject(终审)wrong state → 22045(FINAL_REVIEW_STATUS_INVALID)。
// 终审授权语义(方案 A,2026-06-10 拍板)不在状态机内:finalReviewerUserId 仅审计记录。
// 与 attendances.service.spec.ts 边界互补(该 spec mock 状态机返回值,不复刻内部矩阵)。

const { PENDING, PENDING_FINAL_REVIEW, APPROVED, REJECTED, FINAL_REJECTED } =
  ATTENDANCE_SHEET_STATUS;
const STATUSES = [PENDING, PENDING_FINAL_REVIEW, APPROVED, REJECTED, FINAL_REJECTED] as const;
const UNKNOWN = 'garbage';

const allow = (nextStatusCode: string) => ({ allowed: true, nextStatusCode });
const deny = (biz: BizCodeEntry) => ({ allowed: false, biz });

describe('AttendanceSheetStateMachine', () => {
  let machine: AttendanceSheetStateMachine;

  beforeEach(() => {
    machine = new AttendanceSheetStateMachine();
  });

  type Case = [
    action: AttendanceSheetTransitionAction,
    current: string,
    expected: ReturnType<typeof allow> | ReturnType<typeof deny>,
  ];

  // edit 与 softDelete 共用 rejectEditLike 判定:仅 pending 可改(next echo pending),
  // 已进入审阅链 / 终态后按状态细分错误码。
  const editLikeExpected: Array<[current: string, expected: Case[2]]> = [
    [PENDING, allow(PENDING)],
    [PENDING_FINAL_REVIEW, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    [APPROVED, deny(BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE)],
    [REJECTED, deny(BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE)],
    [FINAL_REJECTED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE)],
    [UNKNOWN, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
  ];

  const cases: Case[] = [
    ...editLikeExpected.map(([current, expected]): Case => ['edit', current, expected]),
    ...editLikeExpected.map(([current, expected]): Case => ['softDelete', current, expected]),
    // approve(一审):仅 pending → pending_final_review;wrong state 统一 22030
    ['approve', PENDING, allow(PENDING_FINAL_REVIEW)],
    ['approve', PENDING_FINAL_REVIEW, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['approve', APPROVED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['approve', REJECTED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['approve', FINAL_REJECTED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['approve', UNKNOWN, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    // reject(一审):仅 pending → rejected;wrong state 统一 22030
    ['reject', PENDING, allow(REJECTED)],
    ['reject', PENDING_FINAL_REVIEW, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['reject', APPROVED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['reject', REJECTED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['reject', FINAL_REJECTED, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    ['reject', UNKNOWN, deny(BizCode.ATTENDANCE_SHEET_STATUS_INVALID)],
    // finalApprove(终审):仅 pending_final_review → approved;wrong state 用 22045
    ['finalApprove', PENDING_FINAL_REVIEW, allow(APPROVED)],
    ['finalApprove', PENDING, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalApprove', APPROVED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalApprove', REJECTED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalApprove', FINAL_REJECTED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalApprove', UNKNOWN, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    // finalReject(终审):仅 pending_final_review → final_rejected;wrong state 用 22045
    ['finalReject', PENDING_FINAL_REVIEW, allow(FINAL_REJECTED)],
    ['finalReject', PENDING, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalReject', APPROVED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalReject', REJECTED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalReject', FINAL_REJECTED, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
    ['finalReject', UNKNOWN, deny(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID)],
  ];

  it.each(cases)('%s @ %s', (action, current, expected) => {
    expect(machine.decide(action, current)).toEqual(expected);
  });

  it('矩阵穷尽(6 action × (5 态 + 未知态) = 36)', () => {
    expect(cases).toHaveLength(6 * (STATUSES.length + 1));
  });

  it('唯一可达 approved 的路径是 finalApprove @ pending_final_review(终审两段制)', () => {
    const reachApproved = cases
      .filter(([action, current]) => {
        const d = machine.decide(action, current);
        return d.allowed && d.nextStatusCode === APPROVED;
      })
      .map(([action, current]) => `${action}@${current}`);
    expect(reachApproved).toEqual([`finalApprove@${PENDING_FINAL_REVIEW}`]);
  });
});
