"""Verify the saved build matrix, its published CSV, and retrieval denominators."""
import csv
import json
import math
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
batch = sys.argv[1] if len(sys.argv) > 1 else "measured-build"
if not batch or not all(c.isalnum() or c in "-_" for c in batch):
    raise ValueError("Invalid batch")
results = root / "results"
def records(path):
    return [json.loads(p.read_text(encoding="utf8")) for p in sorted(path.glob("*.json"))]
def csv_rows(name):
    with (results / name).open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))

cases = {c["id"]: c for c in json.loads((root/"corpora"/"manifest.json").read_text(encoding="utf8"))["cases"]}
configs = ["seekdb-model","seekdb-hash","sag2-memory","sag2-sqlite-file","sag2-over-seekdb"]
want = {(case, config, "default") for case in cases for config in configs}
want.update({("B08","sag2-memory","8192"),("B09","sag2-memory","8192")})
assert len(want) == 47
rows = records(results/"index-build"/batch)
assert len(rows) == 47 and {(r["caseId"],r["config"],r["heap"]) for r in rows} == want
csv_data = csv_rows("index-build-summary.csv")
assert len(csv_data) == 188
phase_counts = {status:0 for status in ["ok","error","blocked"]}
for r in rows:
    case = cases[r["caseId"]]
    assert r["corpus"]["sha256"] == case["sha256"] and not r.get("cleanupError"), r
    assert r["status"] in {"ok","error"} and (r["status"] == "ok" or r.get("error"))
    steps = r["steps"]
    assert [s["phase"] for s in steps] == ["full","one","1pct","10pct"]
    published = {v["phase"]: v for v in csv_data if v["caseId"]==case["id"] and v["config"]==r["config"] and v["heap"]==r["heap"]}
    for s in steps:
        state = s["status"]
        phase_counts[state] += 1
        assert published[s["phase"]]["phaseStatus"] == state
        if state == "ok":
            assert s["elapsedMs"] > 0 and s["rssPeakBytes"] > 0 and s["stages"]["scan"] is not None
            assert s["changedFiles"] == {"full":0, "one":1, "1pct":math.ceil(case["files"]*.01),
                                         "10pct":math.ceil(case["files"]*.1)}[s["phase"]]
            if s["phase"]=="full":
                assert {t["repositoryId"] for t in s["repos"]} == {t["id"] for t in case["repositories"]}
            if r["config"] in {"sag2-memory","sag2-sqlite-file"}:
                assert s["embeddingCalls"] == s["embeddingVectors"] == 0
        else:
            assert s.get("error"), (case["id"],r["config"],s["phase"])
    assert r["status"] != "ok" or all(s["status"]=="ok" for s in steps)

extras = records(results/"index-build"/"xl-query-diagnostic") if batch=="measured-build" else []
observed = set()
for r in rows+extras:
    q = r.get("queries")
    if not q or q.get("status") != "ok":
        continue
    samples=q["samples"]
    assert len(samples)==48
    assert len({(s["mode"],s["query"],s["repeat"]) for s in samples})==48
    assert all(s["status"]=="ok" and s["ms"]>=0 and 0<=s["recallAt4"]<=1 for s in samples)
    assert len(q["scope"]) == len(cases[r["caseId"]]["repositories"])+1
    observed.add(r["caseId"])
print(f"Verified {len(rows)} measured attempts, {len(csv_data)} phase rows: {phase_counts}")
print("Cases with 48 completed query measurements:", ", ".join(sorted(observed)))
missing = {"B03","B06","B08","B09"} - observed
if missing:
    print("No fully measured query series:", ", ".join(sorted(missing)), file=sys.stderr)
    sys.exit(2)
