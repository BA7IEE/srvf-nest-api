import request from 'supertest';

import {
  ActivityPublishReadinessService,
  type ActivityPublishReadinessResult,
} from '../../src/modules/activities/activity-publish-readiness.service';
import {
  closeE13Fixture,
  createE13ActivePolicy,
  createE13Draft,
  createE13Fixture,
  E13_APP,
  explicitContributionPolicyChange,
  selectE13MetricNotRequired,
  type E13Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

const REFERENCE_TIME = new Date('2099-01-01T00:00:00.000Z');

describe('E1-3 contribution-policy readiness facts', () => {
  let fixture: E13Fixture;
  let readiness: ActivityPublishReadinessService;

  beforeAll(async () => {
    fixture = await createE13Fixture();
    readiness = fixture.app.get(ActivityPublishReadinessService);
  });

  afterAll(async () => {
    await closeE13Fixture(fixture);
  });

  function select(
    activityId: string,
    changes: ReadonlyArray<ReturnType<typeof explicitContributionPolicyChange>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${E13_APP}/${activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_contribution_policy'),
        expectedRevision: 0,
        changes,
      });
  }

  function contributionPolicyIssueCodes(result: ActivityPublishReadinessResult): string[] {
    return result.blockers
      .filter((issue) => issue.code.startsWith('CONTRIBUTION_POLICY_'))
      .map((issue) => issue.code);
  }

  it('keeps legacy rows unconfigured, but precisely distinguishes resolvable, retired, uncovered and stale targets', async () => {
    const unconfigured = await createE13Draft(fixture);
    await selectE13MetricNotRequired(fixture, unconfigured.activityId);

    const resolved = await createE13Draft(fixture);
    const resolvedPointer = await createE13ActivePolicy(fixture);
    await selectE13MetricNotRequired(fixture, resolved.activityId);
    await select(resolved.activityId, [
      explicitContributionPolicyChange(resolvedPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ]).expect(200);

    const retired = await createE13Draft(fixture);
    const retiredPointer = await createE13ActivePolicy(fixture);
    await selectE13MetricNotRequired(fixture, retired.activityId);
    await select(retired.activityId, [
      explicitContributionPolicyChange(retiredPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ]).expect(200);
    // A policy can be retired after a draft selects it.  The immutable selection stays intact;
    // Readiness must surface the now-unavailable reference rather than silently replacing it.
    await fixture.db.contributionPolicyVersion.update({
      where: { id: retiredPointer.versionId },
      data: {
        statusCode: 'retired',
        retiredAt: new Date('2099-02-01T00:00:00.000Z'),
        retiredByUserId: fixture.creator.id,
      },
    });

    const uncovered = await createE13Draft(fixture);
    const uncoveredPointer = await createE13ActivePolicy(fixture, undefined, {
      effectiveFrom: '2099-08-31T00:00:00.000Z',
      effectiveUntil: '2099-09-01T10:00:00.000Z',
    });
    await selectE13MetricNotRequired(fixture, uncovered.activityId);
    await select(uncovered.activityId, [
      explicitContributionPolicyChange(uncoveredPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ]).expect(200);
    // This emulates an already-saved schedule extension. It intentionally changes no selection
    // row, so the read-only evaluator must report the coverage gap from persisted facts.
    await fixture.db.activity.update({
      where: { id: uncovered.activityId },
      data: { endAt: new Date('2099-09-01T10:30:00.000Z') },
    });

    const staleTarget = await createE13Draft(fixture, { withPosition: true });
    const staleTargetPointer = await createE13ActivePolicy(fixture);
    if (!staleTarget.positionId) throw new Error('E1-3 fixture did not create a position');
    await selectE13MetricNotRequired(fixture, staleTarget.activityId);
    await select(staleTarget.activityId, [
      explicitContributionPolicyChange(staleTargetPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
      explicitContributionPolicyChange(staleTargetPointer, {
        layerCode: 'position',
        sessionId: staleTarget.sessionId,
        positionId: staleTarget.positionId,
      }),
    ]).expect(200);
    await request(httpServer(fixture.app))
      .delete(
        `${E13_APP}/${staleTarget.activityId}/sessions/${staleTarget.sessionId}/positions/${staleTarget.positionId}`,
      )
      .set('Authorization', fixture.creator.auth)
      .expect(200);

    const activityIds = [
      unconfigured.activityId,
      resolved.activityId,
      retired.activityId,
      uncovered.activityId,
      staleTarget.activityId,
    ];
    const before = {
      activities: await fixture.db.activity.findMany({
        where: { id: { in: activityIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          contributionPolicySelectionRevision: true,
          currentContributionPolicySelectionRevisionId: true,
        },
      }),
      revisions: await fixture.db.activityContributionPolicySelectionRevision.findMany({
        where: { activityId: { in: activityIds } },
        orderBy: [{ activityId: 'asc' }, { revision: 'asc' }],
        select: { id: true, activityId: true, revision: true, selectionHash: true },
      }),
      audits: await fixture.db.auditLog.count(),
    };

    const [unconfiguredResult, resolvedResult, retiredResult, uncoveredResult, staleTargetResult] =
      await Promise.all(
        activityIds.map((activityId) => readiness.evaluate(activityId, REFERENCE_TIME)),
      );
    expect(contributionPolicyIssueCodes(unconfiguredResult)).toEqual([
      'CONTRIBUTION_POLICY_UNREPRESENTABLE',
    ]);
    expect(contributionPolicyIssueCodes(resolvedResult)).toEqual([]);
    expect(contributionPolicyIssueCodes(retiredResult)).toEqual([
      'CONTRIBUTION_POLICY_REFERENCE_UNAVAILABLE',
    ]);
    expect(contributionPolicyIssueCodes(uncoveredResult)).toEqual([
      'CONTRIBUTION_POLICY_COVERAGE_INCOMPLETE',
    ]);
    expect(contributionPolicyIssueCodes(staleTargetResult)).toEqual([
      'CONTRIBUTION_POLICY_TARGET_INVALID',
    ]);
    await expect(readiness.evaluate(resolved.activityId, REFERENCE_TIME)).resolves.toEqual(
      resolvedResult,
    );

    await expect(
      Promise.all([
        fixture.db.activity.findMany({
          where: { id: { in: activityIds } },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            contributionPolicySelectionRevision: true,
            currentContributionPolicySelectionRevisionId: true,
          },
        }),
        fixture.db.activityContributionPolicySelectionRevision.findMany({
          where: { activityId: { in: activityIds } },
          orderBy: [{ activityId: 'asc' }, { revision: 'asc' }],
          select: { id: true, activityId: true, revision: true, selectionHash: true },
        }),
        fixture.db.auditLog.count(),
      ]),
    ).resolves.toEqual([before.activities, before.revisions, before.audits]);
  });
});
