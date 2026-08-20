import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { MemberReferenceResolver } from '../../src/modules/members/member-reference-resolver';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import {
  seedCertificateStandard,
  type SeededCertificateStandard,
} from '../fixtures/certificate-standard.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';

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

// issue #1048 T3:MemberReferenceResolver 没有 controller(它是给**机器**用的内部服务),
// 故沿仓内 service-level e2e 范式(member-profiles-sensitive-masking / organizations-audit-
// characterization)直调 `app.get(Service)`,自己造 actor payload。
function payloadOf(person: Person, username: string): CurrentUserPayload {
  return {
    id: person.userId,
    username,
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: person.memberId,
  };
}

describe('v0.49 department data scope — member axis', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let certStd: SeededCertificateStandard;
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
      data: { memberNo: `v049-m-${tag}`, ...memberIdentityData(`v0.49 ${tag}`) },
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
      data: { memberNo: `v049-t-${tag}`, ...memberIdentityData(`范围目标 ${tag}`) },
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
    // PR-4b:直插证书须给齐三列(NOT NULL)。
    certStd = await seedCertificateStandard(prisma, { categoryCode: 'first-aid' });

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
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id-card',
        documentNumber: 'V049123456789',
        mobile: '13800000001',
        privacyConsentSigned: true,
        exerciseMethods: [],
        firstAidSkills: [],
      },
    });
    await prisma.memberProfile.create({
      data: {
        memberId: childMemberId,
        genderCode: 'male',
        birthDate: new Date('1991-01-01T00:00:00.000Z'),
        documentTypeCode: 'id-card',
        documentNumber: 'V049987654321',
        mobile: '13800000002',
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
          ...certStd.certificateColumns,
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
        ...certStd.certificateColumns,
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
        coverageEnd: new Date('2099-01-01T00:00:00.000Z'),
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

  // ==========================================================================
  // issue #1048 T2 DoD 3:相关性搜索**不得**绕过 scoped authz
  //
  // ⚠️ 反面样本必须**只在授权这一维上不同** —— 仓内已记录过的坑:上层边界会遮蔽
  // 下层边界,两个样本若还有别的差异(姓名不同、状态不同…),即便授权腿被删掉,
  // 用例也可能因为那个别的差异而"照样绿",于是判据看着在守、其实什么都没守。
  // 故这里两个人的 realName / nickname / status 逐字相同,**只有 PRIMARY 组织不同**。
  // ==========================================================================
  it('🔴 搜索命中同名两人、只有组织不同 → scoped 调用者只见树内那个(GLOBAL 见两个作正对照)', async () => {
    const SAME_NAME = 'T2范围同名样本';
    const inScope = await prisma.member.create({
      data: { memberNo: 'v049-t2-in', ...memberIdentityData(SAME_NAME, 'T2同外号') },
      select: { id: true },
    });
    const outOfScope = await prisma.member.create({
      data: { memberNo: 'v049-t2-out', ...memberIdentityData(SAME_NAME, 'T2同外号') },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.createMany({
      data: [
        {
          memberId: inScope.id,
          organizationId: sectId, // leader 树内
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
        {
          memberId: outOfScope.id,
          organizationId: swrtId, // leader 树外 —— 两人唯一的差别
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
      ],
    });

    // ---- 正对照:GLOBAL 调用者必须**两个都看得到** ----
    // 这一步是判据成立的前提:证明两行除组织外确实等价、都能被同一个 q 命中。
    // 少了它,下面的"只见一个"可能是因为另一个压根没被搜到,而不是被授权挡住。
    const global = await request(httpServer(app))
      .get('/api/admin/v1/members?page=1&pageSize=100')
      .query({ q: SAME_NAME })
      .set('Authorization', globalAdmin.authHeader);
    expect(global.status).toBe(200);
    const globalIds = (global.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(globalIds).toEqual(expect.arrayContaining([inScope.id, outOfScope.id]));

    // ---- 真读数:scoped 调用者只见树内那个 ----
    const scoped = await request(httpServer(app))
      .get('/api/admin/v1/members?page=1&pageSize=100')
      .query({ q: SAME_NAME })
      .set('Authorization', leader.authHeader);
    expect(scoped.status).toBe(200);
    const scopedIds = (scoped.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(scopedIds).toContain(inScope.id);
    expect(scopedIds).not.toContain(outOfScope.id);
    // total 也必须只数树内的那个 —— 计数走的是另一条 count 查询,
    // 授权腿若只加在 findMany 上、漏在 count 上,行数对但总数会泄露树外人数。
    expect(scoped.body.data.total).toBe(1);

    // ---- 选择器同一条路径,同样只见树内那个 ----
    const options = await request(httpServer(app))
      .get('/api/admin/v1/members/options?limit=100')
      .query({ q: SAME_NAME })
      .set('Authorization', leader.authHeader);
    expect(options.status).toBe(200);
    const optionIds = (options.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(optionIds).toContain(inScope.id);
    expect(optionIds).not.toContain(outOfScope.id);
  });

  // ==========================================================================
  // issue #1048 T3 · MemberReferenceResolver 规则 5(真链路)
  //
  // 单测里 scope filter 是 mock 的 —— 它只证明「解析器把范围腿 AND 进去了」。
  // 这条走**真 authz → 真范围 → 真查询**,证明整条链上范围确实起作用。
  // ==========================================================================
  it('🔴 解析器:范围外的**精确 memberNo** 仍不得命中(GLOBAL 作正对照)', async () => {
    const resolver = app.get(MemberReferenceResolver);
    const leaderPayload = payloadOf(leader, 'v049-m-leader');
    const globalPayload = payloadOf(globalAdmin, 'v049-m-global');

    // crossMemberId 挂在 swrtId —— leader 树外。编号真实存在、拼写完全正确。
    const cross = await prisma.member.findUniqueOrThrow({
      where: { id: crossMemberId },
      select: { memberNo: true, realName: true },
    });

    // ---- 正对照:GLOBAL 调用者用同一个编号必须 MATCHED ----
    // 少了这步,下面的 NOT_FOUND 可能只是"这个编号本来就查不到",而不是"被范围挡住了"。
    await expect(resolver.resolve(globalPayload, { memberNo: cross.memberNo })).resolves.toEqual({
      state: 'MATCHED',
      memberId: crossMemberId,
    });

    // ---- 真读数:范围内调用者拿同一个编号 → NOT_FOUND ----
    await expect(resolver.resolve(leaderPayload, { memberNo: cross.memberNo })).resolves.toEqual({
      state: 'NOT_FOUND',
    });

    // 姓名路径同样被范围挡住(防「换个字段就绕过去」)
    await expect(resolver.resolve(leaderPayload, { realName: cross.realName })).resolves.toEqual({
      state: 'NOT_FOUND',
    });

    // ---- 树内的人:同一个 leader 能正常解析(证明不是"对谁都返 NOT_FOUND")----
    const inTree = await prisma.member.findUniqueOrThrow({
      where: { id: sectMemberId },
      select: { memberNo: true },
    });
    await expect(resolver.resolve(leaderPayload, { memberNo: inTree.memberNo })).resolves.toEqual({
      state: 'MATCHED',
      memberId: sectMemberId,
    });
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
      .send({ realName: '正职范围内更新' });
    expect(writeInside.status).toBe(200);
    const writeCross = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${crossMemberId}`)
      .set('Authorization', leader.authHeader)
      .send({ realName: '越界更新' });
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
      .send({ realName: '副队长不可写' });
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
      .send({ realName: '副职不可写' });
    expectBizError(memberWrite, BizCode.RBAC_FORBIDDEN);
    const profileWrite = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${sectMemberId}/profile`)
      .set('Authorization', deputy.authHeader)
      // issue #1048 T1:realName 已搬出档案 DTO,再传它会先被 forbidNonWhitelisted 打成 400,
      // 于是这条用例量的就不再是「副职不可写」而是「字段不认识」。改用仍在档案里的 genderCode。
      .send({ genderCode: 'female' });
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
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toEqual({ total: 2, ok: 1, blocked: 1 });
    expect(response.body.data.items).toEqual([
      expect.objectContaining({ memberId: bulkInScopeMemberId, status: 'ok' }),
      expect.objectContaining({ memberId: bulkCrossMemberId, status: 'blocked' }),
    ]);
  });
});
