import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPressure, cleanupManifest, supervise } from './local-resource-run.mjs';

test('database/session cleanup verifies zero and preserves unregistered directories (fake Docker adapter)', () => {
  const root = mkdtempSync(join(tmpdir(), 'srvf-lifecycle-ledger-'));
  const runRoot = join(root, 'tmp/resource-runs/srvf-test-fixture');
  const storage = join(root, 'tmp/storage-w1');
  const historical = join(root, 'tmp/storage');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(storage);
  mkdirSync(historical);
  const manifest = join(runRoot, 'resources.jsonl');
  writeFileSync(
    manifest,
    [
      { kind: 'database', name: 'app_test_w1', containerId: 'owned' },
      { kind: 'directory', path: storage },
      { kind: 'postgres-session', containerId: 'owned', applicationName: 'srvf-test-123' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  const statements = [];
  try {
    cleanupManifest(manifest, (_command, args, options) => {
      if (args[0] === 'inspect') return 'owned\n';
      if (options?.input) {
        statements.push(options.input);
        return '';
      }
      assert.match(args.at(-1), /SELECT count\(\*\)/);
      return '0\n';
    });
    assert.equal(existsSync(storage), false);
    assert.equal(existsSync(historical), true);
    assert.equal(statements.length, 2);
    assert.match(statements[0], /application_name='srvf-test-123'/);
    assert.match(statements[1], /DROP DATABASE IF EXISTS "app_test_w1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup continues after a database error and fails rather than reporting zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'srvf-lifecycle-ledger-'));
  const runRoot = join(root, 'tmp/resource-runs/srvf-test-fixture');
  const storage = join(root, 'tmp/storage-w1');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(storage);
  const manifest = join(runRoot, 'resources.jsonl');
  writeFileSync(
    manifest,
    [
      { kind: 'directory', path: storage },
      { kind: 'database', name: 'app_test_w1', containerId: 'owned' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  try {
    assert.throws(
      () =>
        cleanupManifest(manifest, () => {
          throw new Error('fixture');
        }),
      /回收或核验失败/,
    );
    assert.equal(existsSync(storage), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing checkout lock is preserved and prevents another run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'srvf-lifecycle-lock-'));
  mkdirSync(join(root, 'tmp/resource-runs/active'), { recursive: true });
  try {
    await assert.rejects(supervise(process.execPath, ['-e', 'process.exit(0)'], { root }));
    assert.equal(existsSync(join(root, 'tmp/resource-runs/active')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const supervisor = new URL('./local-resource-run.mjs', import.meta.url).href;

test('pressure rejects high swap and unreadable measurements without launching work', () => {
  assert.throws(
    () =>
      checkPressure('darwin', (command) =>
        command === 'sysctl' ? 'used = 9000.00M' : 'System-wide memory free percentage: 44%',
      ),
    /NOT_RUN/,
  );
  assert.throws(() => checkPressure('darwin', () => 'unknown'), /无法核验/);
  assert.doesNotThrow(() =>
    checkPressure('darwin', (command) =>
      command === 'sysctl' ? 'used = 100.00M' : 'System-wide memory free percentage: 50%',
    ),
  );
});

for (const scenario of [
  'pass',
  'fail',
  'exception',
  'timeout',
  'SIGINT',
  'SIGTERM',
  'orphan',
  'cleanup-failure',
]) {
  test(`common cleanup: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'srvf-lifecycle-check-'));
    const childCode =
      scenario === 'pass'
        ? 'process.exit(0)'
        : scenario === 'fail'
          ? 'process.exit(7)'
          : scenario === 'orphan'
            ? "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setTimeout(()=>process.exit(0),100)"
            : 'setInterval(()=>{},1000)';
    const source = `
      import { supervise } from ${JSON.stringify(supervisor)};
      import { writeFileSync } from 'node:fs';
      const root = ${JSON.stringify(root)};
      try {
        const code = await supervise(${scenario === 'exception' ? "'srvf-no-such-executable'" : 'process.execPath'}, ['-e', ${JSON.stringify(childCode)}], {
          root, timeoutMs: ${scenario === 'timeout' ? 150 : 10000},
          cleanup: () => { writeFileSync(root+'/cleaned','yes'); ${scenario === 'cleanup-failure' ? "throw new Error('fixture');" : ''} }
        }); process.exitCode = code;
      } catch { process.exitCode = 1; }
    `;
    const runner = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    runner.stdout.on('data', (chunk) => {
      output += chunk;
    });
    runner.stderr.resume();
    const watchdog = setTimeout(() => runner.kill('SIGKILL'), 15000);
    try {
      if (scenario.startsWith('SIG')) {
        // Wait for its owned process registration, not a fixed sleep as evidence.
        const deadline = Date.now() + 5000;
        while (!existsSync(join(root, 'tmp/resource-runs/active/owner.json'))) {
          if (Date.now() > deadline) throw new Error('fixture did not start');
          await new Promise((accept) => setTimeout(accept, 10));
        }
        const owner = JSON.parse(
          readFileSync(join(root, 'tmp/resource-runs/active/owner.json'), 'utf8'),
        );
        while (!existsSync(join(owner.runRoot, 'process.json')))
          await new Promise((accept) => setTimeout(accept, 10));
        runner.kill(scenario);
      }
      if (scenario === 'cleanup-failure') setTimeout(() => runner.kill('SIGTERM'), 150);
      const code = await new Promise((accept, reject) => {
        runner.once('error', reject);
        runner.once('exit', accept);
      });
      const expected = {
        pass: 0,
        fail: 7,
        exception: 1,
        timeout: 124,
        SIGINT: 130,
        SIGTERM: 143,
        orphan: 0,
        'cleanup-failure': 1,
      };
      assert.equal(code, expected[scenario]);
      assert.equal(readFileSync(join(root, 'cleaned'), 'utf8'), 'yes');
      assert.equal(
        existsSync(join(root, 'tmp/resource-runs/active')),
        scenario === 'cleanup-failure',
      );
      if (scenario !== 'cleanup-failure') assert.match(output, /零残留/);
    } finally {
      clearTimeout(watchdog);
      runner.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
}
