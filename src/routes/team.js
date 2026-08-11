import express from 'express';
import { TEAM, teamBrief } from '../team.js';
import { projectHealth } from '../health.js';
import { board, addTodo, updateTodo, deleteTodo, restoreTodo, syncFromHealth, todoSummary } from '../todos.js';

// /api/team/* — the team board: project health, and everybody's todos.
//
// Mounted inside the authenticated api router, so every route already has a
// session. Deliberately NOT admin-gated: the point is that each owner can see
// and work their own list, and see everyone else's, without going through one
// person.
export const teamApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The board, with the auto todos reconciled against live signals first.
//
// The sync runs on read rather than on a timer: a page nobody is looking at does
// not need its signals refreshed, and a stale board is worse than a slow one.
// `?sync=0` skips it for the cheap poll case.
teamApi.get('/board', wrap(async (req, res) => {
  let health = null;
  let changes = null;
  if (req.query.sync !== '0') {
    ({ health, changes } = await syncFromHealth({ fresh: req.query.fresh === '1' }));
  } else {
    health = await projectHealth({});
  }
  res.json({
    ...board({ includeClosed: req.query.closed === '1' }),
    health,
    changes,
    me: req.user.username,
    mine: todoSummary(req.user.username),
  });
}));

// Health on its own, for the Overview strip — no todo reconciliation, no writes.
teamApi.get('/health', wrap(async (req, res) => {
  res.json(await projectHealth({ fresh: req.query.fresh === '1' }));
}));

teamApi.get('/roster', (req, res) => res.json({ team: TEAM, brief: teamBrief() }));

// The Overview page's action-items block reads THE SAME board the Team page
// renders — one source, deep-linked, never a derived copy that can drift. Pure
// file read: no health sync, no Redash, safe on every page load.
teamApi.get('/items', (req, res) => res.json(board({})));

// What the signed-in person still owes. Cheap enough for the Overview page to
// call on every load.
teamApi.get('/mine', wrap(async (req, res) => {
  res.json({ me: req.user.username, ...todoSummary(req.user.username) });
}));

teamApi.post('/todos', wrap(async (req, res) => {
  const { owner, title, detail, severity, domain, link } = req.body || {};
  res.json(addTodo({ owner, title, detail, severity, domain, link, by: req.user.username }));
}));

// Undo for a delete: the client sends back the whole item it was holding and it
// is reinserted verbatim — same id, notes and history intact.
teamApi.post('/todos/restore', wrap(async (req, res) => {
  res.json(restoreTodo(req.body || {}));
}));

teamApi.patch('/todos/:id', wrap(async (req, res) => {
  const { status, owner, severity, note, snoozeDays } = req.body || {};
  res.json(updateTodo(req.params.id, { status, owner, severity, note, snoozeDays, by: req.user.username }));
}));

teamApi.delete('/todos/:id', wrap(async (req, res) => {
  res.json(deleteTodo(req.params.id));
}));
