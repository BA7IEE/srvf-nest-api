"""Offline verification using only sanitized T45 receipts."""
from pathlib import Path
import hashlib
import json
root = Path(__file__).resolve().parent

def data(name):
    return json.loads((root / name).read_text())

def lines(name):
    return [json.loads(s) for s in (root / name).read_text().splitlines() if s.startswith('{')]

def cases(name):
    return {s['step']:s for s in lines(name) if s['step'] != 'login_rate_limit'}

def check_case(results, step, status, code):
    result=results[step]
    assert (result['status'],result['code'])==(status,code) and result['reqId']
    return result

def verify():
    restored={r['pack']:r for r in lines('restored-acl.jsonl')}
    for pack,apply_file,n in [('read','read-apply.json',22),('ledger-on','ledger-on-apply.json',2),('punch','punch-final-apply.json',78)]:
        original=data(apply_file)
        witnesses=lines(pack+'-witness.jsonl')
        assert len(witnesses)==len(original['missing_before'])==n
        added={tuple(r) for r in original['missing_before']}
        proven={(r['table'],r.get('op','SELECT'),r['column']) for r in witnesses}
        assert added==proven
        assert all(r['with_grant']=='00000' and r['after_single_revoke']=='42501' for r in witnesses)
        spec=data(pack+'-contract.json')
        assert hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()==original['spec_sha256']
        assert all(original[k]==restored[pack][k] for k in ['cluster','spec_sha256','existing_before','missing_before'])
    for f in ['read-baseline.jsonl','read-withdrawn.jsonl']:
        results=cases(f)
        check_case(results,'summary',500,50000)
        check_case(results,'workbench',500,50000)
        check_case(results,'workbench_denied',403,30100)
    for f in ['read-after.jsonl','read-on-after.jsonl']:
        results=cases(f)
        summary=check_case(results,'summary',200,0)['projection']
        assert summary['recordCount']==summary['activityCount']==0
        assert summary['totalServiceHours']==summary['contributionPoints']=='0'
        assert len(summary['ledgerTotals'])==4 and set(summary['ledgerTotals'].values())=={'0'}
        work=check_case(results,'workbench',200,0)['projection']
        assert work['sameActivity'] and work['emptyRun'] and work['emptyClosure']
        assert set(work['gaps'])=={'draft_missing','evidence_seal_missing','settlement_run_missing'}
    check_case(cases('read-on-after.jsonl'),'workbench_denied',403,30100)
    trace=lines('punch-trial.log')
    writes=[r for r in trace if r['step']=='self_check-in']
    assert [(r['status'],r['code']) for r in writes]==[(500,50000),(500,50000),(201,0)]
    assert {'step':'state_after','isPresent':True} in trace
    assert any(r['step']=='revoke' and r['status']==200 and r['code']==0 for r in trace)
    assert lines('punch-rollback.jsonl')[0]['events']==lines('punch-rollback.jsonl')[1]['segments']==0
    result=lines('punch-committed.jsonl')
    assert result[0]=={'events':1,'self_check_in':1,'participants':1}
    assert result[1]=={'segments':1,'open_matching_event':1}
    audit=result[2]
    assert audit['reqId']==writes[-1]['reqId'] and audit['operation']=='attendance-punch.create'
    assert audit['success'] and audit['event_link'] and audit['actor_link']
    assert result[3]['evidence_revision']==1 and result[3]['posted_ledger_for_fixture']==0
    assert result[4]=={'nonowner':True,'r5_caller_member':False,'r5_writer_member':False,'r5_pending_has_write':False,'guard_invoker':True}
    assert result==lines('punch-after-withdraw.jsonl')
    assert 'outstanding=0' in (root/'retired.log').read_text()
    assert 'STOP exited 0' in (root/'worker.log').read_text()
    print('OK: 22 + 2 read columns, 78 check-in columns, 200/200/403, signed check-in 201, reqId/audit/DB match, ACL restoration and disposable stack retirement.')

if __name__=='__main__':
    verify()
