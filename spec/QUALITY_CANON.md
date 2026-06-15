# ACC Quality Canon (distilled)

Authoritative rubric: **V5** (25 dimensions, keys R1–R25, scores 2=Fail / 3=Non-Fail / 5=Pass).
Full texts via the read_spec tool: `v5_rubric` (authoritative), `nwr_checklist` (29 ONL-* check
codes + customer report format), `gap_analysis` (canonical fabrication/fairness evidence),
`qc_rubric_v2_legacy` (superseded prose rubric — richer auditor notes, use for background only).
ALWAYS cite the deciding dimension as a spec:// link, e.g. [R12 Summaries · Accuracy](spec://R12)
— the UI turns it into a button that opens that rubric row.

## V5 dimensions — fail bars (score 2) in brief

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
- R12 Summaries · Accuracy: specific technical claim contradicted by or absent from trajectory
  = Fail (2/5 mainly; mislabeled secondary detail of a REAL event, not affecting rank/score = 3;
  fabricated events and cross-model misattribution remain Fail).
- R13 Comparative Rationale · Reasoning: doesn't explain how the ordering was reached = Fail.
- R14 Comparative Rationale · Evidence: major ungrounded claims = Fail.

**Global Scores** (1-3 ints; the V5 bar is about score-vs-evidence DELTA)
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
- R23 Spelling/Grammar major: 4+ minor errors across all CB-authored content = Fail (3 or fewer = 3).
  Does NOT apply to prompts sent in agent interactions.
- R24 Spelling egregious: 2+ egregious errors = Fail; 1 = 3.
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
  (R1-R3, R5-R6, R12, R21-R22, R25), stub/placeholder trajectories, and packaging defects = HARD
  (ship-blocking). Defensible-but-flawed rationale/score issues (score-3 bands, 1-point deltas)
  = SOFT. Annotator idle time and missing task definition = INFORMATIONAL ONLY (customer policy
  2026-06-09) — never findings.
- Greeting-stub trajectory ("hello" / "Hello! How can I help you today?") = packaging/export
  defect (vendor), NOT annotator forfeit — distinguish via the first user turn.
- Byte-identical resubmission of a previously-failed task = failure-to-remediate → escalate.
- Always use complete 24-char task and annotator IDs.
