import { ScratchLeaseSession, type ScratchSessionTransport } from './scratch-database-lease';

function fakeTransport() {
  let data: (value: string) => void = () => undefined;
  let closed: () => void = () => undefined;
  const statements: string[] = [];
  let holdAcquire = false;
  const transport: ScratchSessionTransport = {
    send: (value) => {
      statements.push(value);
      if (holdAcquire && value.includes('pg_advisory_lock')) return;
      const marker = value
        .split('\n')
        .find((line) => line.startsWith('\\echo '))!
        .slice(6);
      const result = value.includes('current_database()')
        ? 'postgres|\n'
        : value.includes('SELECT pg_backend_pid()')
          ? '42\n'
          : '';
      data(result + marker + '\n');
    },
    onData: (listener) => {
      data = listener;
    },
    onClosed: (listener) => {
      closed = listener;
    },
    close: jest.fn(async () => {
      closed();
    }),
    stop: jest.fn(() => {
      closed();
    }),
  };
  return {
    transport,
    statements,
    lose: () => closed(),
    hold: () => {
      holdAcquire = true;
    },
  };
}

describe('scratch maintenance lease protocol (no database)', () => {
  const originalScope = process.env.SRVF_TEST_RUN_SCOPE;
  beforeEach(() => {
    process.env.SRVF_TEST_RUN_SCOPE = 'app_test_w98';
  });
  afterEach(() => {
    if (originalScope === undefined) delete process.env.SRVF_TEST_RUN_SCOPE;
    else process.env.SRVF_TEST_RUN_SCOPE = originalScope;
    jest.useRealTimers();
  });

  it('refuses lifecycle commands before lock acquisition', async () => {
    const fake = fakeTransport();
    const session = new ScratchLeaseSession(fake.transport);
    await expect(session.dropDatabase()).rejects.toThrow('operation refused');
    expect(fake.statements).toHaveLength(0);
    await session.release();
  });

  it('uses the existing instance-wide key and the same session for ordinary DROP and CREATE', async () => {
    const fake = fakeTransport();
    const session = new ScratchLeaseSession(fake.transport);
    await session.acquire(1000);
    await session.dropDatabase();
    await session.createDatabase();
    expect(fake.statements.some((value) => value.includes('SRVF:test:D3:app_test_w98'))).toBe(true);
    expect(fake.statements.filter((value) => value.includes('DROP DATABASE'))).toHaveLength(1);
    expect(fake.statements.some((value) => value.includes('WITH (FORCE)'))).toBe(false);
    expect(fake.statements.some((value) => value.includes('CREATE DATABASE "app_test_w98"'))).toBe(
      true,
    );
    await session.release();
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  it('loss after successful acquisition fences all later lifecycle calls', async () => {
    const fake = fakeTransport();
    const session = new ScratchLeaseSession(fake.transport);
    await session.acquire(1000);
    const previous = fake.statements.length;
    fake.lose();
    await expect(session.dropDatabase()).rejects.toThrow('lease lost');
    await expect(session.createDatabase()).rejects.toThrow('lease lost');
    expect(fake.statements).toHaveLength(previous);
    await session.release();
  });

  it('a waiting contender sends no lifecycle DDL and acquisition failure closes it', async () => {
    const fake = fakeTransport();
    fake.hold();
    const session = new ScratchLeaseSession(fake.transport);
    const acquisition = session.acquire(1000);
    await Promise.resolve();
    const rejected = expect(acquisition).rejects.toThrow('session ended');
    await expect(session.dropDatabase()).rejects.toThrow('operation refused');
    fake.lose();
    await rejected;
    expect(fake.statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
    await session.release();
  });

  it('acquisition timeout ends the process without any DROP', async () => {
    jest.useFakeTimers();
    const fake = fakeTransport();
    fake.hold();
    const session = new ScratchLeaseSession(fake.transport);
    const rejected = expect(session.acquire(1000)).rejects.toThrow('session ended');
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(fake.transport.stop).toHaveBeenCalledTimes(1);
    expect(fake.statements.some((value) => value.includes('DROP DATABASE'))).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('release prevents reuse and remains idempotent', async () => {
    const fake = fakeTransport();
    const session = new ScratchLeaseSession(fake.transport);
    await session.acquire(1000);
    await session.release();
    await session.release();
    await expect(session.dropDatabase()).rejects.toThrow('lease lost');
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a scratch target missing from the declared scope', async () => {
    const fake = fakeTransport();
    const session = new ScratchLeaseSession(fake.transport);
    await session.acquire(1000);
    process.env.SRVF_TEST_RUN_SCOPE = 'app_test_w1';
    await expect(session.createDatabase()).rejects.toThrow('超出已声明范围');
    expect(fake.statements.some((value) => value.includes('CREATE DATABASE'))).toBe(false);
    await session.release();
  });
});
