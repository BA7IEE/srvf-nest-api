from pathlib import Path
import json
records=[json.loads(line) for line in Path('readback.jsonl').read_text().splitlines()]
assert len(records)==4
db=Path('db.log').read_text().splitlines()
report={}
for name,log,set_code,count in [('boolean','browser-boolean.log','t36_set',1),('five','browser-five.log','t37_full_set',5)]:
    s=[v for v in records if v['metric_set']==set_code]
    assert [v['type'] for v in s]==['initial','change']
    assert [v['request_version'] for v in s]==[1,2]
    assert all(v['metric_set_version']==1 and v['metric_count']==count and v['all_items_required'] and v['frozen_metrics_match'] for v in s)
    assert len({v['activity'] for v in s})==1
    assert all(v['schema']==7 and v['requirement']=='required' and v['both_ordinary'] and v['independent'] and v['review_status']=='approved' and v['activity_status']=='published' and v['workflow_revision']==2 for v in s)
    assert s[1]['changed_title'] and s[1]['changed_description'] and s[1]['current_matches_target']
    outcome=[]
    for line in Path(log).read_text().splitlines():
        if not line.startswith('{'):continue
        row=json.loads(line)
        if not (row['actor']=='lab-editor' or row['path'].endswith(('/from-template','/publish-reviews','/approve','/change-reviews'))):continue
        expected_actor='lab' if row['actor']=='lab-editor' else row['actor']
        matches=any(line.endswith('|USER|'+expected_actor+'|t|'+row['reqId']) for line in db)
        assert matches==(row['status'] in [200,201]),row
        row['success_audit_matched']=matches
        outcome.append(row)
    assert [(v['status'],v['code']) for v in outcome]==[(201,0),(200,0),(409,20255),(200,0),(200,0),(200,0),(200,0),(404,20001)]
    assert [v['path'].split('/')[-2] for v in outcome if v['path'].endswith('/approve')]==[v['review'] for v in s]
    report[name]={'activity':s[0]['activity'],'writes':outcome}
Path('correlations.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS two ordinary-user browser journeys, four approved reviews, both stored fields, frozen selections and 16 request/audit correlations')
