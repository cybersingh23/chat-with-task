import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { assertBucket, assertTaskId, ensureWorkspace, httpError } from './workspace.js';

// A claimed task ID is searched across every ACC_DELIVERY_* dir under the
// configured delivery roots (plus the roots themselves) for <task_id>/rank.json.
export function findTaskSources(taskId) {
  assertTaskId(taskId);
  const hits = [];
  for (const root of config.deliveryRoots) {
    if (!fs.existsSync(root)) continue;
    const candidates = [root];
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('ACC_DELIVERY')) continue;
      const p = path.join(root, name);
      try {
        if (fs.statSync(p).isDirectory()) candidates.push(p);
      } catch { /* unreadable entry */ }
    }
    for (const dir of candidates) {
      const t = path.join(dir, taskId);
      if (fs.existsSync(path.join(t, 'rank.json'))) hits.push(t);
    }
  }
  return hits;
}

export function ingestTask(taskId, bucket = 'UNSORTED', sourceDir = null) {
  ensureWorkspace();
  assertBucket(bucket);
  const sources = sourceDir ? [sourceDir] : findTaskSources(taskId);
  if (!sources.length) {
    throw httpError(404, `task ${taskId} not found under delivery roots: ${config.deliveryRoots.join(', ')}`);
  }
  const src = sources[sources.length - 1]; // newest-named delivery dir tends to sort last
  const dest = path.join(config.workspaceRoot, bucket, taskId);
  if (fs.existsSync(dest)) throw httpError(409, `task ${taskId} already in workspace (${bucket})`);
  fs.cpSync(src, dest, { recursive: true });
  writeAuditSeed(path.dirname(src), taskId, dest);
  return { taskId, bucket, source: src, candidates: sources };
}

// Pull this task's slice of any /acc audit artifacts that live next to the
// source delivery, so the copilot and docgen start from the audit's findings.
export function writeAuditSeed(deliveryDir, taskId, destTaskDir) {
  const auditDir = path.join(deliveryDir, '_audit');
  if (!fs.existsSync(auditDir)) return false;
  const sections = [`# Audit seed for ${taskId}`, `Source: ${auditDir}`];

  const finalVerdicts = readJson(path.join(auditDir, 'final_verdicts.json'));
  if (Array.isArray(finalVerdicts)) {
    const row = finalVerdicts.find((r) => r.task_id === taskId);
    if (row) sections.push('## Final verdict\n```json\n' + JSON.stringify(row, null, 2) + '\n```');
  }

  const claimVerdicts = readJson(path.join(auditDir, 'claim_verdicts.json'));
  if (claimVerdicts) {
    const mine = sliceByTaskId(claimVerdicts, taskId);
    if (mine.length) {
      sections.push('## Claim verdicts (verify_claims.py)\n```json\n' + JSON.stringify(mine, null, 2).slice(0, 30_000) + '\n```');
    }
  }

  for (const name of fs.readdirSync(auditDir)) {
    if (!/^fairness_findings.*\.md$/.test(name)) continue;
    const text = fs.readFileSync(path.join(auditDir, name), 'utf8');
    if (text.includes(taskId)) {
      const excerpt = extractAround(text, taskId);
      sections.push(`## Fairness findings (${name})\n${excerpt}`);
    }
  }

  const report = path.join(auditDir, 'ACC_AUDIT.md');
  if (fs.existsSync(report)) {
    const text = fs.readFileSync(report, 'utf8');
    if (text.includes(taskId)) sections.push('## ACC_AUDIT.md excerpt\n' + extractAround(text, taskId));
  }

  if (sections.length <= 2) return false;
  fs.writeFileSync(path.join(destTaskDir, '_audit_seed.md'), sections.join('\n\n') + '\n');
  return true;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// claim_verdicts.json shape varies between runs (list or {tasks:...}); filter
// any objects mentioning the task id.
function sliceByTaskId(data, taskId) {
  const rows = Array.isArray(data) ? data : Array.isArray(data.claims) ? data.claims : Object.values(data);
  return rows.filter((r) => JSON.stringify(r).includes(taskId)).slice(0, 80);
}

function extractAround(text, needle) {
  const chunks = [];
  let i = text.indexOf(needle);
  while (i !== -1 && chunks.length < 4) {
    chunks.push(text.slice(Math.max(0, i - 400), i + 1600));
    i = text.indexOf(needle, i + 1600);
  }
  return chunks.map((c) => '```\n…' + c + '…\n```').join('\n');
}
