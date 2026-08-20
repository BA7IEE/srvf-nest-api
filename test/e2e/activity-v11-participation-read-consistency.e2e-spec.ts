import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 第六轮评审 B-01:开闸态下,各参与读面必须取自**同一个真相源** =====
//
// ## 这条 e2e 要防的缺陷
//
// v1.1 闸落地时全仓只有 `participation-summary` 一处读面接了闸,其余「对外产出工时」的
// 读面一处也没接。⇒ **闸开之后,同一个队员在不同页面会拿到不同的服务时长** ——
// 一处按已入账账本出数、另一处仍按旧 approved 考勤出数。结构判据 C8 把「漏接闸」变成
// 静态可判,本 spec 则从**行为**这一侧钉住同一件事:开闸态下几个读面的数字必须相等。
//
// ## 🔴 夹具为什么要让两个口径的数**故意不相等**
//
// 队员同时有:
//   · approved 考勤记录 —— 服务时长 4 小时(旧真相)
//   · 已 committed 账本分录 —— 服务时长 1.5 小时(新真相)
//
// 两者**故意不等**,否则本 spec 会退化成「空集 == 空集」式的假绿:若夹具两侧数字相同,
// 那么即使某个读面压根没接闸、仍在读旧真相,断言照样全绿 —— 什么都没证明。
// 取 4 vs 1.5 之后,只要有一处读面漏接闸,它就会报 `'4'` 而其余报 `'1.5'`,当场红。
// (本仓已登记的教训:比集合不比计数、先钉两边非空,否则判定恒真只表现为「什么都不发生」。)
//
// ## 夹具为什么直插账本分录而不走真实写链
//
// 沿 `activity-batch7-in-flight-display.e2e-spec.ts` 的同一理由:本 spec 要验的是**读面**
// 的取数源,若先跑 prepare/commit 服务,失败时分不清是「读面取错了」还是「夹具没造出来」。

/** 旧真相:approved 考勤口径。**故意**与账本口径不等。 */
const APPROVED_SERVICE_HOURS = '4';
const APPROVED_CONTRIBUTION_POINTS = '2';
/** 新真相:已 committed 账本口径 —— 开闸后四个读面都必须报这个数。 */
const LEDGER_SERVICE_HOURS = '1.5';
const LEDGER_CREDITED_POINTS = '0.5';

const ACTIVITY_TYPE_CODE = 'b01-read-consistency-type';
const ACTIVITY_START = new Date('2099-03-05T02:00:00.000Z');
const ACTIVITY_END = new Date('2099-03-05T06:00:00.000Z');
const ACTIVITY_MONTH = '2099-03';
const BATCH_TIME = new Date('2099-03-05T09:00:00.000Z');

describe('活动 v1.1 开闸态 —— 参与读面取自同一真相源(第六轮评审 B-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuthHeader: string;
  let memberId: string;
  let activityId: string;

  beforeAll(async () => {
    // 本 spec 声明自己跑在**闸开**一侧:读面取数源切到已 committed 账本。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const organization = await prisma.organization.create({
      data: { name: 'B-01 读面一致性组织', nodeTypeCode: 'b01-read-consistency-team' },
      select: { id: true },
    });
    const organizationId = organization.id;

    const admin = await createTestUser(app, {
      username: 'b01-read-consistency-admin',
      role: Role.SUPER_ADMIN,
    });
    const adminUserId = admin.id;
    adminAuthHeader = (await loginAs(app, admin.username)).authHeader;

    const member = await prisma.member.create({
      data: {
        memberNo: 'b01-read-consistency-no',
        ...memberIdentityData('B-01 读面一致性队员'),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    memberId = member.id;

    // 全库唯一的一个活动 —— 月度概览按月折,多一个活动就会把别人的工时折进来,
    // 「四个读面相等」这条断言就失去意义。
    const activity = await prisma.activity.create({
      data: {
        title: 'B-01 读面一致性活动',
        activityTypeCode: ACTIVITY_TYPE_CODE,
        organizationId,
        startAt: ACTIVITY_START,
        endAt: ACTIVITY_END,
        location: '深圳',
        // reconciliation 只受理 completed 活动。
        statusCode: 'completed',
      },
      select: { id: true },
    });
    activityId = activity.id;

    // ---- ① 旧真相:approved 考勤记录(4 小时 / 2 分)----
    const approvedSheet = await prisma.attendanceSheet.create({
      data: { activityId, submitterUserId: adminUserId, statusCode: 'approved' },
      select: { id: true },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: approvedSheet.id,
        memberId,
        roleCode: 'member',
        checkInAt: ACTIVITY_START,
        checkOutAt: ACTIVITY_END,
        serviceHours: APPROVED_SERVICE_HOURS,
        attendanceStatusCode: 'present',
        contributionPoints: APPROVED_CONTRIBUTION_POINTS,
      },
    });

    // ---- ② 新真相:已 committed 账本分录(1.5 小时 / 0.5 分)----
    const session = await prisma.activitySession.create({
      data: {
        activityId,
        code: 'b01-read-consistency-session',
        name: 'B-01 场次',
        startAt: ACTIVITY_START,
        endAt: ACTIVITY_END,
        locationText: '深圳',
        checkInOpenAt: new Date(ACTIVITY_START.getTime() - 3600_000),
        checkInCloseAt: new Date(ACTIVITY_START.getTime() + 3600_000),
        checkOutOpenAt: new Date(ACTIVITY_START.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date(ACTIVITY_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: ACTIVITY_END,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: 'b01-read-consistency-seal',
        statusCode: 'active',
        sealedByUserId: adminUserId,
        sealedAt: ACTIVITY_END,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId,
        statusCode: 'posted',
        currentSubmittedVersion: 1,
        currentPostedVersion: 1,
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
        contentHash: 'b01-read-consistency-content',
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: adminUserId,
        submittedAt: ACTIVITY_END,
        statusCode: 'approved',
        operationKey: 'b01-read-consistency-submit',
        requestHash: 'b01-read-consistency-submit-hash',
      },
      select: { id: true },
    });
    // statusCode 取 `pass` —— reconciliation 的 registeredParticipants 只认这个状态。
    const registration = await prisma.activityRegistration.create({
      data: { activityId, memberId, statusCode: 'pass' },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });
    const revision = await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 1,
        resultCode: 'present',
        recognizedServiceHours: LEDGER_SERVICE_HOURS,
        recognizedContributionPoints: LEDGER_CREDITED_POINTS,
        calculatedServiceHours: LEDGER_SERVICE_HOURS,
        calculatedContributionPoints: LEDGER_CREDITED_POINTS,
        statusCode: 'committed',
      },
      select: { id: true },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'committed',
        requestKey: 'b01-read-consistency-batch',
        requestHash: 'b01-read-consistency-batch-hash',
        totalCount: 2,
        preparedCount: 2,
        preparedAt: BATCH_TIME,
        preparedByUserId: adminUserId,
        committedAt: BATCH_TIME,
        committedByUserId: adminUserId,
      },
      select: { id: true },
    });
    const ledgerDate = new Date('2099-03-05T00:00:00.000Z');
    for (const entry of [
      {
        entryTypeCode: 'service_credit',
        serviceHoursDelta: LEDGER_SERVICE_HOURS,
        recognizedPointsDelta: '0',
        creditedPointsDelta: '0',
      },
      {
        entryTypeCode: 'contribution_credit',
        serviceHoursDelta: '0',
        recognizedPointsDelta: LEDGER_CREDITED_POINTS,
        creditedPointsDelta: LEDGER_CREDITED_POINTS,
      },
    ]) {
      await prisma.participationLedgerEntry.create({
        data: {
          postingBatchId: batch.id,
          entryKey: `b01-read-consistency:${entry.entryTypeCode}`,
          operationKey: `b01-read-consistency:${entry.entryTypeCode}:operation`,
          memberId,
          activityId,
          sessionId: session.id,
          participationIdentityId: identity.id,
          resultRevisionId: revision.id,
          ledgerDate,
          entryTypeCode: entry.entryTypeCode,
          serviceHoursDelta: entry.serviceHoursDelta,
          recognizedPointsDelta: entry.recognizedPointsDelta,
          creditedPointsDelta: entry.creditedPointsDelta,
          cappedOutPointsDelta: '0',
        },
      });
    }
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  function get(path: string, query: Record<string, string> = {}) {
    return request(httpServer(app)).get(path).query(query).set('Authorization', adminAuthHeader);
  }

  it('夹具自证:两个口径的服务时长**确实不相等**(否则本 spec 是假绿)', () => {
    // 这条不是装饰。若两侧数字相同,后面「四个读面相等」即使在某个读面漏接闸时也会通过 ——
    // 断言会退化成恒真。先把「反面样本在被测那一维上确实不同」钉死。
    expect(LEDGER_SERVICE_HOURS).not.toBe(APPROVED_SERVICE_HOURS);
  });

  it('开闸态:四个参与读面的服务时长逐个相等,且都取自已入账账本', async () => {
    const [memberSummary, activitySummary, reconciliation, overview] = await Promise.all([
      get(`/api/admin/v1/members/${memberId}/participation-summary`),
      get(`/api/admin/v1/activities/${activityId}/participation-summary`),
      get(`/api/admin/v1/activities/${activityId}/reconciliation`),
      get('/api/admin/v1/meta/participation-overview', {
        activityTypeCode: ACTIVITY_TYPE_CODE,
        dateFrom: '2099-03-01T00:00:00.000Z',
        dateTo: '2099-03-31T23:59:59.000Z',
      }),
    ]);
    for (const response of [memberSummary, activitySummary, reconciliation, overview]) {
      expect(response.status).toBe(200);
    }

    const months = overview.body.data.months as Array<{
      month: string;
      totalServiceHours: string;
    }>;
    // 先钉「取到了东西」—— 空数组会让下面的 find 拿到 undefined,断言静默变成 undefined 比较。
    expect(months).toHaveLength(1);
    expect(months[0].month).toBe(ACTIVITY_MONTH);

    const participants = reconciliation.body.data.registeredParticipants as Array<{
      memberId: string;
      totalServiceHours: string;
    }>;
    const row = participants.find((item) => item.memberId === memberId);
    expect(row).toBeDefined();

    // 🔴 DoD 4 的正主:同一个队员,四个读面,一个数字。
    const readFaces = {
      '队员参与汇总(admin)': memberSummary.body.data.totalServiceHours,
      逐活动参与汇总: activitySummary.body.data.totalServiceHours,
      '逐活动对账表(该队员行)': row?.totalServiceHours,
      月度参与概览: months[0].totalServiceHours,
    };
    expect(readFaces).toEqual({
      '队员参与汇总(admin)': LEDGER_SERVICE_HOURS,
      逐活动参与汇总: LEDGER_SERVICE_HOURS,
      '逐活动对账表(该队员行)': LEDGER_SERVICE_HOURS,
      月度参与概览: LEDGER_SERVICE_HOURS,
    });

    // 反面:一个读面都不许还在报旧真相。漏接闸的那一处会在这里落网。
    for (const [label, value] of Object.entries(readFaces)) {
      expect({ [label]: value }).not.toEqual({ [label]: APPROVED_SERVICE_HOURS });
    }
  });

  it('开闸态:贡献值同样取自已入账账本(credited 口径)', async () => {
    const activitySummary = await get(
      `/api/admin/v1/activities/${activityId}/participation-summary`,
    );
    expect(activitySummary.status).toBe(200);
    expect(activitySummary.body.data.totalContributionPoints).toBe(LEDGER_CREDITED_POINTS);
    expect(activitySummary.body.data.totalContributionPoints).not.toBe(
      APPROVED_CONTRIBUTION_POINTS,
    );
  });

  it('刻意不随闸切换的那一项:入队门槛贡献值恒按 approved 算(判据 C4 反向锁)', async () => {
    // 维护者已拍板:入队门槛与 computeCappedContribution 恒按 approved 算,不随本闸切换。
    // 这条把那个**刻意的不一致**也钉成行为断言 —— 免得后人看到上面几条「都切了」,
    // 顺手把入队门槛也统一过去(那会悄悄改掉入队资格的判定口径)。
    const summary = await get(`/api/admin/v1/members/${memberId}/participation-summary`);
    expect(summary.status).toBe(200);
    // 服务时长已切到账本,而同一个响应里的贡献值仍是 approved 口径 —— 两者刻意不同源。
    expect(summary.body.data.totalServiceHours).toBe(LEDGER_SERVICE_HOURS);
    expect(summary.body.data.contributionPoints).toBe(APPROVED_CONTRIBUTION_POINTS);
  });
});
