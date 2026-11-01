import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ActivityTimeCorrectionCommandService } from '../../src/modules/activities/activity-time-correction-command.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { buildActivityTimeAllocationManifest } from '../../src/modules/activities/activity-time-allocation-command';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import {
  e4Actor,
  E4_META,
  postE4Ledger,
  type E4Fixture,
} from './activity-contribution-policy.fixture';
import { capacitySlices } from './native-capacity-calibration.fixture';
import { nativeLaunchSlices } from './activity-native-launch.fixture';
import {
  NATIVE_CAPACITY_FIXTURE_WRITE_BATCH,
  type createNativeCapacityLiveSource,
} from './native-capacity-live.fixture';
import {
  assertNativeLaunchFrozenOracle,
  assertNativeLaunchPrepareReplay,
  nativeLaunchBusinessFingerprint,
  nativeLaunchV3Allocation,
  type NativeLaunchStage,
} from './native-launch-live.fixture';
import type { NativeAdmissionResult } from './native-launch-admission.cases';
import { buildNativeCapacityCorrectionShape } from './native-capacity-change-shape';
import { humanCorrectionTestService } from './r5-ci-authenticated-runtime';

type Source = Awaited<ReturnType<typeof createNativeCapacityLiveSource>>;

/** Same native committed-source recognize entry as the one-person case. Batch
 * remaining legal raw allocation rows using its actual receipt/codec, never
 * rewrite immutable old allocations or bypass any correction validation. */
async function recognizeCommittedSources(f: E4Fixture, source: Source, stage: NativeLaunchStage) {
  const old = await f.db.participantTimeAllocationRevision.findMany({
    where: { activityId: source.activityId },
    select: { id: true, sourceSegmentId: true, revision: true },
  });
  assert.equal(old.length, 10000);
  const bySegment = new Map(old.map((row) => [row.sourceSegmentId, row]));
  const first = source.segments[0],
    base = bySegment.get(first.id);
  assert(base);
  const recognized = await stage('CAPACITY_COMMITTED_RECOGNIZE', () =>
    f.app.get(ActivityTimeAllocationService).recognize(
      source.activityId,
      {
        operationKey: f.key('committed_recognize'),
        sourceSegmentId: first.id,
        expectedRevision: base.revision,
        recognitionModeCode: 'manual',
        manualReason: 'Native capacity complete allocation',
        slices: nativeLaunchSlices(first.checkInAt, first.checkOutAt!),
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    ),
  );
  const prototype = await f.db.participantTimeAllocationRevision.findUniqueOrThrow({
    where: { id: recognized.allocationRevisionId },
  });
  assert.equal(prototype.settlementDraftVersionId, null);
  const originalReceipt = await f.db.participantTimeAllocationCommandReceipt.findFirstOrThrow({
    where: { allocationRevisionId: prototype.id },
  });
  for (
    let offset = 1;
    offset < source.segments.length;
    offset += NATIVE_CAPACITY_FIXTURE_WRITE_BATCH
  ) {
    const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
    const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
    const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
    for (const segment of source.segments.slice(
      offset,
      offset + NATIVE_CAPACITY_FIXTURE_WRITE_BATCH,
    )) {
      const previous = bySegment.get(segment.id);
      assert(previous);
      const id = randomUUID(),
        input = capacitySlices(segment.checkInAt, segment.checkOutAt!);
      const { manifest, allocationHash } = buildActivityTimeAllocationManifest(input);
      parents.push({
        ...prototype,
        id,
        participationIdentityId: segment.participationIdentityId,
        memberId: segment.identity.memberId,
        segmentKey: segment.segmentKey,
        revision: previous.revision + 1,
        previousAllocationRevisionId: previous.id,
        sourceSegmentId: segment.id,
        sourceSegmentRevision: segment.revision,
        allocationJson: manifest as unknown as Prisma.InputJsonValue,
        allocationHash,
      });
      input.forEach((slice, ordinal) =>
        slices.push({
          id: randomUUID(),
          allocationRevisionId: id,
          activityId: source.activityId,
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: slice.intervalKindCode,
          startAt: new Date(slice.startAt),
          endAt: new Date(slice.endAt),
        }),
      );
      receipts.push({
        ...originalReceipt,
        id: randomUUID(),
        allocationRevisionId: id,
        operationKey: randomUUID(),
        resultJson: {
          schemaVersion: 1,
          activityId: source.activityId,
          allocationRevisionId: id,
          revision: previous.revision + 1,
          sourceSegmentId: segment.id,
          sourceSegmentRevision: segment.revision,
          recognitionModeCode: 'manual',
          allocationHash,
          sliceCount: 5,
          evidenceCount: 0,
          createdAt: prototype.createdAt.toISOString(),
        },
      });
    }
    await stage('CAPACITY_COMMITTED_ALLOCATIONS_' + offset, () =>
      f.db.$transaction(
        async (tx) => {
          await tx.participantTimeAllocationRevision.createMany({ data: parents });
          await tx.participantTimeAllocationSlice.createMany({ data: slices });
          await tx.participantTimeAllocationCommandReceipt.createMany({ data: receipts });
        },
        { timeout: 30000 },
      ),
    );
  }
  return f.db.participantTimeAllocationRevision.findMany({
    where: { activityId: source.activityId, settlementDraftVersionId: null },
    select: { id: true, sourceSegmentId: true, revision: true },
  });
}

export async function createNativeCapacityCorrectionCases(
  f: E4Fixture,
  observer: PrismaClient,
  stage: NativeLaunchStage,
  emit: (result: NativeAdmissionResult) => void,
  source: Source,
  submitted: TimeSettlementReceiptResult,
  posted: Awaited<ReturnType<typeof postE4Ledger>>,
) {
  const correction = f.app.get(CorrectionApplicationService);
  const originalResults = await observer.participantSettlementResultRevision.findMany({
    where: { settlementVersionId: submitted.settlementVersionId },
  });
  assert.equal(originalResults.length, 2000);
  const results = originalResults.map((row) => ({
    participationIdentityId: row.participationIdentityId,
    resultCode: row.resultCode,
    lateFlag: !row.lateFlag,
    earlyLeaveFlag: row.earlyLeaveFlag,
    recognizedServiceHours: row.recognizedServiceHours.toFixed(2),
    recognizedContributionPoints: row.recognizedContributionPoints.toFixed(2),
    adjustmentReason: 'Native capacity approved fact correction',
  }));
  const apply = async (
    label: string,
    requestedChangeJson: Record<string, unknown>,
    kind: 'result' | 'time',
    sourceKind: string,
  ) => {
    // The unchanged-time V1 copy is the existing trusted internal standard7
    // path. Actual changed-time V3 uses the real Human command adapter, which
    // derives hashes/anchors and dispatches the existing Human15 profile.
    const human =
      kind === 'time'
        ? humanCorrectionTestService(f, ActivityTimeCorrectionCommandService)
        : undefined;
    const submitInput = {
      participationIdentityId: source.raw.people[0].identityId,
      requestTypeCode: kind,
      requestedChangeJson,
      reason: 'Native capacity approved fact correction',
      operationKey: f.key(label + '_request'),
    };
    const requested = await stage(label + '_SUBMIT', async () => {
      if (human) {
        const result = await human.submit(
          source.activityId,
          submitInput,
          e4Actor(f.creator, true),
          E4_META,
        );
        return { ...result, correctionRequestId: result.requestId };
      }
      return correction.submit(
        { ...submitInput, activityId: source.activityId, requestHash: 'e'.repeat(64) },
        e4Actor(f.creator, true),
        E4_META,
      );
    });
    await stage(label + '_REVIEW', async () => {
      const reviewed = human
        ? await human.review(
            source.activityId,
            requested.correctionRequestId,
            { actionCode: 'approve', expectedRequestVersion: requested.requestVersion },
            e4Actor(f.finalReviewer),
            E4_META,
          )
        : await correction.review(
            { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
            e4Actor(f.finalReviewer),
            E4_META,
          );
      assert.equal(reviewed.outcome, 'reviewed');
      assert.equal(reviewed.statusCode, 'approved');
    });
    const command = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key(label + '_prepare'),
      requestHash: 'f'.repeat(64),
    };
    const prepare = async () => {
      if (human) {
        const receipt = await human.prepare(
          source.activityId,
          requested.correctionRequestId,
          {
            expectedBaseSettlementVersionId: requested.baseSettlementVersionId,
            operationKey: command.operationKey,
          },
          e4Actor(f.finalReviewer),
          E4_META,
        );
        return {
          ...receipt,
          correctionApplicationId: receipt.applicationId,
          newSettlementVersionId: receipt.settlementVersionId,
          newPostingBatchId: receipt.postingBatchId,
        };
      }
      return correction.prepare(command, e4Actor(f.finalReviewer), E4_META);
    };
    const prepared = await stage(label + '_PREPARE', prepare);
    const commit = async () => {
      if (human)
        return human.commit(
          source.activityId,
          requested.correctionRequestId,
          {
            expectedBaseSettlementVersionId: requested.baseSettlementVersionId,
            correctionApplicationId: prepared.correctionApplicationId,
            postingBatchId: prepared.newPostingBatchId,
            operationKey: command.operationKey,
          },
          e4Actor(f.finalReviewer),
          E4_META,
        );
      const result = await correction.commit(command, e4Actor(f.finalReviewer), E4_META);
      assert.equal(result.ledger.batchStatus, 'committed');
      return { ...result, postingBatchId: result.ledger.postingBatchId };
    };
    const root = await observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.newSettlementVersionId },
    });
    assert.equal(root.sourceKindCode, sourceKind);
    assert.equal(root.evaluationCount, 8000);
    assert.equal(root.recognizedPointsTotal.toFixed(2), '1000.00');
    await assertNativeLaunchFrozenOracle(observer, root, 8000, stage);
    const beforeReplay = await nativeLaunchBusinessFingerprint(observer, stage);
    const repeated = await stage(label + '_PREPARE_REPLAY', prepare);
    assertNativeLaunchPrepareReplay(prepared, repeated);
    assert.equal((await nativeLaunchBusinessFingerprint(observer, stage)).hash, beforeReplay.hash);
    const committed = await stage(label + '_COMMIT', commit);
    assert.equal(committed.replayed, false);
    assert.equal(committed.applicationStatus, 'committed');
    assert.equal(committed.correctionStatus, 'applied');
    assert.equal(committed.postingBatchId, prepared.newPostingBatchId);
    const batch = await observer.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: prepared.newPostingBatchId },
    });
    assert.equal(batch.statusCode, 'committed');
    const beforeCommitReplay = await nativeLaunchBusinessFingerprint(observer, stage);
    const replayed = await stage(label + '_COMMIT_REPLAY', commit);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.postingBatchId, committed.postingBatchId);
    assert.equal(
      (await nativeLaunchBusinessFingerprint(observer, stage)).hash,
      beforeCommitReplay.hash,
    );
    emit({
      label,
      value: {
        sourceKind,
        evaluations: 8000,
        recognizedPointsTotal: '1000.00',
        actualCommitted: true,
        prepareReplayExact: true,
        commitReplayNoWrites: true,
        postingBatchId: committed.postingBatchId,
        entry: human
          ? 'actual Human command V3 /15s'
          : 'existing internal V1 unchanged copy /standard7s',
      },
    });
    return { prepared, root, committed };
  };
  let unchanged: Awaited<ReturnType<typeof apply>> | undefined;
  let timeChangedConsumed = false;
  return {
    async unchanged() {
      assert(!unchanged, 'unchanged acceptance already consumed');
      unchanged = await apply(
        'NATIVE2000_UNCHANGED',
        { schemaVersion: 1, results, segments: [] },
        'result',
        'unchanged_time',
      );
    },
    async timeChanged(delta: 1 | 1000 | 10000 = 10000) {
      assert(unchanged, 'unchanged acceptance must complete first');
      assert(!timeChangedConsumed, 'one changed-time shape per complete native fixture');
      timeChangedConsumed = true;
      const changeShape = buildNativeCapacityCorrectionShape(source.segments, delta);
      assert.equal(changeShape.metrics.sourceRows, 10000);
      assert.equal(changeShape.metrics.changedSegmentRows, delta);
      emit({ label: 'NATIVE2000_TIME_CHANGED_INPUT_SHAPE', value: changeShape.metrics });
      const allocations = await recognizeCommittedSources(f, source, stage);
      assert.equal(allocations.length, 10000);
      const bySource = new Map(allocations.map((row) => [row.sourceSegmentId, row]));
      const manifest = await observer.participationTimeLedgerManifest.findUniqueOrThrow({
        where: { postingBatchId: posted.batchId },
      });
      const roots = await observer.participationTimeLedgerEntry.findMany({
        where: { manifestId: manifest.id },
      });
      assert.equal(roots.length, 8000);
      assert.equal(
        new Set(roots.map((row) => JSON.stringify([row.participationIdentityId, row.categoryCode])))
          .size,
        8000,
      );
      const changed = await apply(
        'NATIVE2000_TIME_CHANGED',
        {
          schemaVersion: 3,
          results: results.map((row) => ({ ...row, lateFlag: !row.lateFlag })),
          segments: changeShape.selected.map((row) => ({
            participationIdentityId: row.participationIdentityId,
            segmentKey: row.segmentKey,
            checkInAt: row.checkInAt.toISOString(),
            checkOutAt: new Date(row.checkOutAt!.getTime() - 1000).toISOString(),
            resultCode: 'valid',
            serviceHours: '0.01',
          })),
          allocations: changeShape.selected.map((row) => {
            const allocation = bySource.get(row.id);
            assert(allocation);
            return nativeLaunchV3Allocation({
              participationIdentityId: row.participationIdentityId,
              segmentKey: row.segmentKey,
              baseSegmentRevisionId: row.id,
              baseAllocationRevisionId: allocation.id,
              startsAt: row.checkInAt,
              endsAt: new Date(row.checkOutAt!.getTime() - 1000),
            });
          }),
          timeCorrection: {
            baseSettlementVersionId: unchanged.prepared.newSettlementVersionId,
            baseTimeLedgerHash: manifest.contentHash,
            reason: 'Native capacity approved fact correction',
            items: roots.map((row) => {
              const categories = changeShape.recognizedSecondsByIdentity.get(
                row.participationIdentityId,
              );
              assert(categories);
              const recognizedSeconds = categories[row.categoryCode];
              assert(Number.isSafeInteger(recognizedSeconds) && recognizedSeconds >= 0);
              return { rootEntryId: row.id, recognizedSeconds };
            }),
          },
        },
        'time',
        'correction_time_proof',
      );
      assert(changed.root.correctionTimeSourceProofId);
      const proof = await observer.correctionTimeSourceProof.findUniqueOrThrow({
        where: { id: changed.root.correctionTimeSourceProofId },
      });
      assert.equal(proof.expectedSegmentCount, 10000);
      assert.equal(proof.expectedBindingCount, 10000);
      assert.equal(proof.expectedPendingCount, changeShape.expected.pending);
      assert.equal(proof.expectedSliceCount, 50000);
      const changedEvaluations = await observer.participantContributionEvaluation.findMany({
        where: { contributionRevisionId: changed.root.id },
        select: { durationSeconds: true },
      });
      const actualDuration = changedEvaluations.reduce((sum, row) => sum + row.durationSeconds, 0);
      assert.equal(actualDuration, changeShape.expectedRecognizedSeconds);
      const [history] = await observer.$queryRaw<
        { segmentRevisions: number; allocationRevisions: number; physicalSlices: number }[]
      >`
    SELECT
      (SELECT count(*)::int FROM "ParticipantServiceSegmentRevision" s
       JOIN "ActivityParticipationIdentity" i ON i.id=s."participationIdentityId"
       WHERE i."activityId"=${source.activityId}) AS "segmentRevisions",
      (SELECT count(*)::int FROM "ParticipantTimeAllocationRevision"
       WHERE "activityId"=${source.activityId}) AS "allocationRevisions",
      (SELECT count(*)::int FROM "ParticipantTimeAllocationSlice"
       WHERE "activityId"=${source.activityId}) AS "physicalSlices"
  `;
      assert.equal(history.segmentRevisions, changeShape.expected.segmentRevisions);
      assert.equal(history.allocationRevisions, changeShape.expected.allocationRevisions);
      assert.equal(history.physicalSlices, changeShape.expected.physicalSlices);
      // Retain the original full-change acceptance's independent fixed numbers.
      if (delta === 10000) {
        assert.equal(proof.expectedPendingCount, 10000);
        assert.equal(actualDuration, 190000);
        assert.equal(history.segmentRevisions, 20000);
        assert.equal(history.allocationRevisions, 30000);
        assert.equal(history.physicalSlices, 150000);
      }
      emit({ label: 'native2000 complete correction history remains admissible', value: history });
    },
  };
}
