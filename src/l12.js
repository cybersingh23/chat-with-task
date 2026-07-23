import fs from 'node:fs';
import path from 'node:path';
import { config, BUCKETS } from './config.js';

// L12 analytics: aggregate every task's rank.json (eval result) + _studio.json
// (reviewer decision) into one computed payload for the dashboard. Cheap enough
// (a few hundred small JSON files) to compute per request — no caching needed.

const TASK_ID_RE = /^[0-9a-f]{24}$/;
const DIMS = ['correctness', 'agent_behaviour', 'communications', 'code_style'];
const RESOLVED_VERDICTS = new Set(['NO_ISSUES', 'FIXES_MADE', 'SBQ']);
const STRENGTH = { 1: 'slight', 2: 'moderate', 3: 'strong' };

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Resolve each result entry to its real model name. Legacy tasks key results as
// model_1/model_2 and carry a model_assignments map; newer tasks key results by
// the codename directly. Either way, model_assignment tells us the a/b slot.
function resolveNames(rank) {
  const results = rank.results || {};
  const keys = Object.keys(results);
  const legacy = keys.length === 2 && keys.includes('model_1') && keys.includes('model_2');
  const mas = rank.model_assignments || {};
  const out = {};
  for (const [k, v] of Object.entries(results)) {
    out[k] = legacy ? (mas[v.model_assignment] || v.model_assignment || k) : k;
  }
  return out;
}

// Task "name" = the base instance slug (e.g. interactive-hack-…-networkx-perf-optimization),
// with the trailing version/variant tag stripped (…-V47-A, …-v2, …-V3) so re-cuts of the
// same underlying task group together as instances. Falls back to the human title / problem
// statement only when there's no slug.
function baseTaskName(rank) {
  const slug = rank.source_instance_id || rank.instance_id;
  if (slug) {
    return String(slug).trim().replace(/-[Vv]\d+(?:-[A-Za-z0-9]+)?$/, '');
  }
  const t = rank.task && typeof rank.task === 'object' ? rank.task : {};
  const title = t.task_title || t.title;
  if (title) return String(title).trim();
  const ps = String(rank.problem_statement || '').trim();
  return ps ? ps.slice(0, 70) + (ps.length > 70 ? '…' : '') : '(untitled)';
}

// One flat record per task we care about.
function collect(scope) {
  const rows = [];
  for (const bucket of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, bucket);
    let names = [];
    try { names = fs.readdirSync(bdir); } catch { continue; }
    for (const id of names) {
      if (!TASK_ID_RE.test(id)) continue;
      const dir = path.join(bdir, id);
      const rank = readJson(path.join(dir, 'rank.json'));
      if (!rank || !rank.results) continue;
      const studio = readJson(path.join(dir, '_studio.json')) || {};
      if (studio.tour) continue;
      const delivered = !!studio.delivered;
      const verdict = studio.verdict || null;

      // scope filter
      if (scope === 'active' && delivered) continue;
      if (scope === 'completed' && (delivered || !(verdict && RESOLVED_VERDICTS.has(verdict)))) continue;
      // scope === 'all' → everything on disk

      rows.push({ id, bucket, delivered, verdict, rank, annotator: rank.annotator_id || 'unknown' });
    }
  }
  return rows;
}

export function computeL12(scope = 'completed') {
  const rows = collect(scope);

  const severity = { PASS: 0, SOFT_FAIL: 0, HARD_FAIL: 0, UNSORTED: 0 };
  const verdicts = { NO_ISSUES: 0, FIXES_MADE: 0, SBQ: 0, SECOND_OPINION: 0, none: 0 };
  const matchups = new Map();   // "A vs B" -> {a,b,total, perModel:{name:{wins,slight,moderate,strong,unrated}}}
  const models = new Map();     // name -> {appearances,wins,losses, dims:{dim:{sum,n}}}
  const annotators = new Map(); // id -> {tasks,NO_ISSUES,FIXES_MADE,SBQ,SECOND_OPINION}
  const taskNames = new Map();  // title -> count

  const modelRec = (name) => {
    if (!models.has(name)) models.set(name, { name, appearances: 0, wins: 0, losses: 0, dims: Object.fromEntries(DIMS.map((d) => [d, { sum: 0, n: 0 }])) });
    return models.get(name);
  };

  for (const r of rows) {
    severity[r.bucket] = (severity[r.bucket] || 0) + 1;
    verdicts[r.verdict || 'none'] = (verdicts[r.verdict || 'none'] || 0) + 1;

    const a = annotators.get(r.annotator) || { id: r.annotator, tasks: 0, NO_ISSUES: 0, FIXES_MADE: 0, SBQ: 0, SECOND_OPINION: 0 };
    a.tasks += 1;
    if (r.verdict && a[r.verdict] != null) a[r.verdict] += 1;
    annotators.set(r.annotator, a);

    const tn = baseTaskName(r.rank);
    taskNames.set(tn, (taskNames.get(tn) || 0) + 1);

    const names = resolveNames(r.rank);
    const entries = Object.entries(r.rank.results); // [key, resultObj]
    if (entries.length !== 2) continue;

    // per-model appearances + dimension scores + win/loss
    let winnerName = null;
    for (const [k, v] of entries) {
      const name = names[k];
      const rec = modelRec(name);
      rec.appearances += 1;
      if (v.rank === 1) { rec.wins += 1; winnerName = name; }
      else if (v.rank === 2) rec.losses += 1;
      const g = v.grading || {};
      for (const d of DIMS) {
        const sc = g[d] && typeof g[d].score === 'number' ? g[d].score : null;
        if (sc != null) { rec.dims[d].sum += sc; rec.dims[d].n += 1; }
      }
    }

    // matchup + preference strength
    const nameList = entries.map(([k]) => names[k]).sort();
    const key = nameList.join('  vs  ');
    if (!matchups.has(key)) {
      matchups.set(key, { key, a: nameList[0], b: nameList[1], total: 0, perModel: {} });
    }
    const mu = matchups.get(key);
    mu.total += 1;
    for (const nm of nameList) mu.perModel[nm] ||= { wins: 0, slight: 0, moderate: 0, strong: 0, unrated: 0 };
    if (winnerName && mu.perModel[winnerName]) {
      mu.perModel[winnerName].wins += 1;
      const pr = r.rank.preference_rating;
      const bucketName = (typeof pr === 'number' && STRENGTH[Math.abs(pr)]) ? STRENGTH[Math.abs(pr)] : 'unrated';
      mu.perModel[winnerName][bucketName] += 1;
    }
  }

  // finalize model leaderboard
  const leaderboard = [...models.values()].map((m) => {
    const dims = {};
    let oSum = 0, oN = 0;
    for (const d of DIMS) {
      const { sum, n } = m.dims[d];
      dims[d] = { avg: n ? sum / n : null, n };
      if (n) { oSum += sum; oN += n; }
    }
    const decided = m.wins + m.losses;
    return {
      name: m.name,
      appearances: m.appearances,
      wins: m.wins,
      losses: m.losses,
      winRate: decided ? m.wins / decided : null,
      dims,
      overall: oN ? oSum / oN : null,
    };
  }).sort((x, y) => (y.overall ?? -1) - (x.overall ?? -1));

  return {
    scope,
    total: rows.length,
    severity,
    verdicts,
    matchups: [...matchups.values()].sort((a, b) => b.total - a.total),
    leaderboard,
    annotators: [...annotators.values()].sort((a, b) => b.tasks - a.tasks),
    taskNames: [...taskNames.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    dims: DIMS,
  };
}
