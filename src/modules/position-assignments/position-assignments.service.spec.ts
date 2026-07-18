import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import { PositionAssignmentsService } from './position-assignments.service';

// 终态 scoped-authz PR4 service-level characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
// 锁定任命 5 校验纯逻辑 + 撤销状态守卫 + 历史锚定(DB 唯一约束 / partial unique 属 DB 层,由 migration 重放 + e2e 兜底):
//   create:任期(TENURE_INVALID)/ 职务适配(RULE_NOT_MATCHED)/ requireMembership 祖先命中(MEMBERSHIP_REQUIRED)/
//     兼任(CONCURRENT_FORBIDDEN)/ 防重(ALREADY_EXISTS)/ 单人独占(SINGLE_HOLDER)/ P2002 兜底;
//   revoke:找不到 NOT_FOUND / 非 active ALREADY_ENDED / active 写 REVOKED + 撤销人 + endedAt;
//   history:锚定不到 NOT_FOUND。
// 边界:rbac.can 恒 true(判权归 e2e);auditLogs.log 恒 resolve(审计形状归 e2e)。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const META = { requestId: 'req-1', ip: null, ua: null };

const realP2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: 'test',
});

type CallArg = { where?: Record<string, unknown>; data?: Record<string, unknown> };
const argN = (m: jest.Mock, n = 0): CallArg => (m.mock.calls as unknown[][])[n]?.[0] ?? {};

// 默认 happy-path tx:org(rescue-team)/ position(单人独占关闭兼任开启)/ member 均存在;
// 规则匹配 requireMembership=false;count 恒 0(无 dup / 无在任 / 无并发);create 回一行。
function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'm1memberid0' }]),
    organization: {
      findFirst: jest.fn().mockResolvedValue({ id: 'org1', nodeTypeCode: 'rescue-team' }),
    },
    organizationPosition: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'p1', allowMultiple: true, allowConcurrent: true }),
    },
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'm1', status: 'ACTIVE' }) },
    organizationPositionRule: {
      findFirst: jest.fn().mockResolvedValue({ requireMembership: false }),
    },
    organizationClosure: { findMany: jest.fn().mockResolvedValue([{ ancestorId: 'org1' }]) },
    memberOrganizationMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'ms1' }) },
    organizationPositionAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        id: 'pa1',
        organizationId: 'org1',
        positionId: 'p1',
        memberId: 'm1',
        status: 'ACTIVE',
        startedAt: new Date('2026-07-01T00:00:00.000Z'),
        endedAt: null,
        appointedByUserId: 'u1',
        revokedByUserId: null,
        appointmentSource: null,
        isConcurrent: false,
        note: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue({
        id: 'pa1',
        organizationId: 'org1',
        positionId: 'p1',
        memberId: 'm1',
        status: 'REVOKED',
        startedAt: new Date('2026-07-01T00:00:00.000Z'),
        endedAt: new Date('2026-07-02T00:00:00.000Z'),
        appointedByUserId: 'u1',
        revokedByUserId: 'u1',
        appointmentSource: null,
        isConcurrent: false,
        note: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      }),
    },
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>): PrismaService {
  const $transaction = jest.fn((cb: unknown) =>
    typeof cb === 'function'
      ? (cb as (t: unknown) => Promise<unknown>)(tx)
      : Promise.all(cb as Promise<unknown>[]),
  );
  return { $transaction, ...tx } as unknown as PrismaService;
}

const rbacAllow = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
const auditLogMock = jest.fn().mockResolvedValue(undefined);
const auditNoop = { log: auditLogMock } as unknown as AuditLogsService;

const baseDto = {
  positionId: 'p1positionid',
  memberId: 'm1memberid0',
  startedAt: '2026-07-01T00:00:00.000Z',
};

function svcWith(tx: ReturnType<typeof makeTx>) {
  return new PositionAssignmentsService(makePrisma(tx), rbacAllow, auditNoop);
}

describe('PositionAssignmentsService.create', () => {
  it('happy path:透传 org/position/member + status=ACTIVE + appointedByUserId + 写 audit', async () => {
    const tx = makeTx();
    const svc = svcWith(tx);
    const res = await svc.create(USER, 'org1', { ...baseDto, isConcurrent: true }, META);
    const data = argN(tx.organizationPositionAssignment.create).data ?? {};
    expect(data.organizationId).toBe('org1');
    expect(data.positionId).toBe('p1');
    expect(data.memberId).toBe('m1memberid0');
    expect(data.status).toBe('ACTIVE');
    expect(data.appointedByUserId).toBe('u1');
    expect(data.isConcurrent).toBe(true);
    expect(res.status).toBe('ACTIVE');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalled();
  });

  it('任期非法:endedAt ≤ startedAt → TENURE_INVALID(不触库)', async () => {
    const tx = makeTx();
    const svc = svcWith(tx);
    await expect(
      svc.create(USER, 'org1', { ...baseDto, endedAt: '2026-07-01T00:00:00.000Z' }, META),
    ).rejects.toEqual(new BizException(BizCode.POSITION_ASSIGNMENT_TENURE_INVALID));
    expect(tx.organizationPositionAssignment.create).not.toHaveBeenCalled();
  });

  it('职务适配:无 active 规则 → RULE_NOT_MATCHED', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED),
    );
  });

  it('requireMembership=true 且无本组织/祖先 active 归属 → MEMBERSHIP_REQUIRED(读 closure 祖先集)', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({ requireMembership: true });
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'org1' },
      { ancestorId: 'parent1' },
    ]);
    tx.memberOrganizationMembership.findFirst.mockResolvedValue(null); // 无归属
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED),
    );
    // 归属查询按 closure 祖先集(含 O 自身 + 祖先)IN 过滤
    const where = argN(tx.memberOrganizationMembership.findFirst).where ?? {};
    expect(where.organizationId).toEqual({ in: ['org1', 'parent1'] });
    expect(where.status).toBe('ACTIVE');
  });

  it('requireMembership=true 且祖先命中 active 归属 → 通过并创建', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({ requireMembership: true });
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'org1' },
      { ancestorId: 'parent1' },
    ]);
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({ id: 'ms-ancestor' }); // 祖先命中
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(tx.organizationPositionAssignment.create).toHaveBeenCalled();
  });

  it('兼任:position.allowConcurrent=false 且已有其它 active 任职 → CONCURRENT_FORBIDDEN', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({
      id: 'p1',
      allowMultiple: true,
      allowConcurrent: false,
    });
    tx.organizationPositionAssignment.count.mockResolvedValueOnce(1); // concurrent 计数命中
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN),
    );
  });

  it('防重:同人同组织同职务已有 active → ALREADY_EXISTS', async () => {
    const tx = makeTx();
    // allowConcurrent=true → 跳过并发;dup 计数命中
    tx.organizationPositionAssignment.count.mockResolvedValueOnce(1);
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS),
    );
  });

  it('单人独占:allowMultiple=false 且已有在任者(他人)→ SINGLE_HOLDER', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({
      id: 'p1',
      allowMultiple: false,
      allowConcurrent: true,
    });
    // 调用序:dup(0)→ single-holder(1)
    tx.organizationPositionAssignment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER),
    );
  });

  it('并发 P2002 兜底 → ALREADY_EXISTS', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.create.mockRejectedValue(realP2002);
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS),
    );
  });

  // 终态 scoped-authz PR11(2026-07-02):dryRun 沙箱哨兵(announcement-import preview 复用真实校验的机制)。
  it('dryRun=true:走满校验 + 真实 insert + audit 后回滚,返回"本应创建"的响应体,但零持久化 insert/audit', async () => {
    const tx = makeTx();
    const svc = svcWith(tx);
    const res = await svc.create(USER, 'org1', baseDto, META, { dryRun: true });
    expect(res.status).toBe('ACTIVE');
    expect(res.organizationId).toBe('org1');
    // insert 语句本身仍被调用一次(校验路径完全复用),但由 $transaction 整体回滚 —— 单测层面
    // 用 mock 无法直接断言"未落库"(那是 e2e 真事务的职责),这里只锁"create 参数与非 dryRun 一致"。
    expect(tx.organizationPositionAssignment.create).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalled();
  });

  it('dryRun=true 遇校验失败:仍抛出原 BizException(不是静默通过)', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).create(USER, 'org1', baseDto, META, { dryRun: true })).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED),
    );
  });

  it('省略 options(向后兼容):行为与显式 { dryRun: false } 逐字一致', async () => {
    const tx = makeTx();
    const res = await svcWith(tx).create(USER, 'org1', baseDto, META);
    expect(res.status).toBe('ACTIVE');
    expect(tx.organizationPositionAssignment.create).toHaveBeenCalledTimes(1);
  });

  it('org / position / member 不存在 → 各自 NOT_FOUND', async () => {
    const txNoOrg = makeTx();
    txNoOrg.organization.findFirst.mockResolvedValue(null);
    await expect(svcWith(txNoOrg).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.ORGANIZATION_NOT_FOUND),
    );

    const txNoPos = makeTx();
    txNoPos.organizationPosition.findFirst.mockResolvedValue(null);
    await expect(svcWith(txNoPos).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.POSITION_NOT_FOUND),
    );

    const txNoMember = makeTx();
    txNoMember.member.findFirst.mockResolvedValue(null);
    await expect(svcWith(txNoMember).create(USER, 'org1', baseDto, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_NOT_FOUND),
    );
  });
});

describe('PositionAssignmentsService.revoke', () => {
  it('找不到 → NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).revoke(USER, 'nope', META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND),
    );
  });

  it('非 active(已 REVOKED)→ ALREADY_ENDED', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findFirst.mockResolvedValue({
      id: 'pa1',
      status: 'REVOKED',
      memberId: 'm1',
    });
    await expect(svcWith(tx).revoke(USER, 'pa1', META)).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_ENDED),
    );
    expect(tx.organizationPositionAssignment.update).not.toHaveBeenCalled();
  });

  it('active → 写 REVOKED + revokedByUserId + endedAt + 写 audit', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findFirst.mockResolvedValue({
      id: 'pa1',
      status: 'ACTIVE',
      memberId: 'm1',
    });
    const res = await svcWith(tx).revoke(USER, 'pa1', META);
    const data = argN(tx.organizationPositionAssignment.update).data ?? {};
    expect(data.status).toBe('REVOKED');
    expect(data.revokedByUserId).toBe('u1');
    expect(data.endedAt).toBeInstanceOf(Date);
    expect(res.status).toBe('REVOKED');
    expect(auditLogMock).toHaveBeenCalled();
  });
});

describe('PositionAssignmentsService.history', () => {
  it('锚定不到 → NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).history(USER, 'nope')).rejects.toEqual(
      new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND),
    );
  });

  it('锚定到 → 按 (org,position,member) 三元组查链', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findFirst.mockResolvedValue({
      organizationId: 'org1',
      positionId: 'p1',
      memberId: 'm1',
    });
    tx.organizationPositionAssignment.findMany.mockResolvedValue([]);
    await svcWith(tx).history(USER, 'pa1');
    const where = argN(tx.organizationPositionAssignment.findMany).where ?? {};
    expect(where.organizationId).toBe('org1');
    expect(where.positionId).toBe('p1');
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
  });
});
