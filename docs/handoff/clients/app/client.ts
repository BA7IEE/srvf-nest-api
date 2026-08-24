// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: App 小程序
// contractVersion: 0.67.0
// generatorVersion: 1.0.0
// inputDigest: sha256:2178c101d902e0be3447b176c96be5e691568c54b94c69c10d7e64c906afd4b4
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
  AccountAvatarDto,
  ActivityCheckInLocationDto,
  ActivityPublishReviewResponseDto,
  ActivityTemplateResolutionResponseDto,
  AppActivityAllocationBatchDto,
  AppActivityAllocationCandidateDto,
  AppActivityAllocationCommandReceiptDto,
  AppActivityChangePositionDto,
  AppActivityCheckInDto,
  AppActivityDetailDto,
  AppActivityDetailInvitationDto,
  AppActivityDetailSessionDto,
  AppActivityDetailSessionPositionDto,
  AppActivityDirectoryListItemDto,
  AppActivityFeedbackDto,
  AppActivityFeedbackResponseDto,
  AppActivityInitiationOrganizationOptionDto,
  AppActivityInvitationDto,
  AppActivityLifecycleResultDto,
  AppActivityPositionDto,
  AppActivityPunchDto,
  AppActivityPunchReceiptDto,
  AppActivityPunchStateDto,
  AppActivityQualificationDto,
  AppActivityQualificationRuleDto,
  AppActivityQualificationRuleInputDto,
  AppActivityQualificationRuleScopeDto,
  AppActivityQualificationRuleSetDto,
  AppActivityQualificationRuleSetInputDto,
  AppActivityQualificationRulesDto,
  AppActivityQualificationUnmetRuleDto,
  AppActivityRegistrationAnswerCommandDto,
  AppActivityRegistrationCommandDto,
  AppActivityRegistrationCommandReceiptDto,
  AppActivityRegistrationPreferenceCommandDto,
  AppActivityVisitorDto,
  AppAvailableActivityListItemDto,
  AppCapabilityAccountDto,
  AppCapabilityActivitiesDto,
  AppCapabilityAttendanceDto,
  AppCapabilityCertificatesDto,
  AppCapabilityManagedDto,
  AppCapabilityResponseDto,
  AppCapabilityTasksDto,
  AppCollaboratorOptionDto,
  AppCollaboratorOptionsResponseDto,
  AppEvidenceSealResultDto,
  AppGateStatusDto,
  AppManagedActivityCancelCommandDto,
  AppManagedActivityCheckInDto,
  AppManagedActivityCloneCommandDto,
  AppManagedActivityCloneResultDto,
  AppManagedActivityClosureDto,
  AppManagedActivityCountsDto,
  AppManagedActivityDetailDto,
  AppManagedActivityListItemDto,
  AppManagedActivityOnsiteParticipationReceiptDto,
  AppManagedActivityPositionDto,
  AppManagedActivityProjectionDto,
  AppManagedActivitySessionDto,
  AppManagedActivitySessionPositionDto,
  AppManagedActivityTerminateCommandDto,
  AppManagedAttendanceDraftAbsentDto,
  AppManagedAttendanceDraftFlagDto,
  AppManagedAttendanceDraftRecordDto,
  AppManagedAttendanceMemberDto,
  AppManagedAttendanceQrCredentialDto,
  AppManagedAttendanceRecordDto,
  AppManagedAttendanceRecordInputDto,
  AppManagedAttendanceSheetDetailDto,
  AppManagedAttendanceSheetDraftDto,
  AppManagedAttendanceSheetDto,
  AppManagedAttendanceSheetListItemDto,
  AppManagedBulkPunchJobDto,
  AppManagedBulkPunchSelectionDto,
  AppManagedImportExecuteDto,
  AppManagedImportPreviewDto,
  AppManagedImportPreviewItemDto,
  AppManagedImportPreviewItemPageDto,
  AppManagedMemberSummaryDto,
  AppManagedMyResponsibilityDto,
  AppManagedOfflineOperationDto,
  AppManagedOfflinePackageDto,
  AppManagedOfflinePackageIssueDto,
  AppManagedOfflinePackageIssueReceiptDto,
  AppManagedOfflineReviewItemDto,
  AppManagedOfflineUploadDto,
  AppManagedOnsiteBatchJobReceiptDto,
  AppManagedOnsiteLocationDto,
  AppManagedProxyPunchDto,
  AppManagedPublishReviewSummaryDto,
  AppManagedRegistrationBulkFailureDto,
  AppManagedRegistrationBulkResponseDto,
  AppManagedRegistrationDto,
  AppManagedRegistrationListItemDto,
  AppManagedRegistrationMemberDto,
  AppManagedRegistrationPositionDto,
  AppManagedResponsibilitiesDto,
  AppManagedResponsibilityAssignmentDto,
  AppManagedStaffScanDto,
  AppManagedStaffScanManualConfirmationDto,
  AppMeAccountDto,
  AppMePhoneDto,
  AppMeResponseDto,
  AppMeWechatDto,
  AppMeWecomDto,
  AppMyActivityBatchJobActivityDto,
  AppMyActivityBatchJobCreatorDto,
  AppMyActivityBatchJobDetailDto,
  AppMyActivityBatchJobItemDto,
  AppMyActivityBatchJobListItemDto,
  AppMyActivityListItemDto,
  AppMyAttendanceRecordDto,
  AppMyCertificateDto,
  AppMyInsuranceDto,
  AppMyParticipationLedgerTotalsDto,
  AppMyParticipationSummaryDto,
  AppMyRegistrationDto,
  AppMyRegistrationListItemDto,
  AppParticipationLedgerEntryDto,
  AppRegistrationFormChoiceDto,
  AppRegistrationFormDto,
  AppRegistrationFormFieldDto,
  AppRegistrationUploadAttachmentDto,
  AppRegistrationUploadSessionCreatedDto,
  AppSelfProfileDto,
  AppSettlementCloseCheckDto,
  AppSettlementCloseCommandDto,
  AppSettlementCloseGapDto,
  AppSettlementCloseResponseDto,
  AppSettlementClosureSummaryDto,
  AppSettlementGapDto,
  AppSettlementGenerateCommandDto,
  AppSettlementGenerateResponseDto,
  AppSettlementItemDto,
  AppSettlementItemMemberDto,
  AppSettlementItemSessionDto,
  AppSettlementResubmitCommandDto,
  AppSettlementRunSummaryDto,
  AppSettlementSealRevisionDto,
  AppSettlementSealSummaryDto,
  AppSettlementSubmitCommandDto,
  AppSettlementSubmitResponseDto,
  AppSettlementUpdateDraftItemDto,
  AppSettlementUpdatedDraftItemResponseDto,
  AppSettlementVersionDetailHeaderDto,
  AppSettlementVersionDetailResponseDto,
  AppSettlementVersionDiffDto,
  AppSettlementVersionPointerDto,
  AppSettlementWorkbenchResponseDto,
  AppSubmitActivityChangeReviewDto,
  AppTeamJoinApplicationDto,
  ApproveAppManagedRegistrationDto,
  BindMyPhoneDto,
  BindMyWechatDto,
  BindMyWecomDto,
  BulkReviewAppManagedRegistrationsDto,
  CancelAppManagedRegistrationDto,
  CancelAppMyRegistrationDto,
  ChangeMyPasswordDto,
  ChangeReviewDto,
  ChangeReviewQualificationRuleScopeDto,
  ChangeReviewQualificationRuleSetCancelDto,
  ChangeReviewQualificationRuleSetCollectionsDto,
  ChangeReviewQualificationRuleSetUpsertDto,
  ChangeReviewSessionCancelDto,
  ChangeReviewSessionCollectionsDto,
  ChangeReviewSessionCreateDto,
  ChangeReviewSessionPositionCancelDto,
  ChangeReviewSessionPositionCollectionsDto,
  ChangeReviewSessionPositionCreateDto,
  ChangeReviewSessionPositionUpdateDto,
  ChangeReviewSessionUpdateDto,
  CommitAppManagedActivityAllocationBatchDto,
  ContentAttachmentDto,
  ContentReadDetailDto,
  ContentReadListItemDto,
  CorrectAppManagedOnsitePunchDto,
  CreateAppManagedActivityDto,
  CreateAppManagedActivityInvitationDto,
  CreateAppManagedActivityOnsiteParticipationDto,
  CreateAppManagedActivityPositionDto,
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
  CreateAppManagedActivityVisitorDto,
  CreateAppManagedAttendanceSheetDto,
  CreateAppManagedCollaboratorDto,
  CreateAppMeInsuranceDto,
  CreateAppMyRegistrationDto,
  CreateAppTeamJoinApplicationDto,
  DeclineAppMyActivityInvitationDto,
  EarlyDepartureCloseAppManagedOnsitePunchDto,
  IssueAppManagedAttendanceQrDto,
  MarkNotificationReadResponseDto,
  NotificationReadDetailDto,
  NotificationReadListItemDto,
  NotificationUnreadCountDto,
  PageResultDto,
  PrepareAppManagedActivityAllocationBatchDto,
  PutAppManagedActivityQualificationRulesDto,
  PutAppManagedRegistrationFormDto,
  RegistrationFormChoiceInputDto,
  RegistrationFormDefinitionInputDto,
  RegistrationFormFieldInputDto,
  RejectAppManagedRegistrationDto,
  ResubmitAppManagedAttendanceSheetDto,
  RevokeAppManagedActivityInvitationDto,
  RevokeAppManagedAttendanceQrDto,
  SendMyPhoneCodeDto,
  SendMyPhoneCodeResponseDto,
  SetAppManagedActivityCoverDto,
  SetAppManagedActivityGalleryDto,
  SubmitActivityPublishReviewDto,
  TransferAppManagedActivityInitiatorDto,
  TransferAppManagedActivityOwnerDto,
  UpdateAppManagedActivityDto,
  UpdateAppManagedActivityPositionDto,
  UpdateAppManagedActivitySessionDto,
  UpdateAppManagedActivitySessionPositionDto,
  UpdateAppManagedAttendanceSheetDto,
  UpdateAppMeInsuranceDto,
  UpdateAppSelfProfileDto,
  UpdateAppTeamJoinTargetsDto,
  UpsertActivityFeedbackDto,
  UserLinkedMemberDto,
  UserResponseDto,
  VoidAppManagedActivityAllocationBatchDto,
  WechatQuotaItemDto,
  WechatSubscriptionAckDto,
  WechatSubscriptionAckResponseDto,
  WechatSubscriptionStatusResponseDto,
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createAppClient(fetcher: Fetcher) {
  return {
    /** App 队员内部活动目录(仅 published；invitation 仅本人受邀可见) [auth] */
    AppActivitiesControllerListDirectory(query?: { "page"?: number; "pageSize"?: number; "q"?: string; "type"?: string; "date"?: string; "organization"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppActivityDirectoryListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppActivityDirectoryListItemDto[] }>({ method: "GET", path: "/api/app/v1/activities", query });
    },
    /** App 视角可参加活动列表(分页;仅 published + 公开报名 + 未结束 + 未软删) [auth] */
    AppActivitiesControllerListAvailable(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppAvailableActivityListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppAvailableActivityListItemDto[] }>({ method: "GET", path: "/api/app/v1/activities/available", query });
    },
    /** App 视角公开报名活动岗位列表(含余量与当前队员是否可报) [auth] */
    AppActivitiesControllerListPositions(activityId: string): Promise<ApiEnvelope<AppActivityPositionDto[]>> {
      return fetcher<AppActivityPositionDto[]>({ method: "GET", path: `/api/app/v1/activities/${activityId}/positions` });
    },
    /** App 创建一次性报名附件上传会话；原始 token 仅本次返回，不签发 Provider upload URL [auth] */
    AppRegistrationUploadSessionsControllerCreate(activityId: string): Promise<ApiEnvelope<AppRegistrationUploadSessionCreatedDto>> {
      return fetcher<AppRegistrationUploadSessionCreatedDto>({ method: "POST", path: `/api/app/v1/activities/${activityId}/registration-upload-sessions` });
    },
    /** App 后端中转上传一次性报名附件；token/session/route/member/form/expiry 不匹配统一 13001 [auth] */
    AppRegistrationUploadSessionsControllerUpload(activityId: string, sessionId: string): Promise<ApiEnvelope<AppRegistrationUploadAttachmentDto>> {
      return fetcher<AppRegistrationUploadAttachmentDto>({ method: "POST", path: `/api/app/v1/activities/${activityId}/registration-upload-sessions/${sessionId}/files` });
    },
    /** 本人提交或审批前重提报名主链；请求含 operationKey、冻结表单答案与有序场次岗位志愿 [auth] */
    AppActivityRegistrationsControllerSubmit(activityId: string, body: AppActivityRegistrationCommandDto): Promise<ApiEnvelope<AppActivityRegistrationCommandReceiptDto>> {
      return fetcher<AppActivityRegistrationCommandReceiptDto>({ method: "POST", path: `/api/app/v1/activities/${activityId}/registrations`, body });
    },
    /** 读取本人当前服务段的安全打卡状态 [auth] */
    AppActivityPunchesControllerState(activityId: string, sessionId: string): Promise<ApiEnvelope<AppActivityPunchStateDto>> {
      return fetcher<AppActivityPunchStateDto>({ method: "GET", path: `/api/app/v1/activities/${activityId}/sessions/${sessionId}/my-punch-state` });
    },
    /** 本人扫描场次签到二维码并追加正式签到事实 [auth] */
    AppActivityPunchesControllerCheckIn(activityId: string, sessionId: string, body: AppActivityPunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/activities/${activityId}/sessions/${sessionId}/punches/check-in`, body });
    },
    /** 本人扫描场次签退二维码并追加正式签退事实 [auth] */
    AppActivityPunchesControllerCheckOut(activityId: string, sessionId: string, body: AppActivityPunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/activities/${activityId}/sessions/${sessionId}/punches/check-out`, body });
    },
    /** App 视角活动详情(仅 published；invitation 仅本人受邀；draft / cancelled / terminated / completed / 软删 / 不存在统一 → 404) [auth] */
    AppActivitiesControllerFindOne(id: string): Promise<ApiEnvelope<AppActivityDetailDto>> {
      return fetcher<AppActivityDetailDto>({ method: "GET", path: `/api/app/v1/activities/${id}` });
    },
    /** 会员内容列表(准入 canUseApp;按 5 档可见性过滤;keyword/tags/contentTypeCode;无 body) [auth] */
    ContentAppControllerList(query?: { "page"?: number; "pageSize"?: number; "contentTypeCode"?: string; "keyword"?: string; "tags"?: string[] }): Promise<ApiEnvelope<PageResultDto & { "items": ContentReadListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": ContentReadListItemDto[] }>({ method: "GET", path: "/api/app/v1/contents", query });
    },
    /** 会员内容详情(准入 canUseApp;可见级不通过 → 404 防枚举;正文占位改写 + 附件签名 + viewCount 自增) [auth] */
    ContentAppControllerDetail(id: string): Promise<ApiEnvelope<ContentReadDetailDto>> {
      return fetcher<ContentReadDetailDto>({ method: "GET", path: `/api/app/v1/contents/${id}` });
    },
    /** App 视角本人 user + member 摘要(含 canUseApp 标志) [auth] */
    AppMeControllerGetMe(): Promise<ApiEnvelope<AppMeResponseDto>> {
      return fetcher<AppMeResponseDto>({ method: "GET", path: "/api/app/v1/me" });
    },
    /** App 视角本人账号信息(username / status / lastLoginAt / canUseApp) [auth] */
    AppMeControllerGetMeAccount(): Promise<ApiEnvelope<AppMeAccountDto>> {
      return fetcher<AppMeAccountDto>({ method: "GET", path: "/api/app/v1/me/account" });
    },
    /** App 视角读本人账号头像(短 TTL 签名 URL;无头像返 null) [auth] */
    AppMeControllerGetMyAvatar(): Promise<ApiEnvelope<AccountAvatarDto>> {
      return fetcher<AccountAvatarDto>({ method: "GET", path: "/api/app/v1/me/avatar" });
    },
    /** App 视角上传 / 替换本人账号头像(multipart;服务端规范化并清除 EXIF/GPS) [auth] */
    AppMeControllerUploadMyAvatar(): Promise<ApiEnvelope<AccountAvatarDto>> {
      return fetcher<AccountAvatarDto>({ method: "POST", path: "/api/app/v1/me/avatar" });
    },
    /** App 视角清空本人账号头像(重复清空幂等) [auth] */
    AppMeControllerClearMyAvatar(): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "DELETE", path: "/api/app/v1/me/avatar" });
    },
    /** App 视角本人 capability map(product-level;非 raw RBAC code) [auth] */
    AppMeControllerGetMeCapabilities(): Promise<ApiEnvelope<AppCapabilityResponseDto>> {
      return fetcher<AppCapabilityResponseDto>({ method: "GET", path: "/api/app/v1/me/capabilities" });
    },
    /** 我的自购保险分页列表(仅本人;软删不可见;createdAt desc) [auth] */
    AppMeInsurancesControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyInsuranceDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyInsuranceDto[] }>({ method: "GET", path: "/api/app/v1/me/insurances", query });
    },
    /** 新增自购保险(自报即可,无核验;保险公司/保单号/到期必填,起保可选;起保 ≤ 到期否则 26010) [auth] */
    AppMeInsurancesControllerCreate(body: CreateAppMeInsuranceDto): Promise<ApiEnvelope<AppMyInsuranceDto>> {
      return fetcher<AppMyInsuranceDto>({ method: "POST", path: "/api/app/v1/me/insurances", body });
    },
    /** 部分更新自购保险(expectedVersion 必填;旧版本 26011;实质变更重置审核为 pending;等值为空操作) [auth] */
    AppMeInsurancesControllerUpdate(id: string, body: UpdateAppMeInsuranceDto): Promise<ApiEnvelope<AppMyInsuranceDto>> {
      return fetcher<AppMyInsuranceDto>({ method: "PATCH", path: `/api/app/v1/me/insurances/${id}`, body });
    },
    /** 删除自购保险(软删;expectedVersion query 必填;旧版本 26011;保留原审核结论) [auth] */
    AppMeInsurancesControllerSoftDelete(id: string, query: { "expectedVersion": number }): Promise<ApiEnvelope<AppMyInsuranceDto>> {
      return fetcher<AppMyInsuranceDto>({ method: "DELETE", path: `/api/app/v1/me/insurances/${id}`, query });
    },
    /** App 视角本人自助改密(需 oldPassword;不主动吊销 access token;撤销全部 refresh) [auth] */
    AppMeControllerChangeMyPassword(body: ChangeMyPasswordDto): Promise<ApiEnvelope<UserResponseDto>> {
      return fetcher<UserResponseDto>({ method: "PUT", path: "/api/app/v1/me/password", body });
    },
    /** App 验码绑定 / 换绑手机号(需 PHONE_BIND step-up proof;真实变更撤销全部 refresh) [auth] */
    AppMeControllerBindMyPhone(body: BindMyPhoneDto): Promise<ApiEnvelope<AppMePhoneDto>> {
      return fetcher<AppMePhoneDto>({ method: "PUT", path: "/api/app/v1/me/phone", body });
    },
    /** App 发送手机号绑定验证码(目标号已被任何账号绑定则拒;同号限频;响应永不含验证码) [auth] */
    AppMeControllerSendMyPhoneCode(body: SendMyPhoneCodeDto): Promise<ApiEnvelope<SendMyPhoneCodeResponseDto>> {
      return fetcher<SendMyPhoneCodeResponseDto>({ method: "POST", path: "/api/app/v1/me/phone/send-code", body });
    },
    /** App 视角本人 profile(User + Member 基础摘要 + hasMemberProfile 派生;canUseApp=true 必要) [auth] */
    AppMeControllerGetMyProfile(): Promise<ApiEnvelope<AppSelfProfileDto>> {
      return fetcher<AppSelfProfileDto>({ method: "GET", path: "/api/app/v1/me/profile" });
    },
    /** App 视角本人改 profile(严格白名单:仅 nickname) [auth] */
    AppMeControllerUpdateMyProfile(body: UpdateAppSelfProfileDto): Promise<ApiEnvelope<AppSelfProfileDto>> {
      return fetcher<AppSelfProfileDto>({ method: "PATCH", path: "/api/app/v1/me/profile", body });
    },
    /** 发起入队申请(候选须属于本轮开放清单且不超过轮上限;需有 open 入队轮 + 本人未入队;同轮防重) [auth] */
    TeamJoinApplicationsAppControllerSubmit(body: CreateAppTeamJoinApplicationDto): Promise<ApiEnvelope<AppTeamJoinApplicationDto>> {
      return fetcher<AppTeamJoinApplicationDto>({ method: "POST", path: "/api/app/v1/me/team-join/applications", body });
    },
    /** 查本人当前入队进度(状态 / 各 gate 实况 / 实时贡献值 / 候选部门;无申请→404) [auth] */
    TeamJoinApplicationsAppControllerCurrent(): Promise<ApiEnvelope<AppTeamJoinApplicationDto>> {
      return fetcher<AppTeamJoinApplicationDto>({ method: "GET", path: "/api/app/v1/me/team-join/applications/current" });
    },
    /** 改候选目标部门(仅本人 + joining 态;每个 org 须存在+ACTIVE、属于本轮开放清单且不超过轮上限) [auth] */
    TeamJoinApplicationsAppControllerUpdateTargets(id: string, body: UpdateAppTeamJoinTargetsDto): Promise<ApiEnvelope<AppTeamJoinApplicationDto>> {
      return fetcher<AppTeamJoinApplicationDto>({ method: "PATCH", path: `/api/app/v1/me/team-join/applications/${id}/targets`, body });
    },
    /** App 查询本人微信绑定状态(openid 一律掩码回显) [auth] */
    AppMeControllerGetMyWechat(): Promise<ApiEnvelope<AppMeWechatDto>> {
      return fetcher<AppMeWechatDto>({ method: "GET", path: "/api/app/v1/me/wechat" });
    },
    /** App 绑定 / 换绑本人微信(需 WECHAT_BIND step-up proof;真实变更撤销全部 refresh) [auth] */
    AppMeControllerBindMyWechat(body: BindMyWechatDto): Promise<ApiEnvelope<AppMeWechatDto>> {
      return fetcher<AppMeWechatDto>({ method: "PUT", path: "/api/app/v1/me/wechat", body });
    },
    /** App 查询本人企业微信绑定状态(wecomUserId 一律掩码回显) [auth] */
    AppMeControllerGetMyWecom(): Promise<ApiEnvelope<AppMeWecomDto>> {
      return fetcher<AppMeWecomDto>({ method: "GET", path: "/api/app/v1/me/wecom" });
    },
    /** App 绑定 / 换绑本人企业微信(需 WECOM_BIND step-up proof;真实变更撤销全部 refresh) [auth] */
    AppMeControllerBindMyWecom(body: BindMyWecomDto): Promise<ApiEnvelope<AppMeWecomDto>> {
      return fetcher<AppMeWecomDto>({ method: "PUT", path: "/api/app/v1/me/wecom", body });
    },
    /** 我已建立 registration 关系的活动汇总(分页 + 可选 registrationStatusCode 过滤;每活动一行,含本人最新有效 registration 摘要) [auth] */
    AppMyRegistrationsControllerListMyActivities(query?: { "page"?: number; "pageSize"?: number; "registrationStatusCode"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyActivityListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyActivityListItemDto[] }>({ method: "GET", path: "/api/app/v1/my/activities", query });
    },
    /** 读取本人当前审核通过报名的打卡状态 [auth] */
    AppActivityCheckInsControllerGetCurrent(activityId: string): Promise<ApiEnvelope<AppActivityCheckInDto>> {
      return fetcher<AppActivityCheckInDto>({ method: "GET", path: `/api/app/v1/my/activities/${activityId}/check-in` });
    },
    /** 本人 GPS 签到（首次与合法重试均返回当前证据） [auth] */
    AppActivityCheckInsControllerCheckIn(activityId: string, body: ActivityCheckInLocationDto): Promise<ApiEnvelope<AppActivityCheckInDto>> {
      return fetcher<AppActivityCheckInDto>({ method: "POST", path: `/api/app/v1/my/activities/${activityId}/check-in`, body });
    },
    /** 本人 GPS 签退（首次与合法重试均返回当前证据） [auth] */
    AppActivityCheckInsControllerCheckOut(activityId: string, body: ActivityCheckInLocationDto): Promise<ApiEnvelope<AppActivityCheckInDto>> {
      return fetcher<AppActivityCheckInDto>({ method: "POST", path: `/api/app/v1/my/activities/${activityId}/check-out`, body });
    },
    /** 读取本人活动评价与当前提交按钮态 [auth] */
    AppActivityFeedbacksControllerGetMine(activityId: string): Promise<ApiEnvelope<AppActivityFeedbackResponseDto>> {
      return fetcher<AppActivityFeedbackResponseDto>({ method: "GET", path: `/api/app/v1/my/activities/${activityId}/feedback` });
    },
    /** 窗口内创建或更新本人活动评价 [auth] */
    AppActivityFeedbacksControllerUpsertMine(activityId: string, body: UpsertActivityFeedbackDto): Promise<ApiEnvelope<AppActivityFeedbackResponseDto>> {
      return fetcher<AppActivityFeedbackResponseDto>({ method: "PUT", path: `/api/app/v1/my/activities/${activityId}/feedback`, body });
    },
    /** App 分页查看当前责任范围内的后台批任务 [auth] */
    AppMyActivityBatchJobsControllerList(query?: { "page"?: number; "pageSize"?: number; "activityId"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyActivityBatchJobListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyActivityBatchJobListItemDto[] }>({ method: "GET", path: "/api/app/v1/my/activity-batch-jobs", query });
    },
    /** App 查看单个后台批任务详情 [auth] */
    AppMyActivityBatchJobsControllerDetail(jobId: string): Promise<ApiEnvelope<AppMyActivityBatchJobDetailDto>> {
      return fetcher<AppMyActivityBatchJobDetailDto>({ method: "GET", path: `/api/app/v1/my/activity-batch-jobs/${jobId}` });
    },
    /** App 取消后台批任务(重新判权;已完成不可取消) [auth] */
    AppMyActivityBatchJobsControllerCancel(jobId: string): Promise<ApiEnvelope<AppMyActivityBatchJobDetailDto>> {
      return fetcher<AppMyActivityBatchJobDetailDto>({ method: "POST", path: `/api/app/v1/my/activity-batch-jobs/${jobId}/cancel` });
    },
    /** App 分页查看后台批任务逐项(失败项即 status=failed) [auth] */
    AppMyActivityBatchJobsControllerListItems(jobId: string, query?: { "page"?: number; "pageSize"?: number; "status"?: "pending" | "succeeded" | "failed" | "skipped" }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyActivityBatchJobItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyActivityBatchJobItemDto[] }>({ method: "GET", path: `/api/app/v1/my/activity-batch-jobs/${jobId}/items`, query });
    },
    /** App 重试后台批任务的失败项(重新判权) [auth] */
    AppMyActivityBatchJobsControllerRetryFailed(jobId: string): Promise<ApiEnvelope<AppMyActivityBatchJobDetailDto>> {
      return fetcher<AppMyActivityBatchJobDetailDto>({ method: "POST", path: `/api/app/v1/my/activity-batch-jobs/${jobId}/retry-failed` });
    },
    /** App 队员接受自己的未过期 pending 邀请并提交 canonical 报名 [auth] */
    AppMyActivityInvitationsControllerAccept(invitationId: string, body: AppActivityRegistrationCommandDto): Promise<ApiEnvelope<AppActivityRegistrationCommandReceiptDto>> {
      return fetcher<AppActivityRegistrationCommandReceiptDto>({ method: "POST", path: `/api/app/v1/my/activity-invitations/${invitationId}/accept`, body });
    },
    /** App 队员拒绝自己的未过期 pending 邀请 [auth] */
    AppMyActivityInvitationsControllerDecline(invitationId: string, body: DeclineAppMyActivityInvitationDto): Promise<ApiEnvelope<AppActivityInvitationDto>> {
      return fetcher<AppActivityInvitationDto>({ method: "POST", path: `/api/app/v1/my/activity-invitations/${invitationId}/decline`, body });
    },
    /** 生成本人短时可信成员凭证 SVG；不返回 JSON token [auth] */
    AppMyAttendanceMemberCredentialControllerRender(): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "POST", path: "/api/app/v1/my/attendance-member-credential/render" });
    },
    /** 我的考勤记录列表(仅 approved Sheet 内 records;分页 + 可选 activityId 过滤;含 activity 派生字段) [auth] */
    AppMyAttendanceRecordsControllerListMyAttendanceRecords(query?: { "page"?: number; "pageSize"?: number; "activityId"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyAttendanceRecordDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyAttendanceRecordDto[] }>({ method: "GET", path: "/api/app/v1/my/attendance-records", query });
    },
    /** 我的证书列表(本人 pending / verified / expired / rejected 全部可见;分页 + 可选 certStatusCode / certTypeCode 过滤) [auth] */
    AppMyCertificatesControllerListMyCertificates(query?: { "page"?: number; "pageSize"?: number; "certStatusCode"?: "pending" | "verified" | "expired" | "rejected"; "certCategoryCode"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyCertificateDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyCertificateDto[] }>({ method: "GET", path: "/api/app/v1/my/certificates", query });
    },
    /** App 我发起或承担责任的活动分页 [auth] */
    AppManagedActivitiesControllerList(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: "draft" | "published" | "cancelled" | "completed" }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedActivityListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedActivityListItemDto[] }>({ method: "GET", path: "/api/app/v1/my/managed-activities", query });
    },
    /** App 正式队员创建本人作为发起人的活动草稿 [auth] */
    AppManagedActivitiesControllerCreate(body: CreateAppManagedActivityDto): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "POST", path: "/api/app/v1/my/managed-activities", body });
    },
    /** App 获取当前队员可发起活动的组织 options [auth] */
    AppManagedActivitiesControllerOrganizationOptions(): Promise<ApiEnvelope<AppActivityInitiationOrganizationOptionDto[]>> {
      return fetcher<AppActivityInitiationOrganizationOptionDto[]>({ method: "GET", path: "/api/app/v1/my/managed-activities/organization-options" });
    },
    /** App 我管理的活动详情、责任、审核与待办摘要 [auth] */
    AppManagedActivitiesControllerDetail(activityId: string): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}` });
    },
    /** App 发起人修改 draft 活动 [auth] */
    AppManagedActivitiesControllerUpdate(activityId: string, body: UpdateAppManagedActivityDto): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}`, body });
    },
    /** App 发起人删除无参与数据的 draft 活动 [auth] */
    AppManagedActivitiesControllerSoftDelete(activityId: string): Promise<ApiEnvelope<AppManagedActivityProjectionDto>> {
      return fetcher<AppManagedActivityProjectionDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}` });
    },
    /** 负责人冻结资格排序或抽签候选批次 [auth] */
    AppManagedActivityAllocationBatchesControllerPrepare(activityId: string, body: PrepareAppManagedActivityAllocationBatchDto): Promise<ApiEnvelope<AppActivityAllocationCommandReceiptDto>> {
      return fetcher<AppActivityAllocationCommandReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/allocation-batches`, body });
    },
    /** 负责人读取安全的分配批次与结果 [auth] */
    AppManagedActivityAllocationBatchesControllerGet(activityId: string, batchId: string): Promise<ApiEnvelope<AppActivityAllocationBatchDto>> {
      return fetcher<AppActivityAllocationBatchDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/allocation-batches/${batchId}` });
    },
    /** 负责人提交已冻结的资格排序或抽签批次 [auth] */
    AppManagedActivityAllocationBatchesControllerCommit(activityId: string, batchId: string, body: CommitAppManagedActivityAllocationBatchDto): Promise<ApiEnvelope<AppActivityAllocationCommandReceiptDto>> {
      return fetcher<AppActivityAllocationCommandReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/allocation-batches/${batchId}/commit`, body });
    },
    /** 负责人作废已冻结或未漂移的已提交批次 [auth] */
    AppManagedActivityAllocationBatchesControllerVoid(activityId: string, batchId: string, body: VoidAppManagedActivityAllocationBatchDto): Promise<ApiEnvelope<AppActivityAllocationCommandReceiptDto>> {
      return fetcher<AppActivityAllocationCommandReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/allocation-batches/${batchId}/void`, body });
    },
    /** App 活动考勤责任人生成考勤提交草稿（只读不落库） [auth] */
    AppManagedActivityAttendancesControllerDraft(activityId: string): Promise<ApiEnvelope<AppManagedAttendanceSheetDraftDto>> {
      return fetcher<AppManagedAttendanceSheetDraftDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheet-draft` });
    },
    /** App 活动考勤责任人查看考勤单列表 [auth] */
    AppManagedActivityAttendancesControllerListSheets(activityId: string, query?: { "page"?: number; "pageSize"?: number; "statusCode"?: "pending" | "pending_final_review" | "returned" | "approved" | "rejected" | "final_rejected" }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedAttendanceSheetListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedAttendanceSheetListItemDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`, query });
    },
    /** App 活动考勤责任人提交考勤单 [auth] */
    AppManagedActivityAttendancesControllerSubmit(activityId: string, body: CreateAppManagedAttendanceSheetDto): Promise<ApiEnvelope<AppManagedAttendanceSheetDto>> {
      return fetcher<AppManagedAttendanceSheetDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`, body });
    },
    /** App 活动考勤责任人查看考勤单与 records 详情 [auth] */
    AppManagedActivityAttendancesControllerDetail(activityId: string, sheetId: string): Promise<ApiEnvelope<AppManagedAttendanceSheetDetailDto>> {
      return fetcher<AppManagedAttendanceSheetDetailDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}` });
    },
    /** App 活动考勤责任人编辑 pending 或 returned 考勤单(活动已取消拒绝改 records) [auth] */
    AppManagedActivityAttendancesControllerEdit(activityId: string, sheetId: string, body: UpdateAppManagedAttendanceSheetDto): Promise<ApiEnvelope<AppManagedAttendanceSheetDto>> {
      return fetcher<AppManagedAttendanceSheetDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`, body });
    },
    /** App 活动考勤责任人软删 pending 考勤单 [auth] */
    AppManagedActivityAttendancesControllerSoftDelete(activityId: string, sheetId: string): Promise<ApiEnvelope<AppManagedAttendanceSheetDto>> {
      return fetcher<AppManagedAttendanceSheetDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}` });
    },
    /** App 活动考勤责任人重提 returned 考勤单 [auth] */
    AppManagedActivityAttendancesControllerResubmit(activityId: string, sheetId: string, body: ResubmitAppManagedAttendanceSheetDto): Promise<ApiEnvelope<AppManagedAttendanceSheetDto>> {
      return fetcher<AppManagedAttendanceSheetDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}/resubmit`, body });
    },
    /** App 发起人/负责人在首场开始前取消活动 [auth] */
    AppManagedActivitiesControllerCancel(activityId: string, body: AppManagedActivityCancelCommandDto): Promise<ApiEnvelope<AppActivityLifecycleResultDto>> {
      return fetcher<AppActivityLifecycleResultDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/cancel`, body });
    },
    /** App 提交已发布活动的完整场次/岗位变更审核 proposal [auth] */
    AppManagedActivitiesControllerCreateChangeReview(activityId: string, body: ChangeReviewDto): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/change-reviews`, body });
    },
    /** App 活动考勤责任人分页查看 GPS 打卡证据 [auth] */
    AppManagedActivityAttendancesControllerListCheckIns(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedActivityCheckInDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedActivityCheckInDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/check-ins`, query });
    },
    /** App 发起人/负责人仅复制活动配置为新 draft [auth] */
    AppManagedActivitiesControllerClone(activityId: string, body: AppManagedActivityCloneCommandDto): Promise<ApiEnvelope<AppManagedActivityCloneResultDto>> {
      return fetcher<AppManagedActivityCloneResultDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/clone`, body });
    },
    /** App 获取本活动可选协办人（到场者或活动组织有效成员；q 模糊 + page/pageSize 分页） [auth] */
    AppManagedActivityResponsibilitiesControllerCollaboratorOptions(activityId: string, query?: { "q"?: string; "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<AppCollaboratorOptionsResponseDto>> {
      return fetcher<AppCollaboratorOptionsResponseDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/collaborator-options`, query });
    },
    /** App 活动负责人新增协办人 [auth] */
    AppManagedActivityResponsibilitiesControllerAddCollaborator(activityId: string, body: CreateAppManagedCollaboratorDto): Promise<ApiEnvelope<AppManagedResponsibilityAssignmentDto>> {
      return fetcher<AppManagedResponsibilityAssignmentDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/collaborators`, body });
    },
    /** App 活动负责人结束协办职责 [auth] */
    AppManagedActivityResponsibilitiesControllerEndCollaborator(activityId: string, assignmentId: string): Promise<ApiEnvelope<AppManagedResponsibilityAssignmentDto>> {
      return fetcher<AppManagedResponsibilityAssignmentDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}/collaborators/${assignmentId}` });
    },
    /** App 设 / 清本人 managed 活动封面(attachmentId 须为本活动附件;null 清空) [auth] */
    AppManagedActivitiesControllerSetCover(activityId: string, body: SetAppManagedActivityCoverDto): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "PUT", path: `/api/app/v1/my/managed-activities/${activityId}/cover`, body });
    },
    /** App 主负责人声明活动考勤已全部提交 [auth] */
    AppManagedActivitiesControllerDeclareAttendanceComplete(activityId: string): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/declare-attendance-complete` });
    },
    /** App 发起人在持有效发布审核 grant 时直接发布 [auth] */
    AppManagedActivitiesControllerDirectPublish(activityId: string): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/direct-publish` });
    },
    /** App 负责人执行机器证据封场；缺口与 seal 结果沿既有服务透传 [auth] */
    AppManagedActivitiesControllerEvidenceSeal(activityId: string): Promise<ApiEnvelope<AppEvidenceSealResultDto>> {
      return fetcher<AppEvidenceSealResultDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/evidence-seals` });
    },
    /** App 设 / 清本人 managed 活动图集(每个 id 须为本活动附件;[] 清空) [auth] */
    AppManagedActivitiesControllerSetGallery(activityId: string, body: SetAppManagedActivityGalleryDto): Promise<ApiEnvelope<AppManagedActivityDetailDto>> {
      return fetcher<AppManagedActivityDetailDto>({ method: "PUT", path: `/api/app/v1/my/managed-activities/${activityId}/gallery`, body });
    },
    /** App 活动负责人或报名协办查看邀请列表 [auth] */
    AppManagedActivityGuestsControllerListInvitations(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppActivityInvitationDto[] }>> {
      return fetcher<PageResultDto & { "items": AppActivityInvitationDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/invitations`, query });
    },
    /** App 活动负责人或报名协办创建定向邀请 [auth] */
    AppManagedActivityGuestsControllerCreateInvitation(activityId: string, body: CreateAppManagedActivityInvitationDto): Promise<ApiEnvelope<AppActivityInvitationDto>> {
      return fetcher<AppActivityInvitationDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/invitations`, body });
    },
    /** App 活动负责人或报名协办撤回未过期的 pending 邀请 [auth] */
    AppManagedActivityGuestsControllerRevokeInvitation(activityId: string, invitationId: string, body: RevokeAppManagedActivityInvitationDto): Promise<ApiEnvelope<AppActivityInvitationDto>> {
      return fetcher<AppActivityInvitationDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/invitations/${invitationId}/revoke`, body });
    },
    /** App 活动负责人现场临时补录参加并占用容量 [auth] */
    AppManagedActivityOnsiteParticipationsControllerCreate(activityId: string, body: CreateAppManagedActivityOnsiteParticipationDto): Promise<ApiEnvelope<AppManagedActivityOnsiteParticipationReceiptDto>> {
      return fetcher<AppManagedActivityOnsiteParticipationReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite-participations`, body });
    },
    /** 读取负责人可见的现场批量代签任务安全进度 [auth] */
    AppManagedActivityOnsiteOperationsControllerGetBulkPunchJob(activityId: string, jobId: string): Promise<ApiEnvelope<AppManagedOnsiteBatchJobReceiptDto>> {
      return fetcher<AppManagedOnsiteBatchJobReceiptDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/bulk-punch-jobs/${jobId}` });
    },
    /** 读取负责人可见的 CSV 导入预览安全摘要与分页行状态 [auth] */
    AppManagedActivityOnsiteOperationsControllerGetImportPreview(activityId: string, previewId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<AppManagedImportPreviewDto>> {
      return fetcher<AppManagedImportPreviewDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/import-previews/${previewId}`, query });
    },
    /** 考勤责任人按已冻结摘要排队执行 CSV 现场导入 [auth] */
    AppManagedActivityOnsiteOperationsControllerExecuteImportPreview(activityId: string, previewId: string, body: AppManagedImportExecuteDto): Promise<ApiEnvelope<AppManagedOnsiteBatchJobReceiptDto>> {
      return fetcher<AppManagedOnsiteBatchJobReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/import-previews/${previewId}/execute`, body });
    },
    /** 以防重键撤销仍可使用或待复核的离线考勤包 [auth] */
    AppManagedActivityOnsiteOperationsControllerRevokeOfflinePackage(activityId: string, packageId: string, body: AppManagedOfflineOperationDto): Promise<ApiEnvelope<AppManagedOfflinePackageDto>> {
      return fetcher<AppManagedOfflinePackageDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-packages/${packageId}/revoke`, body });
    },
    /** 验证并追加单条离线现场事件，异常只进入安全复核链 [auth] */
    AppManagedActivityOnsiteOperationsControllerUploadOfflineEvent(activityId: string, packageId: string, body: AppManagedOfflineUploadDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-packages/${packageId}/upload`, body });
    },
    /** 分页读取不含凭证、签名、hash 与坐标的离线复核摘要 [auth] */
    AppManagedActivityOnsiteOperationsControllerListOfflineReviewItems(activityId: string, query?: { "page"?: number; "pageSize"?: number; "sessionId"?: string; "statusCode"?: "pending" | "approved" | "rejected" }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedOfflineReviewItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedOfflineReviewItemDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-review-items`, query });
    },
    /** 原子批准可批准的离线异常并复用唯一 Punch writer [auth] */
    AppManagedActivityOnsiteOperationsControllerApproveOfflineReviewItem(activityId: string, reviewItemId: string, body: AppManagedOfflineOperationDto): Promise<ApiEnvelope<AppManagedOfflineReviewItemDto>> {
      return fetcher<AppManagedOfflineReviewItemDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-review-items/${reviewItemId}/approve`, body });
    },
    /** 拒绝离线异常且不创建 PunchEvent，并收束包状态 [auth] */
    AppManagedActivityOnsiteOperationsControllerRejectOfflineReviewItem(activityId: string, reviewItemId: string, body: AppManagedOfflineOperationDto): Promise<ApiEnvelope<AppManagedOfflineReviewItemDto>> {
      return fetcher<AppManagedOfflineReviewItemDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-review-items/${reviewItemId}/reject`, body });
    },
    /** 考勤责任人追加替代事实，不覆盖原现场事件 [auth] */
    AppManagedActivityOnsitePunchesControllerReplaceEvent(activityId: string, eventId: string, body: CorrectAppManagedOnsitePunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/punch-events/${eventId}/replace`, body });
    },
    /** 考勤责任人追加作废事实，不覆盖原现场事件 [auth] */
    AppManagedActivityOnsitePunchesControllerVoidEvent(activityId: string, eventId: string, body: CorrectAppManagedOnsitePunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/punch-events/${eventId}/void`, body });
    },
    /** 考勤责任人创建可重放的现场批量代签任务（id 列表或 selection 选择条件，二选一） [auth] */
    AppManagedActivityOnsiteOperationsControllerCreateBulkPunchJob(activityId: string, sessionId: string, body: AppManagedBulkPunchJobDto): Promise<ApiEnvelope<AppManagedOnsiteBatchJobReceiptDto>> {
      return fetcher<AppManagedOnsiteBatchJobReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/bulk-punch-jobs`, body });
    },
    /** 考勤责任人特殊提前离场闭合；固定零时长零分 [auth] */
    AppManagedActivityOnsitePunchesControllerEarlyClose(activityId: string, sessionId: string, body: EarlyDepartureCloseAppManagedOnsitePunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/early-departure-close`, body });
    },
    /** 考勤责任人上传并冻结 CSV 现场导入预览 [auth] */
    AppManagedActivityOnsiteOperationsControllerCreateImportPreview(activityId: string, sessionId: string): Promise<ApiEnvelope<AppManagedOnsiteBatchJobReceiptDto>> {
      return fetcher<AppManagedOnsiteBatchJobReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/import-previews` });
    },
    /** 签发冻结名单与规则的现场离线考勤包 [auth] */
    AppManagedActivityOnsiteOperationsControllerIssueOfflinePackage(activityId: string, sessionId: string, body: AppManagedOfflinePackageIssueDto): Promise<ApiEnvelope<AppManagedOfflinePackageIssueReceiptDto>> {
      return fetcher<AppManagedOfflinePackageIssueReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/offline-packages`, body });
    },
    /** 考勤责任人以明确原因代为追加单人现场签到/签退事实 [auth] */
    AppManagedActivityOnsiteOperationsControllerProxyPunch(activityId: string, sessionId: string, body: AppManagedProxyPunchDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/proxy-punch`, body });
    },
    /** 考勤责任人以受控人工确认追加工作人员现场签到/签退事实 [auth] */
    AppManagedActivityOnsiteOperationsControllerStaffScan(activityId: string, sessionId: string, body: AppManagedStaffScanDto): Promise<ApiEnvelope<AppActivityPunchReceiptDto>> {
      return fetcher<AppActivityPunchReceiptDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/staff-scan`, body });
    },
    /** App 查看我管理活动的岗位 [auth] */
    AppManagedActivityPositionsControllerList(activityId: string): Promise<ApiEnvelope<AppManagedActivityPositionDto[]>> {
      return fetcher<AppManagedActivityPositionDto[]>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/positions` });
    },
    /** App 发起人为 draft 活动新增岗位 [auth] */
    AppManagedActivityPositionsControllerCreate(activityId: string, body: CreateAppManagedActivityPositionDto): Promise<ApiEnvelope<AppManagedActivityPositionDto>> {
      return fetcher<AppManagedActivityPositionDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/positions`, body });
    },
    /** App 发起人修改 draft 活动岗位 [auth] */
    AppManagedActivityPositionsControllerUpdate(activityId: string, activityPositionId: string, body: UpdateAppManagedActivityPositionDto): Promise<ApiEnvelope<AppManagedActivityPositionDto>> {
      return fetcher<AppManagedActivityPositionDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/positions/${activityPositionId}`, body });
    },
    /** App 发起人删除 draft 活动岗位 [auth] */
    AppManagedActivityPositionsControllerSoftDelete(activityId: string, activityPositionId: string): Promise<ApiEnvelope<AppManagedActivityPositionDto>> {
      return fetcher<AppManagedActivityPositionDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}/positions/${activityPositionId}` });
    },
    /** App 发起人提交初次发布审核；服务端冻结 canonical 快照 [auth] */
    AppManagedActivitiesControllerCreatePublishReview(activityId: string, body: SubmitActivityPublishReviewDto): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/publish-reviews`, body });
    },
    /** 生成受保护且不可缓存的 SVG 二维码二进制内容 [auth] */
    AppManagedActivityAttendanceQrControllerRender(activityId: string, credentialId: string): Promise<ApiEnvelope<void>> {
      return fetcher<void>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/qr-credentials/${credentialId}/render` });
    },
    /** 作废场次二维码；精确 operationKey 重放原安全回执 [auth] */
    AppManagedActivityAttendanceQrControllerRevoke(activityId: string, credentialId: string, body: RevokeAppManagedAttendanceQrDto): Promise<ApiEnvelope<AppManagedAttendanceQrCredentialDto>> {
      return fetcher<AppManagedAttendanceQrCredentialDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/qr-credentials/${credentialId}/revoke`, body });
    },
    /** App 获取本人 managed 活动当前资格规则定义 [auth] */
    AppManagedActivitiesControllerGetQualificationRules(activityId: string): Promise<ApiEnvelope<AppActivityQualificationRulesDto>> {
      return fetcher<AppActivityQualificationRulesDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/qualification-rules` });
    },
    /** App 全量替换本人 draft 活动资格规则；已发布活动须走变更审核 [auth] */
    AppManagedActivitiesControllerPutQualificationRules(activityId: string, body: PutAppManagedActivityQualificationRulesDto): Promise<ApiEnvelope<AppActivityQualificationRulesDto>> {
      return fetcher<AppActivityQualificationRulesDto>({ method: "PUT", path: `/api/app/v1/my/managed-activities/${activityId}/qualification-rules`, body });
    },
    /** App 获取本人 managed 活动当前报名表定义 [auth] */
    AppManagedActivitiesControllerGetRegistrationForm(activityId: string): Promise<ApiEnvelope<AppRegistrationFormDto>> {
      return fetcher<AppRegistrationFormDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/registration-form` });
    },
    /** App 直改本人 draft 活动报名表定义；已发布活动须走变更审核 [auth] */
    AppManagedActivitiesControllerPutRegistrationForm(activityId: string, body: PutAppManagedRegistrationFormDto): Promise<ApiEnvelope<AppRegistrationFormDto>> {
      return fetcher<AppRegistrationFormDto>({ method: "PUT", path: `/api/app/v1/my/managed-activities/${activityId}/registration-form`, body });
    },
    /** App 活动负责人或报名协办查看报名列表 [auth] */
    AppManagedActivityRegistrationsControllerList(activityId: string, query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedRegistrationListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedRegistrationListItemDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/registrations`, query });
    },
    /** App 批量通过活动报名；逐条独立事务并返回部分成功结果 [auth] */
    AppManagedActivityRegistrationsControllerBulkApprove(activityId: string, body: BulkReviewAppManagedRegistrationsDto): Promise<ApiEnvelope<AppManagedRegistrationBulkResponseDto>> {
      return fetcher<AppManagedRegistrationBulkResponseDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/bulk-approve`, body });
    },
    /** App 批量拒绝活动报名；逐条独立事务并返回部分成功结果 [auth] */
    AppManagedActivityRegistrationsControllerBulkReject(activityId: string, body: BulkReviewAppManagedRegistrationsDto): Promise<ApiEnvelope<AppManagedRegistrationBulkResponseDto>> {
      return fetcher<AppManagedRegistrationBulkResponseDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/bulk-reject`, body });
    },
    /** App 活动负责人或报名协办通过待审报名 [auth] */
    AppManagedActivityRegistrationsControllerApprove(activityId: string, registrationId: string, body: ApproveAppManagedRegistrationDto): Promise<ApiEnvelope<AppManagedRegistrationDto>> {
      return fetcher<AppManagedRegistrationDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/approve`, body });
    },
    /** App 活动负责人或报名协办代取消报名 [auth] */
    AppManagedActivityRegistrationsControllerCancel(activityId: string, registrationId: string, body: CancelAppManagedRegistrationDto): Promise<ApiEnvelope<AppManagedRegistrationDto>> {
      return fetcher<AppManagedRegistrationDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/cancel`, body });
    },
    /** App 活动负责人或报名协办拒绝待审或候补报名 [auth] */
    AppManagedActivityRegistrationsControllerReject(activityId: string, registrationId: string, body: RejectAppManagedRegistrationDto): Promise<ApiEnvelope<AppManagedRegistrationDto>> {
      return fetcher<AppManagedRegistrationDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/reject`, body });
    },
    /** App 活动负责人或报名协办将已拒报名重开为待审 [auth] */
    AppManagedActivityRegistrationsControllerReopen(activityId: string, registrationId: string): Promise<ApiEnvelope<AppManagedRegistrationDto>> {
      return fetcher<AppManagedRegistrationDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/reopen` });
    },
    /** App 查看我管理活动的负责人和协办人 [auth] */
    AppManagedActivityResponsibilitiesControllerList(activityId: string): Promise<ApiEnvelope<AppManagedResponsibilitiesDto>> {
      return fetcher<AppManagedResponsibilitiesDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/responsibilities` });
    },
    /** App 提交人撤回本人当前 pending 发布申请 [auth] */
    AppManagedActivitiesControllerWithdrawReview(activityId: string): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/reviews/withdraw` });
    },
    /** App 分页查看本人草稿活动的场次 [auth] */
    AppManagedActivitiesControllerListSessions(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedActivitySessionDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedActivitySessionDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/sessions`, query });
    },
    /** App 为本人 draft 活动新增场次 [auth] */
    AppManagedActivitiesControllerCreateSession(activityId: string, body: CreateAppManagedActivitySessionDto): Promise<ApiEnvelope<AppManagedActivitySessionDto>> {
      return fetcher<AppManagedActivitySessionDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/sessions`, body });
    },
    /** App 修改本人 draft 活动场次 [auth] */
    AppManagedActivitiesControllerUpdateSession(activityId: string, sessionId: string, body: UpdateAppManagedActivitySessionDto): Promise<ApiEnvelope<AppManagedActivitySessionDto>> {
      return fetcher<AppManagedActivitySessionDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}`, body });
    },
    /** App 软删本人 draft 活动场次 [auth] */
    AppManagedActivitiesControllerDeleteSession(activityId: string, sessionId: string): Promise<ApiEnvelope<AppManagedActivitySessionDto>> {
      return fetcher<AppManagedActivitySessionDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}` });
    },
    /** App 分页查看本人草稿场次岗位 [auth] */
    AppManagedActivitiesControllerListSessionPositions(activityId: string, sessionId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppManagedActivitySessionPositionDto[] }>> {
      return fetcher<PageResultDto & { "items": AppManagedActivitySessionPositionDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`, query });
    },
    /** App 为本人 draft 场次新增岗位 [auth] */
    AppManagedActivitiesControllerCreateSessionPosition(activityId: string, sessionId: string, body: CreateAppManagedActivitySessionPositionDto): Promise<ApiEnvelope<AppManagedActivitySessionPositionDto>> {
      return fetcher<AppManagedActivitySessionPositionDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`, body });
    },
    /** App 修改本人 draft 场次岗位 [auth] */
    AppManagedActivitiesControllerUpdateSessionPosition(activityId: string, sessionId: string, positionId: string, body: UpdateAppManagedActivitySessionPositionDto): Promise<ApiEnvelope<AppManagedActivitySessionPositionDto>> {
      return fetcher<AppManagedActivitySessionPositionDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}`, body });
    },
    /** App 软删本人 draft 场次岗位 [auth] */
    AppManagedActivitiesControllerDeleteSessionPosition(activityId: string, sessionId: string, positionId: string): Promise<ApiEnvelope<AppManagedActivitySessionPositionDto>> {
      return fetcher<AppManagedActivitySessionPositionDto>({ method: "DELETE", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}` });
    },
    /** App 考勤责任人读取场次二维码版本与状态（不返回可用 token） [auth] */
    AppManagedActivityAttendanceQrControllerList(activityId: string, sessionId: string): Promise<ApiEnvelope<AppManagedAttendanceQrCredentialDto[]>> {
      return fetcher<AppManagedAttendanceQrCredentialDto[]>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/qr-credentials` });
    },
    /** 签发或重签场次签到/签退二维码；窗口只取冻结场次配置 [auth] */
    AppManagedActivityAttendanceQrControllerIssue(activityId: string, sessionId: string, action: "check-in" | "check-out", body: IssueAppManagedAttendanceQrDto): Promise<ApiEnvelope<AppManagedAttendanceQrCredentialDto>> {
      return fetcher<AppManagedAttendanceQrCredentialDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/qr-credentials/${action}/issue`, body });
    },
    /** App 查看负责人结算工作台摘要 [rbac: activity.settlement-generate.record] */
    AppManagedActivitiesControllerSettlementWorkbench(activityId: string): Promise<ApiEnvelope<AppSettlementWorkbenchResponseDto>> {
      return fetcher<AppSettlementWorkbenchResponseDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/settlement` });
    },
    /** App 执行结算和账本检查后机器关账 [rbac: activity.settlement-close.record] */
    AppManagedActivitiesControllerCloseSettlement(activityId: string, body: AppSettlementCloseCommandDto): Promise<ApiEnvelope<AppSettlementCloseResponseDto>> {
      return fetcher<AppSettlementCloseResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/close`, body });
    },
    /** App 生成或刷新结算草稿 [rbac: activity.settlement-generate.record] */
    AppManagedActivitiesControllerGenerateSettlement(activityId: string, body: AppSettlementGenerateCommandDto): Promise<ApiEnvelope<AppSettlementGenerateResponseDto>> {
      return fetcher<AppSettlementGenerateResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/generate`, body });
    },
    /** App 分页查看负责人结算逐人结果 [rbac: activity.settlement-generate.record] */
    AppManagedActivitiesControllerSettlementItems(activityId: string, query?: { "page"?: number; "pageSize"?: number; "session"?: string; "result"?: "present" | "leave" | "absent" | "cancelled" | "not_selected" | "waitlist_expired" | "review_expired" | "invitation_expired" | "exempt" | "early_departure_zero"; "q"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppSettlementItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppSettlementItemDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/items`, query });
    },
    /** App 负责人编辑当前 working draft 结算项 [rbac: activity.settlement-update-draft.record] */
    AppManagedActivitiesControllerUpdateSettlementDraftItem(activityId: string, identityId: string, body: AppSettlementUpdateDraftItemDto): Promise<ApiEnvelope<AppSettlementUpdatedDraftItemResponseDto>> {
      return fetcher<AppSettlementUpdatedDraftItemResponseDto>({ method: "PATCH", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/items/${identityId}`, body });
    },
    /** App 固化当前草稿为不可变结算版本 [rbac: activity.settlement-submit.record] */
    AppManagedActivitiesControllerSubmitSettlement(activityId: string, body: AppSettlementSubmitCommandDto): Promise<ApiEnvelope<AppSettlementSubmitResponseDto>> {
      return fetcher<AppSettlementSubmitResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/submit`, body });
    },
    /** App 查看不可变结算版本、差异和封场修订 [rbac: activity.settlement-generate.record] */
    AppManagedActivitiesControllerSettlementVersionDetail(activityId: string, versionId: string): Promise<ApiEnvelope<AppSettlementVersionDetailResponseDto>> {
      return fetcher<AppSettlementVersionDetailResponseDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/versions/${versionId}` });
    },
    /** App 将 returned 结算版本基于当前 working draft 重新提交 [rbac: activity.settlement-submit.record] */
    AppManagedActivitiesControllerResubmitSettlement(activityId: string, versionId: string, body: AppSettlementResubmitCommandDto): Promise<ApiEnvelope<AppSettlementSubmitResponseDto>> {
      return fetcher<AppSettlementSubmitResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/settlement/versions/${versionId}/resubmit`, body });
    },
    /** App 活动负责人提交已发布活动的完整变更 proposal [auth] */
    AppManagedActivitiesControllerSubmitChangeReview(activityId: string, body: AppSubmitActivityChangeReviewDto): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/submit-change-review`, body });
    },
    /** App 发起人提交初次发布审核 [auth] */
    AppManagedActivitiesControllerSubmitPublishReview(activityId: string): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/submit-publish-review` });
    },
    /** App 查看模板、活动、场次和岗位的最终解析值及来源 [auth] */
    AppManagedActivitiesControllerTemplateResolution(activityId: string): Promise<ApiEnvelope<ActivityTemplateResolutionResponseDto>> {
      return fetcher<ActivityTemplateResolutionResponseDto>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/template-resolution` });
    },
    /** App 负责人提前终止已开始的 published 活动 [auth] */
    AppManagedActivitiesControllerTerminate(activityId: string, body: AppManagedActivityTerminateCommandDto): Promise<ApiEnvelope<AppActivityLifecycleResultDto>> {
      return fetcher<AppActivityLifecycleResultDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/terminate`, body });
    },
    /** App 草稿活动移交发起人(当前发起人或 responsibility override) [auth] */
    AppManagedActivityResponsibilitiesControllerTransferInitiator(activityId: string, body: TransferAppManagedActivityInitiatorDto): Promise<ApiEnvelope<AppManagedResponsibilitiesDto>> {
      return fetcher<AppManagedResponsibilitiesDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/transfer-initiator`, body });
    },
    /** App 活动负责人移交责任并原子切换授权 [auth] */
    AppManagedActivityResponsibilitiesControllerTransferOwner(activityId: string, body: TransferAppManagedActivityOwnerDto): Promise<ApiEnvelope<AppManagedResponsibilitiesDto>> {
      return fetcher<AppManagedResponsibilitiesDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/transfer-owner`, body });
    },
    /** App 活动负责人或报名协办查看访客名单 [auth] */
    AppManagedActivityGuestsControllerListVisitors(activityId: string, query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": AppActivityVisitorDto[] }>> {
      return fetcher<PageResultDto & { "items": AppActivityVisitorDto[] }>({ method: "GET", path: `/api/app/v1/my/managed-activities/${activityId}/visitors`, query });
    },
    /** App 活动负责人或报名协办登记外部访客 [auth] */
    AppManagedActivityGuestsControllerCreateVisitor(activityId: string, body: CreateAppManagedActivityVisitorDto): Promise<ApiEnvelope<AppActivityVisitorDto>> {
      return fetcher<AppActivityVisitorDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/visitors`, body });
    },
    /** App 提交人撤回当前 pending 发布审核 [auth] */
    AppManagedActivitiesControllerWithdrawPublishReview(activityId: string): Promise<ApiEnvelope<ActivityPublishReviewResponseDto>> {
      return fetcher<ActivityPublishReviewResponseDto>({ method: "POST", path: `/api/app/v1/my/managed-activities/${activityId}/withdraw-publish-review` });
    },
    /** 我的已生效参与账本（分页，可选 activityId） [auth] */
    AppMyParticipationLedgerControllerList(query?: { "page"?: number; "pageSize"?: number; "activityId"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppParticipationLedgerEntryDto[] }>> {
      return fetcher<PageResultDto & { "items": AppParticipationLedgerEntryDto[] }>({ method: "GET", path: "/api/app/v1/my/participation-ledger", query });
    },
    /** 我的参与累计(approved 时长/活动次数/记录数/生涯封顶贡献；仅正向数据；恒本人范围) [auth] */
    AppMyParticipationSummaryControllerParticipationSummary(): Promise<ApiEnvelope<AppMyParticipationSummaryDto>> {
      return fetcher<AppMyParticipationSummaryDto>({ method: "GET", path: "/api/app/v1/my/participation-summary" });
    },
    /** 我的报名列表(分页 + 可选 statusCode 过滤;sensitive admin 字段不返) [auth] */
    AppMyRegistrationsControllerListMy(query?: { "page"?: number; "pageSize"?: number; "statusCode"?: string }): Promise<ApiEnvelope<PageResultDto & { "items": AppMyRegistrationListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": AppMyRegistrationListItemDto[] }>({ method: "GET", path: "/api/app/v1/my/registrations", query });
    },
    /** 本人报名活动(仅 legacy 活动；v1.1 live session 或 active Form 必须走 canonical 报名命令；非 published 统一 404) [auth] */
    AppMyRegistrationsControllerCreateMy(body: CreateAppMyRegistrationDto): Promise<ApiEnvelope<AppMyRegistrationDto>> {
      return fetcher<AppMyRegistrationDto>({ method: "POST", path: "/api/app/v1/my/registrations", body });
    },
    /** 我的报名详情(owner 校验:memberId !== currentUser.memberId 统一返 404 防侧信道) [auth] */
    AppMyRegistrationsControllerFindMy(id: string): Promise<ApiEnvelope<AppMyRegistrationDto>> {
      return fetcher<AppMyRegistrationDto>({ method: "GET", path: `/api/app/v1/my/registrations/${id}` });
    },
    /** 取消本人报名(pending|pass → cancelled;reject / cancelled / 他人 / 软删 / 不存在统一返 404 防侧信道或 21030) [auth] */
    AppMyRegistrationsControllerCancelMy(id: string, body: CancelAppMyRegistrationDto): Promise<ApiEnvelope<AppMyRegistrationDto>> {
      return fetcher<AppMyRegistrationDto>({ method: "PATCH", path: `/api/app/v1/my/registrations/${id}/cancel`, body });
    },
    /** 会员通知列表(准入 canUseApp;按 4 档可见性过滤;每项带 read 已读标志) [auth] */
    NotificationAppControllerList(query?: { "page"?: number; "pageSize"?: number }): Promise<ApiEnvelope<PageResultDto & { "items": NotificationReadListItemDto[] }>> {
      return fetcher<PageResultDto & { "items": NotificationReadListItemDto[] }>({ method: "GET", path: "/api/app/v1/notifications", query });
    },
    /** 上报微信订阅授权(逐模板 quota +1,封顶 D-N2;additive 非去重幂等;前端只在真授权后上报) [auth] */
    NotificationAppControllerAckSubscriptions(body: WechatSubscriptionAckDto): Promise<ApiEnvelope<WechatSubscriptionAckResponseDto>> {
      return fetcher<WechatSubscriptionAckResponseDto>({ method: "POST", path: "/api/app/v1/notifications/subscriptions/ack", body });
    },
    /** 查微信订阅剩余配额(逐模板 availableCount;前端据此判断是否需补授权) [auth] */
    NotificationAppControllerSubscriptionStatus(query: { "templateIds": string }): Promise<ApiEnvelope<WechatSubscriptionStatusResponseDto>> {
      return fetcher<WechatSubscriptionStatusResponseDto>({ method: "GET", path: "/api/app/v1/notifications/subscriptions/status", query });
    },
    /** 会员未读通知数(badge;可见 + published − 本人已读) [auth] */
    NotificationAppControllerUnreadCount(): Promise<ApiEnvelope<NotificationUnreadCountDto>> {
      return fetcher<NotificationUnreadCountDto>({ method: "GET", path: "/api/app/v1/notifications/unread-count" });
    },
    /** 会员通知详情(准入 canUseApp;可见级不通过 → 404 防枚举;不自动已读) [auth] */
    NotificationAppControllerDetail(id: string): Promise<ApiEnvelope<NotificationReadDetailDto>> {
      return fetcher<NotificationReadDetailDto>({ method: "GET", path: `/api/app/v1/notifications/${id}` });
    },
    /** 标记通知已读(幂等 upsert;首读 readCount 原子 +1,二次 no-op;不可见 → 404 防枚举) [auth] */
    NotificationAppControllerMarkRead(id: string): Promise<ApiEnvelope<MarkNotificationReadResponseDto>> {
      return fetcher<MarkNotificationReadResponseDto>({ method: "POST", path: `/api/app/v1/notifications/${id}/read` });
    },
  };
}
