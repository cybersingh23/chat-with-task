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

5. **Export** — each bucket column has a **⬇ ids** button (one task_id per line), and
   **Export all (CSV)** gives `task_id,bucket,verdict,claimed_by,has_review,has_remediation`.
   Filtered export: `/api/export/ids/HARD_FAIL?verdict=SBQ`.

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

## Notes

- `workspace/` and `data/` are gitignored — task data and credentials never leave the machine.
- Claim/verdict state lives in `<task>/_studio.json`; chat history in `<task>/_chat.json`.
- The copilot's system prompt encodes the audit house rules: grep-verify every specific
  number/quote, absence-claim polarity, complete 24-char IDs, idle time + missing task
  definition are informational-only.
- Trajectory format: opencode export (`{info, messages:[{info:{role}, parts:[text|reasoning|tool]}]}`),
  normalized server-side; `step-start`/`step-finish` parts are dropped.
- Dev screenshots with auth: `node tools/screenshot.mjs http://localhost:4100/ out.png`.
