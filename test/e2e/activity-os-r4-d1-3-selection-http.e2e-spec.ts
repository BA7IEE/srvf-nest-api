import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import {
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  D13_APP,
  explicitTimePolicyChange,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

describe('D1-3 four-level time-policy selection HTTP', () => {
  let fixture: D13Fixture;

  beforeAll(async () => {
    fixture = await createD13Fixture();
  });

  afterAll(async () => {
    await closeD13Fixture(fixture);
  });

  it('requires the manual grant, writes one immutable complete revision, and replays its safe receipt', async () => {
    const draft = await createD13Draft(fixture, { withPosition: true });
    const pointer = await createD13ActivePolicy(fixture);
    if (!draft.positionId) throw new Error('D1-3 fixture did not create a session position');

    const options = await request(httpServer(fixture.app))
      .get(
        `${D13_APP}/time-policy-options?organizationId=${fixture.organizationId}&plannedFrom=2099-09-01T08%3A00%3A00.000Z&plannedUntil=2099-09-01T10%3A00%3A00.000Z`,
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
        explicitTimePolicyChange(pointer, {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
        }),
        explicitTimePolicyChange(pointer, {
          layerCode: 'session',
          sessionId: draft.sessionId,
          positionId: null,
        }),
        explicitTimePolicyChange(pointer, {
          layerCode: 'position',
          sessionId: draft.sessionId,
          positionId: draft.positionId,
        }),
      ],
    };
    const written = await request(httpServer(fixture.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send(payload)
      .expect(200);
    expect(written.body.data).toMatchObject({ activityId: draft.activityId, revision: 1 });
    expect(written.body.data).not.toHaveProperty('operationKey');
    expect(written.body.data).not.toHaveProperty('requestHash');

    const replay = await request(httpServer(fixture.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send(payload)
      .expect(200);
    expect(replay.body.data).toEqual(written.body.data);

    const read = await request(httpServer(fixture.app))
      .get(`${D13_APP}/${draft.activityId}/time-policy-selection?pageSize=10`)
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(read.body.data).toMatchObject({
      activityId: draft.activityId,
      selectionRevisionId: written.body.data.selectionRevisionId,
      revision: 1,
      total: 3,
      resolutionSummary: {
        targetCount: 3,
        resolvedTargetCount: 3,
        unresolvedTargetCount: 0,
      },
    });
    expect(read.body.data.items).toHaveLength(3);
    expect(JSON.stringify(read.body.data)).not.toContain(payload.operationKey);

    const stored = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
        timePolicySelectionRevisions: {
          select: { id: true, revision: true, itemCount: true, selectionHash: true, items: true },
        },
      },
    });
    expect(stored.timePolicySelectionRevision).toBe(1);
    expect(stored.currentTimePolicySelectionRevisionId).toBe(written.body.data.selectionRevisionId);
    expect(stored.timePolicySelectionRevisions).toHaveLength(1);
    expect(stored.timePolicySelectionRevisions[0]).toMatchObject({ revision: 1, itemCount: 3 });
    expect(stored.timePolicySelectionRevisions[0].items).toHaveLength(3);
    expect(
      await fixture.db.activityTimePolicySelectionCommandReceipt.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    expect(
      await fixture.db.auditLog.count({
        where: { resourceId: draft.activityId, event: 'activity.time-policy.selection' },
      }),
    ).toBe(1);

    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
        .set('Authorization', fixture.reviewer.auth)
        .send({ ...payload, operationKey: fixture.key('ungranted') }),
      BizCode.FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
        .set('Authorization', fixture.creator.auth)
        .send({ ...payload, expectedRevision: 1 }),
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_COMMAND_CONFLICT,
    );
    expectBizError(
      await request(httpServer(fixture.app))
        .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
        .set('Authorization', fixture.creator.auth)
        .send({ ...payload, operationKey: fixture.key('stale'), expectedRevision: 0 }),
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE,
    );
  });
});
