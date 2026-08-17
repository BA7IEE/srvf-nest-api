import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ActivitiesModule } from '../activities/activities.module';
import { AuthzModule } from '../authz/authz.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MemberAuditRecorder } from './member-audit-recorder';
import { MembersController } from './members.controller';
import { MembersQueryService } from './members-query.service';
import { MemberAccessService } from './member-access.service';
import { MemberAccountService } from './member-account.service';
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
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuthzModule,
    OrganizationsModule,
    AuditLogsModule,
    ActivitiesModule,
  ],
  controllers: [MembersController],
  // Phase 6-B 第一刀(2026-08-15):MembersQueryService = 读侧查询构造边界(§3.2)。
  // 只在本模块内被 MembersService 注入,不 exports —— 跨模块复用仍走 MembersService.options()
  // 那一个入口(F4/D 组既有约定),避免第二条绕过判权腿的读路径。
  // Phase 6-B 第二刀:MemberAuditRecorder = 6 个 audit 事件的 payload 组装边界(§3.5)。
  // 只注入 AuditLogsService,tx 由调用方透传,事务边界仍归 MembersService。
  providers: [
    MemberAccessService,
    MemberAccountService,
    MembersService,
    MembersQueryService,
    MemberAuditRecorder,
  ],
  exports: [MembersService],
})
export class MembersModule {}
