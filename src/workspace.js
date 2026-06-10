import fs from 'node:fs';
import path from 'node:path';
import { config, BUCKETS } from './config.js';

const TASK_ID_RE = /^[a-f0-9]{24}$/;
const TEXT_READ_CAP = 200_000; // chars served per file read

export function ensureWorkspace() {
  for (const b of BUCKETS) fs.mkdirSync(path.join(config.workspaceRoot, b), { recursive: true });
}

export function assertBucket(bucket) {
  if (!BUCKETS.includes(bucket)) throw httpError(400, `unknown bucket: ${bucket}`);
  return bucket;
}

export function assertTaskId(id) {
  if (!TASK_ID_RE.test(id)) throw httpError(400, `invalid task id: ${id}`);
  return id;
}

export function taskDir(bucket, id, { mustExist = true } = {}) {
  const dir = path.join(config.workspaceRoot, assertBucket(bucket), assertTaskId(id));
  if (mustExist && !fs.existsSync(dir)) throw httpError(404, `task not found: ${bucket}/${id}`);
  return dir;
}

// Resolve a user-supplied relative path inside a task dir, refusing traversal.
export function resolveSafe(dir, rel) {
  const abs = path.resolve(dir, rel || '.');
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw httpError(400, `path escapes task dir: ${rel}`);
  return abs;
}

export function listWorkspace() {
  ensureWorkspace();
  const out = {};
  for (const b of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, b);
    out[b] = fs
      .readdirSync(bdir)
      .filter((n) => TASK_ID_RE.test(n) && fs.statSync(path.join(bdir, n)).isDirectory())
      .sort()
      .map((id) => taskMeta(b, id));
  }
  return out;
}

export function taskMeta(bucket, id) {
  const dir = taskDir(bucket, id);
  const has = (f) => fs.existsSync(path.join(dir, f));
  const meta = {
    id,
    bucket,
    hasReview: has('review.md'),
    hasRemediation: has('remediation.md'),
    hasAuditSeed: has('_audit_seed.md'),
    hasChat: has('_chat.json'),
    models: [],
    problem: '',
  };
  try {
    const rank = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
    meta.models = Object.keys(rank.results || {});
    meta.problem = String(rank.problem_statement || '').slice(0, 240);
    meta.annotator = rank.annotator_id || '';
  } catch {
    /* rank.json missing or unparseable — meta stays minimal */
  }
  return meta;
}

export function listFiles(bucket, id) {
  const dir = taskDir(bucket, id);
  const walk = (d, rel) => {
    const entries = [];
    for (const name of fs.readdirSync(d).sort()) {
      if (name === '.DS_Store') continue;
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) entries.push({ path: r, dir: true, children: walk(abs, r) });
      else entries.push({ path: r, dir: false, size: st.size });
    }
    return entries;
  };
  return walk(dir, '');
}

export function readTaskFile(bucket, id, rel) {
  const abs = resolveSafe(taskDir(bucket, id), rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `file not found: ${rel}`);
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(abs)) return { kind: 'image', abs };
  const buf = fs.readFileSync(abs);
  const text = buf.toString('utf8');
  return {
    kind: 'text',
    text: text.length > TEXT_READ_CAP ? text.slice(0, TEXT_READ_CAP) : text,
    truncated: text.length > TEXT_READ_CAP,
    size: buf.length,
  };
}

export function writeTaskFile(bucket, id, rel, content) {
  const abs = resolveSafe(taskDir(bucket, id), rel);
  fs.writeFileSync(abs, content);
}

export function moveTask(bucket, id, toBucket) {
  assertBucket(toBucket);
  const from = taskDir(bucket, id);
  const to = path.join(config.workspaceRoot, toBucket, id);
  if (fs.existsSync(to)) throw httpError(409, `task already exists in ${toBucket}`);
  fs.renameSync(from, to);
}

// Trajectory normalization: opencode export {info, messages:[{info:{role,...}, parts:[...]}]}
// -> flat [{index, role, created, parts:[{type, ...}]}], skipping step-start/step-finish noise.
const PART_TEXT_CAP = 30_000;

export function readTrajectory(bucket, id, model) {
  if (!/^model_[ab]$/.test(model)) throw httpError(400, `model must be model_a or model_b`);
  const abs = path.join(taskDir(bucket, id), 'trajectories', `trajectory_${model}.json`);
  if (!fs.existsSync(abs)) throw httpError(404, `no trajectory for ${model}`);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const messages = (raw.messages || []).map((m, index) => ({
    index,
    role: m.info?.role || 'unknown',
    created: m.info?.time?.created || null,
    completed: m.info?.time?.completed || null,
    parts: (m.parts || [])
      .filter((p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'tool')
      .map((p) => {
        if (p.type === 'tool') {
          return {
            type: 'tool',
            tool: p.tool,
            title: p.state?.title || '',
            status: p.state?.status || '',
            input: clip(JSON.stringify(p.state?.input ?? null, null, 2)),
            output: clip(String(p.state?.output ?? '')),
          };
        }
        return { type: p.type, text: clip(String(p.text ?? '')) };
      }),
  }));
  return { model, count: messages.length, messages };
}

function clip(s) {
  return s.length > PART_TEXT_CAP ? s.slice(0, PART_TEXT_CAP) + `\n… [truncated, ${s.length} chars total]` : s;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
