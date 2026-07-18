import { NestFactory } from '@nestjs/core';

import { NotificationOutboxWorkerModule } from './modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxWorker } from './modules/notifications/notification-outbox.worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule);
  app.enableShutdownHooks();
  await app.get(NotificationOutboxWorker).run();
  await app.close();
}

void bootstrap();
