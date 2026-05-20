import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersModule } from '../users/users.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { AppActivitiesService } from './app-activities.service';
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
@Module({
  imports: [DatabaseModule, AuditLogsModule, UsersModule],
  controllers: [ActivitiesController, AppActivitiesController],
  providers: [ActivitiesService, AppActivitiesService],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
