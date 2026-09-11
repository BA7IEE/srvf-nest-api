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

describe('D1-3 time-policy selection concurrency', () => {
  let fixture: D13Fixture;

  beforeAll(async () => {
    fixture = await createD13Fixture();
  });

  afterAll(async () => {
    await closeD13Fixture(fixture);
  });

  function command(
    activityId: string,
    operationKey: string,
    expectedRevision: number,
    pointer: Awaited<ReturnType<typeof createD13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${D13_APP}/${activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey,
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

  it('serializes duplicate operation keys into a single revision, receipt, and audit event', async () => {
    const draft = await createD13Draft(fixture);
    const pointer = await createD13ActivePolicy(fixture);
    const operationKey = fixture.key('same_operation');

    const [first, second] = await Promise.all([
      command(draft.activityId, operationKey, 0, pointer),
      command(draft.activityId, operationKey, 0, pointer),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data).toEqual(second.body.data);
    expect(first.body.data).toMatchObject({ activityId: draft.activityId, revision: 1 });
    expect(
      await fixture.db.activityTimePolicySelectionRevision.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
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
  });

  it('accepts exactly one competing expected revision and leaves the loser with no partial fact', async () => {
    const draft = await createD13Draft(fixture);
    const firstPointer = await createD13ActivePolicy(fixture);
    const secondPointer = await createD13ActivePolicy(fixture);
    const [first, second] = await Promise.all([
      command(draft.activityId, fixture.key('competing_first'), 0, firstPointer),
      command(draft.activityId, fixture.key('competing_second'), 0, secondPointer),
    ]);
    const responses = [first, second];
    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status !== 200);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectBizError(rejected[0], BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE);
    expect(
      await fixture.db.activityTimePolicySelectionRevision.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    expect(
      await fixture.db.activityTimePolicySelectionCommandReceipt.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    const current = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: { timePolicySelectionRevision: true, currentTimePolicySelectionRevision: true },
    });
    expect(current.timePolicySelectionRevision).toBe(1);
    expect(current.currentTimePolicySelectionRevision?.revision).toBe(1);
  });
});
