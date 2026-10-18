import type { INestApplication } from '@nestjs/common';
import { writeSync } from 'node:fs';
import appConfig from '../../src/config/app.config';

const active = process.env.SRVF_E5_ACTIVE_MATRIX === '1';
let pending = 0;
const openApps = new Set<INestApplication>();
let setupUnknown = false;
async function owned(work: () => Promise<unknown>) {
  pending++;
  try {
    await work();
  } finally {
    pending--;
  }
}
export function assertE5MatrixSettled() {
  if (active && pending !== 0) {
    markE5MatrixUnknown();
    throw new Error('E5 active matrix body pending; close and DROP refused');
  }
}
/** Same existing assertions and real application; the selector changes only process configuration. */
export function e5ActiveMatrixOptions() {
  return {
    settlementMode: active ? ('active' as const) : ('fixture' as const),
    boundMigrationProcesses: true as const,
    assertReadyToFinalize: () => {
      assertE5MatrixSettled();
      if (active && (setupUnknown || openApps.size)) {
        markE5MatrixUnknown();
        throw new Error('E5 active matrix resources UNKNOWN; DROP refused');
      }
    },
  };
}
export function assertE5MatrixMode(app: INestApplication) {
  const actual = app.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode;
  expect(actual).toBe(active ? 'active' : 'fixture');
  if (active) openApps.add(app);
  if (active) writeSync(2, 'E5_ACTIVE_MATRIX actualApplicationMode=active\n');
}
export function e5MatrixIt(name: string, work: () => Promise<unknown>, timeout?: number) {
  return it(name, () => owned(work), timeout);
}
export function markE5MatrixUnknown() {
  if (active) setupUnknown = true;
}
export function e5MatrixBeforeEach(work: () => Promise<unknown>, timeout?: number) {
  return beforeEach(() => {
    if (active && (pending || setupUnknown || openApps.size)) {
      markE5MatrixUnknown();
      throw new Error('E5 active matrix previous work/resources UNKNOWN');
    }
    return owned(async () => {
      try {
        await work();
      } catch (cause) {
        markE5MatrixUnknown();
        throw cause;
      }
    });
  }, timeout);
}

export async function closeE5MatrixApp(app: INestApplication | undefined) {
  try {
    await app?.close();
  } catch (cause) {
    markE5MatrixUnknown();
    throw cause;
  }
  if (app) openApps.delete(app);
}
