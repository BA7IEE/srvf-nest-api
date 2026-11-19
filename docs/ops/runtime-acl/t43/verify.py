import json
from pathlib import Path
def rows(name):
    return [json.loads(line) for line in Path(name).read_text().splitlines() if line.startswith('{')]
def one(seq):
    items=list(seq);assert len(items)==1,len(items);return items[0]
def stage(state,kind):
    return [x for x in state if x['kind']==kind]
trace=rows('state-update-trace.jsonl')
for path,table,kind in [('baseline','ActivityParticipationIdentity','FOR UPDATE'),('after-lock','organization_closure','FOR SHARE'),('after-cover','ActivityParticipationIdentity','INSERT'),('after-insert','ActivityEvidenceState','FOR UPDATE'),('state-update','ActivityEvidenceState','INSERT')]:
    h=one(x for x in rows(path+'-http.log') if x['status']==500)
    assert h['code']==50000
    same=[x for x in trace if x['id']==h['reqId']]
    assert len({x['pid'] for x in same})==1
    assert one(x for x in same if x.get('phase')=='enter')['role']=='srvf_dp_acceptance_runtime'
    assert one(x for x in same if x.get('phase')=='exception')['phase']=='exception'
    err=one(x for x in same if x.get('kind')=='ERROR')
    sql=one(x for x in same if x.get('kind')=='STATEMENT')
    assert err['sqlstate']=='42501' and err['table']==table and (sql['op']==kind or sql['row_lock']==kind)
h=one(x for x in rows('after-closure-http.log') if x['status']==409)
assert h['code']==26030
assert rows('baseline.jsonl')==rows('before-stock.jsonl')
enrol=rows('enroll-stock.log');cancel=rows('cancel-stock.log')
first=rows('after-enroll.jsonl');last=rows('after-cancel.jsonl');done=rows('after-worker.jsonl')
for data,expected in [(first,['pass','pass']),(last,['cancelled','pass'])]:
    regs=stage(data,'registration')
    assert [x['status'] for x in regs]==expected
    assert all(x['role']=='USER' and x['direct_bindings']==0 for x in regs)
    assert [x['active_reservations'] for x in regs]==([3,3] if data is first else [0,3])
    assert [x['saved_revisions'] for x in regs]==([1,1] if data is first else [2,1])
    assert all(x['used']==(2 if data is first else 1) for x in stage(data,'bucket'))
for x in enrol+cancel:
    relevant=[a for a in stage(last,'audit') if a['reqId']==x['reqId']]
    if x['label']=='enroll':
        assert x['status']==201 and sorted(a['event'] for a in relevant)==['registration.create','registration.review']
    elif x['label']=='self_cancel':
        assert x['status']==200 and [a['event'] for a in relevant]==['registration.review']
    elif x['label'] in ['exact_replay','changed_payload','cross_read','cross_cancel','repeat_cancel']:
        assert not relevant
        assert (x['status'],x['code'])=={'exact_replay':(201,0),'changed_payload':(409,21003),'cross_read':(404,21001),'cross_cancel':(404,21001),'repeat_cancel':(409,21030)}[x['label']]
    for a in relevant:
        assert a['actor']==x['actor'] and a['success'] and a['resource']==one(r['header'] for r in stage(last,'registration') if r['actor']==x['actor'])
assert len(stage(last,'audit'))==5
assert len(stage(first,'outbox'))==4 and len(stage(last,'outbox'))==5
assert [x for x in last if x['kind']!='outbox']==[x for x in done if x['kind']!='outbox']
intents=rows('registration-intents.jsonl')
assert len(intents)==3 and all(i['state']=='succeeded' and i['attempts']==1 and i['completed'] and i['sent'] for i in intents)
assert {i['intent'] for i in intents}=={x['id'] for x in stage(done,'outbox') if x['aggregate']=='activity_registration'}
assert sorted(i['header'] for i in intents)==sorted([stage(last,'registration')[0]['header']]*2+[stage(last,'registration')[1]['header']])
assert all(i['state']=='succeeded' and i['attempts']==1 for i in stage(done,'outbox'))
assert rows('withdrawn-state.jsonl')==done==rows('after-assembly.jsonl')
assert one(x for x in rows('withdrawn-http.log') if x['status']==500)['code']==50000
assert rows('mobile-page.log')[0]['api_requests']==0 and rows('mobile-page.log')[0]['observed']=='服务尚未接通'
print('PASS five correlated PostgreSQL 42501 blocks, insurance 26030, no partial write')
print('PASS stock API: two unprivileged members, real registrations/replays/conflicts/reads/cancels, five audits, three linked worker intents')
print('PASS fixture ACL restored with business history preserved; mobile entry closed as observed')
