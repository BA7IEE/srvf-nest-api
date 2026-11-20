"""Recompute the limited assertions from the sanitized T48 receipts."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent
def load(name):
    return json.loads((root / name).read_text())
p = load('live.json')
t = load('trial.json')
build = load('build-inputs.json')
for k, label in [('backend', 'backend'), ('admin', 'admin'), ('h5', 'mobile')]:
    assert p[k]['headRefOid'] == build[label] and p[k]['mergedAt'] is None
checks = p['backend']['checks']
assert len(checks)==15 and all((c['status'], c['conclusion'])==('COMPLETED','SUCCESS') for c in checks)
assert any(c['name']=='Red-zone trusted approval' for c in checks)
assert all(t['flags'].values()) and t['ordinary_release']
v=t['projections']['before']
assert all(x==v for x in t['projections'].values())
assert (v['complete_join'],v['wrong_request'],v['team_evidence'],v['bindings'],v['outbox_pending'])==(1,0,1,0,0)
assert v['registration_audits']==['registration.create','registration.review'] and v['source_kind']=='team_insurance_coverage'
def step(batch,name):
    return next(row for row in t['browser'][batch] if row.get('step')==name)
assert step('business','H5 self QR')['reqId']==v['punchReqId']
assert step('business','registered')['reqId']==v['signupReqId']
assert step('business','H5 self QR')['status']==step('business','registered')['status']==201
assert t['browser']['fallback'][-1]=={'page':'/#/system/not-configured','api':0,'exit':0}
assert t['browser']['recovered'][-1]['present'] and t['browser']['recovered'][-1]['http']==200
assert t['observation']['id']==step('observed-page','participation-ledger')['reqId']
assert t['observation']['sqlstate']=='42501' and t['observation']['table']=='ParticipationLedgerEntry'
for run in ('followup','observed-page','after-withdraw'):
    assert step(run,'participation-ledger')['http']==500 and step(run,'participation-ledger')['code']==50000
assert step('ledger-retest','participation-ledger')['http']==200 and step('ledger-retest','participation-summary')['code']==0
assert step('ledger-retest','参与页与未结算状态')['ledgerRows']==0
assert step('ledger-retest','严格保险下无保障主体可见本人不符合')['eligible'] is False
acl=t['acl_missing']
assert acl['isolated_baseline']==acl['restored_db_baseline']==acl['isolated_withdrawn']
assert len(acl['isolated_baseline'])==6 and not acl['isolated_with_delta'] and len(acl['shared_read_only'])==13
assert 'STOP exited 0' in t['worker'] and any('10 named trial containers' in s for s in t['retirement'])
print('PASS for the recorded T48 trial, backup/restore, audit linkage and ledger ACL differential')
