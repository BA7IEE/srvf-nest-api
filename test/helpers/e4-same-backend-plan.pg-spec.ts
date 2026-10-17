import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { E4SameBackendPlanDiagnostic } from './e4-same-backend-plan-diagnostic';
import { e4DiagnosticContext, installE4DiagnosticLimits } from './e4-diagnostic-limits-client';

// Explicit only; no default Jest config collects *.pg-spec.ts. All SQL/log text stays in memory.
// The authorized container must be separately migrated, ephemeral and network-isolated.
function containerName() {
  const container = process.env.SRVF_E4_SETUP_PG_CONTAINER ?? '';
  if (!/^srvf-e4-setup-fix-[a-z0-9-]{1,64}$/u.test(container))
    throw new Error('E4_FIXTURE_EXPLICIT_CONTAINER_REQUIRED');
  const inspect = (format: string) =>
    execFileSync('docker', ['inspect', '--format', format, container], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    }).trim();
  if (
    inspect('{{.HostConfig.NetworkMode}}') !== 'none' ||
    inspect('{{.Config.Image}}') !== 'postgres:16-alpine'
  )
    throw new Error('E4_FIXTURE_CONTAINER_REFUSED');
  return container;
}

// Keep one real backend over docker exec: no host port, password or network connection.
function session(container: string) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'app_test_w98',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '',
    pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  const fail = () => pending?.reject(new Error('E4_FIXTURE_SESSION_FAILED'));
  child.on('error', fail);
  child.on('exit', fail);
  child.stderr.on('data', () => {
    /* Never retain or print server exception/statement text. */
  });
  child.stdout.on('data', (part: Buffer) => {
    output += part.toString();
    if (Buffer.byteLength(output) > 65536) {
      fail();
      child.kill();
      return;
    }
    if (output.endsWith('E4_FIXTURE_END\n')) {
      const value = output.slice(0, -'E4_FIXTURE_END\n'.length).trim();
      output = '';
      const current = pending;
      pending = undefined;
      current?.resolve(value);
    }
  });
  const send = async (sql: string) => {
    if (pending || child.exitCode !== null) throw new Error('E4_FIXTURE_SESSION_BUSY');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(() => {
          fail();
          child.kill();
        }, 5000);
        child.stdin.write(sql + ';\n\\echo E4_FIXTURE_END\n');
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const bind = (sql: string, args: unknown[]) =>
    sql.replace(/\$(\d+)/gu, (_, index: string) => {
      const value = args[Number(index) - 1];
      if (value === 'app_test_w98') return "'app_test_w98'";
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        return String(value);
      throw new Error('E4_FIXTURE_PARAMETER_REFUSED');
    });
  return {
    $queryRawUnsafe: async (
      sql: string,
      ...args: unknown[]
    ): Promise<Record<string, unknown>[]> => {
      const raw = await send(
        `SELECT coalesce(json_agg(row_to_json(probe)), '[]'::json) FROM (${bind(sql, args)}) probe`,
      );
      try {
        return JSON.parse(raw) as Record<string, unknown>[];
      } catch {
        throw new Error('E4_FIXTURE_QUERY_SHAPE');
      }
    },
    $executeRawUnsafe: async (sql: string) => {
      await send(sql);
      return 0;
    },
    close: async () => {
      const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.stdin.end('\\q\n');
      await ended;
    },
  };
}

describe('E4 real PG16 trigger plan collection (explicit; tiny fixture)', () => {
  it.each(['COMMIT', 'ROLLBACK'] as const)(
    'collects TIMING OFF trigger plans and restores the same backend after %s',
    async (terminal) => {
      const container = containerName(),
        backend = session(container),
        observer = session(container);
      try {
        await backend.$executeRawUnsafe(`
        CREATE TEMP TABLE e4_plan_fixture(value integer);
        CREATE FUNCTION pg_temp.e4_plan_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$;
        CREATE TRIGGER e4_plan_fixture_guard BEFORE INSERT ON e4_plan_fixture
          FOR EACH ROW EXECUTE FUNCTION pg_temp.e4_plan_fixture_trigger()`);
        const target = {
          $queryRawUnsafe: backend.$queryRawUnsafe,
          $transaction: async (
            work: (tx: typeof backend) => Promise<unknown>,
            options: { timeout: number },
          ) => {
            expect(options.timeout).toBe(90000);
            await backend.$executeRawUnsafe('BEGIN');
            try {
              return await work(backend);
            } finally {
              await backend.$executeRawUnsafe(terminal);
            }
          },
        };
        const context = e4DiagnosticContext({
          purpose: 'DIAGNOSTIC_ONLY',
          appEnv: 'test',
          scope: 'app_test_w98',
          sourceHead: 'a'.repeat(40),
          databaseUrl: 'postgresql://synthetic@localhost/app_test_w98',
        });
        const limits = installE4DiagnosticLimits(target, context);
        let missingTime = false,
          projectedTrigger = false;
        const diagnostic = new E4SameBackendPlanDiagnostic(limits.client, context, {
          observe: observer.$queryRawUnsafe,
          logs: async (since, until) => {
            const result = spawnSync(
              'docker',
              ['logs', '--since', since, '--until', until, container],
              {
                encoding: 'utf8',
                timeout: 5000,
                maxBuffer: 2 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            if (result.status !== 0 || result.error || (result.stdout && result.stderr))
              throw new Error('E4_FIXTURE_LOG_READ');
            const raw = result.stderr || result.stdout;
            missingTime =
              raw.includes('"Trigger Name": "e4_plan_fixture_guard"') && !/"Time"\s*:/u.test(raw);
            return raw;
          },
        });
        const result = await diagnostic.client.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`WITH revision_domain AS MATERIALIZED (SELECT 1 AS value)
          INSERT INTO e4_plan_fixture SELECT value FROM revision_domain /* e4_private_fixture_sentinel */`);
            return 'BUSINESS_CALLBACK_COMPLETE';
          },
          { timeout: 30000 },
        );
        expect(result).toBe('BUSINESS_CALLBACK_COMPLETE');
        const snapshot = diagnostic.snapshot();
        for (const plan of snapshot.plans) {
          for (const trigger of plan.triggers) {
            projectedTrigger = true;
            expect(trigger.timeMs).toBeNull();
          }
        }
        expect(snapshot).toMatchObject({
          status: 'OBSERVED',
          reason: 'NONE',
          logReason: 'NONE',
          sameBackendAndSettingsRestored: true,
          terminal: 'IDLE_NO_TX',
        });
        expect(projectedTrigger && missingTime).toBe(true);
        expect(JSON.stringify(snapshot)).not.toMatch(
          /e4_private_fixture_sentinel|e4_plan_fixture|pg_sleep|Query Text|Trigger Name/,
        );
        const persisted = await backend.$queryRawUnsafe(
          'SELECT count(*)::int AS rows FROM e4_plan_fixture',
        );
        expect(persisted).toEqual([{ rows: terminal === 'COMMIT' ? 1 : 0 }]);
        limits.restore();
        expect(limits.snapshot().restored).toBe(true);
      } finally {
        await Promise.all([backend.close(), observer.close()]);
      }
    },
    20000,
  );
});
