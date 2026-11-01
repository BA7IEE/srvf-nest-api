import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Load the real pure functions without executing the driver's CLI or Docker work.
const probe = `
import ast,json,re,sys
from pathlib import Path
source=ast.parse(Path(sys.argv[1]).read_text())
functions=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in ['clean','regression_failure_tail']]
assert len(functions)==2
case=json.load(sys.stdin)
scope={'re':re,'passwords':case['passwords']}
exec(compile(ast.Module(body=functions,type_ignores=[]),'<driver-pure-diagnostics>','exec'),scope)
print(json.dumps(scope['regression_failure_tail'](case['stderr'],case['stdout'])))
`;
function diagnostic(stderr: string, stdout = '', passwords: string[] = []): string {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', probe, resolve('test/helpers/r5-ci-authentication.py')], {
      input: JSON.stringify({ stderr, stdout, passwords }),
      encoding: 'utf8',
    }),
  ) as string;
}

describe('bounded CI regression diagnostics expose the original failure safely', () => {
  it('retains SQLSTATE, stage and Jest cause without changing their meaning', () => {
    expect(diagnostic('FAIL D7\nRaw query failed. Code: 42501\nat source.ts:20', '1 failed')).toBe(
      'FAIL D7\nRaw query failed. Code: 42501\nat source.ts:20\n1 failed',
    );
  });
  it('redacts live passwords and complete connection URLs', () => {
    const value = diagnostic(
      'password synthetic-private-value; postgresql://p:synthetic-private-value@127.0.0.1/db',
      '',
      ['synthetic-private-value'],
    );
    expect(value).not.toContain('synthetic-private-value');
    expect(value).not.toContain('127.0.0.1');
    expect(value).toContain('[REDACTED_DATABASE_URL]');
  });
  it.each([
    'Authorization: Bearer fake-access-token',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.fake-signature',
    'https://example.invalid/result?sig=fake-signature&token=fake-access-token',
  ])('redacts token-shaped data without depending on a known password: %s', (value) => {
    const result = diagnostic(value);
    expect(result).not.toContain('fake-access-token');
    expect(result).not.toContain('fake-signature');
    expect(result).toContain('[REDACTED');
  });
  it('sanitizes before taking the bounded tail and retains the final failure', () => {
    const password = 'synthetic-password-that-could-straddle-the-limit';
    const result = diagnostic(password + 'x'.repeat(12_270) + '\nSQLSTATE 23514', '', [password]);
    expect(result.length).toBeLessThanOrEqual(12_288);
    expect(result).not.toContain('straddle-the-limit');
    expect(result).toContain('SQLSTATE 23514');
  });
  it('retains the original cause when verbose fixture output follows it', () => {
    const result = diagnostic('FAIL D7\nSQLSTATE 42501\n' + 'x'.repeat(20_000), '51 tests');
    expect(result).toContain('SQLSTATE 42501');
    expect(result).toContain('51 tests');
    expect(result).toContain('bounded middle omitted');
    expect(result.length).toBeLessThanOrEqual(12_288);
  });
  it('preserves the closed main-prepare error record from the middle of verbose output', () => {
    const record =
      '[d7-main-prepare-failure] {"population":2000,"code":"PrismaClientKnownRequestError:P2028:unavailable"}';
    const result = diagnostic(
      'FAIL D7\n' + 'x'.repeat(20_000) + '\n  ' + record + '\n' + 'y'.repeat(20_000),
    );
    expect(result).toContain(record);
    expect(result).toContain('FAIL D7');
    expect(result.length).toBeLessThanOrEqual(12_288);
  });
  it('retains the closed submit record as well as the original prepare label', () => {
    const record =
      '[d7-main-settlement-failure] {"phase":"submit","code":"PrismaClientKnownRequestError:P1017:unavailable"}';
    const result = diagnostic('x'.repeat(20_000) + '\n' + record + '\n' + 'y'.repeat(20_000));
    expect(result).toContain(record);
    expect(result.length).toBeLessThanOrEqual(12_288);
  });
});
