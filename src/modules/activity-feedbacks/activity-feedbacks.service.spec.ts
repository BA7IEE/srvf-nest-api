import type { ConfigType } from '@nestjs/config';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityFeedbacksService } from './activity-feedbacks.service';

const USER: CurrentUserPayload = {
  id: 'user-1',
  username: 'member',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-1',
};

const FEEDBACK = {
  rating: 4,
  comment: '很好',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
};

const ACTIVE_CLOSURE = {
  revision: 1,
  closedAt: new Date('2026-01-15T00:00:00.000Z'),
  settlementVersionId: 'settlement-version-1',
  postingBatchId: 'posting-batch-1',
};

function makeTx() {
  return {
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'activity-1',
        statusCode: 'completed',
      }),
    },
    activitySettlementClosureRevision: {
      findFirst: jest.fn().mockResolvedValue(ACTIVE_CLOSURE),
      findMany: jest.fn().mockResolvedValue([]),
    },
    participantSettlementResultRevision: {
      findFirst: jest.fn().mockResolvedValue({ id: 'result-1' }),
    },
    activityFeedback: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(FEEDBACK),
      update: jest.fn().mockResolvedValue(FEEDBACK),
    },
  };
}

function makeService(overrides?: {
  tx?: ReturnType<typeof makeTx>;
  access?: { canUseApp: boolean; member: { id: string } | null };
  feedbackWindowDays?: number;
}) {
  const tx = overrides?.tx ?? makeTx();
  const transaction = jest.fn((cb: (client: typeof tx) => Promise<unknown>) => cb(tx));
  const prisma = {
    ...tx,
    $transaction: transaction,
  } as unknown as PrismaService;
  const appIdentity = {
    resolve: jest
      .fn()
      .mockResolvedValue(overrides?.access ?? { canUseApp: true, member: { id: 'member-1' } }),
  } as unknown as AppIdentityResolver;
  const config = {
    attendance: { feedbackWindowDays: overrides?.feedbackWindowDays ?? 30 },
  } as unknown as ConfigType<typeof appConfig>;
  return {
    service: new ActivityFeedbacksService(prisma, appIdentity, config),
    tx,
    prisma,
    appIdentity,
    transaction,
  };
}

describe('ActivityFeedbacksService App self flow', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('首次 PUT：active closure + 当前结算资格 + 1 create，scope 锁本人且缺省 comment 入库 null', async () => {
    const { service, tx, transaction } = makeService();

    const result = await service.upsertMine('activity-1', { rating: 5 }, USER);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.activity.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activitySettlementClosureRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.participantSettlementResultRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityFeedback.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityFeedback.create).toHaveBeenCalledTimes(1);
    expect(tx.activityFeedback.update).not.toHaveBeenCalled();
    expect(tx.participantSettlementResultRevision.findFirst).toHaveBeenCalledWith({
      where: {
        settlementVersionId: 'settlement-version-1',
        statusCode: 'committed',
        resultCode: 'present',
        identity: { activityId: 'activity-1', memberId: 'member-1' },
        ledgerEntries: {
          some: {
            postingBatchId: 'posting-batch-1',
            entryTypeCode: 'service_credit',
            serviceHoursDelta: { gt: 0 },
          },
        },
      },
      select: { id: true },
    });
    expect(tx.activityFeedback.create).toHaveBeenCalledWith({
      data: { activityId: 'activity-1', memberId: 'member-1', rating: 5, comment: null },
      select: { rating: true, comment: true, createdAt: true, updatedAt: true },
    });
    expect(result).toEqual({
      feedback: { ...FEEDBACK, eligibilityCorrected: false },
      canSubmit: true,
      windowClosesAt: '2026-02-14T00:00:00.000Z',
    });
  });

  it('重复 PUT：更新同一 live 行，不 create，comment 可清空', async () => {
    const tx = makeTx();
    tx.activityFeedback.findFirst.mockResolvedValue({ id: 'feedback-1' });
    const { service } = makeService({ tx });

    await service.upsertMine('activity-1', { rating: 3, comment: null }, USER);

    expect(tx.activityFeedback.update).toHaveBeenCalledWith({
      where: { id: 'feedback-1' },
      data: { rating: 3, comment: null },
      select: { rating: true, comment: true, createdAt: true, updatedAt: true },
    });
    expect(tx.activityFeedback.create).not.toHaveBeenCalled();
  });

  it('固定闸序：活动非 completed 时先返 35030，不查资格/feedback', async () => {
    const tx = makeTx();
    tx.activity.findFirst.mockResolvedValue({
      id: 'activity-1',
      statusCode: 'published',
    });
    const { service } = makeService({ tx });

    await expect(service.upsertMine('activity-1', { rating: 5 }, USER)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED),
    );
    expect(tx.activitySettlementClosureRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.participantSettlementResultRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.activityFeedback.findFirst).not.toHaveBeenCalled();
  });

  it('无 active closure 的 GET/PUT 均复用 35030，且不查资格/feedback', async () => {
    const tx = makeTx();
    tx.activitySettlementClosureRevision.findFirst.mockResolvedValue(null);
    const { service } = makeService({ tx });

    await expect(service.upsertMine('activity-1', { rating: 5 }, USER)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED),
    );
    await expect(service.getMine('activity-1', USER)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED),
    );
    expect(tx.participantSettlementResultRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.activityFeedback.findFirst).not.toHaveBeenCalled();
  });

  it('窗口边界：now === closure.closedAt+N 天允许；晚 1ms 返 35031', async () => {
    const atBoundary = makeService();
    jest.setSystemTime(new Date('2026-02-14T00:00:00.000Z'));
    await expect(
      atBoundary.service.upsertMine('activity-1', { rating: 1 }, USER),
    ).resolves.toMatchObject({ canSubmit: true });

    const afterBoundary = makeService();
    jest.setSystemTime(new Date('2026-02-14T00:00:00.001Z'));
    await expect(
      afterBoundary.service.upsertMine('activity-1', { rating: 1 }, USER),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_FEEDBACK_WINDOW_CLOSED));
    expect(afterBoundary.tx.participantSettlementResultRevision.findFirst).not.toHaveBeenCalled();
  });

  it('最新结算无 present + service_credit → 35032，且不查/写 feedback', async () => {
    const tx = makeTx();
    tx.participantSettlementResultRevision.findFirst.mockResolvedValue(null);
    const { service } = makeService({ tx });

    await expect(service.upsertMine('activity-1', { rating: 5 }, USER)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED),
    );
    expect(tx.activityFeedback.findFirst).not.toHaveBeenCalled();
    expect(tx.activityFeedback.create).not.toHaveBeenCalled();
  });

  it('并发首次 create 的真实 P2002 → 35002，不泄露 Prisma 异常', async () => {
    const tx = makeTx();
    tx.activityFeedback.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const { service } = makeService({ tx });

    await expect(service.upsertMine('activity-1', { rating: 5 }, USER)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_FEEDBACK_ALREADY_EXISTS),
    );
  });

  it('GET 无评价恒 200 形态：feedback=null 且准确返回 canSubmit/window', async () => {
    const { service, tx } = makeService();

    await expect(service.getMine('activity-1', USER)).resolves.toEqual({
      feedback: null,
      canSubmit: true,
      windowClosesAt: '2026-02-14T00:00:00.000Z',
    });
    expect(tx.activity.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activitySettlementClosureRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.participantSettlementResultRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityFeedback.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityFeedback.findFirst).toHaveBeenCalledWith({
      where: { activityId: 'activity-1', memberId: 'member-1', deletedAt: null },
      select: { rating: true, comment: true, createdAt: true, updatedAt: true },
    });
  });

  it('GET 只返回本人 live feedback；窗口关闭后保留 feedback 但 canSubmit=false', async () => {
    const tx = makeTx();
    tx.activityFeedback.findFirst.mockResolvedValue(FEEDBACK);
    const { service } = makeService({ tx });
    jest.setSystemTime(new Date('2026-02-15T00:00:00.000Z'));

    await expect(service.getMine('activity-1', USER)).resolves.toEqual({
      feedback: { ...FEEDBACK, eligibilityCorrected: false },
      canSubmit: false,
      windowClosesAt: '2026-02-14T00:00:00.000Z',
    });
  });

  it('最新纠错撤销资格时保留历史评价并标 eligibilityCorrected=true', async () => {
    const tx = makeTx();
    tx.activitySettlementClosureRevision.findFirst.mockResolvedValue({
      ...ACTIVE_CLOSURE,
      revision: 2,
    });
    tx.activitySettlementClosureRevision.findMany.mockResolvedValue([
      { settlementVersionId: 'settlement-version-1', postingBatchId: 'posting-batch-1' },
    ]);
    tx.participantSettlementResultRevision.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'prior-result-1' });
    tx.activityFeedback.findFirst.mockResolvedValue(FEEDBACK);
    const { service } = makeService({ tx });

    await expect(service.getMine('activity-1', USER)).resolves.toEqual({
      feedback: { ...FEEDBACK, eligibilityCorrected: true },
      canSubmit: false,
      windowClosesAt: '2026-02-14T00:00:00.000Z',
    });
    expect(tx.activitySettlementClosureRevision.findMany).toHaveBeenCalledWith({
      where: { activityId: 'activity-1', statusCode: 'superseded', revision: { lt: 2 } },
      select: { settlementVersionId: true, postingBatchId: true },
      orderBy: { revision: 'desc' },
    });
  });

  it('AppIdentityResolver 拒绝时复用 40300，业务表 0 查询', async () => {
    const { service, tx } = makeService({ access: { canUseApp: false, member: null } });

    await expect(service.getMine('activity-1', USER)).rejects.toEqual(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(tx.activity.findFirst).not.toHaveBeenCalled();
    expect(tx.activitySettlementClosureRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.participantSettlementResultRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.activityFeedback.findFirst).not.toHaveBeenCalled();
  });
});
