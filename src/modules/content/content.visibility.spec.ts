import {
  CONTENT_STATUS_ARCHIVED,
  CONTENT_STATUS_DRAFT,
  CONTENT_STATUS_PUBLISHED,
  CONTENT_VISIBILITY_DEPARTMENT,
  CONTENT_VISIBILITY_FORMAL_MEMBER,
  CONTENT_VISIBILITY_MANAGEMENT,
  CONTENT_VISIBILITY_MEMBER,
  CONTENT_VISIBILITY_PUBLIC,
} from './content.constants';
import {
  ANON_VISIBILITY_CONTEXT,
  buildVisibilityWhere,
  canSeeContent,
  type CallerVisibilityContext,
} from './content.visibility';

// CMS 内容发布模块(第 28 模块)可见性纯函数单测(评审稿 §4)。
// 零 DB / 零 NestJS:只验 canSeeContent(单条判定)+ buildVisibilityWhere(list where 片段)。
// 覆盖 5 档 × 命中/不命中 + 非 published + 未知档 fail-close;以及匿名/会员/正式/部门/管理 where 形态。

// caller 上下文工厂(只覆盖关心的字段,其余取 ANON 默认)。
function ctx(over: Partial<CallerVisibilityContext> = {}): CallerVisibilityContext {
  return { ...ANON_VISIBILITY_CONTEXT, ...over };
}

// content 行工厂(canSeeContent 只读 statusCode / visibilityCode / visibleOrganizationIds 三字段)。
function content(over: {
  statusCode?: string;
  visibilityCode: string;
  visibleOrganizationIds?: string[];
}): {
  statusCode: string;
  visibilityCode: string;
  visibleOrganizationIds: readonly string[];
} {
  return {
    statusCode: over.statusCode ?? CONTENT_STATUS_PUBLISHED,
    visibilityCode: over.visibilityCode,
    visibleOrganizationIds: over.visibleOrganizationIds ?? [],
  };
}

describe('content.visibility — canSeeContent', () => {
  describe('published 前提', () => {
    it('draft 一律不可见(即便 public + 管理层)', () => {
      const c = content({
        statusCode: CONTENT_STATUS_DRAFT,
        visibilityCode: CONTENT_VISIBILITY_PUBLIC,
      });
      expect(canSeeContent(ctx({ isManagement: true }), c)).toBe(false);
    });

    it('archived 一律不可见(即便 public)', () => {
      const c = content({
        statusCode: CONTENT_STATUS_ARCHIVED,
        visibilityCode: CONTENT_VISIBILITY_PUBLIC,
      });
      expect(canSeeContent(ctx(), c)).toBe(false);
    });
  });

  describe('public 档', () => {
    it('任何人(含匿名)都可见', () => {
      const c = content({ visibilityCode: CONTENT_VISIBILITY_PUBLIC });
      expect(canSeeContent(ANON_VISIBILITY_CONTEXT, c)).toBe(true);
      expect(canSeeContent(ctx({ isMember: true }), c)).toBe(true);
    });
  });

  describe('member 档', () => {
    const c = content({ visibilityCode: CONTENT_VISIBILITY_MEMBER });
    it('isMember=true → 可见', () => {
      expect(canSeeContent(ctx({ isMember: true }), c)).toBe(true);
    });
    it('isMember=false(匿名)→ 不可见', () => {
      expect(canSeeContent(ANON_VISIBILITY_CONTEXT, c)).toBe(false);
    });
  });

  describe('formal_member 档', () => {
    const c = content({ visibilityCode: CONTENT_VISIBILITY_FORMAL_MEMBER });
    it('isFormalMember=true → 可见', () => {
      expect(canSeeContent(ctx({ isMember: true, isFormalMember: true }), c)).toBe(true);
    });
    it('仅 isMember(非正式队员)→ 不可见', () => {
      expect(canSeeContent(ctx({ isMember: true, isFormalMember: false }), c)).toBe(false);
    });
  });

  describe('department 档(org 交集判定)', () => {
    const c = content({
      visibilityCode: CONTENT_VISIBILITY_DEPARTMENT,
      visibleOrganizationIds: ['orgA', 'orgB'],
    });
    it('activeOrgIds 与文章 visibleOrganizationIds 有交集 → 可见(命中)', () => {
      expect(
        canSeeContent(
          ctx({ isMember: true, isFormalMember: true, activeOrgIds: ['orgB', 'orgC'] }),
          c,
        ),
      ).toBe(true);
    });
    it('activeOrgIds 与文章无交集 → 不可见(不命中)', () => {
      expect(
        canSeeContent(ctx({ isMember: true, isFormalMember: true, activeOrgIds: ['orgC'] }), c),
      ).toBe(false);
    });
    it('activeOrgIds 为空 → 不可见', () => {
      expect(canSeeContent(ctx({ isMember: true }), c)).toBe(false);
    });
  });

  describe('management 档', () => {
    const c = content({ visibilityCode: CONTENT_VISIBILITY_MANAGEMENT });
    it('isManagement=true → 可见', () => {
      expect(canSeeContent(ctx({ isManagement: true }), c)).toBe(true);
    });
    it('isManagement=false(普通会员)→ 不可见', () => {
      expect(
        canSeeContent(ctx({ isMember: true, isFormalMember: true, activeOrgIds: ['orgA'] }), c),
      ).toBe(false);
    });
  });

  describe('未知 / 脏可见档', () => {
    it('未知 visibilityCode → fail-close(false),即便管理层', () => {
      const c = content({ visibilityCode: 'some_unknown_tier' });
      expect(canSeeContent(ctx({ isManagement: true }), c)).toBe(false);
    });
  });
});

describe('content.visibility — buildVisibilityWhere', () => {
  it('始终含 deletedAt:null + statusCode=published(任何 ctx)', () => {
    const where = buildVisibilityWhere(ANON_VISIBILITY_CONTEXT);
    expect(where.deletedAt).toBeNull();
    expect(where.statusCode).toBe(CONTENT_STATUS_PUBLISHED);
  });

  it('匿名 = 仅 public 一档 OR', () => {
    const where = buildVisibilityWhere(ANON_VISIBILITY_CONTEXT);
    expect(where.OR).toEqual([{ visibilityCode: CONTENT_VISIBILITY_PUBLIC }]);
  });

  it('isMember → OR 追加 member 档(public + member 两档)', () => {
    const where = buildVisibilityWhere(ctx({ isMember: true }));
    expect(where.OR).toEqual([
      { visibilityCode: CONTENT_VISIBILITY_PUBLIC },
      { visibilityCode: CONTENT_VISIBILITY_MEMBER },
    ]);
  });

  it('isFormalMember → OR 追加 formal_member 档', () => {
    const where = buildVisibilityWhere(ctx({ isMember: true, isFormalMember: true }));
    expect(where.OR).toContainEqual({ visibilityCode: CONTENT_VISIBILITY_FORMAL_MEMBER });
  });

  it('activeOrgIds 非空 → OR 追加 department 档含 hasSome', () => {
    const where = buildVisibilityWhere(
      ctx({ isMember: true, isFormalMember: true, activeOrgIds: ['orgA', 'orgB'] }),
    );
    expect(where.OR).toContainEqual({
      visibilityCode: CONTENT_VISIBILITY_DEPARTMENT,
      visibleOrganizationIds: { hasSome: ['orgA', 'orgB'] },
    });
  });

  it('activeOrgIds 为空 → OR 不含 department 档', () => {
    const where = buildVisibilityWhere(ctx({ isMember: true }));
    const hasDept = (where.OR as { visibilityCode?: string }[]).some(
      (clause) => clause.visibilityCode === CONTENT_VISIBILITY_DEPARTMENT,
    );
    expect(hasDept).toBe(false);
  });

  it('isManagement → OR 追加 management 档', () => {
    const where = buildVisibilityWhere(ctx({ isManagement: true }));
    expect(where.OR).toContainEqual({ visibilityCode: CONTENT_VISIBILITY_MANAGEMENT });
  });

  it('全档 ctx → OR 含全 5 档(public + member + formal + department + management)', () => {
    const where = buildVisibilityWhere(
      ctx({ isMember: true, isFormalMember: true, activeOrgIds: ['orgA'], isManagement: true }),
    );
    const codes = (where.OR as { visibilityCode?: string }[]).map((c) => c.visibilityCode);
    expect(codes).toEqual([
      CONTENT_VISIBILITY_PUBLIC,
      CONTENT_VISIBILITY_MEMBER,
      CONTENT_VISIBILITY_FORMAL_MEMBER,
      CONTENT_VISIBILITY_DEPARTMENT,
      CONTENT_VISIBILITY_MANAGEMENT,
    ]);
  });
});
