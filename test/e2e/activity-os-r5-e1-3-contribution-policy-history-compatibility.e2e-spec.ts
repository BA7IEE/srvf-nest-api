import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import {
  closeE13Fixture,
  createE13ActivePolicy,
  createE13Draft,
  createE13Fixture,
  E13_ADMIN,
  E13_APP,
  explicitContributionPolicyChange,
  selectE13MetricNotRequired,
  type E13Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('E1-3 historical proposal compatibility', () => {
  let fixture: E13Fixture;
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    fixture = await createE13Fixture();
  });

  afterAll(async () => {
    await closeE13Fixture(fixture);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  function approve(reviewId: string) {
    return request(httpServer(fixture.app))
      .post(`${E13_ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', fixture.reviewer.auth)
      .send({ requiresInsuranceConfirmed: true, operationKey: fixture.key('approve') });
  }

  function submitInitial(activityId: string) {
    return request(httpServer(fixture.app))
      .post(`${E13_APP}/${activityId}/publish-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({ operationKey: fixture.key('initial'), confirmation: true });
  }

  function selectRoot(
    activityId: string,
    pointer: Awaited<ReturnType<typeof createE13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${E13_APP}/${activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_contribution_policy'),
        expectedRevision: 0,
        changes: [
          explicitContributionPolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      });
  }

  function submitLegacyChange(activityId: string, title: string) {
    return request(httpServer(fixture.app))
      .post(`${E13_APP}/${activityId}/submit-change-review`)
      .set('Authorization', fixture.creator.auth)
      .send({ activity: { title } });
  }

  function submitCurrentChange(activityId: string, title: string) {
    return request(httpServer(fixture.app))
      .post(`${E13_APP}/${activityId}/change-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('current_change'),
        confirmation: true,
        activityPatch: { title },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
  }

  it('keeps an unconfigured historical activity on its pre-V9 review route', async () => {
    const draft = await createE13Draft(fixture);
    await selectE13MetricNotRequired(fixture, draft.activityId);

    const initial = await submitInitial(draft.activityId).expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 7,
      contributionPolicyPointers: null,
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
          contributionPolicySelectionRevision: true,
          currentContributionPolicySelectionRevisionId: true,
        },
      }),
    ).resolves.toEqual({
      title: '历史 V7 路由的无关标题变更',
      contributionPolicySelectionRevision: 0,
      currentContributionPolicySelectionRevisionId: null,
    });
  });

  it('rejects the legacy write envelope once a real selection exists, while the V9 route retains it', async () => {
    const draft = await createE13Draft(fixture);
    const pointer = await createE13ActivePolicy(fixture);
    await selectE13MetricNotRequired(fixture, draft.activityId);
    const selected = await selectRoot(draft.activityId, pointer).expect(200);

    const initial = await submitInitial(draft.activityId).expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 9,
      contributionPolicyPointers: { selectionRevision: 1 },
    });
    await approve(initial.body.data.id as string).expect(200);

    const before = await fixture.db.activityPublishReview.count({
      where: { activityId: draft.activityId },
    });
    expectBizError(
      await submitLegacyChange(draft.activityId, '不得绕开 V9 冻结'),
      BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
    );
    await expect(
      fixture.db.activityPublishReview.count({ where: { activityId: draft.activityId } }),
    ).resolves.toBe(before);

    const current = await submitCurrentChange(draft.activityId, '由当前提案路由保留选择').expect(
      200,
    );
    expect(current.body.data.snapshot).toMatchObject({
      schemaVersion: 9,
      contributionPolicySelectionExplicit: false,
      contributionPolicyPointers: {
        selectionRevision: 1,
        proposalSelectionHash: selected.body.data.selectionHash,
      },
      base: { contributionPolicyPointers: { selectionRevision: 1 } },
    });
    await approve(current.body.data.id as string).expect(200);
    await expect(
      fixture.db.activity.findUniqueOrThrow({
        where: { id: draft.activityId },
        select: {
          title: true,
          contributionPolicySelectionRevision: true,
          currentContributionPolicySelectionRevisionId: true,
        },
      }),
    ).resolves.toEqual({
      title: '由当前提案路由保留选择',
      contributionPolicySelectionRevision: 1,
      currentContributionPolicySelectionRevisionId: selected.body.data
        .selectionRevisionId as string,
    });
  });
});
