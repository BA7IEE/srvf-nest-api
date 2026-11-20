#!/usr/bin/env bash
# Usage: check-true-review-before-accept.sh EXPECTED_HEAD IMPLEMENTER_ID TRUSTED_SOURCE.json REPORT.md
# The acceptance owner obtains the producer ID and original report digest from the
# reviewer channel/dispatch record. Display names and author-supplied receipts cannot establish origin.
set -eu
if [ "$#" -ne 4 ]; then
  echo "usage: $0 EXPECTED_HEAD IMPLEMENTER_ID TRUSTED_SOURCE.json REPORT.md" >&2
  exit 2
fi
exec python3 - "$@" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

head, implementer, source_path, report_path = sys.argv[1:]

def reject(reason):
    sys.exit(f"NOT_ACCEPTED: {reason}")

if not re.fullmatch("[0-9a-f]{40}", head) or not implementer.strip():
    reject("expected full commit SHA and implementer ID")
try:
    source = json.loads(Path(source_path).read_bytes())
    report = Path(report_path).read_bytes()
    text = report.decode("utf-8")
except (OSError, ValueError) as error:
    reject(f"unreadable source or report: {error}")

if not isinstance(source, dict):
    reject("invalid source record")
actor = source.get("actor_id")
if not isinstance(actor, str) or not actor.strip() or actor != actor.strip():
    reject("missing canonical producer ID")
if actor == implementer.strip() or source.get("participated_in_implementation") is not False:
    reject("producer implemented the change or independence is unverified")
if not isinstance(source.get("source_ref"), str) or not source["source_ref"].strip():
    reject("missing review event reference")
if hashlib.sha256(report).hexdigest() != source.get("report_sha256"):
    reject("report differs from the bytes delivered by the reviewer")

# The original event binds the decision to the commit even when its body is plain Markdown.
if source.get("reviewed_sha") != head:
    reject("source event missing the requested commit SHA")
if source.get("verdict") != "PASS":
    reject("source event has no unconditional acceptance")

# A reviewer may also include explicit fields in the first paragraph. If supplied,
# cross-check the whole header. The narrative can quote historical failures/SHAs.
header, _, body = text.replace("\r\n", "\n").partition("\n\n")
expected = {"Reviewer": actor, "Reviewed-SHA": head, "Verdict": "PASS"}
findings = text
if re.search(r"^(Reviewer|Reviewed-SHA|Verdict):", header, re.MULTILINE):
    for name, value in expected.items():
        values = re.findall(rf"^{name}:[ \t]*(.*)$", header, re.MULTILINE)
        if [v.strip() for v in values] != [value]:
            reject(f"missing, ambiguous or inconsistent {name} in report")
    findings = body
if findings.strip() in ("", "PASS", "APPROVED", "FAIL", "CONDITIONAL_PASS", "NOT_ACCEPTED"):
    reject("missing review findings")

print(f"OK: {actor} reviewed {head} ({source['source_ref']})")
PY
