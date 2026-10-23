import { spawn } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';

// Native errno errors can originate outside Jest's Error realm.
const isMissingProcessGroup = (failure: unknown) =>
  typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === 'ESRCH';

type Identity = { kind: 'LINUX_PROC' | 'POSIX_GROUP_ONLY'; group: number; starttime: string };

function identity(pid: number): Identity {
  // Ordinary POSIX callers retain the old group check. The external Linux
  // supervisor accepts only the exact /proc identity, never this fallback.
  if (process.platform !== 'linux')
    return { kind: 'POSIX_GROUP_ONLY', group: pid, starttime: 'UNAVAILABLE' };
  const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u);
  const group = Number(fields[2]);
  const starttime = fields[19];
  if (
    !raw.startsWith(pid + ' (') ||
    !Number.isSafeInteger(group) ||
    group < 1 ||
    !starttime ||
    !/^[1-9][0-9]*$/u.test(starttime)
  )
    throw new Error('E4 owned migration identity invalid');
  return { kind: 'LINUX_PROC', group, starttime };
}

// The parent's pipe is the ownership lease. No CLI starts before the fixed GO;
// EOF/error kills this wrapper's own group, including its non-detached pnpm.
const CLI_GATE_WRAPPER = [
  "const { spawn } = require('node:child_process');",
  'let input = ""; let released = false;',
  'const stop = () => { process.kill(-process.pid, "SIGKILL"); };',
  'process.stdin.on("end", stop);',
  'process.stdin.on("error", stop);',
  'process.stdin.on("data", (part) => {',
  '  if (released) return stop();',
  '  input += part.toString();',
  '  if (input.length > 3 || !"GO\\n".startsWith(input)) return stop();',
  '  if (input !== "GO\\n") return;',
  '  released = true;',
  '  const cli = spawn("pnpm", process.argv.slice(1), {',
  '    env: process.env, detached: false, stdio: ["ignore", "inherit", "inherit"]',
  '  });',
  '  cli.once("error", () => { process.stderr.write("E4 gate CLI spawn failed\\n"); stop(); });',
  '  cli.once("close", (status, signal) => {',
  '    if (signal) process.kill(process.pid, signal);',
  '    else process.exit(status === null ? 1 : status);',
  '  });',
  '});',
  'process.stdin.resume();',
].join('\n');

/** The bounded historical test owns the whole CLI process group, including Prisma. */
export function runE4OwnedMigrationProcess(args: readonly string[], timeout: number) {
  if (process.platform === 'win32')
    throw new Error('E4 bounded migration process-group ownership unavailable');
  return new Promise<void>((resolve, reject) => {
    const began = performance.now();
    let owner: Identity;
    try {
      owner = identity(process.pid);
    } catch {
      reject(
        Object.assign(new Error('E4 owned migration owner identity unknown'), {
          processCleanupUnknown: true,
        }),
      );
      return;
    }
    const common = {
      schemaVersion: 1,
      launchId: process.pid + '-' + process.hrtime.bigint(),
      ownerPid: process.pid,
      ownerGroup: owner.group,
      ownerStarttime: owner.starttime,
      identityKind: owner.kind,
      mode: args.includes('--schema') ? 'historical' : 'latest',
    };
    let registered: { pid: number; group: number; starttime: string } | undefined;
    const trace = (event: string, extra: object = {}) => {
      const bytes = Buffer.from(
        '[e4-owned-migration] ' + JSON.stringify({ ...common, event, ...extra }) + '\n',
      );
      if (writeSync(2, bytes) !== bytes.length)
        throw new Error('E4 owned migration registration incomplete');
    };
    // A failed/partial INTENT cannot launch even the blocked wrapper.
    try {
      trace('INTENT');
    } catch {
      reject(
        Object.assign(new Error('E4 owned migration intent registration unknown'), {
          processCleanupUnknown: true,
        }),
      );
      return;
    }
    const child = spawn(process.execPath, ['-e', CLI_GATE_WRAPPER, '--', ...args], {
      env: process.env,
      detached: true,
      stdio: 'pipe',
    });
    let expired = false;
    let stdout = '';
    let stderr = '';
    let closed = false;
    let error: Error | undefined;
    const retain = (text: string, data: Buffer) => (text + data.toString()).slice(-65_536);
    child.stdout.on('data', (data: Buffer) => (stdout = retain(stdout, data)));
    child.stderr.on('data', (data: Buffer) => (stderr = retain(stderr, data)));
    const stop = () => {
      // This also closes the pre-registration death window: without GO the
      // wrapper can only observe EOF and terminate, never run pnpm.
      child.stdin.destroy();
      if (!child.pid || !registered) return;
      try {
        if (process.platform === 'linux') {
          try {
            const current = identity(child.pid);
            if (current.group !== registered.group || current.starttime !== registered.starttime)
              throw new Error('E4 owned migration identity replaced');
          } catch (failure) {
            if (
              !(
                typeof failure === 'object' &&
                failure !== null &&
                'code' in failure &&
                failure.code === 'ENOENT'
              )
            )
              throw failure;
            // A leader can exit before its same-group descendants. A reused
            // leader PID would have existed above and failed the starttime pin.
          }
        }
        process.kill(-child.pid, 'SIGKILL');
      } catch (failure) {
        if (!isMissingProcessGroup(failure))
          error = Object.assign(new Error('E4 owned migration process group termination unknown'), {
            processCleanupUnknown: true,
          });
      }
    };
    child.stdin.on('error', () => {
      error = Object.assign(new Error('E4 owned migration control pipe unknown'), {
        processCleanupUnknown: true,
      });
      stop();
    });
    const remaining = Math.max(0, timeout - (performance.now() - began));
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, remaining);
    // A hung close is UNKNOWN, never successful process cleanup.
    const terminalTimer = setTimeout(() => {
      if (closed) return;
      stop();
      reject(
        Object.assign(new Error('E4 owned migration process closure unknown'), {
          processCleanupUnknown: true,
        }),
      );
    }, remaining + 1_000);
    child.once('error', (failure) => {
      error = failure;
      stop();
    });
    child.once('close', (status, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(terminalTimer);
      child.stdin.destroy();
      if (child.pid) {
        try {
          process.kill(-child.pid, 0);
          stop();
          error = Object.assign(new Error('E4 owned migration descendant closure unknown'), {
            processCleanupUnknown: true,
          });
        } catch (failure) {
          if (!isMissingProcessGroup(failure))
            error = Object.assign(new Error('E4 owned migration group check unknown'), {
              processCleanupUnknown: true,
            });
        }
      }
      try {
        trace('RESULT', {
          child: registered ?? null,
          status,
          signal,
          code: expired ? 'ETIMEDOUT' : error || status !== 0 ? 'E4_MIGRATION_FAILED' : 'NONE',
          cleanup:
            error && 'processCleanupUnknown' in error && error.processCleanupUnknown === true
              ? 'UNKNOWN'
              : registered
                ? 'CLOSED'
                : 'UNKNOWN',
          outcome: expired || error || status !== 0 ? 'REJECTED' : 'RESOLVED',
        });
      } catch {
        error = Object.assign(new Error('E4 owned migration terminal registration unknown'), {
          processCleanupUnknown: true,
        });
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
    try {
      if (!child.pid) throw new Error('E4 owned migration wrapper identity unavailable');
      const leader = identity(child.pid);
      if (leader.kind !== owner.kind || leader.group !== child.pid)
        throw new Error('E4 owned migration wrapper group differs');
      registered = { pid: child.pid, group: leader.group, starttime: leader.starttime };
      trace('REGISTER', { child: registered });
      if (performance.now() - began >= timeout) {
        expired = true;
        stop();
        return;
      }
      trace('RELEASE', { child: registered });
      // Keep the write end open until this command closes. end(GO) would revoke
      // ownership immediately and kill a normally running CLI.
      child.stdin.write('GO\n', (failure) => {
        if (!failure) return;
        error = Object.assign(new Error('E4 owned migration GO delivery unknown'), {
          processCleanupUnknown: true,
        });
        stop();
      });
    } catch {
      error = Object.assign(new Error('E4 owned migration launch registration unknown'), {
        processCleanupUnknown: true,
      });
      stop();
    }
  });
}
