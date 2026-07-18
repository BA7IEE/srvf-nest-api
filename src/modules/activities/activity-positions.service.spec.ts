import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthzService } from '../authz/authz.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher';
import type { RbacService } from '../permissions/rbac.service';
import type { ActivityPositionAuditRecorder } from './activity-position-audit-recorder';
import { ActivityPositionsService } from './activity-positions.service';

const ACTIVITY_ID = 'activity-0001';
const ACTIVITY_POSITION_ID = 'activity-position-0001';
const START = new Date('2026-08-01T08:00:00.000Z');
const END = new Date('2026-08-01T12:00:00.000Z');
const META: AuditMeta = { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' };
const USER: CurrentUserPayload = {
  id: 'user-0001',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function activityPositionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVITY_POSITION_ID,
    activityId: ACTIVITY_ID,
    name: '现场保障',
    attendanceRoleCode: 'support',
    capacity: 3,
    startAt: new Date('2026-08-01T09:00:00.000Z'),
    endAt: new Date('2026-08-01T11:00:00.000Z'),
    genderRequirementCode: null,
    description: null,
    sortOrder: 1,
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

type ActivityPositionFixture = ReturnType<typeof activityPositionRow>;

function makeMocks() {
  const prisma = {
    activity: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: ACTIVITY_ID, startAt: START, endAt: END, capacity: null }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: ACTIVITY_ID, startAt: START, endAt: END, capacity: null }),
    },
    activityPosition: {
      findMany: jest.fn<Promise<ActivityPositionFixture[]>, [unknown]>().mockResolvedValue([]),
      findFirst: jest.fn<Promise<ActivityPositionFixture | null>, [unknown]>(),
      create: jest.fn<Promise<ActivityPositionFixture>, [unknown]>(),
      update: jest.fn<Promise<ActivityPositionFixture>, [unknown]>(),
    },
    activityRegistration: {
      count: jest.fn().mockResolvedValue(0),
    },
    dictItem: {
      findFirst: jest.fn().mockResolvedValue({ id: 'dict-item-1' }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: ACTIVITY_ID }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) =>
    callback(prisma),
  );

  const auditRecorder = {
    logCreate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logUpdate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logSoftDelete: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
  const rbac = { can: jest.fn().mockResolvedValue(false) };
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' }),
  };
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
  const notificationDispatcher = { dispatchTargeted: jest.fn().mockResolvedValue(undefined) };
  const service = new ActivityPositionsService(
    prisma as unknown as PrismaService,
    auditRecorder as unknown as ActivityPositionAuditRecorder,
    auditLogs as unknown as AuditLogsService,
    rbac as unknown as RbacService,
    authz as unknown as AuthzService,
    notificationDispatcher as unknown as NotificationDispatcher,
  );
  return { prisma, auditRecorder, auditLogs, rbac, authz, notificationDispatcher, service };
}

describe('ActivityPositionsService', () => {
  it('list 先校验 activity live 存在，再按固定三键列出 live 岗位', async () => {
    const { prisma, service } = makeMocks();
    prisma.activityPosition.findMany.mockResolvedValue([activityPositionRow()]);

    const result = await service.list(ACTIVITY_ID);

    expect(result).toHaveLength(1);
    expect(prisma.activity.findFirst).toHaveBeenCalledWith({
      where: { id: ACTIVITY_ID, deletedAt: null },
      select: { id: true, startAt: true, endAt: true, capacity: true },
    });
    expect(prisma.activityPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: ACTIVITY_ID, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('findOne 的软删或跨活动岗位统一 ACTIVITY_POSITION_NOT_FOUND', async () => {
    const { prisma, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(null);

    await expect(service.findOne(ACTIVITY_ID, ACTIVITY_POSITION_ID)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_POSITION_NOT_FOUND),
    );
    expect(prisma.activityPosition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTIVITY_POSITION_ID, activityId: ACTIVITY_ID, deletedAt: null },
      }),
    );
  });

  it('create 锁 Activity、校验两类字典/时间并在同事务写 audit', async () => {
    const { prisma, auditRecorder, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(null);
    prisma.activityPosition.create.mockResolvedValue(activityPositionRow());

    const result = await service.create(
      ACTIVITY_ID,
      {
        name: '现场保障',
        attendanceRoleCode: 'support',
        capacity: 3,
        startAt: '2026-08-01T09:00:00.000Z',
        endAt: '2026-08-01T11:00:00.000Z',
        genderRequirementCode: 'any',
        sortOrder: 1,
      },
      USER,
      META,
    );

    expect(result.activityPositionId).toBe(ACTIVITY_POSITION_ID);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.dictItem.findFirst).toHaveBeenCalledTimes(2);
    expect(auditRecorder.logCreate).toHaveBeenCalledTimes(1);
    const createAuditArgs = auditRecorder.logCreate.mock.calls[0][0] as {
      activityPosition: { id: string };
    };
    expect(createAuditArgs.activityPosition.id).toBe(ACTIVITY_POSITION_ID);
    expect(auditRecorder.logCreate.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.activityPosition.create.mock.invocationCallOrder[0],
    );
  });

  it('create 时间不同空或越出活动窗 → ACTIVITY_POSITION_TIME_RANGE_INVALID', async () => {
    const { prisma, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        ACTIVITY_ID,
        {
          name: '现场保障',
          attendanceRoleCode: 'support',
          startAt: '2026-08-01T07:00:00.000Z',
          endAt: null,
        },
        USER,
        META,
      ),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID));
    expect(prisma.activityPosition.create).not.toHaveBeenCalled();
  });

  it('partial unique 的 P2002 统一映射同名岗位 BizCode', async () => {
    const { prisma, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(null);
    prisma.activityPosition.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6.19.2',
      }),
    );

    await expect(
      service.create(ACTIVITY_ID, { name: '现场保障', attendanceRoleCode: 'support' }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS));
  });

  it('update 容量基线与 passCount 均在 Activity 行锁后读取', async () => {
    const { prisma, auditRecorder, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(activityPositionRow({ capacity: 2 }));
    prisma.activityRegistration.count.mockResolvedValue(2);
    prisma.activityPosition.update.mockResolvedValue(activityPositionRow({ capacity: 4 }));

    await service.update(ACTIVITY_ID, ACTIVITY_POSITION_ID, { capacity: 4 }, USER, META);

    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.activityPosition.findFirst.mock.invocationCallOrder[0],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.activityRegistration.count.mock.invocationCallOrder[0],
    );
    expect(prisma.activityRegistration.count).toHaveBeenCalledWith({
      where: {
        activityId: ACTIVITY_ID,
        activityPositionId: ACTIVITY_POSITION_ID,
        statusCode: 'pass',
        deletedAt: null,
      },
    });
    expect(auditRecorder.logUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: ['capacity'] }),
    );
  });

  it('update 缩容低于本岗位 passCount → ACTIVITY_POSITION_CAPACITY_INVALID', async () => {
    const { prisma, auditRecorder, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(activityPositionRow({ capacity: 5 }));
    prisma.activityRegistration.count.mockResolvedValue(3);

    await expect(
      service.update(ACTIVITY_ID, ACTIVITY_POSITION_ID, { capacity: 2 }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_POSITION_CAPACITY_INVALID));
    expect(prisma.activityPosition.update).not.toHaveBeenCalled();
    expect(auditRecorder.logUpdate).not.toHaveBeenCalled();
  });

  it('softDelete 存在 pending/pass/waitlisted 报名时拒绝且不写 audit', async () => {
    const { prisma, auditRecorder, service } = makeMocks();
    prisma.activityPosition.findFirst.mockResolvedValue(activityPositionRow());
    prisma.activityRegistration.count.mockResolvedValue(1);

    await expect(service.softDelete(ACTIVITY_ID, ACTIVITY_POSITION_ID, USER, META)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS),
    );
    expect(prisma.activityRegistration.count).toHaveBeenCalledWith({
      where: {
        activityId: ACTIVITY_ID,
        activityPositionId: ACTIVITY_POSITION_ID,
        statusCode: { in: ['pending', 'pass', 'waitlisted'] },
        deletedAt: null,
      },
    });
    expect(prisma.activityPosition.update).not.toHaveBeenCalled();
    expect(auditRecorder.logSoftDelete).not.toHaveBeenCalled();
  });

  it('softDelete 无活跃报名时只写 deletedAt，并记录 before/after', async () => {
    const { prisma, auditRecorder, service } = makeMocks();
    const before = activityPositionRow();
    const after = activityPositionRow({ deletedAt: new Date('2026-07-16T01:00:00.000Z') });
    prisma.activityPosition.findFirst.mockResolvedValue(before);
    prisma.activityPosition.update.mockResolvedValue(after);

    const result = await service.softDelete(ACTIVITY_ID, ACTIVITY_POSITION_ID, USER, META);

    expect(result.activityPositionId).toBe(ACTIVITY_POSITION_ID);
    expect(prisma.activityPosition.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.activityPosition.update.mock.calls[0][0] as {
      where: { id: string };
      data: { deletedAt: unknown };
    };
    expect(updateArgs.where).toEqual({ id: ACTIVITY_POSITION_ID });
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
    expect(auditRecorder.logSoftDelete).toHaveBeenCalledWith(
      expect.objectContaining({ before, after }),
    );
  });

  it('resource_not_found 决策对 GLOBAL 持码者回退 rbac.can，再交业务层返回真实 404', async () => {
    const { prisma, authz, rbac, service } = makeMocks();
    authz.explain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
    rbac.can.mockResolvedValue(true);
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      service.create(ACTIVITY_ID, { name: '现场保障', attendanceRoleCode: 'support' }, USER, META),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_NOT_FOUND));
    expect(rbac.can).toHaveBeenCalledWith(USER, 'activity.update.record');
  });
});
