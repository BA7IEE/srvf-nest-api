import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  PrincipalType,
  Role,
  SupervisionScopeMode,
  SupervisionStatus,
} from '@prisma/client';
import { execSync } from 'child_process';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR8:三源推导正确性 service 级测试(goal DoD 3;冻结稿 §5.2 三源 + §6 场景推演)。
// 角色 / 职务 / policy / 组织树用**真 seed**(子进程,沿 seed-position-role-policies 范式)—— org-admin 56 码
// 真的没有终审码、org-supervisor 真的只有 4 读码,场景语义与生产逐字一致。
//
// 覆盖:
//   场景 1(队长甲):team-leader@SECT 经 policy→org-admin@TREE → SECT 子组(行动组)sheet 读 ALLOW
//     (matchedGrant source=position);同 ref 终审 DENY no_permission(BD-2:终审不在 org-admin 码集)
//   场景 3(副队长乙):仅 SupervisionAssignment(SECT,TREE)→ SECT 队员读 ALLOW(source=supervision,
//     org-supervisor);SWRT 队员 DENY out_of_supervised_scope;写 DENY no_permission(BD-3 只读)
//   场景 4(BD-2 终审):RoleBinding(principalType=POSITION_ASSIGNMENT〔APD 部长任职〕,终审测试角色,
//     TREE@root)→ 任意 sheet 终审 ALLOW;自己提交的 sheet DENY self_approval_forbidden(SUPER_ADMIN 亦拒);
//     一级同人 DENY same_reviewer_forbidden;任职 ENDED 后绑定随之失效(换届即失权,expired_grant)
//   R5(副职红线):仅持 vice-captain 任职(零 policy 行)→ 管理 action + ref 全 DENY no_permission(3b 零产出)
//   失效族:任职 REVOKED / 任职过期 / 分管 ENDED / 绑定过期 → expired_grant;scope org INACTIVE → inactive_org;
//     resource 不存在 / 已软删 → resource_not_found
//   SELF:RoleBinding(MEMBER, scopeType=SELF, org-supervisor)→ 本人 member ref ALLOW / 他人 DENY out_of_scope
//   无 ref 退化:三源持有者(副队长乙)无 ref 判权仍 === rbac 旧语义(scoped/推导源不泄入)
//
// 时间口径:active fixture 用 startedAt 远过去 + endedAt=null(spec 不随日历腐烂);
// 失效 fixture 用 endedAt 远过去 / 非 ACTIVE status。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr8-3src-su',
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

const PAST_START = new Date('2020-01-01T00:00:00.000Z');
const PAST_END = new Date('2020-12-31T00:00:00.000Z');

interface Person {
  payload: CurrentUserPayload;
  memberId: string;
  userId: string;
}

describe('authz 三源推导(§5.2 3a/3b/3c + §6 场景 + R5 + 失效族 + SELF)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: AuthzService;

  // 组织(seed 内置 + fixture 建)
  let rootId: string;
  let sectId: string;
  let swrtId: string;
  let apdId: string;
  let grpId: string;
  let inactOrgId: string;
  // 人
  let cui: Person;
  let huang: Person;
  let apdHead: Person;
  let vice: Person;
  let selfGuy: Person;
  let revokedGuy: Person;
  let expiredGuy: Person;
  let endedSupGuy: Person;
  let expiredBindGuy: Person;
  let inactBindGuy: Person;
  let saPayload: CurrentUserPayload;
  // 资源
  let sectMemberId: string;
  let swrtMemberId: string;
  let inactMemberId: string;
  let grpActivityId: string;
  let sheet1Id: string; // 行动组活动;submitter=neutral
  let sheet2Id: string; // submitter=apdHead 本人(自审拒)
  let sheet3Id: string; // submitter=SA 本人(SA 亦拒)
  let sheet4Id: string; // reviewer=apdHead 本人(同人终审拒)
  // 场景 4 绑定所需
  let apdAssignmentId: string;
  let cuiAssignmentId: string;
  let huangSupervisionId: string;
  let apdBindingId: string;
  let selfBindingId: string;

  async function mkPerson(tag: string, role: Role = Role.USER): Promise<Person> {
    const member = await prisma.member.create({
      data: { memberNo: `pr8-3s-${tag}`, displayName: `3src ${tag}` },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        username: `pr8-3src-${tag}`,
        passwordHash: '$2a$10$dummy',
        role,
        memberId: member.id,
      },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    return {
      payload: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        memberId: user.memberId,
      },
      memberId: member.id,
      userId: user.id,
    };
  }

  async function mkTargetMember(tag: string, organizationId: string): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo: `pr8-3t-${tag}`, displayName: `3src 目标 ${tag}` },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: member.id,
        organizationId,
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
    authz = app.get(AuthzService);

    // ===== seed 组织(SRVF 根 + SECT/SWRT/APD)+ fixture 组织(SECT-行动组 group / INACTIVE 部门)=====
    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    rootId = await orgByCode('SRVF');
    sectId = await orgByCode('SECT');
    swrtId = await orgByCode('SWRT');
    apdId = await orgByCode('APD');

    const grp = await prisma.organization.create({
      data: { name: 'SECT 行动组', nodeTypeCode: 'group', parentId: sectId },
      select: { id: true },
    });
    grpId = grp.id;
    const inact = await prisma.organization.create({
      data: {
        name: '已停用部门',
        nodeTypeCode: 'functional-dept',
        parentId: rootId,
        status: OrganizationStatus.INACTIVE,
      },
      select: { id: true },
    });
    inactOrgId = inact.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: grpId, descendantId: grpId, depth: 0 },
        { ancestorId: sectId, descendantId: grpId, depth: 1 },
        { ancestorId: rootId, descendantId: grpId, depth: 2 },
        { ancestorId: inactOrgId, descendantId: inactOrgId, depth: 0 },
        { ancestorId: rootId, descendantId: inactOrgId, depth: 1 },
      ],
    });

    // ===== 人 =====
    cui = await mkPerson('cui');
    huang = await mkPerson('huang');
    apdHead = await mkPerson('apd-head');
    vice = await mkPerson('vice');
    selfGuy = await mkPerson('self');
    revokedGuy = await mkPerson('revoked');
    expiredGuy = await mkPerson('expired');
    endedSupGuy = await mkPerson('ended-sup');
    expiredBindGuy = await mkPerson('expired-bind');
    inactBindGuy = await mkPerson('inact-bind');
    const sa = await mkPerson('sa', Role.SUPER_ADMIN);
    saPayload = sa.payload;
    const neutral = await mkPerson('neutral');

    // ===== 目标资源:队员(SECT / SWRT / INACT)+ 行动组活动 4 张 sheet =====
    sectMemberId = await mkTargetMember('sect', sectId);
    swrtMemberId = await mkTargetMember('swrt', swrtId);
    inactMemberId = await mkTargetMember('inact', inactOrgId);

    const activity = await prisma.activity.create({
      data: {
        title: '行动组拉练',
        activityTypeCode: 'pr8-demo',
        organizationId: grpId,
        startAt: new Date('2026-06-01T01:00:00.000Z'),
        endAt: new Date('2026-06-01T05:00:00.000Z'),
        location: '训练场',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    grpActivityId = activity.id;
    const mkSheet = async (submitterUserId: string, reviewerUserId?: string): Promise<string> =>
      (
        await prisma.attendanceSheet.create({
          data: {
            activityId: activity.id,
            submitterUserId,
            reviewerUserId,
            statusCode: 'pending_final_review',
          },
          select: { id: true },
        })
      ).id;
    sheet1Id = await mkSheet(neutral.userId);
    sheet2Id = await mkSheet(apdHead.userId);
    sheet3Id = await mkSheet(sa.userId);
    sheet4Id = await mkSheet(neutral.userId, apdHead.userId);

    // ===== 职务 / 角色锚点(全部来自真 seed)=====
    const positionByCode = async (code: string): Promise<string> =>
      (
        await prisma.organizationPosition.findFirstOrThrow({
          where: { code, deletedAt: null },
          select: { id: true },
        })
      ).id;
    const teamLeaderId = await positionByCode('team-leader');
    const deptLeaderId = await positionByCode('dept-leader');
    const viceCaptainId = await positionByCode('vice-captain');
    const roleByCode = async (code: string): Promise<string> =>
      (
        await prisma.rbacRole.findFirstOrThrow({
          where: { code, deletedAt: null },
          select: { id: true },
        })
      ).id;
    const orgAdminRoleId = await roleByCode('org-admin');
    const orgSupervisorRoleId = await roleByCode('org-supervisor');

    const mkAssignment = (
      memberId: string,
      organizationId: string,
      positionId: string,
      overrides: Partial<{ status: AssignmentStatus; startedAt: Date; endedAt: Date | null }> = {},
    ) =>
      prisma.organizationPositionAssignment.create({
        data: {
          memberId,
          organizationId,
          positionId,
          status: overrides.status ?? AssignmentStatus.ACTIVE,
          startedAt: overrides.startedAt ?? PAST_START,
          endedAt: overrides.endedAt ?? null,
        },
        select: { id: true },
      });

    // 场景 1:队长甲 team-leader@SECT(policy→org-admin@TREE)
    cuiAssignmentId = (await mkAssignment(cui.memberId, sectId, teamLeaderId)).id;
    // 场景 3:副队长乙仅分管 SECT(TREE),无职务无绑定
    huangSupervisionId = (
      await prisma.organizationSupervisionAssignment.create({
        data: {
          supervisorMemberId: huang.memberId,
          organizationId: sectId,
          scopeMode: SupervisionScopeMode.TREE,
          status: SupervisionStatus.ACTIVE,
          startedAt: PAST_START,
        },
        select: { id: true },
      })
    ).id;
    // 场景 4:APD 部长任职 + 终审测试角色 + POSITION_ASSIGNMENT 主体绑定 @TREE(root)
    apdAssignmentId = (await mkAssignment(apdHead.memberId, apdId, deptLeaderId)).id;
    const finalReviewerRole = await prisma.rbacRole.create({
      data: { code: 'test-final-reviewer', displayName: '测试终审角色(BD-2 中枢形态)' },
      select: { id: true },
    });
    const finalPerms = await prisma.permission.findMany({
      where: { code: { in: ['attendance.final-approve.sheet', 'attendance.read.sheet'] } },
      select: { id: true },
    });
    expect(finalPerms).toHaveLength(2);
    await prisma.rolePermission.createMany({
      data: finalPerms.map((p) => ({ roleId: finalReviewerRole.id, permissionId: p.id })),
    });
    apdBindingId = (
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.POSITION_ASSIGNMENT,
          principalId: apdAssignmentId,
          roleId: finalReviewerRole.id,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: rootId,
          status: BindingStatus.ACTIVE,
        },
        select: { id: true },
      })
    ).id;
    // R5:副队长任职 @root,零 policy 行 → 3b 零产出
    await mkAssignment(vice.memberId, rootId, viceCaptainId);
    // SELF:MEMBER 主体 + SELF scope + org-supervisor(含 member.read.record)
    selfBindingId = (
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.MEMBER,
          principalId: selfGuy.memberId,
          roleId: orgSupervisorRoleId,
          scopeType: BindingScopeType.SELF,
          status: BindingStatus.ACTIVE,
        },
        select: { id: true },
      })
    ).id;
    // 失效族
    await mkAssignment(revokedGuy.memberId, sectId, teamLeaderId, {
      status: AssignmentStatus.REVOKED,
    });
    await mkAssignment(expiredGuy.memberId, sectId, teamLeaderId, { endedAt: PAST_END });
    await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: endedSupGuy.memberId,
        organizationId: sectId,
        scopeMode: SupervisionScopeMode.TREE,
        status: SupervisionStatus.ENDED,
        startedAt: PAST_START,
        endedAt: PAST_END,
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: expiredBindGuy.userId,
        roleId: orgAdminRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: sectId,
        status: BindingStatus.ACTIVE,
        startedAt: PAST_START,
        endedAt: PAST_END,
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: inactBindGuy.userId,
        roleId: orgSupervisorRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: inactOrgId,
        status: BindingStatus.ACTIVE,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const sheetRef = (id: string) => ({ type: 'attendance_sheet', id });
  const memberRef = (id: string) => ({ type: 'member', id });

  // ============ 场景 1:队长甲(3b 职务推导) ============

  it('场景 1:team-leader@SECT → org-admin@TREE 覆盖 SECT 子组 sheet 读(source=position)', async () => {
    const d = await authz.explain(cui.payload, 'attendance.read.sheet', sheetRef(sheet1Id));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('matched');
    expect(d.matchedGrant).toMatchObject({
      source: 'position',
      positionAssignmentId: cuiAssignmentId,
      roleCode: 'org-admin',
      scopeType: 'ORGANIZATION_TREE',
      scopeId: sectId,
    });
    expect(d.resource).toMatchObject({ organizationId: grpId });
  });

  it('场景 1:同 ref 终审 DENY no_permission(BD-2:org-admin 56 码不含终审)', async () => {
    const d = await authz.explain(
      cui.payload,
      'attendance.final-approve.sheet',
      sheetRef(sheet1Id),
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('no_permission');
    expect(d.matchedGrant).toBeUndefined();
  });

  // ============ 场景 3:副队长乙(3c 分管推导) ============

  it('场景 3:仅分管 SECT(TREE)→ SECT 队员读 ALLOW(source=supervision,org-supervisor)', async () => {
    const d = await authz.explain(huang.payload, 'member.read.record', memberRef(sectMemberId));
    expect(d.allow).toBe(true);
    expect(d.matchedGrant).toMatchObject({
      source: 'supervision',
      supervisionAssignmentId: huangSupervisionId,
      roleCode: 'org-supervisor',
      scopeType: 'ORGANIZATION_TREE',
      scopeId: sectId,
    });
  });

  it('场景 3:SWRT 队员 → DENY out_of_supervised_scope(分管源专属 reason)', async () => {
    const d = await authz.explain(huang.payload, 'member.read.record', memberRef(swrtMemberId));
    expect(d).toMatchObject({ allow: false, reason: 'out_of_supervised_scope' });
  });

  it('场景 3:写操作 → DENY no_permission(BD-3 org-supervisor 只读 4 码)', async () => {
    const d = await authz.explain(huang.payload, 'member.update.record', memberRef(sectMemberId));
    expect(d).toMatchObject({ allow: false, reason: 'no_permission' });
  });

  it('无 ref 退化:三源持有者(副队长乙)无 ref 判权 === rbac 旧语义(推导源不泄入)', async () => {
    expect(await authz.can(huang.payload, 'member.read.record')).toBe(false);
    expect(await authz.can(cui.payload, 'attendance.read.sheet')).toBe(false);
  });

  // ============ 场景 4:BD-2 终审中枢(3a POSITION_ASSIGNMENT 主体绑定) ============

  it('场景 4:APD 部长任职上的显式绑定(TREE@root)→ 任意 sheet 终审 ALLOW(source=role_binding)', async () => {
    const d = await authz.explain(
      apdHead.payload,
      'attendance.final-approve.sheet',
      sheetRef(sheet1Id),
    );
    expect(d.allow).toBe(true);
    expect(d.matchedGrant).toMatchObject({
      source: 'role_binding',
      bindingId: apdBindingId,
      roleCode: 'test-final-reviewer',
      scopeType: 'ORGANIZATION_TREE',
      scopeId: rootId,
    });
  });

  it('场景 4:自己提交的 sheet → DENY self_approval_forbidden(scope 命中仍被域不变量否决)', async () => {
    const d = await authz.explain(
      apdHead.payload,
      'attendance.final-approve.sheet',
      sheetRef(sheet2Id),
    );
    expect(d).toMatchObject({ allow: false, reason: 'self_approval_forbidden' });
  });

  it('场景 4:SUPER_ADMIN 终审自己提交的 sheet → 同样 DENY self_approval_forbidden(SA 不豁免)', async () => {
    expect(await authz.can(saPayload, 'attendance.final-approve.sheet', sheetRef(sheet1Id))).toBe(
      true,
    );
    const d = await authz.explain(saPayload, 'attendance.final-approve.sheet', sheetRef(sheet3Id));
    expect(d).toMatchObject({ allow: false, reason: 'self_approval_forbidden' });
  });

  it('场景 4:一级审核人再终审同一张 → DENY same_reviewer_forbidden(默认禁止,BD 拍板)', async () => {
    const d = await authz.explain(
      apdHead.payload,
      'attendance.final-approve.sheet',
      sheetRef(sheet4Id),
    );
    expect(d).toMatchObject({ allow: false, reason: 'same_reviewer_forbidden' });
  });

  it('场景 4:任职 ENDED → POSITION_ASSIGNMENT 主体绑定随之失效(换届即失权,expired_grant)', async () => {
    await prisma.organizationPositionAssignment.update({
      where: { id: apdAssignmentId },
      data: { status: AssignmentStatus.ENDED },
    });
    try {
      const d = await authz.explain(
        apdHead.payload,
        'attendance.final-approve.sheet',
        sheetRef(sheet1Id),
      );
      expect(d).toMatchObject({ allow: false, reason: 'expired_grant' });
    } finally {
      await prisma.organizationPositionAssignment.update({
        where: { id: apdAssignmentId },
        data: { status: AssignmentStatus.ACTIVE },
      });
    }
  });

  // ============ R5:副职零推导(安全红线) ============

  it('R5:仅持 vice-captain 任职(零 policy 行)→ 管理 action + ref 全 DENY no_permission', async () => {
    const read = await authz.explain(vice.payload, 'attendance.read.sheet', sheetRef(sheet1Id));
    expect(read).toMatchObject({ allow: false, reason: 'no_permission' });
    expect(read.matchedGrant).toBeUndefined();
    const memberRead = await authz.explain(
      vice.payload,
      'member.read.record',
      memberRef(sectMemberId),
    );
    expect(memberRead).toMatchObject({ allow: false, reason: 'no_permission' });
    const update = await authz.explain(
      vice.payload,
      'member.update.record',
      memberRef(sectMemberId),
    );
    expect(update).toMatchObject({ allow: false, reason: 'no_permission' });
  });

  // ============ 失效族 ============

  it('失效族:任职 REVOKED / 任职过期 / 分管 ENDED / 绑定过期 → DENY expired_grant', async () => {
    expect(
      await authz.explain(revokedGuy.payload, 'attendance.read.sheet', sheetRef(sheet1Id)),
    ).toMatchObject({ allow: false, reason: 'expired_grant' });
    expect(
      await authz.explain(expiredGuy.payload, 'attendance.read.sheet', sheetRef(sheet1Id)),
    ).toMatchObject({ allow: false, reason: 'expired_grant' });
    expect(
      await authz.explain(endedSupGuy.payload, 'member.read.record', memberRef(sectMemberId)),
    ).toMatchObject({ allow: false, reason: 'expired_grant' });
    expect(
      await authz.explain(expiredBindGuy.payload, 'member.read.record', memberRef(sectMemberId)),
    ).toMatchObject({ allow: false, reason: 'expired_grant' });
  });

  it('失效族:scope org INACTIVE → DENY inactive_org(绑定在期仍不覆盖)', async () => {
    const d = await authz.explain(
      inactBindGuy.payload,
      'member.read.record',
      memberRef(inactMemberId),
    );
    expect(d).toMatchObject({ allow: false, reason: 'inactive_org' });
  });

  it('失效族:resource 不存在 / 已软删 → DENY resource_not_found', async () => {
    expect(
      await authz.explain(cui.payload, 'attendance.read.sheet', sheetRef('no-such-sheet')),
    ).toMatchObject({ allow: false, reason: 'resource_not_found' });

    const doomed = await prisma.attendanceSheet.create({
      data: {
        activityId: grpActivityId,
        submitterUserId: apdHead.userId,
        statusCode: 'pending',
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    expect(
      await authz.explain(cui.payload, 'attendance.read.sheet', sheetRef(doomed.id)),
    ).toMatchObject({ allow: false, reason: 'resource_not_found' });
  });

  // ============ SELF scope ============

  it('SELF:RoleBinding(MEMBER, SELF, 含读码)→ 本人 member ref ALLOW / 他人 DENY out_of_scope', async () => {
    const own = await authz.explain(
      selfGuy.payload,
      'member.read.record',
      memberRef(selfGuy.memberId),
    );
    expect(own.allow).toBe(true);
    expect(own.matchedGrant).toMatchObject({
      source: 'role_binding',
      bindingId: selfBindingId,
      scopeType: 'SELF',
    });

    const other = await authz.explain(
      selfGuy.payload,
      'member.read.record',
      memberRef(sectMemberId),
    );
    expect(other).toMatchObject({ allow: false, reason: 'out_of_scope' });
  });
});
