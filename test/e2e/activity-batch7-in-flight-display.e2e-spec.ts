import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 第 7 批第 ②-a 刀:统计读面加「在途」显示(不动任何取数)=====
//
// ## 「在途」的定义(直查法),以及为什么不用差值法
//
// **在途 = 分录所属批次停在 `preparing` / `ready` 的那部分**(已终审、等入账)。
//
// 另一个候选是差值法「现有总数 − 已生效」。它被否掉有两条硬理由,本 spec 各有用例坐实:
//   1. **会算出负数**:冲正已入账、而重记那笔还在途时,已生效可以**大于**考勤口径的总数
//      ⇒ 差值为负。「在途 -2 小时」没法向队员解释。
//   2. **它减的是两张表**:四个数字来自 approved 考勤记录(北京日封顶),账本来自分录 delta 求和。
//      两者本就可能有漂移;差值法会把漂移**当成在途报出来**,比不显示更糟。
//
// 直查法则是结构性互斥:一条分录只有一个 `postingBatchId`,一个批次只有一个 `statusCode`。
//
// ## 🔴 实测结论:「已生效 + 在途 = 总数」**不成立**
//
// 见「不变量 1b」用例里的实测数字。两条独立原因:
//   · **阶段缺口** —— 批次要到终审才存在,「考勤已审批但结算没走到终审」那一段两个小计都不计;
//   · **口径不同** —— 四个数字按考勤记录算,两个小计按账本分录算。
// 所以本刀**不合并数字**,三个口径并排摆着,各自标签清楚。
//
// ## 夹具为什么直插分录而不走真实写链
//
// 沿 `activity-batch2-9b-ledger-read.e2e-spec.ts` 的同一理由:本刀要验的是**读面**在
// 三种批次状态下的取数,若先走 prepare/commit 服务,`preparing`/`ready` 形态很难稳定落到读面,
// 反而会把「读面算对了」测成「夹具没造出来」。冲正分录更是只有直插才造得稳。

const ATTENDANCE_CHECK_IN = new Date('2026-07-10T02:00:00.000Z');
const ATTENDANCE_CHECK_OUT = new Date('2026-07-10T06:00:00.000Z');
const BATCH_TIME = new Date('2026-07-10T09:00:00.000Z');

/** 本人考勤口径的四个数字(approved Sheet);故意与两条账本轴都不相等。 */
const APPROVED_SERVICE_HOURS = '4';
const APPROVED_CONTRIBUTION_POINTS = '2';

/**
 * 结构判据只看**可执行的代码**,先剥注释 —— 否则本文件的说明文字里出现
 * `includeUncommitted` 这种词就会把自己判红(实测踩过:第一次跑就红在注释上)。
 * 沿 `activity-batch2-9b-ledger-read.e2e-spec.ts` 的同名做法。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

interface LedgerEntrySpec {
  entryTypeCode: 'service_credit' | 'contribution_credit' | 'service_reversal' | 'contribution_reversal';
  serviceHoursDelta: string;
  recognizedPointsDelta: string;
  creditedPointsDelta: string;
  cappedOutPointsDelta: string;
  /** reversal 必带(DB CHECK `participation_ledger_entry_reversal_shape_check`)。 */
  reversesEntryId?: string;
  /** 同批次内换一个 result revision,避开 (batch, revision, date, type) 唯一键。 */
  revisionSlot?: 'primary' | 'secondary';
}

interface LedgerFixture {
  activityId: string;
  batchId: string;
  /** entryKey → entry id;冲正用例要拿 id 回指。 */
  entryIds: Record<string, string>;
  entryKeys: string[];
}

describe('第 7 批第 ②-a 刀 —— 统计读面「已生效 / 在途」显示', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let adminUserId: string;
  let adminAuthHeader: string;

  /** 主角:有 approved 考勤 + 已生效账本(含冲正)+ 在途账本。 */
  let focusMemberId: string;
  let focusAuthHeader: string;
  /** 对照:什么账本都没有,用来钉「空集返 0 而不是 null」。 */
  let emptyMemberId: string;
  /** 守恒探针专用:只有一批 preparing,用例里把它转正,看数额是否恰好搬家。 */
  let probeMemberId: string;
  let probeBatchId: string;

  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const organization = await prisma.organization.create({
      data: { name: '第 7 批②-a 在途显示组织', nodeTypeCode: 'batch7-slice2a-team' },
      select: { id: true },
    });
    organizationId = organization.id;

    const admin = await createTestUser(app, {
      username: 'batch7-slice2a-admin',
      role: Role.SUPER_ADMIN,
    });
    adminUserId = admin.id;
    adminAuthHeader = (await loginAs(app, admin.username)).authHeader;

    const focusUser = await createTestUser(app, {
      username: 'batch7-slice2a-focus',
      role: Role.USER,
    });
    const focusMember = await prisma.member.create({
      data: {
        memberNo: 'batch7-slice2a-focus-no',
        displayName: '第 7 批②-a 主角队员',
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    focusMemberId = focusMember.id;
    await prisma.user.update({
      where: { id: focusUser.id },
      data: { memberId: focusMember.id },
    });
    focusAuthHeader = (await loginAs(app, focusUser.username)).authHeader;

    const emptyMember = await prisma.member.create({
      data: {
        memberNo: 'batch7-slice2a-empty-no',
        displayName: '第 7 批②-a 零账本队员',
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    emptyMemberId = emptyMember.id;

    const probeMember = await prisma.member.create({
      data: {
        memberNo: 'batch7-slice2a-probe-no',
        displayName: '第 7 批②-a 守恒探针队员',
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    probeMemberId = probeMember.id;

    // ---- ① approved 考勤:四个数字的唯一来源,本刀一个字没动 ----
    const attendanceActivity = await prisma.activity.create({
      data: {
        title: '第 7 批②-a 考勤活动',
        activityTypeCode: 'batch7-slice2a-attendance',
        organizationId,
        startAt: ATTENDANCE_CHECK_IN,
        endAt: ATTENDANCE_CHECK_OUT,
        location: '深圳',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    const approvedSheet = await prisma.attendanceSheet.create({
      data: {
        activityId: attendanceActivity.id,
        submitterUserId: adminUserId,
        statusCode: 'approved',
      },
      select: { id: true },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: approvedSheet.id,
        memberId: focusMemberId,
        roleCode: 'member',
        checkInAt: ATTENDANCE_CHECK_IN,
        checkOutAt: ATTENDANCE_CHECK_OUT,
        serviceHours: APPROVED_SERVICE_HOURS,
        attendanceStatusCode: 'present',
        contributionPoints: APPROVED_CONTRIBUTION_POINTS,
      },
    });

    // ---- ② 已生效:一笔原始入账,再一笔「全额冲正 + 重记」的更正批次 ----
    const committedOriginal = await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2026-07-10',
      entries: [
        creditPair({ serviceHours: '2', points: '1' }),
      ].flat(),
    });
    await createLedgerFixture({
      batchStatus: 'committed',
      ledgerDate: '2026-07-10',
      entries: [
        {
          entryTypeCode: 'service_reversal',
          serviceHoursDelta: '-2',
          recognizedPointsDelta: '0',
          creditedPointsDelta: '0',
          cappedOutPointsDelta: '0',
          reversesEntryId: committedOriginal.entryIds['service_credit'],
        },
        {
          entryTypeCode: 'contribution_reversal',
          serviceHoursDelta: '0',
          recognizedPointsDelta: '-1',
          creditedPointsDelta: '-1',
          cappedOutPointsDelta: '0',
          reversesEntryId: committedOriginal.entryIds['contribution_credit'],
        },
        // 更正后的重记落在**另一个** result revision 上(同批次唯一键才不撞)。
        ...creditPair({ serviceHours: '1.5', points: '0.5', revisionSlot: 'secondary' }),
      ],
    });

    // ---- ③ 在途:preparing 与 ready 各一批 ----
    await createLedgerFixture({
      batchStatus: 'preparing',
      ledgerDate: '2026-07-11',
      entries: creditPair({ serviceHours: '3', points: '1' }),
    });
    await createLedgerFixture({
      batchStatus: 'ready',
      ledgerDate: '2026-07-12',
      entries: creditPair({ serviceHours: '0.5', points: '0.25' }),
    });

    // ---- ④ 守恒探针:独占队员,只有一批 preparing ----
    probeBatchId = (
      await createLedgerFixture({
        batchStatus: 'preparing',
        ledgerDate: '2026-07-13',
        entries: creditPair({ serviceHours: '1.25', points: '0.75' }),
        memberId: probeMemberId,
      })
    ).batchId;
  });

  afterAll(async () => {
    await app.close();
  });

  function creditPair(options: {
    serviceHours: string;
    points: string;
    revisionSlot?: 'primary' | 'secondary';
  }): LedgerEntrySpec[] {
    return [
      {
        entryTypeCode: 'service_credit',
        serviceHoursDelta: options.serviceHours,
        recognizedPointsDelta: '0',
        creditedPointsDelta: '0',
        cappedOutPointsDelta: '0',
        ...(options.revisionSlot ? { revisionSlot: options.revisionSlot } : {}),
      },
      {
        entryTypeCode: 'contribution_credit',
        serviceHoursDelta: '0',
        recognizedPointsDelta: options.points,
        creditedPointsDelta: options.points,
        cappedOutPointsDelta: '0',
        ...(options.revisionSlot ? { revisionSlot: options.revisionSlot } : {}),
      },
    ];
  }

  async function createLedgerFixture(options: {
    batchStatus: 'preparing' | 'ready' | 'committed';
    ledgerDate: string;
    entries: LedgerEntrySpec[];
    /** 缺省落在主角身上;守恒探针要一个不受其它用例干扰的独占队员。 */
    memberId?: string;
  }): Promise<LedgerFixture> {
    sequence += 1;
    const tag = `batch7-slice2a-${sequence}`;
    const ledgerMemberId = options.memberId ?? focusMemberId;
    const sessionStart = new Date(`${options.ledgerDate}T01:00:00.000Z`);
    const sessionEnd = new Date(`${options.ledgerDate}T05:00:00.000Z`);

    const activity = await prisma.activity.create({
      data: {
        title: `第 7 批②-a 账本活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId,
        startAt: sessionStart,
        endAt: sessionEnd,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    // 两套 session / identity / result revision:`ParticipantSettlementResultRevision`
    // 唯一键是 (settlementVersionId, participationIdentityId) —— 同一 identity 上开不出
    // 第二个 revision,所以「冲正 + 重记」的重记那笔必须挂在**另一个 identity** 上。
    const [session, secondarySession] = await Promise.all(
      (['primary', 'secondary'] as const).map((slot) =>
        prisma.activitySession.create({
          data: {
            activityId: activity.id,
            code: `${tag}-session-${slot}`,
            name: `${tag} ${slot} 场次`,
            startAt: sessionStart,
            endAt: sessionEnd,
            locationText: '深圳',
            checkInOpenAt: new Date(sessionStart.getTime() - 3600_000),
            checkInCloseAt: new Date(sessionStart.getTime() + 3600_000),
            checkOutOpenAt: new Date(sessionStart.getTime() + 2 * 3600_000),
            checkOutCloseAt: new Date(sessionEnd.getTime() + 3600_000),
            locationRequired: false,
            locationPolicySourceCode: 'session',
            statusCode: 'scheduled',
          },
          select: { id: true },
        }),
      ),
    );
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: sessionEnd,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: `${tag}-seal`,
        statusCode: 'active',
        sealedByUserId: adminUserId,
        sealedAt: sessionEnd,
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
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: adminUserId,
        submittedAt: sessionEnd,
        statusCode: 'approved',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: ledgerMemberId, statusCode: 'approved' },
      select: { id: true },
    });
    const [identity, secondaryIdentity] = await Promise.all(
      [session, secondarySession].map((target) =>
        prisma.activityParticipationIdentity.create({
          data: {
            activityId: activity.id,
            sessionId: target.id,
            registrationId: registration.id,
            memberId: ledgerMemberId,
            currentStatusCode: 'pass',
            populationIncluded: true,
          },
          select: { id: true },
        }),
      ),
    );
    const [primaryRevision, secondaryRevision] = await Promise.all(
      [identity, secondaryIdentity].map((target) =>
        prisma.participantSettlementResultRevision.create({
          data: {
            settlementVersionId: version.id,
            participationIdentityId: target.id,
            revision: 1,
            resultCode: 'present',
            recognizedServiceHours: 2,
            recognizedContributionPoints: 1,
            calculatedServiceHours: 2,
            calculatedContributionPoints: 1,
            statusCode: options.batchStatus === 'committed' ? 'committed' : 'draft',
          },
          select: { id: true },
        }),
      ),
    );
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: options.batchStatus,
        requestKey: `${tag}-batch`,
        requestHash: `${tag}-batch-hash`,
        totalCount: options.entries.length,
        preparedCount: options.batchStatus === 'preparing' ? 1 : options.entries.length,
        ...(options.batchStatus === 'preparing'
          ? {}
          : { preparedAt: BATCH_TIME, preparedByUserId: adminUserId }),
        ...(options.batchStatus === 'committed'
          ? { committedAt: BATCH_TIME, committedByUserId: adminUserId }
          : {}),
      },
      select: { id: true },
    });

    const ledgerDate = new Date(`${options.ledgerDate}T00:00:00.000Z`);
    const entryIds: Record<string, string> = {};
    const entryKeys: string[] = [];
    // 顺序插入(不是 Promise.all):冲正要回指同批次先插的那条时顺序才确定。
    for (const spec of options.entries) {
      const entryKey = `${tag}:${spec.revisionSlot ?? 'primary'}:${spec.entryTypeCode}`;
      const created = await prisma.participationLedgerEntry.create({
        data: {
          postingBatchId: batch.id,
          entryKey,
          operationKey: `${entryKey}:operation`,
          memberId: ledgerMemberId,
          activityId: activity.id,
          // session / identity / revision 三者必须取同一槽位,否则分录会指向别人的场次。
          sessionId: spec.revisionSlot === 'secondary' ? secondarySession.id : session.id,
          participationIdentityId:
            spec.revisionSlot === 'secondary' ? secondaryIdentity.id : identity.id,
          resultRevisionId:
            spec.revisionSlot === 'secondary' ? secondaryRevision.id : primaryRevision.id,
          ledgerDate,
          entryTypeCode: spec.entryTypeCode,
          serviceHoursDelta: spec.serviceHoursDelta,
          recognizedPointsDelta: spec.recognizedPointsDelta,
          creditedPointsDelta: spec.creditedPointsDelta,
          cappedOutPointsDelta: spec.cappedOutPointsDelta,
          ...(spec.reversesEntryId ? { reversesEntryId: spec.reversesEntryId } : {}),
        },
        select: { id: true, entryKey: true },
      });
      entryIds[spec.entryTypeCode] = created.id;
      entryKeys.push(created.entryKey);
    }

    return { activityId: activity.id, batchId: batch.id, entryIds, entryKeys };
  }

  async function entryKeysByBatchStatus(statuses: string[]): Promise<string[]> {
    const rows = await prisma.participationLedgerEntry.findMany({
      where: { memberId: focusMemberId, postingBatch: { statusCode: { in: statuses } } },
      select: { entryKey: true },
    });
    return rows.map((row) => row.entryKey).sort();
  }

  function getAdminSummary(memberId: string): request.Test {
    return request(httpServer(app))
      .get(`/api/admin/v1/members/${memberId}/participation-summary`)
      .set('Authorization', adminAuthHeader);
  }

  function getAdminContribution(memberId: string): request.Test {
    return request(httpServer(app))
      .get(`/api/admin/v1/members/${memberId}/contribution-summary`)
      .set('Authorization', adminAuthHeader);
  }

  function getAppSummary(): request.Test {
    return request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', focusAuthHeader);
  }

  // ===== 不变量 1a:两个集合互不相交(结构性),且两边都非空 =====
  it('不变量 1a:committed 与 in-flight 是两个互不相交的分录集合,且两边都非空', async () => {
    const committedKeys = await entryKeysByBatchStatus(['committed']);
    const inFlightKeys = await entryKeysByBatchStatus(['preparing', 'ready']);

    // 🔴 先钉两边非空 —— 否则下面的「交集为空」在空集上恒真,是一条静默的空绿。
    expect(committedKeys.length).toBeGreaterThan(0);
    expect(inFlightKeys.length).toBeGreaterThan(0);

    // 比集合,不比计数。
    const overlap = committedKeys.filter((key) => inFlightKeys.includes(key));
    expect({ 同时落进两个小计的分录: overlap }).toEqual({ 同时落进两个小计的分录: [] });

    // 反向:两个集合合起来必须就是该队员的全部分录(没有第三类批次状态被静默吞掉)。
    const allKeys = (
      await prisma.participationLedgerEntry.findMany({
        where: { memberId: focusMemberId },
        select: { entryKey: true },
      })
    )
      .map((row) => row.entryKey)
      .sort();
    expect([...committedKeys, ...inFlightKeys].sort()).toEqual(allKeys);
  });

  // 上面那条只证明**数据**可以被分成两堆;下面这条才证明**读面**真的按那条界线取数。
  // 判据是守恒:把一批 preparing 转成 committed,数额必须**恰好搬家** ——
  // 既不能两边都算(重复计数),也不能两边都不算(凭空蒸发)。
  it('不变量 1a(守恒):批次转正时,数额恰好从在途搬进已生效,不重复计数也不蒸发', async () => {
    const before = (await getAdminSummary(probeMemberId)).body.data.ledgerTotals;
    // 正对照:搬家前在途非零、已生效为零,否则下面的相等断言是 0 == 0 的空绿。
    expect(before).toEqual({
      committedServiceHours: '0',
      committedContributionPoints: '0',
      inFlightServiceHours: '1.25',
      inFlightContributionPoints: '0.75',
    });

    await prisma.ledgerPostingBatch.update({
      where: { id: probeBatchId },
      data: { statusCode: 'committed', committedAt: BATCH_TIME, committedByUserId: adminUserId },
    });

    const after = (await getAdminSummary(probeMemberId)).body.data.ledgerTotals;
    expect(after).toEqual({
      committedServiceHours: before.inFlightServiceHours,
      committedContributionPoints: before.inFlightContributionPoints,
      // 🔴 搬走之后在途必须归零 —— 若在途口径把 committed 也算进去,这里会留着原值。
      inFlightServiceHours: '0',
      inFlightContributionPoints: '0',
    });

    // 复原,避免污染同 suite 其它用例(本 spec 其余用例都不看探针队员,但别留脏数据)。
    await prisma.ledgerPostingBatch.update({
      where: { id: probeBatchId },
      data: { statusCode: 'preparing', committedAt: null, committedByUserId: null },
    });
  });

  // ===== 不变量 1b:带冲正分录时,三个口径的关系是什么(实测写进断言)=====
  it('不变量 1b:有冲正分录时「已生效 + 在途 = 总数」不成立 —— 实测三个口径逐字钉住', async () => {
    const response = await getAdminSummary(focusMemberId);
    expect(response.status).toBe(200);
    const data = response.body.data;

    // 冲正确实存在(否则本条只是又一次普通用例)。
    await expect(
      prisma.participationLedgerEntry.count({
        where: {
          memberId: focusMemberId,
          entryTypeCode: { in: ['service_reversal', 'contribution_reversal'] },
          reversesEntryId: { not: null },
        },
      }),
    ).resolves.toBe(2);

    // 已生效 = 原始 (2 / 1) + 冲正 (-2 / -1) + 重记 (1.5 / 0.5) = 1.5 / 0.5
    // 在途   = preparing (3 / 1) + ready (0.5 / 0.25)                = 3.5 / 1.25
    // 四个数字(approved 考勤口径,本刀未动)                          = 4   / 2
    expect(data.ledgerTotals).toEqual({
      committedServiceHours: '1.5',
      committedContributionPoints: '0.5',
      inFlightServiceHours: '3.5',
      inFlightContributionPoints: '1.25',
    });
    // ⚠️ 这里**刻意不**断言四个数字的具体值 —— 那是不变量 2 的职责。
    //    两处都写就会让「改取数」这个变异同时红两条,红集重叠、诊断力下降。

    // 🔴 实测结论:等式**两条轴都不成立**,所以本刀不合并数字。
    //    服务时长:1.5 + 3.5 = 5   ≠ 4
    //    贡献值  :0.5 + 1.25 = 1.75 ≠ 2
    const sum = (left: string, right: string): string =>
      (Math.round(Number(left) * 100) + Math.round(Number(right) * 100)) / 100 + '';
    expect(sum(data.ledgerTotals.committedServiceHours, data.ledgerTotals.inFlightServiceHours)).toBe(
      '5',
    );
    expect(sum(data.ledgerTotals.committedServiceHours, data.ledgerTotals.inFlightServiceHours)).not.toBe(
      data.totalServiceHours,
    );
    expect(
      sum(
        data.ledgerTotals.committedContributionPoints,
        data.ledgerTotals.inFlightContributionPoints,
      ),
    ).toBe('1.75');
    expect(
      sum(
        data.ledgerTotals.committedContributionPoints,
        data.ledgerTotals.inFlightContributionPoints,
      ),
    ).not.toBe(data.contributionPoints);
  });

  // ===== 不变量 2:既有四个数字逐字不变 =====
  it('不变量 2:既有四个数字整包不变,且不随账本状态漂移(改成 committed 取数当场红)', async () => {
    const [adminResponse, appResponse] = await Promise.all([
      getAdminSummary(focusMemberId),
      getAppSummary(),
    ]);
    expect(adminResponse.status).toBe(200);
    expect(appResponse.status).toBe(200);

    // 整包快照:四个字段的**名字与值**一并钉住。
    // 这些值只能由 approved 考勤推出(4 / 1 活动 / 1 条 / 2 分);账本三条轴
    // (已生效 1.5 / 0.5、在途 3.5 / 1.25)与它们**逐个都不相等**
    // ⇒ 谁把取数换成 committed 或 committed+inFlight,本条必红。
    expect({
      totalServiceHours: adminResponse.body.data.totalServiceHours,
      activityCount: adminResponse.body.data.activityCount,
      recordCount: adminResponse.body.data.recordCount,
      contributionPoints: adminResponse.body.data.contributionPoints,
    }).toEqual({
      totalServiceHours: '4',
      activityCount: 1,
      recordCount: 1,
      contributionPoints: '2',
    });
    expect({
      totalServiceHours: appResponse.body.data.totalServiceHours,
      activityCount: appResponse.body.data.activityCount,
      recordCount: appResponse.body.data.recordCount,
      contributionPoints: appResponse.body.data.contributionPoints,
    }).toEqual({
      totalServiceHours: '4',
      activityCount: 1,
      recordCount: 1,
      contributionPoints: '2',
    });

    // contribution-summary 的那一个数字同样未动。
    const contribution = await getAdminContribution(focusMemberId);
    expect(contribution.status).toBe(200);
    expect(contribution.body.data.contributionPoints).toBe('2');
  });

  // ===== 不变量 3:既有 committed 过滤一处不少,且没有 bypass 开关 =====
  it('不变量 3:账本读入口的 committed 过滤一处不少,且没有 includeUncommitted 之类的开关', () => {
    const source = stripComments(
      readFileSync(
        resolve(process.cwd(), 'src/modules/activities/ledger-query.service.ts'),
        'utf8',
      ),
    );

    // 🔴 实测基线是 **7 处**(goal 前提表写的「三处」与代码不符,已在 PR 说明订正):
    //    list×2 + 两条分页读面的 rows/count ×4 + sumCommittedByDayForMember ×1。
    //    放宽任意一处(改成 IN (...) 或删掉)本条当场红。
    const committedFilters = source.match(/AND b\."statusCode" = 'committed'/g) ?? [];
    expect({ committed过滤处数: committedFilters.length }).toEqual({ committed过滤处数: 7 });

    // 在途那条**新**方法只有一处,且状态是写死的字面量,不是入参。
    const inFlightFilters = source.match(/AND b\."statusCode" IN \('preparing', 'ready'\)/g) ?? [];
    expect({ 在途过滤处数: inFlightFilters.length }).toEqual({ 在途过滤处数: 1 });

    // 没有任何形式的「要不要过滤」开关。
    for (const forbidden of [
      'includeUncommitted',
      'includeInFlight',
      'includeAllStatuses',
      'skipCommittedFilter',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // 也不允许把批次状态做成参数(那等于把开关换个名字)。
    expect(source).not.toMatch(/statusCode:\s*(readonly\s+)?string(\[\])?/);
    expect(source).not.toMatch(/batchStatus(es)?\s*[?:]/);
  });

  it('不变量 3b:在途分录不从任何账本 items 读面漏出(§3.22 分录级不可见性一寸未让)', async () => {
    const inFlightKeys = await entryKeysByBatchStatus(['preparing', 'ready']);
    expect(inFlightKeys.length).toBeGreaterThan(0);

    const [appLedger, adminMemberLedger] = await Promise.all([
      request(httpServer(app))
        .get('/api/app/v1/my/participation-ledger')
        .query({ page: 1, pageSize: 50 })
        .set('Authorization', focusAuthHeader),
      request(httpServer(app))
        .get(`/api/admin/v1/members/${focusMemberId}/participation-ledger`)
        .query({ page: 1, pageSize: 50 })
        .set('Authorization', adminAuthHeader),
    ]);

    for (const response of [appLedger, adminMemberLedger]) {
      expect(response.status).toBe(200);
      const visibleKeys: string[] = response.body.data.items.map(
        (item: { entryKey: string }) => item.entryKey,
      );
      // 正对照:committed 的确看得见(否则「看不见在途」可能只是整个读面挂了)。
      expect(visibleKeys.length).toBeGreaterThan(0);
      expect(visibleKeys.filter((key) => inFlightKeys.includes(key))).toEqual([]);
    }
  });

  // ===== 不变量 4:空集返明确零值 =====
  it('不变量 4:无账本数据时四个值恒为 "0" —— 不是 null、不是缺字段', async () => {
    const response = await getAdminSummary(emptyMemberId);
    expect(response.status).toBe(200);

    // 前提:这个队员的确一条分录都没有(否则本条测的是别的东西)。
    await expect(
      prisma.participationLedgerEntry.count({ where: { memberId: emptyMemberId } }),
    ).resolves.toBe(0);

    const totals = response.body.data.ledgerTotals;
    // 字段必须**存在**(缺字段时 toEqual 对 undefined 会通过 —— 所以先查键清单)。
    expect(Object.keys(totals).sort()).toEqual([
      'committedContributionPoints',
      'committedServiceHours',
      'inFlightContributionPoints',
      'inFlightServiceHours',
    ]);
    expect(totals).toEqual({
      committedServiceHours: '0',
      committedContributionPoints: '0',
      inFlightServiceHours: '0',
      inFlightContributionPoints: '0',
    });
    // 逐个钉「是字符串 '0'」而不是 0 / null / ''。
    for (const value of Object.values(totals)) {
      expect(typeof value).toBe('string');
      expect(value).toBe('0');
    }

    const contribution = await getAdminContribution(emptyMemberId);
    expect(contribution.status).toBe(200);
    expect(contribution.body.data.ledgerTotals).toEqual(totals);
  });

  // ===== 不变量 5:三条读面口径一致(正对照)=====
  it('不变量 5:同一个人的「已生效 / 在途」在 App 面与两条 Admin 面逐字相同', async () => {
    const [appResponse, adminSummary, adminContribution] = await Promise.all([
      getAppSummary(),
      getAdminSummary(focusMemberId),
      getAdminContribution(focusMemberId),
    ]);
    for (const response of [appResponse, adminSummary, adminContribution]) {
      expect(response.status).toBe(200);
    }

    const appTotals = appResponse.body.data.ledgerTotals;
    // 🔴 正对照:先钉这四个数**不是全零**,否则三处 `{0,0,0,0}` 相等是空绿。
    //    这里**刻意只查非零、不查具体值** —— 具体值归不变量 1b。本条只守「三面一致」,
    //    这样「改了在途口径」只红 1b,「某一面用了另一套算法」只红本条,红集不重叠。
    expect(Object.values(appTotals).every((value) => typeof value === 'string')).toBe(true);
    expect(Object.values(appTotals).some((value) => value !== '0')).toBe(true);

    // 三条读面整包相等 —— 任一端改用另一套算法当场红。
    expect(adminSummary.body.data.ledgerTotals).toEqual(appTotals);
    expect(adminContribution.body.data.ledgerTotals).toEqual(appTotals);

    // App DTO 仍不泄露 memberId(D-5 / D-6 的 self-scope 口径未被本刀撬动)。
    expect(appResponse.body.data).not.toHaveProperty('memberId');
  });
});
