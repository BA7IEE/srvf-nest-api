import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '../../database/database.module';
import { HealthController } from './health.controller';

// 健康检查分层(ARCHITECTURE.md §11.1):接入 @nestjs/terminus 提供 HealthCheckService +
// PrismaHealthIndicator;DB 探针通过注入的 PrismaService 走 SELECT 1 等价命令。
//
// health 仍是 4 文件铁律的明确例外(docs/reference/naming-dto-validation.md §2):
// 只有 module + controller + dto,不创建 service。
@Module({
  imports: [TerminusModule, DatabaseModule],
  controllers: [HealthController],
})
export class HealthModule {}
