#!/usr/bin/env python3
"""Pull every task at a given ACC review level and stage them for chat-with-task ingest.

Pipeline:
  1. Run l10_task_ids.sql via Redash  -> the list of task_ids currently at the level.
  2. Shell the (unmodified) fill_rank.py for those ids -> ranks/<id>/{rank,a,b}.json.
  3. Reshape each into the on-disk layout the app's trajectory viewer expects:
        <out>/<id>/rank.json
        <out>/<id>/trajectories/trajectory_model_a.json   (from a.json)
        <out>/<id>/trajectories/trajectory_model_b.json   (from b.json)
  4. Print a JSON manifest on stdout for the Node caller (src/l10.js).

This file is the L10 *batch* layer. It deliberately does NOT import fill_rank.py's
internals (eng may change them) — it only depends on its stable CLI and output dir.
fill_rank.py and latest_response.sql are vendored verbatim alongside this script.

Usage:
    REDASH_API_KEY=... python3 pull_l10.py --out <staging_dir>
        [--review-level 10] [--status pending] [--project <id>] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SQL_PATH = SCRIPT_DIR / "l10_task_ids.sql"
FILL_RANK = SCRIPT_DIR / "fill_rank.py"
RANKS_DIR = SCRIPT_DIR / "ranks"  # where fill_rank.py writes (REPO_ROOT/"ranks")

# Same Redash instance / project / data source as fill_rank.py; overridable by env.
REDASH_BASE_URL = os.environ.get("REDASH_BASE_URL", "https://redash.scale.com").rstrip("/")
PROJECT_ID = os.environ.get("L10_PROJECT_ID", "69979ab5a4b6d80af7b7d1c8")
REDASH_DATA_SOURCE_ID = int(os.environ.get("REDASH_DATA_SOURCE_ID", "30"))
REDASH_API_KEY = os.environ.get("REDASH_API_KEY")
# Published, parameterized Redash query (params: project_id, review_level, status) that
# returns the L10 task-id list. Running a saved query needs only VIEW access to the data
# source, so a key without ad-hoc-query permission still works (same approach fill_rank.py
# uses for the per-task fetch). 0 = fall back to ad-hoc SQL from l10_task_ids.sql (needs
# ad-hoc permission). Set L10_QUERY_ID once the query is published in Redash.
REDASH_QUERY_ID = int(os.environ.get("L10_QUERY_ID", "0"))

POLL_INTERVAL_SECONDS = 2.0
POLL_TIMEOUT_SECONDS = 120.0
_JOB_SUCCESS, _JOB_FAILURE, _JOB_CANCELLED = 3, 4, 5
TASK_ID_RE = re.compile(r"^[a-f0-9]{24}$")

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# Minimal Redash ad-hoc client (self-contained; mirrors fill_rank.py's flow)
# ---------------------------------------------------------------------------

def _redash_request(path: str, method: str = "GET", body: dict | None = None) -> dict:
    url = f"{REDASH_BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Key {REDASH_API_KEY}")
    req.add_header("User-Agent", _USER_AGENT)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Redash {method} {path} failed: {e.code} {e.reason}\n{detail}") from None


def _poll_job(job_id: str) -> int:
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_SECONDS)
        job = _redash_request(f"/api/jobs/{job_id}").get("job", {})
        status = job.get("status")
        if status == _JOB_SUCCESS:
            qr_id = job.get("query_result_id")
            if not qr_id:
                raise RuntimeError(f"Redash job {job_id} succeeded but returned no query_result_id")
            return qr_id
        if status in (_JOB_FAILURE, _JOB_CANCELLED):
            raise RuntimeError(f"Redash job {job_id} failed: {job.get('error') or f'status={status}'}")
    raise TimeoutError(f"Redash job {job_id} did not finish within {POLL_TIMEOUT_SECONDS:.0f}s")


def _rows_from_payload(payload: dict) -> list[dict]:
    """Resolve a /api/query_results-style response (job-or-result) into its rows."""
    if "query_result" in payload:
        query_result = payload["query_result"]
    else:
        job_id = payload.get("job", {}).get("id")
        if not job_id:
            raise RuntimeError(f"Unexpected Redash response: {payload}")
        qr_payload = _redash_request(f"/api/query_results/{_poll_job(job_id)}.json")
        query_result = qr_payload["query_result"]
    rows = query_result.get("data", {}).get("rows", [])
    return [{k.lower(): v for k, v in row.items()} for row in rows]


def fetch_task_ids(review_level: int, status: str, project: str) -> list[str]:
    if REDASH_QUERY_ID:
        # Published query: needs only view access (works for keys without ad-hoc rights).
        payload = _redash_request(
            f"/api/queries/{REDASH_QUERY_ID}/results",
            method="POST",
            body={
                "id": REDASH_QUERY_ID,
                "parameters": {"project_id": project, "review_level": review_level, "status": status},
                "max_age": 0,
            },
        )
    else:
        # Ad-hoc SQL fallback (needs ad-hoc-query permission on the data source).
        sql = SQL_PATH.read_text(encoding="utf-8")
        sql = (
            sql.replace("{{project_id}}", project)
            .replace("{{review_level}}", str(int(review_level)))
            .replace("{{status}}", status)
        )
        payload = _redash_request(
            "/api/query_results",
            method="POST",
            body={"query": sql, "data_source_id": REDASH_DATA_SOURCE_ID, "max_age": 0},
        )
    rows = _rows_from_payload(payload)
    ids, seen = [], set()
    for row in rows:
        tid = str(row.get("task_id") or "").strip()
        if TASK_ID_RE.match(tid) and tid not in seen:
            seen.add(tid)
            ids.append(tid)
    return ids


# ---------------------------------------------------------------------------
# fill_rank.py invocation + reshape into the app's task-folder layout
# ---------------------------------------------------------------------------

def run_fill_rank(task_ids: list[str]) -> None:
    """Shell the vendored fill_rank.py (stable CLI) to write ranks/<id>/ folders."""
    if not task_ids:
        return
    subprocess.run(
        [sys.executable, str(FILL_RANK), *task_ids],
        cwd=str(SCRIPT_DIR),
        check=False,  # fill_rank exits non-zero on partial pulls; we judge per-task below
    )


def _nonempty(p: Path) -> bool:
    return p.exists() and p.stat().st_size > 0


def stage_task(task_id: str, out_dir: Path) -> dict:
    """Reshape ranks/<id>/ -> out/<id>/ with trajectories/ where the viewer expects them."""
    src = RANKS_DIR / task_id
    dest = out_dir / task_id
    rank = src / "rank.json"
    if not _nonempty(rank):
        return {"task_id": task_id, "staged": False, "reason": "no rank.json from fill_rank"}

    (dest / "trajectories").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(rank, dest / "rank.json")
    have = {}
    for label, model in (("a", "model_a"), ("b", "model_b")):
        side = src / f"{label}.json"
        have[model] = _nonempty(side)
        if have[model]:
            shutil.copyfile(side, dest / "trajectories" / f"trajectory_{model}.json")
    return {
        "task_id": task_id,
        "staged": True,
        "trajectories": have,
        "partial": not (have["model_a"] and have["model_b"]),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Pull all tasks at a review level for chat-with-task.")
    ap.add_argument("--out", required=True, help="staging dir to write reshaped <id>/ folders into")
    ap.add_argument("--review-level", type=int, default=int(os.environ.get("L10_REVIEW_LEVEL", "10")))
    ap.add_argument("--status", default=os.environ.get("L10_STATUS", "pending"))
    ap.add_argument("--project", default=PROJECT_ID)
    ap.add_argument("--limit", type=int, default=0, help="cap the number of tasks (0 = no cap)")
    ap.add_argument("--task-ids", default="", help="explicit task ids (comma/space separated); skips the L10 query")
    args = ap.parse_args(argv[1:])
    project = args.project

    explicit = [t for t in re.split(r"[,\s]+", args.task_ids.strip()) if t]
    mode = "ids" if explicit else "l10"

    manifest = {
        "mode": mode,
        "review_level": args.review_level,
        "status": args.status,
        "project": project,
        "out": str(Path(args.out).resolve()),
        "task_ids": [],
        "staged": [],
        "errors": [],
    }

    if not REDASH_API_KEY:
        manifest["errors"].append("REDASH_API_KEY is not set in the environment")
        print(json.dumps(manifest))
        return 2

    if mode == "ids":
        ids, bad = [], []
        for t in explicit:
            (ids if TASK_ID_RE.match(t) else bad).append(t)
        if bad:
            manifest["errors"].append(f"ignored {len(bad)} non-24-hex id(s): {', '.join(bad[:5])}")
    else:
        try:
            ids = fetch_task_ids(args.review_level, args.status, project)
        except Exception as e:  # noqa: BLE001 — surface as a manifest error, not a stack trace
            manifest["errors"].append(f"query failed: {type(e).__name__}: {e}")
            print(json.dumps(manifest))
            return 1

    if args.limit and len(ids) > args.limit:
        manifest["errors"].append(f"limited to {args.limit} of {len(ids)} tasks")
        ids = ids[: args.limit]
    manifest["task_ids"] = ids

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    label = (f"explicit list: {len(ids)} task(s)" if mode == "ids"
             else f"L10 pull: {len(ids)} task(s) at review_level={args.review_level} status={args.status}")
    print(label, file=sys.stderr)
    run_fill_rank(ids)
    for tid in ids:
        try:
            manifest["staged"].append(stage_task(tid, out_dir))
        except Exception as e:  # noqa: BLE001
            manifest["errors"].append(f"{tid}: stage failed: {type(e).__name__}: {e}")

    print(json.dumps(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
