import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import { MemberDepartmentsService } from './member-departments.service';
import { MembershipsService } from './memberships.service';

// 终态 scoped-authz PR2 service-level characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
// 锁定两条 PR2-specific 契约(DB partial unique / 回填逻辑属 DB 层,由 migration 重放 + e2e 兜底):
//   1. 旧 member-departments 面重指向 = 只碰 active PRIMARY 行(where 必含 membershipType=PRIMARY + status=ACTIVE);
//      P2002 仍抛 MEMBER_DEPARTMENT_ALREADY_EXISTS(旧契约不变,不用新 17004)。
//   2. 新 memberships 面:create 透传 type + status=ACTIVE + createdByUserId;P2002 抛 MEMBERSHIP_ALREADY_EXISTS(17004);
//      end 置 status=ENDED + endedAt + endedByUserId;找不到 active 归属 → MEMBERSHIP_NOT_FOUND(17003)。
// 边界:rbac.can 恒 true(判权归 e2e);auditLogs.log 恒 resolve(审计形状归 e2e,沿
// supervision-assignments.service.spec.ts 范式);不测真实事务/DB 约束(归 migration 重放 + e2e)。
//
// 审计留痕批(2026-07-03;review #484 G5):补 auditLogMock 断言 —— 4 个写点(memberships.create/end,
// legacy set/remove)调用 audit;update(PATCH)与 set 幂等分支(无状态变更)**不**调用 audit。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const META = { requestId: 'req-1', ip: null, ua: null };

const ACTIVE_MEMBER = { id: 'm1', status: 'ACTIVE' };
const ACTIVE_ORG = { id: 'org1', status: 'ACTIVE' };
const realP2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: 'test',
});

type CallArg = { where?: Record<string, unknown>; data?: Record<string, unknown> };
// 取某 mock 第一次调用的首个实参(cast 到 typed shape → 字段访问产出 unknown,不触发 no-unsafe-*)。
const arg0 = (m: jest.Mock): CallArg => (m.mock.calls as unknown[][])[0]?.[0] ?? {};

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'm1' }]),
    member: { findFirst: jest.fn().mockResolvedValue(ACTIVE_MEMBER) },
    organization: { findFirst: jest.fn().mockResolvedValue(ACTIVE_ORG) },
    memberOrganizationMembership: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: 'ACTIVE',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: null,
      }),
      create: jest.fn().mockResolvedValue({ id: 'mom1', memberId: 'm1', organizationId: 'org1' }),
      update: jest.fn().mockResolvedValue({ id: 'mom1' }),
    },
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>): PrismaService {
  const $transaction = jest.fn<Promise<unknown>, [(t: unknown) => Promise<unknown>]>((cb) =>
    cb(tx),
  );
  return {
    $transaction,
    memberOrganizationMembership: tx.memberOrganizationMembership,
    member: tx.member,
  } as unknown as PrismaService;
}

const rbacAllow = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
const auditLogMock = jest.fn().mockResolvedValue(undefined);
const auditNoop = { log: auditLogMock } as unknown as AuditLogsService;
// F4(2026-07-04):MembershipsService 新增 organizations / members 两依赖(仅 F4 扁平/组织轴方法用;
// 本文件既有用例只测队员轴 CRUD,不触达 —— 传最小 stub,F4 方法行为由 e2e memberships-f4-admin 覆盖)。
const organizationsStub = {
  queryDescendantOrgIds: jest.fn().mockResolvedValue([]),
} as unknown as import('../organizations/organizations.service').OrganizationsService;
const membersStub = {
  options: jest.fn().mockResolvedValue({ items: [] }),
} as unknown as import('../members/members.service').MembersService;

describe('MemberDepartmentsService(重指向 PRIMARY membership)', () => {
  beforeEach(() => {
    auditLogMock.mockClear();
  });

  it('findCurrent 只查 active PRIMARY 行(membershipType=PRIMARY + status=ACTIVE + deletedAt=null)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({ id: 'mom1' });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await svc.findCurrent(USER, 'm1');

    const where = arg0(tx.memberOrganizationMembership.findFirst).where ?? {};
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
    expect(where.membershipType).toBe('PRIMARY');
    expect(where.status).toBe('ACTIVE');
  });

  it('set 换部门:结束旧 active PRIMARY(status=ENDED,不再软删)+ 建新 PRIMARY(单事务)+ 写 audit(viaPath=department,before=旧行)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'old',
      memberId: 'm1',
      organizationId: 'orgX',
    });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await svc.set(USER, 'm1', { organizationId: 'org1' }, META);

    const upd = arg0(tx.memberOrganizationMembership.update);
    expect(upd.where).toEqual({ id: 'old' });
    // v0.40.0 参与域生命周期收口⑥:换部门结束旧 PRIMARY 改 status=ENDED + endedAt + endedByUserId(不再软删)。
    expect((upd.data ?? {}).status).toBe('ENDED');
    expect((upd.data ?? {}).endedAt).toBeInstanceOf(Date);
    expect((upd.data ?? {}).endedByUserId).toBe('u1');
    expect((upd.data ?? {}).deletedAt).toBeUndefined();
    const data = arg0(tx.memberOrganizationMembership.create).data ?? {};
    expect(data.memberId).toBe('m1');
    expect(data.organizationId).toBe('org1');
    expect(data.membershipType).toBe('PRIMARY');
    expect(data.status).toBe('ACTIVE');

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = arg0(auditLogMock) as unknown as {
      event: string;
      before?: { organizationId?: string };
      extra?: { viaPath?: string; operation?: string };
    };
    expect(auditArg.event).toBe('membership.set');
    expect(auditArg.before?.organizationId).toBe('orgX');
    expect(auditArg.extra).toEqual({
      viaPath: 'department',
      operation: 'set',
      targetMemberId: 'm1',
    });
  });

  it('set 幂等:同 org → 直接返回现归属,不软删不新建,不写 audit(无状态变更)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'cur',
      organizationId: 'org1',
    });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await svc.set(USER, 'm1', { organizationId: 'org1' }, META);

    expect(tx.memberOrganizationMembership.update).not.toHaveBeenCalled();
    expect(tx.memberOrganizationMembership.create).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it('set 首次建(无旧 PRIMARY)→ 写 audit(before=undefined)', async () => {
    const tx = makeTx();
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await svc.set(USER, 'm1', { organizationId: 'org1' }, META);

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = arg0(auditLogMock) as unknown as { event: string; before?: unknown };
    expect(auditArg.event).toBe('membership.set');
    expect(auditArg.before).toBeUndefined();
  });

  it('set 撞 P2002 → 旧契约码 MEMBER_DEPARTMENT_ALREADY_EXISTS(非新 17004)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockRejectedValue(realP2002);
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await expect(svc.set(USER, 'm1', { organizationId: 'org1' }, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_DEPARTMENT_ALREADY_EXISTS),
    );
  });

  it('remove 无 active PRIMARY → MEMBER_DEPARTMENT_NOT_FOUND', async () => {
    const svc = new MemberDepartmentsService(makePrisma(makeTx()), rbacAllow, auditNoop);
    await expect(svc.remove(USER, 'm1', META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_DEPARTMENT_NOT_FOUND),
    );
  });

  it('remove 命中 → 写 audit(membership.end,viaPath=department)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'cur',
      memberId: 'm1',
      organizationId: 'org1',
    });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow, auditNoop);

    await svc.remove(USER, 'm1', META);

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = arg0(auditLogMock) as unknown as {
      event: string;
      extra?: { viaPath?: string; operation?: string };
    };
    expect(auditArg.event).toBe('membership.end');
    expect(auditArg.extra).toEqual({
      viaPath: 'department',
      operation: 'remove',
      targetMemberId: 'm1',
    });
  });
});

describe('MembershipsService(终态全归属面)', () => {
  beforeEach(() => {
    auditLogMock.mockClear();
  });

  it('create 透传 membershipType + status=ACTIVE + createdByUserId + 写 audit(viaPath=membership)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockResolvedValue({
      id: 'mom1',
      memberId: 'm1',
      organizationId: 'org1',
      membershipType: 'SECONDARY',
      status: 'ACTIVE',
    });
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );

    await svc.create(USER, 'm1', { organizationId: 'org1', membershipType: 'SECONDARY' }, META);

    const data = arg0(tx.memberOrganizationMembership.create).data ?? {};
    expect(data.memberId).toBe('m1');
    expect(data.organizationId).toBe('org1');
    expect(data.membershipType).toBe('SECONDARY');
    expect(data.status).toBe('ACTIVE');
    expect(data.createdByUserId).toBe('u1');

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = arg0(auditLogMock) as unknown as {
      event: string;
      before?: unknown;
      after?: { membershipType?: string };
      extra?: { viaPath?: string; operation?: string };
    };
    expect(auditArg.event).toBe('membership.set');
    expect(auditArg.before).toBeUndefined();
    expect(auditArg.after?.membershipType).toBe('SECONDARY');
    expect(auditArg.extra).toEqual({
      viaPath: 'membership',
      operation: 'create',
      targetMemberId: 'm1',
    });
  });

  it('create 撞 P2002 → MEMBERSHIP_ALREADY_EXISTS(17004,新面码)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockRejectedValue(realP2002);
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );
    await expect(
      svc.create(USER, 'm1', { organizationId: 'org1', membershipType: 'PRIMARY' }, META),
    ).rejects.toEqual(new BizException(BizCode.MEMBERSHIP_ALREADY_EXISTS));
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it('end 置 status=ENDED + endedAt + endedByUserId(仅 active 可结束)+ 写 audit(viaPath=membership)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'mom1',
      status: 'ACTIVE',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
    });
    tx.memberOrganizationMembership.update.mockResolvedValue({
      id: 'mom1',
      status: 'ENDED',
      endedAt: new Date(),
      endedByUserId: 'u1',
    });
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );

    await svc.end(USER, 'm1', 'mom1', META);

    const where = arg0(tx.memberOrganizationMembership.findFirst).where ?? {};
    expect(where.id).toBe('mom1');
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe('ACTIVE');
    const data = arg0(tx.memberOrganizationMembership.update).data ?? {};
    expect(data.status).toBe('ENDED');
    expect(data.endedByUserId).toBe('u1');
    expect(data.endedAt).toBeInstanceOf(Date);

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = arg0(auditLogMock) as unknown as {
      event: string;
      before?: { status?: string };
      after?: { status?: string };
      extra?: { viaPath?: string; operation?: string };
    };
    expect(auditArg.event).toBe('membership.end');
    expect(auditArg.before).toEqual({ status: 'ACTIVE' });
    expect(auditArg.after?.status).toBe('ENDED');
    expect(auditArg.extra).toEqual({
      viaPath: 'membership',
      operation: 'end',
      targetMemberId: 'm1',
    });
  });

  it('end 找不到 active 归属 → MEMBERSHIP_NOT_FOUND(17003),不写 audit', async () => {
    const svc = new MembershipsService(
      makePrisma(makeTx()),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );
    await expect(svc.end(USER, 'm1', 'nope', META)).rejects.toEqual(
      new BizException(BizCode.MEMBERSHIP_NOT_FOUND),
    );
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it('end 拒绝尚未开始的 ACTIVE 任期,不伪造未来 endedAt', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'mom1',
      status: 'ACTIVE',
      startedAt: new Date('2999-01-01T00:00:00.000Z'),
      endedAt: null,
    });
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );

    await expect(svc.end(USER, 'm1', 'mom1', META)).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(tx.memberOrganizationMembership.update).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it('update 找不到归属 → MEMBERSHIP_NOT_FOUND(17003)', async () => {
    const svc = new MembershipsService(
      makePrisma(makeTx()),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );
    await expect(svc.update(USER, 'm1', 'nope', { reason: 'x' })).rejects.toEqual(
      new BizException(BizCode.MEMBERSHIP_NOT_FOUND),
    );
  });

  it('update(PATCH)成功路径不写 audit(沿 role-binding.update / supervision-assignment.update 先例)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'mom1',
      status: 'ACTIVE',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
    });
    tx.memberOrganizationMembership.update.mockResolvedValue({ id: 'mom1', reason: 'x' });
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );

    await svc.update(USER, 'm1', 'mom1', { reason: 'x' });

    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'future startedAt', dto: { startedAt: '2999-01-01T00:00:00.000Z' } },
    { label: 'ACTIVE endedAt', dto: { endedAt: '2999-01-01T00:00:00.000Z' } },
  ])('update 拒绝 $label,不写任期', async ({ dto }) => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'mom1',
      status: 'ACTIVE',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
    });
    const svc = new MembershipsService(
      makePrisma(tx),
      rbacAllow,
      auditNoop,
      organizationsStub,
      membersStub,
    );

    await expect(svc.update(USER, 'm1', 'mom1', dto)).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(tx.memberOrganizationMembership.update).not.toHaveBeenCalled();
  });
});
