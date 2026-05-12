import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

// V2 批次 6 PR #2(D6 v1.1 §8.2):导入 AuditLogsModule 以注入 AuditLogsService,
// certificates 写操作(create / update / softDelete / verify / reject)调 log() 替代 auditPlaceholder。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [CertificatesController],
  providers: [CertificatesService],
})
export class CertificatesModule {}
