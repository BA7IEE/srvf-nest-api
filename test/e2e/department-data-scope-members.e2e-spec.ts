import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
} from '@prisma/client';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// v0.49 部门数据范围成员轴 E2E：真 seed 的正/副职 policy，active PRIMARY 归属，列表交集，
// point auth，敏感字段二次授权，以及 bulk 逐项授权。API path / DTO / response shape 均不改。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'v049-member-su',
};

function runSeed(): void {
  const envForChild: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env: envForChild,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface Person {
  userId: string;
  memberId: string;
  authHeader: string;
}

describe('v0.49 department data scope — member axis', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rootId: string;
  let sectId: string;
  let childId: string;
  let swrtId: string;
  let sectMemberId: string;
  let childMemberId: string;
  let crossMemberId: string;
  let secondaryOnlyMemberId: string;
  let bulkInScopeMemberId: string;
  let bulkCrossMemberId: string;
  let sectCertificateId: string;
  let sectContactId: string;
  let leader: Person;
  let viceCaptain: Person;
  let deputy: Person;
  let groupDeputy: Person;
  let noPermission: Person;
  let emptyScope: Person;
  let globalAdmin: Person;
  let scopedWriter: Person;

  async function mkPerson(tag: string): Promise<Person> {
    const member = await prisma.member.create({
      data: { memberNo: `v049-m-${tag}`, displayName: `v0.49 ${tag}` },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        username: `v049-m-${tag}`,
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.USER,
        memberId: member.id,
      },
      select: { id: true, username: true },
    });
    return {
      userId: user.id,
      memberId: member.id,
      authHeader: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function mkTarget(tag: string, primaryOrganizationId: string): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo: `v049-t-${tag}`, displayName: `范围目标 ${tag}` },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: member.id,
        organizationId: primaryOrganizationId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
      },
    });
    return member.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();
    prisma = app.get(PrismaService);

    rootId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SRVF' }, select: { id: true } })
    ).id;
    sectId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SECT' }, select: { id: true } })
    ).id;
    swrtId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SWRT' }, select: { id: true } })
    ).id;
    childId = (
      await prisma.organization.create({
        data: { name: 'v0.49 SECT 子组', nodeTypeCode: 'group', parentId: sectId },
        select: { id: true },
      })
    ).id;
    const sectAncestors = await prisma.organizationClosure.findMany({
      where: { descendantId: sectId },
      select: { ancestorId: true, depth: true },
    });
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: childId, descendantId: childId, depth: 0 },
        ...sectAncestors.map((row) => ({
          ancestorId: row.ancestorId,
          descendantId: childId,
          depth: row.depth + 1,
        })),
      ],
    });

    sectMemberId = await mkTarget('sect', sectId);
    childMemberId = await mkTarget('child', childId);
    crossMemberId = await mkTarget('cross', swrtId);
    secondaryOnlyMemberId = await mkTarget('secondary', swrtId);
    bulkInScopeMemberId = await mkTarget('bulk-in', sectId);
    bulkCrossMemberId = await mkTarget('bulk-cross', swrtId);
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: secondaryOnlyMemberId,
        organizationId: sectId,
        membershipType: MembershipType.SECONDARY,
        status: MembershipStatus.ACTIVE,
      },
    });

    leader = await mkPerson('leader');
    viceCaptain = await mkPerson('vice-captain');
    deputy = await mkPerson('deputy');
    groupDeputy = await mkPerson('group-deputy');
    noPermission = await mkPerson('none');
    emptyScope = await mkPerson('empty-scope');
    globalAdmin = await mkPerson('global');
    scopedWriter = await mkPerson('writer');

    const positions = await prisma.organizationPosition.findMany({
      where: {
        code: { in: ['dept-leader', 'vice-captain', 'dept-deputy', 'deputy-group-leader'] },
      },
      select: { id: true, code: true },
    });
    const positionId = (code: string): string =>
      positions.find((position) => position.code === code)!.id;
    await prisma.organizationPositionAssignment.createMany({
      data: [
        {
          memberId: leader.memberId,
          organizationId: sectId,
          positionId: positionId('dept-leader'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          memberId: viceCaptain.memberId,
          organizationId: rootId,
          positionId: positionId('vice-captain'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          memberId: deputy.memberId,
          organizationId: sectId,
          positionId: positionId('dept-deputy'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          memberId: groupDeputy.memberId,
          organizationId: childId,
          positionId: positionId('deputy-group-leader'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const orgReadonly = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'org-readonly', deletedAt: null },
      select: { id: true },
    });
    const orgAdmin = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'org-admin', deletedAt: null },
      select: { id: true },
    });
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: PrincipalType.USER,
          principalId: emptyScope.userId,
          roleId: orgReadonly.id,
          scopeType: BindingScopeType.SELF,
        },
        {
          principalType: PrincipalType.USER,
          principalId: globalAdmin.userId,
          roleId: orgAdmin.id,
          scopeType: BindingScopeType.GLOBAL,
        },
      ],
    });

    const grantPermission = await prisma.permission.findFirstOrThrow({
      where: { code: 'member.grant.account' },
      select: { id: true },
    });
    const scopedWriterRole = await prisma.rbacRole.create({
      data: { code: 'v049-member-scoped-writer', displayName: 'v0.49 成员 scoped writer' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: scopedWriterRole.id, permissionId: grantPermission.id },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: scopedWriter.userId,
        roleId: scopedWriterRole.id,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: sectId,
      },
    });

    await prisma.memberProfile.create({
      data: {
        memberId: sectMemberId,
        realName: '范围内实名',
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id-card',
        documentNumber: 'V049123456789',
        mobile: '13800000001',
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'internal',
        privacyConsentSigned: true,
        exerciseMethods: [],
        firstAidSkills: [],
      },
    });
    await prisma.memberProfile.create({
      data: {
        memberId: childMemberId,
        realName: '子组实名',
        genderCode: 'male',
        birthDate: new Date('1991-01-01T00:00:00.000Z'),
        documentTypeCode: 'id-card',
        documentNumber: 'V049987654321',
        mobile: '13800000002',
        joinedDate: new Date('2021-01-01T00:00:00.000Z'),
        joinSourceCode: 'internal',
        privacyConsentSigned: true,
        exerciseMethods: [],
        firstAidSkills: [],
      },
    });
    sectContactId = (
      await prisma.emergencyContact.create({
        data: {
          memberId: sectMemberId,
          contactName: '范围内联系人',
          relationCode: 'other',
          phonePrimary: '13900000001',
          address: '范围内完整地址',
        },
        select: { id: true },
      })
    ).id;
    await prisma.emergencyContact.create({
      data: {
        memberId: childMemberId,
        contactName: '子组联系人',
        relationCode: 'other',
        phonePrimary: '13900000002',
      },
    });
    sectCertificateId = (
      await prisma.certificate.create({
        data: {
          memberId: sectMemberId,
          certTypeCode: 'first-aid',
          issuingOrg: 'v0.49 发证机构',
          issuedAt: new Date('2025-01-01T00:00:00.000Z'),
          certStatusCode: 'pending',
        },
        select: { id: true },
      })
    ).id;
    await prisma.certificate.create({
      data: {
        memberId: childMemberId,
        certTypeCode: 'first-aid',
        issuingOrg: 'v0.49 子组发证机构',
        issuedAt: new Date('2025-01-01T00:00:00.000Z'),
        certStatusCode: 'pending',
      },
    });
    await prisma.memberInsurance.create({
      data: {
        memberId: sectMemberId,
        insurerName: 'v0.49 保险公司',
        policyNumber: 'V049-POLICY',
        coverageEnd: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('正职列表/下拉只见组织树内 active PRIMARY；用户组织过滤与授权范围取交集', async () => {
    const list = await request(httpServer(app))
      .get('/api/admin/v1/members?page=1&pageSize=100')
      .set('Authorization', leader.authHeader);
    expect(list.status).toBe(200);
    const ids = list.body.data.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([sectMemberId, childMemberId]));
    expect(ids).not.toEqual(expect.arrayContaining([crossMemberId, secondaryOnlyMemberId]));

    const intersected = await request(httpServer(app))
      .get(`/api/admin/v1/members?organizationId=${swrtId}&includeDescendants=true`)
      .set('Authorization', leader.authHeader);
    expect(intersected.status).toBe(200);
    expect(intersected.body.data.items).toEqual([]);

    const exact = await request(httpServer(app))
      .get(
        `/api/admin/v1/members/options?organizationId=${sectId}&includeDescendants=false&limit=100`,
      )
      .set('Authorization', leader.authHeader);
    expect(exact.status).toBe(200);
    expect(exact.body.data.items.map((item: { id: string }) => item.id)).toContain(sectMemberId);
    expect(exact.body.data.items.map((item: { id: string }) => item.id)).not.toContain(
      childMemberId,
    );
  });

  it('无码返回 30100；有 read 码但仅 SELF scope 的列表返回空集', async () => {
    const denied = await request(httpServer(app))
      .get('/api/admin/v1/members')
      .set('Authorization', noPermission.authHeader);
    expectBizError(denied, BizCode.RBAC_FORBIDDEN);

    const empty = await request(httpServer(app))
      .get('/api/admin/v1/members')
      .set('Authorization', emptyScope.authHeader);
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);
    expect(empty.body.data.total).toBe(0);
  });

  it('正职点读写仅覆盖本树；SECONDARY 不扩大 point scope', async () => {
    const inside = await request(httpServer(app))
      .get(`/api/admin/v1/members/${childMemberId}`)
      .set('Authorization', leader.authHeader);
    expect(inside.status).toBe(200);

    for (const memberId of [crossMemberId, secondaryOnlyMemberId]) {
      const cross = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', leader.authHeader);
      expectBizError(cross, BizCode.RBAC_FORBIDDEN);
    }

    const writeInside = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${sectMemberId}`)
      .set('Authorization', leader.authHeader)
      .send({ displayName: '正职范围内更新' });
    expect(writeInside.status).toBe(200);
    const writeCross = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${crossMemberId}`)
      .set('Authorization', leader.authHeader)
      .send({ displayName: '越界更新' });
    expectBizError(writeCross, BizCode.RBAC_FORBIDDEN);

    for (const path of [
      `/api/admin/v1/members/${crossMemberId}/profile`,
      `/api/admin/v1/members/${crossMemberId}/certificates`,
    ]) {
      const nestedCross = await request(httpServer(app))
        .get(path)
        .set('Authorization', leader.authHeader);
      expectBizError(nestedCross, BizCode.RBAC_FORBIDDEN);
    }
  });

  it('vice-captain@root 自动全队只读，但任何成员写动作仍 30100', async () => {
    const list = await request(httpServer(app))
      .get('/api/admin/v1/members?page=1&pageSize=100')
      .set('Authorization', viceCaptain.authHeader);
    expect(list.status).toBe(200);
    const ids = list.body.data.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([sectMemberId, childMemberId, crossMemberId]));

    const crossProfile = await request(httpServer(app))
      .get(`/api/admin/v1/members/${crossMemberId}/profile`)
      .set('Authorization', viceCaptain.authHeader);
    expect(crossProfile.status).toBe(200);

    const write = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${crossMemberId}`)
      .set('Authorization', viceCaptain.authHeader)
      .send({ displayName: '副队长不可写' });
    expectBizError(write, BizCode.RBAC_FORBIDDEN);
  });

  it('副职继承只读投影：本树可读、敏感字段掩码、全部写仍 30100', async () => {
    const detail = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}`)
      .set('Authorization', deputy.authHeader);
    expect(detail.status).toBe(200);

    const profile = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/profile`)
      .set('Authorization', deputy.authHeader);
    expect(profile.status).toBe(200);
    expect(profile.body.data.documentNumber).not.toBe('V049123456789');
    expect(profile.body.data.documentNumber).toContain('*');
    expect(profile.body.data.mobile).toContain('*');

    const contacts = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/emergency-contacts`)
      .set('Authorization', deputy.authHeader);
    expect(contacts.status).toBe(200);
    expect(contacts.body.data[0].phonePrimary).toContain('*');

    const certificates = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/certificates`)
      .set('Authorization', deputy.authHeader);
    expect(certificates.status).toBe(200);
    expect(certificates.body.data.map((item: { id: string }) => item.id)).toContain(
      sectCertificateId,
    );

    const insurances = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/insurances`)
      .set('Authorization', deputy.authHeader);
    expect(insurances.status).toBe(200);
    expect(insurances.body.data).toHaveLength(1);

    const memberWrite = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${sectMemberId}`)
      .set('Authorization', deputy.authHeader)
      .send({ displayName: '副职不可写' });
    expectBizError(memberWrite, BizCode.RBAC_FORBIDDEN);
    const profileWrite = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${sectMemberId}/profile`)
      .set('Authorization', deputy.authHeader)
      .send({ realName: '副职不可写' });
    expectBizError(profileWrite, BizCode.RBAC_FORBIDDEN);
    const contactDelete = await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/emergency-contacts/${sectContactId}`)
      .set('Authorization', deputy.authHeader);
    expectBizError(contactDelete, BizCode.RBAC_FORBIDDEN);
    const certificateDelete = await request(httpServer(app))
      .delete(`/api/admin/v1/members/${sectMemberId}/certificates/${sectCertificateId}`)
      .set('Authorization', deputy.authHeader);
    expectBizError(certificateDelete, BizCode.RBAC_FORBIDDEN);
  });

  it('副职跨组织的成员与所有嵌套资料均 30100', async () => {
    const paths = [
      `/api/admin/v1/members/${crossMemberId}`,
      `/api/admin/v1/members/${crossMemberId}/profile`,
      `/api/admin/v1/members/${crossMemberId}/emergency-contacts`,
      `/api/admin/v1/members/${crossMemberId}/certificates`,
      `/api/admin/v1/members/${crossMemberId}/insurances`,
    ];
    for (const path of paths) {
      const response = await request(httpServer(app))
        .get(path)
        .set('Authorization', deputy.authHeader);
      expectBizError(response, BizCode.RBAC_FORBIDDEN);
    }
  });

  it('小组副职镜像 group-manager 只读面：可读子组资料，但不凭空获得 member/insurance 码', async () => {
    for (const path of [
      `/api/admin/v1/members/${childMemberId}/profile`,
      `/api/admin/v1/members/${childMemberId}/emergency-contacts`,
      `/api/admin/v1/members/${childMemberId}/certificates`,
    ]) {
      const response = await request(httpServer(app))
        .get(path)
        .set('Authorization', groupDeputy.authHeader);
      expect(response.status).toBe(200);
    }

    const member = await request(httpServer(app))
      .get(`/api/admin/v1/members/${childMemberId}`)
      .set('Authorization', groupDeputy.authHeader);
    expectBizError(member, BizCode.RBAC_FORBIDDEN);
    const insurance = await request(httpServer(app))
      .get(`/api/admin/v1/members/${childMemberId}/insurances`)
      .set('Authorization', groupDeputy.authHeader);
    expectBizError(insurance, BizCode.RBAC_FORBIDDEN);
  });

  it('GLOBAL 旧角色保留 NOT_FOUND；scoped 不存在资源统一 30100', async () => {
    const missingId = 'cl0000000000000000000000';
    const globalMissing = await request(httpServer(app))
      .get(`/api/admin/v1/members/${missingId}`)
      .set('Authorization', globalAdmin.authHeader);
    expectBizError(globalMissing, BizCode.MEMBER_NOT_FOUND);
    const scopedMissing = await request(httpServer(app))
      .get(`/api/admin/v1/members/${missingId}`)
      .set('Authorization', deputy.authHeader);
    expectBizError(scopedMissing, BizCode.RBAC_FORBIDDEN);

    const globalCertificateMissing = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/certificates/${missingId}`)
      .set('Authorization', globalAdmin.authHeader);
    expectBizError(globalCertificateMissing, BizCode.CERTIFICATE_NOT_FOUND);
    const scopedCertificateMissing = await request(httpServer(app))
      .get(`/api/admin/v1/members/${sectMemberId}/certificates/${missingId}`)
      .set('Authorization', deputy.authHeader);
    expectBizError(scopedCertificateMissing, BizCode.RBAC_FORBIDDEN);
  });

  it('bulk grant 对每个 member 单独 point auth：范围内成功、跨范围 blocked', async () => {
    const response = await request(httpServer(app))
      .post('/api/admin/v1/members/accounts/bulk-grant')
      .set('Authorization', scopedWriter.authHeader)
      .send({
        items: [
          { memberId: bulkInScopeMemberId, phone: '13800000901' },
          { memberId: bulkCrossMemberId, phone: '13800000902' },
        ],
      });
    expect(response.status).toBe(201);
    expect(response.body.data.summary).toEqual({ total: 2, ok: 1, blocked: 1 });
    expect(response.body.data.items).toEqual([
      expect.objectContaining({ memberId: bulkInScopeMemberId, status: 'ok' }),
      expect.objectContaining({ memberId: bulkCrossMemberId, status: 'blocked' }),
    ]);
  });
});
