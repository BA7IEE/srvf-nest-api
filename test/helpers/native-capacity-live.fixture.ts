import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { buildActivityTimeAllocationManifest } from '../../src/modules/activities/activity-time-allocation-command';
import { rebuildServiceSegments } from '../../src/modules/activities/settlement-segment-projector';
import {
  createNativeLaunchPublication,
  nativeLaunchSlices,
} from './activity-native-launch.fixture';
import { capacitySlices, NATIVE_CAPACITY_POLICY } from './native-capacity-calibration.fixture';
import { e4Actor, E4_META, type E4Fixture } from './activity-contribution-policy.fixture';
import { memberIdentityData } from './member-identity.fixture';
import { httpServer } from './http-server';
import {
  nativeLaunchPrepareRequest,
  observeNativeLaunchHttp,
  type NativeLaunchStage,
} from './native-launch-live.fixture';

// Fixture writes reuse the existing bounded500 row write envelope; input facts are unchanged.
export const NATIVE_CAPACITY_FIXTURE_WRITE_BATCH = 500;

/** Real publish/approval/seal/HTTP async generate/worker. Only raw source rows
 * and legal allocation rows are batched; no invented policy or draft receipt. */
export async function createNativeCapacityLiveSource(f: E4Fixture, stage: NativeLaunchStage) {
  const published = await stage('PUBLICATION_NATIVE2000', () =>
    createNativeLaunchPublication(f, 2000, stage, {
      contributionDefinition: NATIVE_CAPACITY_POLICY,
      sourceDurationMs: 112000,
    }),
  );
  const session = await f.db.activitySession.findUniqueOrThrow({
    where: { id: published.sessionId },
  });
  const people = Array.from({ length: 2000 }, (_, i) => ({
    memberId: i === 0 ? f.creator.memberId : randomUUID(),
    registrationId: randomUUID(),
    identityId: randomUUID(),
  }));
  for (let offset = 0; offset < people.length; offset += 100) {
    const group = people.slice(offset, offset + 100);
    const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
    const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = [];
    for (const person of group) {
      const observations = Array.from({ length: 5 }, (_, j) => [
        {
          id: randomUUID(),
          eventTypeCode: 'check_in',
          occurredAt: new Date(published.startsAt.getTime() + j * 23000),
          supersedesEventId: null,
        },
        {
          id: randomUUID(),
          eventTypeCode: 'check_out',
          occurredAt: new Date(published.startsAt.getTime() + j * 23000 + 20000),
          supersedesEventId: null,
        },
      ]).flat();
      const projected = rebuildServiceSegments(observations, {
        sessionStartAt: session.startAt,
        sessionEndAt: session.endAt,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
      });
      assert.deepEqual(projected.chainAnomalies, []);
      assert.equal(projected.segments.length, 5);
      for (const event of observations)
        events.push({
          ...event,
          activityId: published.activityId,
          sessionId: published.sessionId,
          positionId: published.positionId,
          participationIdentityId: person.identityId,
          memberId: person.memberId,
          sourceCode: 'self_qr',
          receivedAt: new Date(),
          operatorUserId: f.creator.id,
          eventKey: randomUUID(),
          requestHash: 'b'.repeat(64),
          evidenceRevision: 0,
        });
      for (const { exceptionFlags, ...segment } of projected.segments)
        segments.push({
          ...segment,
          id: randomUUID(),
          participationIdentityId: person.identityId,
          revision: 1,
          statusCode: 'draft',
          exceptionFlagsJson: { flags: exceptionFlags },
        });
    }
    await stage('RAW_NATIVE2000_' + offset, () =>
      f.db.$transaction(
        async (tx) => {
          const members = group.filter((person) => person.memberId !== f.creator.memberId);
          if (members.length)
            await tx.member.createMany({
              data: members.map((person) => ({
                id: person.memberId,
                memberNo: person.memberId,
                ...memberIdentityData('Isolated native capacity'),
              })),
            });
          await tx.activityRegistration.createMany({
            data: group.map((person) => ({
              id: person.registrationId,
              activityId: published.activityId,
              memberId: person.memberId,
              statusCode: 'pass',
            })),
          });
          await tx.activityParticipationIdentity.createMany({
            data: group.map((person) => ({
              id: person.identityId,
              activityId: published.activityId,
              sessionId: published.sessionId,
              registrationId: person.registrationId,
              memberId: person.memberId,
              currentStatusCode: 'pass',
              currentPositionId: published.positionId,
              populationIncluded: true,
            })),
          });
          await tx.attendancePunchEvent.createMany({ data: events });
          await tx.participantServiceSegmentRevision.createMany({ data: segments });
        },
        { timeout: 30000 },
      ),
    );
  }
  const post = async (suffix: string, body: object = {}) => {
    const response = await request(httpServer(f.app))
      .post(published.appUrl + suffix)
      .set('Authorization', f.creator.auth)
      .send(body);
    observeNativeLaunchHttp(stage, suffix, response);
    assert(
      [200, 201].includes(response.status) && response.body.code === 0,
      'NATIVE_CAPACITY_HTTP_' + response.status + '_' + response.body.code,
    );
    return response.body.data;
  };
  const seal = await stage('NATIVE2000_REAL_SEAL', () => post('/evidence-seals'));
  const generated = await stage('NATIVE2000_GENERATE_HTTP', () =>
    post('/settlement/generate', { operationKey: f.key('native2000_generate') }),
  );
  assert.equal(
    generated.outcome,
    'job',
    '2000 identities must use the existing async worker; sync limit remains500',
  );
  const worker = f.app.get(ActivityBatchWorker);
  const drained = await stage('NATIVE2000_GENERATE_WORKER', () => worker.drainOnce());
  assert.equal(drained.jobClaimed, true);
  assert.equal(drained.jobId, generated.jobId);
  assert.equal(drained.itemsFailed, 0);
  const job = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: generated.jobId } });
  assert.equal(job.statusCode, 'succeeded');
  assert(job.settlementVersionId);
  const draft = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: job.settlementVersionId },
  });
  assert.equal(draft.contributionRegimeCode, 'policy_v1');
  assert.equal(draft.sessionParticipationCount, 2000);
  const expectation = {
    expectedDraftVersion: draft.version,
    expectedEvidenceSealId: seal.sealId as string,
    expectedEvidenceRevision: seal.evidenceRevision as number,
    expectedPopulationRevision: seal.populationRevision as number,
    expectedWorkflowRevision: seal.workflowRevision as number,
  };
  const segments = await f.db.participantServiceSegmentRevision.findMany({
    where: { identity: { activityId: published.activityId }, statusCode: { not: 'superseded' } },
    include: { identity: { select: { memberId: true } } },
    orderBy: { id: 'asc' },
  });
  assert.equal(segments.length, 10000);
  assert(segments.every((row) => row.resultCode === 'valid' && row.checkOutAt));
  const first = segments[0];
  await stage('NATIVE2000_REAL_ALLOCATION', () =>
    f.app.get(ActivityTimeSettlementService).allocate(
      published.activityId,
      {
        ...expectation,
        operationKey: f.key('native2000_allocate'),
        sourceSegmentId: first.id,
        expectedRevision: 0,
        recognitionModeCode: 'manual',
        manualReason: 'Native capacity complete allocation',
        slices: nativeLaunchSlices(first.checkInAt, first.checkOutAt!),
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    ),
  );
  const prototype = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
    where: { sourceSegmentId: first.id },
  });
  const receipt = await f.db.participantTimeAllocationCommandReceipt.findFirstOrThrow({
    where: { allocationRevisionId: prototype.id },
  });
  const remaining = segments.slice(1);
  for (let offset = 0; offset < remaining.length; offset += NATIVE_CAPACITY_FIXTURE_WRITE_BATCH) {
    const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
    const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
    const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
    for (const segment of remaining.slice(offset, offset + NATIVE_CAPACITY_FIXTURE_WRITE_BATCH)) {
      const id = randomUUID(),
        input = capacitySlices(segment.checkInAt, segment.checkOutAt!);
      const { manifest, allocationHash } = buildActivityTimeAllocationManifest(input);
      parents.push({
        ...prototype,
        id,
        sliceCount: 5,
        memberId: segment.identity.memberId,
        participationIdentityId: segment.participationIdentityId,
        segmentKey: segment.segmentKey,
        sourceSegmentId: segment.id,
        sourceSegmentRevision: segment.revision,
        allocationJson: manifest as unknown as Prisma.InputJsonValue,
        allocationHash,
      });
      input.forEach((slice, ordinal) =>
        slices.push({
          id: randomUUID(),
          allocationRevisionId: id,
          activityId: published.activityId,
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: slice.intervalKindCode,
          startAt: new Date(slice.startAt),
          endAt: new Date(slice.endAt),
        }),
      );
      receipts.push({
        ...receipt,
        id: randomUUID(),
        allocationRevisionId: id,
        operationKey: randomUUID(),
        resultJson: {
          schemaVersion: 1,
          activityId: published.activityId,
          allocationRevisionId: id,
          revision: 1,
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
    await stage('NATIVE2000_ALLOCATIONS_' + offset, () =>
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
  assert.equal(
    await f.db.participantTimeAllocationRevision.count({
      where: { activityId: published.activityId },
    }),
    10000,
  );
  assert.equal(
    await f.db.participantTimeAllocationSlice.count({
      where: { activityId: published.activityId },
    }),
    50000,
  );
  return {
    ...published,
    post,
    raw: { people, identities: people },
    seal,
    generated,
    draft,
    expectation,
    segments,
    prepare: nativeLaunchPrepareRequest(expectation, f.key('native2000_prepare')),
  };
}
