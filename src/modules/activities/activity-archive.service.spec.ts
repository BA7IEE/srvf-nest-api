import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivitiesService } from './activities.service';
import { ActivityArchivePolicy, STALE_DRAFT_ARCHIVE_DAYS } from './activity-archive-policy';
import { ActivityArchiveService } from './activity-archive.service';
import type { ActivityAuditRecorder } from './activity-audit-recorder';
import type { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityStateMachine } from './activity-state-machine';

/*
 * 归档写路径的**留痕**判据(goal §3 / DoD:「这个活动被归档过又撤销过」查得出来吗?)。
 *
 * 🔴 判据形状:断言的是**交给 Prisma 的 `data`**,不是返回值。
 *    返回值断言对「撤销时顺手把 archivedAt 抹了」这类缺陷是失明的 ——
 *    抹掉之后返回值该有的字段照样有(它们来自同一次 update 的 select)。
 * 🔴 每一维各自成 `it`:jest 首个失败即停,合并会让变异下的红集不可读。
 *
 * ⚠️ 真链路(行锁 / 幂等 unique / 事务回滚 / HTTP 判权)由 e2e 承担,本 spec 不冒充它们:
 *    这里的 prisma 是 mock,`FOR UPDATE` 与 `claimAtStatus` 的并发语义在这里观测不到。
 */

const NOW = new Date('2026-08-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const user = { id: 'user-1', role: 'ADMIN', memberId: 'member-1' } as unknown as CurrentUserPayload;
const auditMeta = { ip: '127.0.0.1', userAgent: 'jest' } as unknown as AuditMeta;

type ActivityRowOverrides = Record<string, unknown>;

function makeActivityRow(overrides: ActivityRowOverrides = {}): Record<string, unknown> {
  return {
    id: 'act-1',
    title: '演练',
    activityTypeCode: 'training',
    organizationId: 'org-1',
    startAt: new Date('2026-01-01T00:00:00.000Z'),
    endAt: new Date('2026-01-02T00:00:00.000Z'),
    location: '深圳',
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
    isPublicRegistration: true,
    registrationSchema: null,
    coverImageUrl: null,
    galleryImageUrls: null,
    content: null,
    locationLongitude: null,
    locationLatitude: null,
    archiveWaitingDays: 7,
    updatedAt: new Date(NOW.getTime() - (STALE_DRAFT_ARCHIVE_DAYS + 1) * DAY_MS),
    archivedAt: null,
    archivedByUserId: null,
    archivedFromStatusCode: null,
    archiveReasonCode: null,
    archiveOperationKey: null,
    archiveRequestHash: null,
    unarchivedAt: null,
    unarchivedByUserId: null,
    unarchiveOperationKey: null,
    unarchiveRequestHash: null,
    ...overrides,
  };
}

function makeHarness(current: Record<string, unknown>, closedAt: Date | null = null) {
  const activityUpdate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...current, ...args.data }),
  );
  const activityFindUnique = jest.fn().mockResolvedValue(null);
  const tx = {
    activity: { update: activityUpdate, findUnique: activityFindUnique },
    activitySettlementClosureRevision: {
      findFirst: jest.fn().mockResolvedValue(closedAt === null ? null : { closedAt }),
    },
    // claimAtStatus 与 readAuthoritativeNow 共用 tx.$queryRaw:
    // 前者只看数组非空,后者读 authoritativeNow —— 同一行同时满足两者。
    $queryRaw: jest.fn().mockResolvedValue([{ id: current.id, authoritativeNow: NOW }]),
  };
  const prisma = {
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const activities = {
    lockActivityForLifecycle: jest.fn().mockResolvedValue(current),
  } as unknown as ActivitiesService;
  // 判权锚的两个 spy 单独持出:直接 `expect(policy.assertX)` 会触发
  // @typescript-eslint/unbound-method(把方法从对象上摘下来传递)。
  const assertInitiatorOrOverride = jest.fn().mockResolvedValue(undefined);
  const assertOwnerOrOverride = jest.fn().mockResolvedValue(undefined);
  const responsibilityPolicy = {
    assertInitiatorOrOverride,
    assertOwnerOrOverride,
  } as unknown as ActivityResponsibilityPolicy;
  const auditRecorder = {
    logArchive: jest.fn().mockResolvedValue(undefined),
    logUnarchive: jest.fn().mockResolvedValue(undefined),
  } as unknown as ActivityAuditRecorder;
  const service = new ActivityArchiveService(
    prisma,
    activities,
    new ActivityStateMachine(),
    new ActivityArchivePolicy(),
    responsibilityPolicy,
    auditRecorder,
  );
  return {
    service,
    activityUpdate,
    activityFindUnique,
    assertInitiatorOrOverride,
    assertOwnerOrOverride,
  };
}

function writtenData(fn: jest.Mock): Record<string, unknown> {
  const calls = fn.mock.calls as Array<[{ data: Record<string, unknown> }]>;
  const first = calls[0];
  if (first === undefined) throw new Error('activity.update 从未被调用');
  return first[0].data;
}

describe('ActivityArchiveService', () => {
  describe('archive 写入的事实', () => {
    it('把 statusCode 推到 archived', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow());
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      expect(writtenData(activityUpdate).statusCode).toBe('archived');
    });

    it('冻下归档前的状态(撤销归档唯一的复原依据)', async () => {
      const { service, activityUpdate } = makeHarness(
        makeActivityRow({ statusCode: 'completed' }),
        new Date(NOW.getTime() - 8 * DAY_MS),
      );
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      expect(writtenData(activityUpdate).archivedFromStatusCode).toBe('completed');
    });

    it('记下走的是哪一套开工条件:草稿路径 ⇒ stale_draft', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow());
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      expect(writtenData(activityUpdate).archiveReasonCode).toBe('stale_draft');
    });

    it('记下走的是哪一套开工条件:结算路径 ⇒ settled', async () => {
      const { service, activityUpdate } = makeHarness(
        makeActivityRow({ statusCode: 'completed', updatedAt: NOW }),
        new Date(NOW.getTime() - 8 * DAY_MS),
      );
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      expect(writtenData(activityUpdate).archiveReasonCode).toBe('settled');
    });

    it('记下归档人与归档时刻(时刻取同事务 now(),不取本机墙钟)', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow());
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      const data = writtenData(activityUpdate);
      expect(data.archivedByUserId).toBe('user-1');
      expect(data.archivedAt).toEqual(NOW);
    });

    it('条件不满足时一行都不写(刚碰过的草稿 ⇒ 20155,update 零调用)', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow({ updatedAt: NOW }));
      await expect(
        service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE));
      expect(activityUpdate).not.toHaveBeenCalled();
    });

    it('已办完但没关账 ⇒ 20156,update 零调用(交叉反向:陈旧度撬不开结算路径)', async () => {
      const { service, activityUpdate } = makeHarness(
        makeActivityRow({ statusCode: 'completed' }),
        null,
      );
      await expect(
        service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED));
      expect(activityUpdate).not.toHaveBeenCalled();
    });

    it('cancelled 活动不进任何一套条件 ⇒ 状态机先拒(20030)', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow({ statusCode: 'cancelled' }));
      await expect(
        service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(activityUpdate).not.toHaveBeenCalled();
    });

    it('草稿以发起人为锚判权(草稿没有责任行,要 owner 会让草稿谁都归不了档)', async () => {
      const { service, assertInitiatorOrOverride, assertOwnerOrOverride } =
        makeHarness(makeActivityRow());
      await service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta);
      expect(assertInitiatorOrOverride).toHaveBeenCalledTimes(1);
      expect(assertOwnerOrOverride).not.toHaveBeenCalled();
    });
  });

  describe('unarchive:复原 + 留痕不被抹', () => {
    const archivedRow = (from: string) =>
      makeActivityRow({
        statusCode: 'archived',
        archivedAt: new Date(NOW.getTime() - DAY_MS),
        archivedByUserId: 'user-9',
        archivedFromStatusCode: from,
        archiveReasonCode: from === 'draft' ? 'stale_draft' : 'settled',
        archiveOperationKey: 'op-archive-1',
        archiveRequestHash: 'hash-1',
      });

    it('复原到归档时冻下来的状态', async () => {
      const { service, activityUpdate } = makeHarness(archivedRow('published'));
      await service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta);
      expect(writtenData(activityUpdate).statusCode).toBe('published');
    });

    it('记下撤销人与撤销时刻', async () => {
      const { service, activityUpdate } = makeHarness(archivedRow('draft'));
      await service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta);
      const data = writtenData(activityUpdate);
      expect(data.unarchivedByUserId).toBe('user-1');
      expect(data.unarchivedAt).toEqual(NOW);
    });

    // 🔴 本刀的核心留痕不变式。撤销时把归档三件事实抹掉,「归过又撤过」就查不出来了 ——
    //    而那正是维护者拍板③要的东西。这四条各自成 `it`。
    it.each(['archivedAt', 'archivedByUserId', 'archivedFromStatusCode', 'archiveReasonCode'])(
      '撤销归档**不写** %s(留痕不清空)',
      async (field) => {
        const { service, activityUpdate } = makeHarness(archivedRow('published'));
        await service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta);
        expect(writtenData(activityUpdate)).not.toHaveProperty(field);
      },
    );

    it('撤销后「归过又撤过」在同一行上查得出来(两侧时刻同时非 NULL)', async () => {
      const current = archivedRow('published');
      const { service, activityUpdate } = makeHarness(current);
      await service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta);
      // update 的 mock 返回 { ...current, ...data } —— 即撤销后库里那一行的形状。
      const after = (await activityUpdate.mock.results[0].value) as Record<string, unknown>;
      expect(after.archivedAt).not.toBeNull();
      expect(after.unarchivedAt).not.toBeNull();
      expect(after.statusCode).toBe('published');
    });

    it('归档前状态缺失时拒,不猜一个常量回退', async () => {
      const { service, activityUpdate } = makeHarness(
        makeActivityRow({ statusCode: 'archived', archivedFromStatusCode: null }),
      );
      await expect(
        service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(activityUpdate).not.toHaveBeenCalled();
    });

    it('非归档态不能撤销归档', async () => {
      const { service, activityUpdate } = makeHarness(makeActivityRow({ statusCode: 'draft' }));
      await expect(
        service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
      expect(activityUpdate).not.toHaveBeenCalled();
    });

    it('归档前是草稿时,撤销仍以发起人为锚(否则草稿归档后谁都撤不回来)', async () => {
      const { service, assertInitiatorOrOverride, assertOwnerOrOverride } = makeHarness(
        archivedRow('draft'),
      );
      await service.unarchive('act-1', { operationKey: 'op-unarchive-1' }, user, auditMeta);
      expect(assertInitiatorOrOverride).toHaveBeenCalledTimes(1);
      expect(assertOwnerOrOverride).not.toHaveBeenCalled();
    });
  });

  describe('幂等重放', () => {
    it('同 key 同 payload 的归档重放返回原结果,不写第二次', async () => {
      const { service, activityUpdate, activityFindUnique } = makeHarness(makeActivityRow());
      const first = await service.archive(
        'act-1',
        { operationKey: 'op-archive-1' },
        user,
        auditMeta,
      );
      // 第二发:让 findUnique 命中第一发写下的那一行。
      activityFindUnique.mockResolvedValue({
        id: 'act-1',
        statusCode: 'archived',
        archivedAt: first.occurredAt,
        archiveReasonCode: first.reasonCode,
        archivedFromStatusCode: first.archivedFromStatusCode,
        archiveRequestHash: (writtenData(activityUpdate).archiveRequestHash as string) ?? '',
      });
      const replayed = await service.archive(
        'act-1',
        { operationKey: 'op-archive-1' },
        user,
        auditMeta,
      );

      expect(replayed).toEqual(first);
      expect(activityUpdate).toHaveBeenCalledTimes(1);
    });

    it('同 key 不同 payload ⇒ 操作键冲突(不静默再归档一次)', async () => {
      const { service, activityFindUnique } = makeHarness(makeActivityRow());
      activityFindUnique.mockResolvedValue({
        id: 'act-1',
        statusCode: 'archived',
        archivedAt: NOW,
        archiveReasonCode: 'stale_draft',
        archivedFromStatusCode: 'draft',
        archiveRequestHash: 'some-other-hash',
      });
      await expect(
        service.archive(
          'act-1',
          { operationKey: 'op-archive-1', reason: '换了理由' },
          user,
          auditMeta,
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT));
    });

    it('拿上一轮的归档 key 想在撤销之后再归一次 ⇒ 冲突,不静默再归档', async () => {
      const { service, activityFindUnique, activityUpdate } = makeHarness(makeActivityRow());
      // 库里那一行:key 还在,但已经被撤销归档(statusCode 不再是 archived)。
      activityFindUnique.mockResolvedValue({
        id: 'act-1',
        statusCode: 'draft',
        archivedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        archiveReasonCode: 'stale_draft',
        archivedFromStatusCode: 'draft',
        archiveRequestHash: 'hash-whatever',
      });
      await expect(
        service.archive('act-1', { operationKey: 'op-archive-1' }, user, auditMeta),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT));
      expect(activityUpdate).not.toHaveBeenCalled();
    });
  });
});
