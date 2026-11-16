import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivitySettlementHttpService } from '../../src/modules/activities/activity-settlement-http.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { createTestUser } from '../fixtures/users.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Native phases replace the retired Sheet submit/edit/reject contract:
// conflicting punch chains stay unresolved; cross-activity overlap is checked
// when formal credit commits under the member lock. Draft/returned history
// cannot reserve a formal time window, and regeneration never deletes history.
// Sealed source events are fixtures; generation, submission, review, preparation
// and commit below are real services. No fabricated result/ledger outcome.
const META = { requestId: 'native-time-overlap', ip: null, ua: null };
const EPOCH = Date.parse('2020-03-01T00:00:00Z');
const at = (hour: number) => new Date(EPOCH + hour * 3_600_000);
type Draft = Awaited<ReturnType<typeof createSettlementDraftFixture>>;
interface Scene extends Draft {
  memberIds: string[];
  generation: SettlementDraftResult;
  events: Array<{ id: string; identityId: string; type: string; hour: number }>;
}
type Submitted = Scene & { versionId: string };
type Ready = Submitted & { batchId: string };

describe('Native time overlap — migrated submit/edit/history characterization', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let db: PrismaService;
  let dbB: PrismaService;
  let drafts: SettlementDraftService;
  let submitter: SettlementSubmitService;
  let reviews: ActivitySettlementHttpService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let postingB: LedgerPostingService;
  let owner: CurrentUserPayload;
  let firstReviewer: CurrentUserPayload;
  let finalReviewer: CurrentUserPayload;
  let organizationId: string;
  let ownerMemberId: string;
  let sequence = 0;
  let eventSequence = 0;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  async function member(label: string): Promise<string> {
    return (
      await db.member.create({
        data: {
          memberNo: `overlap-${label}-${++sequence}`,
          ...memberIdentityData(label),
          gradeCode: 'level-2',
        },
      })
    ).id;
  }
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    appB = await createTestApp();
    db = app.get(PrismaService);
    dbB = appB.get(PrismaService);
    drafts = app.get(SettlementDraftService);
    submitter = app.get(SettlementSubmitService);
    reviews = app.get(ActivitySettlementHttpService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    postingB = appB.get(LedgerPostingService);
    const actor = async (name: string, role: Role): Promise<CurrentUserPayload> => {
      const user = await createTestUser(app, { username: name, role });
      return { id: user.id, username: name, role, status: UserStatus.ACTIVE, memberId: null };
    };
    owner = await actor('overlap-owner', Role.USER);
    firstReviewer = await actor('overlap-first', Role.ADMIN);
    finalReviewer = await actor('overlap-final', Role.SUPER_ADMIN);
    const role = await db.rbacRole.create({
      data: { code: 'overlap-first-review', displayName: 'Overlap first review' },
    });
    const code = 'activity.settlement-first-review.record';
    const permission = await db.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: 'activity',
        action: 'settlement-first-review',
        resourceType: 'record',
      },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: firstReviewer.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
    organizationId = (
      await db.organization.create({ data: { name: 'Overlap org', nodeTypeCode: 'team' } })
    ).id;
    ownerMemberId = await member('owner');
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([app?.close(), appB?.close()]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function event(
    scene: Draft,
    identityId: string,
    type: string,
    hour: number,
    supersedesEventId: string | null = null,
  ) {
    const identity = await db.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: identityId },
    });
    const n = ++eventSequence;
    const row = await db.attendancePunchEvent.create({
      data: {
        // Stable source ordering at equal timestamps: checkout precedes the next
        // check-in. This tests [start,end), not random CUID tie ordering.
        id: `c${String(n).padStart(24, '0')}`,
        activityId: scene.activityId,
        sessionId: identity.sessionId,
        participationIdentityId: identityId,
        memberId: identity.memberId,
        eventTypeCode: type,
        sourceCode: supersedesEventId ? 'correction' : 'staff_scan',
        occurredAt: at(hour),
        receivedAt: at(hour),
        operatorUserId: owner.id,
        eventKey: `overlap-event-${n}`,
        requestHash: `overlap-event-hash-${n}`,
        evidenceRevision: 0,
        supersedesEventId,
        reason: supersedesEventId ? '历史来源纠错夹具' : null,
      },
    });
    return { id: row.id, identityId, type, hour };
  }

  async function scene(
    memberIds: string[],
    spans: Array<{ member: number; start: number; end: number }>,
  ): Promise<Scene> {
    const activityTypeCode = `overlap-type-${++sequence}`;
    const input = await createSettlementDraftFixture(db, {
      organizationId,
      participantMemberIds: memberIds,
      ownerMemberId,
      actorUserId: owner.id,
      activityTypeCode,
      missingResult: true,
    });
    await db.contributionRule.create({
      data: { activityTypeCode, attendanceRoleCode: 'member', status: 'ACTIVE', pointsBelow: 0.5 },
    });
    const source = spans
      .flatMap((span) => [
        { identityId: input.identityIds[span.member], type: 'check_in', hour: span.start },
        { identityId: input.identityIds[span.member], type: 'check_out', hour: span.end },
      ])
      .sort((a, b) => a.hour - b.hour || (a.type === b.type ? 0 : a.type === 'check_out' ? -1 : 1));
    const events = [];
    for (const item of source)
      events.push(await event(input, item.identityId, item.type, item.hour));
    const generation = await drafts.generate(input.activityId, owner, META);
    return { ...input, memberIds, events, generation };
  }
  async function single(memberId: string, start = 0, end = 1) {
    return scene([memberId], [{ member: 0, start, end }]);
  }
  const submit = (input: Scene) =>
    submitter.submit(
      {
        activityId: input.activityId,
        operationKey: `overlap-submit-${input.generation.settlementVersionId}`,
        requestHash: `overlap-submit-hash-${input.generation.settlementVersionId}`,
        expectedDraftVersion: input.generation.settlementVersion,
        expectedEvidenceSealId: input.sealId,
      },
      owner,
      META,
    );

  async function review(input: Submitted, stage: 'first' | 'final', action: 'approve' | 'return') {
    const version = await db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: input.versionId },
    });
    return reviews.review(
      input.versionId,
      stage,
      action,
      {
        operationKey: `overlap-${stage}-${action}-${input.versionId}`,
        note: '重叠验收',
        expectation: {
          evidenceSealId: version.evidenceSealId,
          evidenceRevision: version.evidenceRevision,
          populationRevision: version.populationRevision,
          workflowRevision: version.workflowRevision,
          contentHash: version.contentHash,
        },
      },
      stage === 'first' ? firstReviewer : finalReviewer,
      META,
    );
  }
  async function ready(input: Scene): Promise<Ready> {
    expect(input.generation.pendingItemCount).toBe(0);
    expect(input.generation.blockedItemCount).toBe(0);
    const submitted = { ...input, versionId: (await submit(input)).settlementVersionId };
    await review(submitted, 'first', 'approve');
    await review(submitted, 'final', 'approve');
    const batch = await db.ledgerPostingBatch.findFirstOrThrow({
      where: { settlementVersionId: submitted.versionId },
    });
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    const items = await db.activityBatchJobItem.findMany({
      where: { jobId },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    expect(
      (await db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } })).statusCode,
    ).toBe('ready');
    return { ...submitted, batchId: batch.id };
  }
  const commit = (input: Ready, service = posting) =>
    service.commitBatch(
      {
        postingBatchId: input.batchId,
        operationKey: `overlap-commit-${input.batchId}`,
      },
      finalReviewer,
      META,
    );

  async function snapshot(input: Draft) {
    const versions = await db.attendanceSettlementVersion.findMany({
      where: { settlementRunId: input.runId },
      orderBy: { id: 'asc' },
    });
    const batches = await db.ledgerPostingBatch.findMany({
      where: { settlementRunId: input.runId },
      orderBy: { id: 'asc' },
    });
    const ids = [
      input.activityId,
      input.runId,
      ...versions.map((v) => v.id),
      ...batches.map((b) => b.id),
    ];
    return {
      run: await db.attendanceSettlementRun.findUniqueOrThrow({ where: { id: input.runId } }),
      versions,
      batches,
      results: await db.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: { in: versions.map((v) => v.id) } },
        orderBy: { id: 'asc' },
      }),
      segments: await db.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: { in: input.identityIds } },
        orderBy: { id: 'asc' },
      }),
      entries: await db.participationLedgerEntry.findMany({
        where: { activityId: input.activityId },
        orderBy: { id: 'asc' },
      }),
      audits: await db.auditLog.findMany({
        where: { resourceId: { in: ids } },
        orderBy: { id: 'asc' },
      }),
      intents: await db.notificationOutboxIntent.findMany({
        where: { aggregateId: { in: ids } },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function expectUnresolved(input: Scene) {
    expect(input.generation.pendingItemCount).toBe(1);
    expect(input.generation.items[0].pendingReasons).toContain('punch_chain_conflict');
    const before = await snapshot(input);
    await expect(submit(input)).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
    });
    expect(await snapshot(input)).toEqual(before);
    expect(
      await db.participationLedgerEntry.count({ where: { activityId: input.activityId } }),
    ).toBe(0);
  }
  async function expectOverlapRefused(input: Ready) {
    const before = await snapshot(input);
    const totals = await db.memberContributionDayState.findMany({
      where: { memberId: { in: input.memberIds } },
      orderBy: { id: 'asc' },
    });
    await expect(commit(input)).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });
    expect(await snapshot(input)).toEqual(before);
    expect(
      await db.memberContributionDayState.findMany({
        where: { memberId: { in: input.memberIds } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(totals);
    expect(
      await db.participationLedgerEntry.count({
        where: { activityId: input.activityId, postingBatch: { statusCode: 'committed' } },
      }),
    ).toBe(0);
  }

  it.each([
    {
      label: 'identical',
      spans: [
        { member: 0, start: 0, end: 2 },
        { member: 0, start: 0, end: 2 },
      ],
    },
    {
      label: 'partially overlapping',
      spans: [
        { member: 0, start: 0, end: 2 },
        { member: 0, start: 1, end: 3 },
      ],
    },
  ])(
    '$label source intervals cannot silently become a determined result or formal credit',
    async ({ spans }) => {
      await expectUnresolved(await scene([await member('conflict')], spans));
    },
  );

  it('left-closed/right-open boundary permits consecutive intervals and commits exactly their hours', async () => {
    const id = await member('boundary');
    const input = await scene(
      [id],
      [
        { member: 0, start: 0, end: 1 },
        { member: 0, start: 1, end: 2 },
      ],
    );
    expect(input.generation.items[0]).toMatchObject({ segmentCount: 2, calculatedServiceHours: 2 });
    const batch = await ready(input);
    await commit(batch);
    const hours = await db.participationLedgerEntry.aggregate({
      where: { postingBatchId: batch.batchId, entryTypeCode: 'service_credit' },
      _sum: { serviceHoursDelta: true },
    });
    expect(Number(hours._sum.serviceHoursDelta)).toBe(2);
  });

  it('overlapping intervals of different members within one activity remain independent', async () => {
    const ids = [await member('multi-a'), await member('multi-b')];
    const batch = await ready(
      await scene(ids, [
        { member: 0, start: 0, end: 2 },
        { member: 1, start: 0, end: 2 },
      ]),
    );
    await commit(batch);
    const entries = await db.participationLedgerEntry.findMany({
      where: { postingBatchId: batch.batchId, entryTypeCode: 'service_credit' },
      orderBy: { memberId: 'asc' },
    });
    expect(entries.map((row) => row.memberId).sort()).toEqual([...ids].sort());
    expect(entries.map((row) => Number(row.serviceHoursDelta))).toEqual([2, 2]);
  });

  it('same-member cross-activity overlap rejects at formal commit with the entire ready state unchanged', async () => {
    const id = await member('cross');
    await commit(await ready(await single(id, 0, 2)));
    await expectOverlapRefused(await ready(await single(id, 1, 3)));
  });

  it('different members can commit overlapping time across activities', async () => {
    const a = await ready(await single(await member('cross-a')));
    const b = await ready(await single(await member('cross-b')));
    await commit(a);
    await commit(b);
    expect(
      await db.ledgerPostingBatch.count({
        where: { id: { in: [a.batchId, b.batchId] }, statusCode: 'committed' },
      }),
    ).toBe(2);
  });

  it('two real connections queue on the same member key; exactly one conflicting activity commits', async () => {
    const id = await member('race');
    const a = await ready(await single(id));
    const b = await ready(await single(id));
    const before = [await snapshot(a), await snapshot(b)];
    let release!: () => void;
    let acquired!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))::text AS locked`;
        const [row] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid()::int AS pid`;
        acquired(row.pid);
        await gate;
      },
      { timeout: 20_000 },
    );
    void blocker.catch(failed);
    const pending: ReturnType<LedgerPostingService['commitBatch']>[] = [];
    try {
      const pid = await reached;
      pending.push(commit(a), commit(b, postingB));
      const settled = Promise.allSettled(pending);
      const deadline = Date.now() + 1_200;
      let waiters: Array<{ pid: number }> = [];
      while (Date.now() < deadline) {
        waiters = await dbB.$queryRaw<Array<{ pid: number }>>`
          SELECT waiter.pid FROM pg_locks waiter
          JOIN pg_locks holder USING (locktype, database, classid, objid, objsubid)
          WHERE holder.pid = CAST(${pid} AS integer)
            AND holder.locktype = 'advisory' AND holder.granted AND NOT waiter.granted
        `;
        if (new Set(waiters.map((row) => row.pid)).size === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(new Set(waiters.map((row) => row.pid)).size).toBe(2);
      release();
      await blocker;
      const outcomes = await settled;
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failedIndex = outcomes.findIndex((result) => result.status === 'rejected');
      const rejected = outcomes[failedIndex] as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });
      expect(await snapshot([a, b][failedIndex])).toEqual(before[failedIndex]);
      expect(
        await db.ledgerPostingBatch.count({
          where: { id: { in: [a.batchId, b.batchId] }, statusCode: 'committed' },
        }),
      ).toBe(1);
      const total = await db.memberContributionDayState.findMany({ where: { memberId: id } });
      expect(total).toHaveLength(1);
      expect(Number(total[0].committedCreditedPoints)).toBe(0.5);
    } finally {
      release();
      await Promise.allSettled([blocker, ...pending]);
    }
  }, 60_000);

  async function retime(input: Scene, eventIndex: number, hour: number) {
    const old = input.events[eventIndex];
    if (!old) throw new Error('Retiming fixture event missing');
    // Append-only corrected input, mirroring the native generator's correction
    // characterization. Old source events/results remain as historical evidence.
    await event(input, old.identityId, 'void', 5, old.id);
    input.events.push(await event(input, old.identityId, old.type, hour));
    return { ...input, generation: await drafts.generate(input.activityId, owner, META) };
  }
  const historicalResults = (input: Scene) =>
    db.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: input.generation.settlementVersionId },
      orderBy: { id: 'asc' },
    });

  it('regeneration ignores its own superseded span while retaining the old version and result', async () => {
    const input = await single(await member('self-edit'), 0, 2);
    const history = await historicalResults(input);
    const revised = await retime(input, 1, 1.5);
    expect(revised.generation.settlementVersion).toBe(input.generation.settlementVersion + 1);
    expect(revised.generation.items[0].calculatedServiceHours).toBe(1.5);
    expect(await historicalResults(input)).toEqual(history);
    expect(
      (
        await db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: input.generation.settlementVersionId },
        })
      ).statusCode,
    ).toBe('voided');
    const batch = await ready(revised);
    await commit(batch);
    const segments = await db.participantServiceSegmentRevision.findMany({
      where: { participationIdentityId: input.identityId, statusCode: 'committed' },
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].checkOutAt).toEqual(at(1.5));
  });

  it('retiming into another activity cannot bypass overlap checking; history and failed commit remain intact', async () => {
    const id = await member('edit-other');
    await commit(await ready(await single(id, 0, 1)));
    const input = await single(id, 1.5, 2.5);
    const history = await historicalResults(input);
    const revised = await retime(input, 0, 0.5);
    expect(await historicalResults(input)).toEqual(history);
    await expectOverlapRefused(await ready(revised));
    expect(await historicalResults(input)).toEqual(history);
  });

  it('retiming into an internal conflict leaves an unresolved new draft and preserves the prior results', async () => {
    const input = await scene(
      [await member('edit-internal')],
      [
        { member: 0, start: 0, end: 1 },
        { member: 0, start: 2, end: 3 },
      ],
    );
    const history = await historicalResults(input);
    const revised = await retime(input, 2, 0.5);
    expect(await historicalResults(input)).toEqual(history);
    await expectUnresolved(revised);
    expect(await historicalResults(input)).toEqual(history);
  });

  it('returning an unposted version retains its facts but does not block another activity from committing', async () => {
    const id = await member('returned');
    const input = await single(id);
    const submitted = { ...input, versionId: (await submit(input)).settlementVersionId };
    const history = await db.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: submitted.versionId },
      orderBy: { id: 'asc' },
    });
    await review(submitted, 'first', 'return');
    const other = await ready(await single(id));
    await commit(other);
    expect(
      (
        await db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: submitted.versionId },
        })
      ).statusCode,
    ).toBe('returned');
    expect(
      await db.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: submitted.versionId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(history);
    expect(
      await db.participationLedgerEntry.count({ where: { activityId: input.activityId } }),
    ).toBe(0);
    expect(
      (await db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: other.batchId } })).statusCode,
    ).toBe('committed');
  });
});
