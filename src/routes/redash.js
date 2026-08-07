import express from 'express';
import { config } from '../config.js';
import { requireAdmin } from '../auth.js';
import {
  redashEnabled, runSaved, runAdhoc, getQuery, searchQueries,
  listDataSources, ping, queryUrl, clearRedashCache, RedashError, assertReadOnly,
} from '../redash.js';
import { describeRegistry, runRegistryQuery } from '../redash_registry.js';
import { taskPipeline, boardPipeline, pipelineOverview } from '../pipeline.js';
import { qualitySnapshot } from '../quality.js';

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

// The pipeline's own view of the people producing the work: QMS tiers, the
// week-over-week slippers, and the reviewer scorecard. Three queries rolled up
// server-side so the tier mix and the action list can never describe different
// populations.
redashApi.get('/quality', wrap(async (req, res) => {
  res.json(await qualitySnapshot({
    fresh: req.query.fresh === '1',
    days: Math.min(365, Math.max(1, Number(req.query.days) || 30)),
    windowDays: Math.min(90, Math.max(1, Number(req.query.windowDays) || 7)),
    level: Number.isInteger(Number(req.query.level)) ? Number(req.query.level) : 0,
  }));
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

// assertReadOnly now lives in src/redash.js so the copilot's run_sql tool passes
// through the same gate. Re-exported here because that is where it was, and
// callers should not have to care that it moved.
export { assertReadOnly };

redashApi.post('/adhoc', requireAdmin, wrap(async (req, res) => {
  if (!config.redash.allowAdhoc) throw new RedashError('ad-hoc SQL is disabled (REDASH_ALLOW_ADHOC=false)', 403);
  const sql = assertReadOnly(String(req.body?.sql || ''));
  const dsId = Number(req.body?.dataSourceId) || config.redash.dataSourceId;
  res.json(await runAdhoc(dsId, sql, { fresh: !!req.body?.fresh }));
}));

redashApi.post('/cache/clear', requireAdmin, wrap(async (req, res) => res.json({ cleared: clearRedashCache() })));
