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

// 约束评估上下文保留 `attendanceAllowSameReviewer` 仅为配置兼容。活动责任闭环起运行时
// 永不读取该值放开同人复核；true / false 均严格禁止。
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

// 自己不能审核自己最初提交或最近一次重提的考勤单；SUPER_ADMIN 亦拒。
const selfApprovalForbidden: ActionConstraint = {
  reason: 'self_approval_forbidden',
  vetoes: (user, resource) => {
    const submitterUserId = resource?.extra?.['submitterUserId'];
    const lastSubmittedByUserId = resource?.extra?.['lastSubmittedByUserId'];
    return (
      (typeof submitterUserId === 'string' && submitterUserId === user.id) ||
      (typeof lastSubmittedByUserId === 'string' && lastSubmittedByUserId === user.id)
    );
  },
};

// 一级审核人不得再做终审；严格域不变量，不读兼容配置。
const sameReviewerForbidden: ActionConstraint = {
  reason: 'same_reviewer_forbidden',
  vetoes: (user, resource) => {
    const reviewerUserId = resource?.extra?.['reviewerUserId'];
    return typeof reviewerUserId === 'string' && reviewerUserId === user.id;
  },
};

// 注册表:action → 约束列表(顺序即评估顺序,首个否决即返)。
export const ACTION_CONSTRAINTS: ReadonlyMap<string, readonly ActionConstraint[]> = new Map([
  ['attendance.approve.sheet', [selfApprovalForbidden]],
  ['attendance.reject.sheet', [selfApprovalForbidden]],
  ['attendance.return.sheet', [selfApprovalForbidden]],
  ['attendance.final-approve.sheet', [selfApprovalForbidden, sameReviewerForbidden]],
  ['attendance.final-reject.sheet', [selfApprovalForbidden, sameReviewerForbidden]],
  ['attendance.final-return.sheet', [selfApprovalForbidden, sameReviewerForbidden]],
]);

export function getConstraintsForAction(action: string): readonly ActionConstraint[] {
  return ACTION_CONSTRAINTS.get(action) ?? [];
}
