import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { MemberProfilesController } from './member-profiles.controller';
import { MemberProfilesService } from './member-profiles.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MemberProfilesController],
  providers: [MemberProfilesService],
})
export class MemberProfilesModule {}
