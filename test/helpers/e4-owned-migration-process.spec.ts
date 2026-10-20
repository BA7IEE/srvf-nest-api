import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { runE4OwnedMigrationProcess } from './e4-owned-migration-process';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: jest.fn(actual.readFileSync), writeSync: jest.fn() };
});

describe('E4 bounded migration process group', () => {
  const missing = () => {
    throw Object.assign(new Error('missing group'), { code: 'ESRCH' });
  };
  let child: EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  const fakeStat = (starttime = '123456', group = '12345') => {
    const fields = Array<string>(52).fill('0');
    fields[0] = 'S';
    fields[1] = '1';
    fields[2] = group;
    fields[19] = starttime;
    return '12345 (node) ' + fields.join(' ');
  };
  const actualFs = jest.requireActual<typeof import('node:fs')>('node:fs');
  let frames: string[];
  let kill: jest.SpiedFunction<typeof process.kill>;
  beforeEach(() => {
    jest.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    kill = jest.spyOn(process, 'kill').mockImplementation(missing);
    frames = [];
    jest
      .mocked(readFileSync)
      .mockImplementation(((file: unknown, ...args: unknown[]) =>
        file === '/proc/12345/stat'
          ? fakeStat()
          : Reflect.apply(actualFs.readFileSync, actualFs, [
              file,
              ...args,
            ])) as typeof readFileSync);
    jest.mocked(writeSync).mockImplementation(((_fd: number, bytes: Buffer) => {
      frames.push(bytes.toString());
      return bytes.length;
    }) as typeof writeSync);
  });
  afterEach(() => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('waits for successful process closure and verifies no owned descendants', async () => {
    const write = jest.spyOn(child.stdin, 'write');
    const end = jest.spyOn(child.stdin, 'end');
    const result = runE4OwnedMigrationProcess(['exec', 'prisma', 'migrate', 'deploy'], 1000);
    expect(write).toHaveBeenCalledWith('GO\n', expect.any(Function));
    expect(end).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    await expect(result).resolves.toBeUndefined();
    expect(jest.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ detached: true });
    expect(kill).toHaveBeenCalledWith(-12345, 0);
    expect(frames.map((line) => JSON.parse(line.split('[e4-owned-migration] ')[1]).event)).toEqual([
      'INTENT',
      'REGISTER',
      'RELEASE',
      'RESULT',
    ]);
  });

  it('accepts ESRCH from another realm after the owned process closes', async () => {
    const failure = runInNewContext(
      "Object.assign(new Error('missing'), { code: 'ESRCH' })",
    ) as unknown;
    expect(failure).not.toBeInstanceOf(Error);
    kill.mockImplementation(() => {
      throw failure;
    });
    const result = runE4OwnedMigrationProcess([], 1000);
    child.emit('close', 0, null);
    await expect(result).resolves.toBeUndefined();
  });

  it.each(['EPERM', undefined, 1, null])(
    'keeps an unverified cross-realm errno %s UNKNOWN',
    async (code) => {
      const failure = runInNewContext("Object.assign(new Error('unverified'), { code })", {
        code,
      }) as unknown;
      kill.mockImplementation(() => {
        throw failure;
      });
      const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
        processCleanupUnknown: true,
      });
      child.emit('close', 0, null);
      await rejected;
    },
  );

  it('terminates the entire owned group on timeout and retains a failed result', async () => {
    kill.mockImplementationOnce(() => true).mockImplementation(missing);
    const result = runE4OwnedMigrationProcess([], 1000);
    const rejected = expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });

  it('reports an unclosed process as UNKNOWN within the cleanup reserve', async () => {
    kill.mockReturnValue(true);
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      processCleanupUnknown: true,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await rejected;
    child.emit('close', null, 'SIGKILL');
  });

  it('refuses a green result while an owned descendant group remains', async () => {
    kill.mockReturnValue(true);
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      processCleanupUnknown: true,
    });
    child.emit('close', 0, null);
    await rejected;
  });

  it('retains nonzero command status and bounded output without converting failure into success', async () => {
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      status: 3,
      stdout: 'synthetic stdout',
      stderr: 'synthetic stderr',
    });
    child.stdout.write('synthetic stdout');
    child.stderr.write('synthetic stderr');
    child.emit('close', 3, null);
    await rejected;
  });

  it('does not spawn a wrapper after an incomplete INTENT write', async () => {
    jest.mocked(spawn).mockClear();
    jest.mocked(writeSync).mockReturnValue(0);
    await expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      processCleanupUnknown: true,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not release the CLI after an incomplete REGISTER write', async () => {
    jest.mocked(writeSync).mockImplementation(((_fd: number, bytes: Buffer) => {
      const line = bytes.toString();
      return line.includes('"event":"REGISTER"') ? bytes.length - 1 : bytes.length;
    }) as typeof writeSync);
    const write = jest.spyOn(child.stdin, 'write');
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      processCleanupUnknown: true,
    });
    expect(write).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });

  it('refuses a differing group before GO without signalling an unverified group', async () => {
    jest
      .mocked(readFileSync)
      .mockImplementation(((file: unknown, ...args: unknown[]) =>
        file === '/proc/12345/stat'
          ? fakeStat('123456', '12346')
          : Reflect.apply(actualFs.readFileSync, actualFs, [
              file,
              ...args,
            ])) as typeof readFileSync);
    const write = jest.spyOn(child.stdin, 'write');
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      processCleanupUnknown: true,
    });
    expect(write).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });

  it('refuses to signal a replaced leader identity on timeout', async () => {
    let reads = 0;
    jest
      .mocked(readFileSync)
      .mockImplementation(((file: unknown, ...args: unknown[]) =>
        file === '/proc/12345/stat'
          ? fakeStat(++reads === 1 ? '123456' : '654321')
          : Reflect.apply(actualFs.readFileSync, actualFs, [
              file,
              ...args,
            ])) as typeof readFileSync);
    const rejected = expect(runE4OwnedMigrationProcess([], 1000)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      processCleanupUnknown: true,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await rejected;
  });

  it('verifies an actual completed CLI process group under the Jest environment', async () => {
    jest.useRealTimers();
    kill.mockRestore();
    const realSpawn =
      jest.requireActual<typeof import('node:child_process')>('node:child_process').spawn;
    const realKill = process.kill.bind(process);
    let errno: unknown;
    kill = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      try {
        return realKill(pid, signal);
      } catch (failure) {
        errno = failure;
        throw failure;
      }
    });
    jest.mocked(spawn).mockImplementation(realSpawn);
    jest.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
    await expect(runE4OwnedMigrationProcess(['--version'], 5000)).resolves.toBeUndefined();
    expect(errno).toMatchObject({ code: 'ESRCH' });
    console.info(
      'E4_PROCESS_NATIVE_ERRNO',
      JSON.stringify({ code: 'ESRCH', sameRealm: errno instanceof Error }),
    );
  }, 10_000);
});
