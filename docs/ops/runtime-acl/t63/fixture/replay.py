#!/usr/bin/env python3
"""Replay on a new internal Docker network, empty PG16 tmpfs and fixed local artifacts."""

import argparse
import csv
import io
import json
import os
import secrets
import subprocess as sp
import sys
import tempfile
from projections import collect, verify
import time
from pathlib import Path

csv.field_size_limit(128 * 1024 * 1024)

HERE = Path(__file__).resolve().parent
REV = "65bad1ccb7e6a4bb7a3cda46b49512f092d04779"
IMAGE = "sha256:ca892d7090c4dee48544567cfac1d0cd41862c7585f2cd149f3a8252bbcda26f"
TOOLS = "sha256:42ef97a91877bf9ef0e865a01648ecabfc91c2e7ad2990f58745680890b43e00"
PG = "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
NODE = "node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c"
VOLUME = "srvf-release-artifacts-t62"


def run(*args, **kw):
    return sp.run([str(a) for a in args], check=True, text=True, **kw)


def out(*args, **kw):
    return run(*args, stdout=sp.PIPE, **kw).stdout.strip()


def mount(path, target, writable=False):
    return ["-v", f"{path}:{target}" + ("" if writable else ":ro")]


def env(path, values):
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    path.chmod(0o600)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class Lab:
    def __init__(self, tmp, evidence):
        self.tmp, self.evidence = tmp, evidence
        self.tag = "srvf-t63-" + secrets.token_hex(5)
        self.net = self.tag + "-net"
        self.containers = []
        self.has_network = False

    def client(self, image, *args, options=()):
        return out(
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network",
            self.net,
            *options,
            image,
            *args,
        )

    def start(self, name, image, *cmd, options=(), aliases=()):
        opts = [v for alias in aliases for v in ("--network-alias", alias)]
        full = self.tag + "-" + name
        cid = out(
            "docker",
            "run",
            "-d",
            "--pull=never",
            "--label",
            "task=srvf-t63",
            "--network",
            self.net,
            "--name",
            full,
            *opts,
            *options,
            image,
            *cmd,
        )
        self.containers.append(cid)
        return full

    def sql(self, db, query):
        return out(
            "docker",
            "exec",
            "-i",
            self.tag + "-pg",
            "psql",
            "-U",
            "postgres",
            "-XAtq",
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            db,
            input=query,
        )

    def prepare(self, source):
        t = self.tmp
        # Export tracked source only. The ledger schema and SQL below are taken from the image.
        with (t / "source.tar").open("wb") as f:
            run(
                "git",
                "-C",
                source,
                "archive",
                REV,
                "prisma",
                "src",
                "test/fixtures/r5-ci-sealed-roles.sql",
                stdout=f,
            )
        run("tar", "-xf", t / "source.tar", "-C", t)
        archive = mount(VOLUME, "/archive")
        for name in ("admin", "h5"):
            (t / "static" / name).mkdir(parents=True)
        receipt = out(
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network",
            "none",
            *archive,
            *mount(HERE / "packages.sha256", "/expected"),
            *mount(t / "static", "/static", True),
            "--entrypoint",
            "sh",
            PG,
            "-ec",
            "cd /archive; sha256sum -c /expected; for k in admin-26261168 h5-ae2e3b0a; do "
            'tar xzf "$k.tar.gz" -C "/static/${k%-*}"; '
            '(cd "/static/${k%-*}" && sha256sum -sc "/archive/$k.files"); done',
        )
        (self.evidence / "packages.txt").write_text(receipt + "\n")
        # Re-import bytes already verified above. Network-disabled local volume reader.
        with (t / "api.tar").open("wb") as f:
            run(
                "docker",
                "run",
                "--rm",
                "--pull=never",
                "--network",
                "none",
                *archive,
                "--entrypoint",
                "cat",
                PG,
                "/archive/api-65bad1cc.tar",
                stdout=f,
            )
        run("docker", "load", "--input", t / "api.tar", stdout=sp.DEVNULL)
        config = json.loads(out("docker", "image", "inspect", "t61-local/api:65bad1cc"))[0]
        assert (
            config["Id"] == IMAGE
            and config["Architecture"] == "amd64"
            and config["Config"]["Labels"]["org.opencontainers.image.revision"] == REV
        )
        cid = out(
            "docker",
            "create",
            "--network",
            "none",
            "--pull=never",
            "--platform",
            "linux/amd64",
            IMAGE,
        )
        try:
            run("docker", "cp", cid + ":/app/prisma", t / "image-prisma")
        finally:
            run("docker", "rm", cid, stdout=sp.DEVNULL)
        out(
            "docker",
            "network",
            "create",
            "--internal",
            "--label",
            "task=srvf-t63",
            self.net,
        )
        self.has_network = True
        pw = {r: secrets.token_hex(36) for r in ["postgres", "t63_api", "t63_worker"]}
        env(
            t / "pg.env",
            {"POSTGRES_PASSWORD": pw["postgres"], "POSTGRES_DB": "app_test"},
        )
        pg = self.start(
            "pg",
            PG,
            "postgres",
            "-c",
            "logging_collector=on",
            "-c",
            "log_destination=csvlog",
            "-c",
            "log_directory=/tmp/t63-logs",
            "-c",
            "log_filename=pg.log",
            "-c",
            "log_rotation_age=0",
            "-c",
            "log_rotation_size=0",
            "-c",
            "log_parameter_max_length=0",
            "-c",
            "log_parameter_max_length_on_error=0",
            aliases=["pg"],
            options=[
                "--tmpfs",
                "/var/lib/postgresql/data:size=1900m",
                "--memory",
                "2500m",
                "--env-file",
                t / "pg.env",
            ],
        )
        for _ in range(120):
            if (
                sp.run(
                    [
                        "docker",
                        "exec",
                        pg,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-d",
                        "app_test",
                    ],
                    stdout=sp.DEVNULL,
                ).returncode
                == 0
            ):
                break
            time.sleep(0.3)
        self.sql("app_test", (t / "test/fixtures/r5-ci-sealed-roles.sql").read_text())

        def url(role, db):
            return f"postgresql://{role}:{pw[role]}@pg:5432/{db}?schema=public&application_name={role}"

        env(t / "migrate.env", {"DATABASE_URL": url("postgres", "app_test")})
        self.client(
            TOOLS,
            "migrate",
            "deploy",
            "--schema",
            "/trial/prisma/schema.prisma",
            options=[
                "--platform",
                "linux/amd64",
                "--env-file",
                t / "migrate.env",
                *mount(t / "image-prisma", "/trial/prisma"),
                "--entrypoint",
                "/app/node_modules/.bin/prisma",
            ],
        )
        self.sql("postgres", "CREATE DATABASE t63_lab TEMPLATE app_test;")
        self.sql("t63_lab", "REVOKE TEMPORARY ON DATABASE t63_lab FROM PUBLIC;")
        self.cid = self.sql("t63_lab", "SELECT system_identifier FROM pg_control_system()")
        for role in ("t63_api", "t63_worker"):
            self.sql(
                "t63_lab",
                f"CREATE ROLE {role} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{pw[role]}';",
            )
        accounts = {
            "PASS_" + r.upper(): secrets.token_hex(24)
            for r in ("owner", "first", "final", "member", "other")
        }
        env(t / "client.env", accounts)
        env(
            t / "fixture.env",
            {
                **accounts,
                "TRIAL_DB": "t63_lab",
                "TRIAL_CID": self.cid,
                "DATABASE_URL": url("postgres", "t63_lab"),
            },
        )
        roles = self.client(
            TOOLS,
            "-r",
            "ts-node/register/transpile-only",
            "/app/t63-catalog.cjs",
            options=[
                "--platform",
                "linux/amd64",
                *mount(t / "src", "/app/src"),
                *mount(t / "prisma", "/app/prisma"),
                *mount(HERE / "catalog.cjs", "/app/t63-catalog.cjs"),
                "--entrypoint",
                "node",
            ],
        )
        write_json(t / "roles.json", json.loads(roles))
        (t / "roles.json").chmod(0o644)  # Public seed catalogue, read by image UID 1000.
        fixture = self.client(
            IMAGE,
            "node",
            "/app/fixture.cjs",
            options=[
                "--platform",
                "linux/amd64",
                "--env-file",
                t / "fixture.env",
                *mount(t / "roles.json", "/catalog.json"),
                *mount(HERE / "seed.cjs", "/app/fixture.cjs"),
            ],
        )
        self.fixture = json.loads(fixture)
        write_json(self.evidence / "fixture.json", self.fixture)
        self.sql("t63_lab", (HERE / "observe.sql").read_text())
        for role in ("t63_api", "t63_worker"):
            self.sql(
                "t63_lab",
                f"ALTER ROLE {role} IN DATABASE t63_lab SET debug_print_plan=on; ALTER ROLE {role} IN DATABASE t63_lab SET debug_pretty_print=off",
            )
        common = dict(
            APP_ENV="smoke",
            APP_PORT="3000",
            APP_CORS_ORIGIN="https://t63.test",
            JWT_EXPIRES_IN="15m",
            JWT_REFRESH_EXPIRES_IN="90d",
            INSURANCE_ENFORCEMENT_ENABLED="false",
            ACTIVITY_V11_WORKFLOW_ENABLED="true",
            ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED="true",
            ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED="false",
            ACTIVITY_OS_CONTROL_PLANE_MODE="off",
            ACTIVITY_HUMAN_CORRECTION_BACKGROUND_MODE="off",
            INTEGRATION_API_ENABLED="false",
            STORAGE_CONSISTENCY_MODE="JIT",
            LOG_LEVEL="warn",
            ENABLE_SWAGGER="false",
        )
        for k in (
            "JWT_SECRET",
            "INTEGRATION_JWT_SECRET",
            "STORAGE_ENCRYPTION_KEY",
            "SMS_ENCRYPTION_KEY",
            "WECHAT_ENCRYPTION_KEY",
            "WECOM_ENCRYPTION_KEY",
            "REALNAME_ENCRYPTION_KEY",
        ):
            common[k] = secrets.token_hex(48)
        run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=t63.test",
            "-addext",
            "subjectAltName=DNS:t63.test",
            "-keyout",
            t / "key",
            "-out",
            t / "cert",
            stderr=sp.DEVNULL,
        )
        web = self.start(
            "web",
            NODE,
            "node",
            "/gateway.cjs",
            aliases=["t63.test"],
            options=[
                *mount(t / "cert", "/cert"),
                *mount(t / "key", "/key"),
                *mount(t / "static", "/static"),
                *mount(HERE / "gateway.cjs", "/gateway.cjs"),
            ],
        )
        common["APP_TRUSTED_PROXY_CIDRS"] = (
            out(
                "docker",
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                web,
            )
            + "/32"
        )
        for role in ("t63_api", "t63_worker"):
            env(t / (role + ".env"), {**common, "DATABASE_URL": url(role, "t63_lab")})
        (t / "session").mkdir(mode=0o700)
        write_json(
            self.evidence / "target.json",
            dict(
                container=pg,
                systemIdentifier=self.cid,
                network=self.net,
                apiRevision=REV,
                image=IMAGE,
            ),
        )

    def acl(self, mode, expect_success=True):
        cmd = [
            sys.executable,
            HERE.parent / "acl.py",
            mode,
            "--container",
            self.tag + "-pg",
            "--cluster-id",
            self.cid,
        ]
        result = sp.run(cmd, text=True, capture_output=True)
        if (result.returncode == 0) != expect_success:
            raise RuntimeError(f"{mode} unexpected exit {result.returncode}: {result.stderr[:650]}")
        expected_error = None
        if not expect_success:
            expected_error = (
                "Partial or unrelated ACL"
                if mode == "setup"
                else "Effective column ACL does not match the required state"
            )
            if expected_error not in result.stderr:
                raise RuntimeError("Unexpected preflight failure: " + result.stderr[:500])
        with (self.evidence / "acl-verification.jsonl").open("a") as f:
            print(
                json.dumps(
                    {
                        "mode": mode,
                        "expected": expect_success,
                        "exit": result.returncode,
                        "expectedError": expected_error,
                    }
                ),
                file=f,
            )

    def probe(self, phase):
        t = self.tmp
        result = sp.run(
            [
                "docker",
                "run",
                "--rm",
                "--pull=never",
                "--network",
                self.net,
                "--env-file",
                t / "client.env",
                "-e",
                "NODE_EXTRA_CA_CERTS=/cert",
                *mount(t / "cert", "/cert"),
                *mount(t / "session", "/state", True),
                *mount(self.evidence / "fixture.json", "/fixture.json"),
                *mount(HERE / "journey.cjs", "/journey.cjs"),
                NODE,
                "node",
                "/journey.cjs",
                phase,
            ],
            text=True,
            stdout=sp.PIPE,
        )
        with (self.evidence / "http.jsonl").open("a") as f:
            for line in result.stdout.splitlines():
                json.loads(line)
                print(line, file=f)
        result.check_returncode()

    def check_business(self):
        fx = self.fixture
        # No raw sessions, bound parameters, names or audit contexts in receipts.
        checks = json.loads(self.sql("t63_lab", (HERE / "business.sql").read_text()))
        assert checks["batches"] == checks["committed"] == checks["closed"] == 1
        assert (
            checks["ledger"] == checks["memberRows"] == checks["uniqueEntries"] == 2
            and checks["otherRows"] == 0
        )
        assert checks["closedRuns"] == checks["closedPointers"] == 1
        assert checks["inputSeconds"] == 39 * 60 == fx["punchMinutes"] * 60
        assert checks["hours"] == round(checks["inputSeconds"] / 3600, 2) and checks["points"] == 1.5
        assert checks["ordinaryBindings"] == 0 and checks["ordinaryUsers"] == 5
        assert len(checks["jobs"]) == 1
        job = checks["jobs"][0]
        assert (
            job["status"] == "succeeded"
            and int(job["attempts"]) == int(job["generation"]) == 1
            and job["failed"] == 0
        )
        write_json(self.evidence / "business.json", checks)
        requests = [json.loads(line) for line in (self.evidence / "http.jsonl").read_text().splitlines()]
        assert len({r["reqId"] for r in requests}) == len(requests)
        audit = json.loads(
            self.sql(
                "t63_lab",
                """SELECT coalesce(json_agg(json_build_object('reqId',context->>'requestId',
          'actor',"actorUserId",'event',event,'success',success) ORDER BY "createdAt"),'[]') FROM audit_logs;""",
            )
        )
        linked = {}
        for step in (
            "login-member",
            "login-other",
            "seal",
            "generate",
            "submit",
            "first-review",
            "final-review",
            "close",
        ):
            req = next(r for r in requests if r["step"] == step)
            actor = fx["actors"][req["who"]]["id"]
            hits = [
                a for a in audit if a["reqId"] == req["reqId"] and a["actor"] == actor and a["success"]
            ]
            assert len(hits) == 1, (step, len(hits))
            linked[step] = hits[0]
        write_json(self.evidence / "http-db-audit.json", linked)
        raw = out("docker", "exec", self.tag + "-pg", "cat", "/tmp/t63-logs/pg.csv")
        rows = list(csv.reader(io.StringIO(raw)))
        attrs = self.sql(
            "t63_lab",
            "SELECT c.oid,c.relname,a.attnum+7,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped",
        )
        catalog = {}
        for line in attrs.splitlines():
            oid, table, bit, col = line.split("|")
            catalog.setdefault(oid, (table, {}))[1][int(bit)] = col
        projections = collect(rows, catalog)
        write_json(self.evidence / "sql-projections.json", projections)
        verify(json.loads((HERE.parent / "columns.json").read_text()), projections)
        errors = [
            r[13] for r in rows if len(r) > 14 and r[1] in ("t63_api", "t63_worker") and r[12] == "42501"
        ]
        assert not errors, errors[:3]
        events = []
        for row in rows:
            if len(row) > 14 and row[13].startswith("T63_OBSERVATION "):
                event = json.loads(row[13].removeprefix("T63_OBSERVATION "))
                assert event["login"] == event["role"] == row[1]
                event["at"] = row[0]
                events.append(event)
        batch_id = checks["batchId"]

        def matching(table, role, **fields):
            return [
                x
                for x in events
                if x["relation"] == table
                and x["role"] == role
                and all(x[k] == v for k, v in fields.items())
            ]

        claims = matching(
            "ActivityBatchJob",
            "t63_worker",
            type="settlement_prepare",
            to="processing",
            id=job["id"],
        )
        assert any(x["leaseOwner"] and x["attempts"] == "1" and x["generation"] == "1" for x in claims)
        assert matching(
            "ActivityBatchJob",
            "t63_worker",
            type="settlement_prepare",
            to="succeeded",
            id=job["id"],
        )
        posts = matching("LedgerPostingBatch", "t63_worker", id=batch_id, to="committed")
        assert len(posts) == 1 and posts[0]["committedBy"] == fx["actors"]["final"]["id"]
        assert (
            len(
                matching(
                    "ParticipationLedgerEntry",
                    "t63_worker",
                    op="INSERT",
                    batch=batch_id,
                )
            )
            == 2
        )
        assert (
            len(
                matching(
                    "ActivitySettlementClosureRevision",
                    "t63_api",
                    op="INSERT",
                    batch=batch_id,
                )
            )
            == 1
        )
        write_json(self.evidence / "db-transitions.json", events)
        pools = self.sql(
            "t63_lab",
            "SELECT usename,datname,client_addr,application_name,pid FROM pg_stat_activity WHERE datname='t63_lab' AND usename IN ('t63_api','t63_worker') ORDER BY usename,pid",
        )
        for role, component in [("t63_api", "api"), ("t63_worker", "worker")]:
            addr = out(
                "docker",
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                self.tag + "-" + component,
            )
            assert f"{role}|t63_lab|{addr}|{role}|" in pools
        (self.evidence / "connections.tsv").write_text(pools + "\n")

    def exercise(self):
        t = self.tmp
        self.acl("preflight", False)
        self.acl("setup")
        self.acl("setup")
        self.acl("preflight")
        # Deliberately incomplete effective ACL is rejected; the transaction under test never fixes it.
        self.sql(
            "t63_lab",
            'REVOKE SELECT ("entryKey") ON public."ParticipationLedgerEntry" FROM t63_api',
        )
        self.acl("preflight", False)
        self.acl("setup", False)
        self.sql(
            "t63_lab",
            'GRANT SELECT ("entryKey") ON public."ParticipationLedgerEntry" TO t63_api',
        )
        self.acl("preflight")
        self.start(
            "api",
            IMAGE,
            aliases=["api"],
            options=[
                "--platform",
                "linux/amd64",
                "--env-file",
                t / "t63_api.env",
                "--memory",
                "1g",
                "--cpus",
                "2",
            ],
        )
        ready = HERE / "ready.cjs"
        boot = self.client(
            NODE,
            "node",
            "/ready.cjs",
            options=[
                "-e",
                "NODE_EXTRA_CA_CERTS=/cert",
                *mount(t / "cert", "/cert"),
                *mount(ready, "/ready.cjs"),
                *mount(VOLUME, "/archive"),
            ],
        )
        (self.evidence / "pairing.json").write_text(boot + "\n")
        self.probe("approve")
        wk = self.start(
            "worker",
            IMAGE,
            "node",
            "dist/storage-consistency-worker.js",
            options=[
                "--platform",
                "linux/amd64",
                "--env-file",
                t / "t63_worker.env",
                "--memory",
                "800m",
                "--cpus",
                "1",
            ],
        )
        for _ in range(120):
            if (
                self.sql(
                    "t63_lab",
                    """SELECT count(*) FROM "ActivityBatchJob" j
                       JOIN "LedgerPostingBatch" b ON b.id=j."postingBatchId"
                       WHERE j."jobTypeCode"='settlement_prepare' AND j."statusCode"='succeeded'
                         AND b."statusCode"='committed' """,
                )
                == "1"
            ):
                break
            time.sleep(1)
        else:
            raise RuntimeError("The native worker did not complete the settlement job")
        self.probe("close")
        self.check_business()
        run("docker", "stop", "-t", "5", wk, self.tag + "-api", stdout=sp.DEVNULL)
        self.acl("rollback")
        self.acl("rollback")
        self.acl("preflight", False)
        # Verify denial under the real runtime logins, using harmless reads of the same objects.
        denied = {}
        for role, table in (
            ("t63_api", "throttler_buckets"),
            ("t63_worker", "ActivityBatchJob"),
        ):
            result = self.client(
                IMAGE,
                "node",
                "/check.cjs",
                table,
                role,
                options=[
                    "--platform",
                    "linux/amd64",
                    "--env-file",
                    t / (role + ".env"),
                    *mount(HERE / "denied.cjs", "/check.cjs"),
                ],
            )
            denied[role] = json.loads(result)
        write_json(self.evidence / "withdrawal.json", denied)
        after = json.loads(self.sql("t63_lab", (HERE / "business.sql").read_text()))
        assert after == json.loads((self.evidence / "business.json").read_text())
        print("Clean replay, business receipts and rollback verified", flush=True)

    def retire(self):
        for cid in reversed(self.containers):
            assert out("docker", "inspect", "-f", '{{index .Config.Labels "task"}}', cid) == "srvf-t63"
            run("docker", "rm", "-f", cid, stdout=sp.DEVNULL)
        if self.has_network:
            run("docker", "network", "rm", self.net, stdout=sp.DEVNULL)
        write_json(
            self.evidence / "retired.json",
            {
                "containersRemoved": len(self.containers),
                "networkRemoved": self.has_network,
                "publishedPorts": 0,
            },
        )


def main():
    if not __debug__:
        raise RuntimeError("Replay assertions require normal Python execution")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Git checkout containing the fixed API commit",
    )
    parser.add_argument("--evidence", type=Path, required=True, help="New evidence directory")
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=False)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="srvf-t63-") as scratch:
        lab = Lab(Path(scratch), args.evidence.resolve())
        try:
            lab.prepare(args.source)
            lab.exercise()
        except Exception:
            if lab.has_network and len(lab.containers) >= 1:
                log = out(
                    "docker",
                    "exec",
                    lab.tag + "-pg",
                    "sh",
                    "-c",
                    "cat /tmp/t63-logs/pg.csv 2>/dev/null || true",
                )
                errors = [
                    {"role": r[1], "state": r[12], "message": r[13]}
                    for r in csv.reader(io.StringIO(log))
                    if len(r) > 14 and r[12] == "42501" and r[1] in ("t63_api", "t63_worker")
                ]
                write_json(lab.evidence / "privilege-errors.json", errors[-20:])
            raise
        finally:
            lab.retire()


if __name__ == "__main__":
    main()
