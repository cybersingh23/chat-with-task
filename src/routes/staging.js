import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspace, taskMeta, taskDir } from '../workspace.js';
import { laneOf, moveTaskToLane } from '../lanes.js';
import { recordAction } from '../actions.js';
import { runRegistryQuery } from '../redash_registry.js';
import { redashEnabled } from '../redash.js';
import { ptrGet, ptrSet } from '../fixes.js';

// /api/staging/* and /api/backfill — the Staging lane's working surface
// (HANDOFF_STAGING_FIXES_BACKFILL.md §6-§8, flow per Pavit 2026-08-10):
// fixes are decided in Staging, the backfill export pulls FROM Staging, the
// check runs there, and all-confirmed tasks move to Resolved with the id list
// copied out for the platform-side L12 move.
export const stagingApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// How long after a backfill Redash may legitimately not reflect it yet.
// 30 minutes, per Pavit (§10.1) — inside the window a gap is PENDING, not
// MISMATCH.
export const PROPAGATION_WINDOW_MS = 30 * 60 * 1000;

function stagingTasks() {
  const ws = listWorkspace();
  const out = [];
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const meta = taskMeta(bucket, t.id);
      if (laneOf(meta) === 'STAGING') out.push(meta);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check behind the lane's button
// ---------------------------------------------------------------------------

// Readiness + upstream reconciliation for every task in Staging. "Ready" is a
// conjunction the popup can explain per task: no pending fixes, no validation
// warnings, and Redash does not show the task sent back. Redash being
// unreachable degrades to board-only checks, loudly.
stagingApi.get('/verify', wrap(async (req, res) => {
  const tasks = stagingTasks();
  if (!tasks.length) return res.json({ items: [], redash: redashEnabled(), generatedAt: new Date().toISOString() });

  let sbq = new Map();
  let level = new Map();
  let labels = new Map();
  let redashError = null;
  if (redashEnabled()) {
    try {
      const ids = tasks.map((t) => t.id);
      const [sbqRes, lvlRes, labelRes] = await Promise.all([
        runRegistryQuery('task_sbq', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
        runRegistryQuery('task_current_level', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
        runRegistryQuery('task_labels', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
      ]);
      sbq = new Map(sbqRes.rows.map((r) => [r.task_id, r]));
      level = new Map(lvlRes.rows.map((r) => [r.task_id, r]));
      labels = new Map(labelRes.rows.map((r) => [r.task_id, r]));
    } catch (e) {
      redashError = e.message;
    }
  }

  const items = tasks.map((m) => {
    const s = sbq.get(m.id);
    const l = level.get(m.id);
    const upstreamSbq = Number(s?.sbq_attempts || 0) > 0;
    const warnings = m.audit?.warnings?.length || 0;
    const blockers = [];
    if (m.pendingFixes > 0) blockers.push(`${m.pendingFixes} fix${m.pendingFixes === 1 ? '' : 'es'} pending`);
    if (warnings) blockers.push(`${warnings} validation warning${warnings === 1 ? '' : 's'}`);
    // Board SBQ verdict without Redash confirmation shows as awaiting, never as
    // truth in either direction (§7.4).
    if (upstreamSbq) blockers.push('SBQ upstream — pull, do not backfill');
    else if (m.verdict === 'SBQ') blockers.push('board-marked SBQ, awaiting Redash confirmation');
    return {
      id: m.id,
      bucket: m.bucket,
      severity: m.bucket,
      tags: m.audit?.tags || [],
      grammarOnly: !!m.audit?.grammar_only_fail || m.grammarOnly,
      pendingFixes: m.pendingFixes,
      warnings,
      upstream: l ? { level: String(l.review_level), status: l.status } : null,
      sbq: upstreamSbq,
      lastSbqAt: s?.last_sbq_at || null,
      hasSourceRow: fs.existsSync(path.join(taskDir(m.bucket, m.id), '_source_row.json')),
      // Did the board's label land on platform? Covers the two 1:1-mappable
      // fields (preference rating, winning side); prose fields have no platform
      // field map yet — the eval-side reconciler owns that (§7.5). Informational,
      // not a gate: a grammar-only task matches trivially, a re-ranked one shows
      // ✗ until the backfill lands.
      labelMatch: labelMatch(taskDir(m.bucket, m.id), labels.get(m.id)),
      ready: blockers.length === 0,
      blockers,
    };
  });

  res.json({
    items,
    confirmed: items.filter((i) => i.ready).map((i) => i.id),
    redash: redashEnabled() && !redashError,
    redashError,
    propagationWindowMs: PROPAGATION_WINDOW_MS,
    generatedAt: new Date().toISOString(),
  });
}));

// "Move all confirmed": the popup's button. Resolves each task — grammar-only
// as GRAMMAR_ONLY, everything else as FIXES_MADE — through the same
// moveTaskToLane + recordAction path every other lane change takes, so each
// move shows in Recent actions and is undoable.
stagingApi.post('/resolve', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });

  const inStaging = new Map(stagingTasks().map((m) => [m.id, m]));
  const moved = [];
  const skipped = [];
  for (const id of ids) {
    const m = inStaging.get(id);
    if (!m) { skipped.push({ id, reason: 'not in Staging' }); continue; }
    if (m.pendingFixes > 0) { skipped.push({ id, reason: 'pending fixes' }); continue; }
    const verdict = (m.audit?.grammar_only_fail || m.grammarOnly) ? 'GRAMMAR_ONLY' : 'FIXES_MADE';
    const item = moveTaskToLane(m.bucket, id, 'RESOLVED', { verdict, username: req.user.username });
    if (item) {
      // The backfill stamp lives beside the verdict so the export manifest and
      // the eval-side reconciler can see when the move happened.
      const p = path.join(taskDir(m.bucket, id), '_studio.json');
      try {
        const state = JSON.parse(fs.readFileSync(p, 'utf8'));
        state.backfilled_at = new Date().toISOString();
        state.backfilled_by = req.user.username;
        fs.writeFileSync(p, JSON.stringify(state, null, 2));
      } catch { /* stamp is advisory */ }
      moved.push(item);
    } else skipped.push({ id, reason: 'no change' });
  }
  if (moved.length) {
    recordAction({
      by: req.user.username,
      kind: 'bulk_move',
      label: `Staging backfill: ${moved.length} confirmed → Resolved`,
      items: moved,
    });
  }
  res.json({ moved: moved.map((m) => m.id), skipped });
}));

// Normalize-then-compare for the two mappable label fields (§8: normalize both
// sides; a naive === cries wolf on formatting).
function labelMatch(dir, platform) {
  if (!platform) return { status: 'NOT_FOUND' };
  let live;
  try { live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8')); } catch { return { status: 'NO_RANK' }; }

  const fields = [];
  // preference: "+2: moderately prefer model b" -> +2, matched numerically.
  const platPref = parseInt(String(platform.preference_rating || '').trim(), 10);
  const boardPref = Number(live.preference_rating);
  if (!Number.isNaN(platPref) && !Number.isNaN(boardPref)) {
    fields.push({ field: 'preference_rating', match: platPref === boardPref, board: boardPref, platform: platPref });
  }
  // winner: platform says "model a"/"model b"; the board's rank-1 result key
  // maps to a side directly (model_1/model_2) or via model_assignments.
  const winKey = Object.entries(live.results || {}).find(([, r]) => Number(r.rank) === 1)?.[0];
  if (winKey) {
    let side = null;
    if (/^model_[12]$/i.test(winKey)) side = winKey.endsWith('1') ? 'model a' : 'model b';
    else {
      const assign = live.model_assignments || {};
      const entry = Object.entries(assign).find(([, code]) => code === winKey);
      if (entry) side = entry[0] === 'model_a' ? 'model a' : 'model b';
    }
    const plat = String(platform.model_ranking || '').trim().toLowerCase();
    if (side && plat) fields.push({ field: 'winner', match: plat === side, board: side, platform: plat });
  }
  if (!fields.length) return { status: 'UNMAPPED' };
  return { status: fields.every((f) => f.match) ? 'MATCH' : 'MISMATCH', fields };
}

// Upstream layer for EVERY task on the board — the per-card tag (§7.1). One
// batched query, served from the registry's cache (5-minute TTL); fresh=1 is
// the manual refresh.
stagingApi.get('/layers', wrap(async (req, res) => {
  const ws = listWorkspace();
  const ids = Object.values(ws).flat().filter((t) => !t.tour).map((t) => t.id);
  if (!ids.length || !redashEnabled()) return res.json({ layers: {}, enabled: redashEnabled() });
  try {
    const out = await runRegistryQuery('task_current_level', { task_ids: ids }, { fresh: req.query.fresh === '1' });
    res.json({
      layers: Object.fromEntries(out.rows.map((r) => [r.task_id, { level: String(r.review_level), status: r.status }])),
      cached: out.cached,
      retrievedAt: out.retrievedAt,
      enabled: true,
    });
  } catch (e) {
    res.json({ layers: {}, enabled: true, error: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Backfill export (§6)
// ---------------------------------------------------------------------------

// The only fields the board may overwrite in the wire row. Everything else is
// byte-preserved from _source_row.json — asserted, not assumed.
const WHITELIST_TOP = ['ranking_rationale', 'preference_rating', 'optional_clarification_comments', 'optional_other_comments'];
const WHITELIST_RESULT = ['rank', 'summary'];

function buildRow(dir, live) {
  const source = JSON.parse(fs.readFileSync(path.join(dir, '_source_row.json'), 'utf8'));
  const wire = source['rank.json'] || source.rank_json;
  if (!wire) throw new Error('_source_row.json has no rank.json payload');
  const out = JSON.parse(JSON.stringify(source));
  const rank = out['rank.json'] || out.rank_json;

  for (const f of WHITELIST_TOP) {
    if (live[f] !== undefined) rank[f] = live[f];
  }
  // results keys vary by batch (model_1/model_2 vs codenames) — iterate what
  // the SOURCE row has; never hardcode (§6.2).
  for (const key of Object.keys(rank.results || {})) {
    const liveR = live.results?.[key];
    if (!liveR) continue;
    for (const f of WHITELIST_RESULT) {
      if (liveR[f] !== undefined) rank.results[key][f] = liveR[f];
    }
    for (const dim of Object.keys(rank.results[key].grading || {})) {
      const liveDim = liveR.grading?.[dim];
      if (!liveDim) continue;
      if (liveDim.score !== undefined) rank.results[key].grading[dim].score = liveDim.score;
      if (liveDim.rationale !== undefined) rank.results[key].grading[dim].rationale = liveDim.rationale;
    }
    for (const mode of Object.keys(rank.results[key].failure_modes || {})) {
      if (liveR.failure_modes?.[mode] !== undefined) rank.results[key].failure_modes[mode] = liveR.failure_modes[mode];
    }
  }
  return { out, source };
}

// Whitelist assertion: outside the allowed pointers, the emitted row must be
// byte-identical to the source row (§6.3). Cheap, and it catches a pointer bug
// before platform does.
function assertOutsideUntouched(emitted, source) {
  const strip = (row) => {
    const r = JSON.parse(JSON.stringify(row));
    const rank = r['rank.json'] || r.rank_json;
    for (const f of WHITELIST_TOP) delete rank[f];
    for (const key of Object.keys(rank.results || {})) {
      for (const f of WHITELIST_RESULT) delete rank.results[key][f];
      delete rank.results[key].grading;
      delete rank.results[key].failure_modes;
    }
    return JSON.stringify(r);
  };
  return strip(emitted) === strip(source);
}

stagingApi.get('/backfill', wrap(async (req, res) => {
  const tasks = stagingTasks();
  const rows = [];
  const excluded = [];
  for (const m of tasks) {
    const dir = taskDir(m.bucket, m.id);
    if (m.verdict === 'SBQ') { excluded.push({ id: m.id, reason: 'sbq' }); continue; }
    if (m.pendingFixes > 0) { excluded.push({ id: m.id, reason: 'pending_fixes' }); continue; }
    if (!fs.existsSync(path.join(dir, '_source_row.json'))) { excluded.push({ id: m.id, reason: 'no_source_row' }); continue; }
    try {
      const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
      const { out, source } = buildRow(dir, live);
      if (!assertOutsideUntouched(out, source)) {
        excluded.push({ id: m.id, reason: 'whitelist_assertion_failed' });
        continue;
      }
      rows.push(out);
    } catch (e) {
      excluded.push({ id: m.id, reason: `build_failed: ${e.message}` });
    }
  }
  res.json({
    manifest: {
      generated_at: new Date().toISOString(),
      generated_by: req.user.username,
      lane: 'STAGING',
      tasks: rows.length,
      excluded,
    },
    rows,
  });
}));

// Read endpoint for the eval-side reconciler (§7.5): where every task sits on
// the board, so the quadrant check runs off facts instead of re-deriving them.
stagingApi.get('/status', wrap(async (req, res) => {
  const ws = listWorkspace();
  const items = [];
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const m = taskMeta(bucket, t.id);
      items.push({
        id: m.id,
        severity: bucket,
        lane: laneOf(m),
        verdict: m.verdict || null,
        pendingFixes: m.pendingFixes,
        tags: m.audit?.tags || [],
        backfilledAt: null,
        delivered: m.delivered,
      });
    }
  }
  res.json({ items, generatedAt: new Date().toISOString() });
}));
