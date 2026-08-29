// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: Admin 管理后台
// contractVersion: 0.69.0
// generatorVersion: 1.0.0
// inputDigest: sha256:37349a15fa29087d8266ad35f03a06ddda1891097399dd3af53721dfca1ce152

// 共用类型不在本文件重复定义 —— 从 shared 引入并再导出,保证仓内每个类型只有一份定义。
import type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ActivityPublishReviewResponseDto, ContentAttachmentDto, PageResultDto, UserLinkedMemberDto, UserResponseDto } from '../shared/types';
export type { ApiEnvelope, PageResult, FetchRequest, Fetcher, ActivityPublishReviewResponseDto, ContentAttachmentDto, PageResultDto, UserLinkedMemberDto, UserResponseDto };

export interface ActionStateBatchDto {
  "items": ActionStateItemDto[];
}

export interface ActionStateBatchResponseDto {
  "items": ActionStateResultItemDto[];
}

export interface ActionStateItemDto {
  "action": string;
  "resourceType": "organization" | "activity" | "activity_publish_review" | "attendance_sheet" | "attendance_settlement_version" | "attendance_record" | "activity_registration" | "member" | "member_profile" | "certificate" | "team_join_application" | "recruitment_application" | "notification" | "attachment";
  "resourceId": string;
  "key"?: string;
}

export interface ActionStateResultItemDto {
  "action": string;
  "resourceType": "organization" | "activity" | "activity_publish_review" | "attendance_sheet" | "attendance_settlement_version" | "attendance_record" | "activity_registration" | "member" | "member_profile" | "certificate" | "team_join_application" | "recruitment_application" | "notification" | "attachment";
  "resourceId": string;
  "key"?: string;
  "allowed": boolean;
  "reason": "super_admin_pass" | "matched" | "no_permission" | "out_of_scope" | "out_of_supervised_scope" | "expired_grant" | "inactive_org" | "self_approval_forbidden" | "same_reviewer_forbidden" | "sensitive_denied" | "resource_not_found" | "state_forbidden";
}

export interface ActivityFeedbackAggregateDto {
  "count": number;
  "avgRating": number | null;
}

export interface ActivityFeedbackRatingBucketDto {
  "rating": number;
  "count": number;
}

export interface ActivityListItemDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "description"?: Record<string, unknown> | null;
  "capacity"?: Record<string, unknown> | null;
  "genderRequirementCode"?: Record<string, unknown> | null;
  "registrationDeadline"?: Record<string, unknown> | null;
  "statusCode": string;
  "phase": "upcoming" | "ongoing" | "ended";
  "isPublicRegistration": boolean;
  "requiresInsurance": boolean;
  "coverImageUrl"?: Record<string, unknown> | null;
  "locationLongitude"?: string | null;
  "locationLatitude"?: string | null;
  "createdAt": string;
  "updatedAt": string;
  "registrationCount"?: number;
  "attendanceSheetCount"?: number;
}

export interface ActivityOptionItemDto {
  "id": string;
  "label": string;
  "startAt": string;
  "statusCode": string;
}

export interface ActivityOptionsResponseDto {
  "items": ActivityOptionItemDto[];
}

export interface ActivityParticipationSummaryDto {
  "activityId": string;
  "activityStatusCode": string;
  "registrationCounts": ActivityRegistrationCountsDto;
  "attendeeCount": number;
  "registeredAttendeeCount": number;
  "temporaryAttendeeCount": number;
  "noShowCount": number;
  "attendanceRate": number;
  "totalServiceHours": string;
  "totalContributionPoints": string;
  "durationHistogram": DurationHistogramDto;
  "feedback": ActivityFeedbackAggregateDto;
}

export interface ActivityPositionResponseDto {
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

export interface ActivityReconciliationDto {
  "activityId": string;
  "activityStatusCode": string;
  "passRegistrationCount": number;
  "attendedCount": number;
  "noShowCount": number;
  "registeredParticipants": ActivityReconciliationRegisteredParticipantDto[];
  "temporaryParticipants": ActivityReconciliationTemporaryParticipantDto[];
}

export interface ActivityReconciliationRegisteredParticipantDto {
  "registrationId": string;
  "memberId": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "outcome": "attended" | "no-show";
  "recordCount": number;
  "approvedRecordCount": number;
  "totalServiceHours": string;
}

export interface ActivityReconciliationTemporaryParticipantDto {
  "memberId": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "outcome": "temporary";
  "recordCount": number;
  "approvedRecordCount": number;
  "totalServiceHours": string;
}

export interface ActivityRegistrationActivityPositionDto {
  "activityPositionId": string;
  "name": string;
}

export interface ActivityRegistrationCountsDto {
  "total": number;
  "pending": number;
  "pass": number;
  "reject": number;
  "cancelled": number;
  "waitlisted": number;
}

export interface ActivityRegistrationListItemDto {
  "id": string;
  "activityId": string;
  "activityPosition": ActivityRegistrationActivityPositionDto;
  "memberId": string;
  "memberNo"?: Record<string, unknown> | null;
  "memberRealName"?: Record<string, unknown> | null;
  "memberLabel"?: Record<string, unknown> | null;
  "statusCode": string;
  "waitlistPosition": number | null;
  "registeredAt": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface ActivityRegistrationResponseDto {
  "id": string;
  "activityId": string;
  "memberId": string;
  "statusCode": string;
  "registeredAt": string;
  "reviewedBy"?: Record<string, unknown> | null;
  "reviewedAt"?: Record<string, unknown> | null;
  "reviewNote"?: Record<string, unknown> | null;
  "extras"?: Record<string, unknown> | null;
  "cancelledByUserId"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "cancelReason"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface ActivityResponseDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "organizationId": string;
  "initiatorMemberId": string | null;
  "workflowRevision": number;
  "startAt": string;
  "endAt": string;
  "location": string;
  "description"?: Record<string, unknown> | null;
  "capacity"?: Record<string, unknown> | null;
  "genderRequirementCode"?: Record<string, unknown> | null;
  "registrationDeadline"?: Record<string, unknown> | null;
  "registrationNotes"?: Record<string, unknown> | null;
  "statusCode": string;
  "phase": "upcoming" | "ongoing" | "ended";
  "publishedBy"?: Record<string, unknown> | null;
  "publishedAt"?: Record<string, unknown> | null;
  "cancelledBy"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "cancelReason"?: Record<string, unknown> | null;
  "isPublicRegistration": boolean;
  "requiresInsurance": boolean;
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused" | null;
  "visibilityCode"?: "internal" | "invitation" | null;
  "defaultCheckInRadiusMeters"?: number | null;
  "defaultLocationRequired"?: boolean | null;
  "archiveWaitingDays": number;
  "registrationSchema"?: Record<string, unknown> | null;
  "coverImageUrl"?: Record<string, unknown> | null;
  "galleryImageUrls"?: string[] | null;
  "content"?: Record<string, unknown> | null;
  "locationLongitude"?: string | null;
  "locationLatitude"?: string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface ActivityResponsibilitiesResponseDto {
  "activityId": string;
  "initiator": ActivityResponsibilityMemberDto;
  "owner": ActivityResponsibilityAssignmentDto;
  "collaborators": ActivityResponsibilityAssignmentDto[];
  "legacyUnassigned": boolean;
}

export interface ActivityResponsibilityAssignmentDto {
  "id": string;
  "activityId": string;
  "memberId": string;
  "responsibilityType": "owner" | "collaborator";
  "canManageRegistrations": boolean;
  "canManageAttendance": boolean;
  "status": "active" | "ended" | "revoked";
  "startedAt": string;
  "endedAt": string | null;
  "assignedByUserId": string;
  "endedByUserId": string | null;
  "source": string;
  "reason": string | null;
  "member": ActivityResponsibilityMemberDto;
}

export interface ActivityResponsibilityMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode": string | null;
}

export interface AddAllActiveCoverageResultDto {
  "addedCount": number;
}

export interface AddTeamInsuranceCoverageDto {
  "memberId": string;
}

export interface AdminActivityCheckInListItemDto {
  "id": string;
  "activityId": string;
  "registrationId": string;
  "member": AdminActivityCheckInMemberDto;
  "checkInAt": string;
  "checkOutAt": string | null;
  "checkInDistance": string | null;
  "checkOutDistance": string | null;
  "geoVerified": boolean;
  "outOfRange": boolean;
  "createdAt": string;
  "updatedAt": string;
}

export interface AdminActivityCheckInMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AdminActivityFeedbackListItemDto {
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "rating": number;
  "comment": string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AdminActivityFeedbackSummaryDto {
  "count": number;
  "avgRating": number | null;
  "ratingDistribution": ActivityFeedbackRatingBucketDto[];
  "feedbackRate": number;
}

export interface AdminAttendanceSettlementListItemDto {
  "settlementVersionId": string;
  "activityId": string;
  "activityTitle": string;
  "version": number;
  "statusCode": string;
  "submittedAt"?: string | null;
  "postingBatchStatusCode"?: string | null;
}

export interface AdminAttendanceSheetExpandedActivityDto {
  "id": string;
  "title": string;
  "startAt": string;
  "organizationId": string;
}

export interface AdminAttendanceSheetListItemDto {
  "id": string;
  "activityId": string;
  "activityTitle"?: Record<string, unknown> | null;
  "submitterUserId": string;
  "submittedAt": string;
  "statusCode": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "version": number;
  "createdAt": string;
  "activity"?: AdminAttendanceSheetExpandedActivityDto;
}

export interface AdminMeResponseDto {
  "userId": string;
  "username": string;
  "email": Record<string, unknown> | null;
  "nickname": Record<string, unknown> | null;
  "avatarKey": Record<string, unknown> | null;
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
  "status": "ACTIVE" | "DISABLED";
  "lastLoginAt": Record<string, unknown> | null;
  "memberId": Record<string, unknown> | null;
}

export interface AdminMemberAttendanceRecordDto {
  "id": string;
  "sheetId": string;
  "activityId": string;
  "activityTitle"?: Record<string, unknown> | null;
  "memberId": string;
  "member"?: Record<string, unknown>;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": string;
  "attendanceStatusCode": string;
  "note"?: Record<string, unknown> | null;
  "registrationId"?: Record<string, unknown> | null;
  "contributionPoints"?: string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AdminParticipationLedgerEntryDto {
  "entryKey": string;
  "postingBatchId": string;
  "memberId": string;
  "activityId": string;
  "sessionId": string;
  "participationIdentityId": string;
  "resultRevisionId": string;
  "ledgerDate": string;
  "entryTypeCode": string;
  "serviceHoursDelta": number;
  "recognizedPointsDelta": number;
  "creditedPointsDelta": number;
  "cappedOutPointsDelta": number;
}

export interface AdminRegistrationExpandedActivityDto {
  "id": string;
  "title": string;
  "startAt": string;
  "organizationId": string;
}

export interface AdminRegistrationExpandedMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: Record<string, unknown> | null;
}

export interface AdminRegistrationListItemDto {
  "id": string;
  "activityId": string;
  "activityPosition": ActivityRegistrationActivityPositionDto;
  "activityTitle"?: Record<string, unknown> | null;
  "memberId": string;
  "memberNo"?: Record<string, unknown> | null;
  "memberRealName"?: Record<string, unknown> | null;
  "memberLabel"?: Record<string, unknown> | null;
  "statusCode": string;
  "waitlistPosition": number | null;
  "registeredAt": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "cancelledAt"?: Record<string, unknown> | null;
  "createdAt": string;
  "member"?: AdminRegistrationExpandedMemberDto;
  "activity"?: AdminRegistrationExpandedActivityDto;
}

export interface AdminSettlementApproveCommandDto {
  "operationKey": string;
  "evidenceSealId": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "contentHash": string;
  "note"?: string;
}

export interface AdminSettlementPostingBatchDto {
  "id": string;
  "settlementVersionId": string;
  "statusCode": string;
  "preparedCount": number;
  "totalCount": number;
  "failureCount": number;
  "effective": boolean;
  "effectiveLabel": string;
  "preparedAt"?: string | null;
  "committedAt"?: string | null;
}

export interface AdminSettlementReturnCommandDto {
  "operationKey": string;
  "evidenceSealId": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "contentHash": string;
  "note": string;
}

export interface AdminSettlementReviewDetailDto {
  "version": AdminSettlementReviewVersionDto;
  "diff": AdminSettlementReviewDiffDto;
  "sealRevisions": AdminSettlementSealRevisionDto[];
  "gaps": AdminSettlementReviewGapDto[];
}

export interface AdminSettlementReviewDiffDto {
  "priorVersionId"?: string | null;
  "addedItemCount": number;
  "removedItemCount": number;
  "changedItemCount": number;
}

export interface AdminSettlementReviewGapDto {
  "gapCode": string;
  "count": number;
}

export interface AdminSettlementReviewResponseDto {
  "activityId": string;
  "settlementRunId": string;
  "settlementVersionId": string;
  "settlementVersion": number;
  "stageCode": "first" | "final";
  "actionCode": "approve" | "return";
  "reviewActionId": string;
  "runStatusBefore": string;
  "runStatusAfter": string;
  "versionStatusAfter": string;
  "ledgerPostingBatchId": string | null;
  "ledgerPostingBatchStatus": string | null;
  "replayed": boolean;
}

export interface AdminSettlementReviewVersionDto {
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

export interface AdminSettlementSealRevisionDto {
  "id": string;
  "sealRevision": number;
  "statusCode": string;
  "evidenceRevision": number;
  "populationRevision": number;
  "workflowRevision": number;
  "manualReviewPendingCount": number;
  "sealedAt": string;
}

export interface AnnouncementImportRequestDto {
  "organizations"?: ImportOrganizationRowDto[];
  "positions"?: ImportPositionRowDto[];
  "supervisions"?: ImportSupervisionRowDto[];
}

export interface AnnouncementImportResultDto {
  "organizations": ImportOrganizationRowResultDto[];
  "positions": ImportPositionRowResultDto[];
  "supervisions": ImportSupervisionRowResultDto[];
  "summary": ImportSummaryDto;
}

export interface ApproveActivityPublishReviewDto {
  "reviewNote"?: string;
  "requiresInsuranceConfirmed": boolean;
  "operationKey"?: string;
}

export interface ApproveAttendanceSheetDto {
  "reviewNote"?: string;
}

export interface ApproveRegistrationDto {
  "reviewNote"?: string;
}

export interface AssignLegacyActivityInitiatorDto {
  "memberId": string;
  "reason": string;
}

export interface AttachmentResponseDto {
  "id": string;
  "key": string;
  "originalName": string;
  "mime": string;
  "size": number;
  "uploadedBy": string;
  "uploadedAt": string;
  "ownerType": string;
  "ownerId": string;
  "description"?: Record<string, unknown> | null;
  "accessLevel"?: "PUBLIC" | "INTERNAL" | "SENSITIVE" | null;
  "tags": string[];
  "originalUploaderName"?: Record<string, unknown> | null;
  "expireAt"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "accessUrl"?: Record<string, unknown> | null;
}

export interface AttendanceRecordInputDto {
  "memberId": string;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours"?: number;
  "attendanceStatusCode": string;
  "note"?: string;
  "registrationId"?: string;
}

export interface AttendanceRecordResponseDto {
  "id": string;
  "sheetId": string;
  "memberId": string;
  "member"?: Record<string, unknown>;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": string;
  "attendanceStatusCode": string;
  "note"?: Record<string, unknown> | null;
  "registrationId"?: Record<string, unknown> | null;
  "contributionPoints"?: string | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface AttendanceSheetActivitySummaryDto {
  "id": string;
  "title": string;
  "activityTypeCode": string;
  "organizationId": string;
  "startAt": string;
  "endAt": string;
  "location": string;
  "statusCode": string;
}

export interface AttendanceSheetDraftAbsentRegistrationDto {
  "registrationId": string;
  "memberId": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface AttendanceSheetDraftDto {
  "activityId": string;
  "records": AttendanceSheetDraftRecordDto[];
  "flags": AttendanceSheetDraftFlagDto[];
  "absentRegistrations": AttendanceSheetDraftAbsentRegistrationDto[];
}

export interface AttendanceSheetDraftFlagDto {
  "registrationId": string;
  "memberId": string;
  "noCheckOut": boolean;
  "outOfRange": boolean;
  "unverified": boolean;
}

export interface AttendanceSheetDraftRecordDto {
  "memberId": string;
  "roleCode": string;
  "checkInAt": string;
  "checkOutAt": string;
  "serviceHours": number;
  "attendanceStatusCode": string;
  "registrationId": string;
}

export interface AttendanceSheetListItemDto {
  "id": string;
  "activityId": string;
  "submitterUserId": string;
  "submittedAt": string;
  "statusCode": string;
  "reviewedAt"?: Record<string, unknown> | null;
  "version": number;
  "createdAt": string;
}

export interface AttendanceSheetResponseDto {
  "id": string;
  "activityId": string;
  "submitterUserId": string;
  "submittedAt": string;
  "statusCode": "pending" | "pending_final_review" | "returned" | "approved" | "rejected" | "final_rejected";
  "reviewerUserId"?: Record<string, unknown> | null;
  "reviewedAt"?: Record<string, unknown> | null;
  "reviewNote"?: Record<string, unknown> | null;
  "finalReviewerUserId"?: Record<string, unknown> | null;
  "finalReviewedAt"?: Record<string, unknown> | null;
  "finalReviewNote"?: Record<string, unknown> | null;
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

export interface AttendanceSheetReviewDetailDto {
  "activity": AttendanceSheetActivitySummaryDto;
  "sheet": AttendanceSheetResponseDto;
  "records": AttendanceRecordResponseDto[];
}

export interface AuthzDecisionDto {
  "allow": boolean;
  "reason": "super_admin_pass" | "matched" | "no_permission" | "out_of_scope" | "out_of_supervised_scope" | "expired_grant" | "inactive_org" | "self_approval_forbidden" | "same_reviewer_forbidden" | "sensitive_denied" | "resource_not_found";
  "matchedGrant"?: MatchedGrantDto;
  "resource"?: ResolvedResourceDto;
}

export interface BatchCreateRoleBindingsDto {
  "items": CreateRoleBindingDto[];
}

export interface BatchCreateRoleBindingsResponseDto {
  "items": RoleBindingBatchItemResultDto[];
  "summary": RoleBindingBatchSummaryDto;
}

export interface BatchMarkThresholdDto {
  "cycleId"?: string;
  "thresholdCode": "patrol1" | "patrol2" | "training";
  "completed": boolean;
  "matches": BatchMarkThresholdMatchDto[];
}

export interface BatchMarkThresholdMatchDto {
  "tempNo"?: string;
  "phone"?: string;
  "realName"?: string;
}

export interface BatchMarkThresholdResultDto {
  "results": BatchMarkThresholdRowResultDto[];
  "total": number;
  "marked": number;
  "unmatched": number;
  "failed": number;
  "autoAdvanced": number;
}

export interface BatchMarkThresholdRowResultDto {
  "index": number;
  "status": string;
  "applicationId"?: Record<string, unknown> | null;
  "matchedBy"?: Record<string, unknown> | null;
  "unmatchedReason"?: Record<string, unknown> | null;
  "errorCode"?: Record<string, unknown> | null;
  "statusCode"?: Record<string, unknown> | null;
  "thresholdsComplete"?: Record<string, unknown> | null;
}

export interface BindMemberAccountDto {
  "userId": string;
}

export interface BulkGrantAccountItemDto {
  "memberId": string;
  "phone": string;
}

export interface BulkGrantAccountResultItemDto {
  "memberId": string;
  "status": "ok" | "blocked";
  "userId"?: Record<string, unknown> | null;
  "reason"?: Record<string, unknown> | null;
}

export interface BulkGrantMemberAccountsDto {
  "items": BulkGrantAccountItemDto[];
}

export interface BulkGrantMemberAccountsResponseDto {
  "items": BulkGrantAccountResultItemDto[];
  "summary": BulkGrantSummaryDto;
}

export interface BulkGrantSummaryDto {
  "total": number;
  "ok": number;
  "blocked": number;
}

export interface BulkReviewFailureDto {
  "id": string;
  "code": number;
  "message": string;
}

export interface BulkReviewRegistrationsDto {
  "ids": string[];
  "reviewNote"?: string;
}

export interface BulkReviewRegistrationsResponseDto {
  "succeeded": string[];
  "failed": BulkReviewFailureDto[];
}

export interface CancelActivityDto {
  "cancelReason"?: string;
}

export interface CancelRegistrationDto {
  "cancelReason"?: string;
}

export interface CertificateEvidenceUrlsResponseDto {
  "certificateId": string;
  "sourceCode": "ADMIN" | "RECRUITMENT";
  "urls": string[];
  "expiresAt"?: Record<string, unknown> | null;
}

export interface CertificateListItemDto {
  "id": string;
  "memberId": string;
  "standardId": string;
  "sourceCode": "ADMIN" | "RECRUITMENT";
  "issuingOrg": string;
  "issuedAt": string;
  "expiredAt"?: Record<string, unknown> | null;
  "certStatusCode": string;
  "createdAt": string;
  "updatedAt": string;
}

export interface CertificateRecognitionIssuerInputDto {
  "name": string;
  "sortOrder"?: number;
}

export interface CertificateRecognitionIssuerResponseDto {
  "id": string;
  "name": string;
  "sortOrder": number;
}

export interface CertificateRecognitionPolicyListResponseDto {
  "items": CertificateRecognitionPolicyResponseDto[];
}

export interface CertificateRecognitionPolicyResponseDto {
  "id": string;
  "standardId": string;
  "version": number;
  "status": "DRAFT" | "ACTIVE" | "RETIRED";
  "issuerPolicy": "FIXED" | "ALLOWLIST" | "FREE_TEXT";
  "validityMode": "PERMANENT" | "FIXED_MONTHS" | "EXPLICIT_REQUIRED" | "EXPLICIT_OPTIONAL";
  "validityMonths"?: number | null;
  "certNumberMode": "REQUIRED" | "OPTIONAL" | "NONE";
  "activatedAt"?: Record<string, unknown> | null;
  "retiredAt"?: Record<string, unknown> | null;
  "issuers": CertificateRecognitionIssuerResponseDto[];
  "createdAt": string;
  "updatedAt": string;
}

export interface CertificateResponseDto {
  "id": string;
  "memberId": string;
  "issuingOrg": string;
  "certNumberMasked"?: string | null;
  "certNumberFull"?: string | null;
  "issuedAt": string;
  "expiredAt"?: Record<string, unknown> | null;
  "certStatusCode": string;
  "verifiedBy"?: Record<string, unknown> | null;
  "verifiedAt"?: Record<string, unknown> | null;
  "verifyNote"?: Record<string, unknown> | null;
  "evidenceAvailable": boolean;
  "standardId"?: string | null;
  "recognitionPolicyId"?: string | null;
  "recognitionIssuerId"?: string | null;
  "sourceCode"?: "ADMIN" | "RECRUITMENT" | null;
  "supersededByCertId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface CertificateStandardOptionIssuerDto {
  "id": string;
  "name": string;
}

export interface CertificateStandardOptionItemDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": string;
  "levelCode"?: string | null;
  "isInternal": boolean;
  "currentlyRecognized": boolean;
  "currentPolicy"?: CertificateStandardOptionPolicyDto;
}

export interface CertificateStandardOptionPolicyDto {
  "id": string;
  "version": number;
  "issuerPolicy": "FIXED" | "ALLOWLIST" | "FREE_TEXT";
  "validityMode": "PERMANENT" | "FIXED_MONTHS" | "EXPLICIT_REQUIRED" | "EXPLICIT_OPTIONAL";
  "validityMonths"?: number | null;
  "certNumberMode": "REQUIRED" | "OPTIONAL" | "NONE";
  "issuers": CertificateStandardOptionIssuerDto[];
}

export interface CertificateStandardOptionsResponseDto {
  "items": CertificateStandardOptionItemDto[];
}

export interface CertificateStandardResponseDto {
  "id": string;
  "code": string;
  "name": string;
  "description"?: string | null;
  "kind": "FAMILY" | "CREDENTIAL";
  "categoryCode": string;
  "levelCode"?: string | null;
  "parentId"?: string | null;
  "isInternal": boolean;
  "status": "DRAFT" | "ACTIVE" | "INACTIVE";
  "sortOrder": number;
  "activatedAt"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface CertificateWorkbenchItemDto {
  "id": string;
  "member": WorkbenchMemberSummaryDto;
  "standard": WorkbenchStandardSummaryDto;
  "issuingOrg": string;
  "certNumberMasked"?: string | null;
  "issuedAt": string;
  "expiredAt"?: Record<string, unknown> | null;
  "certStatusCode": "pending" | "verified" | "expired" | "rejected";
  "effectiveStatusCode": "pending" | "verified" | "expired" | "rejected";
  "sourceCode": "ADMIN" | "RECRUITMENT";
  "evidenceAvailable": boolean;
  "createdAt": string;
}

export interface CertificateWorkbenchStatsDto {
  "pending": number;
  "verified": number;
  "expired": number;
  "rejected": number;
  "expiringWithin60Days": number;
  "permanent": number;
}

export interface ClaimLegacyActivityDto {
  "ownerMemberId": string;
  "reason": string;
}

export interface ClaimStandardSummaryDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": string;
  "levelCode"?: string | null;
}

export interface ConfirmUploadDto {
  "uploadToken": string;
  "checksum"?: string;
}

export interface ContentAdminDetailDto {
  "id": string;
  "title": string;
  "summary"?: Record<string, unknown> | null;
  "body": string;
  "contentTypeCode": string;
  "statusCode": string;
  "visibilityCode": string;
  "visibleOrganizationIds": string[];
  "tags": string[];
  "coverImageUrl"?: string | null;
  "coverAttachmentId"?: Record<string, unknown> | null;
  "attachments": ContentAttachmentDto[];
  "pinned": boolean;
  "viewCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "authorUserId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface ContentAdminListItemDto {
  "id": string;
  "title": string;
  "summary"?: Record<string, unknown> | null;
  "contentTypeCode": string;
  "statusCode": string;
  "visibilityCode": string;
  "tags": string[];
  "coverImageUrl"?: string | null;
  "pinned": boolean;
  "viewCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "authorUserId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface ContentAttachmentConfirmDto {
  "uploadToken": string;
  "checksum"?: string;
  "etag"?: string;
}

export interface ContentAttachmentUploadUrlDto {
  "kind": "image" | "file";
  "originalName": string;
  "mime": string;
  "sizeBytes": number;
}

export interface CorrectMemberIdentityDto {
  "memberNo"?: string;
  "memberSinceDate"?: string;
  "memberOriginCode"?: string;
  "reason": string;
  "confirmMemberNoChange"?: boolean;
}

export interface CreateActivityCollaboratorDto {
  "memberId": string;
  "canManageRegistrations": boolean;
  "canManageAttendance": boolean;
  "reason"?: string;
}

export interface CreateActivityDto {
  "title": string;
  "activityTypeCode": string;
  "allocationModeCode": "first_come" | "qualification_rank" | "lottery";
  "organizationId": string;
  "initiatorMemberId"?: string;
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
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused";
  "visibilityCode"?: "internal" | "invitation";
  "defaultCheckInRadiusMeters"?: number | null;
  "defaultLocationRequired"?: boolean | null;
  "archiveWaitingDays"?: number;
  "registrationSchema"?: Record<string, unknown>;
  "content"?: Record<string, unknown>;
  "locationLongitude"?: number;
  "locationLatitude"?: number;
}

export interface CreateActivityPositionDto {
  "name": string;
  "attendanceRoleCode": string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder"?: number;
}

export interface CreateAttachmentDto {
  "key": string;
  "originalName": string;
  "mime": string;
  "size": number;
  "ownerType": string;
  "ownerId": string;
  "description"?: string;
  "accessLevel"?: "PUBLIC" | "INTERNAL" | "SENSITIVE";
  "tags"?: string[];
  "expireAt"?: string;
}

export interface CreateAttendanceSheetDto {
  "records": AttendanceRecordInputDto[];
}

export interface CreateCertificateDto {
  "standardId": string;
  "recognitionIssuerId"?: string;
  "issuingOrg"?: string;
  "certNumber"?: string;
  "issuedAt": string;
  "expiredAt"?: string;
}

export interface CreateCertificateRecognitionPolicyDto {
  "issuerPolicy": "FIXED" | "ALLOWLIST" | "FREE_TEXT";
  "validityMode": "PERMANENT" | "FIXED_MONTHS" | "EXPLICIT_REQUIRED" | "EXPLICIT_OPTIONAL";
  "validityMonths"?: number;
  "certNumberMode": "REQUIRED" | "OPTIONAL" | "NONE";
  "issuers": CertificateRecognitionIssuerInputDto[];
}

export interface CreateCertificateStandardDto {
  "code": string;
  "name": string;
  "description"?: string | null;
  "kind": "FAMILY" | "CREDENTIAL";
  "categoryCode": string;
  "levelCode"?: string;
  "parentId"?: string;
  "isInternal"?: boolean;
  "sortOrder"?: number;
}

export interface CreateContentDto {
  "title": string;
  "summary"?: string;
  "body": string;
  "contentTypeCode": string;
  "visibilityCode": "public" | "member" | "formal_member" | "department" | "management";
  "visibleOrganizationIds"?: string[];
  "tags"?: string[];
  "pinned"?: boolean;
}

export interface CreateEmergencyContactDto {
  "contactName": string;
  "relationCode": string;
  "phonePrimary": string;
  "phoneBackup"?: string;
  "address"?: string;
  "priority"?: number;
}

export interface CreateMemberDto {
  "memberNo": string;
  "realName": string;
  "nickname"?: string;
  "memberSinceDate": string;
  "memberOriginCode": string;
  "gradeCode"?: string;
}

export interface CreateMemberProfileDto {
  "genderCode": string;
  "birthDate": string;
  "documentTypeCode": string;
  "documentNumber": string;
  "mobile": string;
  "email": string;
  "privacyConsentSigned": boolean;
  "ethnicityCode"?: string;
  "politicalStatusCode"?: string;
  "isVeteran"?: boolean;
  "maritalStatusCode"?: string;
  "educationCode"?: string;
  "major"?: string;
  "workNatureCode"?: string;
  "residenceArea"?: string;
  "workArea"?: string;
  "landline"?: string;
  "qq"?: string;
  "wechat"?: string;
  "heightCm"?: number;
  "weightKg"?: number;
  "bloodTypeCode"?: string;
  "eyesight"?: string;
  "medicalNotes"?: MedicalNoteItemDto[];
  "hasVehicle"?: boolean;
  "vehicleType"?: string;
  "exerciseFrequencyCode"?: string;
  "exerciseSportCode"?: string;
  "exerciseMethods"?: string[];
  "firstAidKnowledgeCode"?: string;
  "firstAidSkills"?: string[];
  "otherSkills"?: string;
  "noCriminalRecordSigned"?: boolean;
  "privacyConsentSignedAt"?: string;
  "volunteerNo"?: string;
}

export interface CreateMembershipDto {
  "organizationId": string;
  "membershipType": "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT";
  "reason"?: string;
}

export interface CreateNotificationDto {
  "title": string;
  "body": string;
  "notificationTypeCode": string;
  "visibilityCode": "member" | "formal_member" | "department" | "management";
  "visibleOrganizationIds"?: string[];
  "pinned"?: boolean;
  "channels"?: "in-app" | "wechat" | "wecom" | "sms"[];
}

export interface CreateOrganizationDto {
  "name": string;
  "code"?: string;
  "parentId"?: string;
  "nodeTypeCode": string;
  "sortOrder"?: number;
  "establishmentStatusCode"?: "formal" | "provisional";
  "groupFunctionCode"?: string;
}

export interface CreatePositionAssignmentDto {
  "positionId": string;
  "memberId": string;
  "startedAt": string;
  "endedAt"?: string;
  "isConcurrent"?: boolean;
  "appointmentSource"?: string;
  "note"?: string;
}

export interface CreatePositionDto {
  "code": string;
  "name": string;
  "categoryCode": "LEADER" | "DEPUTY" | "STAFF";
  "rank"?: number;
  "isLeadership"?: boolean;
  "allowMultiple"?: boolean;
  "allowConcurrent"?: boolean;
  "sortOrder"?: number;
  "status"?: "ACTIVE" | "INACTIVE";
  "description"?: string;
}

export interface CreatePositionRuleDto {
  "nodeTypeCode": string;
  "positionId": string;
  "required"?: boolean;
  "minCount"?: number | null;
  "maxCount"?: number | null;
  "requireMembership"?: boolean;
  "allowConcurrent"?: boolean;
  "status"?: "ACTIVE" | "INACTIVE";
}

export interface CreateRecruitmentCycleDto {
  "year": number;
  "name": string;
  "capacity"?: number;
}

export interface CreateRegistrationDto {
  "memberId": string;
  "activityPositionId"?: string;
  "extras"?: Record<string, unknown>;
}

export interface CreateRoleBindingDto {
  "principalType": "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SERVICE_PRINCIPAL" | "SYSTEM";
  "principalId"?: string;
  "roleId": string;
  "scopeType": "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF";
  "scopeOrgId"?: string;
  "scopeActivityId"?: string;
  "scopeResourceType"?: string;
  "scopeResourceId"?: string;
  "startedAt"?: string;
  "endedAt"?: string;
  "note"?: string;
}

export interface CreateSupervisionAssignmentDto {
  "supervisorMemberId": string;
  "organizationId": string;
  "scopeMode"?: "EXACT" | "TREE";
  "startedAt": string;
  "endedAt"?: string;
  "note"?: string;
}

export interface CreateTeamInsurancePolicyDto {
  "insurerName": string;
  "policyNumber": string;
  "coverageStart": string;
  "coverageEnd": string;
  "note"?: string;
}

export interface CreateTeamJoinCycleDto {
  "year": number;
  "name": string;
  "requiresInsurance"?: boolean;
  "openOrganizationIds"?: string[] | null;
  "maxTargetOrgs"?: number | null;
}

export interface CreateUserDto {
  "username": string;
  "email"?: string;
  "password": string;
  "nickname"?: string;
  "avatarKey"?: string;
  "role"?: "SUPER_ADMIN" | "ADMIN" | "USER";
}

export interface DashboardActivitiesSummaryDto {
  "published": number;
  "pendingCompletion": number;
}

export interface DashboardActivityPublishReviewsSummaryDto {
  "pending": number;
}

export interface DashboardAttendanceSheetsSummaryDto {
  "pending": number;
  "pendingFirstReview"?: number;
  "pendingFinalReview": number;
}

export interface DashboardRegistrationsSummaryDto {
  "pending": number;
  "waitlisted": number;
}

export interface DashboardSummaryResponseDto {
  "registrations"?: DashboardRegistrationsSummaryDto;
  "attendanceSheets"?: DashboardAttendanceSheetsSummaryDto;
  "activityPublishReviews"?: DashboardActivityPublishReviewsSummaryDto;
  "activities"?: DashboardActivitiesSummaryDto;
}

export interface DurationHistogramDto {
  "under2Hours": number;
  "from2To4Hours": number;
  "from4To8Hours": number;
  "atLeast8Hours": number;
}

export interface EmergencyContactInputDto {
  "name": string;
  "relation": string;
  "phone": string;
}

export interface EmergencyContactResponseDto {
  "id": string;
  "memberId": string;
  "contactName": string;
  "relationCode": string;
  "phonePrimary": string;
  "phoneBackup"?: Record<string, unknown> | null;
  "address"?: Record<string, unknown> | null;
  "priority": number;
  "createdAt": string;
  "updatedAt": string;
}

export interface EvaluateRecruitmentApplicationDto {
  "approved": boolean;
  "note"?: string;
}

export interface EvaluateTeamJoinApplicationDto {
  "approved": boolean;
  "note"?: string;
  "evaluationExtendedUntil"?: string;
}

export interface ExplainAuthzBatchDto {
  "items": ExplainBatchItemDto[];
}

export interface ExplainAuthzBatchResponseDto {
  "items": ExplainBatchResultItemDto[];
}

export interface ExplainAuthzDto {
  "userId": string;
  "action": string;
  "resourceRef"?: ExplainResourceRefDto;
}

export interface ExplainAuthzResponseDto {
  "targetUser": ExplainTargetUserDto;
  "decision": AuthzDecisionDto;
}

export interface ExplainBatchItemDto {
  "userId": string;
  "action": string;
  "resourceRef"?: ExplainResourceRefDto;
}

export interface ExplainBatchResultItemDto {
  "userId": string;
  "action": string;
  "resourceRef"?: ExplainResourceRefDto;
  "decision": AuthzDecisionDto;
}

export interface ExplainResourceRefDto {
  "type": "organization" | "activity" | "activity_publish_review" | "attendance_sheet" | "attendance_settlement_version" | "attendance_record" | "activity_registration" | "member" | "member_profile" | "certificate" | "team_join_application" | "recruitment_application" | "notification" | "attachment";
  "id": string;
}

export interface ExplainTargetUserDto {
  "id": string;
  "username": string;
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
  "status": "ACTIVE" | "DISABLED";
  "memberId"?: Record<string, unknown> | null;
}

export interface ExportRecruitmentApplicationsDto {
  "cycleId"?: string;
  "filter"?: "all" | "manual" | "verified" | "threshold-incomplete" | "pending-evaluation" | "publicity" | "promoted" | "rejected" | "withdrawn";
}

export interface FinalApproveAttendanceSheetDto {
  "finalReviewNote"?: string;
}

export interface FinalRejectAttendanceSheetDto {
  "finalReviewNote": string;
}

export interface GateStatusDto {
  "code": string;
  "professional": boolean;
  "marked": boolean;
  "passed"?: Record<string, unknown> | null;
  "satisfied": boolean;
  "completionDate"?: Record<string, unknown> | null;
  "extendedUntil"?: Record<string, unknown> | null;
}

export interface GenerateUploadUrlDto {
  "ownerType": string;
  "ownerId": string;
  "originalName": string;
  "mime": string;
  "sizeBytes": number;
}

export interface GrantMemberAccountDto {
  "phone": string;
}

export interface GrantMemberAccountResponseDto {
  "userId": string;
  "username": string;
  "phone": string;
  "phoneVerifiedAt": string;
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
  "memberId": string;
}

export interface IdCardImageUrlResponseDto {
  "url": string;
  "expiresAt": string;
  "cropImageUrl"?: Record<string, unknown> | null;
  "portraitImageUrl"?: Record<string, unknown> | null;
}

export interface ImportOrganizationRowDto {
  "code"?: string;
  "parentCode"?: string;
  "name"?: string;
  "establishmentStatusCode"?: "formal" | "provisional";
  "groupFunctionCode"?: string;
  "sortOrder"?: number;
}

export interface ImportOrganizationRowResultDto {
  "row": ImportOrganizationRowDto;
  "status": "ok" | "blocked" | "already-exists" | "needs-manual";
  "reasons": ImportRowIssueDto[];
  "organizationId"?: Record<string, unknown> | null;
}

export interface ImportPositionRowDto {
  "memberNo"?: string;
  "realName"?: string;
  "orgCode"?: string;
  "positionCode"?: string;
  "startedAt"?: string;
  "endedAt"?: string;
  "isConcurrent"?: boolean;
  "note"?: string;
  "appointmentSource"?: string;
}

export interface ImportPositionRowResultDto {
  "row": ImportPositionRowDto;
  "status": "ok" | "blocked" | "already-exists" | "needs-manual";
  "reasons": ImportRowIssueDto[];
  "suggestedMemberNo"?: Record<string, unknown> | null;
  "positionAssignmentId"?: Record<string, unknown> | null;
}

export interface ImportRowIssueDto {
  "bizCode"?: Record<string, unknown> | null;
  "message": string;
}

export interface ImportSummaryDto {
  "total": number;
  "ok": number;
  "blocked": number;
  "alreadyExists": number;
  "needsManual": number;
}

export interface ImportSupervisionRowDto {
  "supervisorMemberNo"?: string;
  "realName"?: string;
  "orgCode"?: string;
  "scopeMode"?: "EXACT" | "TREE";
  "startedAt"?: string;
  "endedAt"?: string;
  "note"?: string;
}

export interface ImportSupervisionRowResultDto {
  "row": ImportSupervisionRowDto;
  "status": "ok" | "blocked" | "already-exists" | "needs-manual";
  "reasons": ImportRowIssueDto[];
  "suggestedMemberNo"?: Record<string, unknown> | null;
  "supervisionAssignmentId"?: Record<string, unknown> | null;
}

export interface JoinTeamJoinApplicationDto {
  "organizationId": string;
}

export interface MarkGateDto {
  "gateCode": "fitness" | "first-aid-training" | "military" | "psych" | "interview" | "dept-assessment" | "entry-exam" | "intermediate-outdoor" | "team-water" | "team-urban" | "team-mountain" | "team-high";
  "passed": boolean;
  "completionDate": string;
  "extendedUntil"?: string;
}

export interface MarkThresholdDto {
  "thresholdCode": "patrol1" | "patrol2" | "training";
  "completed": boolean;
}

export interface MatchedGrantDto {
  "source": "super_admin" | "role_binding" | "position" | "supervision";
  "bindingId"?: string;
  "positionAssignmentId"?: string;
  "supervisionAssignmentId"?: string;
  "roleCode"?: string;
  "scopeType": "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF";
  "scopeId"?: string;
}

export interface MedicalNoteItemDto {
  "categoryCode": string;
  "note"?: string;
}

export interface MemberAudienceTagDto {
  "code": string;
  "label": string;
  "status": "ACTIVE" | "INACTIVE";
  "sortOrder": number;
}

export interface MemberAudienceTagsResponseDto {
  "memberId": string;
  "tags": MemberAudienceTagDto[];
}

export interface MemberContributionSummaryDto {
  "memberId": string;
  "contributionPoints": string;
  "ledgerTotals": MemberParticipationLedgerTotalsDto;
}

export interface MemberDepartmentResponseDto {
  "id": string;
  "memberId": string;
  "organizationId": string;
  "createdAt": string;
  "updatedAt": string;
}

export interface MemberInsuranceAdminResponseDto {
  "id": string;
  "memberId": string;
  "insurerName": string;
  "policyNumber": string;
  "coverageStart"?: Record<string, unknown> | null;
  "coverageEnd": string;
  "createdAt": string;
  "updatedAt": string;
  "reviewStatusCode": string;
  "version": number;
  "reviewedAt"?: Record<string, unknown> | null;
}

export interface MemberInsuranceOverviewResponseDto {
  "memberId": string;
  "asOfDate": string;
  "summary": MemberInsuranceOverviewSummaryDto;
  "selfPurchased": MemberInsuranceOverviewSelfItemDto[];
  "teamProvided": MemberInsuranceOverviewTeamItemDto[];
}

export interface MemberInsuranceOverviewSelfItemDto {
  "id": string;
  "insurerName": string;
  "policyNumber": string;
  "coverageStart"?: string | null;
  "coverageEnd": string;
  "reviewStatusCode": string;
  "version": number;
  "reviewedAt"?: string | null;
  "createdAt": string;
  "updatedAt": string;
  "dateStatus": "upcoming" | "active" | "expired";
}

export interface MemberInsuranceOverviewSummaryDto {
  "dateActiveSelfPurchasedCount": number;
  "confirmedActiveSelfPurchasedCount": number;
  "dateActiveTeamProvidedCount": number;
  "hasConfirmedCoverage": boolean;
  "confirmedCoverageThrough"?: string | null;
}

export interface MemberInsuranceOverviewTeamItemDto {
  "coverageId": string;
  "policyId": string;
  "insurerName": string;
  "coverageStart": string;
  "coverageEnd": string;
  "coverageAddedAt": string;
  "dateStatus": "upcoming" | "active" | "expired";
}

export interface MemberInsuranceWorkbenchItemDto {
  "id": string;
  "member": MemberInsuranceWorkbenchMemberDto;
  "insurerName": string;
  "policyNumberMasked"?: Record<string, unknown> | null;
  "coverageStart"?: Record<string, unknown> | null;
  "coverageEnd": string;
  "reviewStatusCode": string;
  "version": number;
  "reviewedAt"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface MemberInsuranceWorkbenchMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname"?: Record<string, unknown> | null;
  "label": string;
}

export interface MemberOffboardActivityClosureDto {
  "status": string;
}

export interface MemberOffboardActivityImpactItemDto {
  "activityId": string;
  "title": string;
  "statusCode": string;
  "closure": MemberOffboardActivityClosureDto;
  "responsibilityType": "initiator" | "owner" | "collaborator";
}

export interface MemberOffboardImpactResponseDto {
  "draftInitiatedActivities": MemberOffboardActivityImpactItemDto[];
  "activeOwnerActivities": MemberOffboardActivityImpactItemDto[];
  "activeCollaboratorActivities": MemberOffboardActivityImpactItemDto[];
  "futureRegistrations": MemberOffboardRegistrationImpactItemDto[];
  "historicalRegistrationsWithEvidence": MemberOffboardRegistrationImpactItemDto[];
  "canOffboard": boolean;
  "blockingReasons": "draft-initiator-handoff-required" | "active-owner-handoff-required" | "registration-cleanup-required"[];
}

export interface MemberOffboardRegistrationImpactItemDto {
  "activityId": string;
  "title": string;
  "statusCode": string;
  "closure": MemberOffboardActivityClosureDto;
  "registrationId": string;
  "registrationStatus": "pending" | "waitlisted" | "pass";
  "hasParticipationEvidence": boolean;
}

export interface MemberOffboardResponseDto {
  "member": MemberResponseDto;
  "memberDeactivated": boolean;
  "membershipsEnded": number;
  "accountDisabled": boolean;
  "refreshTokensRevoked": number;
  "linkedUserId"?: Record<string, unknown> | null;
  "residualActivePositionAssignments": number;
  "residualActiveSupervisions": number;
}

export interface MemberOfficialPortraitDto {
  "id": string;
  "memberId": string;
  "version": number;
  "status": "ACTIVE" | "SUPERSEDED" | "VOIDED";
  "specVersion": string;
  "source": "ADMIN_UPLOAD" | "LEGACY_IMPORT";
  "capturedAt": string | null;
  "activatedAt": string;
  "endedAt": string | null;
  "endReason": string | null;
  "attachmentId": string | null;
  "accessUrl": string | null;
  "accessUrlExpiresAt": string | null;
}

export interface MemberOptionItemDto {
  "id": string;
  "label": string;
  "memberNo": string;
  "gradeCode"?: Record<string, unknown> | null;
}

export interface MemberOptionsResponseDto {
  "items": MemberOptionItemDto[];
}

export interface MemberParticipationLedgerTotalsDto {
  "committedServiceHours": string;
  "committedContributionPoints": string;
  "inFlightServiceHours": string;
  "inFlightContributionPoints": string;
}

export interface MemberParticipationSummaryDto {
  "memberId": string;
  "totalServiceHours": string;
  "activityCount": number;
  "recordCount": number;
  "contributionPoints": string;
  "ledgerTotals": MemberParticipationLedgerTotalsDto;
}

export interface MemberProfileResponseDto {
  "id": string;
  "memberId": string;
  "genderCode": string;
  "birthDate": Record<string, unknown> | null;
  "documentTypeCode": string;
  "documentNumber": string;
  "ethnicityCode"?: Record<string, unknown> | null;
  "politicalStatusCode"?: Record<string, unknown> | null;
  "isVeteran"?: Record<string, unknown> | null;
  "maritalStatusCode"?: Record<string, unknown> | null;
  "educationCode"?: Record<string, unknown> | null;
  "major"?: Record<string, unknown> | null;
  "workNatureCode"?: Record<string, unknown> | null;
  "residenceArea"?: Record<string, unknown> | null;
  "workArea"?: Record<string, unknown> | null;
  "mobile": string;
  "landline"?: Record<string, unknown> | null;
  "email"?: Record<string, unknown> | null;
  "qq"?: Record<string, unknown> | null;
  "wechat"?: Record<string, unknown> | null;
  "heightCm"?: Record<string, unknown> | null;
  "weightKg"?: Record<string, unknown> | null;
  "bloodTypeCode"?: Record<string, unknown> | null;
  "eyesight"?: Record<string, unknown> | null;
  "medicalNotes"?: MedicalNoteItemDto[] | null;
  "hasVehicle"?: Record<string, unknown> | null;
  "vehicleType"?: Record<string, unknown> | null;
  "exerciseFrequencyCode"?: Record<string, unknown> | null;
  "exerciseSportCode"?: Record<string, unknown> | null;
  "exerciseMethods": string[];
  "firstAidKnowledgeCode"?: Record<string, unknown> | null;
  "firstAidSkills": string[];
  "otherSkills"?: Record<string, unknown> | null;
  "noCriminalRecordSigned"?: Record<string, unknown> | null;
  "privacyConsentSigned": boolean;
  "privacyConsentSignedAt"?: Record<string, unknown> | null;
  "volunteerNo"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface MemberResponseDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname"?: Record<string, unknown> | null;
  "label": string;
  "memberSinceDate": string;
  "memberOriginCode": string;
  "gradeCode"?: Record<string, unknown> | null;
  "status": "ACTIVE" | "INACTIVE";
  "hasAccount": boolean;
  "accountStatus"?: "ACTIVE" | "DISABLED" | null;
  "userId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "officialPortraitId": string | null;
  "hasOfficialPortrait": boolean;
}

export interface MembershipConflictItemDto {
  "type": "multiple_active_primary" | "dangling_member" | "dangling_organization" | "inactive_organization";
  "memberId"?: Record<string, unknown> | null;
  "organizationId"?: Record<string, unknown> | null;
  "membershipIds": string[];
}

export interface MembershipConflictsResponseDto {
  "items": MembershipConflictItemDto[];
  "total": number;
}

export interface MembershipExpandedMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: Record<string, unknown> | null;
}

export interface MembershipExpandedOrganizationDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
}

export interface MembershipResponseDto {
  "id": string;
  "memberId": string;
  "organizationId": string;
  "membershipType": "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT";
  "status": "ACTIVE" | "ENDED" | "SUSPENDED";
  "startedAt": string;
  "endedAt"?: Record<string, unknown> | null;
  "reason"?: Record<string, unknown> | null;
  "createdByUserId"?: Record<string, unknown> | null;
  "endedByUserId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "member"?: MembershipExpandedMemberDto;
  "organization"?: MembershipExpandedOrganizationDto;
}

export interface MoveOrganizationDto {
  "parentId": string;
}

export interface NotificationAdminDetailDto {
  "id": string;
  "title": string;
  "body": string;
  "notificationTypeCode": string;
  "statusCode": string;
  "visibilityCode": string;
  "visibleOrganizationIds": string[];
  "audienceType": string;
  "sourceType": string;
  "channels": string[];
  "pinned": boolean;
  "readCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "authorUserId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface NotificationAdminListItemDto {
  "id": string;
  "title": string;
  "notificationTypeCode": string;
  "statusCode": string;
  "visibilityCode": string;
  "audienceType": string;
  "sourceType": string;
  "channels": string[];
  "pinned": boolean;
  "readCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "authorUserId"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface NotificationSmsSendResultDto {
  "confirmed": boolean;
  "recipientCount": number;
  "sent": number;
  "failed": number;
  "skipped": number;
}

export interface NotificationWecomReplayItemDto {
  "memberId": string | null;
  "outcome": "enqueued" | "already-sent" | "active-attempt-exists" | "notification-not-found" | "notification-deleted" | "notification-not-published" | "not-system-directed" | "channel-not-declared" | "never-attempted" | "last-attempt-not-replayable";
  "newIntentId"?: string;
  "newEventKey"?: string;
}

export interface NotificationWecomReplayResultDto {
  "replayed": number;
  "skipped": number;
  "results": NotificationWecomReplayItemDto[];
}

export interface OrganizationOptionItemDto {
  "id": string;
  "label": string;
  "code"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
  "parentId"?: Record<string, unknown> | null;
}

export interface OrganizationOptionsResponseDto {
  "items": OrganizationOptionItemDto[];
}

export interface OrganizationResponseDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "parentId"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
  "sortOrder": number;
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
}

export interface OrganizationSupervisorDto {
  "coverage": "DIRECT" | "INHERITED";
  "supervisionAssignment": SupervisionAssignmentResponseDto;
}

export interface OrganizationTreeNodeDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "parentId"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
  "sortOrder": number;
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
  "children": OrganizationTreeNodeDto[];
}

export interface OrganizationTreeOptionItemDto {
  "id": string;
  "label": string;
  "code"?: Record<string, unknown> | null;
  "children": OrganizationTreeOptionItemDto[];
}

export interface OrganizationTreeWithSummaryNodeDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
  "status": "ACTIVE" | "INACTIVE";
  "directMembershipCount": number;
  "subtreeMembershipCount": number;
  "children": OrganizationTreeWithSummaryNodeDto[];
}

export interface ParticipationOverviewMonthDto {
  "month": string;
  "activityCount": number;
  "completedActivityCount": number;
  "participationCount": number;
  "totalServiceHours": string;
  "averageAttendanceRate": number;
  "noShowRate": number;
  "durationHistogram": DurationHistogramDto;
}

export interface ParticipationOverviewResponseDto {
  "months": ParticipationOverviewMonthDto[];
}

export interface PositionAssignmentExpandedMemberDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: Record<string, unknown> | null;
}

export interface PositionAssignmentExpandedOrganizationDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
}

export interface PositionAssignmentExpandedPositionDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": string;
}

export interface PositionAssignmentPreviewResponseDto {
  "valid": boolean;
  "violations": PositionAssignmentViolationDto[];
}

export interface PositionAssignmentResponseDto {
  "id": string;
  "organizationId": string;
  "positionId": string;
  "memberId": string;
  "status": "ACTIVE" | "ENDED" | "REVOKED";
  "startedAt": string;
  "endedAt"?: Record<string, unknown> | null;
  "appointedByUserId"?: Record<string, unknown> | null;
  "revokedByUserId"?: Record<string, unknown> | null;
  "appointmentSource"?: Record<string, unknown> | null;
  "isConcurrent": boolean;
  "note"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "member"?: PositionAssignmentExpandedMemberDto;
  "position"?: PositionAssignmentExpandedPositionDto;
  "organization"?: PositionAssignmentExpandedOrganizationDto;
}

export interface PositionAssignmentViolationDto {
  "bizCode": number;
  "message": string;
}

export interface PositionOptionItemDto {
  "id": string;
  "label": string;
  "categoryCode": "LEADER" | "DEPUTY" | "STAFF";
}

export interface PositionOptionsResponseDto {
  "items": PositionOptionItemDto[];
}

export interface PositionResponseDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": "LEADER" | "DEPUTY" | "STAFF";
  "rank": number;
  "isLeadership": boolean;
  "allowMultiple": boolean;
  "allowConcurrent": boolean;
  "sortOrder": number;
  "status": "ACTIVE" | "INACTIVE";
  "description"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface PositionRuleResponseDto {
  "id": string;
  "nodeTypeCode": string;
  "positionId": string;
  "required": boolean;
  "minCount"?: number | null;
  "maxCount"?: number | null;
  "requireMembership": boolean;
  "allowConcurrent": boolean;
  "status": "ACTIVE" | "INACTIVE";
  "createdAt": string;
  "updatedAt": string;
}

export interface PreviewPositionAssignmentDto {
  "organizationId": string;
  "positionId": string;
  "memberId": string;
  "startedAt": string;
  "endedAt"?: string;
  "isConcurrent"?: boolean;
  "appointmentSource"?: string;
  "note"?: string;
}

export interface PromotePrecheckResultDto {
  "cycleId": string;
  "cycleYear": number;
  "rows": PromotePrecheckRowDto[];
  "promotableCount": number;
  "skipCount": number;
  "total": number;
}

export interface PromotePrecheckRowDto {
  "applicationId": string;
  "realName"?: Record<string, unknown> | null;
  "willIssue": boolean;
  "skipReason"?: Record<string, unknown> | null;
  "proposedMemberNo"?: Record<string, unknown> | null;
  "isNonMainlandDocument": boolean;
  "documentTypeCode": string;
  "missingOpenid": boolean;
  "openidAlreadyBound": boolean;
  "duplicateOpenidInBatch": boolean;
  "phoneAlreadyBound": boolean;
  "duplicatePhoneInBatch": boolean;
  "missingPhone": boolean;
  "missingBirthDate": boolean;
  "missingGender": boolean;
}

export interface PromoteResultDto {
  "cycleId": string;
  "promotedCount": number;
  "skippedCount": number;
  "promoted": PromotedItemDto[];
  "skipped": PromoteSkippedItemDto[];
}

export interface PromoteSingleResultDto {
  "applicationId": string;
  "memberId": string;
  "memberNo": string;
  "realName"?: Record<string, unknown> | null;
  "loginChannel": "wechat" | "phone";
}

export interface PromoteSkippedItemDto {
  "applicationId": string;
  "realName"?: Record<string, unknown> | null;
  "reason": string;
}

export interface PromotedItemDto {
  "applicationId": string;
  "memberId": string;
  "memberNo": string;
  "realName"?: Record<string, unknown> | null;
}

export interface PublicityListItemDto {
  "applicationId": string;
  "realName"?: Record<string, unknown> | null;
  "proposedMemberNo"?: Record<string, unknown> | null;
  "isNonMainlandDocument": boolean;
  "needsManualBuild": boolean;
}

export interface PublicityListResponseDto {
  "cycleId": string;
  "cycleYear": number;
  "items": PublicityListItemDto[];
  "promotableCount": number;
  "manualBuildCount": number;
}

export interface PublishActivityDto {
  "requiresInsuranceConfirmed": boolean;
}

export interface PublishActivityWithAudienceTagsDto {
  "requiresInsuranceConfirmed": boolean;
  "audienceTagCodes": string[];
  "audienceOrganizationIds"?: string[];
}

export interface QualificationFlagResponseDto {
  "memberId": string;
  "criterionType": "category" | "standard";
  "criterionCode": string;
  "qualified": boolean;
  "matchedCertificateId"?: string | null;
  "expiredAt"?: string | null;
}

export interface RecruitmentApplicationAdminDto {
  "id": string;
  "cycleId": string;
  "statusCode": string;
  "tempNo"?: Record<string, unknown> | null;
  "realName"?: Record<string, unknown> | null;
  "idCardNumber"?: Record<string, unknown> | null;
  "phone"?: Record<string, unknown> | null;
  "documentTypeCode": string;
  "isNonMainlandDocument": boolean;
  "genderCode"?: Record<string, unknown> | null;
  "ageGroup"?: Record<string, unknown> | null;
  "cityDistrict"?: Record<string, unknown> | null;
  "verifyOutcome"?: Record<string, unknown> | null;
  "riskLevel"?: Record<string, unknown> | null;
  "manualReviewReason"?: Record<string, unknown> | null;
  "eliminationStage"?: Record<string, unknown> | null;
  "hasIdCardImage": boolean;
  "ocrAddress"?: Record<string, unknown> | null;
  "ocrNation"?: Record<string, unknown> | null;
  "ocrAuthority"?: Record<string, unknown> | null;
  "ocrValidDate"?: Record<string, unknown> | null;
  "hasIdCardCropImage": boolean;
  "hasIdCardPortraitImage": boolean;
  "thresholdMarks"?: Record<string, unknown> | null;
  "thresholdsComplete": boolean;
  "evaluationNote"?: Record<string, unknown> | null;
  "promotedMemberId"?: Record<string, unknown> | null;
  "needsManualBuild": boolean;
  "createdAt": string;
}

export interface RecruitmentCertificateClaimAdminDto {
  "id": string;
  "applicationId": string;
  "version": number;
  "status": "SUBMITTED" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "PROMOTED" | "WITHDRAWN";
  "categoryHintCode": string;
  "rawCertificateName"?: string | null;
  "suggestedStandard"?: ClaimStandardSummaryDto;
  "standard"?: ClaimStandardSummaryDto;
  "recognitionPolicyId"?: string | null;
  "recognitionIssuerId"?: string | null;
  "issuingOrg"?: string | null;
  "certNumberMasked"?: string | null;
  "certNumberFull"?: string | null;
  "issuedAt"?: Record<string, unknown> | null;
  "expiredAt"?: Record<string, unknown> | null;
  "imageCount": number;
  "reviewedByUserId"?: string | null;
  "reviewedAt"?: Record<string, unknown> | null;
  "reviewNote"?: string | null;
  "promotedAt"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface RecruitmentCertificateClaimImageUrlsResponseDto {
  "claimId": string;
  "urls": string[];
  "expiresAt": string;
}

export interface RecruitmentCertificateClaimListResponseDto {
  "items": RecruitmentCertificateClaimAdminDto[];
}

export interface RecruitmentCycleResponseDto {
  "id": string;
  "year": number;
  "name": string;
  "statusCode": string;
  "capacity"?: Record<string, unknown> | null;
  "issuedCount": number;
  "meetingInfo"?: Record<string, unknown> | null;
  "qqGroup"?: Record<string, unknown> | null;
  "notifyTemplate"?: Record<string, unknown> | null;
  "openedAt"?: Record<string, unknown> | null;
  "closedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface RecruitmentCycleStatsDto {
  "cycleId": string;
  "cycleYear": number;
  "today": RecruitmentStatsTodayDto;
  "pending": RecruitmentStatsPendingDto;
  "threshold": RecruitmentStatsThresholdDto;
  "evaluation": RecruitmentStatsEvaluationDto;
  "issuance": RecruitmentStatsIssuanceDto;
  "withdrawnCount": number;
}

export interface RecruitmentStatsEvaluationDto {
  "pending": number;
  "passed": number;
  "eliminated": number;
}

export interface RecruitmentStatsIssuanceDto {
  "inPublicity": number;
  "oneClickIssuable": number;
  "needManualBuild": number;
  "promoted": number;
}

export interface RecruitmentStatsPendingDto {
  "manualTotal": number;
  "manualNormal": number;
  "manualHigh": number;
  "manualSystem": number;
  "pendingEvaluation": number;
  "pendingIssuance": number;
}

export interface RecruitmentStatsThresholdDto {
  "tracking": number;
  "byThreshold": RecruitmentStatsThresholdItemDto[];
}

export interface RecruitmentStatsThresholdItemDto {
  "code": string;
  "name": string;
  "completedCount": number;
}

export interface RecruitmentStatsTodayDto {
  "newApplications": number;
  "tempNoIssued": number;
  "manualProcessed": number;
}

export interface RejectAttendanceSheetDto {
  "reviewNote": string;
}

export interface RejectCertificateDto {
  "verifyNote": string;
}

export interface RejectRegistrationDto {
  "reviewNote": string;
}

export interface ReopenAttendanceSheetDto {
  "reason": string;
}

export interface ReplaceMemberAudienceTagsDto {
  "tagCodes": string[];
}

export interface ReplayNotificationWecomDto {
  "overrideReason"?: boolean;
}

export interface ResetUserPasswordDto {
  "newPassword": string;
}

export interface ResolveLabelRefDto {
  "type": "member" | "user" | "organization" | "role" | "position" | "activity";
  "id": string;
}

export interface ResolveLabelsDto {
  "refs": ResolveLabelRefDto[];
}

export type ResolveLabelsResponseDto = Record<string, unknown>;

export interface ResolveRecruitmentApplicationDto {
  "approved": boolean;
  "reviewNote"?: string;
}

export interface ResolvedResourceDto {
  "resourceType": string;
  "resourceId": string;
  "organizationId"?: Record<string, unknown> | null;
  "organizationPath"?: string[] | null;
  "ownerMemberId"?: Record<string, unknown> | null;
  "ownerUserId"?: Record<string, unknown> | null;
  "activityId"?: Record<string, unknown> | null;
  "statusCode"?: Record<string, unknown> | null;
  "sensitivityLevel"?: "public" | "internal" | "sensitive" | null;
  "extra"?: Record<string, unknown>;
}

export type ResubmitAttendanceSheetDto = Record<string, unknown>;

export interface ReturnActivityPublishReviewDto {
  "reviewNote": string;
  "operationKey"?: string;
}

export interface ReturnAttendanceSheetDto {
  "returnNote": string;
}

export interface ReviewCertificateClaimDto {
  "decision": "APPROVE" | "REJECT" | "NEEDS_INFO";
  "version": number;
  "standardId"?: string;
  "recognitionIssuerId"?: string;
  "issuingOrg"?: string;
  "certNumber"?: string;
  "issuedAt"?: string;
  "expiredAt"?: string;
  "note"?: string;
}

export interface ReviewMemberInsuranceDto {
  "decision": "verified" | "rejected";
  "expectedVersion": number;
}

export interface RevokeCertificateClaimReviewDto {
  "version": number;
  "note": string;
}

export interface RoleBindingBatchItemResultDto {
  "index": number;
  "outcome": "ok" | "blocked" | "already-exists";
  "bindingId"?: Record<string, unknown> | null;
  "bizCode"?: Record<string, unknown> | null;
  "message"?: Record<string, unknown> | null;
}

export interface RoleBindingBatchSummaryDto {
  "total": number;
  "ok": number;
  "blocked": number;
  "alreadyExists": number;
}

export interface RoleBindingExpandedPrincipalDto {
  "type": "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SERVICE_PRINCIPAL" | "SYSTEM";
  "id": string;
  "username"?: string;
  "clientId"?: string;
  "servicePrincipalName"?: string;
  "nickname"?: Record<string, unknown> | null;
  "memberNo"?: string;
  "realName"?: string;
  "memberLabel"?: string;
  "organizationId"?: string;
  "positionId"?: string;
  "memberId"?: string;
}

export interface RoleBindingExpandedRoleDto {
  "id": string;
  "code": string;
  "displayName": string;
}

export interface RoleBindingPreviewConflictDto {
  "bizCode"?: Record<string, unknown> | null;
  "message": string;
}

export interface RoleBindingPreviewResponseDto {
  "valid": boolean;
  "conflicts": RoleBindingPreviewConflictDto[];
  "resolvedScope": RoleBindingResolvedScopeDto;
}

export interface RoleBindingResolvedScopeDto {
  "scopeType": "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF";
  "scopeOrgId"?: Record<string, unknown> | null;
  "scopeActivityId"?: Record<string, unknown> | null;
  "scopeResourceType"?: Record<string, unknown> | null;
  "scopeResourceId"?: Record<string, unknown> | null;
}

export interface RoleBindingResponseDto {
  "id": string;
  "principalType": "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SERVICE_PRINCIPAL" | "SYSTEM";
  "principalId"?: Record<string, unknown> | null;
  "roleId": string;
  "scopeType": "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF";
  "scopeOrgId"?: Record<string, unknown> | null;
  "scopeActivityId"?: Record<string, unknown> | null;
  "scopeResourceType"?: Record<string, unknown> | null;
  "scopeResourceId"?: Record<string, unknown> | null;
  "status": "ACTIVE" | "ENDED" | "SUSPENDED";
  "startedAt": string;
  "endedAt"?: Record<string, unknown> | null;
  "createdByUserId"?: Record<string, unknown> | null;
  "note"?: Record<string, unknown> | null;
  "scopeInactive": boolean;
  "createdAt": string;
  "updatedAt": string;
  "role"?: RoleBindingExpandedRoleDto;
  "principal"?: RoleBindingExpandedPrincipalDto;
}

export interface SendNotificationSmsDto {
  "confirmed": boolean;
}

export interface SetActivityCoverDto {
  "attachmentId": string | null;
}

export interface SetActivityGalleryDto {
  "attachmentIds": string[];
}

export interface SetContentCoverDto {
  "attachmentId": string | null;
}

export interface SetMemberDepartmentDto {
  "organizationId": string;
}

export interface SupervisionAssignmentResponseDto {
  "id": string;
  "supervisorMemberId": string;
  "organizationId": string;
  "scopeMode": "EXACT" | "TREE";
  "status": "ACTIVE" | "ENDED" | "REVOKED";
  "startedAt": string;
  "endedAt"?: Record<string, unknown> | null;
  "appointedByUserId"?: Record<string, unknown> | null;
  "revokedByUserId"?: Record<string, unknown> | null;
  "note"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
  "supervisor"?: SupervisionExpandedSupervisorDto;
  "organization"?: SupervisionExpandedOrganizationDto;
}

export interface SupervisionCoveragePreviewDto {
  "organizationId": string;
  "scopeMode"?: "EXACT" | "TREE";
}

export interface SupervisionCoveragePreviewResponseDto {
  "organizationId": string;
  "scopeMode": "EXACT" | "TREE";
  "expandedOrganizationIds": string[];
}

export interface SupervisionExpandedOrganizationDto {
  "id": string;
  "name": string;
  "code"?: Record<string, unknown> | null;
  "nodeTypeCode": string;
}

export interface SupervisionExpandedSupervisorDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
  "gradeCode"?: Record<string, unknown> | null;
}

export interface SupervisionScopeEntryDto {
  "supervisionAssignmentId": string;
  "organizationId": string;
  "scopeMode": "EXACT" | "TREE";
  "expandedOrganizationIds": string[];
}

export interface TeamInsuranceCoverageResponseDto {
  "id": string;
  "policyId": string;
  "memberId": string;
  "memberNo": string;
  "memberRealName": string;
  "memberLabel": string;
  "createdAt": string;
}

export interface TeamInsurancePolicyResponseDto {
  "id": string;
  "insurerName": string;
  "policyNumber": string;
  "coverageStart": string;
  "coverageEnd": string;
  "note"?: Record<string, unknown> | null;
  "createdAt": string;
  "updatedAt": string;
}

export interface TeamJoinApplicationAdminDto {
  "id": string;
  "cycleId": string;
  "memberId": string;
  "memberNo"?: Record<string, unknown> | null;
  "memberRealName"?: Record<string, unknown> | null;
  "memberLabel"?: Record<string, unknown> | null;
  "statusCode": string;
  "targetOrganizationIds": string[];
  "selectedOrganizationId"?: Record<string, unknown> | null;
  "gates": GateStatusDto[];
  "generalGatesSatisfied": boolean;
  "contributionPoints"?: Record<string, unknown> | null;
  "contributionSatisfied"?: Record<string, unknown> | null;
  "evaluationNote"?: Record<string, unknown> | null;
  "evaluatedAt"?: Record<string, unknown> | null;
  "evaluationExtendedUntil"?: Record<string, unknown> | null;
  "eliminationStage"?: Record<string, unknown> | null;
  "joinedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface TeamJoinCycleResponseDto {
  "id": string;
  "year": number;
  "name": string;
  "statusCode": string;
  "requiresInsurance": boolean;
  "openedAt"?: Record<string, unknown> | null;
  "closedAt"?: Record<string, unknown> | null;
  "openOrganizationIds"?: string[] | null;
  "maxTargetOrgs"?: number | null;
  "createdAt": string;
}

export interface TransferActivityOwnerDto {
  "newOwnerMemberId": string;
  "reason": string;
  "retainPreviousOwnerAsCollaborator": boolean;
}

export interface TransferMembershipDto {
  "memberId": string;
  "fromOrganizationId": string;
  "toOrganizationId": string;
  "membershipType": "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT";
  "reason"?: string;
}

export interface UpdateActivityDto {
  "title"?: string;
  "activityTypeCode"?: string;
  "allocationModeCode"?: "first_come" | "qualification_rank" | "lottery";
  "organizationId"?: string;
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
  "registrationModeCode"?: "open_apply" | "invitation_only" | "admin_only" | "paused";
  "visibilityCode"?: "internal" | "invitation";
  "defaultCheckInRadiusMeters"?: number | null;
  "defaultLocationRequired"?: boolean | null;
  "archiveWaitingDays"?: number;
  "registrationSchema"?: Record<string, unknown>;
  "content"?: Record<string, unknown>;
  "locationLongitude"?: number;
  "locationLatitude"?: number;
}

export interface UpdateActivityPositionDto {
  "name"?: string;
  "attendanceRoleCode"?: string;
  "capacity"?: number | null;
  "startAt"?: string | null;
  "endAt"?: string | null;
  "genderRequirementCode"?: string | null;
  "description"?: string | null;
  "sortOrder"?: number;
}

export interface UpdateAttachmentDto {
  "description"?: Record<string, unknown>;
  "accessLevel"?: "PUBLIC" | "INTERNAL" | "SENSITIVE";
  "tags"?: string[];
  "expireAt"?: Record<string, unknown>;
}

export interface UpdateAttendanceSheetDto {
  "records"?: AttendanceRecordInputDto[];
}

export interface UpdateCertificateDto {
  "standardId"?: string;
  "recognitionIssuerId"?: string | null;
  "issuingOrg"?: string | null;
  "certNumber"?: string | null;
  "issuedAt"?: string;
  "expiredAt"?: string | null;
}

export interface UpdateCertificateRecognitionPolicyDto {
  "issuerPolicy"?: "FIXED" | "ALLOWLIST" | "FREE_TEXT";
  "validityMode"?: "PERMANENT" | "FIXED_MONTHS" | "EXPLICIT_REQUIRED" | "EXPLICIT_OPTIONAL";
  "validityMonths"?: number;
  "certNumberMode"?: "REQUIRED" | "OPTIONAL" | "NONE";
  "issuers"?: CertificateRecognitionIssuerInputDto[];
}

export interface UpdateCertificateRecognitionPolicyStatusDto {
  "status": "ACTIVE";
}

export interface UpdateCertificateStandardDto {
  "name"?: string;
  "description"?: string | null;
  "sortOrder"?: number;
  "kind"?: "FAMILY" | "CREDENTIAL";
  "categoryCode"?: string;
  "levelCode"?: string | null;
  "parentId"?: string | null;
  "isInternal"?: boolean;
}

export interface UpdateCertificateStandardStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdateContentDto {
  "title"?: string;
  "summary"?: Record<string, unknown>;
  "body"?: string;
  "contentTypeCode"?: string;
  "visibilityCode"?: "public" | "member" | "formal_member" | "department" | "management";
  "visibleOrganizationIds"?: string[];
  "tags"?: string[];
  "pinned"?: boolean;
}

export interface UpdateEmergencyContactDto {
  "contactName"?: string;
  "relationCode"?: string;
  "phonePrimary"?: string;
  "phoneBackup"?: string;
  "address"?: string;
  "priority"?: number;
}

export interface UpdateMemberAccountStatusDto {
  "status": "ACTIVE" | "DISABLED";
}

export interface UpdateMemberDto {
  "realName"?: string;
  "nickname"?: Record<string, unknown> | null;
  "gradeCode"?: string;
}

export interface UpdateMemberProfileDto {
  "genderCode"?: string;
  "birthDate"?: string;
  "documentTypeCode"?: string;
  "documentNumber"?: string;
  "ethnicityCode"?: string;
  "politicalStatusCode"?: string;
  "isVeteran"?: boolean;
  "maritalStatusCode"?: string;
  "educationCode"?: string;
  "major"?: string;
  "workNatureCode"?: string;
  "residenceArea"?: string;
  "workArea"?: string;
  "mobile"?: string;
  "landline"?: string;
  "email"?: string;
  "qq"?: string;
  "wechat"?: string;
  "heightCm"?: number;
  "weightKg"?: number;
  "bloodTypeCode"?: string;
  "eyesight"?: string;
  "medicalNotes"?: MedicalNoteItemDto[];
  "hasVehicle"?: boolean;
  "vehicleType"?: string;
  "exerciseFrequencyCode"?: string;
  "exerciseSportCode"?: string;
  "exerciseMethods"?: string[];
  "firstAidKnowledgeCode"?: string;
  "firstAidSkills"?: string[];
  "otherSkills"?: string;
  "noCriminalRecordSigned"?: boolean;
  "privacyConsentSigned"?: boolean;
  "privacyConsentSignedAt"?: string;
  "volunteerNo"?: string;
}

export interface UpdateMemberStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdateMembershipDto {
  "membershipType"?: "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT";
  "startedAt"?: string;
  "endedAt"?: string;
  "reason"?: string;
}

export interface UpdateNotificationDto {
  "title"?: string;
  "body"?: string;
  "notificationTypeCode"?: string;
  "visibilityCode"?: "member" | "formal_member" | "department" | "management";
  "visibleOrganizationIds"?: string[];
  "pinned"?: boolean;
  "channels"?: "in-app" | "wechat" | "wecom" | "sms"[];
}

export interface UpdateOrganizationDto {
  "name"?: string;
  "code"?: string;
  "sortOrder"?: number;
  "nodeTypeCode"?: string;
}

export interface UpdateOrganizationStatusDto {
  "status": "ACTIVE" | "INACTIVE";
}

export interface UpdatePositionDto {
  "name"?: string;
  "categoryCode"?: "LEADER" | "DEPUTY" | "STAFF";
  "rank"?: number;
  "isLeadership"?: boolean;
  "allowMultiple"?: boolean;
  "allowConcurrent"?: boolean;
  "sortOrder"?: number;
  "status"?: "ACTIVE" | "INACTIVE";
  "description"?: Record<string, unknown> | null;
}

export interface UpdatePositionRuleDto {
  "required"?: boolean;
  "minCount"?: number | null;
  "maxCount"?: number | null;
  "requireMembership"?: boolean;
  "allowConcurrent"?: boolean;
  "status"?: "ACTIVE" | "INACTIVE";
}

export interface UpdateRecruitmentApplicationDto {
  "realName"?: string;
  "idCardNumber"?: string;
  "birthDate"?: string;
  "genderCode"?: "male" | "female";
  "detailedAddress"?: string;
  "cityDistrict"?: string;
  "sourceChannel"?: string;
  "emergencyContacts"?: EmergencyContactInputDto[];
  "profileExtra"?: Record<string, unknown>;
}

export interface UpdateRecruitmentCycleDto {
  "statusCode"?: string;
  "capacity"?: Record<string, unknown> | null;
  "meetingInfo"?: string;
  "qqGroup"?: string;
  "notifyTemplate"?: Record<string, unknown>;
}

export interface UpdateRoleBindingDto {
  "status"?: "ACTIVE" | "ENDED" | "SUSPENDED";
  "startedAt"?: string;
  "endedAt"?: string;
  "note"?: string;
}

export interface UpdateSupervisionAssignmentDto {
  "scopeMode"?: "EXACT" | "TREE";
  "startedAt"?: string;
  "endedAt"?: string;
  "note"?: string;
}

export interface UpdateTeamInsurancePolicyDto {
  "insurerName"?: string;
  "policyNumber"?: string;
  "coverageStart"?: string;
  "coverageEnd"?: string;
  "note"?: string;
}

export interface UpdateTeamJoinCycleDto {
  "statusCode"?: string;
  "name"?: string;
  "requiresInsurance"?: boolean;
  "openOrganizationIds"?: string[] | null;
  "maxTargetOrgs"?: number | null;
}

export interface UpdateUserDto {
  "email"?: string;
  "nickname"?: string;
  "avatarKey"?: string;
}

export interface UpdateUserRoleDto {
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
}

export interface UpdateUserStatusDto {
  "status": "ACTIVE" | "DISABLED";
}

export interface UploadUrlResponseDto {
  "key": string;
  "uploadUrl": string;
  "uploadHeaders": Record<string, unknown>;
  "uploadMethod": "PUT" | "POST";
  "expiresAt": string;
  "uploadToken": string;
}

export interface UpsertWechatSubscribeTemplateDto {
  "templateId"?: string | null;
  "enabled"?: boolean;
  "remarks"?: string | null;
}

export interface UserOptionItemDto {
  "id": string;
  "label": string;
  "username": string;
}

export interface UserOptionsResponseDto {
  "items": UserOptionItemDto[];
}

export interface VerifyCertificateDto {
  "verifyNote"?: string;
}

export interface VoidMemberOfficialPortraitDto {
  "reason": string;
}

export interface WechatSubscribeTemplateDto {
  "notificationTypeCode": string;
  "templateId"?: Record<string, unknown> | null;
  "enabled": boolean;
  "remarks"?: Record<string, unknown> | null;
  "updatedBy"?: Record<string, unknown> | null;
  "updatedAt": string;
}

export interface WorkbenchMemberSummaryDto {
  "id": string;
  "memberNo": string;
  "realName": string;
  "nickname": string | null;
  "label": string;
}

export interface WorkbenchStandardSummaryDto {
  "id": string;
  "code": string;
  "name": string;
  "categoryCode": string;
  "levelCode"?: string | null;
}
