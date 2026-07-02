import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { ResolvedResource } from './authz.types';

// 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.3):ActionConstraint 注册表(域不变量层)。
//
// 语义(§5.2 applyConstraints):按 action 注册的小型否决器,在 scope 命中后、返回前执行,
// **对所有人(含 SUPER_ADMIN)生效** —— 它是数据完整性不变量,不是权限,故不随短路豁免。
// 未注册 action 零约束(注册表即全集,不做通配)。
//
// 边界:
// - 约束只依据 ResolvedResource 上的事实字段判定;resource 为 null(无 ref 判权)或所需字段缺失时
//   **不否决**(判不了 = 不判;保「无 ref 退化等旧」行为锁,goal 决断①)。消费者(PR9 起)传 ref 后约束才有咬合点。
// - `sensitive_denied` 为保留 reason:敏感分级由 §4.2「另一个权限码」承载(*.read.sensitive 独立码),
//   本注册表不注册兜底约束(避免与权限码粒度双轨判定);未来若需资源级兜底再补,勿默认加。
// - attendances 业务侧仍可叠加自己的状态机 / PolicyService 校验,二者不冲突(§5.3 职责分离归属)。

export type ConstraintVetoReason = 'self_approval_forbidden' | 'same_reviewer_forbidden';

// 约束评估上下文(PR9,goal 决断②):运行时可配开关,由 AuthzService 从 app.config 注入
// (env `ATTENDANCE_ALLOW_SAME_REVIEWER`,默认 false=禁止;取代 PR8 的代码常量
// ATTENDANCE_FINAL_APPROVE_ALLOW_SAME_REVIEWER)。只影响 same_reviewer;自审约束永不读此开关。
export interface ActionConstraintContext {
  attendanceAllowSameReviewer: boolean;
}

export interface ActionConstraint {
  reason: ConstraintVetoReason;
  // 返回 true = 否决(deny with reason);false = 放行
  vetoes(
    user: CurrentUserPayload,
    resource: ResolvedResource | null,
    ctx: ActionConstraintContext,
  ): boolean;
}

// 自己不能终审自己提交的考勤单(§5.3 第 1 行;场景 4:SUPER_ADMIN 亦拒)。
// 域不变量:不读 ctx,任何配置都不可放开(goal 决断②「自审永不可放开」)。
const selfApprovalForbidden: ActionConstraint = {
  reason: 'self_approval_forbidden',
  vetoes: (user, resource) => {
    const submitterUserId = resource?.extra?.['submitterUserId'];
    return typeof submitterUserId === 'string' && submitterUserId === user.id;
  },
};

// 一级审核人不得再终审同一张单(§5.3 第 2 行;默认禁止,env 可配 —— ctx 见上)。
const sameReviewerForbidden: ActionConstraint = {
  reason: 'same_reviewer_forbidden',
  vetoes: (user, resource, ctx) => {
    if (ctx.attendanceAllowSameReviewer) return false;
    const reviewerUserId = resource?.extra?.['reviewerUserId'];
    return typeof reviewerUserId === 'string' && reviewerUserId === user.id;
  },
};

// 注册表:action → 约束列表(顺序即评估顺序,首个否决即返)。
export const ACTION_CONSTRAINTS: ReadonlyMap<string, readonly ActionConstraint[]> = new Map([
  ['attendance.final-approve.sheet', [selfApprovalForbidden, sameReviewerForbidden]],
]);

export function getConstraintsForAction(action: string): readonly ActionConstraint[] {
  return ACTION_CONSTRAINTS.get(action) ?? [];
}
