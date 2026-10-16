import {
  closeE5MatrixApp,
  e5ActiveMatrixOptions,
  assertE5MatrixMode,
  assertE5MatrixSettled,
  e5MatrixIt as it,
  e5MatrixBeforeEach as beforeEach,
} from '../helpers/e5-active-matrix';
import { MemberStatus, PrincipalType, Role } from '@prisma/client';
import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  E13_ADMIN,
  E13_APP,
  createE4Fixture,
  createE4Source,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

type Source = Awaited<ReturnType<typeof createE4Source>>;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an HTTP response object');
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected an HTTP identifier');
  return value;
}

function successData(response: Response): Record<string, unknown> {
  const body = object(response.body);
  expect({ status: response.status, code: body.code }).toEqual({ status: 200, code: 0 });
  expect(typeof body.message).toBe('string');
  return object(body.data);
}

function expectError(response: Response, biz: { code: number; httpStatus: number }) {
  const body = object(response.body);
  expect({ status: response.status, code: body.code }).toEqual({
    status: biz.httpStatus,
    code: biz.code,
  });
  expect(typeof body.message).toBe('string');
  expect(body.data).toBeNull();
}

function prepareCommand(f: E4Fixture, source: Source) {
  return {
    expectedDraftVersion: source.expectation.expectedDraftVersion,
    expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
    operationKey: f.key('http_prepare'),
    expectedTimeRevision: 0,
  };
}

function workbenchUrl(source: Source) {
  return `${E13_APP}/${source.activityId}/time-settlement`;
}

function detailUrl(versionId: string) {
  return `${E13_ADMIN}/attendance-settlements/${versionId}/review-detail`;
}

async function prepareViaHttp(f: E4Fixture, source: Source) {
  return successData(
    await request(httpServer(f.app))
      .post(`${workbenchUrl(source)}/prepare`)
      .set('Authorization', f.creator.auth)
      .send(prepareCommand(f, source)),
  );
}

/** Compare the public proof to actual rows, not the production Presenter as its own oracle. */
async function expectPersistedProof(
  f: E4Fixture,
  value: unknown,
  versionId: string,
  source: Source,
  points: string,
  explanationCode: string,
) {
  const proof = object(value);
  const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
    where: { activityId: source.activityId, settlementVersionId: versionId },
    orderBy: { revision: 'desc' },
  });
  const rows = await f.db.participantContributionEvaluation.findMany({
    where: { contributionRevisionId: root.id },
    orderBy: { evaluationUnitKey: 'asc' },
  });
  expect(root.recognizedPointsTotal.toFixed(2)).toBe(points);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    participationIdentityId: source.identity.id,
    policyVersionId: source.contributionPointer.versionId,
    definitionHash: source.contributionPointer.definitionHash,
    evaluatorVersion: 1,
    durationSeconds: 3600,
    explanationCode,
  });
  expect(rows[0].recognizedPoints.toFixed(2)).toBe(points);
  // Exact keys reject additional policy/source documents or private audit/actor payloads.
  expect(Object.keys(proof).sort()).toEqual(
    [
      'regimeCode',
      'pending',
      'revisionId',
      'sourceKindCode',
      'selectionHash',
      'sourceSetHash',
      'evaluationSetHash',
      'recognizedPointsTotal',
      'evaluationCount',
      'hasMore',
      'evaluations',
    ].sort(),
  );
  expect(proof).toEqual({
    regimeCode: 'policy_v1',
    pending: false,
    revisionId: root.id,
    sourceKindCode: root.sourceKindCode,
    selectionHash: root.selectionRevisionHash,
    sourceSetHash: root.sourceSetHash,
    evaluationSetHash: root.evaluationSetHash,
    recognizedPointsTotal: points,
    evaluationCount: 1,
    hasMore: false,
    evaluations: rows.map((row) => ({
      participationIdentityId: row.participationIdentityId,
      policyVersionId: row.policyVersionId,
      definitionHash: row.definitionHash,
      evaluatorVersion: row.evaluatorVersion,
      attendanceRoleCode: row.attendanceRoleCode,
      timeCategoryCode: row.timeCategoryCode,
      durationSeconds: row.durationSeconds,
      calculatedPoints: row.calculatedPoints.toFixed(2),
      recognizedPoints: row.recognizedPoints.toFixed(2),
      explanationCode: row.explanationCode,
    })),
  });
  return root;
}

installE4ValidationDatabase(e5ActiveMatrixOptions());
describe('E4 contribution HTTP: real JWT, scoped workbench and immutable Admin proof', () => {
  let current: E4Fixture | undefined;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  function fixture(): E4Fixture {
    if (!current) throw new Error('E4 HTTP fixture is not initialized');
    return current;
  }

  beforeEach(async () => {
    current = undefined;
    // Test process only; the application uses its real guards and permission engines.
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    current = await createE4Fixture();
    assertE5MatrixMode(current.app);
  }, 120_000);
  afterEach(async () => {
    assertE5MatrixSettled();
    try {
      await closeE5MatrixApp(current?.app);
    } finally {
      current = undefined;
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  it('keeps both existing proof read surfaces JWT-protected', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    for (const url of [workbenchUrl(source), detailUrl(source.generated.settlementVersionId)]) {
      expectError(await request(httpServer(f.app)).get(url), BizCode.UNAUTHORIZED);
    }
  }, 120_000);

  it('reports native pending as null rather than silently awarding zero', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const data = successData(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
    );
    expect(data.ready).toBe(false);
    expect(data.blockers).toEqual(
      expect.arrayContaining([{ code: 'contribution_pending', count: 1 }]),
    );
    expect(data.contributionProof).toEqual({
      regimeCode: 'policy_v1',
      pending: true,
      revisionId: null,
      sourceKindCode: null,
      selectionHash: null,
      sourceSetHash: null,
      evaluationSetHash: null,
      recognizedPointsTotal: null,
      evaluationCount: null,
      hasMore: false,
      evaluations: [],
    });
    expect(
      await f.db.activitySettlementContributionRevision.count({
        where: { activityId: source.activityId },
      }),
    ).toBe(0);
  }, 120_000);

  it('prepares and submits through HTTP, reading each version own frozen proof on App and Admin', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const prepared = await prepareViaHttp(f, source);
    expect(prepared.activityId).toBe(source.activityId);
    expect(prepared.settlementVersionId).toBe(source.generated.settlementVersionId);
    const workbench = successData(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
    );
    expect(workbench.ready).toBe(true);
    expect(workbench.blockers).toEqual([]);
    const draftRoot = await expectPersistedProof(
      f,
      workbench.contributionProof,
      source.generated.settlementVersionId,
      source,
      '1.00',
      'service_hour_plus',
    );
    const draftDetail = successData(
      await request(httpServer(f.app))
        .get(detailUrl(source.generated.settlementVersionId))
        .set('Authorization', f.creator.auth),
    );
    expect(draftDetail.contributionProof).toEqual(workbench.contributionProof);

    const submitted = successData(
      await request(httpServer(f.app))
        .post(`${workbenchUrl(source)}/submit`)
        .set('Authorization', f.creator.auth)
        .send({
          expectedDraftVersion: source.expectation.expectedDraftVersion,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: f.key('http_submit'),
          timeRevisionId: stringField(prepared.timeRevisionId),
          expectedBucketContentHash: stringField(prepared.bucketContentHash),
        }),
    );
    const formalVersionId = stringField(submitted.settlementVersionId);
    expect(formalVersionId).not.toBe(source.generated.settlementVersionId);
    const detail = successData(
      await request(httpServer(f.app))
        .get(detailUrl(formalVersionId))
        .set('Authorization', f.creator.auth),
    );
    expect(object(detail.version).id).toBe(formalVersionId);
    const formalRoot = await expectPersistedProof(
      f,
      detail.contributionProof,
      formalVersionId,
      source,
      '1.00',
      'service_hour_plus',
    );
    expect(formalRoot.id).not.toBe(draftRoot.id);
    expect(formalRoot.kindCode).toBe('submitted');
    expect(draftRoot.kindCode).toBe('draft');
    // Regression for the lock-after authorization callback: valid scoped/GLOBAL reviewers
    // still approve and replay through the real HTTP owner, with the original proof intact.
    const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: formalVersionId },
    });
    const expectation = {
      evidenceSealId: version.evidenceSealId,
      evidenceRevision: version.evidenceRevision,
      populationRevision: version.populationRevision,
      workflowRevision: version.workflowRevision,
      contentHash: version.contentHash,
    };
    for (const [stage, actor] of [
      ['first', f.reviewer],
      ['final', f.finalReviewer],
    ] as const) {
      const command = { ...expectation, operationKey: f.key(`http_${stage}_review`) };
      const url = `${E13_ADMIN}/attendance-settlements/${formalVersionId}/${stage}-approve`;
      expect(
        successData(
          await request(httpServer(f.app)).post(url).set('Authorization', actor.auth).send(command),
        ),
      ).toMatchObject({ stageCode: stage, replayed: false });
      expect(
        successData(
          await request(httpServer(f.app)).post(url).set('Authorization', actor.auth).send(command),
        ),
      ).toMatchObject({ stageCode: stage, replayed: true });
    }
    expect(
      await f.db.activitySettlementContributionRevision.findUniqueOrThrow({
        where: { id: formalRoot.id },
      }),
    ).toEqual(formalRoot);
  }, 120_000);

  it('distinguishes an explicit zero policy from pending and retains its four-tuple and explanation', async () => {
    const f = fixture();
    const source = await createE4Source(f, {
      definition: {
        defaultResult: { recognizedPoints: '0.00', explanationCode: 'explicit_zero_policy' },
        roleRules: [],
      },
    });
    await prepareViaHttp(f, source);
    const data = successData(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
    );
    expect(data.ready).toBe(true);
    expect(data.blockers).toEqual([]);
    await expectPersistedProof(
      f,
      data.contributionProof,
      source.generated.settlementVersionId,
      source,
      '0.00',
      'explicit_zero_policy',
    );
  }, 120_000);

  it('rejects a missing frozen policy without creating time/contribution roots or a command receipt', async () => {
    const f = fixture();
    const source = await createE4Source(f, { withoutFrozenContribution: true });
    const command = prepareCommand(f, source);
    expectError(
      await request(httpServer(f.app))
        .post(`${workbenchUrl(source)}/prepare`)
        .set('Authorization', f.creator.auth)
        .send(command),
      BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
    );
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: source.activityId } }),
    ).toBe(0);
    expect(
      await f.db.activitySettlementContributionRevision.count({
        where: { activityId: source.activityId },
      }),
    ).toBe(0);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: source.activityId, operationKey: command.operationKey },
      }),
    ).toBe(0);
  }, 120_000);

  it('rechecks explicit scoped and GLOBAL grants for the same pre-existing JWT after revocation', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    await prepareViaHttp(f, source);
    // The existing Admin read code has a legacy SUPER_ADMIN shortcut. Use an actual ordinary
    // Human with the already explicit grants to measure revocation, not that unrelated shortcut.
    await f.db.user.update({ where: { id: f.creator.id }, data: { role: Role.USER } });
    for (const url of [workbenchUrl(source), detailUrl(source.generated.settlementVersionId)]) {
      successData(await request(httpServer(f.app)).get(url).set('Authorization', f.creator.auth));
    }
    const revoked = await f.db.roleBinding.updateMany({
      where: {
        principalType: PrincipalType.USER,
        principalId: f.creator.id,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    expect(revoked.count).toBeGreaterThan(0);
    expectError(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
      BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
    );
    expectError(
      await request(httpServer(f.app))
        .get(detailUrl(source.generated.settlementVersionId))
        .set('Authorization', f.creator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
  }, 120_000);

  it('refuses App proof reads when the linked member becomes inactive despite the old JWT and grants', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    await prepareViaHttp(f, source);
    successData(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
    );
    await f.db.member.update({
      where: { id: f.creator.memberId },
      data: { status: MemberStatus.INACTIVE },
    });
    expectError(
      await request(httpServer(f.app))
        .get(workbenchUrl(source))
        .set('Authorization', f.creator.auth),
      BizCode.FORBIDDEN,
    );
  }, 120_000);
});
