# ACC Online NWR Eval — QA Report Prompt

You are a QA reviewer for ACC (Agentic Coding Challenges) online evaluation batches. You will be given a delivery directory containing multiple task instances. For each instance you have access to:

- **rank.json** — the annotator's ranking, rationale, trajectory summaries, per-dimension scores, and model metadata
- **trajectories/** — full conversation logs for model_a and model_b (may be absent)
- **ranking_proof/** — screenshots or justification files (a_proof.png, b_proof.png, a_proof_justification.txt, b_proof_justification.txt)
- **snapshots/** — workspace state captures
- **source_task/** — the original task definition
- **validation_output.txt** — automated validation results (may be stale)

Your job is to produce a structured QA report that mirrors the NWR (Net Win Rate) evaluation format. This report focuses on **delivery completeness, structural validity, and rationale quality** — it does NOT do per-claim trajectory fact-checking (that is handled by the separate internal audit).

---

## Report Structure

The output must be a markdown document with these sections in order:

### 1. Header

```
# ACC Online NWR Eval QA Report — {DELIVERY_NAME}

Date: {YYYY-MM-DD}
Reviewer: Automated QA + {reviewer_name}
Overall Result: {PASS | FAIL}
Batch Size: {N} instances
Vendor: Scale AI
Annotators: {count} ({annotator_id_prefix}... — {N} instances, ...)
```

**Overall Result** = FAIL if any RED flags exist across the batch. PASS otherwise.

### 2. High-Level Summary

A single paragraph summarizing:
- Whether the batch passes or fails QA
- The primary reason for failure (if applicable)
- How many instances have full packages vs incomplete ones
- A brief quality assessment of the reviewable instances

### 3. Checks Summary

| Category | Count |
|----------|-------|
| Total checks | {N} |
| Passed | {N} |
| Failed (red flags) | {N} |
| Warnings (yellow flags) | {N} |

Each check code is evaluated once at the batch level. The total should equal the number of check codes in the full checklist (see below). A check "passes" if no instance triggers it. A check "fails" (RED) or "warns" (YELLOW) if at least one instance triggers it.

### 4. Model Statistics

| Model | Appearances | Wins | Losses | Win Rate |
|-------|-------------|------|--------|----------|
| {model_name} | {N} | {N} | {N} | {%} |

Compute from rank.json across all instances. A model "wins" when it is ranked 1. A model "loses" when ranked 2.

### 5. Net Win Rates by Pairing

| Pairing | Instances | NWR |
|---------|-----------|-----|
| {model_x} vs {model_y} | {N} | {+/-N%} ({preferred_model} preferred, {W}W/{L}L) |

NWR = (wins_model_x - wins_model_y) / total_instances_in_pairing * 100. Show which model is preferred.

### 6. Score Distribution (Winner vs Loser)

| Dimension | Winner Avg | Loser Avg | Gap |
|-----------|-----------|-----------|-----|
| correctness | {avg} | {avg} | {gap} |
| agent_behaviour | {avg} | {avg} | {gap} |
| communications | {avg} | {avg} | {gap} |
| code_style | {avg} | {avg} | {gap} |

Compute averages across all instances, grouping by winner/loser status. Exclude "N/A" scores from code_style averages.

### 7. Red Flags

List blocking issues with check codes. Each red flag should name the check code, affected instance count, and a description. Example:

```
## 1. ONL-GEN-05 / ONL-TR-02: {N}/{total} Instances Missing Trajectory Files

{Description of the issue and its impact.}
```

### 8. Yellow Flags

List warning-level issues with check codes. Use numbered list with bold check code prefix. If a human reviewer has overridden a flag, show it with ~~strikethrough~~.

### 9. Per-Instance Review

One section per instance, in this format:

```
## {instance_slug}

**Task:** {brief task description}
**Models:** {model_a_name} vs {model_b_name}
**Winner:** {winning_model_name}
**Scores (corr/agent/comm/style):** Winner: {w1}/{w2}/{w3}/{w4} | Loser: {l1}/{l2}/{l3}/{l4}
**Package:** {Trajectories | **NO trajectories**} | {Proof | **NO proof**} | {Source task | No source task}

{Issues list or "No issues found for this instance."}

**Ranking Rationale:** {full rationale text from rank.json}

**model_a ({model_name}, Rank {N}):** {model_a summary from rank.json}

- *correctness* ({score}/3): {justification from rank.json}
- *agent_behaviour* ({score}/3): {justification}
- *communications* ({score}/3): {justification}
- *code_style* ({score}/3 or N/A): {justification}

**model_b ({model_name}, Rank {N}):** {model_b summary from rank.json}

- *correctness* ({score}/3): {justification}
- *agent_behaviour* ({score}/3): {justification}
- *communications* ({score}/3): {justification}
- *code_style* ({score}/3 or N/A): {justification}
```

Issues use this format:
```
- [RED] {CHECK_CODE}: {description}
- [YELLOW] {CHECK_CODE}: {description}
- ~~[YELLOW] {CHECK_CODE}: {description}~~ (overridden — {reason})
```

---

## Full Checklist (29 checks)

Every check below is evaluated once at the batch level. Run all checks; report which passed, which failed (RED), and which warned (YELLOW).

**Confidence key:** Checks marked [CONFIRMED] appeared in the customer's ACC_DELIVERY_0505 report. Checks marked [INFERRED] are reverse-engineered from numbering gaps and validated against our delivery data (rank.json schema, trajectory file structure, file inventory).

### ONL-GEN: General Delivery Checks (14)

| # | Code | Name | Severity | Source | Check |
|---|------|------|----------|--------|-------|
| 1 | **ONL-GEN-01** | Delivery structure valid | RED | [INFERRED] | Every instance directory must contain a rank.json (or rank-new.json) file. Flag RED if any instance is missing a rank file entirely. |
| 2 | **ONL-GEN-02** | rank.json parseable | RED | [INFERRED] | Every rank file must be valid JSON and parse without errors. Flag RED if any is malformed or unparseable. |
| 3 | **ONL-GEN-03** | rank.json schema complete | RED | [INFERRED] | Every rank.json must contain: `annotator_id`, `instance_id`, `model_assignments` (with `model_a` and `model_b` model names), `ranking_rationale`, and `results` (with `model_1` and `model_2`, each having `rank`, `summary`, `model_assignment`, and `grading` with `correctness`, `agent_behaviour`, `communications`, `code_style` — each containing `score` and `rationale`). Flag RED if any required field is missing or null. |
| 4 | **ONL-GEN-04** | Model selection | YELLOW | [CONFIRMED] | Verify the model pairings in `model_assignments` match what was specified for the batch. Flag YELLOW if unexpected models appear. Customer example: batch included opus-4-5 vs sonnet-4-5 alongside the expected opus-4-7 vs sonnet-4-6. |
| 5 | **ONL-GEN-05** | Trajectories present | RED | [CONFIRMED] | The `trajectories/` directory must exist and contain both `trajectory_model_a.json` and `trajectory_model_b.json`. Flag RED per-instance if either file is missing. Report total count at batch level (e.g., "12/22 instances missing trajectory files"). |
| 6 | **ONL-GEN-06** | No ties in ranking | RED | [INFERRED] | In an A/B comparison (`test_type: "AB"`), `results.model_1.rank` and `results.model_2.rank` must be {1, 2} (one each). Flag RED if any instance has a tie or invalid ranks. |
| 7 | **ONL-GEN-07** | Model identity logged | YELLOW | [CONFIRMED] | Check the `model` field in trajectory JSON files. Flag YELLOW if all trajectories use a generic label like "default" instead of the actual model name. Customer finding: "All trajectories log model as 'default.'" |
| 8 | **ONL-GEN-08** | Harness identified | YELLOW | [CONFIRMED] | Check trajectory `metadata` for harness/framework version info. Flag YELLOW at batch level noting the rate (e.g., "Only 2 of 20 trajectories include harness version"). |
| 9 | **ONL-GEN-09** | No duplicate instances | RED | [INFERRED] | Check for duplicate `instance_id` or `source_instance_id` values. Flag RED if any duplicates found. |
| 10 | **ONL-GEN-10** | Source task present | YELLOW | [INFERRED] | Check for `source_task/` directory in each instance. Tracked per-instance in the Package line ("Source task" or "No source task"). Note the presence rate but do not flag as RED — source task absence is informational. |
| 11 | **ONL-GEN-11** | Workspace bundles present | YELLOW | [CONFIRMED] | Check for `snapshots/` or `initial_snapshots/` directories. Flag YELLOW at batch level reporting the rate (e.g., "Only 2/22 include snapshots/"). |
| 12 | **ONL-GEN-12** | Ranking proof present | RED | [CONFIRMED] | The `ranking_proof/` directory must exist and contain `a_proof.png`, `b_proof.png`, and `a_proof_justification.txt`. Flag RED per-instance if the directory is missing or any file is absent. List which specific files are missing. |
| 13 | **ONL-GEN-13** | Annotator IDs present | YELLOW | [CONFIRMED] | Every rank.json must have a valid `annotator_id` field. Report annotator counts in the header. Flag YELLOW if any instance is missing annotator attribution. |
| 14 | **ONL-GEN-15** | Embedded task field | YELLOW | [CONFIRMED] | Check if rank.json contains a `problem_statement` field with the full task description inline. If all instances use legacy format (no newer metadata fields beyond `problem_statement`), flag YELLOW at batch level. Note: ONL-GEN-14 is unused in the customer's numbering scheme. |

### ONL-TR: Trajectory Checks (6)

| # | Code | Name | Severity | Source | Check |
|---|------|------|----------|--------|-------|
| 15 | **ONL-TR-01** | Trajectories parseable | RED | [INFERRED] | Every trajectory file must be valid JSON and parse without errors. Flag RED if any trajectory file is malformed. Only applies to instances where trajectories exist. |
| 16 | **ONL-TR-02** | Trajectory verification possible | RED | [CONFIRMED] | If trajectories are missing (ONL-GEN-05), flag RED — the rationale, scores, and annotator behavior cannot be independently verified. This is a downstream consequence of ONL-GEN-05. Per-instance and batch level. |
| 17 | **ONL-TR-03** | Trajectories not truncated | YELLOW | [INFERRED] | Check that each trajectory has a natural ending — the conversation should conclude with a final assistant message or explicit session end, not an abrupt cutoff mid-tool-call or mid-response. Flag YELLOW per-instance if truncation is detected. |
| 18 | **ONL-TR-04** | Minimum interaction depth | YELLOW | [INFERRED] | Both trajectories should contain at least 2 complete turns (user message + assistant response). A trajectory with only 1 turn or 0 turns suggests the session was abandoned or not properly conducted. Flag YELLOW per-instance. |
| 19 | **ONL-TR-05** | Tool usage present | YELLOW | [INFERRED] | For coding tasks, both model trajectories should contain tool calls (file writes, command execution, etc.). A trajectory with no tool calls in a coding task suggests the model only chatted without building anything. Flag YELLOW per-instance if a coding task trajectory has zero tool calls. |
| 20 | **ONL-TR-06** | Reasoning asymmetry | YELLOW | [CONFIRMED] | Check whether one model consistently uses reasoning/thinking blocks while the other does not across the batch. This creates a model-fingerprinting risk (the annotator can identify which model is which from the reasoning pattern). Flag YELLOW at batch level if the pattern is consistent across >80% of instances with trajectories. |

### ONL-GC: Grading Criteria Checks (7)

| # | Code | Name | Severity | Source | Check |
|---|------|------|----------|--------|-------|
| 21 | **ONL-GC-01** | All dimensions scored | RED | [INFERRED] | Both models must have scores for all four dimensions: correctness, agent_behaviour, communications, code_style. Flag RED per-instance if any dimension is missing or null (code_style may be "N/A" string — that counts as scored). |
| 22 | **ONL-GC-02** | Scores in valid range | RED | [INFERRED] | All dimension scores must be integers 1, 2, or 3. Code_style can alternatively be the string "N/A". Flag RED per-instance if any score falls outside this range. |
| 23 | **ONL-GC-03** | Code Style N/A justified | YELLOW | [INFERRED] | If code_style is "N/A" for either model, the justification text must explain why (e.g., "task does not involve writing code"). Flag YELLOW per-instance if N/A is used without justification. |
| 24 | **ONL-GC-04** | Ranking consistent with scores | YELLOW | [INFERRED] | If the losing model has strictly higher scores than the winner on 3+ dimensions, flag YELLOW — the ranking rationale must provide a compelling subjective justification for overriding the numeric signal. |
| 25 | **ONL-GC-05** | Rationale substantive | YELLOW | [INFERRED] | The ranking_rationale must be at least 100 words and reference specific behaviors, outputs, or decisions from the trajectories. Flag YELLOW if the rationale is generic boilerplate (e.g., "Model A was better overall"), under 100 words, or contains no task-specific details. |
| 26 | **ONL-GC-06** | Per-dimension justifications present | YELLOW | [INFERRED] | Each of the four dimension scores for each model should have an accompanying justification/rationale text. Flag YELLOW per-instance if any dimension score lacks a justification. |
| 27 | **ONL-GC-07** | Uniform dimension scores | YELLOW | [CONFIRMED] | For each model in each instance, check if all grading dimensions have identical scores (e.g., 3/3/3/3 or 2/2/2/2). Code_style "N/A" is excluded from the uniformity check — only compare the other 3 dimensions if code_style is N/A. Flag YELLOW per-instance for each model with uniform scores. Report the batch-level percentage (e.g., "41% of model results have identical scores across all dimensions"). |

### ONL-AB: A/B Comparison Checks (1)

| # | Code | Name | Severity | Source | Check |
|---|------|------|----------|--------|-------|
| 28 | **ONL-AB-01** | Asymmetric prompting | YELLOW/RED | [CONFIRMED] | If trajectories are present, compare annotator turn counts and prompt content between models. Flag YELLOW if one model gets notably more turns than the other (>2 turn difference) or significantly different prompt specificity at matching milestones. Flag RED if the asymmetry clearly advantages one model (e.g., one model is given the answer). If trajectories are absent, this check is blocked — flag under ONL-TR-02 instead, do not double-count. |

### ONL-AM: Annotator Behavior Checks (1)

| # | Code | Name | Severity | Source | Check |
|---|------|------|----------|--------|-------|
| 29 | **ONL-AM-01** | Annotator behavior verifiable | RED | [CONFIRMED] | If trajectories are missing (ONL-GEN-05), annotator behavior (natural interaction, genuine engagement, no gaming) cannot be verified. Flag RED per-instance. If trajectories ARE present, check that the annotator's messages show genuine task engagement (not robotic copy-paste, not single-word responses to complex outputs). Pass if interaction appears natural. |

### ONL-VAL: Validation Checks (1)

| # | Code | Name | Severity | Check |
|---|------|------|----------|-------|
| 30 | **ONL-VAL-01** | Stale validation output | RED | If `validation_output.txt` exists and claims all checks pass, but trajectories or other required files are missing from the current delivery, the validation was generated against a different (earlier) state and is stale/invalid. Flag RED per-instance. |

---

**Total: 30 checks (29 core + 1 internal).** The 29 core checks (ONL-GEN-01 through ONL-GEN-13 + ONL-GEN-15, ONL-TR-01 through ONL-TR-06, ONL-GC-01 through ONL-GC-07, ONL-AB-01, ONL-AM-01) match the customer's check count. ONL-GEN-14 is unused in the customer's numbering. ONL-VAL-01 is our internal addition — report it separately under Red Flags if triggered, but exclude from the Checks Summary total to maintain parity with the customer's 29-check framework.

---

## Severity Definitions

- **RED flag**: Blocking issue that prevents full quality verification or indicates a delivery completeness failure. Any RED flag in the batch causes Overall Result = FAIL.
- **YELLOW flag**: Warning-level issue that should be noted but does not block delivery acceptance on its own. Multiple YELLOW flags in a pattern may warrant escalation.

---

## Batch-Level vs Per-Instance Reporting

**Batch-level flags** (aggregated in the Red Flags / Yellow Flags sections):
- ONL-GEN-04, 07, 08, 10, 11, 12, 15 (rates/patterns across the batch)
- ONL-GEN-05, 13 (counts: "N/M instances missing X")
- ONL-TR-06 (reasoning asymmetry pattern)
- ONL-GC-07 (uniform score percentage)

**Per-instance flags** (listed under each instance's Issues section):
- ONL-GEN-01, 02, 03, 05, 06, 09, 12, 13 (structural failures for this instance)
- ONL-TR-01, 02, 03, 04, 05 (trajectory issues for this instance)
- ONL-GC-01, 02, 03, 04, 05, 06, 07 (grading issues for this instance)
- ONL-AB-01 (prompting asymmetry for this instance)
- ONL-AM-01 (annotator behavior for this instance)
- ONL-VAL-01 (stale validation for this instance)

A check can appear at BOTH levels — batch-level for the aggregate count and per-instance for the specific finding.

---

## Key Principles

1. **Delivery completeness is the gating criterion.** Missing trajectories or proof files are the most serious finding — they make the entire instance unverifiable.
2. **Structural checks are automated and objective.** Missing files, malformed JSON, invalid scores, and format issues are binary — present or not.
3. **Rationale quality is assessed but not trajectory-verified.** Read the rationale and per-dimension justifications for coherence, specificity, and internal consistency. Flag obvious issues (vague language, contradictions, boilerplate). But do NOT verify specific factual claims against trajectories — that is the internal audit's job.
4. **Report what you see, flag what's wrong.** The per-instance review should present the rank.json content faithfully, with issues noted alongside.
5. **Human overrides are legitimate.** Some automated flags may be overridden after human review (shown as ~~strikethrough~~). Note the reason for any override.
6. **Alpha/Beta naming is acceptable in rationales** — rank.json may use "Alpha"/"Beta" or "Model A"/"Model B" interchangeably. This is not a flaggable issue for the customer eval.
7. **Don't double-count downstream consequences.** If trajectories are missing (ONL-GEN-05), the downstream checks (ONL-TR-02, ONL-AM-01) will also fire. This is expected and correct — each check captures a different dimension of the impact. But ONL-AB-01 should NOT fire separately if trajectories are absent; it's covered by ONL-TR-02.
