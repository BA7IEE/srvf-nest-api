import {
  buildVisibilityWhere,
  canSeeContent,
  type CallerVisibilityContext,
} from '../content/content.visibility';
import {
  NOTIFICATION_STATUS_ARCHIVED,
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_STATUS_PUBLISHED,
  NOTIFICATION_VISIBILITIES,
  NOTIFICATION_VISIBILITY_DEPARTMENT,
  NOTIFICATION_VISIBILITY_FORMAL_MEMBER,
  NOTIFICATION_VISIBILITY_MANAGEMENT,
  NOTIFICATION_VISIBILITY_MEMBER,
} from './notification.constants';

// 统一通知模块 S1 站内信渠道:**可见性复用** content.visibility 纯函数自证(评审稿 §5;零第二套)。
//
// 通知不另写可见性纯函数:直接喂 notification 行(statusCode / visibilityCode / visibleOrganizationIds 同形)
// 进 content 的 canSeeContent / buildVisibilityWhere。本 spec 证:
//   1. 通知可见值 = content 可见值的 4 档子集(NOTIFICATION_VISIBILITIES 不含 public);
//   2. canSeeContent 对通知行 4 档判定正确(member / formal_member / department / management);
//   3. 通知永不写 public → 复用函数的 public 分支对通知恒不命中,效果即「去 public」;
//   4. 非 published(draft / archived)通知一律不可见;
//   5. buildVisibilityWhere 产出的 where 对通知列表过滤同样适用(published + 命中可见档 OR)。

const memberCtx: CallerVisibilityContext = {
  isMember: true,
  isFormalMember: false,
  activeOrgIds: [],
  isManagement: false,
};
const formalCtx: CallerVisibilityContext = {
  isMember: true,
  isFormalMember: true,
  activeOrgIds: ['org-1'],
  isManagement: false,
};
const mgmtCtx: CallerVisibilityContext = {
  isMember: true,
  isFormalMember: true,
  activeOrgIds: ['org-1'],
  isManagement: true,
};

function notif(visibilityCode: string, visibleOrganizationIds: string[] = []) {
  return { statusCode: NOTIFICATION_STATUS_PUBLISHED, visibilityCode, visibleOrganizationIds };
}

describe('统一通知模块 — 可见性复用 content.visibility(零第二套)', () => {
  it('NOTIFICATION_VISIBILITIES = 4 档,不含 public(去 public)', () => {
    expect([...NOTIFICATION_VISIBILITIES]).toEqual([
      'member',
      'formal_member',
      'department',
      'management',
    ]);
    expect([...NOTIFICATION_VISIBILITIES]).not.toContain('public');
  });

  it('member 档:任意活跃会员可见', () => {
    expect(canSeeContent(memberCtx, notif(NOTIFICATION_VISIBILITY_MEMBER))).toBe(true);
  });

  it('formal_member 档:仅正式队员(有活跃部门)可见', () => {
    expect(canSeeContent(memberCtx, notif(NOTIFICATION_VISIBILITY_FORMAL_MEMBER))).toBe(false);
    expect(canSeeContent(formalCtx, notif(NOTIFICATION_VISIBILITY_FORMAL_MEMBER))).toBe(true);
  });

  it('department 档:仅命中 visibleOrganizationIds 的会员可见', () => {
    expect(canSeeContent(formalCtx, notif(NOTIFICATION_VISIBILITY_DEPARTMENT, ['org-1']))).toBe(
      true,
    );
    expect(canSeeContent(formalCtx, notif(NOTIFICATION_VISIBILITY_DEPARTMENT, ['org-2']))).toBe(
      false,
    );
  });

  it('management 档:仅管理层可见', () => {
    expect(canSeeContent(formalCtx, notif(NOTIFICATION_VISIBILITY_MANAGEMENT))).toBe(false);
    expect(canSeeContent(mgmtCtx, notif(NOTIFICATION_VISIBILITY_MANAGEMENT))).toBe(true);
  });

  it('非 published(draft / archived)一律不可见', () => {
    expect(
      canSeeContent(mgmtCtx, {
        statusCode: NOTIFICATION_STATUS_DRAFT,
        visibilityCode: NOTIFICATION_VISIBILITY_MEMBER,
        visibleOrganizationIds: [],
      }),
    ).toBe(false);
    expect(
      canSeeContent(mgmtCtx, {
        statusCode: NOTIFICATION_STATUS_ARCHIVED,
        visibilityCode: NOTIFICATION_VISIBILITY_MEMBER,
        visibleOrganizationIds: [],
      }),
    ).toBe(false);
  });

  it('buildVisibilityWhere:member ctx 产出 published + 命中可见档 OR(通知列表过滤同样适用)', () => {
    const where = buildVisibilityWhere(memberCtx);
    expect(where.statusCode).toBe(NOTIFICATION_STATUS_PUBLISHED);
    expect(where.deletedAt).toBeNull();
    const orVisibilities = (where.OR ?? []).map(
      (o) => (o as { visibilityCode?: string }).visibilityCode,
    );
    // 含 member 档(isMember=true);public 分支虽在(复用函数)但通知无 public 行 → 恒不命中(去 public)。
    expect(orVisibilities).toContain('member');
    expect(orVisibilities).not.toContain('formal_member'); // memberCtx 非正式队员
  });
});
