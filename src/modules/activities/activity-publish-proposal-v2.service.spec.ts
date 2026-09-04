import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ActivityPublishProposalV2Service,
  type ActivityPublishProposalSnapshotV2,
} from './activity-publish-proposal-v2.service';
import { activitySessionCancellationEffects } from './activity-session-cancellation-effects';
import { canonicalizeRegistrationFormDefinition } from './registration-form-definition';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';

type ProposalV2Internals = {
  currentState: jest.Mock;
  toSnapshot: (...args: unknown[]) => ActivityPublishProposalSnapshotV2;
};

function hashUnsignedSnapshot(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalize(value as CanonicalValue), 'utf8')
    .digest('hex');
}

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
  /** apply() 的 actor / 批次键 / 审计上下文三件套(ADV-018 后为必填)。 */
  const applyActorInput = {
    publishedByUserRole: 'SUPER_ADMIN',
    versionKey: 'review:proposal-v2-spec',
    auditMeta: { requestId: 'req-proposal-v2-spec', ip: null, ua: null },
  } as const;

  it('keeps governed Form targets canonical and hash-bound in every existing v3-v5 slot without changing the envelope', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const governed = canonicalizeRegistrationFormDefinition({
      fields: [
        {
          fieldCode: 'travel_note',
          typeCode: 'short_text',
          label: '出行说明',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 0,
          governance: {
            purposeCode: 'transport_logistics',
            dataClassCode: 'ordinary',
            retentionPolicyCode: 'activity_lifecycle',
            maskingPolicyCode: 'none',
            prefillSourceCode: null,
          },
        },
      ],
    });
    const changed = canonicalizeRegistrationFormDefinition({
      fields: [
        {
          ...governed.definition.fields[0],
          governance: {
            purposeCode: 'equipment_clothing',
            dataClassCode: 'ordinary',
            retentionPolicyCode: 'activity_lifecycle',
            maskingPolicyCode: 'none',
            prefillSourceCode: null,
          },
        },
      ],
    });
    const state = {
      workflowRevision: 12,
      activity: { title: 'B3 governed form hash', allocationModeCode: 'first_come' },
      sessions: [],
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: { definition: governed.definition, schemaHash: governed.schemaHash },
      qualificationRuleSets: { ruleSets: [] },
    };
    const internals = service as unknown as {
      currentState: jest.Mock;
      assertSnapshotFormTarget(target: unknown): void;
    };
    internals.currentState = jest.fn().mockResolvedValue(state);

    const before = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
      service.rebuildCurrent({} as never, 'activity-1', 5),
    ]);
    internals.currentState.mockResolvedValue({
      ...state,
      registrationForm: { definition: changed.definition, schemaHash: changed.schemaHash },
    });
    const after = await Promise.all([
      service.rebuildCurrent({} as never, 'activity-1', 3),
      service.rebuildCurrent({} as never, 'activity-1', 4),
      service.rebuildCurrent({} as never, 'activity-1', 5),
    ]);
    expect(after.map((item) => item.snapshotHash)).not.toEqual(
      before.map((item) => item.snapshotHash),
    );
    expect(() =>
      internals.assertSnapshotFormTarget({
        definition: governed.definition,
        schemaHash: governed.schemaHash,
      }),
    ).not.toThrow();
    try {
      internals.assertSnapshotFormTarget({
        definition: governed.definition,
        schemaHash: '0'.repeat(64),
      });
      throw new Error('expected governed Form snapshot hash mismatch to fail');
    } catch (error) {
      expect(error).toMatchObject({ biz: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID });
    }
  });

  it('recognizes a historical schemaVersion 3 form-bearing proposal for approval compatibility', () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'activity-1',
      true,
      false,
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'activity-1',
      false,
      false,
      false,
    );
    expect(internals.currentState).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      'activity-1',
      true,
      false,
      false,
    );
  });

  it('keeps v2 and v3 mode-free while v4 freezes allocation mode in its stale hash', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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
      false,
    );
  });

  it('emits V6 for every new initial proposal, including an empty Qualification RuleSet target', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    const state = {
      workflowRevision: 11,
      activity: { title: 'initial qualification probe', allocationModeCode: 'qualification_rank' },
      sessions: [],
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: null,
      qualificationRuleSets: { ruleSets: [] },
      selectedTemplateVersionId: null,
      activityPlaces: [],
    };
    internals.currentState = jest.fn().mockResolvedValue(state);
    internals.assertProposalValid = jest.fn();
    internals.toSnapshotV6 = jest.fn().mockReturnValue({ schemaVersion: 6 });

    await expect(service.buildInitial({} as never, 'activity-1')).resolves.toMatchObject({
      schemaVersion: 6,
    });
    expect(internals.toSnapshotV6).toHaveBeenCalledTimes(1);
    expect(internals.currentState).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1',
      true,
      true,
      true,
    );
  });

  it('freezes the complete V6 base and target with canonical local places and null future pointers', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const internals = service as unknown as { currentState: jest.Mock };
    const activity = {
      title: 'V6 local place snapshot',
      activityTypeCode: 'assistance',
      allocationModeCode: 'first_come',
      organizationId: 'organization-1',
      startAt: '2099-01-01T00:00:00.000Z',
      endAt: '2099-01-01T01:00:00.000Z',
      location: 'legacy location',
      description: null,
      capacity: null,
      genderRequirementCode: null,
      registrationDeadline: null,
      registrationNotes: null,
      isPublicRegistration: true,
      requiresInsurance: false,
      registrationSchema: null,
      coverImageUrl: null,
      galleryImageUrls: null,
      content: null,
      locationLongitude: null,
      locationLatitude: null,
      registrationModeCode: null,
      visibilityCode: 'staff',
      defaultCheckInRadiusMeters: null,
      defaultLocationRequired: null,
      archiveWaitingDays: 7,
    };
    internals.currentState = jest.fn().mockResolvedValue({
      workflowRevision: 18,
      activity,
      sessions: [],
      selectedTemplateVersionId: 'selected-retired-template',
      templateVersionId: 'resolved-fallback-template',
      resolvedConfig: { templateVersionId: 'resolved-fallback-template' },
      registrationForm: null,
      qualificationRuleSets: { ruleSets: [] },
      activityPlaces: [
        {
          id: 'place-session',
          sessionId: 'session-z',
          roleCode: 'execution',
          name: '场次地点',
          addressText: '地址 C',
          instruction: null,
          longitude: '113.1234567',
          latitude: '22.1234567',
          coordinateSystemCode: 'wgs84',
          providerCode: 'manual',
          providerPlaceId: 'provider-c',
          visibilityCode: 'staff',
          checkInEligible: true,
          radiusMeters: 500,
          sourcePresetId: 'preset-c',
          workflowRevision: 4,
        },
        {
          id: 'place-null-z',
          sessionId: null,
          roleCode: 'primary',
          name: '活动地点 Z',
          addressText: '地址 Z',
          instruction: '集合',
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'staff',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
          workflowRevision: 1,
        },
        {
          id: 'place-null-a',
          sessionId: null,
          roleCode: 'meeting',
          name: '活动地点 A',
          addressText: '地址 A',
          instruction: null,
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'public',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
          workflowRevision: 2,
        },
      ],
    });

    const snapshot = await service.buildInitial({} as never, 'activity-1');

    expect(snapshot).toMatchObject({
      schemaVersion: 6,
      categoryCode: 'pending_classification',
      plannedSemanticAssignments: [],
      selectedTemplateVersionId: 'selected-retired-template',
      templateVersionId: 'resolved-fallback-template',
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
      contentVisibilitySummary: { visibilityCode: 'staff', isPublicRegistration: true },
    });
    expect(snapshot.activityPlaces.map((place) => place.id)).toEqual([
      'place-null-a',
      'place-null-z',
      'place-session',
    ]);
    expect(Object.keys(snapshot.activityPlaces[0]).sort()).toEqual([
      'addressText',
      'checkInEligible',
      'coordinateSystemCode',
      'id',
      'instruction',
      'latitude',
      'longitude',
      'name',
      'providerCode',
      'providerPlaceId',
      'radiusMeters',
      'roleCode',
      'sessionId',
      'sourcePresetId',
      'visibilityCode',
      'workflowRevision',
    ]);
    expect(snapshot.base).toMatchObject({
      categoryCode: 'pending_classification',
      selectedTemplateVersionId: 'selected-retired-template',
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
    });
    expect(service.parseSnapshot(snapshot as unknown as Prisma.JsonValue)).toEqual(snapshot);

    const invalidFuturePointer = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    invalidFuturePointer.timePolicyPointers = {};
    const { snapshotHash: ignoredPointerHash, ...pointerUnsigned } = invalidFuturePointer;
    void ignoredPointerHash;
    invalidFuturePointer.snapshotHash = hashUnsignedSnapshot(pointerUnsigned);
    try {
      service.parseSnapshot(invalidFuturePointer as Prisma.JsonValue);
      throw new Error('expected a non-null V6 future pointer to fail');
    } catch (error) {
      expect(error).toMatchObject({ biz: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID });
    }

    const invalidPlace = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const invalidPlaceRows = invalidPlace.activityPlaces as Array<Record<string, unknown>>;
    invalidPlaceRows[0].roleCode = 'unknown_role';
    invalidPlaceRows[0].longitude = 'not-a-decimal';
    invalidPlaceRows[0].latitude = 'also-not-a-decimal';
    invalidPlaceRows[0].coordinateSystemCode = 'wgs84';
    const { snapshotHash: ignoredPlaceHash, ...placeUnsigned } = invalidPlace;
    void ignoredPlaceHash;
    invalidPlace.snapshotHash = hashUnsignedSnapshot(placeUnsigned);
    try {
      service.parseSnapshot(invalidPlace as Prisma.JsonValue);
      throw new Error('expected invalid V6 local-place controlled values to fail');
    } catch (error) {
      expect(error).toMatchObject({ biz: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID });
    }

    const invalidBase = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const base = invalidBase.base as Record<string, unknown>;
    const basePlaces = base.activityPlaces as Array<Record<string, unknown>>;
    basePlaces[0].name = '被改写的地点';
    const { snapshotHash: ignoredBaseHash, ...baseUnsigned } = invalidBase;
    void ignoredBaseHash;
    invalidBase.snapshotHash = hashUnsignedSnapshot(baseUnsigned);
    try {
      service.parseSnapshot(invalidBase as Prisma.JsonValue);
      throw new Error('expected a base fact that no longer matches baseSnapshotHash to fail');
    } catch (error) {
      expect(error).toMatchObject({ biz: BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID });
    }
  });

  it('rebuilds a V6 stale hash from local places without adding that read to V2-V5', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const internals = service as unknown as { currentState: jest.Mock };
    const state = {
      workflowRevision: 9,
      activity: {
        title: 'V6 stale place probe',
        activityTypeCode: 'event_support',
        allocationModeCode: 'first_come',
        isPublicRegistration: false,
        visibilityCode: 'staff',
      },
      sessions: [],
      selectedTemplateVersionId: null,
      templateVersionId: null,
      resolvedConfig: { templateVersionId: null },
      registrationForm: null,
      qualificationRuleSets: { ruleSets: [] },
      activityPlaces: [
        {
          id: 'place-1',
          sessionId: null,
          roleCode: 'assembly',
          name: '原地点',
          addressText: '地址',
          instruction: null,
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'staff',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
          workflowRevision: 0,
        },
      ],
    };
    internals.currentState = jest.fn().mockResolvedValue(state);

    const before = await service.rebuildCurrent({} as never, 'activity-1', 6);
    internals.currentState.mockResolvedValue({
      ...state,
      activityPlaces: [{ ...state.activityPlaces[0], name: '更新后的地点' }],
    });
    const after = await service.rebuildCurrent({} as never, 'activity-1', 6);

    expect(after.snapshotHash).not.toBe(before.snapshotHash);
    expect(internals.currentState).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1',
      true,
      true,
      true,
    );
  });

  it('never forwards allocation mode into v2/v3 applyActivity, but does forward V4 and V6 targets', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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
    const input = {
      publish: false,
      publishedByUserId: 'reviewer-1',
      at: new Date('2099-01-01'),
      ...applyActorInput,
    } as never;

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

    await service.apply(
      tx as never,
      'activity-1',
      {
        ...common,
        schemaVersion: 6,
        base: {
          ...common.base,
          activity: { title: 'before', allocationModeCode: 'first_come' },
          qualificationRuleSets: { ruleSets: [] },
          categoryCode: null,
          plannedSemanticAssignments: [],
          selectedTemplateVersionId: null,
          activityPlaces: [],
          timePolicyPointers: null,
          contributionPolicyPointers: null,
          metricSetPointer: null,
          contentVisibilitySummary: { visibilityCode: null, isPublicRegistration: false },
        },
        activity: { title: 'after', allocationModeCode: 'lottery' },
        qualificationRuleSets: { ruleSets: [] },
        categoryCode: null,
        plannedSemanticAssignments: [],
        selectedTemplateVersionId: null,
        activityPlaces: [],
        timePolicyPointers: null,
        contributionPolicyPointers: null,
        metricSetPointer: null,
        contentVisibilitySummary: { visibilityCode: null, isPublicRegistration: false },
      } as never,
      input,
    );

    expect(appliedAllocationModes).toEqual([undefined, undefined, 'lottery', 'lottery']);
  });

  it('keeps template resolution Form-free until v3 explicitly reads its active pointer', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
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

  it('resolves a stored template version by its exact id without legacy lifecycle filters', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const selected = {
      id: 'selected-retired-version',
      defaultRegistrationModeCode: 'selected-registration',
      defaultLocationRequired: null,
      defaultCheckInRadiusMeters: null,
      defaultArchiveWaitingDays: null,
    };
    const tx = {
      activityTemplate: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(selected),
        findFirst: jest.fn(),
      },
    };
    const internals = service as unknown as {
      findTemplate(
        tx: unknown,
        selectedTemplateVersionId: string | null,
        activityTypeCode: string,
      ): Promise<typeof selected | null>;
    };

    await expect(
      internals.findTemplate(tx, 'selected-retired-version', 'legacy-activity-type'),
    ).resolves.toEqual(selected);
    expect(tx.activityTemplate.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'selected-retired-version' },
      select: {
        id: true,
        defaultRegistrationModeCode: true,
        defaultLocationRequired: true,
        defaultCheckInRadiusMeters: true,
        defaultArchiveWaitingDays: true,
      },
    });
    expect(tx.activityTemplate.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the exact legacy active-template fallback when no stored version exists', async () => {
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      { apply: jest.fn() } as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const fallback = {
      id: 'latest-active-legacy-version',
      defaultRegistrationModeCode: 'fallback-registration',
      defaultLocationRequired: null,
      defaultCheckInRadiusMeters: null,
      defaultArchiveWaitingDays: null,
    };
    const tx = {
      activityTemplate: {
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(fallback),
      },
    };
    const internals = service as unknown as {
      findTemplate(
        tx: unknown,
        selectedTemplateVersionId: string | null,
        activityTypeCode: string,
      ): Promise<typeof fallback | null>;
    };

    await expect(internals.findTemplate(tx, null, 'legacy-activity-type')).resolves.toEqual(
      fallback,
    );
    expect(tx.activityTemplate.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.activityTemplate.findFirst).toHaveBeenCalledWith({
      where: { activityTypeCode: 'legacy-activity-type', statusCode: 'active' },
      orderBy: [{ version: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        defaultRegistrationModeCode: true,
        defaultLocationRequired: true,
        defaultCheckInRadiusMeters: true,
        defaultArchiveWaitingDays: true,
      },
    });
  });

  it('runs the proposal application sequence through the capacity projector', async () => {
    const capacityBuckets = { apply: jest.fn() };
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      registrationForms as never,
      qualificationRules as never,
      capacityBuckets as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const calls: string[] = [];
    const internals = service as unknown as Record<string, jest.Mock>;

    // 「刚取消的场次」必须在 applySessions 落库**之前**读:落库之后 DB 里全是 cancelled,
    // 分不出「这次刚取消」与「上次就已经取消」。顺序断言把这一条也钉住。
    internals.resolveNewlyCancelledSessionIds = jest.fn(() => {
      calls.push('newly-cancelled-probe');
      return Promise.resolve([]);
    });
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
    // 联动是模块级对象上的方法(刻意导出成对象而不是裸函数,就是为了能在这里被 spy 住)。
    const effectsSpy = jest
      .spyOn(activitySessionCancellationEffects, 'applyInTransactionTrusted')
      .mockImplementation(() => {
        calls.push('session-cancel-effects');
        return Promise.resolve({
          cancelledIdentityCount: 0,
          revokedCredentialCount: 0,
          notifiedMemberCount: 0,
          populationRevisionBumped: false,
        });
      });
    internals.getTemplateResolution = jest.fn(() => Promise.resolve({ templateVersionId: null }));

    const tx = {
      activityEmergencyInitiation: { findUnique: jest.fn().mockResolvedValue(null) },
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
      ...applyActorInput,
    });

    expect(calls).toEqual([
      'newly-cancelled-probe',
      'activity',
      'sessions',
      'positions',
      'form-rules-batch4',
      'capacity-batch4',
      // 第 5 批曾在这里留一个空桩(applyQrCredentialsPlaceholder);ADV-018 把它换成真联动,
      // 并且必须排在容量投影**之后** —— 投影器才是「该场次还有人占名额就不许取消」那道闸。
      'session-cancel-effects',
      'population-revision',
    ]);
    expect(result.workflowRevision).toBe(9);
    effectsSpy.mockRestore();
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
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const calls: string[] = [];
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.resolveNewlyCancelledSessionIds = jest.fn(() => Promise.resolve([]));
    internals.applyActivity = jest.fn(() => Promise.resolve());
    internals.applySessions = jest.fn(() => Promise.resolve(new Map<string, string>()));
    internals.applyPositions = jest.fn(() => Promise.resolve());
    internals.applyFormAndRulesPlaceholder = jest.fn(() => {
      calls.push('legacy-placeholder');
      return Promise.resolve();
    });
    capacityBuckets.apply.mockResolvedValue(undefined);
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
      {
        publish: false,
        publishedByUserId: 'reviewer-1',
        at: new Date('2099-01-01T00:00:00.000Z'),
        ...applyActorInput,
      },
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

  it('composes approved V6 facts into RuleSnapshot config without invoking an ActivityPlace writer', async () => {
    const activeForm = {
      formVersionId: 'form-version-6',
      version: 6,
      schemaHash: 'f'.repeat(64),
    };
    const activeRuleSets = [
      {
        scope: { sessionId: null, positionId: null },
        ruleSetVersionId: 'rule-set-version-6',
        version: 6,
        definitionHash: 'r'.repeat(64),
      },
    ];
    const forms = {
      currentTarget: jest.fn(),
      activeResolvedConfig: jest.fn(),
      applyPublishedTarget: jest.fn().mockResolvedValue(activeForm),
    };
    const rules = {
      currentTarget: jest.fn(),
      activeResolvedConfig: jest.fn(),
      applyPublishedTarget: jest.fn().mockResolvedValue(activeRuleSets),
    };
    const capacityBuckets = { apply: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityPublishProposalV2Service(
      { get: jest.fn() } as never,
      forms as never,
      rules as never,
      capacityBuckets as never,
      { enqueueSessionCancellation: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.applyActivity = jest.fn().mockResolvedValue(undefined);
    internals.applySessions = jest.fn().mockResolvedValue(new Map<string, string>());
    internals.applyPositions = jest.fn().mockResolvedValue(new Map<string, string>());
    const tx = {
      activity: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ workflowRevision: 4 }),
        update: jest.fn().mockResolvedValue({ workflowRevision: 5 }),
      },
    };
    const frozenConfig = { templateVersionId: 'template-before-approval' };
    const snapshot = {
      schemaVersion: 6,
      activity: { allocationModeCode: 'first_come' },
      sessions: [],
      resolvedConfig: frozenConfig,
      registrationForm: null,
      qualificationRuleSets: { ruleSets: [] },
      categoryCode: 'event_support',
      plannedSemanticAssignments: [{ dimensionCode: 'format', optionCode: 'event_support' }],
      selectedTemplateVersionId: 'selected-template',
      activityPlaces: [
        {
          id: 'place-6',
          sessionId: null,
          roleCode: 'assembly',
          name: '冻结地点',
          addressText: '地址',
          instruction: null,
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'staff',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
          workflowRevision: 3,
        },
      ],
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
      contentVisibilitySummary: { visibilityCode: 'staff', isPublicRegistration: false },
    };

    const result = await service.apply(tx as never, 'activity-1', snapshot as never, {
      publish: false,
      publishedByUserId: 'reviewer-1',
      at: new Date('2099-01-01T00:00:00.000Z'),
      ...applyActorInput,
    });

    expect(result.resolvedConfig).toEqual({
      ...frozenConfig,
      registrationForm: activeForm,
      qualificationRuleSets: activeRuleSets,
      categoryCode: 'event_support',
      plannedSemanticAssignments: [{ dimensionCode: 'format', optionCode: 'event_support' }],
      selectedTemplateVersionId: 'selected-template',
      activityPlaces: snapshot.activityPlaces,
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
      contentVisibilitySummary: { visibilityCode: 'staff', isPublicRegistration: false },
    });
    expect((tx as { activityPlace?: unknown }).activityPlace).toBeUndefined();
  });
});
