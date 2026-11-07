import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pgReference =
  'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const resolvedImageId = 'sha256:' + 'b'.repeat(64);
const containerId = 'a'.repeat(64);

// Execute the real controller and cleanup with a synthetic subprocess transport.
// No Docker command, database, authentication or qualification is performed.
const controllerProbe = String.raw`
import ast,hashlib,io,json,os,re,subprocess,sys,tempfile,time
from contextlib import redirect_stdout
from datetime import datetime,timezone,timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote
case=json.load(sys.stdin)
repo=Path(sys.argv[1]).resolve()
tree=ast.parse((repo/'test/helpers/r5-ci-authentication.py').read_text())
names={'PG_IMAGE','PG_IMAGE_REF','NODE_IMAGE','DB','ROLES','DOCKER','PG_MEMORY_BYTES','NODE_MEMORY_BYTES','PG_DATA_TMPFS_BYTES','FIXTURE_MEMORY_BUDGET_BYTES','PG_MAX_WAL_BYTES','PG_MIN_WAL_BYTES'}
constants=[n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in names for t in n.targets)]
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
drivers=[n for n in tree.body if isinstance(n,ast.Try)]
assert len(drivers)==1
calls=[]
image_id='sha256:'+'b'*64
container_id='a'*64
def transport(argv,**kw):
    assert argv[:2]==['docker','--host=unix:///var/run/docker.sock']
    args=argv[2:]
    calls.append(args)
    stdout=''
    code=0
    if args[:2]==['image','inspect']:
        code=case.get('inspectExit',0)
        stdout=case.get('inspectStdout',json.dumps(image_id))
    elif args[:2]==['volume','create']:
        stdout='synthetic-socket-volume'
    elif args[:1]==['run']:
        raise subprocess.TimeoutExpired('synthetic-pg-create',1)
    elif args[:1]==['ps'] and 'name=^/r5-ci-auth-image-test$' in args:
        stdout=container_id if case.get('recover',True) else ''
    elif args[:1]==['inspect'] and '{{json .Image}}' in args:
        stdout=json.dumps(case.get('recoveryImage',image_id))
    elif args[:1]==['inspect'] and '{{json .State}}' in args:
        stdout=json.dumps({'Running':True,'OOMKilled':False,'ExitCode':0})
    elif args[:1]==['exec'] and 'psql' in args:
        if 'jsonb_build_object' in kw.get('input',''):
            stdout=json.dumps({'rolesSealed':True,'otherClients':0,'prepared':0})
    elif args[:1]==['wait']:
        stdout='0'
    return SimpleNamespace(returncode=code,stdout=stdout,stderr='synthetic missing digest' if code else '')
with tempfile.TemporaryDirectory(prefix='r5-image-controller-') as directory:
    started=time.monotonic()
    scope={'Path':Path,'datetime':datetime,'timezone':timezone,'timedelta':timedelta,
           'hashlib':hashlib,'json':json,'os':os,'re':re,'quote':quote,'time':time,
           'shutil':SimpleNamespace(disk_usage=lambda p:SimpleNamespace(free=20*1024**3)),
           'subprocess':SimpleNamespace(run=transport),
           'memory_admission':lambda:{'memoryAvailableBytes':8*1024**3},
           'repo':repo,'root':Path(directory),'env':{},'args':SimpleNamespace(regressions=True),
           'name':'r5-ci-auth-image-test','label':'srvf.r5.ci-auth=r5-ci-auth-image-test',
           'campaign':{'synthetic':True},'campaign_end':datetime.now(timezone.utc)+timedelta(seconds=1800),
           'started':started,'deadline':started+600,'auth_deadline':None,
           'cid':None,'app_cid':None,'socket_volume':None,'passwords':[],
           'pg_image_id':None,
           'receipt':{'status':'RUNNING','businessCalls':0,'existingDatabaseCalls':0,'newObjectGrants':0}}
    with redirect_stdout(io.StringIO()):
        exec(compile(ast.Module(body=constants+functions+drivers,type_ignores=[]),'<mocked-r5-controller>','exec'),scope)
    print(json.dumps({'reference':scope.get('PG_IMAGE_REF'),'resolvedImageId':scope.get('pg_image_id'),
                      'calls':calls,'receipt':scope['receipt'],'cleanup':scope['cleanup']}))
`;

type Observation = {
  reference?: string;
  resolvedImageId: string | null;
  calls: string[][];
  receipt: {
    status: string;
    businessCalls: number;
    error: { type: string; safeReason: string };
  };
  cleanup: {
    status: string;
    matchingContainers?: number;
    ephemeralSocketVolumesRemaining?: number;
  };
};

function simulate(input: Record<string, unknown> = {}): Observation {
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', controllerProbe, resolve('.')], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 15_000,
    }),
  ) as Observation;
}

function creationCalls(result: Observation): string[][] {
  return result.calls.filter(
    (args) => args[0] === 'run' || (args[0] === 'volume' && args[1] === 'create'),
  );
}

describe('R5 CI resolves the pinned PostgreSQL reference before disposable resource creation', () => {
  it('uses the workflow digest to resolve one full local ID for create and timeout recovery', () => {
    const result = simulate();
    expect(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')).toContain(
      'docker pull ' + pgReference,
    );
    expect(result.reference).toBe(pgReference);
    expect(result.resolvedImageId).toBe(resolvedImageId);
    const lookup = result.calls.findIndex((args) => args[0] === 'image');
    const firstCreate = result.calls.findIndex(
      (args) => args[0] === 'run' || (args[0] === 'volume' && args[1] === 'create'),
    );
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeLessThan(firstCreate);
    expect(result.calls[lookup]).toEqual([
      'image',
      'inspect',
      '--format',
      '{{json .Id}}',
      pgReference,
    ]);
    const creates = result.calls.filter((args) => args[0] === 'run');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('--pull=never');
    expect(creates[0]).toContain(resolvedImageId);
    expect(creates[0]).not.toContain(pgReference);
    expect(result.receipt.error.type).toBe('TimeoutExpired');
    expect(result.receipt.businessCalls).toBe(0);
    expect(result.cleanup).toMatchObject({
      status: 'PASS',
      matchingContainers: 0,
      ephemeralSocketVolumesRemaining: 0,
    });
    expect(result.calls).toContainEqual([
      'ps',
      '-aq',
      '--filter',
      'name=^/r5-ci-auth-image-test$',
      '--filter',
      'label=srvf.r5.ci-auth=r5-ci-auth-image-test',
    ]);
    expect(result.calls).toContainEqual(['inspect', '--format', '{{json .Image}}', containerId]);
  });

  it('rejects a missing pinned digest before any volume or container creation', () => {
    const result = simulate({ inspectExit: 1, recover: false });
    expect(result.receipt.status).toBe('FAIL');
    expect(result.receipt.error.type).toBe('RuntimeError');
    expect(result.resolvedImageId).toBeNull();
    expect(creationCalls(result)).toEqual([]);
    expect(result.cleanup.status).toBe('NOT_CREATED');
  });

  it.each([
    '',
    '{invalid-json',
    'null',
    '1',
    'true',
    '{}',
    '[]',
    JSON.stringify('sha256:' + 'a'.repeat(63)),
    JSON.stringify('sha256:' + 'g'.repeat(64)),
    JSON.stringify('sha512:' + 'a'.repeat(64)),
    JSON.stringify('sha256:' + 'A'.repeat(64)),
  ])('rejects malformed JSON or an invalid full image ID before creation: %s', (inspectStdout) => {
    const result = simulate({ inspectStdout, recover: false });
    expect(result.receipt.status).toBe('FAIL');
    expect(result.resolvedImageId).toBeNull();
    expect(creationCalls(result)).toEqual([]);
    expect(result.cleanup.status).toBe('NOT_CREATED');
  });

  it.each(['sha256:' + 'c'.repeat(64), pgReference, null])(
    'refuses timeout recovery when container .Image differs from the resolved ID: %s',
    (recoveryImage) => {
      const result = simulate({ recoveryImage });
      expect(result.resolvedImageId).toBe(resolvedImageId);
      expect(result.cleanup.status).toBe('UNKNOWN_REQUIRES_INSPECTION_NO_REPLAY');
      expect(
        result.calls.filter((args) => ['exec', 'stop', 'rm', 'wait'].includes(args[0])),
      ).toEqual([]);
      expect(result.calls.filter((args) => args[0] === 'run')).toHaveLength(1);
    },
  );
});
