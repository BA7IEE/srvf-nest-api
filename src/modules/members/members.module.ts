import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// Slow-4 T2(2026-06-11):imports PermissionsModule 供 MembersService 注入 RbacService
// (沿 P0-F contribution-rules 范本;评审稿 slow4-rbac-business-face-review.md §3.1)。
// F1/A1(路线图 §4;D7 拍板):imports OrganizationsModule 供注入 OrganizationsService,
// 复用其 queryDescendantOrgIds() 只读 helper 展开 includeDescendants(closure 非判权)。
// F4/D 组(2026-07-04):exports MembersService 供 member-departments 模块组织轴队员下拉
// (organizations/:orgId/members/options)复用 options() 同一份投影与过滤(sugar 端点,零第二套查询逻辑)。
// 队员账号闭环 v1(2026-07-07):imports AuditLogsModule 供 grantAccount() 写 audit
// (`member.account-granted`;沿 users/recruitment 模块同款 DI 范式)。
@Module({
  imports: [DatabaseModule, PermissionsModule, OrganizationsModule, AuditLogsModule],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
