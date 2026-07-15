import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { UsersModule } from '../users/users.module';
import { ActivityFeedbacksService } from './activity-feedbacks.service';
import { AppActivityFeedbacksController } from './controllers/app-activity-feedbacks.controller';

// F2 注册 App self surface；F3 再追加 Admin controller/query service 与只读 aggregate export。
@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [AppActivityFeedbacksController],
  providers: [ActivityFeedbacksService],
})
export class ActivityFeedbacksModule {}
