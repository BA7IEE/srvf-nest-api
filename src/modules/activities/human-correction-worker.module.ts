import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import jwtConfig from '../../config/jwt.config';
import { ActivityBatchWorker } from './activity-batch.worker';
import {
  HUMAN_CORRECTION_EXECUTION,
  HumanCorrectionExecutionModule,
  type HumanCorrectionExecution,
} from './human-correction-execution.module';
import { HumanCorrectionRuntimeSetupError } from './human-correction-runtime-bootstrap';

/** Uses the existing worker binary/slot. No ordinary application client,
 * Storage lifecycle, login service, cron or second worker loop is started. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig, jwtConfig] }),
    HumanCorrectionExecutionModule,
  ],
  providers: [
    {
      provide: ActivityBatchWorker,
      inject: [HUMAN_CORRECTION_EXECUTION],
      useFactory: (scope: HumanCorrectionExecution | null) => {
        if (!scope) throw new HumanCorrectionRuntimeSetupError('HUMAN_WORKER_DISABLED');
        return scope.worker;
      },
    },
  ],
})
export class HumanCorrectionWorkerModule {}
