import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { MemberDepartmentsController } from './member-departments.controller';
import { MemberDepartmentsService } from './member-departments.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MemberDepartmentsController],
  providers: [MemberDepartmentsService],
})
export class MemberDepartmentsModule {}
