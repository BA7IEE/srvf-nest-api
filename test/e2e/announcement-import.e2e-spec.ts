import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { PositionAssignmentsService } from '../../src/modules/position-assignments/position-assignments.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11;goal DoD §2/§3)公告导入 preview/execute e2e。
//
// 覆盖:
//   RBAC 权限边界(preview/execute 各自判权,无码 30100)
//   preview 标记族(goal DoD 2):memberNo 命中 ok / displayName 唯一命中回显建议 needs-manual /
//     displayName 多义 needs-manual / member 不存在 blocked / orgCode 不存在 blocked /
//     职务不适配该类别 blocked / 缺归属 blocked / 已任职 already-exists / 组织行 provisional ok
//   preview 零写入断言(表 count 前后不变)+ 同请求新组织被后续任命/分管真实引用且与 execute 同结果
//   execute(goal DoD 3):混合三类行一次落库(组节点含 provisional + 任职含字段/任期/isConcurrent/
//     appointmentSource + audit 落 + 分管)/ 无 memberNo 行拒 / 重跑全 skipped(幂等)/
//     部分失败不影响其它行 / 同批组织行可被后续行通过 orgCode 引用 / 未声明异常整请求回滚
//
// R13 红线:全部用例使用合成占位数据(AIE2E- 前缀 memberNo / "测试X" 占位姓名),不含任何真实
// 2026 任命公告姓名 / memberNo 对照。
//
// RBAC:沿 position-assignments.e2e-spec.ts / supervision-assignments.e2e-spec.ts 范式,rbac.fixture
// 共享 56 码基线不含 position-assignment.* / supervision-assignment.* / announcement-import.*,
// 本 spec 在 beforeAll 内联 seed 这 4 码 + 绑 ops-admin(org.create.node 已在共享基线中)。

const EXTRA_CODES = [
  'position-assignment.create.record',
  'supervision-assignment.create.record',
  'announcement-import.preview.record',
  'announcement-import.execute.record',
] as const;

async function seedExtraCodesAndBind(prisma: PrismaService, opsAdminRoleId: string): Promise<void> {
  for (const code of EXTRA_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...EXTRA_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

describe('announcement-import 公告导入 preview/execute', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let userAuth: string;

  // 配置面基线(beforeAll 建一次,只读复用)。
  let posGroupLeaderId: string; // 有 (group, posGroupLeader) 规则,requireMembership=true
  let posTeamOnlyId: string; // 只有 (rescue-team, posTeamOnly) 规则,对 group 而言 RULE_NOT_MATCHED
  let orgTeamId: string; // rescue-team,根
  let orgGroupId: string; // group,parent=orgTeam,已存在(非本次导入新建)

  let memberSeq = 0;
  async function newMember(
    tag: string,
    opts: { displayName?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
  ): Promise<{ id: string; memberNo: string }> {
    memberSeq += 1;
    const memberNo = `AIE2E-${tag}-${memberSeq}`;
    const m = await prisma.member.create({
      data: {
        memberNo,
        displayName: opts.displayName ?? `测试-${tag}-${memberSeq}`,
        status: opts.status ?? 'ACTIVE',
      },
      select: { id: true },
    });
    return { id: m.id, memberNo };
  }

  async function addMembership(memberId: string, organizationId: string): Promise<void> {
    await prisma.memberOrganizationMembership.create({
      data: { memberId, organizationId, membershipType: 'PRIMARY', status: 'ACTIVE' },
    });
  }

  const startedAt = '2026-07-01T00:00:00.000Z';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'ai-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'ai-user', role: Role.USER });
    adminAuth = (await loginAs(app, 'ai-adm')).authHeader;
    userAuth = (await loginAs(app, 'ai-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedExtraCodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // node_type 字典(供 OrganizationsService.create 的 assertNodeTypeCodeValid 6 项 AND 校验通过;
    // 组织行 nodeTypeCode 恒为 'group',沿 organizations.e2e-spec.ts 范式)。
    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: nodeType.id, code: 'group', label: '组' } });

    // 职务定义
    const [groupLeader, teamOnly] = await Promise.all([
      prisma.organizationPosition.create({
        data: {
          code: 'ai-e2e-group-leader',
          name: '组长',
          categoryCode: 'LEADER',
          allowMultiple: true,
          allowConcurrent: true,
        },
        select: { id: true },
      }),
      prisma.organizationPosition.create({
        data: {
          code: 'ai-e2e-team-only',
          name: '仅队级职务',
          categoryCode: 'LEADER',
          allowMultiple: true,
          allowConcurrent: true,
        },
        select: { id: true },
      }),
    ]);
    posGroupLeaderId = groupLeader.id;
    posTeamOnlyId = teamOnly.id;

    // 组织树:orgTeam(rescue-team,根)/ orgGroup(group,parent=orgTeam,已存在)
    const team = await prisma.organization.create({
      data: { name: 'ai-e2e-team', code: 'AIE2E-TEAM', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgTeamId = team.id;
    const group = await prisma.organization.create({
      data: {
        name: 'ai-e2e-existing-group',
        code: 'AIE2E-GRP',
        nodeTypeCode: 'group',
        parentId: orgTeamId,
      },
      select: { id: true },
    });
    orgGroupId = group.id;

    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: orgTeamId, descendantId: orgTeamId, depth: 0 },
        { ancestorId: orgGroupId, descendantId: orgGroupId, depth: 0 },
        { ancestorId: orgTeamId, descendantId: orgGroupId, depth: 1 },
      ],
    });

    await prisma.organizationPositionRule.createMany({
      data: [
        { nodeTypeCode: 'group', positionId: posGroupLeaderId, requireMembership: true },
        { nodeTypeCode: 'rescue-team', positionId: posTeamOnlyId, requireMembership: false },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function preview(auth: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .post('/api/admin/v1/announcement-import/preview')
      .set('Authorization', auth)
      .send(body);
  }

  function execute(auth: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .post('/api/admin/v1/announcement-import/execute')
      .set('Authorization', auth)
      .send(body);
  }

  // ============ RBAC 权限边界 ============

  describe('RBAC 权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/announcement-import/preview')
        .send({ organizations: [{ code: 'X', parentCode: 'Y', name: 'Z' }] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 无码 → preview 30100', async () => {
      const res = await preview(userAuth, {
        organizations: [{ code: 'X', parentCode: 'Y', name: 'Z' }],
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 无码 → execute 30100', async () => {
      const res = await execute(userAuth, {
        organizations: [{ code: 'X', parentCode: 'Y', name: 'Z' }],
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ preview 标记族 + 零写入(goal DoD 2)============

  describe('preview 标记族(单请求覆盖全部标记 + 零写入断言)', () => {
    it(
      'memberNo ok / displayName 唯一 needs-manual+建议 / displayName 多义 needs-manual / ' +
        'member 不存在 blocked / orgCode 不存在 blocked / 职务不适配 blocked / 缺归属 blocked / ' +
        '已任职 already-exists / 组织行 provisional ok —— 全程零写入',
      async () => {
        const memberHappy = await newMember('happy');
        await addMembership(memberHappy.id, orgTeamId); // 祖先归属,满足 requireMembership

        const memberUnique = await newMember('uniq', { displayName: '测试唯一命中甲' });
        await prisma.member.create({
          data: {
            memberNo: `AIE2E-DUP-${++memberSeq}`,
            displayName: '测试重名乙',
            status: 'ACTIVE',
          },
        });
        await prisma.member.create({
          data: {
            memberNo: `AIE2E-DUP-${++memberSeq}`,
            displayName: '测试重名乙',
            status: 'ACTIVE',
          },
        });

        const memberNoMembership = await newMember('nomem');
        // 故意不给 memberNoMembership 任何归属

        const memberAlready = await newMember('already');
        await addMembership(memberAlready.id, orgTeamId);
        await prisma.organizationPositionAssignment.create({
          data: {
            organizationId: orgGroupId,
            positionId: posGroupLeaderId,
            memberId: memberAlready.id,
            status: 'ACTIVE',
            startedAt: new Date(startedAt),
          },
        });

        const countsBefore = await Promise.all([
          prisma.organization.count(),
          prisma.organizationPositionAssignment.count(),
          prisma.organizationSupervisionAssignment.count(),
          prisma.auditLog.count(),
        ]);

        const res = await preview(adminAuth, {
          organizations: [
            {
              code: 'AIE2E-PREVIEW-NEW',
              parentCode: 'AIE2E-TEAM',
              name: '预览筹备组',
              establishmentStatusCode: 'provisional',
            },
          ],
          positions: [
            {
              memberNo: memberHappy.memberNo,
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              displayName: '测试唯一命中甲',
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              displayName: '测试重名乙',
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              memberNo: 'AIE2E-DOES-NOT-EXIST',
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              memberNo: memberHappy.memberNo,
              orgCode: 'AIE2E-NO-SUCH-ORG',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              memberNo: memberHappy.memberNo,
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-team-only',
              startedAt,
            },
            {
              memberNo: memberNoMembership.memberNo,
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
            {
              memberNo: memberAlready.memberNo,
              orgCode: 'AIE2E-GRP',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
          ],
        });

        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
        const data = res.body.data as {
          organizations: Array<{ status: string; organizationId: string | null }>;
          positions: Array<{ status: string; suggestedMemberNo: string | null }>;
        };

        expect(data.organizations[0].status).toBe('ok');
        expect(typeof data.organizations[0].organizationId).toBe('string');

        expect(data.positions[0].status).toBe('ok'); // memberNo 命中
        expect(data.positions[1].status).toBe('needs-manual');
        expect(data.positions[1].suggestedMemberNo).toBe(memberUnique.memberNo); // 唯一命中回显建议
        expect(data.positions[2].status).toBe('needs-manual');
        expect(data.positions[2].suggestedMemberNo ?? null).toBeNull(); // 多义,无建议
        expect(data.positions[3].status).toBe('blocked'); // member 不存在
        expect(data.positions[4].status).toBe('blocked'); // orgCode 不存在
        expect(data.positions[5].status).toBe('blocked'); // 职务不适配该类别(RULE_NOT_MATCHED)
        expect(data.positions[6].status).toBe('blocked'); // 缺归属(MEMBERSHIP_REQUIRED)
        expect(data.positions[7].status).toBe('already-exists'); // 已任职

        // 零写入:preview 前后表 count 完全不变(含 organizations[] 的 dry-run 组节点)。
        const countsAfter = await Promise.all([
          prisma.organization.count(),
          prisma.organizationPositionAssignment.count(),
          prisma.organizationSupervisionAssignment.count(),
          prisma.auditLog.count(),
        ]);
        expect(countsAfter).toEqual(countsBefore);
      },
    );
  });

  // ============ preview / execute 同事务拓扑 + fatal rollback ============

  describe('preview / execute 同事务拓扑', () => {
    it('同请求新组织 + 引用它的任命/分管:preview 与 execute 同为 ok,preview 零写入', async () => {
      const memberPos = await newMember('parity-pos');
      await addMembership(memberPos.id, orgTeamId);
      const memberSup = await newMember('parity-sup');
      const body = {
        organizations: [
          { code: 'AIE2E-PARITY-GRP', parentCode: 'AIE2E-TEAM', name: '同事务拓扑组' },
        ],
        positions: [
          {
            memberNo: memberPos.memberNo,
            orgCode: 'AIE2E-PARITY-GRP',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
        ],
        supervisions: [
          {
            supervisorMemberNo: memberSup.memberNo,
            orgCode: 'AIE2E-PARITY-GRP',
            startedAt,
          },
        ],
      };
      const countsBefore = await Promise.all([
        prisma.organization.count(),
        prisma.organizationPositionAssignment.count(),
        prisma.organizationSupervisionAssignment.count(),
        prisma.auditLog.count(),
      ]);

      const previewRes = await preview(adminAuth, body);
      expect(previewRes.status).toBe(200);
      const previewData = previewRes.body.data as {
        organizations: Array<{ status: string; reasons: unknown[] }>;
        positions: Array<{ status: string; reasons: unknown[] }>;
        supervisions: Array<{ status: string; reasons: unknown[] }>;
      };
      expect([
        previewData.organizations[0].status,
        previewData.positions[0].status,
        previewData.supervisions[0].status,
      ]).toEqual(['ok', 'ok', 'ok']);
      expect(
        await Promise.all([
          prisma.organization.count(),
          prisma.organizationPositionAssignment.count(),
          prisma.organizationSupervisionAssignment.count(),
          prisma.auditLog.count(),
        ]),
      ).toEqual(countsBefore);

      const executeRes = await execute(adminAuth, body);
      expect(executeRes.status).toBe(200);
      const executeData = executeRes.body.data as typeof previewData;
      expect([
        executeData.organizations[0].status,
        executeData.positions[0].status,
        executeData.supervisions[0].status,
      ]).toEqual(['ok', 'ok', 'ok']);
      expect({
        organizations: executeData.organizations.map(({ status, reasons }) => ({
          status,
          reasons,
        })),
        positions: executeData.positions.map(({ status, reasons }) => ({ status, reasons })),
        supervisions: executeData.supervisions.map(({ status, reasons }) => ({ status, reasons })),
      }).toEqual({
        organizations: previewData.organizations.map(({ status, reasons }) => ({
          status,
          reasons,
        })),
        positions: previewData.positions.map(({ status, reasons }) => ({ status, reasons })),
        supervisions: previewData.supervisions.map(({ status, reasons }) => ({ status, reasons })),
      });

      const persistedOrg = await prisma.organization.findFirst({
        where: { code: 'AIE2E-PARITY-GRP' },
        select: { id: true },
      });
      expect(persistedOrg).not.toBeNull();
      expect(
        await prisma.organizationPositionAssignment.count({
          where: { organizationId: persistedOrg!.id, memberId: memberPos.id },
        }),
      ).toBe(1);
      expect(
        await prisma.organizationSupervisionAssignment.count({
          where: { organizationId: persistedOrg!.id, supervisorMemberId: memberSup.id },
        }),
      ).toBe(1);
    });

    it('execute 未声明异常:更早成功的组织/closure/audit 随整请求回滚,不留半成品', async () => {
      const member = await newMember('fatal-rollback');
      await addMembership(member.id, orgTeamId);
      const countsBefore = await Promise.all([
        prisma.organization.count(),
        prisma.organizationClosure.count(),
        prisma.organizationPositionAssignment.count(),
        prisma.auditLog.count(),
      ]);
      const assignments = app.get(PositionAssignmentsService);
      const createSpy = jest
        .spyOn(assignments, 'create')
        .mockRejectedValueOnce(new Error('simulated announcement import failure'));

      try {
        const res = await execute(adminAuth, {
          organizations: [
            {
              code: 'AIE2E-FATAL-ROLLBACK',
              parentCode: 'AIE2E-TEAM',
              name: '应整体回滚组',
            },
          ],
          positions: [
            {
              memberNo: member.memberNo,
              orgCode: 'AIE2E-FATAL-ROLLBACK',
              positionCode: 'ai-e2e-group-leader',
              startedAt,
            },
          ],
        });
        expectBizError(res, BizCode.INTERNAL_ERROR, { strictMessage: false });
      } finally {
        createSpy.mockRestore();
      }

      expect(
        await Promise.all([
          prisma.organization.count(),
          prisma.organizationClosure.count(),
          prisma.organizationPositionAssignment.count(),
          prisma.auditLog.count(),
        ]),
      ).toEqual(countsBefore);
      expect(
        await prisma.organization.findFirst({
          where: { code: 'AIE2E-FATAL-ROLLBACK' },
          select: { id: true },
        }),
      ).toBeNull();
    });
  });

  // ============ execute(goal DoD 3)============

  describe('execute 落库(混合三类行 / 无 memberNo 拒 / 幂等重跑 / 部分失败隔离)', () => {
    it('混合三类行一次落库:组节点(provisional)+ 任职(字段/任期/isConcurrent/appointmentSource + audit)+ 分管', async () => {
      const memberPos = await newMember('exec-pos');
      await addMembership(memberPos.id, orgTeamId);
      const memberSup = await newMember('exec-sup');

      const res = await execute(adminAuth, {
        organizations: [
          {
            code: 'AIE2E-EXECGRP',
            parentCode: 'AIE2E-TEAM',
            name: '执行新组',
            establishmentStatusCode: 'provisional',
          },
        ],
        positions: [
          {
            memberNo: memberPos.memberNo,
            orgCode: 'AIE2E-EXECGRP', // 引用同请求 organizations[] 新建的组
            positionCode: 'ai-e2e-group-leader',
            startedAt,
            isConcurrent: true,
            note: 'exec-note',
          },
        ],
        supervisions: [
          {
            supervisorMemberNo: memberSup.memberNo,
            orgCode: 'AIE2E-EXECGRP',
            scopeMode: 'EXACT',
            startedAt,
          },
        ],
      });

      expect(res.status).toBe(200);
      const data = res.body.data as {
        organizations: Array<{ status: string; organizationId: string | null }>;
        positions: Array<{ status: string; positionAssignmentId: string | null }>;
        supervisions: Array<{ status: string; supervisionAssignmentId: string | null }>;
      };
      expect(data.organizations[0].status).toBe('ok');
      expect(data.positions[0].status).toBe('ok');
      expect(data.supervisions[0].status).toBe('ok');

      // 组节点真落库(含 provisional)
      const org = await prisma.organization.findFirst({
        where: { code: 'AIE2E-EXECGRP' },
        select: { id: true, nodeTypeCode: true, parentId: true, establishmentStatusCode: true },
      });
      expect(org).not.toBeNull();
      expect(org!.nodeTypeCode).toBe('group');
      expect(org!.parentId).toBe(orgTeamId);
      expect(org!.establishmentStatusCode).toBe('provisional');
      expect(org!.id).toBe(data.organizations[0].organizationId);

      // 组织行 audit 落(NEXT_TASKS P1-16;review #484 G18)——announcement-import 复用
      // OrganizationsService.create() 同一方法,批量场景自动获得逐行审计轨迹。
      const orgAudit = await prisma.auditLog.findFirst({
        where: { event: 'organization.create', resourceId: org!.id },
      });
      expect(orgAudit).not.toBeNull();

      // 任职真落库:字段 / 任期 / isConcurrent / appointmentSource 默认值正确
      const pa = await prisma.organizationPositionAssignment.findFirst({
        where: { id: data.positions[0].positionAssignmentId ?? undefined },
        select: {
          organizationId: true,
          positionId: true,
          memberId: true,
          status: true,
          startedAt: true,
          isConcurrent: true,
          note: true,
          appointmentSource: true,
        },
      });
      expect(pa).not.toBeNull();
      expect(pa!.organizationId).toBe(org!.id);
      expect(pa!.positionId).toBe(posGroupLeaderId);
      expect(pa!.memberId).toBe(memberPos.id);
      expect(pa!.status).toBe('ACTIVE');
      expect(pa!.startedAt.toISOString()).toBe(startedAt);
      expect(pa!.isConcurrent).toBe(true);
      expect(pa!.note).toBe('exec-note');
      expect(pa!.appointmentSource).toBe('announcement-2026');

      const paAudit = await prisma.auditLog.findFirst({
        where: {
          event: 'position-assignment.create',
          resourceId: pa ? data.positions[0].positionAssignmentId : undefined,
        },
      });
      expect(paAudit).not.toBeNull();

      // 分管真落库
      const sup = await prisma.organizationSupervisionAssignment.findFirst({
        where: { id: data.supervisions[0].supervisionAssignmentId ?? undefined },
        select: { organizationId: true, supervisorMemberId: true, scopeMode: true, status: true },
      });
      expect(sup).not.toBeNull();
      expect(sup!.organizationId).toBe(org!.id);
      expect(sup!.supervisorMemberId).toBe(memberSup.id);
      expect(sup!.scopeMode).toBe('EXACT');
      expect(sup!.status).toBe('ACTIVE');

      const supAudit = await prisma.auditLog.findFirst({
        where: {
          event: 'supervision-assignment.create',
          resourceId: data.supervisions[0].supervisionAssignmentId ?? undefined,
        },
      });
      expect(supAudit).not.toBeNull();
    });

    it('批量 execute 创建多个组织 → organization.create 审计行数与成功组织行数一致(NEXT_TASKS P1-16)', async () => {
      const beforeAuditCount = await prisma.auditLog.count({
        where: { event: 'organization.create' },
      });

      const res = await execute(adminAuth, {
        organizations: [
          { code: 'AIE2E-BATCH-A', parentCode: 'AIE2E-TEAM', name: '批量组A' },
          { code: 'AIE2E-BATCH-B', parentCode: 'AIE2E-TEAM', name: '批量组B' },
          { code: 'AIE2E-BATCH-C', parentCode: 'AIE2E-TEAM', name: '批量组C' },
        ],
      });

      expect(res.status).toBe(200);
      const data = res.body.data as {
        organizations: Array<{ status: string; organizationId: string | null }>;
      };
      const okRows = data.organizations.filter((o) => o.status === 'ok');
      expect(okRows).toHaveLength(3);

      const afterAuditCount = await prisma.auditLog.count({
        where: { event: 'organization.create' },
      });
      expect(afterAuditCount - beforeAuditCount).toBe(okRows.length);
    });

    it('无 memberNo 行拒(即便 displayName 给了)——不落库,不猜', async () => {
      const before = await prisma.organizationPositionAssignment.count();
      const res = await execute(adminAuth, {
        positions: [
          {
            displayName: '随便什么名字',
            orgCode: 'AIE2E-GRP',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
        ],
      });
      expect(res.status).toBe(200);
      const data = res.body.data as { positions: Array<{ status: string }> };
      expect(data.positions[0].status).toBe('blocked');
      expect(await prisma.organizationPositionAssignment.count()).toBe(before);
    });

    it('重跑幂等:同一批次再次 execute 全部 already-exists,零新增行', async () => {
      const memberPos = await newMember('idem-pos');
      await addMembership(memberPos.id, orgTeamId);
      const memberSup = await newMember('idem-sup');

      const body = {
        organizations: [{ code: 'AIE2E-IDEMGRP', parentCode: 'AIE2E-TEAM', name: '幂等组' }],
        positions: [
          {
            memberNo: memberPos.memberNo,
            orgCode: 'AIE2E-IDEMGRP',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
        ],
        supervisions: [
          { supervisorMemberNo: memberSup.memberNo, orgCode: 'AIE2E-IDEMGRP', startedAt },
        ],
      };

      const first = await execute(adminAuth, body);
      expect(first.status).toBe(200);
      const firstData = first.body.data as {
        organizations: Array<{ status: string }>;
        positions: Array<{ status: string }>;
        supervisions: Array<{ status: string }>;
      };
      expect(firstData.organizations[0].status).toBe('ok');
      expect(firstData.positions[0].status).toBe('ok');
      expect(firstData.supervisions[0].status).toBe('ok');

      const countsAfterFirst = await Promise.all([
        prisma.organization.count(),
        prisma.organizationPositionAssignment.count(),
        prisma.organizationSupervisionAssignment.count(),
      ]);

      const second = await execute(adminAuth, body);
      expect(second.status).toBe(200);
      const secondData = second.body.data as {
        organizations: Array<{ status: string }>;
        positions: Array<{ status: string }>;
        supervisions: Array<{ status: string }>;
      };
      expect(secondData.organizations[0].status).toBe('already-exists');
      expect(secondData.positions[0].status).toBe('already-exists');
      expect(secondData.supervisions[0].status).toBe('already-exists');

      const countsAfterSecond = await Promise.all([
        prisma.organization.count(),
        prisma.organizationPositionAssignment.count(),
        prisma.organizationSupervisionAssignment.count(),
      ]);
      expect(countsAfterSecond).toEqual(countsAfterFirst);
    });

    it('部分失败不影响其它行:一行 orgCode 不存在,另一行仍成功落库', async () => {
      const memberGood = await newMember('partial-ok');
      await addMembership(memberGood.id, orgTeamId);

      const res = await execute(adminAuth, {
        positions: [
          {
            memberNo: memberGood.memberNo,
            orgCode: 'AIE2E-GRP',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
          {
            memberNo: (await newMember('partial-bad')).memberNo,
            orgCode: 'AIE2E-TOTALLY-MISSING',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
        ],
      });
      expect(res.status).toBe(200);
      const data = res.body.data as {
        positions: Array<{ status: string; positionAssignmentId: string | null }>;
      };
      expect(data.positions[0].status).toBe('ok');
      expect(data.positions[1].status).toBe('blocked');

      const created = await prisma.organizationPositionAssignment.findFirst({
        where: { id: data.positions[0].positionAssignmentId ?? undefined },
      });
      expect(created).not.toBeNull();
    });
  });

  // ============ 组织行 already-exists 锚点一致性校验 + 毒丸传播(review #484 G8)============
  describe('组织行 already-exists 锚点一致性校验 + 毒丸传播(review #484 G8)', () => {
    it('code 撞既有异构组织(nodeTypeCode 非 group)→ blocked + reason,不视为 already-exists', async () => {
      const collide = await prisma.organization.create({
        data: {
          name: '异构组织-类型不符',
          code: 'AIE2E-COLLIDE-TYPE',
          nodeTypeCode: 'rescue-team',
          parentId: orgTeamId,
        },
        select: { id: true },
      });

      const res = await execute(adminAuth, {
        organizations: [
          { code: 'AIE2E-COLLIDE-TYPE', parentCode: 'AIE2E-TEAM', name: '尝试导入同 code' },
        ],
      });

      expect(res.status).toBe(200);
      const data = res.body.data as {
        organizations: Array<{
          status: string;
          organizationId: string | null;
          reasons: Array<{ bizCode: number | null; message: string }>;
        }>;
      };
      expect(data.organizations[0].status).toBe('blocked');
      expect(data.organizations[0].organizationId ?? null).toBeNull();
      expect(data.organizations[0].reasons[0].bizCode).toBeNull(); // synthetic 诊断,非底层 BizException

      // 既有异构组织本身未被篡改,也没有新组织被创建顶替它
      const stillThere = await prisma.organization.findUnique({
        where: { id: collide.id },
        select: { nodeTypeCode: true, parentId: true, name: true },
      });
      expect(stillThere!.nodeTypeCode).toBe('rescue-team');
      expect(stillThere!.name).toBe('异构组织-类型不符');
    });

    it('code 撞既有异构组织(nodeTypeCode=group 但父级不同)→ blocked + reason', async () => {
      const otherParent = await prisma.organization.create({
        data: {
          name: '另一个父组织',
          code: 'AIE2E-COLLIDE-OTHERPARENT',
          nodeTypeCode: 'group',
          parentId: orgTeamId,
        },
        select: { id: true },
      });
      const collide = await prisma.organization.create({
        data: {
          name: '异构组织-父级不符',
          code: 'AIE2E-COLLIDE-PARENT',
          nodeTypeCode: 'group',
          parentId: otherParent.id,
        },
        select: { id: true },
      });

      const res = await execute(adminAuth, {
        organizations: [
          { code: 'AIE2E-COLLIDE-PARENT', parentCode: 'AIE2E-TEAM', name: '尝试导入同 code' },
        ],
      });

      const data = res.body.data as {
        organizations: Array<{ status: string; organizationId: string | null }>;
      };
      expect(data.organizations[0].status).toBe('blocked');
      expect(data.organizations[0].organizationId ?? null).toBeNull();

      const stillThere = await prisma.organization.findUnique({
        where: { id: collide.id },
        select: { parentId: true },
      });
      expect(stillThere!.parentId).toBe(otherParent.id); // 未被篡改
    });

    it('毒丸传播:锚点冲突组织行的 code 阻断同请求任职/分管行落库,不影响同批其它未声明 code', async () => {
      // 构造"若毒丸拦截失效,resolveOrg 直查 DB 会正常命中"的既有异构组织——nodeType=group、
      // rule/membership 前提均满足,唯独 parentId 不同,确保拦截一旦失效任职/分管行会真的落库成功,
      // 而不是恰好被其它校验挡住导致测试失去区分力。
      const poisonParent = await prisma.organization.create({
        data: {
          name: '毒丸-其它父',
          code: 'AIE2E-POISON-OTHERPARENT',
          nodeTypeCode: 'group',
          parentId: orgTeamId,
        },
        select: { id: true },
      });
      await prisma.organizationClosure.createMany({
        data: [
          { ancestorId: poisonParent.id, descendantId: poisonParent.id, depth: 0 },
          { ancestorId: orgTeamId, descendantId: poisonParent.id, depth: 1 },
        ],
      });
      const collideOrg = await prisma.organization.create({
        data: {
          name: '毒丸-冲突组',
          code: 'AIE2E-POISON-ORG',
          nodeTypeCode: 'group',
          parentId: poisonParent.id,
        },
        select: { id: true },
      });
      await prisma.organizationClosure.createMany({
        data: [
          { ancestorId: collideOrg.id, descendantId: collideOrg.id, depth: 0 },
          { ancestorId: poisonParent.id, descendantId: collideOrg.id, depth: 1 },
          { ancestorId: orgTeamId, descendantId: collideOrg.id, depth: 2 },
        ],
      });

      const memberPoisonPos = await newMember('poison-pos');
      await addMembership(memberPoisonPos.id, orgTeamId); // collideOrg 的祖先,若误挂会满足 requireMembership
      const memberPoisonSup = await newMember('poison-sup');
      const memberSafe = await newMember('poison-safe');
      await addMembership(memberSafe.id, orgTeamId); // orgGroupId 的祖先,合法路径

      const res = await execute(adminAuth, {
        organizations: [
          { code: 'AIE2E-POISON-ORG', parentCode: 'AIE2E-TEAM', name: '尝试复用(应判 blocked)' },
        ],
        positions: [
          {
            memberNo: memberPoisonPos.memberNo,
            orgCode: 'AIE2E-POISON-ORG',
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
          {
            memberNo: memberSafe.memberNo,
            orgCode: 'AIE2E-GRP', // 未在本请求 organizations[] 中声明,既有合法组织
            positionCode: 'ai-e2e-group-leader',
            startedAt,
          },
        ],
        supervisions: [
          { supervisorMemberNo: memberPoisonSup.memberNo, orgCode: 'AIE2E-POISON-ORG', startedAt },
        ],
      });

      expect(res.status).toBe(200);
      const data = res.body.data as {
        organizations: Array<{ status: string }>;
        positions: Array<{ status: string }>;
        supervisions: Array<{ status: string }>;
      };
      expect(data.organizations[0].status).toBe('blocked');
      expect(data.positions[0].status).toBe('blocked'); // 毒丸传播
      expect(data.positions[1].status).toBe('ok'); // 未声明于 organizations[] 的既有 code,不受影响
      expect(data.supervisions[0].status).toBe('blocked'); // 毒丸传播

      const poisonedPa = await prisma.organizationPositionAssignment.findFirst({
        where: { memberId: memberPoisonPos.id },
      });
      expect(poisonedPa).toBeNull();
      const poisonedSup = await prisma.organizationSupervisionAssignment.findFirst({
        where: { supervisorMemberId: memberPoisonSup.id },
      });
      expect(poisonedSup).toBeNull();
      const safePa = await prisma.organizationPositionAssignment.findFirst({
        where: { memberId: memberSafe.id },
      });
      expect(safePa).not.toBeNull();
      expect(safePa!.organizationId).toBe(orgGroupId);
    });

    it('preview 与 execute 对锚点冲突分类完全一致(dryRun 不影响判断)', async () => {
      const collide = await prisma.organization.create({
        data: {
          name: '异构-一致性核对',
          code: 'AIE2E-COLLIDE-PARITY',
          nodeTypeCode: 'rescue-team',
          parentId: orgTeamId,
        },
        select: { id: true },
      });
      const body = {
        organizations: [
          { code: 'AIE2E-COLLIDE-PARITY', parentCode: 'AIE2E-TEAM', name: '一致性核对' },
        ],
      };

      const previewRes = await preview(adminAuth, body);
      const executeRes = await execute(adminAuth, body);

      const previewData = previewRes.body.data as { organizations: Array<{ status: string }> };
      const executeData = executeRes.body.data as { organizations: Array<{ status: string }> };
      expect(previewData.organizations[0].status).toBe('blocked');
      expect(executeData.organizations[0].status).toBe('blocked');

      const stillThere = await prisma.organization.findUnique({
        where: { id: collide.id },
        select: { nodeTypeCode: true },
      });
      expect(stillThere!.nodeTypeCode).toBe('rescue-team'); // 双方均未篡改既有组织
    });
  });
});
