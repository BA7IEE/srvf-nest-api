import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DictItemsController, DictTypesController } from './dictionaries.controller';
import { DictionariesService } from './dictionaries.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DictTypesController, DictItemsController],
  providers: [DictionariesService],
})
export class DictionariesModule {}
