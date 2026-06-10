import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './llm.js';
import { TOOL_DEFS, makeExecutor } from './tools.js';
import { taskDir, writeTaskFile } from './workspace.js';

// Shared context block: rank.json digest + audit seed, prepended to every
// system prompt (chat copilot and doc generation).
export function taskContext(bucket, id) {
  const dir = taskDir(bucket, id);
  const parts = [`Task ID: ${id} (bucket: ${bucket})`];
  try {
    const rank = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
    const digest = {
      instance_id: rank.instance_id,
      annotator_id: rank.annotator_id,
      vendor: rank.vendor,
      problem_statement: String(rank.problem_statement || '').slice(0, 2000),
      models: {},
      ranking_rationale: String(rank.ranking_rationale || '').slice(0, 4000),
      preference_rating: rank.preference_rating,
    };
    for (const [codename, r] of Object.entries(rank.results || {})) {
      digest.models[codename] = {
        model_assignment: r.model_assignment,
        rank: r.rank,
        failure_modes_non_none: Object.fromEntries(
          Object.entries(r.failure_modes || {}).filter(([, v]) => v && v !== 'none')
        ),
      };
    }
    parts.push('rank.json digest:\n' + JSON.stringify(digest, null, 2));
  } catch {
    parts.push('(rank.json missing or unparseable — flag this immediately, it is a packaging defect)');
  }
  const seed = path.join(dir, '_audit_seed.md');
  if (fs.existsSync(seed)) {
    parts.push('Prior /acc audit findings for this task (_audit_seed.md):\n' + fs.readFileSync(seed, 'utf8').slice(0, 20_000));
  }
  return parts.join('\n\n');
}

export const CITATION_RULES = `
Citation rules (mandatory):
- Whenever you reference a point in a trajectory, cite it as a markdown link with a traj:// URL:
  [model_a msg 23](traj://model_a/23). The UI turns these into "Show in trajectory" buttons that
  jump the reviewer to that exact message. model is model_a or model_b; the number is the message
  index shown by read_trajectory. Cite generously — every factual claim about a trajectory needs one.
- "model_a"/"model_b" map to model codenames via rank.json model_assignment; always state the mapping once.
- Verify before you assert: every specific number or quoted prompt in rank.json is a falsifiable
  claim — use the search tool against the trajectories before calling it accurate or fabricated.
  For quoted prompts, search distinctive n-grams, not the full literal; for absence claims
  ("never X"), remember a search HIT refutes the claim.
- Use complete 24-char task and annotator IDs, never truncated forms.
- Annotator idle time and a missing task definition are INFORMATIONAL only, never findings (customer policy 2026-06-09).
`.trim();

const REVIEW_PROMPT = `
You are an expert ACC delivery auditor writing review.md for a QM reviewer.

Investigate the task thoroughly using your tools (list_files first, then rank.json, both
trajectories, ranking_proof justifications, snapshots as needed). Then output ONLY the final
markdown document (no preamble) with this structure:

# Review — <task_id>
## Verdict summary
One paragraph: overall assessment, proposed bucket (HARD_FAIL / SOFT_FAIL / PASS), and why.
## Task overview
Problem statement summary, model_a/model_b codename mapping, ranks, preference rating.
## Trajectory walkthrough
Brief per-model narrative of what the annotator did, with traj:// citations.
## Findings
Numbered findings, most severe first. Each finding: severity (HARD/SOFT/INFO), the verbatim
rank.json claim and its field path, the trajectory evidence with traj:// citations and search
hit counts, and the impact (which side, whether rank/scores are affected).
Check at minimum: initial-prompt consistency between models, claim accuracy of every specific
number/quote in the rationales, coaching/guidance asymmetry, duplicate prompts, stub/forfeit
trajectories (≤3 msgs or greeting-stub "Hello! How can I help you today?"), milestone coverage,
ranking_proof justification vs rank.json consistency.
## Informational notes
Idle time, missing task definition, and other non-finding observations.
`.trim();

const REMEDIATION_PROMPT = `
You are an expert ACC delivery auditor writing remediation.md — the concrete path to fixing this
task so it can ship. You are given review.md; verify anything you rely on with your tools.

Output ONLY the final markdown document (no preamble):

# Remediation — <task_id>
## Goal state
What a shippable version of this task looks like.
## Steps
Numbered, ordered remediation steps. Each step: the owner (annotator / vendor / internal-QM),
exactly what to change (file + field path for rank.json edits, e.g. /results/<codename>/grading/...),
the trajectory evidence motivating it with traj:// citations, and how to verify the fix.
## Re-audit checklist
Checkboxes the reviewer ticks before moving the task to PASS.
## Escalation
When to escalate instead of remediate (e.g. byte-identical unremediated resubmission, vendor stub).
`.trim();

export async function generateDoc(bucket, id, which, onEvent) {
  const isReview = which === 'review';
  const dir = taskDir(bucket, id);
  const system = [
    isReview ? REVIEW_PROMPT : REMEDIATION_PROMPT,
    CITATION_RULES,
    taskContext(bucket, id),
  ].join('\n\n');

  const userParts = [`Generate ${which}.md for task ${id}. Use complete IDs.`];
  if (!isReview) {
    const reviewPath = path.join(dir, 'review.md');
    if (fs.existsSync(reviewPath)) {
      userParts.push('Current review.md:\n\n' + fs.readFileSync(reviewPath, 'utf8').slice(0, 30_000));
    } else {
      userParts.push('No review.md exists yet — investigate from scratch.');
    }
  }

  const { final } = await runAgentLoop({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    tools: TOOL_DEFS,
    executor: makeExecutor(bucket, id),
    onEvent,
    maxSteps: 25,
  });

  const doc = cleanDoc(final);
  writeTaskFile(bucket, id, `${which}.md`, doc);
  return doc;
}

// Models sometimes wrap whole-document output in a ```markdown fence and/or
// prefix it with a "Let me compile the review" lead-in — keep only the doc,
// which always starts at the first H1.
function cleanDoc(s) {
  const m = s.trim().match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  let doc = (m ? m[1] : s).trim();
  const h1 = doc.search(/^# /m);
  if (h1 > 0) doc = doc.slice(h1);
  return doc.trim() + '\n';
}
