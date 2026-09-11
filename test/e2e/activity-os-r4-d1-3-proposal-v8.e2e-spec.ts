import request from 'supertest';

import {
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  D13_ADMIN,
  explicitTimePolicyChange,
  selectD13MetricNotRequired,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('D1-3 V8 publish-review time-policy freezing', () => {
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

  function selectRoot(
    activityId: string,
    expectedRevision: number,
    pointer: Awaited<ReturnType<typeof createD13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_time_policy'),
        expectedRevision,
        changes: [
          explicitTimePolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      });
  }

  function approve(reviewId: string) {
    return request(httpServer(fixture.app))
      .post(`${D13_ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', fixture.reviewer.auth)
      .send({ requiresInsuranceConfirmed: true, operationKey: fixture.key('approve_v8') });
  }

  it('freezes the selected revision on initial approval, then atomically advances it through a V8 change review', async () => {
    const draft = await createD13Draft(fixture, { withPosition: true });
    const initialPointer = await createD13ActivePolicy(fixture);
    const changedPointer = await createD13ActivePolicy(fixture);
    await selectD13MetricNotRequired(fixture, draft.activityId);

    const selected = await selectRoot(draft.activityId, 0, initialPointer).expect(200);
    expect(selected.body.data).toMatchObject({ revision: 1, activityId: draft.activityId });

    const initial = await request(httpServer(fixture.app))
      .post(`/api/app/v1/my/managed-activities/${draft.activityId}/publish-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({ operationKey: fixture.key('initial_v8'), confirmation: true })
      .expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 8,
      timePolicySelectionExplicit: true,
      timePolicyPointers: {
        schemaVersion: 1,
        selectionRevision: 1,
        proposalSelectionHash: selected.body.data.selectionHash,
      },
      base: {
        timePolicyPointers: {
          schemaVersion: 1,
          selectionRevision: 1,
          proposalSelectionHash: selected.body.data.selectionHash,
        },
      },
    });
    await approve(initial.body.data.id as string).expect(200);
    const afterInitial = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        statusCode: true,
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
        ruleSnapshots: {
          orderBy: { workflowRevision: 'asc' },
          select: { workflowRevision: true, timePolicySelectionRevisionId: true },
        },
      },
    });
    expect(afterInitial.statusCode).toBe('published');
    expect(afterInitial.timePolicySelectionRevision).toBe(1);
    expect(afterInitial.ruleSnapshots).toEqual([
      {
        workflowRevision: 1,
        timePolicySelectionRevisionId: selected.body.data.selectionRevisionId,
      },
    ]);

    const changePayload = {
      operationKey: fixture.key('change_v8'),
      confirmation: true,
      activityPatch: { title: 'D1-3 V8 冻结后变更' },
      sessions: { create: [], update: [], cancel: [] },
      positions: { create: [], update: [], cancel: [] },
      expectedTimePolicySelectionRevision: 1,
      timePolicySelectionChanges: [
        {
          scope: { layerCode: 'activity' },
          selection: { mode: 'explicit', pointer: changedPointer },
        },
      ],
    };
    const change = await request(httpServer(fixture.app))
      .post(`/api/app/v1/my/managed-activities/${draft.activityId}/change-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send(changePayload)
      .expect(200);
    expect(change.body.data.snapshot).toMatchObject({
      schemaVersion: 8,
      timePolicySelectionExplicit: true,
      timePolicyPointers: { selectionRevision: 2 },
      base: { timePolicyPointers: { selectionRevision: 1 } },
    });

    const detail = await request(httpServer(fixture.app))
      .get(`${D13_ADMIN}/activity-publish-reviews/${change.body.data.id as string}`)
      .set('Authorization', fixture.reviewer.auth)
      .expect(200);
    expect(detail.body.data.changeDiff).toMatchObject({
      kind: 'proposal-v8',
      activityFields: ['title'],
    });
    const safeDiff = JSON.stringify(detail.body.data.changeDiff);
    expect(safeDiff).not.toContain(initialPointer.definitionHash);
    expect(safeDiff).not.toContain(changedPointer.definitionHash);
    expect(safeDiff).not.toContain(initialPointer.policyId);
    expect(safeDiff).not.toContain(changedPointer.policyId);

    await approve(change.body.data.id as string).expect(200);
    const completed = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
        timePolicySelectionRevisions: {
          orderBy: { revision: 'asc' },
          select: { id: true, revision: true, originCode: true, publishReviewId: true },
        },
        ruleSnapshots: {
          orderBy: { workflowRevision: 'asc' },
          select: { workflowRevision: true, timePolicySelectionRevisionId: true },
        },
      },
    });
    expect(completed.timePolicySelectionRevision).toBe(2);
    expect(completed.timePolicySelectionRevisions).toHaveLength(2);
    expect(completed.timePolicySelectionRevisions).toMatchObject([
      { revision: 1, originCode: 'select', publishReviewId: null },
      {
        revision: 2,
        originCode: 'publish_review',
        publishReviewId: change.body.data.id as string,
      },
    ]);
    expect(completed.currentTimePolicySelectionRevisionId).toBe(
      completed.timePolicySelectionRevisions[1].id,
    );
    expect(completed.ruleSnapshots).toEqual([
      {
        workflowRevision: 1,
        timePolicySelectionRevisionId: selected.body.data.selectionRevisionId,
      },
      {
        workflowRevision: 2,
        timePolicySelectionRevisionId: completed.timePolicySelectionRevisions[1].id,
      },
    ]);
    expect(
      await fixture.db.auditLog.count({
        where: { resourceId: draft.activityId, event: 'activity.time-policy.selection' },
      }),
    ).toBe(2);
  });
});
