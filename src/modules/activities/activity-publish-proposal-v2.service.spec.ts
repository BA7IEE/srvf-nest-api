import { ActivityPublishProposalV2Service } from './activity-publish-proposal-v2.service';

describe('ActivityPublishProposalV2Service', () => {
  it('runs the proposal application sequence through every explicit batch placeholder', async () => {
    const service = new ActivityPublishProposalV2Service({ get: jest.fn() } as never);
    const calls: string[] = [];
    const internals = service as unknown as Record<string, jest.Mock>;

    internals.applyActivity = jest.fn(() => {
      calls.push('activity');
      return Promise.resolve();
    });
    internals.applySessions = jest.fn(() => {
      calls.push('sessions');
      return Promise.resolve(new Map<string, string>());
    });
    internals.applyPositions = jest.fn(() => {
      calls.push('positions');
      return Promise.resolve();
    });
    internals.applyFormAndRulesPlaceholder = jest.fn(() => {
      calls.push('form-rules-batch4');
      return Promise.resolve();
    });
    internals.applyCapacityBucketsPlaceholder = jest.fn(() => {
      calls.push('capacity-batch4');
      return Promise.resolve();
    });
    internals.applyQrCredentialsPlaceholder = jest.fn(() => {
      calls.push('qr-batch5');
      return Promise.resolve();
    });
    internals.getTemplateResolution = jest.fn(() => Promise.resolve({ templateVersionId: null }));

    const tx = {
      activity: {
        update: jest.fn(() => {
          calls.push('population-revision');
          return Promise.resolve({ workflowRevision: 9 });
        }),
      },
    };

    const result = await service.apply(tx as never, 'activity-1', {} as never, {
      publish: true,
      publishedByUserId: 'reviewer-1',
      at: new Date('2099-01-01T00:00:00.000Z'),
    });

    expect(calls).toEqual([
      'activity',
      'sessions',
      'positions',
      'form-rules-batch4',
      'capacity-batch4',
      'qr-batch5',
      'population-revision',
    ]);
    expect(result.workflowRevision).toBe(9);
  });
});
