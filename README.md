# Chat with Task — ACC Audit Studio

A separate layer on top of the existing `/acc` eval pipeline: a multi-user website where QM
reviewers **claim a task and chat with it**. Dark liquid-glass UI. Tasks are auto-sorted into
verdict buckets on upload, every task carries a generated `review.md` (glaring issues banner +
segmented findings) and `remediation.md` (pinpoint fix list), and both the docs and the copilot
cite trajectory points as **"Show in trajectory" buttons** that jump straight to the cited
message in the built-in trajectory viewer.

## Flow

1. **Admin builds & uploads a tasks zip.** Build it from an audited delivery:

   ```sh
   python3 tools/make_tasks_zip.py ~/Downloads/ACC_DELIVERY_0610 --out tasks_0610.zip
   ```

   The zip bundles the `<task_id>/` folders plus the delivery's `_audit/` artifacts. On upload
   (admin-only, drag-and-drop), every task is sorted into **HARD_FAIL / SOFT_FAIL / PASS** from
   `_audit/final_verdicts.json`, gets its `_audit_seed.md` slice, and **anything already in the
   workspace from a previous delivery is skipped** (reported in the upload summary).

2. **Reviewers sign in and claim.** Four seeded accounts (`data/users.json`, created on first
   boot — see Setup). A claimed task shows `⬤ claimed by <user>` on everyone's board (the index
   polls every 8s). Only the claimer or an admin can release it.

3. **Audit** — task page leads with the task definition (milestones with Locate-in-A/B +
   Ask-copilot), generated docs, trajectory viewers, and the audit copilot panel (LiteLLM
   tool-use loop over the task's files; history persists per task).

4. **Verdict** — the reviewer sets one of **No issues / SBQ / Fixes in progress / Second
   opinion** from the task header; it shows as a chip on the board.

   **Grammar Fixes** is a lane that fills itself: a task lands there when its audit's only
   tripped dimensions are the writing ones (R23/R24) — 3 spelling errors and nothing else
   qualifies, 2 spelling plus a milestone issue does not. Read from `review.md`'s `autoqc`
   fence, so un-audited tasks never land there. These get fixed in bulk rather than claimed
   one at a time, so claiming leaves a task in the lane and **Mark all fixed** clears the
   whole lane to *Fixes made*. Drag a card in when everything but grammar is done, or out to
   put it back in the normal flow (the override is stored as `grammar_lane` in `_studio.json`,
   so the automatic rule can't drag it back).

5. **Export** — each bucket column has a **⬇ ids** button (one task_id per line), and
   **Export all (CSV)** gives `task_id,bucket,verdict,claimed_by,has_review,has_remediation`.
   Filtered export: `/api/export/ids/HARD_FAIL?verdict=SBQ`.

## Pull tasks from Redash

Admins can pull tasks straight from Redash and **download them as a zip** — nothing is ingested
into the board, so existing buckets are never touched. On the Admin Console page (`/admin.html`),
**Pull Task by ID**: paste a list of 24-hex task ids (comma/space separated) and pull them.

(Pulling a whole review layer is still supported in the backend — `pull_l10.py` with no
`--task-ids` runs `tools/get_tasks/l10_task_ids.sql` for every task at `L10_REVIEW_LEVEL` with the
unpaused `L10_STATUS` — but it isn't surfaced as a button; the ID list is supplied externally.)

`tools/get_tasks/pull_l10.py` shells the vendored `fill_rank.py` to build each
`rank.json` + both trajectories, reshapes them into `<task_id>/rank.json` +
`<task_id>/trajectories/trajectory_model_{a,b}.json`, and the server zips them. The pull runs in
the background (single-flight); the page polls `GET /api/admin/pull-l10/status` and shows a
**download zip** link when ready (`GET /api/admin/pull-l10/download`). The zip's folder shape
matches the upload flow, so it can be re-uploaded or fed to an eval directly.

Requires `REDASH_API_KEY` in the VM's `.env` and Python 3.10+. Both queries run as **published,
parameterized Redash queries** (`POST /api/queries/<id>/results`), which need only **view-only**
data-source access — so a key without ad-hoc-query permission works:

- **Per-task fetch** — `fill_rank.py` uses `REDASH_QUERY_ID` (default `324062`). Works out of the
  box, so **Pull these ids** is ready with any view-only key.
- **L10 list** — set `L10_QUERY_ID` to a published query taking `project_id` / `review_level` /
  `status`. Until it's set, **Pull L10** falls back to ad-hoc SQL (`l10_task_ids.sql`), which needs
  ad-hoc-query permission.

`fill_rank.py` is vendored **verbatim** — `pull_l10.py` only depends on its CLI. No schedule:
button-triggered only.

## Delivering tasks (soft-archive + backup)

On the Admin Console page, admins can paste task ids and **Mark delivered**. Delivered tasks are
*soft-archived*: their `_studio.json` gets a `delivered` flag, so they drop off the board
(hidden for everyone) but stay on disk — **Restore** clears the flag and they reappear. The
board shows a **Show delivered (N)** toggle when any are hidden.

Marking delivered also builds **one backup zip** (download link on the panel) that fully
restores the feed if re-uploaded through the normal upload flow:

```
delivered_<stamp>.csv        readable audit register (task_id, bucket, verdict, claim,
                             annotator, problem, review.md + remediation.md text, checklist)
_audit/final_verdicts.json   maps each task → its bucket, so re-upload re-sorts correctly
<task_id>/…                  full folder snapshot, with a pre-delivery _studio.json
                             (no delivered flag → restores visible)
```

Keep the CSV as your delivered-tasks register; keep the zip as the recovery point. Only the most
recent backup is retained on disk (`workspace/_deliveries/`); download it after each delivery.

## Doc conventions

- `review.md` starts with a ```` ```alerts ```` fence — one line per glaring issue — rendered as
  a large red banner at the top of the page ("MODEL A IS A 2-MESSAGE GREETING STUB…"). Findings
  are one-error-one-block: `### [HARD] F1 — title` with Claim / Evidence / Impact bullets,
  separated by horizontal rules.
- `remediation.md` is a pinpoint fix list: each `### R<n>` block has **Go to** (exact file/field
  path or traj:// point), **Problem**, **Fix** (before → after), **Verify**.
- `traj://model_a/23` links anywhere (docs, chat) render as buttons that open the trajectory
  viewer scrolled to that message. URL form: `/task/<bucket>/<id>?traj=model_a&msg=23`.

## Setup

```sh
npm install
cp .env.example .env   # fill in LITELLM_API_KEY (same key as trajectory-viewer-v2)
npm start              # http://localhost:4100
```

First boot seeds `data/users.json` with four accounts:
`admin/admin-cwt26` (admin), `qm1/qm1-cwt26`, `qm2/qm2-cwt26`, `qm3/qm3-cwt26` (reviewers).
Passwords are scrypt-hashed; to reset one, replace its entry's hash fields with
`"password": "newpass"` — it re-hashes on next login. Sessions are in-memory (a server restart
logs everyone out).

## Deploying (sandbox / VM)

The app is one long-lived Node process with three stateful directories — it needs a host with a
persistent disk (a sandbox VM or container platform with volumes), **not** a serverless platform
(uploads are 100s of MB; docgen streams for minutes).

```sh
# on the host
git clone <repo> && cd chat-with-task
# 1. customer docs (NOT in git) — copy them in:           spec/   (see spec/README.md)
# 2. cp .env.example .env  → set LITELLM_API_KEY
docker compose up -d --build                              # serves :4100
```

Or without Docker: `npm ci && npm start` (needs Node 22+ and `unzip` on PATH).

| Mount / env | Holds |
|---|---|
| `/app/workspace` (`WORKSPACE_ROOT`) | uploaded tasks, chats, claims/verdicts |
| `/app/data` (`DATA_DIR`) | `users.json` (seeded on first boot) |
| `/app/spec` (`SPEC_DIR`, read-only) | customer spec docs incl. `V11_RUBRIC.csv` |

`GET /healthz` is the unauthenticated liveness probe. Change the seeded passwords in
`data/users.json` before sharing the URL (set `"password": "newpass"` on an entry — it re-hashes
on next login). Sessions are in-memory: a restart logs everyone out, nothing else is lost.
Put TLS in front (sandbox ingress / reverse proxy) — the login cookie is HttpOnly but the app
itself serves plain HTTP.

## Notes

- `workspace/` and `data/` are gitignored — task data and credentials never leave the machine.
- Claim/verdict state lives in `<task>/_studio.json`; chat history in `<task>/_chat.json`.
- The copilot's system prompt encodes the audit house rules: grep-verify every specific
  number/quote, absence-claim polarity, complete 24-char IDs, idle time + missing task
  definition are informational-only.
- Trajectory format: opencode export (`{info, messages:[{info:{role}, parts:[text|reasoning|tool]}]}`),
  normalized server-side; `step-start`/`step-finish` parts are dropped.
- Dev screenshots with auth: `node tools/screenshot.mjs http://localhost:4100/ out.png`.
