import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import {
  AttendanceRecordsMeController,
  AttendanceSheetsCollectionController,
  AttendanceSheetsResourceController,
} from './attendances.controller';
import { AttendancesService } from './attendances.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    AttendanceSheetsCollectionController,
    AttendanceSheetsResourceController,
    AttendanceRecordsMeController,
  ],
  providers: [AttendancesService],
})
export class AttendancesModule {}
