import { NestFactory } from '@nestjs/core';

import { ActivityBatchWorker } from './modules/activities/activity-batch.worker';
import { NotificationOutboxWorkerModule } from './modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxWorker } from './modules/notifications/notification-outbox.worker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule);
  app.enableShutdownHooks();
  // ⚠️ **不用 `Promise.all`**:它把两个循环的失败模式耦合起来 —— 任一方 reject 会让
  //    `bootstrap()` 立刻 reject、进程当场退出,**另一个 worker 陪葬**。
  //    本刀的边界是「只加注册,不改既有 worker 的语义」,而进程寿命正是既有语义的一部分。
  //    (实测代价:`notification-outbox.e2e-spec.ts` 那条「真实 OS child SIGKILL」用例
  //     收到 `null` 而不是 `SIGKILL` —— 子进程在被杀之前就自己没了。)
  //    ⇒ `allSettled` + 逐条记日志:一方倒下不改变另一方的存活与退出码。
  const outcomes = await Promise.allSettled([
    app.get(NotificationOutboxWorker).run(),
    app.get(ActivityBatchWorker).run(),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected')
      console.error('[worker] loop exited abnormally', outcome.reason);
  }
  await app.close();
}

void bootstrap();
