import { spawn } from 'node:child_process';

/** The bounded historical test owns the whole CLI process group, including Prisma. */
export function runE4OwnedMigrationProcess(args: readonly string[], timeout: number) {
  if (process.platform === 'win32')
    throw new Error('E4 bounded migration process-group ownership unavailable');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', [...args], { env: process.env, detached: true, stdio: 'pipe' });
    let expired = false;
    let stdout = '';
    let stderr = '';
    let closed = false;
    let error: Error | undefined;
    const retain = (text: string, data: Buffer) => (text + data.toString()).slice(-65_536);
    child.stdout.on('data', (data: Buffer) => (stdout = retain(stdout, data)));
    child.stderr.on('data', (data: Buffer) => (stderr = retain(stderr, data)));
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (failure) {
        if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH'))
          error = Object.assign(new Error('E4 owned migration process group termination unknown'), {
            processCleanupUnknown: true,
          });
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, timeout);
    // A hung close is UNKNOWN, never successful process cleanup.
    const terminalTimer = setTimeout(() => {
      if (closed) return;
      stop();
      reject(
        Object.assign(new Error('E4 owned migration process closure unknown'), {
          processCleanupUnknown: true,
        }),
      );
    }, timeout + 1_000);
    child.once('error', (failure) => {
      error = failure;
      stop();
    });
    child.once('close', (status, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(terminalTimer);
      if (child.pid) {
        try {
          process.kill(-child.pid, 0);
          stop();
          error = Object.assign(new Error('E4 owned migration descendant closure unknown'), {
            processCleanupUnknown: true,
          });
        } catch (failure) {
          if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH'))
            error = Object.assign(new Error('E4 owned migration group check unknown'), {
              processCleanupUnknown: true,
            });
        }
      }
      if (expired || error || status !== 0) {
        stop();
        reject(
          Object.assign(error ?? new Error('E4 owned migration command failed'), {
            status,
            signal,
            code: expired ? 'ETIMEDOUT' : 'E4_MIGRATION_FAILED',
            stdout,
            stderr,
          }),
        );
      } else resolve();
    });
  });
}
