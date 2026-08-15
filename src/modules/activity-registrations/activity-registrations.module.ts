import { Module } from '@nestjs/common';
import { InsurancesModule } from '../insurances/insurances.module';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ActivitiesModule } from '../activities/activities.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationNotificationProducer } from './activity-registration-notification-producer';
import { ActivityRegistrationPresenter } from './activity-registration-presenter';
import { ActivityRegistrationQueryService } from './activity-registration-query.service';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import { ActivityRegistrationsAdminController } from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { AppMyRegistrationsService } from './app-my-registrations.service';
import {
  AdminMemberRegistrationsController,
  AdminRegistrationsController,
} from './controllers/admin-registrations.controller';
import { AppMyRegistrationsController } from './controllers/app-my-registrations.controller';
import { ActivityRegistrationBulkService } from './activity-registration-bulk.service';
import { ActivityRegistrationWaitlistQueryService } from './activity-registration-waitlist-query.service';
import { AppManagedActivityRegistrationsService } from './app-managed-activity-registrations.service';
import { AppManagedActivityRegistrationsController } from './controllers/app-managed-activity-registrations.controller';
import { AppRegistrationUploadSessionsController } from './controllers/app-registration-upload-sessions.controller';
import { AppActivityRegistrationsController } from './controllers/app-activity-registrations.controller';
import { RegistrationCommandService } from './registration-command.service';
import { RegistrationUploadSessionService } from './registration-upload-session.service';
import { CapacityReservationService } from './capacity-reservation.service';
import { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import { ActivityInvitationService } from './activity-invitation.service';
import { ActivityVisitorService } from './activity-visitor.service';
import { AppManagedActivityGuestsController } from './controllers/app-managed-activity-guests.controller';
import { AppMyActivityInvitationsController } from './controllers/app-my-activity-invitations.controller';
import { AppManagedActivityOnsiteParticipationsController } from './controllers/app-managed-activity-onsite-participations.controller';
import { OnsiteParticipationCommandService } from './onsite-participation-command.service';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import { ActivityAllocationService } from './activity-allocation.service';
import { AppManagedActivityAllocationBatchesController } from './controllers/app-managed-activity-allocation-batches.controller';

// V2 批次 6 PR #5(D6 v1.1 §8 / 第二波第三步):导入 AuditLogsModule 以注入 AuditLogsService,
// activity-registrations 6 处写操作(create / createMy / approve / reject / cancelAdmin / cancelMy)
// 调 log() 替代 auditPlaceholder;敏感读取统一批次起 exportCsv 在返回 generator 前复用
// registration.review 落库,审计失败 fail-closed 且不会发送首字节。
//
// Phase 2 P2-5a(2026-05-20):追加 AppMyRegistrationsController(/api/app/v1/my/* 3
// 只读 endpoint)+ AppMyRegistrationsService(薄壳)。沿
// docs/api-surface-policy.md §5 项 3:旧 ActivityRegistrationsAdminController
// 行为**逐字不变**(PR review 强查 controller.ts 无 diff)。
//
// Route B Phase 4d2(2026-06-01):`ActivityRegistrationsMeController`(`/api/v2/users/me/*` 4 端点)
// 已删除(app/v1/my/registrations* 对等存在,队员流由 app-my-registrations-*.e2e 覆盖;
// 沿 docs/api-surface-migration-plan.md §6 Phase 4)。
// 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 PR12+ 逐面迁移第一批):导入 AuthzModule 注入
// AuthzService —— list/approve/reject/cancelAdmin/exportCsv 判权从 rbac.can 切 authz.can/explain
// (list/exportCsv 带 {type:'activity', id} 父 ref;approve/reject/cancelAdmin 带
// {type:'activity_registration', id};create/listAllForAdmin/listForMemberAdmin 仍 no-ref)。
// authz 是叶子模块,不成环。
@Module({
  // InsurancesModule:保险 T3 报名门槛(单向依赖,仅注入 InsuranceRequirementService;评审稿 E-13)
  imports: [
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    UsersModule,
    ActivitiesModule,
    InsurancesModule,
    // 报名通知 L1 durable outbox:producer 在报名事务内 enqueue，独立 worker commit 后执行 Effect；
    // producer → notifications **单向**，通知绝不回调报名。
    NotificationsModule,
    // F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D7 拍板):供 listAllForAdmin 注入
    // OrganizationsService.queryDescendantOrgIds()(closure 只读展开,非判权)。
    OrganizationsModule,
    AttachmentsModule,
  ],
  controllers: [
    ActivityRegistrationsAdminController,
    AdminRegistrationsController,
    AdminMemberRegistrationsController,
    AppMyRegistrationsController,
    AppManagedActivityRegistrationsController,
    AppRegistrationUploadSessionsController,
    AppActivityRegistrationsController,
    AppManagedActivityGuestsController,
    AppMyActivityInvitationsController,
    AppManagedActivityOnsiteParticipationsController,
    AppManagedActivityAllocationBatchesController,
  ],
  providers: [
    ActivityRegistrationsService,
    ActivityRegistrationBulkService,
    AppMyRegistrationsService,
    ActivityRegistrationStateMachine,
    ActivityRegistrationAuditRecorder,
    ActivityRegistrationNotificationProducer,
    ActivityRegistrationWaitlistQueryService,
    // Phase 6-B 第三域第一刀:读侧查询构造。**刻意不进 exports** —— 跨模块读仍走
    // ActivityRegistrationsService 那一个入口,避免出现绕过判权腿的第二条读路径
    // (沿 members #1008 / attendances #1021 先例)。
    ActivityRegistrationQueryService,
    // Phase 6-B 第三域第二刀:响应序列化。纯函数类、零依赖,同样不进 exports。
    ActivityRegistrationPresenter,
    AppManagedActivityRegistrationsService,
    RegistrationUploadSessionService,
    RegistrationCommandService,
    CapacityReservationService,
    ActivityInvitationAuditRecorder,
    ActivityInvitationService,
    ActivityVisitorService,
    OnsiteParticipationCommandService,
    ActivityRegistrationLifecycleService,
    ActivityAllocationService,
  ],
})
export class ActivityRegistrationsModule {}
