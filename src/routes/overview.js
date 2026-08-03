import express from 'express';
import { buildBrief, fullBrief, inflightMatchups, getSummary, clearSummaryCache, ptNow, deliveryPhase } from '../overview.js';

// /api/overview/* — mounted inside the authenticated api router.
//
// Two endpoints on purpose. The brief is fast (cached Redash results) and the
// page renders entirely from it; the summary is a model call that can take
// seconds. Splitting them means the charts paint immediately and the prose
// arrives after, rather than the whole page waiting on the LLM.
export const overviewApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const windowDays = (req) => Math.min(180, Math.max(7, Number(req.query.days) || 30));

overviewApi.get('/brief', wrap(async (req, res) => {
  res.json(await fullBrief({ fresh: req.query.fresh === '1', days: windowDays(req) }));
}));

// Every in-flight task with its A/B matchup, plus level and matchup facets. The
// client filters against these in memory — a few hundred rows — so toggling a
// layer is instant instead of a round trip.
overviewApi.get('/inflight', wrap(async (req, res) => {
  res.json(await inflightMatchups({ fresh: req.query.fresh === '1' }));
}));

overviewApi.get('/summary', wrap(async (req, res) => {
  const brief = await buildBrief({ days: windowDays(req) });
  const summary = await getSummary(brief, { refresh: req.query.refresh === '1' });
  // The deterministic headline goes back either way, so the client can render a
  // useful card even when the model call failed.
  res.json({ ...summary, headline: brief.calendar.headline, phase: brief.calendar.phase });
}));

// Cheap enough to poll: no upstream calls, just the delivery clock. Lets the page
// re-evaluate the greeting across a phase boundary without refetching the brief.
overviewApi.get('/clock', (req, res) => {
  const now = ptNow();
  res.json({ now, calendar: deliveryPhase(now) });
});

overviewApi.post('/summary/clear', (req, res) => res.json({ cleared: clearSummaryCache() }));
