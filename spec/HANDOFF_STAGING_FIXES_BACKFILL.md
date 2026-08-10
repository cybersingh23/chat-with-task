# Handoff — Staging layer, in-app fixes, and backfill export

**Audience:** whoever is building this in `chat-with-task`.
**Status:** spec. Nothing in this document is built yet. The upstream (eval) half **is** built and
shipping — see §2 for the payload you'll receive.
**Reference batch:** `~/Downloads/upload_0807_1252.zip` (78 tasks) and the delivery it came from,
`~/Downloads/ACC_DELIVERY_0807_1252/`. Every example below is copied verbatim out of that batch, so
you can diff your implementation against real data rather than a mock.

> **Please ask.** Two decisions are explicitly left open in §10, and there are places where I've
> picked a default that may not match how you actually operate the board. If a rule here looks
> arbitrary, it probably has a reason behind it that I failed to write down — ask rather than guess.
> Same if you hit a shape in the data that contradicts this doc: the data wins, and I want to know.

---

## 1. Why this exists

### 1.1 What the product actually is

Each task is a **pairwise model evaluation**. Two models (`model_a`, `model_b`, blinded behind
codenames) were given the same coding task in the same container. A human annotator drove both
sessions, then wrote a judgement: a `rank` for each side, a `preference_rating`, per-dimension scores
(correctness, agent_behaviour, communications, code_style), 20 `failure_modes` flags, and prose
rationales. That judgement is the **label**. It's what the customer buys and what downstream training
or model-selection decisions get made on.

The `/acc` audit exists because that label is expensive to produce and easy to get wrong in ways that
are invisible on inspection. It runs six checks over each task and asks one question: *would a
customer be misled about which model is better, and why?*

### 1.2 Why not all defects are equal — this is the crux of the change

The audit's findings fall into two categories that behave completely differently:

**Label-invalidating.** A claim attributed to the wrong model. A rank that contradicts its own
rationale. A ranking decided by a harness artifact (a context compaction, an output-cap truncation)
rather than model behaviour. A whole record that grades a different task than the trajectories
attached to it — we found exactly that this batch, and the delivery validator passed it 21/21.
These corrupt the comparison. They need a human to re-derive the judgement; you cannot script them.

**Cosmetic.** Spelling, grammar, punctuation in the customer-facing prose. Graded under V11 rubric
dimensions R23/R24, and by count: 0 errors = pass, 1 = score 4, 2–3 = score 3, 4+ minor or 2+
egregious = Fail. A Fail here used to make the whole task HARD. But a comma splice in a rationale
doesn't make the model comparison wrong — it makes the deliverable sloppy. The fix is mechanical and
the correct text is knowable from the flagged span alone.

That asymmetry is the entire reason for this work. Grammar defects are now **fixed automatically in
the same cycle as the audit**, and a task whose *only* failing layer was grammar ships **PASS** with
a `grammar-fixed` tag instead of sitting in a fail lane. Non-grammar findings still set the bucket,
and still need you.

### 1.3 Why the as-delivered text must survive

If we fix grammar and only keep the fixed version, the vendor's error rate disappears. A vendor who
ships 127 writing errors and a vendor who ships zero look identical downstream, and the incentive to
proofread evaporates. So every fixed task ships **two copies** of the label, plus a ledger of what
changed between them. §3 makes this concrete. This is also why `writing_band_as_delivered` is on the
verdict row: it's the as-delivered R23/R24 band, preserved after the verdict moves to PASS.

### 1.4 What you're building

The board currently ends at "reviewer resolves a task." You're extending it to:

- surface which records the eval already cleaned, and let the reviewer approve or deny each change;
- let the reviewer apply the *non*-grammar fixes with a button instead of hand-editing JSON;
- reconcile board state against Redash so SBQ and pipeline layer aren't guesses;
- export the corrected labels back in the original wire format for platform backfill;
- verify a backfill actually landed.

---

## 2. Payload contract — what arrives in the zip

Drag-drop is unchanged (`src/upload.js` → `ingestFromDelivery`). `fs.cpSync` copies whole task dirs,
so the new files come along with no ingest change needed. What changed is the *content*.

### 2.1 `_audit/final_verdicts.json` — new fields

Was `[{task_id, verdict}]`. Now:

```json
{
  "task_id": "6a6968b5483e19cfb6662ef4",
  "verdict": "PASS",
  "tags": ["grammar-fixed"],
  "grammar_only_fail": true,
  "writing_band_as_delivered": "SOFT(4)",
  "grammar_fixes_applied": 1,
  "grammar_fixes_meaning_changing": 1
}
```

An untagged task looks the same with `tags: []`, `grammar_only_fail: false`,
`writing_band_as_delivered: "PASS"`, and zero counts.

Semantics:

| Field | Meaning |
|---|---|
| `verdict` | `PASS` / `SOFT` / `HARD`. Still the only thing `bucketFor()` should key off. |
| `tags` | `["grammar-fixed"]` iff the task had **any** writing finding, regardless of verdict. |
| `grammar_only_fail` | `true` iff writing was the **only** failing layer — this is why `verdict` is PASS. |
| `writing_band_as_delivered` | The R23/R24 band **before** fixes. Vendor-accountability field; see §1.3. |
| `grammar_fixes_applied` | Count of edits written into `rank.json` by the eval. |
| `grammar_fixes_meaning_changing` | Subset of the above that alter meaning, not just mechanics. |

**Required change:** `loadVerdicts()` (`src/upload.js:186`) currently does
`new Map(rows.map(r => [r.task_id, r.verdict]))` and throws everything else away. Make it
`new Map(rows.map(r => [r.task_id, r]))` and have `bucketFor()` read `row.verdict`. Everything else
in this doc depends on that one line.

### 2.2 `<task>/rank.source.json` — new, immutable

Byte-for-byte the label as the vendor delivered it, before any grammar fix. Present only on tasks
that had a writing finding (47 of 78 in the reference batch). **Never write to this file.** It is the
rollback anchor for undo, the comparand for the diff view, and the correct source for
vendor-facing analytics.

### 2.3 `<task>/grammar_fixes.json` — new

The edits the eval already applied. One entry per edit:

```json
{
  "path": "/results/model_2/summary",
  "occurrence": 1,
  "occurrences_in_field": 1,
  "old": "trie lexicolon over packed postings array",
  "new": "trie lexicon over a packed postings array",
  "class": "minor",
  "rule": "R23",
  "error_type": "spelling",
  "meaning_changing": true,
  "owner": "annotator",
  "status": "APPLIED"
}
```

`status` is `APPLIED` on all of these — the text in `rank.json` already reflects them. A small number
carry `"reanchored": true`; see §5.4 for what that means and why it matters to your validator.

### 2.4 `<task>/remediation.md` — fix blocks

Findings are now directive. Each fix is 1–2 lines of prose followed by a fenced block:

````
### Fix 3 — Reset the continuation_nudges failure mode on model_2 to none
The flag is `severe` against model_1's `none`, but every nudge on side b is the verbatim harness
string after a `compaction` turn and side a was never compacted.

```fix
{"id":"F3","rule":"R16","class":"soft","status":"PROPOSED","meaning_changing":true,"owner":"annotator","path":"/results/model_2/failure_modes/continuation_nudges","occurrence":1,"old":"severe","new":"none"}
```
````

Contract:

- **Single-line JSON inside a ` ```fix ` fence.** Parse with
  `/```fix\n(.*?)\n```/gs` then `JSON.parse`. Single-line so it survives markdown rendering and so
  quotes/newlines inside `old`/`new` are JSON-escaped rather than needing a custom parser.
- `path` is a **JSON pointer** into `rank.json`.
- `old` is an **exact substring** of the value at `path`. Not a paraphrase, no ellipsis, no
  `[placeholder]`. Scalars work directly: `"old":"severe","new":"none"`.
- `new` is the literal replacement. `""` means delete.
- `occurrence` is 1-based. If `old` isn't unique in the field, the eval widens `old` until it is —
  but validate anyway (§5.2).
- `status`: `APPLIED` (grammar, already in `rank.json`) or `PROPOSED` (needs a decision).
- `owner`: `annotator` | `vendor` | `internal-QM` | `packaging`.
- Non-swap actions carry `"path": null` plus an `"instruction"` string — e.g. "pull and re-grade this
  record." Render these but never try to apply them.

**Transitional note:** in the reference batch, 9 of 78 tasks use this format
(`_audit/v2_docs.json` lists them); the other 69 carry v1 prose findings plus the grammar section
appended. Don't assume every `remediation.md` has fences yet. Future batches will be uniform.

### 2.5 On-disk vs wire — the delta that matters for export

`transform.py` and `embed_task_defs.py` rewrite three things when they explode the wire JSON to disk.
You need to know this for §6:

| Field | Wire (original) | On disk |
|---|---|---|
| `rank.json.task` | CDS URL string | inlined task-definition object |
| `rank.json.task_cds_url` | absent | the original URL, preserved |
| `results.*.trajectory_file` | CDS URL | relative path (`trajectories/trajectory_model_a.json`) |
| `results.*.container_snapshot_file` | CDS URL | relative path |

Everything else is identical — **measured, not assumed**: across all 91 tasks of the reference batch,
a full leaf-wise diff of the wire row's `rank.json` against the as-delivered on-disk copy returns
exactly six paths, and they are precisely the four file pointers plus `/task` and `/task_cds_url`.
That is why export is **not** a reverse transform (§6.2): the original row already holds the correct
URLs, so copying a whitelist forward is both simpler and auditable.

---

## 3. Data model

### 3.1 Three files plus a ledger, per task

```
workspace/<layer>/<task_id>/
  rank.source.json   immutable   as delivered
  rank.json          mutable     current state (eval fixes + board fixes)
  grammar_fixes.json read-only   what the eval did
  fix_ledger.json    append-only board's change log  ← you create this
  _studio.json       mutable     reviewer state (existing)
```

`fix_ledger.json` entries:

```json
{
  "fix_id": "F3",
  "source": "remediation.md",
  "path": "/results/model_2/failure_modes/continuation_nudges",
  "occurrence": 1,
  "old": "severe",
  "new": "none",
  "decision": "approved",
  "decided_by": "pavit",
  "decided_at": "2026-08-10T14:02:11Z",
  "reverted_at": null,
  "reason": null
}
```

**Why append-only.** Undo needs to be deterministic. With a log you restore the field from
`rank.source.json` and replay every non-reverted entry for that path — you always land in a state you
can explain. Mutating in place and hoping you can invert the edit fails the moment two fixes touch
one field.

**Seed the ledger at ingest** from `grammar_fixes.json`, one entry per edit, `decision: "approved"`,
`decided_by: "acc-eval"`. The eval's work then shows as history rather than pending work, and the
approve/deny UI has a uniform list to render.

**Durability.** The ledger must survive re-upload the way `_studio.json` does (`upload.js:143`). On a
re-upload of *changed* content, the task reopens (`REOPEN_VERDICTS` path) — mark prior ledger entries
`superseded_at` rather than replaying them onto new text. Replaying stale `old` strings onto a
re-delivered record is the single most likely way to silently corrupt a label.

### 3.2 Layer × severity — orthogonal, not one axis

Severity (`HARD_FAIL` / `SOFT_FAIL` / `PASS` / `UNSORTED`) is a property of the **audit**. Layer is
where the task sits in **your workflow**:

```
Open  →  Staging (grammar & quality fixes)  →  Resolved  →  Backfilled
```

Keep them independent. Severity colours the card in every column. If Staging replaced the severity
lane, a HARD task with grammar fixes would vanish out of the Hard lane and you'd lose the signal you
audit by.

A task enters **Staging** when it has at least one ledger entry or one `PROPOSED` fix. It leaves for
**Resolved** when nothing is left in `pending` (§5.5). On the reference batch the 20 grammar-only
tasks arrive in Staging with everything already applied — approve and move, not new work.

---

## 4. Ingest changes

1. `loadVerdicts` → return the whole row (§2.1).
2. Persist the row into `_studio.json` under a namespaced key, e.g. `audit: {…}`, kept separate from
   reviewer fields so re-upload can overwrite the audit block without touching claims or checklists.
3. Seed `fix_ledger.json` from `grammar_fixes.json` (§3.1).
4. Parse `remediation.md` fix blocks once and cache them to `<task>/fixes.json` — don't re-parse
   markdown on every request.
5. Extend `writeAuditSeed()` (`src/ingest.js:112`) to include `grammar_fixes.json` and the parsed fix
   list, so the copilot can see what was already corrected and doesn't re-flag it.
6. **Validate and surface problems.** Port `~/.claude/skills/acc-package/validate_fix_blocks.py`.
   Run it on drag-drop and show a per-task warning list. Four checks, in order of how badly they bite:
   - `verdict` outside `{PASS,SOFT,HARD}` → the task silently lands in UNSORTED today. This has bitten
     twice. Warn loudly.
   - a task dir with no verdict row → same problem.
   - a ` ```fix ` block that doesn't `JSON.parse`.
   - a `PROPOSED` fix whose `old` doesn't resolve at `path` in the live `rank.json`.

   For `APPLIED` fixes the assertion is inverted: `old` must resolve in **`rank.source.json`** and
   `new` must be present in **`rank.json`**. Getting this backwards will make every correctly-applied
   grammar fix look broken — I made exactly that mistake writing the validator.

---

## 5. Fix lifecycle

### 5.1 States

| Decision | Grammar (`status: APPLIED`) | Non-grammar (`status: PROPOSED`) |
|---|---|---|
| `pending` | n/a — arrives approved-by-eval, but still needs reviewer sign-off | not yet applied |
| `approved` | text stays as-is; ledger records sign-off | apply the edit, append to ledger |
| `denied` | **revert** the span from `rank.source.json` | do nothing; record the reason |

The asymmetry on `denied` is the easy thing to get wrong. Grammar edits are already in the file, so
denying one has to undo it, or the UI says "denied" while the change ships anyway. Drive the
behaviour off the block's `status` field, not off the button.

### 5.2 Apply algorithm

```
applyFix(taskId, fix):
  assert fix.status == 'PROPOSED'            # never re-apply an APPLIED grammar block
  assert fix.path != null                    # instruction-only fixes are not applicable
  live  = readJSON(rank.json)
  value = pointerGet(live, fix.path)
  if typeof value != 'string':               # scalar field (score, failure_mode)
      if String(value) != String(fix.old): return DRIFTED
      pointerSet(live, fix.path, coerce(fix.new, typeof value))
  else:
      n = countOccurrences(value, fix.old)
      if n == 0:  return DRIFTED             # already applied, or hand-edited
      if n > 1 and fix.occurrence == 1: return AMBIGUOUS
      pointerSet(live, fix.path, replaceNth(value, fix.old, fix.new, fix.occurrence))
  writeJSON(rank.json, live)
  ledgerAppend(taskId, {...fix, decision:'approved', decided_by:user, decided_at:now})
  revalidatePendingFixesOnPath(taskId, fix.path)   # see 5.4
```

Three things that are not optional:

- **`replaceNth`, never `replaceAll`.** A `replaceAll` on a short `old` will corrupt every other
  occurrence in the field. The `occurrence` field exists for this.
- **`DRIFTED` must refuse and show a diff**, not write. Zero matches means the state isn't what the
  fix was authored against. Blind-replacing there is how you get a mangled label.
- **`AMBIGUOUS` must refuse and route back to the eval** to widen `old`. Don't guess at which
  occurrence was meant.

### 5.3 Batch by field

If several fixes target the same `path`, apply them in **one transaction, longest `old` first**. Two
reasons: it's atomic (no half-applied field on a crash), and long-before-short avoids a short `old`
matching inside a longer span that a later fix was going to rewrite.

### 5.4 Re-anchoring — flag, don't automate

Applying fix #1 can move the text fix #2 was written against, so #2's `old` stops matching. After any
apply, re-check every still-pending fix on that path and mark the misses `NEEDS_REANCHOR` for a human.

**Do not implement automatic re-anchoring in the board.** The eval does it, at *word* level, and
getting it wrong is subtle: a character-level diff of `"stands out" → "stand out"` reduces to
"delete one `s`", which then rewrites every `s` in the string. That bug is real — I hit it building
the eval side. Blocks the eval already re-anchored carry `"reanchored": true`; for those, skip the
`old`-resolves-in-source assertion and only assert that `new` is present in `rank.json`.

### 5.5 Undo

```
revertFix(taskId, fixId):
  entry = ledgerFind(fixId); mark entry.reverted_at = now, entry.decision = 'denied'
  src   = readJSON(rank.source.json)
  live  = readJSON(rank.json)
  pointerSet(live, entry.path, pointerGet(src, entry.path))     # reset the whole field
  for e in ledgerEntriesForPath(entry.path) where not reverted:  # replay the survivors
      live = applyToValue(live, e)
  writeJSON(rank.json, live)
```

Field-level reset then replay. Don't try to invert a single string edit in place.

### 5.6 Merge with the existing checklist

Render fixes as checklist items so there's one mental model. Each item: rule (`R23`, `R16`, `R25`…),
severity class, owner, a `meaning-changing` marker where set, and the decision control. Suggested
affordances:

- **Bulk "approve all mechanical"** — but **exclude `meaning_changing: true`** from any bulk action.
  44 of the 127 edits in the reference batch were meaning-changing (`"mild transition"` →
  `"mid-transition"`, `"no correction to the task"` → `"no connection to the task"`). Those alter what
  the sentence asserts about a model and deserve an individual look.
- **Diff view** `rank.source.json` vs `rank.json`, per field.
- **Deny requires a reason.** It's a judgement being recorded, and it's what you'll want when a
  vendor disputes the audit.

---

## 6. Export — "Retrieve backfills"

### 6.1 Behaviour

`GET /api/backfill?layer=resolved` → JSON, computed **live** on every request from current board
state. No caching, no snapshot: you asked for something that reflects edits as you make them.

Filters: layer `Resolved`, approved, **non-SBQ** (§7 for where SBQ comes from).

### 6.2 Shape — reassemble, don't reverse-transform

Output is the upload shape: a **top-level list** of rows, each

```
{task_id, created_at, "rank.json": {...}, trajectories, snapshots,
 initial_snapshots, ranking_proof, validation_output, appsheetProjectId}
```

To build a row: **start from the original wire row and overwrite only the reviewer-editable fields
from the board's live `rank.json`.**

**`<task>/_source_row.json` now ships in the zip** — one per task, the original wire row verbatim.
Produced by `~/.claude/skills/acc/emit_source_rows.py` as a mandatory `/acc-package` step. It is
present for all 78 tasks in the reference batch; re-download that zip if yours predates 2026-08-10.

There is a **working reference implementation** of this whole export at
`~/.claude/skills/acc-package/build_backfill_export.py`. Port its logic rather than re-deriving it:
it does the whitelist overwrite, then asserts every non-whitelist leaf is byte-identical to a
pristine reload of `_source_row.json`. Run against the reference batch it reports
`78 tasks exported | 103 editable leaves updated | 0 whitelist violations`, and its output
round-trips cleanly back through `transform.py`.

Whitelist — the only fields copied from live `rank.json`:

```
/ranking_rationale
/preference_rating
/optional_clarification_comments
/optional_other_comments
/results/<key>/rank
/results/<key>/summary
/results/<key>/grading/<dim>/score
/results/<key>/grading/<dim>/rationale
/results/<key>/failure_modes/<mode>
```

Everything else — `created_at`, `appsheetProjectId`, `task`, `trajectory_file`,
`container_snapshot_file`, `trajectories`, `snapshots`, `ranking_proof`, `validation_output` — comes
from `_source_row.json` untouched.

**Why this way and not a reverse transform.** Per §2.5 the on-disk copy has a different `task` (object
vs URL), an extra `task_cds_url`, and relative paths where the wire format carries CDS URLs.
Exporting the on-disk `rank.json` directly would hand platform relative filesystem paths and an
inlined task blob. Reconstructing the URLs is possible but pointless: the original row already has
them correct, and a whitelist copy is auditable in a way a reverse transform never is. It also
enforces the same invariant the eval enforces on its own grammar pass — *nothing outside the intended
fields changes* — which is exactly the property you want in something that writes to platform.

`results` keys vary by batch (`model_1`/`model_2` in older exports, codenames in newer). Iterate the
keys present in `_source_row.json`; don't hardcode.

### 6.3 Guards

- **Refuse (or loudly warn) on a Resolved task with any fix still `pending`.** Otherwise you backfill
  a half-remediated record. With approve/deny in place this is well-defined: denied is a decision,
  pending is an omission.
- Include a manifest: batch tag, generated_at, task count, and the tasks excluded with reasons
  (`sbq`, `pending_fixes`, `not_resolved`). You'll want that when a count doesn't match.
- Re-run the whitelist assertion before emitting: for each task, every field *outside* the whitelist
  must be byte-identical between `_source_row.json` and the emitted row. Cheap, and it catches a
  pointer bug before platform does.

---

## 7. Redash reconciliation

### 7.1 Layer tag on every card

You already run a per-task pipeline query on task entry. Batch it: one query for every `task_id` in
the workspace, cached with a TTL plus a manual refresh, surfaced as a tag on the card. That gives
every task a **Redash-observed layer** alongside its board layer, and makes SBQ a fact rather than an
assumption.

Per-task-on-entry won't scale to a lane-wide tag at 78 tasks; batch or it'll feel broken.

### 7.2 The four quadrants

For each Resolved task, compare Redash SBQ status against L12 membership:

| | Redash: SBQ | Redash: non-SBQ |
|---|---|---|
| **In L12** | ✗ must be pulled out of L12 | ✓ correct |
| **Not in L12** | ✓ correct | ✗ backfill missing |

### 7.3 Three outcomes, not two

Redash is a warehouse and it lags. A task backfilled minutes ago will legitimately not be in L12 yet.
So report `MATCH` / `MISMATCH` / `PENDING`, where `PENDING` means "inside the propagation window,
too early to judge." A two-state check will cry wolf on every fresh backfill and you'll stop trusting
it. **The window length is an open question — see §10.**

### 7.4 Authority on disagreement

- **Pipeline layer:** Redash wins outright. It's the system of record for where a task actually sits.
- **SBQ:** Redash wins, but *visibly*. If the board marks SBQ and Redash hasn't caught up, show
  `board-marked, awaiting confirmation` rather than silently overriding in either direction. A silent
  override is how a task that shouldn't be backfilled gets backfilled.
- **Audit verdict and fix decisions:** the board wins. Redash has no opinion on these.

### 7.5 The recurring check

After each backfill, the reconciliation over the Resolved column — every non-SBQ Resolved task present
in L12, every SBQ task absent — is a scripted check, not a judgement call. I'll version it on the eval
side so it's repeatable and emits the quadrant table plus an exception list. If you expose the L12
membership + SBQ status as a small read endpoint, I can call that instead of re-deriving the query.

---

## 8. Backfill match verification

A button on the Staging/Resolved view: **did what I exported actually land?**

Compare the board's live `rank.json` against the tasking data Redash returns, **only on the §6.2
whitelist fields**. Comparing everything drowns you in noise from rotating CDS URLs and formatting
drift.

Two things or it cries wolf:

- **Normalize both sides before comparing.** Trim and collapse whitespace, NFC-normalize unicode, and
  compare numbers numerically not as strings. We shipped genuine U+2011 non-breaking hyphens in
  `6a6fb1bad8e0bb802adbabfe`'s `ranking_rationale` this batch; a naive `===` flags that as a mismatch
  when the text is correct.
- **Report per field.** "Task didn't match" is useless. "`results.model_2.summary` didn't land" is
  actionable.

Outcomes: `MATCH` / `MISMATCH` (with the differing fields and both values) / `NOT_FOUND` (task absent
from Redash — lag, not failure). Gate "move to Backfilled" on all-MATCH.

---

## 9. Acceptance checklist

Ingest
- [ ] `loadVerdicts` returns full rows; `bucketFor` reads `row.verdict`; `tags` reach the UI.
- [ ] A verdict value outside `{PASS,SOFT,HARD}` produces a visible warning, not a silent UNSORTED.
- [ ] A task dir with no verdict row produces a visible warning.
- [ ] `fix_ledger.json` is seeded from `grammar_fixes.json`, `decision: approved`, `decided_by: acc-eval`.
- [ ] Fix blocks are parsed and cached; `APPLIED` blocks validate against `rank.source.json` for `old`
      and `rank.json` for `new`; `reanchored: true` blocks skip the `old` assertion.
- [ ] Reference batch ingests with **0 UNSORTED** and 47 tasks tagged `grammar-fixed`.

Fixes
- [ ] Applying a `PROPOSED` fix with 0 matches returns `DRIFTED` and writes nothing.
- [ ] Applying one with >1 match and `occurrence: 1` returns `AMBIGUOUS` and writes nothing.
- [ ] `replaceNth` verified against a field where `old` occurs twice.
- [ ] Scalar swap works (`failure_modes.*`, `grading.*.score`) with type preserved — a score stays a
      number, not `"2"`.
- [ ] Denying an `APPLIED` grammar fix reverts that span; `rank.json` matches `rank.source.json` for it.
- [ ] Denying a `PROPOSED` fix changes no text and records a reason.
- [ ] Undo → replay lands byte-identical to applying the surviving fixes from source.
- [ ] Multiple fixes on one path apply atomically, longest `old` first.
- [ ] Pending fixes on a path are re-validated after an apply; misses marked `NEEDS_REANCHOR`.
- [ ] `path: null` blocks render but are not applicable.
- [ ] Bulk approve excludes `meaning_changing: true`.

Layers
- [ ] Severity and layer are independent; a HARD task with fixes shows in Staging *and* reads HARD.
- [ ] Staging entry = ≥1 ledger entry or ≥1 `PROPOSED` fix. Exit = nothing `pending`.
- [ ] Re-upload of changed content reopens and marks prior ledger entries `superseded_at`.

Export
- [ ] Output parses as the wire shape and round-trips through `transform.py` without error.
- [ ] For every exported task, all non-whitelist fields are byte-identical to `_source_row.json`.
- [ ] A field edited on the board appears changed in the export; nothing else does.
- [ ] `task` is a URL string, `trajectory_file`/`container_snapshot_file` are CDS URLs, no
      `task_cds_url` key.
- [ ] SBQ tasks excluded; a Resolved task with pending fixes is excluded or flagged.
- [ ] Manifest lists exclusions with reasons.
- [ ] Works for both `model_1`/`model_2` and codename-keyed `results`.

Redash
- [ ] Layer tag is batched, cached, manually refreshable.
- [ ] Quadrant report produced for the Resolved column.
- [ ] `PENDING` distinguished from `MISMATCH` by the freshness window.
- [ ] Board-marked-SBQ-without-Redash shows as awaiting confirmation, not as truth.
- [ ] Match check normalizes whitespace/unicode/numbers and reports per field.
- [ ] "Move to Backfilled" gated on all-MATCH.

---

## 10. Open — I need these from Pavit

1. **Redash propagation lag.** What's the realistic window between a backfill and the task appearing
   in L12? That number is the `PENDING` threshold in §7.3 and §8. Without it the check either cries
   wolf or hides real gaps.
2. **Does "approved" mean the same thing as "in Resolved"?** If they're distinct states, the export
   filter needs both and I need to know where approval is recorded.

Lower-stakes, answer when convenient:

3. Should denying a grammar fix require a reason, or is silent revert fine?
4. Does the export need pagination? 78 full `rank.json` objects is a large response but fine; if
   batches grow past a few hundred, streaming or paging becomes worth it.
5. ~~Should `_source_row.json` ship in the zip?~~ **Resolved 2026-08-10: it ships.** Emitted for
   every task by `emit_source_rows.py`, now a mandatory `/acc-package` step, and verified end-to-end
   by `build_backfill_export.py` (0 whitelist violations on the reference batch). Nothing for you to
   do here — just re-pull the zip if yours is older than 2026-08-10.

---

## 11. Appendix — the eval side, for reference

Versioned in `~/.claude/skills/acc/` and `~/.claude/skills/acc-package/`; all take the delivery dir as
`argv[1]`.

| Tool | Produces |
|---|---|
| `transform.py` | wire JSON → task dirs (`rank.json` paths rewritten to relative) |
| `embed_task_defs.py` | inlines the CDS task def into `rank.json.task`, preserves `task_cds_url` |
| `grammar_inline_build.py` | `_audit/grammar_fixes_all.json` — directives, validated against `rank.source.json` |
| `grammar_inline_apply.py` | `rank.source.json` + fixed `rank.json` + `<task>/grammar_fixes.json`; fails on any change outside a flagged field |
| `grammar_inline_render.py` | `_audit/grammar_blocks.json` — the ready-to-paste `fix` blocks |
| `compute_verdicts.py` | `_audit/final_verdicts.json` with verdicts + tags |
| `acc-package/dedup_batch.py` | delta batching against `~/acc_audit_tools/upload_ledger.json` |
| `emit_source_rows.py` | `<task>/_source_row.json` — the original wire row, base for the export |
| `acc-package/build_backfill_export.py` | reference implementation of §6, with the whitelist assertion |
| `acc-package/validate_fix_blocks.py` | the gate to port in §4.6 |

Two invariants the eval guarantees, which you can rely on:

1. **`rank.json` differs from `rank.source.json` only inside fields named in `grammar_fixes.json`.**
   Enforced by a whole-document diff that fails the run otherwise.
2. **The chain is idempotent.** Re-running build→apply produces a byte-identical `rank.json`, because
   the builder always reads `rank.source.json` when it exists. (It didn't originally; a second run
   collapsed 128 directives to 3 and unwound the fixes. Guarded now — worth knowing because the same
   trap exists in the board if you ever recompute fixes from the live file.)
