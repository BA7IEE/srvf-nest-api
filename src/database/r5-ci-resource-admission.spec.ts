import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const memoryReader = resolve('test/helpers/r5_ci_resources.py');
const probe = `
import importlib.util,json,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('r5_resources',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='r5-memory-test-') as directory:
 root=Path(directory)
 (root/'meminfo').write_text(case.get('meminfo','MemTotal: 8388608 kB\\nMemAvailable: 6291456 kB\\n'))
 for field in ['memory.max','memory.current']:
  if field in case: (root/field).write_text(case[field])
 try: print(json.dumps(module.memory_admission(root,root/'meminfo')))
 except (ValueError,FileNotFoundError) as error: print(json.dumps({'error':str(error)}))
`;
function readMemory(input: Record<string, string | undefined>): Record<string, unknown> {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', probe, memoryReader], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    }),
  ) as Record<string, unknown>;
}

describe('isolated CI memory admission reads actual root/cgroup boundaries', () => {
  it('fits the isolated WAL targets inside the unchanged tmpfs and memory caps', () => {
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `import ast,json,shlex,sys
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text())
names={'PG_MEMORY_BYTES','NODE_MEMORY_BYTES','PG_DATA_TMPFS_BYTES','FIXTURE_MEMORY_BUDGET_BYTES','PG_MAX_WAL_BYTES','PG_MIN_WAL_BYTES'}
nodes=[node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id in names for target in node.targets)]
shells=[node for node in ast.walk(tree) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='shell' for target in node.targets)]
assert len(nodes)==len(names) and len(shells)==1
scope={'hba':'test-only','socket':'/run/r5-pg-socket'}
exec(compile(ast.Module(body=nodes+shells,type_ignores=[]),'<isolated-pg-settings>','exec'),scope)
argv=shlex.split(scope['shell'].split('exec su-exec postgres postgres ',1)[1])
options=[argv[i+1] for i,word in enumerate(argv) if word=='-c']
print(json.dumps({'caps':{name:scope[name] for name in names},'options':options}))`,
          resolve('test/helpers/r5-ci-authentication.py'),
        ],
        { encoding: 'utf8' },
      ),
    ) as { caps: Record<string, number>; options: string[] };
    expect(result.caps).toEqual({
      PG_MEMORY_BYTES: 1536 * 1024 ** 2,
      NODE_MEMORY_BYTES: 2 * 1024 ** 3,
      PG_DATA_TMPFS_BYTES: 1024 ** 3,
      FIXTURE_MEMORY_BUDGET_BYTES: 3584 * 1024 ** 2,
      PG_MAX_WAL_BYTES: 128 * 1024 ** 2,
      PG_MIN_WAL_BYTES: 32 * 1024 ** 2,
    });
    expect(result.options).toEqual([
      'max_wal_size=128MB',
      'min_wal_size=32MB',
      'listen_addresses=127.0.0.1',
      'unix_socket_directories=/run/r5-pg-socket',
    ]);
  });

  it.each([{}, { 'memory.max': 'max\n' }])(
    'uses bounded host evidence when the root has no finite cgroup limit: %j',
    (input) => {
      expect(readMemory(input)).toEqual({
        source: 'host-root',
        memoryLimitBytes: 8 * 1024 ** 3,
        memoryUsedBytes: 2 * 1024 ** 3,
        memoryAvailableBytes: 6 * 1024 ** 3,
      });
    },
  );
  it('uses the smaller finite cgroup headroom without treating it as host free memory', () => {
    expect(
      readMemory({ 'memory.max': String(8 * 1024 ** 3), 'memory.current': String(5 * 1024 ** 3) }),
    ).toMatchObject({ source: 'cgroup', memoryAvailableBytes: 3 * 1024 ** 3 });
    expect(
      readMemory({ 'memory.max': String(16 * 1024 ** 3), 'memory.current': '0' }),
    ).toMatchObject({ source: 'cgroup', memoryAvailableBytes: 6 * 1024 ** 3 });
  });
  it.each([
    { 'memory.max': '0', 'memory.current': '0' },
    { 'memory.max': 'invalid', 'memory.current': '0' },
    { 'memory.max': '100', 'memory.current': '-1' },
    { 'memory.max': '100', 'memory.current': '101' },
    { 'memory.max': '100' },
    { meminfo: 'MemTotal: 100 kB\nMemAvailable: 101 kB\n' },
    { meminfo: 'MemTotal: 100 kB\n' },
  ])('rejects malformed, incomplete or contradictory evidence: %j', (input) => {
    expect(readMemory(input)).toHaveProperty('error');
  });
});
