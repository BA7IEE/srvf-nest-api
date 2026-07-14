import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthzService } from '../authz/authz.service';
import type { PrismaService } from '../../database/prisma.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import type { RbacService } from '../permissions/rbac.service';
import { MembersService } from './members.service';

// 队员账号闭环 v1 收尾补丁(2026-07-07,元核验 P3):runWithUniqueConstraintGuard 的
// memberId 分支 characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
// 锁定:两个管理员并发对同一队员 grantAccount 时,输家 INSERT 撞 memberId 唯一约束 →
// MEMBER_HAS_LINKED_USER(语义同 grantAccount 第 462-466 行 existingLink 预检查);既有
// username 分支回归哨兵(逐字不动);非 P2002 / 未映射 target 原样上抛(§5 数组判断铁律,
// 不误吞他键冲突)。grantAccount 主流程 / 校验顺序 / 审计 / 全链登录由既有 19 例
// members-account-grant.e2e-spec.ts 覆盖,本文件不重复。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const META = { requestId: 'req-1', ip: null, ua: null };

const ACTIVE_MEMBER = { id: 'm1', memberNo: 'm-001', status: 'ACTIVE' };

function makeTx() {
  return {
    member: { findFirst: jest.fn().mockResolvedValue(ACTIVE_MEMBER) },
    user: {
      findFirst: jest.fn().mockResolvedValue(null), // existingLink 预检查未命中(竞态窗口)
      findUnique: jest.fn().mockResolvedValue(null), // username/phone 预检查未命中(两次调用共用)
      // 队员账号闭环 v2:computeNextUsername 的 count(0 = 该 memberId 从未创建过 User,
      // 沿用裸 memberNo,与本文件既有用例的 v1 行为逐字一致)。
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(), // 逐用例覆写
    },
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>): PrismaService {
  const $transaction = jest.fn<Promise<unknown>, [(t: unknown) => Promise<unknown>]>((cb) =>
    cb(tx),
  );
  return { $transaction } as unknown as PrismaService;
}

const rbacAllow = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
const authzAllow = {
  explain: jest.fn().mockResolvedValue({ allow: true, reason: 'matched' }),
} as unknown as AuthzService;
const lastAdminProtectionNoop = {
  assertCanDeactivateOpsAdminUser: jest.fn().mockResolvedValue(undefined),
} as unknown as LastAdminProtectionPolicy;
const auditNoop = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogsService;
const organizationsStub = {} as unknown as OrganizationsService; // grantAccount 不触达

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('MembersService.grantAccount — runWithUniqueConstraintGuard P2002 兜底', () => {
  it('target 含 memberId → MEMBER_HAS_LINKED_USER(并发双开号,输家 INSERT 撞 memberId 唯一约束)', async () => {
    const tx = makeTx();
    tx.user.create.mockRejectedValue(p2002(['memberId']));
    const service = new MembersService(
      makePrisma(tx),
      rbacAllow,
      authzAllow,
      lastAdminProtectionNoop,
      organizationsStub,
      auditNoop,
    );

    await expect(service.grantAccount('m1', { phone: '13800000001' }, USER, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_HAS_LINKED_USER),
    );
  });

  it('target 含手写 partial index 字面量名 User_memberId_active_key → 仍 MEMBER_HAS_LINKED_USER(队员账号闭环 v2,评审稿 §1.2 E-4)', async () => {
    const tx = makeTx();
    tx.user.create.mockRejectedValue(p2002(['User_memberId_active_key']));
    const service = new MembersService(
      makePrisma(tx),
      rbacAllow,
      authzAllow,
      lastAdminProtectionNoop,
      organizationsStub,
      auditNoop,
    );

    await expect(service.grantAccount('m1', { phone: '13800000006' }, USER, META)).rejects.toEqual(
      new BizException(BizCode.MEMBER_HAS_LINKED_USER),
    );
  });

  it('target 含 username → 仍 USERNAME_ALREADY_EXISTS(既有分支回归哨兵,逐字不动)', async () => {
    const tx = makeTx();
    tx.user.create.mockRejectedValue(p2002(['username']));
    const service = new MembersService(
      makePrisma(tx),
      rbacAllow,
      authzAllow,
      lastAdminProtectionNoop,
      organizationsStub,
      auditNoop,
    );

    await expect(service.grantAccount('m1', { phone: '13800000002' }, USER, META)).rejects.toEqual(
      new BizException(BizCode.USERNAME_ALREADY_EXISTS),
    );
  });

  it('P2002 但 target 不含已映射键(memberNo/username/phone/memberId)→ 原样上抛,不误吞他键冲突', async () => {
    const tx = makeTx();
    const unmapped = p2002(['someOtherColumn']);
    tx.user.create.mockRejectedValue(unmapped);
    const service = new MembersService(
      makePrisma(tx),
      rbacAllow,
      authzAllow,
      lastAdminProtectionNoop,
      organizationsStub,
      auditNoop,
    );

    await expect(service.grantAccount('m1', { phone: '13800000003' }, USER, META)).rejects.toBe(
      unmapped,
    );
  });

  it('非 P2002 错误 → 原样上抛', async () => {
    const tx = makeTx();
    const other = new Error('boom');
    tx.user.create.mockRejectedValue(other);
    const service = new MembersService(
      makePrisma(tx),
      rbacAllow,
      authzAllow,
      lastAdminProtectionNoop,
      organizationsStub,
      auditNoop,
    );

    await expect(service.grantAccount('m1', { phone: '13800000004' }, USER, META)).rejects.toBe(
      other,
    );
  });
});
