import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RealnameModule } from '../realname/realname.module';
import { StorageModule } from '../storage/storage.module';
import { WechatModule } from '../wechat/wechat.module';
import { RecruitmentApplicationsAdminController } from './recruitment-applications.admin.controller';
import { RecruitmentApplicationsService } from './recruitment-applications.service';
import { RecruitmentCyclesController } from './recruitment-cycles.controller';
import { RecruitmentCyclesService } from './recruitment-cycles.service';
import { RecruitmentPublicController } from './recruitment-public.controller';

// 招新一期(招新前段)T3(2026-06-18):recruitment 模块装配(评审稿 §3.2)。
// 消费 Wechat(code2session)/ Realname(付费实名核验)/ Storage(证件照)/ Permissions(rbac.can)/
// AuditLogs(审计)。两 surface:open/v1 公开报名 + admin/v1 轮次/报名管理。
// 不导出任何 provider(招新前段自成闭环;phase-2 promote 出范围)。
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuditLogsModule,
    WechatModule,
    RealnameModule,
    StorageModule,
  ],
  controllers: [
    RecruitmentPublicController,
    RecruitmentCyclesController,
    RecruitmentApplicationsAdminController,
  ],
  providers: [RecruitmentCyclesService, RecruitmentApplicationsService],
})
export class RecruitmentModule {}
