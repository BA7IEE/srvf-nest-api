import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPressure(platform = process.platform, run = execFileSync) {
  if (platform !== 'darwin') return;
  const swap = String(run('sysctl', ['vm.swapusage'], { timeout: 5000 }));
  const pressure = String(run('memory_pressure', [], { timeout: 5000 }));
  const used = swap.match(/used\s*=\s*([\d.]+)M/);
  const free = pressure.match(/System-wide memory free percentage:\s*(\d+)%/);
  if (!used || !free) throw new Error('无法核验宿主机压力，拒绝启动检查。');
  if (Number(used[1]) >= 4096 || Number(free[1]) < 20) {
    throw new Error('宿主机资源保护：Swap ≥ 4 GiB 或压力读数偏低；NOT_RUN，请在干净环境重试。');
  }
}

export async function supervise(
  command,
  args,
  { root, timeoutMs = 900000, env = process.env, cleanup = () => {} },
) {
  const stateRoot = join(root, 'tmp', 'resource-runs');
  mkdirSync(stateRoot, { recursive: true });
  const lock = join(stateRoot, 'active');
  mkdirSync(lock); // Atomic, never reclaim another run or a stale lock automatically.
  let runRoot;
  let child;
  let requested;
  let timer;
  let escalation;
  const stop = (signal, code) => {
    requested ??= code;
    if (child?.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      escalation ??= setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') process.stderr.write('进程组回收失败\n');
        }
      }, 3000);
    }
  };
  const onInt = () => stop('SIGINT', 130);
  const onTerm = () => stop('SIGTERM', 143);
  try {
    runRoot = mkdtempSync(join(stateRoot, 'srvf-test-'));
    const manifest = join(runRoot, 'resources.jsonl');
    writeFileSync(manifest, '');
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, runRoot }));
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child = spawn(command, args, {
      cwd: root,
      detached: true,
      stdio: 'inherit',
      env: { ...env, SRVF_RESOURCE_MANIFEST: manifest, SRVF_RESOURCE_OWNER: String(process.pid) },
    });
    writeFileSync(join(runRoot, 'process.json'), JSON.stringify({ pid: child.pid }));
    timer = setTimeout(() => stop('SIGTERM', 124), timeoutMs);
    const code = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => accept(exitCode ?? 1));
    });
    return requested ?? code;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    // The group can outlive its leader. Terminate and verify it before database cleanup.
    let clean = true;
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') clean = false;
      }
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          clean = false;
        }
        await new Promise((accept) => setTimeout(accept, 100));
      }
      try {
        process.kill(-child.pid, 0);
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') clean = false;
      }
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
        }
        await new Promise((accept) => setTimeout(accept, 100));
      }
      try {
        process.kill(-child.pid, 0);
        clean = false;
      } catch (error) {
        if (error.code !== 'ESRCH') clean = false;
      }
    }
    try {
      if (runRoot) await cleanup(join(runRoot, 'resources.jsonl'));
    } catch {
      clean = false;
    }
    clearTimeout(escalation);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    if (clean) {
      if (runRoot) rmSync(runRoot, { recursive: true });
      rmSync(lock, { recursive: true });
      process.stdout.write('[resource] 本轮登记资源与进程组零残留\n');
    } else {
      throw new Error(`资源回收未完成，保留登记及锁：${runRoot}`);
    }
  }
}

export function cleanupManifest(manifest, run = execFileSync) {
  const entries = readFileSync(manifest, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const errors = [];
  for (const entry of entries.reverse()) {
    try {
      if (entry.kind === 'database') {
        if (!/^app_test(?:_[a-z0-9_]+)?_w[0-9]{1,2}$/.test(entry.name))
          throw new Error('invalid database');
        const currentId = run('docker', ['inspect', '--format', '{{.Id}}', 'u-nest-api-postgres'], {
          encoding: 'utf8',
          timeout: 10000,
        }).trim();
        if (currentId !== entry.containerId) throw new Error('container changed');
        const sql = `DROP DATABASE IF EXISTS "${entry.name}" WITH (FORCE);`;
        run(
          'docker',
          [
            'exec',
            '-i',
            currentId,
            'psql',
            '--no-psqlrc',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          { input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
        );
        const remaining = run(
          'docker',
          [
            'exec',
            currentId,
            'psql',
            '--no-psqlrc',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-tAc',
            `SELECT count(*) FROM pg_database WHERE datname='${entry.name}'`,
          ],
          { encoding: 'utf8', timeout: 10000 },
        ).trim();
        if (remaining !== '0') throw new Error('database remains');
      } else if (entry.kind === 'postgres-session') {
        if (!/^srvf-test-\d+$/.test(entry.applicationName))
          throw new Error('invalid session owner');
        const currentId = run('docker', ['inspect', '--format', '{{.Id}}', 'u-nest-api-postgres'], {
          encoding: 'utf8',
          timeout: 10000,
        }).trim();
        if (currentId !== entry.containerId) throw new Error('container changed');
        const sql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='${entry.applicationName}' AND pid<>pg_backend_pid();`;
        run(
          'docker',
          [
            'exec',
            '-i',
            currentId,
            'psql',
            '--no-psqlrc',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          { input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
        );
        const remaining = run(
          'docker',
          [
            'exec',
            currentId,
            'psql',
            '--no-psqlrc',
            '-U',
            'postgres',
            '-d',
            'postgres',
            '-tAc',
            `SELECT count(*) FROM pg_stat_activity WHERE application_name='${entry.applicationName}'`,
          ],
          { encoding: 'utf8', timeout: 10000 },
        ).trim();
        if (remaining !== '0') throw new Error('session remains');
      } else if (entry.kind === 'directory') {
        const target = resolve(entry.path);
        const allowed = resolve(dirname(manifest), '../../../tmp');
        if (
          !/^storage-w[0-9]{1,2}$/.test(target.slice(allowed.length + 1)) ||
          !target.startsWith(allowed + '/')
        )
          throw new Error('invalid directory');
        rmSync(target, { recursive: true, force: true });
        if (existsSync(target)) throw new Error('directory remains');
      } else throw new Error('unknown resource');
    } catch {
      errors.push(entry.kind);
    }
  }
  if (errors.length) throw new Error('登记资源回收或核验失败');
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const configs = {
    e2e: 'test/jest-e2e.config.ts',
    journeys: 'test/jest-journeys.config.ts',
    contract: 'test/jest-contract.config.ts',
    unit: 'test/jest-unit.config.ts',
  };
  checkPressure();
  // Local governance does not change the established hosted CI database lifecycle.
  const hostedCI = process.env.GITHUB_ACTIONS === 'true';
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (mode === 'quick') {
    process.exitCode = await supervise('bash', ['scripts/check-quick.sh', ...args], {
      root,
      env: { ...process.env, SRVF_RESOURCE_DATABASES: '0' },
      cleanup: cleanupManifest,
    });
  } else if (configs[mode]) {
    if (
      args.some((arg) =>
        /workers|runInBand|watch|globalSetup|globalTeardown|setupFiles|forceExit|--config/i.test(
          arg,
        ),
      )
    )
      throw new Error('受监督测试固定串行，不接受 worker/watch 覆盖。');
    process.exitCode = await supervise(
      'pnpm',
      [
        'exec',
        'jest',
        '--config',
        configs[mode],
        ...(hostedCI && mode === 'e2e' ? [] : ['--runInBand']),
        ...args,
      ],
      {
        root,
        timeoutMs: hostedCI ? 4200000 : 900000,
        env: { ...process.env, SRVF_RESOURCE_DATABASES: mode === 'unit' || hostedCI ? '0' : '1' },
        cleanup: cleanupManifest,
      },
    );
  } else throw new Error('期望 quick/unit/e2e/journeys/contract');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
