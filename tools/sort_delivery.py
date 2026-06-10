#!/usr/bin/env python3
"""Sort an audited ACC delivery into the chat-with-task workspace buckets.

Reads per-task verdicts from the delivery's /acc audit artifacts
(_audit/final_verdicts.json by default) and copies each task folder into
<workspace>/{HARD_FAIL,SOFT_FAIL,PASS,UNSORTED}/<task_id>/, alongside an
_audit_seed.md slice of the audit findings for that task. review.md and
remediation.md are generated later from the web app (they need the LLM).

Usage:
  python3 tools/sort_delivery.py ~/Downloads/ACC_DELIVERY_0610 [--workspace ./workspace]
      [--verdicts path/to/final_verdicts.json] [--overwrite] [--dry-run]
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

BUCKETS = ["HARD_FAIL", "SOFT_FAIL", "PASS", "UNSORTED"]
TASK_ID_RE = re.compile(r"^[a-f0-9]{24}$")


def bucket_for(verdict: str) -> str:
    v = (verdict or "").strip().upper()
    if v.startswith("HARD"):
        return "HARD_FAIL"
    if v.startswith("SOFT"):
        return "SOFT_FAIL"
    if v.startswith("PASS"):
        return "PASS"
    return "UNSORTED"


def load_verdicts(path: Path) -> dict:
    """final_verdicts.json: list of {task_id, verdict, ...} -> {task_id: row}."""
    rows = json.loads(path.read_text())
    if not isinstance(rows, list):
        sys.exit(f"unexpected verdicts format in {path} (want a list of rows)")
    return {r["task_id"]: r for r in rows if "task_id" in r}


def audit_seed(audit_dir: Path, task_id: str, verdict_row) -> str:
    sections = [f"# Audit seed for {task_id}", f"Source: {audit_dir}"]
    if verdict_row:
        sections.append("## Final verdict\n```json\n" + json.dumps(verdict_row, indent=2) + "\n```")
    cv = audit_dir / "claim_verdicts.json"
    if cv.exists():
        try:
            data = json.loads(cv.read_text())
            rows = data if isinstance(data, list) else data.get("claims", list(data.values()))
            mine = [r for r in rows if task_id in json.dumps(r)][:80]
            if mine:
                sections.append(
                    "## Claim verdicts (verify_claims.py)\n```json\n"
                    + json.dumps(mine, indent=2)[:30000] + "\n```"
                )
        except Exception as e:  # noqa: BLE001 — seed is best-effort
            sections.append(f"(could not slice claim_verdicts.json: {e})")
    for md in sorted(audit_dir.glob("fairness_findings*.md")) + [audit_dir / "ACC_AUDIT.md"]:
        if md.exists():
            text = md.read_text()
            if task_id in text:
                chunks, i = [], text.find(task_id)
                while i != -1 and len(chunks) < 4:
                    chunks.append(text[max(0, i - 400): i + 1600])
                    i = text.find(task_id, i + 1600)
                body = "\n".join(f"```\n…{c}…\n```" for c in chunks)
                sections.append(f"## {md.name} excerpt\n{body}")
    return "\n\n".join(sections) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("delivery", type=Path, help="materialized delivery dir (contains <task_id>/ folders)")
    ap.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parent.parent / "workspace")
    ap.add_argument("--verdicts", type=Path, default=None, help="default: <delivery>/_audit/final_verdicts.json")
    ap.add_argument("--overwrite", action="store_true", help="replace tasks already in the workspace")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    delivery = args.delivery.expanduser().resolve()
    if not delivery.is_dir():
        sys.exit(f"not a directory: {delivery}")

    verdicts_path = args.verdicts or (delivery / "_audit" / "final_verdicts.json")
    verdicts = {}
    if verdicts_path.exists():
        verdicts = load_verdicts(verdicts_path)
        print(f"verdicts: {len(verdicts)} rows from {verdicts_path}")
    else:
        print(f"WARNING: no verdicts file at {verdicts_path} — everything goes to UNSORTED")

    task_dirs = sorted(
        d for d in delivery.iterdir()
        if d.is_dir() and TASK_ID_RE.match(d.name) and (d / "rank.json").exists()
    )
    if not task_dirs:
        sys.exit(f"no <task_id>/rank.json folders found under {delivery}")

    for b in BUCKETS:
        (args.workspace / b).mkdir(parents=True, exist_ok=True)

    counts = {b: 0 for b in BUCKETS}
    skipped = []
    audit_dir = delivery / "_audit"
    for td in task_dirs:
        row = verdicts.get(td.name)
        bucket = bucket_for(row.get("verdict") if row else None)
        dest = args.workspace / bucket / td.name
        existing = [p for b in BUCKETS if (p := args.workspace / b / td.name).exists()]
        if existing and not args.overwrite:
            skipped.append(td.name)
            continue
        counts[bucket] += 1
        print(f"  {bucket:9s} <- {td.name}")
        if args.dry_run:
            continue
        for p in existing:
            shutil.rmtree(p)
        shutil.copytree(td, dest)
        if audit_dir.is_dir():
            (dest / "_audit_seed.md").write_text(audit_seed(audit_dir, td.name, row))

    print(f"\ndone: " + ", ".join(f"{b}={counts[b]}" for b in BUCKETS))
    if skipped:
        print(f"skipped (already in workspace, use --overwrite): {len(skipped)}")
        for t in skipped:
            print(f"  {t}")


if __name__ == "__main__":
    main()
