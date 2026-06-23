#!/usr/bin/env python3
"""Build a rank.json capturing the full attempter A/B submission for one or more tasks.

Pulls a task's latest RESPONSE:before blob from Redash, downloads both model trajectories,
and extracts the task metadata, real model names, trajectory + container-snapshot CDS urls,
per-model grading, all failure-mode ratings, the numeric preference rating, and rationales.
Writes one rank.json per task folder under ranks/<task_id>/. Self-contained: the only
external input is latest_response.sql alongside this script.

Usage:
    REDASH_API_KEY=... python3 fill_rank.py <task_id | task-NNN-... | NNN> [...]
    REDASH_API_KEY=... python3 fill_rank.py            # uses the in-file TASK_IDS list
    python3 fill_rank.py --from-file <before.json>     # offline: render from a saved blob
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent
OUT_DIR = REPO_ROOT / "ranks"
REVIEWS_DIR = REPO_ROOT / "reviews"
SQL_PATH = REPO_ROOT / "latest_response.sql"
TASK_PATTERN = re.compile(r"^task-(\d+)-")

# Optional fallback batch (used only when no task ids are passed on the command line).
TASK_IDS: list[str] = []

# ---------------------------------------------------------------------------
# Redash client + trajectory download
# ---------------------------------------------------------------------------

REDASH_BASE_URL = "https://redash.scale.com"
PROJECT_ID = "69979ab5a4b6d80af7b7d1c8"
REDASH_API_KEY = os.environ.get("REDASH_API_KEY")
# Snowflake data source backing the ad-hoc query in latest_response.sql, which returns the
# rubric fields AND the raw RESPONSE:before blob in a single row.
REDASH_DATA_SOURCE_ID = int(os.environ.get("REDASH_DATA_SOURCE_ID", "30"))

POLL_INTERVAL_SECONDS = 2.0
POLL_TIMEOUT_SECONDS = 120.0

# Redash job statuses: 1=pending, 2=started, 3=success, 4=failure, 5=cancelled
_JOB_SUCCESS = 3
_JOB_FAILURE = 4
_JOB_CANCELLED = 5

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


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
        payload = _redash_request(f"/api/jobs/{job_id}")
        job = payload.get("job", {})
        status = job.get("status")
        if status == _JOB_SUCCESS:
            qr_id = job.get("query_result_id")
            if not qr_id:
                raise RuntimeError(f"Redash job {job_id} succeeded but returned no query_result_id")
            return qr_id
        if status in (_JOB_FAILURE, _JOB_CANCELLED):
            err = job.get("error") or f"status={status}"
            raise RuntimeError(f"Redash job {job_id} failed: {err}")
    raise TimeoutError(f"Redash job {job_id} did not finish within {POLL_TIMEOUT_SECONDS:.0f}s")


def _run_adhoc_sql(sql: str) -> list[dict[str, Any]]:
    """Run an ad-hoc Snowflake query via Redash, poll if needed, return its rows.

    Keys are lowercased (Snowflake uppercases unquoted aliases).
    """
    payload = _redash_request(
        "/api/query_results",
        method="POST",
        body={"query": sql, "data_source_id": REDASH_DATA_SOURCE_ID, "max_age": 0},
    )

    if "query_result" in payload:
        query_result = payload["query_result"]
    else:
        job = payload.get("job", {})
        job_id = job.get("id")
        if not job_id:
            raise RuntimeError(f"Unexpected Redash response: {payload}")
        qr_id = _poll_job(job_id)
        qr_payload = _redash_request(f"/api/query_results/{qr_id}.json")
        query_result = qr_payload["query_result"]

    rows = query_result.get("data", {}).get("rows", [])
    return [{k.lower(): v for k, v in row.items()} for row in rows]


def fetch_from_redash(task_id: str) -> dict[str, Any]:
    """Run latest_response.sql for one task, returning the single matching row."""
    sql = SQL_PATH.read_text(encoding="utf-8")
    sql = sql.replace("{{project_id}}", PROJECT_ID).replace("{{task_id}}", task_id)
    rows = _run_adhoc_sql(sql)
    if not rows:
        raise RuntimeError(
            f"No annotation found in Redash for task_id={task_id} (project_id={PROJECT_ID})"
        )
    return rows[0]


def extract_before(row: dict[str, Any]) -> dict:
    """Pull the parsed RESPONSE:before blob out of a fetch_from_redash row."""
    before = row.get("before")
    if isinstance(before, str):
        before = json.loads(before)
    if not isinstance(before, dict):
        raise RuntimeError("Task response 'before' blob was not a JSON object")
    return before


def fetch_before_blob(task_id: str) -> dict:
    """Pull the raw RESPONSE:before blob for the latest attempt."""
    return extract_before(fetch_from_redash(task_id))


def cds_to_https(cds: str) -> str:
    """Convert a scale-cds:// url into the public S3 https url."""
    if not cds or not cds.startswith("scale-cds://"):
        return ""
    body, _, backend = cds.partition("#")
    project, _, file_id = body[len("scale-cds://"):].partition("/")
    bucket = backend.split("/", 1)[1] if "/" in backend else ""
    m = re.search(r"[a-z]{2}-[a-z]+-\d+", bucket)
    region = m.group(0) if m else "us-east-1"
    return f"https://{bucket}.s3.{region}.amazonaws.com/{project}/{file_id}"


def select_latest_instance(before: dict) -> dict | None:
    """Return the *latest* deploy instance dict from a RESPONSE:before blob.

    A task can have several deploy instances (re-runs); only ones with completed_runs are
    real, and the canonical one is the most recent — identified by the largest
    context.metadata.run_epoch. Returns the full instances[] element (carrying
    context.metadata.task_data, completed_runs, source_task_cds_url, etc.) or None when
    nothing usable is found (in-progress tasks). Defensive against missing keys.
    """
    best_inst = None
    best_epoch = None
    for step in before.values():
        if not isinstance(step, dict):
            continue
        out = step.get("output")
        if not isinstance(out, dict):
            continue
        items = out.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            data = item.get("content", {}).get("data", {})
            if not isinstance(data, dict):
                continue
            for inst in data.get("instances", []):
                if not isinstance(inst, dict):
                    continue
                meta = inst.get("context", {}).get("metadata", {})
                runs = meta.get("completed_runs")
                if not runs:
                    continue
                epoch = meta.get("run_epoch") or 0
                if best_epoch is None or epoch >= best_epoch:
                    best_epoch = epoch
                    best_inst = inst
    return best_inst


def trajectory_cds_by_label(before: dict) -> dict:
    """Map model_label -> trajectory.json CDS url from the *latest* completed instance.

    Note: when this blob comes from Snowflake's variant path, dotted keys are mangled
    (`trajectory.json` -> `trajectory__DOT__json`), so cds_urls keys are normalized.
    """
    inst = select_latest_instance(before)
    best_runs = inst.get("context", {}).get("metadata", {}).get("completed_runs") if inst else None

    result = {}
    for run in best_runs or []:
        if not isinstance(run, dict):
            continue
        label = (run.get("model_label") or "").lower()
        cds_urls = run.get("cds_urls", {})
        if not isinstance(cds_urls, dict):
            continue
        cds_urls = {k.replace("__DOT__", "."): v for k, v in cds_urls.items()}
        traj = cds_urls.get("trajectory.json", "")
        if label and traj and not result.get(label):
            result[label] = traj
    return result


def download_trajectories(folder: Path, before: dict) -> None:
    """Download each model's trajectory.json into a.json/b.json.

    Best-effort: on a missing label or a download failure, print a warning and write an
    empty placeholder file so the trajectory can be fetched manually later.
    """
    cds = trajectory_cds_by_label(before)
    for label, filename in (("a", "a.json"), ("b", "b.json")):
        dest = folder / filename
        url = cds_to_https(cds.get(label, ""))
        if not url:
            print(f"  WARNING: no trajectory found for model {label} — wrote empty {filename} (fetch manually)")
            dest.write_text("", encoding="utf-8")
            continue
        try:
            req = urllib.request.Request(url, method="GET")
            req.add_header("User-Agent", _USER_AGENT)
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
            dest.write_bytes(data)
            print(f"  Saved {filename} ({len(data)} bytes)")
        except (urllib.error.URLError, OSError) as e:
            print(f"  WARNING: failed to download trajectory for model {label}: {e} — wrote empty {filename} (fetch manually)")
            dest.write_text("", encoding="utf-8")


# ---------------------------------------------------------------------------
# Model-preference / rating helpers
# ---------------------------------------------------------------------------

_MODEL_PREFERENCE_MAP = {
    "model a": "Model Alpha > Model Beta",
    "model alpha": "Model Alpha > Model Beta",
    "alpha": "Model Alpha > Model Beta",
    "a": "Model Alpha > Model Beta",
    "model b": "Model Beta > Model Alpha",
    "model beta": "Model Beta > Model Alpha",
    "beta": "Model Beta > Model Alpha",
    "b": "Model Beta > Model Alpha",
    "tie": "Model Alpha = Model Beta",
    "equal": "Model Alpha = Model Beta",
    "model a = model b": "Model Alpha = Model Beta",
    "model alpha = model beta": "Model Alpha = Model Beta",
}

# Leading signed integer in strings like "+3: strongly prefer model b".
_RATING_RE = re.compile(r"[+-]?\d+")


def parse_rating(raw) -> int:
    """Pull the signed integer out of a preference_rating value (str or number)."""
    if isinstance(raw, bool):  # bool is an int subclass; reject it explicitly
        raise ValueError(f"rating is a bool, not a number: {raw!r}")
    if isinstance(raw, (int, float)):
        return int(raw)
    m = _RATING_RE.search(str(raw))
    if not m:
        raise ValueError(f"could not parse a number from rating {raw!r}")
    return int(m.group())


def _side_from_ranking(model_ranking: str) -> str:
    """Reduce a model_ranking value to 'A', 'B', 'tie', or '?' (uninterpretable)."""
    pref = _MODEL_PREFERENCE_MAP.get((model_ranking or "").strip().lower())
    if pref is None:
        return "?"
    if pref.startswith("Model Alpha >"):
        return "A"
    if pref.startswith("Model Beta >"):
        return "B"
    return "tie"


def _side_from_rating(rating: int) -> str:
    if rating < 0:
        return "A"
    if rating > 0:
        return "B"
    return "invalid"

# rank.json failure-mode key  <-  alpha_/beta_-prefixed form field (suffix after the prefix).
# The live form may carry only a subset; any canonical key not found defaults to "none".
FAILURE_MODE_SUFFIXES = {
    "incomplete_code": "incomplete_final_code",
    "overclaimed_status": "overclaimed_success",
    "continuation_nudges": "stalled_nudges",
    "excessive_turns": "excessive_turns",
    "weak_verification": "weak_verification",
    "malformed_tool_calls": "malformed_tool_calls",
    "debugging_loops": "debugging_loops",
    "over_scoped": "over_scoped",
    "wrong_initial_approach": "wrong_initial_approach",
    "regression_during_refactor": "regressions",
    "gibberish_output": "gibberish_output",
    "unrequested_artifacts": "unrequested_artifacts",
    "excessive_verbosity": "excessive_verbosity",
    # Not present in the example form version; mapped 1:1 if the live form adds them.
    "instruction_following": "instruction_following",
    "poor_navigation": "poor_navigation",
    "silent_no_progress": "silent_no_progress",
    "hallucinations": "hallucinations",
    "stubbornness": "stubbornness",
}

# rank.json grading key -> (score field stem, rationale field stem). The form appends the
# model index (1 = alpha, 2 = beta) to each stem (e.g. correctness_rating1).
GRADING_STEMS = {
    "correctness": ("correctness_rating", "correctness_justification"),
    "agent_behaviour": ("agent_behavior", "agent_behavior_justification"),
    "communications": ("communication", "communication_justification"),
    "code_style": ("code_style", "code_style_justification"),
}


# ---------------------------------------------------------------------------
# Blob scanning helpers
# ---------------------------------------------------------------------------

def _scan_outputs(before: dict) -> dict[str, Any]:
    """Merge every step's ``output`` dict into one flat field->value map.

    Survives step-id/version drift: rubric fields are looked up by name, not by the step
    they live in. Later steps win on key collisions (there are none in practice).
    """
    merged: dict[str, Any] = {}
    for step in before.values():
        if isinstance(step, dict) and isinstance(step.get("output"), dict):
            merged.update(step["output"])
    return merged


def _text(merged: dict, key: str) -> str:
    v = merged.get(key)
    return "" if v is None else str(v).strip()


def _score(merged: dict, key: str) -> int:
    v = merged.get(key)
    if v is None:
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _https(cds: str) -> str:
    """Convert a scale-cds:// url to https, region-less for public CDS buckets.

    cds_to_https yields ``{bucket}.s3.{region}.amazonaws.com``; the public CDS buckets are
    reachable region-less (``{bucket}.s3.amazonaws.com``), which also matches the canonical
    rank.json shape. Both forms are valid S3 urls.
    """
    url = cds_to_https(cds)
    if not url:
        return ""
    return re.sub(r"\.s3\.[a-z]{2}-[a-z]+-\d+\.amazonaws\.com", ".s3.amazonaws.com", url)


def _runs_by_label(metadata: dict) -> dict[str, dict]:
    """Map model_label ('a'/'b') -> its completed_runs entry."""
    out: dict[str, dict] = {}
    for run in metadata.get("completed_runs") or []:
        if not isinstance(run, dict):
            continue
        label = (run.get("model_label") or "").lower()
        if label and label not in out:
            out[label] = run
    return out


def _run_cds(run: dict, key: str) -> str:
    """Read a CDS url from a run's cds_urls / cds_snapshot_urls, de-mangling dotted keys."""
    urls: dict[str, str] = {}
    for src in ("cds_urls", "cds_snapshot_urls"):
        d = run.get(src)
        if isinstance(d, dict):
            for k, v in d.items():
                urls[k.replace("__DOT__", ".")] = v
    return urls.get(key, "")


def _run_snapshot(run: dict) -> str:
    """Container snapshot CDS url: prefer the 'final' snapshot, fall back to 'initial'.

    Not every run records a 'final' snapshot (e.g. the A-side often only has 'initial'),
    so falling back keeps container_snapshot_file populated rather than empty.
    """
    return _run_cds(run, "final") or _run_cds(run, "initial")


_SEVERITIES = {"none", "mild", "severe"}


def _norm_severity(raw: Any) -> str:
    """Reduce a failure-mode value to its severity token.

    The form is inconsistent: older modes store a bare ``mild``; newer ones store
    ``"severe: <description>"``. Take the token before the first colon when it is a known
    severity; otherwise pass the (lowercased) value through so nothing is silently lost.
    """
    if raw in (None, ""):
        return "none"
    s = str(raw).strip()
    token = s.split(":", 1)[0].strip().lower()
    return token if token in _SEVERITIES else s.lower()


# ---------------------------------------------------------------------------
# rank.json assembly
# ---------------------------------------------------------------------------

def _failure_modes(merged: dict, prefix: str) -> dict[str, str]:
    """All 18 canonical failure modes for one model; missing fields default to 'none'."""
    out: dict[str, str] = {}
    for canon, suffix in FAILURE_MODE_SUFFIXES.items():
        out[canon] = _norm_severity(merged.get(f"{prefix}_{suffix}"))
    return out


def _grading(merged: dict, idx: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for canon, (score_stem, rationale_stem) in GRADING_STEMS.items():
        out[canon] = {
            "score": _score(merged, f"{score_stem}{idx}"),
            "rationale": _text(merged, f"{rationale_stem}{idx}"),
        }
    return out


def extract_rank(before: dict) -> dict:
    """Assemble the rank.json dict (example key order) from a RESPONSE:before blob."""
    merged = _scan_outputs(before)
    inst = select_latest_instance(before) or {}
    metadata = inst.get("context", {}).get("metadata", {})
    task_data = metadata.get("task_data", {}) if isinstance(metadata, dict) else {}
    runs = _runs_by_label(metadata)
    run_a, run_b = runs.get("a", {}), runs.get("b", {})

    # Rank: model_1 is always model_a, model_2 always model_b. The winning side decides rank.
    side = _side_from_ranking(_text(merged, "model_ranking"))
    if side == "?":  # fall back to the numeric rating's sign when the radio is unreadable
        try:
            side = _side_from_rating(parse_rating(merged.get("preference_rating")))
        except (ValueError, TypeError):
            side = "tie"
    rank_a, rank_b = (1, 2) if side == "A" else (2, 1) if side == "B" else (1, 1)

    try:
        preference_rating: Any = parse_rating(merged.get("preference_rating"))
    except (ValueError, TypeError):
        preference_rating = None

    def model_block(model_key: str, run: dict, idx: str, rank: int, summary_field: str) -> dict:
        prefix = "alpha" if idx == "1" else "beta"
        return {
            "model_assignment": model_key,
            "rank": rank,
            "summary": _text(merged, summary_field),
            "trajectory_file": _https(_run_cds(run, "trajectory.json")),
            "container_snapshot_file": _https(_run_snapshot(run)),
            "grading": _grading(merged, idx),
            "failure_modes": _failure_modes(merged, prefix),
        }

    return {
        "task": _https(metadata.get("source_task_cds_url", "") if isinstance(metadata, dict) else ""),
        "instance_id": task_data.get("instance_id"),
        "source_instance_id": task_data.get("instance_id"),
        "annotator_id": task_data.get("annotator_id"),
        "vendor": task_data.get("vendor"),
        "problem_statement": task_data.get("problem_statement"),
        "test_type": "AB",
        "results": {
            "model_1": model_block("model_a", run_a, "1", rank_a, "model_alpha_reasoning"),
            "model_2": model_block("model_b", run_b, "2", rank_b, "model_beta_trajectory"),
        },
        "preference_rating": preference_rating,
        "ranking_rationale": _text(merged, "model_trajectory_justification"),
        "optional_clarification_comments": merged.get("optional_clarification_comments") or None,
        "optional_other_comments": merged.get("optional_other_comments") or None,
        "model_assignments": {
            "model_a": run_a.get("agent_model"),
            "model_b": run_b.get("agent_model"),
        },
    }


# ---------------------------------------------------------------------------
# Task-id resolution: accept a hex id, a reviews/ folder name, or a bare number
# ---------------------------------------------------------------------------

def resolve_task_id(arg: str) -> str:
    if re.fullmatch(r"[0-9a-fA-F]{6,}", arg):
        return arg
    if REVIEWS_DIR.is_dir():
        for d in REVIEWS_DIR.iterdir():
            m = TASK_PATTERN.match(d.name)
            if not m:
                continue
            num = m.group(1)
            if arg in (d.name, f"task-{num}", num) or (arg.isdigit() and int(arg) == int(num)):
                return d.name.split("-", 2)[2]
    return arg  # fall back; let the fetch surface a clear error


# ---------------------------------------------------------------------------
# Offline rendering (no network)
# ---------------------------------------------------------------------------

def _before_from_doc(doc: dict) -> dict:
    """Pull a RESPONSE:before blob out of a saved task document or a bare before-blob."""
    for path in (("response", "before"), ("lastTaskerResponse", "before"), ("before",)):
        node: Any = doc
        for k in path:
            node = node.get(k) if isinstance(node, dict) else None
        if isinstance(node, dict):
            return node
    return doc  # assume the doc itself is already a before-blob


def _render_from_file(path: Path) -> int:
    doc = json.loads(path.read_text(encoding="utf-8"))
    rank = extract_rank(_before_from_doc(doc))
    print(json.dumps(rank, indent=2))
    return 0


# ---------------------------------------------------------------------------
# Online: fetch + write one rank.json per task folder
# ---------------------------------------------------------------------------

def _process_task(arg: str) -> tuple[str, str, str, str]:
    """Fetch, download trajectories, and write rank.json. Returns (task_id, a, b, error)."""
    task_id = resolve_task_id(arg)
    folder = OUT_DIR / task_id
    folder.mkdir(parents=True, exist_ok=True)
    error = ""
    try:
        before = fetch_before_blob(task_id)
        download_trajectories(folder, before)
        rank = extract_rank(before)
        if not rank.get("instance_id"):
            print("  WARNING: no task metadata found (in-progress task?) — wrote partial rank.json")
        (folder / "rank.json").write_text(json.dumps(rank, indent=2) + "\n", encoding="utf-8")
        print(f"  Saved rank.json ({rank['instance_id'] or '?'})")
    except Exception as e:  # noqa: BLE001 - keep going across a batch
        error = f"{type(e).__name__}: {e}"
        print(f"  ERROR: {error}")

    def status(p: Path) -> str:
        if not p.exists():
            return "missing"
        size = p.stat().st_size
        return "EMPTY" if size == 0 else f"{size} bytes"

    return task_id, status(folder / "a.json"), status(folder / "b.json"), error


def main(argv: list[str]) -> int:
    args = argv[1:]
    if len(args) == 2 and args[0] == "--from-file":
        return _render_from_file(Path(args[1]))

    task_args = args or TASK_IDS
    if not task_args:
        print(__doc__)
        return 2
    if not os.environ.get("REDASH_API_KEY"):
        print("ERROR: REDASH_API_KEY is not set in the environment.", file=sys.stderr)
        return 2

    results = []
    total = len(task_args)
    for i, arg in enumerate(task_args, 1):
        print(f"\n[{i}/{total}] task {arg}")
        results.append(_process_task(arg))

    print("\n" + "=" * 78)
    print(f"{'task_id':<26} {'a.json':<14} {'b.json':<14} status")
    print("-" * 78)
    ok = 0
    for task_id, a, b, error in results:
        a_ok, b_ok = a.endswith("bytes"), b.endswith("bytes")
        if a_ok and b_ok and not error:
            note, ok = "OK", ok + 1
        elif error:
            note = f"ERROR ({error[:36]})"
        else:
            note = "INCOMPLETE (empty/missing trajectory)"
        print(f"{task_id:<26} {a:<14} {b:<14} {note}")
    print("-" * 78)
    print(f"{ok}/{total} tasks wrote rank.json with both trajectories")
    print(f"Output dir: {OUT_DIR}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
