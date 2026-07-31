import express from 'express';
import { config } from '../config.js';
import { requireAdmin } from '../auth.js';
import {
  redashEnabled, runSaved, runAdhoc, getQuery, searchQueries,
  listDataSources, ping, queryUrl, clearRedashCache, RedashError,
} from '../redash.js';
import { describeRegistry, runRegistryQuery } from '../redash_registry.js';
import { taskPipeline, boardPipeline, pipelineOverview } from '../pipeline.js';

// /api/redash/* — mounted inside the authenticated api router, so every route
// here already requires a session. Ad-hoc SQL additionally requires admin.
export const redashApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Every route past this point needs a working key; fail with a clear message
// rather than a confusing 502 from the first upstream call.
redashApi.use((req, res, next) => {
  if (req.path === '/status') return next();
  if (!redashEnabled()) return next(new RedashError('Redash is not configured (REDASH_API_KEY unset)', 503));
  next();
});

// Is Redash wired up, and as whom? Drives the "connected" chip in the UI.
redashApi.get('/status', wrap(async (req, res) => {
  if (!redashEnabled()) return res.json({ enabled: false });
  try {
    const who = await ping();
    res.json({
      enabled: true,
      baseUrl: config.redash.baseUrl,
      dataSourceId: config.redash.dataSourceId,
      projectId: config.redash.projectId,
      adhocAllowed: config.redash.allowAdhoc,
      ...who,
    });
  } catch (e) {
    // A bad/expired key shouldn't 502 the page — report it as not-connected.
    res.json({ enabled: true, connected: false, error: e.message });
  }
}));

redashApi.get('/registry', (req, res) => res.json({ queries: describeRegistry() }));

// Run a curated registry query by name. Params come from the body.
redashApi.post('/run/:name', wrap(async (req, res) => {
  const out = await runRegistryQuery(req.params.name, req.body?.params || {}, { fresh: !!req.body?.fresh });
  res.json(out);
}));

// ---- blended board + pipeline views ----

redashApi.get('/task/:taskId', wrap(async (req, res) => {
  res.json(await taskPipeline(req.params.taskId, { fresh: req.query.fresh === '1' }));
}));

redashApi.get('/overview', wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(await pipelineOverview({ days, fresh: req.query.fresh === '1' }));
}));

redashApi.get('/board', wrap(async (req, res) => {
  res.json(await boardPipeline({ scope: req.query.scope, fresh: req.query.fresh === '1' }));
}));

// ---- query browser ----

redashApi.get('/search', wrap(async (req, res) => {
  res.json(await searchQueries({
    q: String(req.query.q || ''),
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(100, Number(req.query.pageSize) || 25),
    mine: req.query.mine === '1',
  }));
}));

redashApi.get('/data-sources', wrap(async (req, res) => res.json({ dataSources: await listDataSources() })));

redashApi.get('/query/:id', wrap(async (req, res) => {
  const q = await getQuery(req.params.id);
  res.json({ ...q, url: queryUrl(q.id) });
}));

// Run a published Redash query by id, with its declared parameters.
redashApi.post('/query/:id/run', wrap(async (req, res) => {
  const out = await runSaved(Number(req.params.id), req.body?.parameters || {}, { fresh: !!req.body?.fresh });
  res.json(out);
}));

// ---- ad-hoc SQL (admin only) ----

// Defence in depth: the browser box is admin-gated and the data source should be
// read-only anyway, but a typo'd DELETE shouldn't be able to reach Snowflake.
// Comments and string literals are stripped first so a keyword inside a quoted
// string ("-- drop table" in a comment, 'DELETE' as a value) doesn't false-trip.
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|copy|call|execute|use|set)\b/i;

export function assertReadOnly(sql) {
  const original = String(sql).trim();

  // Analysis copy ONLY: comments and string literals are blanked so a keyword
  // written inside them can't trip the checks below. It is never executed —
  // running it would silently rewrite the user's string literals to ''.
  const stripped = original
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');

  // Reject stacked statements: anything after the first ; that isn't whitespace.
  const semi = stripped.indexOf(';');
  if (semi !== -1 && stripped.slice(semi + 1).trim()) {
    throw new RedashError('only a single statement is allowed', 400);
  }
  const body = (semi === -1 ? stripped : stripped.slice(0, semi)).trim();
  if (!/^(with|select)\b/i.test(body)) {
    throw new RedashError('only SELECT / WITH queries are allowed', 400);
  }
  const hit = FORBIDDEN.exec(body);
  if (hit) throw new RedashError(`statement keyword not allowed here: ${hit[1].toUpperCase()}`, 400);

  // Hand back the ORIGINAL text (minus a trailing semicolon), so literals and
  // comments survive into the query that actually runs.
  return original.replace(/;\s*$/, '');
}

redashApi.post('/adhoc', requireAdmin, wrap(async (req, res) => {
  if (!config.redash.allowAdhoc) throw new RedashError('ad-hoc SQL is disabled (REDASH_ALLOW_ADHOC=false)', 403);
  const sql = assertReadOnly(String(req.body?.sql || ''));
  const dsId = Number(req.body?.dataSourceId) || config.redash.dataSourceId;
  res.json(await runAdhoc(dsId, sql, { fresh: !!req.body?.fresh }));
}));

redashApi.post('/cache/clear', requireAdmin, wrap(async (req, res) => res.json({ cleared: clearRedashCache() })));
