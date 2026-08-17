import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AuthzService } from '../authz/authz.service';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import type { ActivityAllocationService } from './activity-allocation.service';
import type { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import type { ActivityQualificationEvaluatorService } from './activity-qualification-evaluator.service';
import type { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';
import { ActivityRegistrationPresenter } from './activity-registration-presenter';
import { ActivityRegistrationQueryService } from './activity-registration-query.service';
import type { ActivityRegistrationTransitionDecision } from './activity-registration-state-machine';
import type { ActivityRegistrationWaitlistQueryService } from './activity-registration-waitlist-query.service';
import { ActivityRegistrationAccessService } from './activity-registration-access.service';
import { ActivityRegistrationCreateService } from './activity-registration-create.service';
import { ActivityRegistrationReviewService } from './activity-registration-review.service';
import { ActivityRegistrationsService } from './activity-registrations.service';

jest.mock('../activities/activity-waitlist-promotion', () => ({
  promoteActivityWaitlist: jest.fn().mockResolvedValue({ activityTitle: '测试活动', promoted: [] }),
  promoteActivityWaitlistWithinCapacity: jest
    .fn()
    .mockResolvedValue({ activityTitle: '测试活动', promoted: [] }),
}));

// activity-registrations service-level characterization spec(B 档,沿 srvf-god-service-refactor）。
// 锁定 service 内部「编排契约」现状行为,作为后续 Presenter / QueryService 抽离前的快速重构护栏。
//
// 风格沿 src/modules/audit-logs/audit-logs.service.spec.ts:
// - 纯构造器注入 mock,不使用 NestJS TestingModule、不连库、不起 Nest
// - $transaction mock 同时支持 callback(写路径)与 array(list / listMy)两种用法
//
// 边界(本 spec 只到 service 编排层):
// - 不测 StateMachine 内部状态矩阵(mock decide;矩阵归 state-transition e2e)
// - 不测 AuditRecorder 内部 snapshot 组装(只断言被调用入参;snapshot 归 audit-characterization e2e)
// - 不复刻完整 e2e 端到端流程;不改任何业务代码 / BizCode / audit event 名。

// ============ 行形(覆盖 registrationSafeSelect 与 registrationListSelect 的并集) ============

interface RegRow {
  id: string;
  activityId: string;
  activityPositionId: string | null;
  memberId: string;
  statusCode: string;
  registeredAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  extras: Prisma.JsonValue | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  currentRevision: number;
  member?: { memberNo: string; displayName: string } | null;
  activityPosition?: { id: string; name: string } | null;
}

interface ActivityRow {
  id: string;
  title: string;
  statusCode: string;
  isPublicRegistration: boolean;
  capacity: number | null;
  requiresInsurance: boolean;
  startAt: Date;
  registrationDeadline: Date | null;
  endAt: Date;
  genderRequirementCode: string | null;
  publisher: { memberId: string | null } | null;
}

interface MemberRow {
  id: string;
  memberNo: string;
  displayName: string;
  status: 'ACTIVE' | 'INACTIVE';
  deletedAt: Date | null;
}

interface UserRow {
  memberId: string | null;
}

// ============ 固定 fixture ============

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-test-1', ip: '127.0.0.1', ua: 'jest' };

// findMy / list / create / exportCsv 不调用 state machine;这些用例传入占位 decision。
const DENY_DECISION: ActivityRegistrationTransitionDecision = {
  allowed: false,
  biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
};

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

function makeRegRow(overrides: Partial<RegRow> = {}): RegRow {
  return {
    id: 'reg-1',
    activityId: 'act-1',
    activityPositionId: null,
    memberId: 'mem-1',
    statusCode: 'pending',
    registeredAt: FIXED_DATE,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    extras: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    currentRevision: 0,
    member: null,
    activityPosition: null,
    ...overrides,
  };
}

function makeActivityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'act-1',
    title: '测试活动',
    statusCode: 'published',
    isPublicRegistration: true,
    capacity: null,
    requiresInsurance: false,
    startAt: new Date('2098-12-31T00:00:00.000Z'),
    registrationDeadline: null,
    endAt: new Date('2099-01-01T00:00:00.000Z'),
    genderRequirementCode: null,
    publisher: { memberId: 'member-publisher' },
    ...overrides,
  };
}

function makeMemberRow(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    id: 'mem-1',
    memberNo: 'LOCAL-001',
    displayName: '本地队员甲',
    status: 'ACTIVE',
    deletedAt: null,
    ...overrides,
  };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const activityRegistration = {
    findFirst: jest.fn<Promise<RegRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<RegRow[]>, [unknown]>(),
    create: jest.fn<Promise<RegRow>, [unknown]>(),
    update: jest.fn<Promise<RegRow>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
    count: jest.fn<Promise<number>, [unknown]>(),
  };
  const activityRegistrationRevision = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'registration-revision-1' }),
  };
  const activity = {
    findFirst: jest.fn<Promise<ActivityRow | null>, [unknown]>(),
    // 统一通知 S4:审批后 commit 外的派发 helper 读活动名(this.prisma.activity.findUnique);
    // 默认返标题,旧 characterization 用例不关心(helper try-catch 永不抛,断言零影响)。
    findUnique: jest
      .fn<Promise<{ title: string } | null>, [unknown]>()
      .mockResolvedValue({ title: '测试活动' }),
  };
  const activityPosition = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  };
  const activitySession = { findFirst: jest.fn().mockResolvedValue(null) };
  const activityQualificationRuleSet = { findFirst: jest.fn().mockResolvedValue(null) };
  const registrationFormVersion = { findFirst: jest.fn().mockResolvedValue(null) };
  const member = {
    findFirst: jest.fn<Promise<MemberRow | null>, [unknown]>().mockResolvedValue(makeMemberRow()),
    findUnique: jest.fn<Promise<MemberRow | null>, [unknown]>().mockResolvedValue(makeMemberRow()),
  };
  const memberProfile = { findFirst: jest.fn().mockResolvedValue({ genderCode: 'male' }) };
  const user = { findFirst: jest.fn<Promise<UserRow | null>, [unknown]>() };
  // 参与域生命周期收口⑦:cancelAdmin / cancelMy 事务内查考勤记录与签到证据守卫。
  // 默认 0(无参与证据 → 放行),既有 cancel characterization 用例断言零影响;守卫用例显式覆写返回 >0。
  const attendanceRecord = {
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const activityCheckIn = {
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  // create / approve / pass cancel 的 Activity 聚合锁默认命中测试活动；不存在场景仍由
  // activity.findFirst fixture 驱动既有 ACTIVITY_NOT_FOUND 断言。
  const $queryRaw = jest.fn().mockImplementation((query: unknown) => {
    const candidate = query as { sql?: string; text?: string; strings?: readonly string[] };
    const text = candidate.sql ?? candidate.text ?? candidate.strings?.join('?') ?? String(query);
    if (
      text.includes('FROM "ActivityRegistration"') &&
      text.includes('"activityId"') &&
      text.includes('"memberId"')
    ) {
      return Promise.resolve([]);
    }
    if (
      text.includes('FROM "ActivityParticipationIdentity"') &&
      text.includes('"activityId"') &&
      text.includes('"memberId"')
    ) {
      return Promise.resolve([]);
    }
    return Promise.resolve([{ id: 'act-1' }]);
  });
  const prisma = {
    activityRegistration,
    activityRegistrationRevision,
    activity,
    activityPosition,
    activitySession,
    activityQualificationRuleSet,
    registrationFormVersion,
    member,
    memberProfile,
    user,
    attendanceRecord,
    activityCheckIn,
    $transaction,
    $queryRaw,
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

function makeAuditRecorderMock() {
  return {
    logExport: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logCreate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logReview: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logCancel: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
}
type AuditRecorderMock = ReturnType<typeof makeAuditRecorderMock>;

function makeStateMachineMock(decision: ActivityRegistrationTransitionDecision) {
  return {
    decide: jest
      .fn<ActivityRegistrationTransitionDecision, [string, string]>()
      .mockReturnValue(decision),
  };
}
type StateMachineMock = ReturnType<typeof makeStateMachineMock>;

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
    getVisibleOrganizationScope: jest.fn().mockResolvedValue({
      hasPermission: true,
      global: true,
      organizationIds: [],
    }),
  };
}
type AuthzMock = ReturnType<typeof makeAuthzMock>;

// 保险 T3(2026-06-13,评审稿 insurance-module-review.md E-10):构造函数注入门槛 mock,
// decision 恒通过且 evidence no-op(本 spec fixture 活动 requiresInsurance 走 Prisma default=false,门槛语义
// 由 e2e activity-registrations-insurance-gate 锁定)。既有断言零修改,仅机械补第 5 参。
function makeInsuranceRequirementMock() {
  return {
    requireForActivityRegistration: jest.fn().mockResolvedValue(null),
    createActivityRegistrationEvidence: jest.fn().mockResolvedValue(undefined),
    revalidateActivityRegistrationApproval: jest
      .fn<Promise<void>, [unknown, unknown, unknown]>()
      .mockResolvedValue(undefined),
  };
}
type InsuranceRequirementMock = ReturnType<typeof makeInsuranceRequirementMock>;

// PR-L1:业务事务内 durable notification producer；失败必须外抛给事务并整体回滚。
function makeNotificationProducerMock() {
  return {
    enqueueReview: jest
      .fn<
        ReturnType<ActivityRegistrationNotificationProducer['enqueueReview']>,
        Parameters<ActivityRegistrationNotificationProducer['enqueueReview']>
      >()
      .mockResolvedValue(),
    enqueueWaitlistPromotions: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
    enqueueSelfCancellation: jest
      .fn<Promise<'legacy-publisher'>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue('legacy-publisher'),
  };
}
type NotificationProducerMock = ReturnType<typeof makeNotificationProducerMock>;

// F2/B1(2026-07-04):listAllForAdmin 新增 organizationId+includeDescendants 注入
// OrganizationsService.queryDescendantOrgIds();本 spec 不覆盖该分支(归 e2e
// admin-cross-axis-registrations),mock 仅满足构造器类型,不返回有意义值。
function makeOrganizationsMock() {
  return {
    queryDescendantOrgIds: jest.fn<Promise<string[]>, [string]>().mockResolvedValue([]),
  };
}
type OrganizationsMock = ReturnType<typeof makeOrganizationsMock>;

function makeRegistrationLifecycleMock() {
  return {
    rejectInTransactionTrusted: jest.fn().mockResolvedValue(undefined),
    reopenInTransactionTrusted: jest.fn().mockResolvedValue(undefined),
    cancelInTransactionTrusted: jest
      .fn<
        Promise<void>,
        [
          PrismaMock,
          Parameters<ActivityRegistrationLifecycleService['cancelInTransactionTrusted']>[1],
        ]
      >()
      .mockImplementation(async (tx, input) => {
        const updated = await tx.activityRegistration.update({
          where: { id: input.registrationId },
          data: {
            statusCode: 'cancelled',
            cancelledByUserId: input.actorUserId,
            cancelledAt: input.cancelledAt,
            cancelReason: input.cancelReason,
          },
        });
        tx.activityRegistration.findFirst.mockResolvedValue(updated);
      }),
    incrementPopulationRevisionInTransactionTrusted: jest.fn(),
  };
}

function makeQualificationEvaluatorMock() {
  return {
    evaluate: jest.fn().mockResolvedValue({
      resultCode: 'pass',
      activity: { resultCode: 'pass', unmetRules: [] },
      sessions: new Map(),
      positions: new Map(),
      snapshotCandidates: [],
    }),
    assertNoBlock: jest.fn(),
    appendSnapshots: jest.fn().mockResolvedValue(undefined),
  };
}
type QualificationEvaluatorMock = ReturnType<typeof makeQualificationEvaluatorMock>;

function makeWaitlistQueryMock() {
  return {
    getPosition: jest.fn<Promise<number | null>, [RegRow]>().mockResolvedValue(null),
    getPositions: jest
      .fn<Promise<Map<string, number | null>>, [RegRow[]]>()
      .mockImplementation((rows) => Promise.resolve(new Map(rows.map((row) => [row.id, null])))),
  };
}

function makeService(
  prisma: PrismaMock,
  recorder: AuditRecorderMock,
  stateMachine: StateMachineMock,
  notificationProducer: NotificationProducerMock = makeNotificationProducerMock(),
  authz: AuthzMock = makeAuthzMock(),
  organizations: OrganizationsMock = makeOrganizationsMock(),
  insuranceRequirement: InsuranceRequirementMock = makeInsuranceRequirementMock(),
  qualificationEvaluator: QualificationEvaluatorMock = makeQualificationEvaluatorMock(),
): ActivityRegistrationsService {
  // stateMachine mock 仅含 decide,结构上可直接赋给 ActivityRegistrationStateMachine,无需断言。
  // Phase 6-B 第三域第二刀:三个新类全部传**真实实例**并喂同一组 mock ——
  // 判权、聚合根锁、建单与审批四式的行为锁必须走真实实现。mock 掉它们等于把本 spec 里
  // 全部 RBAC_FORBIDDEN / 容量 / 状态机 / 审计断言变成自说自话(同 presenter / queryService 的既有处理)。
  const rbacMock = makeRbacMock() as unknown as RbacService;
  const auditLogsMock = {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogsService;
  const participationPolicy = new ActivityParticipationPolicy();
  const presenterReal = new ActivityRegistrationPresenter();
  const lifecycleMock =
    makeRegistrationLifecycleMock() as unknown as ActivityRegistrationLifecycleService;
  const allocationsMock = {
    promoteAfterCancellationInTransactionTrusted: jest.fn().mockResolvedValue({
      handled: false,
      activityTitle: '活动',
      promoted: [],
    }),
  } as unknown as ActivityAllocationService;
  const access = new ActivityRegistrationAccessService(
    prisma as unknown as PrismaService,
    rbacMock,
    authz as unknown as AuthzService,
  );
  return new ActivityRegistrationsService(
    prisma as unknown as PrismaService,
    access,
    new ActivityRegistrationCreateService(
      prisma as unknown as PrismaService,
      access,
      recorder as unknown as ActivityRegistrationAuditRecorder,
      insuranceRequirement as unknown as InsuranceRequirementService,
      qualificationEvaluator as unknown as ActivityQualificationEvaluatorService,
      participationPolicy,
      presenterReal,
    ),
    new ActivityRegistrationReviewService(
      prisma as unknown as PrismaService,
      access,
      recorder as unknown as ActivityRegistrationAuditRecorder,
      stateMachine,
      auditLogsMock,
      insuranceRequirement as unknown as InsuranceRequirementService,
      qualificationEvaluator as unknown as ActivityQualificationEvaluatorService,
      notificationProducer as unknown as ActivityRegistrationNotificationProducer,
      participationPolicy,
      lifecycleMock,
      allocationsMock,
      presenterReal,
    ),
    recorder as unknown as ActivityRegistrationAuditRecorder,
    stateMachine,
    auditLogsMock,
    rbacMock,
    authz as unknown as AuthzService,
    insuranceRequirement as unknown as InsuranceRequirementService,
    qualificationEvaluator as unknown as ActivityQualificationEvaluatorService,
    notificationProducer as unknown as ActivityRegistrationNotificationProducer,
    organizations as unknown as OrganizationsService,
    participationPolicy,
    makeWaitlistQueryMock() as unknown as ActivityRegistrationWaitlistQueryService,
    lifecycleMock,
    allocationsMock,
    // Phase 6-B 第三域第一刀:传**真实实例**并喂同一个 prisma mock —— 读路径的既有
    // characterization 断言(where / select / orderBy / skip / take)因此继续经新类落到
    // 同一个 mock 上,断言一字未改即证「搬家零漂移」。传 mock 反而会把被测行为挖空。
    new ActivityRegistrationQueryService(prisma as unknown as PrismaService),
    // Phase 6-B 第三域第二刀:Presenter 传**真实实例**而非 mock(零依赖纯映射类)——
    // DTO mapping 的既有 characterization 断言因此经真实序列化路径,直接锁「搬家零漂移」。
    presenterReal,
  );
}

describe('ActivityRegistrationsService (characterization)', () => {
  describe('DTO mapping', () => {
    it('toResponseDto via findMy: extras object 透传 / array → null / null 字段保持', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      // 1) extras 为对象 → 透传;reviewed* / cancelled* 维持 null
      prisma.activityRegistration.findFirst.mockResolvedValueOnce(
        makeRegRow({ memberId: 'mem-1', extras: { note: 'x' } }),
      );
      const r1 = await service.findMy('reg-1', makeCurrentUser({ role: Role.USER }));
      expect(r1.extras).toEqual({ note: 'x' });
      expect(r1.reviewedBy).toBeNull();
      expect(r1.reviewedAt).toBeNull();
      expect(r1.cancelledAt).toBeNull();

      // 2) extras 为数组 → jsonAsObject 收窄为 null
      prisma.activityRegistration.findFirst.mockResolvedValueOnce(
        makeRegRow({ memberId: 'mem-1', extras: ['x'] }),
      );
      const r2 = await service.findMy('reg-1', makeCurrentUser({ role: Role.USER }));
      expect(r2.extras).toBeNull();
    });

    it('toListItemDto via list: member 映射 memberNo / displayName,member 缺省时为 null', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.activityRegistration.findMany.mockResolvedValue([
        makeRegRow({ id: 'r-1', member: { memberNo: 'M-1', displayName: 'D-1' } }),
        makeRegRow({ id: 'r-2', member: null }),
      ]);
      prisma.activityRegistration.count.mockResolvedValue(2);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      // Slow-4 T3:list 补 currentUser 入参(D-S4-5;rbac mock 恒 true,断言零修改)
      const page = await service.list('act-1', { page: 1, pageSize: 20 }, makeCurrentUser());

      expect(page.total).toBe(2);
      expect(page.items[0].memberNo).toBe('M-1');
      expect(page.items[0].memberDisplayName).toBe('D-1');
      expect(page.items[1].memberNo).toBeNull();
      expect(page.items[1].memberDisplayName).toBeNull();
    });
  });

  describe('duplicate / capacity guards (create)', () => {
    it.each([
      ['live session', 'activitySession'],
      ['active Form', 'registrationFormVersion'],
    ])('legacy create is fail-closed with 21038 when %s exists', async (_name, gate) => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      if (gate === 'activitySession')
        prisma.activitySession.findFirst.mockResolvedValue({ id: 'session-1' });
      else prisma.registrationFormVersion.findFirst.mockResolvedValue({ id: 'form-1' });
      const recorder = makeAuditRecorderMock();
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED));
      expect(prisma.activityRegistration.create).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });

    it('active duplicate → ACTIVITY_REGISTRATION_ALREADY_EXISTS;不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'act-1' }]).mockResolvedValueOnce([
        {
          id: 'dup-1',
          statusCode: 'pending',
          currentRevision: 1,
          deletedAt: null,
        },
      ]);
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS));
      expect(prisma.activityRegistration.create).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });

    it('cancelled legacy head with a permanent identity stays on the v1.1 flow and writes nothing', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'act-1' }])
        .mockResolvedValueOnce([
          {
            id: 'cancelled-head-1',
            statusCode: 'cancelled',
            currentRevision: 1,
            deletedAt: null,
          },
        ])
        .mockResolvedValueOnce([{ id: 'permanent-identity-1' }]);
      const insurance = makeInsuranceRequirementMock();
      const service = makeService(
        prisma,
        recorder,
        makeStateMachineMock(DENY_DECISION),
        makeNotificationProducerMock(),
        makeAuthzMock(),
        makeOrganizationsMock(),
        insurance,
      );

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED));
      expect(insurance.requireForActivityRegistration).not.toHaveBeenCalled();
      expect(prisma.activityRegistrationRevision.create).not.toHaveBeenCalled();
      expect(prisma.activityRegistration.updateMany).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });

    it('create 抛 P2002 → ACTIVITY_REGISTRATION_ALREADY_EXISTS(unique 兜底)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', currentRevision: 1 }),
      );
      prisma.activityRegistration.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS));
    });

    it('capacity = null → 不调用 count,允许创建;logCreate viaPath=admin', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', currentRevision: 1 }),
      );
      prisma.activityRegistration.create.mockResolvedValue(makeRegRow({ statusCode: 'pending' }));
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      const result = await service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META);

      expect(prisma.activityRegistration.count).not.toHaveBeenCalled();
      expect(prisma.activityRegistration.create).toHaveBeenCalled();
      expect(recorder.logCreate).toHaveBeenCalledWith(
        expect.objectContaining({ viaPath: 'admin' }),
      );
      expect(result.statusCode).toBe('pending');
    });

    it('capacity 已满 → 创建 waitlisted 并写 create audit', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: 1 }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'waitlisted', currentRevision: 1 }),
      );
      prisma.activityRegistration.count.mockResolvedValue(1);
      prisma.activityRegistration.create.mockResolvedValue(
        makeRegRow({ statusCode: 'waitlisted' }),
      );
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      const result = await service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META);

      const createArg = prisma.activityRegistration.create.mock.calls[0][0] as {
        data: { statusCode: string };
      };
      const auditArg = recorder.logCreate.mock.calls[0][0] as {
        created: { statusCode: string };
      };
      expect(createArg.data.statusCode).toBe('waitlisted');
      expect(auditArg.created.statusCode).toBe('waitlisted');
      expect(result.statusCode).toBe('waitlisted');
    });

    it('App 自助报名在保险校验后最终重读到 Member INACTIVE → 回滚且零 evidence/audit', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const insuranceRequirement = makeInsuranceRequirementMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.activityRegistration.findFirst.mockResolvedValue(null);
      insuranceRequirement.requireForActivityRegistration.mockImplementation(() => {
        // 模拟无锁 snapshot 通过后，offboard 在最终 lifecycle lock 前已提交。
        prisma.member.findFirst.mockResolvedValueOnce(makeMemberRow({ status: 'INACTIVE' }));
        return Promise.resolve(null);
      });
      const service = makeService(
        prisma,
        recorder,
        makeStateMachineMock(DENY_DECISION),
        makeNotificationProducerMock(),
        makeAuthzMock(),
        makeOrganizationsMock(),
        insuranceRequirement,
      );

      await expect(
        service.createMy(
          'act-1',
          {},
          makeCurrentUser({ id: 'user-1', role: Role.USER, memberId: 'mem-1' }),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.MEMBER_INACTIVE));

      expect(prisma.activityRegistration.create).not.toHaveBeenCalled();
      expect(insuranceRequirement.createActivityRegistrationEvidence).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });
  });

  describe('state-machine wiring', () => {
    it('approve denied → 抛 decision.biz;不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', activityId: 'act-1' }),
      );
      const service = makeService(prisma, recorder, stateMachine);

      await expect(service.approve('act-1', 'reg-1', {}, makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID),
      );
      expect(stateMachine.decide).toHaveBeenCalledWith('approve', 'pass');
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
    });

    it('approve allowed → update 写 nextStatusCode;logReview action=approve,tx 透传', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const insuranceRequirement = makeInsuranceRequirementMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'pass' });
      const observed = makeRegRow({ statusCode: 'pending', activityId: 'act-1' });
      const locked = makeRegRow({
        statusCode: 'pending',
        activityId: 'act-1',
        reviewNote: 'authoritative-before',
      });
      prisma.activityRegistration.findFirst
        .mockResolvedValueOnce(observed)
        .mockResolvedValueOnce(locked);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', reviewedBy: 'admin-1', reviewedAt: FIXED_DATE }),
      );
      const service = makeService(
        prisma,
        recorder,
        stateMachine,
        undefined,
        undefined,
        undefined,
        insuranceRequirement,
      );

      const result = await service.approve(
        'act-1',
        'reg-1',
        {},
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      expect(stateMachine.decide).toHaveBeenCalledWith('approve', 'pending');
      expect(prisma.activityRegistration.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.activityRegistration.update.mock.calls[0][0] as {
        data: { statusCode: string; reviewedBy: string | null };
      };
      expect(updateArg.data.statusCode).toBe('pass');
      expect(updateArg.data.reviewedBy).toBe('admin-1');
      expect(recorder.logReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'approve', nextStatusCode: 'pass', tx: prisma }),
      );
      expect(insuranceRequirement.revalidateActivityRegistrationApproval).toHaveBeenCalledWith(
        { id: 'reg-1', memberId: 'mem-1', currentRevision: 0 },
        expect.objectContaining({ id: 'act-1', requiresInsurance: false }),
        prisma,
      );
      expect(
        insuranceRequirement.revalidateActivityRegistrationApproval.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        prisma.$queryRaw.mock.invocationCallOrder[
          prisma.$queryRaw.mock.invocationCallOrder.length - 1
        ],
      );
      expect(recorder.logReview).toHaveBeenCalledWith(expect.objectContaining({ before: locked }));
      expect(result.statusCode).toBe('pass');
    });

    it('approve 保险重验失败 → registration 已 claim，但零 update / audit / notification', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const notificationProducer = makeNotificationProducerMock();
      const insuranceRequirement = makeInsuranceRequirementMock();
      insuranceRequirement.revalidateActivityRegistrationApproval.mockRejectedValue(
        new BizException(BizCode.INSURANCE_REQUIRED),
      );
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1', memberId: 'mem-1' }),
      );
      prisma.activity.findFirst.mockResolvedValue(
        makeActivityRow({ capacity: null, requiresInsurance: true }),
      );
      const service = makeService(
        prisma,
        recorder,
        makeStateMachineMock({ allowed: true, nextStatusCode: 'pass' }),
        notificationProducer,
        undefined,
        undefined,
        insuranceRequirement,
      );

      await expect(service.approve('act-1', 'reg-1', {}, makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.INSURANCE_REQUIRED),
      );

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(
        insuranceRequirement.revalidateActivityRegistrationApproval.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        prisma.$queryRaw.mock.invocationCallOrder[
          prisma.$queryRaw.mock.invocationCallOrder.length - 1
        ],
      );
      expect(prisma.activityRegistration.updateMany).not.toHaveBeenCalled();
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
      expect(notificationProducer.enqueueReview).not.toHaveBeenCalled();
    });

    it('active scoped RuleSet cannot make a legacy pending head without identity or preference guess a review target', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const notificationProducer = makeNotificationProducerMock();
      const insuranceRequirement = makeInsuranceRequirementMock();
      const qualificationEvaluator = makeQualificationEvaluatorMock();
      const observed = makeRegRow({
        statusCode: 'pending',
        activityId: 'act-1',
        currentRevision: 1,
      });
      const locked = makeRegRow({
        statusCode: 'pending',
        activityId: 'act-1',
        currentRevision: 1,
      });
      prisma.activityRegistration.findFirst
        .mockResolvedValueOnce(observed)
        .mockResolvedValueOnce(locked);
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.activityQualificationRuleSet.findFirst
        .mockResolvedValueOnce({ id: 'active-rule-set' })
        .mockResolvedValueOnce({ id: 'active-scoped-rule-set' });
      prisma.$queryRaw.mockImplementation((query: unknown) => {
        const candidate = query as { sql?: string; text?: string; strings?: readonly string[] };
        const text =
          candidate.sql ?? candidate.text ?? candidate.strings?.join('?') ?? String(query);
        if (text.includes('ActivityRegistrationRevision')) {
          return Promise.resolve([{ id: 'revision-1' }]);
        }
        if (
          text.includes('ActivityParticipationIdentity') ||
          text.includes('ActivityPositionPreference')
        ) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ id: 'act-1' }]);
      });
      const service = makeService(
        prisma,
        recorder,
        makeStateMachineMock({ allowed: true, nextStatusCode: 'pass' }),
        notificationProducer,
        undefined,
        undefined,
        insuranceRequirement,
        qualificationEvaluator,
      );

      await expect(service.approve('act-1', 'reg-1', {}, makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED),
      );

      expect(qualificationEvaluator.evaluate).not.toHaveBeenCalled();
      expect(qualificationEvaluator.appendSnapshots).not.toHaveBeenCalled();
      expect(insuranceRequirement.revalidateActivityRegistrationApproval).not.toHaveBeenCalled();
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
      expect(notificationProducer.enqueueReview).not.toHaveBeenCalled();
    });
  });

  // ===== PR-L1:审批结果 intent 与 business/audit 同事务，Effect 由 worker 在 commit 后执行 =====
  describe('PR-L1 审批结果 durable intent(approve/reject → 报名本人)', () => {
    function setupApprove(
      notificationProducer: NotificationProducerMock = makeNotificationProducerMock(),
    ) {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'pass' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1', memberId: 'mem-42' }),
      );
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', memberId: 'mem-42' }),
      );
      const service = makeService(prisma, recorder, stateMachine, notificationProducer);
      return { service, prisma, recorder, notificationProducer };
    }

    it('approve 成功 → audit 后在同一 tx enqueue 审批 intent', async () => {
      const { service, recorder, notificationProducer } = setupApprove();
      const result = await service.approve(
        'act-1',
        'reg-1',
        { reviewNote: '材料齐全' },
        makeCurrentUser(),
        META,
      );
      expect(result.statusCode).toBe('pass');
      const [, reviewIntent] = notificationProducer.enqueueReview.mock.calls[0];
      expect(reviewIntent).toMatchObject({
        registrationId: 'reg-1',
        activityId: 'act-1',
        memberId: 'mem-42',
        outcome: 'approved',
        reviewNote: '材料齐全',
      });
      expect(reviewIntent.reviewedAt).toBeInstanceOf(Date);
      expect(notificationProducer.enqueueReview.mock.invocationCallOrder[0]).toBeGreaterThan(
        recorder.logReview.mock.invocationCallOrder[0],
      );
    });

    it('reject 成功 → 同 tx enqueue rejected intent + reviewNote', async () => {
      const notificationProducer = makeNotificationProducerMock();
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'reject' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1', memberId: 'mem-7' }),
      );
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'reject', memberId: 'mem-7' }),
      );
      const service = makeService(prisma, recorder, stateMachine, notificationProducer);

      const result = await service.reject(
        'act-1',
        'reg-1',
        { reviewNote: '名额已满' },
        makeCurrentUser(),
        META,
      );
      expect(result.statusCode).toBe('reject');
      expect(prisma.activityRegistration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ statusSummaryCode: 'not_selected' }) as unknown,
        }),
      );
      const [, reviewIntent] = notificationProducer.enqueueReview.mock.calls[0];
      expect(reviewIntent).toMatchObject({
        registrationId: 'reg-1',
        activityId: 'act-1',
        memberId: 'mem-7',
        outcome: 'rejected',
        reviewNote: '名额已满',
      });
      expect(reviewIntent.reviewedAt).toBeInstanceOf(Date);
    });

    it('intent enqueue 失败 → 外抛给事务，禁止返回已提交审批', async () => {
      const notificationProducer = makeNotificationProducerMock();
      notificationProducer.enqueueReview.mockRejectedValue(new Error('intent insert failed'));
      const { service, prisma } = setupApprove(notificationProducer);

      await expect(service.approve('act-1', 'reg-1', {}, makeCurrentUser(), META)).rejects.toThrow(
        'intent insert failed',
      );
      expect(prisma.activityRegistration.update).toHaveBeenCalledTimes(1);
      expect(notificationProducer.enqueueReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('audit recorder wiring', () => {
    it('cancelAdmin:已有 live AttendanceRecord → 21033,不再查询签到 / 不取消', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', activityId: 'act-1' }),
      );
      prisma.attendanceRecord.count.mockResolvedValue(1);
      const service = makeService(prisma, recorder, stateMachine);

      await expect(
        service.cancelAdmin('act-1', 'reg-1', {}, makeCurrentUser({ id: 'admin-1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE));

      expect(prisma.activityCheckIn.count).not.toHaveBeenCalled();
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });

    it('cancelAdmin:已有 live ActivityCheckIn → 21033,不取消 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', activityId: 'act-1' }),
      );
      prisma.activityCheckIn.count.mockResolvedValue(1);
      const service = makeService(prisma, recorder, stateMachine);

      await expect(
        service.cancelAdmin('act-1', 'reg-1', {}, makeCurrentUser({ id: 'admin-1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE));

      expect(prisma.attendanceRecord.count).toHaveBeenCalledWith({
        where: { registrationId: 'reg-1', deletedAt: null },
      });
      expect(prisma.activityCheckIn.count).toHaveBeenCalledWith({
        where: { registrationId: 'reg-1', deletedAt: null },
      });
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });

    it('cancelMy:已有 live ActivityCheckIn → 21033,不取消 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', activityId: 'act-1', memberId: 'mem-1' }),
      );
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.activityCheckIn.count.mockResolvedValue(1);
      const service = makeService(prisma, recorder, stateMachine);

      await expect(
        service.cancelMy('reg-1', {}, makeCurrentUser({ id: 'user-1', role: Role.USER }), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE));

      expect(prisma.activityCheckIn.count).toHaveBeenCalledWith({
        where: { registrationId: 'reg-1', deletedAt: null },
      });
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });

    // B-D3 起只有取消 pass 才通知负责人，故快照断言必须挂在 pass 上（pending 根本不会调 producer）。
    it('cancelMy(pass):同事务只快照 memberNo/displayName 传给通知 producer', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const notificationProducer = makeNotificationProducerMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', activityId: 'act-1', memberId: 'mem-1' }),
      );
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'cancelled', activityId: 'act-1', memberId: 'mem-1' }),
      );
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.member.findUnique.mockResolvedValue(
        makeMemberRow({ memberNo: 'LOCAL-001', displayName: '本地队员甲' }),
      );
      const service = makeService(prisma, recorder, stateMachine, notificationProducer);

      await service.cancelMy(
        'reg-1',
        { cancelReason: '临时有事' },
        makeCurrentUser({ id: 'user-1', role: Role.USER }),
        META,
      );

      expect(prisma.member.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        select: { memberNo: true, displayName: true },
      });
      const [, input] = notificationProducer.enqueueSelfCancellation.mock.calls[0];
      expect(input).toMatchObject({
        registrationId: 'reg-1',
        cancellingMember: { memberNo: 'LOCAL-001', displayName: '本地队员甲' },
        cancelReason: '临时有事',
      });
      expect(input).not.toHaveProperty('cancellingMemberId');
    });

    // B-D3（维护者 2026-08-01 拍板）：取消非 pass 报名不打扰负责人。
    it.each(['pending', 'waitlisted'])(
      'cancelMy(%s):取消照常成交，但不调用通知 producer',
      async (statusCode) => {
        const prisma = makePrismaMock();
        const recorder = makeAuditRecorderMock();
        const notificationProducer = makeNotificationProducerMock();
        const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
        prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
        prisma.activityRegistration.findFirst.mockResolvedValue(
          makeRegRow({ statusCode, activityId: 'act-1', memberId: 'mem-1' }),
        );
        prisma.activityRegistration.update.mockResolvedValue(
          makeRegRow({ statusCode: 'cancelled', activityId: 'act-1', memberId: 'mem-1' }),
        );
        prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
        const service = makeService(prisma, recorder, stateMachine, notificationProducer);

        await service.cancelMy(
          'reg-1',
          {},
          makeCurrentUser({ id: 'user-1', role: Role.USER }),
          META,
        );

        expect(prisma.activityRegistration.update).toHaveBeenCalled();
        expect(recorder.logCancel).toHaveBeenCalled();
        expect(notificationProducer.enqueueSelfCancellation).not.toHaveBeenCalled();
      },
    );

    it('cancelAdmin: cancelReason 缺省时传 null,cancelledByPath=admin', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'cancelled' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1' }),
      );
      prisma.activityRegistration.update.mockResolvedValue(makeRegRow({ statusCode: 'cancelled' }));
      const service = makeService(prisma, recorder, stateMachine);

      const result = await service.cancelAdmin(
        'act-1',
        'reg-1',
        {},
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      expect(stateMachine.decide).toHaveBeenCalledWith('cancel', 'pending');
      expect(recorder.logCancel).toHaveBeenCalledWith(
        expect.objectContaining({ cancelledByPath: 'admin', cancelReason: null }),
      );
      expect(result.statusCode).toBe('cancelled');
    });

    it('reopen: reject → pending,清空审核三字段,logReview action=reopen', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'pending' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'reject', activityId: 'act-1' }),
      );
      prisma.activityRegistration.update.mockResolvedValue(makeRegRow({ statusCode: 'pending' }));
      const service = makeService(prisma, recorder, stateMachine);

      const result = await service.reopen(
        'act-1',
        'reg-1',
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      expect(stateMachine.decide).toHaveBeenCalledWith('reopen', 'reject');
      // 审核三字段清空写入 update.data
      const updateArg = prisma.activityRegistration.update.mock.calls[0][0] as {
        data: {
          reviewedBy: unknown;
          reviewedAt: unknown;
          reviewNote: unknown;
          statusCode: unknown;
          statusSummaryCode: unknown;
        };
      };
      expect(updateArg.data.reviewedBy).toBeNull();
      expect(updateArg.data.reviewedAt).toBeNull();
      expect(updateArg.data.reviewNote).toBeNull();
      expect(updateArg.data.statusCode).toBe('pending');
      expect(updateArg.data.statusSummaryCode).toBe('active');
      expect(recorder.logReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reopen', nextStatusCode: 'pending' }),
      );
      expect(result.statusCode).toBe('pending');
    });
  });

  describe('app scope (memberId)', () => {
    it('cancelMy 他人的 reg → ACTIVITY_REGISTRATION_NOT_FOUND;不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.activityRegistration.findFirst.mockResolvedValue(makeRegRow({ memberId: 'mem-2' }));
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      await expect(
        service.cancelMy('reg-1', {}, makeCurrentUser({ id: 'u1' }), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND));
      expect(prisma.activityRegistration.update).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });

    it('findMy: user 未绑定 memberId → MEMBER_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: null });
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await expect(service.findMy('reg-1', makeCurrentUser({ id: 'u1' }))).rejects.toEqual(
        new BizException(BizCode.MEMBER_NOT_FOUND),
      );
      expect(prisma.activityRegistration.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('exportCsv (audit before generator handoff)', () => {
    it('先完成审计再返回流式 CSV generator', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.activityRegistration.findMany.mockResolvedValue([
        makeRegRow({ member: { memberNo: 'M-1', displayName: 'D-1' } }),
      ]);
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      const chunks = await service.exportCsv('act-1', {}, makeCurrentUser(), META);
      expect(recorder.logExport).toHaveBeenCalledWith({
        activityId: 'act-1',
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        filterFields: [],
        auditMeta: META,
      });
      expect(prisma.activityRegistration.findMany).not.toHaveBeenCalled();
      let csv = '';
      for await (const chunk of chunks) csv += chunk;

      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('registration_id');
      const calls = prisma.activityRegistration.findMany.mock.calls as unknown as Array<
        [{ take: number; select: unknown }]
      >;
      expect(calls[0][0].take).toBe(500);
      expect(calls[0][0].select).toBeDefined();
      expect(recorder.logCreate).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });

    it('审计失败时不返回 generator,也不执行任何 CSV 查询', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      recorder.logExport.mockRejectedValue(new Error('audit unavailable'));
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      await expect(service.exportCsv('act-1', {}, makeCurrentUser(), META)).rejects.toThrow(
        'audit unavailable',
      );
      expect(prisma.activityRegistration.findMany).not.toHaveBeenCalled();
    });

    it('findings #13/#14:500 行后用 id cursor 拉下一批,常驻集合不超过 batch', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      const firstBatch = Array.from({ length: 500 }, (_, index) =>
        makeRegRow({ id: `reg-${index}`, member: null }),
      );
      prisma.activityRegistration.findMany
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([makeRegRow({ id: 'reg-tail', member: null })]);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      let csv = '';
      for await (const chunk of await service.exportCsv('act-1', {}, makeCurrentUser(), META)) {
        csv += chunk;
      }

      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.activityRegistration.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: { id: 'reg-499' }, skip: 1, take: 500 }),
      );
      expect(csv).toContain('reg-tail');
    });
  });

  // Phase 6-B 第三域第一刀新增的**跨类入参锁**(纯新增用例,不改任何既有断言)。
  //
  // 立项理由:抽出前 `resolveVisibleOrganizationIds()` 与「把结果写进 activity where」
  // 在同一个方法体内,是**编译期就绑死**的一条直线;抽出后它变成跨类边界的一个入参
  // (`listAllForAdmin(query, visibleOrganizationIds)`)—— 传错、传 undefined、或干脆
  // 不传,TypeScript 都拦不住,而后果是**越权读**(受限管理员看到全部组织的报名)。
  // 实测变异「把入参改成 undefined」时全仓单测**零红** ⇒ 这是本刀引入的新失效面,
  // 必须在提交前补上锁。断言打在传给 Prisma 的 where 上,而不是打在返回值上。
  describe('listAllForAdmin 组织范围下推(跨类入参锁)', () => {
    const scopedAuthz = (organizationIds: string[]) => {
      const authz = makeAuthzMock();
      authz.getVisibleOrganizationScope.mockResolvedValue({
        hasPermission: true,
        global: false,
        organizationIds,
      });
      return authz;
    };

    it('非 GLOBAL 时,算好的可见组织范围必须下推到 activity.organizationId(丢了 = 越权读)', async () => {
      const prisma = makePrismaMock();
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityRegistration.count.mockResolvedValue(0);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
        makeNotificationProducerMock(),
        scopedAuthz(['org-1', 'org-2']),
      );

      await service.listAllForAdmin({ page: 1, pageSize: 20 }, makeCurrentUser());

      const arg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where.activity).toEqual({ organizationId: { in: ['org-1', 'org-2'] } });
    });

    it('可见组织范围为空集时仍必须下推(空集 = 什么都看不到,不能退化成不加过滤)', async () => {
      const prisma = makePrismaMock();
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityRegistration.count.mockResolvedValue(0);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
        makeNotificationProducerMock(),
        scopedAuthz([]),
      );

      await service.listAllForAdmin({ page: 1, pageSize: 20 }, makeCurrentUser());

      const arg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where.activity).toEqual({ organizationId: { in: [] } });
    });

    it('GLOBAL 且无显式筛选时不加组织 where(v0.49 既有语义,别被上面两条改宽)', async () => {
      const prisma = makePrismaMock();
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityRegistration.count.mockResolvedValue(0);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await service.listAllForAdmin({ page: 1, pageSize: 20 }, makeCurrentUser());

      const arg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where).not.toHaveProperty('activity');
    });
  });

  // 同一新失效面的第二条腿:`listByActivity(activityId, query)` 与
  // `listForMember(memberId, query)` **签名同形**(string, ListRegistrationsQueryDto),
  // 调用点交叉接线在 TypeScript 下完全合法。锁 where 的键名即可结构性区分。
  describe('列表方法接线(同形签名的交叉接线锁)', () => {
    it('listForMemberAdmin 必须按 memberId 过滤,不能误接成 activityId', async () => {
      const prisma = makePrismaMock();
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityRegistration.count.mockResolvedValue(0);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await service.listForMemberAdmin('mem-1', { page: 1, pageSize: 20 }, makeCurrentUser());

      const arg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where).toMatchObject({ memberId: 'mem-1' });
      expect(arg.where).not.toHaveProperty('activityId');
    });

    it('list 必须按 activityId 过滤,不能误接成 memberId', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityRegistration.count.mockResolvedValue(0);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await service.list('act-1', { page: 1, pageSize: 20 }, makeCurrentUser());

      const arg = prisma.activityRegistration.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where).toMatchObject({ activityId: 'act-1' });
      expect(arg.where).not.toHaveProperty('memberId');
    });
  });
});
