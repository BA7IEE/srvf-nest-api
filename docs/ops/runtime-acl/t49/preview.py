"""Render review text from an effective-ACL receipt. This command has no database connection."""
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROLE = "srvf_dp_acceptance_runtime"
ENTRY = "ParticipationLedgerEntry"
BATCH = "LedgerPostingBatch"

def proposal(snapshot, shape, expected_database):
    if snapshot["database"] != expected_database or snapshot["role"] != ROLE:
        raise ValueError("target database or role differs")
    pairs = {(table, col) for table, ops in shape.items() for col in ops["SELECT"]}
    seen = set()
    missing = []
    for row in snapshot["rows"]:
        key = row["table"], row["column"]
        if key not in pairs or key in seen:
            raise ValueError("unexpected or duplicated receipt row")
        seen.add(key)
        if row["owner_access"] or row["superuser_or_bypassrls"] or type(row["select"]) is not bool:
            raise ValueError("unexpected runtime identity or privilege result")
        if not row["select"]:
            if row["table"] != ENTRY:
                raise ValueError("batch prerequisites changed; review target drift")
            missing.append(row["column"])
    if seen != pairs or set(shape) != {ENTRY,BATCH} or len(seen) != 15:
        raise ValueError("incomplete scope")
    missing.sort()
    data = {"database":expected_database, "role":ROLE, "table":ENTRY,"privilege":"SELECT",
            "columns":missing, "baseline_sha256":hashlib.sha256(json.dumps(snapshot,sort_keys=True).encode()).hexdigest(),
            "grant_draft":None, "withdraw_if_exact_delta_applied":None}
    if missing:
        fields = ", ".join(f'"{col}"' for col in missing)
        privilege = f'SELECT ({fields}) ON public."{ENTRY}"'
        data["grant_draft"] = f"GRANT {privilege} TO {ROLE};"
        data["withdraw_if_exact_delta_applied"] = f"REVOKE {privilege} FROM {ROLE};"
    return data

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("receipt",type=Path)
    p.add_argument("--expected-database",required=True)
    args=p.parse_args()
    print(json.dumps(proposal(json.loads(args.receipt.read_text()),json.loads((HERE/"ledger-contract.json").read_text()),
                              args.expected_database),indent=2))
