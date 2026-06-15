# ACC Online QC Rubric — Updated Dimension Definitions

**Version**: v2 (revised 2026-05-07)
**Basis**: QC <> MLDG Rubric Generator v1117 + ACC delivery eval findings
**Changes from v1**: Milestone Design removed; Prompt Alignment and Code Style revisions applied; 5 new sub-dimensions added (marked NEW)

---

## How to Read This Document

Each sub-dimension has:

- **Notes for Auditors** — context and guidance on how to apply the dimension
- **1-2 (Fail)** — conditions that warrant a failing score
- **3-4 (Non-Fail)** — issues present but not severe enough to fail
- **5 (Pass)** — the standard the task should meet

Task Type is "All" for every dimension unless otherwise noted.

---

## 1. Submission Integrity

### 1.1 Task Reviewability / Core Evidence

**Order**: 1

**Notes for Auditors**: Use this dimension to decide whether the task can be meaningfully reviewed based on the submission itself. Focus on whether the task contains the minimum evidence needed to evaluate trajectories, rankings, and scores.

A complete submission must include: rank.json (valid, parseable), both trajectory files (trajectory_model_a.json, trajectory_model_b.json), and ranking proof files (a_proof.png, b_proof.png, a_proof_justification.txt). If validation_output.txt is present but references files that are missing from the delivery, the validation is stale and should not be trusted.

**1-2 (Fail)**:

- **[Fail - Missing Core Evidence]** Core task evidence is missing, corrupted, or too incomplete to determine whether the task was performed correctly. This includes: missing or unparseable rank.json, missing trajectory files for either model, or missing ranking proof directory.
- **[Fail - Platform Failure With No Reviewable Evidence]** A setup or platform issue prevented task completion and there is not enough evidence to judge the annotator's work.

**3-4 (Non-Fail)**:

- **[Non-Fail - Minor Evidence Gaps]** Minor pieces of context are missing (e.g., one non-critical note, missing source_task directory, missing snapshots) but trajectories, rankings, and scores can still be reviewed end-to-end.

**5 (Pass)**: The task is fully reviewable and contains the required context, trajectories, and evidence needed for a confident QC decision.

---

### 1.2 Task Scope / Feasibility

**Order**: 1

**Notes for Auditors**: A passing task should be coherent, realistically scoped, and feasible to complete through the Mailbox Ring workflow.

**1-2 (Fail)**:

- **[Fail - Impossible Task]** The task cannot be completed with the provided setup, instructions, or environment.
- **[Fail - Trivial Task]** The task is so underspecified or easy that it does not support meaningful milestone-based interaction.

**3-4 (Non-Fail)**:

- Scope is slightly too narrow or too broad but the task still supports a realistic milestone-based session.
- Some instructions are ambiguous but a reasonable annotator can still guide the agent through the intended flow.

**5 (Pass)**: The task is appropriately scoped, feasible, and suitable for milestone-based agent interaction.

---

## 2. Task Setup

### 2.1 Prompt and Task Intent Alignment

**Order**: 1

**Notes for Auditors**: Review the initial prompt, task instructions, and any persona or edits made before tasking. The task should clearly communicate the intended problem without giving away the solution.

Setup adherence should be judged from available evidence only. Do not fail a task for missing UI-only details that are not observable in the exported records; however, visible contradictions to the guidelines should be flagged.

Note: The initial prompt as well as the prompts for each milestone must be copied verbatim from TASK.md and status.md files — minor variation is okay. This dimension is used to grade the follow-up prompts that contributors provide on their own.

**1-2 (Fail)**:

- **[Fail - Misaligned Task Intent]** The task prompt, instructions, or persona push the annotator toward the wrong objective.
- **[Fail - Overconstrained Prompt]** The task gives away too much of the solution and leaves little room for agent reasoning.

**3-4 (Non-Fail)**:

- The prompt is mostly aligned with the intended objective but has grammar issues, mild boilerplate copied verbatim, or an edit to user persona that slightly dilutes naturalness.
- The prompt hints at part of the solution but still leaves meaningful room for agent reasoning.

**5 (Pass)**: The prompt and instructions are aligned, realistic, humanized where appropriate, and suitable for natural interaction.

---

~~### 2.2 Milestone Design~~ **REMOVED**

*Removed from rubric. Milestone design is a task-generation problem, not an annotator/contributor issue. Milestone quality should be caught during task generation QC, not delivery QC.*

---

## 3. Trajectory Review

### 3.1 Milestone Achievement Verification

**Order**: 1

**Notes for Auditors**: The annotator should only move to the next milestone after verifying that the current milestone was actually met. Do not rely on green markers, validator summaries, or completion text alone — the milestone completions must be supported by the trajectories.

**1-2 (Fail)**:

- **[Fail - Unverified Milestone Completion]** The annotator advanced without evidence that the milestone was actually satisfied.
- **[Fail - Incorrect Milestone Pass]** A milestone is treated as completed even though the trajectory contradicts that status.

**3-4 (Non-Fail)**:

- Verification evidence exists but is indirect (e.g., agent output implies completion without explicit confirmation).
- Annotator advanced confidently but could have done one extra check (test run, output inspection) to make verification airtight.

**5 (Pass)**: Each claimed milestone is clearly supported by the observed interaction, outputs, or code state.

---

### 3.2 Trajectory Completeness

**Order**: 1

**Notes for Auditors**: A complete trajectory should include enough interaction to understand how the annotator worked through the task and reached completion.

**1-2 (Fail)**:

- **[Fail - Incomplete Trajectory]** A required trajectory is missing, truncated, or clearly ends before the claimed completion state.
- **[Fail - Missing Required Turn Context]** The trajectory lacks enough turns or content to verify what happened.

**3-4 (Non-Fail)**:

- The trajectory is complete but slightly thin in one section (e.g., a milestone resolved in a single terse turn) while the overall flow remains interpretable.
- A tool output is summarized rather than fully shown, but the outcome is still clear.

**5 (Pass)**: The trajectory is complete, interpretable, and sufficient for end-to-end review.

---

### 3.3 Prompting and Interaction Discipline

**Order**: 2

**Notes for Auditors**: Mailbox Ring expects natural prompting. Annotators may use suggested prompts as inspiration, but should not over-index on them or reduce the interaction to a script.

**1-2 (Fail)**:

- **[Fail - Scripted / Artificial Interaction]** The interaction is clearly robotic, formulaic, or over-dependent on canned prompts and the auditor fails to flag it.
- **[Fail - No Real Guidance]** The annotator does not meaningfully guide the agent toward milestones, yet the task is treated as acceptable.

**3-4 (Non-Fail)**:

- One or two follow-ups sound slightly templated, but the overall session still reads as natural and purposeful.
- Persona use is inconsistent in a minor way but does not break immersion or guidance quality.

**5 (Pass)**: The interaction feels natural, purposeful, and consistent with the project's goal of capturing real coder preferences.

---

### 3.4 A/B Comparison Fairness — NEW

**Order**: 2

**Notes for Auditors**: In an A/B pairwise comparison, the annotator conducts two parallel sessions. At any point where both models have reached the same milestone with the same background knowledge, the annotator must provide equivalent guidance. This dimension does NOT require identical trajectories — different turn counts, different bugs, and different reactive corrections are all expected. It only flags cases where the annotator gives one model an information advantage at a step where both models are in the same state.

Before flagging, verify that the models were truly at the same milestone with the same knowledge. If Model A is stuck on a permissions error while Model B has already found the root cause, different prompts are appropriate — that is reactive guidance, not unfair treatment.

Common patterns that indicate unfair treatment:
- One model is told exactly what to check (e.g., "verify threshold=6 and add --aggregate") while the other gets a generic prompt ("verify all requirements") at the same milestone
- One model is given an explicit file path or function name that neither model has discovered yet
- One model receives leaked pipeline metadata (continuation_criteria, acceptance rubrics, fallback instructions) that the other does not see

**1-2 (Fail)**:

- **[Fail - Information Asymmetry at Matching Milestone]** At a point where both models have the same background knowledge and have reached the same milestone, the annotator gives one model materially more specific guidance — exact values, file paths, implementation hints, or internal metadata — that the other model must discover independently.
- **[Fail - Leaked Pipeline Metadata]** One model's prompt contains internal system metadata (continuation_criteria, grading rubrics, correction budgets) that the other model does not receive.

**3-4 (Non-Fail)**:

- Minor framing differences at matching milestones (e.g., one prompt is slightly more direct) that do not confer a meaningful information advantage.
- Turn count differences that result from one model needing more back-and-forth to reach the same state.

**5 (Pass)**: At every matching milestone, both models receive equivalent guidance. All prompt divergences are reactive to different model states.

---

## 4. Ranking & Rationale

### 4.1 Subjective Ranking Quality

**Order**: 2

**Notes for Auditors**: The ranking should reflect the annotator's actual preference between trajectories. It is a vibe check, not a formula.

**1-2 (Fail)**:

- **[Fail - Ranking Contradicts Evidence]** The final ordering is not defensible given the rationale and observed trajectories.

**3-4 (Non-Fail)**:

- The ranking is plausible overall but the gap between two adjacent trajectories feels under-justified.
- The ordering reads slightly too aligned with the global scores rather than as a genuine preference call, yet is still defensible.

**5 (Pass)**: The ranking clearly reflects subjective preference and is plausible given the trajectories.

---

### 4.2 Trajectory Summaries

**Order**: 2

**Notes for Auditors**: The per-trajectory summaries should be opinionated and specific, not neutral placeholders. Every factual claim in a summary must be traceable to something that actually happened in the trajectory. If a summary says a model did or did not do something, verify it.

**1-2 (Fail)**:

- **[Fail - Generic Summary]** One or more trajectory summaries are vague, templated, or provide no concrete commentary.
- **[Fail - Missing Summary Content]** A required summary field is absent or too incomplete to be useful.
- **[Fail - Fabricated or False Claim]** A summary contains a specific technical claim — an event, output, behavior, or code state — that is contradicted by or absent from the trajectory evidence. Examples: claiming a model created a file it never wrote, claiming a feature "never materialized" when the trajectory shows it was implemented and tested, or describing a technical root cause that does not appear anywhere in the trajectory. *(NEW)*

**3-4 (Non-Fail)**:

- Summaries are opinionated but include a bit of neutral recap.
- One summary is slightly shallower than the others but still references concrete model behavior.

**5 (Pass)**: Each summary is opinionated, concrete, and tied to the observed model behavior. All factual claims are verifiable against the trajectories.

---

### 4.3 Final Comparative Rationale

**Order**: 3

**Notes for Auditors**: The final field should explain how the annotator weighed the important criteria and reached the ordering.

**1-2 (Fail)**:

- **[Fail - No Comparative Reasoning]** The rationale does not explain how the final ranking was reached.
- **[Fail - Unsupported Comparative Claim]** The rationale makes major claims that are not grounded in the observed trajectories.

**3-4 (Non-Fail)**:

- The rationale explains the ordering but leans on one or two generic phrases instead of specific trajectory evidence.
- One comparison point is supported indirectly rather than with a concrete example.

**5 (Pass)**: The rationale clearly shows how the annotator compared the trajectories and why the final ordering makes sense.

---

### 4.4 Internal Consistency — NEW

**Order**: 3

**Notes for Auditors**: The ranking rationale, per-trajectory summaries, and per-dimension score justifications are all written by the same annotator about the same task. They must tell a coherent, non-contradictory story. If the ranking rationale praises a model for catching and fixing a bug, the Correctness justification for that model should not cite the same bug as an unfixed defect.

Cross-check these fields against each other:
- ranking_rationale vs. per-trajectory summaries
- ranking_rationale vs. per-dimension score justifications
- Per-trajectory summaries vs. per-dimension score justifications

**1-2 (Fail)**:

- **[Fail - Internal Contradiction]** A factual claim in one field directly contradicts a factual claim in another field within the same submission. Example: the ranking rationale says "Model A caught its own bug mid-turn and fixed it cleanly" while the Correctness justification says "the bug remains hard-coded in the final code."
- **[Fail - Inconsistent Scoring Narrative]** The overall narrative across fields is incoherent — e.g., summaries describe Model A as clearly stronger, but scores favor Model B with no explanation for the discrepancy.

**3-4 (Non-Fail)**:

- Fields are consistent on facts but differ slightly in emphasis or framing (e.g., the ranking rationale focuses on correctness while a summary emphasizes communication style).
- A minor detail is described differently across fields but does not change the conclusion.

**5 (Pass)**: All fields tell a coherent, non-contradictory story. Factual claims are consistent across the ranking rationale, summaries, and score justifications.

---

## 5. Global Scores

### 5.1 Correctness Score

**Order**: 3

**Notes for Auditors**: Correctness is primarily concerned with the final solution or end state; however, the annotator should also consider the intermediate path for any obvious errors.

Bugs that a model caught and fixed within the same turn are not Correctness defects — they demonstrate strong self-correction and should be credited under Agent Behavior. Only bugs present in the final code state count against Correctness. Before accepting a rationale that cites a specific bug, verify whether the bug exists in the model's final output or was already resolved.

**1-2 (Fail)**:

- **[Fail - Incorrect Correctness Score]** The assigned score does not match the final code, output, or verified end state.
- **[Fail - End-State Evidence Ignored]** Clear evidence about whether the final solution works is present, but the score ignores it.
- **[Fail - Self-Fixed Bug Penalized]** The score penalizes a model for a bug it identified and corrected within the same turn, treating a resolved issue as a final-state defect. *(NEW)*

**3-4 (Non-Fail)**:

- The score is in the right range but does not fully reflect a minor edge case the solution handled or missed.
- A small end-state nuance is under-weighted but the overall score direction is defensible.

**5 (Pass)**: The score accurately reflects the final solution's correctness.

---

### 5.2 Agent Behavior Score

**Order**: 3

**Notes for Auditors**: Consider decision-making, planning, tool usage, exploration, and instruction following throughout the trajectory.

**1-2 (Fail)**:

- **[Fail - Incorrect Agent Behavior Score]** The score does not match the observed planning, execution, or tool-use behavior.
- **[Fail - Trajectory Behavior Ignored]** The score is based only on the final answer and ignores poor or strong intermediate behavior.

**3-4 (Non-Fail)**:

- The score captures the overall behavior but slightly under- or over-weights a specific planning or tool-use moment.
- A strong/weak intermediate moment is acknowledged in the rationale but only partially reflected in the score.

**5 (Pass)**: The score accurately captures how the agent behaved during the interaction.

---

### 5.3 Communication Score

**Order**: 3 (no order specified in original)

**Notes for Auditors**: Consider clarity, summaries, responsiveness, and whether the agent communicated effectively with the annotator.

**1-2 (Fail)**:

- **[Fail - Incorrect Communications Score]** The score does not match the clarity or usefulness of the agent's communication.
- **[Fail - Missing Communication Evidence]** Obvious communication strengths or failures are not reflected in the score.

**3-4 (Non-Fail)**:

- The score captures overall communication quality but under-weights one moment of unclear messaging or a particularly strong summary.
- A minor responsiveness issue is noted in the rationale but not fully reflected in the numeric score.

**5 (Pass)**: The score accurately reflects the quality and effectiveness of the agent's communication.

---

### 5.4 (Optional) Code Style Score

**Order**: 3 (no order specified in original)

**Notes for Auditors**: If the task does not require code, it can be skipped. If assessing the code would take more than ~10 minutes, skim through some of the files to assess the model's general style. If one or more agents unnecessarily produce huge amounts of code, you may flag verbosity without reviewing every line. The ranking value is optional, but there must be a rationale that justifies why it was not ranked.

**1-2 (Fail)**:

- **[Fail - Incorrect Code Style Score]** The code style score does not fit the visible quality of the final output.
- **[Fail - Improper Mandatory Style Review]** The reviewer treats Code Style as required even when the task does not justify scoring it.
- **[Fail - Unjustified Style Critique]** The style judgment is asserted without enough support from the final code.
- **[Fail - Missing Code Style Justification]** The contributor did not provide a reasonable justification for why the ranking was not completed.

**3-4 (Non-Fail)**:

- The score is defensible but could be justified with more specific code references.
- The decision to score vs. skip is reasonable but borderline for the type of task.
- Given the weight of evidence in the trajectory, the justification for skipping the ranking is weak.

**5 (Pass)**: The reviewer handles this dimension correctly: either scores it well with clear justification or skips it for the right reason.

---

### 5.5 Dimension Score Integrity — NEW

**Order**: 3

**Notes for Auditors**: Each dimension score must be justified by criteria that belong to that dimension. When an annotator borrows reasoning from one dimension to justify another — for example, penalizing Code Style because of correctness bugs, or penalizing Correctness because the model didn't write tests proactively (an Agent Behavior concern) — it conflates the signals and artificially widens the gap between models on dimensions where no real gap exists.

Additionally, at the batch level, check the rate of uniform scores (all four dimensions receiving the same value for a given model, e.g. 3/3/3/3 or 2/2/2/2). Code Style "N/A" is excluded from this check. If more than 30% of model results in a batch have uniform scores across all graded dimensions, flag as a batch-level pattern concern suggesting insufficiently granular scoring.

**1-2 (Fail)**:

- **[Fail - Cross-Dimension Contamination]** A dimension score's primary justification is grounded in criteria from a different dimension, materially affecting the score. Example: Code Style score penalizes "correctness bugs in both milestones" or Correctness score penalizes "not writing tests proactively."
- **[Fail - Contradictory Score-Ranking Alignment]** A model has strictly higher scores than its opponent on 3 or more dimensions but is ranked as the loser, with no compelling justification for the override.

**3-4 (Non-Fail)**:

- A justification briefly mentions a cross-dimension concern but the score is primarily grounded in the correct criteria.
- Scores are uniform across all dimensions for a model, but the rationale provides enough context to suggest the uniformity is genuine rather than lazy.

**5 (Pass)**: Each dimension's justification stays within its own criteria. Scores show appropriate differentiation across dimensions where the trajectory evidence supports it.

---

## Summary of Changes from v1

| # | Change | Type | Category | Rationale |
|---|--------|------|----------|-----------|
| 1 | Milestone Design | Removed | Task Setup | Task-generation problem, not an annotator QC issue |
| 2 | Prompt and Task Intent Alignment | Revised 3-4 | Task Setup | Applied pending revision (grammar, persona nuance) |
| 3 | Code Style Score | Revised 1-2, 3-4 | Global Scores | Applied pending revision (missing justification fail, weak skip justification) |
| 4 | A/B Comparison Fairness | Added | Trajectory Review | 14% failure rate in ACC trajectory audits; no prior coverage |
| 5 | Fabricated Claims fail condition | Added to Trajectory Summaries | Ranking & Rationale | 29% of tasks in ACC_DELIVERY_0505 had false claims; prior rubric only caught generic/missing |
| 6 | Internal Consistency | Added | Ranking & Rationale | Found direct contradictions within same rank.json (e.g., ad1) |
| 7 | Self-Fixed Bug fail condition | Added to Correctness | Global Scores | Annotators penalizing bugs models caught and fixed mid-turn |
| 8 | Dimension Score Integrity | Added | Global Scores | Cross-dimension contamination (ab2, ac8) and 41% uniform score rate |
| 9 | Task Reviewability expanded notes | Revised notes | Submission Integrity | Explicit file checklist added to auditor notes |
| 10 | Trajectory Summaries expanded notes | Revised notes | Ranking & Rationale | Added verification guidance for factual claims |

**Final dimension count**: 16 sub-dimensions (was 14; removed 1, added 3 net new)
