import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { IntegrationIdempotencyService } from './integration-idempotency.service';

@Module({
  imports: [DatabaseModule],
  providers: [IntegrationIdempotencyService],
  exports: [IntegrationIdempotencyService],
})
export class IntegrationIdempotencyModule {}
