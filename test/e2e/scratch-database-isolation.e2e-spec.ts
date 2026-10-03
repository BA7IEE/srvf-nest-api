import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  acquireScratchDatabaseLease,
  openScratchDatabaseSession,
  type ScratchLeaseSession,
} from '../helpers/scratch-database-lease';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
import { deriveWorkerTestDbName } from '../setup/worktree-db';

function lockCount(pid: number, granted: boolean): number {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid fixture backend identity');
  const value = execFileSync(
    'docker',
    [
      'exec',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SELECT count(*) FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND granted=${granted}
     AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  ).trim();
  if (!/^\d+$/.test(value)) throw new Error('Unable to read fixture lock state');
  return Number(value);
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture lock barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function dropWithBoundedEvidence(session: ScratchLeaseSession): Promise<void> {
  let complete = false;
  const drop = session.dropDatabase().finally(() => {
    complete = true;
  });
  void drop.catch(() => undefined);
  for (const delay of [100, 1000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (complete) break;
    const pid = session.backendPid!;
    const value = execFileSync(
      'docker',
      [
        'exec',
        'u-nest-api-postgres',
        'psql',
        '--no-psqlrc',
        '-qtA',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT state || '|' || coalesce(wait_event_type,'') || '|' || coalesce(wait_event,'')
       FROM pg_stat_activity WHERE pid=${pid} AND datname=current_database()`,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    const allowed = /^[a-z ]*\|[A-Za-z]*\|[A-Za-z0-9]*$/;
    console.info(
      '[scratch-drop-wait] ' +
        JSON.stringify({
          sample: delay,
          state: allowed.test(value) ? value : 'unknown',
        }),
    );
  }
  await drop;
}

describe('scratch database physical-process isolation', () => {
  let holder: ScratchLeaseSession | undefined;
  let contender: ScratchLeaseSession | undefined;
  let active: PrismaClient | undefined;
  const target = deriveWorkerTestDbName(98);

  afterEach(async () => {
    await active?.$disconnect();
    active = undefined;
    await contender?.release();
    contender = undefined;
    await holder?.release();
    holder = undefined;
    // Cleanup is itself fenced by a newly acquired live session, never FORCE.
    const cleanup = await acquireScratchDatabaseLease(5000);
    try {
      await cleanup.dropDatabase();
    } finally {
      await cleanup.release();
    }
  });

  it('two maintenance processes serialize the full w98 lifecycle; the waiter sends no DROP', async () => {
    let phase = 'holder_acquire';
    holder = await acquireScratchDatabaseLease(5000);
    phase = 'holder_drop';
    await holder.dropDatabase();
    phase = 'holder_create';
    await holder.createDatabase();
    phase = 'contender_connect';
    contender = openScratchDatabaseSession();
    let acquired = false;
    const waiting = contender.acquire(5000).then(() => {
      acquired = true;
    });
    void waiting.catch(() => undefined);
    try {
      await until(() => contender?.backendPid !== undefined);
      phase = 'waiter_lock_barrier';
      await until(() => lockCount(contender!.backendPid!, false) === 1);
      expect(lockCount(holder.backendPid!, true)).toBe(1);
      expect(acquired).toBe(false);
      await expect(contender.dropDatabase()).rejects.toThrow('operation refused');
      phase = 'holder_release';
      await holder.release();
      holder = undefined;
      phase = 'contender_acquire';
      await waiting;
      expect(acquired).toBe(true);
      expect(lockCount(contender.backendPid!, true)).toBe(1);
      phase = 'contender_drop';
      await dropWithBoundedEvidence(contender);
      phase = 'contender_create';
      await contender.createDatabase();
    } catch (error) {
      console.info('[scratch-isolation-stage] ' + JSON.stringify({ phase, acquired }));
      throw error;
    } finally {
      if (!acquired) contender.abort();
      await waiting.catch(() => undefined);
    }
  });

  it('ordinary DROP refuses a live foreign connection without killing it', async () => {
    holder = await acquireScratchDatabaseLease(5000);
    await holder.dropDatabase();
    await holder.createDatabase();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + target;
    active = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await active.$connect();
    await assertConnectedTestDatabase(active, target);
    const before = await active.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await expect(holder.dropDatabase()).rejects.toThrow('session ended');
    const after = await active.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    expect(after).toEqual(before);
    await expect(active.$queryRaw`SELECT 1 AS alive`).resolves.toEqual([{ alive: 1 }]);
  });

  it('an aborted lock holder cannot send later lifecycle commands', async () => {
    holder = await acquireScratchDatabaseLease(5000);
    const pid = holder.backendPid!;
    holder.abort();
    await expect(holder.createDatabase()).rejects.toThrow('lease lost');
    await expect(holder.dropDatabase()).rejects.toThrow('lease lost');
    await until(() => lockCount(pid, true) === 0);
    contender = await acquireScratchDatabaseLease(5000);
    expect(contender.backendPid).not.toBe(pid);
  });
});
