import { forwardRef, Module } from '@nestjs/common';
import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { DatabaseModule } from '../../database/database.module';
import { ActivityFeedbacksModule } from '../activity-feedbacks/activity-feedbacks.module';
import { AuthzModule } from '../authz/authz.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { InsurancesModule } from '../insurances/insurances.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { MemberProfilesModule } from '../member-profiles/member-profiles.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { ActivityAccessService } from './activity-access.service';
import { ActivityStatusCommandService } from './activity-status-command.service';
import { ActivityWriteService } from './activity-write.service';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivitySeriesAuditRecorder } from './activity-series-audit-recorder';
import { ActivitySeriesService } from './activity-series.service';
import { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import { ActivityDraftService } from './activity-draft.service';
import { ActivityStateMachine } from './activity-state-machine';
import { ActivityParticipationPolicy } from './activity-participation-policy';
import { AppActivitiesService } from './app-activities.service';
import { AppMyActivitiesService } from './app-my-activities.service';
import { AppActivitiesController } from './controllers/app-activities.controller';
import { AdminActivityParticipationController } from './controllers/admin-activity-participation.controller';
import { ActivityParticipationQueryService } from './activity-participation-query.service';
import { AdminActivityPositionsController } from './controllers/admin-activity-positions.controller';
import { ActivityPositionsService } from './activity-positions.service';
import { ActivityPositionAuditRecorder } from './activity-position-audit-recorder';
import { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityPublishReviewStateMachine } from './activity-publish-review-state-machine';
import { ActivityPublishReviewPresenter } from './activity-publish-review-presenter';
import { ActivityPublishReviewAuditRecorder } from './activity-publish-review-audit-recorder';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import { ActivityPublishReviewSubmitService } from './activity-publish-review-submit.service';
import { ActivityPublishProposalV2Service } from './activity-publish-proposal-v2.service';
import { ActivityPublishReviewQueryService } from './activity-publish-review-query.service';
import { AdminActivityPublishReviewsController } from './controllers/admin-activity-publish-reviews.controller';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityResponsibilityGrantProjector } from './activity-responsibility-grant-projector';
import { ActivityResponsibilityAuditRecorder } from './activity-responsibility-audit-recorder';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import { AdminActivityResponsibilitiesController } from './controllers/admin-activity-responsibilities.controller';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { AppManagedActivitiesController } from './controllers/app-managed-activities.controller';
import { AdminAttendanceSettlementsController } from './controllers/admin-attendance-settlements.controller';
import { AppManagedActivityPositionsController } from './controllers/app-managed-activity-positions.controller';
import { AppManagedActivityResponsibilitiesController } from './controllers/app-managed-activity-responsibilities.controller';
import { AppMyActivityBatchJobsController } from './controllers/app-my-activity-batch-jobs.controller';
import { AppMyActivityBatchJobsService } from './app-my-activity-batch-jobs.service';
import { AppMyParticipationLedgerController } from './controllers/app-my-participation-ledger.controller';
import { AdminMemberParticipationLedgerController } from './controllers/admin-member-participation-ledger.controller';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { ActivityProposalApplier } from './activity-proposal-applier';
import { ActivityClosurePolicy } from './activity-closure-policy';
import { ActivityMemberOffboardImpactService } from './activity-member-offboard-impact.service';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';
import { ActivityNotificationProducer } from './activity-notification-producer';
import { ActivityResponsibilityNotificationProducer } from './activity-responsibility-notification-producer';
import { EvidenceSealAuditRecorder } from './evidence-seal-audit-recorder';
import { EvidenceSealService } from './evidence-seal.service';
import { ContributionCalculator } from '../attendances/contribution-calculator';
import { SettlementDraftAuditRecorder } from './settlement-draft-audit-recorder';
import { SettlementDraftService } from './settlement-draft.service';
import { SettlementDraftDispatchService } from './settlement-draft-dispatch.service';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { SettlementReviewAuditRecorder } from './settlement-review-audit-recorder';
import { SettlementReviewService } from './settlement-review.service';
import { SettlementSubmitAuditRecorder } from './settlement-submit-audit-recorder';
import { SettlementSubmitService } from './settlement-submit.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { LedgerPostingService } from './ledger-posting.service';
import { LegacyConversionRegistrationHeadService } from '../activity-registrations/legacy-conversion-registration-head.service';
import { LegacyLedgerConversionService } from './legacy-ledger-conversion.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerQueryService } from './ledger-query.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import { ActivityClosureAuditRecorder } from './activity-closure-audit-recorder';
import { ActivityClosureNotificationProducer } from './activity-closure-notification-producer';
import { ActivityClosureService } from './activity-closure.service';
import { CorrectionApplicationService } from './correction-application.service';
import { CorrectionAuditRecorder } from './correction-audit-recorder';
import { ActivitySettlementHttpService } from './activity-settlement-http.service';
import { ActivityLifecycleService } from './activity-lifecycle.service';
// 归档 / 撤销归档(2026-08-25 拍板;§6.6 + AC-004 / AC-064)。
import { ActivityArchivePolicy } from './activity-archive-policy';
import { ActivityArchiveService } from './activity-archive.service';
import { RegistrationFormVersionService } from './registration-form-version.service';
import { QualificationRuleSetVersionService } from './qualification-rule-set-version.service';
import { ActivityCapacityBucketProjector } from './activity-capacity-bucket-projector';
import { ActivityQualificationEvaluatorService } from '../activity-registrations/activity-qualification-evaluator.service';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';
import { AttendanceSegmentProjectorService } from './attendance-segment-projector.service';
import { AttendancesModule } from '../attendances/attendances.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ActivityCoverService } from './activity-cover.service';
import { ActivityImageSigningService } from './activity-image-signing.service';

// V2 批次 6 PR #4(D6 v1.1 §8 / 第二波第二步):导入 AuditLogsModule 以注入 AuditLogsService,
// activities 写操作(create / update / softDelete / publish / cancel 共 5 处共用 activity.publish)
// 调 log() 替代 auditPlaceholder。
//
// Phase 2 P2-4a(2026-05-20):追加 AppActivitiesController(`/api/app/v1/activities/available`)
// + AppActivitiesService。沿 docs/app-api-p2-4-activities-review.md §1 接口清单 + §6.1 准入。
// 导入 UsersModule 获取已 exports 的 AppIdentityResolver(沿 §8.4 复用既有基础设施);
// **不**新建 AppActivitiesModule(避免模块爆炸;沿 §1 模块归属决议)。
// 既有 ActivitiesController / ActivitiesService 行为**逐字不变**(沿 §11.4 + 风险表 13.12)。
//
// Phase 2 P2-5a(2026-05-20):追加 AppMyActivitiesService。沿
// docs/app-api-p2-5-registrations-review.md §6.2 + §6.3.2 + D-P2-5-4:
//   - 物理位置归 src/modules/activities/(语义"我的活动";沿 P2-4 AppActivitiesService
//     同模块隔离范式)
//   - 用于 `/api/app/v1/my/activities` 汇总查询(沿 §11 + §16.B.1 方案 A 两阶段)
//   - exports 供 ActivityRegistrationsModule 内 AppMyRegistrationsService 注入(沿
//     §6.3.1;**不**新建 AppMyActivitiesController,该 endpoint 挂在
//     AppMyRegistrationsController 上)
// 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 PR12+ 逐面迁移第一批):导入 AuthzModule
// 注入 AuthzService —— 5 个写方法判权从 rbac.can 切 authz.can/explain(update/delete/publish/cancel
// 带 {type:'activity', id} ref;create 仍 no-ref)。authz 是叶子模块,不成环。
@Module({
  // 统一通知 S4/L2-L3:活动发布/变更/取消/审核结果及责任委托/移交都在主业务
  // transaction 内 enqueue durable intent；独立 worker 仅在 commit 后执行 Effect。
  imports: [
    // 活动 v1.1 cutover gate(合同 §16.2 单轨):两个模块 import 同一个模块 ⇒ 同一个闸实例。
    ActivityWorkflowModule,
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    UsersModule,
    InsurancesModule,
    CertificatesModule,
    MemberProfilesModule,
    NotificationsModule,
    OrganizationsModule,
    ActivityFeedbacksModule,
    // P2-14 刀 A:封面 / 图集改附件制 —— 归属校验、存储边界锁与签 URL 全部复用
    // attachments 模块的既有实现(与内容模块同一份),本模块不另写一套。
    AttachmentsModule,
    // B6 的 durable bulk worker 只能复用 Attendances 的统一 PunchCommand；双向模块关系
    // 由 forwardRef 显式声明，避免在 Activities 侧复制考勤写链。
    forwardRef(() => AttendancesModule),
  ],
  controllers: [
    ActivitiesController,
    AppActivitiesController,
    AdminActivityParticipationController,
    AdminActivityPositionsController,
    AdminActivityPublishReviewsController,
    AdminActivityResponsibilitiesController,
    AppManagedActivitiesController,
    AdminAttendanceSettlementsController,
    AppManagedActivityPositionsController,
    AppManagedActivityResponsibilitiesController,
    AppMyActivityBatchJobsController,
    AppMyParticipationLedgerController,
    AdminMemberParticipationLedgerController,
  ],
  providers: [
    ActivitiesService,
    AppMyActivityBatchJobsService,
    ActivityAccessService,
    ActivityCoverService,
    ActivityImageSigningService,
    ActivityStatusCommandService,
    ActivityWriteService,
    ActivityFromTemplateService,
    ActivityAuditRecorder,
    ActivitySeriesAuditRecorder,
    ActivitySeriesService,
    ActivityDraftAuditRecorder,
    ActivityDraftService,
    ActivityNotificationProducer,
    ActivityResponsibilityNotificationProducer,
    ActivityStateMachine,
    ActivityParticipationPolicy,
    ActivityParticipationQueryService,
    AppActivitiesService,
    AppMyActivitiesService,
    ActivityPositionsService,
    ActivityPositionAuditRecorder,
    ActivityInitiationPolicy,
    ActivityPublishReviewStateMachine,
    ActivityPublishReviewPresenter,
    ActivityPublishReviewAuditRecorder,
    ActivityPublishProposalV2Service,
    ActivityAllocationModeService,
    // 第 5 批只能经此公开 façade 复用已冻结的服务段投影；Attendances 不得深引 projector。
    AttendanceSegmentProjectorService,
    ActivityCapacityBucketProjector,
    ActivityQualificationEvaluatorService,
    RegistrationFormVersionService,
    QualificationRuleSetVersionService,
    ActivityProposalValidator,
    ActivityProposalApplier,
    ActivityClosurePolicy,
    ActivityMemberOffboardImpactService,
    ActivityWorkflowQueryService,
    ActivityPublishReviewService,
    ActivityPublishReviewSubmitService,
    ActivityPublishReviewQueryService,
    ActivityResponsibilityPolicy,
    ActivityResponsibilityGrantProjector,
    ActivityResponsibilityAuditRecorder,
    ActivityResponsibilityService,
    AppManagedActivitiesService,
    ActivityLifecycleService,
    ActivityArchivePolicy,
    ActivityArchiveService,
    ActivitySettlementHttpService,
    // 活动改造 v1.1 第 2 批第一刀(合同 §5.8):证据封场。
    // 本刀零端点 —— 消费方是第 2 批第二刀(结算草稿 / 提交),故先 provider + export。
    EvidenceSealAuditRecorder,
    EvidenceSealService,
    // 活动改造 v1.1 第 2 批第二刀(合同 §5.9):结算草稿生成 + 服务段重建。
    // 本刀同样零端点 —— 消费方是第三刀(提交不可变版本)。
    //
    // ⚠️ `ContributionCalculator` 在这里作为 **provider** 而不是 import AttendancesModule:
    //    `AttendancesModule` 已经 import 了本模块,反向 import 会成环。
    //    它无构造依赖、无状态,复用的是**同一个类**(同一套 ACTIVE pair 查找 +
    //    「重复 pair fail-closed」不变量),不是第二套实现。
    ContributionCalculator,
    SettlementDraftAuditRecorder,
    SettlementDraftService,
    SettlementDraftDispatchService,
    // 活动改造 v1.1 第 2 批第三刀(合同 §5.10):提交不可变 SettlementVersion。
    // 同样零端点 —— 消费方是第四刀(一审/终审)。
    SettlementNotificationProducer,
    SettlementSubmitAuditRecorder,
    SettlementSubmitService,
    // 活动改造 v1.1 第 2 批第四刀(合同 §5.11):一审 / 终审。
    // 同样零端点 —— 消费方是第 2 批收尾那一刀(整条结算流程的对外入口)。
    SettlementReviewAuditRecorder,
    SettlementReviewService,
    // 活动改造 v1.1 第 2 批第五刀(合同 §5.12 + §5.13):账本分块准备 + 短事务统一生效。
    //
    // 🔴 本刀语义像钱:`LedgerPostingService.commitBatch` 成功的那一刻,
    //    `ParticipationLedgerEntry` 就是队员贡献值真值。
    //
    // `ActivityBatchWorker` 的 daemon 只由两个既有 worker 专用 module 启动；HTTP app
    // 保留 provider 只供显式 service/e2e 调用,不自启动。全仓仍零新增 cron、Redis、
    // 外部 queue 或新进程。
    LedgerPreparationService,
    LedgerReadyBatchCommitter,
    // HTTP application context 不启动 worker daemon；保留显式 drain 的第五刀测试探针为
    // prepare-only。两个真实 worker process 的专用 module 把本 token 置 true。
    { provide: ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, useValue: false },
    ActivityBatchWorker,
    LedgerPostingAuditRecorder,
    LedgerPostingService,
    // 存量考勤账本化转换刀(P1-28 第 7 批② A 案,2026-08-27 拍板):零端点 / 零 DTO /
    // 零权限码 —— 唯一调用方是 scripts/legacy-ledger-conversion.ts(维护者 SOP)与 e2e。
    // ⭐ 复用而非另写:生效走 commitConvertedBatchWithin(第五刀协议体,判闸位换转换窗口)。
    // 头服务文件放在归属域 activity-registrations/ 下(D2 建头是它的域),
    // 但零 DI 依赖(事务由调用方传入),由本模块直接提供即可,不经模块互引
    // (ActivityRegistrationsModule 已 import 本模块,反向直连会成环)。
    LegacyConversionRegistrationHeadService,
    LegacyLedgerConversionService,
    LedgerQueryService,
    // 活动改造 v1.1 第 2 批第六刀(合同 §5.15 + §3.26):机器关账。
    //
    // 🔴 关账是"这场活动的账算完了"的唯一权威(合同 §1.2 把它从负责人**声明**
    //    改成**机器检查**)。同样零端点 / 零 DTO / 零权限码 —— 消费方是第 ⑧ 刀。
    // ⚠️ 本刀**与旧关账路径并存**:不删 `declareAttendanceComplete`、不改
    //    `activity-closure-policy.ts`(那是既有行为契约变更,另立一刀单独拍板)。
    ActivityClosureAuditRecorder,
    ActivityClosureNotificationProducer,
    ActivityClosureService,
    // 活动改造 v1.1 第 2 批第七刀(合同 §5.14 + §3.25):更正应用。
    // 🔴 **全仓唯一能改动"已生效账本"的通路**,语义像钱:它成功的那一刻,
    //    队员账上的贡献值就换了一份真值。
    // ⭐ 复用而非另写:生效走第五刀 `LedgerPostingService.commitBatchWithin`
    //    (member lock / day-state CAS / 日合计 0..3 / 零部分生效),
    //    重新关账走第六刀 `ActivityClosureService` —— 本刀两者都只调用,不复制。
    // 同样零端点 / 零 DTO / 零权限码 —— 消费方是第 ⑧ 刀。
    CorrectionAuditRecorder,
    CorrectionApplicationService,
  ],
  exports: [
    ActivitiesService,
    // 跨模块读侧(activity-registrations / attendances 的 App 列表)也要按 coverImageKey
    // 现签活动封面 —— 导出签名层,而不是让它们各自去调 AttachmentsService。
    ActivityImageSigningService,
    EvidenceSealService,
    SettlementDraftService,
    SettlementDraftDispatchService,
    SettlementSubmitService,
    SettlementReviewService,
    LedgerPreparationService,
    ActivityBatchWorker,
    LedgerPostingService,
    LedgerQueryService,
    ActivityClosureService,
    CorrectionApplicationService,
    // 存量考勤账本化转换刀(P1-28 第 7 批② A 案,2026-08-27 拍板):零端点 / 零 DTO /
    // 零权限码 —— 唯一调用方是 scripts/legacy-ledger-conversion.ts(维护者 SOP)与 e2e。
    // ⭐ 复用而非另写:生效走 LedgerPostingService.commitConvertedBatchWithin(第五刀
    // 协议体,判闸位换转换窗口断言);判闸见 ActivityWorkflowGate.assertLegacyLedgerConversionAllowed。
    LegacyLedgerConversionService,
    AppMyActivitiesService,
    ActivityParticipationPolicy,
    ActivityPublishReviewService,
    ActivityResponsibilityPolicy,
    ActivityResponsibilityService,
    AppManagedActivitiesService,
    ActivityWorkflowQueryService,
    ActivityMemberOffboardImpactService,
    ActivityQualificationEvaluatorService,
    AttendanceSegmentProjectorService,
  ],
})
export class ActivitiesModule {}
