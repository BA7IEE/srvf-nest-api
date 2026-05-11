import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import {
  ActivityRegistrationsAdminController,
  ActivityRegistrationsMeController,
} from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ActivityRegistrationsAdminController, ActivityRegistrationsMeController],
  providers: [ActivityRegistrationsService],
})
export class ActivityRegistrationsModule {}
