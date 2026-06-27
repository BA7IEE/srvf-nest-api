import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher';
import type { RbacService } from '../permissions/rbac.service';
import type { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import type { ActivityRegistrationTransitionDecision } from './activity-registration-state-machine';
import { ActivityRegistrationsService } from './activity-registrations.service';

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
  member?: { memberNo: string; displayName: string } | null;
}

interface ActivityRow {
  id: string;
  statusCode: string;
  isPublicRegistration: boolean;
  capacity: number | null;
}

interface MemberRow {
  id: string;
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
    member: null,
    ...overrides,
  };
}

function makeActivityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'act-1',
    statusCode: 'published',
    isPublicRegistration: true,
    capacity: null,
    ...overrides,
  };
}

function makeMemberRow(overrides: Partial<MemberRow> = {}): MemberRow {
  return { id: 'mem-1', ...overrides };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const activityRegistration = {
    findFirst: jest.fn<Promise<RegRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<RegRow[]>, [unknown]>(),
    create: jest.fn<Promise<RegRow>, [unknown]>(),
    update: jest.fn<Promise<RegRow>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
  };
  const activity = {
    findFirst: jest.fn<Promise<ActivityRow | null>, [unknown]>(),
    // 统一通知 S4:审批后 commit 外的派发 helper 读活动名(this.prisma.activity.findUnique);
    // 默认返标题,旧 characterization 用例不关心(helper try-catch 永不抛,断言零影响)。
    findUnique: jest
      .fn<Promise<{ title: string } | null>, [unknown]>()
      .mockResolvedValue({ title: '测试活动' }),
  };
  const member = { findFirst: jest.fn<Promise<MemberRow | null>, [unknown]>() };
  const user = { findFirst: jest.fn<Promise<UserRow | null>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = { activityRegistration, activity, member, user, $transaction };
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

// 保险 T3(2026-06-13,评审稿 insurance-module-review.md E-10):构造函数注入门槛 mock,
// assert 恒通过(本 spec fixture 活动 requiresInsurance 走 Prisma default=false,门槛语义
// 由 e2e activity-registrations-insurance-gate 锁定)。既有断言零修改,仅机械补第 5 参。
function makeInsuranceRequirementMock() {
  return {
    assertMemberInsuredForActivity: jest
      .fn<Promise<void>, [string, unknown, unknown]>()
      .mockResolvedValue(undefined),
  };
}

// 统一通知 S4:派发器 mock —— dispatchTargeted 默认 resolve(派发成功);新 S4 用例可注入 reject
// 验证「派发失败不破坏审批」,或断言入参(recipientMemberId / type / channels)。
function makeNotificationDispatcherMock() {
  return {
    dispatchTargeted: jest
      .fn<Promise<{ id: string }>, [Record<string, unknown>]>()
      .mockResolvedValue({ id: 'notif-1' }),
  };
}
type NotificationDispatcherMock = ReturnType<typeof makeNotificationDispatcherMock>;

function makeService(
  prisma: PrismaMock,
  recorder: AuditRecorderMock,
  stateMachine: StateMachineMock,
  dispatcher: NotificationDispatcherMock = makeNotificationDispatcherMock(),
): ActivityRegistrationsService {
  // stateMachine mock 仅含 decide,结构上可直接赋给 ActivityRegistrationStateMachine,无需断言。
  return new ActivityRegistrationsService(
    prisma as unknown as PrismaService,
    recorder as unknown as ActivityRegistrationAuditRecorder,
    stateMachine,
    makeRbacMock() as unknown as RbacService,
    makeInsuranceRequirementMock() as unknown as InsuranceRequirementService,
    dispatcher as unknown as NotificationDispatcher,
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
    it('active duplicate → ACTIVITY_REGISTRATION_ALREADY_EXISTS;不写库 / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findFirst.mockResolvedValue(makeRegRow({ id: 'dup-1' }));
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS));
      expect(prisma.activityRegistration.create).not.toHaveBeenCalled();
      expect(recorder.logCreate).not.toHaveBeenCalled();
    });

    it('create 抛 P2002 → ACTIVITY_REGISTRATION_ALREADY_EXISTS(unique 兜底)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.findFirst.mockResolvedValue(null);
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
      prisma.activityRegistration.findFirst.mockResolvedValue(null);
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

    it('capacity 已满 → ACTIVITY_CAPACITY_EXCEEDED;不写库', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: 1 }));
      prisma.member.findFirst.mockResolvedValue(makeMemberRow());
      prisma.activityRegistration.count.mockResolvedValue(1);
      const service = makeService(
        prisma,
        makeAuditRecorderMock(),
        makeStateMachineMock(DENY_DECISION),
      );

      await expect(
        service.create('act-1', { memberId: 'mem-1' }, makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_EXCEEDED));
      expect(prisma.activityRegistration.create).not.toHaveBeenCalled();
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
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'pass' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1' }),
      );
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow({ capacity: null }));
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'pass', reviewedBy: 'admin-1', reviewedAt: FIXED_DATE }),
      );
      const service = makeService(prisma, recorder, stateMachine);

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
      expect(result.statusCode).toBe('pass');
    });
  });

  // ===== 统一通知 S4(评审稿 §6.4 / §6.2):审批结果 → 报名本人定向通知(事务外 + 失败不破坏行为锁) =====
  describe('S4 审批结果定向通知(approve/reject → 报名本人;commit 后事务外)', () => {
    function setupApprove(
      dispatcher: NotificationDispatcherMock = makeNotificationDispatcherMock(),
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
      prisma.activity.findUnique.mockResolvedValue({ title: '周末巡山' });
      const service = makeService(prisma, recorder, stateMachine, dispatcher);
      return { service, prisma, dispatcher };
    }

    it('approve 成功 → 派给报名本人(directed/in-app/activity-reminder),且在 update 之后(commit 外)', async () => {
      const { service, prisma, dispatcher } = setupApprove();
      const result = await service.approve(
        'act-1',
        'reg-1',
        { reviewNote: '材料齐全' },
        makeCurrentUser(),
        META,
      );
      expect(result.statusCode).toBe('pass');
      expect(dispatcher.dispatchTargeted).toHaveBeenCalledTimes(1);
      const arg = dispatcher.dispatchTargeted.mock.calls[0][0];
      expect(arg).toMatchObject({
        recipientMemberId: 'mem-42',
        notificationTypeCode: 'activity-reminder',
        channels: ['in-app'],
        title: '报名已通过',
      });
      expect(arg.body).toContain('周末巡山');
      // 事务外硬证:派发严格在 registration.update(事务内)之后(commit 后才派发,绝不并入事务)
      const updateOrder = prisma.activityRegistration.update.mock.invocationCallOrder[0];
      const dispatchOrder = dispatcher.dispatchTargeted.mock.invocationCallOrder[0];
      expect(dispatchOrder).toBeGreaterThan(updateOrder);
    });

    it('reject 成功 → title 未通过 + body 含活动名 + reviewNote 理由', async () => {
      const dispatcher = makeNotificationDispatcherMock();
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      const stateMachine = makeStateMachineMock({ allowed: true, nextStatusCode: 'reject' });
      prisma.activityRegistration.findFirst.mockResolvedValue(
        makeRegRow({ statusCode: 'pending', activityId: 'act-1', memberId: 'mem-7' }),
      );
      prisma.activityRegistration.update.mockResolvedValue(
        makeRegRow({ statusCode: 'reject', memberId: 'mem-7' }),
      );
      prisma.activity.findUnique.mockResolvedValue({ title: '夜间值守' });
      const service = makeService(prisma, recorder, stateMachine, dispatcher);

      const result = await service.reject(
        'act-1',
        'reg-1',
        { reviewNote: '名额已满' },
        makeCurrentUser(),
        META,
      );
      expect(result.statusCode).toBe('reject');
      const arg = dispatcher.dispatchTargeted.mock.calls[0][0];
      expect(arg).toMatchObject({
        recipientMemberId: 'mem-7',
        notificationTypeCode: 'activity-reminder',
        channels: ['in-app'],
        title: '报名未通过',
      });
      expect(arg.body).toContain('夜间值守');
      expect(arg.body).toContain('名额已满');
    });

    it('派发失败(dispatcher 抛错)→ **审批仍成功**(update 已 commit;不外冒)', async () => {
      const dispatcher = makeNotificationDispatcherMock();
      dispatcher.dispatchTargeted.mockRejectedValue(new Error('dispatch boom'));
      const { service, prisma } = setupApprove(dispatcher);

      const result = await service.approve('act-1', 'reg-1', {}, makeCurrentUser(), META);
      expect(result.statusCode).toBe('pass'); // 业务成功,派发失败被 try-catch 吞
      expect(prisma.activityRegistration.update).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatchTargeted).toHaveBeenCalled();
    });
  });

  describe('audit recorder wiring', () => {
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

  describe('exportCsv (no audit)', () => {
    it('返回 CSV 字符串,且不调用 auditRecorder', async () => {
      const prisma = makePrismaMock();
      const recorder = makeAuditRecorderMock();
      prisma.activity.findFirst.mockResolvedValue(makeActivityRow());
      prisma.activityRegistration.findMany.mockResolvedValue([
        makeRegRow({ member: { memberNo: 'M-1', displayName: 'D-1' } }),
      ]);
      const service = makeService(prisma, recorder, makeStateMachineMock(DENY_DECISION));

      const csv = await service.exportCsv('act-1', {}, makeCurrentUser());

      expect(typeof csv).toBe('string');
      expect(csv).toContain('registration_id');
      expect(recorder.logCreate).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
      expect(recorder.logCancel).not.toHaveBeenCalled();
    });
  });
});
