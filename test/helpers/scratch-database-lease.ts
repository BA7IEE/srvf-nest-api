import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  assertDroppableTestDbName,
  assertLocalPostgresServer,
  dropWorkerDatabase,
} from '../setup/test-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';
import { deriveTemplateTestDbName, deriveWorkerTestDbName } from '../setup/worktree-db';

// Keep the existing instance-wide D3 key: its four fixture roles are instance-wide too.
const W98_LEASE_KEY = 'SRVF:test:D3:app_test_w98';
const CONTAINER = 'u-nest-api-postgres';

export interface ScratchSessionTransport {
  send(this: void, value: string): void;
  close(this: void): Promise<void>;
  stop(this: void): void;
  onData(listener: (value: string) => void): void;
  onClosed(listener: () => void): void;
}

/** One maintenance backend owns both the advisory lock and every scratch lifecycle DDL. */
export class ScratchLeaseSession {
  private readonly marker = 'SRVF_LEASE_' + randomUUID().replaceAll('-', '');
  private sequence = 0;
  private closed = false;
  private acquired = false;
  private pid?: number;
  private buffer = '';
  private pending?: {
    marker: string;
    rows: string[];
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(private readonly transport: ScratchSessionTransport) {
    transport.onData((value) => this.receive(value));
    transport.onClosed(() => this.invalidate());
  }

  private invalidate(): void {
    this.closed = true;
    this.acquired = false;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(
        new Error('Scratch maintenance session ended; no further operation allowed'),
      );
      this.pending = undefined;
    }
  }

  private receive(value: string): void {
    this.buffer += value;
    if (this.buffer.length > 16_384) {
      this.invalidate();
      this.transport.stop();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending;
      if (!pending) continue;
      if (line === pending.marker) {
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(pending.rows.filter(Boolean).join('\n'));
      } else {
        pending.rows.push(line);
      }
    }
  }

  private execute(sql: string, timeoutMs = 30_000): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Scratch lease session is no longer live'));
    if (this.pending)
      return Promise.reject(new Error('Concurrent scratch lifecycle operation refused'));
    return new Promise((resolve, reject) => {
      const marker = this.marker + '_' + ++this.sequence;
      const timer = setTimeout(() => {
        this.invalidate();
        this.transport.stop();
      }, timeoutMs);
      this.pending = { marker, rows: [], resolve, reject, timer };
      try {
        this.transport.send(sql + '\n\\echo ' + marker + '\n');
      } catch {
        this.invalidate();
        this.transport.stop();
      }
    });
  }

  async acquire(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110_000) {
      throw new Error('Invalid scratch lease acquisition budget');
    }
    const identity = await this.execute(
      "SELECT current_database() || '|' || coalesce(host(inet_server_addr()), '');",
    );
    if (identity !== 'postgres|') {
      await this.release();
      throw new Error('Scratch maintenance connection identity mismatch');
    }
    const pid = Number(await this.execute('SELECT pg_backend_pid();'));
    if (!Number.isInteger(pid) || pid <= 0) {
      await this.release();
      throw new Error('Scratch maintenance backend identity unavailable');
    }
    this.pid = pid;
    await this.execute(
      `SET statement_timeout = '${timeoutMs}ms';\n` +
        `SELECT pg_advisory_lock(hashtextextended('${W98_LEASE_KEY}', 0));`,
      timeoutMs,
    );
    // Lifecycle DDL may wait for PostgreSQL's checkpoint. This is a bounded
    // maintenance session, not an application transaction; existing hook budgets remain unchanged.
    await this.execute('SET statement_timeout = 30000;');
    this.acquired = true;
  }

  assertHeld(): void {
    if (!this.acquired || this.closed) throw new Error('Scratch lease lost; operation refused');
  }

  get backendPid(): number | undefined {
    return this.pid;
  }

  abort(): void {
    this.invalidate();
    this.transport.stop();
  }

  private target(): string {
    this.assertHeld();
    const name = deriveWorkerTestDbName(98);
    assertDroppableTestDbName(name);
    assertNamedTestDatabaseScope([name]);
    return name;
  }

  async dropDatabase(): Promise<void> {
    const name = this.target();
    // This same backend still holds the lock. Normal DROP closes the connection-count race
    // without terminating another process, including a holder surviving a lost lease child.
    await this.execute(`DROP DATABASE IF EXISTS "${name}";`);
  }

  async createDatabase(): Promise<void> {
    const name = this.target();
    await this.execute(`CREATE DATABASE "${name}";`);
  }

  async cloneDatabase(): Promise<void> {
    const name = this.target();
    const template = deriveTemplateTestDbName();
    assertDroppableTestDbName(template);
    assertNamedTestDatabaseScope([name, template]);
    await this.execute(`CREATE DATABASE "${name}" TEMPLATE "${template}";`);
  }

  async release(): Promise<void> {
    if (this.pending) {
      this.invalidate();
      this.transport.stop();
      return;
    }
    this.acquired = false;
    if (this.closed) return;
    try {
      await this.transport.close();
    } finally {
      this.invalidate();
    }
  }
}

export function openScratchDatabaseSession(): ScratchLeaseSession {
  const database = deriveWorkerTestDbName(98);
  assertDroppableTestDbName(database);
  assertNamedTestDatabaseScope([database]);
  assertLocalPostgresServer();
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      CONTAINER,
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume(); // Never expose URLs, raw SQL, parameters or fixture values.
  const session = new ScratchLeaseSession({
    send: (value) => {
      if (child.exitCode !== null || child.killed || !child.stdin.writable) {
        throw new Error('Scratch maintenance process is not writable');
      }
      child.stdin.write(value);
    },
    stop: () => {
      child.kill();
    },
    onData: (listener) => {
      child.stdout.on('data', (value: Buffer) => listener(value.toString()));
    },
    onClosed: (listener) => {
      child.once('exit', listener);
      child.once('error', listener);
      child.stdin.once('error', listener);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) {
          if (child.exitCode === 0) resolve();
          else reject(new Error('Scratch maintenance close failed'));
          return;
        }
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Scratch maintenance close timed out'));
        }, 10_000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error('Scratch maintenance close failed'));
        });
        child.stdin.end('\\q\n');
      }),
  });
  return session;
}

export async function acquireScratchDatabaseLease(
  timeoutMs = 110_000,
): Promise<ScratchLeaseSession> {
  const session = openScratchDatabaseSession();
  try {
    await session.acquire(timeoutMs);
    return session;
  } catch (error) {
    await session.release();
    throw error;
  }
}

/** Register at file root; call finish() at file end, after all cleanup hooks. */
export function installScratchDatabaseLease(enabled: boolean) {
  let session: ScratchLeaseSession | undefined;
  if (enabled) {
    beforeAll(async () => {
      session = await acquireScratchDatabaseLease();
    }, 120_000);
  }
  const held = () => {
    if (!session) throw new Error('Scratch lifecycle lease was not acquired');
    session.assertHeld();
    return session;
  };
  return {
    finish(): void {
      if (enabled)
        afterAll(async () => {
          await session?.release();
        }, 120_000);
    },
    async drop(worker: string | number): Promise<void> {
      if (!enabled) {
        dropWorkerDatabase(worker);
        return;
      }
      if (String(worker) !== '98') throw new Error('Scratch lifecycle worker mismatch');
      await held().dropDatabase();
    },
    async create(database: string): Promise<void> {
      if (!enabled) {
        assertDroppableTestDbName(database);
        assertNamedTestDatabaseScope([database]);
        execFileSync('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', database], {
          stdio: 'pipe',
        });
        return;
      }
      if (database !== deriveWorkerTestDbName(98))
        throw new Error('Scratch lifecycle database mismatch');
      await held().createDatabase();
    },
    async clone(): Promise<void> {
      if (!enabled) throw new Error('Scratch clone requires explicit dedicated mode');
      await held().dropDatabase();
      await held().cloneDatabase();
    },
  };
}
