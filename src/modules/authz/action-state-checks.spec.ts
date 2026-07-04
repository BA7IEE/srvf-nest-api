import { ActivityRegistrationStateMachine } from '../activity-registrations/activity-registration-state-machine';
import { ActivityStateMachine } from '../activities/activity-state-machine';
import { AttendanceSheetStateMachine } from '../attendances/attendance-sheet-state-machine';
import { buildActionStateChecks } from './action-state-checks';

// F3/C3(路线图 §4 C3 / D8;2026-07-04):action→状态机只读校验注册表单测。
// 只锁「注册面形状 + 每项与底层状态机 decide 的代表性对齐」;状态机自身的全矩阵行为
// 由各自的 *-state-machine.spec.ts characterization 锁定,此处不重复。

describe('buildActionStateChecks(action→状态机只读注册表)', () => {
  const checks = buildActionStateChecks({
    attendanceSheet: new AttendanceSheetStateMachine(),
    activity: new ActivityStateMachine(),
    activityRegistration: new ActivityRegistrationStateMachine(),
  });

  it('注册面 = 12 项(attendance_sheet 6 + activity 3 + activity_registration 3),resourceType 对齐', () => {
    expect(checks.size).toBe(12);
    const byType = (t: string): string[] =>
      [...checks.entries()].filter(([, c]) => c.resourceType === t).map(([a]) => a);
    expect(byType('attendance_sheet').sort()).toEqual(
      [
        'attendance.approve.sheet',
        'attendance.delete.sheet',
        'attendance.final-approve.sheet',
        'attendance.final-reject.sheet',
        'attendance.reject.sheet',
        'attendance.update.sheet',
      ].sort(),
    );
    expect(byType('activity').sort()).toEqual(
      ['activity.cancel.record', 'activity.publish.record', 'activity.update.record'].sort(),
    );
    expect(byType('activity_registration').sort()).toEqual(
      [
        'activity-registration.approve.record',
        'activity-registration.cancel.record',
        'activity-registration.reject.record',
      ].sort(),
    );
  });

  it('attendance:终审仅 pending_final_review 可行;一级审批仅 pending 可行(与状态机 decide 对齐)', () => {
    const finalApprove = checks.get('attendance.final-approve.sheet')!;
    expect(finalApprove.decide('pending_final_review')).toBe(true);
    expect(finalApprove.decide('pending')).toBe(false);
    expect(finalApprove.decide('approved')).toBe(false);

    const approve = checks.get('attendance.approve.sheet')!;
    expect(approve.decide('pending')).toBe(true);
    expect(approve.decide('pending_final_review')).toBe(false);

    const edit = checks.get('attendance.update.sheet')!;
    expect(edit.decide('pending')).toBe(true);
    expect(edit.decide('approved')).toBe(false);
  });

  it('activity:cancelled 不可再 update/cancel;publish 仅 draft 可行(D8「活动已取消」示例)', () => {
    const update = checks.get('activity.update.record')!;
    expect(update.decide('published')).toBe(true);
    expect(update.decide('cancelled')).toBe(false);

    const publish = checks.get('activity.publish.record')!;
    expect(publish.decide('draft')).toBe(true);
    expect(publish.decide('published')).toBe(false);

    const cancel = checks.get('activity.cancel.record')!;
    expect(cancel.decide('published')).toBe(true);
    expect(cancel.decide('cancelled')).toBe(false);
  });

  it('activity_registration:approve/reject 仅 pending;cancel 允许 pending|pass', () => {
    const approve = checks.get('activity-registration.approve.record')!;
    expect(approve.decide('pending')).toBe(true);
    expect(approve.decide('pass')).toBe(false);

    const cancel = checks.get('activity-registration.cancel.record')!;
    expect(cancel.decide('pending')).toBe(true);
    expect(cancel.decide('pass')).toBe(true);
    expect(cancel.decide('reject')).toBe(false);
    expect(cancel.decide('cancelled')).toBe(false);
  });

  it('未注册 action 不在表内(注册表即全集;消费方对未注册项跳过状态层)', () => {
    expect(checks.has('activity.delete.record')).toBe(false);
    expect(checks.has('member.read.record')).toBe(false);
  });
});
