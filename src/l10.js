import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { ingestTask } from './ingest.js';
import { findTaskBucket, ensureWorkspace } from './workspace.js';

// The L10 pull: shell tools/get_tasks/pull_l10.py to fetch + stage every task at
// the review level, then ingest the new ones into UNSORTED (un-audited → no verdict
// yet). Additive: tasks already on the board (any bucket) are left untouched, and
// tasks that have since left L10 are NOT removed. Single-flight: a run in progress
// blocks a second; the scheduler and the admin button share this guard.

const PULL_SCRIPT = path.join(config.projectRoot, 'tools', 'get_tasks', 'pull_l10.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

let running = false;
let lastRun = null; // summary of the most recent completed (or failed) run

export function pullStatus() {
  return { running, lastRun };
}

// Fire-and-forget so the HTTP request (or the timer) returns immediately; the UI
// polls pullStatus(). Returns whether a new run was actually started.
export function startPull({ trigger = 'manual', user = null } = {}) {
  if (running) return { started: false, running: true };
  running = true;
  runL10Pull({ trigger, user })
    .then((summary) => { lastRun = summary; })
    .catch((e) => { lastRun = { ok: false, trigger, user, error: e.message, finishedAt: new Date().toISOString() }; })
    .finally(() => { running = false; });
  return { started: true, running: true };
}

async function runL10Pull({ trigger, user }) {
  ensureWorkspace();
  const startedAt = new Date().toISOString();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-l10-'));
  try {
    const manifest = await runPullScript(staging);
    const ingested = [];
    const skippedExisting = [];
    const failed = [...(manifest.errors || [])];

    for (const entry of manifest.staged || []) {
      const id = entry.task_id;
      if (!entry.staged) { failed.push(`${id}: ${entry.reason || 'not staged'}`); continue; }
      if (findTaskBucket(id)) { skippedExisting.push(id); continue; }
      try {
        ingestTask(id, 'UNSORTED', path.join(staging, id));
        ingested.push({ id, partial: !!entry.partial });
      } catch (e) {
        failed.push(`${id}: ingest failed: ${e.message}`);
      }
    }

    return {
      ok: failed.length === 0,
      trigger,
      user,
      startedAt,
      finishedAt: new Date().toISOString(),
      reviewLevel: manifest.review_level ?? config.l10.reviewLevel,
      status: manifest.status ?? config.l10.status,
      inL10: (manifest.task_ids || []).length,
      ingested: ingested.length,
      ingestedIds: ingested.map((i) => i.id),
      partial: ingested.filter((i) => i.partial).map((i) => i.id),
      skippedExisting: skippedExisting.length,
      errors: failed,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Run pull_l10.py and parse the JSON manifest it prints on its last stdout line
// (progress goes to stderr). The child inherits process.env, so REDASH_API_KEY
// (loaded from .env by config.js) reaches it.
function runPullScript(staging) {
  return new Promise((resolve, reject) => {
    const argv = [
      PULL_SCRIPT,
      '--out', staging,
      '--review-level', String(config.l10.reviewLevel),
      '--status', config.l10.status,
    ];
    if (config.l10.limit) argv.push('--limit', String(config.l10.limit));

    execFile(PYTHON, argv, { env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
      (err, stdout, stderr) => {
        const manifest = parseManifest(stdout);
        if (manifest) return resolve(manifest); // a manifest with errors[] is still a result
        reject(new Error(`pull_l10.py produced no manifest (${err ? err.message : 'exit 0'})\n${String(stderr).slice(-800)}`));
      });
  });
}

function parseManifest(stdout) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* not the manifest line */ }
  }
  return null;
}
