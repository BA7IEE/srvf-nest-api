import type { PrismaService } from '../../database/prisma.service';
import { Role } from '@prisma/client';
import type { AuthzService } from '../authz/authz.service';
import { ActivityClosurePolicy } from './activity-closure-policy';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';
import { memberIdentityData } from '../../../test/helpers/member-identity.fixture';

// P2-14 刀 A:签名层 stub。返回 key 派生值而不是定值 —— 定值会让「读出侧到底走没走签名」
// 在单测里不可观测。真链路(含过期附件 → null)由 e2e 负责。
const imagesStub = {
  signCover: jest.fn((row: { coverImageKey: string | null }) =>
    Promise.resolve({
      coverImageUrl: row.coverImageKey === null ? null : `/uploads/${row.coverImageKey}?sig=stub`,
    }),
  ),
  signCovers: jest.fn((rows: Array<{ coverImageKey: string | null }>) =>
    Promise.resolve(
      rows.map((row) => ({
        coverImageUrl: row.coverImageKey === null ? null : `/uploads/${row.coverImageKey}?sig=stub`,
      })),
    ),
  ),
  signImages: jest.fn((row: { coverImageKey: string | null; galleryImageKeys: string[] }) =>
    Promise.resolve({
      coverImageUrl: row.coverImageKey === null ? null : `/uploads/${row.coverImageKey}?sig=stub`,
      galleryImageUrls: row.galleryImageKeys.map((key) => `/uploads/${key}?sig=stub`),
    }),
  ),
} as unknown as ActivityImageSigningService;

describe('ActivityWorkflowQueryService', () => {
  it('aggregates one page with two bulk groupBy queries instead of per-row reads', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `activity-${index}`,
      title: `Activity ${index}`,
      activityTypeCode: 'training',
      organizationId: 'org-1',
      startAt: new Date('2026-07-24T01:00:00.000Z'),
      endAt: new Date('2026-07-24T02:00:00.000Z'),
      location: '深圳',
      description: null,
      capacity: null,
      statusCode: 'completed',
      workflowRevision: 1,
      requiresInsurance: false,
      isPublicRegistration: true,
      attendanceDeclaredCompleteAt: new Date('2026-07-24T03:00:00.000Z'),
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T03:00:00.000Z'),
      initiator: null,
      responsibilityAssignments: [
        {
          memberId: 'member-1',
          responsibilityType: 'owner',
          canManageRegistrations: true,
          canManageAttendance: true,
          member: {
            id: 'member-1',
            memberNo: 'M001',
            ...memberIdentityData('Owner'),
            gradeCode: 'level-3',
          },
        },
      ],
      publishReviews: [],
      _count: { registrations: 0, attendanceSheets: 0 },
    }));
    const activityFindMany = jest.fn().mockResolvedValue(rows);
    const activityCount = jest.fn().mockResolvedValue(rows.length);
    const registrationGroupBy = jest.fn().mockResolvedValue([
      {
        activityId: 'activity-0',
        statusCode: 'pending',
        _count: { _all: 2 },
      },
    ]);
    const attendanceGroupBy = jest.fn().mockResolvedValue([
      {
        activityId: 'activity-0',
        statusCode: 'returned',
        _count: { _all: 1 },
      },
    ]);
    const prisma = {
      activity: { findMany: activityFindMany, count: activityCount },
      activityRegistration: { groupBy: registrationGroupBy },
      attendanceSheet: { groupBy: attendanceGroupBy },
      $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    } as unknown as PrismaService;
    const authz = {} as AuthzService;
    const service = new ActivityWorkflowQueryService(
      prisma,
      authz,
      new ActivityClosurePolicy(),
      imagesStub,
    );

    const result = await service.list('member-1', { page: 1, pageSize: 25 });

    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        pendingRegistrations: 2,
        unresolvedAttendanceSheets: 1,
        nextAction: '修改并重提退回考勤单',
      }),
    );
    expect(registrationGroupBy).toHaveBeenCalledTimes(1);
    expect(attendanceGroupBy).toHaveBeenCalledTimes(1);
    expect(activityFindMany).toHaveBeenCalledTimes(1);
    expect(activityCount).toHaveBeenCalledTimes(1);
  });

  // ===== 归档默认不显示(2026-08-25 拍板②)=====
  //
  // 🔴 判据形状:断言的是**交给 Prisma 的 `where`**,不是返回的行。
  //    mock 恒定返回固定行 ⇒ 用返回值断言的话,「查询被收窄」整类变异会被藏住
  //    (把 where 里的排除删掉,mock 照样吐同一批行,断言照样绿)。
  // 🔴 三格**各自成 `it`**:jest 首个失败即停,合并一格会让后两条在变异下根本不执行。
  describe('list — 归档默认不显示', () => {
    function makeListPrisma() {
      const activityFindMany = jest.fn().mockResolvedValue([]);
      const activityCount = jest.fn().mockResolvedValue(0);
      const prisma = {
        activity: { findMany: activityFindMany, count: activityCount },
        activityRegistration: { groupBy: jest.fn().mockResolvedValue([]) },
        attendanceSheet: { groupBy: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
      } as unknown as PrismaService;
      const service = new ActivityWorkflowQueryService(
        prisma,
        {} as AuthzService,
        new ActivityClosurePolicy(),
        imagesStub,
      );
      return { service, activityFindMany, activityCount };
    }

    function capturedWhere(fn: jest.Mock): { statusCode?: unknown } {
      const calls = fn.mock.calls as Array<[{ where: { statusCode?: unknown } }]>;
      const first = calls[0];
      if (first === undefined) throw new Error('activity 查询从未被调用');
      return first[0].where;
    }

    it('不传 statusCode → where 排除 archived', async () => {
      const { service, activityFindMany } = makeListPrisma();

      await service.list('member-1', { page: 1, pageSize: 20 });

      expect(capturedWhere(activityFindMany).statusCode).toEqual({ not: 'archived' });
    });

    it('count 与 findMany 共用同一份 where(否则 total 会把已归档算进去)', async () => {
      const { service, activityFindMany, activityCount } = makeListPrisma();

      await service.list('member-1', { page: 1, pageSize: 20 });

      expect(capturedWhere(activityCount)).toEqual(capturedWhere(activityFindMany));
      expect(capturedWhere(activityCount).statusCode).toEqual({ not: 'archived' });
    });

    it('includeArchived=true → 不加 statusCode 过滤(勾了「显示已归档」)', async () => {
      const { service, activityFindMany } = makeListPrisma();

      await service.list('member-1', { page: 1, pageSize: 20, includeArchived: true });

      expect(capturedWhere(activityFindMany).statusCode).toBeUndefined();
    });

    it('statusCode=archived → 按入参走,不被默认排除顶掉(「只看已归档」视图)', async () => {
      const { service, activityFindMany } = makeListPrisma();

      await service.list('member-1', { page: 1, pageSize: 20, statusCode: 'archived' });

      expect(capturedWhere(activityFindMany).statusCode).toBe('archived');
    });

    it('statusCode=draft → 按入参走(既有行为一格未动)', async () => {
      const { service, activityFindMany } = makeListPrisma();

      await service.list('member-1', { page: 1, pageSize: 20, statusCode: 'draft' });

      expect(capturedWhere(activityFindMany).statusCode).toBe('draft');
    });
  });

  describe('list — AC-004 长期未处理草稿在工作台提示', () => {
    function listWithRow(row: Record<string, unknown>) {
      const prisma = {
        activity: {
          findMany: jest.fn().mockResolvedValue([row]),
          count: jest.fn().mockResolvedValue(1),
        },
        activityRegistration: { groupBy: jest.fn().mockResolvedValue([]) },
        attendanceSheet: { groupBy: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
      } as unknown as PrismaService;
      return new ActivityWorkflowQueryService(
        prisma,
        {} as AuthzService,
        new ActivityClosurePolicy(),
        imagesStub,
      ).list('member-1', { page: 1, pageSize: 20 });
    }

    function draftRow(updatedAt: Date, statusCode = 'draft') {
      return {
        id: 'activity-stale',
        title: 'Stale draft',
        activityTypeCode: 'training',
        organizationId: 'org-1',
        startAt: new Date('2026-07-24T01:00:00.000Z'),
        endAt: new Date('2026-07-24T02:00:00.000Z'),
        location: '深圳',
        description: null,
        capacity: null,
        statusCode,
        workflowRevision: 1,
        requiresInsurance: false,
        isPublicRegistration: true,
        attendanceDeclaredCompleteAt: null,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        updatedAt,
        initiator: null,
        responsibilityAssignments: [],
        publishReviews: [],
        _count: { registrations: 0, attendanceSheets: 0 },
      };
    }

    it('闲置超过阈值的草稿 ⇒ staleDraft=true', async () => {
      const result = await listWithRow(draftRow(new Date('2020-01-01T00:00:00.000Z')));
      expect(result.items[0]?.staleDraft).toBe(true);
    });

    it('刚刚碰过的草稿 ⇒ staleDraft=false', async () => {
      const result = await listWithRow(draftRow(new Date()));
      expect(result.items[0]?.staleDraft).toBe(false);
    });

    it('非草稿(published)即使很久没碰也恒 false', async () => {
      const result = await listWithRow(draftRow(new Date('2020-01-01T00:00:00.000Z'), 'published'));
      expect(result.items[0]?.staleDraft).toBe(false);
    });
  });

  it('closure policy 把 archived 显示成 archived,而不是掉进「等待考勤声明」', () => {
    // 状态闭集扩张最典型的漏接:新值掉进 if 链末尾的兜底分支,把归档了的活动
    // 显示成「等待活动完结」还催人干活。这条钉住它。
    expect(
      new ActivityClosurePolicy().decide({
        statusCode: 'archived',
        endAt: new Date('2020-01-01T00:00:00.000Z'),
        attendanceDeclaredCompleteAt: null,
        latestPublishReviewStatus: null,
        attendance: { total: 0, pending: 0, returned: 0, pendingFinalReview: 0, unresolved: 0 },
      }),
    ).toEqual({ status: 'archived', nextAction: null });
  });

  it('returns allocation mode in the managed activity detail projection', async () => {
    const registrationGroupBy = jest.fn().mockResolvedValue([]);
    const attendanceGroupBy = jest.fn().mockResolvedValue([]);
    const prisma = {
      activityRegistration: { groupBy: registrationGroupBy },
      attendanceSheet: { groupBy: attendanceGroupBy },
    } as unknown as PrismaService;
    const service = new ActivityWorkflowQueryService(
      prisma,
      {} as AuthzService,
      new ActivityClosurePolicy(),
      imagesStub,
    );
    jest.spyOn(service, 'loadManaged').mockResolvedValue({
      id: 'activity-1',
      title: 'Allocation detail',
      activityTypeCode: 'training',
      allocationModeCode: 'lottery',
      organizationId: 'org-1',
      startAt: new Date('2026-07-24T01:00:00.000Z'),
      endAt: new Date('2026-07-24T02:00:00.000Z'),
      location: '深圳',
      description: null,
      capacity: null,
      statusCode: 'draft',
      workflowRevision: 1,
      requiresInsurance: false,
      isPublicRegistration: true,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultCheckInRadiusMeters: null,
      defaultLocationRequired: false,
      archiveWaitingDays: 0,
      // P2-14 刀 A:附件制两列(真实 Prisma 行恒有,数组列有 DB 默认值 `{}`)。
      coverImageKey: null,
      galleryImageKeys: [],
      attendanceDeclaredCompleteAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T03:00:00.000Z'),
      initiator: null,
      responsibilityAssignments: [],
      publishReviews: [],
    } as never);

    const result = await service.detail('activity-1', 'member-1', { role: Role.USER } as never);

    expect(result.activity).toEqual(expect.objectContaining({ allocationModeCode: 'lottery' }));
  });
});
