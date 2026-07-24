import type {
  ActivityRegistrationStateMachine,
  ActivityRegistrationTransitionAction,
} from '../activity-registrations/activity-registration-state-machine';
import type {
  ActivityStateAction,
  ActivityStateMachine,
} from '../activities/activity-state-machine';
import type {
  AttendanceSheetStateMachine,
  AttendanceSheetTransitionAction,
} from '../attendances/attendance-sheet-state-machine';
import type { AuthzReason } from './authz.types';

// F3/C3「action-state/batch」(路线图 §4 C3 / D8;2026-07-04):action 权限码 → 状态机只读校验注册表。
//
// 语义:前端「一组按钮该不该亮」的第二重闸 —— authz 判权放行后,已注册 action 再经对应资源
// **既有 StateMachine 的纯判定**(decide() 只读,不写、不跃迁、不抛)复核当前 statusCode 是否允许该动作;
// 不允许 → reason='state_forbidden'。未注册 action 零状态校验(注册表即全集,不做通配 —— 镜像
// action-constraints.ts 边界哲学:判不了 = 不判)。
//
// **D8 模块环规避(路线图预警项,此处为其落地方式)**:三个 StateMachine 均为零依赖纯决策类
// (不持有 DB / audit / DTO),本文件只做 **TS 类型级 import**(import type),实例经 authz.module
// providers 独立注入(与业务模块各自的实例互不相干,无状态故等价)—— authz 模块**不** import 任何
// 业务 Nest module,不成模块环(AuthzModule 叶子铁律不破)。若未来某状态机长出依赖,须回到 D8
// mini-T0 重议,禁止顺手把业务 module import 进来。
//
// **不引入新判权语义**:本表只消费 decide().allowed 布尔结论,BizCode / nextStatusCode 一概不用;
// 判权部分(含自审/同人 ActionConstraint)完全由 AuthzService.explain 承载。

export type ActionStateReason = AuthzReason | 'state_forbidden';

export interface ActionStateCheck {
  // 该 action 的状态校验只在入参 resourceType 与此一致时咬合(不一致 = 判不了,跳过状态层)
  resourceType: string;
  // true = 资源当前状态允许该动作;false = state_forbidden
  decide(statusCode: string): boolean;
}

export interface ActionStateMachines {
  attendanceSheet: AttendanceSheetStateMachine;
  activity: ActivityStateMachine;
  activityRegistration: ActivityRegistrationStateMachine;
}

// 注册面 = 三个既有状态机动作与权限码的既有对应(各 service 判权位点的 action 码 × 状态机 decide 动作;
// 见 attendances/activities/activity-registrations 各 service):
//   attendance_sheet 9 项 / activity 3 项(delete 无状态机动作,不注册)/ activity_registration 3 项。
export function buildActionStateChecks(
  machines: ActionStateMachines,
): ReadonlyMap<string, ActionStateCheck> {
  const sheet = (action: AttendanceSheetTransitionAction): ActionStateCheck => ({
    resourceType: 'attendance_sheet',
    decide: (statusCode) => machines.attendanceSheet.decide(action, statusCode).allowed,
  });
  const activity = (action: ActivityStateAction): ActionStateCheck => ({
    resourceType: 'activity',
    decide: (statusCode) => machines.activity.decide(action, statusCode).allowed,
  });
  const registration = (action: ActivityRegistrationTransitionAction): ActionStateCheck => ({
    resourceType: 'activity_registration',
    decide: (statusCode) => machines.activityRegistration.decide(action, statusCode).allowed,
  });

  return new Map<string, ActionStateCheck>([
    ['attendance.update.sheet', sheet('edit')],
    ['attendance.delete.sheet', sheet('softDelete')],
    ['attendance.approve.sheet', sheet('approve')],
    ['attendance.reject.sheet', sheet('reject')],
    ['attendance.return.sheet', sheet('firstReturn')],
    ['attendance.final-approve.sheet', sheet('finalApprove')],
    ['attendance.final-reject.sheet', sheet('finalReject')],
    ['attendance.final-return.sheet', sheet('finalReturn')],
    ['attendance.reopen.sheet', sheet('reopen')],
    ['activity.update.record', activity('update')],
    ['activity.publish.record', activity('publish')],
    ['activity.cancel.record', activity('cancel')],
    ['activity-registration.approve.record', registration('approve')],
    ['activity-registration.reject.record', registration('reject')],
    ['activity-registration.cancel.record', registration('cancel')],
  ]);
}
