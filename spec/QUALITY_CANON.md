# ACC Quality Canon (distilled)

Authoritative rubric: **V11** ("Reviewability & Spelling/grammar", `spec/V11_RUBRIC.csv`, full text via
the read_spec tool as `v11_rubric`; 25 dimensions, scores 2=Fail / 3–4=Non-Fail / 5=Pass). V11 keeps V5's 25 dimensions but re-groups and
renames them under UUID keys; we keep the `R1–R25` shorthand as a **stable 1:1 alias** for tooling and
cross-refs (mapping below). Superseded: V5 was authoritative through 2026-07-22.
Full texts via the read_spec tool: `nwr_checklist` (29 ONL-* check codes + customer report format),
`gap_analysis` (canonical fabrication/fairness evidence), `qc_rubric_v2_legacy` (background only).
ALWAYS cite the deciding dimension as a spec:// link, e.g. [R12 Summaries · Accuracy](spec://R12)
— the UI turns it into a button that opens that rubric row.

## Two substantive V11 changes vs V5 (the rest is renaming)
1. **Spelling/Grammar is a COUNT, not flag-any** (R23 `3110cdd1` / R24 `55409b26`). Errors accumulate
   across ALL CB-authored content of the task; the per-task total bands it: 0=Pass(5) · exactly 1=Non-Fail(4)
   · 2-3=Non-Fail(3) · **4+ minor=Fail(2)**; egregious: 1=Non-Fail · **2+=Fail(2)**. Does NOT apply to
   agent-interaction prompts. ⇒ writing CAN now be HARD (4+ minor or 2+ egregious).
2. **Reviewability framing** (R5 `e12d2366` / R6 `cb76debd`, "07/17 note"). An error fails only if it
   actually degrades what a reviewer/eval can assess from the trajectory/code: misordered-but-still-runnable
   (tests after impl, but they run) = order slip, NOT a fail; skipped/never-shown tests or a **truncated
   trajectory (cause irrelevant)** = Fail; tooling/VCS side-effect (per-item commits collapsed) with a
   reviewable trajectory = Non-Fail(3).
Several dims also gained a milder **score-4** "single minor slip" band: R12 `22381c23` (one mislabeled
secondary detail), R13 `c00b4776` (specific except one generic phrase), R14 `1d371aa1` (one point supported
indirectly), R21 `bba5f40e` (one trivial secondary inaccuracy) — all ranking+score unaffected.

## R↔V11 UUID map
R1 `77b72767` · R2 `8082d27e` · R3 `a7a4d514` · R4 `c07cb3a9` · R5 `e12d2366` · R6 `cb76debd` ·
R7 `9f525f2b` · R8 `ef360318` · R9 `19553e65` · R10 `06eebc56` · R11 `825c9d53` · R12 `22381c23` ·
R13 `c00b4776` · R14 `1d371aa1` · R15 `a4f7a644` · R16 `d9cf7bfe` · R17 `e46eba67` · R18 `a80e4f96` ·
R19 `ac9c7ffb` · R20 `71724579` · R21 `bba5f40e` · R22 `7bfd66e4` · R23 `3110cdd1` · R24 `55409b26` ·
R25 `689423cd`

## V11 dimensions — fail bars (score 2) in brief

**Submission Integrity**
- R1 Core Evidence: core evidence missing/corrupted/unreviewable (rank.json, both trajectories, ranking_proof).
- R2 Consistency (A/B fairness): materially different information to the models at equivalent
  milestones = Fail. A model proactively addressing something is NOT an advantage for the other.
  Minor re-wording at matching milestones = 3.
- R3 Prompt Matching: initial prompts of both models must be a PERFECT string match (2/5 only — any mismatch = Fail).
- R4 Scope/Feasibility: task impossible with provided setup = Fail.

**Trajectory Review**
- R5 Milestone Verification: milestone skipped/misordered/completed incorrectly in a way that
  materially invalidates outcome/ranking/reviewability, or prompting toward a later milestone
  before the previous one completes = Fail. Indirect verification or subtle tooling/VCS side
  effect with reviewable trajectory = 3.
- R6 Trajectory Completeness: missing/truncated/ends before claimed completion = Fail.
  Provider-side encrypted reasoning blobs do NOT count against completeness.
- R7 Natural Prompting: robotic/formulaic/canned interaction = Fail; 1-2 templated follow-ups = 3.
- R8 Guidance: annotator does not meaningfully guide toward milestones = Fail (2/5 only).

**Ranking & Rationale**
- R9 Subjective Ranking: ordering not defensible against rationale + trajectories = Fail ("vibe check, not a formula").
- R10 Summaries · Specificity: vague/templated summary = Fail.
- R11 Summaries · Completeness: required summary field absent/useless = Fail.
- R12 Summaries · Accuracy (`22381c23`): specific technical claim contradicted by or absent from
  trajectory = Fail(2). V11 bands for mislabeled secondary details of REAL events (type/timing/
  milestone-index, rank+score unaffected): a SINGLE such detail = Non-Fail(4), MULTIPLE = Non-Fail(3).
  Fabricated events and cross-model misattribution remain Fail(2) regardless.
- R13 Comparative Rationale · Reasoning: doesn't explain how the ordering was reached = Fail.
- R14 Comparative Rationale · Evidence: major ungrounded claims = Fail.

**Global Scores** (1-3 ints; the bar is about score-vs-evidence DELTA)
- R15 Correctness: score off by 2+ points vs final end state = Fail; off by 1 point = 3.
  Final-state only; same-turn self-fixed bugs are not correctness defects.
- R16 Agent Behavior: same delta rule vs observed planning/tool use.
- R17 Code Style · Rating: same delta rule vs visible final-code quality.
- R18 Code Style · Improperly Completed: scored when the task doesn't justify scoring = Fail.
- R19 Code Style · Improperly Omitted: skipped without reasonable justification = Fail.
- R20 Communication: same delta rule vs clarity/usefulness of agent communication.

**Justification / Content Integrity**
- R21 Justification Claims · Accuracy: any PRIMARY claim (directly supports the assigned score)
  inaccurate, or secondary inaccuracies material enough to change the score = Fail; only
  secondary/illustrative claims wrong (score unchanged) = 3.
- R22 Milestone JSON Leakage: raw milestone fully leaked in a user turn = Fail; small portion
  (e.g. "M2: Add a --report flag…") = 3; none = 5.
- R23 Spelling/Grammar major (`3110cdd1`): errors ACCUMULATE across all CB-authored content;
  0 = Pass(5) · exactly 1 = Non-Fail(4) · 2-3 = Non-Fail(3) · 4+ = Fail(2). Does NOT apply to
  prompts sent in agent interactions. (⇒ 4+ = HARD in /acc.)
- R24 Spelling egregious (`55409b26`, not required): 2+ egregious = Fail(2); 1 = Non-Fail(3).
  (⇒ 2+ egregious = HARD in /acc.)
- R25 Cheating: clear, concrete evidence of unsanctioned LLM usage (hallucinated /
  trajectory-contradicted content, copy-paste leakage, unauthored scaffolding) = Fail.
  Style alone (polish, parallel structure, pleasantries) is NOT cheating when content is
  specific and trajectory-grounded.

## NWR check codes (customer batch report; RED = batch FAIL)
- RED: ONL-GEN-01/02/03 (rank.json present/parseable/schema), 05 (both trajectories), 06 (no
  rank ties), 09 (no duplicate instance ids), 12 (ranking_proof complete); ONL-TR-01/02;
  ONL-GC-01/02 (all dims scored, range 1-3); ONL-AM-01; ONL-VAL-01 (stale validation).
- YELLOW: ONL-GEN-04/07/08/10/11/13/15; ONL-TR-03 (truncation), 04 (<2 turns), 05 (no tool
  calls in coding task), 06 (reasoning asymmetry); ONL-GC-03 (N/A unjustified), 04 (loser
  strictly higher on 3+ dims), 05 (rationale <100 words/generic), 06 (missing justifications),
  07 (uniform scores; >30% of batch = pattern concern).
- ONL-AB-01 (asymmetric prompting) YELLOW/RED — blocked (don't fire) when trajectories absent.
- Don't double-count downstream consequences; Alpha/Beta naming is fine.

## House verification discipline (internal, supplements the spec)
- Every specific number/quote in rank.json is a falsifiable claim — search the trajectory before
  calling it accurate or fabricated. For quoted prompts, search distinctive n-grams, then
  enumerate ALL user turns before declaring absence. For absence claims ("never X"), a search
  HIT refutes the claim.
- Severity mapping: R-dimension score-2 conditions on the claim/fairness/integrity layers
  (R1-R3, R5-R6, R12, R21-R22, R25), **R23 4+/R24 2+ egregious spelling (V11: writing CAN be HARD)**,
  stub/placeholder trajectories, and packaging defects = HARD (ship-blocking). Defensible-but-flawed
  rationale/score issues (score-3 AND V11 score-4 bands, 1-point deltas, 1-3 spelling errors) = SOFT.
  Annotator idle time and missing task definition = INFORMATIONAL ONLY (customer policy 2026-06-09) —
  never findings.
- Greeting-stub trajectory ("hello" / "Hello! How can I help you today?") = packaging/export
  defect (vendor), NOT annotator forfeit — distinguish via the first user turn.
- Byte-identical resubmission of a previously-failed task = failure-to-remediate → escalate.
- Always use complete 24-char task and annotator IDs.
