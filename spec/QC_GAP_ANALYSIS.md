# QC Spec Gap Analysis

**Based on**: QC <> MLDG Rubric Generator v1117 vs ACC eval findings (ACC_DELIVERY through ACC_DELIVERY_0505)
**Date**: 2026-05-06
**Author**: Pavit Singh

---

## Background

This document compares the current QC rubric (the "Dimension Definition" sheet from the QC <> MLDG Rubric Generator) against patterns found across four rounds of ACC delivery evaluation. The goal is to identify what the rubric should add, remove, or revise so that QC auditors catch the issues we've been finding post-delivery.

Sources used:

- QC <> MLDG Rubric Generator v1117, Dimension Definition tab (14 sub-dimensions across 5 categories)
- Internal quality eval results for ACC_DELIVERY, ACC_DELIVERY_2, ACC_DELIVERY_3, ACC_DELIVERY_0505
- Cross-trajectory consistency audit (ACC_Trajs, 22 tasks)
- Customer NWR QA report for ACC_DELIVERY_0505

---

## Recommendations at a Glance

| Priority | Action | Item | Section |
|----------|--------|------|---------|
| P0 | Add | A/B Comparison Fairness | Trajectory Review |
| P0 | Add | Fabricated Claims fail condition | Ranking & Rationale > Trajectory Summaries |
| P1 | Add | Cross-Dimension Score Contamination | Global Scores |
| P1 | Add | Internal Consistency check | Ranking & Rationale |
| P1 | Add | Self-Fixed Bug policy clarification | Global Scores > Correctness |
| P2 | Add | Score Uniformity batch-level flag | Global Scores |
| P0 | Remove | Milestone Design | Task Setup |
| P1 | Revise | Code Style fail conditions | Global Scores |
| P2 | Revise | Prompt and Task Intent Alignment | Task Setup |

---

## Additions

### 1. A/B Comparison Fairness (P0 — Add to Trajectory Review)

**Why this matters**: This is the most common failure mode we've found and has zero coverage in the current spec.

The rubric checks whether interaction *feels natural* (Prompting and Interaction Discipline) but never asks whether the annotator *treated both models equivalently*. These are different concerns. An annotator can sound perfectly natural while giving one model specific answers and the other model vague prompts.

**Evidence from our evals (3 of 22 tasks failed, 14% rate):**

| Task | What happened |
|------|---------------|
| aa5 (Friend Feed) | Both models finished milestone 1. Model B was told "check that threshold=6 and add --aggregate." Model A got "verify and validate that all requirements were correctly satisfied." Same milestone, same knowledge, different specificity. |
| abb (OpenTelemetry) | Both models finished implementation, neither knew the verify script location. Model B was given the explicit path `/app/verify_otel_integration.py`. Model A got a vague "the verify script was not executed." |
| ac8 (Dev Orchestrator) | Model A's Turn 3 contained leaked pipeline metadata (`continuation_criteria`) with explicit pass/fail criteria and fallback instructions. Model B received none of this. |

**Suggested rubric language:**

> **A/B Comparison Fairness** (under Trajectory Review)
>
> At matching milestones with matching background knowledge, the annotator must provide equivalent guidance to both models. Different turn counts and reactive corrections for model-specific bugs are expected and acceptable. What is not acceptable: giving one model specific answers, file paths, thresholds, or implementation hints at a step where both models are at the same point with the same knowledge.
>
> - **1-2 (Fail):** Annotator provides materially different information to models at equivalent milestones, giving one model an information advantage the other must discover independently.
> - **3-4 (Non-Fail):** Minor framing differences at matching milestones that do not confer a meaningful information advantage.
> - **5 (Pass):** At every matching milestone, both models receive equivalent guidance. All prompt divergences are reactive to different model states.

---

### 2. Fabricated Claims Fail Condition (P0 — Add to Trajectory Summaries)

**Why this matters**: The rubric catches *generic* and *missing* summaries, but not *false* ones. Our evals found fabricated claims in 6 of 21 tasks (29%).

**Evidence:**

| Task | Fabricated claim | Reality |
|------|-----------------|---------|
| aab (Chain Merge) | "Final wrap-up includes a small README" | No README was ever written. Model B mentioned wanting to create one but never did. |
| abe (Geodesic Heat) | IC(0) preconditioner "never materialized into actual running code" (2 locations) | IC(0) was implemented, compiled, ran, and produced measured results. It was reverted because wall time was worse despite fewer iterations. |
| ac5 (yaml-cpp) | "Regression test needed a revision after targeting the wrong code path" attributed to Model A (2 locations) | Only Model B needed a revision. Model A used the correct approach on the first attempt. |
| acc (C Profiler) | Model B summary fabricates a technical root cause for the empty dashboard | The described root cause does not appear anywhere in the trajectory. The actual cause was a FIFO timing/EOF bug. |
| acc (C Profiler) | "I only needed three messages total" | Actual count is 6 messages (5 meaningful). |
| ad1 (KV Store) | "New merged segment ID is hard-coded to 1" cited as a final-state defect | Model A caught and fixed this bug mid-turn. The fix is visible in the trajectory. |

**Suggested addition to the 1-2 (Fail) column for Trajectory Summaries:**

> [Fail - Fabricated or False Claim]: A summary or rationale contains a specific technical claim — an event, output, behavior, or code state — that is contradicted by or absent from the trajectory evidence.

---

### 3. Cross-Dimension Score Contamination (P1 — Add to Global Scores)

**Why this matters**: Auditors are borrowing justifications from one dimension to penalize another, which distorts the per-dimension signal.

**Evidence:**

| Task | Dimension | What the rationale says | Correct dimension |
|------|-----------|------------------------|-------------------|
| ab2 (Coffee Shop) | Code Style = 2 | "Correctness bugs in both milestones suggest the code was not carefully validated" | Correctness |
| ac8 (Dev Orchestrator) | Correctness = 2 | Penalizes Model B for "not writing tests proactively" | Agent Behaviour |

**Suggested addition (note under Global Scores or standalone sub-dimension):**

> Each dimension score must be justified by criteria belonging to that dimension. Penalizing Code Style for correctness bugs, or Correctness for process failures, conflates dimensions and inflates the apparent gap between models. If a justification's primary argument belongs to a different dimension, flag it.
>
> - **1-2 (Fail):** A dimension score's primary justification is grounded in criteria from a different dimension, materially affecting the score.
> - **3-4 (Non-Fail):** A justification briefly mentions a cross-dimension concern but the score is primarily grounded in the correct criteria.
> - **5 (Pass):** Each dimension's justification stays within its own criteria.

---

### 4. Internal Consistency Check (P1 — Add to Ranking & Rationale)

**Why this matters**: Different fields within the same rank.json can directly contradict each other. The rubric checks rationale quality in isolation but never instructs auditors to cross-check.

**Evidence:**

| Task | Field A says | Field B says |
|------|-------------|-------------|
| ad1 (KV Store) | Correctness rationale: "segment ID hard-coded to 1" (a defect) | Ranking rationale (same file): "Alpha caught its own segment-id collision bug mid-turn and fixed it cleanly" |

**Suggested sub-dimension under Ranking & Rationale:**

> **Internal Consistency** — The ranking rationale, per-trajectory summaries, and per-dimension justifications must not contradict each other within the same submission.
>
> - **1-2 (Fail):** A factual claim in one field directly contradicts a factual claim in another field of the same rank.json.
> - **3-4 (Non-Fail):** Fields are consistent on facts but differ slightly in emphasis or framing.
> - **5 (Pass):** All fields tell a coherent, non-contradictory story.

---

### 5. Self-Fixed Bug Policy Clarification (P1 — Add to Correctness Score)

**Why this matters**: Annotators are penalizing models for bugs they caught and fixed themselves within the same turn. The rubric says Correctness is "primarily concerned with the final solution or end state," but auditors aren't applying this consistently.

**Evidence**: ad1 (KV Store) — Model A identified a segment-ID collision bug, fixed it to use `max_existing + 1`, and the final code is correct. The Correctness rationale still cites the bug as a defect.

**Suggested addition to the Correctness "Additional Notes for Auditors" column:**

> Bugs caught and fixed by the model within the same turn are not Correctness defects — they demonstrate strong self-correction and should be credited under Agent Behavior. Only bugs present in the final code state count against Correctness.

---

### 6. Score Uniformity Batch-Level Flag (P2 — Add to Global Scores)

**Why this matters**: 41% of model scores in ACC_DELIVERY_0505 had identical values across all four dimensions (e.g., 3/3/3/3 or 2/2/2/2). This suggests insufficient per-dimension differentiation. The customer flagged this independently in their QA report.

**Suggested addition (batch-level auditor note):**

> At the batch level, check the rate of uniform scores (all dimensions identical for a given model). If more than 30% of model results in a batch have uniform scores, flag as a pattern concern suggesting lazy or insufficiently granular scoring.

---

## Removals

### Milestone Design (P0 — Remove from Task Setup)

The revision column already flags this: "Completely remove this sub-dimension as it's a task-generation problem and not an annotator/contributor issue."

Our evals confirm this. Across four delivery rounds and 22+ tasks, we never flagged milestone design as an annotator quality issue. Milestone problems are upstream of the annotator and should be caught during task generation QC, not delivery QC.

---

## Revisions

### Code Style Fail Conditions (P1 — Apply Pending Revision)

The revision column already has the right changes queued:

- Add `[Fail - Missing Code Style justification]` to the 1-2 range: "The contributor did not provide a reasonable justification for why the ranking was not completed."
- Add to the 3-4 range: "Given the weight of evidence in the trajectory, the justification for skipping the ranking is weak."

These align with our findings. Code Style is frequently N/A or uniformly scored across the batch, and the current fail conditions don't catch unjustified skips. Apply the revisions as written.

### Prompt and Task Intent Alignment (P2 — Apply Pending Revision)

The revision column softens "mild boilerplate copied verbatim" to "grammar issues, mild boilerplate copied verbatim" and adds nuance about persona edits. This is a reasonable adjustment. Apply it.

---

## What's Already Well-Covered (No Changes Needed)

| QC Spec Dimension | Our Eval Equivalent | Assessment |
|---|---|---|
| Task Reviewability / Core Evidence | ONL-GEN-05, ONL-TR-02, ONL-AM-01 | Well aligned |
| Task Scope / Feasibility | Not directly tested in our evals | Appropriate for task-generation QC; keep as-is |
| Milestone Achievement Verification | Partially covered by internal eval | Keep as-is |
| Trajectory Completeness | ONL-TR-03 (truncation), ONL-TR-04 (depth) | Well aligned |
| Prompting and Interaction Discipline | ONL-AM-01 (naturalness) | Well aligned for naturalness; A/B fairness is the gap (covered in addition 1) |
| Subjective Ranking Quality | Internal eval Ranking Validity | Well aligned |
| Final Comparative Rationale | Internal eval + ONL-GC-05 | Well aligned |
| Agent Behavior / Communication Scores | Internal eval Grading Alignment | Well aligned |
