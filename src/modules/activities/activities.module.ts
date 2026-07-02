import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityStateMachine } from './activity-state-machine';
import { AppActivitiesService } from './app-activities.service';
import { AppMyActivitiesService } from './app-my-activities.service';
import { AppActivitiesController } from './controllers/app-activities.controller';

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
    NotificationsModule,
  ],
  controllers: [ActivitiesController, AppActivitiesController],
  providers: [
    ActivitiesService,
    ActivityAuditRecorder,
    ActivityStateMachine,
    AppActivitiesService,
    AppMyActivitiesService,
  ],
  exports: [ActivitiesService, AppMyActivitiesService],
})
export class ActivitiesModule {}
