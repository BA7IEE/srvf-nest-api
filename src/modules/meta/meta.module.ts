import { forwardRef, Module } from '@nestjs/common';
import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { ActivitiesModule } from '../activities/activities.module';
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
// ⚠️ 上一段「不注入其它业务模块 service」的自包含约定,**在 2026-08-21 被本刀有意放宽**
// (第六轮评审 B-01):participation-overview 是「对外产出工时」的统计读面,闸开后必须改读
// 已入账账本,而账本的**唯一**读入口是 ActivitiesModule 导出的 LedgerQueryService
// (该类文件头明文禁止调用方自写 $queryRaw)。两害相权:要么破这条自包含约定,
// 要么在 meta 里复制一份账本 SQL —— 后者会造出第二份真相,是本仓明确禁止的形状。
// forwardRef 与 attendances 模块同一范式(统计读面 ↔ activities 互引)。
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuthzModule,
    OrganizationsModule,
    ActivityWorkflowModule,
    forwardRef(() => ActivitiesModule),
  ],
  controllers: [MetaController],
  providers: [MetaService, ParticipationOverviewQueryService],
})
export class MetaModule {}
