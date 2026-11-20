"""Apply a reviewed column delta on a verified, exclusive SRVF T45 disposable PG."""
import argparse,hashlib,json,os,re,subprocess
from pathlib import Path
from fcntl import flock,LOCK_EX
DB = "srvf_staging"
ROLE = "srvf_dp_acceptance_runtime"
IMAGE = "sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75"
APPROVED_TRIAL_SHAPES = {'read': '68406fa34de39f046bb8c84955026929aa9bf1382aae7d315d24687e59892d80', 'ledger-on': '7e0fd4e55191f5eae9f28f8fcb7bb61996ddc39f8963163b446b990642976401', 'punch': 'bcccb9b98ece71b35d5e024e269e8f4e9eb4ad4283e2dc9c96e67181ae201521'}
ROOT=Path.cwd()
def require(ok,message):
    if not ok: raise SystemExit(message)
def run(args,data=None):
    p=subprocess.run(args,input=data,text=True,capture_output=True)
    if p.returncode:
        errors=re.findall(r'(?:ERROR|FATAL):\s+([^\n]{1,140})',p.stderr)
        raise RuntimeError((errors or ['command failed'])[0])
    return p.stdout.strip()
def identity(cluster):
    name=ROOT.name.replace('.','-')
    require(ROOT.parent==Path('/var/tmp') and re.fullmatch(r'srvf-t45\.[A-Za-z0-9]{8}',ROOT.name) and (ROOT/'name').read_text().strip()==name,'wrong isolated stack')
    require(run(['docker','network','inspect','-f','{{.Internal}}',name])=='true','external network')
    for suffix in ['api','pg']:
        require(run(['docker','inspect','-f','{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}/{{len .HostConfig.PortBindings}}',name+'-'+suffix])==name+'/0','exposed or wrong service')
    require(run(['docker','inspect','-f','{{.Image}}',name+'-api'])==IMAGE,'unexpected image')
    require('/var/lib/postgresql/data' in json.loads(run(['docker','inspect','-f','{{json .HostConfig.Tmpfs}}',name+'-pg'])),'not tmpfs')
    def sql(s):
        return run(['docker','exec','-i',name+'-pg','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB],s)
    require(re.fullmatch('[0-9]{10,20}',cluster) and sql('select system_identifier from pg_control_system()')==cluster,'wrong cluster')
    require(sql(f"""select current_database()='{DB}' AND (select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null)=156 AND EXISTS(select from pg_roles where rolname='{ROLE}' and not rolsuper and not rolbypassrls and not rolcreaterole)""")=='t','wrong DB profile')
    return sql
def identifier(v):
    require(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*',v),'invalid identifier')
    return '"'+v+'"'
def main():
    os.umask(0o077)
    cli=argparse.ArgumentParser()
    cli.add_argument('action',choices=['preview','apply','withdraw'])
    cli.add_argument('pack',choices=['read','punch','ledger-on'])
    cli.add_argument('--expected-cluster',required=True)
    a=cli.parse_args()
    sql=identity(a.expected_cluster)
    spec=json.loads(Path(a.pack+'-contract.json').read_text())
    digest=hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()
    require(APPROVED_TRIAL_SHAPES[a.pack]==digest, 'unexpected trial contract digest')
    with Path('.t45-acl.lock').open('a') as lock:
        flock(lock,LOCK_EX)
        absent=[];present=[]
        for t,ops in spec.items():
            tab='public.'+identifier(t)
            require(sql(f"select not(pg_has_role('{ROLE}',relowner,'MEMBER') or relrowsecurity) from pg_class where oid='{tab}'::regclass")=='t','unexpected ownership or RLS')
            for op,cols in ops.items():
                require(op=='SELECT' if a.pack in ('read','ledger-on') else op in ('SELECT','UPDATE','INSERT'),'unsupported operation')
                for col in cols:
                    identifier(col)
                    require(sql(f"select count(*) from pg_attribute where attrelid='{tab}'::regclass and attname='{col}' and attnum>0 and not attisdropped")=='1','unknown column')
                    (present if sql(f"select has_column_privilege('{ROLE}','{tab}','{col}','{op}')")=='t' else absent).append([t,op,col])
        receipt=ROOT/('t45-'+a.pack+'-receipt.json')
        old=json.loads(receipt.read_text()) if receipt.exists() else None
        def change(items,undo=False):
            parts=[]
            for t,op,c in items:
                tab='public.'+identifier(t); col=identifier(c)
                parts.append(f"{'REVOKE' if undo else 'GRANT'} {op} ({col}) ON {tab} {'FROM' if undo else 'TO'} {ROLE};")
            return '\n'.join(parts)
        def checks(rows,on):
            parts=[f"has_column_privilege('{ROLE}','public.{identifier(t)}','{c}','{op}')" for t,op,c in rows]
            return 'DO $$BEGIN IF NOT ('+(' AND '.join(('' if on else 'NOT ')+x for x in parts) or 'TRUE')+") THEN RAISE EXCEPTION 'privilege drift'; END IF; END$$;"
        if old:require(old['cluster']==a.expected_cluster and old['hash']==digest and sorted(old['delta']+old['baseline'])==sorted(absent+present),'receipt mismatch')
        if a.action=='preview':pass
        elif a.action=='apply':
            if not old:
                old=dict(cluster=a.expected_cluster,hash=digest,delta=absent,baseline=present)
                with receipt.open('x') as f:
                    json.dump(old,f);f.flush();os.fsync(f.fileno())
            already=all(x in present for x in old['delta'])
            if not already:
                require(old['delta']==absent,'partial apply or baseline drift')
                sql('BEGIN;'+checks(old['baseline'],True)+checks(old['delta'],False)+change(old['delta'])+checks(old['delta'],True)+'COMMIT;')
            else:require(not absent,'baseline drift')
        elif a.action=='withdraw':
            if old:
                effective=[x for x in old['delta'] if x in present]
                require(effective==old['delta'] or not effective,'partial rollback or drift')
                sql('BEGIN;'+checks(old['baseline'],True)+change(effective,True)+checks(old['delta'],False)+'COMMIT;');receipt.unlink()
        print(json.dumps(dict(action=a.action,pack=a.pack,cluster=a.expected_cluster,spec_sha256=digest,missing_before=absent,existing_before=present,recorded_delta=old['delta'] if old else [])))
if __name__=='__main__':main()
