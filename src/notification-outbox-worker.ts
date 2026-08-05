import { NestFactory } from '@nestjs/core';

import { ActivityBatchWorker } from './modules/activities/activity-batch.worker';
import { NotificationOutboxWorkerModule } from './modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxWorker } from './modules/notifications/notification-outbox.worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule);
  app.enableShutdownHooks();
  await Promise.all([app.get(NotificationOutboxWorker).run(), app.get(ActivityBatchWorker).run()]);
  await app.close();
}

void bootstrap();
