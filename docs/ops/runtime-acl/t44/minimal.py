"""Reconcile observed Prisma write projections and test individual privileges inside rolled-back transactions."""
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

from assemble import DB, ROLE, DELTA

def main():
    cid=sys.argv[1]
    subprocess.run(['python3','closure_guard.py','verify','--expected-cluster',cid],check=True,stdout=subprocess.DEVNULL)
    n=Path('name').read_text().strip()
    def test(sql, expected='00000', *, reason=None):
        run=subprocess.run(['docker','exec','-i',n+'-pg','psql','-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U','postgres','-d',DB],text=True,input='BEGIN; SET LOCAL lock_timeout=\'3s\';'+sql+';ROLLBACK;',capture_output=True)
        err=re.search(r'ERROR:\s+([A-Z0-9]{5}):',run.stderr)
        state=err.group(1) if err else '00000'
        if state!=expected or run.returncode!=(0 if expected=='00000' else 3) or (reason and reason not in run.stderr):
            raise RuntimeError(f'unexpected SQLSTATE={state}, exit={run.returncode}')
        return state
    shapes=[json.loads(l) for l in Path('shapes.jsonl').read_text().splitlines()]
    guard=f'SET LOCAL ROLE {ROLE}; '
    for table,op,declared in DELTA:
        rel='public."'+table+'"'
        if table=='organization_closure':
            lock='SELECT "ancestorId" FROM public.organization_closure WHERE "descendantId" IN (SELECT "descendantId" FROM public.organization_closure LIMIT 1) ORDER BY "ancestorId" FOR SHARE'
            test(guard+lock)
            state=test(f'REVOKE UPDATE(depth) ON {rel} FROM {ROLE}; '+guard+lock,'42501',reason='permission denied for table organization_closure')
            print(json.dumps(dict(table=table,op=op,column='depth',actual='FOR SHARE',with_all='00000',without=state)))
            for pred in ['false','"ancestorId"="descendantId"']:
                test(guard+'UPDATE public.organization_closure SET depth=depth+1 WHERE '+pred,'42501',reason='trial registration role cannot update organization closure')
            test('UPDATE public.organization_closure SET depth=depth WHERE false')
            continue
        seen=[row for row in shapes if row['table']==table and row['op']==op]
        union=set().union(*(set(row['columns']) for row in seen))
        assert union==set(declared.split()), (table,op,union)
        for name in sorted(union):
            shape=next(row for row in seen if name in row['columns'])
            cols=['"'+c+'"' for c in shape['columns']]
            assert all(re.fullmatch(r'"[a-zA-Z0-9_]+"',c) for c in cols)
            fields=','.join(cols)
            if op=='INSERT':
                sql=f'INSERT INTO {rel} ({fields}) SELECT {fields} FROM {rel} WHERE false'
            else:
                sql='UPDATE '+rel+' SET '+','.join(c+'='+c for c in cols)+' WHERE false'
            test(guard+sql)
            state=test(f'REVOKE {op} ("{name}") ON {rel} FROM {ROLE}; '+guard+sql,'42501',reason='permission denied for table '+table)
            print(json.dumps(dict(table=table,op=op,column=name,actual='observed write projection',with_all='00000',without=state)))
if __name__=='__main__':
    main()
