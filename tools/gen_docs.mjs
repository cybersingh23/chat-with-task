#!/usr/bin/env node
// Pre-generate review.md + remediation.md into every task folder of a delivery,
// BEFORE it's zipped for upload — so the zip ships the docs and reviewers see
// them immediately (no in-app "Generate" needed). Uses the same docgen/tools/
// prompts as the live app (src/docgen.js), reading the LiteLLM key from .env.
//
// Usage:
//   node tools/gen_docs.mjs <delivery_dir> [--force] [--only review|remediation]
//       [--concurrency N] [--ids id1,id2,...]
//
// Notes:
// - review is generated first, then remediation (remediation reads review).
// - skips tasks that already have both docs unless --force.
// - run AFTER _audit/final_verdicts.json exists if you want it in the zip too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocForDir } from '../src/docgen.js';
import { costOf } from '../src/usage.js';

const TASK_ID_RE = /^[a-f0-9]{24}$/;
const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(name); return i !== -1 ? (args[i + 1] ?? true) : def; };
const has = (name) => args.includes(name);

const delivery = args.find((a) => !a.startsWith('--') && a !== flag('--only') && a !== flag('--concurrency') && a !== flag('--ids'));
if (!delivery) {
  console.error('usage: node tools/gen_docs.mjs <delivery_dir> [--force] [--only review|remediation] [--concurrency N] [--ids a,b]');
  process.exit(1);
}
const root = path.resolve(delivery.replace(/^~/, process.env.HOME));
const force = has('--force');
const only = flag('--only');
const concurrency = Math.max(1, Number(flag('--concurrency', 3)));
const idFilter = flag('--ids') ? new Set(String(flag('--ids')).split(',').map((s) => s.trim())) : null;

const which = only ? [only] : ['review', 'remediation'];

let taskDirs = fs.readdirSync(root)
  .filter((n) => TASK_ID_RE.test(n) && fs.existsSync(path.join(root, n, 'rank.json')))
  .filter((n) => !idFilter || idFilter.has(n))
  .map((n) => path.join(root, n));
if (!taskDirs.length) { console.error(`no <task_id>/rank.json folders under ${root}`); process.exit(1); }

const totals = { prompt: 0, completion: 0 };
const onUsage = (u) => { totals.prompt += u.prompt_tokens || 0; totals.completion += u.completion_tokens || 0; };

async function doTask(dir) {
  const id = path.basename(dir);
  for (const w of which) {
    if (!force && fs.existsSync(path.join(dir, `${w}.md`))) { console.log(`  skip ${id} ${w} (exists)`); continue; }
    const t0 = Date.now();
    try {
      await generateDocForDir(dir, w, { id, onUsage });
      console.log(`  ✓ ${id} ${w} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (e) {
      console.log(`  ✗ ${id} ${w} — ${e.message}`);
    }
  }
}

// simple concurrency pool over tasks (review→remediation stays sequential per task)
console.log(`gen_docs: ${taskDirs.length} task(s) in ${path.basename(root)} · ${which.join(' + ')} · concurrency ${concurrency}`);
let cursor = 0;
async function worker() { while (cursor < taskDirs.length) { const d = taskDirs[cursor++]; await doTask(d); } }
await Promise.all(Array.from({ length: Math.min(concurrency, taskDirs.length) }, worker));

const cost = costOf(totals.prompt, totals.completion);
console.log(`\ndone · ${totals.prompt.toLocaleString()} in / ${totals.completion.toLocaleString()} out tokens · est. $${cost.toFixed(2)}`);
process.exit(0);
