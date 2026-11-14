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

describe('isolated PG startup and timed-out-create recovery across Docker image stores', () => {
  const startupProbe = `
import ast,json,re,sys
from pathlib import Path
from types import SimpleNamespace
tree=ast.parse(Path(sys.argv[1]).read_text())
case=json.load(sys.stdin)
main=next(node for node in tree.body if isinstance(node,ast.Try))
def assigns(node,name):
 return isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in node.targets)
constants=[node for node in tree.body if any(assigns(node,name) for name in ['PG_IMAGE','PG_MEMORY_BYTES','PG_DATA_TMPFS_BYTES'])]
lookup=next(i for i,node in enumerate(main.body) if assigns(node,'pg_image_id'))
create=next(node for node in main.body if assigns(node,'cid'))
recover=next(node for part in main.finalbody for node in ast.walk(part) if isinstance(node,ast.If)
 and isinstance(node.test,ast.UnaryOp) and isinstance(node.test.op,ast.Not)
 and isinstance(node.test.operand,ast.Name) and node.test.operand.id=='cid')
pin='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
calls=[]
def docker(argv,stem,**kw):
 calls.append(argv)
 if argv[:2]==['image','inspect']:
  assert argv[-1]==pin
  return SimpleNamespace(stdout=json.dumps(case['imageId']))
 if argv[0]=='run':
  # Model an engine that accepts the pulled reference, not a config-digest alias.
  assert pin in argv, 'No such image'
  assert '--pull=never' in argv and argv[argv.index('--network')+1]=='none'
  return SimpleNamespace(stdout='c'*64)
 if argv[0]=='ps': return SimpleNamespace(stdout='c'*64)
 if argv[0]=='inspect': return SimpleNamespace(stdout=json.dumps(case['containerImageId']))
 raise AssertionError('Unexpected Docker operation')
scope={'docker':docker,'json':json,'re':re,'name':'owned-fixture','label':'test-label',
       'socket_mount':[],'shell':'test-only'}
def execute(nodes):
 exec(compile(ast.Module(body=nodes,type_ignores=[]),'<pg-image-identity>','exec'),scope)
try:
 execute(constants+main.body[lookup:lookup+2]+[create])
 scope['cid']=None
 execute([recover])
 print(json.dumps({'recovered':scope['cid'],'calls':calls}))
except AssertionError:
 print(json.dumps({'rejected':True,'calls':calls}))
`;

  function startup(imageId: unknown, containerImageId: unknown = imageId) {
    return JSON.parse(
      execFileSync(
        'python3',
        ['-B', '-c', startupProbe, resolve('test/helpers/r5-ci-authentication.py')],
        { input: JSON.stringify({ imageId, containerImageId }), encoding: 'utf8' },
      ),
    ) as { recovered?: string; rejected?: boolean; calls: string[][] };
  }

  it.each([
    'sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542',
    'sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
  ])('uses the immutable reference and recovers only the resolved engine identity: %s', (id) => {
    expect(startup(id).recovered).toBe('c'.repeat(64));
  });

  it('refuses cleanup ownership of a container with a different image', () => {
    expect(startup(`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`).rejected).toBe(true);
  });

  it.each([null, '', 'postgres:latest', 'sha256:short'])(
    'rejects invalid image identity before creating a container: %j',
    (id) => {
      const result = startup(id);
      expect(result.rejected).toBe(true);
      expect(result.calls.some((argv) => argv[0] === 'run')).toBe(false);
    },
  );
});
