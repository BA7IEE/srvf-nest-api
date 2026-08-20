import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  MembershipStatus,
  PrincipalType,
  Role,
} from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { extractMethodSource } from '../helpers/source-span';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * 两条规模可用性缺口 —— #1089 逐条判定时被推翻的两条**真能力缺口**。
 *
 * - **AC-030**「超过 200 人仍可完整查找」:`collaborator-options` 改造前无搜索、无分页、
 *   `take: 200` 硬截 ⇒ 第 201 个候选人在任何入参下都不可达。
 * - **AC-068**「500/2000/10000 人不要求业务人员手工拆 200 人数组」:现场批量代签只接受
 *   ≤500 条 id 列表 ⇒ 2000 人现场要业务人员自己拆四次。
 *
 * 本 spec 的五条不变量与 goal 一一对应,每条都写成「改回改造前的写法就会红」的形状。
 */

interface OptionsPayload {
  items: Array<{ id: string; memberNo: string; eligibilitySource: string }>;
  total: number;
  page: number;
  pageSize: number;
}

const CANDIDATE_COUNT = 250;
const LEGACY_HARD_CUT = 200;

describe('activity scale usability: selector reachability and batch split', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousV11Workflow = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerAuth: string;
  let ownerUserId: string;
  let ownerMemberId: string;
  let activityOwnerRoleId: string;
  let organizationId: string;
  let sequence = 0;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const owner = await createTestUser(app, { username: 'scale-usability-owner', role: Role.USER });
    const ownerMember = await prisma.member.create({
      data: {
        memberNo: 'SCALE-OWNER',
        ...memberIdentityData('Scale Usability Owner'),
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    ownerUserId = owner.id;
    ownerMemberId = ownerMember.id;
    await prisma.user.update({ where: { id: owner.id }, data: { memberId: ownerMember.id } });
    ownerAuth = (await loginAs(app, owner.username)).authHeader;

    const root = await prisma.organization.create({
      data: { name: '规模可用性根组织', nodeTypeCode: 'scale-usability-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '规模可用性执行组织',
        nodeTypeCode: 'scale-usability-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    restoreEnv('ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED', previousResponsibilityWorkflow);
    restoreEnv('ACTIVITY_V11_WORKFLOW_ENABLED', previousV11Workflow);
  });

  function restoreEnv(key: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }

  /** 建一场 owner 归属本人的已发布活动(collaborator-options 的 loadOwned 前提)。 */
  async function createOwnedActivity(): Promise<string> {
    const index = ++sequence;
    const now = new Date();
    const activity = await prisma.activity.create({
      data: {
        title: `规模可用性活动 ${index}`,
        activityTypeCode: 'training',
        organizationId,
        startAt: new Date(now.getTime() - 10 * 60_000),
        endAt: new Date(now.getTime() + 2 * 60 * 60_000),
        location: '规模可用性现场',
        statusCode: 'published',
        publishedAt: now,
        capacity: 10_000,
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        registrationDeadline: new Date(now.getTime() + 60 * 60_000),
        initiatorMemberId: ownerMemberId,
      },
      select: { id: true },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: ownerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: ownerUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: ownerMemberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `scale usability fixture ${index}`,
      },
    });
    return activity.id;
  }

  /**
   * 造 N 个「本组织有效成员」候选人。memberNo 补零 ⇒ 与生产排序键
   * `[{ memberNo: 'asc' }, { id: 'asc' }]` 完全同序,断言才能逐位对齐。
   */
  async function createCandidates(prefix: string, count: number): Promise<string[]> {
    const tag = `${prefix}-${++sequence}`;
    const members = Array.from({ length: count }, (_, i) => ({
      memberNo: `${tag}-${String(i).padStart(5, '0')}`,
      ...memberIdentityData(`候选人 ${tag} ${String(i).padStart(5, '0')}`),
      gradeCode: 'L1',
      status: MemberStatus.ACTIVE,
    }));
    await prisma.member.createMany({ data: members });
    const created = await prisma.member.findMany({
      where: { memberNo: { startsWith: `${tag}-` } },
      select: { id: true, memberNo: true },
      orderBy: [{ memberNo: 'asc' }, { id: 'asc' }],
    });
    await prisma.user.createMany({
      data: created.map((member) => ({
        username: `u-${member.memberNo.toLowerCase()}`,
        passwordHash: 'scale-usability-not-a-real-hash',
        memberId: member.id,
      })),
    });
    await prisma.memberOrganizationMembership.createMany({
      data: created.map((member) => ({
        memberId: member.id,
        organizationId,
        status: MembershipStatus.ACTIVE,
        startedAt: new Date(Date.now() - 60 * 60_000),
      })),
    });
    return created.map((member) => member.id);
  }

  function optionsUrl(activityId: string, query = ''): string {
    return `/api/app/v1/my/managed-activities/${activityId}/collaborator-options${query}`;
  }

  async function getOptions(activityId: string, query = ''): Promise<request.Response> {
    return request(httpServer(app))
      .get(optionsUrl(activityId, query))
      .set('Authorization', ownerAuth);
  }

  /** 200 响应的业务载荷。错误分支照旧走 expectBizError,不经过这里。 */
  async function getOptionsData(activityId: string, query = ''): Promise<OptionsPayload> {
    const response = await getOptions(activityId, query);
    expect(response.status).toBe(200);
    return response.body.data as OptionsPayload;
  }

  // ==========================================================================
  // 不变量 1:第 201 人可达
  // ==========================================================================

  it('不变量 1 —— 超过 200 人时第 201 个候选人可以翻页找到,也可以搜索找到', async () => {
    const activityId = await createOwnedActivity();
    const candidateIds = await createCandidates('reach', CANDIDATE_COUNT);
    expect(candidateIds).toHaveLength(CANDIDATE_COUNT);

    const twoHundredFirstId = candidateIds[LEGACY_HARD_CUT];
    expect(twoHundredFirstId).toBeDefined();

    // ① 改造前的那一页:默认页仍恰好是前 200 个 —— 第 201 人确实不在里面。
    const firstPage = await getOptionsData(activityId);
    expect(firstPage.items).toHaveLength(LEGACY_HARD_CUT);
    expect(firstPage.total).toBe(CANDIDATE_COUNT);
    expect(firstPage.items.map((item) => item.id)).not.toContain(twoHundredFirstId);

    // ② 翻页够得到。变异:把 skip 去掉 / 恢复 take: 200 ⇒ 这里红。
    const secondPage = await getOptionsData(activityId, '?page=2');
    const secondPageIds = secondPage.items.map((item) => item.id);
    expect(secondPageIds).toHaveLength(CANDIDATE_COUNT - LEGACY_HARD_CUT);
    expect(secondPageIds).toContain(twoHundredFirstId);
    expect(secondPageIds[0]).toBe(twoHundredFirstId);

    // ③ 搜索也够得到(不必知道他在第几页)。变异:去掉 q 分支 ⇒ 这里红。
    const target = await prisma.member.findUniqueOrThrow({
      where: { id: twoHundredFirstId },
      select: { memberNo: true },
    });
    const searched = await getOptionsData(activityId, `?q=${encodeURIComponent(target.memberNo)}`);
    expect(searched.total).toBe(1);
    expect(searched.items.map((item) => item.id)).toEqual([twoHundredFirstId]);
  }, 180_000);

  it('搜索是 trim + 大小写不敏感的,空搜索等同于不搜索', async () => {
    const activityId = await createOwnedActivity();
    await createCandidates('search', 3);
    const anyone = (await getOptionsData(activityId)).items[0];

    const upper = await getOptionsData(
      activityId,
      `?q=${encodeURIComponent(anyone.memberNo.toUpperCase())}`,
    );
    const lower = await getOptionsData(
      activityId,
      `?q=${encodeURIComponent(anyone.memberNo.toLowerCase())}`,
    );
    const padded = await getOptionsData(
      activityId,
      `?q=${encodeURIComponent(`   ${anyone.memberNo}   `)}`,
    );
    expect(upper.items.map((item) => item.id)).toEqual([anyone.id]);
    expect(lower.items.map((item) => item.id)).toEqual([anyone.id]);
    expect(padded.items.map((item) => item.id)).toEqual([anyone.id]);

    // trim 完是空串 ⇒ 等同于没搜,而不是「搜一个空串」。
    const blank = await getOptionsData(activityId, '?q=%20%20');
    expect(blank.total).toBe((await getOptionsData(activityId)).total);

    // 长度上限:合同 §11.2 要求模糊搜索统一有长度上限。
    const tooLong = await getOptions(activityId, `?q=${'a'.repeat(101)}`);
    expectBizError(tooLong, BizCode.BAD_REQUEST, { strictMessage: false });
  }, 120_000);

  // ==========================================================================
  // 不变量 4:纯加法 —— 不传新参数时行为与改造前一致
  // ==========================================================================

  it('不变量 4 —— 不传任何新参数时,items 与改造前逐位相同(默认页 = 改造前的 take: 200)', async () => {
    const activityId = await createOwnedActivity();
    await createCandidates('additive', CANDIDATE_COUNT);

    // 独立复算「改造前那一版查询」的结果:同 where、同 orderBy、同 take: 200。
    // 这里刻意不复用生产代码 —— 复用了就变成拿实现证明实现。
    const legacy = await prisma.member.findMany({
      where: {
        status: MemberStatus.ACTIVE,
        deletedAt: null,
        users: { some: { status: 'ACTIVE', deletedAt: null } },
        activityResponsibilities: { none: { activityId, status: 'active' } },
        OR: [
          { activityRegistrations: { some: { activityId, statusCode: 'pass', deletedAt: null } } },
          {
            memberOrganizationMemberships: {
              some: {
                organizationId,
                status: MembershipStatus.ACTIVE,
                deletedAt: null,
                startedAt: { lte: new Date() },
                OR: [{ endedAt: null }, { endedAt: { gt: new Date() } }],
              },
            },
          },
        ],
      },
      select: { id: true, memberNo: true, realName: true, nickname: true, gradeCode: true },
      orderBy: [{ memberNo: 'asc' }, { id: 'asc' }],
      take: LEGACY_HARD_CUT,
    });
    expect(legacy.length).toBe(LEGACY_HARD_CUT);

    const current = await getOptionsData(activityId);
    expect(
      current.items.map((item) => ({
        id: item.id,
        memberNo: item.memberNo,
      })),
    ).toEqual(legacy.map((row) => ({ id: row.id, memberNo: row.memberNo })));
    // 新增的三个分页元字段是纯加法,默认值必须复现改造前那一页的形状。
    expect(current.page).toBe(1);
    expect(current.pageSize).toBe(LEGACY_HARD_CUT);
  }, 180_000);

  // ==========================================================================
  // 🔴 红线:可见集合逐个 id 相同 —— 扩面只改「翻得到」,不改「看得到谁」
  // ==========================================================================

  it('🔴 红线 —— 翻遍所有页得到的可见集合,与改造前不截断时的可见集合逐个 id 相同', async () => {
    const activityId = await createOwnedActivity();
    const visible = await createCandidates('visible', CANDIDATE_COUNT);

    // 三个必须**看不到**的反面样本,逐个证明扩面没有顺手放宽可见范围。
    const inactiveMember = await prisma.member.create({
      data: {
        memberNo: `SCALE-INACTIVE-${++sequence}`,
        ...memberIdentityData('已停用队员'),
        status: MemberStatus.INACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.create({
      data: {
        username: `u-scale-inactive-${sequence}`,
        passwordHash: 'x',
        memberId: inactiveMember.id,
      },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: inactiveMember.id, organizationId, status: MembershipStatus.ACTIVE },
    });

    const noAccountMember = await prisma.member.create({
      data: {
        memberNo: `SCALE-NOACCOUNT-${++sequence}`,
        ...memberIdentityData('无账号队员'),
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: noAccountMember.id, organizationId, status: MembershipStatus.ACTIVE },
    });

    const otherOrg = await prisma.organization.create({
      data: { name: `外组织 ${++sequence}`, nodeTypeCode: 'scale-usability-other' },
      select: { id: true },
    });
    const outsiderMember = await prisma.member.create({
      data: {
        memberNo: `SCALE-OUTSIDER-${sequence}`,
        ...memberIdentityData('外组织队员'),
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.create({
      data: {
        username: `u-scale-outsider-${sequence}`,
        passwordHash: 'x',
        memberId: outsiderMember.id,
      },
    });
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: outsiderMember.id,
        organizationId: otherOrg.id,
        status: MembershipStatus.ACTIVE,
      },
    });

    // 改造前不截断时的可见集合(把 take 拿掉的那一版)。
    const expectedVisible = await prisma.member.findMany({
      where: {
        status: MemberStatus.ACTIVE,
        deletedAt: null,
        users: { some: { status: 'ACTIVE', deletedAt: null } },
        activityResponsibilities: { none: { activityId, status: 'active' } },
        OR: [
          { activityRegistrations: { some: { activityId, statusCode: 'pass', deletedAt: null } } },
          {
            memberOrganizationMemberships: {
              some: {
                organizationId,
                status: MembershipStatus.ACTIVE,
                deletedAt: null,
                startedAt: { lte: new Date() },
                OR: [{ endedAt: null }, { endedAt: { gt: new Date() } }],
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    // 翻遍所有页。
    const seen: string[] = [];
    let page = 1;
    for (;;) {
      const response = await getOptionsData(activityId, `?page=${page}&pageSize=100`);
      seen.push(...response.items.map((item) => item.id));
      if (response.items.length < 100) break;
      page += 1;
      expect(page).toBeLessThan(50); // 翻页不收敛就停,别把用例挂死
    }

    // 先钉两边非空 —— 空集 == 空集会静默变绿。
    expect(expectedVisible.length).toBeGreaterThan(LEGACY_HARD_CUT);
    expect(seen.length).toBeGreaterThan(LEGACY_HARD_CUT);
    // 比集合,不比计数。
    expect(new Set(seen)).toEqual(new Set(expectedVisible.map((row) => row.id)));
    expect(new Set(seen).size).toBe(seen.length); // 翻页不重复、不漏

    // 三个反面样本逐个确认不可见。
    expect(seen).toEqual(expect.arrayContaining(visible));
    expect(seen).not.toContain(inactiveMember.id);
    expect(seen).not.toContain(noAccountMember.id);
    expect(seen).not.toContain(outsiderMember.id);

    // 搜索也不得成为放宽可见范围的旁路:搜外组织队员的编号,照样搜不到。
    const outsider = await prisma.member.findUniqueOrThrow({
      where: { id: outsiderMember.id },
      select: { memberNo: true },
    });
    const searched = await getOptionsData(
      activityId,
      `?q=${encodeURIComponent(outsider.memberNo)}`,
    );
    expect(searched.total).toBe(0);
    expect(searched.items).toEqual([]);
  }, 240_000);

  // ==========================================================================
  // 不变量 3:查询次数固定
  // ==========================================================================

  it('不变量 3 —— SQL 次数不随候选人数、页大小或命中条数变化', async () => {
    const activityId = await createOwnedActivity();
    await createCandidates('queries', CANDIDATE_COUNT);

    const countSpy = jest.spyOn(prisma.member, 'count');
    const membersSpy = jest.spyOn(prisma.member, 'findMany');
    const registrationsSpy = jest.spyOn(prisma.activityRegistration, 'findMany');
    try {
      const probe = async (query: string): Promise<[number, number, number]> => {
        countSpy.mockClear();
        membersSpy.mockClear();
        registrationsSpy.mockClear();
        const response = await getOptions(activityId, query);
        expect(response.status).toBe(200);
        return [
          countSpy.mock.calls.length,
          membersSpy.mock.calls.length,
          registrationsSpy.mock.calls.length,
        ];
      };

      const smallPage = await probe('?pageSize=1');
      const fullPage = await probe('?pageSize=200');
      const emptyPage = await probe('?page=99');
      const searchHit = await probe('?q=candidate-does-not-exist-anywhere');

      // 每一格都恰好 1 次 —— 尤其是 registrations:空页也照发,不能省成条件分支,
      // 否则「查询次数」就随结果多少变了。变异:给它加 `if (ids.length === 0) return []`
      // 或把 eligibilitySource 改回整场次预取 ⇒ 这里红。
      expect(smallPage).toEqual([1, 1, 1]);
      expect(fullPage).toEqual([1, 1, 1]);
      expect(emptyPage).toEqual([1, 1, 1]);
      expect(searchHit).toEqual([1, 1, 1]);
    } finally {
      countSpy.mockRestore();
      membersSpy.mockRestore();
      registrationsSpy.mockRestore();
    }
  }, 180_000);

  // ==========================================================================
  // 不变量 2:不在内存里 filter / sort(结构判据 + 正对照)
  // ==========================================================================

  it('不变量 2 —— collaboratorOptions 的查询路径上没有「取全量再内存 filter/sort」', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/activities/app-managed-activities.service.ts'),
      'utf8',
    );
    const body = extractMethodSource(source, 'async collaboratorOptions(');

    // ---- 自证 ①:抽取器必须真的抽到方法体。参数表里的内联对象类型曾把天真版本骗停在
    // 签名处 —— 那时 `toContain` 恒假(看着像判据红了),而 `not.toContain` 恒真(判据变空)。
    expect(
      extractMethodSource(
        'class X { private async f(a: B & { c: string }): Promise<void> { return MARKER; } }',
        'private async f(',
      ),
    ).toContain('MARKER');

    // ---- 自证 ②:探测器对「内存过滤」的样本必须报阳,否则下面的阴性读数没有意义 ----
    const positiveControl = `
      const all = await this.prisma.member.findMany({ where });
      const hit = all.filter((m) => m.realName.includes(keyword)).sort((a, b) => 0);
      return { items: hit };
    `;
    expect(hasInMemoryFilterOrSort(positiveControl)).toBe(true);
    expect(
      hasInMemoryFilterOrSort('const rows = await this.prisma.member.findMany({ where });'),
    ).toBe(false);

    // ---- 再报数 ----
    expect(hasInMemoryFilterOrSort(body)).toBe(false);
    // 过滤与排序都必须交给 SQL:分页在 skip/take 上,搜索在 contains + insensitive 上。
    expect(body).toContain('skip: (page - 1) * pageSize');
    expect(body).toContain('take: pageSize');
    expect(body).toContain("mode: 'insensitive' as const");
    expect(body).toContain("orderBy: [{ memberNo: 'asc' }, { id: 'asc' }]");
    // 改造前那一版把整场次 pass 报名全量取进内存,现在必须收窄到当前页。
    expect(body).toContain('memberId: { in: members.map((member) => member.id) }');
  });
});

/** 「取回一批行之后在应用里 filter / sort」的字面形状。 */
function hasInMemoryFilterOrSort(body: string): boolean {
  return /\.\s*(filter|sort)\s*\(/u.test(body);
}
