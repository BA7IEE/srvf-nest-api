"""Column omission witnesses on the two real, migrated PostgreSQL tables."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROLE = "srvf_dp_acceptance_runtime"
RELEASE = "dd62ce308f9142e8b3be04e9c4d52f548c0ebb17"
SCHEMA_DIGEST = "c7909219407a26c6c6a2e0572d0ee0d73e7e09a3deb5a4397bda5c1335f770d6"
METHOD_DIGEST = "7245d16e4b6cd34d264576414f703f37332b849b45d7cacd91a2863378a201bd"
SHAPE = json.loads((HERE / "ledger-contract.json").read_text())
REQUIRED = {(t, c) for t, ops in SHAPE.items() for c in ops["SELECT"]}

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def source_queries(root):
    files = sorted(p for p in (root / "prisma/migrations").rglob("*") if p.is_file())
    files += [root / "prisma/schema.prisma", root / "test/fixtures/r5-ci-sealed-roles.sql"]
    digest = sha("".join(f"{p.relative_to(root)} {sha(p.read_bytes())}\n" for p in files).encode())
    require(digest == SCHEMA_DIGEST, "migration tree, schema or sealed-role fixture changed")
    src = (root / "src/modules/activities/ledger-query.service.ts").read_text()
    start = src.index("  async listCommittedEntriesForMemberPage(")
    method = src[start:src.index("\n  }\n", start) + 4]
    require(sha(method.encode()) == METHOD_DIGEST, "ledger query implementation changed")
    queries = re.findall(r"\(Prisma.sql`\s*(SELECT\b.*?)`\)", method, re.S)
    require(len(queries) == 2, "page and count queries required")
    # The self-service DTO supplies an optional activityId and no date range.
    replacements = {
        "memberId": "'t49-synthetic-member'", "activityFilter": """AND e."activityId" = 't49-synthetic-activity'""",
        "dateFromFilter": "", "dateToFilter": "", "query.pageSize": "20", "offset": "0",
    }
    variants = {}
    for name, activity_filter in [("h5_default", ""), ("filtered", replacements["activityFilter"])]:
        binds = {**replacements, "activityFilter": activity_filter}
        variants[name] = [re.sub(r"\$\{([^}]+)\}", lambda m: binds[m[1]], q) + ";" for q in queries]
    return variants

def acl_sql(action, columns):
    require(action in ("GRANT", "REVOKE") and set(columns) <= REQUIRED, "outside SELECT contract")
    prep = "TO" if action == "GRANT" else "FROM"
    statements = []
    for table in sorted(SHAPE):
        fields = ", ".join(f'"{col}"' for rel, col in sorted(columns) if rel == table)
        if fields:
            statements.append(f'{action} SELECT ({fields}) ON public."{table}" {prep} {ROLE};')
    return "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;"

def exercise(container, label, variants):
    page_sql = variants["h5_default"][0]
    inspect = json.loads(subprocess.check_output(["docker", "inspect", "--format",
        '{{json (index .Config.Labels "srvf.ledger.trial")}}', container]))
    require(re.fullmatch("[0-9a-f]{64}", container) and re.fullmatch("[0-9a-f]{32}", label)
            and inspect == label, "fresh rehearsal container required")
    guard = subprocess.check_output(["docker","inspect","--format",
        '{{.Name}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{range $k,$v := .HostConfig.Tmpfs}}{{$k}}{{end}}',
        container],text=True).strip()
    require(guard == f"/srvf-ledger-witness-{label} none 0 /var/lib/postgresql/data", "wrong isolation")

    def execute(sql, user="postgres", variables=()):
        args = ["docker","exec","-i",container,"psql","-XAtq","-v","ON_ERROR_STOP=1",
                "-v","VERBOSITY=verbose","-U",user,"-d","app_test"]
        for key, value in variables:
            args += ["-v", f"{key}={value}"]
        return subprocess.run(args,input=sql,text=True,capture_output=True,timeout=30)

    def ok(sql, user="postgres"):
        r = execute(sql, user)
        require(r.returncode == 0, r.stderr[-800:])
        return r.stdout.strip()

    def preflight(expected, missing=None, expected_db="app_test"):
        result = execute((HERE / "preflight.sql").read_text(), variables=[
            ("contract",json.dumps(SHAPE)),("runtime_role",ROLE),("expected_database",expected_db)])
        require(result.returncode == expected, f"preflight exit {result.returncode}, expected {expected}: {result.stderr}")
        receipt = json.loads(result.stdout)
        if missing is not None:
            absent = {(r["table"],r["column"]) for r in receipt["rows"] if not r["select"]}
            require(absent == missing, "unexpected effective column baseline")
        return receipt

    def denial(query):
        r = execute(query, ROLE)
        require(r.returncode == 3 and re.search(r'ERROR:\s+42501:',r.stderr), "expected 42501 from ordinary role")
        return {"exit":r.returncode,"sqlstate":"42501"}

    require(ok("SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")=="156","migration count")
    ok(f"CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;")
    require(ok("SELECT current_user", ROLE)==ROLE, "wrong business connection")
    batch = {pair for pair in REQUIRED if pair[0]=="LedgerPostingBatch"}
    entries = REQUIRED - batch
    # Reproduce the measured effective batch permissions. The group grant also tests rollback preservation.
    ok("CREATE ROLE ledger_batch_reader; GRANT SELECT ON public.\"LedgerPostingBatch\" TO ledger_batch_reader;"
       f"GRANT ledger_batch_reader TO {ROLE};")
    phases = {}
    for profile, missing in (("shared_snapshot",entries), ("after_t45", delta_after_t45(entries))):
        baseline = preflight(3,missing)
        initial_denial = denial(page_sql)
        ok(acl_sql("GRANT",missing))
        complete = preflight(0,set())
        for page, count in variants.values():
            require(ok(page, ROLE)=="" and ok(count, ROLE)=="0", "unexpected page/count results")
        wrong_db = preflight(3,set(),expected_db="different_database")
        require(wrong_db["database"]=="app_test","wrong-database guard failed")
        ok(acl_sql("REVOKE",missing))
        require(preflight(3,missing)==baseline, "withdrawal changed baseline grants")
        phases[profile] = {"baseline":baseline,"query_before":initial_denial,"apply_exit":0,
                            "after":complete,"page_count_exit":{name:[0,0] for name in variants},"wrong_db_exit":3,"withdraw_exit":0,
                            "query_after_withdraw":denial(page_sql),"baseline_restored":True}
        if profile=="shared_snapshot":
            ok(acl_sql("GRANT",entries-delta_after_t45(entries)))
    # Per-column witnesses use direct grants on a fresh baseline so even the two inherited batch fields can be omitted.
    ok(f"REVOKE ledger_batch_reader FROM {ROLE}")
    ok(acl_sql("GRANT",REQUIRED))
    witnesses=[]
    for table, col in sorted(REQUIRED):
        ok(acl_sql("REVOKE",{(table,col)}))
        denied = denial(page_sql)
        ok(acl_sql("GRANT",{(table,col)}))
        ok(page_sql, ROLE)
        witnesses.append({"table":table,"column":col,"omitted":denied,"restored_query_exit":0})
    # Statement planning checks permissions without modifying a row.
    boundaries = {}
    for op, query in {
        "noncontract_column":'SELECT "requestKey" FROM "LedgerPostingBatch" LIMIT 0',
        "write":'EXPLAIN UPDATE "ParticipationLedgerEntry" SET "sessionId"=\'t49\' WHERE false',
    }.items():
        boundaries[op]=denial(query)
    return {"source":RELEASE,"source_method_sha256":METHOD_DIGEST,"schema_input_sha256":SCHEMA_DIGEST,
            "contract_sha256_t45":sha(json.dumps(SHAPE,sort_keys=True).encode()),"db_version":ok("SHOW server_version"),
            "migrations":156,"nonowner_session":ROLE,"rows_in_page":0,"network":"none","phases":phases,
            "column_witnesses":witnesses,"outside_contract":boundaries}

def delta_after_t45(entries):
    previous=set()
    for filename in ["read-contract.json","ledger-on-contract.json"]:
        pack=json.loads((HERE.parent / "t45" / filename).read_text())
        previous.update(("ParticipationLedgerEntry",c) for c in pack["ParticipationLedgerEntry"]["SELECT"])
    require(len(previous)==7 and previous <= entries, "T45 ledger contract drift")
    return entries-previous

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("source_tree",type=Path)
    p.add_argument("--check-source",action="store_true")
    p.add_argument("--container")
    p.add_argument("--label")
    args=p.parse_args()
    sql=source_queries(args.source_tree)
    if args.check_source:
        print("Frozen migration inputs and ledger SQL verified")
    else:
        print(json.dumps(exercise(args.container,args.label,sql),indent=2))
