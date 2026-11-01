"""One disposable, loopback-only PG16 authentication/qualification fixture.

No existing database, port publication, persistent volume or credentials. The
only expected catalogs come from checksum-pinned repository source. Passwords
exist in controller RAM and stdin pipes only; never argv/env/files/output.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from urllib.parse import quote
from r5_ci_resources import memory_admission

PG_IMAGE = 'sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542'
NODE_IMAGE = 'node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413'
DB = 'app_test_r5_setmat_20261029_q1'
ROLES = ['r5_boundary_owner_h7c6', 'r5_boundary_caller_h7c6', 'r5_mat_writer_20261029_q1',
         'r5_human_queue_login_20261030_q1', 'r5_untrusted_caller_login_20261030_q1']
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
parser = argparse.ArgumentParser()
parser.add_argument('--checkout', required=True)
parser.add_argument('--evidence', required=True)
parser.add_argument('--campaign', required=True)
parser.add_argument('--regressions', action='store_true')
args = parser.parse_args()
repo = Path(args.checkout).resolve()
root = Path(args.evidence).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
env = os.environ.copy()
for key in ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']:
    env.pop(key, None)
name = 'r5-ci-auth-' + secrets.token_hex(5)
label = 'srvf.r5.ci-auth=' + name
started = time.monotonic()
campaign_path = Path(args.campaign).resolve()
campaign = json.loads(campaign_path.read_text())
campaign_start = datetime.fromisoformat(campaign['startedAt'])
campaign_end = datetime.fromisoformat(campaign['deadline'])
assert campaign_start.tzinfo and campaign_end.tzinfo and (campaign_end - campaign_start).total_seconds() == 1800
now = datetime.now(timezone.utc)
assert campaign_start <= now < campaign_end, 'ORIGINAL_CAMPAIGN_EXPIRED_NO_RESET'
deadline = min(started + 600, started + (campaign_end - now).total_seconds())
auth_deadline = None
cid = None
app_cid = None
socket_volume = None
passwords = []
receipt = {'status': 'RUNNING', 'businessCalls': 0, 'existingDatabaseCalls': 0,
           'newObjectGrants': 0, 'stageLimitSeconds': 600, 'controlLimitSeconds': 1800,
           'authenticationLimitSeconds': 180, 'passwordsPersisted': False}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def save(name, value):
    (root / name).write_text(json.dumps(value, indent=2) + '\n')


def clean(value):
    for secret in passwords:
        value = value.replace(secret, '[REDACTED]')
    return value


def run(argv, stem, text=None, allow=False, cleanup=False, timeout=30, persist=True):
    limit = deadline if auth_deadline is None else min(deadline, auth_deadline)
    if not cleanup and time.monotonic() >= limit - 25:
        raise RuntimeError('RESERVE_STOP_BEFORE_' + stem)
    cap = timeout if cleanup else min(timeout, max(.1, limit - time.monotonic() - 25))
    before = time.monotonic()
    p = subprocess.run(argv, input=text, text=True, capture_output=True, env=env, timeout=cap)
    if persist:
        (root / (stem + '.stdout')).write_text(clean(p.stdout))
        (root / (stem + '.stderr')).write_text(clean(p.stderr))
    save(stem + '.result.json', {'at': stamp(), 'exitCode': p.returncode,
                                'seconds': time.monotonic() - before})
    if p.returncode and not allow:
        raise RuntimeError(stem + '_EXIT_' + str(p.returncode))
    return p


def docker(argv, stem, **kw):
    return run(DOCKER + argv, stem, **kw)


def sql(text, stem, db=DB, **kw):
    assert cid and re.fullmatch('[a-f0-9]{64}', cid)
    socket = '/run/r5-pg-socket' if args.regressions else '/tmp'
    return docker(['exec', '-i', cid, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                   '-h', socket, '-U', 'postgres', '-d', db], stem, text=text, **kw)


def query(text, stem, **kw):
    return json.loads(sql('BEGIN READ ONLY; SET LOCAL search_path=pg_catalog;\n' + text + '\nCOMMIT;', stem, **kw).stdout)


def probe(data, stem, **kw):
    # A separate container shares ONLY this new PG's isolated network namespace.
    return docker(['exec', '-i', app_cid, 'node', '-r', './node_modules/ts-node/register/transpile-only',
                   'test/helpers/r5-ci-auth-probe.ts'], stem, text=json.dumps(data), timeout=40, **kw)


def authenticated(role, password, db, text, stem, allow=False):
    url = 'postgresql://' + role + ':' + quote(password, safe='') + '@127.0.0.1:5432/' + db
    command = '\\connect ' + url + '\n' + text + '\n'
    return docker(['exec', '-i', cid, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                   '-h', '/run/r5-pg-socket' if args.regressions else '/tmp', '-U', 'postgres', '-d', 'postgres'], stem,
                  text=command, allow=allow, timeout=10)


try:
    free = shutil.disk_usage(repo).free
    memory = memory_admission()
    save('ADMISSION.json', {'diskFreeBytes': free, **memory,
                           'pgCpu': 1, 'pgMemoryBytes': 512 * 1024**2,
                           'nodeCpu': 1, 'nodeMemoryBytes': 3 * 1024**3, 'pidsPerContainer': 128,
                           'dataTmpfsBytes': 256 * 1024**2})
    assert free > 10 * 1024**3, 'DISK_ADMISSION_REJECTED_GT_10GIB'
    assert memory['memoryAvailableBytes'] > 4 * 1024**3, 'MEMORY_ADMISSION_REJECTED_GT_4GIB'
    source_paths = ['test/helpers/r5-ci-authentication.py', 'test/helpers/r5_ci_resources.py',
                    'test/helpers/r5-ci-auth-probe.ts', 'test/helpers/r5-ci-source-binding.ts',
                    'test/fixtures/r5-ci-source-catalog.json', 'test/r5-authenticated-ci-suites.json']
    save('EXECUTION-SOURCE.json', {p: hashlib.sha256((repo / p).read_bytes()).hexdigest()
                                 for p in source_paths})
    assert not docker(['ps', '-aq', '--filter', 'label=srvf.r5.ci-auth'], 'other-fixture-preflight').stdout.strip()
    save('WINDOW.json', {'startedAt': stamp(), 'stageLimitSeconds': 600,
                         'controlLimitSeconds': 1800, 'authenticationLimitSeconds': 180,
                         'campaign': campaign, 'claim': name})
    fd = os.open(root / 'EXECUTED-CLAIM.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'name': name, 'at': stamp()}, f)
    socket = '/run/r5-pg-socket' if args.regressions else '/tmp'
    socket_mount = []
    if args.regressions:
        # Only a 1MiB socket tmpfs, never PG data or credentials. This exposes
        # the existing bootstrap Unix endpoint solely to the trusted arrange
        # fixture. N/P stay on independently authenticated loopback TCP.
        socket_volume = name + '-socket'
        docker(['volume', 'create', '--label', label, '--driver', 'local',
                '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
                '--opt', 'o=size=1048576,uid=70,gid=70,mode=0700', socket_volume], 'socket-tmpfs-create')
        socket_mount = ['--mount', 'type=volume,source=' + socket_volume + ',target=' + socket]
    hba = ('local all postgres trust\nlocal all all reject\n'
           'host ' + DB + ' ' + ','.join(ROLES[3:]) + ' 127.0.0.1/32 scram-sha-256\n'
           'host all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n')
    shell = ('mkdir -p /var/lib/postgresql/data; chown postgres:postgres /var/lib/postgresql/data; '
             'chmod 700 /var/lib/postgresql/data; '
             'su-exec postgres initdb -D /var/lib/postgresql/data --username=postgres '
             '--auth-local=trust --auth-host=reject >/tmp/initdb.log; '
             "printf '%s' '" + hba + "' > /var/lib/postgresql/data/pg_hba.conf; "
             'chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf; '
             'exec su-exec postgres postgres -D /var/lib/postgresql/data '
             '-c listen_addresses=127.0.0.1 -c unix_socket_directories=' + socket)
    cid = docker(['run', '--detach', '--pull=never', '--name', name, '--label', label,
                  '--network', 'none', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
                  '--tmpfs', '/var/lib/postgresql/data:rw,size=268435456', *socket_mount, '--entrypoint', '/bin/sh',
                  PG_IMAGE, '-ceu', shell], 'create-pg').stdout.strip()
    assert re.fullmatch('[a-f0-9]{64}', cid)
    receipt['containerId'] = cid
    for i in range(60):
        if docker(['exec', cid, 'pg_isready', '-h', socket, '-U', 'postgres'],
                  'ready-' + str(i), allow=True, timeout=2).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('PG_NOT_READY')
    mounts = json.loads(docker(['inspect', '--format', '{{json .Mounts}}', cid], 'mounts').stdout)
    tmpfs = json.loads(docker(['inspect', '--format', '{{json .HostConfig.Tmpfs}}', cid], 'tmpfs').stdout)
    network = json.loads(docker(['inspect', '--format', '{{json .HostConfig.NetworkMode}}', cid], 'network').stdout)
    ports = json.loads(docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', cid], 'ports').stdout)
    fs = docker(['exec', cid, 'stat', '-f', '-c', '%T', '/var/lib/postgresql/data'], 'filesystem').stdout.strip()
    assert network == 'none' and not ports and fs == 'tmpfs'
    assert list(tmpfs) == ['/var/lib/postgresql/data']
    assert all(m['Type'] == 'tmpfs' or (args.regressions and m['Type'] == 'volume' and
               m['Name'] == socket_volume and m['Destination'] == socket) for m in mounts)
    if socket_volume:
        opts = json.loads(docker(['volume', 'inspect', '--format', '{{json .Options}}', socket_volume], 'socket-tmpfs-options').stdout)
        assert opts == {'type': 'tmpfs', 'device': 'tmpfs', 'o': 'size=1048576,uid=70,gid=70,mode=0700'}
        assert docker(['exec', cid, 'stat', '-f', '-c', '%T', socket], 'socket-filesystem').stdout.strip() == 'tmpfs'
    save('ISOLATION.json', {'network': network, 'ports': ports, 'mounts': mounts, 'tmpfs': tmpfs, 'filesystem': fs})
    sql('CREATE DATABASE ' + DB + ';', 'create-db', db='postgres')
    roles_sql = ['BEGIN;']
    for role in ROLES:
        inherit = 'INHERIT' if role == ROLES[3] else 'NOINHERIT'
        roles_sql.append(f'CREATE ROLE {role} NOLOGIN {inherit} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;')
    for role, inherit in [(ROLES[3], 'TRUE'), (ROLES[4], 'FALSE')]:
        roles_sql.extend(f'GRANT {ROLES[1]} TO {role} WITH {option} {value};'
                         for option, value in [('SET', 'TRUE'), ('INHERIT', inherit), ('ADMIN', 'FALSE')])
    roles_sql.extend(['COMMIT;'])
    sql('\n'.join(roles_sql), 'sealed-roles')
    identity = query("SELECT jsonb_build_object('database',current_database(),'databaseOid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),'cluster',(SELECT system_identifier::text FROM pg_control_system()),'roles',(SELECT jsonb_object_agg(rolname,oid::bigint) FROM pg_roles WHERE rolname LIKE 'r5_%'));", 'identity')
    assert identity['database'] == DB and identity['cluster'] not in ['7695840193603043362', '7702954905055002659']
    save('IDENTITY.json', identity)
    files = sorted((repo / 'prisma/migrations').glob('*/migration.sql'))
    assert len(files) == 155
    install = '\n'.join('\\echo ' + p.parent.name + '\n' + p.read_text() for p in files)
    sql(install, 'install-155', timeout=80)
    negative = sql('\\set VERBOSITY verbose\nSET ROLE ' + ROLES[1] + '; SELECT public.r5_correction_boundary_preflight();', 'default-null', allow=True)
    assert negative.returncode == 3 and '55000: materialization catalog pins are not bound' in negative.stderr
    app_cid = docker(['run', '--detach', '--pull=never', '--name', name + '-app', '--label', label,
                      '--network', 'container:' + cid, '--cpus', '1', '--memory', '3g', '--pids-limit', '128',
                      '--mount', 'type=bind,src=' + str(repo) + ',dst=' + str(repo) + ',readonly',
                      *(['--mount', 'type=volume,source=' + socket_volume + ',target=' + socket + ',readonly'] if socket_volume else []),
                      '--workdir', str(repo), NODE_IMAGE, 'node', '-e', 'setInterval(()=>{},1000)'], 'create-node').stdout.strip()
    app_env = json.loads(docker(['inspect', '--format', '{{json .Config.Env}}', app_cid], 'node-environment').stdout)
    assert not {'DATABASE_URL', 'HUMAN_CORRECTION_DATABASE_URL', 'CONTRIBUTION_SHADOW_DATABASE_URL'} & {
        value.partition('=')[0] for value in app_env
    }, 'NODE_FIXTURE_MUST_NOT_INHERIT_DATABASE_URLS'
    built = json.loads(probe({'mode': 'build', 'identity': identity}, 'build-source').stdout)
    for section, query_file in [('base', 'r5-setmat-catalog-query.sql'), ('supplemental', 'r5-setmat-async-job-catalog.sql')]:
        actual = query((repo / 'test/helpers' / query_file).read_text(), section + '-catalog')
        expected = built[section]
        if actual != expected:
            save('CATALOG-MISMATCH.json', {'section': section, 'expected': expected, 'actual': actual})
            raise RuntimeError('SOURCE_CATALOG_MISMATCH_' + section)
    install_hash = hashlib.sha256(json.dumps({'sourceCatalogSha256': built['catalogSha256'], 'identity': identity}, sort_keys=True).encode()).hexdigest()
    sql('BEGIN;\n' + built['ddl'] + '\nSELECT pg_current_xact_id()::text; COMMIT;', 'bind-source')
    sql('BEGIN READ ONLY; SET LOCAL ROLE ' + ROLES[1] + '; SELECT public.r5_correction_boundary_preflight(); COMMIT;', 'bound-caller')
    passwords = [secrets.token_hex(32), secrets.token_hex(32)]
    auth_started = datetime.now(timezone.utc)
    auth_deadline = time.monotonic() + 180
    expires = campaign_end.isoformat()
    save('AUTH-WINDOW.json', {'startedAt': auth_started.isoformat(), 'deadline': (auth_started + timedelta(seconds=180)).isoformat(), 'limitSeconds': 180})
    changes = ['BEGIN;', "SET LOCAL log_statement='none';", "SET LOCAL log_min_error_statement='panic';", 'SET LOCAL log_parameter_max_length_on_error=0;']
    changes.extend(f"ALTER ROLE {role} LOGIN PASSWORD '{password}' VALID UNTIL '{expires}';" for role, password in zip(ROLES[3:], passwords))
    changes.append('COMMIT;')
    sql('\n'.join(changes), 'temporary-enable', persist=False)
    cases = []
    for role, password in zip(ROLES[3:], passwords):
        value = authenticated(role, password, DB, "SELECT jsonb_build_object('session',session_user,'current',current_user,'pid',pg_backend_pid(),'address',host(inet_client_addr()),'database',current_database());", role + '-ok')
        profile = json.loads(value.stdout)
        assert profile['session'] == profile['current'] == role and profile['address'] == '127.0.0.1' and profile['database'] == DB, 'REAL_AUTH_PROFILE_' + role
        cases.append({'case': role + '-real-scram', 'pass': True, 'profile': profile})
        save('AUTH-CASES.json', cases)
        bad = authenticated(role, password + 'bad', DB, 'SELECT 1;', role + '-wrong-password', allow=True)
        assert bad.returncode != 0 and 'password authentication failed' in bad.stderr, 'WRONG_PASSWORD_REJECTION_' + role
        cases.append({'case': role + '-wrong-password-rejected', 'pass': True})
        other = authenticated(role, password, 'postgres', 'SELECT 1;', role + '-wrong-db', allow=True)
        assert other.returncode != 0 and 'pg_hba.conf rejects connection' in other.stderr, 'CROSS_DATABASE_REJECTION_' + role
        cases.append({'case': role + '-other-db-rejected', 'pass': True})
    untrusted = authenticated(ROLES[4], passwords[1], DB, 'SET ROLE ' + ROLES[3] + ';', 'u-cannot-become-p', allow=True)
    assert untrusted.returncode != 0 and 'permission denied to set role' in untrusted.stderr, 'U_ESCALATION_REJECTION'
    cases.append({'case': 'u-cannot-become-p', 'pass': True})
    item = authenticated(ROLES[4], passwords[1], DB, 'SET ROLE ' + ROLES[1] + '; SELECT id FROM public."ActivityBatchJobItem" LIMIT 0;', 'u-cannot-read-item', allow=True)
    assert item.returncode != 0 and 'permission denied' in item.stderr, 'U_ITEM_REJECTION'
    cases.append({'case': 'u-cannot-read-item-through-c', 'pass': True})
    save('AUTH-CASES.json', cases)
    auth_hash = hashlib.sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest()
    urls = []
    for role, password in zip(ROLES[3:], passwords):
        urls.append('postgresql://' + role + ':' + password + '@127.0.0.1:5432/' + DB + '?connection_limit=1&options=' + quote('-c role=' + ROLES[1], safe=''))
    result = json.loads(probe({'mode': 'qualify', 'identity': identity, 'trustedUrl': urls[0], 'untrustedUrl': urls[1],
                              'installationSha256': install_hash, 'authenticationSha256': auth_hash}, 'actual-production-qualification').stdout)
    assert result['status'] == 'PASS_REAL_AUTHENTICATED_COMPONENTS'
    receipt.update(status='PASS_REAL_AUTHENTICATION_AND_QUALIFICATION', cases=len(cases), qualification=result,
                   elapsedSeconds=time.monotonic() - started)
    save('AUTHENTICATION-RESULT.json', receipt)
    if args.regressions:
        auth_deadline = None
        manifest = json.loads((repo / 'test/r5-authenticated-ci-suites.json').read_text())
        expected_files = {'activity-os-r4-d7-time-correction.e2e-spec.ts',
                          'activity-os-r5-e4-contribution-settlement-correction.e2e-spec.ts',
                          'activity-os-r5-adv010-contribution-progress.e2e-spec.ts',
                          'activity-os-r5-native-admission.e2e-spec.ts'}
        assert len(manifest) == 4 and {r['file'] for r in manifest} == expected_files
        assert all(r['config'] == 'test/jest-r5-ci-authenticated.config.ts' for r in manifest)
        owner_url = 'postgresql://postgres@localhost/' + DB + '?host=' + quote(socket, safe='') + '&connection_limit=1'
        private_input = json.dumps({'identity': identity, 'ownerUrl': owner_url,
                                    'trustedUrl': urls[0], 'untrustedUrl': urls[1],
                                    'installationSha256': install_hash, 'authenticationSha256': auth_hash})
        stages = []
        for index, suite in enumerate(manifest):
            now = datetime.now(timezone.utc)
            if (campaign_end - now).total_seconds() <= 35:
                raise RuntimeError('ORIGINAL_CAMPAIGN_RESERVE_STOP_NO_RESET')
            deadline = time.monotonic() + min(600, (campaign_end - now).total_seconds())
            stage = {'file': suite['file'], 'startedAt': now.isoformat(),
                     'deadline': (now + timedelta(seconds=min(600, (campaign_end - now).total_seconds()))).isoformat(),
                     'limitSeconds': 600, 'campaignDeadline': campaign_end.isoformat()}
            stages.append(stage)
            save('REGRESSION-STAGES.json', stages)
            receipt['businessCalls'] = 'REGRESSION_TEST_PROCESSES_STARTED_NOT_COUNTED'
            p = docker(['exec', '-i', '--env', 'SRVF_R5_CI_AUTHENTICATED=1',
                        app_cid,
                        'node', './node_modules/jest/bin/jest.js', '--config', suite['config'],
                        '--runInBand', '--runTestsByPath', 'test/e2e/' + suite['file']],
                       'regression-' + str(index + 1), text=private_input, timeout=575, allow=True)
            stage.update(exitCode=p.returncode, endedAt=stamp())
            save('REGRESSION-STAGES.json', stages)
            if p.returncode:
                raise RuntimeError('REGRESSION_FAILED_' + suite['file'])
        receipt['status'] = 'PASS_REAL_AUTHENTICATION_AND_ALL_FOUR_REGRESSION_FILES'
except BaseException as error:
    receipt.update(status='FAIL', error={'type': type(error).__name__, 'safeReason': clean(str(error))},
                   elapsedSeconds=time.monotonic() - started)
finally:
    cleanup = {'status': 'NOT_CREATED'}
    try:
        # Resolve a timed-out Docker create before deciding that nothing ran.
        if not cid:
            found = docker(['ps', '-aq', '--filter', 'name=^/' + name + '$', '--filter', 'label=' + label],
                           'resolve-pg-create-outcome', cleanup=True).stdout.strip()
            if found:
                assert re.fullmatch('[a-f0-9]{64}', found)
                assert json.loads(docker(['inspect', '--format', '{{json .Image}}', found], 'resolve-pg-image', cleanup=True).stdout) == PG_IMAGE
                cid = found
        if not app_cid:
            found = docker(['ps', '-aq', '--filter', 'name=^/' + name + '-app$', '--filter', 'label=' + label],
                           'resolve-node-create-outcome', cleanup=True).stdout.strip()
            if found:
                assert re.fullmatch('[a-f0-9]{64}', found)
                app_cid = found
        if app_cid:
            docker(['stop', '--time', '10', app_cid], 'node-stop', cleanup=True, timeout=15)
            docker(['rm', app_cid], 'node-remove', cleanup=True)
        if cid:
            sql('BEGIN;\n' + '\n'.join('ALTER ROLE ' + r + ' NOLOGIN PASSWORD NULL;' for r in ROLES[3:]) + '\nCOMMIT;', 'seal', cleanup=True)
            state = query("SELECT jsonb_build_object('rolesSealed',(SELECT bool_and(NOT rolcanlogin AND rolpassword IS NULL) FROM pg_authid WHERE rolname LIKE 'r5_%'),'otherClients',(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()),'prepared',(SELECT count(*) FROM pg_prepared_xacts));", 'independent-closeout', cleanup=True)
            assert state['rolesSealed'] and state['otherClients'] == state['prepared'] == 0
            docker(['exec', '--user', 'postgres', cid, 'pg_ctl', '-D', '/var/lib/postgresql/data', '-m', 'fast', '-w', '-t', '10', 'stop'], 'pg-normal-stop', cleanup=True, timeout=15, allow=True)
            exited = docker(['wait', cid], 'pg-wait', cleanup=True, timeout=10)
            assert exited.stdout.strip() == '0'
            docker(['rm', cid], 'pg-remove', cleanup=True)
            left = docker(['ps', '-aq', '--filter', 'label=' + label], 'no-containers', cleanup=True).stdout.strip()
            assert not left
            cleanup = {'status': 'PASS', 'sealed': state, 'matchingContainers': 0, 'persistentVolumes': 0}
        if socket_volume:
            docker(['volume', 'rm', socket_volume], 'socket-tmpfs-remove', cleanup=True)
            left = docker(['volume', 'ls', '--quiet', '--filter', 'label=' + label], 'no-socket-volumes', cleanup=True).stdout.strip()
            assert not left
            cleanup['ephemeralSocketVolumesRemaining'] = 0
    except BaseException as error:
        cleanup = {'status': 'UNKNOWN_REQUIRES_INSPECTION_NO_REPLAY', 'type': type(error).__name__, 'safeReason': clean(str(error))}
    save('CLEANUP.json', cleanup)
    receipt['cleanup'] = cleanup
    save('RESULT.json', receipt)
    print(json.dumps({'status': receipt['status'], 'error': receipt.get('error'),
                      'cleanup': cleanup['status'], 'elapsedSeconds': time.monotonic() - started}), flush=True)
raise SystemExit(0 if receipt['status'].startswith('PASS') and receipt['cleanup']['status'] == 'PASS' else 1)
