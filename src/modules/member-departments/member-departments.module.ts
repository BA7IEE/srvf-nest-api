import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MemberDepartmentsController } from './member-departments.controller';
import { MemberDepartmentsService } from './member-departments.service';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

// P0-F PR-2A(2026-05-18):imports PermissionsModule 供 service 注入 RbacService(沿 PR-1 attachments F5 v1.0 范本)。
// 终态 scoped-authz PR2(2026-07-01;冻结稿 §7.1):并入终态组织归属面(memberships)—— 与旧单部门端点同源
// (同一 member_organization_memberships 表)、同模块内聚;旧 member-departments 端点重指向 PRIMARY 行做兼容。
// 审计留痕批(2026-07-03;review #484 G5):imports AuditLogsModule 供两 service 注入 AuditLogsService
// (建 / 结束归属写 audit;沿 position-assignments 模块接线范式)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [MemberDepartmentsController, MembershipsController],
  providers: [MemberDepartmentsService, MembershipsService],
})
export class MemberDepartmentsModule {}
