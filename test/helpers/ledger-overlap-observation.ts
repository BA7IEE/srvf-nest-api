import { execFile, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { deriveTestDbName } from '../setup/worktree-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';

export interface OverlapTarget {
  database: string;
  oid: number;
  pid: number;
  backendStart: string;
}

export interface NativeObservationRequest {
  database: string;
  applicationName: string;
  sql: string;
  timeout: number;
  maxBuffer: number;
}

type NativeRunner = (request: NativeObservationRequest) => Promise<string>;
type NativeLauncher = (
  request: NativeObservationRequest,
  done: (failed: boolean, stdout: string) => void,
) => ChildProcess;

export class NativeObservationError extends Error {
  constructor(readonly closed: boolean) {
    super('Overlap observer client failed or exceeded its window');
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isOverlapStatement(parts: readonly string[]): boolean {
  const sql = parts.join('?');
  return (
    /^\s*SELECT 1 AS conflict\b/u.test(sql) &&
    sql.includes('"ParticipantServiceSegmentRevision" existing') &&
    sql.includes('"ActivityParticipationIdentity" existing_identity') &&
    sql.includes('"ActivityParticipationIdentity" candidate_identity') &&
    sql.includes('"ParticipantServiceSegmentRevision" candidate') &&
    /\bLIMIT 1\s*$/u.test(sql)
  );
}

export function observationRequest(
  target: OverlapTarget,
  cleanup = false,
): NativeObservationRequest {
  if (
    !/^app_test(?:_[a-z0-9]+)*$/u.test(target.database) ||
    target.database.length > 63 ||
    !positiveInteger(target.oid) ||
    !positiveInteger(target.pid) ||
    typeof target.backendStart !== 'string' ||
    target.backendStart.length === 0
  ) {
    throw new Error('Invalid overlap observation identity');
  }
  const application = `srvf-overlap-observer-${target.pid}`;
  const content = cleanup
    ? `json_build_object('remaining_clients', (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name='${application}'), 'remaining_locks', (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND a.application_name='${application}'))`
    : `json_build_object('sampler_pid',pg_backend_pid(),'target',(SELECT row_to_json(t) FROM (SELECT pid,datid::int,backend_start::text,state,wait_event_type,wait_event,query_start::text,pg_blocking_pids(pid) AS blockers,query ~ '^\\s*SELECT 1 AS conflict' AS is_overlap FROM pg_stat_activity WHERE pid=${target.pid} AND datid=${target.oid}) t))`;
  return {
    database: target.database,
    applicationName: cleanup ? 'srvf-overlap-cleanup' : application,
    timeout: 750,
    maxBuffer: 16_384,
    sql: `BEGIN READ ONLY; SET LOCAL statement_timeout='100ms'; SELECT json_build_object('database',current_database(),'oid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),'unix',inet_server_addr() IS NULL,'readonly',current_setting('transaction_read_only')='on','data',${content}); ROLLBACK;\n\\q\n`,
  };
}

const launchNative: NativeLauncher = (request, done) =>
  execFile(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGAPPNAME=${request.applicationName}`,
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      request.database,
    ],
    { killSignal: 'SIGKILL', maxBuffer: request.maxBuffer, encoding: 'utf8' },
    (error, stdout) => {
      done(Boolean(error), stdout);
    },
  );

/** Settle on our deadline independently; success also requires confirmed process close. */
export function executeObservation(
  request: NativeObservationRequest,
  launch: NativeLauncher = launchNative,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let closed = false,
      callback = false,
      failed = false,
      settled = false,
      stdout = '';
    const settle = (expired = false) => {
      if (settled || (!expired && !(closed && callback))) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (expired || failed) reject(new NativeObservationError(closed));
      else resolve(stdout);
    };
    const killOwnedChild = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* Closing remains unconfirmed. */
      }
    };
    const timer = setTimeout(() => {
      killOwnedChild();
      settle(true);
    }, request.timeout);
    try {
      child = launch(request, (error, output) => {
        callback = true;
        failed ||= error;
        stdout = output;
        settle();
      });
      child.once('close', () => {
        closed = true;
        settle();
      });
      child.stdin?.once('error', () => {
        failed = true;
        killOwnedChild();
      });
      if (!child.stdin) {
        failed = true;
        killOwnedChild();
      } else child.stdin.end(request.sql);
    } catch {
      failed = true;
      if (child) killOwnedChild();
      else {
        closed = true;
        callback = true;
        settle();
      }
    }
  });
}

const nativeRunner: NativeRunner = async (request) => {
  if (request.database !== deriveTestDbName())
    throw new Error('Overlap observer database mismatch');
  assertNamedTestDatabaseScope([request.database]);
  return executeObservation(request);
};

/** Accept only fixed server metadata. Never retain query text, bindings or stderr. */
export function parseObservation(raw: string, target: OverlapTarget, cleanup = false): unknown {
  const row: unknown = JSON.parse(raw);
  if (!row || typeof row !== 'object') throw new Error('Invalid overlap observation');
  const value = row as Record<string, unknown>;
  if (
    value.database !== target.database ||
    value.oid !== target.oid ||
    value.unix !== true ||
    value.readonly !== true
  )
    throw new Error('Overlap observer server mismatch');
  const data = value.data as Record<string, unknown> | null;
  if (!data) throw new Error('Missing overlap observation');
  if (cleanup) {
    if (data.remaining_clients !== 0 || data.remaining_locks !== 0)
      throw new Error('Overlap observer cleanup unconfirmed');
    return { remainingClients: 0, remainingLocks: 0 };
  }
  if (!positiveInteger(data.sampler_pid)) throw new Error('Invalid sampler identity');
  if (data.target === null) return { target: null };
  const backend = data.target as Record<string, unknown>;
  if (
    !backend ||
    backend.pid !== target.pid ||
    backend.datid !== target.oid ||
    backend.backend_start !== target.backendStart ||
    typeof backend.is_overlap !== 'boolean' ||
    !Array.isArray(backend.blockers) ||
    !backend.blockers.every(positiveInteger)
  )
    throw new Error('Overlap target identity changed');
  const metadata = ['state', 'wait_event_type', 'wait_event', 'query_start'];
  if (metadata.some((key) => backend[key] !== null && typeof backend[key] !== 'string'))
    throw new Error('Invalid backend metadata');
  return {
    target: {
      pid: target.pid,
      state: backend.state,
      waitType: backend.wait_event_type,
      waitEvent: backend.wait_event,
      queryStart: backend.query_start,
      isOverlap: backend.is_overlap,
      blockers: [...backend.blockers],
    },
  };
}

export class LedgerOverlapObservation {
  readonly frames: Array<{ elapsedMs: number; roundtripMs: number; value: unknown }> = [];
  readonly receipt = {
    status: 'NOT_STARTED',
    attempts: 0,
    droppedAfterStop: 0,
    cleanup: 'NOT_RUN',
    roundtripMsSum: 0,
    roundtripMsMax: 0,
    clientClose: 'CONFIRMED_OR_NOT_STARTED',
  };
  private stopped = false;
  private target?: OverlapTarget;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  private finishing?: Promise<void>;

  constructor(
    private readonly run: NativeRunner = nativeRunner,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(target: OverlapTarget): void {
    if (this.running) throw new Error('Overlap observer already started');
    observationRequest(target);
    this.target = target;
    this.receipt.status = 'RUNNING';
    const started = this.now();
    this.running = (async () => {
      try {
        while (!this.stopped && this.receipt.attempts < 20 && this.now() - started < 10_000) {
          this.receipt.attempts++;
          const began = this.now();
          let raw: string;
          try {
            raw = await this.run(observationRequest(target));
          } finally {
            const duration = this.now() - began;
            this.receipt.roundtripMsSum += duration;
            this.receipt.roundtripMsMax = Math.max(this.receipt.roundtripMsMax, duration);
          }
          if (this.now() - began > 750)
            throw new Error('Overlap observer response window exceeded');
          if (this.stopped) {
            this.receipt.droppedAfterStop++;
            break;
          }
          this.frames.push({
            elapsedMs: began - started,
            roundtripMs: this.now() - began,
            value: parseObservation(raw, target),
          });
          await new Promise<void>((resolve) => {
            if (this.stopped) {
              resolve();
              return;
            }
            this.wake = resolve;
            this.timer = setTimeout(
              resolve,
              Math.min(500, Math.max(0, 10_000 - (this.now() - started))),
            );
          });
        }
        this.receipt.status = this.frames.some(
          ({ value }) =>
            value && typeof value === 'object' && 'target' in value && value.target !== null,
        )
          ? 'OBSERVED'
          : this.frames.length
            ? 'NO_TARGET'
            : 'NO_FRAME';
      } catch (error) {
        if (error instanceof NativeObservationError && !error.closed)
          this.receipt.clientClose = 'UNKNOWN';
        this.receipt.status = 'UNKNOWN';
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  finish(): Promise<void> {
    this.stop();
    this.finishing ??= this.complete();
    return this.finishing;
  }

  private async complete(): Promise<void> {
    await this.running;
    if (!this.target) return;
    try {
      parseObservation(await this.run(observationRequest(this.target, true)), this.target, true);
      this.receipt.cleanup = this.receipt.status === 'UNKNOWN' ? 'ZERO_AT_CHECK' : 'VERIFIED';
    } catch (error) {
      if (error instanceof NativeObservationError && !error.closed)
        this.receipt.clientClose = 'UNKNOWN';
      this.receipt.cleanup = 'UNKNOWN';
      this.receipt.status = 'UNKNOWN';
    }
  }
}

/** Plan first, then consume the original lazy query once, including with multiple consumers. */
export function observeLazyQuery<T>(
  original: PromiseLike<T>,
  prepare: () => Promise<void>,
  start: () => void,
  stop: () => void,
): PromiseLike<T> {
  let pending: Promise<T> | undefined;
  return {
    then(fulfilled, rejected) {
      pending ??= (async () => {
        await prepare();
        start();
        try {
          return await original;
        } finally {
          stop();
        }
      })();
      return pending.then(fulfilled, rejected);
    },
  };
}
