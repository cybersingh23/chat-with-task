import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { ensureWorkspace } from './workspace.js';

// Pull tasks from Redash (all of a review level, or an explicit id list) and
// package them into a downloadable zip of <task_id>/ folders — each with
// rank.json + trajectories/. Nothing is ingested into the board; the admin
// downloads the zip and runs evals separately. Single-flight: one pull at a time.

const execFileP = promisify(execFile);
const PULL_SCRIPT = path.join(config.projectRoot, 'tools', 'get_tasks', 'pull_l10.py');

// fill_rank.py needs Python 3.10+. Honor PYTHON_BIN if set; otherwise auto-pick a
// versioned 3.10+ interpreter on PATH so no config is needed when one exists. Falls
// back to python3 (pull_l10.py reports clearly if that turns out to be too old).
function resolvePython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  for (const cand of ['python3.13', 'python3.12', 'python3.11', 'python3.10']) {
    try { execFileSync(cand, ['--version'], { stdio: 'ignore' }); return cand; }
    catch { /* not on PATH — try the next */ }
  }
  return 'python3';
}
const PYTHON = resolvePython();
// Persistent (workspace is a mounted volume) but outside the bucket dirs, so
// listWorkspace() never sees it. Holds the most recent pull's zip.
const DOWNLOAD_DIR = path.join(config.workspaceRoot, '_l10_downloads');

let running = false;
let lastRun = null; // { ok, mode, finishedAt, taskIds, staged, errors, zipName?, zipBytes? }

export function pullStatus() {
  return { running, lastRun };
}

// Resolve the current download to an absolute path, or null if none/stale.
export function currentDownload() {
  if (!lastRun?.zipName) return null;
  const abs = path.join(DOWNLOAD_DIR, lastRun.zipName);
  return fs.existsSync(abs) ? { abs, name: lastRun.zipName } : null;
}

// Fire-and-forget; the UI polls pullStatus(). mode: 'l10' | 'ids'.
export function startPull({ mode = 'l10', taskIds = [], user = null } = {}) {
  if (running) return { started: false, running: true };
  running = true;
  runPull({ mode, taskIds, user })
    .then((summary) => { lastRun = summary; })
    .catch((e) => { lastRun = { ok: false, mode, user, error: e.message, finishedAt: new Date().toISOString() }; })
    .finally(() => { running = false; });
  return { started: true, running: true };
}

async function runPull({ mode, taskIds, user }) {
  ensureWorkspace();
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-l10-'));
  try {
    const manifest = await runPullScript(staging, mode, taskIds);
    const staged = (manifest.staged || []).filter((s) => s.staged);
    const errors = [...(manifest.errors || [])];
    for (const s of manifest.staged || []) if (!s.staged) errors.push(`${s.task_id}: ${s.reason || 'not staged'}`);

    let zipName = null;
    let zipBytes = 0;
    if (staged.length) {
      zipName = await makeZip(staging, mode);
      zipBytes = fs.statSync(path.join(DOWNLOAD_DIR, zipName)).size;
    }

    return {
      ok: errors.length === 0 && staged.length > 0,
      mode: manifest.mode || mode,
      user,
      startedAt,
      finishedAt: new Date().toISOString(),
      requested: (manifest.task_ids || []).length,
      staged: staged.length,
      partial: staged.filter((s) => s.partial).map((s) => s.task_id),
      zipName,
      zipBytes,
      errors,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// One fresh zip per pull; drop any previous so the download dir stays small.
async function makeZip(staging, mode) {
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    if (f.endsWith('.zip')) fs.rmSync(path.join(DOWNLOAD_DIR, f), { force: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `pull_${mode}_${stamp}.zip`;
  // zip from inside staging so archive entries are <task_id>/… (no temp-path prefix),
  // matching the upload flow's expected shape.
  await execFileP('zip', ['-q', '-r', path.join(DOWNLOAD_DIR, zipName), '.'], { cwd: staging });
  return zipName;
}

function runPullScript(staging, mode, taskIds) {
  const argv = [PULL_SCRIPT, '--out', staging,
    '--review-level', String(config.l10.reviewLevel), '--status', config.l10.status];
  if (config.l10.limit) argv.push('--limit', String(config.l10.limit));
  if (mode === 'ids') argv.push('--task-ids', taskIds.join(','));

  return execFileP(PYTHON, argv, { env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 })
    .then(({ stdout }) => parseManifest(stdout) || Promise.reject(new Error('pull_l10.py produced no manifest')))
    .catch((err) => {
      // execFile rejects on non-zero exit, but the script still prints a manifest
      // (e.g. a query-permission error) — prefer that over the raw exit error.
      const m = err.stdout && parseManifest(err.stdout);
      if (m) return m;
      throw new Error(`${err.message}\n${String(err.stderr || '').slice(-800)}`);
    });
}

function parseManifest(stdout) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* not the manifest line */ }
  }
  return null;
}
