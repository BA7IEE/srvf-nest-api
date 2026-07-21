import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  CancelActivityDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivitiesService } from './activities.service';
import type { ActivityAuditRecorder } from './activity-audit-recorder';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { ActivityStateDecision } from './activity-state-machine';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AuthzService } from '../authz/authz.service';

jest.mock('./activity-waitlist-promotion', () => ({
  promoteActivityWaitlist: jest.fn().mockResolvedValue({ activityTitle: '测试活动', promoted: [] }),
}));

// activities service-level characterization spec(B 档 test-only,沿 srvf-god-service-refactor）。
// 锁定 `activities.service.ts`(607L,L 体量)内部「编排契约」现状行为,作为后续
// Presenter / QueryService 抽离前的快速重构护栏。
//
// 风格沿 src/modules/activity-registrations/activity-registrations.service.spec.ts
//      + src/modules/attachments/attachments.service.spec.ts:
// - 纯构造器注入 mock,不使用 NestJS TestingModule、不连库、不起 Nest。
// - $transaction mock 同时支持 callback(create/update/softDelete/publish/cancel)与
//   array(list)两种用法。
//
// 边界(本 spec 只到 service 编排层;不改任何业务代码 / BizCode / audit event 名):
// - 不测 ActivityStateMachine 内部状态矩阵(mock decide;矩阵归 state-transition e2e)。
// - 不测 ActivityAuditRecorder 内部 snapshot 组装(只断言被调用入参;snapshot 归 audit-characterization e2e)。
// - 不测 AppActivitiesService / AppMyActivitiesService(独立类,非本 service)。
// - 不复刻 HTTP / Guard / Prisma 集成 / 完整 e2e。

// ============ 固定 fixture ============

const FIXED_START = new Date('2099-01-01T00:00:00.000Z');
const FIXED_END = new Date('2099-01-02T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-act-1', ip: '127.0.0.1', ua: 'jest' };

// 占位 decision:list / findOne / create / softDelete 不调用 state machine,用它兜底。
const DENY_DECISION: ActivityStateDecision = {
  allowed: false,
  biz: BizCode.ACTIVITY_STATUS_INVALID,
};

// ============ 行形(= activitySafeSelect 27 字段;list select 为其子集) ============

interface ActivityRow {
  id: string;
  title: string;
  activityTypeCode: string;
  organizationId: string;
  startAt: Date;
  endAt: Date;
  location: string;
  description: string | null;
  capacity: number | null;
  genderRequirementCode: string | null;
  registrationDeadline: Date | null;
  registrationNotes: string | null;
  statusCode: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  isPublicRegistration: boolean;
  requiresInsurance: boolean;
  registrationSchema: Prisma.JsonValue | null;
  coverImageUrl: string | null;
  galleryImageUrls: Prisma.JsonValue | null;
  content: Prisma.JsonValue | null;
  locationLongitude: Prisma.Decimal | null;
  locationLatitude: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
  activityPositions: Array<{ capacity: number | null }>;
}

function makeActivityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'act-1',
    title: 'Rescue Drill',
    activityTypeCode: 'rescue',
    organizationId: 'org-1',
    startAt: FIXED_START,
    endAt: FIXED_END,
    location: 'HQ',
    description: null,
    capacity: null,
    genderRequirementCode: null,
    registrationDeadline: null,
    registrationNotes: null,
    statusCode: 'draft',
    publishedBy: null,
    publishedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    isPublicRegistration: false,
    requiresInsurance: false,
    registrationSchema: null,
    coverImageUrl: null,
    galleryImageUrls: null,
    content: null,
    locationLongitude: null,
    locationLatitude: null,
    createdAt: FIXED_START,
    updatedAt: FIXED_START,
    activityPositions: [],
    ...overrides,
  };
}

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'admin-1',
    username: 'admin',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

// ============ DTO 工厂(只填 service 实际读取的字段;结构性 cast) ============

function makeCreateDto(overrides: Partial<Record<string, unknown>> = {}): CreateActivityDto {
  return {
    title: 'New Activity',
    activityTypeCode: 'rescue',
    organizationId: 'org-1',
    startAt: '2099-01-01T00:00:00.000Z',
    endAt: '2099-01-02T00:00:00.000Z',
    location: 'HQ',
    ...overrides,
  };
}

function makeUpdateDto(overrides: Partial<Record<string, unknown>> = {}): UpdateActivityDto {
  return { title: 'Updated Title', ...overrides };
}

function makeCancelDto(cancelReason?: string): CancelActivityDto {
  return cancelReason === undefined ? {} : { cancelReason };
}

function makeListQuery(overrides: Partial<Record<string, unknown>> = {}): ListActivitiesQueryDto {
  return { page: 1, pageSize: 20, ...overrides };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const activity = {
    findFirst: jest.fn<Promise<ActivityRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<ActivityRow[]>, [unknown]>(),
    create: jest.fn<Promise<ActivityRow>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
    update: jest.fn<Promise<ActivityRow>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
  };
  const dictItem = { findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>() };
  const organization = {
    findFirst: jest.fn<Promise<{ id: string; parentId: string | null } | null>, [unknown]>(),
  };
  // 统一通知 S4:cancel 后 commit 外的 fan-out helper 读已报名者(this.prisma.activityRegistration.findMany);
  // 默认空(无报名者 → 零派发),旧 characterization 用例不关心(helper try-catch 永不抛,断言零影响)。
  const activityRegistration = {
    findMany: jest.fn<Promise<Array<{ memberId: string }>>, [unknown]>().mockResolvedValue([]),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const attendanceSheet = {
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $queryRaw = jest.fn().mockResolvedValue([{ id: 'act-1' }]);
  const prisma = {
    activity,
    dictItem,
    organization,
    activityRegistration,
    attendanceSheet,
    $queryRaw,
    $transaction,
  };
  // 双模:回调式把 prisma mock 自身当 tx 传入(service 在 tx 与 this.prisma 上调同名方法);
  // 数组式($transaction([findMany, count]))走 Promise.all。
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeStateMachineMock(decision: ActivityStateDecision) {
  return {
    decide: jest.fn<ActivityStateDecision, [string, string?]>().mockReturnValue(decision),
  };
}
type StateMachineMock = ReturnType<typeof makeStateMachineMock>;

function makeRecorderMock() {
  return {
    logCreate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logUpdate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logSoftDelete: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logPublish: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logCancel: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logComplete: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
}
type RecorderMock = ReturnType<typeof makeRecorderMock>;

// Slow-4 T3(2026-06-11,评审稿 D-S4-6):service 构造函数注入 rbac mock,`can` 恒 true
// (本 spec 锁业务行为而非判权;判权矩阵由 e2e 权限边界 spec 锁定)。断言零修改。
function makeRbacMock() {
  return { can: jest.fn<Promise<boolean>, [unknown, string]>().mockResolvedValue(true) };
}

// 终态 scoped-authz PR12(2026-07-02):authz mock —— explain 默认 allow(matched),既有
// characterization 断言零修改(判权切换不动业务行为);风格镜像 attendances.service.spec.ts
// 的 makeAuthzMock(PR9 先例)。
function makeAuthzMock(
  decision: { allow: boolean; reason: string } = { allow: true, reason: 'matched' },
) {
  return {
    explain: jest
      .fn<Promise<{ allow: boolean; reason: string }>, [unknown, string, unknown]>()
      .mockResolvedValue(decision),
  };
}
type AuthzMock = ReturnType<typeof makeAuthzMock>;

// 统一通知 S4:派发器 mock —— dispatchTargeted 默认 resolve;cancel fan-out 用例可注入 reject
// 验证「派发失败不破坏取消」,或断言逐报名者入参(recipientMemberId / channels)。
function makeNotificationDispatcherMock() {
  return {
    dispatchTargeted: jest
      .fn<Promise<{ id: string }>, [Record<string, unknown>]>()
      .mockResolvedValue({ id: 'notif-1' }),
    dispatchSystemMemberBroadcast: jest
      .fn<Promise<{ id: string }>, [Record<string, unknown>]>()
      .mockResolvedValue({ id: 'notif-broadcast-1' }),
  };
}
type NotificationDispatcherMock = ReturnType<typeof makeNotificationDispatcherMock>;

// F1/A6(路线图 §4;D7 拍板):organizations mock —— 仅 queryDescendantOrgIds 供
// includeDescendants 展开,既有 characterization 断言零修改(未传 includeDescendants 时不调用)。
function makeOrganizationsMock() {
  return {
    queryDescendantOrgIds: jest.fn<Promise<string[]>, [string]>().mockResolvedValue([]),
  };
}
type OrganizationsMock = ReturnType<typeof makeOrganizationsMock>;

function makeInsuranceRequirementMock() {
  return {
    assertActivityInsuranceLifecycleMutable: jest
      .fn<Promise<void>, [unknown, unknown, unknown]>()
      .mockResolvedValue(undefined),
  };
}
type InsuranceRequirementMock = ReturnType<typeof makeInsuranceRequirementMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    stateMachine?: StateMachineMock;
    recorder?: RecorderMock;
    dispatcher?: NotificationDispatcherMock;
    authz?: AuthzMock;
    organizations?: OrganizationsMock;
    insuranceRequirement?: InsuranceRequirementMock;
  } = {},
): ActivitiesService {
  const stateMachine = opts.stateMachine ?? makeStateMachineMock(DENY_DECISION);
  const recorder = opts.recorder ?? makeRecorderMock();
  const dispatcher = opts.dispatcher ?? makeNotificationDispatcherMock();
  const authz = opts.authz ?? makeAuthzMock();
  const organizations = opts.organizations ?? makeOrganizationsMock();
  const insuranceRequirement = opts.insuranceRequirement ?? makeInsuranceRequirementMock();
  return new ActivitiesService(
    prisma as unknown as PrismaService,
    stateMachine,
    recorder as unknown as ActivityAuditRecorder,
    { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService,
    makeRbacMock() as unknown as RbacService,
    authz as unknown as AuthzService,
    dispatcher as unknown as NotificationDispatcher,
    organizations as unknown as OrganizationsService,
    insuranceRequirement as unknown as InsuranceRequirementService,
  );
}

describe('ActivitiesService (characterization)', () => {
  // ============ A. DTO mapping / normalization(toResponseDto via findOne) ============
  describe('DTO mapping / normalization', () => {
    it('rich row → Decimal→string / json object 透传 / gallery→string[] / content object', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          locationLongitude: new Prisma.Decimal('116.404'),
          locationLatitude: new Prisma.Decimal('39.915'),
          registrationSchema: { fields: ['name'] },
          galleryImageUrls: ['x.jpg', 'y.jpg'],
          content: { blocks: [1] },
        }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.locationLongitude).toBe('116.404');
      expect(res.locationLatitude).toBe('39.915');
      expect(res.registrationSchema).toEqual({ fields: ['name'] });
      expect(res.galleryImageUrls).toEqual(['x.jpg', 'y.jpg']);
      expect(res.content).toEqual({ blocks: [1] });
    });

    it('null 字段透传 null(Decimal / json 全 null)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.locationLongitude).toBeNull();
      expect(res.registrationSchema).toBeNull();
      expect(res.galleryImageUrls).toBeNull();
      expect(res.content).toBeNull();
    });

    it('json 不符型收窄为 null(schema 为数组 / gallery 为对象 / content 为数组)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          registrationSchema: ['x'],
          galleryImageUrls: { a: 1 },
          content: ['y'],
        }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.registrationSchema).toBeNull();
      expect(res.galleryImageUrls).toBeNull();
      expect(res.content).toBeNull();
    });

    it('galleryImageUrls 过滤非字符串元素', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({ statusCode: 'published', galleryImageUrls: ['a', 123, 'b', null] }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.galleryImageUrls).toEqual(['a', 'b']);
    });
  });

  // ============ B. list:Role 状态过滤(scope) ============
  describe('list — role-based status filter', () => {
    it('USER 角色 → 强制 statusCode ∈ {published, completed},忽略入参 statusCode', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([makeActivityRow({ statusCode: 'published' })]);
      prisma.activity.count.mockResolvedValue(1);
      const service = makeService(prisma);

      const page = await service.list(
        makeListQuery({ statusCode: 'draft' }),
        makeCurrentUser({ role: Role.USER }),
      );

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toEqual({ in: ['published', 'completed'] });
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
    });

    it('ADMIN + 入参 statusCode → 使用入参', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeListQuery({ statusCode: 'draft' }), makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toBe('draft');
    });

    it('ADMIN 无入参 statusCode → 不加 statusCode 过滤', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeListQuery(), makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toBeUndefined();
    });
  });

  // ============ C. findOne:可见性 ============
  describe('findOne — visibility', () => {
    it('不存在 → ACTIVITY_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne('missing', makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
    });

    it('USER 看 draft → ACTIVITY_NOT_FOUND(存在性隐藏)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'draft' }));
      const service = makeService(prisma);

      await expect(service.findOne('act-1', makeCurrentUser({ role: Role.USER }))).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
    });

    it('USER 看 published → 返回 dto', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser({ role: Role.USER }));
      expect(res.id).toBe('act-1');
      expect(res.statusCode).toBe('published');
    });

    it('ADMIN 看 draft → 返回 dto(管理面可见全部)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'draft' }));
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());
      expect(res.statusCode).toBe('draft');
    });
  });

  // ============ D. create:校验链 fail-fast ============
  describe('create — validation chain', () => {
    it('startAt >= endAt → ACTIVITY_START_END_INVALID;不开事务 / 不写库', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const service = makeService(prisma, { recorder });

      await expect(
        service.create(
          makeCreateDto({ startAt: '2026-01-02T00:00:00.000Z', endAt: '2026-01-01T00:00:00.000Z' }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_START_END_INVALID));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.activity.create).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });

    it('activityTypeCode 无效 → ACTIVITY_TYPE_CODE_INVALID;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.dictItem.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.create(makeCreateDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_TYPE_CODE_INVALID),
      );
      expect(prisma.activity.create).not.toHaveBeenCalled();
    });

    it('genderRequirementCode 无效 → ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID;不写库', async () => {
      const prisma = makePrismaMock();
      // 第 1 次 dictItem.findFirst(activity_type)通过;第 2 次(gender)null。
      prisma.dictItem.findFirst
        .mockResolvedValueOnce({ id: 'di-type' })
        .mockResolvedValueOnce(null);
      const service = makeService(prisma);

      await expect(
        service.create(makeCreateDto({ genderRequirementCode: 'male' }), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID));
      expect(prisma.activity.create).not.toHaveBeenCalled();
    });

    it('organization 不存在 → ORGANIZATION_NOT_FOUND;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.organization.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.create(makeCreateDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ORGANIZATION_NOT_FOUND),
      );
      expect(prisma.activity.create).not.toHaveBeenCalled();
    });

    it('organization 为根节点(parentId null)→ ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', parentId: null });
      const service = makeService(prisma);

      await expect(service.create(makeCreateDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN),
      );
      expect(prisma.activity.create).not.toHaveBeenCalled();
    });

    it('happy → 事务内 create(statusCode=draft)+ logCreate(nextStatusCode=draft, tx);返 dto', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', parentId: 'root-1' });
      prisma.activity.create.mockResolvedValue(makeActivityRow({ statusCode: 'draft' }));
      const service = makeService(prisma, { recorder });

      const res = await service.create(makeCreateDto(), makeCurrentUser({ id: 'admin-1' }), META);

      expect(prisma.activity.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.activity.create.mock.calls[0][0] as { data: { statusCode: string } };
      expect(createArg.data.statusCode).toBe('draft');
      expect(recorder.logCreate).toHaveBeenCalledWith(
        expect.objectContaining({ nextStatusCode: 'draft', actorUserId: 'admin-1', tx: prisma }),
      );
      expect(res.statusCode).toBe('draft');
    });
  });

  // ============ E. update:state-machine + audit 接线 ============
  describe('update — state-machine & audit wiring', () => {
    it('cancelled 拒改 → 抛 decision.biz;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      const service = makeService(prisma, { stateMachine, recorder });

      await expect(
        service.update('act-1', makeUpdateDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith('update', 'cancelled');
      expect(prisma.activity.update).not.toHaveBeenCalled();
      expect(recorder.logUpdate).not.toHaveBeenCalled();
    });

    it('allowed → update 写库;logUpdate(priorStatusCode / changedFields / tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'published' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(
        makeActivityRow({ statusCode: 'published', title: 'Updated Title' }),
      );
      const service = makeService(prisma, { stateMachine, recorder });

      const res = await service.update('act-1', makeUpdateDto(), makeCurrentUser(), META);

      expect(stateMachine.decide).toHaveBeenCalledWith('update', 'published');
      expect(prisma.activity.update).toHaveBeenCalledTimes(1);
      expect(recorder.logUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          priorStatusCode: 'published',
          changedFields: ['title'],
          tx: prisma,
        }),
      );
      expect(res.title).toBe('Updated Title');
    });

    it('保险生命周期守卫在 Activity 锁后、写入前失败 → 零 update / audit', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const insuranceRequirement = makeInsuranceRequirementMock();
      insuranceRequirement.assertActivityInsuranceLifecycleMutable.mockRejectedValue(
        new BizException(BizCode.ACTIVITY_STATUS_INVALID),
      );
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({ statusCode: 'published', requiresInsurance: true }),
      );
      const service = makeService(prisma, {
        stateMachine: makeStateMachineMock({ allowed: true, nextStatusCode: 'published' }),
        recorder,
        insuranceRequirement,
      });

      await expect(
        service.update(
          'act-1',
          makeUpdateDto({ requiresInsurance: false }),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));

      expect(insuranceRequirement.assertActivityInsuranceLifecycleMutable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'act-1', requiresInsurance: true }),
        expect.objectContaining({
          requiresInsurance: false,
          startAt: FIXED_START,
        }),
        prisma,
      );
      expect(
        insuranceRequirement.assertActivityInsuranceLifecycleMutable.mock.invocationCallOrder[0],
      ).toBeGreaterThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
      expect(prisma.activity.update).not.toHaveBeenCalled();
      expect(recorder.logUpdate).not.toHaveBeenCalled();
    });
  });

  // ============ F. publish:state-machine 接线 ============
  describe('publish — state-machine wiring', () => {
    it('非 draft → 抛 decision.biz;不 update', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma, { stateMachine });

      await expect(
        service.publish('act-1', { requiresInsuranceConfirmed: true }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith('publish', 'published');
      expect(prisma.activity.update).not.toHaveBeenCalled();
    });

    it('draft → update statusCode=published + publishedBy;logPublish(prior/next)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'published' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'draft' }));
      prisma.activity.update.mockResolvedValue(
        makeActivityRow({ statusCode: 'published', publishedBy: 'admin-1' }),
      );
      const service = makeService(prisma, { stateMachine, recorder });

      const res = await service.publish(
        'act-1',
        { requiresInsuranceConfirmed: true },
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      const updateArg = prisma.activity.update.mock.calls[0][0] as {
        data: { statusCode: string; publishedBy: string };
      };
      expect(updateArg.data.statusCode).toBe('published');
      expect(updateArg.data.publishedBy).toBe('admin-1');
      expect(recorder.logPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          priorStatusCode: 'draft',
          nextStatusCode: 'published',
          tx: prisma,
        }),
      );
      expect(res.statusCode).toBe('published');
    });
  });

  // ============ G. cancel:state-machine + cancelReason 兜底 ============
  describe('cancel — state-machine & cancelReason', () => {
    it('已 cancelled → 抛 decision.biz;不 update', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      const service = makeService(prisma, { stateMachine });

      await expect(
        service.cancel('act-1', makeCancelDto('dup'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith('cancel', 'cancelled');
      expect(prisma.activity.update).not.toHaveBeenCalled();
    });

    it('allowed + 有 cancelReason → update / logCancel 透传 reason', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      const service = makeService(prisma, { stateMachine, recorder });

      await service.cancel('act-1', makeCancelDto('weather'), makeCurrentUser(), META);

      const updateArg = prisma.activity.update.mock.calls[0][0] as {
        data: { statusCode: string; cancelReason: string | null };
      };
      expect(updateArg.data.statusCode).toBe('cancelled');
      expect(updateArg.data.cancelReason).toBe('weather');
      expect(recorder.logCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          cancelReason: 'weather',
          nextStatusCode: 'cancelled',
          tx: prisma,
        }),
      );
    });

    it('allowed + 无 cancelReason → 兜底 null(update + logCancel 均 null)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      const service = makeService(prisma, { stateMachine, recorder });

      await service.cancel('act-1', makeCancelDto(), makeCurrentUser(), META);

      const updateArg = prisma.activity.update.mock.calls[0][0] as {
        data: { cancelReason: string | null };
      };
      expect(updateArg.data.cancelReason).toBeNull();
      expect(recorder.logCancel).toHaveBeenCalledWith(
        expect.objectContaining({ cancelReason: null }),
      );
    });

    // ===== 统一通知 S4(评审稿 §6.4 / §6.2):取消 → 已报名者 fan-out 定向通知 =====
    it('S4:取消 → fan-out 已报名者(pending+pass+waitlisted,去重)各一条 directed/in-app/activity-changed(含活动名+原因);事务外', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const dispatcher = makeNotificationDispatcherMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(
        makeActivityRow({ statusCode: 'cancelled', title: '周末巡山' }),
      );
      // 三行(含同 member 重复)→ 去重为 2 收件人
      prisma.activityRegistration.findMany.mockResolvedValue([
        { memberId: 'm1' },
        { memberId: 'm2' },
        { memberId: 'm1' },
      ]);
      const service = makeService(prisma, { stateMachine, dispatcher });

      await service.cancel('act-1', makeCancelDto('暴雨'), makeCurrentUser(), META);

      // 收件人查询:仅 pending+pass + 未软删
      const findArg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: { statusCode: { in: string[] }; deletedAt: null };
      };
      expect(findArg.where.statusCode.in).toEqual(['pending', 'pass', 'waitlisted']);
      expect(findArg.where.deletedAt).toBeNull();

      // 收件集必须在 Activity claim 之后读取，锁定 R5-01 的事务内时序。
      const claimOrder = prisma.$queryRaw.mock.invocationCallOrder[0];
      const recipientReadOrder = prisma.activityRegistration.findMany.mock.invocationCallOrder[0];
      expect(recipientReadOrder).toBeGreaterThan(claimOrder);

      // 去重后 2 派发,各 directed in-app activity-changed + 活动名 + 原因
      expect(dispatcher.dispatchTargeted).toHaveBeenCalledTimes(2);
      const recipients = dispatcher.dispatchTargeted.mock.calls.map((c) => c[0].recipientMemberId);
      expect(new Set(recipients)).toEqual(new Set(['m1', 'm2']));
      for (const [arg] of dispatcher.dispatchTargeted.mock.calls) {
        expect(arg).toMatchObject({
          notificationTypeCode: 'activity-changed',
          channels: ['in-app'],
          title: '活动已取消',
        });
        expect(arg.body).toContain('周末巡山');
        expect(arg.body).toContain('暴雨');
      }

      // 事务外硬证:首个派发严格在 activity.update(事务内)之后(commit 后才 fan-out)
      const updateOrder = prisma.activity.update.mock.invocationCallOrder[0];
      const dispatchOrder = dispatcher.dispatchTargeted.mock.invocationCallOrder[0];
      expect(dispatchOrder).toBeGreaterThan(updateOrder);
    });

    it('S4:无已报名者 → 零派发(取消仍成功)', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const dispatcher = makeNotificationDispatcherMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      const service = makeService(prisma, { stateMachine, dispatcher });

      const res = await service.cancel('act-1', makeCancelDto(), makeCurrentUser(), META);
      expect(res.statusCode).toBe('cancelled');
      expect(dispatcher.dispatchTargeted).not.toHaveBeenCalled();
    });

    it('S4:某收件人派发失败 → 其余仍派发 + 取消仍成功(整体 try-catch 永不抛)', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const dispatcher = makeNotificationDispatcherMock();
      dispatcher.dispatchTargeted
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ id: 'notif-2' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      prisma.activityRegistration.findMany.mockResolvedValue([
        { memberId: 'm1' },
        { memberId: 'm2' },
      ]);
      const service = makeService(prisma, { stateMachine, dispatcher });

      const res = await service.cancel('act-1', makeCancelDto('原因'), makeCurrentUser(), META);
      expect(res.statusCode).toBe('cancelled'); // 业务成功(派发失败被吞)
      expect(dispatcher.dispatchTargeted).toHaveBeenCalledTimes(2); // 单人失败不阻断其余
    });
  });

  // ============ G2. complete:state-machine 接线(v0.40.0)============
  describe('complete — state-machine wiring', () => {
    it('非 published → 抛 decision.biz;不 update', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'draft' }));
      const service = makeService(prisma, { stateMachine });

      await expect(service.complete('act-1', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_STATUS_INVALID),
      );
      expect(stateMachine.decide).toHaveBeenCalledWith('complete', 'draft');
      expect(prisma.activity.update).not.toHaveBeenCalled();
    });

    it('published → update statusCode=completed;logComplete(prior/next);无通知派发', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const dispatcher = makeNotificationDispatcherMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'completed' });
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          startAt: new Date('2020-01-01T00:00:00.000Z'),
          endAt: new Date('2020-01-02T00:00:00.000Z'),
        }),
      );
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'completed' }));
      const service = makeService(prisma, { stateMachine, recorder, dispatcher });

      const res = await service.complete('act-1', makeCurrentUser({ id: 'admin-1' }), META);

      const updateArg = prisma.activity.update.mock.calls[0][0] as {
        data: { statusCode: string };
      };
      expect(updateArg.data.statusCode).toBe('completed');
      expect(recorder.logComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          priorStatusCode: 'published',
          nextStatusCode: 'completed',
          tx: prisma,
        }),
      );
      // complete 不发通知(区别于 cancel 的 fan-out)
      expect(dispatcher.dispatchTargeted).not.toHaveBeenCalled();
      expect(res.statusCode).toBe('completed');
    });
  });

  // ============ H. softDelete:audit 接线,不走 state machine ============
  describe('softDelete — audit wiring, no state machine', () => {
    it('happy → update deletedAt + logSoftDelete(priorStatusCode / tx);**不**调 state machine', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma, { stateMachine, recorder });

      await service.softDelete('act-1', makeCurrentUser(), META);

      const updateArg = prisma.activity.update.mock.calls[0][0] as { data: { deletedAt: unknown } };
      expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
      expect(recorder.logSoftDelete).toHaveBeenCalledWith(
        expect.objectContaining({ priorStatusCode: 'published', tx: prisma }),
      );
      expect(stateMachine.decide).not.toHaveBeenCalled();
    });

    it('不存在 → ACTIVITY_NOT_FOUND;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { recorder });

      await expect(service.softDelete('missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
      expect(prisma.activity.update).not.toHaveBeenCalled();
      expect(recorder.logSoftDelete).not.toHaveBeenCalled();
    });
  });
});
