import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';

// F1 仅落 schema 与模块边界；F2/F3 再按冻结稿分别接入 App / Admin controller 与 service。
@Module({ imports: [DatabaseModule] })
export class ActivityFeedbacksModule {}
