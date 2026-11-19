import json
from pathlib import Path
def records(file):
    return [json.loads(line) for line in Path(file).read_text().splitlines() if line.startswith('{')]
def one(items):
    assert len(items)==1, len(items)
    return items[0]
pre,post=records('final-before.jsonl'),records('final-after.jsonl')
before,after=one([r for r in pre if 'hash'in r]),one([r for r in post if 'hash'in r])
assert before==after
assert before['active_reservations']==6 and len(before['buckets'])==3
assert all(r[1] is None and r[2]==2 for r in before['buckets'])
reviews=sorted([r for r in post if 'kind'in r],key=lambda r:r['version'])
assert [(r['kind'],r['status'],r['activity_target']) for r in reviews]==[
    ('initial','approved',2),('change','approved',12),('change','approved',None),('change','pending',1)]
assert all(r['activity_target']==r['session_target']==r['position_target'] and r['schedule_consistent'] and r['places_unchanged'] for r in reviews)
assert all(r['independent'] and r['submitted_role']==r['reviewed_role']=='USER' for r in reviews[:3])
assert sorted([r for r in pre if 'kind'in r],key=lambda r:r['version'])==reviews[:3]
assert reviews[3]['reviewed_role'] is None
audits=[r for r in post if r.get('event','').startswith('activity.')]
logged=records('final-layout.log')+records('final-occupied-retry.log')
writes=[r for r in logged if r['path'].endswith(('/change-reviews','/approve','/from-template','/publish-reviews')) and r['status']!=403]
for r in writes:
    matching=[a['event'] for a in audits if a['reqId']==r['reqId']]
    if r['status'] in (200,201): assert matching,(r,matching)
    else: assert not matching,(r,matching)
    r['audit_events']=matching
assert sorted(r['code'] for r in writes if r['status']==400)==[20015,20134,40000]
assert one([r for r in writes if r['status']==409])['code']==20147
out={'basis':'isolated PostgreSQL and Chromium; synthetic ordinary owner and reviewer',
     'before_failed_capacity_decision':before,'after_failed_capacity_decision':after,'reviews':reviews,'requests':writes}
Path('reconciled.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(f"PASS DB aggregate, 3 buckets, 6 reservations, 4 reviews, {len(writes)} HTTP to audit correlations")
