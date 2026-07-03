import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { RbacService } from '../permissions/rbac.service';
import type { PositionAssignmentsService } from '../position-assignments/position-assignments.service';
import type { SupervisionAssignmentsService } from '../supervision-assignments/supervision-assignments.service';
import { AnnouncementImportService } from './announcement-import.service';

// 终态 scoped-authz PR11 service-level characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
//
// **本 spec 只锁本模块自己的逻辑**(锚定解析 / 批内去重 / displayName 辅助解析 / 逐行结果聚合 /
// dryRun 透传),**不**重新验证被复用三个 service 的 create() 内部校验(那些已在各自 spec 锁定)——
// 三个被复用 service 在这里全部是薄 jest.fn() mock,只关心"传参是否正确"与"抛出的 BizException
// 是否被正确转译成行结果"。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const META = { requestId: 'req-1', ip: null, ua: null };

function makePrismaMock() {
  return {
    organization: { findFirst: jest.fn().mockResolvedValue(null) },
    organizationPosition: { findFirst: jest.fn().mockResolvedValue(null) },
    member: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function build(prismaMock: ReturnType<typeof makePrismaMock>) {
  const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService & {
    can: jest.Mock;
  };
  const organizations = { create: jest.fn() } as unknown as OrganizationsService & {
    create: jest.Mock;
  };
  const positionAssignments = { create: jest.fn() } as unknown as PositionAssignmentsService & {
    create: jest.Mock;
  };
  const supervisionAssignments = {
    create: jest.fn(),
  } as unknown as SupervisionAssignmentsService & { create: jest.Mock };
  const svc = new AnnouncementImportService(
    prismaMock as unknown as PrismaService,
    rbac,
    organizations,
    positionAssignments,
    supervisionAssignments,
  );
  return { svc, rbac, organizations, positionAssignments, supervisionAssignments };
}

describe('AnnouncementImportService — 权限门 + 空请求', () => {
  it('三个数组均空/未传 → BAD_REQUEST', async () => {
    const { svc } = build(makePrismaMock());
    await expect(svc.preview(USER, {}, META)).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
  });

  it('preview 判权用 announcement-import.preview.record;execute 判权用 .execute.record', async () => {
    const { svc, rbac } = build(makePrismaMock());
    rbac.can.mockResolvedValue(false);
    await expect(
      svc.preview(USER, { organizations: [{ code: 'X', parentCode: 'Y', name: 'Z' }] }, META),
    ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(rbac.can).toHaveBeenCalledWith(USER, 'announcement-import.preview.record');

    await expect(
      svc.execute(USER, { organizations: [{ code: 'X', parentCode: 'Y', name: 'Z' }] }, META),
    ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(rbac.can).toHaveBeenCalledWith(USER, 'announcement-import.execute.record');
  });
});

describe('AnnouncementImportService — 组织行', () => {
  it('缺 code/parentCode/name → blocked,不调用 organizations.create', async () => {
    const { svc, organizations } = build(makePrismaMock());
    const res = await svc.preview(USER, { organizations: [{ name: 'only-name' }] }, META);
    expect(res.organizations[0].status).toBe('blocked');
    expect(organizations.create).not.toHaveBeenCalled();
  });

  it('parentCode 在库中未找到 → blocked', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst.mockResolvedValue(null);
    const { svc, organizations } = build(prisma);
    const res = await svc.preview(
      USER,
      { organizations: [{ code: 'G1', parentCode: 'NOPE', name: '新组' }] },
      META,
    );
    expect(res.organizations[0].status).toBe('blocked');
    expect(organizations.create).not.toHaveBeenCalled();
  });

  it('成功:nodeTypeCode 恒为 group,dryRun 透传,组 id 登记进 orgCodeMap 供后续行引用', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst.mockResolvedValue({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockResolvedValue({ id: 'new-org-1' });

    const res = await svc.preview(
      USER,
      {
        organizations: [
          {
            code: 'G1',
            parentCode: 'PARENT',
            name: '新组',
            establishmentStatusCode: 'provisional',
          },
        ],
      },
      META,
    );
    expect(res.organizations[0].status).toBe('ok');
    expect(res.organizations[0].organizationId).toBe('new-org-1');
    expect(organizations.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        name: '新组',
        code: 'G1',
        parentId: 'parent-1',
        nodeTypeCode: 'group',
        establishmentStatusCode: 'provisional',
      }),
      META,
      { dryRun: true },
    );
  });

  it('execute 时 dryRun:false 透传', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst.mockResolvedValue({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockResolvedValue({ id: 'new-org-1' });
    await svc.execute(
      USER,
      { organizations: [{ code: 'G1', parentCode: 'PARENT', name: '新组' }] },
      META,
    );
    expect(organizations.create).toHaveBeenCalledWith(USER, expect.anything(), META, {
      dryRun: false,
    });
  });

  it('code 在批内重复 → 第二行 blocked,第一行不受影响', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst.mockResolvedValue({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockResolvedValue({ id: 'new-org-1' });
    const res = await svc.preview(
      USER,
      {
        organizations: [
          { code: 'DUP', parentCode: 'PARENT', name: '第一次' },
          { code: 'DUP', parentCode: 'PARENT', name: '第二次' },
        ],
      },
      META,
    );
    expect(res.organizations[0].status).toBe('ok');
    expect(res.organizations[1].status).toBe('blocked');
    expect(organizations.create).toHaveBeenCalledTimes(1);
  });

  it('ORGANIZATION_CODE_ALREADY_EXISTS 且锚点匹配(nodeType=group + 父级一致)→ 幂等标 already-exists 并回填现有行 id 供后续引用', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst
      .mockResolvedValueOnce({ id: 'parent-1', nodeTypeCode: 'rescue-team' }) // parentCode 解析
      // 冲突后二次查现有行:review #484 G8 起 select 含 parentId,匹配才视为幂等 already-exists
      .mockResolvedValueOnce({ id: 'existing-org-1', nodeTypeCode: 'group', parentId: 'parent-1' });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
    );
    const res = await svc.execute(
      USER,
      { organizations: [{ code: 'EXIST', parentCode: 'PARENT', name: '已存在的组' }] },
      META,
    );
    expect(res.organizations[0].status).toBe('already-exists');
    expect(res.organizations[0].organizationId).toBe('existing-org-1');
  });

  // review #484 G8(2026-07-03):code 撞既有组织但 nodeType/父级与本行锚点不一致 → 不再无条件幂等复用,
  // 改判 blocked 并把 code 计入毒丸集(见下方"毒丸传播"describe)。
  describe('ORGANIZATION_CODE_ALREADY_EXISTS 且锚点不一致 → blocked(不再盲目复用,review #484 G8)', () => {
    it('nodeTypeCode 非 group(异构类型)→ blocked,不回填 organizationId,不进 orgCodeMap', async () => {
      const prisma = makePrismaMock();
      prisma.organization.findFirst
        .mockResolvedValueOnce({ id: 'parent-1', nodeTypeCode: 'rescue-team' }) // parentCode 解析
        .mockResolvedValueOnce({
          id: 'existing-org-1',
          nodeTypeCode: 'rescue-team',
          parentId: 'parent-1',
        }); // 类型不是 group
      const { svc, organizations, positionAssignments } = build(prisma);
      (organizations.create as jest.Mock).mockRejectedValue(
        new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
      );
      const res = await svc.execute(
        USER,
        {
          organizations: [{ code: 'COLLIDE', parentCode: 'PARENT', name: '异构撞车' }],
          positions: [
            {
              memberNo: 'T0001',
              orgCode: 'COLLIDE',
              positionCode: 'POS',
              startedAt: '2026-07-01T00:00:00.000Z',
            },
          ],
        },
        META,
      );
      expect(res.organizations[0].status).toBe('blocked');
      expect(res.organizations[0].organizationId ?? null).toBeNull();
      expect(res.organizations[0].reasons[0].bizCode).toBeNull(); // synthetic 诊断,非底层 BizException
      // 毒丸传播:引用同 code 的任职行随之 blocked,绝不经 resolveOrg 直查 DB 静默挂到异构组织
      expect(res.positions[0].status).toBe('blocked');
      expect(positionAssignments.create).not.toHaveBeenCalled();
    });

    it('nodeTypeCode=group 但父级不一致(异父)→ blocked', async () => {
      const prisma = makePrismaMock();
      prisma.organization.findFirst
        .mockResolvedValueOnce({ id: 'parent-1', nodeTypeCode: 'rescue-team' }) // parentCode 解析
        .mockResolvedValueOnce({
          id: 'existing-org-1',
          nodeTypeCode: 'group',
          parentId: 'other-parent',
        }); // 父级不同
      const { svc, organizations } = build(prisma);
      (organizations.create as jest.Mock).mockRejectedValue(
        new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
      );
      const res = await svc.execute(
        USER,
        { organizations: [{ code: 'COLLIDE2', parentCode: 'PARENT', name: '异父撞车' }] },
        META,
      );
      expect(res.organizations[0].status).toBe('blocked');
      expect(res.organizations[0].organizationId ?? null).toBeNull();
    });

    it('毒丸传播同样拦截分管行(镜像任职行)', async () => {
      const prisma = makePrismaMock();
      prisma.organization.findFirst
        .mockResolvedValueOnce({ id: 'parent-1', nodeTypeCode: 'rescue-team' }) // parentCode 解析
        .mockResolvedValueOnce({
          id: 'existing-org-1',
          nodeTypeCode: 'rescue-team',
          parentId: 'parent-1',
        }); // 冲突二次查(异构)
      const { svc, organizations, supervisionAssignments } = build(prisma);
      (organizations.create as jest.Mock).mockRejectedValue(
        new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
      );
      const res = await svc.execute(
        USER,
        {
          organizations: [{ code: 'COLLIDE3', parentCode: 'PARENT', name: '异构撞车' }],
          supervisions: [
            {
              supervisorMemberNo: 'T0001',
              orgCode: 'COLLIDE3',
              startedAt: '2026-07-01T00:00:00.000Z',
            },
          ],
        },
        META,
      );
      expect(res.organizations[0].status).toBe('blocked');
      expect(res.supervisions[0].status).toBe('blocked');
      expect(supervisionAssignments.create).not.toHaveBeenCalled();
    });
  });

  it('preview 与 execute 对锚点冲突分类完全一致(dryRun 不影响判断)', async () => {
    function buildMismatchPrisma() {
      const prisma = makePrismaMock();
      prisma.organization.findFirst
        .mockResolvedValueOnce({ id: 'parent-1', nodeTypeCode: 'rescue-team' })
        .mockResolvedValueOnce({
          id: 'existing-org-1',
          nodeTypeCode: 'rescue-team',
          parentId: 'parent-1',
        });
      return prisma;
    }
    const previewSetup = build(buildMismatchPrisma());
    (previewSetup.organizations.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
    );
    const previewRes = await previewSetup.svc.preview(
      USER,
      { organizations: [{ code: 'COLLIDE4', parentCode: 'PARENT', name: '一致性核对' }] },
      META,
    );

    const executeSetup = build(buildMismatchPrisma());
    (executeSetup.organizations.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS),
    );
    const executeRes = await executeSetup.svc.execute(
      USER,
      { organizations: [{ code: 'COLLIDE4', parentCode: 'PARENT', name: '一致性核对' }] },
      META,
    );

    expect(previewRes.organizations[0].status).toBe('blocked');
    expect(executeRes.organizations[0].status).toBe('blocked');
  });

  it('其它 BizException(如 ORGANIZATION_PARENT_NOT_FOUND)→ blocked,原样携带 bizCode/message', async () => {
    const prisma = makePrismaMock();
    prisma.organization.findFirst.mockResolvedValue({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.ORGANIZATION_PARENT_NOT_FOUND),
    );
    const res = await svc.preview(
      USER,
      { organizations: [{ code: 'G2', parentCode: 'PARENT', name: '新组' }] },
      META,
    );
    expect(res.organizations[0].status).toBe('blocked');
    expect(res.organizations[0].reasons[0].bizCode).toBe(
      BizCode.ORGANIZATION_PARENT_NOT_FOUND.code,
    );
  });
});

describe('AnnouncementImportService — 任命行(双锚 + displayName 辅助解析)', () => {
  it('缺 orgCode/positionCode/startedAt → blocked', async () => {
    const { svc, positionAssignments } = build(makePrismaMock());
    const res = await svc.preview(USER, { positions: [{ memberNo: 'M1' }] }, META);
    expect(res.positions[0].status).toBe('blocked');
    expect(positionAssignments.create).not.toHaveBeenCalled();
  });

  it('execute 且 memberNo 缺失(即便 displayName 唯一命中)→ blocked,绝不按姓名自动落库', async () => {
    const prisma = makePrismaMock();
    const { svc, positionAssignments } = build(prisma);
    const res = await svc.execute(
      USER,
      {
        positions: [
          {
            displayName: '张三',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('blocked');
    expect(positionAssignments.create).not.toHaveBeenCalled();
  });

  it('preview 且 memberNo/displayName 均缺 → blocked', async () => {
    const { svc } = build(makePrismaMock());
    const res = await svc.preview(
      USER,
      {
        positions: [{ orgCode: 'ORG', positionCode: 'POS', startedAt: '2026-07-01T00:00:00.000Z' }],
      },
      META,
    );
    expect(res.positions[0].status).toBe('blocked');
  });

  it('preview 且 displayName 唯一命中 active 队员 → needs-manual + suggestedMemberNo,不落库', async () => {
    const prisma = makePrismaMock();
    prisma.member.findMany.mockResolvedValue([{ memberNo: 'T0001' }]);
    const { svc, positionAssignments } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            displayName: '张三',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('needs-manual');
    expect(res.positions[0].suggestedMemberNo).toBe('T0001');
    expect(positionAssignments.create).not.toHaveBeenCalled();
  });

  it('preview 且 displayName 零命中 → needs-manual,无建议', async () => {
    const prisma = makePrismaMock();
    prisma.member.findMany.mockResolvedValue([]);
    const { svc } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            displayName: '查无此人',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('needs-manual');
    expect(res.positions[0].suggestedMemberNo ?? null).toBeNull();
  });

  it('preview 且 displayName 多义命中 → needs-manual,无建议', async () => {
    const prisma = makePrismaMock();
    prisma.member.findMany.mockResolvedValue([{ memberNo: 'T0001' }, { memberNo: 'T0002' }]);
    const { svc } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            displayName: '重名',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('needs-manual');
    expect(res.positions[0].suggestedMemberNo ?? null).toBeNull();
  });

  it('memberNo 命中但非 active → blocked(MEMBER_INACTIVE)', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'INACTIVE' });
    const { svc } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('blocked');
    expect(res.positions[0].reasons[0].bizCode).toBe(BizCode.MEMBER_INACTIVE.code);
  });

  it('orgCode 未找到(既非已建组,也非库中已有)→ blocked', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue(null);
    const { svc } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'NOPE',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('blocked');
    expect(res.positions[0].reasons[0].bizCode).toBe(BizCode.ORGANIZATION_NOT_FOUND.code);
  });

  it('positionCode 未找到 → blocked', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'group' });
    prisma.organizationPosition.findFirst.mockResolvedValue(null);
    const { svc } = build(prisma);
    const res = await svc.preview(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'ORG',
            positionCode: 'NOPE',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('blocked');
    expect(res.positions[0].reasons[0].bizCode).toBe(BizCode.POSITION_NOT_FOUND.code);
  });

  it('成功:解析 memberNo/orgCode/positionCode 后调用 positionAssignments.create,appointmentSource 默认 announcement-2026', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'group' });
    prisma.organizationPosition.findFirst.mockResolvedValue({ id: 'pos-1' });
    const { svc, positionAssignments } = build(prisma);
    (positionAssignments.create as jest.Mock).mockResolvedValue({ id: 'pa-1' });

    const res = await svc.execute(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
            isConcurrent: true,
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('ok');
    expect(res.positions[0].positionAssignmentId).toBe('pa-1');
    expect(positionAssignments.create).toHaveBeenCalledWith(
      USER,
      'org-1',
      expect.objectContaining({
        positionId: 'pos-1',
        memberId: 'm1',
        startedAt: '2026-07-01T00:00:00.000Z',
        isConcurrent: true,
        appointmentSource: 'announcement-2026',
      }),
      META,
      { dryRun: false },
    );
  });

  it('appointmentSource 行内显式覆盖', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'group' });
    prisma.organizationPosition.findFirst.mockResolvedValue({ id: 'pos-1' });
    const { svc, positionAssignments } = build(prisma);
    (positionAssignments.create as jest.Mock).mockResolvedValue({ id: 'pa-1' });
    await svc.preview(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
            appointmentSource: 'manual-fixup',
          },
        ],
      },
      META,
    );
    expect(positionAssignments.create).toHaveBeenCalledWith(
      USER,
      'org-1',
      expect.objectContaining({ appointmentSource: 'manual-fixup' }),
      META,
      { dryRun: true },
    );
  });

  it('POSITION_ASSIGNMENT_ALREADY_EXISTS → status=already-exists(幂等 skip)', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'group' });
    prisma.organizationPosition.findFirst.mockResolvedValue({ id: 'pos-1' });
    const { svc, positionAssignments } = build(prisma);
    (positionAssignments.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS),
    );
    const res = await svc.execute(
      USER,
      {
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'ORG',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.positions[0].status).toBe('already-exists');
  });

  it('批内重复 (member, org, position) 组合 → 第二行 blocked', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'group' });
    prisma.organizationPosition.findFirst.mockResolvedValue({ id: 'pos-1' });
    const { svc, positionAssignments } = build(prisma);
    (positionAssignments.create as jest.Mock).mockResolvedValue({ id: 'pa-1' });
    const row = {
      memberNo: 'T0001',
      orgCode: 'ORG',
      positionCode: 'POS',
      startedAt: '2026-07-01T00:00:00.000Z',
    };
    const res = await svc.preview(USER, { positions: [row, { ...row }] }, META);
    expect(res.positions[0].status).toBe('ok');
    expect(res.positions[1].status).toBe('blocked');
    expect(positionAssignments.create).toHaveBeenCalledTimes(1);
  });

  it('orgCode 引用同请求内更早声明的组织行(通过 orgCodeMap,不查库)', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organizationPosition.findFirst.mockResolvedValue({ id: 'pos-1' });
    const { svc, organizations, positionAssignments } = build(prisma);
    (organizations.create as jest.Mock).mockResolvedValue({ id: 'brand-new-org' });
    (positionAssignments.create as jest.Mock).mockResolvedValue({ id: 'pa-1' });

    // 无 parentCode → 组织行本身会 blocked,但仍应把成功建组的行登记进 map;这里构造一个能成功建组的父。
    prisma.organization.findFirst.mockResolvedValueOnce({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });

    const res = await svc.execute(
      USER,
      {
        organizations: [{ code: 'NEWGRP', parentCode: 'PARENT', name: '新组' }],
        positions: [
          {
            memberNo: 'T0001',
            orgCode: 'NEWGRP',
            positionCode: 'POS',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.organizations[0].status).toBe('ok');
    expect(res.positions[0].status).toBe('ok');
    // organization.findFirst 只应为 parentCode 解析调用一次;positions[].orgCode 命中 orgCodeMap,不再查库。
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(1);
    expect(positionAssignments.create).toHaveBeenCalledWith(
      USER,
      'brand-new-org',
      expect.anything(),
      META,
      { dryRun: false },
    );
  });
});

describe('AnnouncementImportService — 分管行(镜像任命行的锚定解析)', () => {
  it('execute 且 supervisorMemberNo 缺失 → blocked', async () => {
    const { svc, supervisionAssignments } = build(makePrismaMock());
    const res = await svc.execute(
      USER,
      {
        supervisions: [
          { displayName: '张三', orgCode: 'ORG', startedAt: '2026-07-01T00:00:00.000Z' },
        ],
      },
      META,
    );
    expect(res.supervisions[0].status).toBe('blocked');
    expect(supervisionAssignments.create).not.toHaveBeenCalled();
  });

  it('成功:解析 supervisorMemberNo/orgCode 后调用 supervisionAssignments.create', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'rescue-team' });
    const { svc, supervisionAssignments } = build(prisma);
    (supervisionAssignments.create as jest.Mock).mockResolvedValue({ id: 'sup-1' });

    const res = await svc.execute(
      USER,
      {
        supervisions: [
          {
            supervisorMemberNo: 'T0001',
            orgCode: 'ORG',
            scopeMode: 'EXACT',
            startedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      META,
    );
    expect(res.supervisions[0].status).toBe('ok');
    expect(res.supervisions[0].supervisionAssignmentId).toBe('sup-1');
    expect(supervisionAssignments.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        supervisorMemberId: 'm1',
        organizationId: 'org-1',
        scopeMode: 'EXACT',
      }),
      META,
      { dryRun: false },
    );
  });

  it('SUPERVISION_ALREADY_EXISTS → status=already-exists', async () => {
    const prisma = makePrismaMock();
    prisma.member.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', nodeTypeCode: 'rescue-team' });
    const { svc, supervisionAssignments } = build(prisma);
    (supervisionAssignments.create as jest.Mock).mockRejectedValue(
      new BizException(BizCode.SUPERVISION_ALREADY_EXISTS),
    );
    const res = await svc.execute(
      USER,
      {
        supervisions: [
          { supervisorMemberNo: 'T0001', orgCode: 'ORG', startedAt: '2026-07-01T00:00:00.000Z' },
        ],
      },
      META,
    );
    expect(res.supervisions[0].status).toBe('already-exists');
  });
});

describe('AnnouncementImportService — summary 汇总', () => {
  it('三类行混合时按 status 正确计数', async () => {
    const prisma = makePrismaMock();
    // 组织行:成功
    prisma.organization.findFirst.mockResolvedValueOnce({
      id: 'parent-1',
      nodeTypeCode: 'rescue-team',
    });
    const { svc, organizations } = build(prisma);
    (organizations.create as jest.Mock).mockResolvedValue({ id: 'org-new' });

    const res = await svc.preview(
      USER,
      {
        organizations: [{ code: 'G1', parentCode: 'PARENT', name: 'G1' }],
        positions: [{ memberNo: 'T1' }], // 缺字段 → blocked
      },
      META,
    );
    expect(res.summary.total).toBe(2);
    expect(res.summary.ok).toBe(1);
    expect(res.summary.blocked).toBe(1);
    expect(res.summary.alreadyExists).toBe(0);
    expect(res.summary.needsManual).toBe(0);
  });
});
