import { NestFactory } from '@nestjs/core';

import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import type { WechatDeliveryOutboxPayload } from '../../src/modules/notifications/notification-outbox.types';
import { parseKnownNotificationOutboxPayload } from '../../src/modules/notifications/notification-outbox.types';
import { DevStubWechatProvider } from '../../src/modules/wechat/providers/dev-stub.provider';

async function main(): Promise<void> {
  const [command, owner = `child-${process.pid}`, nowIso, leaseMsText, eventKey] =
    process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
    abortOnError: false,
    logger: false,
  });
  app.enableShutdownHooks();
  try {
    const workerModule = app.select(NotificationOutboxWorkerModule);
    // B6 经 Attendances → Activities → Notifications 带回一组 HTTP provider；真实 worker
    // child 的 crash barrier 必须绑定入口 module 的同一组 outbox/handler/worker 实例。
    const outbox = workerModule.get(NotificationOutboxService, { strict: true });
    const worker = workerModule.get(NotificationOutboxWorker, { strict: true });
    const handlers = workerModule.get(NotificationOutboxHandlers, { strict: true });
    const activityWorker = app
      .select(ActivityBatchWorkerModule)
      .get(ActivityBatchWorker, { strict: true });
    if (command === 'boot') {
      void worker;
      void activityWorker;
      write({
        booted: true,
        notificationOutboxWorker: true,
        activityBatchWorker: true,
        pid: process.pid,
      });
      return;
    }
    if (command === 'run-slow-sigterm') {
      const execute = handlers.execute.bind(handlers);
      const delayMs = leaseMsText ? Number(leaseMsText) : 750;
      let first = true;
      handlers.execute = async (intent, guard) => {
        const result = await execute(intent, guard);
        if (first) {
          first = false;
          write({ phase: 'effect-persisted-before-return', owner, ids: [intent.id] });
          await pause(delayMs);
        }
        return result;
      };
      await worker.run();
      return;
    }
    const claim = () =>
      outbox.claim(owner, {
        limit: 1,
        ...(nowIso ? { now: new Date(nowIso) } : {}),
        ...(leaseMsText ? { leaseMs: Number(leaseMsText) } : {}),
        ...(eventKey ? { eventKey } : {}),
      });
    if (command === 'claim') {
      const rows = await claim();
      write({ owner, ids: rows.map(({ id }) => id) });
      return;
    }
    if (command === 'claim-and-wait') {
      const [intent] = await claim();
      write({ phase: 'claimed', owner, ids: intent ? [intent.id] : [] });
      if (intent) await waitForever();
      return;
    }
    if (command === 'authorize-admin-and-wait') {
      const [intent] = await claim();
      if (!intent) {
        write({ phase: 'not-claimed', owner, ids: [] });
        return;
      }
      const payload = parseKnownNotificationOutboxPayload(
        intent.eventType,
        intent.payloadVersion,
        intent.payload,
      ) as WechatDeliveryOutboxPayload;
      const notification = await outbox.authorizeAdminNotificationEffect(
        intent,
        payload.notificationId,
        payload.publishGeneration!,
        'wechat',
      );
      write({
        phase: notification ? 'permission-granted' : 'permission-denied',
        owner,
        ids: [intent.id],
      });
      await waitForever();
      return;
    }
    if (command === 'execute-before-final-permission-and-wait') {
      const authorize = outbox.authorizeAdminNotificationEffect.bind(outbox);
      outbox.authorizeAdminNotificationEffect = async (...args) => {
        write({ phase: 'prepared-before-final-permission', owner, ids: [args[0].id] });
        await waitForever();
        return authorize(...args);
      };
      const [intent] = await claim();
      if (!intent) {
        write({ phase: 'not-claimed', owner, ids: [] });
        return;
      }
      await worker.executeReserved(intent);
      return;
    }
    if (command === 'execute-no-ack') {
      const [intent] = await claim();
      if (!intent) {
        write({ owner, ids: [] });
        return;
      }
      const refreshed = await outbox.renewLease(
        intent,
        new Date(),
        leaseMsText ? Number(leaseMsText) : undefined,
      );
      const result = await handlers.execute(refreshed, {
        beforeEffect: () =>
          outbox
            .renewLease(refreshed, new Date(), leaseMsText ? Number(leaseMsText) : undefined)
            .then(() => undefined),
      });
      write({ owner, ids: [intent.id], effectPerformed: result.effectPerformed });
      return;
    }
    if (command === 'execute-effect-and-wait') {
      const [intent] = await claim();
      if (!intent) {
        write({ phase: 'not-claimed', owner, ids: [] });
        return;
      }
      const refreshed = await outbox.renewLease(
        intent,
        new Date(),
        leaseMsText ? Number(leaseMsText) : undefined,
      );
      const result = await handlers.execute(refreshed, {
        beforeEffect: () =>
          outbox
            .renewLease(refreshed, new Date(), leaseMsText ? Number(leaseMsText) : undefined)
            .then(() => undefined),
      });
      write({
        phase: 'evidence-persisted',
        owner,
        ids: [intent.id],
        effectPerformed: result.effectPerformed,
      });
      await waitForever();
      return;
    }
    if (command === 'execute-provider-returned-and-wait') {
      const [intent] = await claim();
      if (!intent) {
        write({ phase: 'not-claimed', owner, ids: [] });
        return;
      }
      const provider = app.get(DevStubWechatProvider);
      const send = provider.sendSubscribeMessage.bind(provider);
      provider.sendSubscribeMessage = async (...args) => {
        const result = await send(...args);
        write({ phase: 'provider-returned-before-evidence', owner, ids: [intent.id] });
        await waitForever();
        return result;
      };
      await worker.executeReserved(intent);
      return;
    }
    if (command === 'execute-and-ack') {
      const rows = await outbox.claim(owner, {
        limit: 1,
        ...(nowIso ? { now: new Date(nowIso) } : {}),
        ...(leaseMsText ? { leaseMs: Number(leaseMsText) } : {}),
        ...(eventKey ? { eventKey } : {}),
      });
      const [intent] = rows;
      if (!intent) {
        write({ owner, ids: [] });
        return;
      }
      const value = await worker.executeReserved(intent);
      write({ owner, ids: [intent.id], value });
      return;
    }
    throw new Error(`unknown notification outbox child command: ${command ?? '<missing>'}`);
  } finally {
    await app.close();
  }
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitForever(): Promise<never> {
  // 悬空 Promise 本身不会保活 Node 事件循环。这里的真实 OS child 必须停在 crash
  // barrier，直到父进程显式 SIGKILL；不能依赖某张 worker module 图碰巧留下的 DB handle。
  return new Promise(() => {
    setInterval(() => undefined, 60_000);
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
