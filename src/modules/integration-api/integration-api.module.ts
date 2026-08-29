import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { IntegrationApiController } from './integration-api.controller';
import { IntegrationApiService } from './integration-api.service';

@Module({
  imports: [DatabaseModule],
  controllers: [IntegrationApiController],
  providers: [IntegrationApiService],
})
export class IntegrationApiModule {}
