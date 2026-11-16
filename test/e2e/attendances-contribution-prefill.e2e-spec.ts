import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { ContributionCalculator } from '../../src/modules/attendances/contribution-calculator';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Preserve the legacy-regime rule characterization through the native draft
// generator, which consumes the same ContributionCalculator. Input hours come
// from real punch facts; assertions inspect persisted native result revisions.
// This does not claim policy_v1 evaluation or final daily-cap posting coverage.
// No retired provider, Sheet writer or retired HTTP DTO is reintroduced.
const START = new Date('2020-07-01T00:00:00Z');
const META = { requestId: 'native-contribution-prefill', ip: null, ua: null };
const ZERO_BLOCKER = 'contribution_points_zero_no_effective_rule';
const BASE_RULE = {
  durationThreshold: 4,
  pointsBelow: 0.5,
  pointsAbove: 1 as number | null,
  dailyCap: 5 as number | null,
};
interface Rule {
  durationThreshold: number | null;
  pointsBelow: number;
  pointsAbove: number | null;
  dailyCap: number | null;
}
interface Fixture {
  activityId: string;
  activityTypeCode: string;
  identityId: string;
  hours: number;
  roleCode: string;
}

describe('Native settlement legacy-regime contribution prefill (characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: SettlementDraftService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    drafts = app.get(SettlementDraftService);
    const user = await createTestUser(app, { username: 'native-prefill', role: Role.SUPER_ADMIN });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    organizationId = (
      await prisma.organization.create({
        data: { name: 'Native prefill', nodeTypeCode: 'prefill' },
      })
    ).id;
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function fixture(hours: number, roleCode = 'member'): Promise<Fixture> {
    const tag = `native-prefill-${++sequence}`;
    const end = new Date(START.getTime() + hours * 3_600_000);
    const activity = await prisma.activity.create({
      data: {
        title: tag,
        activityTypeCode: tag,
        organizationId,
        statusCode: 'published',
        startAt: START,
        endAt: end,
        location: 'prefill',
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: tag,
        name: tag,
        startAt: START,
        endAt: end,
        locationText: 'prefill',
        statusCode: 'scheduled',
        locationRequired: false,
        locationPolicySourceCode: 'session',
        checkInOpenAt: new Date(START.getTime() - 3_600_000),
        checkInCloseAt: new Date(START.getTime() + 3_600_000),
        checkOutOpenAt: new Date(end.getTime() - 3_600_000),
        checkOutCloseAt: new Date(end.getTime() + 3_600_000),
      },
    });
    const member = await prisma.member.create({
      data: { memberNo: tag, ...memberIdentityData(tag), gradeCode: 'level-2' },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
    });
    const position =
      roleCode === 'member'
        ? null
        : await prisma.activitySessionPosition.create({
            data: {
              activityId: activity.id,
              sessionId: session.id,
              code: tag,
              name: tag,
              attendanceRoleCode: roleCode,
            },
          });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        memberId: member.id,
        registrationId: registration.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
        currentPositionId: position?.id ?? null,
      },
    });
    // Sealed-input fixture, as in activity-settlement-draft.e2e-spec.ts:
    // generation, rather than a fabricated result row, projects the events.
    await prisma.attendancePunchEvent.createMany({
      data: [
        { eventTypeCode: 'check_in', occurredAt: START },
        { eventTypeCode: 'check_out', occurredAt: end },
      ].map((event) => ({
        ...event,
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId: member.id,
        sourceCode: 'staff_scan',
        receivedAt: event.occurredAt,
        operatorUserId: actor.id,
        eventKey: `${tag}:${event.eventTypeCode}`,
        requestHash: `${tag}:${event.eventTypeCode}`,
        evidenceRevision: 0,
      })),
    });
    await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date(end.getTime() + 3_600_000),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: tag,
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: new Date(end.getTime() + 7_200_000),
      },
    });
    return {
      activityId: activity.id,
      activityTypeCode: tag,
      identityId: identity.id,
      hours,
      roleCode,
    };
  }

  function createRule(input: Fixture, rule: Rule = BASE_RULE, roleCode = input.roleCode) {
    return prisma.contributionRule.create({
      data: {
        activityTypeCode: input.activityTypeCode,
        attendanceRoleCode: roleCode,
        status: 'ACTIVE',
        ...rule,
      },
    });
  }

  async function expectGenerated(input: Fixture, points: number) {
    const result = await drafts.generate(input.activityId, actor, META);
    const blockers = points === 0 ? [ZERO_BLOCKER] : [];
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      participationIdentityId: input.identityId,
      resultCode: 'present',
      calculatedServiceHours: input.hours,
      calculatedContributionPoints: points,
      segmentCount: 1,
      blockers,
    });
    expect(result.blockedItemCount).toBe(points === 0 ? 1 : 0);
    const rows = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: result.settlementVersionId },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].calculatedServiceHours)).toBe(input.hours);
    expect(Number(rows[0].calculatedContributionPoints)).toBe(points);
    expect(Number(rows[0].recognizedContributionPoints)).toBe(points);
    expect(rows[0].exceptionFlagsJson).toEqual(points === 0 ? { blockers } : null);
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: input.activityId } })).statusCode,
    ).toBe('published');
    expect(await prisma.attendanceSheet.count()).toBe(0);
    expect(await prisma.attendanceRecord.count()).toBe(0);
    expect(await prisma.participationLedgerEntry.count()).toBe(0);
  }

  it('no matching rule gives zero and an explicit blocker, never silent formal credit', async () => {
    await expectGenerated(await fixture(4), 0);
  });

  it.each([
    {
      label: 'NULL threshold ignores the upper band',
      hours: 6,
      rule: { ...BASE_RULE, durationThreshold: null, pointsAbove: 9 },
      expected: 0.5,
    },
    { label: 'below threshold uses the lower band', hours: 3, rule: BASE_RULE, expected: 0.5 },
    { label: 'exact threshold uses the lower band', hours: 4, rule: BASE_RULE, expected: 0.5 },
    { label: 'above threshold uses the upper band', hours: 5, rule: BASE_RULE, expected: 1 },
    {
      label: 'NULL upper band falls back to the lower band',
      hours: 5,
      rule: { ...BASE_RULE, pointsAbove: null },
      expected: 0.5,
    },
    {
      label: 'per-record dailyCap does not clamp the calculated value',
      hours: 5,
      rule: { ...BASE_RULE, pointsAbove: 2, dailyCap: 1.2 },
      expected: 2,
    },
    {
      label: 'NULL dailyCap does not introduce a fallback clamp',
      hours: 5,
      rule: { ...BASE_RULE, pointsAbove: 2, dailyCap: null },
      expected: 2,
    },
  ])('$label', async ({ hours, rule, expected }) => {
    const input = await fixture(hours);
    await createRule(input, rule);
    await expectGenerated(input, expected);
  });

  it('database rejects a second ACTIVE pair even at another threshold; the valid rule still generates 0.4', async () => {
    const input = await fixture(6);
    await createRule(input, {
      durationThreshold: null,
      pointsBelow: 0.4,
      pointsAbove: null,
      dailyCap: 3,
    });
    await expect(
      createRule(input, { ...BASE_RULE, pointsBelow: 0.9, pointsAbove: 1.2 }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await prisma.contributionRule.count({ where: { activityTypeCode: input.activityTypeCode } }),
    ).toBe(1);
    await expectGenerated(input, 0.4);
  });

  it.each([null, 0.7])(
    'the shared calculator overwrites supplied %p; native generation persists the authoritative value',
    async (supplied) => {
      const input = await fixture(5);
      await createRule(input);
      // This is the actual public calculator consumed by native generation.
      // Its generic input must not let an old caller-supplied field override the
      // result. Native generate itself has no client points/records parameter.
      const applied = await prisma.$transaction((tx) =>
        app
          .get(ContributionCalculator)
          .applyContributionRulePrefill(
            [{ roleCode: 'member', serviceHours: 5, contributionPoints: supplied }],
            input.activityTypeCode,
            tx,
          ),
      );
      expect(applied).toEqual([{ roleCode: 'member', serviceHours: 5, contributionPoints: 1 }]);
      await expectGenerated(input, 1);
    },
  );

  it.each(['activity type', 'role', 'both'])(
    'mismatched %s cannot select another rule',
    async (mismatch) => {
      const input = await fixture(4, 'coach');
      await prisma.contributionRule.create({
        data: {
          ...BASE_RULE,
          status: 'ACTIVE',
          activityTypeCode:
            mismatch === 'role' ? input.activityTypeCode : `${input.activityTypeCode}-other`,
          attendanceRoleCode: mismatch === 'activity type' ? 'coach' : 'member',
        },
      });
      await expectGenerated(input, 0);
    },
  );

  it('a matching position role selects its rule rather than the member fallback', async () => {
    const input = await fixture(4, 'coach');
    await createRule(input, { ...BASE_RULE, durationThreshold: null, pointsBelow: 2.5 });
    await createRule(input, { ...BASE_RULE, durationThreshold: null, pointsBelow: 0.25 }, 'member');
    await expectGenerated(input, 2.5);
  });
});
