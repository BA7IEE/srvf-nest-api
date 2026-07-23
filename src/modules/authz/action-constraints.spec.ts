import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import {
  ACTION_CONSTRAINTS,
  getConstraintsForAction,
  type ActionConstraintContext,
} from './action-constraints';
import type { ResolvedResource } from './authz.types';

// 活动责任闭环 PR3:ActionConstraint 注册表单测。
// 一审三动作均禁最初提交人 / 最近重提人自审；终审三动作在此基础上再禁一级审核人。
// 兼容配置 true / false 均不得放开同人终审。

const FINAL_APPROVE_ACTION = 'attendance.final-approve.sheet';

const FIRST_REVIEW_ACTIONS = [
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.return.sheet',
] as const;
const FINAL_REVIEW_ACTIONS = [
  FINAL_APPROVE_ACTION,
  'attendance.final-reject.sheet',
  'attendance.final-return.sheet',
] as const;

const DEFAULT_CTX: ActionConstraintContext = { attendanceAllowSameReviewer: false };
const COMPAT_TRUE_CTX: ActionConstraintContext = { attendanceAllowSameReviewer: true };

function userPayload(id: string, role: Role = Role.ADMIN): CurrentUserPayload {
  return { id, username: `u-${id}`, role, status: UserStatus.ACTIVE, memberId: null };
}

function sheetResource(extra: Record<string, unknown>): ResolvedResource {
  return {
    resourceType: 'attendance_sheet',
    resourceId: 'sheet-1',
    organizationId: 'org-1',
    organizationPath: ['root', 'org-1'],
    ownerMemberId: null,
    ownerUserId: null,
    activityId: 'act-1',
    statusCode: 'pending_final_review',
    sensitivityLevel: null,
    extra,
  };
}

describe('action-constraints(§5.3 域不变量注册表)', () => {
  it('注册表全集 = 一审三动作各一条 + 终审三动作各两条；未注册 action 零约束', () => {
    expect([...ACTION_CONSTRAINTS.keys()]).toEqual([
      ...FIRST_REVIEW_ACTIONS,
      ...FINAL_REVIEW_ACTIONS,
    ]);
    for (const action of FIRST_REVIEW_ACTIONS) {
      expect(ACTION_CONSTRAINTS.get(action)?.map((constraint) => constraint.reason)).toEqual([
        'self_approval_forbidden',
      ]);
    }
    for (const action of FINAL_REVIEW_ACTIONS) {
      expect(ACTION_CONSTRAINTS.get(action)?.map((constraint) => constraint.reason)).toEqual([
        'self_approval_forbidden',
        'same_reviewer_forbidden',
      ]);
    }
    expect(getConstraintsForAction('member.read.record')).toHaveLength(0);
  });

  it('self_approval_forbidden:最初提交人或最近重提人==判权人 → 否决', () => {
    const [selfApproval] = getConstraintsForAction(FINAL_APPROVE_ACTION);
    expect(selfApproval.reason).toBe('self_approval_forbidden');

    const me = userPayload('user-a');
    expect(selfApproval.vetoes(me, sheetResource({ submitterUserId: 'user-a' }), DEFAULT_CTX)).toBe(
      true,
    );
    expect(
      selfApproval.vetoes(
        me,
        sheetResource({
          submitterUserId: 'user-b',
          lastSubmittedByUserId: 'user-a',
        }),
        DEFAULT_CTX,
      ),
    ).toBe(true);
    expect(selfApproval.vetoes(me, sheetResource({ submitterUserId: 'user-b' }), DEFAULT_CTX)).toBe(
      false,
    );
    expect(selfApproval.vetoes(me, sheetResource({}), DEFAULT_CTX)).toBe(false);
    // 无 ref 判权(resource=null)判不了 = 不判(goal 决断①「无 resource 退化等旧」)
    expect(selfApproval.vetoes(me, null, DEFAULT_CTX)).toBe(false);
    // SUPER_ADMIN 不豁免:约束只看事实字段,不看身份档位(服务层也不为 SA 绕过)
    expect(
      selfApproval.vetoes(
        userPayload('user-a', Role.SUPER_ADMIN),
        sheetResource({ submitterUserId: 'user-a' }),
        DEFAULT_CTX,
      ),
    ).toBe(true);
    expect(
      selfApproval.vetoes(me, sheetResource({ submitterUserId: 'user-a' }), COMPAT_TRUE_CTX),
    ).toBe(true);
  });

  it('same_reviewer_forbidden:一级 reviewer==判权人 → 默认否决;他人 / 未审 / resource=null → 放行', () => {
    const constraints = getConstraintsForAction(FINAL_APPROVE_ACTION);
    const sameReviewer = constraints[1];
    expect(sameReviewer.reason).toBe('same_reviewer_forbidden');

    const me = userPayload('user-a');
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: 'user-a' }), DEFAULT_CTX)).toBe(
      true,
    );
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: 'user-b' }), DEFAULT_CTX)).toBe(
      false,
    );
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: null }), DEFAULT_CTX)).toBe(
      false,
    );
    expect(sameReviewer.vetoes(me, null, DEFAULT_CTX)).toBe(false);
  });

  it('same_reviewer_forbidden:兼容配置 true / false 均严格否决', () => {
    const sameReviewer = getConstraintsForAction(FINAL_APPROVE_ACTION)[1];
    const me = userPayload('user-a');
    const resource = sheetResource({ reviewerUserId: 'user-a' });
    expect(sameReviewer.vetoes(me, resource, DEFAULT_CTX)).toBe(true);
    expect(sameReviewer.vetoes(me, resource, COMPAT_TRUE_CTX)).toBe(true);
  });

  // review #484 G12:两约束同时命中(同一人身兼 submitter + 一级 reviewer,现试图终审)时的优先级
  // 此前无测试锁定。`AuthzService.applyConstraints`(authz.service.ts)对 `getConstraintsForAction()`
  // 返回的数组做 `for...of` 遍历、首个否决即返(见该方法头注释"首个否决即 deny"),注册表顺序
  // `[selfApprovalForbidden, sameReviewerForbidden]` 即评估顺序 —— 故本测试用 `.find()` 复现同一遍历
  // 语义,不重新实现 applyConstraints,也不 mock AuthzService。
  it('两约束同时命中(submitter==reviewer==判权人)时,自审 self_approval_forbidden 优先于同人 same_reviewer_forbidden(注册顺序即优先级,首个否决即返;两个原因码均映射为 deny,非 allow/deny 翻转,静默重排风险见头注释)', () => {
    const constraints = getConstraintsForAction(FINAL_APPROVE_ACTION);
    const me = userPayload('user-a');
    const bothTrigger = sheetResource({ submitterUserId: 'user-a', reviewerUserId: 'user-a' });

    // 先证两条约束在此 resource 下确实都会独立否决(不是因为互斥条件导致只有一条命中)
    expect(constraints[0].vetoes(me, bothTrigger, DEFAULT_CTX)).toBe(true);
    expect(constraints[1].vetoes(me, bothTrigger, DEFAULT_CTX)).toBe(true);

    // 复现 applyConstraints 的评估顺序(首个否决即返),断言胜出的是 self_approval_forbidden(22074)
    const firstVeto = constraints.find((c) => c.vetoes(me, bothTrigger, DEFAULT_CTX));
    expect(firstVeto?.reason).toBe('self_approval_forbidden');
  });
});
