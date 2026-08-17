import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RealnameModule } from '../realname/realname.module';
import { SmsModule } from '../sms/sms.module';
import { StorageModule } from '../storage/storage.module';
import { WechatModule } from '../wechat/wechat.module';
import { RecruitmentApplicationReviewService } from './recruitment-application-review.service';
import { RecruitmentApplicationsAdminController } from './recruitment-applications.admin.controller';
import { RecruitmentApplicationsQueryService } from './recruitment-applications-query.service';
import { RecruitmentApplicationProgressService } from './recruitment-application-progress.service';
import { RecruitmentApplicationsService } from './recruitment-applications.service';
import { RecruitmentCycleAccessService } from './recruitment-cycle-access.service';
import { RecruitmentOcrService } from './recruitment-ocr.service';
import { RecruitmentCertificateClaimsAdminController } from './recruitment-certificate-claims.admin.controller';
import { RecruitmentCertificateClaimsService } from './recruitment-certificate-claims.service';
import { RecruitmentCyclesController } from './recruitment-cycles.controller';
import { RecruitmentCyclesService } from './recruitment-cycles.service';
import { RecruitmentIdentityService } from './recruitment-identity.service';
import { RecruitmentPromotionService } from './recruitment-promotion.service';
import { RecruitmentPublicController } from './recruitment-public.controller';
import { RecruitmentStatsService } from './recruitment-stats.service';

// 招新一期(招新前段)T3(2026-06-18):recruitment 模块装配(评审稿 §3.2)。
// 消费 Wechat(code2session)/ Realname(付费实名核验)/ Storage(证件照)/ Permissions(rbac.can)/
// AuditLogs(审计)/ Sms(招新四期 S4a:H5 手机身份链发码/验码,SmsCodeService)。
// 两 surface:open/v1 公开报名 + admin/v1 轮次/报名管理。
// 不导出任何 provider(招新前段自成闭环;phase-2 promote 出范围)。
@Module({
  imports: [
    AttachmentsModule,
    DatabaseModule,
    PermissionsModule,
    AuditLogsModule,
    WechatModule,
    RealnameModule,
    StorageModule,
    SmsModule, // 招新四期 S4a:复用 SmsCodeService(RECRUITMENT_BIND 发码/验码)
    NotificationsModule, // durable outbox producer: 发号事务与 targeted intent 同事务
    // 证书标准库 PR-4a-1(§19):只为拿 CertificatesModule 导出的窄 Resolver,
    // 让 Claim 审核复用同一套认定规则解析,不在招新侧复制第二套 Policy 算法。
    CertificatesModule,
  ],
  controllers: [
    RecruitmentPublicController,
    RecruitmentCyclesController,
    RecruitmentApplicationsAdminController,
    RecruitmentCertificateClaimsAdminController,
  ],
  providers: [
    RecruitmentCyclesService,
    RecruitmentApplicationProgressService,
    RecruitmentApplicationsService,
    RecruitmentCycleAccessService,
    RecruitmentOcrService,
    RecruitmentApplicationsQueryService, // god-service 拆分(2026-06-28):admin 读面
    RecruitmentApplicationReviewService, // god-service 拆分(2026-06-28):核验后评审写动作
    RecruitmentIdentityService,
    RecruitmentPromotionService,
    RecruitmentStatsService,
    RecruitmentCertificateClaimsService,
  ],
})
export class RecruitmentModule {}
