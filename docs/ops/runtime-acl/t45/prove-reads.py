"""Check the real normalized successful SELECTs with and without each added column."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
from acl import DB,ROLE,identity,identifier
sql=identity(sys.argv[1])
name=Path('name').read_text().strip()
receipt=json.loads(Path('t45-'+(sys.argv[2] if len(sys.argv)>2 else 'read')+'-receipt.json').read_text())
assert receipt['cluster']==sys.argv[1]
targets={t for t,op,c in receipt['delta']}
history=json.loads(sql(f"""select coalesce(json_agg(query),'[]') from pg_stat_statements
 where userid=(select oid from pg_roles where rolname='{ROLE}')
 and dbid=(select oid from pg_database where datname=current_database())
 and ltrim(query) LIKE 'SELECT%'"""))
def checks(query,pre=''):
    # PostgreSQL assigns a fresh ACL snapshot in each transaction. Never execute a stored query.
    assert query.lstrip().startswith('SELECT ') and ';' not in query and '--' not in query and '/*' not in query
    cmd="BEGIN; "+pre+' SET LOCAL ROLE '+ROLE+'; SET TRANSACTION READ ONLY;' if not pre else 'BEGIN; '+pre+' SET LOCAL ROLE '+ROLE+';'
    s=cmd+" SET LOCAL statement_timeout='2s'; EXPLAIN (GENERIC_PLAN TRUE) "+query+"; ROLLBACK;"
    p=subprocess.run(['docker','exec','-i',name+'-pg','psql','-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U','postgres','-d',DB],input=s,text=True,capture_output=True)
    if p.returncode==0:return '00000'
    m=re.search(r'ERROR:\s+([A-Z0-9]{5}):',p.stderr)
    return m[1] if m else 'unknown'
candidates={t:[] for t in targets}
for q in history:
    for t in targets:
        if identifier(t) not in q:continue
        if checks(q)=='00000':candidates[t].append(q)
for t,op,c in receipt['delta']:
    assert op=='SELECT'
    revoke=f'REVOKE SELECT ({identifier(c)}) ON public.{identifier(t)} FROM {ROLE};'
    witnesses=[x for x in candidates[t] if checks(x,revoke)=='42501']
    if not witnesses:raise SystemExit('no actual SQL witness: '+t+'.'+c)
    print(json.dumps(dict(table=t,column=c,with_grant='00000',after_single_revoke='42501',query_sha256=hashlib.sha256(witnesses[0].encode()).hexdigest())))
