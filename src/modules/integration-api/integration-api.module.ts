import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { DictionariesModule } from '../dictionaries/dictionaries.module';
import { IntegrationAuthzModule } from '../integration-authz/integration-authz.module';
import { IntegrationActivityTypesController } from './integration-activity-types.controller';
import { IntegrationActivityTypesFacade } from './integration-activity-types.facade';
import { IntegrationApiController } from './integration-api.controller';
import { IntegrationApiService } from './integration-api.service';

@Module({
  imports: [DatabaseModule, DictionariesModule, IntegrationAuthzModule],
  controllers: [IntegrationApiController, IntegrationActivityTypesController],
  providers: [IntegrationApiService, IntegrationActivityTypesFacade],
})
export class IntegrationApiModule {}
