import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '../../database/database.module';
import { HealthController } from './health.controller';

// V1.1 §11.2 / TASKS.md 15.5:接入 @nestjs/terminus 提供 HealthCheckService +
// PrismaHealthIndicator;DB 探针通过注入的 PrismaService 走 SELECT 1 等价命令。
//
// health 仍是 4 文件铁律的明确例外(CLAUDE.md §2):
// 只有 module + controller + dto,不创建 service。
@Module({
  imports: [TerminusModule, DatabaseModule],
  controllers: [HealthController],
})
export class HealthModule {}
