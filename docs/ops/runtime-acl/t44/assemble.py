"""Prepare, apply or withdraw the T43 registration ACL on a disposable SRVF test stack."""
import argparse
import fcntl
import json
import os
import re
import subprocess
from pathlib import Path

ROLE = 'srvf_dp_acceptance_runtime'
DB = 'srvf_staging'
IMAGE = 'sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75'
DELTA = [
    ('ActivityParticipationIdentity', 'INSERT', 'id createdAt updatedAt activityId sessionId registrationId memberId currentRevision currentStatusCode currentPositionId populationIncluded version'),
    ('ActivityParticipationIdentity', 'UPDATE', 'updatedAt currentRevision currentStatusCode currentPositionId capacityReservationId populationIncluded version'),
    ('organization_closure', 'UPDATE', 'depth'),
    ('ActivityEvidenceState', 'INSERT', 'id createdAt updatedAt activityId evidenceRevision populationRevision version lastPopulationAt'),
    ('ActivityEvidenceState', 'UPDATE', 'updatedAt populationRevision version lastPopulationAt'),
]

def run(*args, sql=None):
    return subprocess.check_output(args, input=sql, text=True).strip()

def require(condition, reason):
    if not condition:
        raise SystemExit(reason)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'rehearse', 'apply', 'withdraw'])
    parser.add_argument('--expected-cluster', required=True)
    args = parser.parse_args()
    directory = Path.cwd().resolve()
    require(directory.parent == Path('/var/tmp') and re.fullmatch(r'srvf-t[0-9]+\.[a-zA-Z0-9]{8}', directory.name), 'not an isolated trial directory')
    name = (directory/'name').read_text().strip()
    require(name == directory.name.replace('.', '-'), 'unexpected stack name')
    require(run('docker', 'network', 'inspect', '-f', '{{.Internal}}', name)=='true', 'network is not internal')
    for suffix in ['-api','-pg']:
        require(run('docker','inspect','-f','{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}',name+suffix)==name, 'unexpected network attachment')
        require(run('docker','inspect','-f','{{len .HostConfig.PortBindings}}',name+suffix)=='0', 'host port published')
    require(run('docker','inspect','-f','{{.Image}}',name+'-api')==IMAGE,'unexpected API image')
    tmpfs=json.loads(run('docker','inspect','-f','{{json .HostConfig.Tmpfs}}',name+'-pg'))
    require('/var/lib/postgresql/data' in (tmpfs or {}),'PG data directory must be tmpfs')
    def psql(sql):
        return run('docker','exec','-i',name+'-pg','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB,sql=sql)
    cid=args.expected_cluster
    require(re.fullmatch(r'[0-9]{1,20}',cid) and psql('SELECT system_identifier::text FROM pg_control_system()')==cid,'cluster mismatch')
    check = f"""DO $$ BEGIN IF current_database()<>'{DB}' OR (SELECT system_identifier::text FROM pg_control_system())<>'{cid}'
        OR (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)<>156
        OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{ROLE}' AND NOT rolsuper AND NOT rolbypassrls)
        THEN RAISE EXCEPTION 'wrong target'; END IF; END $$;"""
    rows=[]; grants=[]; revokes=[]
    for table, privilege, names in DELTA:
        rel='public."'+table+'"'
        cols=names.split()
        require(psql(f"SELECT pg_has_role('{ROLE}',relowner,'MEMBER') FROM pg_class WHERE oid='{rel}'::regclass;")=='f','runtime owns target')
        for col in cols:
            rows.append(f"has_column_privilege('{ROLE}','{rel}','{col}','{privilege}')")
        fields=','.join('"'+col+'"' for col in cols)
        grants.append(f'GRANT {privilege} ({fields}) ON {rel} TO {ROLE};')
        revokes.append(f'REVOKE {privilege} ({fields}) ON {rel} FROM {ROLE};')
    def baseline(present):
        predicates=[p if present else 'NOT '+p for p in rows]
        return 'DO $$ BEGIN IF NOT ('+' AND '.join(predicates)+") THEN RAISE EXCEPTION 'ACL does not match expected state'; END IF; END $$;"
    receipt=directory/'t43-registration-acl-receipt.json'
    expected={'cluster':cid,'db':DB,'role':ROLE,'image':IMAGE,'grants':grants}
    with (directory/'.t43-acl.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        old=json.loads(receipt.read_text()) if receipt.exists() else None
        if old is not None: require(old==expected,'receipt differs from current target')
        if args.mode=='check':
            psql(check+baseline(old is not None))
        elif args.mode=='rehearse':
            require(old is None,'trial already applied')
            psql('BEGIN;'+check+baseline(False)+''.join(grants)+baseline(True)+''.join(revokes)+baseline(False)+'ROLLBACK;')
        elif args.mode=='apply':
            if old:
                psql(check+baseline(True))
            else:
                # Record the complete intended delta before COMMIT so a lost exit can be reconciled.
                psql(check+baseline(False))
                with receipt.open('x') as f:
                    json.dump(expected,f); f.flush(); os.fsync(f.fileno())
                psql('BEGIN;'+check+baseline(False)+''.join(grants)+baseline(True)+'COMMIT;')
        elif old:
            # A failed atomic apply or interrupted withdrawal can leave the baseline intact.
            none_effective=psql('SELECT NOT ('+' OR '.join(rows)+');')=='t'
            if none_effective:
                psql(check+baseline(False))
            else:
                psql('BEGIN;'+check+baseline(True)+''.join(revokes)+baseline(False)+'COMMIT;')
            receipt.unlink()
        else:
            psql(check+baseline(False))
    print(args.mode, 'OK;', len(rows),'column privileges, 3 relations')
if __name__=='__main__':
    os.umask(0o077)
    main()
