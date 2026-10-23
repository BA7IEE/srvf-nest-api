import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import {
  createE4Source,
  e4Actor,
  E4_META,
  postE4Ledger,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from './activity-contribution-policy.fixture';

export async function approvedE4TimeCorrection(
  f: E4Fixture,
  sourceWindow?: { startsAt: Date; endsAt: Date },
) {
  const source = await createE4Source(f, sourceWindow);
  const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
  await postE4Ledger(f, submitted);
  const segment = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
    where: {
      participationIdentityId: source.identity.id,
      statusCode: 'committed',
      resultCode: 'valid',
    },
    orderBy: { revision: 'desc' },
  });
  const allocation = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
    where: { sourceSegmentId: segment.id },
    orderBy: { revision: 'desc' },
  });
  const recognized = await f.app.get(ActivityTimeAllocationService).recognize(
    source.activityId,
    {
      operationKey: f.key('null_allocation'),
      sourceSegmentId: segment.id,
      expectedRevision: allocation.revision,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [],
    },
    e4Actor(f.creator, true),
    E4_META,
  );
  const original = await f.db.participationTimeLedgerManifest.findFirstOrThrow({
    where: { settlementVersionId: submitted.settlementVersionId },
  });
  const roots = await f.db.participationTimeLedgerEntry.findMany({
    where: { manifestId: original.id },
  });
  const correction = f.app.get(CorrectionApplicationService);
  const requested = await correction.submit(
    {
      activityId: source.activityId,
      participationIdentityId: source.identity.id,
      requestTypeCode: 'time',
      requestedChangeJson: {
        schemaVersion: 3,
        results: [],
        segments: [
          {
            participationIdentityId: source.identity.id,
            segmentKey: segment.segmentKey,
            checkInAt: source.startsAt.toISOString(),
            checkOutAt: new Date(source.startsAt.getTime() + 1800_000).toISOString(),
            resultCode: 'valid',
            serviceHours: '0.50',
          },
        ],
        timeCorrection: {
          baseSettlementVersionId: submitted.settlementVersionId,
          baseTimeLedgerHash: original.contentHash,
          reason: 'NULL constraint diagnostic',
          items: roots.map((root) => ({
            rootEntryId: root.id,
            recognizedSeconds:
              root.categoryCode === 'volunteer_service' ? 1800 : root.recognizedSeconds,
          })),
        },
        allocations: [
          {
            participationIdentityId: source.identity.id,
            segmentKey: segment.segmentKey,
            baseSegmentRevisionId: segment.id,
            baseAllocationRevisionId: recognized.allocationRevisionId,
            recognitionModeCode: 'automatic',
            manualReason: null,
            slices: [],
            evidenceAttachmentIds: [],
          },
        ],
      },
      reason: 'NULL constraint diagnostic',
      operationKey: f.key('null_request'),
      requestHash: 'e'.repeat(64),
    },
    e4Actor(f.creator, true),
    E4_META,
    { human: true },
  );
  await correction.review(
    { correctionRequestId: requested.correctionRequestId, actionCode: 'approve' },
    e4Actor(f.finalReviewer),
    E4_META,
  );
  return {
    correction,
    input: {
      correctionRequestId: requested.correctionRequestId,
      operationKey: f.key('null_prepare'),
      requestHash: 'f'.repeat(64),
    },
  };
}

export function injectE4NullCorrectionHash(f: E4Fixture) {
  const service = f.app.get(ActivityContributionSettlementService);
  const original = service.prepareCorrectionInTx.bind(service);
  return jest
    .spyOn(service, 'prepareCorrectionInTx')
    .mockImplementationOnce(async (tx, ...args) => {
      const create = tx.activitySettlementContributionRevision.create.bind(
        tx.activitySettlementContributionRevision,
      );
      const interception = jest
        .spyOn(tx.activitySettlementContributionRevision, 'create')
        .mockImplementationOnce((input) => {
          input.data.correctionSourceSetHash = null;
          return create(input);
        });
      try {
        return await original(tx, ...args);
      } finally {
        interception.mockRestore();
      }
    });
}
