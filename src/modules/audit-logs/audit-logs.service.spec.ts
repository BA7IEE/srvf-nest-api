import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import { AuditLogsService, type AuditLogInput } from './audit-logs.service';
import type { AuditMeta } from './audit-logs.types';

// V2 第一阶段批次 6 audit_logs service 单元测试。
// 覆盖:
// 1. log() 写入路径:context 锁形(3 必填 + 3 可选)/ tx 透传 / null 字段
// 2. findOne() 权限路径:SUPER 全过 / ADMIN 看自己 / ADMIN 看 USER / ADMIN 越级查 SUPER →
//    14101 / 不存在 → 14001
//
// list() 涉及 $transaction + findMany + count 复杂 mock,留 e2e 覆盖(D6 v1.1 §12.1)。

const META: AuditMeta = {
  requestId: 'c1xqgkb0000001abcdef234567',
  ip: '127.0.0.1',
  ua: 'jest/30.x',
};

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'user-self-id',
    username: 'self',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    ...overrides,
  };
}

// log() 实际写入 prisma.auditLog.create({ data: { ... } }) 的形状(典型字段)。
// 单元测试只关心 data 部分,这里显式建模避免 unsafe member access。
interface CreatedData {
  actorUserId: string | null;
  actorRoleSnap: Role | null;
  resourceType: string;
  resourceId: string | null;
  event: string;
  context: AuditContextShape;
  success?: boolean;
}

interface AuditContextShape {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

// 最小 mock:只 mock 业务用到的方法,其他成员不需要
function makePrismaMock() {
  return {
    auditLog: {
      create: jest.fn<Promise<void>, [{ data: CreatedData }]>().mockResolvedValue(undefined),
      findUnique: jest.fn<Promise<unknown>, [{ where: { id: string }; select: unknown }]>(),
    },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;

function lastCreateData(prisma: PrismaMock): CreatedData {
  const calls = prisma.auditLog.create.mock.calls;
  if (calls.length === 0) throw new Error('expected auditLog.create to have been called');
  return calls[calls.length - 1][0].data;
}

describe('AuditLogsService', () => {
  describe('log()', () => {
    it('最简:不传 before / after / extra,context 只含 3 必填字段', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);
      const input: AuditLogInput = {
        event: 'emergency-contact.write',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'emergency_contact',
        resourceId: 'ec-1',
        meta: META,
      };

      await service.log(input);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const data = lastCreateData(prisma);
      expect(data.context).toEqual({
        requestId: META.requestId,
        ip: META.ip,
        ua: META.ua,
      });
      // success 不显式传(走 schema default true)
      expect(data.success).toBeUndefined();
    });

    it('带 before:context 含 4 字段(3 必填 + before)', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);
      const before = { contactName: '张*', phonePrimary: '138****1111' };

      await service.log({
        event: 'emergency-contact.write',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'emergency_contact',
        resourceId: 'ec-1',
        meta: META,
        before,
      });

      expect(lastCreateData(prisma).context).toEqual({
        requestId: META.requestId,
        ip: META.ip,
        ua: META.ua,
        before,
      });
    });

    it('带 after:context 含 4 字段(3 必填 + after)', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);
      const after = { contactName: '王**', priority: 0 };

      await service.log({
        event: 'emergency-contact.write',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'emergency_contact',
        resourceId: 'ec-1',
        meta: META,
        after,
      });

      expect(lastCreateData(prisma).context).toEqual({
        requestId: META.requestId,
        ip: META.ip,
        ua: META.ua,
        after,
      });
    });

    it('带 extra:context 含 4 字段(3 必填 + extra)', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);
      const extra = { targetMemberId: 'mem-1', operation: 'create' };

      await service.log({
        event: 'certificate.create',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: 'cert-1',
        meta: META,
        extra,
      });

      expect(lastCreateData(prisma).context).toEqual({
        requestId: META.requestId,
        ip: META.ip,
        ua: META.ua,
        extra,
      });
    });

    it('before + after + extra 全部传:context 含 6 字段', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await service.log({
        event: 'certificate.update',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: 'cert-1',
        meta: META,
        before: { certStatusCode: 'pending' },
        after: { certStatusCode: 'verified' },
        extra: { targetMemberId: 'mem-1' },
      });

      const ctx = lastCreateData(prisma).context;
      expect(Object.keys(ctx).sort()).toEqual(
        ['after', 'before', 'extra', 'ip', 'requestId', 'ua'].sort(),
      );
    });

    it('meta.ip / meta.ua 为 null:仍写入字段,值为 null', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await service.log({
        event: 'emergency-contact.write',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'emergency_contact',
        resourceId: 'ec-1',
        meta: { requestId: META.requestId, ip: null, ua: null },
      });

      const ctx = lastCreateData(prisma).context;
      expect(ctx.ip).toBeNull();
      expect(ctx.ua).toBeNull();
      // 字段必须存在(锁形)
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('actorUserId / resourceId 为 null:落库 null', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await service.log({
        event: 'emergency-contact.write',
        actorUserId: null,
        actorRoleSnap: null,
        resourceType: 'emergency_contact',
        resourceId: null,
        meta: META,
      });

      const data = lastCreateData(prisma);
      expect(data.actorUserId).toBeNull();
      expect(data.actorRoleSnap).toBeNull();
      expect(data.resourceId).toBeNull();
    });

    it('tx 透传:使用 tx.auditLog.create,而非 prisma.auditLog.create', async () => {
      const prisma = makePrismaMock();
      const service = new AuditLogsService(prisma as unknown as PrismaService);
      const txCreate = jest
        .fn<Promise<void>, [{ data: CreatedData }]>()
        .mockResolvedValue(undefined);
      const tx = { auditLog: { create: txCreate } };

      await service.log({
        event: 'certificate.create',
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: 'cert-1',
        meta: META,
        // service 接口 tx 类型是 Prisma.TransactionClient,这里给的是最小契约 mock
        tx: tx as never,
      });

      expect(txCreate).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('findOne() 权限矩阵', () => {
    interface AuditRow {
      id: string;
      createdAt: Date;
      actorUserId: string | null;
      actorRoleSnap: Role | null;
      resourceType: string;
      resourceId: string | null;
      event: string;
      context: AuditContextShape;
      success: boolean;
    }

    function makeRow(overrides: Partial<AuditRow> = {}): AuditRow {
      return {
        id: 'log-1',
        createdAt: new Date('2026-05-12T10:00:00.000Z'),
        actorUserId: 'actor-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'emergency_contact',
        resourceId: 'ec-1',
        event: 'emergency-contact.write',
        context: { requestId: META.requestId, ip: META.ip, ua: META.ua },
        success: true,
        ...overrides,
      };
    }

    it('不存在 → 14001 AUDIT_LOG_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(null);
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await expect(
        service.findOne('non-existent', makeCurrentUser({ role: Role.SUPER_ADMIN })),
      ).rejects.toEqual(new BizException(BizCode.AUDIT_LOG_NOT_FOUND));
    });

    it('SUPER_ADMIN 看 SUPER_ADMIN 操作的记录 → 通过', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(makeRow({ actorRoleSnap: Role.SUPER_ADMIN }));
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      const res = await service.findOne('log-1', makeCurrentUser({ role: Role.SUPER_ADMIN }));
      expect(res.id).toBe('log-1');
    });

    it('ADMIN 看自己操作的记录(actorUserId === self.id)→ 通过', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(
        makeRow({ actorUserId: 'user-self-id', actorRoleSnap: Role.ADMIN }),
      );
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      const res = await service.findOne('log-1', makeCurrentUser({ id: 'user-self-id' }));
      expect(res.id).toBe('log-1');
    });

    it('ADMIN 看 USER 操作的记录(actorRoleSnap === USER)→ 通过', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(
        makeRow({ actorUserId: 'other-user', actorRoleSnap: Role.USER }),
      );
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      const res = await service.findOne('log-1', makeCurrentUser({ role: Role.ADMIN }));
      expect(res.id).toBe('log-1');
    });

    it('ADMIN 越级查 SUPER_ADMIN 的 detail → 14101 FORBIDDEN_AUDIT_LOG_READ', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(
        makeRow({ actorUserId: 'super-admin-id', actorRoleSnap: Role.SUPER_ADMIN }),
      );
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await expect(service.findOne('log-1', makeCurrentUser({ role: Role.ADMIN }))).rejects.toEqual(
        new BizException(BizCode.FORBIDDEN_AUDIT_LOG_READ),
      );
    });

    it('ADMIN 查另一个 ADMIN 操作的记录 → 14101', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(
        makeRow({ actorUserId: 'other-admin', actorRoleSnap: Role.ADMIN }),
      );
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await expect(service.findOne('log-1', makeCurrentUser({ role: Role.ADMIN }))).rejects.toEqual(
        new BizException(BizCode.FORBIDDEN_AUDIT_LOG_READ),
      );
    });

    it('USER 防御性 fallback → 14101(实际 Guard 已挡,此用例覆盖 race 场景)', async () => {
      const prisma = makePrismaMock();
      prisma.auditLog.findUnique.mockResolvedValue(makeRow());
      const service = new AuditLogsService(prisma as unknown as PrismaService);

      await expect(service.findOne('log-1', makeCurrentUser({ role: Role.USER }))).rejects.toEqual(
        new BizException(BizCode.FORBIDDEN_AUDIT_LOG_READ),
      );
    });
  });
});
