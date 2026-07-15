import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { ActivityFeedbacksQueryService } from './activity-feedbacks-query.service';
import { ActivityFeedbacksService } from './activity-feedbacks.service';
import { AdminActivityFeedbacksController } from './controllers/admin-activity-feedbacks.controller';
import { AppActivityFeedbacksController } from './controllers/app-activity-feedbacks.controller';

// F3 注册 Admin list/summary，并导出只读 aggregate 给 activity participation-summary 单向复用。
@Module({
  imports: [DatabaseModule, UsersModule, AuthzModule, PermissionsModule],
  controllers: [AppActivityFeedbacksController, AdminActivityFeedbacksController],
  providers: [ActivityFeedbacksService, ActivityFeedbacksQueryService],
  exports: [ActivityFeedbacksQueryService],
})
export class ActivityFeedbacksModule {}
