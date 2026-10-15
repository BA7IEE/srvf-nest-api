import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runE4OwnedMigrationProcess } from './e4-owned-migration-process';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

describe('E4 bounded migration process group', () => {
  const missing = () => {
    throw Object.assign(new Error('missing group'), { code: 'ESRCH' });
  };
  let child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
  let kill: jest.SpiedFunction<typeof process.kill>;
  beforeEach(() => {
    jest.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    kill = jest.spyOn(process, 'kill').mockImplementation(missing);
  });
  afterEach(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('waits for successful process closure and verifies no owned descendants', async () => {
    const result = runE4OwnedMigrationProcess(['exec', 'prisma', 'migrate', 'deploy'], 1000);
    child.emit('close', 0, null);
    await expect(result).resolves.toBeUndefined();
    expect(jest.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ detached: true });
    expect(kill).toHaveBeenCalledWith(-12345, 0);
  });

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
});
