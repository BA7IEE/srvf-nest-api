// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: Admin 管理后台
// generatorVersion: 1.0.0
// inputDigest: sha256:d640132922db38cca8e13d36b3660d471332aea3d611e07c03ab6667c065445d
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  ActionStateBatchDto,
  ActionStateBatchResponseDto,
  ActionStateItemDto,
  ActionStateResultItemDto,
  ActivityFeedbackAggregateDto,
  ActivityFeedbackRatingBucketDto,
  ActivityListItemDto,
  ActivityOptionItemDto,
  ActivityOptionsResponseDto,
  ActivityParticipationSummaryDto,
  ActivityPositionResponseDto,
  ActivityPublishReviewResponseDto,
  ActivityReconciliationDto,
  ActivityReconciliationRegisteredParticipantDto,
  ActivityReconciliationTemporaryParticipantDto,
  ActivityRegistrationActivityPositionDto,
  ActivityRegistrationCountsDto,
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  ActivityResponseDto,
  ActivityResponsibilitiesResponseDto,
  ActivityResponsibilityAssignmentDto,
  ActivityResponsibilityMemberDto,
  AddAllActiveCoverageResultDto,
  AddTeamInsuranceCoverageDto,
  AdminActivityCheckInListItemDto,
  AdminActivityCheckInMemberDto,
  AdminActivityFeedbackListItemDto,
  AdminActivityFeedbackSummaryDto,
  AdminAttendanceSettlementListItemDto,
  AdminAttendanceSheetExpandedActivityDto,
  AdminAttendanceSheetListItemDto,
  AdminMeResponseDto,
  AdminMemberAttendanceRecordDto,
  AdminParticipationLedgerEntryDto,
  AdminRegistrationExpandedActivityDto,
  AdminRegistrationExpandedMemberDto,
  AdminRegistrationListItemDto,
  AdminSettlementApproveCommandDto,
  AdminSettlementPostingBatchDto,
  AdminSettlementReturnCommandDto,
  AdminSettlementReviewDetailDto,
  AdminSettlementReviewDiffDto,
  AdminSettlementReviewGapDto,
  AdminSettlementReviewResponseDto,
  AdminSettlementReviewVersionDto,
  AdminSettlementSealRevisionDto,
  AnnouncementImportRequestDto,
  AnnouncementImportResultDto,
  ApproveActivityPublishReviewDto,
  ApproveAttendanceSheetDto,
  ApproveRegistrationDto,
  AssignLegacyActivityInitiatorDto,
  AttachmentResponseDto,
  AttendanceRecordInputDto,
  AttendanceRecordResponseDto,
  AttendanceSheetActivitySummaryDto,
  AttendanceSheetDraftAbsentRegistrationDto,
  AttendanceSheetDraftDto,
  AttendanceSheetDraftFlagDto,
  AttendanceSheetDraftRecordDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  AuthzDecisionDto,
  BatchCreateRoleBindingsDto,
  BatchCreateRoleBindingsResponseDto,
  BatchMarkThresholdDto,
  BatchMarkThresholdMatchDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
  BindMemberAccountDto,
  BulkGrantAccountItemDto,
  BulkGrantAccountResultItemDto,
  BulkGrantMemberAccountsDto,
  BulkGrantMemberAccountsResponseDto,
  BulkGrantSummaryDto,
  BulkReviewFailureDto,
  BulkReviewRegistrationsDto,
  BulkReviewRegistrationsResponseDto,
  CancelActivityDto,
  CancelRegistrationDto,
  CertificateEvidenceUrlsResponseDto,
  CertificateListItemDto,
  CertificateRecognitionIssuerInputDto,
  CertificateRecognitionIssuerResponseDto,
  CertificateRecognitionPolicyListResponseDto,
  CertificateRecognitionPolicyResponseDto,
  CertificateResponseDto,
  CertificateStandardOptionIssuerDto,
  CertificateStandardOptionItemDto,
  CertificateStandardOptionPolicyDto,
  CertificateStandardOptionsResponseDto,
  CertificateStandardResponseDto,
  CertificateWorkbenchItemDto,
  CertificateWorkbenchStatsDto,
  ClaimLegacyActivityDto,
  ClaimStandardSummaryDto,
  ConfirmUploadDto,
  ContentAdminDetailDto,
  ContentAdminListItemDto,
  ContentAttachmentConfirmDto,
  ContentAttachmentDto,
  ContentAttachmentUploadUrlDto,
  CreateActivityCollaboratorDto,
  CreateActivityDto,
  CreateActivityPositionDto,
  CreateAttachmentDto,
  CreateAttendanceSheetDto,
  CreateCertificateDto,
  CreateCertificateRecognitionPolicyDto,
  CreateCertificateStandardDto,
  CreateContentDto,
  CreateEmergencyContactDto,
  CreateMemberDto,
  CreateMemberProfileDto,
  CreateMembershipDto,
  CreateNotificationDto,
  CreateOrganizationDto,
  CreatePositionAssignmentDto,
  CreatePositionDto,
  CreatePositionRuleDto,
  CreateRecruitmentCycleDto,
  CreateRegistrationDto,
  CreateRoleBindingDto,
  CreateSupervisionAssignmentDto,
  CreateTeamInsurancePolicyDto,
  CreateTeamJoinCycleDto,
  CreateUserDto,
  DashboardActivitiesSummaryDto,
  DashboardActivityPublishReviewsSummaryDto,
  DashboardAttendanceSheetsSummaryDto,
  DashboardRegistrationsSummaryDto,
  DashboardSummaryResponseDto,
  DurationHistogramDto,
  EmergencyContactInputDto,
  EmergencyContactResponseDto,
  EvaluateRecruitmentApplicationDto,
  EvaluateTeamJoinApplicationDto,
  ExplainAuthzBatchDto,
  ExplainAuthzBatchResponseDto,
  ExplainAuthzDto,
  ExplainAuthzResponseDto,
  ExplainBatchItemDto,
  ExplainBatchResultItemDto,
  ExplainResourceRefDto,
  ExplainTargetUserDto,
  ExportRecruitmentApplicationsDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  GateStatusDto,
  GenerateUploadUrlDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  IdCardImageUrlResponseDto,
  ImportOrganizationRowDto,
  ImportOrganizationRowResultDto,
  ImportPositionRowDto,
  ImportPositionRowResultDto,
  ImportRowIssueDto,
  ImportSummaryDto,
  ImportSupervisionRowDto,
  ImportSupervisionRowResultDto,
  JoinTeamJoinApplicationDto,
  MarkGateDto,
  MarkThresholdDto,
  MatchedGrantDto,
  MedicalNoteItemDto,
  MemberAudienceTagDto,
  MemberAudienceTagsResponseDto,
  MemberContributionSummaryDto,
  MemberDepartmentResponseDto,
  MemberInsuranceAdminResponseDto,
  MemberInsuranceOverviewResponseDto,
  MemberInsuranceOverviewSelfItemDto,
  MemberInsuranceOverviewSummaryDto,
  MemberInsuranceOverviewTeamItemDto,
  MemberOffboardActivityClosureDto,
  MemberOffboardActivityImpactItemDto,
  MemberOffboardImpactResponseDto,
  MemberOffboardRegistrationImpactItemDto,
  MemberOffboardResponseDto,
  MemberOptionItemDto,
  MemberOptionsResponseDto,
  MemberParticipationSummaryDto,
  MemberProfileResponseDto,
  MemberResponseDto,
  MembershipConflictItemDto,
  MembershipConflictsResponseDto,
  MembershipExpandedMemberDto,
  MembershipExpandedOrganizationDto,
  MembershipResponseDto,
  MoveOrganizationDto,
  NotificationAdminDetailDto,
  NotificationAdminListItemDto,
  NotificationSmsSendResultDto,
  NotificationWecomReplayItemDto,
  NotificationWecomReplayResultDto,
  OrganizationOptionItemDto,
  OrganizationOptionsResponseDto,
  OrganizationResponseDto,
  OrganizationSupervisorDto,
  OrganizationTreeNodeDto,
  OrganizationTreeOptionItemDto,
  OrganizationTreeWithSummaryNodeDto,
  PageResultDto,
  ParticipationOverviewMonthDto,
  ParticipationOverviewResponseDto,
  PositionAssignmentExpandedMemberDto,
  PositionAssignmentExpandedOrganizationDto,
  PositionAssignmentExpandedPositionDto,
  PositionAssignmentPreviewResponseDto,
  PositionAssignmentResponseDto,
  PositionAssignmentViolationDto,
  PositionOptionItemDto,
  PositionOptionsResponseDto,
  PositionResponseDto,
  PositionRuleResponseDto,
  PreviewPositionAssignmentDto,
  PromotePrecheckResultDto,
  PromotePrecheckRowDto,
  PromoteResultDto,
  PromoteSingleResultDto,
  PromoteSkippedItemDto,
  PromotedItemDto,
  PublicityListItemDto,
  PublicityListResponseDto,
  PublishActivityDto,
  PublishActivityWithAudienceTagsDto,
  QualificationFlagResponseDto,
  RecruitmentApplicationAdminDto,
  RecruitmentCertificateClaimAdminDto,
  RecruitmentCertificateClaimImageUrlsResponseDto,
  RecruitmentCertificateClaimListResponseDto,
  RecruitmentCycleResponseDto,
  RecruitmentCycleStatsDto,
  RecruitmentStatsEvaluationDto,
  RecruitmentStatsIssuanceDto,
  RecruitmentStatsPendingDto,
  RecruitmentStatsThresholdDto,
  RecruitmentStatsThresholdItemDto,
  RecruitmentStatsTodayDto,
  RejectAttendanceSheetDto,
  RejectCertificateDto,
  RejectRegistrationDto,
  ReopenAttendanceSheetDto,
  ReplaceMemberAudienceTagsDto,
  ReplayNotificationWecomDto,
  ResetUserPasswordDto,
  ResolveLabelRefDto,
  ResolveLabelsDto,
  ResolveLabelsResponseDto,
  ResolveRecruitmentApplicationDto,
  ResolvedResourceDto,
  ResubmitAttendanceSheetDto,
  ReturnActivityPublishReviewDto,
  ReturnAttendanceSheetDto,
  ReviewCertificateClaimDto,
  ReviewMemberInsuranceDto,
  RevokeCertificateClaimReviewDto,
  RoleBindingBatchItemResultDto,
  RoleBindingBatchSummaryDto,
  RoleBindingExpandedPrincipalDto,
  RoleBindingExpandedRoleDto,
  RoleBindingPreviewConflictDto,
  RoleBindingPreviewResponseDto,
  RoleBindingResolvedScopeDto,
  RoleBindingResponseDto,
  SendNotificationSmsDto,
  SetContentCoverDto,
  SetMemberDepartmentDto,
  SupervisionAssignmentResponseDto,
  SupervisionCoveragePreviewDto,
  SupervisionCoveragePreviewResponseDto,
  SupervisionExpandedOrganizationDto,
  SupervisionExpandedSupervisorDto,
  SupervisionScopeEntryDto,
  TeamInsuranceCoverageResponseDto,
  TeamInsurancePolicyResponseDto,
  TeamJoinApplicationAdminDto,
  TeamJoinCycleResponseDto,
  TransferActivityOwnerDto,
  TransferMembershipDto,
  UpdateActivityDto,
  UpdateActivityPositionDto,
  UpdateAttachmentDto,
  UpdateAttendanceSheetDto,
  UpdateCertificateDto,
  UpdateCertificateRecognitionPolicyDto,
  UpdateCertificateRecognitionPolicyStatusDto,
  UpdateCertificateStandardDto,
  UpdateCertificateStandardStatusDto,
  UpdateContentDto,
  UpdateEmergencyContactDto,
  UpdateMemberAccountStatusDto,
  UpdateMemberDto,
  UpdateMemberProfileDto,
  UpdateMemberStatusDto,
  UpdateMembershipDto,
  UpdateNotificationDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
  UpdatePositionDto,
  UpdatePositionRuleDto,
  UpdateRecruitmentApplicationDto,
  UpdateRecruitmentCycleDto,
  UpdateRoleBindingDto,
  UpdateSupervisionAssignmentDto,
  UpdateTeamInsurancePolicyDto,
  UpdateTeamJoinCycleDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UploadUrlResponseDto,
  UpsertWechatSubscribeTemplateDto,
  UserLinkedMemberDto,
  UserOptionItemDto,
  UserOptionsResponseDto,
  UserResponseDto,
  VerifyCertificateDto,
  WechatSubscribeTemplateDto,
  WorkbenchMemberSummaryDto,
  WorkbenchStandardSummaryDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createAdminClient(fetcher: Fetcher) {
  return {
    /** 列出活动(分页 + 多字段过滤;Q-A7 USER 强制只见 published/completed,忽略入参 statusCode) [auth] */
    ActivitiesControllerList(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "activityTypeCode"?: string; "organizationId"?: string; "isPublicRegistration"?: boolean; "q"?: string; "dateFrom"?: string; "dateTo"?: string; "includeDescendants"?: boolean; "includeStats"?: boolean }): Promise<ApiEnvelope<PageResultDto & { "items": ActivityListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": ActivityListItemDto[] }>({ method: "GET", path: "/api/admin/v1/activities", query });
    },
    /** 创建活动(initial statusCode=draft;禁 statusCode / audit 字段) [rbac: activity.create.record] */
    ActivitiesControllerCreate(body: CreateActivityDto): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "POST", path: "/api/admin/v1/activities", body });
    },
    /** 活动选择器投影(q 模糊 title;USER 强制只见 published/completed) [auth] */
    ActivitiesControllerOptions(query?: { "q"?: string; "statusCode"?: string; "organizationId"?: string; "limit"?: number }): Promise<ApiEnvelope<ActivityOptionsResponseDto>> {
      return fetcher<ActivityOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/activities/options", query });
    },
    /** 生成活动考勤提交草稿（只读不落库） [rbac: attendance.read.sheet] */
    AdminActivityCheckInsControllerAttendanceSheetDraft(activityId: string): Promise<ApiEnvelope<AttendanceSheetDraftDto>> {
      return fetcher<AttendanceSheetDraftDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/attendance-sheet-draft` });
    },
    /** 列出该活动所有考勤单据(分页 + 可选 statusCode 过滤) [rbac: attendance.read.sheet] */
    AttendanceSheetsCollectionControllerList(activityId: string, query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "q"?: string; "activityQ"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "dateFrom"?: string; "dateTo"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AttendanceSheetListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AttendanceSheetListItemDto[] }>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/attendance-sheets`, query });
    },
    /** 提交考勤单据(事务内一次性 create Sheet + N records;初始 statusCode=pending,version=1;Activity cancelled 拒绝) [rbac: attendance.create.sheet] */
    AttendanceSheetsCollectionControllerSubmit(activityId: string, body: CreateAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/attendance-sheets`, body });
    },
    /** 分页查看活动 GPS 打卡证据 [rbac: attendance.read.sheet] */
    AdminActivityCheckInsControllerList(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AdminActivityCheckInListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminActivityCheckInListItemDto[] }>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/check-ins`, query });
    },
    /** 查看活动评价均分、直方图与评价率 [rbac: attendance.read.sheet] */
    AdminActivityFeedbacksControllerSummary(activityId: string): Promise<ApiEnvelope<AdminActivityFeedbackSummaryDto>> {
      return fetcher<AdminActivityFeedbackSummaryDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/feedback-summary` });
    },
    /** 分页查看活动评价与评价人摘要 [rbac: attendance.read.sheet] */
    AdminActivityFeedbacksControllerList(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AdminActivityFeedbackListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminActivityFeedbackListItemDto[] }>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/feedbacks`, query });
    },
    /** 活动已生效参与账本（分页） [rbac: attendance.read.sheet] */
    AdminActivityParticipationControllerParticipationLedger(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AdminParticipationLedgerEntryDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminParticipationLedgerEntryDto[] }>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/participation-ledger`, query });
    },
    /** 活动参与合计(报名状态/实到/到场率/approved 时长与贡献/固定时长桶；需同时持 attendance.read.sheet 与 activity-registration.read.record，按活动资源范围判定) [auth] */
    AdminActivityParticipationControllerParticipationSummary(activityId: string): Promise<ApiEnvelope<ActivityParticipationSummaryDto>> {
      return fetcher<ActivityParticipationSummaryDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/participation-summary` });
    },
    /** 活动岗位列表(sortOrder/createdAt/id 升序) [auth] */
    AdminActivityPositionsControllerList(activityId: string): Promise<ApiEnvelope<ActivityPositionResponseDto[]>> {
      return fetcher<ActivityPositionResponseDto[]>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/positions` });
    },
    /** 创建活动岗位 [rbac: activity.update.record] */
    AdminActivityPositionsControllerCreate(activityId: string, body: CreateActivityPositionDto): Promise<ApiEnvelope<ActivityPositionResponseDto>> {
      return fetcher<ActivityPositionResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/positions`, body });
    },
    /** 活动岗位详情(软删/跨活动统一 20002) [auth] */
    AdminActivityPositionsControllerFindOne(activityId: string, activityPositionId: string): Promise<ApiEnvelope<ActivityPositionResponseDto>> {
      return fetcher<ActivityPositionResponseDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/positions/${activityPositionId}` });
    },
    /** 部分更新活动岗位(容量锁后重读) [rbac: activity.update.record] */
    AdminActivityPositionsControllerUpdate(activityId: string, activityPositionId: string, body: UpdateActivityPositionDto): Promise<ApiEnvelope<ActivityPositionResponseDto>> {
      return fetcher<ActivityPositionResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/positions/${activityPositionId}`, body });
    },
    /** 软删活动岗位(pending/pass/waitlisted 报名守卫) [rbac: activity.update.record] */
    AdminActivityPositionsControllerSoftDelete(activityId: string, activityPositionId: string): Promise<ApiEnvelope<ActivityPositionResponseDto>> {
      return fetcher<ActivityPositionResponseDto>({ method: "DELETE", path: `/api/admin/v1/activities/${activityId}/positions/${activityPositionId}` });
    },
    /** 活动报名×实到核对(completed only；pass 逐人 attended/no-show + 临时参加名单；需同时持 attendance.read.sheet 与 activity-registration.read.record，按活动资源范围判定) [auth] */
    AdminActivityParticipationControllerReconciliation(activityId: string): Promise<ApiEnvelope<ActivityReconciliationDto>> {
      return fetcher<ActivityReconciliationDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/reconciliation` });
    },
    /** 列出该活动所有报名(分页;含已取消 / 已拒绝) [rbac: activity-registration.read.record] */
    ActivityRegistrationsAdminControllerList(activityId: string, query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "q"?: string; "memberQ"?: string; "activityQ"?: string; "memberId"?: string; "activityId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "dateFrom"?: string; "dateTo"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": ActivityRegistrationListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": ActivityRegistrationListItemDto[] }>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/registrations`, query });
    },
    /** ADMIN 代报名(Q-A3 与 USER 自助拆开;必填 memberId;校验 capacity + 公开报名 + 未重复) [rbac: activity-registration.create.record] */
    ActivityRegistrationsAdminControllerCreate(activityId: string, body: CreateRegistrationDto): Promise<ApiEnvelope<ActivityRegistrationResponseDto>> {
      return fetcher<ActivityRegistrationResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/registrations`, body });
    },
    /** 批量审核通过(ids 1–100；逐条独立事务/判权/capacity/audit/通知；部分成功) [rbac: activity-registration.approve.record] */
    ActivityRegistrationsAdminControllerBulkApprove(activityId: string, body: BulkReviewRegistrationsDto): Promise<ApiEnvelope<BulkReviewRegistrationsResponseDto>> {
      return fetcher<BulkReviewRegistrationsResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/registrations/bulk-approve`, body });
    },
    /** 批量审核拒绝(ids 1–100；逐条独立事务/判权/audit/通知；部分成功；空备注默认“批量驳回”) [rbac: activity-registration.reject.record] */
    ActivityRegistrationsAdminControllerBulkReject(activityId: string, body: BulkReviewRegistrationsDto): Promise<ApiEnvelope<BulkReviewRegistrationsResponseDto>> {
      return fetcher<BulkReviewRegistrationsResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/registrations/bulk-reject`, body });
    },
    /** 名单导出 CSV(Q-A6:第一版仅 CSV;默认 scope=pass,可选 scope=all;XLSX 不支持 → 400) [rbac: activity-registration.read.record] */
    ActivityRegistrationsAdminControllerExportRegistrations(activityId: string, query?: { "format"?: "csv"; "scope"?: "pass" | "all" }): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/registrations/export`, query });
    },
    /** 审核通过(pending → pass;capacity 复核) [rbac: activity-registration.approve.record] */
    ActivityRegistrationsAdminControllerApprove(activityId: string, id: string, body: ApproveRegistrationDto): Promise<ApiEnvelope<ActivityRegistrationResponseDto>> {
      return fetcher<ActivityRegistrationResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/registrations/${id}/approve`, body });
    },
    /** 管理员代取消(pending|pass → cancelled;cancelled 释放名额;已有考勤记录 → 拒) [rbac: activity-registration.cancel.record] */
    ActivityRegistrationsAdminControllerCancel(activityId: string, id: string, body: CancelRegistrationDto): Promise<ApiEnvelope<ActivityRegistrationResponseDto>> {
      return fetcher<ActivityRegistrationResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/registrations/${id}/cancel`, body });
    },
    /** 审核拒绝(pending → reject;reviewNote 必填) [rbac: activity-registration.reject.record] */
    ActivityRegistrationsAdminControllerReject(activityId: string, id: string, body: RejectRegistrationDto): Promise<ApiEnvelope<ActivityRegistrationResponseDto>> {
      return fetcher<ActivityRegistrationResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${activityId}/registrations/${id}/reject`, body });
    },
    /** 撤销驳回、回待审(reject → pending;清空审核字段;不发通知) [rbac: activity-registration.reopen.record] */
    ActivityRegistrationsAdminControllerReopen(activityId: string, id: string): Promise<ApiEnvelope<ActivityRegistrationResponseDto>> {
      return fetcher<ActivityRegistrationResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/registrations/${id}/reopen` });
    },
    /** 查看活动当前负责人和协办人 [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerList(activityId: string): Promise<ApiEnvelope<ActivityResponsibilitiesResponseDto>> {
      return fetcher<ActivityResponsibilitiesResponseDto>({ method: "GET", path: `/api/admin/v1/activities/${activityId}/responsibilities` });
    },
    /** 为 legacy draft 活动补录正式发起人 [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerAssignInitiator(activityId: string, body: AssignLegacyActivityInitiatorDto): Promise<ApiEnvelope<ActivityResponsibilitiesResponseDto>> {
      return fetcher<ActivityResponsibilitiesResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/responsibilities/assign-initiator`, body });
    },
    /** 为 legacy published 活动认领当前负责人 [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerClaim(activityId: string, body: ClaimLegacyActivityDto): Promise<ApiEnvelope<ActivityResponsibilityAssignmentDto>> {
      return fetcher<ActivityResponsibilityAssignmentDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/responsibilities/claim`, body });
    },
    /** 新增活动协办人(owner 或 override；至少一项管理能力) [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerAddCollaborator(activityId: string, body: CreateActivityCollaboratorDto): Promise<ApiEnvelope<ActivityResponsibilityAssignmentDto>> {
      return fetcher<ActivityResponsibilityAssignmentDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/responsibilities/collaborators`, body });
    },
    /** 结束活动协办职责并同步摘除 scoped RoleBinding [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerEndCollaborator(activityId: string, assignmentId: string): Promise<ApiEnvelope<ActivityResponsibilityAssignmentDto>> {
      return fetcher<ActivityResponsibilityAssignmentDto>({ method: "DELETE", path: `/api/admin/v1/activities/${activityId}/responsibilities/collaborators/${assignmentId}` });
    },
    /** 移交活动负责人并原子切换 scoped RoleBinding [rbac: activity-responsibility.override.record] */
    AdminActivityResponsibilitiesControllerTransfer(activityId: string, body: TransferActivityOwnerDto): Promise<ApiEnvelope<ActivityResponsibilitiesResponseDto>> {
      return fetcher<ActivityResponsibilitiesResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${activityId}/responsibilities/transfer`, body });
    },
    /** 活动详情(Q-A7 USER 仅可见 published/completed,其他 → 404) [auth] */
    ActivitiesControllerFindOne(id: string): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "GET", path: `/api/admin/v1/activities/${id}` });
    },
    /** 部分更新活动(completed/cancelled 仅展示字段可改;事实字段锁定) [rbac: activity.update.record] */
    ActivitiesControllerUpdate(id: string, body: UpdateActivityDto): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${id}`, body });
    },
    /** 软删活动(存在 pending/pass 报名或未软删考勤单时拒绝，须先取消活动) [rbac: activity.delete.record] */
    ActivitiesControllerSoftDelete(id: string): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "DELETE", path: `/api/admin/v1/activities/${id}` });
    },
    /** 取消活动(draft|published → cancelled；pending 报名联动取消，pass 保留) [rbac: activity.cancel.record] */
    ActivitiesControllerCancel(id: string, body: CancelActivityDto): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${id}/cancel`, body });
    },
    /** 手动完结活动(published → completed；唯一完结通路，非 published → 20030) [rbac: activity.complete.record] */
    ActivitiesControllerComplete(id: string): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "POST", path: `/api/admin/v1/activities/${id}/complete` });
    },
    /** 发布活动(draft → published;请求体须显式确认保险，且活动/报名截止时间有效) [rbac: activity.publish.record] */
    ActivitiesControllerPublish(id: string, body: PublishActivityDto): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${id}/publish`, body });
    },
    /** 按会员受众标签发布活动(空数组面向全部有效会员；开关关闭时 503) [rbac: activity.publish.record] */
    ActivitiesControllerPublishWithAudienceTags(id: string, body: PublishActivityWithAudienceTagsDto): Promise<ApiEnvelope<ActivityResponseDto>> {
      return fetcher<ActivityResponseDto>({ method: "PATCH", path: `/api/admin/v1/activities/${id}/publish-with-audience-tags`, body });
    },
    /** 发布审核工作台(按显式 reviewer RoleBinding 的组织范围过滤) [rbac: activity-review.read.request] */
    AdminActivityPublishReviewsControllerList(query?: { "page"?: number; "pageSize"?: number; "status"?: "pending" | "approved" | "returned" | "withdrawn" | "cancelled"; "requestType"?: "initial" | "change"; "organizationId"?: string; "includeDescendants"?: boolean; "initiatorQ"?: string; "activityQ"?: string; "submittedFrom"?: string; "submittedTo"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": ActivityPublishReviewResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": ActivityPublishReviewResponseDto[] }>({ method: "GET", path: "/api/admin/v1/activity-publish-reviews", query });
    },
    /** 发布审核详情 [rbac: activity-review.read.request] */
    AdminActivityPublishReviewsControllerFindOne(id: string): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "GET", path: `/api/admin/v1/activity-publish-reviews/${id}` });
    },
    /** 通过待处理发布审核并发布活动 [rbac: activity.publish.record] */
    AdminActivityPublishReviewsControllerApprove(id: string, body: ApproveActivityPublishReviewDto): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/admin/v1/activity-publish-reviews/${id}/approve`, body });
    },
    /** 退回待处理发布审核 [rbac: activity-review.return.request] */
    AdminActivityPublishReviewsControllerReturnReview(id: string, body: ReturnActivityPublishReviewDto): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/admin/v1/activity-publish-reviews/${id}/return`, body });
    },
    /** 公告导入执行(逐行落库,幂等可重跑,单行失败不影响其它行)[rbac: announcement-import.execute.record] */
    AnnouncementImportControllerExecute(body: AnnouncementImportRequestDto): Promise<ApiEnvelope<AnnouncementImportResultDto>> {
      return fetcher<AnnouncementImportResultDto>({ method: "POST", path: "/api/admin/v1/announcement-import/execute", body });
    },
    /** 公告导入预览(零写入,逐行回显 ok/blocked/already-exists/needs-manual)[rbac: announcement-import.preview.record] */
    AnnouncementImportControllerPreview(body: AnnouncementImportRequestDto): Promise<ApiEnvelope<AnnouncementImportResultDto>> {
      return fetcher<AnnouncementImportResultDto>({ method: "POST", path: "/api/admin/v1/announcement-import/preview", body });
    },
    /** 列出附件(分页;可选 ownerType / ownerId / uploadedBy / mime / accessLevel / tags 过滤;tags OR 语义;total 按可见数量返;默认排序 createdAt DESC) [rbac: attachment.view.*] */
    AttachmentsControllerList(query?: { "page"?: number; "pageSize"?: number; "ownerType"?: string; "ownerId"?: string; "uploadedBy"?: string; "mime"?: string; "accessLevel"?: "PUBLIC" | "INTERNAL" | "SENSITIVE"; "tags"?: string[] }): Promise<ApiEnvelope<PageResultDto & { "items": AttachmentResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AttachmentResponseDto[] }>({ method: "GET", path: "/api/admin/v1/attachments", query });
    },
    /** 创建附件元数据(先落 durable storage intent,按 pinned locator 校验对象,再将 Attachment + audit + storage available 原子提交;存储状态不确定返 13034;其余校验:ownerType 13010 / ownerId 13011 / RBAC 30100 / MIME 13033或13012 / size 13013 / key 13014 / PII 13015) [rbac: attachment.upload.*] */
    AttachmentsControllerCreate(body: CreateAttachmentDto): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "POST", path: "/api/admin/v1/attachments", body });
    },
    /** 按 ownerType + ownerId 列出某业务对象的全部附件(业务模块常用入口;ownerType / ownerId 必填;逐条 ownership 过滤) [rbac: attachment.view.*] */
    AttachmentsControllerListByOwner(query: { "page"?: number; "pageSize"?: number; "ownerType": string; "ownerId": string }): Promise<ApiEnvelope<PageResultDto & { "items": AttachmentResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": AttachmentResponseDto[] }>({ method: "GET", path: "/api/admin/v1/attachments/by-owner", query });
    },
    /** 确认上传完成(模式 B;验 uploadToken,按 intent 的 pinned locator 校验 HEAD/size/文件签名,再原子提交 Attachment + audit + available;同 token 幂等;不确定态返 13034) [rbac: attachment.upload.*] */
    AttachmentsControllerConfirmUpload(body: ConfirmUploadDto): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "POST", path: "/api/admin/v1/attachments/confirm-upload", body });
    },
    /** 申请 signed upload URL(模式 B;先预写 durable storage intent,再按 pinned locator 签 URL;尚不创建 Attachment/不写业务 audit;存储状态不确定返 13034) [rbac: attachment.upload.*] */
    AttachmentsControllerCreateUploadUrl(body: GenerateUploadUrlDto): Promise<ApiEnvelope<UploadUrlResponseDto>> {
      return fetcher<UploadUrlResponseDto>({ method: "POST", path: "/api/admin/v1/attachments/upload-url", body });
    },
    /** 附件详情(不存在 / 无权统一返 13001;Q13 v1.0 信息泄漏防御) [rbac: attachment.view.*] */
    AttachmentsControllerGetById(id: string): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "GET", path: `/api/admin/v1/attachments/${id}` });
    },
    /** 更新附件元数据(仅 description / accessLevel / tags / expireAt;不存在返 13001;无权返 30100;PII 命中返 13015) [rbac: attachment.update.*] */
    AttachmentsControllerUpdate(id: string, body: UpdateAttachmentDto): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "PATCH", path: `/api/admin/v1/attachments/${id}`, body });
    },
    /** 删除附件(content-* 另需 Content 更新权且仅草稿未引用;durable delete + HEAD absent 后原子 finalize;未完成返 13034) [rbac: attachment.delete.*] */
    AttachmentsControllerDelete(id: string): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "DELETE", path: `/api/admin/v1/attachments/${id}` });
    },
    /** 跨活动结算审核工作台（分页） [rbac: attendance.read.sheet] */
    AdminAttendanceSettlementsControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AdminAttendanceSettlementListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminAttendanceSettlementListItemDto[] }>({ method: "GET", path: "/api/admin/v1/attendance-settlements", query });
    },
    /** 终审通过结算版本并准备账本批次 [rbac: activity.settlement-final-review.record] */
    AdminAttendanceSettlementsControllerFinalApprove(id: string, body: AdminSettlementApproveCommandDto): Promise<ApiEnvelope<AdminSettlementReviewResponseDto>> {
      return fetcher<AdminSettlementReviewResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-settlements/${id}/final-approve`, body });
    },
    /** 终审退回结算版本 [rbac: activity.settlement-final-review.record] */
    AdminAttendanceSettlementsControllerFinalReturn(id: string, body: AdminSettlementReturnCommandDto): Promise<ApiEnvelope<AdminSettlementReviewResponseDto>> {
      return fetcher<AdminSettlementReviewResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-settlements/${id}/final-return`, body });
    },
    /** 一审通过结算版本 [rbac: activity.settlement-first-review.record] */
    AdminAttendanceSettlementsControllerFirstApprove(id: string, body: AdminSettlementApproveCommandDto): Promise<ApiEnvelope<AdminSettlementReviewResponseDto>> {
      return fetcher<AdminSettlementReviewResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-settlements/${id}/first-approve`, body });
    },
    /** 一审退回结算版本 [rbac: activity.settlement-first-review.record] */
    AdminAttendanceSettlementsControllerFirstReturn(id: string, body: AdminSettlementReturnCommandDto): Promise<ApiEnvelope<AdminSettlementReviewResponseDto>> {
      return fetcher<AdminSettlementReviewResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-settlements/${id}/first-return`, body });
    },
    /** 查看结算版本账本批次进度 [rbac: attendance.read.sheet] */
    AdminAttendanceSettlementsControllerPostingBatch(id: string): Promise<ApiEnvelope<AdminSettlementPostingBatchDto>> {
      return fetcher<AdminSettlementPostingBatchDto>({ method: "GET", path: `/api/admin/v1/attendance-settlements/${id}/posting-batch` });
    },
    /** 查看结算版本不可变审核详情、seal、差异与缺口 [rbac: attendance.read.sheet] */
    AdminAttendanceSettlementsControllerReviewDetail(settlementVersionId: string): Promise<ApiEnvelope<AdminSettlementReviewDetailDto>> {
      return fetcher<AdminSettlementReviewDetailDto>({ method: "GET", path: `/api/admin/v1/attendance-settlements/${settlementVersionId}/review-detail` });
    },
    /** 跨活动考勤单据横扫(审批工作台;分页 + 可选 statusCode/q/activityQ/organizationId/includeDescendants/dateFrom/dateTo/expand=activity;脱离 :activityId 路径段;item 带 activity 上下文) [rbac: attendance.read.sheet] */
    AttendanceSheetsResourceControllerListAll(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "q"?: string; "activityQ"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "dateFrom"?: string; "dateTo"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AdminAttendanceSheetListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminAttendanceSheetListItemDto[] }>({ method: "GET", path: "/api/admin/v1/attendance-sheets", query });
    },
    /** Sheet 简化详情(不含 records 数组;不返 previousSnapshot) [rbac: attendance.read.sheet] */
    AttendanceSheetsResourceControllerFindOne(id: string): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "GET", path: `/api/admin/v1/attendance-sheets/${id}` });
    },
    /** 编辑 pending/returned Sheet(D38:后端生成 previousSnapshot + version+1;旧 records 软删 + 新 records 创建;其余状态拒绝;Activity cancelled 拒绝改 records) [rbac: attendance.update.sheet] */
    AttendanceSheetsResourceControllerEdit(id: string, body: UpdateAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "PATCH", path: `/api/admin/v1/attendance-sheets/${id}`, body });
    },
    /** 软删 pending Sheet(事务内级联软删 records;approved/rejected/pending_final_review/final_rejected 拒绝) [rbac: attendance.delete.sheet] */
    AttendanceSheetsResourceControllerSoftDelete(id: string): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "DELETE", path: `/api/admin/v1/attendance-sheets/${id}` });
    },
    /** APD 一级通过(pending → pending_final_review;批次 4-B 升级,沿 D-S6;R31 所有 records.contributionPoints 必填;**不再触发** attendance.recorded — 触发位置移到 final-approve;待终审) [rbac: attendance.approve.sheet] */
    AttendanceSheetsResourceControllerApprove(id: string, body: ApproveAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "PATCH", path: `/api/admin/v1/attendance-sheets/${id}/approve`, body });
    },
    /** 终审通过(ADMIN 级终审沿 P1-5 方案 A,部门级细分挂 Slow-3;pending_final_review → approved;贡献值正式生效;**触发** attendance.recorded;沿 D-S5 / D-S7) [rbac: attendance.final-approve.sheet] */
    AttendanceSheetsResourceControllerFinalApprove(id: string, body: FinalApproveAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "PATCH", path: `/api/admin/v1/attendance-sheets/${id}/final-approve`, body });
    },
    /** 终审驳回(ADMIN 级终审沿 P1-5 方案 A,部门级细分挂 Slow-3;pending_final_review → final_rejected;finalReviewNote 必填;records 跟随软删;**不触发** attendance.recorded) [rbac: attendance.final-reject.sheet] */
    AttendanceSheetsResourceControllerFinalReject(id: string, body: FinalRejectAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "PATCH", path: `/api/admin/v1/attendance-sheets/${id}/final-reject`, body });
    },
    /** 终审退回修改(pending_final_review → returned;保留 records;执行自审与同人约束) [rbac: attendance.final-return.sheet] */
    AttendanceSheetsResourceControllerFinalReturn(id: string, body: ReturnAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-sheets/${id}/final-return`, body });
    },
    /** APD 一级驳回(pending → rejected;reviewNote 必填) [rbac: attendance.reject.sheet] */
    AttendanceSheetsResourceControllerReject(id: string, body: RejectAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "PATCH", path: `/api/admin/v1/attendance-sheets/${id}/reject`, body });
    },
    /** 撤回已终审通过的考勤单(approved → pending;保留 records,清空一审/终审责任字段;不发通知) [rbac: attendance.reopen.sheet] */
    AttendanceSheetsResourceControllerReopen(id: string, body: ReopenAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-sheets/${id}/reopen`, body });
    },
    /** 退回考勤单重提(returned → pending;保留 records;清空审核/退回字段;version+1;限活动考勤责任人或 SUPER_ADMIN) [rbac: attendance.update.sheet] */
    AttendanceSheetsResourceControllerResubmit(id: string, body: ResubmitAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-sheets/${id}/resubmit`, body });
    },
    /** 一级审核退回修改(pending → returned;保留 records;记录退回人、阶段与原因) [rbac: attendance.return.sheet] */
    AttendanceSheetsResourceControllerFirstReturn(id: string, body: ReturnAttendanceSheetDto): Promise<ApiEnvelope<AttendanceSheetResponseDto>> {
      return fetcher<AttendanceSheetResponseDto>({ method: "POST", path: `/api/admin/v1/attendance-sheets/${id}/return`, body });
    },
    /** APD 审核完整视图(R25):Activity 摘要 + Sheet 详情 + Records[含 Member 嵌套] [rbac: attendance.read.sheet] */
    AttendanceSheetsResourceControllerReviewDetail(id: string): Promise<ApiEnvelope<AttendanceSheetReviewDetailDto>> {
      return fetcher<AttendanceSheetReviewDetailDto>({ method: "GET", path: `/api/admin/v1/attendance-sheets/${id}/review-detail` });
    },
    /** 批量业务态闸(诊断读):调用者对一组 action×资源 的 allowed + reason(authz 11 值 ∪ state_forbidden);items 回显 action/resourceType/resourceId 且顺序 = 请求顺序;可选 key 逐 item 透传回显(仅请求携带时出现,不参与判定);deny 是 200 数据非错误 [rbac: authz.action-state.decision] */
    ActionStateControllerBatch(body: ActionStateBatchDto): Promise<ApiEnvelope<ActionStateBatchResponseDto>> {
      return fetcher<ActionStateBatchResponseDto>({ method: "POST", path: "/api/admin/v1/authz/action-state/batch", body });
    },
    /** 权限解释(诊断读):目标用户对 action(+可选 resourceRef)的 allow/deny + reason + matchedGrant;deny 是 200 数据非错误 [rbac: authz.explain.decision] */
    AuthzControllerExplain(body: ExplainAuthzDto): Promise<ApiEnvelope<ExplainAuthzResponseDto>> {
      return fetcher<ExplainAuthzResponseDto>({ method: "POST", path: "/api/admin/v1/authz/explain", body });
    },
    /** 批量权限解释(诊断读):逐条返 allow/deny + reason(同单条 11 值枚举)+ matchedGrant;deny 是 200 数据非错误 [rbac: authz.explain-batch.decision] */
    AuthzControllerExplainBatch(body: ExplainAuthzBatchDto): Promise<ApiEnvelope<ExplainAuthzBatchResponseDto>> {
      return fetcher<ExplainAuthzBatchResponseDto>({ method: "POST", path: "/api/admin/v1/authz/explain-batch", body });
    },
    /** 认定规则详情(含认可机构集合) [rbac: certificate-recognition-policy.read.record] */
    CertificateRecognitionPoliciesControllerFindOne(id: string): Promise<ApiEnvelope<CertificateRecognitionPolicyResponseDto>> {
      return fetcher<CertificateRecognitionPolicyResponseDto>({ method: "GET", path: `/api/admin/v1/certificate-recognition-policies/${id}` });
    },
    /** 修改 DRAFT 认定规则(传 issuers 即整体替换;ACTIVE / RETIRED 恒 18036) [rbac: certificate-recognition-policy.update.record] */
    CertificateRecognitionPoliciesControllerUpdate(id: string, body: UpdateCertificateRecognitionPolicyDto): Promise<ApiEnvelope<CertificateRecognitionPolicyResponseDto>> {
      return fetcher<CertificateRecognitionPolicyResponseDto>({ method: "PATCH", path: `/api/admin/v1/certificate-recognition-policies/${id}`, body });
    },
    /** 软删 DRAFT 认定规则(ACTIVE / RETIRED 恒 18036) [rbac: certificate-recognition-policy.delete.record] */
    CertificateRecognitionPoliciesControllerSoftDelete(id: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: `/api/admin/v1/certificate-recognition-policies/${id}` });
    },
    /** 激活 / 退役认定规则(ACTIVE 会原子退役该标准当前生效版;不接受 DRAFT) [rbac: certificate-recognition-policy.update.record] */
    CertificateRecognitionPoliciesControllerUpdateStatus(id: string, body: UpdateCertificateRecognitionPolicyStatusDto): Promise<ApiEnvelope<CertificateRecognitionPolicyResponseDto>> {
      return fetcher<CertificateRecognitionPolicyResponseDto>({ method: "PATCH", path: `/api/admin/v1/certificate-recognition-policies/${id}/status`, body });
    },
    /** 列出证书标准(分页 + kind / category / level / status / parentId / q) [rbac: certificate-standard.read.record] */
    CertificateStandardsControllerList(query?: { "page"?: number; "pageSize"?: number; "kind"?: "FAMILY" | "CREDENTIAL"; "categoryCode"?: string; "levelCode"?: string; "status"?: "DRAFT" | "ACTIVE" | "INACTIVE"; "parentId"?: string; "q"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": CertificateStandardResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": CertificateStandardResponseDto[] }>({ method: "GET", path: "/api/admin/v1/certificate-standards", query });
    },
    /** 创建证书标准(初始恒 DRAFT;code 唯一且不可复用) [rbac: certificate-standard.create.record] */
    CertificateStandardsControllerCreate(body: CreateCertificateStandardDto): Promise<ApiEnvelope<CertificateStandardResponseDto>> {
      return fetcher<CertificateStandardResponseDto>({ method: "POST", path: "/api/admin/v1/certificate-standards", body });
    },
    /** 证书标准选择器(只返 CREDENTIAL;带当前 ACTIVE 认定规则摘要与机构选项;recognizedOnly=true 只返可认定的;§16.4 替代入口码:certificate.create.record / certificate.verify.record / recruitment-application.review.certificate 任一即可) [rbac: certificate-standard.read.record] */
    CertificateStandardsControllerOptions(query?: { "recognizedOnly"?: boolean; "categoryCode"?: string; "q"?: string; "limit"?: number }): Promise<ApiEnvelope<CertificateStandardOptionsResponseDto>> {
      return fetcher<CertificateStandardOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/certificate-standards/options", query });
    },
    /** 证书标准详情(软删返 404) [rbac: certificate-standard.read.record] */
    CertificateStandardsControllerFindOne(id: string): Promise<ApiEnvelope<CertificateStandardResponseDto>> {
      return fetcher<CertificateStandardResponseDto>({ method: "GET", path: `/api/admin/v1/certificate-standards/${id}` });
    },
    /** 修正证书标准文案与排序(只接受 name / description / sortOrder;身份字段永不可改) [rbac: certificate-standard.update.record] */
    CertificateStandardsControllerUpdate(id: string, body: UpdateCertificateStandardDto): Promise<ApiEnvelope<CertificateStandardResponseDto>> {
      return fetcher<CertificateStandardResponseDto>({ method: "PATCH", path: `/api/admin/v1/certificate-standards/${id}`, body });
    },
    /** 软删证书标准(被子节点 / 认定规则 / 申报 / 证书引用时禁删 → 18032) [rbac: certificate-standard.delete.record] */
    CertificateStandardsControllerSoftDelete(id: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: `/api/admin/v1/certificate-standards/${id}` });
    },
    /** 证书标准状态迁移(DRAFT→ACTIVE / ACTIVE→INACTIVE / INACTIVE→ACTIVE;恢复 ACTIVE 前重校验字典与父级) [rbac: certificate-standard.update.record] */
    CertificateStandardsControllerUpdateStatus(id: string, body: UpdateCertificateStandardStatusDto): Promise<ApiEnvelope<CertificateStandardResponseDto>> {
      return fetcher<CertificateStandardResponseDto>({ method: "PATCH", path: `/api/admin/v1/certificate-standards/${id}/status`, body });
    },
    /** 列出某证书标准的全部认定规则版本(version DESC;含 DRAFT / ACTIVE / RETIRED) [rbac: certificate-recognition-policy.read.record] */
    CertificateRecognitionPoliciesControllerList(standardId: string): Promise<ApiEnvelope<CertificateRecognitionPolicyListResponseDto>> {
      return fetcher<CertificateRecognitionPolicyListResponseDto>({ method: "GET", path: `/api/admin/v1/certificate-standards/${standardId}/recognition-policies` });
    },
    /** 为某证书标准新建认定规则版本(恒 DRAFT;version 服务端在 Standard 行锁内分配) [rbac: certificate-recognition-policy.create.record] */
    CertificateRecognitionPoliciesControllerCreate(standardId: string, body: CreateCertificateRecognitionPolicyDto): Promise<ApiEnvelope<CertificateRecognitionPolicyResponseDto>> {
      return fetcher<CertificateRecognitionPolicyResponseDto>({ method: "POST", path: `/api/admin/v1/certificate-standards/${standardId}/recognition-policies`, body });
    },
    /** 全局证书工作台列表(跨队员;可见组织范围先下推 SQL 再分页与计数;q 只搜队员编号/展示名/标准名称与 code/发证机构 —— **不搜完整证书编号**;出参恒不含完整编号/审核备注/审核人/图片 key;含 effectiveStatusCode 当前有效展示状态) [rbac: certificate.read.record] */
    CertificatesWorkbenchControllerList(query?: { "q"?: string; "memberId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "standardCode"?: string; "categoryCode"?: string; "levelCode"?: string; "certStatusCode"?: "pending" | "verified" | "expired" | "rejected"; "sourceCode"?: "ADMIN" | "RECRUITMENT"; "issuedFrom"?: string; "issuedTo"?: string; "expiresFrom"?: string; "expiresTo"?: string; "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": CertificateWorkbenchItemDto[] }>> {
      return fetcher<PageResultDto & { "items": CertificateWorkbenchItemDto[] }>({ method: "GET", path: "/api/admin/v1/certificates", query });
    },
    /** 全局证书工作台统计(六个计数器:pending/verified/expired/rejected/expiringWithin60Days/permanent;接受与列表**完全相同**的非分页过滤;按北京 today 计算且**不依赖到期 cron 已翻态**〔expired 含「verified 但 expiredAt<today」〕;scope 先下推再计数) [rbac: certificate.read.record] */
    CertificatesWorkbenchControllerStats(query?: { "q"?: string; "memberId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "standardCode"?: string; "categoryCode"?: string; "levelCode"?: string; "certStatusCode"?: "pending" | "verified" | "expired" | "rejected"; "sourceCode"?: "ADMIN" | "RECRUITMENT"; "issuedFrom"?: string; "issuedTo"?: string; "expiresFrom"?: string; "expiresTo"?: string }): Promise<ApiEnvelope<CertificateWorkbenchStatsDto>> {
      return fetcher<CertificateWorkbenchStatsDto>({ method: "GET", path: "/api/admin/v1/certificates/stats", query });
    },
    /** 内容分页列表(status/type/visibility/keyword/tags/pinned 过滤;admin 见全部状态全可见档) [rbac: content.read.record] */
    ContentAdminControllerList(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "contentTypeCode"?: string; "visibilityCode"?: string; "keyword"?: string; "tags"?: string[]; "pinned"?: boolean }): Promise<ApiEnvelope<PageResultDto & { "items": ContentAdminListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": ContentAdminListItemDto[] }>({ method: "GET", path: "/api/admin/v1/contents", query });
    },
    /** 新建内容草稿(create → draft) [rbac: content.create.record] */
    ContentAdminControllerCreate(body: CreateContentDto): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "POST", path: "/api/admin/v1/contents", body });
    },
    /** 内容详情(含附件签名 URL + 正文占位改写 + viewCount〔不自增〕) [rbac: content.read.record] */
    ContentAdminControllerDetail(id: string): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "GET", path: `/api/admin/v1/contents/${id}` });
    },
    /** 更新内容(draft/published 可改,archived 冻结 → 29030) [rbac: content.update.record] */
    ContentAdminControllerUpdate(id: string, body: UpdateContentDto): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "PATCH", path: `/api/admin/v1/contents/${id}`, body });
    },
    /** 软删内容(任意态) [rbac: content.delete.record] */
    ContentAdminControllerRemove(id: string): Promise<ApiEnvelope<Record<string, unknown> | null>> {
      return fetcher<Record<string, unknown> | null>({ method: "DELETE", path: `/api/admin/v1/contents/${id}` });
    },
    /** 归档内容(published → archived,终态不可逆) [rbac: content.publish.record] */
    ContentAdminControllerArchive(id: string): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "POST", path: `/api/admin/v1/contents/${id}/archive` });
    },
    /** 确认附件上传(token 校验 + headObject；按 token ownerType 要求 attachment.upload.content-image 或 attachment.upload.content-file；落 Attachment 行 + audit attachment.upload) [auth] */
    ContentAdminControllerConfirm(id: string, body: ContentAttachmentConfirmDto): Promise<ApiEnvelope<AttachmentResponseDto>> {
      return fetcher<AttachmentResponseDto>({ method: "POST", path: `/api/admin/v1/contents/${id}/attachments/confirm`, body });
    },
    /** 取附件上传 URL(kind=image|file;先验内容存在;附件写权由 AttachmentsService 判) [rbac: attachment.upload.*] */
    ContentAdminControllerUploadUrl(id: string, body: ContentAttachmentUploadUrlDto): Promise<ApiEnvelope<UploadUrlResponseDto>> {
      return fetcher<UploadUrlResponseDto>({ method: "POST", path: `/api/admin/v1/contents/${id}/attachments/upload-url`, body });
    },
    /** 删草稿未引用附件(另需 content.update.record;Content 根锁 + durable storage delete) [rbac: attachment.delete.*] */
    ContentAdminControllerRemoveAttachment(id: string, attachmentId: string): Promise<ApiEnvelope<Record<string, unknown> | null>> {
      return fetcher<Record<string, unknown> | null>({ method: "DELETE", path: `/api/admin/v1/contents/${id}/attachments/${attachmentId}` });
    },
    /** 设 / 清封面({attachmentId|null};非本文章 content-image 附件 → 404) [rbac: content.update.record] */
    ContentAdminControllerSetCover(id: string, body: SetContentCoverDto): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "PUT", path: `/api/admin/v1/contents/${id}/cover`, body });
    },
    /** 发布内容(draft → published,置 publishedAt) [rbac: content.publish.record] */
    ContentAdminControllerPublish(id: string): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "POST", path: `/api/admin/v1/contents/${id}/publish` });
    },
    /** 撤回内容(published → draft,保留 publishedAt) [rbac: content.publish.record] */
    ContentAdminControllerUnpublish(id: string): Promise<ApiEnvelope<ContentAdminDetailDto>> {
      return fetcher<ContentAdminDetailDto>({ method: "POST", path: `/api/admin/v1/contents/${id}/unpublish` });
    },
    /** Admin 视角本人身份摘要(只读 bootstrap;不内联角色/权限——权限走 rbac/me/permissions) [auth] */
    AdminMeControllerGetMe(): Promise<ApiEnvelope<AdminMeResponseDto>> {
      return fetcher<AdminMeResponseDto>({ method: "GET", path: "/api/admin/v1/me" });
    },
    /** 列出队员(分页;memberNo 精确查询 / gradeCode / status 过滤) [rbac: member.read.record] */
    MembersControllerList(query?: { "page"?: number; "pageSize"?: number; "memberNo"?: string; "gradeCode"?: string; "status"?: "ACTIVE" | "INACTIVE"; "q"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "hasAccount"?: boolean }): Promise<ApiEnvelope<PageResultDto & { "items": MemberResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": MemberResponseDto[] }>({ method: "GET", path: "/api/admin/v1/members", query });
    },
    /** 创建队员(memberNo 必填,全局唯一不复用;不接收任何敏感字段) [rbac: member.create.record] */
    MembersControllerCreate(body: CreateMemberDto): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "POST", path: "/api/admin/v1/members", body });
    },
    /** 批量开号(逐行 skip-on-error,单行失败不影响其余行;≤200 条) [rbac: member.grant.account] */
    MembersControllerBulkGrantAccounts(body: BulkGrantMemberAccountsDto): Promise<ApiEnvelope<BulkGrantMemberAccountsResponseDto>> {
      return fetcher<BulkGrantMemberAccountsResponseDto>({ method: "POST", path: "/api/admin/v1/members/accounts/bulk-grant", body });
    },
    /** 队员选择器投影(q 模糊 displayName+memberNo;limit≤100,默认 20) [rbac: member.read.record] */
    MembersControllerOptions(query?: { "q"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "limit"?: number }): Promise<ApiEnvelope<MemberOptionsResponseDto>> {
      return fetcher<MemberOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/members/options", query });
    },
    /** 队员详情(返回 memberNo) [rbac: member.read.record] */
    MembersControllerFindOne(id: string): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "GET", path: `/api/admin/v1/members/${id}` });
    },
    /** 更新队员(displayName / gradeCode;**禁止改 memberNo / status**) [rbac: member.update.record] */
    MembersControllerUpdate(id: string, body: UpdateMemberDto): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${id}`, body });
    },
    /** 软删队员(码不绑 biz-admin,仅 SUPER_ADMIN 短路;有 active 部门归属 / 绑定 user 则拒绝;非常规离队入口) [rbac: member.delete.record] */
    MembersControllerSoftDelete(id: string): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "DELETE", path: `/api/admin/v1/members/${id}` });
    },
    /** 给已存在队员开通登录账号(手机验证码登录,不设密码;队员已有绑定账号则拒绝) [rbac: member.grant.account] */
    MembersControllerGrantAccount(id: string, body: GrantMemberAccountDto): Promise<ApiEnvelope<GrantMemberAccountResponseDto>> {
      return fetcher<GrantMemberAccountResponseDto>({ method: "POST", path: `/api/admin/v1/members/${id}/account`, body });
    },
    /** 绑定既有悬空账号到队员(账号保留原登录方式,不强制手机号) [rbac: member.bind.account] */
    MembersControllerBindAccount(id: string, body: BindMemberAccountDto): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "POST", path: `/api/admin/v1/members/${id}/account/bind`, body });
    },
    /** 退号重开:软删旧号 + 开新号(新手机号),单事务原子("账号打错了"一步修复) [rbac: member.grant.account] */
    MembersControllerReopenAccount(id: string, body: GrantMemberAccountDto): Promise<ApiEnvelope<GrantMemberAccountResponseDto>> {
      return fetcher<GrantMemberAccountResponseDto>({ method: "POST", path: `/api/admin/v1/members/${id}/account/reopen`, body });
    },
    /** 队员面启/停关联账号(禁自我操作;置 DISABLED 时联动撤销 refresh) [rbac: user.update.status] */
    MembersControllerUpdateAccountStatus(id: string, body: UpdateMemberAccountStatusDto): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${id}/account/status`, body });
    },
    /** 解绑队员账号(只断链,不停用/软删账号) [rbac: member.bind.account] */
    MembersControllerUnbindAccount(id: string): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "POST", path: `/api/admin/v1/members/${id}/account/unbind` });
    },
    /** 查询会员受众标签 [rbac: member.read.record] */
    MembersControllerAudienceTags(id: string): Promise<ApiEnvelope<MemberAudienceTagsResponseDto>> {
      return fetcher<MemberAudienceTagsResponseDto>({ method: "GET", path: `/api/admin/v1/members/${id}/audience-tags` });
    },
    /** 全量替换会员受众标签(空数组撤销全部) [rbac: member.update.record] */
    MembersControllerReplaceAudienceTags(id: string, body: ReplaceMemberAudienceTagsDto): Promise<ApiEnvelope<MemberAudienceTagsResponseDto>> {
      return fetcher<MemberAudienceTagsResponseDto>({ method: "PUT", path: `/api/admin/v1/members/${id}/audience-tags`, body });
    },
    /** 一键离队并结束全部当前授权来源(归属/账号/任职/分管/直接绑定) [rbac: member.offboard.record] */
    MembersControllerOffboard(id: string): Promise<ApiEnvelope<MemberOffboardResponseDto>> {
      return fetcher<MemberOffboardResponseDto>({ method: "POST", path: `/api/admin/v1/members/${id}/offboard` });
    },
    /** 离队影响预检(活动发起/负责人/协办及当前未来报名安全摘要) [rbac: member.offboard.record] */
    MembersControllerOffboardImpact(id: string): Promise<ApiEnvelope<MemberOffboardImpactResponseDto>> {
      return fetcher<MemberOffboardImpactResponseDto>({ method: "GET", path: `/api/admin/v1/members/${id}/offboard-impact` });
    },
    /** 切换队员 status；置 INACTIVE 时同步结束全部当前授权来源 [rbac: member.update.status] */
    MembersControllerUpdateStatus(id: string, body: UpdateMemberStatusDto): Promise<ApiEnvelope<MemberResponseDto>> {
      return fetcher<MemberResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${id}/status`, body });
    },
    /** 某队员考勤记录(队员 360;分页;仅 approved Sheet 内 records;item 带 activity 上下文;不存在/软删 → MEMBER_NOT_FOUND) [rbac: attendance.read.sheet] */
    AdminMemberAttendanceControllerAttendanceRecords(memberId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AdminMemberAttendanceRecordDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminMemberAttendanceRecordDto[] }>({ method: "GET", path: `/api/admin/v1/members/${memberId}/attendance-records`, query });
    },
    /** 列出队员证书(无分页;按 certStatusCode ASC, createdAt DESC 排序;软删过滤;精简字段) [rbac: certificate.read.record] */
    CertificatesControllerList(memberId: string): Promise<ApiEnvelope<CertificateListItemDto[]>> {
      return fetcher<CertificateListItemDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/certificates` });
    },
    /** 新增一条证书(默认 certStatusCode=pending / isInternal=false) [rbac: certificate.create.record] */
    CertificatesControllerCreate(memberId: string, body: CreateCertificateDto): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "POST", path: `/api/admin/v1/members/${memberId}/certificates`, body });
    },
    /** 资质判定(已核验 + 未过期 + 未软删 = qualified=true;只返布尔 + 摘要) [rbac: certificate.read.record] */
    CertificatesControllerQualificationFlag(memberId: string, query: { "criterionType": "category" | "standard"; "criterionCode": string }): Promise<ApiEnvelope<QualificationFlagResponseDto>> {
      return fetcher<QualificationFlagResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/certificates/qualification-flag`, query });
    },
    /** 查证书详情(含敏感字段;不返 deletedAt) [rbac: certificate.read.record] */
    CertificatesControllerFindOne(memberId: string, id: string): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/certificates/${id}` });
    },
    /** 部分更新证书(全字段 optional;**禁止** id / memberId / certStatusCode / verifiedBy / verifiedAt / verifyNote / isInternal / supersededByCertId / expireNotifyDueAt) [rbac: certificate.update.record] */
    CertificatesControllerUpdate(memberId: string, id: string, body: UpdateCertificateDto): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/certificates/${id}`, body });
    },
    /** 软删证书(写 deletedAt;不物理删除) [rbac: certificate.delete.record] */
    CertificatesControllerSoftDelete(memberId: string, id: string): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "DELETE", path: `/api/admin/v1/members/${memberId}/certificates/${id}` });
    },
    /** 取证书证据短 TTL signed-URL(只返 URL 不返 key;no-store;URL 不入日志/审计/snapshot;RECRUITMENT 来源读 sourceClaim.imageKeys〔TTL 300s〕,ADMIN 来源经 AttachmentsService 的可读性与 pinned ledger 解析且**另需 attachment.view**;provider/ledger 不确定的项 fail-closed 不出现在数组里,绝不回退裸 key) [rbac: certificate.read.sensitive] */
    CertificatesControllerEvidenceUrls(memberId: string, id: string): Promise<ApiEnvelope<CertificateEvidenceUrlsResponseDto>> {
      return fetcher<CertificateEvidenceUrlsResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/certificates/${id}/evidence-urls` });
    },
    /** 核验拒绝(pending → rejected;verifyNote 必填;不接收其他系统字段) [rbac: certificate.reject.record] */
    CertificatesControllerReject(memberId: string, id: string, body: RejectCertificateDto): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/certificates/${id}/reject`, body });
    },
    /** 核验通过(pending → verified;不接收 issuedAt / expiredAt / certStatusCode / verifiedBy / verifiedAt) [rbac: certificate.verify.record] */
    CertificatesControllerVerify(memberId: string, id: string, body: VerifyCertificateDto): Promise<ApiEnvelope<CertificateResponseDto>> {
      return fetcher<CertificateResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/certificates/${id}/verify`, body });
    },
    /** 某队员贡献值生涯累计 capped 总分(队员 360;实时算不落库;approved sheet + 北京日封顶 3;不存在/软删 → MEMBER_NOT_FOUND) [rbac: attendance.read.sheet] */
    AdminMemberAttendanceControllerContributionSummary(memberId: string): Promise<ApiEnvelope<MemberContributionSummaryDto>> {
      return fetcher<MemberContributionSummaryDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/contribution-summary` });
    },
    /** 查队员当前部门归属(无归属返 data: null) [rbac: member-department.read.current] */
    MemberDepartmentsControllerFindCurrent(memberId: string): Promise<ApiEnvelope<MemberDepartmentResponseDto>> {
      return fetcher<MemberDepartmentResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/department` });
    },
    /** 幂等设置队员正式部门(已有归属时软删旧 + 创建新;同 org 直接返回) [rbac: member-department.set.current] */
    MemberDepartmentsControllerSet(memberId: string, body: SetMemberDepartmentDto): Promise<ApiEnvelope<MemberDepartmentResponseDto>> {
      return fetcher<MemberDepartmentResponseDto>({ method: "PUT", path: `/api/admin/v1/members/${memberId}/department`, body });
    },
    /** 解除当前部门归属(软删中间表行;非 SA 也可) [rbac: member-department.clear.current] */
    MemberDepartmentsControllerRemove(memberId: string): Promise<ApiEnvelope<MemberDepartmentResponseDto>> {
      return fetcher<MemberDepartmentResponseDto>({ method: "DELETE", path: `/api/admin/v1/members/${memberId}/department` });
    },
    /** 列出队员紧急联系人(无分页;按 priority ASC, createdAt ASC 排序;软删项不返回) [rbac: emergency-contact.read.record] */
    EmergencyContactsControllerList(memberId: string): Promise<ApiEnvelope<EmergencyContactResponseDto[]>> {
      return fetcher<EmergencyContactResponseDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/emergency-contacts` });
    },
    /** 新增一条紧急联系人 [rbac: emergency-contact.create.record] */
    EmergencyContactsControllerCreate(memberId: string, body: CreateEmergencyContactDto): Promise<ApiEnvelope<EmergencyContactResponseDto>> {
      return fetcher<EmergencyContactResponseDto>({ method: "POST", path: `/api/admin/v1/members/${memberId}/emergency-contacts`, body });
    },
    /** 更新一条紧急联系人(全字段 optional;**禁止** memberId / id 入参) [rbac: emergency-contact.update.record] */
    EmergencyContactsControllerUpdate(memberId: string, id: string, body: UpdateEmergencyContactDto): Promise<ApiEnvelope<EmergencyContactResponseDto>> {
      return fetcher<EmergencyContactResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/emergency-contacts/${id}`, body });
    },
    /** 软删一条紧急联系人(写 deletedAt;不物理删除) [rbac: emergency-contact.delete.record] */
    EmergencyContactsControllerSoftDelete(memberId: string, id: string): Promise<ApiEnvelope<EmergencyContactResponseDto>> {
      return fetcher<EmergencyContactResponseDto>({ method: "DELETE", path: `/api/admin/v1/members/${memberId}/emergency-contacts/${id}` });
    },
    /** 列出队员自购保险(无分页;coverageEnd desc;软删过滤;本人侧走 app/v1/me/insurances) [rbac: member-insurance.read.other] */
    AdminMemberInsurancesControllerList(memberId: string): Promise<ApiEnvelope<MemberInsuranceAdminResponseDto[]>> {
      return fetcher<MemberInsuranceAdminResponseDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/insurances` });
    },
    /** 获取队员统一保险概览（个人自购 + 队内统一覆盖安全投影） [rbac: member-insurance.read.other] */
    AdminMemberInsurancesControllerOverview(memberId: string): Promise<ApiEnvelope<MemberInsuranceOverviewResponseDto>> {
      return fetcher<MemberInsuranceOverviewResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/insurances/overview` });
    },
    /** 记录队员自购保险审核结论(expectedVersion 必填;仅 pending 可审) [rbac: member-insurance.review.record] */
    AdminMemberInsurancesControllerReview(memberId: string, insuranceId: string, body: ReviewMemberInsuranceDto): Promise<ApiEnvelope<MemberInsuranceAdminResponseDto>> {
      return fetcher<MemberInsuranceAdminResponseDto>({ method: "POST", path: `/api/admin/v1/members/${memberId}/insurances/${insuranceId}/review`, body });
    },
    /** 列出队员全部组织归属(主/兼/临时/支援 + 任期;含历史) [rbac: membership.list.record] */
    MembershipsControllerList(memberId: string): Promise<ApiEnvelope<MembershipResponseDto[]>> {
      return fetcher<MembershipResponseDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/memberships` });
    },
    /** 新增队员归属(指定 membershipType) [rbac: membership.set.record] */
    MembershipsControllerCreate(memberId: string, body: CreateMembershipDto): Promise<ApiEnvelope<MembershipResponseDto>> {
      return fetcher<MembershipResponseDto>({ method: "POST", path: `/api/admin/v1/members/${memberId}/memberships`, body });
    },
    /** 改归属类型 / 任期 / 原因(不改 status) [rbac: membership.set.record] */
    MembershipsControllerUpdate(memberId: string, id: string, body: UpdateMembershipDto): Promise<ApiEnvelope<MembershipResponseDto>> {
      return fetcher<MembershipResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/memberships/${id}`, body });
    },
    /** 结束队员归属(status=ENDED + endedAt,保留留痕) [rbac: membership.end.record] */
    MembershipsControllerEnd(memberId: string, id: string): Promise<ApiEnvelope<MembershipResponseDto>> {
      return fetcher<MembershipResponseDto>({ method: "DELETE", path: `/api/admin/v1/members/${memberId}/memberships/${id}` });
    },
    /** 某队员已生效参与账本（分页，可选 ledgerDate 区间） [rbac: attendance.read.sheet] */
    AdminMemberParticipationLedgerControllerList(memberId: string, query?: { "page"?: number; "pageSize"?: number; "dateFrom"?: string; "dateTo"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AdminParticipationLedgerEntryDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminParticipationLedgerEntryDto[] }>({ method: "GET", path: `/api/admin/v1/members/${memberId}/participation-ledger`, query });
    },
    /** 某队员参与累计(approved 时长/活动次数/记录数/生涯封顶贡献；member ref 点判) [rbac: attendance.read.sheet] */
    AdminMemberAttendanceControllerParticipationSummary(memberId: string): Promise<ApiEnvelope<MemberParticipationSummaryDto>> {
      return fetcher<MemberParticipationSummaryDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/participation-summary` });
    },
    /** 列出某队员任职(含 ENDED / REVOKED 历史) [rbac: position-assignment.read.record] */
    PositionAssignmentsControllerListByMember(memberId: string): Promise<ApiEnvelope<PositionAssignmentResponseDto[]>> {
      return fetcher<PositionAssignmentResponseDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/position-assignments` });
    },
    /** 查队员扩展档案(无则返 data: null;documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.read.record] */
    MemberProfilesControllerFindOne(memberId: string): Promise<ApiEnvelope<MemberProfileResponseDto>> {
      return fetcher<MemberProfileResponseDto>({ method: "GET", path: `/api/admin/v1/members/${memberId}/profile` });
    },
    /** 创建队员扩展档案(1:1;重复创建 → MEMBER_PROFILE_ALREADY_EXISTS;回显 documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.create.record] */
    MemberProfilesControllerCreate(memberId: string, body: CreateMemberProfileDto): Promise<ApiEnvelope<MemberProfileResponseDto>> {
      return fetcher<MemberProfileResponseDto>({ method: "POST", path: `/api/admin/v1/members/${memberId}/profile`, body });
    },
    /** 部分更新队员扩展档案(全字段 optional;**禁止** id / memberId / 系统字段;回显 documentNumber / mobile 默认掩码,持 member-profile.read.sensitive 见明文) [rbac: member-profile.update.record] */
    MemberProfilesControllerUpdate(memberId: string, body: UpdateMemberProfileDto): Promise<ApiEnvelope<MemberProfileResponseDto>> {
      return fetcher<MemberProfileResponseDto>({ method: "PATCH", path: `/api/admin/v1/members/${memberId}/profile`, body });
    },
    /** 某队员报名履历(队员 360;分页 + 可选 statusCode;item 带 activity 上下文;不存在/软删 → MEMBER_NOT_FOUND) [rbac: activity-registration.read.record] */
    AdminMemberRegistrationsControllerListForMember(memberId: string, query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "q"?: string; "memberQ"?: string; "activityQ"?: string; "memberId"?: string; "activityId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "dateFrom"?: string; "dateTo"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AdminRegistrationListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminRegistrationListItemDto[] }>({ method: "GET", path: `/api/admin/v1/members/${memberId}/registrations`, query });
    },
    /** 某分管人的分管范围(TREE 经 closure 展开含全部后代 / EXACT 仅该节点;展示读非判权) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerSupervisionScope(memberId: string): Promise<ApiEnvelope<SupervisionScopeEntryDto[]>> {
      return fetcher<SupervisionScopeEntryDto[]>({ method: "GET", path: `/api/admin/v1/members/${memberId}/supervision-scope` });
    },
    /** 分页列组织归属总表(memberId/organizationId/includeDescendants/membershipType/status/q 过滤 + expand=member,organization;缺省含 ENDED 历史) [rbac: membership.list.record] */
    MembershipsAdminControllerPage(query?: { "page"?: number; "pageSize"?: number; "memberId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "membershipType"?: "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT"; "status"?: "ACTIVE" | "ENDED" | "SUSPENDED"; "q"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": MembershipResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": MembershipResponseDto[] }>({ method: "GET", path: "/api/admin/v1/memberships", query });
    },
    /** 归属冲突只读诊断(多 ACTIVE PRIMARY / 悬空队员 / 悬空组织 / 停用组织在任归属;零写入,数据体检面) [rbac: membership.list.record] */
    MembershipsAdminControllerConflicts(query?: { "organizationId"?: string; "includeDescendants"?: boolean }): Promise<ApiEnvelope<MembershipConflictsResponseDto>> {
      return fetcher<MembershipConflictsResponseDto>({ method: "GET", path: "/api/admin/v1/memberships/conflicts", query });
    },
    /** 归属迁移(单事务:结束源组织对应类型 ACTIVE 归属 + 在目标组织建同类型新归属;源=目标 → 400;目标撞唯一 → 17004) [rbac: membership.transfer.record] */
    MembershipsAdminControllerTransfer(body: TransferMembershipDto): Promise<ApiEnvelope<MembershipResponseDto>> {
      return fetcher<MembershipResponseDto>({ method: "POST", path: "/api/admin/v1/memberships/transfer", body });
    },
    /** 查单条归属(detail;找不到未软删记录 → 17003) [rbac: membership.read.record] */
    MembershipsAdminControllerFindOne(id: string): Promise<ApiEnvelope<MembershipResponseDto>> {
      return fetcher<MembershipResponseDto>({ method: "GET", path: `/api/admin/v1/memberships/${id}` });
    },
    /** 工作台/首页待办汇总(报名/考勤/发布审核按对应 action 的授权组织范围统计;activities 无码;无权块或字段静默省略) [auth] */
    MetaControllerDashboardSummary(): Promise<ApiEnvelope<DashboardSummaryResponseDto>> {
      return fetcher<DashboardSummaryResponseDto>({ method: "GET", path: "/api/admin/v1/meta/dashboard-summary" });
    },
    /** 参与度月度总览(活动日期/类型/组织筛选；两项读权限可见组织范围求交；无可见范围返空) [auth] */
    MetaControllerParticipationOverviewSummary(query?: { "dateFrom"?: string; "dateTo"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "activityTypeCode"?: string }): Promise<ApiEnvelope<ParticipationOverviewResponseDto>> {
      return fetcher<ParticipationOverviewResponseDto>({ method: "GET", path: "/api/admin/v1/meta/participation-overview", query });
    },
    /** 批量 id→label 解析(refs≤200;per-type 读权限过滤 + 无权/不存在静默省略) [rbac: meta.resolve.label] */
    MetaControllerResolveLabels(body: ResolveLabelsDto): Promise<ApiEnvelope<ResolveLabelsResponseDto>> {
      return fetcher<ResolveLabelsResponseDto>({ method: "POST", path: "/api/admin/v1/meta/resolve-labels", body });
    },
    /** 列出微信订阅模板配置(各通知类型 → templateId / 启用态;运维查哪些类型可发微信) [rbac: notification.read.record] */
    NotificationWechatTemplateAdminControllerList(): Promise<ApiEnvelope<WechatSubscribeTemplateDto[]>> {
      return fetcher<WechatSubscribeTemplateDto[]>({ method: "GET", path: "/api/admin/v1/notification-wechat-templates" });
    },
    /** 配置某通知类型的微信模板 ID + 启用态(upsert;运营改不重部署;类型须 ∈ notification_type 字典) [rbac: notification.update.template] */
    NotificationWechatTemplateAdminControllerUpsert(typeCode: string, body: UpsertWechatSubscribeTemplateDto): Promise<ApiEnvelope<WechatSubscribeTemplateDto>> {
      return fetcher<WechatSubscribeTemplateDto>({ method: "PUT", path: `/api/admin/v1/notification-wechat-templates/${typeCode}`, body });
    },
    /** 通知分页列表(status/type/visibility/pinned 过滤;admin 见全部状态全可见档;回显 readCount) [rbac: notification.read.record] */
    NotificationAdminControllerList(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "notificationTypeCode"?: string; "visibilityCode"?: string; "pinned"?: boolean }): Promise<ApiEnvelope<PageResultDto & { "items": NotificationAdminListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": NotificationAdminListItemDto[] }>({ method: "GET", path: "/api/admin/v1/notifications", query });
    },
    /** 新建通知草稿(create → draft) [rbac: notification.create.record] */
    NotificationAdminControllerCreate(body: CreateNotificationDto): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "POST", path: "/api/admin/v1/notifications", body });
    },
    /** 通知详情(回显 readCount〔不自增〕) [rbac: notification.read.record] */
    NotificationAdminControllerDetail(id: string): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "GET", path: `/api/admin/v1/notifications/${id}` });
    },
    /** 更新 admin 广播通知(published 的 Effect 字段真实变化自动回 draft;pinned/语义等价更新不撤回;archived/system-directed → 31030) [rbac: notification.update.record] */
    NotificationAdminControllerUpdate(id: string, body: UpdateNotificationDto): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "PATCH", path: `/api/admin/v1/notifications/${id}`, body });
    },
    /** 软删 admin 广播通知(system-directed → 31030) [rbac: notification.delete.record] */
    NotificationAdminControllerRemove(id: string): Promise<ApiEnvelope<Record<string, unknown> | null>> {
      return fetcher<Record<string, unknown> | null>({ method: "DELETE", path: `/api/admin/v1/notifications/${id}` });
    },
    /** 归档 admin 广播通知(published → archived,终态不可逆;system-directed → 31030) [rbac: notification.publish.record] */
    NotificationAdminControllerArchive(id: string): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "POST", path: `/api/admin/v1/notifications/${id}/archive` });
    },
    /** 发布 admin 广播通知(draft → published,publishGeneration 原子 +1,置 publishedAt = 推送时刻;system-directed → 31030) [rbac: notification.publish.record] */
    NotificationAdminControllerPublish(id: string): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "POST", path: `/api/admin/v1/notifications/${id}/publish` });
    },
    /** 重发系统定向通知的企业微信投递(建新 child + 新 eventKey;默认只放行上次是 rate-limited / provider-contract-error 的,越界需 overrideReason=true;已 SENT / 在途 attempt / 非系统定向一概拒) [rbac: notification.replay.wecom] */
    NotificationAdminControllerReplayWecom(id: string, body: ReplayNotificationWecomDto): Promise<ApiEnvelope<NotificationWecomReplayResultDto>> {
      return fetcher<NotificationWecomReplayResultDto>({ method: "POST", path: `/api/admin/v1/notifications/${id}/replay-wecom`, body });
    },
    /** 显式发起 admin 广播短信兜底(计费确认必需:confirmed=true 才真发,false 仅预览;须已发布且声明短信渠道;system-directed → 31013) [rbac: notification.send.sms] */
    NotificationAdminControllerSendSms(id: string, body: SendNotificationSmsDto): Promise<ApiEnvelope<NotificationSmsSendResultDto>> {
      return fetcher<NotificationSmsSendResultDto>({ method: "POST", path: `/api/admin/v1/notifications/${id}/send-sms`, body });
    },
    /** 撤回 admin 广播通知(published → draft,保留 publishedAt;system-directed → 31030) [rbac: notification.publish.record] */
    NotificationAdminControllerUnpublish(id: string): Promise<ApiEnvelope<NotificationAdminDetailDto>> {
      return fetcher<NotificationAdminDetailDto>({ method: "POST", path: `/api/admin/v1/notifications/${id}/unpublish` });
    },
    /** 列出组织节点(分页;parentId=null 过滤根节点) [rbac: org.read.node] */
    OrganizationsControllerList(query?: { "page"?: number; "pageSize"?: number; "parentId"?: string; "nodeTypeCode"?: string; "status"?: "ACTIVE" | "INACTIVE"; "q"?: string; "nameContains"?: string; "codeContains"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": OrganizationResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": OrganizationResponseDto[] }>({ method: "GET", path: "/api/admin/v1/organizations", query });
    },
    /** 创建组织节点(parentId 不传 = 根节点;V2 第一阶段单根上限 1) [rbac: org.create.node] */
    OrganizationsControllerCreate(body: CreateOrganizationDto): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "POST", path: "/api/admin/v1/organizations", body });
    },
    /** 组织选择器投影(q 模糊 name+code;limit≤100,默认 20) [rbac: org.read.node] */
    OrganizationsControllerOptions(query?: { "q"?: string; "nodeTypeCode"?: string; "status"?: "ACTIVE" | "INACTIVE"; "limit"?: number }): Promise<ApiEnvelope<OrganizationOptionsResponseDto>> {
      return fetcher<OrganizationOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/organizations/options", query });
    },
    /** 组织树形(从根开始嵌套;深度无限制) [rbac: org.read.node] */
    OrganizationsControllerTree(query?: { "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<OrganizationTreeNodeDto[]>> {
      return fetcher<OrganizationTreeNodeDto[]>({ method: "GET", path: "/api/admin/v1/organizations/tree", query });
    },
    /** 组织树极简投影(id/label/code/children,表单级联选择器用) [rbac: org.read.node] */
    OrganizationsControllerTreeOptions(query?: { "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<OrganizationTreeOptionItemDto[]>> {
      return fetcher<OrganizationTreeOptionItemDto[]>({ method: "GET", path: "/api/admin/v1/organizations/tree-options", query });
    },
    /** 组织树 + 每节点归属计数(directMembershipCount 直属 / subtreeMembershipCount 含后代;ACTIVE 归属条数,展示读) [rbac: org.read.node] */
    OrganizationsControllerTreeWithSummary(query?: { "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<OrganizationTreeWithSummaryNodeDto[]>> {
      return fetcher<OrganizationTreeWithSummaryNodeDto[]>({ method: "GET", path: "/api/admin/v1/organizations/tree-with-summary", query });
    },
    /** 组织节点详情 [rbac: org.read.node] */
    OrganizationsControllerFindOne(id: string): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "GET", path: `/api/admin/v1/organizations/${id}` });
    },
    /** 更新组织节点(name / sortOrder / nodeTypeCode;**禁止改 parentId**) [rbac: org.update.node] */
    OrganizationsControllerUpdate(id: string, body: UpdateOrganizationDto): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "PATCH", path: `/api/admin/v1/organizations/${id}`, body });
    },
    /** 软删组织节点(P0-F PR-2A D3=A 放宽:ops-admin 可调;有子节点 / 成员归属 / 唯一活跃根则拒绝) [rbac: org.delete.node] */
    OrganizationsControllerSoftDelete(id: string): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "DELETE", path: `/api/admin/v1/organizations/${id}` });
    },
    /** 重挂组织节点父级(reparent;禁改根节点父级 / 目标父=自身或后代成环 → 拒;事务内重算 closure) [rbac: org.move.node] */
    OrganizationsControllerMove(id: string, body: MoveOrganizationDto): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "POST", path: `/api/admin/v1/organizations/${id}/move`, body });
    },
    /** 启停组织节点(只改 status;停用唯一活跃根 → LAST_ROOT_PROTECTED) [rbac: org.update.node] */
    OrganizationsControllerUpdateStatus(id: string, body: UpdateOrganizationStatusDto): Promise<ApiEnvelope<OrganizationResponseDto>> {
      return fetcher<OrganizationResponseDto>({ method: "PATCH", path: `/api/admin/v1/organizations/${id}/status`, body });
    },
    /** 组织轴队员下拉(该组织±后代的可选队员;复用 F1 members/options 投影;组织不存在 → 11001) [rbac: member.read.record] */
    MembershipsAdminControllerOrgMembersOptions(orgId: string, query?: { "q"?: string; "includeDescendants"?: boolean; "limit"?: number }): Promise<ApiEnvelope<MemberOptionsResponseDto>> {
      return fetcher<MemberOptionsResponseDto>({ method: "GET", path: `/api/admin/v1/organizations/${orgId}/members/options`, query });
    },
    /** 组织轴列归属(分页;includeDescendants 展开后代 + membershipType/status/q 过滤 + expand=member,organization;含历史与暂停,组织成员页请传 status=ACTIVE;组织不存在 → 11001) [rbac: membership.list.record] */
    MembershipsAdminControllerListForOrganization(orgId: string, query?: { "page"?: number; "pageSize"?: number; "includeDescendants"?: boolean; "membershipType"?: "PRIMARY" | "SECONDARY" | "TEMPORARY" | "SUPPORT"; "status"?: "ACTIVE" | "ENDED" | "SUSPENDED"; "q"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": MembershipResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": MembershipResponseDto[] }>({ method: "GET", path: `/api/admin/v1/organizations/${orgId}/memberships`, query });
    },
    /** 列出某组织在任职务(status=ACTIVE) [rbac: position-assignment.read.record] */
    PositionAssignmentsControllerListByOrganization(orgId: string): Promise<ApiEnvelope<PositionAssignmentResponseDto[]>> {
      return fetcher<PositionAssignmentResponseDto[]>({ method: "GET", path: `/api/admin/v1/organizations/${orgId}/position-assignments` });
    },
    /** 任命(校验 active 职务/规则、严格兼任交集、人数上限、归属要求、任期；锁后重算) [rbac: position-assignment.create.record] */
    PositionAssignmentsControllerCreate(orgId: string, body: CreatePositionAssignmentDto): Promise<ApiEnvelope<PositionAssignmentResponseDto>> {
      return fetcher<PositionAssignmentResponseDto>({ method: "POST", path: `/api/admin/v1/organizations/${orgId}/position-assignments`, body });
    },
    /** 某组织被谁分管(直接分管 + 祖先 TREE 继承覆盖,标 coverage;展示读 closure 非判权) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerSupervisors(orgId: string): Promise<ApiEnvelope<OrganizationSupervisorDto[]>> {
      return fetcher<OrganizationSupervisorDto[]>({ method: "GET", path: `/api/admin/v1/organizations/${orgId}/supervisors` });
    },
    /** 全局分页任职总表(organizationId+includeDescendants/memberId/positionId/status/q 过滤 + expand=member,position,organization;缺省含 REVOKED 历史) [rbac: position-assignment.read.record] */
    PositionAssignmentsControllerPage(query?: { "page"?: number; "pageSize"?: number; "organizationId"?: string; "includeDescendants"?: boolean; "memberId"?: string; "positionId"?: string; "status"?: "ACTIVE" | "ENDED" | "REVOKED"; "q"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": PositionAssignmentResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": PositionAssignmentResponseDto[] }>({ method: "GET", path: "/api/admin/v1/position-assignments", query });
    },
    /** 预检任命(dry-run:任期 + 存在性/member ACTIVE + active 配置/归属/兼任/人数上限全量收集；只读时点建议) [rbac: position-assignment.read.record] */
    PositionAssignmentsControllerPreview(body: PreviewPositionAssignmentDto): Promise<ApiEnvelope<PositionAssignmentPreviewResponseDto>> {
      return fetcher<PositionAssignmentPreviewResponseDto>({ method: "POST", path: "/api/admin/v1/position-assignments/preview", body });
    },
    /** 查单条任职(detail;找不到未软删记录 → 32020) [rbac: position-assignment.read.record] */
    PositionAssignmentsControllerFindOne(id: string): Promise<ApiEnvelope<PositionAssignmentResponseDto>> {
      return fetcher<PositionAssignmentResponseDto>({ method: "GET", path: `/api/admin/v1/position-assignments/${id}` });
    },
    /** 任职变更/历史链(以 :id 锚定人-组织-职务三元组) [rbac: position-assignment.read.history] */
    PositionAssignmentsControllerHistory(id: string): Promise<ApiEnvelope<PositionAssignmentResponseDto[]>> {
      return fetcher<PositionAssignmentResponseDto[]>({ method: "GET", path: `/api/admin/v1/position-assignments/${id}/history` });
    },
    /** 撤销任职(status=REVOKED + 撤销人 + endedAt；required/minCount 不阻断) [rbac: position-assignment.revoke.record] */
    PositionAssignmentsControllerRevoke(id: string): Promise<ApiEnvelope<PositionAssignmentResponseDto>> {
      return fetcher<PositionAssignmentResponseDto>({ method: "POST", path: `/api/admin/v1/position-assignments/${id}/revoke` });
    },
    /** 列出职务规则(分页 + 过滤 nodeTypeCode / positionId / status) [rbac: position-rule.read.record] */
    PositionRulesControllerList(query?: { "page"?: number; "pageSize"?: number; "nodeTypeCode"?: string; "positionId"?: string; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<PageResultDto & { "items": PositionRuleResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": PositionRuleResponseDto[] }>({ method: "GET", path: "/api/admin/v1/position-rules", query });
    },
    /** 创建职务规则(校验字典/职务/唯一键 + required/min/max 一致性) [rbac: position-rule.create.record] */
    PositionRulesControllerCreate(body: CreatePositionRuleDto): Promise<ApiEnvelope<PositionRuleResponseDto>> {
      return fetcher<PositionRuleResponseDto>({ method: "POST", path: "/api/admin/v1/position-rules", body });
    },
    /** 部分更新职务规则(合并现值校验 required/min/max；禁改 nodeTypeCode/positionId) [rbac: position-rule.update.record] */
    PositionRulesControllerUpdate(id: string, body: UpdatePositionRuleDto): Promise<ApiEnvelope<PositionRuleResponseDto>> {
      return fetcher<PositionRuleResponseDto>({ method: "PATCH", path: `/api/admin/v1/position-rules/${id}`, body });
    },
    /** 软删职务规则 [rbac: position-rule.delete.record] */
    PositionRulesControllerSoftDelete(id: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: `/api/admin/v1/position-rules/${id}` });
    },
    /** 列出职务定义(分页 + 过滤 categoryCode / status) [rbac: position.read.definition] */
    PositionsControllerList(query?: { "page"?: number; "pageSize"?: number; "categoryCode"?: "LEADER" | "DEPUTY" | "STAFF"; "status"?: "ACTIVE" | "INACTIVE" }): Promise<ApiEnvelope<PageResultDto & { "items": PositionResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": PositionResponseDto[] }>({ method: "GET", path: "/api/admin/v1/positions", query });
    },
    /** 创建职务定义(code kebab 唯一) [rbac: position.create.definition] */
    PositionsControllerCreate(body: CreatePositionDto): Promise<ApiEnvelope<PositionResponseDto>> {
      return fetcher<PositionResponseDto>({ method: "POST", path: "/api/admin/v1/positions", body });
    },
    /** 职务选择器投影(q 模糊 name;limit≤100,默认 20) [rbac: position.read.definition] */
    PositionsControllerOptions(query?: { "categoryCode"?: "LEADER" | "DEPUTY" | "STAFF"; "status"?: "ACTIVE" | "INACTIVE"; "q"?: string; "limit"?: number }): Promise<ApiEnvelope<PositionOptionsResponseDto>> {
      return fetcher<PositionOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/positions/options", query });
    },
    /** 职务定义详情(软删返 404) [rbac: position.read.definition] */
    PositionsControllerFindOne(id: string): Promise<ApiEnvelope<PositionResponseDto>> {
      return fetcher<PositionResponseDto>({ method: "GET", path: `/api/admin/v1/positions/${id}` });
    },
    /** 部分更新职务定义(白名单禁改 code,由 ValidationPipe 拦截) [rbac: position.update.definition] */
    PositionsControllerUpdate(id: string, body: UpdatePositionDto): Promise<ApiEnvelope<PositionResponseDto>> {
      return fetcher<PositionResponseDto>({ method: "PATCH", path: `/api/admin/v1/positions/${id}`, body });
    },
    /** 软删职务定义(被职务规则引用时禁删 → 32003) [rbac: position.delete.definition] */
    PositionsControllerSoftDelete(id: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: `/api/admin/v1/positions/${id}` });
    },
    /** 招新报名分页列表(可按 cycleId / statusCode / riskLevel〔S4b 人工队列三栏 normal/high/system〕过滤;身份证号/手机列表掩码) [rbac: recruitment-application.read.record] */
    RecruitmentApplicationsAdminControllerList(query?: { "page"?: number; "pageSize"?: number; "cycleId"?: string; "statusCode"?: string; "riskLevel"?: "normal" | "high" | "system" }): Promise<ApiEnvelope<PageResultDto & { "items": RecruitmentApplicationAdminDto[] }>> {
      return fetcher<PageResultDto & { "items": RecruitmentApplicationAdminDto[] }>({ method: "GET", path: "/api/admin/v1/recruitment/applications", query });
    },
    /** 批量标门槛(匹配键 临时编号/手机/姓名+手机,签到记录导入由前端解析为数组;逐行复用单行 markThreshold = 逐行幂等 + 逐行容错〔某行匹配不上/状态非法不整批回滚〕+ 自动推进;返回 per-row 结果 + 批次汇总) [rbac: recruitment-application.mark.threshold] */
    RecruitmentApplicationsAdminControllerBatchMarkThreshold(body: BatchMarkThresholdDto): Promise<ApiEnvelope<BatchMarkThresholdResultDto>> {
      return fetcher<BatchMarkThresholdResultDto>({ method: "POST", path: "/api/admin/v1/recruitment/applications/batch-mark-threshold", body });
    },
    /** 批量导出 CSV(按筛选 全部/待人工/已初审/门槛未完成/待评定/公示/发号/淘汰;持 read.sensitive → 明文证件号/手机列 / 仅 read.record → 脱敏列〔S3 分级,脱敏复用 toAdminDto〕;读操作记审计) [rbac: recruitment-application.read.record] */
    RecruitmentApplicationsAdminControllerExport(body: ExportRecruitmentApplicationsDto): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "POST", path: "/api/admin/v1/recruitment/applications/export", body });
    },
    /** 列出某报名的全部证书申报(一证一行;编号默认掩码、imageCount 代替 key;明文与审核人需敏感码) [rbac: recruitment-application.read.record] */
    RecruitmentCertificateClaimsAdminControllerList(applicationId: string): Promise<ApiEnvelope<RecruitmentCertificateClaimListResponseDto>> {
      return fetcher<RecruitmentCertificateClaimListResponseDto>({ method: "GET", path: `/api/admin/v1/recruitment/applications/${applicationId}/certificate-claims` });
    },
    /** 招新报名详情(敏感分级 S3:持 read.sensitive 看明文身份证号/手机,仅 read.record 看脱敏;字段集不变;读 PII 记审计) [rbac: recruitment-application.read.record] */
    RecruitmentApplicationsAdminControllerDetail(id: string): Promise<ApiEnvelope<RecruitmentApplicationAdminDto>> {
      return fetcher<RecruitmentApplicationAdminDto>({ method: "GET", path: `/api/admin/v1/recruitment/applications/${id}` });
    },
    /** admin 改报名资料(R1 白名单:非身份字段恒可改;身份字段 realName/idCardNumber/birthDate/genderCode 仅 manual_review 或非大陆证件记录,verified 大陆 → 28045;大陆 birthDate/genderCode 恒由证件号派生不可直改;大陆改证件号 → 校验位/年龄复检 + 重派生 + 同轮去重;promoted/已脱敏行 → 28041;不含 phone/openid〔走自助换绑〕;必落 audit) [rbac: recruitment-application.update.record] */
    RecruitmentApplicationsAdminControllerUpdate(id: string, body: UpdateRecruitmentApplicationDto): Promise<ApiEnvelope<RecruitmentApplicationAdminDto>> {
      return fetcher<RecruitmentApplicationAdminDto>({ method: "PATCH", path: `/api/admin/v1/recruitment/applications/${id}`, body });
    },
    /** 综合评定/淘汰(单一人工闸;pending_evaluation 通过→公示·不通过→未通过;verified approved=false→门槛超期淘汰;他态或门槛未齐 approve→28041) [rbac: recruitment-application.evaluate.assessment] */
    RecruitmentApplicationsAdminControllerEvaluate(id: string, body: EvaluateRecruitmentApplicationDto): Promise<ApiEnvelope<RecruitmentApplicationAdminDto>> {
      return fetcher<RecruitmentApplicationAdminDto>({ method: "POST", path: `/api/admin/v1/recruitment/applications/${id}/evaluate`, body });
    },
    /** 取证件照短 TTL signed-URL(L3;不入日志/snapshot;读图记审计;敏感分级 S3) [rbac: recruitment-application.read.sensitive] */
    RecruitmentApplicationsAdminControllerIdCardImageUrl(id: string): Promise<ApiEnvelope<IdCardImageUrlResponseDto>> {
      return fetcher<IdCardImageUrlResponseDto>({ method: "GET", path: `/api/admin/v1/recruitment/applications/${id}/id-card-image-url` });
    },
    /** 单人手动建档(publicity 报名逐条发号建 User+Member;与批量共用同一建档内核/原子号段/通知派发;非大陆证件须先补齐 birthDate/genderCode,缺 → 28047;锚点择优 openid 未占用→微信 / openid 缺·占用且 phone 未占用→手机 / 双缺双占→28046;非 publicity〔含已 promoted 重跑〕→ 28041 幂等零重复) [rbac: recruitment-application.promote.single] */
    RecruitmentApplicationsAdminControllerPromoteSingle(id: string): Promise<ApiEnvelope<PromoteSingleResultDto>> {
      return fetcher<PromoteSingleResultDto>({ method: "POST", path: `/api/admin/v1/recruitment/applications/${id}/promote-single` });
    },
    /** 人工 resolve(manual_review 或 pending_verification 真卡死态〔verifyOutcome 已落库;核验在途态不可碰〕;approved→verified 发临时编号〔受容量限;mismatch 卡死态只能 reject〕/ 否→rejected;不可解或在途→28040) [rbac: recruitment-application.resolve.manual] */
    RecruitmentApplicationsAdminControllerResolve(id: string, body: ResolveRecruitmentApplicationDto): Promise<ApiEnvelope<RecruitmentApplicationAdminDto>> {
      return fetcher<RecruitmentApplicationAdminDto>({ method: "POST", path: `/api/admin/v1/recruitment/applications/${id}/resolve`, body });
    },
    /** 标/清门槛(仅巡山×2/培训三项人工门槛;⚠️ 契约收紧:急救资质 redCross 与 BSAFE 已改为证书申报审核结论的派生投影,传这两个 code 无论 completed 真假一律 28063;清标不受闸;幂等;仅 verified/pending_evaluation 态;末次完成自动→待综合评定) [rbac: recruitment-application.mark.threshold] */
    RecruitmentApplicationsAdminControllerMarkThreshold(id: string, body: MarkThresholdDto): Promise<ApiEnvelope<RecruitmentApplicationAdminDto>> {
      return fetcher<RecruitmentApplicationAdminDto>({ method: "PATCH", path: `/api/admin/v1/recruitment/applications/${id}/thresholds`, body });
    },
    /** 证书申报详情(授权不只靠 claimId —— 连带校验其报名真实且未软删) [rbac: recruitment-application.read.record] */
    RecruitmentCertificateClaimsAdminControllerFindOne(id: string): Promise<ApiEnvelope<RecruitmentCertificateClaimAdminDto>> {
      return fetcher<RecruitmentCertificateClaimAdminDto>({ method: "GET", path: `/api/admin/v1/recruitment/certificate-claims/${id}` });
    },
    /** 取证书申报证据图短 TTL signed-URL(只返 URL 不返 key;no-store;URL 不入日志/审计/snapshot) [rbac: recruitment-application.read.sensitive] */
    RecruitmentCertificateClaimsAdminControllerImageUrls(id: string): Promise<ApiEnvelope<RecruitmentCertificateClaimImageUrlsResponseDto>> {
      return fetcher<RecruitmentCertificateClaimImageUrlsResponseDto>({ method: "GET", path: `/api/admin/v1/recruitment/certificate-claims/${id}/image-urls` });
    },
    /** 审核单张证书申报(APPROVE 锁定 Standard/Policy/机构/编号/日期;REJECT 与 NEEDS_INFO 需 note;version 为 CAS) [rbac: recruitment-application.review.certificate] */
    RecruitmentCertificateClaimsAdminControllerReview(id: string, body: ReviewCertificateClaimDto): Promise<ApiEnvelope<RecruitmentCertificateClaimAdminDto>> {
      return fetcher<RecruitmentCertificateClaimAdminDto>({ method: "POST", path: `/api/admin/v1/recruitment/certificate-claims/${id}/review`, body });
    },
    /** 撤回已通过的审核结论(APPROVED → SUBMITTED;清空 Standard/Policy/机构与审核字段;note 必填,写高价值审计) [rbac: recruitment-application.review.certificate] */
    RecruitmentCertificateClaimsAdminControllerRevokeReview(id: string, body: RevokeCertificateClaimReviewDto): Promise<ApiEnvelope<RecruitmentCertificateClaimAdminDto>> {
      return fetcher<RecruitmentCertificateClaimAdminDto>({ method: "POST", path: `/api/admin/v1/recruitment/certificate-claims/${id}/revoke-review`, body });
    },
    /** 招新轮次分页列表 [rbac: recruitment-cycle.read.record] */
    RecruitmentCyclesControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": RecruitmentCycleResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": RecruitmentCycleResponseDto[] }>({ method: "GET", path: "/api/admin/v1/recruitment/cycles", query });
    },
    /** 创建招新轮次(默认 closed,需显式开轮) [rbac: recruitment-cycle.create.record] */
    RecruitmentCyclesControllerCreate(body: CreateRecruitmentCycleDto): Promise<ApiEnvelope<RecruitmentCycleResponseDto>> {
      return fetcher<RecruitmentCycleResponseDto>({ method: "POST", path: "/api/admin/v1/recruitment/cycles", body });
    },
    /** 招新轮次详情 [rbac: recruitment-cycle.read.record] */
    RecruitmentCyclesControllerDetail(id: string): Promise<ApiEnvelope<RecruitmentCycleResponseDto>> {
      return fetcher<RecruitmentCycleResponseDto>({ method: "GET", path: `/api/admin/v1/recruitment/cycles/${id}` });
    },
    /** 更新招新轮次(开/关轮、容量、见面会/QQ群/通知模板;开 open 轮要求当前无其它 open 轮) [rbac: recruitment-cycle.update.record] */
    RecruitmentCyclesControllerUpdate(id: string, body: UpdateRecruitmentCycleDto): Promise<ApiEnvelope<RecruitmentCycleResponseDto>> {
      return fetcher<RecruitmentCycleResponseDto>({ method: "PATCH", path: `/api/admin/v1/recruitment/cycles/${id}`, body });
    },
    /** 公示结束一键发号:对公示报名按拼音序批量发永久编号 {YY}{NNN} + 建 User+Member+档案+紧急联系人(单事务原子/幂等;非大陆证件资料齐备亦可批量发号;不可发项 skip+report 不 block;空集零发) [rbac: recruitment-application.promote.member] */
    RecruitmentCyclesControllerPromote(id: string): Promise<ApiEnvelope<PromoteResultDto>> {
      return fetcher<PromoteResultDto>({ method: "POST", path: `/api/admin/v1/recruitment/cycles/${id}/promote` });
    },
    /** 一键发号前预检(纯读;复用 decidePromotionIssuance 结构性保证「预检=实发」;逐行可发/跳过 + 六类跳过原因 + 重复 openid 高亮 + 缺手机/生日/性别 + 特殊证件标识 + 汇总) [rbac: recruitment-application.promote.member] */
    RecruitmentCyclesControllerPromotePrecheck(id: string): Promise<ApiEnvelope<PromotePrecheckResultDto>> {
      return fetcher<PromotePrecheckResultDto>({ method: "GET", path: `/api/admin/v1/recruitment/cycles/${id}/promote-precheck` });
    },
    /** 公示名单(姓名 + 拟发编号,拼音序,零敏感;资料或登录锚不齐的项 needsManualBuild=true 不占号) [rbac: recruitment-application.read.record] */
    RecruitmentCyclesControllerPublicityList(id: string): Promise<ApiEnvelope<PublicityListResponseDto>> {
      return fetcher<PublicityListResponseDto>({ method: "GET", path: `/api/admin/v1/recruitment/cycles/${id}/publicity-list` });
    },
    /** 招新工作台聚合 stats(今日数据/待处理事项/门槛进度/综合评定/公示发号 五组;纯读零写;各业务态计数与 stage 派生同源) [rbac: recruitment-application.read.record] */
    RecruitmentCyclesControllerStats(id: string): Promise<ApiEnvelope<RecruitmentCycleStatsDto>> {
      return fetcher<RecruitmentCycleStatsDto>({ method: "GET", path: `/api/admin/v1/recruitment/cycles/${id}/stats` });
    },
    /** 跨活动报名横扫(审批工作台;分页 + 可选 statusCode/q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/expand=member,activity;脱离 :activityId 路径段;item 带 activity 上下文) [rbac: activity-registration.read.record] */
    AdminRegistrationsControllerListAll(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string; "q"?: string; "memberQ"?: string; "activityQ"?: string; "memberId"?: string; "activityId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "dateFrom"?: string; "dateTo"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AdminRegistrationListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AdminRegistrationListItemDto[] }>({ method: "GET", path: "/api/admin/v1/registrations", query });
    },
    /** 列角色绑定(可按 principalType × principalId × role × scopeType × status 过滤;含 scoped 各型) [rbac: role-binding.read.record] */
    RoleBindingsControllerList(query?: { "principalType"?: "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SYSTEM"; "principalId"?: string; "roleId"?: string; "scopeType"?: "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF"; "status"?: "ACTIVE" | "ENDED" | "SUSPENDED" }): Promise<ApiEnvelope<RoleBindingResponseDto[]>> {
      return fetcher<RoleBindingResponseDto[]>({ method: "GET", path: "/api/admin/v1/role-bindings", query });
    },
    /** 建角色绑定(principal × role × scope + 任期;GLOBAL/ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF;scoped 入库不判,判权是 PR8) [rbac: role-binding.create.record] */
    RoleBindingsControllerCreate(body: CreateRoleBindingDto): Promise<ApiEnvelope<RoleBindingResponseDto>> {
      return fetcher<RoleBindingResponseDto>({ method: "POST", path: "/api/admin/v1/role-bindings", body });
    },
    /** 批量建角色绑定(≤200 条,逐条 ok/blocked/already-exists;already-exists=幂等 skip,重跑同批不报错) [rbac: role-binding.create.record] */
    RoleBindingsControllerCreateBatch(body: BatchCreateRoleBindingsDto): Promise<ApiEnvelope<BatchCreateRoleBindingsResponseDto>> {
      return fetcher<BatchCreateRoleBindingsResponseDto>({ method: "POST", path: "/api/admin/v1/role-bindings/batch", body });
    },
    /** 分页列角色绑定(既有 5 过滤 + scopeOrgId/roleCode/principalQ/includeExpired/q + expand=role,principal;默认仅当前生效) [rbac: role-binding.read.record] */
    RoleBindingsControllerPage(query?: { "page"?: number; "pageSize"?: number; "principalType"?: "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SYSTEM"; "principalId"?: string; "roleId"?: string; "scopeType"?: "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF"; "status"?: "ACTIVE" | "ENDED" | "SUSPENDED"; "scopeOrgId"?: string; "roleCode"?: string; "principalQ"?: string; "includeExpired"?: boolean; "q"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": RoleBindingResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": RoleBindingResponseDto[] }>({ method: "GET", path: "/api/admin/v1/role-bindings/page", query });
    },
    /** 预检待建角色绑定(dry-run:与 create 同参同校验,零写入;冲突/非法逐项返 conflicts,deny 是数据) [rbac: role-binding.read.record] */
    RoleBindingsControllerPreview(query: { "principalType": "USER" | "MEMBER" | "POSITION_ASSIGNMENT" | "SYSTEM"; "principalId"?: string; "roleId": string; "scopeType": "GLOBAL" | "ORGANIZATION" | "ORGANIZATION_TREE" | "ACTIVITY" | "RESOURCE" | "SELF"; "scopeOrgId"?: string; "scopeActivityId"?: string; "scopeResourceType"?: string; "scopeResourceId"?: string; "startedAt"?: string; "endedAt"?: string; "note"?: string }): Promise<ApiEnvelope<RoleBindingPreviewResponseDto>> {
      return fetcher<RoleBindingPreviewResponseDto>({ method: "GET", path: "/api/admin/v1/role-bindings/preview", query });
    },
    /** 查单条角色绑定(detail;找不到未软删记录 → 34001) [rbac: role-binding.read.record] */
    RoleBindingsControllerFindOne(id: string): Promise<ApiEnvelope<RoleBindingResponseDto>> {
      return fetcher<RoleBindingResponseDto>({ method: "GET", path: `/api/admin/v1/role-bindings/${id}` });
    },
    /** 改角色绑定(状态 / 任期 / note;不可改 principal/role/scope) [rbac: role-binding.update.record] */
    RoleBindingsControllerUpdate(id: string, body: UpdateRoleBindingDto): Promise<ApiEnvelope<RoleBindingResponseDto>> {
      return fetcher<RoleBindingResponseDto>({ method: "PATCH", path: `/api/admin/v1/role-bindings/${id}`, body });
    },
    /** 软删角色绑定(status=ENDED + endedAt + deletedAt;保历史) [rbac: role-binding.delete.record] */
    RoleBindingsControllerRemove(id: string): Promise<ApiEnvelope<RoleBindingResponseDto>> {
      return fetcher<RoleBindingResponseDto>({ method: "DELETE", path: `/api/admin/v1/role-bindings/${id}` });
    },
    /** 列出当前在任分管(status=ACTIVE) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerList(): Promise<ApiEnvelope<SupervisionAssignmentResponseDto[]>> {
      return fetcher<SupervisionAssignmentResponseDto[]>({ method: "GET", path: "/api/admin/v1/supervision-assignments" });
    },
    /** 建分管(supervisor × org × scopeMode + 任期;与职务正交,不要求 supervisor 持职务) [rbac: supervision-assignment.create.record] */
    SupervisionAssignmentsControllerCreate(body: CreateSupervisionAssignmentDto): Promise<ApiEnvelope<SupervisionAssignmentResponseDto>> {
      return fetcher<SupervisionAssignmentResponseDto>({ method: "POST", path: "/api/admin/v1/supervision-assignments", body });
    },
    /** 覆盖范围预演(dry-run:某待建分管将覆盖哪些组织;EXACT=[该节点] / TREE=closure 展开含后代;零写入,展示读非判权) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerCoveragePreview(body: SupervisionCoveragePreviewDto): Promise<ApiEnvelope<SupervisionCoveragePreviewResponseDto>> {
      return fetcher<SupervisionCoveragePreviewResponseDto>({ method: "POST", path: "/api/admin/v1/supervision-assignments/coverage-preview", body });
    },
    /** 分页分管总表(supervisorMemberId/organizationId+includeDescendants/scopeMode/status/q 过滤 + expand=supervisor,organization;缺省含 REVOKED 历史) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerPage(query?: { "page"?: number; "pageSize"?: number; "supervisorMemberId"?: string; "organizationId"?: string; "includeDescendants"?: boolean; "scopeMode"?: "EXACT" | "TREE"; "status"?: "ACTIVE" | "ENDED" | "REVOKED"; "q"?: string; "expand"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": SupervisionAssignmentResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": SupervisionAssignmentResponseDto[] }>({ method: "GET", path: "/api/admin/v1/supervision-assignments/page", query });
    },
    /** 查单条分管(detail;找不到未软删记录 → 33001) [rbac: supervision-assignment.read.record] */
    SupervisionAssignmentsControllerFindOne(id: string): Promise<ApiEnvelope<SupervisionAssignmentResponseDto>> {
      return fetcher<SupervisionAssignmentResponseDto>({ method: "GET", path: `/api/admin/v1/supervision-assignments/${id}` });
    },
    /** 改分管(scopeMode / 任期 / note;不可改 supervisor/organization) [rbac: supervision-assignment.update.record] */
    SupervisionAssignmentsControllerUpdate(id: string, body: UpdateSupervisionAssignmentDto): Promise<ApiEnvelope<SupervisionAssignmentResponseDto>> {
      return fetcher<SupervisionAssignmentResponseDto>({ method: "PATCH", path: `/api/admin/v1/supervision-assignments/${id}`, body });
    },
    /** 撤销分管(status=REVOKED + 撤销人 + endedAt) [rbac: supervision-assignment.revoke.record] */
    SupervisionAssignmentsControllerRevoke(id: string): Promise<ApiEnvelope<SupervisionAssignmentResponseDto>> {
      return fetcher<SupervisionAssignmentResponseDto>({ method: "POST", path: `/api/admin/v1/supervision-assignments/${id}/revoke` });
    },
    /** 队保单分页列表(软删过滤;createdAt desc) [rbac: team-insurance-policy.read.record] */
    TeamInsurancePoliciesControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": TeamInsurancePolicyResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": TeamInsurancePolicyResponseDto[] }>({ method: "GET", path: "/api/admin/v1/team-insurance-policies", query });
    },
    /** 创建队保单(一张 = 一条;起保 ≤ 到期否则 26010) [rbac: team-insurance-policy.create.record] */
    TeamInsurancePoliciesControllerCreate(body: CreateTeamInsurancePolicyDto): Promise<ApiEnvelope<TeamInsurancePolicyResponseDto>> {
      return fetcher<TeamInsurancePolicyResponseDto>({ method: "POST", path: "/api/admin/v1/team-insurance-policies", body });
    },
    /** 队保单详情(不含覆盖名单,名单走 :id/members) [rbac: team-insurance-policy.read.record] */
    TeamInsurancePoliciesControllerFindOne(id: string): Promise<ApiEnvelope<TeamInsurancePolicyResponseDto>> {
      return fetcher<TeamInsurancePolicyResponseDto>({ method: "GET", path: `/api/admin/v1/team-insurance-policies/${id}` });
    },
    /** 部分更新队保单(终态起保 ≤ 到期否则 26010;note 传空串清空) [rbac: team-insurance-policy.update.record] */
    TeamInsurancePoliciesControllerUpdate(id: string, body: UpdateTeamInsurancePolicyDto): Promise<ApiEnvelope<TeamInsurancePolicyResponseDto>> {
      return fetcher<TeamInsurancePolicyResponseDto>({ method: "PATCH", path: `/api/admin/v1/team-insurance-policies/${id}`, body });
    },
    /** 软删队保单(不级联覆盖行,门槛查询对被删保单自然失效) [rbac: team-insurance-policy.delete.record] */
    TeamInsurancePoliciesControllerSoftDelete(id: string): Promise<ApiEnvelope<TeamInsurancePolicyResponseDto>> {
      return fetcher<TeamInsurancePolicyResponseDto>({ method: "DELETE", path: `/api/admin/v1/team-insurance-policies/${id}` });
    },
    /** 保单覆盖名单分页列表(含队员编号/姓名摘要) [rbac: team-insurance-policy.read.record] */
    TeamInsurancePoliciesControllerListCoverage(id: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": TeamInsuranceCoverageResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": TeamInsuranceCoverageResponseDto[] }>({ method: "GET", path: `/api/admin/v1/team-insurance-policies/${id}/members`, query });
    },
    /** 覆盖名单单加队员(重复 → 26004;队员须存在未软删) [rbac: team-insurance-policy.add.member] */
    TeamInsurancePoliciesControllerAddMember(id: string, body: AddTeamInsuranceCoverageDto): Promise<ApiEnvelope<TeamInsuranceCoverageResponseDto>> {
      return fetcher<TeamInsuranceCoverageResponseDto>({ method: "POST", path: `/api/admin/v1/team-insurance-policies/${id}/members`, body });
    },
    /** 全体在册一键加入覆盖名单(仅 ACTIVE 未软删队员;幂等,已在名单跳过,二跑 addedCount=0) [rbac: team-insurance-policy.add.member] */
    TeamInsurancePoliciesControllerAddAllActiveMembers(id: string): Promise<ApiEnvelope<AddAllActiveCoverageResultDto>> {
      return fetcher<AddAllActiveCoverageResultDto>({ method: "POST", path: `/api/admin/v1/team-insurance-policies/${id}/members/add-all-active` });
    },
    /** 覆盖名单移除队员(软删覆盖行;partial unique 允许重新加入;不在名单 → 26003) [rbac: team-insurance-policy.remove.member] */
    TeamInsurancePoliciesControllerRemoveMember(id: string, memberId: string): Promise<ApiEnvelope<TeamInsuranceCoverageResponseDto>> {
      return fetcher<TeamInsuranceCoverageResponseDto>({ method: "DELETE", path: `/api/admin/v1/team-insurance-policies/${id}/members/${memberId}` });
    },
    /** 入队申请分页列表(可按 cycleId / statusCode 过滤;贡献值列表不算) [rbac: team-join-application.read.record] */
    TeamJoinApplicationsAdminControllerList(query?: { "page"?: number; "pageSize"?: number; "cycleId"?: string; "statusCode"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": TeamJoinApplicationAdminDto[] }>> {
      return fetcher<PageResultDto & { "items": TeamJoinApplicationAdminDto[] }>({ method: "GET", path: "/api/admin/v1/team-join/applications", query });
    },
    /** 入队申请详情(含各 gate 实况 + 实时贡献值汇总) [rbac: team-join-application.read.record] */
    TeamJoinApplicationsAdminControllerDetail(id: string): Promise<ApiEnvelope<TeamJoinApplicationAdminDto>> {
      return fetcher<TeamJoinApplicationAdminDto>({ method: "GET", path: `/api/admin/v1/team-join/applications/${id}` });
    },
    /** 综合评估/淘汰(单一人工闸;pending_evaluation 通过→待入队·不通过→未通过;joining approved=false→门槛超期淘汰;他态或门槛未齐 approve→冲突) [rbac: team-join-application.evaluate.assessment] */
    TeamJoinApplicationsAdminControllerEvaluate(id: string, body: EvaluateTeamJoinApplicationDto): Promise<ApiEnvelope<TeamJoinApplicationAdminDto>> {
      return fetcher<TeamJoinApplicationAdminDto>({ method: "POST", path: `/api/admin/v1/team-join/applications/${id}/evaluate`, body });
    },
    /** 标 gate(8 通用 + 4 专业队;通过/未通过 + 完成日 + dept-assessment 可延长期;幂等;仅 joining/pending_evaluation 态;末次 8 通用全过 + 贡献值≥5 自动→待综合评估) [rbac: team-join-application.mark.gate] */
    TeamJoinApplicationsAdminControllerMarkGate(id: string, body: MarkGateDto): Promise<ApiEnvelope<TeamJoinApplicationAdminDto>> {
      return fetcher<TeamJoinApplicationAdminDto>({ method: "PATCH", path: `/api/admin/v1/team-join/applications/${id}/gates`, body });
    },
    /** 一键入队(志愿者→队员):approved 申请选定单一部门 → 单事务设部门 + 级别 level-1 → joined(原子/幂等;专业队需对应 gate 过;选定部门须在候选;approved 资格不随轮关闭失效) [rbac: team-join-application.join.member] */
    TeamJoinApplicationsAdminControllerJoin(id: string, body: JoinTeamJoinApplicationDto): Promise<ApiEnvelope<TeamJoinApplicationAdminDto>> {
      return fetcher<TeamJoinApplicationAdminDto>({ method: "POST", path: `/api/admin/v1/team-join/applications/${id}/join`, body });
    },
    /** 入队轮分页列表 [rbac: team-join-cycle.read.record] */
    TeamJoinCyclesControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": TeamJoinCycleResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": TeamJoinCycleResponseDto[] }>({ method: "GET", path: "/api/admin/v1/team-join/cycles", query });
    },
    /** 创建入队轮(默认 closed;可配置开放候选部门清单与候选数上限,清单 org 须 ACTIVE) [rbac: team-join-cycle.create.record] */
    TeamJoinCyclesControllerCreate(body: CreateTeamJoinCycleDto): Promise<ApiEnvelope<TeamJoinCycleResponseDto>> {
      return fetcher<TeamJoinCycleResponseDto>({ method: "POST", path: "/api/admin/v1/team-join/cycles", body });
    },
    /** 入队轮详情 [rbac: team-join-cycle.read.record] */
    TeamJoinCyclesControllerDetail(id: string): Promise<ApiEnvelope<TeamJoinCycleResponseDto>> {
      return fetcher<TeamJoinCycleResponseDto>({ method: "GET", path: `/api/admin/v1/team-join/cycles/${id}` });
    },
    /** 更新入队轮(开/关轮、轮次名、开放候选部门清单与候选数上限;开 open 轮要求当前无其它 open 轮) [rbac: team-join-cycle.update.record] */
    TeamJoinCyclesControllerUpdate(id: string, body: UpdateTeamJoinCycleDto): Promise<ApiEnvelope<TeamJoinCycleResponseDto>> {
      return fetcher<TeamJoinCycleResponseDto>({ method: "PATCH", path: `/api/admin/v1/team-join/cycles/${id}`, body });
    },
    /** 用户列表(分页;ADMIN 仅能看到 USER) [rbac: user.read.account] */
    UsersControllerList(query?: { "page"?: number; "pageSize"?: number; "q"?: string; "role"?: "SUPER_ADMIN" | "ADMIN" | "USER"; "status"?: "ACTIVE" | "DISABLED"; "memberId"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": UserResponseDto[] }>> {
      return fetcher<PageResultDto & { "items": UserResponseDto[] }>({ method: "GET", path: "/api/admin/v1/users", query });
    },
    /** 创建用户;SUPER_ADMIN 可创建 ADMIN/USER,ADMIN 只能创建 USER [rbac: user.create.account] */
    UsersControllerCreate(body: CreateUserDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "POST", path: "/api/admin/v1/users", body });
    },
    /** 用户选择器投影(q 模糊 username+nickname+email+phone;canViewUser 可见性裁剪保留) [rbac: user.read.account] */
    UsersControllerOptions(query?: { "q"?: string; "limit"?: number }): Promise<ApiEnvelope<UserOptionsResponseDto>> {
      return fetcher<UserOptionsResponseDto>({ method: "GET", path: "/api/admin/v1/users/options", query });
    },
    /** 用户详情(ADMIN 仅能查看 USER) [rbac: user.read.account] */
    UsersControllerFindOne(id: string): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "GET", path: `/api/admin/v1/users/${id}` });
    },
    /** 修改用户资料(不含 username / 密码 / 角色 / 状态) [rbac: user.update.account] */
    UsersControllerUpdate(id: string, body: UpdateUserDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "PATCH", path: `/api/admin/v1/users/${id}`, body });
    },
    /** 软删除用户(同时置 deletedAt 与 status=DISABLED) [rbac: user.delete.account] */
    UsersControllerSoftDelete(id: string): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "DELETE", path: `/api/admin/v1/users/${id}` });
    },
    /** 管理员重置用户密码(无需 oldPassword) [rbac: user.reset.password] */
    UsersControllerResetPassword(id: string, body: ResetUserPasswordDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "PUT", path: `/api/admin/v1/users/${id}/password`, body });
    },
    /** 清除用户绑定手机号(幂等;同时置空 phoneVerifiedAt;审计号码掩码) [rbac: user.phone.clear] */
    UsersControllerClearUserPhone(id: string): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "DELETE", path: `/api/admin/v1/users/${id}/phone` });
    },
    /** 修改用户角色(D1=A:仅 SUPER_ADMIN 短路;ops-admin 不绑 user.update.role) [rbac: user.update.role] */
    UsersControllerUpdateRole(id: string, body: UpdateUserRoleDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "PATCH", path: `/api/admin/v1/users/${id}/role`, body });
    },
    /** 启用/禁用用户(只改 status) [rbac: user.update.status] */
    UsersControllerUpdateStatus(id: string, body: UpdateUserStatusDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "PATCH", path: `/api/admin/v1/users/${id}/status`, body });
    },
    /** 清除用户绑定微信 openid(幂等;审计 openid 掩码) [rbac: user.wechat.clear] */
    UsersControllerClearUserWechat(id: string): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "DELETE", path: `/api/admin/v1/users/${id}/wechat` });
    },
    /** 清除用户企业微信身份(幂等;审计仅掩码) [rbac: user.wecom.clear] */
    UsersControllerClearUserWecom(id: string): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "DELETE", path: `/api/admin/v1/users/${id}/wecom` });
    },
  };
}
