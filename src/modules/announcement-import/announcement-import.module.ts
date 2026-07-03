import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PositionAssignmentsModule } from '../position-assignments/position-assignments.module';
import { SupervisionAssignmentsModule } from '../supervision-assignments/supervision-assignments.module';
import { AnnouncementImportController } from './announcement-import.controller';
import { AnnouncementImportService } from './announcement-import.service';

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):公告导入模块。
// imports PermissionsModule 供注入 RbacService(R 模式 rbac.can);imports
// OrganizationsModule/PositionAssignmentsModule/SupervisionAssignmentsModule 供注入三个被复用 service
// 的 create()(决断②:绝不绕过,校验/audit/closure 全继承)。本模块自身**不**注入 AuditLogsModule ——
// 不写自己的 audit 事件,三个被复用 service 各自 audit(组织行 audit 已随 NEXT_TASKS P1-16〔review #484
// G18,2026-07-03〕补齐,`OrganizationsService.create()` 内部写 `organization.create`)。
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    OrganizationsModule,
    PositionAssignmentsModule,
    SupervisionAssignmentsModule,
  ],
  controllers: [AnnouncementImportController],
  providers: [AnnouncementImportService],
})
export class AnnouncementImportModule {}
