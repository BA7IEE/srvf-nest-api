import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * 活动通知按**组织**定向 —— 真库穿透(维护者 2026-08-25 拍板 AC-066 的组织那一格)。
 *
 * ## 这条 e2e 补的是哪一格
 *
 * 交集与子树的判据主体在 `src/modules/activities/activity-recipient-freeze.spec.ts`
 * (正向 + 两个反向 + 两条边界 + 三次变异对拍),但那些用的是**手搓 tx mock** ——
 * 它们证明的是「代码按我以为的形状发查询」,**证不了**「真的 `organization_closure`
 * 与真的 `member_organization_memberships` 会给出我以为的那批人」。
 * 本 spec 就走一遍真库:真闭包行、真任职行、真软删、真 HTTP 发布路径。
 *
 * ## 四个人各自只差一维(与单测同一套设计,刻意不换)
 *
 *   bothMember   A 大队(直属)  有标签  ⇒ 收到
 *   orgOnly      A 大队(直属)  无标签  ⇒ **不**收到(只差标签这一维)
 *   tagOnly      B 大队(无关)  有标签  ⇒ **不**收到(只差组织这一维)
 *   subMember    A-1 分队(下级) 有标签  ⇒ 收到(只差「直属 vs 下级」这一维)
 *
 * 反面样本不在被测那一维上单独不同,上层边界就会遮蔽下层边界 —— 那时四个人一起
 * 落选也能让「不收到」的断言变绿,而判据其实什么都没证明。
 */
describe('活动通知按组织定向 —— 真闭包表 / 真任职 / 真 HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;

  let hostOrganizationId: string;
  let teamAId: string;
  let teamASubId: string;
  let teamBId: string;
  let activityTypeCode: string;
  let audienceTagTypeId: string;

  const TAG_CODE = 'org-targeting-diving';
  const previousHttpEnabled = process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'true';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const superAdmin = await createTestUser(app, {
      username: 'org-targeting-sa',
      role: Role.SUPER_ADMIN,
    });
    superAdminAuth = (await loginAs(app, superAdmin.username)).authHeader;

    // ── 组织树 ────────────────────────────────────────────────
    //   host(活动承办)
    //   teamA ── teamASub        teamB(与 teamA 无祖先关系)
    // ⚠️ 承办组织**不能是根节点**(业务规则 20011「活动不允许挂在组织根节点」)——
    //    本 spec 初版把它建成根,5 例全部卡在建活动那一步、连受众逻辑都没走到。
    const hostRoot = await prisma.organization.create({
      data: { name: '组织定向承办根', nodeTypeCode: 'org-targeting-root' },
      select: { id: true },
    });
    const host = await prisma.organization.create({
      data: { name: '组织定向承办组织', nodeTypeCode: 'org-targeting-host', parentId: hostRoot.id },
      select: { id: true },
    });
    hostOrganizationId = host.id;
    const teamA = await prisma.organization.create({
      data: { name: '组织定向 A 大队', nodeTypeCode: 'org-targeting-team' },
      select: { id: true },
    });
    teamAId = teamA.id;
    const teamASub = await prisma.organization.create({
      data: {
        name: '组织定向 A 大队下属分队',
        nodeTypeCode: 'org-targeting-squad',
        parentId: teamA.id,
      },
      select: { id: true },
    });
    teamASubId = teamASub.id;
    const teamB = await prisma.organization.create({
      data: { name: '组织定向 B 大队', nodeTypeCode: 'org-targeting-team' },
      select: { id: true },
    });
    teamBId = teamB.id;

    // 闭包表恒含 depth-0 自身行(建表 migration 的回填口径)。
    // teamB **不是** teamA 的后代 —— 这正是反向②要用的那一维。
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: hostRoot.id, descendantId: hostRoot.id, depth: 0 },
        { ancestorId: hostRoot.id, descendantId: host.id, depth: 1 },
        { ancestorId: host.id, descendantId: host.id, depth: 0 },
        { ancestorId: teamA.id, descendantId: teamA.id, depth: 0 },
        { ancestorId: teamA.id, descendantId: teamASub.id, depth: 1 },
        { ancestorId: teamASub.id, descendantId: teamASub.id, depth: 0 },
        { ancestorId: teamB.id, descendantId: teamB.id, depth: 0 },
      ],
    });

    const activityType = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', superAdminAuth)
      .send({ code: 'activity_type', label: '活动类型', sortOrder: 0 });
    expect(activityType.status).toBe(201);
    activityTypeCode = 'org-targeting-activity';
    const activityTypeItem = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', superAdminAuth)
      .send({
        typeId: activityType.body.data.id,
        code: activityTypeCode,
        label: '组织定向活动',
        sortOrder: 0,
      });
    expect(activityTypeItem.status).toBe(201);

    const tagType = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', superAdminAuth)
      .send({ code: 'member_audience_tag', label: '会员受众标签', sortOrder: 0 });
    expect(tagType.status).toBe(201);
    audienceTagTypeId = tagType.body.data.id as string;
    const tagItem = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', superAdminAuth)
      .send({ typeId: audienceTagTypeId, code: TAG_CODE, label: '潜水', sortOrder: 1 });
    expect(tagItem.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    if (previousHttpEnabled === undefined) {
      delete process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;
    } else {
      process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = previousHttpEnabled;
    }
  });

  async function createMember(memberNo: string, realName: string): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo, ...memberIdentityData(realName) },
      select: { id: true },
    });
    return member.id;
  }

  async function joinOrganization(memberId: string, organizationId: string): Promise<void> {
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId,
        organizationId,
        // effectiveWhere 要求:未软删 + ACTIVE + startedAt <= 事件时刻 + endedAt IS NULL。
        startedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
  }

  async function assignTag(memberId: string): Promise<void> {
    const assigned = await request(httpServer(app))
      .put(`/api/admin/v1/members/${memberId}/audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ tagCodes: [TAG_CODE] });
    expect(assigned.status).toBe(200);
  }

  async function createDraftActivity(title: string): Promise<string> {
    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title,
        activityTypeCode,
        organizationId: hostOrganizationId,
        startAt: '2099-09-02T01:00:00.000Z',
        endAt: '2099-09-02T05:00:00.000Z',
        registrationDeadline: '2099-09-01T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        isPublicRegistration: true,
      });
    // 先断 envelope 再断 status:失败时 jest 会把整个 body 打出来,而光看一个裸 400
    // 分不清是哪条业务规则。本 spec 初版正是靠它一次定位到
    // 20011「活动不允许挂在组织根节点」——承办组织当时被建成了根节点。
    expect(activity.body).toMatchObject({ code: 0 });
    expect(activity.status).toBe(201);
    return activity.body.data.id as string;
  }

  async function recipientsOf(activityId: string): Promise<string[]> {
    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId, destinationType: 'member' },
      select: { destinationRef: true },
    });
    return [...new Set(intents.map((intent) => intent.destinationRef))].sort();
  }

  it('组织 ∩ 标签:勾 A 大队 ⇒ 下级分队的人收到,只满足一边的两个人都收不到', async () => {
    const bothMember = await createMember('org-targeting-both', '两边都满足');
    const orgOnlyMember = await createMember('org-targeting-org-only', '在组织但没标签');
    const tagOnlyMember = await createMember('org-targeting-tag-only', '有标签但不在组织');
    const subMember = await createMember('org-targeting-sub', '下级分队且有标签');

    await joinOrganization(bothMember, teamAId);
    await joinOrganization(orgOnlyMember, teamAId);
    await joinOrganization(tagOnlyMember, teamBId);
    await joinOrganization(subMember, teamASubId);

    await assignTag(bothMember);
    await assignTag(tagOnlyMember);
    await assignTag(subMember);

    const activityId = await createDraftActivity('组织定向:A 大队 ∩ 潜水标签');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({
        requiresInsuranceConfirmed: true,
        audienceTagCodes: [TAG_CODE],
        audienceOrganizationIds: [teamAId],
      });
    expect(published.status).toBe(200);

    // 比**集合**不比计数:计数相等照样可能是「漏了一个、多了另一个」。
    expect(await recipientsOf(activityId)).toEqual([bothMember, subMember].sort());

    // 审计里同时留下两个维度的依据。
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'activity.publish', resourceId: activityId },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect((audit?.context as { extra?: Record<string, unknown> } | undefined)?.extra).toEqual({
      operation: 'publish-with-audience-tags',
      priorStatusCode: 'draft',
      nextStatusCode: 'published',
      audienceTagCodes: [TAG_CODE],
      audienceOrganizationIds: [teamAId],
      recipientCount: 2,
    });
  });

  it('只勾组织不勾标签([]) ⇒ 子树内**全体**有效会员,不是空集', async () => {
    const inTeam = await createMember('org-targeting-plain-a', 'A 大队无标签会员');
    const inSub = await createMember('org-targeting-plain-sub', '下级分队无标签会员');
    const outside = await createMember('org-targeting-plain-b', 'B 大队会员');
    await joinOrganization(inTeam, teamAId);
    await joinOrganization(inSub, teamASubId);
    await joinOrganization(outside, teamBId);

    const activityId = await createDraftActivity('组织定向:只勾 A 大队');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({
        requiresInsuranceConfirmed: true,
        audienceTagCodes: [],
        audienceOrganizationIds: [teamAId],
      });
    expect(published.status).toBe(200);

    const recipients = await recipientsOf(activityId);
    expect(recipients).toEqual(expect.arrayContaining([inTeam, inSub]));
    expect(recipients).not.toContain(outside);
  });

  it('只勾标签不勾组织 ⇒ 组织维度不设限,落库列留 NULL(存量行语义)', async () => {
    const taggedElsewhere = await createMember('org-targeting-nofilter', '任意组织的有标签会员');
    await joinOrganization(taggedElsewhere, teamBId);
    await assignTag(taggedElsewhere);

    const activityId = await createDraftActivity('组织定向:不勾组织');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [TAG_CODE] });
    expect(published.status).toBe(200);

    // 空数组**不是**空交集 —— 不勾组织时 B 大队的人照收不误。
    expect(await recipientsOf(activityId)).toContain(taggedElsewhere);

    // 审计形状与本刀之前逐字相同:不按组织发时该键整个不进 extra。
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'activity.publish', resourceId: activityId },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    const extra = (audit?.context as { extra?: Record<string, unknown> } | undefined)?.extra;
    expect(extra).not.toHaveProperty('audienceOrganizationIds');
  });

  it('已调出(endedAt 非空)的会员不算在组织里 —— 有效任职口径走真表', async () => {
    const stillIn = await createMember('org-targeting-active-member', '在队会员');
    const movedOut = await createMember('org-targeting-ended-member', '已调出会员');
    await joinOrganization(stillIn, teamAId);
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: movedOut,
        organizationId: teamAId,
        status: 'ENDED',
        startedAt: new Date('2020-01-01T00:00:00.000Z'),
        endedAt: new Date('2021-01-01T00:00:00.000Z'),
      },
    });
    await assignTag(stillIn);
    await assignTag(movedOut);

    const activityId = await createDraftActivity('组织定向:已调出不算在队');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({
        requiresInsuranceConfirmed: true,
        audienceTagCodes: [TAG_CODE],
        audienceOrganizationIds: [teamAId],
      });
    expect(published.status).toBe(200);

    const recipients = await recipientsOf(activityId);
    expect(recipients).toContain(stillIn);
    expect(recipients).not.toContain(movedOut);
  });

  it('组织 id 不存在 ⇒ 整批拒,不静默算出一个空收件人集', async () => {
    const activityId = await createDraftActivity('组织定向:幽灵组织');
    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({
        requiresInsuranceConfirmed: true,
        audienceTagCodes: [TAG_CODE],
        audienceOrganizationIds: [teamAId, 'org-does-not-exist'],
      });
    expect(published.status).toBe(400);

    // 拒了就不该留下任何 intent,也不该把活动发出去。
    expect(await recipientsOf(activityId)).toEqual([]);
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true },
    });
    expect(activity.statusCode).toBe('draft');
  });

  it('落库列与 audienceTagCodes 同形:非空写数组、不勾组织留 NULL', async () => {
    const column = await prisma.$queryRaw<
      Array<{ data_type: string; udt_name: string; is_nullable: string }>
    >`
      SELECT data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'activity_publish_reviews'
        AND column_name = 'audienceOrganizationIds'
    `;
    // 与姊妹列 audienceTagCodes 逐字同形:可空 JSONB、无 default。
    expect(column).toEqual([{ data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES' }]);

    const columnDefault = await prisma.$queryRaw<Array<{ column_default: string | null }>>`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'activity_publish_reviews'
        AND column_name = 'audienceOrganizationIds'
    `;
    expect(columnDefault[0]?.column_default).toBeNull();
  });
});
