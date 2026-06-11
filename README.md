# Chat with Task — ACC Audit Studio

A separate layer on top of the existing `/acc` eval pipeline: a website where QM reviewers
**chat with a claimed task**. Tasks are sorted into verdict buckets, every task carries a
generated `review.md` (thorough flaw review) and `remediation.md` (fix plan), and both the
docs and the copilot cite trajectory points as **"Show in trajectory" buttons** that jump
straight to the cited message in the built-in trajectory viewer.

## Flow

1. **Sort** an audited delivery into buckets (uses `_audit/final_verdicts.json` from `/acc`):

   ```sh
   python3 tools/sort_delivery.py ~/Downloads/ACC_DELIVERY_0610
   ```

   This creates `workspace/{HARD_FAIL,SOFT_FAIL,PASS,UNSORTED}/<task_id>/` with the full task
   folder plus `_audit_seed.md` — that task's slice of the audit findings.

2. **Upload** — reviewers add their claimed task from the browser: drag the `<task_id>` folder
   (or a .zip of it) onto the home page, or use the pickers. Works when the server runs on a
   shared host with no access to the reviewer's files. If the upload contains a sibling
   `_audit/` dir (whole-delivery zip), the audit seed is attached automatically.
   Claiming by task ID (server-side search of `DELIVERY_ROOTS` for `ACC_DELIVERY_*`) remains
   as a secondary path for local use.

   **Task definition & milestones** — every task page leads with the task definition
   (`rank.json:task`, legacy fallback `source_task/task.json`): persona, milestones, and
   guardrails. Each milestone has *Locate in A/B* (jumps to the closest user turn — navigation,
   not a coverage verdict) and *Ask copilot* (pre-fills a milestone-coverage check).

3. **Generate docs** — `review.md` and `remediation.md` are written by an LLM agent (LiteLLM
   proxy, tool-use loop over the task's files) and rendered in the UI.

4. **Chat** — the right-hand copilot panel has the same file tools (`list_files`, `read_file`,
   `search`, `read_trajectory`). Reviewers go back and forth to verify claims; chat history
   persists per task in `_chat.json`.

5. **Deep links** — any `traj://model_a/23` link in a doc or chat reply renders as a button
   that opens the trajectory viewer scrolled to message 23 (highlighted). Each trajectory
   message has a *copy link* button to cite it back. URLs also work directly:
   `/task/<bucket>/<id>?traj=model_a&msg=23`.

6. **Re-bucket** — after remediation review, move the task between buckets from the header.

## Setup

```sh
npm install
cp .env.example .env   # fill in LITELLM_API_KEY (same key as trajectory-viewer-v2)
npm start              # http://localhost:4100
```

## Notes

- `workspace/` is gitignored — task data never leaves the machine.
- The copilot's system prompt encodes the audit house rules: grep-verify every specific
  number/quote, absence-claim polarity, complete 24-char IDs, idle time + missing task
  definition are informational-only.
- Trajectory format: opencode export (`{info, messages:[{info:{role}, parts:[text|reasoning|tool]}]}`),
  normalized server-side; `step-start`/`step-finish` parts are dropped.
