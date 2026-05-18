import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DictItemsController, DictTypesController } from './dictionaries.controller';
import { DictionariesService } from './dictionaries.service';

// P0-F PR-2A(2026-05-18):imports PermissionsModule 供 DictionariesService 注入 RbacService
// (沿 PR-1 attachments F5 v1.0 范本;PermissionsModule exports [RbacService])。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [DictTypesController, DictItemsController],
  providers: [DictionariesService],
})
export class DictionariesModule {}
