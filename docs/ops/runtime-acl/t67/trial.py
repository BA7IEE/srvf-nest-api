"""Desktop browser ACL rehearsal on one fresh, internal T63 lab. Run with normal Python assertions."""

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
T63 = HERE.parent / "t63"
sys.path.insert(0, str(T63 / "fixture"))
import replay
from projections import collect

CHROME = (
    "selenium/standalone-chrome@sha256:11b1c18434233ea10e065ba2c43f8599373a014f8253e689d1df6cd96f9ea8e5"
)
RESPONSIBILITY = "activity_responsibility_assignments"
TOKEN = "refresh_tokens"


def overlay(lab, mode, *, missing=False):
    result = subprocess.run(
        [
            sys.executable,
            T63 / "acl.py",
            mode,
            "--browser-delta",
            "--container",
            lab.tag + "-pg",
            "--cluster-id",
            lab.cid,
        ],
        text=True,
        capture_output=True,
    )
    if missing:
        if result.returncode == 0 or "Effective column ACL does not match" not in result.stderr:
            raise RuntimeError(f"{mode}: expected an incomplete-contract rejection")
    else:
        result.check_returncode()
    with (lab.evidence / "overlay.jsonl").open("a") as f:
        print(json.dumps({"mode": mode, "exit": result.returncode, "expectedMissing": missing}), file=f)


def browser(lab, core, phase):
    cert = subprocess.check_output(["openssl", "x509", "-pubkey", "-noout", "-in", lab.tmp / "cert"])
    der = subprocess.check_output(["openssl", "pkey", "-pubin", "-outform", "DER"], input=cert)
    pin = base64.b64encode(hashlib.sha256(der).digest()).decode()
    chrome = lab.start(
        "chrome-" + phase,
        CHROME,
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-quic",
        "--user-data-dir=/tmp/t67",
        "--remote-debugging-port=9222",
        "--ignore-certificate-errors-spki-list=" + pin,
        "about:blank",
        options=["--platform", "linux/amd64", "--entrypoint", "/usr/bin/google-chrome"],
    )
    for _ in range(45):
        result = subprocess.run(
            ["docker", "exec", chrome, "curl", "-fs", "http://127.0.0.1:9222/json/version"],
            stdout=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("Chrome did not start")
    # The Playwright driver shares Chrome's private network namespace. No port is published.
    replay.run(
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "container:" + chrome,
        "--env-file",
        lab.tmp / "client.env",
        *replay.mount(core, "/playwright"),
        *replay.mount(HERE / "browser.cjs", "/probe.cjs"),
        *replay.mount(lab.evidence, "/out", True),
        replay.NODE,
        "node",
        "/probe.cjs",
        phase,
    )


def read_log(lab):
    raw = replay.out("docker", "exec", lab.tag + "-pg", "cat", "/tmp/t63-logs/pg.csv")
    return [r for r in csv.reader(io.StringIO(raw)) if len(r) > 19 and r[1:3] == ["t63_api", "t63_lab"]]


def check_installed(lab, rows):
    assert not any(r[11] == "ERROR" for r in rows), "Unexpected SQL error during the browser path"
    attrs = lab.sql(
        "t63_lab",
        """SELECT c.oid,c.relname,a.attnum+7,a.attname
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND a.attnum>0 AND NOT a.attisdropped""",
    )
    catalog = {}
    for line in attrs.splitlines():
        oid, name, bit, col = line.split("|")
        catalog.setdefault(oid, (name, {}))[1][int(bit)] = col
    plans = collect(rows, catalog)
    rights = {(p["table"], p["op"], c) for p in plans for c in p["columns"]}
    wanted = {
        (RESPONSIBILITY, "SELECT"): {
            "id",
            "memberId",
            "status",
            "canManageRegistrations",
            "canManageAttendance",
        },
        (TOKEN, "UPDATE"): {"rotatedAt", "revokedAt", "revokedReason", "replacedById"},
    }
    replay.write_json(lab.evidence / "pg-plans.json", plans)
    for (table, op), expected in wanted.items():
        observed = {c for t, o, c in rights if (t, o) == (table, op)}
        assert observed == expected, (table, op, sorted(observed), sorted(expected))
    base = json.loads((T63 / "columns.json").read_text())["t63_api"]
    base_rights = {
        (table, op, col) for table, ops in base.items() for op, cols in ops.items() for col in cols
    }
    additions = {(table, op, col) for (table, op), cols in wanted.items() for col in cols} - base_rights
    assert len(additions) == 6 and rights - base_rights == additions
    usage = {}
    for plan in plans:
        columns = usage.setdefault(plan["table"], {}).setdefault(plan["op"], [])
        columns[:] = sorted(set(columns).union(plan["columns"]))
    replay.write_json(lab.evidence / "observed-browser-columns.json", usage)
    state = json.loads(
        lab.sql(
            "t63_lab",
            """WITH tokens AS (
        SELECT r.* FROM refresh_tokens r JOIN "User" u ON u.id=r."userId" WHERE u.username='t63_member'
      ) SELECT json_build_object('rows',count(*),'familyCount',count(DISTINCT "familyId"),
        'active',count(*) FILTER (WHERE "revokedAt" IS NULL AND "rotatedAt" IS NULL AND "replacedById" IS NULL),
        'linked', (SELECT count(*) FROM tokens a JOIN tokens b ON b.id=a."replacedById"
          AND b.id<>a.id AND b."familyId"=a."familyId" AND b."expiresAt"=a."expiresAt"
          WHERE a."revokedAt" IS NOT NULL AND a."rotatedAt" IS NOT NULL AND a."revokedReason"='rotated'
          AND b."revokedAt" IS NULL)) FROM tokens""",
        )
    )
    assert state == {"rows": 2, "familyCount": 1, "active": 1, "linked": 1}, state
    audit = lab.sql(
        "t63_lab",
        """SELECT a.event,a.context->>'requestId' FROM audit_logs a
      JOIN "User" u ON u.id=a."actorUserId" WHERE u.username='t63_member' AND a.success
      AND a.event IN ('auth.login','auth.refresh') ORDER BY a.event""",
    )
    events = json.loads((lab.evidence / "installed.json").read_text())["responses"]
    matches = {r["path"].split("/")[-1]: r["reqId"] for r in events if "/h5/" in r["path"]}
    assert sorted(audit.splitlines()) == sorted(f"auth.{key}|{value}" for key, value in matches.items())
    replay.write_json(lab.evidence / "rotation.json", {**state, "actorAuditReqIds": matches})


def exercise(lab, core):
    lab.acl("setup")
    lab.acl("preflight")
    overlay(lab, "preflight", missing=True)
    overlay(lab, "setup")
    overlay(lab, "setup")
    overlay(lab, "preflight")
    lab.start(
        "api",
        replay.IMAGE,
        aliases=["api"],
        options=[
            "--platform",
            "linux/amd64",
            "--env-file",
            lab.tmp / "t63_api.env",
            "--memory",
            "1g",
            "--cpus",
            "2",
        ],
    )
    # Use the T63 fixed-package pairing probe for HTTPS static file hashes and application readiness.
    result = lab.client(
        replay.NODE,
        "node",
        "/ready.cjs",
        options=[
            "--env",
            "NODE_EXTRA_CA_CERTS=/cert",
            *replay.mount(lab.tmp / "cert", "/cert"),
            *replay.mount(replay.VOLUME, "/archive"),
            *replay.mount(T63 / "fixture/ready.cjs", "/ready.cjs"),
        ],
    )
    replay.write_json(lab.evidence / "pairing.json", json.loads(result))
    before = len(read_log(lab))
    browser(lab, core, "installed")
    check_installed(lab, read_log(lab)[before:])
    overlay(lab, "rollback")
    overlay(lab, "rollback")
    lab.acl("preflight")
    overlay(lab, "preflight", missing=True)
    before = len(read_log(lab))
    browser(lab, core, "withdrawn")
    denied = [
        {"utc": r[0], "role": r[1], "sqlstate": r[12], "message": r[13]}
        for r in read_log(lab)[before:]
        if r[11] == "ERROR" and r[12] == "42501"
    ]
    assert [d["message"] for d in denied] == [
        "permission denied for table " + t for t in (RESPONSIBILITY, TOKEN)
    ], denied
    replay.write_json(lab.evidence / "denials.json", denied)
    lab.acl("rollback")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, required=True, help="Git checkout containing the fixed API commit"
    )
    parser.add_argument(
        "--playwright-core", type=Path, required=True, help="Local playwright-core module directory"
    )
    parser.add_argument("--evidence", type=Path, required=True, help="Fresh output directory")
    args = parser.parse_args()
    context = os.getenv("DOCKER_HOST") or replay.out(
        "docker", "context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'
    )
    if not __debug__ or not context.startswith("unix://"):
        parser.error("Use normal Python and a local Docker socket")
    core = args.playwright_core.resolve()
    if json.loads((core / "package.json").read_text())["name"] != "playwright-core":
        parser.error("Expected an installed playwright-core module")
    os.umask(0o077)
    args.evidence.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="srvf-t67-") as scratch:
        lab = replay.Lab(Path(scratch), args.evidence.resolve())
        try:
            lab.prepare(args.source)
            exercise(lab, core)
        finally:
            lab.retire()


if __name__ == "__main__":
    main()
