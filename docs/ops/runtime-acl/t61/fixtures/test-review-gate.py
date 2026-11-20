"""Synthetic inputs for check-true-review-before-accept.sh. No real review evidence."""
import hashlib
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

fixtures = Path(__file__).resolve().parent
gate = fixtures.parents[4] / "scripts/check-true-review-before-accept.sh"
example = (fixtures / "review.md").read_text()
head = "1" * 40
author = "fixture-owner-01"
child = "fixture-child-02"
main = "fixture-reviewer-03"

def check(label, accepted=False, *, body=example, actor=child, participated=False,
          requested=head, reviewed=head, verdict="PASS", source_ref="fixture/event-42", digest=None, missing=None):
    with TemporaryDirectory() as tmp:
        report = Path(tmp) / "review.md"
        source = Path(tmp) / "source.json"
        payload = body.encode()
        if missing != "report":
            report.write_bytes(payload)
        if missing != "source":
            source.write_text(json.dumps({
                "actor_id": actor,
                "reviewed_sha": reviewed,
                "verdict": verdict,
                "participated_in_implementation": participated,
                "source_ref": source_ref,
                "report_sha256": hashlib.sha256(payload).hexdigest() if digest is None else digest,
            }))
        result = subprocess.run([gate, requested, author, source, report], capture_output=True, text=True)
        if (result.returncode == 0) != accepted or (
            not accepted and not result.stderr.startswith("NOT_ACCEPTED:")
        ):
            raise AssertionError(f"{label}: {result.returncode}, {result.stdout}, {result.stderr}")
    print(f"{label}: {'accept' if accepted else 'reject'}")

check("independent subagent, same parent", True, source_ref="fixture/owner-01/child-02/event-42")
check("independent reviewer, plain Markdown in original event", True, actor=main,
      body="模拟真实回传。复核了差异与实际执行结果。")
check("independent reviewer", True, actor=main, body=example.replace(child, main))
check("implementer self-review", actor=author, body=example.replace(child, author))
check("implementer self-named review_convention", actor=author, body=example.replace(child, "review_convention"))
check("claimed reviewer differs from producer", actor=main)
check("reviewer helped implement", participated=True)
check("participation unknown", participated=None)
check("missing source", missing="source")
check("missing source reference", source_ref="")
check("missing report", missing="report")
check("report altered since delivery", digest="0" * 64)
check("wrong reviewed SHA, target mentioned in body", body=example.replace(head, "2" * 40) + head)
check("missing reviewed SHA", body=example.replace(f"Reviewed-SHA: {head}\n", ""))
check("short target SHA", requested=head[:8])
check("ambiguous verdict", body=example.replace("Verdict: PASS", "Verdict: FAIL\nVerdict: PASS"))
check("FAIL with PASS in prose", body=example.replace("Verdict: PASS", "Verdict: FAIL") + "PASS")
check("conditional verdict", body=example.replace("Verdict: PASS", "Verdict: CONDITIONAL_PASS"))
check("historical NOT_ACCEPTED", body=example.replace("Verdict: PASS", "Verdict: NOT_ACCEPTED"))
check("missing findings", body=example.split("\n\n", 1)[0])
check("source SHA missing", reviewed=None)
check("source SHA from earlier revision", reviewed="2" * 40)
check("source verdict FAIL, report says PASS", verdict="FAIL")
check("source verdict absent", verdict=None)
check("verdict token alone is not a review report", body="PASS")
