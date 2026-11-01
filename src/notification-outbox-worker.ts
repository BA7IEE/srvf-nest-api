import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { ActivityBatchWorkerModule } from './modules/activities/activity-batch-worker.module';
import { ActivityBatchWorker } from './modules/activities/activity-batch.worker';
import { NotificationOutboxWorkerModule } from './modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxWorker } from './modules/notifications/notification-outbox.worker';
import { runHumanCorrectionWorkerIfSelected } from './modules/activities/human-correction-runtime-bootstrap';
import { HumanCorrectionWorkerModule } from './modules/activities/human-correction-worker.module';

export async function bootstrapNotificationOutboxWorker(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes('--human-correction-only')) {
    const app = await NestFactory.createApplicationContext(HumanCorrectionWorkerModule);
    app.enableShutdownHooks();
    try {
      const worker = app
        .select(HumanCorrectionWorkerModule)
        .get(ActivityBatchWorker, { strict: true });
      await runHumanCorrectionWorkerIfSelected(app.get(ConfigService), worker, args);
    } finally {
      await app.close();
    }
    return;
  }
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule);
  app.enableShutdownHooks();
  // B6 的 worker-only Attendances graph 经 Activities → Notifications 带回同 token 的 HTTP
  // provider；入口只能取本 module 的真实循环实例，不能让全局 app.get() 静默选到嵌套图。
  const outboxWorker = app
    .select(NotificationOutboxWorkerModule)
    .get(NotificationOutboxWorker, { strict: true });
  const activityWorker = app
    .select(ActivityBatchWorkerModule)
    .get(ActivityBatchWorker, { strict: true });
  try {
    if (await runHumanCorrectionWorkerIfSelected(app.get(ConfigService), activityWorker, args)) {
      await app.close();
      return;
    }
  } catch (error) {
    await app.close();
    throw error;
  }
  // ⚠️ **不用 `Promise.all`**:它把两个循环的失败模式耦合起来 —— 任一方 reject 会让
  //    `bootstrap()` 立刻 reject、进程当场退出,**另一个 worker 陪葬**。
  //    本刀的边界是「只加注册,不改既有 worker 的语义」,而进程寿命正是既有语义的一部分。
  //    (实测代价:`notification-outbox.e2e-spec.ts` 那条「真实 OS child SIGKILL」用例
  //     收到 `null` 而不是 `SIGKILL` —— 子进程在被杀之前就自己没了。)
  //    ⇒ `allSettled` + 逐条记日志:一方倒下不改变另一方的存活与退出码。
  const outcomes = await Promise.allSettled([outboxWorker.run(), activityWorker.run()]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected')
      console.error('[worker] loop exited abnormally', outcome.reason);
  }
  await app.close();
}

if (require.main === module) void bootstrapNotificationOutboxWorker();
