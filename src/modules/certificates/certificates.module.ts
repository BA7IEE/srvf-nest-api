import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersModule } from '../users/users.module';
import { AppMyCertificatesService } from './app-my-certificates.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { AppMyCertificatesController } from './controllers/app-my-certificates.controller';

// V2 批次 6 PR #2(D6 v1.1 §8.2):导入 AuditLogsModule 以注入 AuditLogsService,
// certificates 写操作(create / update / softDelete / verify / reject)调 log() 替代 auditPlaceholder。
//
// Phase 2 P2-7(2026-05-20):追加 AppMyCertificatesController
// (/api/app/v1/my/certificates 1 endpoint)+ AppMyCertificatesService(独立 App service)。
// 沿 docs/app-api-p2-7-my-certificates-review.md §7.1 + D-P2-7-9 / D-P2-7-10:
//   - 导入 UsersModule 注入 AppIdentityResolver(P2-1 已 exports;P2-7 准入沿同)
//   - 独立 App service 直查 PrismaService(**不** thin-wrap CertificatesService.list;
//     **不**新增 listForMember,沿 D-P2-7-9 + Phase 0.7 §6 不立即重构)
//   - 旧 v2 admin path `/api/v2/members/:memberId/certificates/*` 8 endpoint 行为
//     **逐字不变**(沿 D-P2-7-15 + §11.1 path stability)
@Module({
  imports: [DatabaseModule, AuditLogsModule, UsersModule],
  controllers: [CertificatesController, AppMyCertificatesController],
  providers: [CertificatesService, AppMyCertificatesService],
})
export class CertificatesModule {}
