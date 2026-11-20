"""Isolated only. PG16 checks the traced statements with one grant omitted each time."""
import os,pathlib,re,subprocess,json
p=pathlib.Path(__file__).resolve().parent
stmts=[q.strip() for q in (p/'functional-trace.sql').read_text().splitlines()
       if q.startswith(('SELECT "public".','INSERT INTO "public".','UPDATE "public".'))]
stmts=list(dict.fromkeys(stmts))
role='srvf_dp_acceptance_runtime'
cases=[]
for line in (p/'lab-grants.sql').read_text().splitlines():
 priv,cols,t=re.fullmatch(r'GRANT (\w+) \((.+)\) ON public\."(\w+)" TO lab_runtime;',line).groups()
 for col in re.findall(r'"(\w+)"',cols):
  targets=[q for q in stmts if f'"public"."{t}"' in q and f'"{col}"' in q]
  cases.append((t,priv,col,targets))
sql=['BEGIN;','CREATE TEMP TABLE proofs(t text,k text,c text,n int);']
for t,priv,col,targets in cases:
 # A statement must plan successfully before this specific permission is removed.
 sql+=['SAVEPOINT each;',f'SET LOCAL ROLE {role};']
 for i,q in enumerate(targets):
  sql.append(f"DO $$ BEGIN PERFORM set_config('lab.ok{i}','no',true); EXECUTE $q$EXPLAIN (GENERIC_PLAN) {q}$q$; PERFORM set_config('lab.ok{i}','yes',true); EXCEPTION WHEN OTHERS THEN NULL; END $$;")
 sql+=['RESET ROLE;',f'REVOKE {priv} ("{col}") ON public."{t}" FROM {role};',f'SET LOCAL ROLE {role};',"SELECT set_config('lab.proof','0',true);"]
 for i,q in enumerate(targets):
  sql.append(f"DO $$ BEGIN IF current_setting('lab.ok{i}',true)='yes' THEN EXECUTE $q$EXPLAIN (GENERIC_PLAN) {q}$q$; END IF; EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('lab.proof','1',true); END $$;")
 sql+=['RESET ROLE;',f"SELECT current_setting('lab.proof') as proof \\gset",'ROLLBACK TO each;',f"INSERT INTO proofs VALUES ('{t}','{priv}','{col}',:proof);"]
sql+=["SELECT json_agg(proofs) FROM proofs;",'ROLLBACK;']
out=subprocess.run(['docker','exec','-i',os.environ['CONTAINER'],'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','srvf_staging'],input='\n'.join(sql),text=True,capture_output=True,check=True)
data=json.loads(out.stdout[out.stdout.index('[{'):]);(p/'column-proofs.json').write_text(json.dumps(data,indent=2))
print('one-column removal 42501 witnesses',sum(x['n'] for x in data),'/',len(data))
