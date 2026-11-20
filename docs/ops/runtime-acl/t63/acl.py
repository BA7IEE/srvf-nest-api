#!/usr/bin/env python3
"""Apply, verify or remove the pinned column ACL on the disposable T63 lab."""

import argparse
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROLES = ("t63_api", "t63_worker")
OPS = ("SELECT", "INSERT", "UPDATE")


def output(*args):
    return subprocess.check_output(list(args), text=True).strip()


def ident(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError("Invalid identifier")
    return '"' + value + '"'


def sql_for(contract, mode):
    if set(contract) != set(ROLES):
        raise ValueError("Unexpected role set")
    rows, grants, revokes = [], [], []
    for role, tables in contract.items():
        for table, operations in tables.items():
            for op, columns in operations.items():
                if op not in OPS or not columns or len(columns) != len(set(columns)):
                    raise ValueError("Invalid column operation")
                cols = ", ".join(ident(c) for c in columns)
                clause = f"{op} ({cols}) ON public.{ident(table)}"
                grants.append(f"GRANT {clause} TO {ident(role)};")
                revokes.append(f"REVOKE {clause} FROM {ident(role)};")
                rows.extend(f"('{role}','{table}','{op}','{c}')" for c in columns)
    cmd = {"setup": grants, "rollback": revokes, "preflight": []}[mode]
    return (
        (HERE / "guard.sql").read_text()
        + "\nINSERT INTO desired VALUES\n"
        + ",\n".join(rows)
        + ";\n"
        + (HERE / "inspect.sql").read_text()
        + "\nSELECT pg_temp.validate_acl(:'mode',false);\n"
        + "\n".join(cmd)
        + "\nSELECT pg_temp.validate_acl(:'mode',true);\nCOMMIT;\n"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("setup", "preflight", "rollback"))
    parser.add_argument("--container", required=True)
    parser.add_argument("--cluster-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"srvf-t63-[a-z0-9]+-pg", args.container):
        parser.error("Expected a T63 PostgreSQL container name")
    if not re.fullmatch(r"[0-9]{15,20}", args.cluster_id):
        parser.error("Expected the system_identifier recorded when creating the lab")
    obj = json.loads(output("docker", "inspect", args.container))[0]
    networks = obj["NetworkSettings"]["Networks"]
    if len(networks) != 1:
        parser.error("Expected one dedicated network")
    net = json.loads(output("docker", "network", "inspect", next(iter(networks))))[0]
    pgdata = obj["HostConfig"].get("Tmpfs") or {}
    if (
        obj["Config"]["Labels"].get("task") != "srvf-t63"
        or not net["Internal"]
        or net["Labels"].get("task") != "srvf-t63"
        or obj["HostConfig"]["PortBindings"]
        or "/var/lib/postgresql/data" not in pgdata
        or any(
            m.get("Destination", "").startswith("/var/lib/postgresql/data") and m.get("Type") != "tmpfs"
            for m in obj["Mounts"]
        )
    ):
        parser.error("Expected the labelled internal-only T63 lab with disposable PGDATA")
    contract = json.loads((HERE / "columns.json").read_text())
    sql = sql_for(contract, args.mode)
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            args.container,
            "psql",
            "-XAtq",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            f"cid={args.cluster_id}",
            "-v",
            f"mode={args.mode}",
            "-U",
            "postgres",
            "-d",
            "t63_lab",
        ],
        input=sql,
        text=True,
        check=True,
    )
    print(f"{args.mode} verified on t63_lab ({args.cluster_id})")


if __name__ == "__main__":
    main()
