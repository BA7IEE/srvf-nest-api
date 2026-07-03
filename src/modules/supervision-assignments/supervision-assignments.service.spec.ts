import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import { SupervisionAssignmentsService } from './supervision-assignments.service';

// 终态 scoped-authz PR5 service-level characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
// 锁定建校验纯逻辑 + 撤销状态守卫 + 改任期综合校验 + scope/supervisors 的 closure 展开纯逻辑
// (partial unique 属 DB 层,由 migration 重放 + e2e 兜底):
//   create:任期(TENURE_INVALID)/ supervisor 存在+active(MEMBER_NOT_FOUND/MEMBER_INACTIVE)/
//     org 存在+active(ORGANIZATION_NOT_FOUND/ORGANIZATION_INACTIVE)/ 防重(ALREADY_EXISTS)/ P2002 兜底 /
//     scopeMode 默认 TREE / 不校验持职务;
//   supervision-scope:TREE 经 closure 展开含后代 / EXACT 不展开(不触 closure);
//   supervisors:直接分管 DIRECT + 祖先 TREE 继承 INHERITED,祖先 EXACT 不覆盖;
//   revoke:找不到 NOT_FOUND / 非 active ALREADY_ENDED / active 写 REVOKED + 撤销人 + endedAt;
//   update:找不到 NOT_FOUND / 任期非法 TENURE_INVALID / 透传 scopeMode。
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

// 完整 safeSelect 行(供 toResponseDto)。
function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sup-1',
    supervisorMemberId: 'sup1',
    organizationId: 'org1',
    scopeMode: 'TREE',
    status: 'ACTIVE',
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    endedAt: null,
    appointedByUserId: 'u1',
    revokedByUserId: null,
    note: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

// 默认 happy-path tx:supervisor(active)/ org(active)均存在;count 恒 0(无 dup);create/update 回一行;closure 空。
function makeTx() {
  return {
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'sup1', status: 'ACTIVE' }) },
    organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org1', status: 'ACTIVE' }) },
    organizationClosure: { findMany: jest.fn().mockResolvedValue([]) },
    organizationSupervisionAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(fullRow()),
      update: jest.fn().mockResolvedValue(fullRow({ status: 'REVOKED', revokedByUserId: 'u1' })),
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
  supervisorMemberId: 'sup1memberid',
  organizationId: 'org1orgid000',
  startedAt: '2026-07-01T00:00:00.000Z',
};

function svcWith(tx: ReturnType<typeof makeTx>) {
  return new SupervisionAssignmentsService(makePrisma(tx), rbacAllow, auditNoop);
}

describe('SupervisionAssignmentsService.create', () => {
  it('happy path:透传 supervisor/org + scopeMode 默认 TREE + status=ACTIVE + appointedByUserId + 写 audit', async () => {
    const tx = makeTx();
    const res = await svcWith(tx).create(USER, baseDto, META);
    const data = argN(tx.organizationSupervisionAssignment.create).data ?? {};
    expect(data.supervisorMemberId).toBe('sup1memberid');
    expect(data.organizationId).toBe('org1orgid000');
    expect(data.scopeMode).toBe('TREE');
    expect(data.status).toBe('ACTIVE');
    expect(data.appointedByUserId).toBe('u1');
    expect(res.status).toBe('ACTIVE');
    expect(auditLogMock).toHaveBeenCalled();
  });

  it('scopeMode=EXACT 透传', async () => {
    const tx = makeTx();
    await svcWith(tx).create(USER, { ...baseDto, scopeMode: 'EXACT' }, META);
    expect((argN(tx.organizationSupervisionAssignment.create).data ?? {}).scopeMode).toBe('EXACT');
  });

  it('任期非法:endedAt ≤ startedAt → TENURE_INVALID(不触库)', async () => {
    const tx = makeTx();
    await expect(
      svcWith(tx).create(USER, { ...baseDto, endedAt: '2026-07-01T00:00:00.000Z' }, META),
    ).rejects.toEqual(new BizException(BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID));
    expect(tx.organizationSupervisionAssignment.create).not.toHaveBeenCalled();
  });

  it('supervisor 不存在 → MEMBER_NOT_FOUND', async () => {
    const tx = makeTx();
    tx.member.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_NOT_FOUND),
    );
  });

  it('supervisor 非 active → MEMBER_INACTIVE(不要求持职务,但要求 active)', async () => {
    const tx = makeTx();
    tx.member.findFirst.mockResolvedValue({ id: 'sup1', status: 'INACTIVE' });
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_INACTIVE),
    );
  });

  it('org 不存在 → ORGANIZATION_NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organization.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.ORGANIZATION_NOT_FOUND),
    );
  });

  it('org 非 active → ORGANIZATION_INACTIVE', async () => {
    const tx = makeTx();
    tx.organization.findFirst.mockResolvedValue({ id: 'org1', status: 'INACTIVE' });
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.ORGANIZATION_INACTIVE),
    );
  });

  it('防重:同人对同组织已有 active → ALREADY_EXISTS', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.count.mockResolvedValue(1);
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ALREADY_EXISTS),
    );
    expect(tx.organizationSupervisionAssignment.create).not.toHaveBeenCalled();
  });

  it('并发 P2002 兜底 → ALREADY_EXISTS', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.create.mockRejectedValue(realP2002);
    await expect(svcWith(tx).create(USER, baseDto, META)).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ALREADY_EXISTS),
    );
  });

  // 终态 scoped-authz PR11(2026-07-02):dryRun 沙箱哨兵(announcement-import preview 复用真实校验的机制)。
  it('dryRun=true:走满校验 + 真实 insert + audit 后回滚,返回"本应创建"的响应体', async () => {
    const tx = makeTx();
    const res = await svcWith(tx).create(USER, baseDto, META, { dryRun: true });
    expect(res.status).toBe('ACTIVE');
    expect(tx.organizationSupervisionAssignment.create).toHaveBeenCalledTimes(1);
    expect(auditLogMock).toHaveBeenCalled();
  });

  it('dryRun=true 遇校验失败:仍抛出原 BizException(不是静默通过)', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.count.mockResolvedValue(1);
    await expect(svcWith(tx).create(USER, baseDto, META, { dryRun: true })).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ALREADY_EXISTS),
    );
  });
});

describe('SupervisionAssignmentsService.getSupervisionScope', () => {
  it('TREE:经 closure 展开为「组织 + 全部后代」', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findMany.mockResolvedValue([
      { id: 's1', organizationId: 'org1', scopeMode: 'TREE' },
    ]);
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'org1', descendantId: 'org1' },
      { ancestorId: 'org1', descendantId: 'child1' },
      { ancestorId: 'org1', descendantId: 'grand1' },
    ]);
    const res = await svcWith(tx).getSupervisionScope(USER, 'sup1');
    expect(res).toEqual([
      {
        supervisionAssignmentId: 's1',
        organizationId: 'org1',
        scopeMode: 'TREE',
        expandedOrganizationIds: ['org1', 'child1', 'grand1'],
      },
    ]);
  });

  it('EXACT:仅该节点,不触 closure 展开', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findMany.mockResolvedValue([
      { id: 's2', organizationId: 'org2', scopeMode: 'EXACT' },
    ]);
    const res = await svcWith(tx).getSupervisionScope(USER, 'sup1');
    expect(res[0].expandedOrganizationIds).toEqual(['org2']);
    expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
  });

  it('混合(副队长乙场景):TREE(SECT 含子) + EXACT(SSD 不展开)两条并存', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findMany.mockResolvedValue([
      { id: 'sect', organizationId: 'orgSECT', scopeMode: 'TREE' },
      { id: 'ssd', organizationId: 'orgSSD', scopeMode: 'EXACT' },
    ]);
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'orgSECT', descendantId: 'orgSECT' },
      { ancestorId: 'orgSECT', descendantId: 'orgSECTaction' },
    ]);
    const res = await svcWith(tx).getSupervisionScope(USER, 'huangyong');
    expect(res).toEqual([
      {
        supervisionAssignmentId: 'sect',
        organizationId: 'orgSECT',
        scopeMode: 'TREE',
        expandedOrganizationIds: ['orgSECT', 'orgSECTaction'],
      },
      {
        supervisionAssignmentId: 'ssd',
        organizationId: 'orgSSD',
        scopeMode: 'EXACT',
        expandedOrganizationIds: ['orgSSD'],
      },
    ]);
  });

  it('member 不存在 → MEMBER_NOT_FOUND', async () => {
    const tx = makeTx();
    tx.member.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).getSupervisionScope(USER, 'nope')).rejects.toEqual(
      new BizException(BizCode.MEMBER_NOT_FOUND),
    );
  });
});

describe('SupervisionAssignmentsService.getSupervisors', () => {
  it('直接分管 DIRECT + 祖先 TREE 继承 INHERITED;祖先 EXACT 不覆盖', async () => {
    const tx = makeTx();
    // 查 orgChild 被谁分管;祖先集 = [orgChild(自身), orgParent]
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'orgChild' },
      { ancestorId: 'orgParent' },
    ]);
    tx.organizationSupervisionAssignment.findMany.mockResolvedValue([
      fullRow({ id: 'sd', organizationId: 'orgChild', scopeMode: 'EXACT' }), // 直接(任意 mode)
      fullRow({ id: 'si', organizationId: 'orgParent', scopeMode: 'TREE' }), // 祖先 TREE → 继承
      fullRow({ id: 'sx', organizationId: 'orgParent', scopeMode: 'EXACT' }), // 祖先 EXACT → 排除
    ]);
    const res = await svcWith(tx).getSupervisors(USER, 'orgChild');
    expect(res.map((r) => [r.coverage, r.supervisionAssignment.id])).toEqual([
      ['DIRECT', 'sd'],
      ['INHERITED', 'si'],
    ]);
    // 归属查询按祖先集 IN 过滤
    const where = argN(tx.organizationSupervisionAssignment.findMany).where ?? {};
    expect(where.organizationId).toEqual({ in: ['orgChild', 'orgParent'] });
  });

  it('org 不存在 → ORGANIZATION_NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organization.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).getSupervisors(USER, 'nope')).rejects.toEqual(
      new BizException(BizCode.ORGANIZATION_NOT_FOUND),
    );
  });

  it('closure 缺自身行时兜底把 orgId 纳入 scope', async () => {
    const tx = makeTx();
    tx.organizationClosure.findMany.mockResolvedValue([]); // 无祖先行
    tx.organizationSupervisionAssignment.findMany.mockResolvedValue([]);
    await svcWith(tx).getSupervisors(USER, 'orgSolo');
    const where = argN(tx.organizationSupervisionAssignment.findMany).where ?? {};
    expect(where.organizationId).toEqual({ in: ['orgSolo'] });
  });
});

describe('SupervisionAssignmentsService.revoke', () => {
  it('找不到 → NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).revoke(USER, 'nope', META)).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND),
    );
  });

  it('非 active(已 REVOKED)→ ALREADY_ENDED', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue({
      id: 'sup-1',
      status: 'REVOKED',
      supervisorMemberId: 'sup1',
    });
    await expect(svcWith(tx).revoke(USER, 'sup-1', META)).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ASSIGNMENT_ALREADY_ENDED),
    );
    expect(tx.organizationSupervisionAssignment.update).not.toHaveBeenCalled();
  });

  it('active → 写 REVOKED + revokedByUserId + endedAt + 写 audit', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue({
      id: 'sup-1',
      status: 'ACTIVE',
      supervisorMemberId: 'sup1',
    });
    const res = await svcWith(tx).revoke(USER, 'sup-1', META);
    const data = argN(tx.organizationSupervisionAssignment.update).data ?? {};
    expect(data.status).toBe('REVOKED');
    expect(data.revokedByUserId).toBe('u1');
    expect(data.endedAt).toBeInstanceOf(Date);
    expect(res.status).toBe('REVOKED');
    expect(auditLogMock).toHaveBeenCalled();
  });
});

describe('SupervisionAssignmentsService.update', () => {
  it('找不到 → NOT_FOUND', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue(null);
    await expect(svcWith(tx).update(USER, 'nope', { scopeMode: 'EXACT' })).rejects.toEqual(
      new BizException(BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND),
    );
  });

  it('任期非法(综合现值):新 endedAt ≤ 现 startedAt → TENURE_INVALID', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue({
      id: 'sup-1',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      endedAt: null,
    });
    await expect(
      svcWith(tx).update(USER, 'sup-1', { endedAt: '2026-06-30T00:00:00.000Z' }),
    ).rejects.toEqual(new BizException(BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID));
    expect(tx.organizationSupervisionAssignment.update).not.toHaveBeenCalled();
  });

  it('透传 scopeMode', async () => {
    const tx = makeTx();
    tx.organizationSupervisionAssignment.findFirst.mockResolvedValue({
      id: 'sup-1',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      endedAt: null,
    });
    tx.organizationSupervisionAssignment.update.mockResolvedValue(fullRow({ scopeMode: 'EXACT' }));
    const res = await svcWith(tx).update(USER, 'sup-1', { scopeMode: 'EXACT' });
    expect((argN(tx.organizationSupervisionAssignment.update).data ?? {}).scopeMode).toBe('EXACT');
    expect(res.scopeMode).toBe('EXACT');
  });
});
