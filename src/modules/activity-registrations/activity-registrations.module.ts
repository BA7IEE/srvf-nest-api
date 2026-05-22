import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ActivitiesModule } from '../activities/activities.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersModule } from '../users/users.module';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import { ActivityRegistrationsAdminController } from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { AppMyRegistrationsService } from './app-my-registrations.service';
import { ActivityRegistrationsMeController } from './controllers/activity-registrations-me-legacy.controller';
import { AppMyRegistrationsController } from './controllers/app-my-registrations.controller';

// V2 批次 6 PR #5(D6 v1.1 §8 / 第二波第三步):导入 AuditLogsModule 以注入 AuditLogsService,
// activity-registrations 6 处写操作(create / createMy / approve / reject / cancelAdmin / cancelMy)
// 调 log() 替代 auditPlaceholder;exportCsv 是 read/export,仍走 pino-only auditPlaceholder。
//
// Phase 2 P2-5a(2026-05-20):追加 AppMyRegistrationsController(/api/app/v1/my/* 3
// 只读 endpoint)+ AppMyRegistrationsService(薄壳)。沿
// docs/api-surface-policy.md §5 项 3:旧 ActivityRegistrationsAdminController /
// ActivityRegistrationsMeController 行为**逐字不变**(PR review 强查 controller.ts 无 diff)。
//
// P1-C step 3(2026-05-21):`ActivityRegistrationsMeController` 已物理迁出到
// `controllers/activity-registrations-me-legacy.controller.ts`(沿 docs/api-surface-policy.md
// §5 项 3 + §7 P1-C step 3);endpoint path / DTO / service / Guard / RBAC / Swagger Tag
// 全部 zero drift。
//
// **controllers 数组顺序**:沿 PR #169 / #171 范式,legacy mobile controller 注册先于
// admin controller。本拆分中 Admin 与 Mobile 的 `@Controller(...)` 前缀不同
// (`v2/activities/:activityId/registrations` vs `v2/users/me`)无实际路由冲突,
// 但保留 legacy-first 顺序作为模块一致性规则。
@Module({
  imports: [DatabaseModule, AuditLogsModule, UsersModule, ActivitiesModule],
  controllers: [
    ActivityRegistrationsMeController,
    ActivityRegistrationsAdminController,
    AppMyRegistrationsController,
  ],
  providers: [
    ActivityRegistrationsService,
    AppMyRegistrationsService,
    ActivityRegistrationStateMachine,
  ],
})
export class ActivityRegistrationsModule {}
