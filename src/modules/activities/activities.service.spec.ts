import { Prisma, Role, UserStatus } from '@prisma/client';
import { validate } from 'class-validator';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateActivityDto,
  type CancelActivityDto,
  type ListActivitiesQueryDto,
  type UpdateActivityDto,
} from './activities.dto';
import { CreateAppManagedActivityDto } from './dto/app/app-managed-activity.dto';
import { ActivitiesService } from './activities.service';
import { ActivityAccessService } from './activity-access.service';
import { ActivityImageSigningService } from './activity-image-signing.service';
import type { ActivityAllocationModeService } from './activity-allocation-mode.service';
import { ActivityStatusCommandService } from './activity-status-command.service';
import { ActivityWriteService } from './activity-write.service';
import type { ActivityFromTemplateService } from './activity-from-template.service';
import type { ActivityAuditRecorder } from './activity-audit-recorder';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { ActivityStateDecision } from './activity-state-machine';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AuthzService } from '../authz/authz.service';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import type { ActivityNotificationProducer } from './activity-notification-producer';
import type { ActivityPublishReviewService } from './activity-publish-review.service';
import type { ConfigType } from '@nestjs/config';
import appConfig from '../../config/app.config';

jest.mock('./activity-waitlist-promotion', () => ({
  promoteActivityWaitlist: jest.fn().mockResolvedValue({ activityTitle: '测试活动', promoted: [] }),
}));

jest.mock('../activity-registrations/activity-cancellation-lifecycle', () => ({
  cancelActivityRegistrationLifecycle: jest
    .fn()
    .mockResolvedValue({ cancelledRegistrationCount: 0 }),
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
  initiatorMemberId: string | null;
  workflowRevision: number;
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
  // P2-14 刀 A:附件制四列。夹具必须带上它们 —— 真实 Prisma 行恒有这四列
  // (两个数组列有 DB 默认值 `{}`,migration 的等长 CHECK 还禁止它们为 NULL),
  // 夹具漏掉就会让签名层在测试里遇到生产上不可能出现的形状。
  coverImageKey: string | null;
  coverAttachmentId: string | null;
  galleryImageKeys: string[];
  galleryAttachmentIds: string[];
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
    initiatorMemberId: null,
    workflowRevision: 0,
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
    coverImageKey: null,
    coverAttachmentId: null,
    galleryImageKeys: [],
    galleryAttachmentIds: [],
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
    allocationModeCode: 'first_come',
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

describe('activity allocation mode DTO contract', () => {
  it('keeps Admin and physically independent App create payloads required and closed', async () => {
    const adminMissing = Object.assign(new CreateActivityDto(), makeCreateDto());
    delete (adminMissing as Partial<CreateActivityDto>).allocationModeCode;
    const appMissing = Object.assign(new CreateAppManagedActivityDto(), {
      title: 'App activity',
      activityTypeCode: 'rescue',
      organizationId: 'org-1',
      startAt: '2099-01-01T00:00:00.000Z',
      endAt: '2099-01-02T00:00:00.000Z',
      location: 'HQ',
    });
    const appInvalid = Object.assign(new CreateAppManagedActivityDto(), {
      ...appMissing,
      allocationModeCode: 'not-an-allocation-mode',
    });

    const [adminErrors, appMissingErrors, appInvalidErrors] = await Promise.all([
      validate(adminMissing),
      validate(appMissing),
      validate(appInvalid),
    ]);

    expect(adminErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'allocationModeCode' })]),
    );
    expect(appMissingErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'allocationModeCode' })]),
    );
    expect(appInvalidErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'allocationModeCode' })]),
    );
  });
});

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
  // 统一通知 L2:cancel 在同一事务内读取收件人并 enqueue durable intent；
  // 默认空(无报名者 → 零 intent),旧 characterization 用例不关心通知内容。
  const activityRegistration = {
    findMany: jest.fn<Promise<Array<{ memberId: string }>>, [unknown]>().mockResolvedValue([]),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const attendanceSheet = {
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  // 第 5 批整单取消会在已持有 Activity 根锁后读取有效 PunchEvent 链；默认空链保持
  // 既有取消 characterization 的无现场事实前提，不改写它们原有的状态机/audit 断言。
  const attendancePunchEvent = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
  };
  const activityPublishReview = {
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  // 收件人冻结在 enqueue 前回捞既有 intent(冻结批次存在就读回、不重算)。
  // 默认空表 = 本次是首次冻结,与这些 characterization 原本的前提一致。
  const notificationOutboxIntent = {
    findMany: jest
      .fn<Promise<Array<{ destinationRef: string; payload: unknown }>>, [unknown]>()
      .mockResolvedValue([]),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $queryRaw = jest.fn().mockResolvedValue([{ id: 'act-1' }]);
  const prisma = {
    activityEmergencyInitiation: { findUnique: jest.fn().mockResolvedValue(null) },
    activity,
    dictItem,
    organization,
    activityRegistration,
    attendanceSheet,
    attendancePunchEvent,
    activityPublishReview,
    notificationOutboxIntent,
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

/** 从 producer mock 的第一次调用里取出冻结批次的收件人集合(比集合,不比计数)。 */
function frozenMemberIds(
  producerMethod: jest.Mock<Promise<void>, [unknown, Record<string, unknown>]>,
): readonly string[] {
  const input = producerMethod.mock.calls[0]?.[1];
  const cohort = input?.cohort as { memberIds?: readonly string[] } | undefined;
  if (cohort?.memberIds === undefined) throw new Error('producer 未收到冻结批次');
  return cohort.memberIds;
}

// PR-L2:durable producer mock；business + audit + intent 必须共用调用方 transaction。
function makeNotificationProducerMock() {
  return {
    enqueuePublished: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
    enqueueCancellation: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
    enqueueScheduleChange: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
    enqueueWaitlistPromotions: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
  };
}
type NotificationProducerMock = ReturnType<typeof makeNotificationProducerMock>;

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

function makeInitiationPolicyMock() {
  return {
    resolveInitiator: jest
      .fn<Promise<string>, [unknown, string, string | undefined, unknown?]>()
      .mockResolvedValue('member-initiator'),
    assertInitiatorEligible: jest
      .fn<Promise<void>, [unknown, string, string | null, unknown]>()
      .mockResolvedValue(undefined),
  };
}
type InitiationPolicyMock = ReturnType<typeof makeInitiationPolicyMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    stateMachine?: StateMachineMock;
    recorder?: RecorderMock;
    notificationProducer?: NotificationProducerMock;
    authz?: AuthzMock;
    organizations?: OrganizationsMock;
    insuranceRequirement?: InsuranceRequirementMock;
    initiationPolicy?: InitiationPolicyMock;
    workflowEnabled?: boolean;
  } = {},
): ActivitiesService {
  const stateMachine = opts.stateMachine ?? makeStateMachineMock(DENY_DECISION);
  const recorder = opts.recorder ?? makeRecorderMock();
  const notificationProducer = opts.notificationProducer ?? makeNotificationProducerMock();
  const authz = opts.authz ?? makeAuthzMock();
  const organizations = opts.organizations ?? makeOrganizationsMock();
  const insuranceRequirement = opts.insuranceRequirement ?? makeInsuranceRequirementMock();
  const initiationPolicy = opts.initiationPolicy ?? makeInitiationPolicyMock();
  // Phase 6-B 第三域第三刀:三个新类全部传**真实实例**并喂同一组 mock ——
  // 判权、域校验、建单改单与状态流转的行为锁必须走真实实现。mock 掉它们等于把本 spec 里
  // 全部 RBAC_FORBIDDEN / 字典校验 / 时间窗 / 状态机断言变成自说自话。
  // (presenter 已是模块级纯函数,不再需要注入 —— DTO mapping 断言直接走真实映射。)
  const rbacMock = makeRbacMock() as unknown as RbacService;
  const auditLogsMock = {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogsService;
  const publishReviewMock = {
    compatibilityPublish: jest.fn(),
    cancelPendingForActivity: jest.fn(),
    assertNoPendingChangeReview: jest.fn(),
  } as unknown as ActivityPublishReviewService;
  const allocationModesMock = {
    assertValidMode: jest.fn(),
    assertLockedActivityConsistent: jest.fn().mockResolvedValue(undefined),
  } as unknown as ActivityAllocationModeService;
  const configMock = {
    activityResponsibilityWorkflow: { enabled: opts.workflowEnabled ?? false },
  } as ConfigType<typeof appConfig>;
  // P2-14 刀 A:封面 / 图集对外是现签 URL。单测里签名层是 stub —— 但它**不能返回定值**,
  // 否则「读出侧到底走没走签名」在单测里不可观测。返回 key 派生值,让断言能区分
  // 「签过」与「原样吐 key」。真链路(含过期附件 → null)由 e2e 负责。
  const imagesMock = {
    signCover: jest.fn((row: { coverImageKey: string | null }) =>
      Promise.resolve({
        coverImageUrl: row.coverImageKey === null ? null : `/uploads/${row.coverImageKey}?sig=stub`,
      }),
    ),
    signCovers: jest.fn((rows: Array<{ coverImageKey: string | null }>) =>
      Promise.resolve(
        rows.map((row) => ({
          coverImageUrl:
            row.coverImageKey === null ? null : `/uploads/${row.coverImageKey}?sig=stub`,
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
  const access = new ActivityAccessService(
    prisma as unknown as PrismaService,
    rbacMock,
    authz as unknown as AuthzService,
    imagesMock,
  );
  return new ActivitiesService(
    imagesMock,
    access,
    new ActivityWriteService(
      prisma as unknown as PrismaService,
      imagesMock,
      access,
      recorder as unknown as ActivityAuditRecorder,
      stateMachine,
      allocationModesMock,
      auditLogsMock,
      initiationPolicy as unknown as ActivityInitiationPolicy,
      insuranceRequirement as unknown as InsuranceRequirementService,
      notificationProducer as unknown as ActivityNotificationProducer,
      configMock,
    ),
    { createFromTemplate: jest.fn() } as unknown as ActivityFromTemplateService,
    new ActivityStatusCommandService(
      prisma as unknown as PrismaService,
      imagesMock,
      access,
      recorder as unknown as ActivityAuditRecorder,
      stateMachine,
      allocationModesMock,
      notificationProducer as unknown as ActivityNotificationProducer,
      publishReviewMock,
      configMock,
    ),
    prisma as unknown as PrismaService,
    stateMachine,
    recorder as unknown as ActivityAuditRecorder,
    auditLogsMock,
    rbacMock,
    authz as unknown as AuthzService,
    notificationProducer as unknown as ActivityNotificationProducer,
    organizations as unknown as OrganizationsService,
    insuranceRequirement as unknown as InsuranceRequirementService,
    initiationPolicy as unknown as ActivityInitiationPolicy,
    publishReviewMock,
    allocationModesMock,
    configMock,
  );
}

describe('ActivitiesService (characterization)', () => {
  // ============ A. DTO mapping / normalization(toResponseDto via findOne) ============
  describe('DTO mapping / normalization', () => {
    it('rich row → Decimal→string / json object 透传 / content object', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          locationLongitude: new Prisma.Decimal('116.404'),
          locationLatitude: new Prisma.Decimal('39.915'),
          registrationSchema: { fields: ['name'] },
          content: { blocks: [1] },
        }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.locationLongitude).toBe('116.404');
      expect(res.locationLatitude).toBe('39.915');
      expect(res.registrationSchema).toEqual({ fields: ['name'] });
      expect(res.content).toEqual({ blocks: [1] });
    });

    it('null 字段透传 null(Decimal / json 全 null)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.locationLongitude).toBeNull();
      expect(res.registrationSchema).toBeNull();
      expect(res.content).toBeNull();
    });

    it('json 不符型收窄为 null(schema 为数组 / content 为数组)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          registrationSchema: ['x'],
          content: ['y'],
        }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.registrationSchema).toBeNull();
      expect(res.content).toBeNull();
    });

    // ============ P2-14 刀 A:封面 / 图集不再从裸 URL 列派生 ============
    //
    // 改造前这里有三条断言刻画的是「`galleryImageUrls` JSON 列 → jsonAsStringArray →
    // 出参」(含「对象收窄为 null」「过滤非字符串元素」)。那条链路已被拆除:
    // 出参现在只由 `coverImageKey` / `galleryImageKeys` 现签而来。
    // 下面两条替换它们,并且**必须**能区分「签过」与「原样吐 key」——
    // 所以签名 stub 返回的是 key 派生值而不是定值。
    //
    // ⚠️ P2-14 刀 B(2026-08-25)后,那两列在 DB 上已经**不存在**了。
    // 下面夹具里仍塞进 `coverImageUrl` / `galleryImageUrls` 是**刻意的**:
    // 夹具是 `Record` 形状的手搓类型(不受 Prisma 生成物约束),塞进去等于问
    // 「就算有人把这两列加回来并接上线,出参会不会被污染」—— 断言因此比删列前更强,
    // 不是残留。
    // ⚠️ 原注解说「jsonAsStringArray 收窄行为仍在 activity-audit-recorder.ts 的私有副本里、
    // 由 audit characterization 覆盖」—— 该副本已随两列 DROP 一并移除;
    // 且全仓实测没有任何测试断言过审计快照里的这两个键(那句「由 audit characterization
    // 覆盖」当时就不成立)。

    it('封面 / 图集出参来自 key 现签,不来自裸 URL 遗留列', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          // 遗留列刻意塞入可辨识的值:它们**不得**出现在出参里。
          coverImageUrl: 'https://evil.example.com/hijacked.jpg',
          galleryImageUrls: ['https://evil.example.com/a.jpg'],
          coverImageKey: 'attachments/test/cover.jpg',
          galleryImageKeys: ['attachments/test/g1.jpg', 'attachments/test/g2.jpg'],
        }),
      );
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.coverImageUrl).toBe('/uploads/attachments/test/cover.jpg?sig=stub');
      expect(res.galleryImageUrls).toEqual([
        '/uploads/attachments/test/g1.jpg?sig=stub',
        '/uploads/attachments/test/g2.jpg?sig=stub',
      ]);
      // 遗留列的值一处都不许泄漏到出参。
      expect(JSON.stringify(res)).not.toContain('evil.example.com');
    });

    it('未设封面 / 图集 → 封面 null,图集空数组', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      const service = makeService(prisma);

      const res = await service.findOne('act-1', makeCurrentUser());

      expect(res.coverImageUrl).toBeNull();
      expect(res.galleryImageUrls).toEqual([]);
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

    // ⚠️ 本条**行为已变更**(2026-08-25 归档拍板②:「归档后默认不显示」)。
    //    原断言是「ADMIN 无入参 statusCode → 不加 statusCode 过滤」(where.statusCode 为
    //    undefined)。归档落地后那正是唯一会让已归档活动漏进管理端列表的那一格,
    //    因此它必须变成「排除 archived」。这不是放宽断言,是把契约改严并同步锁住。
    it('ADMIN 无入参 statusCode → 默认排除 archived(归档默认不显示)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeListQuery(), makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toEqual({ not: 'archived' });
    });

    it('ADMIN 无入参 statusCode + includeArchived=true → 不加 statusCode 过滤(勾了「显示已归档」)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeListQuery({ includeArchived: true }), makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toBeUndefined();
    });

    it('ADMIN + statusCode=archived → 按入参走(「只看已归档」是独立视图,不需要再勾一次)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(makeListQuery({ statusCode: 'archived' }), makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toBe('archived');
    });

    it('USER 角色 + includeArchived=true 仍拿不到 archived(Q-A7 白名单优先,勾选框撬不开)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      prisma.activity.count.mockResolvedValue(0);
      const service = makeService(prisma);

      await service.list(
        makeListQuery({ includeArchived: true, statusCode: 'archived' }),
        makeCurrentUser({ role: Role.USER }),
      );

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toEqual({ in: ['published', 'completed'] });
    });

    it('options 选择器与 list 同口径:默认排除 archived', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      const service = makeService(prisma);

      await service.options({}, makeCurrentUser());

      const arg = prisma.activity.findMany.mock.calls[0][0] as { where: { statusCode?: unknown } };
      expect(arg.where.statusCode).toEqual({ not: 'archived' });
    });

    it('options 选择器 + includeArchived=true → 不加 statusCode 过滤', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findMany.mockResolvedValue([]);
      const service = makeService(prisma);

      await service.options({ includeArchived: true }, makeCurrentUser());

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
    it('workflow=true 在 create 事务内执行统一发起资格策略', async () => {
      const prisma = makePrismaMock();
      const initiationPolicy = makeInitiationPolicyMock();
      prisma.dictItem.findFirst.mockResolvedValue({ id: 'di-type' });
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', parentId: 'root-1' });
      prisma.activity.create.mockResolvedValue(
        makeActivityRow({ statusCode: 'draft', initiatorMemberId: 'member-delegated' }),
      );
      initiationPolicy.resolveInitiator.mockResolvedValue('member-delegated');
      const service = makeService(prisma, { initiationPolicy, workflowEnabled: true });
      const user = makeCurrentUser({ memberId: 'member-operator' });

      await service.create(
        makeCreateDto({ initiatorMemberId: 'member-delegated' }),
        user,
        META,
        'managed',
      );

      expect(initiationPolicy.resolveInitiator).toHaveBeenCalledWith(
        user,
        'org-1',
        'member-delegated',
        prisma,
      );
      expect(initiationPolicy.resolveInitiator.mock.invocationCallOrder[0]).toBeGreaterThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
      expect(initiationPolicy.resolveInitiator.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.activity.create.mock.invocationCallOrder[0],
      );
    });

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
    it('workflow draft 真实改组织时在 Activity 锁后用持久化 initiator + tx 复核资格', async () => {
      const prisma = makePrismaMock();
      const initiationPolicy = makeInitiationPolicyMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'draft' });
      const current = makeActivityRow({
        statusCode: 'draft',
        organizationId: 'org-1',
        initiatorMemberId: 'member-persisted',
      });
      prisma.activity.findFirst.mockResolvedValue(current);
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-2', parentId: 'root-1' });
      prisma.activity.update.mockResolvedValue({ ...current, organizationId: 'org-2' });
      const user = makeCurrentUser({ memberId: 'member-persisted' });
      const service = makeService(prisma, {
        initiationPolicy,
        stateMachine,
        workflowEnabled: true,
      });

      await service.update(
        'act-1',
        makeUpdateDto({ organizationId: 'org-2' }),
        user,
        META,
        'managed',
      );

      expect(initiationPolicy.assertInitiatorEligible).toHaveBeenCalledWith(
        user,
        'org-2',
        'member-persisted',
        prisma,
      );
      expect(initiationPolicy.assertInitiatorEligible.mock.invocationCallOrder[0]).toBeGreaterThan(
        prisma.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    it('workflow draft organizationId 同值不调用发起资格策略', async () => {
      const prisma = makePrismaMock();
      const initiationPolicy = makeInitiationPolicyMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'draft' });
      const current = makeActivityRow({
        statusCode: 'draft',
        organizationId: 'org-1',
        initiatorMemberId: 'member-persisted',
      });
      prisma.activity.findFirst.mockResolvedValue(current);
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', parentId: 'root-1' });
      prisma.activity.update.mockResolvedValue(current);
      const service = makeService(prisma, {
        initiationPolicy,
        stateMachine,
        workflowEnabled: true,
      });

      await service.update(
        'act-1',
        makeUpdateDto({ organizationId: 'org-1' }),
        makeCurrentUser({ memberId: 'member-persisted' }),
        META,
        'managed',
      );

      expect(initiationPolicy.assertInitiatorEligible).not.toHaveBeenCalled();
    });

    it('workflow draft initiatorMemberId=null 时改组织 fail-closed', async () => {
      const prisma = makePrismaMock();
      const initiationPolicy = makeInitiationPolicyMock();
      initiationPolicy.assertInitiatorEligible.mockRejectedValue(
        new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL),
      );
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'draft',
          organizationId: 'org-1',
          initiatorMemberId: null,
        }),
      );
      prisma.organization.findFirst.mockResolvedValue({ id: 'org-2', parentId: 'root-1' });
      const service = makeService(prisma, {
        initiationPolicy,
        stateMachine: makeStateMachineMock({ allowed: true, nextStatusCode: 'draft' }),
        workflowEnabled: true,
      });

      await expect(
        service.update(
          'act-1',
          makeUpdateDto({ organizationId: 'org-2' }),
          makeCurrentUser({ role: Role.SUPER_ADMIN, memberId: 'member-operator' }),
          META,
          'managed',
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL));
      expect(initiationPolicy.assertInitiatorEligible).toHaveBeenCalledWith(
        expect.anything(),
        'org-2',
        null,
        prisma,
      );
      expect(prisma.activity.update).not.toHaveBeenCalled();
    });

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

    // ===== PR-L2:取消 → 同事务 durable intent fan-out =====
    it('PR-L2:取消 → 锁后收件集去重并在 audit 后同 tx enqueue', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const notificationProducer = makeNotificationProducerMock();
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
      const service = makeService(prisma, { stateMachine, notificationProducer });

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

      expect(notificationProducer.enqueueCancellation).toHaveBeenCalledTimes(1);
      expect(notificationProducer.enqueueCancellation).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          activityId: 'act-1',
          activityTitle: '周末巡山',
          cancelReason: '暴雨',
        }),
      );
      // 收件集从裸 `memberIds` 换成冻结批次:**同一批人**,多了「按什么算、什么时候算的」。
      expect(frozenMemberIds(notificationProducer.enqueueCancellation)).toEqual(['m1', 'm2']);
      const updateOrder = prisma.activity.update.mock.invocationCallOrder[0];
      const enqueueOrder = notificationProducer.enqueueCancellation.mock.invocationCallOrder[0];
      expect(enqueueOrder).toBeGreaterThan(updateOrder);
    });

    it('PR-L2:无已报名者 → producer 收空收件集，取消仍成功', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const notificationProducer = makeNotificationProducerMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      const service = makeService(prisma, { stateMachine, notificationProducer });

      const res = await service.cancel('act-1', makeCancelDto(), makeCurrentUser(), META);
      expect(res.statusCode).toBe('cancelled');
      expect(notificationProducer.enqueueCancellation).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ activityId: 'act-1' }),
      );
      expect(frozenMemberIds(notificationProducer.enqueueCancellation)).toEqual([]);
    });

    it('PR-L2:intent enqueue 失败 → 外抛给事务，禁止返回已提交取消', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      const notificationProducer = makeNotificationProducerMock();
      notificationProducer.enqueueCancellation.mockRejectedValue(new Error('intent failed'));
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ statusCode: 'published' }));
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'cancelled' }));
      prisma.activityRegistration.findMany.mockResolvedValue([
        { memberId: 'm1' },
        { memberId: 'm2' },
      ]);
      const service = makeService(prisma, { stateMachine, notificationProducer });

      await expect(
        service.cancel('act-1', makeCancelDto('原因'), makeCurrentUser(), META),
      ).rejects.toThrow('intent failed');
      expect(notificationProducer.enqueueCancellation).toHaveBeenCalledTimes(1);
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
      const notificationProducer = makeNotificationProducerMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'completed' });
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({
          statusCode: 'published',
          startAt: new Date('2020-01-01T00:00:00.000Z'),
          endAt: new Date('2020-01-02T00:00:00.000Z'),
        }),
      );
      prisma.activity.update.mockResolvedValue(makeActivityRow({ statusCode: 'completed' }));
      const service = makeService(prisma, { stateMachine, recorder, notificationProducer });

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
      expect(notificationProducer.enqueueCancellation).not.toHaveBeenCalled();
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
