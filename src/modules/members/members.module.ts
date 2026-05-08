import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
