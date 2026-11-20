"""Show a real PG planning witness for each isolated check-in column delta."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
from acl import DB, ROLE, identity, identifier
sql=identity(sys.argv[1])
name=Path('name').read_text().strip()
receipt=json.loads(Path('t45-punch-receipt.json').read_text())
assert receipt['cluster']==sys.argv[1]
targets={t for t,op,c in receipt['delta']}
history=json.loads(sql(f"""select coalesce(json_agg(query),'[]') from pg_stat_statements
 where userid=(select oid from pg_roles where rolname='{ROLE}')
 and dbid=(select oid from pg_database where datname=current_database())
 and ltrim(query) ~ '^(SELECT|INSERT INTO|UPDATE) '"""))
# pg_stat_statements normally tracks outer statements. This is the INVOKER guard's
# ordinary INSERT branch, with the PL/pgSQL NEW.id expression supplied as a parameter.
trigger='SELECT "applicationId" FROM public."CorrectionPendingTimeAllocation" WHERE "targetSegmentRevisionId"=$1::text'
def state(q,rev=''):
    assert ';' not in q and '--' not in q and '/*' not in q
    q0=q.lstrip()
    assert any(q0.startswith(prefix) for prefix in ['SELECT ','INSERT INTO ','UPDATE '])
    cmd='BEGIN; '+rev+' SET LOCAL ROLE '+ROLE+"; SET LOCAL statement_timeout='3s'; EXPLAIN (GENERIC_PLAN TRUE) "+q+';ROLLBACK;'
    p=subprocess.run(['docker','exec','-i',name+'-pg','psql','-XqAt','-v','VERBOSITY=verbose','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB],input=cmd,capture_output=True,text=True)
    if p.returncode==0:return '00000'
    m=re.search(r'ERROR:\s+([A-Z0-9]{5}):',p.stderr)
    return m[1] if m else 'unknown'
bytable={}
for t in sorted(targets):
    qs=[trigger] if t=='CorrectionPendingTimeAllocation' else [q for q in history if identifier(t) in q and all(x not in q for x in (';','--','/*'))]
    bytable[t]=[q for q in qs if state(q)=='00000']
for t,op,c in receipt['delta']:
    rev=f'REVOKE {op} ({identifier(c)}) ON public.{identifier(t)} FROM {ROLE};'
    qs=[q for q in bytable[t] if identifier(c) in q and (op=='SELECT' or q.lstrip().startswith(op+' '))]
    witness=next((q for q in qs if state(q,rev)=='42501'),None)
    if not witness:raise SystemExit('missing real SQL witness '+t+'.'+op+'.'+c)
    print(json.dumps(dict(table=t,op=op,column=c,with_grant='00000',after_single_revoke='42501',source='invoker_trigger' if witness==trigger else 'pg_stat_statements',query_sha256=hashlib.sha256(witness.encode()).hexdigest())),flush=True)
