import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import {
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  D13_ADMIN,
  D13_APP,
  explicitTimePolicyChange,
  selectD13MetricNotRequired,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('D1-3 historical proposal compatibility', () => {
  let fixture: D13Fixture;
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    fixture = await createD13Fixture();
  });

  afterAll(async () => {
    await closeD13Fixture(fixture);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  function approve(reviewId: string) {
    return request(httpServer(fixture.app))
      .post(`${D13_ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', fixture.reviewer.auth)
      .send({ requiresInsuranceConfirmed: true, operationKey: fixture.key('approve') });
  }

  function submitInitial(activityId: string) {
    return request(httpServer(fixture.app))
      .post(`${D13_APP}/${activityId}/publish-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({ operationKey: fixture.key('initial'), confirmation: true });
  }

  function selectRoot(
    activityId: string,
    pointer: Awaited<ReturnType<typeof createD13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${D13_APP}/${activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_time_policy'),
        expectedRevision: 0,
        changes: [
          explicitTimePolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      });
  }

  function submitLegacyChange(activityId: string, title: string) {
    return request(httpServer(fixture.app))
      .post(`${D13_APP}/${activityId}/submit-change-review`)
      .set('Authorization', fixture.creator.auth)
      .send({ activity: { title } });
  }

  function submitCurrentChange(activityId: string, title: string) {
    return request(httpServer(fixture.app))
      .post(`${D13_APP}/${activityId}/change-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('current_change'),
        confirmation: true,
        activityPatch: { title },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
  }

  it('keeps an unconfigured historical activity on its pre-V8 review route', async () => {
    const draft = await createD13Draft(fixture);
    await selectD13MetricNotRequired(fixture, draft.activityId);

    const initial = await submitInitial(draft.activityId).expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 7,
      timePolicyPointers: null,
    });
    await approve(initial.body.data.id as string).expect(200);

    const legacy = await submitLegacyChange(draft.activityId, '历史 V7 路由的无关标题变更').expect(
      200,
    );
    expect(legacy.body.data.snapshot).toMatchObject({ schemaVersion: 1 });
    await approve(legacy.body.data.id as string).expect(200);

    await expect(
      fixture.db.activity.findUniqueOrThrow({
        where: { id: draft.activityId },
        select: {
          title: true,
          timePolicySelectionRevision: true,
          currentTimePolicySelectionRevisionId: true,
        },
      }),
    ).resolves.toEqual({
      title: '历史 V7 路由的无关标题变更',
      timePolicySelectionRevision: 0,
      currentTimePolicySelectionRevisionId: null,
    });
  });

  it('rejects the legacy write envelope once a real selection exists, while the V8 route retains it', async () => {
    const draft = await createD13Draft(fixture);
    const pointer = await createD13ActivePolicy(fixture);
    await selectD13MetricNotRequired(fixture, draft.activityId);
    const selected = await selectRoot(draft.activityId, pointer).expect(200);

    const initial = await submitInitial(draft.activityId).expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 8,
      timePolicyPointers: { selectionRevision: 1 },
    });
    await approve(initial.body.data.id as string).expect(200);

    const before = await fixture.db.activityPublishReview.count({
      where: { activityId: draft.activityId },
    });
    expectBizError(
      await submitLegacyChange(draft.activityId, '不得绕开 V8 冻结'),
      BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
    );
    await expect(
      fixture.db.activityPublishReview.count({ where: { activityId: draft.activityId } }),
    ).resolves.toBe(before);

    const current = await submitCurrentChange(draft.activityId, '由当前提案路由保留选择').expect(
      200,
    );
    expect(current.body.data.snapshot).toMatchObject({
      schemaVersion: 8,
      timePolicySelectionExplicit: false,
      timePolicyPointers: {
        selectionRevision: 1,
        proposalSelectionHash: selected.body.data.selectionHash,
      },
      base: { timePolicyPointers: { selectionRevision: 1 } },
    });
    await approve(current.body.data.id as string).expect(200);
    await expect(
      fixture.db.activity.findUniqueOrThrow({
        where: { id: draft.activityId },
        select: {
          title: true,
          timePolicySelectionRevision: true,
          currentTimePolicySelectionRevisionId: true,
        },
      }),
    ).resolves.toEqual({
      title: '由当前提案路由保留选择',
      timePolicySelectionRevision: 1,
      currentTimePolicySelectionRevisionId: selected.body.data.selectionRevisionId as string,
    });
  });
});
