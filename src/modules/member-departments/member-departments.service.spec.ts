import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
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
// 边界:rbac.can 恒 true(判权归 e2e);不测真实事务/DB 约束(归 migration 重放 + e2e)。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

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
    member: { findFirst: jest.fn().mockResolvedValue(ACTIVE_MEMBER) },
    organization: { findFirst: jest.fn().mockResolvedValue(ACTIVE_ORG) },
    memberOrganizationMembership: {
      findFirst: jest.fn().mockResolvedValue(null),
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

describe('MemberDepartmentsService(重指向 PRIMARY membership)', () => {
  it('findCurrent 只查 active PRIMARY 行(membershipType=PRIMARY + status=ACTIVE + deletedAt=null)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({ id: 'mom1' });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow);

    await svc.findCurrent(USER, 'm1');

    const where = arg0(tx.memberOrganizationMembership.findFirst).where ?? {};
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
    expect(where.membershipType).toBe('PRIMARY');
    expect(where.status).toBe('ACTIVE');
  });

  it('set 换部门:软删旧 active PRIMARY + 建新 PRIMARY(单事务)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'old',
      organizationId: 'orgX',
    });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow);

    await svc.set(USER, 'm1', { organizationId: 'org1' });

    const upd = arg0(tx.memberOrganizationMembership.update);
    expect(upd.where).toEqual({ id: 'old' });
    expect((upd.data ?? {}).deletedAt).toBeInstanceOf(Date);
    const data = arg0(tx.memberOrganizationMembership.create).data ?? {};
    expect(data.memberId).toBe('m1');
    expect(data.organizationId).toBe('org1');
    expect(data.membershipType).toBe('PRIMARY');
    expect(data.status).toBe('ACTIVE');
  });

  it('set 幂等:同 org → 直接返回现归属,不软删不新建', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({
      id: 'cur',
      organizationId: 'org1',
    });
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow);

    await svc.set(USER, 'm1', { organizationId: 'org1' });

    expect(tx.memberOrganizationMembership.update).not.toHaveBeenCalled();
    expect(tx.memberOrganizationMembership.create).not.toHaveBeenCalled();
  });

  it('set 撞 P2002 → 旧契约码 MEMBER_DEPARTMENT_ALREADY_EXISTS(非新 17004)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockRejectedValue(realP2002);
    const svc = new MemberDepartmentsService(makePrisma(tx), rbacAllow);

    await expect(svc.set(USER, 'm1', { organizationId: 'org1' })).rejects.toEqual(
      new BizException(BizCode.MEMBER_DEPARTMENT_ALREADY_EXISTS),
    );
  });

  it('remove 无 active PRIMARY → MEMBER_DEPARTMENT_NOT_FOUND', async () => {
    const svc = new MemberDepartmentsService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.remove(USER, 'm1')).rejects.toEqual(
      new BizException(BizCode.MEMBER_DEPARTMENT_NOT_FOUND),
    );
  });
});

describe('MembershipsService(终态全归属面)', () => {
  it('create 透传 membershipType + status=ACTIVE + createdByUserId', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockResolvedValue({ id: 'mom1' });
    const svc = new MembershipsService(makePrisma(tx), rbacAllow);

    await svc.create(USER, 'm1', { organizationId: 'org1', membershipType: 'SECONDARY' });

    const data = arg0(tx.memberOrganizationMembership.create).data ?? {};
    expect(data.memberId).toBe('m1');
    expect(data.organizationId).toBe('org1');
    expect(data.membershipType).toBe('SECONDARY');
    expect(data.status).toBe('ACTIVE');
    expect(data.createdByUserId).toBe('u1');
  });

  it('create 撞 P2002 → MEMBERSHIP_ALREADY_EXISTS(17004,新面码)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.create.mockRejectedValue(realP2002);
    const svc = new MembershipsService(makePrisma(tx), rbacAllow);
    await expect(
      svc.create(USER, 'm1', { organizationId: 'org1', membershipType: 'PRIMARY' }),
    ).rejects.toEqual(new BizException(BizCode.MEMBERSHIP_ALREADY_EXISTS));
  });

  it('end 置 status=ENDED + endedAt + endedByUserId(仅 active 可结束)', async () => {
    const tx = makeTx();
    tx.memberOrganizationMembership.findFirst.mockResolvedValue({ id: 'mom1' });
    const svc = new MembershipsService(makePrisma(tx), rbacAllow);

    await svc.end(USER, 'm1', 'mom1');

    const where = arg0(tx.memberOrganizationMembership.findFirst).where ?? {};
    expect(where.id).toBe('mom1');
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe('ACTIVE');
    const data = arg0(tx.memberOrganizationMembership.update).data ?? {};
    expect(data.status).toBe('ENDED');
    expect(data.endedByUserId).toBe('u1');
    expect(data.endedAt).toBeInstanceOf(Date);
  });

  it('end 找不到 active 归属 → MEMBERSHIP_NOT_FOUND(17003)', async () => {
    const svc = new MembershipsService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.end(USER, 'm1', 'nope')).rejects.toEqual(
      new BizException(BizCode.MEMBERSHIP_NOT_FOUND),
    );
  });

  it('update 找不到归属 → MEMBERSHIP_NOT_FOUND(17003)', async () => {
    const svc = new MembershipsService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.update(USER, 'm1', 'nope', { reason: 'x' })).rejects.toEqual(
      new BizException(BizCode.MEMBERSHIP_NOT_FOUND),
    );
  });
});
