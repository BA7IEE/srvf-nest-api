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
function readMemory(input: Record<string, string>): Record<string, unknown> {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', probe, memoryReader], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    }),
  ) as Record<string, unknown>;
}

describe('isolated CI memory admission reads actual root/cgroup boundaries', () => {
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
