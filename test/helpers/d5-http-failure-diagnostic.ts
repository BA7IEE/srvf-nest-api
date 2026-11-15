import type { LoggerService } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

const ERROR_TYPES = [
  'Error',
  'TypeError',
  'RangeError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
] as const;
const DATABASE_CODES = [
  'P2002',
  'P2003',
  'P2010',
  'P2024',
  'P2028',
  'P2034',
  '23503',
  '23505',
  '40001',
  '40P01',
  '53200',
  '53300',
  '55P03',
  '57014',
] as const;
const HINTS = [
  ['transaction_closed', /Transaction already closed|expired transaction/i],
  ['transaction_start', /Unable to start a transaction/i],
  ['pool_timeout', /Timed out fetching a new connection/i],
  ['statement_timeout', /statement timeout/i],
  ['lock_timeout', /lock timeout/i],
  ['deadlock', /deadlock detected/i],
] as const;
const LOCATIONS = [
  'src/modules/activities/activity-time-settlement.service.ts',
  'src/modules/activities/activity-time-settlement-query.service.ts',
  'src/modules/activities/activity-time-settlement-access.service.ts',
  'src/modules/activities/activity-time-allocation.service.ts',
  'src/modules/activities/activity-contribution-settlement.service.ts',
  'src/modules/attendances/participation-segment.facade.ts',
] as const;

export type D5RequestContext = { phase: 'prepare' | 'submit'; population: 1 | 100 | 2000 };
type Signals = {
  errorType: string;
  databaseCodes: string[];
  hints: string[];
  repositoryLocations: string[];
};
export type D5HttpFailureRecord = D5RequestContext &
  Signals & {
    status: number;
    code: number | null;
    elapsedMs: number;
  };
type HttpResponse = { status: number; body: unknown };

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function signals(stack = '', message = ''): Signals {
  const text = `${stack.slice(0, 32768)}\n${message.slice(0, 32768)}`;
  const frames = stack.split('\n').filter((line) => /^\s+at /.test(line));
  return {
    errorType: ERROR_TYPES.find((type) => stack.startsWith(`${type}:`)) ?? 'UnknownError',
    databaseCodes: DATABASE_CODES.filter((code) => new RegExp(`\\b${code}\\b`).test(text)),
    hints: HINTS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label),
    repositoryLocations: LOCATIONS.flatMap((path) => {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|[/(])${escaped}:(\\d{1,7}):(\\d{1,7})(?:\\)|$)`).exec(
        frames.join('\n'),
      );
      return match ? [`${path}:${match[1]}:${match[2]}`] : [];
    }),
  };
}

/** Test-only request scope; output contains allowlisted signals, never raw errors or bodies. */
export function createD5HttpFailureDiagnostic(emit: (record: D5HttpFailureRecord) => void) {
  let active: { stack: string } | undefined;
  const noop = () => undefined;
  const logger: LoggerService = {
    log: noop,
    warn: noop,
    debug: noop,
    verbose: noop,
    fatal: noop,
    error: (message: unknown, ...params: unknown[]) => {
      if (!active || active.stack || message !== 'Unhandled exception') return;
      const stack = params.find((value): value is string => typeof value === 'string');
      active.stack = stack?.slice(0, 32768) ?? '';
    },
  };
  return {
    logger,
    async capture<T extends HttpResponse>(
      context: D5RequestContext,
      work: () => Promise<T>,
    ): Promise<T> {
      const previous = active;
      const frame = { stack: '' };
      active = frame;
      const started = performance.now();
      try {
        const response = await work();
        const code = ownValue(response.body, 'code');
        if (response.status !== 200 || code !== 0) {
          const message = ownValue(response.body, 'message');
          const record: D5HttpFailureRecord = {
            phase: context.phase,
            population: context.population,
            status: response.status,
            code: typeof code === 'number' && Number.isFinite(code) ? code : null,
            elapsedMs: Math.round(performance.now() - started),
            ...signals(frame.stack, typeof message === 'string' ? message : ''),
          };
          try {
            emit(record);
          } catch {
            // Diagnostics must not replace the original HTTP response or its assertion failure.
          }
        }
        return response;
      } finally {
        active = previous;
      }
    },
  };
}
