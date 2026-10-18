import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// Explicit setup validation only. No default Jest config collects *.pg-spec.ts.
// Requires a separately authorized, migrated, network-isolated PG16 container.
const source = ts.createSourceFile(
  'e4-same-backend-plan-diagnostic.ts',
  readFileSync(resolve(__dirname, 'e4-same-backend-plan-diagnostic.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
function initializer(name: string) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        const value = declaration.initializer;
        if (value) return ts.isAsExpression(value) ? value.expression : value;
      }
    }
  }
  throw new Error('E4_SETUP_QUERY_SOURCE');
}
function text(value: ts.Node) {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  throw new Error('E4_SETUP_QUERY_SOURCE');
}
function docker(container: string, args: string[], input?: string) {
  const result = spawnSync('docker', [...args, container], {
    input,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
  });
  if (result.status !== 0 || result.error) throw new Error('E4_SETUP_CONTAINER_REFUSED');
  return result.stdout.trim();
}

describe('E4 real PostgreSQL setup fields (explicit; no business prepare)', () => {
  it('preserves exact aliases and passes the real preflight, configuration and rollback restoration', () => {
    const container = process.env.SRVF_E4_SETUP_PG_CONTAINER ?? '';
    if (!/^srvf-e4-setup-fix-[a-z0-9-]{1,64}$/u.test(container))
      throw new Error('E4_SETUP_EXPLICIT_CONTAINER_REQUIRED');
    const network = docker(container, ['inspect', '--format', '{{.HostConfig.NetworkMode}}']);
    const image = docker(container, ['inspect', '--format', '{{.Config.Image}}']);
    if (network !== 'none' || image !== 'postgres:16-alpine')
      throw new Error('E4_SETUP_CONTAINER_REFUSED');
    const settings = initializer('settings');
    if (!ts.isArrayLiteralExpression(settings)) throw new Error('E4_SETUP_QUERY_SOURCE');
    const preflight = text(initializer('preflight')).replaceAll('$1', "'app_test_w98'");
    const configured = text(initializer('configurationCheck')).replaceAll('$1', "'app_test_w98'");
    const observation = text(initializer('observerSql'))
      .replaceAll('$1', 'pg_backend_pid()')
      .replaceAll('$2', "'app_test_w98'");
    const restored = text(initializer('restoreCheck')).replaceAll('$1', "'app_test_w98'");
    const row = (query: string) => `SELECT row_to_json(probe) FROM (${query}) probe;`;
    const sql = [
      'BEGIN;',
      row(preflight),
      "LOAD 'auto_explain';",
      ...settings.elements.map((value) => text(value) + ';'),
      row(configured),
      row(observation),
      'ROLLBACK;',
      row(restored),
    ].join('\n');
    const result = spawnSync(
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
      { input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
    );
    if (result.status !== 0 || result.error) throw new Error('E4_SETUP_PG_QUERY_FAILED');
    let rows: Record<string, unknown>[];
    try {
      rows = result.stdout
        .trim()
        .split('\n')
        .map((value) => JSON.parse(value));
    } catch {
      throw new Error('E4_SETUP_PG_OUTPUT_SHAPE');
    }
    expect(rows.length).toBe(4);
    const [initial, enabled, observed, afterRollback] = rows;
    expect(Object.keys(initial).sort()).toEqual([
      'activity',
      'allowed',
      'catalog',
      'disabled',
      'logFormat',
      'pid',
      'scope',
      'version',
    ]);
    for (const key of [
      'scope',
      'version',
      'allowed',
      'logFormat',
      'activity',
      'disabled',
      'catalog',
    ])
      expect(initial[key] === true).toBe(true);
    expect(initial.logformat === undefined).toBe(true);
    expect(Number.isSafeInteger(initial.pid) && Number(initial.pid) > 0).toBe(true);
    expect(
      enabled.pid === initial.pid && enabled.scope === true && enabled.configured === true,
    ).toBe(true);
    expect(Object.keys(observed).sort()).toEqual([
      'blockers',
      'event',
      'noTransaction',
      'scope',
      'state',
      'type',
    ]);
    expect(observed.scope === true && typeof observed.noTransaction === 'boolean').toBe(true);
    expect(observed.notransaction === undefined).toBe(true);
    expect(
      afterRollback.pid === initial.pid &&
        afterRollback.scope === true &&
        afterRollback.restored === true,
    ).toBe(true);
  });
});
