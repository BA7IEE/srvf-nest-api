import {
  isOverlapStatement,
  LedgerOverlapObservation,
  observationRequest,
  observeLazyQuery,
  parseObservation,
  executeObservation,
  NativeObservationError,
  type OverlapTarget,
  type NativeObservationRequest,
} from './ledger-overlap-observation';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

const target: OverlapTarget = {
  database: 'app_test_observation_w1',
  oid: 123,
  pid: 456,
  backendStart: '2026-10-27 00:00:00+00',
};
const frame = () =>
  JSON.stringify({
    database: target.database,
    oid: target.oid,
    unix: true,
    readonly: true,
    data: {
      sampler_pid: 789,
      target: {
        pid: target.pid,
        datid: target.oid,
        backend_start: target.backendStart,
        state: 'active',
        wait_event_type: 'Lock',
        wait_event: 'relation',
        query_start: '2026-10-27 00:00:01+00',
        blockers: [987],
        is_overlap: true,
        query: 'private payload must not escape',
      },
    },
  });
const cleanup = () =>
  JSON.stringify({
    database: target.database,
    oid: target.oid,
    unix: true,
    readonly: true,
    data: { remaining_clients: 0, remaining_locks: 0 },
  });

describe('ledger overlap observation', () => {
  afterEach(() => jest.useRealTimers());

  it('identifies the overlap SQL independently of the preceding member read', () => {
    const parts = [
      'SELECT 1 AS conflict FROM "ParticipantServiceSegmentRevision" existing JOIN "ActivityParticipationIdentity" existing_identity ON true JOIN "ActivityParticipationIdentity" candidate_identity ON true JOIN "ParticipantServiceSegmentRevision" candidate ON true WHERE x = ',
      ' LIMIT 1',
    ];
    expect(isOverlapStatement(parts)).toBe(true);
    expect(
      isOverlapStatement([
        'SELECT DISTINCT i."memberId" FROM "ParticipantServiceSegmentRevision" s',
      ]),
    ).toBe(false);
    expect(isOverlapStatement(['EXPLAIN (FORMAT JSON) ', ...parts])).toBe(false);
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/activities/ledger-posting.service.ts'),
      'utf8',
    );
    const body = source.match(
      /private async assertNoCrossActivitySegmentOverlap\([\s\S]*?\n {2}}/,
    )?.[0];
    const sql = body?.match(/\$queryRaw[\s\S]*?`([\s\S]*?)`;/)?.[1];
    expect(sql).toBeDefined();
    expect(isOverlapStatement(sql!.split(/\$\{[^}]+\}/u))).toBe(true);
  });

  it('bounds native client/SQL/output and only interpolates numeric server identities', () => {
    const request = observationRequest(target);
    expect(request.timeout).toBe(750);
    expect(request.maxBuffer).toBe(16384);
    expect(request.applicationName).toBe('srvf-overlap-observer-456');
    expect(request.sql).toContain('BEGIN READ ONLY;');
    expect(request.sql).toContain("statement_timeout='100ms'");
    expect(request.sql).toContain('WHERE pid=456 AND datid=123');
    expect(request.sql).toContain('ROLLBACK;');
    expect(request.sql).not.toContain(target.backendStart);
    expect(() => observationRequest({ ...target, database: 'production' })).toThrow();
    expect(() => observationRequest({ ...target, pid: 1.5 })).toThrow();
    expect(() => observationRequest({ ...target, oid: 0 })).toThrow();
  });

  it('drops query text and rejects server, backend or epoch drift', () => {
    const output = parseObservation(frame(), target);
    expect(JSON.stringify(output)).not.toContain('private');
    expect(JSON.stringify(output)).not.toContain('query"');
    expect(() => parseObservation(frame(), { ...target, oid: 124 })).toThrow();
    expect(() => parseObservation(frame(), { ...target, backendStart: 'different' })).toThrow();
    expect(() => parseObservation('{', target)).toThrow();
    expect(() =>
      parseObservation(cleanup().replace('remaining_locks":0', 'remaining_locks":1'), target, true),
    ).toThrow();
  });

  it('consumes the original lazy query once and preserves its value for multiple consumers', async () => {
    let consumed = 0;
    const value = {};
    const original: PromiseLike<object> = {
      then(fulfilled, rejected) {
        consumed++;
        return Promise.resolve(value).then(fulfilled, rejected);
      },
    };
    const prepare = jest.fn(async () => undefined),
      start = jest.fn(),
      stop = jest.fn();
    const query = observeLazyQuery(original, prepare, start, stop);
    expect(consumed).toBe(0);
    const [a, b] = await Promise.all([query, query]);
    expect(a).toBe(value);
    expect(b).toBe(value);
    expect(consumed).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact original error and stops observation', async () => {
    const error = new Error('original failure');
    const stop = jest.fn();
    const original: PromiseLike<never> = {
      then(fulfilled, rejected) {
        return Promise.reject(error).then(fulfilled, rejected);
      },
    };
    const query = observeLazyQuery(
      original,
      async () => undefined,
      () => undefined,
      stop,
    );
    await expect(Promise.resolve(query)).rejects.toBe(error);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('caps sampling at twenty requests and ten seconds, then verifies cleanup', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const run = jest.fn(async (request: NativeObservationRequest) =>
      request.sql.includes('remaining_clients') ? cleanup() : frame(),
    );
    const observer = new LedgerOverlapObservation(run, () => Date.now());
    observer.start(target);
    await jest.advanceTimersByTimeAsync(15000);
    await Promise.all([observer.finish(), observer.finish()]);
    expect(observer.receipt.attempts).toBe(20);
    expect(observer.frames).toHaveLength(20);
    expect(observer.frames.at(-1)?.elapsedMs).toBe(9500);
    expect(run).toHaveBeenCalledTimes(21);
    expect(observer.receipt.cleanup).toBe('VERIFIED');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops immediately after a sampling failure and still checks cleanup', async () => {
    const run = jest.fn(async (request: NativeObservationRequest) => {
      if (request.sql.includes('remaining_clients')) return cleanup();
      throw new Error('sensitive native stderr must not escape');
    });
    const observer = new LedgerOverlapObservation(run);
    observer.start(target);
    await observer.finish();
    expect(observer.receipt.status).toBe('UNKNOWN');
    expect(observer.receipt.attempts).toBe(1);
    expect(observer.receipt.cleanup).toBe('ZERO_AT_CHECK');
    expect(JSON.stringify(observer)).not.toContain('sensitive');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('discards late results and reports unconfirmed cleanup without replacing business outcomes', async () => {
    let release: (raw: string) => void = () => undefined;
    const run = jest.fn((request: NativeObservationRequest) =>
      request.sql.includes('remaining_clients')
        ? Promise.reject(new Error('cleanup failed'))
        : new Promise<string>((resolve) => {
            release = resolve;
          }),
    );
    const observer = new LedgerOverlapObservation(run);
    observer.start(target);
    observer.stop();
    release(frame());
    await expect(observer.finish()).resolves.toBeUndefined();
    expect(observer.frames).toHaveLength(0);
    expect(observer.receipt.droppedAfterStop).toBe(1);
    expect(observer.receipt.status).toBe('UNKNOWN');
  });

  it('marks delayed responses unknown and stops rather than catching up in a burst', async () => {
    let now = 0;
    const observer = new LedgerOverlapObservation(
      async (request) => {
        if (request.sql.includes('remaining_clients')) return cleanup();
        now += 751;
        return frame();
      },
      () => now,
    );
    observer.start(target);
    await observer.finish();
    expect(observer.receipt.status).toBe('UNKNOWN');
    expect(observer.receipt.attempts).toBe(1);
    expect(observer.receipt.roundtripMsMax).toBe(751);
    expect(observer.frames).toHaveLength(0);
    expect(observer.receipt.cleanup).toBe('ZERO_AT_CHECK');
  });
  it('settles at its own deadline even if the child never closes', async () => {
    jest.useFakeTimers();
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    const kill = jest.fn(() => true);
    child.kill = kill;
    const pending = executeObservation(observationRequest(target), () => child);
    const rejected = expect(pending).rejects.toMatchObject({ closed: false });
    await jest.advanceTimersByTimeAsync(750);
    await rejected;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('requires close after normal output or stdin failure', async () => {
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.kill = jest.fn(() => true);
    let done: (failed: boolean, stdout: string) => void = () => undefined;
    const pending = executeObservation(observationRequest(target), (_request, callback) => {
      done = callback;
      return child;
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    done(false, 'complete');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0);
    await expect(pending).resolves.toBe('complete');
    const broken = new ChildProcess();
    broken.stdin = new PassThrough();
    const brokenKill = jest.fn(() => true);
    broken.kill = brokenKill;
    const failed = executeObservation(observationRequest(target), (_request, callback) => {
      done = callback;
      return broken;
    });
    const rejection = expect(failed).rejects.toBeInstanceOf(NativeObservationError);
    broken.stdin.emit('error', new Error('private input failure'));
    done(true, '');
    broken.emit('close', 1);
    await rejection;
    expect(brokenKill).toHaveBeenCalledWith('SIGKILL');
  });
});
