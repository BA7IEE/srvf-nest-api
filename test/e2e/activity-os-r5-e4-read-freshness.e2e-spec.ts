import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  E13_APP,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { nativeLaunchBusinessFingerprint } from '../helpers/native-launch-live.fixture';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an HTTP response object');
  return value as Record<string, unknown>;
}

function data(response: Response): Record<string, unknown> {
  const body = object(response.body);
  expect({ status: response.status, code: body.code }).toEqual({ status: 200, code: 0 });
  return object(body.data);
}

installE4ValidationDatabase({ settlementMode: 'active', boundMigrationProcesses: true });
describe('E4 draft proof freshness across HTTP read surfaces', () => {
  let f: E4Fixture;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterAll(async () => {
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  it('marks every draft proof pending after a new allocation and refuses the stale submit atomically', async () => {
    const source = await createE4Source(f);
    const server = httpServer(f.app);
    const base = `${E13_APP}/${source.activityId}`;
    const timeUrl = `${base}/time-settlement`;
    const ordinaryUrl = `${base}/settlement`;
    const detailUrl = `${base}/settlement/versions/${source.generated.settlementVersionId}`;
    const prepared = data(
      await request(server)
        .post(`${timeUrl}/prepare`)
        .set('Authorization', f.creator.auth)
        .send({
          expectedDraftVersion: source.expectation.expectedDraftVersion,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: f.key('freshness_prepare'),
          expectedTimeRevision: 0,
        }),
    );
    const reads = async () => {
      const result = [];
      for (const url of [ordinaryUrl, detailUrl, timeUrl])
        result.push(data(await request(server).get(url).set('Authorization', f.creator.auth)));
      return result;
    };
    const initial = await reads();
    for (const row of initial)
      expect(row.contributionProof).toMatchObject({
        pending: false,
        recognizedPointsTotal: '1.00',
      });
    const latest = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { activityId: source.activityId, sourceSegmentId: source.segment.id },
      orderBy: { revision: 'desc' },
    });
    data(
      await request(server)
        .post(`${timeUrl}/allocations`)
        .set('Authorization', f.creator.auth)
        .send({
          ...source.expectation,
          operationKey: f.key('freshness_reallocate'),
          sourceSegmentId: source.segment.id,
          expectedRevision: latest.revision,
          recognitionModeCode: 'automatic',
          evidenceAttachmentIds: [],
        }),
    );
    const draft = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: source.generated.settlementVersionId },
    });
    expect(draft.contentHash).toBe(source.generated.contentHash);
    const stale = await reads();
    const before = await nativeLaunchBusinessFingerprint(f.db, async (_label, work) => work());
    const rejected = await request(server)
      .post(`${timeUrl}/submit`)
      .set('Authorization', f.creator.auth)
      .send({
        expectedDraftVersion: source.expectation.expectedDraftVersion,
        expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
        operationKey: f.key('freshness_submit'),
        timeRevisionId: prepared.timeRevisionId,
        expectedBucketContentHash: prepared.bucketContentHash,
      });
    const rejectedBody = object(rejected.body);
    expect({ status: rejected.status, code: rejectedBody.code }).toEqual({
      status: BizCode.ACTIVITY_TIME_SETTLEMENT_STALE.httpStatus,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_STALE.code,
    });
    expect(rejectedBody.data).toBeNull();
    expect(await nativeLaunchBusinessFingerprint(f.db, async (_label, work) => work())).toEqual(
      before,
    );
    console.info('E4_DRAFT_READ_FRESHNESS', {
      pending: stale.map((row) => (row.contributionProof as { pending: boolean }).pending),
      staleSubmitRejected: true,
      rollbackTables: before.tables,
    });
    for (const row of stale)
      expect(row.contributionProof).toMatchObject({
        pending: true,
        recognizedPointsTotal: null,
        sourceSetHash: null,
        evaluations: [],
      });
    expect(stale[0].gaps).toContainEqual({ gapCode: 'contribution_pending', count: 1 });
    expect(stale[2].blockers).toContainEqual({ code: 'contribution_pending', count: 1 });
  }, 120_000);
});
