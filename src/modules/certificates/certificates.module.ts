import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AppMyCertificatesService } from './app-my-certificates.service';
import { CertificateRecognitionPoliciesController } from './certificate-recognition-policies.controller';
import { CertificateRecognitionPoliciesService } from './certificate-recognition-policies.service';
import { CertificateStandardAuditRecorder } from './certificate-standard-audit-recorder';
import { CertificateStandardsController } from './certificate-standards.controller';
import { CertificateStandardsService } from './certificate-standards.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { AppMyCertificatesController } from './controllers/app-my-certificates.controller';

// V2 批次 6 PR #2(D6 v1.1 §8.2):导入 AuditLogsModule 以注入 AuditLogsService,
// certificates 写操作(create / update / softDelete / verify / reject)调 log() 替代 auditPlaceholder。
// C-2 起 admin list/detail/qualification-flag 查询后也 fail-closed 落敏感读取审计。
//
// Phase 2 P2-7(2026-05-20):追加 AppMyCertificatesController
// (/api/app/v1/my/certificates 1 endpoint)+ AppMyCertificatesService(独立 App service)。
// 沿 docs/app-api-p2-7-my-certificates-review.md §7.1 + D-P2-7-9 / D-P2-7-10:
//   - 导入 UsersModule 注入 AppIdentityResolver(P2-1 已 exports;P2-7 准入沿同)
//   - 独立 App service 直查 PrismaService(**不** thin-wrap CertificatesService.list;
//     **不**新增 listForMember,沿 D-P2-7-9 + Phase 0.7 §6 不立即重构)
//   - Admin path `/api/admin/v1/members/:memberId/certificates/*` 8 endpoint 行为
//     **逐字不变**(沿 D-P2-7-15 + §11.1 path stability)
//
// Slow-4 T2(2026-06-11):imports PermissionsModule 供 CertificatesService 注入 RbacService
// (评审稿 slow4-rbac-business-face-review.md §3.4;App surface 不走 RBAC,AppMyCertificatesService 不动)。
// 证书标准库 PR-3(2026-07-30;冻结稿 §13.1 / §13.2 / §19):追加通用证书标准与
// 队内认定规则两个**全局主数据配置面** controller(7 + 6 = 13 路由)。
// 判权走 `RbacService.can()`(§16.4:配置面不是 Certificate 实例的 scoped Authz),
// 故只需已导入的 PermissionsModule,不新增 module 依赖。
// `CertificateStandardAuditRecorder` 为两个 service 共用(§17 两个高价值事件)。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule, AuthzModule, UsersModule],
  controllers: [
    CertificatesController,
    AppMyCertificatesController,
    CertificateStandardsController,
    CertificateRecognitionPoliciesController,
  ],
  providers: [
    CertificatesService,
    AppMyCertificatesService,
    CertificateStandardsService,
    CertificateRecognitionPoliciesService,
    CertificateStandardAuditRecorder,
  ],
})
export class CertificatesModule {}
