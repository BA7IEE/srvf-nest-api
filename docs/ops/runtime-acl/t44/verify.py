"""Recompute the scoped T44 conclusions offline using only sanitized receipts."""
from pathlib import Path
import json
from assemble import DELTA, IMAGE

root = Path(__file__).resolve().parent

def rows(name):
    return [json.loads(s) for s in (root/name).read_text().splitlines() if s.startswith('{')]

def workload(name, step, status, code):
    matches = [r for r in rows(name) if r.get('step',r.get('label')) == step]
    assert matches and all(r['status']==status and r['code']==code and r['reqId'] for r in matches), step
    return matches

columns = rows('minimum.jsonl')
wanted = {(t,op,col) for t,op,names in DELTA for col in names.split()}
assert len(columns)==len(wanted)==32
assert {(r['table'],r['op'],r['column']) for r in columns}==wanted
assert all(r['with_all']=='00000' and r['without']=='42501' for r in columns)
for t,op,names in DELTA:
    if t!='organization_closure':
        shapes = [s for s in rows('shapes.jsonl') if s['table']==t and s['op']==op]
        assert set(names.split())=={col for s in shapes for col in s['columns'] if s['calls']>0}
c, = rows('closure-matrix.jsonl')
assert c['lock_on_existing_row'] and c['closure_row_count']>0 and c['unchanged']
assert c['direct_update_zero_rows']==c['direct_update_existing_roots']=='42501'
assert c['owner_zero_row_update']=='00000'
enroll = workload('enroll.log','enroll',201,0)
workload('enroll.log','exact_replay',201,0)
workload('enroll.log','changed_payload',409,21003)
workload('enroll.log','cross_read',404,21001)
workload('cancel.log','cross_cancel',404,21001)
workload('cancel.log','self_cancel',200,0)
workload('cancel.log','repeat_cancel',409,21030)
db=rows('after-withdraw.jsonl')
assert {r['reqId'] for r in db if r['kind']=='audit' and r['event']=='registration.create'}=={r['reqId'] for r in enroll}
assert {r['actor']:r['status'] for r in db if r['kind']=='registration' and r['role']=='USER' and r['direct_bindings']==0}=={'t44-user-a':'cancelled','t44-user-b':'pass'}
assert sum(r['kind']=='outbox' and r['aggregate']=='activity_registration' and r['state']=='succeeded' and r['completed'] for r in db)==3
assert (root/'after-worker.jsonl').read_bytes()==(root/'after-withdraw.jsonl').read_bytes()
assert rows('restored-acl.jsonl')==rows('baseline-acl.jsonl')
check, = rows('restored-check.jsonl')
assert check['guard_removed'] and check['closure_fixture_rolled_back'] and check['queue_outstanding']==0 and check['audit_rows']>0
workload('scan-in.log','self_check-in',503,20153)
assert (root/'scan-in.exit').read_text().strip()=='1'
assert rows('downstream-db.jsonl')[0]=={'punch_events':0,'service_segments':0}
for name,step,table in [('summary-diag.log','diagnostic_summary','ActivityTimeCutoverReceipt'),('workbench-diag.log','diagnostic_workbench','ActivitySettlementClosureRevision')]:
    rec,=workload(name,step,500,50000)
    line,=[s for s in (root/name).read_text().splitlines() if s.startswith('T44ERR ')]
    evidence=json.loads(line.removeprefix('T44ERR '))
    assert evidence['table']==table and evidence['id']==rec['reqId']
workload('post.log','revoke_qr',200,0)
assert rows('post.log')[-1]=={'step':'retire_assert','only_credential':'revoked'}
assert 'REQUIRED: false' in (root/'redzone.log').read_text()
assert IMAGE in (root/'pair.log').read_text()
print('T44 receipts OK: 32 individual privilege checks, depth write refusal, two member flows, punch gate, two correlated failures and trial rollback.')
