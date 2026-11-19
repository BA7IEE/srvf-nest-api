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
logged=records('final-layout.log')+records('occupied.log')
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

metrics=records("all-five.jsonl")
types=["boolean","non_negative_integer","non_negative_decimal","short_text","single_choice"]
assert [m["id"] for m in metrics]==[r["id"] for r in reviews]
assert len({m["set_hash"] for m in metrics})==1
for m in metrics:
    assert m["matches"] and m["activity_metric"]=="required" and m["template"]=="t37-five-v1"
    assert m["set"]=="t37_full_set" and m["set_version"]==1
    assert m["required_kinds"]==[[kind,True] for kind in types]
browser_text=Path("final-layout.log").read_text()+Path("occupied.log").read_text()
for m in metrics:
    assert browser_text.count("PASS five required definitions, limits and both options visible on review "+m["id"])==1
assert "incomplete five-metric set and undisclosed place difference each blocked with zero approval requests" in browser_text
layers=one(records("final-layers.jsonl"))
assert layers==one(records("positive-layers.jsonl"))
assert layers["activity_time"]==layers["session_time"] and layers["activity_location"]==layers["session_location"]
assert layers["actual_capacity"]==[None,None,None] and layers["position_matches_snapshot"]
assert layers["structured_place_match"] and layers["frozen_windows_match"]
assert layers["session_windows"]==["2026-12-03T02:00:00","2026-12-03T02:20:00","2026-12-03T03:40:00","2026-12-03T04:00:00",None]
assert one(records("registration-before.jsonl"))==one(records("registration-after-enroll.jsonl"))
out.update(frozen_metric_set=metrics,actual_layers=layers)
Path("reconciled.json").write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n")
print("PASS five required kinds across all four frozen reviews and four rendered review decisions; persisted windows agree; failed enrollment left no header, revision, identity or occupancy")
