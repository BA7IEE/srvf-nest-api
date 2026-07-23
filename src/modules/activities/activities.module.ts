import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ActivityFeedbacksModule } from '../activity-feedbacks/activity-feedbacks.module';
import { AuthzModule } from '../authz/authz.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { InsurancesModule } from '../insurances/insurances.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
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
import { ActivityPublishReviewQueryService } from './activity-publish-review-query.service';
import { AdminActivityPublishReviewsController } from './controllers/admin-activity-publish-reviews.controller';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityResponsibilityGrantProjector } from './activity-responsibility-grant-projector';
import { ActivityResponsibilityAuditRecorder } from './activity-responsibility-audit-recorder';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import { AdminActivityResponsibilitiesController } from './controllers/admin-activity-responsibilities.controller';
import { AppManagedActivitiesService } from './app-managed-activities.service';
import { AppManagedActivitiesController } from './controllers/app-managed-activities.controller';
import { AppManagedActivityPositionsController } from './controllers/app-managed-activity-positions.controller';
import { AppManagedActivityResponsibilitiesController } from './controllers/app-managed-activity-responsibilities.controller';
import { ActivityProposalValidator } from './activity-proposal-validator';
import { ActivityProposalApplier } from './activity-proposal-applier';

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
  // 统一通知 S4(评审稿 §6.4 / §11):活动取消 → 已报名者定向通知(NotificationDispatcher;
  // producer → notifications **单向**,cancel commit 后直调,防环:通知绝不回调活动)。
  imports: [
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    UsersModule,
    InsurancesModule,
    NotificationsModule,
    OrganizationsModule,
    ActivityFeedbacksModule,
  ],
  controllers: [
    ActivitiesController,
    AppActivitiesController,
    AdminActivityParticipationController,
    AdminActivityPositionsController,
    AdminActivityPublishReviewsController,
    AdminActivityResponsibilitiesController,
    AppManagedActivitiesController,
    AppManagedActivityPositionsController,
    AppManagedActivityResponsibilitiesController,
  ],
  providers: [
    ActivitiesService,
    ActivityAuditRecorder,
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
    ActivityProposalValidator,
    ActivityProposalApplier,
    ActivityPublishReviewService,
    ActivityPublishReviewQueryService,
    ActivityResponsibilityPolicy,
    ActivityResponsibilityGrantProjector,
    ActivityResponsibilityAuditRecorder,
    ActivityResponsibilityService,
    AppManagedActivitiesService,
  ],
  exports: [
    ActivitiesService,
    AppMyActivitiesService,
    ActivityParticipationPolicy,
    ActivityPublishReviewService,
    ActivityResponsibilityPolicy,
    ActivityResponsibilityService,
    AppManagedActivitiesService,
  ],
})
export class ActivitiesModule {}
