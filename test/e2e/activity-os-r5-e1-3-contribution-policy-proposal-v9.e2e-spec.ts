import request from 'supertest';

import {
  closeE13Fixture,
  createE13ActivePolicy,
  createE13Draft,
  createE13Fixture,
  E13_ADMIN,
  explicitContributionPolicyChange,
  selectE13MetricNotRequired,
  type E13Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('E1-3 V9 publish-review contribution-policy freezing', () => {
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

  function selectRoot(
    activityId: string,
    expectedRevision: number,
    pointer: Awaited<ReturnType<typeof createE13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('select_contribution_policy'),
        expectedRevision,
        changes: [
          explicitContributionPolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      });
  }

  function approve(reviewId: string) {
    return request(httpServer(fixture.app))
      .post(`${E13_ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', fixture.reviewer.auth)
      .send({ requiresInsuranceConfirmed: true, operationKey: fixture.key('approve_v9') });
  }

  it('freezes the selected revision on initial approval, then atomically advances it through a V9 change review', async () => {
    const draft = await createE13Draft(fixture, { withPosition: true });
    const initialPointer = await createE13ActivePolicy(fixture);
    const changedPointer = await createE13ActivePolicy(fixture);
    await selectE13MetricNotRequired(fixture, draft.activityId);

    const selected = await selectRoot(draft.activityId, 0, initialPointer).expect(200);
    expect(selected.body.data).toMatchObject({ revision: 1, activityId: draft.activityId });

    const initial = await request(httpServer(fixture.app))
      .post(`/api/app/v1/my/managed-activities/${draft.activityId}/publish-reviews`)
      .set('Authorization', fixture.creator.auth)
      .send({ operationKey: fixture.key('initial_v9'), confirmation: true })
      .expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      schemaVersion: 9,
      contributionPolicySelectionExplicit: true,
      contributionPolicyPointers: {
        schemaVersion: 1,
        selectionRevision: 1,
        proposalSelectionHash: selected.body.data.selectionHash,
      },
      base: {
        contributionPolicyPointers: {
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
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
        ruleSnapshots: {
          orderBy: { workflowRevision: 'asc' },
          select: { workflowRevision: true, contributionPolicySelectionRevisionId: true },
        },
      },
    });
    expect(afterInitial.statusCode).toBe('published');
    expect(afterInitial.contributionPolicySelectionRevision).toBe(1);
    expect(afterInitial.ruleSnapshots).toEqual([
      {
        workflowRevision: 1,
        contributionPolicySelectionRevisionId: selected.body.data.selectionRevisionId,
      },
    ]);

    const changePayload = {
      operationKey: fixture.key('change_v9'),
      confirmation: true,
      activityPatch: { title: 'E1-3 V9 冻结后变更' },
      sessions: { create: [], update: [], cancel: [] },
      positions: { create: [], update: [], cancel: [] },
      expectedContributionPolicySelectionRevision: 1,
      contributionPolicySelectionChanges: [
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
      schemaVersion: 9,
      contributionPolicySelectionExplicit: true,
      contributionPolicyPointers: { selectionRevision: 2 },
      base: { contributionPolicyPointers: { selectionRevision: 1 } },
    });

    const detail = await request(httpServer(fixture.app))
      .get(`${E13_ADMIN}/activity-publish-reviews/${change.body.data.id as string}`)
      .set('Authorization', fixture.reviewer.auth)
      .expect(200);
    expect(detail.body.data.changeDiff).toMatchObject({
      kind: 'proposal-v9',
      activityFields: ['title'],
    });
    const safeDiff = JSON.stringify(detail.body.data.changeDiff);
    expect(safeDiff).not.toContain(initialPointer.definitionHash);
    expect(safeDiff).not.toContain(changedPointer.definitionHash);
    expect(safeDiff).not.toContain(initialPointer.policyId);
    expect(safeDiff).not.toContain(changedPointer.policyId);

    const changeApproval = await approve(change.body.data.id as string);
    if (changeApproval.status !== 200) {
      throw new Error(
        `E1-3 change approval failed: status=${changeApproval.status} code=${String(changeApproval.body?.code)}`,
      );
    }
    const completed = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
        contributionPolicySelectionRevisions: {
          orderBy: { revision: 'asc' },
          select: { id: true, revision: true, originCode: true, publishReviewId: true },
        },
        ruleSnapshots: {
          orderBy: { workflowRevision: 'asc' },
          select: { workflowRevision: true, contributionPolicySelectionRevisionId: true },
        },
      },
    });
    expect(completed.contributionPolicySelectionRevision).toBe(2);
    expect(completed.contributionPolicySelectionRevisions).toHaveLength(2);
    expect(completed.contributionPolicySelectionRevisions).toMatchObject([
      { revision: 1, originCode: 'select', publishReviewId: null },
      {
        revision: 2,
        originCode: 'publish_review',
        publishReviewId: change.body.data.id as string,
      },
    ]);
    expect(completed.currentContributionPolicySelectionRevisionId).toBe(
      completed.contributionPolicySelectionRevisions[1].id,
    );
    expect(completed.ruleSnapshots).toEqual([
      {
        workflowRevision: 1,
        contributionPolicySelectionRevisionId: selected.body.data.selectionRevisionId,
      },
      {
        workflowRevision: 2,
        contributionPolicySelectionRevisionId: completed.contributionPolicySelectionRevisions[1].id,
      },
    ]);
    expect(
      await fixture.db.auditLog.count({
        where: { resourceId: draft.activityId, event: 'activity.contribution-policy.selection' },
      }),
    ).toBe(2);
  });
});
