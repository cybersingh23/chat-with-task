import Busboy from 'busboy';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { assertBucket, ensureWorkspace, httpError } from './workspace.js';
import { writeAuditSeed } from './ingest.js';

const execFileP = promisify(execFile);
const TASK_ID_RE = /^[a-f0-9]{24}$/;

// Browser folder upload (webkitdirectory) or a single .zip. Each file arrives
// with its relative path as the filename; we stage into a temp dir, locate
// rank.json, derive the task id, and move into the chosen bucket.
export function handleUpload(req, res, next) {
  ensureWorkspace();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-upload-'));
  const fields = {};
  const writes = [];
  let fileCount = 0;

  // preservePath keeps the webkitRelativePath the browser puts in filename.
  const bb = Busboy({ headers: req.headers, preservePath: true, limits: { fileSize: 500 * 1024 * 1024, files: 4000 } });

  bb.on('field', (name, val) => (fields[name] = val));
  bb.on('file', (name, stream, info) => {
    const rel = sanitizeRel(info.filename);
    if (!rel) return stream.resume(); // skip junk/unsafe paths
    fileCount++;
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    stream.pipe(out);
    writes.push(new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('limit', () => reject(httpError(413, `${rel} exceeds the 500MB per-file limit`)));
    }));
  });

  bb.on('close', async () => {
    try {
      await Promise.all(writes);
      if (!fileCount) throw httpError(400, 'no files received');
      const result = await finalizeUpload(tmp, fields);
      res.json(result);
    } catch (e) {
      next(e);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  bb.on('error', (e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    next(e);
  });
  req.pipe(bb);
}

// Strip the browser's path decorations and refuse traversal. Returns '' to skip.
function sanitizeRel(filename) {
  const rel = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.endsWith('/')) return '';
  if (path.basename(rel) === '.DS_Store') return '';
  return rel;
}

async function finalizeUpload(tmp, fields) {
  const bucket = assertBucket(fields.bucket || 'UNSORTED');

  // Single zip → extract in place, then treat like a folder upload.
  const rootEntries = fs.readdirSync(tmp);
  if (rootEntries.length === 1 && rootEntries[0].toLowerCase().endsWith('.zip')) {
    const zipPath = path.join(tmp, rootEntries[0]);
    try {
      await execFileP('unzip', ['-q', '-o', zipPath, '-d', tmp, '-x', '__MACOSX/*']);
    } catch (e) {
      throw httpError(400, `could not extract zip: ${e.message.slice(0, 200)}`);
    }
    fs.unlinkSync(zipPath);
  }

  // Locate the task root: the shallowest directory containing rank.json.
  const taskRoot = findRankRoot(tmp);
  if (!taskRoot) throw httpError(400, 'no rank.json found in the upload — select the task folder itself (the <task_id> directory)');

  const taskId = deriveTaskId(taskRoot, fields.taskId);
  if (!taskId) {
    throw httpError(400, 'could not derive a 24-char task id from the folder name — name the folder after the task id or fill the task id field');
  }

  const dest = path.join(config.workspaceRoot, bucket, taskId);
  if (fs.existsSync(dest)) throw httpError(409, `task ${taskId} already in workspace`);
  fs.cpSync(taskRoot, dest, { recursive: true });

  // If the upload included a sibling _audit dir (whole-delivery zip), seed from it.
  const deliveryDir = path.dirname(taskRoot);
  let seeded = false;
  if (fs.existsSync(path.join(deliveryDir, '_audit'))) {
    seeded = writeAuditSeed(deliveryDir, taskId, dest);
  }

  const fileTotal = countFiles(dest);
  return { taskId, bucket, files: fileTotal, seeded };
}

function findRankRoot(root) {
  const queue = [root];
  while (queue.length) {
    // BFS so the shallowest rank.json wins.
    const dir = queue.shift();
    if (fs.existsSync(path.join(dir, 'rank.json'))) return dir;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) queue.push(p);
    }
  }
  return null;
}

function deriveTaskId(taskRoot, explicit) {
  if (explicit && TASK_ID_RE.test(explicit.trim())) return explicit.trim();
  if (TASK_ID_RE.test(path.basename(taskRoot))) return path.basename(taskRoot);
  // Walk up in case rank.json sat in a subdir of the <task_id> folder.
  let dir = taskRoot;
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    if (TASK_ID_RE.test(path.basename(dir))) return path.basename(dir);
  }
  return null;
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}
