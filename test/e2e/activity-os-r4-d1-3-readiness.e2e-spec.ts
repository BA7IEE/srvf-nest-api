import request from 'supertest';

import {
  ActivityPublishReadinessService,
  type ActivityPublishReadinessResult,
} from '../../src/modules/activities/activity-publish-readiness.service';
import {
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  D13_APP,
  explicitTimePolicyChange,
  selectD13MetricNotRequired,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

const REFERENCE_TIME = new Date('2099-01-01T00:00:00.000Z');

describe('D1-3 time-policy readiness facts', () => {
  let fixture: D13Fixture;
  let readiness: ActivityPublishReadinessService;

  beforeAll(async () => {
    fixture = await createD13Fixture();
    readiness = fixture.app.get(ActivityPublishReadinessService);
  });

  afterAll(async () => {
    await closeD13Fixture(fixture);
  });

  function select(
    activityId: string,
    changes: ReadonlyArray<ReturnType<typeof explicitTimePolicyChange>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${D13_APP}/${activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_time_policy'),
        expectedRevision: 0,
        changes,
      });
  }

  function timePolicyIssueCodes(result: ActivityPublishReadinessResult): string[] {
    return result.blockers
      .filter((issue) => issue.code.startsWith('TIME_POLICY_'))
      .map((issue) => issue.code);
  }

  it('keeps legacy rows unconfigured, but precisely distinguishes resolvable, retired, uncovered and stale targets', async () => {
    const unconfigured = await createD13Draft(fixture);
    await selectD13MetricNotRequired(fixture, unconfigured.activityId);

    const resolved = await createD13Draft(fixture);
    const resolvedPointer = await createD13ActivePolicy(fixture);
    await selectD13MetricNotRequired(fixture, resolved.activityId);
    await select(resolved.activityId, [
      explicitTimePolicyChange(resolvedPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ]).expect(200);

    const retired = await createD13Draft(fixture);
    const retiredPointer = await createD13ActivePolicy(fixture);
    await selectD13MetricNotRequired(fixture, retired.activityId);
    await select(retired.activityId, [
      explicitTimePolicyChange(retiredPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ]).expect(200);
    // A policy can be retired after a draft selects it.  The immutable selection stays intact;
    // Readiness must surface the now-unavailable reference rather than silently replacing it.
    await fixture.db.timePolicyVersion.update({
      where: { id: retiredPointer.versionId },
      data: { statusCode: 'retired', retiredAt: new Date('2099-02-01T00:00:00.000Z') },
    });

    const uncovered = await createD13Draft(fixture);
    const uncoveredPointer = await createD13ActivePolicy(fixture, undefined, {
      effectiveFrom: '2099-08-31T00:00:00.000Z',
      effectiveUntil: '2099-09-01T10:00:00.000Z',
    });
    await selectD13MetricNotRequired(fixture, uncovered.activityId);
    await select(uncovered.activityId, [
      explicitTimePolicyChange(uncoveredPointer, {
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

    const staleTarget = await createD13Draft(fixture);
    const staleTargetPointer = await createD13ActivePolicy(fixture);
    await selectD13MetricNotRequired(fixture, staleTarget.activityId);
    await select(staleTarget.activityId, [
      explicitTimePolicyChange(staleTargetPointer, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
      explicitTimePolicyChange(staleTargetPointer, {
        layerCode: 'session',
        sessionId: staleTarget.sessionId,
        positionId: null,
      }),
    ]).expect(200);
    await request(httpServer(fixture.app))
      .delete(`${D13_APP}/${staleTarget.activityId}/sessions/${staleTarget.sessionId}`)
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
          timePolicySelectionRevision: true,
          currentTimePolicySelectionRevisionId: true,
        },
      }),
      revisions: await fixture.db.activityTimePolicySelectionRevision.findMany({
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
    expect(timePolicyIssueCodes(unconfiguredResult)).toEqual(['TIME_POLICY_UNREPRESENTABLE']);
    expect(timePolicyIssueCodes(resolvedResult)).toEqual([]);
    expect(timePolicyIssueCodes(retiredResult)).toEqual(['TIME_POLICY_REFERENCE_UNAVAILABLE']);
    expect(timePolicyIssueCodes(uncoveredResult)).toEqual(['TIME_POLICY_COVERAGE_INCOMPLETE']);
    expect(timePolicyIssueCodes(staleTargetResult)).toEqual(['TIME_POLICY_TARGET_INVALID']);
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
            timePolicySelectionRevision: true,
            currentTimePolicySelectionRevisionId: true,
          },
        }),
        fixture.db.activityTimePolicySelectionRevision.findMany({
          where: { activityId: { in: activityIds } },
          orderBy: [{ activityId: 'asc' }, { revision: 'asc' }],
          select: { id: true, activityId: true, revision: true, selectionHash: true },
        }),
        fixture.db.auditLog.count(),
      ]),
    ).resolves.toEqual([before.activities, before.revisions, before.audits]);
  });
});
