import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import {
  parseActivityV11WorkflowEnabled,
  parseActivityWorkflowReadonly,
  type AppConfig,
} from '../../src/config/app.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import {
  e4DiagnosticContext,
  E4_DIAGNOSTIC_LIMITS,
  installE4DiagnosticLimits,
  superviseE4DiagnosticChild,
  type E4DiagnosticChild,
  installE4DiagnosticFixtureGate,
} from './e4-diagnostic-limits-client';

const input = {
  purpose: 'DIAGNOSTIC_ONLY',
  scope: 'app_test_w98',
  sourceHead: 'a'.repeat(40),
  databaseUrl: 'postgresql://localhost/app_test_w98',
  appEnv: 'test',
};
const context = () => e4DiagnosticContext(input);
describe('E4 diagnostic fixture gate (offline, actual config parser and gate)', () => {
  function fixtureEnv(value?: string): NodeJS.ProcessEnv {
    return {
      APP_ENV: 'test',
      SRVF_E4_DIAGNOSTIC_PURPOSE: 'DIAGNOSTIC_ONLY',
      SRVF_E4_W98: '1',
      ...(value === undefined ? {} : { ACTIVITY_V11_WORKFLOW_ENABLED: value }),
    };
  }
  function capture(env: NodeJS.ProcessEnv) {
    return new ActivityWorkflowGate({
      activityV11Workflow: {
        enabled: parseActivityV11WorkflowEnabled(env.ACTIVITY_V11_WORKFLOW_ENABLED, 'test'),
        readonlyMaintenance: parseActivityWorkflowReadonly(env.ACTIVITY_WORKFLOW_READONLY),
      },
    } as AppConfig);
  }
  it.each([undefined, 'false', 'true'])(
    'enables before config capture and restores exact original%p after fixture close',
    async (value) => {
      const env = fixtureEnv(value);
      const restore = installE4DiagnosticFixtureGate(context(), env);
      const gate = capture(env);
      expect(() => gate.assertV11WriteAllowed()).not.toThrow();
      const close = jest.fn(async () => {
        expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('true');
      });
      try {
        await Promise.resolve();
      } finally {
        try {
          await close();
        } finally {
          restore();
        }
      }
      restore();
      expect(close).toHaveBeenCalledTimes(1);
      expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBe(value);
      expect(Object.hasOwn(env, 'ACTIVITY_V11_WORKFLOW_ENABLED')).toBe(value !== undefined);
    },
  );
  it('reproduces the exact closed-gate BizException offline, and opening after config capture cannot fix that instance', () => {
    const env = fixtureEnv();
    const capturedBefore = capture(env);
    try {
      capturedBefore.assertV11WriteAllowed();
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toEqual(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
      expect((error as BizException).biz).toMatchObject({ code: 20153, httpStatus: 503 });
    }
    const restore = installE4DiagnosticFixtureGate(context(), env);
    try {
      expect(() => capturedBefore.assertV11WriteAllowed()).toThrow(BizException);
      expect(() => capture(env).assertV11WriteAllowed()).not.toThrow();
    } finally {
      restore();
    }
    expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBeUndefined();
  });
  it('restores after initialization or cleanup throws, and never clears readonly maintenance', async () => {
    const env = fixtureEnv('false');
    env.ACTIVITY_WORKFLOW_READONLY = 'true';
    const restore = installE4DiagnosticFixtureGate(context(), env);
    const original = new Error('fixture initialization failed');
    await expect(
      (async () => {
        try {
          expect(() => capture(env).assertV11WriteAllowed()).toThrow(
            BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.message,
          );
          throw original;
        } finally {
          restore();
        }
      })(),
    ).rejects.toBe(original);
    expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('false');
    expect(env.ACTIVITY_WORKFLOW_READONLY).toBe('true');
    const restoreAgain = installE4DiagnosticFixtureGate(context(), env);
    const failClose = () => Promise.reject(original);
    await expect(
      (async () => {
        try {
          await Promise.resolve();
        } finally {
          try {
            await failClose();
          } finally {
            restoreAgain();
          }
        }
      })(),
    ).rejects.toBe(original);
    expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('false');
  });
  it.each([
    { APP_ENV: 'production' },
    { SRVF_E4_DIAGNOSTIC_PURPOSE: 'FORMAL' },
    { SRVF_E4_W98: '1-other' },
  ])('refuses a non-diagnostic lifecycle without changing the gate:%p', (change) => {
    const env: NodeJS.ProcessEnv = { ...fixtureEnv('false'), ...change };
    expect(() => installE4DiagnosticFixtureGate(context(), env)).toThrow();
    expect(env.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('false');
  });
});
describe('E4 diagnostic instance budget (offline)', () => {
  it.each([
    { purpose: 'FORMAL' },
    { appEnv: 'production' },
    { scope: 'app_test' },
    { sourceHead: 'missing' },
    { databaseUrl: 'postgresql://prod.example/app_test_w98' },
    { databaseUrl: 'postgresql://localhost/production' },
    { databaseUrl: 'postgresql://localhost/app_test_w1' },
  ])(
    'rejects a non-diagnostic/production/unassigned context before installing anything: %p',
    (change) => {
      expect(() => e4DiagnosticContext({ ...input, ...change })).toThrow();
    },
  );
  it('changes only one instance timeout, preserving callback, receiver, original Promise and options', async () => {
    const promise = Promise.resolve('opaque');
    const original = jest.fn<Promise<string>, unknown[]>(() => promise);
    const client = { $transaction: original },
      other = { $transaction: original };
    const descriptor = Object.getOwnPropertyDescriptor(client, '$transaction');
    const limits = installE4DiagnosticLimits(client, context());
    const callback = () => Promise.resolve(undefined);
    const options = Object.freeze({
      timeout: 30000,
      maxWait: 2000,
      isolationLevel: 'ReadCommitted',
    });
    expect(limits.client.$transaction(callback, options)).toBe(promise);
    await promise;
    expect(original.mock.contexts[0]).toBe(client);
    expect(original).toHaveBeenCalledWith(callback, { ...options, timeout: 90000 });
    expect(options.timeout).toBe(30000);
    expect(other.$transaction).toBe(original);
    expect(() => limits.client.$transaction(callback, options)).toThrow();
    limits.restore();
    limits.restore();
    expect(Object.getOwnPropertyDescriptor(client, '$transaction')).toEqual(descriptor);
    expect(limits.client.$transaction(callback, options)).toBe(promise);
    expect(original).toHaveBeenLastCalledWith(callback, options);
    expect(limits.snapshot()).toMatchObject({
      acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
      calls: 1,
      restored: true,
      ownership: true,
    });
  });
  it('preserves the original thrown error and rejects other budgets/batch transactions', () => {
    const error = new Error('opaque');
    const original = jest.fn(() => {
      throw error;
    });
    const client = { $transaction: original };
    const limits = installE4DiagnosticLimits(client, context());
    expect(() =>
      Reflect.apply(limits.client.$transaction, limits.client, [
        () => undefined,
        { timeout: 30000 },
      ]),
    ).toThrow(error);
    limits.restore();
    for (const args of [
      [[], { timeout: 30000 }],
      [() => undefined, { timeout: 90000 }],
      [() => undefined, { timeout: 5000 }],
    ]) {
      const original = jest.fn();
      const c = { $transaction: original };
      const l = installE4DiagnosticLimits(c, context());
      expect(() => Reflect.apply(l.client.$transaction, l.client, args)).toThrow();
      expect(original).not.toHaveBeenCalled();
      l.restore();
    }
  });
  it('does not overwrite another owner on restore', () => {
    const client = { $transaction: () => undefined };
    const limits = installE4DiagnosticLimits(client, context());
    const replacement = () => undefined;
    client.$transaction = replacement;
    limits.restore();
    expect(client.$transaction).toBe(replacement);
    expect(limits.snapshot().ownership).toBe(false);
  });
  it('accepts and restores an actual Prisma proxy without connecting or running a query', async () => {
    const client = new PrismaClient({ datasources: { db: { url: input.databaseUrl } } });
    const original: unknown = Reflect.get(client, '$transaction');
    const limits = installE4DiagnosticLimits(client, context());
    limits.restore();
    expect(Reflect.get(client, '$transaction')).toBe(original);
    await client.$disconnect();
  });
});
describe('E4 independent600s process deadline (offline)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  function childFixture() {
    let listener: (code: number | null) => void = () => undefined,
      alive = true;
    const signals: string[] = [];
    const child: E4DiagnosticChild = {
      onClose: (cb) => {
        listener = cb;
      },
      signal: (s) => signals.push(s),
      groupAlive: () => alive,
    };
    return {
      child,
      signals,
      close: (code: number | null = 0) => {
        alive = false;
        listener(code);
      },
      rootOnlyClosed: () => listener(0),
    };
  }
  it('clears every watchdog timer after normal exit', async () => {
    const f = childFixture();
    const result = superviseE4DiagnosticChild(f.child);
    f.close();
    await expect(result).resolves.toEqual({ exitCode: 0, stopped: false, cleanupConfirmed: true });
    expect(jest.getTimerCount()).toBe(0);
    expect(f.signals).toEqual([]);
  });
  it('stops a blocked child from its independent parent, force-kills before600s, and waits for exit', async () => {
    const f = childFixture();
    const result = superviseE4DiagnosticChild(f.child);
    jest.advanceTimersByTime(E4_DIAGNOSTIC_LIMITS.gracefulStopMs);
    expect(f.signals).toEqual(['SIGTERM']);
    jest.advanceTimersByTime(
      E4_DIAGNOSTIC_LIMITS.forcedStopMs - E4_DIAGNOSTIC_LIMITS.gracefulStopMs,
    );
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    f.close(null);
    await expect(result).resolves.toMatchObject({ stopped: true, cleanupConfirmed: true });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not claim cleanup if a process group still survives the hard deadline', async () => {
    const f = childFixture();
    const result = superviseE4DiagnosticChild(f.child);
    jest.advanceTimersByTime(600000);
    await expect(result).resolves.toMatchObject({ stopped: true, cleanupConfirmed: false });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('kills remaining descendants after the root exits, rather than calling that a clean exit', async () => {
    const f = childFixture();
    const result = superviseE4DiagnosticChild(f.child);
    f.rootOnlyClosed();
    expect(f.signals).toEqual(['SIGKILL']);
    f.close();
    jest.advanceTimersByTime(100);
    await expect(result).resolves.toMatchObject({ stopped: true, cleanupConfirmed: true });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('E4 real independent parent shutdown (offline, no database)', () => {
  it('terminates a CPU-blocked child process group and leaves no watchdog handles', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); process.send('ready'); for (;;) {}"],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const emergency = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
    }, 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
      });
      const signals: string[] = [];
      const result = await superviseE4DiagnosticChild(
        {
          onClose: (callback) => child.once('close', callback),
          signal: (kind) => {
            signals.push(kind);
            process.kill(-child.pid!, kind);
          },
          groupAlive: () => {
            try {
              process.kill(-child.pid!, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
              throw error;
            }
          },
        },
        {
          after: (ms, callback) =>
            setTimeout(
              callback,
              ms === 560000 ? 50 : ms === 590000 ? 100 : ms === 600000 ? 2000 : ms,
            ),
          clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      );
      expect(result).toMatchObject({ stopped: true, cleanupConfirmed: true });
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      clearTimeout(emergency);
      if (child.exitCode === null && child.signalCode === null && child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Own child already gone. */
        }
    }
  }, 10000);
});
