import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
} from '@prisma/client';
import request from 'supertest';
import { normalizeDateOnly } from '../../src/common/datetime/date-only.util';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

interface ResponseBody<T> {
  code: number;
  message: string;
  data: T;
}

interface OverviewSelfItem {
  id: string;
  insurerName: string;
  policyNumber: string;
  coverageStart: string | null;
  coverageEnd: string;
  reviewStatusCode: string;
  version: number;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  dateStatus: 'upcoming' | 'active' | 'expired';
}

interface OverviewTeamItem {
  coverageId: string;
  policyId: string;
  insurerName: string;
  coverageStart: string;
  coverageEnd: string;
  coverageAddedAt: string;
  dateStatus: 'upcoming' | 'active' | 'expired';
}

interface OverviewData {
  memberId: string;
  asOfDate: string;
  summary: {
    dateActiveSelfPurchasedCount: number;
    confirmedActiveSelfPurchasedCount: number;
    dateActiveTeamProvidedCount: number;
    hasConfirmedCoverage: boolean;
    confirmedCoverageThrough: string | null;
  };
  selfPurchased: OverviewSelfItem[];
  teamProvided: OverviewTeamItem[];
}

describe('GET /api/admin/v1/members/:memberId/insurances/overview', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auditLogs: AuditLogsService;
  let reviewerUserId: string;
  let saAuth: string;
  let bizAdminAuth: string;
  let plainAdminAuth: string;
  let userAuth: string;
  let scopedAuth: string;
  let inScopeOrganizationId: string;
  let outOfScopeOrganizationId: string;
  let seq = 0;

  const next = (prefix: string): string => `${prefix}-${++seq}`;
  const overviewPath = (memberId: string): string =>
    `/api/admin/v1/members/${memberId}/insurances/overview`;

  function beijingDateOnlyOffset(days: number): Date {
    const result = normalizeDateOnly(new Date().toISOString());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  async function createMember(organizationId?: string, deletedAt: Date | null = null) {
    const member = await prisma.member.create({
      data: {
        memberNo: next('OVERVIEW-M'),
        displayName: '保险概览测试队员',
        deletedAt,
      },
      select: { id: true },
    });
    if (organizationId) {
      await prisma.memberOrganizationMembership.create({
        data: {
          memberId: member.id,
          organizationId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
      });
    }
    return member;
  }

  async function createSelfInsurance(
    memberId: string,
    input: {
      id?: string;
      start: Date | null;
      end: Date;
      status?: 'pending' | 'verified' | 'rejected';
      deletedAt?: Date | null;
    },
  ) {
    const reviewed = input.status === 'verified' || input.status === 'rejected';
    return prisma.memberInsurance.create({
      data: {
        id: input.id,
        memberId,
        insurerName: `个人保险公司-${next('self')}`,
        policyNumber: next('SELF-POLICY'),
        coverageStart: input.start,
        coverageEnd: input.end,
        reviewStatusCode: input.status ?? 'pending',
        reviewedByUserId: reviewed ? reviewerUserId : null,
        reviewedAt: reviewed ? new Date() : null,
        deletedAt: input.deletedAt ?? null,
      },
    });
  }

  async function createTeamCoverage(
    memberId: string,
    input: {
      coverageId?: string;
      start: Date;
      end: Date;
      coverageDeletedAt?: Date | null;
      policyDeletedAt?: Date | null;
    },
  ) {
    const policy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: `团队保险公司-${next('team')}`,
        policyNumber: next('TEAM-POLICY-SECRET'),
        coverageStart: input.start,
        coverageEnd: input.end,
        note: '团队保单敏感备注',
        deletedAt: input.policyDeletedAt ?? null,
      },
    });
    const coverage = await prisma.teamInsuranceCoverage.create({
      data: {
        id: input.coverageId,
        policyId: policy.id,
        memberId,
        deletedAt: input.coverageDeletedAt ?? null,
      },
    });
    return { policy, coverage };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    auditLogs = app.get(AuditLogsService);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    const sa = await createTestUser(app, { username: 'overview-sa', role: Role.SUPER_ADMIN });
    reviewerUserId = sa.id;
    const bizAdmin = await createTestUser(app, {
      username: 'overview-biz-admin',
      role: Role.ADMIN,
    });
    await grantBizAdminToUser(app, bizAdmin.id, bizAdminRoleId);
    await createTestUser(app, { username: 'overview-plain-admin', role: Role.ADMIN });
    await createTestUser(app, { username: 'overview-user', role: Role.USER });
    const scoped = await createTestUser(app, {
      username: 'overview-scoped-admin',
      role: Role.ADMIN,
    });

    saAuth = (await loginAs(app, 'overview-sa')).authHeader;
    bizAdminAuth = (await loginAs(app, 'overview-biz-admin')).authHeader;
    plainAdminAuth = (await loginAs(app, 'overview-plain-admin')).authHeader;
    userAuth = (await loginAs(app, 'overview-user')).authHeader;
    scopedAuth = (await loginAs(app, 'overview-scoped-admin')).authHeader;

    inScopeOrganizationId = (
      await prisma.organization.create({
        data: { name: '保险概览范围内组织', code: next('OV-IN'), nodeTypeCode: 'department' },
        select: { id: true },
      })
    ).id;
    outOfScopeOrganizationId = (
      await prisma.organization.create({
        data: { name: '保险概览范围外组织', code: next('OV-OUT'), nodeTypeCode: 'department' },
        select: { id: true },
      })
    ).id;
    await prisma.organizationClosure.createMany({
      data: [
        {
          ancestorId: inScopeOrganizationId,
          descendantId: inScopeOrganizationId,
          depth: 0,
        },
        {
          ancestorId: outOfScopeOrganizationId,
          descendantId: outOfScopeOrganizationId,
          depth: 0,
        },
      ],
    });

    const permission = await prisma.permission.findFirstOrThrow({
      where: { code: 'member-insurance.read.other' },
      select: { id: true },
    });
    const scopedRole = await prisma.rbacRole.create({
      data: { code: next('overview-reader'), displayName: '保险概览 scoped reader' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: scopedRole.id, permissionId: permission.id },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: scoped.id,
        roleId: scopedRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: inScopeOrganizationId,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('仅团队覆盖时返回安全投影并形成 confirmed summary，且固定两类查询各一次', async () => {
    const member = await createMember();
    const team = await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: beijingDateOnlyOffset(10),
    });
    const selfQuery = jest.spyOn(prisma.memberInsurance, 'findMany');
    const teamQuery = jest.spyOn(prisma.teamInsuranceCoverage, 'findMany');

    try {
      const response = await request(httpServer(app))
        .get(overviewPath(member.id))
        .set('Authorization', bizAdminAuth)
        .expect(200);
      const data = (response.body as ResponseBody<OverviewData>).data;

      expect(data.memberId).toBe(member.id);
      expect(data.asOfDate).toBe(normalizeDateOnly(new Date().toISOString()).toISOString());
      expect(data.selfPurchased).toEqual([]);
      expect(data.teamProvided).toHaveLength(1);
      expect(data.teamProvided[0]).toEqual({
        coverageId: team.coverage.id,
        policyId: team.policy.id,
        insurerName: team.policy.insurerName,
        coverageStart: team.policy.coverageStart.toISOString(),
        coverageEnd: team.policy.coverageEnd.toISOString(),
        coverageAddedAt: team.coverage.createdAt.toISOString(),
        dateStatus: 'active',
      });
      expect(Object.keys(data.teamProvided[0]).sort()).toEqual(
        [
          'coverageAddedAt',
          'coverageEnd',
          'coverageId',
          'coverageStart',
          'dateStatus',
          'insurerName',
          'policyId',
        ].sort(),
      );
      expect(data.summary).toEqual({
        dateActiveSelfPurchasedCount: 0,
        confirmedActiveSelfPurchasedCount: 0,
        dateActiveTeamProvidedCount: 1,
        hasConfirmedCoverage: true,
        confirmedCoverageThrough: team.policy.coverageEnd.toISOString(),
      });
      expect(selfQuery).toHaveBeenCalledTimes(1);
      expect(teamQuery).toHaveBeenCalledTimes(1);
    } finally {
      selfQuery.mockRestore();
      teamQuery.mockRestore();
    }
  });

  it('个人与团队并存：北京日边界、审核完整性、最大确认到期日和稳定排序均由后端派生', async () => {
    const member = await createMember();
    const today = beijingDateOnlyOffset(0);
    const verified = await createSelfInsurance(member.id, {
      id: next('self-active-a'),
      start: today,
      end: beijingDateOnlyOffset(20),
      status: 'verified',
    });
    const pending = await createSelfInsurance(member.id, {
      id: next('self-active-b'),
      start: null,
      end: beijingDateOnlyOffset(20),
      status: 'pending',
    });
    const rejected = await createSelfInsurance(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: today,
      status: 'rejected',
    });
    const upcoming = await createSelfInsurance(member.id, {
      start: beijingDateOnlyOffset(1),
      end: beijingDateOnlyOffset(30),
    });
    const expired = await createSelfInsurance(member.id, {
      start: beijingDateOnlyOffset(-30),
      end: beijingDateOnlyOffset(-1),
    });
    const team = await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-1),
      end: beijingDateOnlyOffset(40),
    });

    const response = await request(httpServer(app))
      .get(overviewPath(member.id))
      .set('Authorization', bizAdminAuth)
      .expect(200);
    const data = (response.body as ResponseBody<OverviewData>).data;

    expect(data.selfPurchased.map((item) => item.id)).toEqual([
      verified.id,
      pending.id,
      rejected.id,
      upcoming.id,
      expired.id,
    ]);
    expect(data.selfPurchased.map((item) => item.dateStatus)).toEqual([
      'active',
      'active',
      'active',
      'upcoming',
      'expired',
    ]);
    expect(data.selfPurchased[0]).not.toHaveProperty('reviewedByUserId');
    expect(data.selfPurchased[0]).not.toHaveProperty('reviewer');
    expect(data.teamProvided[0].coverageId).toBe(team.coverage.id);
    expect(data.summary).toEqual({
      dateActiveSelfPurchasedCount: 3,
      confirmedActiveSelfPurchasedCount: 1,
      dateActiveTeamProvidedCount: 1,
      hasConfirmedCoverage: true,
      confirmedCoverageThrough: team.policy.coverageEnd.toISOString(),
    });
  });

  it('verified 脏行缺 reviewer/reviewedAt 时不计 confirmed，且无确认来源返回 null', async () => {
    const member = await createMember();
    const asOfDate = normalizeDateOnly(new Date().toISOString());
    const dirtyRow = {
      id: next('dirty-verified'),
      insurerName: '脏数据保险公司',
      policyNumber: next('DIRTY-POLICY'),
      coverageStart: null,
      coverageEnd: beijingDateOnlyOffset(10),
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewStatusCode: 'verified',
      version: 0,
      reviewedByUserId: null,
      reviewedAt: null,
    };
    const transaction = jest
      .spyOn(prisma, '$transaction')
      .mockResolvedValueOnce([[dirtyRow], []] as never);

    try {
      const response = await request(httpServer(app))
        .get(overviewPath(member.id))
        .set('Authorization', bizAdminAuth)
        .expect(200);
      const data = (response.body as ResponseBody<OverviewData>).data;
      expect(data.asOfDate).toBe(asOfDate.toISOString());
      expect(data.summary).toEqual({
        dateActiveSelfPurchasedCount: 1,
        confirmedActiveSelfPurchasedCount: 0,
        dateActiveTeamProvidedCount: 0,
        hasConfirmedCoverage: false,
        confirmedCoverageThrough: null,
      });
      expect(data.selfPurchased[0]).not.toHaveProperty('reviewedByUserId');
    } finally {
      transaction.mockRestore();
    }
  });

  it('过滤软删 self/coverage/policy，policy 软删不会因 live coverage 泄漏', async () => {
    const member = await createMember();
    await createSelfInsurance(member.id, {
      start: null,
      end: beijingDateOnlyOffset(10),
      deletedAt: new Date(),
    });
    await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: beijingDateOnlyOffset(10),
      coverageDeletedAt: new Date(),
    });
    await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: beijingDateOnlyOffset(10),
      policyDeletedAt: new Date(),
    });

    const response = await request(httpServer(app))
      .get(overviewPath(member.id))
      .set('Authorization', bizAdminAuth)
      .expect(200);
    const data = (response.body as ResponseBody<OverviewData>).data;
    expect(data.selfPurchased).toEqual([]);
    expect(data.teamProvided).toEqual([]);
    expect(data.summary.hasConfirmedCoverage).toBe(false);
    expect(data.summary.confirmedCoverageThrough).toBeNull();
  });

  it('鉴权与防枚举：未登录/无码拒绝，biz-admin/SA 与 scoped 范围内通过，范围外 30100', async () => {
    const inScope = await createMember(inScopeOrganizationId);
    const outOfScope = await createMember(outOfScopeOrganizationId);

    const unauthenticated = await request(httpServer(app)).get(overviewPath(inScope.id));
    expectBizError(unauthenticated, BizCode.UNAUTHORIZED);

    for (const auth of [plainAdminAuth, userAuth]) {
      const denied = await request(httpServer(app))
        .get(overviewPath(inScope.id))
        .set('Authorization', auth);
      expectBizError(denied, BizCode.RBAC_FORBIDDEN);
    }

    await request(httpServer(app))
      .get(overviewPath(inScope.id))
      .set('Authorization', bizAdminAuth)
      .expect(200);
    await request(httpServer(app))
      .get(overviewPath(inScope.id))
      .set('Authorization', saAuth)
      .expect(200);
    await request(httpServer(app))
      .get(overviewPath(inScope.id))
      .set('Authorization', scopedAuth)
      .expect(200);

    const scopedDenied = await request(httpServer(app))
      .get(overviewPath(outOfScope.id))
      .set('Authorization', scopedAuth);
    expectBizError(scopedDenied, BizCode.RBAC_FORBIDDEN);

    const missingId = 'cl000000000000000overviewmissing';
    const globalMissing = await request(httpServer(app))
      .get(overviewPath(missingId))
      .set('Authorization', bizAdminAuth);
    expectBizError(globalMissing, BizCode.MEMBER_NOT_FOUND);

    const scopedMissing = await request(httpServer(app))
      .get(overviewPath(missingId))
      .set('Authorization', scopedAuth);
    expectBizError(scopedMissing, BizCode.RBAC_FORBIDDEN);

    const deleted = await createMember(undefined, new Date());
    const deletedMember = await request(httpServer(app))
      .get(overviewPath(deleted.id))
      .set('Authorization', bizAdminAuth);
    expectBizError(deletedMember, BizCode.MEMBER_NOT_FOUND);
  });

  it('读取审计复用 member-insurance.read.other，extra 只有 operation 与两类计数且失败时 fail-closed', async () => {
    const member = await createMember();
    const self = await createSelfInsurance(member.id, {
      start: null,
      end: beijingDateOnlyOffset(10),
    });
    const team = await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: beijingDateOnlyOffset(10),
    });

    await request(httpServer(app))
      .get(overviewPath(member.id))
      .set('Authorization', bizAdminAuth)
      .expect(200);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'member-insurance.read.other',
        resourceType: 'member',
        resourceId: member.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    const context = audit.context as { extra?: Record<string, unknown> };
    expect(context.extra).toEqual({
      operation: 'overview',
      selfPurchasedCount: 1,
      teamProvidedCount: 1,
    });
    expect(Object.keys(context.extra ?? {}).sort()).toEqual(
      ['operation', 'selfPurchasedCount', 'teamProvidedCount'].sort(),
    );
    expect(JSON.stringify(context.extra)).not.toContain(self.policyNumber);
    expect(JSON.stringify(context.extra)).not.toContain(team.policy.policyNumber);
    expect(JSON.stringify(context.extra)).not.toContain(team.coverage.id);

    const failureMember = await createMember();
    const auditFailure = jest
      .spyOn(auditLogs, 'log')
      .mockRejectedValueOnce(new Error('audit down'));
    try {
      const failed = await request(httpServer(app))
        .get(overviewPath(failureMember.id))
        .set('Authorization', bizAdminAuth);
      expectBizError(failed, BizCode.INTERNAL_ERROR, { strictMessage: false });
    } finally {
      auditFailure.mockRestore();
    }
  });

  it('旧 GET 仍只返回个人保险且字段形状不变，团队覆盖不混入旧数组', async () => {
    const member = await createMember();
    const self = await createSelfInsurance(member.id, {
      start: null,
      end: beijingDateOnlyOffset(10),
    });
    await createTeamCoverage(member.id, {
      start: beijingDateOnlyOffset(-10),
      end: beijingDateOnlyOffset(10),
    });

    const response = await request(httpServer(app))
      .get(`/api/admin/v1/members/${member.id}/insurances`)
      .set('Authorization', bizAdminAuth)
      .expect(200);
    const items = (response.body as ResponseBody<Array<Record<string, unknown>>>).data;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(self.id);
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        'coverageEnd',
        'coverageStart',
        'createdAt',
        'id',
        'insurerName',
        'memberId',
        'policyNumber',
        'reviewStatusCode',
        'reviewedAt',
        'updatedAt',
        'version',
      ].sort(),
    );
  });
});
