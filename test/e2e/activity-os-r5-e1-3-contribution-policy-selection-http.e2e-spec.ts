import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import {
  closeE13Fixture,
  createE13ActivePolicy,
  createE13Draft,
  createE13Fixture,
  E13_APP,
  explicitContributionPolicyChange,
  type E13Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('E1-3 three-level contribution-policy selection HTTP', () => {
  let fixture: E13Fixture;

  beforeAll(async () => {
    fixture = await createE13Fixture();
  });

  afterAll(async () => {
    await closeE13Fixture(fixture);
  });

  it('requires the manual grant, writes one immutable complete revision, and replays its safe receipt', async () => {
    const draft = await createE13Draft(fixture, { withPosition: true });
    const pointer = await createE13ActivePolicy(fixture);
    if (!draft.positionId) throw new Error('E1-3 fixture did not create a session position');

    const options = await request(httpServer(fixture.app))
      .get(
        `${E13_APP}/contribution-policy-options?organizationId=${fixture.organizationId}&plannedFrom=2099-09-01T08%3A00%3A00.000Z&plannedUntil=2099-09-01T10%3A00%3A00.000Z`,
      )
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(options.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyId: pointer.policyId,
          versionId: pointer.versionId,
          definitionHash: pointer.definitionHash,
        }),
      ]),
    );

    const payload = {
      operationKey: fixture.key('selection_write'),
      expectedRevision: 0,
      changes: [
        explicitContributionPolicyChange(pointer, {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
        }),
        explicitContributionPolicyChange(pointer, {
          layerCode: 'position',
          sessionId: draft.sessionId,
          positionId: draft.positionId,
        }),
      ],
    };
    const written = await request(httpServer(fixture.app))
      .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send(payload)
      .expect(200);
    expect(written.body.data).toMatchObject({ activityId: draft.activityId, revision: 1 });
    expect(written.body.data).not.toHaveProperty('operationKey');
    expect(written.body.data).not.toHaveProperty('requestHash');

    const replay = await request(httpServer(fixture.app))
      .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send(payload)
      .expect(200);
    expect(replay.body.data).toEqual(written.body.data);

    const read = await request(httpServer(fixture.app))
      .get(`${E13_APP}/${draft.activityId}/contribution-policy-selection?pageSize=10`)
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(read.body.data).toMatchObject({
      activityId: draft.activityId,
      selectionRevisionId: written.body.data.selectionRevisionId,
      revision: 1,
      total: 2,
      resolutionSummary: {
        targetCount: 2,
        resolvedTargetCount: 2,
        unresolvedTargetCount: 0,
      },
    });
    expect(read.body.data.items).toHaveLength(2);
    expect(JSON.stringify(read.body.data)).not.toContain(payload.operationKey);

    const stored = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
        contributionPolicySelectionRevisions: {
          select: { id: true, revision: true, itemCount: true, selectionHash: true, items: true },
        },
      },
    });
    expect(stored.contributionPolicySelectionRevision).toBe(1);
    expect(stored.currentContributionPolicySelectionRevisionId).toBe(
      written.body.data.selectionRevisionId,
    );
    expect(stored.contributionPolicySelectionRevisions).toHaveLength(1);
    expect(stored.contributionPolicySelectionRevisions[0]).toMatchObject({
      revision: 1,
      itemCount: 2,
    });
    expect(stored.contributionPolicySelectionRevisions[0].items).toHaveLength(2);
    expect(
      await fixture.db.activityContributionPolicySelectionCommandReceipt.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    expect(
      await fixture.db.auditLog.count({
        where: { resourceId: draft.activityId, event: 'activity.contribution-policy.selection' },
      }),
    ).toBe(1);

    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
        .set('Authorization', fixture.reviewer.auth)
        .send({ ...payload, operationKey: fixture.key('ungranted') }),
      BizCode.FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
        .set('Authorization', fixture.creator.auth)
        .send({ ...payload, expectedRevision: 1 }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_COMMAND_CONFLICT,
    );
    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${E13_APP}/${draft.activityId}/contribution-policy-selection`)
        .set('Authorization', fixture.creator.auth)
        .send({ ...payload, operationKey: fixture.key('stale'), expectedRevision: 0 }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE,
    );
  });
});
