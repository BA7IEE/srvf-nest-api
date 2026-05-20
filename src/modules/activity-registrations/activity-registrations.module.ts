import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ActivitiesModule } from '../activities/activities.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersModule } from '../users/users.module';
import {
  ActivityRegistrationsAdminController,
  ActivityRegistrationsMeController,
} from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';
import { AppMyRegistrationsService } from './app-my-registrations.service';
import { AppMyRegistrationsController } from './controllers/app-my-registrations.controller';

// V2 批次 6 PR #5(D6 v1.1 §8 / 第二波第三步):导入 AuditLogsModule 以注入 AuditLogsService,
// activity-registrations 6 处写操作(create / createMy / approve / reject / cancelAdmin / cancelMy)
// 调 log() 替代 auditPlaceholder;exportCsv 是 read/export,仍走 pino-only auditPlaceholder。
//
// Phase 2 P2-5a(2026-05-20):追加 AppMyRegistrationsController(/api/app/v1/my/* 3
// 只读 endpoint)+ AppMyRegistrationsService(薄壳)。沿
// docs/app-api-p2-5-registrations-review.md §6.1 / §6.3.1 + D-P2-5-5:
//   - 导入 UsersModule 注入 AppIdentityResolver(P2-1 已 exports;P2-5 5 endpoint 准入沿同)
//   - 导入 ActivitiesModule 注入 AppMyActivitiesService(P2-5a 新增 exports;
//     /my/activities 汇总查询)
//   - 旧 ActivityRegistrationsAdminController / ActivityRegistrationsMeController 行为
//     **逐字不变**(沿 §5.3 + §15.2 + 风险 14.13;PR review 强查 controller.ts 无 diff)
@Module({
  imports: [DatabaseModule, AuditLogsModule, UsersModule, ActivitiesModule],
  controllers: [
    ActivityRegistrationsAdminController,
    ActivityRegistrationsMeController,
    AppMyRegistrationsController,
  ],
  providers: [ActivityRegistrationsService, AppMyRegistrationsService],
})
export class ActivityRegistrationsModule {}
