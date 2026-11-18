import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';

// ===== 第 2 批第 ⑨b 刀：审核读面 + 账本读面 =====
//
// 本 spec 不经过 prepare / commit 服务，而是直接造 "上游已经产出的分录"：本刀只验证
// HTTP 读面是否守住 §6.11 的 committed-only 不变量。若先走真实写链，preparing / ready
// 形态很难稳定落到读面，反而会把 "没有可见性旁路" 测成 "夹具没造出来"。

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');

interface LedgerFixture {
  activityId: string;
  versionId: string;
  batchId: string;
  memberId: string;
  ledgerDate: string;
  entryKeys: string[];
  identityId: string;
  resultId: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function itemKeys(response: request.Response): string[] {
  return response.body.data.items.map((item: { entryKey: string }) => item.entryKey);
}

function settlementVersionIds(response: request.Response): string[] {
  const items: unknown = response.body.data.items;
  if (!Array.isArray(items)) throw new Error('审核工作台响应缺少 items 数组');
  return items.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('settlementVersionId' in item) ||
      typeof item.settlementVersionId !== 'string'
    ) {
      throw new Error('审核工作台项缺少 settlementVersionId');
    }
    return item.settlementVersionId;
  });
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

describe('第 2 批第 ⑨b 刀 —— 审核与账本读面', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let adminUserId: string;
  let adminAuthHeader: string;
  let appAuthHeader: string;
  let appMemberId: string;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const organization = await prisma.organization.create({
      data: { name: '第 ⑨b 刀账本读面组织', nodeTypeCode: 'activity-batch2-9b-team' },
      select: { id: true },
    });
    organizationId = organization.id;

    const admin = await createTestUser(app, {
      username: 'activity-batch2-9b-admin',
      role: Role.SUPER_ADMIN,
    });
    adminUserId = admin.id;
    adminAuthHeader = (await loginAs(app, admin.username)).authHeader;

    const appUser = await createTestUser(app, {
      username: 'activity-batch2-9b-member',
      role: Role.USER,
    });
    const appMember = await prisma.member.create({
      data: {
        memberNo: 'activity-batch2-9b-member-no',
        ...memberIdentityData('第 ⑨b 刀本人队员'),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    appMemberId = appMember.id;
    await prisma.user.update({ where: { id: appUser.id }, data: { memberId: appMember.id } });
    appAuthHeader = (await loginAs(app, appUser.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createLedgerFixture(options: {
    batchStatus: 'preparing' | 'ready' | 'committed';
    ledgerDate: string;
    memberId?: string;
    organizationId?: string;
    title?: string;
    submitterId?: string;
    submittedAt?: Date;
    participantCount?: number;
  }): Promise<LedgerFixture> {
    sequence += 1;
    const tag = `batch2-9b-${sequence}`;
    const memberId =
      options.memberId ??
      (
        await prisma.member.create({
          data: {
            memberNo: `${tag}-member`,
            ...memberIdentityData(`${tag} 队员`),
            gradeCode: 'level-2',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        })
      ).id;

    const activity = await prisma.activity.create({
      data: {
        title: options.title ?? `第 ⑨b 刀账本活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId: options.organizationId ?? organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-session`,
        name: `${tag} 场次`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SESSION_END,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: options.participantCount ?? 1,
        populationCountBySession: {},
        contentHash: `${tag}-seal`,
        statusCode: 'active',
        sealedByUserId: adminUserId,
        sealedAt: SESSION_END,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: options.batchStatus === 'committed' ? 'posted' : 'posting',
        currentSubmittedVersion: 1,
        ...(options.batchStatus === 'committed' ? { currentPostedVersion: 1 } : {}),
      },
      select: { id: true },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${tag}-content`,
        personCount: options.participantCount ?? 1,
        sessionParticipationCount: options.participantCount ?? 1,
        serviceSegmentCount: options.participantCount ?? 1,
        createdByUserId: options.submitterId ?? adminUserId,
        submittedAt: options.submittedAt ?? SESSION_END,
        statusCode: 'approved',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId, statusCode: 'approved' },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });
    const result = await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 1,
        resultCode: 'present',
        recognizedServiceHours: 2,
        recognizedContributionPoints: 1,
        calculatedServiceHours: 2,
        calculatedContributionPoints: 1,
        statusCode: options.batchStatus === 'committed' ? 'committed' : 'draft',
      },
      select: { id: true },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: options.batchStatus,
        requestKey: `${tag}-batch`,
        requestHash: `${tag}-batch-hash`,
        totalCount: 2,
        preparedCount: options.batchStatus === 'preparing' ? 1 : 2,
        ...(options.batchStatus === 'preparing'
          ? {}
          : { preparedAt: SESSION_END, preparedByUserId: adminUserId }),
        ...(options.batchStatus === 'committed'
          ? { committedAt: SESSION_END, committedByUserId: adminUserId }
          : {}),
      },
      select: { id: true },
    });
    const date = new Date(`${options.ledgerDate}T00:00:00.000Z`);
    const entries = await Promise.all(
      [
        {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: 2,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        },
        {
          entryTypeCode: 'contribution_credit',
          serviceHoursDelta: 0,
          recognizedPointsDelta: 1,
          creditedPointsDelta: 1,
          cappedOutPointsDelta: 0,
        },
      ].map((entry) =>
        prisma.participationLedgerEntry.create({
          data: {
            postingBatchId: batch.id,
            entryKey: `${tag}:${entry.entryTypeCode}`,
            operationKey: `${tag}:${entry.entryTypeCode}:operation`,
            memberId,
            activityId: activity.id,
            sessionId: session.id,
            participationIdentityId: identity.id,
            resultRevisionId: result.id,
            ledgerDate: date,
            ...entry,
          },
          select: { entryKey: true },
        }),
      ),
    );

    return {
      activityId: activity.id,
      versionId: version.id,
      batchId: batch.id,
      memberId,
      ledgerDate: options.ledgerDate,
      entryKeys: entries.map((entry) => entry.entryKey).sort(),
      identityId: identity.id,
      resultId: result.id,
    };
  }

  describe('A3/A4 管理员审核能力', () => {
    const prefix = 'review-read-a3';
    let rootOrg: string;
    let childOrg: string;
    let outsiderOrg: string;
    let first: LedgerFixture;
    let second: LedgerFixture;
    let outsider: LedgerFixture;
    let readerAuth: string;
    let readerId: string;
    let bindingId: string;
    let roleId: string;
    let nextVersionId: string;
    const from = new Date('2020-08-01T00:00:00.000Z');
    const to = new Date('2020-08-03T00:00:00.000Z');

    const list = (query: Record<string, unknown> = {}, auth = adminAuthHeader) =>
      request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', auth)
        .query({ activityQ: prefix, ...query });
    const detail = (id: string, query: Record<string, unknown> = {}, auth = adminAuthHeader) =>
      request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${id}/review-detail`)
        .set('Authorization', auth)
        .query(query);

    beforeAll(async () => {
      rootOrg = (
        await prisma.organization.create({
          data: { name: '审核查询根组织', nodeTypeCode: 'group' },
        })
      ).id;
      childOrg = (
        await prisma.organization.create({
          data: { name: '审核查询子组织', nodeTypeCode: 'group', parentId: rootOrg },
        })
      ).id;
      outsiderOrg = (
        await prisma.organization.create({
          data: { name: '审核查询范围外组织', nodeTypeCode: 'group' },
        })
      ).id;
      await prisma.organizationClosure.createMany({
        data: [
          { ancestorId: rootOrg, descendantId: rootOrg, depth: 0 },
          { ancestorId: childOrg, descendantId: childOrg, depth: 0 },
          { ancestorId: rootOrg, descendantId: childOrg, depth: 1 },
        ],
      });
      const submitter = await createTestUser(app, {
        username: 'review-a3-submitter',
        role: Role.USER,
      });
      await prisma.user.update({ where: { id: submitter.id }, data: { nickname: 'ReviewNeedle' } });
      first = await createLedgerFixture({
        batchStatus: 'ready',
        ledgerDate: '2020-08-01',
        organizationId: rootOrg,
        title: `${prefix}-North`,
        submitterId: submitter.id,
        submittedAt: from,
      });
      second = await createLedgerFixture({
        batchStatus: 'committed',
        ledgerDate: '2020-08-03',
        organizationId: childOrg,
        title: `${prefix}-South`,
        submittedAt: to,
      });
      outsider = await createLedgerFixture({
        batchStatus: 'ready',
        ledgerDate: '2020-08-02',
        organizationId: outsiderOrg,
        title: `${prefix}-Outside`,
        submittedAt: new Date('2020-08-02T00:00:00.000Z'),
      });
      const reader = await createTestUser(app, { username: 'review-a3-reader', role: Role.USER });
      readerId = reader.id;
      const permission = await prisma.permission.upsert({
        where: { code: 'attendance.read.sheet' },
        create: {
          code: 'attendance.read.sheet',
          module: 'attendance',
          action: 'read',
          resourceType: 'sheet',
        },
        update: {},
      });
      roleId = (
        await prisma.rbacRole.create({
          data: {
            code: 'review-a3-reader',
            displayName: '审核读取专用测试角色',
            rolePermissions: { create: { permissionId: permission.id } },
          },
        })
      ).id;
      bindingId = (
        await prisma.roleBinding.create({
          data: {
            principalType: PrincipalType.USER,
            principalId: readerId,
            roleId,
            scopeType: BindingScopeType.ORGANIZATION_TREE,
            scopeOrgId: rootOrg,
            status: 'ACTIVE',
          },
        })
      ).id;
      readerAuth = (await loginAs(app, reader.username)).authHeader;
      const original = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: first.versionId },
      });
      const newer = await prisma.attendanceSettlementVersion.create({
        data: {
          settlementRunId: original.settlementRunId,
          version: 2,
          evidenceSealId: original.evidenceSealId,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: 'review-a4-v2',
          personCount: 1,
          sessionParticipationCount: 1,
          serviceSegmentCount: 1,
          statusCode: 'returned',
          createdByUserId: adminUserId,
          submittedAt: new Date('2020-08-04T00:00:00.000Z'),
          priorVersionId: original.id,
        },
      });
      nextVersionId = newer.id;
      await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: newer.id,
          participationIdentityId: first.identityId,
          revision: 2,
          resultCode: 'leave',
          recognizedServiceHours: 0,
          calculatedServiceHours: 2,
          recognizedContributionPoints: 0,
          calculatedContributionPoints: 1,
          adjustmentReason: 'review-test-private-free-text',
          statusCode: 'draft',
          baseResultRevisionId: first.resultId,
        },
      });
      await prisma.attendanceSettlementRun.update({
        where: { id: original.settlementRunId },
        data: { currentSubmittedVersion: 2 },
      });
    });

    it.each([
      ['q', 'REVIEW-A3-SUBMITTER'],
      ['q', 'reviewneedle'],
      ['q', `${prefix}-north`],
      ['activityQ', `${prefix}-north`],
    ])('搜索 %s=%s 命中正确版本而不泄露用户其他字段', async (field, value) => {
      const response = await list({ [field]: value, statusCode: 'approved' }).expect(200);
      expect(settlementVersionIds(response)).toEqual([first.versionId]);
      expect(response.body.data.items[0].submittedBy).toEqual({
        id: expect.any(String),
        username: 'review-a3-submitter',
        nickname: 'ReviewNeedle',
      });
      expect(response.body.data.items[0]).not.toHaveProperty('activity');
    });

    it('activityQ 不搜索提交人，q/activityQ/状态/活动范围共同求交', async () => {
      expect((await list({ activityQ: 'ReviewNeedle' }).expect(200)).body.data.total).toBe(0);
      const response = await list({
        q: 'ReviewNeedle',
        activityId: first.activityId,
        statusCode: 'approved',
      }).expect(200);
      expect(settlementVersionIds(response)).toEqual([first.versionId]);
      expect(
        (await list({ q: 'ReviewNeedle', activityId: second.activityId }).expect(200)).body.data
          .total,
      ).toBe(0);
      expect((await list({ activityId: 'missing-activity-a3' }).expect(200)).body.data.total).toBe(
        0,
      );
    });

    it('组织及后代与真实授权范围求交，外部组织和总数均不可见', async () => {
      const own = await list(
        { organizationId: rootOrg, statusCode: 'approved' },
        readerAuth,
      ).expect(200);
      expect(settlementVersionIds(own)).toEqual([first.versionId]);
      const tree = await list(
        { organizationId: rootOrg, includeDescendants: true, statusCode: 'approved' },
        readerAuth,
      ).expect(200);
      expect(settlementVersionIds(tree).sort()).toEqual([first.versionId, second.versionId].sort());
      expect(tree.body.data.total).toBe(2);
      expect(
        (
          await list({ organizationId: outsiderOrg, includeDescendants: true }, readerAuth).expect(
            200,
          )
        ).body.data.total,
      ).toBe(0);
      expect(
        settlementVersionIds(
          await list({ organizationId: outsiderOrg }, adminAuthHeader).expect(200),
        ),
      ).toEqual([outsider.versionId]);
    });

    it('提交时间双端包含、顺序稳定、分页不漏不重；审核通过与入账状态区分', async () => {
      const query = {
        organizationId: rootOrg,
        includeDescendants: true,
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
        statusCode: 'approved',
        pageSize: 1,
      };
      const one = await list({ ...query, page: 1 }).expect(200);
      const two = await list({ ...query, page: 2 }).expect(200);
      expect(one.body.data.total).toBe(2);
      expect(two.body.data.total).toBe(2);
      expect(settlementVersionIds(one)).toEqual([second.versionId]);
      expect(settlementVersionIds(two)).toEqual([first.versionId]);
      expect(one.body.data.items[0]).toMatchObject({
        statusCode: 'approved',
        postingBatchStatusCode: 'committed',
      });
      expect(two.body.data.items[0]).toMatchObject({
        statusCode: 'approved',
        postingBatchStatusCode: 'ready',
      });
      expect((await list({ dateFrom: to.toISOString(), dateTo: from.toISOString() })).status).toBe(
        400,
      );
    });

    it('返回指定状态和活动上下文，未知扩展不能偷偷生效', async () => {
      const response = await list({ statusCode: 'returned', expand: 'activity' }).expect(200);
      expect(settlementVersionIds(response)).toEqual([nextVersionId]);
      expect(response.body.data.items[0].activity).toEqual({
        id: first.activityId,
        title: `${prefix}-North`,
        organizationId: rootOrg,
        startAt: SESSION_START.toISOString(),
      });
      expect((await list({ statusCode: 'voided' }).expect(200)).body.data.total).toBe(0);
      expect((await list({ statusCode: 'draft' }).expect(200)).body.data.total).toBe(0);
    });

    it.each([
      { expand: 'member' },
      { includeDescendants: 'yes' },
      { statusCode: 'pending' },
      { dateFrom: 'bad-date' },
      { pageSize: 101 },
      { q: 'a'.repeat(201) },
      { raw: 'anything' },
    ])('非法查询 %j 拒绝且不写成功审计', async (query) => {
      const before = await prisma.auditLog.count();
      expect((await list(query)).status).toBe(400);
      expect(await prisma.auditLog.count()).toBe(before);
    });

    it('待审阶段按该版本的一审事实过滤，不把活动当前阶段套到历史版本', async () => {
      const f = await createLedgerFixture({
        batchStatus: 'ready',
        ledgerDate: '2020-08-08',
        title: `${prefix}-Stage`,
      });
      const base = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: f.versionId },
      });
      const pending = await prisma.attendanceSettlementVersion.create({
        data: {
          settlementRunId: base.settlementRunId,
          version: 2,
          evidenceSealId: base.evidenceSealId,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: 'a3-stage-version',
          personCount: 0,
          sessionParticipationCount: 0,
          serviceSegmentCount: 0,
          statusCode: 'submitted',
          submittedAt: from,
          createdByUserId: adminUserId,
        },
      });
      const query = { activityId: f.activityId };
      const before = await list({ ...query, reviewStage: 'first' }).expect(200);
      expect(settlementVersionIds(before)).toEqual([pending.id]);
      expect(before.body.data.items[0].reviewStage).toBe('first');
      expect((await list({ ...query, reviewStage: 'final' }).expect(200)).body.data.total).toBe(0);
      await prisma.settlementReviewAction.create({
        data: {
          settlementVersionId: pending.id,
          stageCode: 'first',
          actionCode: 'approve',
          actorUserId: readerId,
          actedAt: from,
          operationKey: 'a3-stage-first-approved',
        },
      });
      expect((await list({ ...query, reviewStage: 'first' }).expect(200)).body.data.total).toBe(0);
      const after = await list({ ...query, reviewStage: 'final' }).expect(200);
      expect(settlementVersionIds(after)).toEqual([pending.id]);
      expect(after.body.data.items[0].reviewStage).toBe('final');
      expect(
        (await list({ ...query, statusCode: 'approved', reviewStage: 'final' }).expect(200)).body
          .data.total,
      ).toBe(0);
    });

    it('逐人详情来自指定冻结版本，后续版本、当前指针及取消人员都不能替换历史', async () => {
      await prisma.activityParticipationIdentity.update({
        where: { id: first.identityId },
        data: { currentStatusCode: 'cancelled', populationIncluded: false },
      });
      const old = await detail(first.versionId, {}, readerAuth).expect(200);
      const newer = await detail(nextVersionId, {}, readerAuth).expect(200);
      expect(old.body.data.results).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(old.body.data.results.items[0]).toMatchObject({
        id: first.resultId,
        participationIdentityId: first.identityId,
        resultCode: 'present',
        recognizedServiceHours: '2.00',
        recognizedContributionPoints: '1.00',
        member: { id: first.memberId, memberNo: expect.any(String), label: expect.any(String) },
      });
      expect(newer.body.data.results.items[0]).toMatchObject({
        resultCode: 'leave',
        recognizedServiceHours: '0.00',
        calculatedServiceHours: '2.00',
        hasAdjustment: true,
      });
      expect(JSON.stringify(newer.body.data)).not.toContain('review-test-private-free-text');
      const item: unknown = old.body.data.results.items[0];
      if (
        typeof item !== 'object' ||
        item === null ||
        !('member' in item) ||
        typeof item.member !== 'object' ||
        item.member === null
      ) {
        throw new Error('冻结结果缺少人员摘要');
      }
      expect(Object.keys(item.member).sort()).toEqual([
        'id',
        'label',
        'memberNo',
        'nickname',
        'realName',
      ]);
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'participationIdentityId',
          'revision',
          'resultCode',
          'lateFlag',
          'earlyLeaveFlag',
          'recognizedServiceHours',
          'calculatedServiceHours',
          'recognizedContributionPoints',
          'calculatedContributionPoints',
          'hasAdjustment',
          'member',
          'session',
          'timeResultState',
          'timeBuckets',
          'contributionResultState',
          'nativeCalculatedContributionPoints',
          'nativeRecognizedContributionPoints',
        ].sort(),
      );
    });

    it('无成员额外读权的原组织读者可审本组织版本，越权与不存在一致；撤权即时生效', async () => {
      expect((await detail(first.versionId, {}, readerAuth)).status).toBe(200);
      const denied = await detail(outsider.versionId, {}, readerAuth);
      const missing = await detail('missing-version-a4', {}, readerAuth);
      expect(denied.status).toBe(403);
      expect(missing.body.code).toBe(denied.body.code);
      await prisma.roleBinding.update({ where: { id: bindingId }, data: { status: 'ENDED' } });
      try {
        expect((await list({}, readerAuth)).status).toBe(403);
        expect((await detail(first.versionId, {}, readerAuth)).status).toBe(403);
      } finally {
        await prisma.roleBinding.update({ where: { id: bindingId }, data: { status: 'ACTIVE' } });
      }
    });

    it('超过100人的版本可翻页读全，不截断为证明预览；软删人员的冻结结果仍保留', async () => {
      const f = await createLedgerFixture({
        batchStatus: 'ready',
        ledgerDate: '2020-08-06',
        participantCount: 102,
      });
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: f.identityId },
      });
      const indices = Array.from({ length: 101 }, (_, i) => i);
      await prisma.member.createMany({
        data: indices.map((i) => ({
          id: `a4-page-member-${i}`,
          memberNo: `a4-page-member-${i}`,
          ...memberIdentityData(`A4分页测试${i}`),
          gradeCode: 'level-2',
          status: MemberStatus.ACTIVE,
        })),
      });
      await prisma.activityRegistration.createMany({
        data: indices.map((i) => ({
          id: `a4-page-registration-${i}`,
          activityId: f.activityId,
          memberId: `a4-page-member-${i}`,
          statusCode: 'approved',
        })),
      });
      await prisma.activityParticipationIdentity.createMany({
        data: indices.map((i) => ({
          id: `a4-page-identity-${i}`,
          activityId: f.activityId,
          sessionId: identity.sessionId,
          memberId: `a4-page-member-${i}`,
          registrationId: `a4-page-registration-${i}`,
          currentStatusCode: 'pass',
          populationIncluded: true,
        })),
      });
      await prisma.participantSettlementResultRevision.createMany({
        data: indices.map((i) => ({
          settlementVersionId: f.versionId,
          participationIdentityId: `a4-page-identity-${i}`,
          revision: 1,
          resultCode: 'present',
          recognizedServiceHours: '1.25',
          calculatedServiceHours: '1.25',
          recognizedContributionPoints: '1.00',
          calculatedContributionPoints: '1.00',
          statusCode: 'draft',
        })),
      });
      await prisma.member.update({
        where: { id: 'a4-page-member-0' },
        data: { deletedAt: new Date() },
      });
      const one = await detail(f.versionId, { page: 1, pageSize: 100 }).expect(200);
      const two = await detail(f.versionId, { page: 2, pageSize: 100 }).expect(200);
      const again = await detail(f.versionId, { page: 1, pageSize: 100 }).expect(200);
      expect(one.body.data.version.personCount).toBe(102);
      expect(one.body.data.results.total).toBe(102);
      expect(two.body.data.results.total).toBe(102);
      expect(one.body.data.results.items).toHaveLength(100);
      expect(two.body.data.results.items).toHaveLength(2);
      expect(again.body.data.results).toEqual(one.body.data.results);
      const all: Array<{ participationIdentityId: string; recognizedServiceHours: string }> = [
        ...one.body.data.results.items,
        ...two.body.data.results.items,
      ];
      expect(new Set(all.map((row) => row.participationIdentityId)).size).toBe(102);
      expect(all.find((row) => row.participationIdentityId === 'a4-page-identity-0')).toMatchObject(
        { recognizedServiceHours: '1.25' },
      );
    });

    it('可变 draft 仅保留已有元数据，results 明确为 null，不冒充冻结事实', async () => {
      const original = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: first.versionId },
      });
      const draft = await prisma.attendanceSettlementVersion.create({
        data: {
          settlementRunId: original.settlementRunId,
          version: 3,
          evidenceSealId: original.evidenceSealId,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: 'a4-mutable-draft',
          personCount: 0,
          sessionParticipationCount: 0,
          serviceSegmentCount: 0,
          statusCode: 'draft',
        },
      });
      expect((await detail(draft.id).expect(200)).body.data.results).toBeNull();
      expect(
        settlementVersionIds(await list({ activityId: first.activityId }).expect(200)),
      ).not.toContain(draft.id);
    });

    it('读取审计只记录字段名和计数，写入审计后再故障也不返回数据', async () => {
      await list({ q: 'ReviewNeedle', statusCode: 'approved' }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({
        where: {
          event: 'attendance-sheet.read.other',
          resourceType: 'attendance_settlement_version',
          resourceId: 'collection',
          actorUserId: adminUserId,
        },
        orderBy: { createdAt: 'desc' },
      });
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain('ReviewNeedle');
      const audit = app.get(AuditLogsService);
      const original = audit.log.bind(audit);
      const spy = jest.spyOn(audit, 'log').mockImplementation(async (input) => {
        await original(input);
        throw new Error('A4 audit failure after write');
      });
      try {
        for (const response of [await list(), await detail(first.versionId)]) {
          expect(response.status).toBe(500);
          expect(response.body.data == null).toBe(true);
          expect(JSON.stringify(response.body)).not.toContain(first.memberId);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('GET attendance-settlements 按 page/pageSize 返回跨活动审核工作台', async () => {
    await createLedgerFixture({ batchStatus: 'preparing', ledgerDate: '2020-04-10' });
    await createLedgerFixture({ batchStatus: 'ready', ledgerDate: '2020-04-11' });
    await createLedgerFixture({ batchStatus: 'committed', ledgerDate: '2020-04-12' });

    const first = await request(httpServer(app))
      .get('/api/admin/v1/attendance-settlements')
      .query({ page: 1, pageSize: 1 })
      .set('Authorization', adminAuthHeader);
    const second = await request(httpServer(app))
      .get('/api/admin/v1/attendance-settlements')
      .query({ page: 2, pageSize: 1 })
      .set('Authorization', adminAuthHeader);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data).toMatchObject({ total: expect.any(Number), page: 1, pageSize: 1 });
    expect(second.body.data).toMatchObject({ total: expect.any(Number), page: 2, pageSize: 1 });
    expect(first.body.data.total).toBeGreaterThanOrEqual(3);
    expect(intersection(settlementVersionIds(first), settlementVersionIds(second))).toEqual([]);
  });

  it('GET review-detail 返回不可变版本、seal、差异与缺口', async () => {
    const fixture = await createLedgerFixture({ batchStatus: 'ready', ledgerDate: '2020-04-20' });

    const response = await request(httpServer(app))
      .get(`/api/admin/v1/attendance-settlements/${fixture.versionId}/review-detail`)
      .set('Authorization', adminAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      version: { id: fixture.versionId, statusCode: 'approved', contentHash: expect.any(String) },
      diff: expect.any(Object),
      sealRevisions: [expect.objectContaining({ statusCode: 'active', sealRevision: 1 })],
      gaps: expect.any(Array),
    });
  });

  it.each(['preparing', 'ready', 'committed'] as const)(
    'GET posting-batch 如实报告 %s 进度，preparing 不可显示为已生效',
    async (status) => {
      const fixture = await createLedgerFixture({
        batchStatus: status,
        ledgerDate: `2020-04-2${status.length}`,
      });

      const response = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${fixture.versionId}/posting-batch`)
        .set('Authorization', adminAuthHeader);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        statusCode: status,
        effective: status === 'committed',
      });
      if (status === 'preparing') {
        expect(response.body.data.effectiveLabel).toBe('尚未正式生效');
      }
    },
  );

  it('preparing / ready 分录对三读面的 items 与 total 都不可见；批次变 committed 后三面同时可见', async () => {
    const preparing = await createLedgerFixture({
      batchStatus: 'preparing',
      ledgerDate: '2020-05-01',
      memberId: appMemberId,
    });
    const ready = await createLedgerFixture({
      batchStatus: 'ready',
      ledgerDate: '2020-05-02',
      memberId: appMemberId,
    });

    const appBefore = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 20, activityId: preparing.activityId })
      .set('Authorization', appAuthHeader);
    const memberBefore = await request(httpServer(app))
      .get(`/api/admin/v1/members/${appMemberId}/participation-ledger`)
      .query({
        page: 1,
        pageSize: 20,
        dateFrom: preparing.ledgerDate,
        dateTo: preparing.ledgerDate,
      })
      .set('Authorization', adminAuthHeader);
    const activityBefore = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${preparing.activityId}/participation-ledger`)
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', adminAuthHeader);
    const readyBefore = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 20, activityId: ready.activityId })
      .set('Authorization', appAuthHeader);
    // 活动轴必须同时钉 items 与 total；只把 count SQL 放宽为 ready 时，这一条应单独红。
    const readyActivityBefore = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${ready.activityId}/participation-ledger`)
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', adminAuthHeader);

    for (const response of [
      appBefore,
      memberBefore,
      activityBefore,
      readyBefore,
      readyActivityBefore,
    ]) {
      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual([]);
      expect(response.body.data.total).toBe(0);
    }
    await expect(
      prisma.participationLedgerEntry.count({
        where: { postingBatchId: { in: [preparing.batchId, ready.batchId] } },
      }),
    ).resolves.toBe(4);

    await prisma.ledgerPostingBatch.update({
      where: { id: preparing.batchId },
      data: { statusCode: 'committed', committedAt: SESSION_END, committedByUserId: adminUserId },
    });

    const appAfter = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 20, activityId: preparing.activityId })
      .set('Authorization', appAuthHeader);
    const memberAfter = await request(httpServer(app))
      .get(`/api/admin/v1/members/${appMemberId}/participation-ledger`)
      .query({
        page: 1,
        pageSize: 20,
        dateFrom: preparing.ledgerDate,
        dateTo: preparing.ledgerDate,
      })
      .set('Authorization', adminAuthHeader);
    const activityAfter = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${preparing.activityId}/participation-ledger`)
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', adminAuthHeader);

    for (const response of [appAfter, memberAfter, activityAfter]) {
      expect(response.status).toBe(200);
      expect(itemKeys(response).sort()).toEqual(preparing.entryKeys);
    }
  });

  it('三个账本端点各自分页生效，activityId / dateFrom / dateTo 红集两两不重叠', async () => {
    const filterUser = await createTestUser(app, {
      username: `activity-batch2-9b-filter-${sequence}`,
      role: Role.USER,
    });
    const filterMember = await prisma.member.create({
      data: {
        memberNo: `activity-batch2-9b-filter-member-${sequence}`,
        ...memberIdentityData('第 ⑨b 刀分页过滤队员'),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: filterUser.id }, data: { memberId: filterMember.id } });
    const filterAuthHeader = (await loginAs(app, filterUser.username)).authHeader;
    const first = await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2019-06-01',
      memberId: filterMember.id,
    });
    const second = await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2019-06-02',
      memberId: filterMember.id,
    });
    const third = await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2019-06-03',
      memberId: filterMember.id,
    });

    const appPageOne = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 1 })
      .set('Authorization', filterAuthHeader);
    const appPageTwo = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 2, pageSize: 1 })
      .set('Authorization', filterAuthHeader);
    const appActivity = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 20, activityId: second.activityId })
      .set('Authorization', filterAuthHeader);
    const memberPageOne = await request(httpServer(app))
      .get(`/api/admin/v1/members/${filterMember.id}/participation-ledger`)
      .query({ page: 1, pageSize: 1 })
      .set('Authorization', adminAuthHeader);
    const memberPageTwo = await request(httpServer(app))
      .get(`/api/admin/v1/members/${filterMember.id}/participation-ledger`)
      .query({ page: 2, pageSize: 1 })
      .set('Authorization', adminAuthHeader);
    const memberFrom = await request(httpServer(app))
      .get(`/api/admin/v1/members/${filterMember.id}/participation-ledger`)
      .query({ page: 1, pageSize: 20, dateFrom: third.ledgerDate })
      .set('Authorization', adminAuthHeader);
    const memberTo = await request(httpServer(app))
      .get(`/api/admin/v1/members/${filterMember.id}/participation-ledger`)
      .query({ page: 1, pageSize: 20, dateTo: first.ledgerDate })
      .set('Authorization', adminAuthHeader);
    const activityPageOne = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${first.activityId}/participation-ledger`)
      .query({ page: 1, pageSize: 1 })
      .set('Authorization', adminAuthHeader);
    const activityPageTwo = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${first.activityId}/participation-ledger`)
      .query({ page: 2, pageSize: 1 })
      .set('Authorization', adminAuthHeader);

    for (const response of [
      appPageOne,
      appPageTwo,
      appActivity,
      memberPageOne,
      memberPageTwo,
      memberFrom,
      memberTo,
      activityPageOne,
      activityPageTwo,
    ]) {
      expect(response.status).toBe(200);
    }
    expect(intersection(itemKeys(appPageOne), itemKeys(appPageTwo))).toEqual([]);
    expect(intersection(itemKeys(memberPageOne), itemKeys(memberPageTwo))).toEqual([]);
    expect(intersection(itemKeys(activityPageOne), itemKeys(activityPageTwo))).toEqual([]);
    expect(itemKeys(appActivity).sort()).toEqual(second.entryKeys);
    expect(itemKeys(memberFrom).sort()).toEqual(third.entryKeys);
    expect(itemKeys(memberTo).sort()).toEqual(first.entryKeys);
    expect(intersection(itemKeys(appActivity), itemKeys(memberFrom))).toEqual([]);
    expect(intersection(itemKeys(memberFrom), itemKeys(memberTo))).toEqual([]);
    expect(intersection(itemKeys(memberTo), itemKeys(appActivity))).toEqual([]);
  });

  it('App 账本恒为本人范围；无权 admin member 探测不存在与存在主体得到同一拒绝', async () => {
    const own = await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2020-07-01',
      memberId: appMemberId,
    });
    const other = await createLedgerFixture({ batchStatus: 'committed', ledgerDate: '2020-07-02' });

    const appResponse = await request(httpServer(app))
      .get('/api/app/v1/my/participation-ledger')
      .query({ page: 1, pageSize: 50 })
      .set('Authorization', appAuthHeader);
    const deniedExisting = await request(httpServer(app))
      .get(`/api/admin/v1/members/${other.memberId}/participation-ledger`)
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', appAuthHeader);
    const deniedMissing = await request(httpServer(app))
      .get('/api/admin/v1/members/absent-member-activity-batch2-9b/participation-ledger')
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', appAuthHeader);

    expect(appResponse.status).toBe(200);
    expect(itemKeys(appResponse)).toEqual(expect.arrayContaining(own.entryKeys));
    expect(intersection(itemKeys(appResponse), other.entryKeys)).toEqual([]);
    expect(deniedExisting.status).toBe(403);
    expect(deniedMissing.status).toBe(403);
    expect(deniedExisting.body.code).toBe(deniedMissing.body.code);
  });

  it('四个 Admin 读面均按 attendance.read.sheet 判权，版本与活动探测不泄露存在性', async () => {
    const fixture = await createLedgerFixture({ batchStatus: 'ready', ledgerDate: '2020-07-03' });

    const [
      workbench,
      detailExisting,
      detailMissing,
      batchExisting,
      batchMissing,
      activityExisting,
      activityMissing,
    ] = await Promise.all([
      request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .query({ page: 1, pageSize: 20 })
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${fixture.versionId}/review-detail`)
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements/absent-version-activity-batch2-9b/review-detail')
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${fixture.versionId}/posting-batch`)
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements/absent-version-activity-batch2-9b/posting-batch')
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get(`/api/admin/v1/activities/${fixture.activityId}/participation-ledger`)
        .query({ page: 1, pageSize: 20 })
        .set('Authorization', appAuthHeader),
      request(httpServer(app))
        .get('/api/admin/v1/activities/absent-activity-batch2-9b/participation-ledger')
        .query({ page: 1, pageSize: 20 })
        .set('Authorization', appAuthHeader),
    ]);

    for (const response of [
      workbench,
      detailExisting,
      detailMissing,
      batchExisting,
      batchMissing,
      activityExisting,
      activityMissing,
    ]) {
      expect(response.status).toBe(403);
    }
    expect(detailExisting.body.code).toBe(detailMissing.body.code);
    expect(batchExisting.body.code).toBe(batchMissing.body.code);
    expect(activityExisting.body.code).toBe(activityMissing.body.code);
  });

  it('三个账本端点的 transport 实现只依赖 LedgerQueryService，不直接访问分录表', () => {
    const controllerPaths = [
      'src/modules/activities/controllers/app-my-participation-ledger.controller.ts',
      'src/modules/activities/controllers/admin-member-participation-ledger.controller.ts',
      'src/modules/activities/controllers/admin-activity-participation.controller.ts',
    ];

    for (const relativePath of controllerPaths) {
      const source = stripComments(readFileSync(resolve(process.cwd(), relativePath), 'utf8'));
      expect(source).toContain('LedgerQueryService');
      expect(source).not.toMatch(/\bparticipationLedgerEntry\b/);
      expect(source).not.toMatch(/\$queryRaw\b/);
    }
  });
});
