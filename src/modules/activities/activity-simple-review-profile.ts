import type { ActivityPublishProposalV2Service } from './activity-publish-proposal-v2.service';
import { hashCanonical } from './activity-publish-review-idempotency';
import type { ActivityTemplateDefinitionV1 } from './activity-template-definition-v1';
import { materializeActivityTemplateTimePolicySelection } from './activity-template-definition-v4';
import {
  materializeActivityTemplateContributionPolicySelection,
  type ActivityTemplateDefinitionV5,
} from './activity-template-definition-v5';

type InitialProposal = Awaited<ReturnType<ActivityPublishProposalV2Service['buildInitial']>>;
export type SimpleReviewFacts = Pick<
  InitialProposal,
  | 'activity'
  | 'sessions'
  | 'registrationForm'
  | 'qualificationRuleSets'
  | 'metricRequirementCode'
  | 'metricSetPointer'
  | 'timePolicyPointers'
  | 'contributionPolicyPointers'
>;
export type SimpleReviewTemplate = ActivityTemplateDefinitionV1 &
  Partial<
    Pick<
      ActivityTemplateDefinitionV5,
      'registrationForm' | 'metricSelection' | 'timePolicySelection' | 'contributionPolicySelection'
    >
  >;
const same = (actual: unknown, expected: unknown) =>
  hashCanonical(actual) === hashCanonical(expected);

/**
 * A closed profile, not evidence that the user saw the template's hidden defaults.
 * Visible instance values below are retained; hidden values must match the exact selected
 * template / existing materializer defaults. Complete typed objects make new proposal fields
 * require an explicit decision here. Shape, current authorization and reference validity remain
 * the caller/builder's responsibility. This only inspects the final proposal; it never repairs it.
 */
export function matchesSimpleReviewProfile(
  facts: SimpleReviewFacts,
  template: SimpleReviewTemplate,
): boolean {
  if (
    facts.sessions.length !== 1 ||
    template.sessions.length !== 1 ||
    facts.qualificationRuleSets.ruleSets.length !== 0
  )
    return false;
  const a = facts.activity,
    d = template.activity;
  const activity: SimpleReviewFacts['activity'] = {
    title: a.title,
    activityTypeCode: a.activityTypeCode,
    allocationModeCode: a.allocationModeCode,
    organizationId: a.organizationId,
    startAt: a.startAt,
    endAt: a.endAt,
    location: a.location,
    description: a.description,
    capacity: a.capacity,
    registrationDeadline: a.registrationDeadline,
    registrationNotes: a.registrationNotes,
    genderRequirementCode: d.genderRequirementCode ?? null,
    isPublicRegistration: d.isPublicRegistration ?? true,
    requiresInsurance: d.requiresInsurance ?? false,
    registrationModeCode: d.registrationModeCode ?? null,
    visibilityCode: d.visibilityCode ?? null,
    defaultLocationRequired: d.defaultLocationRequired ?? null,
    defaultCheckInRadiusMeters: d.defaultCheckInRadiusMeters ?? null,
    archiveWaitingDays: d.archiveWaitingDays ?? 7,
    registrationSchema: null,
    content: null,
    locationLongitude: null,
    locationLatitude: null,
    coverImageUrl: null,
    galleryImageUrls: null,
  };
  if (!same(a, activity)) return false;
  const s = facts.sessions[0],
    t = template.sessions[0];
  if (!s.sessionId || s.positions.length !== 1 || t.positions.length !== 1) return false;
  const p = s.positions[0],
    q = t.positions[0];
  if (!p.positionId) return false;
  const position: typeof p = {
    positionId: p.positionId,
    clientRef: null,
    code: p.code,
    name: p.name,
    attendanceRoleCode: p.attendanceRoleCode,
    capacity: p.capacity,
    startAt: p.startAt,
    endAt: p.endAt,
    genderRequirementCode: q.genderRequirementCode ?? null,
    qualificationRuleSetId: null,
    locationRequired: q.locationRequired ?? null,
    radiusMeters: q.radiusMeters ?? null,
    leaderMemberId: null,
    description: q.description ?? null,
    equipmentNotes: q.equipmentNotes ?? null,
    sortOrder: q.sortOrder,
    cancelled: false,
  };
  const session: typeof s = {
    sessionId: s.sessionId,
    clientRef: null,
    code: s.code,
    name: s.name,
    startAt: s.startAt,
    endAt: s.endAt,
    capacity: s.capacity,
    checkInOpenAt: s.checkInOpenAt,
    checkInCloseAt: s.checkInCloseAt,
    checkOutOpenAt: s.checkOutOpenAt,
    checkOutCloseAt: s.checkOutCloseAt,
    preparationStartAt: s.preparationStartAt,
    locationText: a.location,
    meetingPoint: null,
    executionPoint: null,
    evacuationPoint: null,
    longitude: null,
    latitude: null,
    locationRequired: false,
    radiusMeters: null,
    locationPolicySourceCode: 'template',
    accuracyWarningMeters: 100,
    lateGraceMinutes: t.lateGraceMinutes,
    earlyLeaveThresholdMinutes: t.earlyLeaveThresholdMinutes,
    statusCode: 'scheduled',
    sortOrder: t.sortOrder,
    positions: [position],
  };
  if (!same(s, session)) return false;
  if (!same(facts.registrationForm?.definition ?? null, template.registrationForm ?? null))
    return false;
  const metric = template.metricSelection ?? {
    metricRequirementCode: 'not_required',
    metricSetPointer: null,
  };
  if (
    !same(
      {
        metricRequirementCode: facts.metricRequirementCode,
        metricSetPointer: facts.metricSetPointer,
      },
      metric,
    )
  )
    return false;
  const targets = [
    { id: s.sessionId, code: s.code, positions: [{ id: p.positionId, code: p.code }] },
  ];
  const time = template.timePolicySelection
    ? materializeActivityTemplateTimePolicySelection(template.timePolicySelection, targets)
    : null;
  if (!same(facts.timePolicyPointers?.selection ?? null, time)) return false;
  const contribution = template.contributionPolicySelection
    ? materializeActivityTemplateContributionPolicySelection(
        template.contributionPolicySelection,
        targets,
      ).document
    : null;
  return same(facts.contributionPolicyPointers?.selection ?? null, contribution);
}
