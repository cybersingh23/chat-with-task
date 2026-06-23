import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { findTaskBucket, ensureWorkspace } from './workspace.js';
import { setDelivered } from './state.js';

// Marking tasks "delivered" soft-archives them (hidden from the board, kept on
// disk, reversible) and produces ONE backup zip that fully restores them:
//   delivered_<stamp>.csv         readable audit register
//   _audit/final_verdicts.json    so re-upload re-buckets them correctly
//   <task_id>/…                   full folder snapshot (pre-delivery _studio.json)
// Re-uploading the zip via the normal upload flow repopulates the feed as it was.

const execFileP = promisify(execFile);
const BACKUP_DIR = path.join(config.workspaceRoot, '_deliveries');

let lastDelivery = null;

export function deliverStatus() {
  return { lastDelivery };
}

export function currentBackup() {
  if (!lastDelivery?.zipName) return null;
  const abs = path.join(BACKUP_DIR, lastDelivery.zipName);
  return fs.existsSync(abs) ? { abs, name: lastDelivery.zipName } : null;
}

// Bucket -> the verdict string the upload's bucketFor() understands, so a restored
// task lands back in its original column. UNSORTED gets no entry (falls back to it).
const VERDICT_FOR_BUCKET = { HARD_FAIL: 'HARD_FAIL', SOFT_FAIL: 'SOFT_FAIL', PASS: 'PASS' };

export async function markDelivered(taskIds, user) {
  ensureWorkspace();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const staging = fs.mkdtempSync(path.join(BACKUP_DIR, 'stage-'));
  try {
    const delivered = [];
    const notFound = [];
    const verdictRows = [];
    const csv = [csvHeader()];

    for (const id of taskIds) {
      const bucket = findTaskBucket(id);
      if (!bucket) { notFound.push(id); continue; }
      const srcDir = path.join(config.workspaceRoot, bucket, id);

      // Snapshot BEFORE flagging, so the backup's _studio.json restores as visible.
      const snap = path.join(staging, id);
      fs.cpSync(srcDir, snap, { recursive: true });

      const meta = gatherMeta(snap);
      csv.push(csvRow({ task_id: id, bucket, ...meta }));
      if (VERDICT_FOR_BUCKET[bucket]) verdictRows.push({ task_id: id, verdict: VERDICT_FOR_BUCKET[bucket] });

      setDelivered(bucket, id, true, user); // flag the live copy → hidden from board
      delivered.push({ id, bucket });
    }

    let zipName = null;
    let zipBytes = 0;
    if (delivered.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.mkdirSync(path.join(staging, '_audit'), { recursive: true });
      fs.writeFileSync(path.join(staging, '_audit', 'final_verdicts.json'), JSON.stringify(verdictRows, null, 2));
      fs.writeFileSync(path.join(staging, `delivered_${stamp}.csv`), csv.join('\n') + '\n');
      zipName = `delivery_${stamp}.zip`;
      await execFileP('zip', ['-q', '-r', path.join(BACKUP_DIR, zipName), '.'], { cwd: staging });
      zipBytes = fs.statSync(path.join(BACKUP_DIR, zipName)).size;
      // keep only the most recent backup on disk
      for (const f of fs.readdirSync(BACKUP_DIR)) {
        if (f.endsWith('.zip') && f !== zipName) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
      }
    }

    lastDelivery = {
      ok: delivered.length > 0,
      user,
      finishedAt: new Date().toISOString(),
      delivered: delivered.length,
      deliveredIds: delivered.map((d) => d.id),
      notFound,
      zipName,
      zipBytes,
    };
    return lastDelivery;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function markUndelivered(taskIds, user) {
  const restored = [];
  const notFound = [];
  for (const id of taskIds) {
    const bucket = findTaskBucket(id);
    if (!bucket) { notFound.push(id); continue; }
    setDelivered(bucket, id, false, user);
    restored.push(id);
  }
  return { restored: restored.length, restoredIds: restored, notFound };
}

// --- backup CSV ---
const CSV_COLS = [
  'task_id', 'bucket', 'verdict', 'verdict_by', 'claimed_by', 'annotator', 'models',
  'problem', 'has_review', 'has_remediation', 'checklist', 'review_md', 'remediation_md',
];

function csvHeader() { return CSV_COLS.join(','); }

function csvRow(r) {
  return CSV_COLS.map((c) => csvCell(r[c])).join(',');
}

// RFC-4180 quoting: wrap in quotes and double any internal quote. Always quote so
// embedded commas / newlines (review text) never break the row.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function gatherMeta(dir) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const meta = {
    verdict: '', verdict_by: '', claimed_by: '', annotator: '', models: '', problem: '',
    has_review: fs.existsSync(path.join(dir, 'review.md')),
    has_remediation: fs.existsSync(path.join(dir, 'remediation.md')),
    checklist: '', review_md: read('review.md'), remediation_md: read('remediation.md'),
  };
  try {
    const rank = JSON.parse(read('rank.json'));
    meta.annotator = rank.annotator_id || '';
    meta.models = Object.keys(rank.results || {}).join(' / ');
    meta.problem = String(rank.problem_statement || '');
  } catch { /* rank.json missing/unparseable */ }
  try {
    const st = JSON.parse(read('_studio.json'));
    meta.verdict = st.verdict || '';
    meta.verdict_by = st.verdict_by || '';
    meta.claimed_by = st.claimed_by || '';
    if (st.checklist) meta.checklist = JSON.stringify(st.checklist);
  } catch { /* no studio state */ }
  return meta;
}
