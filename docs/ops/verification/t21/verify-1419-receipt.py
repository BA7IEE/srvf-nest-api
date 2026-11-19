"""Offline check of the host bridge receipt. No network access."""
import json
from pathlib import Path

receipt = json.loads(Path(__file__).with_name("1419-public.json").read_text())
for case, expected in (("oversize", (102504, 413, 40000, 0)), ("control", (49, 404, 40400, 0))):
    actual = tuple(receipt[case][key] for key in ("bytes", "status", "code", "exit"))
    if actual != expected:
        raise SystemExit(f"{case}: receipt mismatch")
print("PASS")
