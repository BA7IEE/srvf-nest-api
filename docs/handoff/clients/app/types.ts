// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: App 小程序
// contractVersion: 0.72.0
// generatorVersion: 1.0.0
// inputDigest: sha256:6096050df3c2f50940094744ef894b326707443e9f7bf20bf2269024073120c9

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ActivityPublishReviewResponseDto, ContentAttachmentDto, ContentReadDetailDto, ContentReadListItemDto, PageResultDto, UserLinkedMemberDto, UserResponseDto } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ActivityPublishReviewResponseDto, ContentAttachmentDto, ContentReadDetailDto, ContentReadListItemDto, PageResultDto, UserLinkedMemberDto, UserResponseDto };

export interface AccountAvatarDto {
  "attachmentId": string;
  "accessUrl": string | null;
  "expiresAt": string | null;
}

export interface ActivityCheckInLocationDto {
  "longitude": number;
  "latitude": number;
  "accuracy"?: number;
}

export interface ActivityTemplateResolutionResponseDto {
  "templateVersionId": string | null;
  "activity": Record<string, unknown>;
  "sessions": Record<string, unknown>[];
}

export interface AppActivityAllocationBatchDto {
  "batchId": string;
  "activityId": string;
  "sessionId": string;
  "positionId"?: string | null;
  "modeCode": "qualification_rank" | "lottery";
  "statusCode": "preparing" | "committed" | "voided";
  "algorithmVersionCode": string;
  "randomSeedReveal"?: string | null;
  "committedAt"?: string | null;
  "voidReason"?: string | null;
  "voidedAt"?: string | null;
  "candidates": AppActivityAllocationCandidateDto[];
}

export interface AppActivityAllocationCandidateDto {
  "participationIdentityId": string;
  "registrationId": string;
  "acceptedAt": string;
  "qualificationScore"?: string | null;
  "qualificationResultCode": "pass" | "warn" | "fail";
  "lotteryOrder"?: number | null;
  "resultCode"?: "allocated" | "waitlisted" | "not_selected" | null;
  "waitlistRank"?: number | null;
  "waitlistPositionId"?: string | null;
}

export interface AppActivityAllocationCommandReceiptDto {
  "commandCode": "prepare" | "commit" | "void";
  "responseHash": string;
  "batch": AppActivityAllocationBatchDto;
}

export interface AppActivityArchiveResultDto {
  "activityId": string;
  "statusCode": "archived" | "draft" | "published" | "completed" | "terminated";
  "occurredAt": string;
  "reasonCode"?: "stale_draft" | "settled" | null;
  "archivedFromStatusCode"?: Record<string, unknown> | null;
}

export interface AppActivityChangePositionDto {
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder"?: number;
  "activityPositionId"?: string;
  "clientRef"?: string;
}

export interface AppActivityCheckInDto {
  "id": string;
  "activityId": string;
  "registrationId": string;
  "checkInAt": string;
  "checkOutAt": string | null;
  "checkInDistance": string | null;
  "checkOutDistance": string | null;
  "geoVerified": boolean;
  "outOfRange": boolean;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppActivityControlPlaneStatusDto {
  "mode": "off" | "shadow" | "active";
  "creationAvailability": "unavailable" | "pilot" | "enabled";
}

export interface AppActivityCreationDetailDto {
  "activityId": string;
  "createdAt": string;
  "createdStatusCode": "draft";
}

export interface AppActivityCreationPlaceDto {
  "sessionCode"?: string;
  "roleCode": "primary" | "meeting" | "execution" | "evacuation" | "parking" | "other";
  "visibilityCode": "public" | "accepted" | "staff" | "command";
  "presetId"?: string;
  "inline"?: AppInlineCreationPlaceDto;
}

export interface AppActivityCreationResultDto {
  "activity": AppActivityCreationDetailDto;
  "mode": "quick" | "professional" | "emergency";
  "replayed": boolean;
  "followUpItems": AppEmergencyCreationFollowUpDto[];
}

export interface AppActivityDetailDto {
  "id": string;
  "title": string;
  "description"?: Record<string, unknown> | null;
  "activityTypeCode": string;
  "allocationMode": "first_come" | "qualification_rank" | "lottery";
  "statusCode": string;
  "phase": "upcoming" | "ongoing" | "ended";
  "startAt": string;
  "endAt": string;
  "location": string;
  "capacity"?: Record<string, unknown> | null;
  "registrationDeadline"?: Record<string, unknown> | null;
  "registrationNotes"?: Record<string, unknown> | null;
  "genderRequirementCode"?: string | null;
  "requiresInsurance": boolean;
  "passCount": number;
  "coverImageUrl"?: Record<string, unknown> | null;
  "createdAt": string;
  "registrationMode"?: Record<string, unknown> | null;
  "formVersion"?: number | null;
  "registrationForm"?: AppRegistrationFormDto;
  "myInvitations": AppActivityDetailInvitationDto[];
  "qualification": AppActivityQualificationDto;
  "sessions": AppActivityDetailSessionDto[];
}

export interface AppActivityDetailInvitationDto {
  "invitationId": string;
  "scope": "activity" | "session" | "position";
  "status": "pending" | "accepted" | "declined" | "revoked" | "expired";
  "expiresAt": string;
}

export interface AppActivityDetailSessionDto {
  "id": string;
  "code": string;
  "name": string;
  "startAt": string;
  "endAt": string;
  "locationText": string;
  "capacity"?: Record<string, unknown> | null;
  "positions": AppActivityDetailSessionPositionDto[];
  "qualification": AppActivityQualificationDto;
}

export interface AppActivityDetailSessionPositionDto {
  "id": string;
  "code": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: Record<string, unknown> | null;
  "startAt"?: Record<string, unknown> | null;
  "endAt"?: Record<string, unknown> | null;
  "genderRequirementCode"?: Record<string, unknown> | null;
  "description"?: Record<string, unknown> | null;
  "equipmentNotes"?: Record<string, unknown> | null;
  "sortOrder": number;
  "qualification": AppActivityQualificationDto;
}

export interface AppActivityDirectoryListItemDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "statusCode": "published";
  "startAt": string;
  "endAt": string;
  "location": string;
  "registrationMode"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppActivityFeedbackDto {
  "rating": number;
  "comment": string | null;
  "createdAt": string;
  "updatedAt": string;
  "eligibilityCorrected": boolean;
}

export interface AppActivityFeedbackResponseDto {
  "feedback": AppActivityFeedbackDto;
  "canSubmit": boolean;
  "windowClosesAt": string;
}

export interface AppActivityInitiationOrganizationOptionDto {
  "organizationId": string;
  "name": string;
  "pathLabel": string;
  "source": "membership" | "cross-org-grant";
  "membershipType"?: "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT" | null;
}

export interface AppActivityInvitationDto {
  "invitationId": string;
  "activityId": string;
  "memberId": string;
  "sessionId"?: Record<string, unknown> | null;
  "positionId"?: Record<string, unknown> | null;
  "scope": "activity" | "session" | "position";
  "status": "pending" | "accepted" | "declined" | "revoked" | "expired";
  "expiresAt": string;
  "respondedAt"?: Record<string, unknown> | null;
  "revokedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppActivityLifecycleResultDto {
  "activityId": string;
  "statusCode": "cancelled" | "terminated";
  "occurredAt": string;
  "reason"?: Record<string, unknown> | null;
}

export interface AppActivityPositionDto {
  "activityPositionId": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "remainingCapacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder": number;
  "canRegister": boolean;
}

export interface AppActivityPunchDto {
  "qrToken": string;
  "eventKey": string;
  "longitude"?: number;
  "latitude"?: number;
  "accuracy"?: number;
}

export interface AppActivityPunchReceiptDto {
  "eventId": string;
  "eventTypeCode": "check_in" | "check_out" | "early_departure_close" | "void" | "replace";
  "occurredAt": string;
  "segmentStatusCode": "open" | "closed_valid" | "closed_zero";
  "serverTime": string;
  "distanceMeters"?: string | null;
  "geoVerified": boolean;
  "lowAccuracy": boolean;
  "nextAllowedAction": "check_in" | "check_out";
}

export interface AppActivityPunchStateDto {
  "isPresent": boolean;
  "checkInAt"?: string | null;
  "checkOutAllowedAt"?: string | null;
  "distanceMeters"?: string | null;
  "geoVerified": boolean;
  "lowAccuracy": boolean;
  "serverTime": string;
  "nextAllowedAction": "check_in" | "check_out";
}

export interface AppActivityQualificationDto {
  "resultCode": "pass" | "warn" | "fail";
  "unmetRules": AppActivityQualificationUnmetRuleDto[];
}

export interface AppActivityQualificationRuleDto {
  "ruleTypeCode": "grade" | "gender" | "organization" | "certificate" | "training" | "age" | "insurance";
  "enforcementCode": "block" | "warn";
  "operator": "in" | "in_subtree" | "has_any" | "between" | "covers_activity";
  "codes"?: string[];
  "organizationIds"?: string[];
  "standardIds"?: string[];
  "minYears"?: number | null;
  "maxYears"?: number | null;
  "warnScore": number | null;
  "message": string | null;
  "sortOrder": number;
}

export interface AppActivityQualificationRuleInputDto {
  "ruleTypeCode": "grade" | "gender" | "organization" | "certificate" | "training" | "age" | "insurance";
  "enforcementCode": "block" | "warn";
  "operator": "in" | "in_subtree" | "has_any" | "between" | "covers_activity";
  "codes"?: string[];
  "organizationIds"?: string[];
  "standardIds"?: string[];
  "minYears"?: number | null;
  "maxYears"?: number | null;
  "warnScore"?: number;
  "message"?: string | null;
  "sortOrder": number;
}

export interface AppActivityQualificationRuleScopeDto {
  "sessionId": string | null;
  "positionId": string | null;
}

export interface AppActivityQualificationRuleSetDto {
  "scope": AppActivityQualificationRuleScopeDto;
  "version": number;
  "rules": AppActivityQualificationRuleDto[];
}

export interface AppActivityQualificationRuleSetInputDto {
  "scope": AppActivityQualificationRuleScopeDto;
  "rules": AppActivityQualificationRuleInputDto[];
}

export interface AppActivityQualificationRulesDto {
  "ruleSets": AppActivityQualificationRuleSetDto[];
}

export interface AppActivityQualificationUnmetRuleDto {
  "ruleId": string;
  "enforcementCode": "block" | "warn";
  "resultCode": "warn" | "fail";
  "message": string | null;
  "warnScore": number | null;
}

export interface AppActivityRegistrationAnswerCommandDto {
  "fieldCode": string;
  "value"?: string | number | boolean | unknown[] | Record<string, unknown>;
  "uploadSessionId"?: string;
}

export interface AppActivityRegistrationCommandDto {
  "operationKey": string;
  "formVersion": number | null;
  "answers": AppActivityRegistrationAnswerCommandDto[];
  "preferences": AppActivityRegistrationPreferenceCommandDto[];
}

export interface AppActivityRegistrationCommandReceiptDto {
  "registrationId": string;
  "registrationRevisionId": string;
  "revision": number;
  "submittedAt": string;
}

export interface AppActivityRegistrationPreferenceCommandDto {
  "sessionId": string;
  "positionIds": string[];
}

export interface AppActivityVisitorDto {
  "visitorId": string;
  "activityId": string;
  "sessionId": string;
  "name": string;
  "organization"?: Record<string, unknown> | null;
  "invitedByMemberId"?: Record<string, unknown> | null;
  "note"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppAvailableActivityListItemDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "statusCode": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "capacity"?: Record<string, unknown> | null;
  "registrationDeadline"?: Record<string, unknown> | null;
  "coverImageUrl"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppCapabilityAccountDto {
  "canUseApp": boolean;
  "reason": "MEMBER_NOT_LINKED" | "MEMBER_INACTIVE" | "MEMBER_DELETED" | null;
  "canEditProfile": boolean;
  "canChangePassword": boolean;
}

export interface AppCapabilityActivitiesDto {
  "canViewAvailableActivities": boolean;
  "canRegisterActivity": boolean;
  "canCancelOwnRegistration": boolean;
  "canInitiateActivity": boolean;
  "canDirectPublishOwnActivity": boolean;
}

export interface AppCapabilityAttendanceDto {
  "canViewOwnAttendance": boolean;
}

export interface AppCapabilityCertificatesDto {
  "canViewOwnCertificates": boolean;
}

export interface AppCapabilityManagedDto {
  "canViewManagedActivities": boolean;
  "canManageManagedRegistrations": boolean;
  "canSubmitManagedAttendance": boolean;
  "canReviewActivityPublication": boolean;
  "canFirstReviewAttendance": boolean;
  "canFinalReviewAttendance": boolean;
}

export interface AppCapabilityResponseDto {
  "account": AppCapabilityAccountDto;
  "activities": AppCapabilityActivitiesDto;
  "attendance": AppCapabilityAttendanceDto;
  "certificates": AppCapabilityCertificatesDto;
  "tasks": AppCapabilityTasksDto;
  "managed": AppCapabilityManagedDto;
}

export interface AppCapabilityTasksDto {
  "canViewTasks": boolean;
}

export interface AppCollaboratorOptionDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: string | null;
  "eligibilitySource": "participant" | "organization-member";
}

export interface AppCollaboratorOptionsResponseDto {
  "items": AppCollaboratorOptionDto[];
  "total": number;
  "page": number;
  "pageSize": number;
}

export interface AppCreationPlaceCoordinateDto {
  "longitude": number;
  "latitude": number;
  "coordinateSystemCode": "wgs84" | "gcj02" | "bd09";
}

export interface AppCreationQualificationRuleSetDto {
  "sessionCode"?: string;
  "positionCode"?: string;
  "rules": AppActivityQualificationRuleInputDto[];
}

export interface AppEmergencyActivityCreationDto {
  "operationKey": string;
  "title": string;
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "initiatorMemberId": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "organizationIds"?: string[];
  "memberIds"?: string[];
}

export interface AppEmergencyCreationFollowUpDto {
  "itemCode": "session" | "position" | "detailed_location" | "equipment" | "attendance" | "outcome" | "incident_relation";
  "statusCode": "pending" | "verified" | "unrepresentable";
}

export interface AppEvidenceSealResultDto {
  "sealId": string;
  "activityId": string;
  "sealRevision": number;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "allWindowsClosedAt": string;
  "openSegmentCount": number;
  "manualReviewPendingCount": number;
  "populationCountDistinct": number;
  "populationCountBySession": Record<string, unknown>;
  "contentHash": string;
  "sealedAt": string;
  "supersededSealCount": number;
}

export interface AppGateStatusDto {
  "code": string;
  "professional": boolean;
  "marked": boolean;
  "passed"?: Record<string, unknown> | null;
  "satisfied": boolean;
  "completionDate"?: Record<string, unknown> | null;
  "extendedUntil"?: Record<string, unknown> | null;
}

export interface AppInlineCreationPlaceDto {
  "name": string;
  "addressText": string;
  "instruction"?: string;
  "coordinate"?: AppCreationPlaceCoordinateDto;
  "providerCode"?: string;
  "providerPlaceId"?: string;
  "checkInEligible": boolean;
  "radiusMeters"?: number;
}

export interface AppManagedActivityArchiveCommandDto {
  "reason"?: string;
  "operationKey": string;
}

export interface AppManagedActivityCancelCommandDto {
  "reason": string;
  "strongConfirmed": boolean;
  "operationKey": string;
}

export interface AppManagedActivityCheckInDto {
  "id": string;
  "activityId": string;
  "registrationId": string;
  "member": AppManagedAttendanceMemberDto;
  "checkInAt": string;
  "checkOutAt": string | null;
  "checkInDistance": string | null;
  "checkOutDistance": string | null;
  "geoVerified": boolean;
  "outOfRange": boolean;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedActivityCloneCommandDto {
  "title"?: string;
  "organizationId"?: string;
}

export interface AppManagedActivityCloneResultDto {
  "activityId": string;
}

export interface AppManagedActivityClosureDto {
  "attendanceDeclaredCompleteAt"?: string | null;
  "status": "draft" | "publish-review-pending" | "published" | "cancelled" | "waiting-attendance-declaration" | "attendance-first-review" | "attendance-returned" | "attendance-final-review" | "closed" | "archived";
  "nextAction"?: string | null;
}

export interface AppManagedActivityCountsDto {
  "pendingRegistrations": number;
  "waitlistedRegistrations": number;
  "attendanceSheets": number;
  "unresolvedAttendanceSheets": number;
}

export interface AppManagedActivityDetailDto {
  "activity": AppManagedActivityProjectionDto;
  "initiator"?: AppManagedMemberSummaryDto;
  "owner"?: AppManagedMemberSummaryDto;
  "myResponsibility"?: AppManagedMyResponsibilityDto;
  "publishReview": AppManagedPublishReviewSummaryDto;
  "counts": AppManagedActivityCountsDto;
  "closure": AppManagedActivityClosureDto;
}

export interface AppManagedActivityListItemDto {
  "activityId": string;
  "title": string;
  "statusCode": string;
  "startAt": string;
  "endAt": string;
  "relationship": "initiator" | "owner" | "collaborator";
  "pendingRegistrations": number;
  "unresolvedAttendanceSheets": number;
  "nextAction"?: string | null;
  "staleDraft": boolean;
}

export interface AppManagedActivityOnsiteParticipationReceiptDto {
  "registrationId": string;
  "registrationRevisionId": string;
  "participationIdentityId": string;
  "participationRevisionId": string;
  "statusCode": "pass";
  "sourceCode": "onsite";
  "positionId": string | null;
  "approvedAt": string;
}

export interface AppManagedActivityPositionDto {
  "activityPositionId": string;
  "activityId": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedActivityProjectionDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "description"?: string | null;
  "capacity"?: number | null;
  "statusCode": string;
  "workflowRevision": number;
  "requiresInsurance": boolean;
  "isPublicRegistration": boolean;
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused" | null;
  "visibilityCode"?: "internal" | "invitation" | null;
  "defaultCheckInRadiusMeters"?: number | null;
  "defaultLocationRequired"?: boolean | null;
  "archiveWaitingDays": number;
  "coverImageUrl"?: string | null;
  "galleryImageUrls": string[];
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedActivitySessionDto {
  "sessionId": string;
  "activityId": string;
  "code": string;
  "name": string;
  "startAt": string;
  "endAt": string;
  "locationText": string;
  "meetingPoint"?: string | null;
  "executionPoint"?: string | null;
  "evacuationPoint"?: string | null;
  "capacity"?: number | null;
  "checkInOpenAt": string;
  "checkInCloseAt": string;
  "checkOutOpenAt": string;
  "checkOutCloseAt": string;
  "preparationStartAt"?: string | null;
  "locationRequired": boolean;
  "radiusMeters"?: number | null;
  "locationPolicySourceCode": "system" | "template" | "activity" | "session" | "position";
  "accuracyWarningMeters": number;
  "lateGraceMinutes": number;
  "earlyLeaveThresholdMinutes": number;
  "statusCode": string;
  "workflowRevision": number;
  "sortOrder": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedActivitySessionPositionDto {
  "positionId": string;
  "activityId": string;
  "sessionId": string;
  "code": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "locationRequired"?: boolean | null;
  "radiusMeters"?: number | null;
  "leaderMemberId"?: string | null;
  "description"?: string | null;
  "equipmentNotes"?: string | null;
  "sortOrder": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedActivityTerminateCommandDto {
  "reason": string;
  "operationKey": string;
}

export interface AppManagedActivityUnarchiveCommandDto {
  "reason"?: string;
  "operationKey": string;
}

export interface AppManagedAttendanceDraftAbsentDto {
  "registrationId": string;
  "memberId": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AppManagedAttendanceDraftFlagDto {
  "registrationId": string;
  "memberId": string;
  "noCheckOut": boolean;
  "outOfRange": boolean;
  "unverified": boolean;
}

export interface AppManagedAttendanceDraftRecordDto {
  "memberId": string;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": number;
  "attendanceStatusCode": string;
  "registrationId": string;
}

export interface AppManagedAttendanceMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AppManagedAttendanceQrCredentialDto {
  "credentialId": string;
  "activityId": string;
  "sessionId": string;
  "actionCode": "check_in" | "check_out";
  "credentialVersion": number;
  "statusCode": "active" | "revoked" | "expired";
  "validFrom": string;
  "validUntil": string;
  "issuedAt": string;
  "revokedAt"?: string | null;
}

export interface AppManagedAttendanceRecordDto {
  "id": string;
  "sheetId": string;
  "memberId": string;
  "member": AppManagedAttendanceMemberDto;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": string;
  "attendanceStatusCode": string;
  "note": string | null;
  "registrationId": string | null;
  "contributionPoints": string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedAttendanceRecordInputDto {
  "memberId": string;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours"?: number;
  "attendanceStatusCode": string;
  "note"?: string;
  "registrationId"?: string;
}

export interface AppManagedAttendanceSheetDetailDto {
  "sheet": AppManagedAttendanceSheetDto;
  "records": AppManagedAttendanceRecordDto[];
}

export interface AppManagedAttendanceSheetDraftDto {
  "activityId": string;
  "records": AppManagedAttendanceDraftRecordDto[];
  "flags": AppManagedAttendanceDraftFlagDto[];
  "absentRegistrations": AppManagedAttendanceDraftAbsentDto[];
}

export interface AppManagedAttendanceSheetDto {
  "id": string;
  "activityId": string;
  "submitterUserId": string;
  "submittedAt": string;
  "statusCode": "pending" | "pending_final_review" | "returned" | "approved" | "rejected" | "final_rejected";
  "reviewerUserId": string | null;
  "reviewedAt": string | null;
  "reviewNote": string | null;
  "finalReviewerUserId": string | null;
  "finalReviewedAt": string | null;
  "finalReviewNote": string | null;
  "lastSubmittedByUserId": string | null;
  "lastSubmittedAt": string | null;
  "returnedByUserId": string | null;
  "returnedAt": string | null;
  "returnNote": string | null;
  "returnedFromStageCode": "first" | "final" | null;
  "version": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedAttendanceSheetListItemDto {
  "id": string;
  "activityId": string;
  "submitterUserId": string;
  "submittedAt": string;
  "statusCode": "pending" | "pending_final_review" | "returned" | "approved" | "rejected" | "final_rejected";
  "reviewedAt": string | null;
  "version": number;
  "createdAt": string;
}

export interface AppManagedBulkPunchJobDto {
  "operationKey": string;
  "actionCode": "check_in" | "check_out";
  "reason": string;
  "participationIdentityIds"?: string[];
  "selection"?: AppManagedBulkPunchSelectionDto;
  "location"?: AppManagedOnsiteLocationDto;
}

export interface AppManagedBulkPunchSelectionDto {
  "mode"?: "session-all";
  "statusCodes"?: string[];
  "positionId"?: string;
}

export interface AppManagedImportExecuteDto {
  "operationKey": string;
  "fileDigest": string;
  "parserVersion": "attendance-import-csv/v1";
  "previewHash": string;
}

export interface AppManagedImportPreviewDto {
  "jobId": string;
  "statusCode": string;
  "total": number;
  "succeeded": number;
  "failed": number;
  "skipped": number;
  "fileDigest": string;
  "parserVersion": string;
  "previewHash": string;
  "items": AppManagedImportPreviewItemPageDto;
}

export interface AppManagedImportPreviewItemDto {
  "line": number;
  "statusCode": string;
  "lastErrorCode"?: Record<string, unknown> | null;
  "safeMessage"?: Record<string, unknown> | null;
}

export interface AppManagedImportPreviewItemPageDto {
  "items": AppManagedImportPreviewItemDto[];
  "total": number;
  "page": number;
  "pageSize": number;
}

export interface AppManagedMemberSummaryDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: string | null;
}

export interface AppManagedMyResponsibilityDto {
  "responsibilityType": "owner" | "collaborator";
  "canManageRegistrations": boolean;
  "canManageAttendance": boolean;
}

export interface AppManagedOfflineOperationDto {
  "operationKey": string;
  "reason": string;
}

export interface AppManagedOfflinePackageDto {
  "id": string;
  "activityId": string;
  "sessionId": string;
  "deviceId": string;
  "packageVersion": number;
  "packageKeyVersion": 0;
  "statusCode": "active" | "review_required" | "revoked" | "expired";
  "validFrom": string;
  "validUntil": string;
  "uploadUntil": string;
  "sequenceStart": number;
  "nextExpectedSequence": number;
  "ruleSnapshotHash": string;
  "workflowRevision": number;
  "participantSnapshotHash": string;
}

export interface AppManagedOfflinePackageIssueDto {
  "operationKey": string;
  "deviceId": string;
}

export interface AppManagedOfflinePackageIssueReceiptDto {
  "package": AppManagedOfflinePackageDto;
  "packageToken": string;
}

export interface AppManagedOfflineReviewItemDto {
  "id": string;
  "packageId": string;
  "sessionId": string;
  "sequence": number;
  "eventKey": string;
  "statusCode": "pending" | "approved" | "rejected";
  "anomalyCode": "operator_authorization_revoked" | "package_revoked" | "package_expired" | "device_mismatch" | "sequence_gap" | "sequence_duplicate" | "future_time" | "time_out_of_window" | "hash_chain_invalid" | "signature_invalid" | "participant_snapshot_mismatch";
  "approvalPolicyCode": "approvable" | "reject_only";
  "participationIdentityId": string | null;
  "actionCode": "check_in" | "check_out" | null;
  "deviceTime": string | null;
  "stagedAt": string;
  "reviewedAt": string | null;
  "reviewReason": string | null;
  "formalPunchEventId": string | null;
}

export interface AppManagedOfflineUploadDto {
  "packageToken": string;
  "sequence": number;
  "priorHash": string;
  "eventKey": string;
  "actionCode": "check_in" | "check_out";
  "deviceTime": string;
  "memberCredential": string;
  "location"?: AppManagedOnsiteLocationDto;
  "signature": string;
}

export interface AppManagedOnsiteBatchJobReceiptDto {
  "jobId": string;
  "statusCode": "pending" | "processing" | "succeeded" | "partial_failed" | "failed";
  "total": number;
  "succeeded": number;
  "failed": number;
  "skipped": number;
  "replayed": boolean;
}

export interface AppManagedOnsiteLocationDto {
  "longitude"?: number;
  "latitude"?: number;
  "accuracy"?: number;
}

export interface AppManagedProxyPunchDto {
  "actionCode": "check_in" | "check_out";
  "eventKey": string;
  "participationIdentityId": string;
  "reason": string;
  "location"?: AppManagedOnsiteLocationDto;
}

export interface AppManagedPublishReviewSummaryDto {
  "latestRequestId"?: string | null;
  "requestType"?: "initial" | "change" | null;
  "status"?: "pending" | "approved" | "returned" | "withdrawn" | "cancelled" | null;
  "reviewNote"?: string | null;
  "canDirectPublish": boolean;
}

export interface AppManagedRegistrationBulkFailureDto {
  "id": string;
  "code": number;
  "message": string;
}

export interface AppManagedRegistrationBulkResponseDto {
  "succeeded": string[];
  "failed": AppManagedRegistrationBulkFailureDto[];
}

export interface AppManagedRegistrationDto {
  "registrationId": string;
  "activityId": string;
  "memberId": string;
  "statusCode": string;
  "registeredAt": string;
  "reviewedAt": string | null;
  "reviewNote": string | null;
  "extras": Record<string, unknown> | null;
  "cancelledAt": string | null;
  "cancelReason": string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppManagedRegistrationFormDto {
  "version": number;
  "fields": AppManagedRegistrationFormFieldDto[];
}

export interface AppManagedRegistrationFormFieldDto {
  "fieldCode": string;
  "typeCode": "short_text" | "long_text" | "number" | "date" | "single_choice" | "multi_choice" | "file" | "confirmation";
  "label": string;
  "helpText"?: string | null;
  "required": boolean;
  "visibilityCode": "self_and_registration_staff" | "self_and_owner" | "self_only";
  "exportable": boolean;
  "sortOrder": number;
  "minValue"?: string | null;
  "maxValue"?: string | null;
  "minLength"?: number | null;
  "maxLength"?: number | null;
  "maxSelections"?: number | null;
  "options"?: AppRegistrationFormChoiceDto[] | null;
  "governance"?: AppManagedRegistrationFormFieldGovernanceDto;
}

export interface AppManagedRegistrationFormFieldGovernanceDto {
  "purposeCode": "transport_logistics" | "accommodation_logistics" | "dietary_accommodation" | "equipment_clothing" | "activity_specific_note" | "file_confirmation";
  "dataClassCode": "ordinary" | "sensitive";
  "retentionPolicyCode": "activity_lifecycle";
  "maskingPolicyCode": "none";
  "prefillSourceCode": string | null;
}

export interface AppManagedRegistrationListItemDto {
  "registrationId": string;
  "activityId": string;
  "activityPosition": AppManagedRegistrationPositionDto;
  "member": AppManagedRegistrationMemberDto;
  "statusCode": string;
  "waitlistPosition": number | null;
  "registeredAt": string;
  "reviewedAt": string | null;
  "cancelledAt": string | null;
  "createdAt": string;
}

export interface AppManagedRegistrationMemberDto {
  "id": string;
  "memberNo": string | null;
  "realName": string | null;
  "nickname": string | null;
  "label": string | null;
}

export interface AppManagedRegistrationPositionDto {
  "activityPositionId": string;
  "name": string;
}

export interface AppManagedResponsibilitiesDto {
  "activityId": string;
  "initiator"?: AppManagedMemberSummaryDto;
  "owner"?: AppManagedResponsibilityAssignmentDto;
  "collaborators": AppManagedResponsibilityAssignmentDto[];
  "legacyUnassigned": boolean;
}

export interface AppManagedResponsibilityAssignmentDto {
  "id": string;
  "activityId": string;
  "memberId": string;
  "responsibilityType": "owner" | "collaborator";
  "canManageRegistrations": boolean;
  "canManageAttendance": boolean;
  "status": "active" | "ended" | "revoked";
  "startedAt": string;
  "endedAt"?: string | null;
  "assignedByUserId": string;
  "endedByUserId"?: string | null;
  "source": string;
  "reason"?: string | null;
  "member": AppManagedMemberSummaryDto;
}

export interface AppManagedStaffScanDto {
  "actionCode": "check_in" | "check_out";
  "eventKey": string;
  "manualConfirmation"?: AppManagedStaffScanManualConfirmationDto;
  "memberCredential"?: string;
  "location"?: AppManagedOnsiteLocationDto;
}

export interface AppManagedStaffScanManualConfirmationDto {
  "participationIdentityId": string;
  "reason": string;
}

export interface AppMeAccountDto {
  "userId": string;
  "username": string;
  "email": Record<string, unknown> | null;
  "status": "ACTIVE" | "DISABLED";
  "lastLoginAt": Record<string, unknown> | null;
  "linkedMemberId": Record<string, unknown> | null;
  "canUseApp": boolean;
  "appAccessReason": "MEMBER_NOT_LINKED" | "MEMBER_INACTIVE" | "MEMBER_DELETED" | null;
}

export interface AppMePhoneDto {
  "phone"?: Record<string, unknown> | null;
  "phoneVerifiedAt"?: Record<string, unknown> | null;
}

export interface AppMeResponseDto {
  "userId": string;
  "username": string;
  "email": Record<string, unknown> | null;
  "nickname": Record<string, unknown> | null;
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
  "status": "ACTIVE" | "DISABLED";
  "memberId": Record<string, unknown> | null;
  "memberNo": Record<string, unknown> | null;
  "realName": Record<string, unknown> | null;
  "memberLabel": Record<string, unknown> | null;
  "gradeCode": Record<string, unknown> | null;
  "memberStatus": "ACTIVE" | "INACTIVE" | null;
  "canUseApp": boolean;
  "appAccessReason": "MEMBER_NOT_LINKED" | "MEMBER_INACTIVE" | "MEMBER_DELETED" | null;
}

export interface AppMeWechatDto {
  "bound": boolean;
  "openidMasked"?: Record<string, unknown> | null;
}

export interface AppMeWecomDto {
  "bound": boolean;
  "wecomUserIdMasked"?: Record<string, unknown> | null;
  "boundAt"?: Record<string, unknown> | null;
}

export interface AppMyActivityBatchJobActivityDto {
  "id": string;
  "title": string;
  "statusCode": string;
}

export interface AppMyActivityBatchJobCreatorDto {
  "memberId": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AppMyActivityBatchJobDetailDto {
  "jobId": string;
  "jobTypeCode": "settlement_prepare" | "bulk_proxy" | "import_preview" | "import_execute" | "export" | "notification_expand" | "reconciliation";
  "activity": AppMyActivityBatchJobActivityDto;
  "createdBy": AppMyActivityBatchJobCreatorDto;
  "statusCode": "pending" | "processing" | "succeeded" | "partial_failed" | "failed" | "cancelled" | "dead";
  "total": number;
  "succeeded": number;
  "failed": number;
  "skipped": number;
  "leaseStateText": string;
  "retryStateText": string;
  "createdAt": string;
  "startedAt": Record<string, unknown> | null;
  "completedAt": Record<string, unknown> | null;
  "retryFailedAllowed": boolean;
  "cancelAllowed": boolean;
}

export interface AppMyActivityBatchJobItemDto {
  "itemId": string;
  "itemKey": string;
  "statusCode": string;
  "attempts": number;
  "lastErrorCode": Record<string, unknown> | null;
  "safeMessage": Record<string, unknown> | null;
}

export interface AppMyActivityBatchJobListItemDto {
  "jobId": string;
  "jobTypeCode": "settlement_prepare" | "bulk_proxy" | "import_preview" | "import_execute" | "export" | "notification_expand" | "reconciliation";
  "activity": AppMyActivityBatchJobActivityDto;
  "createdBy": AppMyActivityBatchJobCreatorDto;
  "statusCode": "pending" | "processing" | "succeeded" | "partial_failed" | "failed" | "cancelled" | "dead";
  "total": number;
  "succeeded": number;
  "failed": number;
  "skipped": number;
  "leaseStateText": string;
  "retryStateText": string;
  "createdAt": string;
  "startedAt": Record<string, unknown> | null;
  "completedAt": Record<string, unknown> | null;
}

export interface AppMyActivityListItemDto {
  "activityId": string;
  "title": string;
  "activityTypeCode": string;
  "statusCode": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "coverImageUrl"?: Record<string, unknown> | null;
  "myRegistrationId": string;
  "myRegistrationStatusCode": string;
  "myRegisteredAt": string;
}

export interface AppMyAttendanceRecordDto {
  "id": string;
  "activityId": string;
  "activityTitle": string;
  "activityStartAt": string;
  "activityEndAt": string;
  "activityCoverImageUrl"?: Record<string, unknown> | null;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": string;
  "attendanceStatusCode": string;
  "note"?: Record<string, unknown> | null;
  "contributionPoints"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppMyCertificateDto {
  "id": string;
  "standardId": string;
  "standardName": string;
  "certCategoryCode": string;
  "certLevelCode"?: string | null;
  "issuingOrg": string;
  "certNumber"?: Record<string, unknown> | null;
  "issuedAt": string;
  "expiredAt"?: Record<string, unknown> | null;
  "certStatusCode": string;
  "isInternal": boolean;
  "verifyNote"?: Record<string, unknown> | null;
  "verifiedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppMyInsuranceDto {
  "id": string;
  "insurerName": string;
  "policyNumber": string;
  "coverageStart"?: Record<string, unknown> | null;
  "coverageEnd": string;
  "createdAt": string;
  "reviewStatusCode": string;
  "version": number;
  "reviewedAt"?: Record<string, unknown> | null;
}

export interface AppMyParticipationLedgerTotalsDto {
  "committedServiceHours": string;
  "committedContributionPoints": string;
  "inFlightServiceHours": string;
  "inFlightContributionPoints": string;
}

export interface AppMyParticipationSummaryDto {
  "totalServiceHours": string;
  "activityCount": number;
  "recordCount": number;
  "contributionPoints": string;
  "ledgerTotals": AppMyParticipationLedgerTotalsDto;
}

export interface AppMyRegistrationDto {
  "id": string;
  "activityId": string;
  "statusCode": string;
  "waitlistPosition": number | null;
  "registeredAt": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "reviewNote"?: Record<string, unknown> | null;
  "extras"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "cancelReason"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AppMyRegistrationListItemDto {
  "id": string;
  "activityId": string;
  "activityTitle": string;
  "activityStartAt": string;
  "activityEndAt": string;
  "activityCoverImageUrl"?: Record<string, unknown> | null;
  "statusCode": string;
  "waitlistPosition": number | null;
  "registeredAt": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface AppParticipationLedgerEntryDto {
  "entryKey": string;
  "activityId": string;
  "sessionId": string;
  "participationIdentityId": string;
  "ledgerDate": string;
  "entryTypeCode": string;
  "serviceHoursDelta": number;
  "recognizedPointsDelta": number;
  "creditedPointsDelta": number;
  "cappedOutPointsDelta": number;
}

export interface AppProfessionalActivityCreationDto {
  "operationKey": string;
  "title": string;
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "initiatorMemberId"?: string;
  "description"?: string;
  "capacity"?: number | null;
  "genderRequirementCode"?: string;
  "registrationDeadline"?: string | null;
  "registrationNotes"?: string;
  "isPublicRegistration"?: boolean;
  "requiresInsurance"?: boolean;
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused";
  "visibilityCode"?: "internal" | "invitation";
  "defaultLocationRequired"?: boolean;
  "defaultCheckInRadiusMeters"?: number;
  "archiveWaitingDays"?: number;
  "sessions": AppProfessionalCreationSessionDto[];
  "places"?: AppActivityCreationPlaceDto[];
  "form"?: ManagedRegistrationFormDefinitionInputDto;
  "qualificationRuleSets"?: AppCreationQualificationRuleSetDto[];
}

export interface AppProfessionalCreationSessionDto {
  "session": CreateAppManagedActivitySessionDto;
  "positions": CreateAppManagedActivitySessionPositionDto[];
}

export interface AppQuickActivityCreationDto {
  "operationKey": string;
  "title": string;
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "templateVersionId": string;
  "initiatorMemberId"?: string;
  "confirmedCapacity"?: number | null;
  "defaultPlaceVisibilityCode": "public" | "accepted" | "staff" | "command";
  "places"?: AppActivityCreationPlaceDto[];
}

export interface AppRegistrationFormChoiceDto {
  "value": string;
  "label": string;
}

export interface AppRegistrationFormDto {
  "version": number;
  "fields": AppRegistrationFormFieldDto[];
}

export interface AppRegistrationFormFieldDto {
  "fieldCode": string;
  "typeCode": "short_text" | "long_text" | "number" | "date" | "single_choice" | "multi_choice" | "file" | "confirmation";
  "label": string;
  "helpText"?: string | null;
  "required": boolean;
  "visibilityCode": "self_and_registration_staff" | "self_and_owner" | "self_only";
  "exportable": boolean;
  "sortOrder": number;
  "minValue"?: string | null;
  "maxValue"?: string | null;
  "minLength"?: number | null;
  "maxLength"?: number | null;
  "maxSelections"?: number | null;
  "options"?: AppRegistrationFormChoiceDto[] | null;
}

export interface AppRegistrationUploadAttachmentDto {
  "attachmentId": string;
  "originalName": string;
  "mime": string;
  "size": number;
  "createdAt": string;
}

export interface AppRegistrationUploadSessionCreatedDto {
  "id": string;
  "token": string;
  "expiresAt": string;
  "formVersion": number;
}

export interface AppSelfProfileDto {
  "userId": string;
  "memberId": string;
  "username": string;
  "nickname": Record<string, unknown> | null;
  "memberNo": string;
  "realName": string;
  "memberLabel": string;
  "memberStatus": "ACTIVE" | "INACTIVE";
  "hasMemberProfile": boolean;
}

export interface AppSettlementCloseCheckDto {
  "gapCode": string;
  "bizCode": number;
  "passed": boolean;
  "count": number;
}

export interface AppSettlementCloseCommandDto {
  "operationKey": string;
  "expectedSettlementVersionId": string;
  "expectedPostingBatchId": string;
}

export interface AppSettlementCloseGapDto {
  "gapCode": string;
  "bizCode": number;
  "message": string;
  "count": number;
}

export interface AppSettlementCloseResponseDto {
  "outcome": "closed" | "blocked";
  "activityId": string;
  "settlementRunId"?: string | null;
  "closureRevisionId"?: string | null;
  "revision"?: number | null;
  "settlementVersionId"?: string | null;
  "postingBatchId"?: string | null;
  "closedAt"?: string | null;
  "archiveWaitingUntil"?: string | null;
  "checks": AppSettlementCloseCheckDto[];
  "gaps": AppSettlementCloseGapDto[];
  "replayed"?: boolean | null;
}

export interface AppSettlementClosureSummaryDto {
  "id": string;
  "revision": number;
  "statusCode": string;
  "settlementVersionId": string;
  "postingBatchId": string;
  "closedAt": string;
}

export interface AppSettlementGapDto {
  "gapCode": string;
  "count": number;
}

export interface AppSettlementGenerateCommandDto {
  "operationKey": string;
}

export interface AppSettlementGenerateResponseDto {
  "outcome": "draft" | "job";
  "activityId": string;
  "settlementRunId"?: string | null;
  "settlementVersionId"?: string | null;
  "settlementVersion"?: number | null;
  "personCount"?: number | null;
  "sessionParticipationCount"?: number | null;
  "jobId"?: string | null;
  "statusCode"?: string | null;
  "total"?: number | null;
  "replayed": boolean;
}

export interface AppSettlementItemDto {
  "identityId": string;
  "decisionCode": "pending" | "determined";
  "session": AppSettlementItemSessionDto;
  "member": AppSettlementItemMemberDto;
  "resultCode"?: "present" | "leave" | "absent" | "cancelled" | "not_selected" | "waitlist_expired" | "review_expired" | "invitation_expired" | "exempt" | "early_departure_zero" | null;
  "recognizedServiceHours"?: number | null;
  "recognizedContributionPoints"?: number | null;
  "calculatedServiceHours"?: number | null;
  "calculatedContributionPoints"?: number | null;
  "adjustmentReason"?: string | null;
  "lateFlag"?: boolean | null;
  "earlyLeaveFlag"?: boolean | null;
}

export interface AppSettlementItemMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AppSettlementItemSessionDto {
  "id": string;
  "code": string;
  "name": string;
}

export interface AppSettlementResubmitCommandDto {
  "operationKey": string;
  "evidenceSealId": string;
  "expectedDraftVersion": number;
  "confirmation": boolean;
}

export interface AppSettlementRunSummaryDto {
  "id": string;
  "statusCode": string;
  "currentDraftVersion"?: number | null;
  "currentSubmittedVersion"?: number | null;
  "currentPostedVersion"?: number | null;
  "currentClosureRevision"?: number | null;
}

export interface AppSettlementSealRevisionDto {
  "id": string;
  "sealRevision": number;
  "statusCode": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "manualReviewPendingCount": number;
  "sealedAt": string;
}

export interface AppSettlementSealSummaryDto {
  "id": string;
  "sealRevision": number;
  "statusCode": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "manualReviewPendingCount": number;
}

export interface AppSettlementSubmitCommandDto {
  "operationKey": string;
  "expectedDraftVersion": number;
  "evidenceSealId": string;
  "confirmation": boolean;
}

export interface AppSettlementSubmitResponseDto {
  "activityId": string;
  "settlementRunId": string;
  "settlementVersionId": string;
  "settlementVersion": number;
  "priorVersionId": string | null;
  "draftVersionId": string | null;
  "evidenceSealId": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "sealRevision": number;
  "personCount": number;
  "sessionParticipationCount": number;
  "serviceSegmentCount": number;
  "resultRowCount": number;
  "contentHash": string;
  "replayed": boolean;
}

export interface AppSettlementUpdateDraftItemDto {
  "expectedDraftVersion": number;
  "resultCode": "present" | "leave" | "absent" | "cancelled" | "not_selected" | "waitlist_expired" | "review_expired" | "invitation_expired" | "exempt";
  "recognizedServiceHours": number;
  "recognizedContributionPoints": number;
  "reason": string;
}

export interface AppSettlementUpdatedDraftItemResponseDto {
  "settlementVersionId": string;
  "settlementVersion": number;
  "identityId": string;
  "resultCode": "present" | "leave" | "absent" | "cancelled" | "not_selected" | "waitlist_expired" | "review_expired" | "invitation_expired" | "exempt" | "early_departure_zero";
  "recognizedServiceHours": number;
  "recognizedContributionPoints": number;
  "calculatedServiceHours": number;
  "calculatedContributionPoints": number;
  "adjustmentReason"?: string | null;
  "lateFlag": boolean;
  "earlyLeaveFlag": boolean;
}

export interface AppSettlementVersionDetailHeaderDto {
  "id": string;
  "version": number;
  "statusCode": string;
  "evidenceSealId": string;
  "submittedAt"?: string | null;
  "contentHash": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "personCount": number;
  "sessionParticipationCount": number;
  "serviceSegmentCount": number;
  "priorVersionId"?: string | null;
  "returnFromStage"?: string | null;
  "returnReason"?: string | null;
}

export interface AppSettlementVersionDetailResponseDto {
  "version": AppSettlementVersionDetailHeaderDto;
  "diff": AppSettlementVersionDiffDto;
  "sealRevisions": AppSettlementSealRevisionDto[];
}

export interface AppSettlementVersionDiffDto {
  "priorVersionId"?: string | null;
  "addedItemCount": number;
  "removedItemCount": number;
  "changedItemCount": number;
}

export interface AppSettlementVersionPointerDto {
  "id": string;
  "version": number;
  "statusCode": string;
  "evidenceSealId": string;
  "submittedAt"?: string | null;
}

export interface AppSettlementWorkbenchResponseDto {
  "activityId": string;
  "run"?: AppSettlementRunSummaryDto;
  "seal"?: AppSettlementSealSummaryDto;
  "draft"?: AppSettlementVersionPointerDto;
  "submitted"?: AppSettlementVersionPointerDto;
  "posted"?: AppSettlementVersionPointerDto;
  "closure"?: AppSettlementClosureSummaryDto;
  "gaps": AppSettlementGapDto[];
}

export interface AppSubmitActivityChangeReviewDto {
  "activity": UpdateAppManagedActivityDto;
  "positions"?: AppActivityChangePositionDto[];
}

export interface AppTeamJoinApplicationDto {
  "id": string;
  "cycleId": string;
  "cycleName": string;
  "cycleYear": number;
  "statusCode": string;
  "targetOrganizationIds": string[];
  "openOrganizationIds": string[];
  "maxTargetOrgs": number;
  "selectedOrganizationId"?: Record<string, unknown> | null;
  "gates": AppGateStatusDto[];
  "generalGatesSatisfied": boolean;
  "contributionPoints": string;
  "contributionSatisfied": boolean;
  "evaluationNote"?: Record<string, unknown> | null;
  "eliminationStage"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface ApproveAppManagedRegistrationDto {
  "reviewNote"?: string;
}

export interface BindMyPhoneDto {
  "phone": string;
  "code": string;
  "stepUpToken": string;
}

export interface BindMyWechatDto {
  "code": string;
  "stepUpToken": string;
}

export interface BindMyWecomDto {
  "code": string;
  "state": string;
  "stepUpToken": string;
}

export interface BulkReviewAppManagedRegistrationsDto {
  "ids": string[];
  "reviewNote"?: string;
}

export interface CancelAppManagedRegistrationDto {
  "cancelReason"?: string;
}

export interface CancelAppMyRegistrationDto {
  "cancelReason"?: string;
}

export interface ChangeMyPasswordDto {
  "oldPassword": string;
  "newPassword": string;
}

export interface ChangeReviewDto {
  "operationKey": string;
  "confirmation": boolean;
  "activityPatch": UpdateAppManagedActivityDto;
  "sessions": ChangeReviewSessionCollectionsDto;
  "positions": ChangeReviewSessionPositionCollectionsDto;
  "registrationForm"?: ManagedRegistrationFormDefinitionInputDto;
  "qualificationRuleSets"?: ChangeReviewQualificationRuleSetCollectionsDto;
}

export interface ChangeReviewQualificationRuleScopeDto {
  "sessionId": string | null;
  "positionId": string | null;
}

export interface ChangeReviewQualificationRuleSetCancelDto {
  "scope": ChangeReviewQualificationRuleScopeDto;
}

export interface ChangeReviewQualificationRuleSetCollectionsDto {
  "create": ChangeReviewQualificationRuleSetUpsertDto[];
  "update": ChangeReviewQualificationRuleSetUpsertDto[];
  "cancel": ChangeReviewQualificationRuleSetCancelDto[];
}

export interface ChangeReviewQualificationRuleSetUpsertDto {
  "scope": ChangeReviewQualificationRuleScopeDto;
  "rules": AppActivityQualificationRuleInputDto[];
}

export interface ChangeReviewSessionCancelDto {
  "sessionId": string;
}

export interface ChangeReviewSessionCollectionsDto {
  "create": ChangeReviewSessionCreateDto[];
  "update": ChangeReviewSessionUpdateDto[];
  "cancel": ChangeReviewSessionCancelDto[];
}

export interface ChangeReviewSessionCreateDto {
  "code": string;
  "name": string;
  "startAt": string;
  "endAt": string;
  "locationText": string;
  "meetingPoint"?: string | null;
  "executionPoint"?: string | null;
  "evacuationPoint"?: string | null;
  "longitude"?: number | null;
  "latitude"?: number | null;
  "capacity"?: number | null;
  "checkInOpenAt": string;
  "checkInCloseAt": string;
  "checkOutOpenAt": string;
  "checkOutCloseAt": string;
  "preparationStartAt"?: string | null;
  "locationRequired": boolean;
  "radiusMeters"?: number | null;
  "lateGraceMinutes"?: number;
  "earlyLeaveThresholdMinutes"?: number;
  "sortOrder"?: number;
  "clientRef"?: string;
}

export interface ChangeReviewSessionPositionCancelDto {
  "sessionId": string;
  "positionId": string;
}

export interface ChangeReviewSessionPositionCollectionsDto {
  "create": ChangeReviewSessionPositionCreateDto[];
  "update": ChangeReviewSessionPositionUpdateDto[];
  "cancel": ChangeReviewSessionPositionCancelDto[];
}

export interface ChangeReviewSessionPositionCreateDto {
  "code": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "locationRequired"?: boolean | null;
  "radiusMeters"?: number | null;
  "leaderMemberId"?: string | null;
  "description"?: string | null;
  "equipmentNotes"?: string | null;
  "sortOrder"?: number;
  "sessionId": string;
  "clientRef"?: string;
}

export interface ChangeReviewSessionPositionUpdateDto {
  "name"?: string;
  "attendanceRoleCode"?: string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "locationRequired"?: boolean | null;
  "radiusMeters"?: number | null;
  "leaderMemberId"?: string | null;
  "description"?: string | null;
  "equipmentNotes"?: string | null;
  "sortOrder"?: number;
  "sessionId": string;
  "positionId": string;
}

export interface ChangeReviewSessionUpdateDto {
  "name"?: string;
  "startAt"?: string;
  "endAt"?: string;
  "locationText"?: string;
  "meetingPoint"?: string | null;
  "executionPoint"?: string | null;
  "evacuationPoint"?: string | null;
  "longitude"?: number | null;
  "latitude"?: number | null;
  "capacity"?: number | null;
  "checkInOpenAt"?: string;
  "checkInCloseAt"?: string;
  "checkOutOpenAt"?: string;
  "checkOutCloseAt"?: string;
  "preparationStartAt"?: string | null;
  "locationRequired"?: boolean;
  "radiusMeters"?: number | null;
  "lateGraceMinutes"?: number;
  "earlyLeaveThresholdMinutes"?: number;
  "sortOrder"?: number;
  "sessionId": string;
}

export interface CommitAppManagedActivityAllocationBatchDto {
  "operationKey": string;
}

export interface CorrectAppManagedOnsitePunchDto {
  "operationKey": string;
  "reason": string;
}

export interface CreateAppManagedActivityDto {
  "title": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "organizationId": string;
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused";
  "visibilityCode"?: "internal" | "invitation";
  "defaultLocationRequired"?: boolean;
  "defaultCheckInRadiusMeters"?: number | null;
  "archiveWaitingDays"?: number;
  "startAt": string;
  "endAt": string;
  "location": string;
  "description"?: string;
  "capacity"?: number;
  "genderRequirementCode"?: string;
  "registrationDeadline"?: string | null;
  "registrationNotes"?: string;
  "isPublicRegistration"?: boolean;
  "requiresInsurance"?: boolean;
  "registrationSchema"?: Record<string, unknown>;
  "content"?: Record<string, unknown>;
  "locationLongitude"?: number;
  "locationLatitude"?: number;
}

export interface CreateAppManagedActivityInvitationDto {
  "memberId": string;
  "sessionId"?: Record<string, unknown> | null;
  "positionId"?: Record<string, unknown> | null;
  "expiresAt": string;
}

export interface CreateAppManagedActivityOnsiteParticipationDto {
  "operationKey": string;
  "memberId": string;
  "sessionId": string;
  "positionId"?: string;
  "reason": string;
}

export interface CreateAppManagedActivityPositionDto {
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder"?: number;
}

export interface CreateAppManagedActivitySessionDto {
  "code": string;
  "name": string;
  "startAt": string;
  "endAt": string;
  "locationText": string;
  "meetingPoint"?: string | null;
  "executionPoint"?: string | null;
  "evacuationPoint"?: string | null;
  "longitude"?: number | null;
  "latitude"?: number | null;
  "capacity"?: number | null;
  "checkInOpenAt": string;
  "checkInCloseAt": string;
  "checkOutOpenAt": string;
  "checkOutCloseAt": string;
  "preparationStartAt"?: string | null;
  "locationRequired": boolean;
  "radiusMeters"?: number | null;
  "lateGraceMinutes"?: number;
  "earlyLeaveThresholdMinutes"?: number;
  "sortOrder"?: number;
}

export interface CreateAppManagedActivitySessionPositionDto {
  "code": string;
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "locationRequired"?: boolean | null;
  "radiusMeters"?: number | null;
  "leaderMemberId"?: string | null;
  "description"?: string | null;
  "equipmentNotes"?: string | null;
  "sortOrder"?: number;
}

export interface CreateAppManagedActivityVisitorDto {
  "sessionId": string;
  "name": string;
  "organization"?: Record<string, unknown> | null;
  "invitedByMemberId"?: Record<string, unknown> | null;
  "note"?: Record<string, unknown> | null;
}

export interface CreateAppManagedAttendanceSheetDto {
  "records": AppManagedAttendanceRecordInputDto[];
}

export interface CreateAppManagedCollaboratorDto {
  "memberId": string;
  "canManageRegistrations": boolean;
  "canManageAttendance": boolean;
  "reason"?: string;
}

export interface CreateAppMeInsuranceDto {
  "insurerName": string;
  "policyNumber": string;
  "coverageStart"?: string;
  "coverageEnd": string;
}

export interface CreateAppMyRegistrationDto {
  "activityId": string;
  "activityPositionId"?: string;
  "extras"?: Record<string, unknown>;
}

export interface CreateAppTeamJoinApplicationDto {
  "targetOrganizationIds": string[];
}

export interface DeclineAppMyActivityInvitationDto {
  "operationKey": string;
  "reason"?: Record<string, unknown> | null;
}

export interface EarlyDepartureCloseAppManagedOnsitePunchDto {
  "participationIdentityId": string;
  "reason": string;
  "eventKey": string;
}

export interface IssueAppManagedAttendanceQrDto {
  "operationKey": string;
}

export interface ManagedRegistrationFormDefinitionInputDto {
  "fields": ManagedRegistrationFormFieldInputDto[];
}

export interface ManagedRegistrationFormFieldGovernanceInputDto {
  "purposeCode": "transport_logistics" | "accommodation_logistics" | "dietary_accommodation" | "equipment_clothing" | "activity_specific_note" | "file_confirmation";
  "dataClassCode": "ordinary" | "sensitive";
  "retentionPolicyCode": "activity_lifecycle";
  "maskingPolicyCode": "none";
  "prefillSourceCode": string | null;
}

export interface ManagedRegistrationFormFieldInputDto {
  "fieldCode": string;
  "typeCode": "short_text" | "long_text" | "number" | "date" | "single_choice" | "multi_choice" | "file" | "confirmation";
  "label": string;
  "helpText"?: string | null;
  "required": boolean;
  "visibilityCode": "self_and_registration_staff" | "self_and_owner" | "self_only";
  "exportable": boolean;
  "sortOrder": number;
  "minValue"?: number | null;
  "maxValue"?: number | null;
  "minLength"?: number | null;
  "maxLength"?: number | null;
  "maxSelections"?: number | null;
  "options"?: RegistrationFormChoiceInputDto[] | null;
  "governance"?: ManagedRegistrationFormFieldGovernanceInputDto;
}

export interface MarkNotificationReadResponseDto {
  "read": boolean;
}

export interface NotificationReadDetailDto {
  "id": string;
  "title": string;
  "body": string;
  "notificationTypeCode": string;
  "visibilityCode": string;
  "pinned": boolean;
  "read": boolean;
  "publishedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface NotificationReadListItemDto {
  "id": string;
  "title": string;
  "notificationTypeCode": string;
  "pinned": boolean;
  "read": boolean;
  "publishedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface NotificationUnreadCountDto {
  "unreadCount": number;
}

export interface PrepareAppManagedActivityAllocationBatchDto {
  "operationKey": string;
  "sessionId": string;
  "positionId"?: string | null;
}

export interface PutAppManagedActivityQualificationRulesDto {
  "ruleSets": AppActivityQualificationRuleSetInputDto[];
}

export interface PutAppManagedRegistrationFormDto {
  "form": ManagedRegistrationFormDefinitionInputDto;
}

export interface RegistrationFormChoiceInputDto {
  "value": string;
  "label": string;
}

export interface RejectAppManagedRegistrationDto {
  "reviewNote": string;
}

export type ResubmitAppManagedAttendanceSheetDto = Record<string, unknown>;

export interface RevokeAppManagedActivityInvitationDto {
  "reason": string;
}

export interface RevokeAppManagedAttendanceQrDto {
  "operationKey": string;
  "reason": string;
}

export interface SendMyPhoneCodeDto {
  "phone": string;
}

export interface SendMyPhoneCodeResponseDto {
  "expiresInSeconds": number;
}

export interface SetAppManagedActivityCoverDto {
  "attachmentId": string | null;
}

export interface SetAppManagedActivityGalleryDto {
  "attachmentIds": string[];
}

export interface SubmitActivityPublishReviewDto {
  "operationKey": string;
  "confirmation": boolean;
}

export interface TransferAppManagedActivityInitiatorDto {
  "newInitiatorMemberId": string;
  "reason": string;
}

export interface TransferAppManagedActivityOwnerDto {
  "newOwnerMemberId": string;
  "reason": string;
  "retainPreviousOwnerAsCollaborator": boolean;
}

export interface UpdateAppManagedActivityDto {
  "title"?: string;
  "activityTypeCode"?: string;
  "allocationModeCode"?: "first_come" | "qualification_rank" | "lottery";
  "organizationId"?: string;
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused";
  "visibilityCode"?: "internal" | "invitation";
  "defaultLocationRequired"?: boolean;
  "defaultCheckInRadiusMeters"?: number | null;
  "archiveWaitingDays"?: number;
  "startAt"?: string;
  "endAt"?: string;
  "location"?: string;
  "description"?: string;
  "capacity"?: number | null;
  "genderRequirementCode"?: string;
  "registrationDeadline"?: string | null;
  "registrationNotes"?: string;
  "isPublicRegistration"?: boolean;
  "requiresInsurance"?: boolean;
  "registrationSchema"?: Record<string, unknown>;
  "content"?: Record<string, unknown>;
  "locationLongitude"?: number;
  "locationLatitude"?: number;
}

export interface UpdateAppManagedActivityPositionDto {
  "name"?: string;
  "attendanceRoleCode"?: string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder"?: number;
}

export interface UpdateAppManagedActivitySessionDto {
  "name"?: string;
  "startAt"?: string;
  "endAt"?: string;
  "locationText"?: string;
  "meetingPoint"?: string | null;
  "executionPoint"?: string | null;
  "evacuationPoint"?: string | null;
  "longitude"?: number | null;
  "latitude"?: number | null;
  "capacity"?: number | null;
  "checkInOpenAt"?: string;
  "checkInCloseAt"?: string;
  "checkOutOpenAt"?: string;
  "checkOutCloseAt"?: string;
  "preparationStartAt"?: string | null;
  "locationRequired"?: boolean;
  "radiusMeters"?: number | null;
  "lateGraceMinutes"?: number;
  "earlyLeaveThresholdMinutes"?: number;
  "sortOrder"?: number;
}

export interface UpdateAppManagedActivitySessionPositionDto {
  "name"?: string;
  "attendanceRoleCode"?: string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "locationRequired"?: boolean | null;
  "radiusMeters"?: number | null;
  "leaderMemberId"?: string | null;
  "description"?: string | null;
  "equipmentNotes"?: string | null;
  "sortOrder"?: number;
}

export interface UpdateAppManagedAttendanceSheetDto {
  "records"?: AppManagedAttendanceRecordInputDto[];
}

export interface UpdateAppMeInsuranceDto {
  "expectedVersion": number;
  "insurerName"?: string;
  "policyNumber"?: string;
  "coverageStart"?: string;
  "coverageEnd"?: string;
}

export interface UpdateAppSelfProfileDto {
  "nickname"?: string;
}

export interface UpdateAppTeamJoinTargetsDto {
  "targetOrganizationIds": string[];
}

export interface UpsertActivityFeedbackDto {
  "rating": number;
  "comment"?: string | null;
}

export interface VoidAppManagedActivityAllocationBatchDto {
  "operationKey": string;
  "reason": string;
}

export interface WechatQuotaItemDto {
  "templateId": string;
  "availableCount": number;
}

export interface WechatSubscriptionAckDto {
  "templateIds": string[];
}

export interface WechatSubscriptionAckResponseDto {
  "quotas": WechatQuotaItemDto[];
}

export interface WechatSubscriptionStatusResponseDto {
  "quotas": WechatQuotaItemDto[];
}
