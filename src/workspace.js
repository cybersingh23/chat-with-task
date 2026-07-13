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
    hasRankingProof: fs.existsSync(path.join(dir, 'ranking_proof')),
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
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '_studio.json'), 'utf8'));
    meta.claimedBy = state.claimed_by || null;
    meta.verdict = state.verdict || null;
    meta.verdictNote = state.verdict_note || null;
    meta.delivered = !!state.delivered;
    meta.deliveredAt = state.delivered_at || null;
    meta.tour = !!state.tour;
    meta.tourOwner = state.tour_owner || null;
  } catch {
    meta.claimedBy = null;
    meta.verdict = null;
    meta.verdictNote = null;
    meta.delivered = false;
    meta.deliveredAt = null;
    meta.tour = false;
    meta.tourOwner = null;
  }
  return meta;
}

export function deleteTask(bucket, id) {
  const dir = taskDir(bucket, id); // validates bucket/id + existence
  fs.rmSync(dir, { recursive: true, force: true });
}

export function clearWorkspace() {
  ensureWorkspace();
  let n = 0;
  for (const b of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, b);
    for (const name of fs.readdirSync(bdir)) {
      if (TASK_ID_RE.test(name)) { fs.rmSync(path.join(bdir, name), { recursive: true, force: true }); n++; }
    }
  }
  return n;
}

// Where a task currently lives (any bucket), or null.
export function findTaskBucket(id) {
  for (const b of BUCKETS) {
    if (fs.existsSync(path.join(config.workspaceRoot, b, id))) return b;
  }
  return null;
}

export function existingTaskIds() {
  ensureWorkspace();
  const ids = new Set();
  for (const b of BUCKETS) {
    for (const n of fs.readdirSync(path.join(config.workspaceRoot, b))) {
      if (TASK_ID_RE.test(n)) ids.add(n);
    }
  }
  return ids;
}

// Dir-scoped cores (also used by the offline doc generator) + (bucket,id) wrappers.
export function listFilesIn(dir) {
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
export function listFiles(bucket, id) { return listFilesIn(taskDir(bucket, id)); }

export function readFileIn(dir, rel) {
  const abs = resolveSafe(dir, rel);
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
export function readTaskFile(bucket, id, rel) { return readFileIn(taskDir(bucket, id), rel); }

export function writeFileIn(dir, rel, content) { fs.writeFileSync(resolveSafe(dir, rel), content); }

export function writeTaskFile(bucket, id, rel, content) { writeFileIn(taskDir(bucket, id), rel, content); }

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

export function readTrajectory(bucket, id, model) { return readTrajectoryIn(taskDir(bucket, id), model); }

export function readTrajectoryIn(dir, model) {
  if (!/^model_[ab]$/.test(model)) throw httpError(400, `model must be model_a or model_b`);
  const abs = path.join(dir, 'trajectories', `trajectory_${model}.json`);
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

// Task definition: v2 schema embeds it in rank.json under "task" (object);
// legacy batches carry a CDS URL string there, with source_task/task.json as
// the only local fallback. Missing is INFORMATIONAL per customer policy.
export function readTaskDef(bucket, id) { return readTaskDefIn(taskDir(bucket, id)); }

export function readTaskDefIn(dir) {
  let task = null;
  let source = null;
  try {
    const rank = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
    if (rank.task && typeof rank.task === 'object') {
      task = rank.task;
      source = 'rank.json:task';
    }
  } catch { /* fall through to legacy file */ }
  if (!task) {
    const legacy = path.join(dir, 'source_task', 'task.json');
    if (fs.existsSync(legacy)) {
      try {
        task = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        source = 'source_task/task.json';
      } catch { /* unparseable */ }
    }
  }
  if (!task) return { missing: true };
  const ui = task.user_intent || {};
  return {
    missing: false,
    source,
    title: task.task_title || '',
    category: [task.task_category, task.task_subcategory].filter(Boolean).join(' / '),
    difficulty: task.difficulty || '',
    language: task.language || '',
    user_persona: typeof ui.user_persona === 'string' ? ui.user_persona : JSON.stringify(ui.user_persona || ''),
    milestones: asList(ui.milestones).map((m, i) =>
      typeof m === 'string'
        ? { id: `m${i + 1}`, title: '', prompt: m }
        : { id: m.milestone_id || `m${i + 1}`, title: m.title || '', prompt: m.prompt || '' }
    ),
    guardrails: guardrailLines(ui.guardrails),
  };
}

// Vendor task.json fields drift between string / array / object shapes.
function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v);
  return [v];
}

// guardrails is usually {max_turns, session_abort_criteria: [...], notes} but
// drifts; flatten to display lines, one per rule.
function guardrailLines(g) {
  if (g == null) return [];
  if (typeof g === 'string') return [g];
  if (Array.isArray(g)) return g.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  const lines = [];
  for (const [k, v] of Object.entries(g)) {
    if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    else lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return lines;
}

// rank.json behind a clean reader for the "CB responses" view. Normalizes the
// results map (codename-keyed in v2; model_1/model_2-keyed in legacy batches)
// into an ordered per-model list with the model_a/model_b side, grading, and
// failure modes resolved. Missing / unparseable -> { present: false }.
export function readRank(bucket, id) { return readRankIn(taskDir(bucket, id)); }

export function readRankIn(dir) {
  let rank;
  try {
    rank = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
  } catch { return { present: false }; }
  const results = rank.results || {};
  const assignments = rank.model_assignments || {}; // {model_a: codename, ...} in some batches
  const ranks = Object.values(results).map((r) => r?.rank).filter((n) => typeof n === 'number');
  const bestRank = ranks.length ? Math.min(...ranks) : null;
  const models = Object.entries(results).map(([key, r]) => {
    const side = r?.model_assignment || null; // 'model_a' | 'model_b'
    // The results key is the codename in v2; for model_1/model_2 batches resolve
    // the codename via the top-level model_assignments map.
    let codename = key;
    if (/^model_[12]$/i.test(key) && side && assignments[side]) codename = assignments[side];
    return {
      key,
      codename,
      side,
      rank: typeof r?.rank === 'number' ? r.rank : null,
      winner: typeof r?.rank === 'number' && r.rank === bestRank,
      summary: String(r?.summary || ''),
      grading: Object.entries(r?.grading || {}).map(([dim, g]) => ({
        dim,
        score: g && typeof g === 'object' ? (g.score ?? null) : null,
        rationale: g && typeof g === 'object' ? String(g.rationale || '') : String(g ?? ''),
      })),
      failure_modes: Object.entries(r?.failure_modes || {}).map(([fkey, level]) => ({ key: fkey, level: String(level || 'none') })),
    };
  });
  models.sort((a, b) => sideOrder(a.side) - sideOrder(b.side));
  return {
    present: true,
    problem_statement: String(rank.problem_statement || ''),
    test_type: rank.test_type || '',
    annotator: rank.annotator_id || '',
    preference_rating: typeof rank.preference_rating === 'number' ? rank.preference_rating : null,
    ranking_rationale: String(rank.ranking_rationale || ''),
    clarification: rank.optional_clarification_comments || '',
    other: rank.optional_other_comments || '',
    models,
  };
}
function sideOrder(s) { return s === 'model_a' ? 0 : s === 'model_b' ? 1 : 2; }

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
