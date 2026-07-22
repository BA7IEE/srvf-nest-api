import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AdminMemberInsurancesController } from './admin-member-insurances.controller';
import { AppMeInsurancesService } from './app-me-insurances.service';
import { AppMeInsurancesController } from './controllers/app-me-insurances.controller';
import { InsuranceRequirementService } from './insurance-requirement.service';
import { MemberInsuranceOverviewService } from './member-insurance-overview.service';
import { MemberInsurancesService } from './member-insurances.service';
import { TeamInsurancePoliciesController } from './team-insurance-policies.controller';
import { TeamInsurancePoliciesService } from './team-insurance-policies.service';

// 保险模块(2026-06-13 T2;冻结评审稿 docs/archive/reviews/insurance-module-review.md §5)。
// 三块数据:自购保险(App 自助 self-scope)+ 队统一保单 + 覆盖名单(admin)。
//
// imports(沿 certificates.module 范式):
//   - DatabaseModule:PrismaService
//   - AuditLogsModule:写操作落 audit_logs(member-insurance.*.self / team-insurance-policy.* /
//     team-insurance-coverage.*;评审稿 §3.5);admin 自购保险列表查询后 fail-closed 落
//     member-insurance.read.other
//   - PermissionsModule:admin 面 RbacService 判权(App 面不走 RBAC)
//   - UsersModule:AppIdentityResolver(App 准入,P2-1 已 exports)
//
// exports:仅 InsuranceRequirementService(报名门槛纯查询;T3 由 ActivityRegistrationsModule
//   import 本模块接线,依赖单向 activity-registration → insurances,评审稿 E-13;
//   **不** exports 其余 service——跨模块只暴露门槛校验一个口)。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule, AuthzModule, UsersModule],
  controllers: [
    TeamInsurancePoliciesController,
    AdminMemberInsurancesController,
    AppMeInsurancesController,
  ],
  providers: [
    TeamInsurancePoliciesService,
    MemberInsurancesService,
    MemberInsuranceOverviewService,
    AppMeInsurancesService,
    InsuranceRequirementService,
  ],
  exports: [InsuranceRequirementService],
})
export class InsurancesModule {}
