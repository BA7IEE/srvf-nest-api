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

describe('E1-3 contribution-policy selection concurrency', () => {
  let fixture: E13Fixture;

  beforeAll(async () => {
    fixture = await createE13Fixture();
  });

  afterAll(async () => {
    await closeE13Fixture(fixture);
  });

  function command(
    activityId: string,
    operationKey: string,
    expectedRevision: number,
    pointer: Awaited<ReturnType<typeof createE13ActivePolicy>>,
  ) {
    return request(httpServer(fixture.app))
      .patch(`${E13_APP}/${activityId}/contribution-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey,
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

  it('serializes duplicate operation keys into a single revision, receipt, and audit event', async () => {
    const draft = await createE13Draft(fixture);
    const pointer = await createE13ActivePolicy(fixture);
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
      await fixture.db.activityContributionPolicySelectionRevision.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
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
  });

  it('accepts exactly one competing expected revision and leaves the loser with no partial fact', async () => {
    const draft = await createE13Draft(fixture);
    const firstPointer = await createE13ActivePolicy(fixture);
    const secondPointer = await createE13ActivePolicy(fixture);
    const [first, second] = await Promise.all([
      command(draft.activityId, fixture.key('competing_first'), 0, firstPointer),
      command(draft.activityId, fixture.key('competing_second'), 0, secondPointer),
    ]);
    const responses = [first, second];
    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status !== 200);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectBizError(rejected[0], BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE);
    expect(
      await fixture.db.activityContributionPolicySelectionRevision.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    expect(
      await fixture.db.activityContributionPolicySelectionCommandReceipt.count({
        where: { activityId: draft.activityId },
      }),
    ).toBe(1);
    const current = await fixture.db.activity.findUniqueOrThrow({
      where: { id: draft.activityId },
      select: {
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevision: true,
      },
    });
    expect(current.contributionPolicySelectionRevision).toBe(1);
    expect(current.currentContributionPolicySelectionRevision?.revision).toBe(1);
  });
});
