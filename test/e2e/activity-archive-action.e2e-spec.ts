import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/*
 * 活动归档 / 撤销归档的 HTTP 判据(§6.6 + AC-004 / AC-064;维护者 2026-08-25 拍板三问)。
 *
 * ## 本 spec 覆盖什么
 *
 *   ① 草稿路径的正反两向(未达阈值拒 / 达阈值准)
 *   ② **交叉反向**:已办完但没关账的活动,哪怕陈旧 400 天,也必须被拒(不是走草稿那套)
 *   ③ 归档后默认不出现在 App 负责人工作台列表,勾 `includeArchived` 或按 `statusCode=archived` 才看得到
 *   ④ 撤销归档复原到归档前状态,且**归档留痕不被抹** ⇒「归过又撤过」一条 where 查得出来
 *   ⑤ 幂等重放与重复归档
 *   ⑥ AC-004 的工作台提示位 `staleDraft`
 *
 * ## 🔴 本 spec **不**覆盖什么(如实声明,不假装已守住)
 *
 * 结算路径的**放行**那一半(关账满等待期 ⇒ 准)与「关账但未满等待期 ⇒ 20157」需要一条
 * 真的 `ActivitySettlementClosureRevision`,而它有三条必填外键(settlementVersion /
 * postingBatch / evidenceSeal)—— 造这条链要把第 2 批第六刀的整套关账夹具搬过来。
 * 这两格当前只有 `activity-archive-policy.spec.ts` 的纯函数判据,**没有 HTTP 证据**。
 * 已登记在 AC-064 的卡点说明里。
 */

describe('Activity archive action', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await seedActivityResponsibilitySystemRoles(app);

    const root = await prisma.organization.create({
      data: { name: 'Archive Root', nodeTypeCode: 'archive-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: { name: 'Archive Team', nodeTypeCode: 'archive-team', parentId: root.id },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'archive-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '归档用训练' },
    });
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createMember(
    label: string,
  ): Promise<{ memberId: string; userId: string; auth: string }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `archive-${label}-${sequence}`,
        ...memberIdentityData(`Archive ${label} ${sequence}`),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `archive-${label.slice(0, 16)}-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  /**
   * 直接建库行而不是走 HTTP 建单:本 spec 要精确控制 `updatedAt`(草稿陈旧度的锚),
   * 而 HTTP 建单只会把它设成现在。`updatedAt` 是 `@updatedAt`,create 时可显式给值。
   */
  async function createActivity(options: {
    owner: { memberId: string; userId: string };
    statusCode: string;
    /** 距今多少天没人碰过。 */
    idleDays: number;
    withOwnerAssignment?: boolean;
  }): Promise<string> {
    sequence += 1;
    const updatedAt = new Date(Date.now() - options.idleDays * 24 * 60 * 60 * 1000);
    const activity = await prisma.activity.create({
      data: {
        title: `Archive activity ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: new Date('2020-07-23T01:00:00.000Z'),
        endAt: new Date('2020-07-23T05:00:00.000Z'),
        location: '深圳',
        statusCode: options.statusCode,
        initiatorMemberId: options.owner.memberId,
        allocationModeCode: 'first_come',
        updatedAt,
      },
      select: { id: true },
    });
    if (options.withOwnerAssignment === true) {
      await prisma.activityResponsibilityAssignment.create({
        data: {
          activityId: activity.id,
          memberId: options.owner.memberId,
          responsibilityType: 'owner',
          canManageRegistrations: true,
          canManageAttendance: true,
          assignedByUserId: options.owner.userId,
          source: 'publish',
        },
      });
    }
    return activity.id;
  }

  function archive(auth: string, activityId: string, operationKey: string, reason?: string) {
    return request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/archive`)
      .set('Authorization', auth)
      .send(reason === undefined ? { operationKey } : { operationKey, reason });
  }

  function unarchive(auth: string, activityId: string, operationKey: string) {
    return request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/unarchive`)
      .set('Authorization', auth)
      .send({ operationKey });
  }

  // ===== ① 草稿路径:两向 =====

  it('刚碰过的草稿不能归档(20155),且库里一列都没写', async () => {
    const owner = await createMember('fresh-draft');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 0 });

    const response = await archive(owner.auth, activityId, 'op-archive-fresh-draft');
    expectBizError(response, BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE);

    const row = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true, archivedAt: true, archiveOperationKey: true },
    });
    expect(row).toEqual({ statusCode: 'draft', archivedAt: null, archiveOperationKey: null });
  });

  it('长期无人处理的草稿可以归档,并落下归档四件事实', async () => {
    const owner = await createMember('stale-draft');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });

    const response = await archive(
      owner.auth,
      activityId,
      'op-archive-stale-draft',
      '长期无人处理',
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        activityId,
        statusCode: 'archived',
        reasonCode: 'stale_draft',
        archivedFromStatusCode: 'draft',
      }),
    );

    const row = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        statusCode: true,
        archivedByUserId: true,
        archivedFromStatusCode: true,
        archiveReasonCode: true,
        archiveOperationKey: true,
        archivedAt: true,
      },
    });
    expect(row.statusCode).toBe('archived');
    expect(row.archivedByUserId).toBe(owner.userId);
    expect(row.archivedFromStatusCode).toBe('draft');
    expect(row.archiveReasonCode).toBe('stale_draft');
    expect(row.archiveOperationKey).toBe('op-archive-stale-draft');
    expect(row.archivedAt).not.toBeNull();
  });

  // ===== ② 交叉反向:草稿那套条件撬不开结算路径 =====

  it('已办完但没关账的活动,陈旧 400 天也不能归档(20156,不是 20155)', async () => {
    const owner = await createMember('unclosed');
    const activityId = await createActivity({
      owner,
      statusCode: 'completed',
      idleDays: 400,
      withOwnerAssignment: true,
    });

    const response = await archive(owner.auth, activityId, 'op-archive-unclosed');
    expectBizError(response, BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED);

    const row = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true, archivedAt: true },
    });
    expect(row).toEqual({ statusCode: 'completed', archivedAt: null });
  });

  it('已发布但没关账的活动同样被拒(20156)', async () => {
    const owner = await createMember('unclosed-published');
    const activityId = await createActivity({
      owner,
      statusCode: 'published',
      idleDays: 400,
      withOwnerAssignment: true,
    });

    expectBizError(
      await archive(owner.auth, activityId, 'op-archive-unclosed-published'),
      BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED,
    );
  });

  it('取消掉的活动不属于任何一套开工条件(20030)', async () => {
    const owner = await createMember('cancelled');
    const activityId = await createActivity({
      owner,
      statusCode: 'cancelled',
      idleDays: 400,
      withOwnerAssignment: true,
    });

    expectBizError(
      await archive(owner.auth, activityId, 'op-archive-cancelled'),
      BizCode.ACTIVITY_STATUS_INVALID,
    );
  });

  // ===== ③ 归档后列表默认不显示 =====

  it('归档后默认不在工作台列表里,勾 includeArchived 或按 statusCode=archived 才看得到', async () => {
    const owner = await createMember('list-visibility');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });

    const listBefore = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .expect(200);
    expect(
      listBefore.body.data.items.map((item: { activityId: string }) => item.activityId),
    ).toContain(activityId);

    expect((await archive(owner.auth, activityId, 'op-archive-list-visibility')).status).toBe(200);

    const listAfter = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .expect(200);
    expect(
      listAfter.body.data.items.map((item: { activityId: string }) => item.activityId),
    ).not.toContain(activityId);

    const listIncluded = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities?includeArchived=true')
      .set('Authorization', owner.auth)
      .expect(200);
    expect(
      listIncluded.body.data.items.map((item: { activityId: string }) => item.activityId),
    ).toContain(activityId);

    const listArchivedOnly = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities?statusCode=archived')
      .set('Authorization', owner.auth)
      .expect(200);
    expect(
      listArchivedOnly.body.data.items.map((item: { activityId: string }) => item.activityId),
    ).toContain(activityId);
  });

  // ===== ④ 撤销归档:复原 + 留痕不被抹 =====

  it('撤销归档退回归档前的状态,而归档留痕一列都没被抹', async () => {
    const owner = await createMember('unarchive-trace');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-trace')).status).toBe(200);

    const response = await unarchive(owner.auth, activityId, 'op-unarchive-trace');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({ activityId, statusCode: 'draft', reasonCode: null }),
    );

    const row = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        statusCode: true,
        archivedAt: true,
        archivedByUserId: true,
        archivedFromStatusCode: true,
        archiveReasonCode: true,
        unarchivedAt: true,
        unarchivedByUserId: true,
      },
    });
    expect(row.statusCode).toBe('draft');
    // 🔴 DoD 的核心问题:「这个活动被归档过又撤销过」查得出来吗?
    //    答案 = 两侧时刻同时非 NULL。撤销时把归档三件事实抹掉,这条就红。
    expect(row.archivedAt).not.toBeNull();
    expect(row.unarchivedAt).not.toBeNull();
    expect(row.archivedByUserId).toBe(owner.userId);
    expect(row.unarchivedByUserId).toBe(owner.userId);
    expect(row.archivedFromStatusCode).toBe('draft');
    expect(row.archiveReasonCode).toBe('stale_draft');
  });

  it('「被归档过又撤销过」可以用一条 where 查出来', async () => {
    const owner = await createMember('trace-query');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-query')).status).toBe(200);
    expect((await unarchive(owner.auth, activityId, 'op-unarchive-query')).status).toBe(200);

    const everArchivedThenUnarchived = await prisma.activity.findMany({
      where: { archivedAt: { not: null }, unarchivedAt: { not: null } },
      select: { id: true },
    });
    expect(everArchivedThenUnarchived.map((row) => row.id)).toContain(activityId);
  });

  it('非归档态不能撤销归档(20030)', async () => {
    const owner = await createMember('unarchive-invalid');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });

    expectBizError(
      await unarchive(owner.auth, activityId, 'op-unarchive-invalid'),
      BizCode.ACTIVITY_STATUS_INVALID,
    );
  });

  /**
   * 🔴 **首跑实测推翻了本条原来的前提**(原断言写的是「撤销后可以立刻再归档」)。
   *
   * `Activity.updatedAt` 是 Prisma `@updatedAt` ⇒ **归档与撤销归档这两个动作自己也会把它推到现在**。
   * 撤销归档本来就是一次真实的人为处理(有人把这份草稿从抽屉里拿了回来),
   * 所以「长期无人处理」的时钟在那一刻**重置**是对的语义,不是缺陷:
   * 否则这个条件就成了一次性的 —— 归过一次以后,任何时候都能随手再归一次。
   *
   * 订正方向是**加强**而不是放宽:本条现在同时钉住「重置」与「重新陈旧后仍可再归」两侧。
   */
  it('撤销归档本身也算「有人处理了」:立刻再归档被拒(20155),重新放陈旧后才准', async () => {
    const owner = await createMember('recycle');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-recycle-1')).status).toBe(200);
    expect((await unarchive(owner.auth, activityId, 'op-unarchive-recycle-1')).status).toBe(200);

    // ① 时钟已被撤销归档重置 ⇒ 立刻再归必须被拒。
    expectBizError(
      await archive(owner.auth, activityId, 'op-archive-recycle-2'),
      BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE,
    );

    // ② 让它重新变陈旧(= 撤销之后又一个多月没人管)。
    //    ⚠️ 走 `$executeRaw` 而不是 `prisma.activity.update`:`@updatedAt` 列在 update 路径上
    //    由 Prisma 自己接管,显式传值会被它覆盖成 now,夹具就静默失效了。
    const staleAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE "Activity" SET "updatedAt" = ${staleAt} WHERE "id" = ${activityId}`;
    expect((await archive(owner.auth, activityId, 'op-archive-recycle-3')).status).toBe(200);

    const row = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        statusCode: true,
        archiveOperationKey: true,
        archivedFromStatusCode: true,
        unarchivedAt: true,
      },
    });
    expect(row.statusCode).toBe('archived');
    // 换成了第三轮的 key —— 单列 unique 存的是**最近一次**归档,不是全历史。
    expect(row.archiveOperationKey).toBe('op-archive-recycle-3');
    expect(row.archivedFromStatusCode).toBe('draft');
    // 上一轮的撤销留痕仍在 —— 再次归档不清它。
    expect(row.unarchivedAt).not.toBeNull();
  });

  // ===== ⑤ 幂等与重复 =====

  it('同 key 同 payload 的归档重放返回同一结果,不写第二条审计', async () => {
    const owner = await createMember('replay');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });

    const first = await archive(owner.auth, activityId, 'op-archive-replay', '重放测试');
    expect(first.status).toBe(200);
    const auditAfterFirst = await prisma.auditLog.count({ where: { resourceId: activityId } });

    const second = await archive(owner.auth, activityId, 'op-archive-replay', '重放测试');
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    await expect(prisma.auditLog.count({ where: { resourceId: activityId } })).resolves.toBe(
      auditAfterFirst,
    );
  });

  it('同 key 换 payload ⇒ 操作键冲突', async () => {
    const owner = await createMember('key-conflict');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-conflict', '第一版')).status).toBe(
      200,
    );

    expectBizError(
      await archive(owner.auth, activityId, 'op-archive-conflict', '第二版'),
      BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT,
    );
  });

  it('已归档的活动不能再次归档(换新 key 时走状态机拒)', async () => {
    const owner = await createMember('double-archive');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-double-1')).status).toBe(200);

    expectBizError(
      await archive(owner.auth, activityId, 'op-archive-double-2'),
      BizCode.ACTIVITY_STATUS_INVALID,
    );
  });

  // ===== ⑥ AC-004 工作台提示 =====

  it('工作台列表把长期无人处理的草稿标成 staleDraft,刚碰过的不标', async () => {
    const owner = await createMember('stale-hint');
    const staleId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    const freshId = await createActivity({ owner, statusCode: 'draft', idleDays: 0 });

    const list = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities?pageSize=100')
      .set('Authorization', owner.auth)
      .expect(200);
    const items = list.body.data.items as Array<{ activityId: string; staleDraft: boolean }>;
    expect(items.find((item) => item.activityId === staleId)?.staleDraft).toBe(true);
    expect(items.find((item) => item.activityId === freshId)?.staleDraft).toBe(false);
  });

  // ===== ⑦ 归档态是终止编辑态 =====

  it('已归档的草稿不能再编辑(20030),要改先撤销归档', async () => {
    const owner = await createMember('archived-readonly');
    const activityId = await createActivity({ owner, statusCode: 'draft', idleDays: 45 });
    expect((await archive(owner.auth, activityId, 'op-archive-readonly')).status).toBe(200);

    const response = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({ title: '改个名字' });
    expectBizError(response, BizCode.ACTIVITY_STATUS_INVALID);
  });
});
