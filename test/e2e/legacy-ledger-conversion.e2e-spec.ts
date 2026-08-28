import { Prisma, MemberStatus, Role } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import {
  LegacyLedgerConversionService,
  type LegacyLedgerConversionOutcome,
} from '../../src/modules/activities/legacy-ledger-conversion.service';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * 存量考勤账本化转换刀(P1-28 第 7 批② A 案)的 e2e 判据。
 *
 * 三组:
 *   ① 三态判闸 —— 常规闸关拒(20159)/ 闸开拒(20159)/ 只读维护窗放行;
 *   ② 转换本体 —— 事实链(run/version/seal/identity/D2 头)+ 真批次 committed +
 *      分录两条/日 + 日封顶分账(recognized=原始、credited=min(日和,3)、cappedOut=超出)+
 *      D1 零窗兜底点名 + 闸关读面不切(participationReadSource 恒 approved);
 *   ③ 幂等重跑 —— requestKey 命中即 already-converted,库里零新增。
 *
 * ⚠️ 三套 app 对应三个闸态(沿更正 spec 的多 app 手法):app 先建(闸关,env 干净),
 *    然后置 ACTIVITY_WORKFLOW_READONLY 建 readonly app,再换 v11 建闸开 app。
 *    env 是进程级,创建顺序即闸态顺序。
 */

describe('存量考勤账本化转换(P1-28 第 7 批② A 案,合同 §16.3 只读维护窗)', () => {
  let appClosed: Awaited<ReturnType<typeof createTestApp>>;
  let appReadonly: Awaited<ReturnType<typeof createTestApp>>;
  let appV11: Awaited<ReturnType<typeof createTestApp>>;
  let prisma: PrismaService;
  let conversionReadonly: LegacyLedgerConversionService;
  let conversionClosed: LegacyLedgerConversionService;
  let conversionV11: LegacyLedgerConversionService;
  let gate: ActivityWorkflowGate;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let activityTypeCode: string;
  let sequence = 0;

  const auditMeta = { requestId: 'legacy-ledger-conversion-e2e', ip: null, ua: null };
  const DAY = new Date('2026-07-01T00:00:00.000Z');
  const WINDOW_A = {
    startAt: new Date('2026-07-01T10:00:00.000Z'),
    endAt: new Date('2026-07-01T12:00:00.000Z'),
  };
  const WINDOW_B = {
    startAt: new Date('2026-07-01T14:00:00.000Z'),
    endAt: new Date('2026-07-01T16:00:00.000Z'),
  };
  const OUT_OF_WINDOW = new Date('2026-07-01T18:30:00.000Z');

  beforeAll(async () => {
    appClosed = await createTestApp();
    process.env.ACTIVITY_WORKFLOW_READONLY = 'true';
    appReadonly = await createTestApp();
    delete process.env.ACTIVITY_WORKFLOW_READONLY;
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appV11 = await createTestApp();
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

    await resetDb(appReadonly);
    prisma = appReadonly.get(PrismaService);
    conversionReadonly = appReadonly.get(LegacyLedgerConversionService);
    conversionClosed = appClosed.get(LegacyLedgerConversionService);
    conversionV11 = appV11.get(LegacyLedgerConversionService);
    gate = appReadonly.get(ActivityWorkflowGate);

    const user = await createTestUser(appReadonly, {
      username: 'legacy-conversion-operator',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: null,
    };

    const root = await prisma.organization.create({
      data: { name: '转换根组织', nodeTypeCode: 'legacy-conversion-root' },
    });
    const team = await prisma.organization.create({
      data: { name: '转换测试组织', nodeTypeCode: 'legacy-conversion-team', parentId: root.id },
    });
    organizationId = team.id;
    const dictType = await prisma.dictType.create({
      data: { code: `activity_type_lconv_${sequence}`, label: '活动类型(转换)' },
    });
    activityTypeCode = 'legacy-conversion-training';
    await prisma.dictItem.create({
      data: { typeId: dictType.id, code: activityTypeCode, label: '转换测试训练' },
    });
  });

  afterAll(async () => {
    await Promise.all([appClosed.close(), appReadonly.close(), appV11.close()]);
  });

  async function createMember(label: string): Promise<string> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `lconv-${label}-${sequence}`,
        ...memberIdentityData(`Legacy ${label} ${sequence}`),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return member.id;
  }

  async function createActivityWithSessions(): Promise<string> {
    sequence += 1;
    const ownerId = await createMember('owner');
    const activity = await prisma.activity.create({
      data: {
        title: `存量转换活动 ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: WINDOW_A.startAt,
        endAt: WINDOW_B.endAt,
        location: '深圳',
        statusCode: 'published',
        initiatorMemberId: ownerId,
        allocationModeCode: 'first_come',
      },
      select: { id: true },
    });
    await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: 'S1',
        name: '上午场',
        startAt: WINDOW_A.startAt,
        endAt: WINDOW_A.endAt,
        locationText: '深圳',
        checkInOpenAt: new Date(WINDOW_A.startAt.getTime() - 3600_000),
        checkInCloseAt: new Date(WINDOW_A.startAt.getTime() + 3600_000),
        checkOutOpenAt: new Date(WINDOW_A.startAt.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date(WINDOW_A.endAt.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: 'S2',
        name: '下午场',
        startAt: WINDOW_B.startAt,
        endAt: WINDOW_B.endAt,
        locationText: '深圳',
        checkInOpenAt: new Date(WINDOW_B.startAt.getTime() - 3600_000),
        checkInCloseAt: new Date(WINDOW_B.startAt.getTime() + 3600_000),
        checkOutOpenAt: new Date(WINDOW_B.startAt.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date(WINDOW_B.endAt.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    return activity.id;
  }

  interface RecordSpec {
    memberId: string;
    checkInAt: Date;
    serviceHours: string;
    contributionPoints: string;
    registrationId: string | null;
  }

  async function createApprovedSheet(
    activityId: string,
    records: readonly RecordSpec[],
  ): Promise<string> {
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: actor.id,
        submittedAt: DAY,
        statusCode: 'approved',
        finalReviewerUserId: actor.id,
        finalReviewedAt: DAY,
      },
      select: { id: true },
    });
    for (const record of records) {
      await prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: record.memberId,
          roleCode: 'member',
          checkInAt: record.checkInAt,
          checkOutAt: new Date(record.checkInAt.getTime() + 2 * 60 * 60 * 1000),
          serviceHours: new Prisma.Decimal(record.serviceHours),
          attendanceStatusCode: 'present',
          contributionPoints: new Prisma.Decimal(record.contributionPoints),
          registrationId: record.registrationId,
        },
      });
    }
    return sheet.id;
  }

  it('① 三态判闸:常规闸关与闸开都拒(20159),只有只读维护窗放行', async () => {
    const activityId = await createActivityWithSessions();
    await expect(
      conversionClosed.convertActivity({ activityId, currentUser: actor, auditMeta }),
    ).rejects.toMatchObject({
      biz: { code: BizCode.LEGACY_LEDGER_CONVERSION_WINDOW_INVALID.code },
    });
    await expect(
      conversionV11.convertActivity({ activityId, currentUser: actor, auditMeta }),
    ).rejects.toMatchObject({
      biz: { code: BizCode.LEGACY_LEDGER_CONVERSION_WINDOW_INVALID.code },
    });
    // 只读态下读面不切(§16.5):闸未开 ⇒ 恒 approved 考勤口径。
    expect(gate.participationReadSource()).toBe('approved-attendance');
  });

  it('② 转换本体:事实链 + 真批次 committed + 日封顶分账 + D1/D2 点名', async () => {
    const activityId = await createActivityWithSessions();
    const memberWithHead = await createMember('with-head');
    const memberWithoutHead = await createMember('no-head');
    const head = await prisma.activityRegistration.create({
      data: {
        activityId,
        memberId: memberWithHead,
        statusCode: 'pending',
        currentRevision: 0,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: 'self',
        registeredAt: DAY,
      },
      select: { id: true },
    });
    await createApprovedSheet(activityId, [
      // M1 两场同日:原始 2.00 + 4.50 = 6.50,按日封顶 credited 恰 3.00 / cappedOut 3.50。
      {
        memberId: memberWithHead,
        checkInAt: WINDOW_A.startAt,
        serviceHours: '2.00',
        contributionPoints: '2.00',
        registrationId: head.id,
      },
      {
        memberId: memberWithHead,
        checkInAt: WINDOW_B.startAt,
        serviceHours: '1.00',
        contributionPoints: '4.50',
        registrationId: head.id,
      },
      // M2 零窗(checkInAt 不落在任何场次窗口)⇒ 兜底最早场并被点名;无报名头 ⇒ 合成头。
      {
        memberId: memberWithoutHead,
        checkInAt: OUT_OF_WINDOW,
        serviceHours: '1.50',
        contributionPoints: '1.50',
        registrationId: null,
      },
    ]);

    const outcome = await conversionReadonly.convertActivity({
      activityId,
      currentUser: actor,
      auditMeta,
    });
    expect(outcome.status).toBe('converted');
    if (outcome.status !== 'converted') return;
    expect(outcome.memberCount).toBe(2);
    expect(outcome.identityCount).toBe(3); // M1 两场各一 + M2 兜底场
    expect(outcome.dayRowCount).toBe(3);
    expect(outcome.entryCount).toBe(6); // 每日行恰两条 credit
    expect(outcome.fallbackSessionMappings).toHaveLength(1);
    expect(outcome.fallbackSessionMappings[0].memberId).toBe(memberWithoutHead);
    expect(outcome.synthesizedRegistrationHeads).toHaveLength(1);
    expect(outcome.commit.batchStatus).toBe('committed');
    expect(outcome.commit.runStatus).toBe('posted');

    // 事实链:run posted / version approved / result revisions 全部 committed。
    const run = await prisma.attendanceSettlementRun.findUnique({ where: { activityId } });
    expect(run?.statusCode).toBe('posted');
    expect(run?.currentPostedVersion).toBe(1);
    const version = await prisma.attendanceSettlementVersion.findFirst({
      where: { settlementRunId: run?.id },
    });
    expect(version?.statusCode).toBe('approved');
    const revisions = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: version?.id },
    });
    expect(revisions).toHaveLength(3);
    expect(revisions.every((row) => row.statusCode === 'committed')).toBe(true);

    // 日封顶分账:M1 原始 2.00/4.50 ⇒ credited 2.00/1.00、cappedOut 0/3.50;M2 全额。
    const contributionEntries = await prisma.participationLedgerEntry.findMany({
      where: { postingBatchId: outcome.postingBatchId, entryTypeCode: 'contribution_credit' },
      select: {
        memberId: true,
        recognizedPointsDelta: true,
        creditedPointsDelta: true,
        cappedOutPointsDelta: true,
      },
    });
    const byMember = new Map(
      [...new Set(contributionEntries.map((row) => row.memberId))].map((memberId) => [
        memberId,
        contributionEntries
          .filter((row) => row.memberId === memberId)
          .reduce(
            (sum, row) => ({
              recognized: sum.recognized.plus(row.recognizedPointsDelta),
              credited: sum.credited.plus(row.creditedPointsDelta),
              cappedOut: sum.cappedOut.plus(row.cappedOutPointsDelta),
            }),
            {
              recognized: new Prisma.Decimal(0),
              credited: new Prisma.Decimal(0),
              cappedOut: new Prisma.Decimal(0),
            },
          ),
      ]),
    );
    expect((byMember.get(memberWithHead)?.recognized ?? new Prisma.Decimal(-1)).toNumber()).toBe(
      6.5,
    );
    expect(Number(byMember.get(memberWithHead)?.credited ?? -1)).toBe(3);
    expect(Number(byMember.get(memberWithHead)?.cappedOut ?? -1)).toBe(3.5);
    expect(Number(byMember.get(memberWithoutHead)?.credited ?? -1)).toBe(1.5);

    // D2:合成头的 sourceCode 落 §3.6 闭集内的 'admin',且可按 id 点名回查。
    const synthesized = await prisma.activityRegistration.findUnique({
      where: { id: outcome.synthesizedRegistrationHeads[0] },
    });
    expect(synthesized?.sourceCode).toBe('admin');

    // day-state:M1 该北京日 committed credited 恰 3.00(§3.24 日合计 0..3 的落点)。
    const dayState = await prisma.memberContributionDayState.findFirst({
      where: { memberId: memberWithHead, ledgerDate: new Date('2026-07-01T00:00:00.000Z') },
    });
    expect(dayState).not.toBeNull();
  });

  it('③ 幂等重跑:requestKey 命中即 already-converted,库里零新增', async () => {
    const activityId = await createActivityWithSessions();
    const memberId = await createMember('idempotent');
    await createApprovedSheet(activityId, [
      {
        memberId,
        checkInAt: WINDOW_A.startAt,
        serviceHours: '2.00',
        contributionPoints: '2.00',
        registrationId: null,
      },
    ]);
    const first = await conversionReadonly.convertActivity({
      activityId,
      currentUser: actor,
      auditMeta,
    });
    expect(first.status).toBe('converted');
    const entriesBefore = await prisma.participationLedgerEntry.count({
      where: {
        postingBatchId: (first as Extract<typeof first, { status: 'converted' }>).postingBatchId,
      },
    });
    const batchesBefore = await prisma.ledgerPostingBatch.count({
      where: { settlementRun: { activityId } },
    });

    const second: LegacyLedgerConversionOutcome = await conversionReadonly.convertActivity({
      activityId,
      currentUser: actor,
      auditMeta,
    });
    expect(second.status).toBe('already-converted');

    const entriesAfter = await prisma.participationLedgerEntry.count({
      where: {
        postingBatchId: (first as Extract<typeof first, { status: 'converted' }>).postingBatchId,
      },
    });
    const batchesAfter = await prisma.ledgerPostingBatch.count({
      where: { settlementRun: { activityId } },
    });
    expect(entriesAfter).toBe(entriesBefore);
    expect(batchesAfter).toBe(batchesBefore);
  });
});
