import { strict as assert } from 'node:assert';
import type { PrismaClient, Prisma } from '@prisma/client';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from '../../src/modules/activities/activity-contribution-settlement-query.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import { nativeLaunchSlices } from './activity-native-launch.fixture';
import {
  assertNativeLaunchFrozenOracle,
  createNativeLaunchLiveSource,
  createNativeLaunchSealedSource,
  nativeLaunchAdmissionPolicies,
  nativeLaunchBusinessFingerprint,
  observeNativeLaunchHttp,
  type NativeLaunchStage,
} from './native-launch-live.fixture';
import {
  e4Actor,
  E4_META,
  postE4Ledger,
  type E4Fixture,
} from './activity-contribution-policy.fixture';
import { memberIdentityData } from './member-identity.fixture';

export type NativeAdmissionResult = { label: string; value: Record<string, unknown> };

/** New semantics only: three one-person real publications, no 500/max performance rerun. */
export async function runNativeLaunchSmallAdmission(
  f: E4Fixture,
  observer: PrismaClient,
  stage: NativeLaunchStage,
  emit: (result: NativeAdmissionResult) => void,
) {
  const definitions = nativeLaunchAdmissionPolicies();
  const queries = f.app.get(ActivityContributionSettlementQueryService);
  for (const dimension of ['shape', 'bytes'] as const) {
    const definition = definitions[dimension];
    const jsonBytes = Buffer.byteLength(JSON.stringify(definition), 'utf8');
    assert.equal(jsonBytes > 8192, dimension === 'bytes');
    const source = await stage('PUBLICATION_' + dimension, () =>
      createNativeLaunchSealedSource(f, 1, stage, { contributionDefinition: definition }),
    );
    const before = await nativeLaunchBusinessFingerprint(observer, stage);
    const original = queries.assertLaunchFrozenPolicyInTx.bind(queries);
    let originalStack = '';
    const observe = jest
      .spyOn(queries, 'assertLaunchFrozenPolicyInTx')
      .mockImplementation(async (...args) => {
        try {
          return await original(...args);
        } catch (error) {
          originalStack = error instanceof Error ? (error.stack ?? '') : '';
          throw error;
        }
      });
    try {
      // generate is the first native admission for a fresh, lawfully published source.
      // An over-envelope frozen policy cannot lawfully acquire a draft for prepare.
      const response = await stage('GENERATE_REJECT_' + dimension, () =>
        import('supertest').then(({ default: request }) =>
          import('./http-server').then(async ({ httpServer }) => {
            const response = await request(httpServer(f.app))
              .post(source.appUrl + '/settlement/generate')
              .set('Authorization', f.creator.auth)
              .send({ operationKey: f.key('rejected_generate') });
            observeNativeLaunchHttp(stage, '/settlement/generate/' + dimension, response);
            return response;
          }),
        ),
      );
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 20225);
      assert.equal(response.body.data, null);
      assert.equal(observe.mock.calls.length, 1);
      assert(originalStack.includes('assertNativeContributionLaunchPolicies'));
      assert.equal(
        originalStack.includes('assertNativeContributionLaunchJson'),
        dimension === 'bytes',
      );
    } finally {
      observe.mockRestore();
    }
    const after = await nativeLaunchBusinessFingerprint(observer, stage);
    assert.equal(after.hash, before.hash);
    emit({
      label: dimension + ' first native generate rejects20225 and all196 rollback',
      value: {
        identities: 1,
        endpoint: 'settlement/generate',
        noFabricatedDraft: true,
        jsonBytes,
        originalPolicyFunctionObserved: true,
        bytesBranchFirst: dimension === 'bytes',
        bytePolicyAlsoExceedsBandShape: dimension === 'bytes',
        before: before.hash,
        after: after.hash,
      },
    });
  }

  const source = await stage('PUBLICATION_SIMPLE_BASE', () =>
    createNativeLaunchLiveSource(f, 1, stage),
  );
  const prepared = (await stage('BASE_PREPARE', () =>
    source.post('/time-settlement/prepare', source.prepare),
  )) as TimeSettlementReceiptResult;
  const submitted = (await stage('BASE_SUBMIT', () =>
    source.post('/time-settlement/submit', {
      expectedDraftVersion: source.draft.version,
      expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
      operationKey: f.key('admission_submit'),
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    }),
  )) as TimeSettlementReceiptResult;
  const posted = await stage('BASE_LEDGER_COMMIT', () => postE4Ledger(f, submitted));
  const baseProof = await stage('ADMISSION_IO_111', () =>
    observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
    }),
  );
  await assertNativeLaunchFrozenOracle(observer, baseProof, 4, stage);
  emit({
    label: 'one-person current active base actual ledger COMMIT and frozen oracle',
    value: { evaluations: 4, batchCommitted: posted.committed.batchStatus === 'committed' },
  });
  assert.equal(posted.committed.batchStatus, 'committed');

  const correction = f.app.get(CorrectionApplicationService);
  const contributions = f.app.get(ActivityContributionSettlementService);
  const gate = jest.spyOn(contributions, 'assertNewNativeCorrectionInTx');
  const copy = jest.spyOn(queries, 'assertLaunchCopyInTx');
  try {
    const result = await stage('ADMISSION_IO_126', () =>
      observer.participantSettlementResultRevision.findFirstOrThrow({
        where: { settlementVersionId: submitted.settlementVersionId },
      }),
    );
    const requested = await stage('UNCHANGED_SUBMIT_REVIEW', async () => {
      const receipt = await stage('ADMISSION_IO_130', () =>
        correction.submit(
          {
            activityId: source.activityId,
            participationIdentityId: source.raw.people[0].identityId,
            requestTypeCode: 'result',
            requestedChangeJson: {
              schemaVersion: 1,
              results: [
                {
                  participationIdentityId: source.raw.people[0].identityId,
                  resultCode: result.resultCode,
                  lateFlag: !result.lateFlag,
                  earlyLeaveFlag: result.earlyLeaveFlag,
                  recognizedServiceHours: result.recognizedServiceHours.toFixed(2),
                  recognizedContributionPoints: result.recognizedContributionPoints.toFixed(2),
                  adjustmentReason: 'Isolated unchanged-time flag correction',
                },
              ],
              segments: [],
            },
            reason: 'Isolated flag correction',
            operationKey: f.key('flag_request'),
            requestHash: 'e'.repeat(64),
          },
          e4Actor(f.creator, true),
          E4_META,
        ),
      );
      await stage('ADMISSION_IO_157', () =>
        correction.review(
          { correctionRequestId: receipt.correctionRequestId, actionCode: 'approve' },
          e4Actor(f.finalReviewer),
          E4_META,
        ),
      );
      return receipt;
    });
    const command = {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('flag_prepare'),
      requestHash: 'f'.repeat(64),
    };
    const unchanged = await stage('UNCHANGED_PREPARE', () =>
      correction.prepare(command, e4Actor(f.finalReviewer), E4_META),
    );
    assert.equal(gate.mock.calls.length, 1);
    assert(copy.mock.calls.length >= 1);
    const unchangedProof = await stage('ADMISSION_IO_174', () =>
      observer.activitySettlementContributionRevision.findFirstOrThrow({
        where: { settlementVersionId: unchanged.newSettlementVersionId },
      }),
    );
    assert.equal(unchangedProof.sourceKindCode, 'unchanged_time');
    await assertNativeLaunchFrozenOracle(observer, unchangedProof, 4, stage);
    const beforeReplay = await nativeLaunchBusinessFingerprint(observer, stage);
    const repeated = await stage('UNCHANGED_RESUMABLE_PREPARE', () =>
      correction.prepare(command, e4Actor(f.finalReviewer), E4_META),
    );
    assert.deepEqual(repeated, unchanged);
    assert.equal(gate.mock.calls.length, 1, 'Resumable must return before the new admission');
    assert.equal((await nativeLaunchBusinessFingerprint(observer, stage)).hash, beforeReplay.hash);
    await stage('UNCHANGED_COMMIT', () =>
      correction.commit(command, e4Actor(f.finalReviewer), E4_META),
    );
    emit({
      label: 'unchanged-time real new gate/copy, resumable no new gate/write, and COMMIT',
      value: { gateCalls: 1, evaluations: 4, replaySame: true, replayFingerprintSame: true },
    });

    const originalManifest = await stage('ADMISSION_IO_194', () =>
      observer.participationTimeLedgerManifest.findFirstOrThrow({
        where: { settlementVersionId: submitted.settlementVersionId },
      }),
    );
    const roots = await stage('ADMISSION_IO_197', () =>
      observer.participationTimeLedgerEntry.findMany({
        where: { manifestId: originalManifest.id },
      }),
    );
    assert.equal(roots.length, 4);
    const buildTimeRequest = async (versionId: string, long: boolean) => {
      const previous = await stage('ADMISSION_IO_202', () =>
        observer.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: versionId, kindCode: { in: ['submitted', 'correction'] } },
        }),
      );
      const currentSegment = await stage('ADMISSION_IO_205', () =>
        observer.participantServiceSegmentRevision.findFirstOrThrow({
          where: {
            participationIdentityId: source.raw.people[0].identityId,
            statusCode: 'committed',
            resultCode: 'valid',
          },
          orderBy: { revision: 'desc' },
        }),
      );
      const currentAllocation = await stage('ADMISSION_IO_213', () =>
        observer.participantTimeAllocationRevision.findFirstOrThrow({
          where: { sourceSegmentId: currentSegment.id },
          orderBy: { revision: 'desc' },
        }),
      );
      const allocation = await stage('ADMISSION_IO_217', () =>
        f.app.get(ActivityTimeAllocationService).recognize(
          source.activityId,
          {
            operationKey: f.key('latest_base_allocation'),
            sourceSegmentId: currentSegment.id,
            expectedRevision: currentAllocation.revision,
            recognitionModeCode: 'automatic',
            evidenceAttachmentIds: [],
          },
          e4Actor(f.creator, true),
          E4_META,
        ),
      );
      const predecessor = await stage('ADMISSION_IO_229', () =>
        observer.participationTimeCorrectionManifest.findFirst({
          where: { settlementVersionId: previous.effectiveTimeSettlementVersionId },
        }),
      );
      const endsAt = new Date(source.startsAt.getTime() + 20_000);
      const startsAt = long
        ? new Date(source.startsAt.getTime() - 2 * 86_400_000)
        : source.startsAt;
      const slices = nativeLaunchSlices(source.startsAt, endsAt);
      const seconds: Record<string, number> = {
        volunteer_service: 8,
        training: 4,
        organization: 4,
        non_creditable: 4,
      };
      const receipt = await stage('ADMISSION_IO_243', () =>
        correction.submit(
          {
            activityId: source.activityId,
            participationIdentityId: source.raw.people[0].identityId,
            requestTypeCode: 'time',
            requestedChangeJson: {
              schemaVersion: 3,
              results: [],
              segments: [
                {
                  participationIdentityId: source.raw.people[0].identityId,
                  segmentKey: currentSegment.segmentKey,
                  checkInAt: startsAt.toISOString(),
                  checkOutAt: endsAt.toISOString(),
                  resultCode: 'valid',
                  serviceHours: '0.01',
                },
              ],
              timeCorrection: {
                baseSettlementVersionId: versionId,
                baseTimeLedgerHash: predecessor?.contentHash ?? originalManifest.contentHash,
                reason: 'Isolated actual V3 source correction',
                items: roots.map((root) => ({
                  rootEntryId: root.id,
                  recognizedSeconds: seconds[root.categoryCode],
                })),
              },
              allocations: [
                {
                  participationIdentityId: source.raw.people[0].identityId,
                  segmentKey: currentSegment.segmentKey,
                  baseSegmentRevisionId: currentSegment.id,
                  baseAllocationRevisionId: allocation.allocationRevisionId,
                  recognitionModeCode: 'manual',
                  manualReason: 'Short manual slices must not hide the complete source span',
                  slices: slices.map((slice) => ({
                    ...slice,
                    intervalKindCode: 'service_segment',
                  })),
                  evidenceAttachmentIds: [],
                },
              ],
            },
            reason: long
              ? 'Isolated complete-span negative'
              : 'Isolated shortened-source correction',
            operationKey: f.key('v3_request'),
            requestHash: 'e'.repeat(64),
          },
          e4Actor(f.creator, true),
          E4_META,
          { human: true },
        ),
      );
      await stage('ADMISSION_IO_291', () =>
        correction.review(
          { correctionRequestId: receipt.correctionRequestId, actionCode: 'approve' },
          e4Actor(f.finalReviewer),
          E4_META,
        ),
      );
      return {
        correctionRequestId: receipt.correctionRequestId,
        operationKey: f.key('v3_prepare'),
        requestHash: 'f'.repeat(64),
      };
    };

    const v3command = await stage('V3_SUBMIT_REVIEW', () =>
      buildTimeRequest(unchanged.newSettlementVersionId, false),
    );
    const changedEvaluation = jest.spyOn(queries, 'readCorrectionEvaluationInTx');
    let changed: Awaited<ReturnType<CorrectionApplicationService['prepare']>>;
    try {
      changed = await stage('V3_PREPARE', () =>
        correction.prepare(v3command, e4Actor(f.finalReviewer), E4_META),
      );
      assert(changedEvaluation.mock.calls.some((call) => call.at(-1) === true));
    } finally {
      changedEvaluation.mockRestore();
    }
    const changedProof = await stage('ADMISSION_IO_316', () =>
      observer.activitySettlementContributionRevision.findFirstOrThrow({
        where: { settlementVersionId: changed.newSettlementVersionId },
      }),
    );
    assert.equal(changedProof.sourceKindCode, 'correction_time_proof');
    assert(changedProof.correctionTimeSourceProofId);
    await assertNativeLaunchFrozenOracle(observer, changedProof, 4, stage);
    await stage('V3_COMMIT', () => correction.commit(v3command, e4Actor(f.finalReviewer), E4_META));
    const evaluations = await stage('ADMISSION_IO_323', () =>
      observer.participantContributionEvaluation.findMany({
        where: { contributionRevisionId: changedProof.id },
      }),
    );
    assert.equal(
      evaluations.reduce((sum, evaluation) => sum + evaluation.durationSeconds, 0),
      20,
    );
    emit({
      label: 'changed-time real V3 gate/bytes/count/day evaluation and COMMIT',
      value: { evaluations: 4, recognizedSeconds: 20, originalLaunchArgumentObserved: true },
    });

    const longCommand = await stage('LONG_FULL_SOURCE_SHORT_SLICE_SUBMIT_REVIEW', () =>
      buildTimeRequest(changed.newSettlementVersionId, true),
    );
    const beforeLong = await nativeLaunchBusinessFingerprint(observer, stage);
    const callsBeforeLong = gate.mock.calls.length;
    await stage('LONG_FULL_SOURCE_PREPARE_REJECT', () =>
      assert.rejects(
        () => correction.prepare(longCommand, e4Actor(f.finalReviewer), E4_META),
        (error: unknown) => {
          if (typeof error !== 'object' || error === null) return false;
          const biz: unknown = Reflect.get(error, 'biz');
          stage.observe?.({
            transport: 'service',
            entry: 'correction.prepare/full-source-span',
            status: null,
            bizCode:
              typeof biz === 'object' &&
              biz !== null &&
              typeof Reflect.get(biz, 'code') === 'number'
                ? (Reflect.get(biz, 'code') as number)
                : null,
          });
          return typeof biz === 'object' && biz !== null && Reflect.get(biz, 'code') === 20225;
        },
      ),
    );
    assert.equal(gate.mock.calls.length, callsBeforeLong + 1);
    const afterLong = await nativeLaunchBusinessFingerprint(observer, stage);
    assert.equal(afterLong.hash, beforeLong.hash);
    emit({
      label:
        'approved real correction full three-day source with short slices rejects20225/all196 rollback',
      value: {
        oldClosedSchemaAccepted: true,
        submittedAndReviewed: true,
        fullSpanMs: 2 * 86_400_000 + 20_000,
        manualSliceSpanMs: 20_000,
        before: beforeLong.hash,
        after: afterLong.hash,
        scope: 'correction.prepare intended complete source; no fabricated current segment',
      },
    });
  } finally {
    gate.mockRestore();
    copy.mockRestore();
  }
}

/** Regular CI's applicable capacity: original 30s, 500/500/2500/2000, four real prepares. */
export async function runNativeLaunch500Boundary(
  f: E4Fixture,
  observer: PrismaClient,
  stage: NativeLaunchStage,
  emit: (result: NativeAdmissionResult) => void,
) {
  const source = await createNativeLaunchLiveSource(f, 500, stage);
  const prepared = (await stage('BOUNDARY500_PREPARE_HTTP', () =>
    source.post('/time-settlement/prepare', source.prepare),
  )) as TimeSettlementReceiptResult;
  const root = await stage('ADMISSION_IO_383', () =>
    observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { timeRevisionId: prepared.timeRevisionId, kindCode: 'draft' },
    }),
  );
  assert.equal(root.evaluationCount, 2000);
  assert.equal(source.raw.identities.length, 500);
  assert.equal(source.segments.length, 500);
  assert.equal(
    await stage('ADMISSION_IO_389', () => observer.participantTimeAllocationSlice.count()),
    2500,
  );
  assert.equal(
    await stage('ADMISSION_IO_390', () => observer.participantSettlementTimeBucket.count()),
    2000,
  );
  await assertNativeLaunchFrozenOracle(observer, root, 2000, stage);
  const baseline = await nativeLaunchBusinessFingerprint(observer, stage);
  const time = f.app.get(ActivityTimeSettlementService);
  const originalTransaction = f.db.$transaction.bind(f.db);
  const negative = async (
    label: string,
    inject: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(f.db, '$transaction');
    let enteredPrepare = false;
    try {
      await assert.rejects(
        () =>
          originalTransaction(
            async (tx) => {
              Object.defineProperty(f.db, '$transaction', {
                configurable: true,
                value: <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => work(tx),
              });
              await inject(tx);
              enteredPrepare = true;
              await time.prepare(
                source.activityId,
                {
                  ...source.prepare,
                  operationKey: f.key('boundary_negative'),
                  expectedTimeRevision: prepared.revision,
                },
                e4Actor(f.creator, true),
                E4_META,
              );
              throw new Error('NATIVE_LAUNCH_NEGATIVE_UNEXPECTEDLY_ACCEPTED');
            },
            { timeout: 30_000, maxWait: 2_000 },
          ),
        (error: unknown) => {
          if (typeof error !== 'object' || error === null) return false;
          const biz: unknown = Reflect.get(error, 'biz');
          return typeof biz === 'object' && biz !== null && Reflect.get(biz, 'code') === 20225;
        },
      );
    } finally {
      if (descriptor) Object.defineProperty(f.db, '$transaction', descriptor);
      else Reflect.deleteProperty(f.db, '$transaction');
    }
    assert(enteredPrepare);
    const after = await nativeLaunchBusinessFingerprint(observer, stage);
    assert.equal(after.hash, baseline.hash);
    emit({ label, value: { bizCode: 20225, all196Unchanged: true, baseline: baseline.hash } });
  };
  await stage('BOUNDARY501_IDENTITIES', () =>
    negative('501 identities including excluded/no-source', async (tx) => {
      const member = await tx.member.create({
        data: { memberNo: f.key('boundary_member'), ...memberIdentityData('Isolated boundary') },
      });
      const registration = await tx.activityRegistration.create({
        data: { activityId: source.activityId, memberId: member.id, statusCode: 'pass' },
      });
      await tx.activityParticipationIdentity.create({
        data: {
          activityId: source.activityId,
          sessionId: source.sessionId,
          registrationId: registration.id,
          memberId: member.id,
          currentStatusCode: 'cancelled',
          currentPositionId: source.positionId,
          populationIncluded: false,
        },
      });
    }),
  );
  await stage('BOUNDARY501_SEGMENTS', () =>
    negative('501 current segments including voided', async (tx) => {
      const person = source.raw.people[0];
      const events = [];
      for (const [eventTypeCode, occurredAt] of [
        ['check_in', source.startsAt],
        ['check_out', source.endsAt],
      ] as const)
        events.push(
          await tx.attendancePunchEvent.create({
            data: {
              activityId: source.activityId,
              sessionId: source.sessionId,
              positionId: source.positionId,
              participationIdentityId: person.identityId,
              memberId: person.memberId,
              eventTypeCode,
              sourceCode: 'self_qr',
              occurredAt,
              receivedAt: new Date(),
              operatorUserId: f.creator.id,
              eventKey: f.key('void_observation'),
              requestHash: 'b'.repeat(64),
              evidenceRevision: 0,
            },
          }),
        );
      await tx.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: person.identityId,
          segmentKey: '9999',
          revision: 1,
          sourceCheckInEventId: events[0].id,
          sourceCloseEventId: events[1].id,
          resultCode: 'voided',
          statusCode: 'draft',
          checkInAt: source.startsAt,
          checkOutAt: source.endsAt,
          serviceHours: 0,
          lateFlag: false,
          earlyLeaveFlag: false,
        },
      });
    }),
  );
  await stage('BOUNDARY2501_SLICES', () =>
    negative('2501 physical slices after actual allocate', () =>
      time.allocate(
        source.activityId,
        {
          ...source.expectation,
          operationKey: f.key('boundary_allocate6'),
          sourceSegmentId: source.segments[0].id,
          expectedRevision: 1,
          recognitionModeCode: 'manual',
          manualReason: 'Isolated physical slice overflow',
          slices: nativeLaunchSlices(source.startsAt, source.endsAt, 6),
          evidenceAttachmentIds: [],
        },
        e4Actor(f.creator, true),
        E4_META,
      ),
    ),
  );
  const submitted = (await stage('BOUNDARY500_SUBMIT_HTTP', () =>
    source.post('/time-settlement/submit', {
      expectedDraftVersion: source.draft.version,
      expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
      operationKey: f.key('boundary_submit'),
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    }),
  )) as TimeSettlementReceiptResult;
  const posted = await stage('BOUNDARY500_LEDGER_COMMIT', () => postE4Ledger(f, submitted));
  assert.equal(posted.committed.batchStatus, 'committed');
  const formal = await stage('ADMISSION_IO_537', () =>
    observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
    }),
  );
  await assertNativeLaunchFrozenOracle(observer, formal, 2000, stage);
  const entries = await stage('ADMISSION_IO_541', () =>
    observer.participationLedgerEntry.findMany({
      where: { postingBatchId: posted.batchId },
    }),
  );
  assert.equal(entries.length, 1000);
  const pairs = new Map<string, Set<string>>();
  for (const row of entries) {
    const key = JSON.stringify([row.resultRevisionId, row.ledgerDate]);
    const kinds = pairs.get(key) ?? new Set<string>();
    assert(!kinds.has(row.entryTypeCode));
    kinds.add(row.entryTypeCode);
    pairs.set(key, kinds);
  }
  assert.equal(pairs.size, 500);
  for (const kinds of pairs.values())
    assert.deepEqual([...kinds].sort(), ['contribution_credit', 'service_credit']);
  const services = entries.filter((row) => row.entryTypeCode === 'service_credit');
  const credits = entries.filter((row) => row.entryTypeCode === 'contribution_credit');
  assert.equal(services.length, 500);
  assert.equal(credits.length, 500);
  const expectedMembers = new Set(source.raw.people.map((person) => person.memberId));
  for (const credit of credits) {
    assert(expectedMembers.has(credit.memberId));
    assert.equal(credit.reversesEntryId, null);
    assert.equal(credit.recognizedPointsDelta.toFixed(2), '0.50');
    assert.equal(credit.creditedPointsDelta.toFixed(2), '0.50');
    assert.equal(credit.cappedOutPointsDelta.toFixed(2), '0.00');
    assert.equal(credit.serviceHoursDelta.toFixed(2), '0.00');
    const matching = services.filter(
      (row) =>
        row.resultRevisionId === credit.resultRevisionId &&
        row.ledgerDate.getTime() === credit.ledgerDate.getTime(),
    );
    assert.equal(matching.length, 1);
    const service = matching[0];
    assert.equal(service.memberId, credit.memberId);
    assert.equal(service.participationIdentityId, credit.participationIdentityId);
    assert.equal(service.reversesEntryId, null);
    assert.equal(service.serviceHoursDelta.toFixed(2), '0.01');
    assert.equal(service.recognizedPointsDelta.toFixed(2), '0.00');
    assert.equal(service.creditedPointsDelta.toFixed(2), '0.00');
    assert.equal(service.cappedOutPointsDelta.toFixed(2), '0.00');
  }
  assert.equal(
    services.reduce((sum, row) => sum + Math.round(Number(row.serviceHoursDelta) * 100), 0),
    500,
  );
  assert.equal(
    credits.reduce((sum, row) => sum + Math.round(Number(row.creditedPointsDelta) * 100), 0),
    25_000,
  );
  const days = await stage('ADMISSION_IO_591', () =>
    observer.memberContributionDayState.findMany({
      where: { latestBatchId: posted.batchId },
    }),
  );
  assert.equal(days.length, 500);
  assert.equal(new Set(days.map((row) => row.memberId)).size, 500);
  for (const day of days) {
    assert(expectedMembers.has(day.memberId));
    assert.equal(day.version, 1);
    assert.equal(day.committedCreditedPoints.toFixed(2), '0.50');
  }
  const manifest = await stage('ADMISSION_IO_601', () =>
    observer.participationTimeLedgerManifest.findUniqueOrThrow({
      where: { postingBatchId: posted.batchId },
    }),
  );
  const timeRoot = await stage('ADMISSION_IO_604', () =>
    observer.activitySettlementTimeRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
    }),
  );
  assert.equal(manifest.timeRevisionId, timeRoot.id);
  assert.equal(manifest.bucketContentHash, timeRoot.bucketContentHash);
  assert.equal(manifest.sourceSetHash, timeRoot.sourceSetHash);
  const buckets = await stage('ADMISSION_IO_610', () =>
    observer.participantSettlementTimeBucket.findMany({
      where: { timeRevisionId: timeRoot.id },
    }),
  );
  const timeEntries = await stage('ADMISSION_IO_613', () =>
    observer.participationTimeLedgerEntry.findMany({
      where: { manifestId: manifest.id },
    }),
  );
  assert.equal(buckets.length, 2000);
  assert.equal(timeEntries.length, 2000);
  assert.equal(manifest.expectedEntryCount, 2000);
  const bucketMap = new Map(buckets.map((row) => [row.id, row]));
  const seenBuckets = new Set<string>();
  for (const entry of timeEntries) {
    const bucket = bucketMap.get(entry.bucketId);
    assert(bucket && !seenBuckets.has(entry.bucketId));
    seenBuckets.add(entry.bucketId);
    assert.equal(entry.timeRevisionId, bucket.timeRevisionId);
    assert.equal(entry.participationIdentityId, bucket.participationIdentityId);
    assert.equal(entry.categoryCode, bucket.categoryCode);
    assert.equal(entry.recognizedSeconds, bucket.recognizedSeconds);
    assert.equal(entry.postingBatchId, posted.batchId);
  }
  assert.equal(
    timeEntries.reduce((sum, row) => sum + BigInt(row.recognizedSeconds), 0n),
    17_500n,
  );
  emit({
    label: '500/500/2500/2000 real active boundary, frozen oracle and ledger COMMIT',
    value: { capacityPrepareCalls: 4, evaluations: 2000, ledgerPairs: 500 },
  });
}
