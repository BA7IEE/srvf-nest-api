import type { Prisma } from '@prisma/client';

import {
  ActivityPublishProposalV2Service,
  type ActivityPublishProposalSnapshotV2,
} from './activity-publish-proposal-v2.service';

type ProposalV2Internals = {
  currentState: jest.Mock;
  toSnapshot: (...args: unknown[]) => ActivityPublishProposalSnapshotV2;
};

describe('ActivityPublishProposalV2Service', () => {
  const registrationForms = {
    currentTarget: jest.fn(),
    activeResolvedConfig: jest.fn(),
    applyPublishedTarget: jest.fn(),
  };
  const qualificationRules = {
    currentTarget: jest.fn().mockResolvedValue({ ruleSets: [] }),
    activeResolvedConfig: jest.fn().mockResolvedValue([]),
    applyPublishedTarget: jest.fn().mockResolvedValue([]),
  };

  it('recognizes a historical schemaVersion 3 form-bearing proposal for approval compatibility', () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );

    expect(
      service.isSnapshot({
        schemaVersion: 3,
        snapshotHash: 'form-bearing-proposal',
      }),
    ).toBe(true);
  });

  it('keeps historical schemaVersion 2 parsing while hashing a v3 Form target into the stale guard', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );
    const internals = service as unknown as ProposalV2Internals;
    const activity = {
      startAt: '2099-01-01T00:00:00.000Z',
      endAt: '2099-01-01T01:00:00.000Z',
      registrationDeadline: null,
    };
    const baseState = {
      workflowRevision: 4,
      activity,
      sessions: [],
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: {
        definition: {
          fields: [
            {
              fieldCode: 'proof',
              typeCode: 'file',
              label: '证明',
              helpText: null,
              required: false,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 1,
              minValue: null,
              maxValue: null,
              minLength: null,
              maxLength: null,
              maxSelections: null,
              options: null,
            },
          ],
        },
        schemaHash: 'a'.repeat(64),
      },
    };
    internals.currentState = jest.fn().mockResolvedValue(baseState);
    const v2 = internals.toSnapshot(baseState, activity, [], null, baseState.resolvedConfig);
    expect(service.parseSnapshot(v2 as unknown as Prisma.JsonValue)).toEqual(v2);

    const v2Before = await service.rebuildCurrent({} as never, 'activity-1', 2);
    const v3Before = await service.rebuildCurrent({} as never, 'activity-1', 3);
    internals.currentState.mockResolvedValue({
      ...baseState,
      registrationForm: { ...baseState.registrationForm, schemaHash: 'b'.repeat(64) },
    });
    const v2After = await service.rebuildCurrent({} as never, 'activity-1', 2);
    const v3After = await service.rebuildCurrent({} as never, 'activity-1', 3);

    // Mutation target #1: removing registrationForm from hashTargetV3 makes this stale guard
    // blind, while the historical v2 hash deliberately remains unchanged.
    expect(v2After.snapshotHash).toBe(v2Before.snapshotHash);
    expect(v3After.snapshotHash).not.toBe(v3Before.snapshotHash);
    expect(internals.currentState).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'activity-1',
      false,
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'activity-1',
      true,
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'activity-1',
      false,
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      'activity-1',
      true,
      false,
    );
  });

  it('keeps v2 and v3 mode-free while v4 freezes allocation mode in its stale hash', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );
    const internals = service as unknown as { currentState: jest.Mock };
    const state = {
      workflowRevision: 7,
      activity: { title: 'allocation probe', allocationModeCode: 'first_come' },
      sessions: [],
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: null,
    };
    internals.currentState = jest.fn().mockResolvedValue(state);

    const before = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 2),
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
    ]);
    internals.currentState.mockResolvedValue({
      ...state,
      activity: { ...state.activity, allocationModeCode: 'lottery' },
    });
    const after = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 2),
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
    ]);

    expect(after[0].snapshotHash).toBe(before[0].snapshotHash);
    expect(after[1].snapshotHash).toBe(before[1].snapshotHash);
    expect(after[2].snapshotHash).not.toBe(before[2].snapshotHash);
  });

  it('keeps v2-v4 qualification-free while V5 freezes the canonical RuleSet target', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );
    const internals = service as unknown as { currentState: jest.Mock };
    const state = {
      workflowRevision: 11,
      activity: { title: 'qualification stale probe', allocationModeCode: 'qualification_rank' },
      sessions: [],
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: null,
      qualificationRuleSets: {
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [],
            definitionHash: 'a'.repeat(64),
          },
        ],
      },
    };
    internals.currentState = jest.fn().mockResolvedValue(state);

    const before = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 2),
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
      service.rebuildCurrent({} as never, 'activity-1', 5),
    ]);
    internals.currentState.mockResolvedValue({
      ...state,
      qualificationRuleSets: {
        ruleSets: [
          {
            ...state.qualificationRuleSets.ruleSets[0],
            definitionHash: 'b'.repeat(64),
          },
        ],
      },
    });
    const after = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 2),
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
      service.rebuildCurrent({} as never, 'activity-1', 5),
    ]);

    expect(after.slice(0, 3).map((entry) => entry.snapshotHash)).toEqual(
      before.slice(0, 3).map((entry) => entry.snapshotHash),
    );
    // Mutation target: removing qualificationRuleSets from hashTargetV5 makes a pending
    // configuration approval blind to a base-target drift.
    expect(after[3].snapshotHash).not.toBe(before[3].snapshotHash);
    expect(internals.currentState).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1',
      true,
      true,
    );
  });

  it('never forwards allocation mode into v2/v3 applyActivity, but does forward the v4 target', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    const appliedAllocationModes: Array<string | undefined> = [];
    internals.applyActivity = jest.fn(
      (
        _tx: unknown,
        _activityId: string,
        _activity: unknown,
        allocationMode: string | undefined,
      ) => {
        appliedAllocationModes.push(allocationMode);
        return Promise.resolve();
      },
    );
    internals.applySessions = jest.fn().mockResolvedValue(new Map());
    internals.applyPositions = jest.fn().mockResolvedValue(undefined);
    internals.applyFormAndRulesPlaceholder = jest.fn().mockResolvedValue(undefined);
    internals.applyQrCredentialsPlaceholder = jest.fn().mockResolvedValue(undefined);
    internals.getTemplateResolution = jest.fn().mockResolvedValue({ templateVersionId: null });
    const capacityBuckets = { apply: jest.fn().mockResolvedValue(undefined) };
    (service as unknown as { capacityBuckets: typeof capacityBuckets }).capacityBuckets =
      capacityBuckets;
    const tx = {
      activity: {
        update: jest.fn().mockResolvedValue({ workflowRevision: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ workflowRevision: 0 }),
      },
    };
    const common = {
      baseWorkflowRevision: 0,
      baseSnapshotHash: 'base',
      snapshotHash: 'target',
      base: {
        templateVersionId: null,
        resolvedConfig: { templateVersionId: null },
        activity: { title: 'before' },
        sessions: [],
        registrationForm: null,
      },
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      activity: { title: 'after' },
      sessions: [],
      registrationForm: null,
    };
    const input = { publish: false, publishedByUserId: 'reviewer-1', at: new Date('2099-01-01') };

    await service.apply(tx as never, 'activity-1', { ...common, schemaVersion: 2 } as never, input);
    await service.apply(tx as never, 'activity-1', { ...common, schemaVersion: 3 } as never, input);
    await service.apply(
      tx as never,
      'activity-1',
      {
        ...common,
        schemaVersion: 4,
        base: { ...common.base, activity: { title: 'before', allocationModeCode: 'first_come' } },
        activity: { title: 'after', allocationModeCode: 'lottery' },
      } as never,
      input,
    );

    expect(appliedAllocationModes).toEqual([undefined, undefined, 'lottery']);
  });

  it('keeps template resolution Form-free until v3 explicitly reads its active pointer', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.currentState = jest
      .fn()
      .mockResolvedValue({ resolvedConfig: { templateVersionId: null } });

    await expect(service.getTemplateResolution({} as never, 'activity-1')).resolves.toEqual({
      templateVersionId: null,
    });
    expect(internals.currentState).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1',
      false,
      false,
    );
  });

  it('runs the proposal application sequence through the capacity projector', async () => {
    const capacityBuckets = { apply: jest.fn() };
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      capacityBuckets as never,
    );
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
    capacityBuckets.apply.mockImplementation(() => {
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

  it('routes v3 approval through the Form lifecycle with the exact next workflow revision, not the v2 placeholder', async () => {
    const activeForm = {
      formVersionId: 'form-version-9',
      version: 9,
      schemaHash: 'f'.repeat(64),
    };
    const forms = {
      currentTarget: jest.fn(),
      activeResolvedConfig: jest.fn().mockResolvedValue(null),
      applyPublishedTarget: jest.fn().mockResolvedValue(activeForm),
    };
    const capacityBuckets = { apply: jest.fn() };
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      forms as never,
      qualificationRules as never,
      capacityBuckets as never,
    );
    const calls: string[] = [];
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.applyActivity = jest.fn(() => Promise.resolve());
    internals.applySessions = jest.fn(() => Promise.resolve(new Map<string, string>()));
    internals.applyPositions = jest.fn(() => Promise.resolve());
    internals.applyFormAndRulesPlaceholder = jest.fn(() => {
      calls.push('legacy-placeholder');
      return Promise.resolve();
    });
    capacityBuckets.apply.mockResolvedValue(undefined);
    internals.applyQrCredentialsPlaceholder = jest.fn(() => Promise.resolve());
    internals.getTemplateResolution = jest.fn(() => Promise.resolve({ templateVersionId: null }));
    const tx = {
      activity: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ workflowRevision: 8 }),
        update: jest.fn().mockResolvedValue({ workflowRevision: 9 }),
      },
    };

    const frozenConfig = { templateVersionId: 'template-before-approval' };
    const result = await service.apply(
      tx as never,
      'activity-1',
      {
        schemaVersion: 3,
        activity: {},
        sessions: [],
        resolvedConfig: frozenConfig,
        registrationForm: null,
      } as never,
      { publish: false, publishedByUserId: 'reviewer-1', at: new Date('2099-01-01T00:00:00.000Z') },
    );

    expect(forms.applyPublishedTarget).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        activityId: 'activity-1',
        requestType: 'change',
        target: null,
        nextWorkflowRevision: 9,
      }),
    );
    expect(calls).not.toContain('legacy-placeholder');
    expect(internals.getTemplateResolution).not.toHaveBeenCalled();
    expect(result.resolvedConfig).toEqual({ ...frozenConfig, registrationForm: activeForm });
  });
});
