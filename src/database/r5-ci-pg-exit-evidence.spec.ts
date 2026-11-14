import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const probe = `
import ast,json,re,sys
from types import SimpleNamespace
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text())
nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='pg_exit_evidence']
assert len(nodes)==1
case=json.load(sys.stdin)
calls=[];saved=[]
def docker(argv,stem,**kw):
 calls.append({'argv':argv,'kw':kw})
 return SimpleNamespace(returncode=case.get('returncode',0),stdout=json.dumps(case['state']) if argv[0]=='inspect' else '',stderr=case.get('logs',''))
scope={'docker':docker,'save':lambda name,value:saved.append(value.copy()),'json':json,'re':re}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<pg-exit-evidence>','exec'),scope)
result=scope['pg_exit_evidence']('disposable-container','observation')
print(json.dumps({'result':result,'calls':calls,'saved':saved}))
`;
function inspect(state: Record<string, unknown>, logs = '', returncode = 0) {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', probe, resolve('test/helpers/r5-ci-authentication.py')], {
      input: JSON.stringify({ state, logs, returncode }),
      encoding: 'utf8',
    }),
  ) as {
    result: Record<string, unknown>;
    calls: Array<{ argv: string[]; kw: Record<string, unknown> }>;
  };
}
describe('Docker exit evidence preserves uncertainty without SQL, raw logs or secret persistence', () => {
  it('captures independent stop/OOM/exit metadata and only closed log categories', () => {
    const value = inspect(
      { Running: false, OOMKilled: true, ExitCode: 137, Error: 'DO_NOT_PERSIST' },
      '2026-11-01 [1] PANIC: could not write: No space left on device\nSTATEMENT: private member row DO_NOT_PERSIST',
    );
    expect(value.result).toEqual({
      status: 'KNOWN',
      running: false,
      oomKilled: true,
      exitCode: 137,
      logCategories: { NO_SPACE: 1, ALLOCATION_FAILURE: 0, SIGNAL_9: 0, PANIC: 1 },
    });
    expect(value.calls.map((call) => call.argv[0])).toEqual(['inspect', 'logs']);
    for (const call of value.calls)
      expect(call.kw).toMatchObject({ cleanup: true, timeout: 5, allow: true, persist: false });
    expect(JSON.stringify(value)).not.toContain('DO_NOT_PERSIST');
  });
  it.each([
    {},
    { Running: 'false', OOMKilled: false, ExitCode: 1 },
    { Running: false, OOMKilled: false, ExitCode: true },
  ])('retains UNKNOWN for incomplete or wrongly typed state: %j', (state) => {
    expect(inspect(state).result.status).toBe('UNKNOWN');
  });
  it('does not reinterpret a failed inspect as a stopped server', () => {
    expect(
      inspect({ Running: false, OOMKilled: true, ExitCode: 137 }, '', 1).result,
    ).not.toHaveProperty('running');
  });
});
