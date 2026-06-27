import { Module } from '@nestjs/common';
import { InsurancesModule } from '../insurances/insurances.module';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ActivitiesModule } from '../activities/activities.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import { ActivityRegistrationsAdminController } from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { AppMyRegistrationsService } from './app-my-registrations.service';
import {
  AdminMemberRegistrationsController,
  AdminRegistrationsController,
} from './controllers/admin-registrations.controller';
import { AppMyRegistrationsController } from './controllers/app-my-registrations.controller';

// V2 批次 6 PR #5(D6 v1.1 §8 / 第二波第三步):导入 AuditLogsModule 以注入 AuditLogsService,
// activity-registrations 6 处写操作(create / createMy / approve / reject / cancelAdmin / cancelMy)
// 调 log() 替代 auditPlaceholder;exportCsv 是 read/export,仍走 pino-only auditPlaceholder。
//
// Phase 2 P2-5a(2026-05-20):追加 AppMyRegistrationsController(/api/app/v1/my/* 3
// 只读 endpoint)+ AppMyRegistrationsService(薄壳)。沿
// docs/api-surface-policy.md §5 项 3:旧 ActivityRegistrationsAdminController
// 行为**逐字不变**(PR review 强查 controller.ts 无 diff)。
//
// Route B Phase 4d2(2026-06-01):`ActivityRegistrationsMeController`(`/api/v2/users/me/*` 4 端点)
// 已删除(app/v1/my/registrations* 对等存在,队员流由 app-my-registrations-*.e2e 覆盖;
// 沿 docs/api-surface-migration-plan.md §6 Phase 4)。
@Module({
  // InsurancesModule:保险 T3 报名门槛(单向依赖,仅注入 InsuranceRequirementService;评审稿 E-13)
  imports: [
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    UsersModule,
    ActivitiesModule,
    InsurancesModule,
    // 统一通知 S4(评审稿 §6.4 / §11):报名审批结果定向通知(NotificationDispatcher;
    // producer → notifications **单向**,本模块 commit 后直调,防环:通知绝不回调报名)。
    NotificationsModule,
  ],
  controllers: [
    ActivityRegistrationsAdminController,
    AdminRegistrationsController,
    AdminMemberRegistrationsController,
    AppMyRegistrationsController,
  ],
  providers: [
    ActivityRegistrationsService,
    AppMyRegistrationsService,
    ActivityRegistrationStateMachine,
    ActivityRegistrationAuditRecorder,
  ],
})
export class ActivityRegistrationsModule {}
