"""Reconcile T49 receipts with the earlier assembly and incident evidence."""
import json
from copy import deepcopy
from pathlib import Path
from preview import proposal

HERE = Path(__file__).resolve().parent

def read(path):
    return json.loads((HERE/path).read_text())

def missing(receipt):
    return {(r["table"],r["column"]) for r in receipt["rows"] if not r["select"]}

def main():
    shape = read("ledger-contract.json")
    required = {(t,c) for t,ops in shape.items() for c in ops["SELECT"]}
    shared = read("shared-check.json")
    isolated = read("isolated-result.json")
    future = read("future-delta.json")
    assert shared["exit"]==3 and shared["runtime_new_grants"]==0
    assert future==proposal(shared,shape,"srvf_staging")
    assert len(future["columns"])==13 and len(required)==15
    old = read("../t48/trial.json")
    assert {f"{t}.{c}" for t,c in missing(shared)}==set(old["acl_missing"]["shared_read_only"])
    previous=set()
    for name in ["read-apply.json","ledger-on-apply.json"]:
        for t,priv,c in read("../t45/"+name)["recorded_delta"]:
            if t=="ParticipationLedgerEntry" and priv=="SELECT":
                previous.add((t,c))
    assert len(previous)==7
    for profile,delta in [("shared_snapshot",missing(shared)),("after_t45",missing(shared)-previous)]:
        phase=isolated["phases"][profile]
        assert missing(phase["baseline"])==delta
        assert phase["baseline_restored"] and phase["withdraw_exit"]==phase["apply_exit"]==0
        assert phase["page_count_exit"]=={"h5_default":[0,0],"filtered":[0,0]}
        assert phase["query_after_withdraw"]==phase["query_before"]=={"exit":3,"sqlstate":"42501"}
        draft=proposal(phase["baseline"],shape,"app_test")
        assert set(draft["columns"])=={c for _,c in delta}
        nothing=proposal(phase["after"],shape,"app_test")
        assert nothing["grant_draft"] is None and nothing["withdraw_if_exact_delta_applied"] is None
    ws=isolated["column_witnesses"]
    assert {(w["table"],w["column"]) for w in ws}==required and len(ws)==15
    assert all(w["omitted"]=={"exit":3,"sqlstate":"42501"} and w["restored_query_exit"]==0 for w in ws)
    assert all(w=={"exit":3,"sqlstate":"42501"} for w in isolated["outside_contract"].values())
    broader=read("../t29c/column-proofs.json")
    assert len(broader)==130 and not any((r["t"],r["c"]) in required and r["k"]=="SELECT" for r in broader)
    drift=deepcopy(shared)
    next(r for r in drift["rows"] if r["table"]=="LedgerPostingBatch")["select"]=False
    try:
        proposal(drift,shape,"srvf_staging")
    except ValueError as e:
        assert "batch prerequisites" in str(e)
    else:
        raise AssertionError("batch drift must not become part of a grant proposal")
    print("PASS: 15 column witnesses, 13/6 deltas, exact withdrawal, 2 out-of-scope denials, read-only shared preflight and B130 boundary")

if __name__=="__main__":
    main()
