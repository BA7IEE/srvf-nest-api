import re,json,pathlib,collections
p=pathlib.Path(__file__).resolve().parent
rows=list(map(json.loads,(p/'acl.jsonl').read_text().splitlines()))
base={(t,k):set(c) for t,k,_,c in rows}
sql=(p/'functional-trace.sql').read_text()
need=collections.defaultdict(set)
for t,cols in re.findall(r'INSERT INTO "public"\."(\w+)" \(([^)]+)\)',sql):
 need[t,'INSERT'].update(re.findall(r'"(\w+)"',cols))
for t,cols in re.findall(r'UPDATE "public"\."(\w+)" SET (.*?) WHERE',sql):
 need[t,'UPDATE'].update(re.findall(r'"(\w+)" = ',cols))
# Only SELECT statements and RETURNING/WHERE projections require reads.
for stmt in re.split(r'(?m)(?=^(?:INSERT INTO|SELECT |UPDATE |BEGIN|COMMIT|ROLLBACK))',sql):
 if stmt.startswith('INSERT'):stmt=stmt.partition('RETURNING')[2]
 for t,c in re.findall(r'"public"\."(\w+)"\."(\w+)"',stmt):
  if (t,'SELECT') in base:need[t,'SELECT'].add(c)
delta={k:sorted(v-base[k]) for k,v in need.items() if v-base[k]}
for action in ['grant','revoke']:
 lines=[]
 for (table,priv),cols in sorted(delta.items()):
  collist=','.join('"'+c+'"' for c in cols)
  lines.append(f'{action.upper()} {priv} ({collist}) ON public."{table}" '+('TO' if action=='grant' else 'FROM')+' lab_runtime;')
 (p/('lab-'+action+'s.sql')).write_text('\n'.join(lines)+'\n')
print([(k,len(v)) for k,v in sorted(delta.items())])
