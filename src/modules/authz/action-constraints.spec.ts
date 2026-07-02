import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import {
  ACTION_CONSTRAINTS,
  ATTENDANCE_FINAL_APPROVE_ALLOW_SAME_REVIEWER,
  getConstraintsForAction,
} from './action-constraints';
import type { ResolvedResource } from './authz.types';

// 终态 scoped-authz PR8:ActionConstraint 注册表单测(冻结稿 §5.3)。
// 纯函数层:注册表内容 + 两条终审约束的否决/放行边界;与 DB 无关(服务级链路在
// test/e2e/authz-three-source.e2e-spec.ts 场景 4 里连 AuthzService 一起锁)。

const FINAL_APPROVE_ACTION = 'attendance.final-approve.sheet';

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
  it('注册表全集 = 仅 attendance.final-approve.sheet 两条(未注册 action 零约束)', () => {
    expect([...ACTION_CONSTRAINTS.keys()]).toEqual([FINAL_APPROVE_ACTION]);
    expect(ACTION_CONSTRAINTS.get(FINAL_APPROVE_ACTION)).toHaveLength(2);
    expect(getConstraintsForAction('member.read.record')).toHaveLength(0);
    expect(getConstraintsForAction('attendance.approve.sheet')).toHaveLength(0);
  });

  it('same_reviewer 默认禁止(BD 拍板;常量可配)', () => {
    expect(ATTENDANCE_FINAL_APPROVE_ALLOW_SAME_REVIEWER).toBe(false);
  });

  it('self_approval_forbidden:submitter==判权人 → 否决;他人 / 字段缺失 / resource=null → 放行', () => {
    const [selfApproval] = getConstraintsForAction(FINAL_APPROVE_ACTION);
    expect(selfApproval.reason).toBe('self_approval_forbidden');

    const me = userPayload('user-a');
    expect(selfApproval.vetoes(me, sheetResource({ submitterUserId: 'user-a' }))).toBe(true);
    expect(selfApproval.vetoes(me, sheetResource({ submitterUserId: 'user-b' }))).toBe(false);
    expect(selfApproval.vetoes(me, sheetResource({}))).toBe(false);
    // 无 ref 判权(resource=null)判不了 = 不判(goal 决断①「无 resource 退化等旧」)
    expect(selfApproval.vetoes(me, null)).toBe(false);
    // SUPER_ADMIN 不豁免:约束只看事实字段,不看身份档位(服务层也不为 SA 绕过)
    expect(
      selfApproval.vetoes(
        userPayload('user-a', Role.SUPER_ADMIN),
        sheetResource({ submitterUserId: 'user-a' }),
      ),
    ).toBe(true);
  });

  it('same_reviewer_forbidden:一级 reviewer==判权人 → 否决;他人 / 未审 / resource=null → 放行', () => {
    const constraints = getConstraintsForAction(FINAL_APPROVE_ACTION);
    const sameReviewer = constraints[1];
    expect(sameReviewer.reason).toBe('same_reviewer_forbidden');

    const me = userPayload('user-a');
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: 'user-a' }))).toBe(true);
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: 'user-b' }))).toBe(false);
    expect(sameReviewer.vetoes(me, sheetResource({ reviewerUserId: null }))).toBe(false);
    expect(sameReviewer.vetoes(me, null)).toBe(false);
  });
});
