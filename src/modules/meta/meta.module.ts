import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';
import { AuthzModule } from '../authz/authz.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ParticipationOverviewQueryService } from './participation-overview-query.service';

// F1/A7(路线图 §4 A7;net-new 模块):跨资源批量 id→label 解析(resolve-labels)。
// imports PermissionsModule 供 MetaService 的 resolve-labels 继续走 GLOBAL RbacService；
// AuthzModule 供 dashboard/participation-overview 汇合三源组织范围。**只读查询各资源自身的表,
// 不注入其它业务模块 service**(镜像 authz 模块 ResourceResolverService 的自包含范式)；
// 无 AuditLogsModule(诊断读,无 audit)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuthzModule, OrganizationsModule],
  controllers: [MetaController],
  providers: [MetaService, ParticipationOverviewQueryService],
})
export class MetaModule {}
