import { NestFactory } from '@nestjs/core';

import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';

async function main(): Promise<void> {
  const [command, owner = `child-${process.pid}`, nowIso, leaseMsText, eventKey] =
    process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
    abortOnError: false,
    logger: false,
  });
  app.enableShutdownHooks();
  try {
    if (command === 'boot') {
      app.get(NotificationOutboxWorker);
      write({ booted: true, pid: process.pid });
      return;
    }
    const outbox = app.get(NotificationOutboxService);
    if (command === 'run-slow-sigterm') {
      const worker = app.get(NotificationOutboxWorker);
      const handlers = app.get(NotificationOutboxHandlers);
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
      const result = await app.get(NotificationOutboxHandlers).execute(refreshed, {
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
      const result = await app.get(NotificationOutboxHandlers).execute(refreshed, {
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
      const value = await app.get(NotificationOutboxWorker).executeReserved(intent);
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
  return new Promise(() => undefined);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
