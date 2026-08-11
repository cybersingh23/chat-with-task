import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { projectHealth } from './health.js';
import { TEAM, personByUsername } from './team.js';
import { writeJsonAtomic } from './fixes.js';

// Everybody's todos, in one file, with the auto-generated ones kept honest.
//
// Two sources, one list:
//   auto    derived from a health signal. Created when the signal fires, and
//           CLOSED AUTOMATICALLY when it stops firing — because a list that only
//           grows is a list people stop reading. The close is recorded as
//           'resolved' rather than 'done' so nobody gets credit for a number that
//           moved on its own, and so a signal that comes back is visibly a
//           recurrence rather than a fresh problem.
//   manual  typed by a person. Never auto-closed; the data cannot see onsites,
//           guideline rewrites or a course that needs updating.
//
// State lives in DATA_DIR/todos.json (gitignored, same as users.json). Small
// enough that read-modify-write of the whole file is the right call — this is
// tens of rows, not thousands, and it keeps the file readable by hand.

const TODOS_PATH = path.join(config.dataDir, 'todos.json');

const STATUSES = new Set(['open', 'claimed', 'snoozed', 'done', 'resolved']);

// Priorities are deadlines, not adjectives:
//   p00  THE most pressing item — at most one open at a time
//   p0   asap
//   p1   by end of day
//   p2   within 2-3 days
// The file predates this scale, so legacy names normalize on load and on any
// write: critical was asap, high was same-day, medium was this-week-ish.
export const SEVERITIES = ['p00', 'p0', 'p1', 'p2'];
const LEGACY_SEV = { critical: 'p0', high: 'p1', medium: 'p2', low: 'p2' };
// Case-insensitive on purpose: 'P0' from a caller is a casing difference, not a
// different priority, and silently flooring it to p2 was a demotion nobody
// asked for. Genuinely unknown values still floor to p2.
export const normSev = (x) => {
  const s = String(x ?? '').trim().toLowerCase();
  return SEVERITIES.includes(s) ? s : (LEGACY_SEV[s] || 'p2');
};

// P00 is exclusive by definition. Crowning a new one demotes every other open
// P00 to P0 — latest crown wins — rather than erroring into a two-step dance.
function enforceSingleP00(items, keepId) {
  const demoted = [];
  for (const t of items) {
    if (t.severity !== 'p00' || String(t.id) === String(keepId)) continue;
    if (t.status === 'done' || t.status === 'resolved') continue;
    t.severity = 'p0';
    t.updatedAt = new Date().toISOString();
    demoted.push({ id: t.id, title: t.title });
  }
  return demoted;
}
// What a person still owes: anything not finished and not currently snoozed.
const isLive = (t) => t.status === 'open' || t.status === 'claimed'
  || (t.status === 'snoozed' && (!t.snoozeUntil || t.snoozeUntil <= new Date().toISOString()));

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_PATH, 'utf8'));
    const state = Array.isArray(raw?.items) ? raw : { items: [] };
    for (const t of state.items) {
      t.severity = normSev(t.severity);
      // demoted rides on write responses only; older builds persisted it.
      delete t.demoted;
    }
    // Monotonic id counter. max+1 seeds files that predate it; it never goes
    // down, so a deleted id is never reused and a stale #t<id> deep link stays
    // dead instead of flashing whatever card inherited the number.
    const maxSeen = Math.max(0, ...state.items.map((t) => Number(String(t.id).slice(1)) || 0));
    state.next_id = Math.max(Number(state.next_id) || 0, maxSeen + 1);
    return state;
  } catch {
    return { items: [], next_id: 1 };
  }
}

function save(state) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  writeJsonAtomic(TODOS_PATH, state);
  return state;
}

const nextId = (state) => `t${state.next_id++}`;

// ---------------------------------------------------------------------------
// Sync: reconcile the auto todos against the current signals
// ---------------------------------------------------------------------------

export async function syncFromHealth({ fresh = false } = {}) {
  const health = await projectHealth({ fresh });
  const state = load();
  const now = new Date().toISOString();
  const live = new Map(health.signals.map((s) => [s.id, s]));

  let created = 0, updated = 0, resolved = 0, reopened = 0;

  for (const s of health.signals) {
    const existing = state.items.find((t) => t.source === 'auto' && t.signalId === s.id);
    const fields = {
      owner: s.owner,
      escalated: s.escalated,
      unrouted: s.unrouted,
      domain: s.domain,
      severity: s.severity,
      title: s.title,
      detail: s.detail,
      metric: s.metric,
      link: s.link,
      updatedAt: now,
    };

    if (!existing) {
      state.items.push({
        id: nextId(state), source: 'auto', signalId: s.id,
        status: 'open', createdAt: now, ...fields,
      });
      created += 1;
      continue;
    }

    // A signal that fires again after being auto-resolved is a RECURRENCE, and
    // saying so matters — "this came back" is a different conversation from
    // "this is new". A todo someone marked done by hand is left alone: they
    // acted, and the metric may simply lag.
    if (existing.status === 'resolved') {
      existing.status = 'open';
      existing.recurrences = (existing.recurrences || 0) + 1;
      existing.reopenedAt = now;
      reopened += 1;
    }
    // Refresh the numbers in place so a claimed todo shows today's figure, not
    // the one from whenever it was created.
    Object.assign(existing, fields);
    updated += 1;
  }

  // Signals that stopped firing.
  for (const t of state.items) {
    if (t.source !== 'auto' || live.has(t.signalId)) continue;
    if (t.status === 'done' || t.status === 'resolved') continue;
    t.status = 'resolved';
    t.resolvedAt = now;
    t.resolvedBy = 'signal cleared';
    t.updatedAt = now;
    resolved += 1;
  }

  save(state);
  return { health, changes: { created, updated, resolved, reopened } };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listTodos({ includeClosed = false } = {}) {
  const items = load().items;
  return includeClosed ? items : items.filter((t) => t.status !== 'done' && t.status !== 'resolved');
}

// Grouped by person, in team order, with the escalation list computed separately
// so a cross-cutting item appears BOTH with its owner and on the escalation
// list — the owner still has the work; the escalation is a second pair of eyes.
export function board({ includeClosed = false } = {}) {
  const all = load().items;
  const items = includeClosed ? all : all.filter((t) => t.status !== 'done' && t.status !== 'resolved');
  const byOwner = new Map(TEAM.map((p) => [p.username, []]));
  for (const t of items) {
    if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
    byOwner.get(t.owner).push(t);
  }

  const rank = { p00: 0, p0: 1, p1: 2, p2: 3 };
  const sort = (list) => list.sort((a, b) =>
    (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
    || String(a.createdAt).localeCompare(String(b.createdAt)));

  // Completion is tracked per owner over the trailing week, from the full file
  // regardless of the includeClosed filter — "3 open · 4 closed this week" is
  // the difference between a queue that is stuck and one that is churning.
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const doneWeek = (username) => all.filter((t) => t.owner === username
    && (t.status === 'done' || t.status === 'resolved')
    && String(t.doneAt || t.resolvedAt || t.updatedAt) >= weekAgo).length;

  return {
    people: TEAM.map((p) => ({
      ...p,
      todos: sort(byOwner.get(p.username) || []),
      live: (byOwner.get(p.username) || []).filter(isLive).length,
      doneWeek: doneWeek(p.username),
    })),
    escalated: sort(items.filter((t) => t.escalated)),
    unowned: sort(items.filter((t) => !personByUsername(t.owner))),
    total: items.length,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function addTodo({ owner, title, detail = '', severity = 'p2', domain = null, link = null, by }) {
  if (!title?.trim()) throw new Error('title is required');
  if (!personByUsername(owner)) throw new Error(`unknown owner: ${owner}`);
  const state = load();
  const now = new Date().toISOString();
  const item = {
    id: nextId(state),
    source: 'manual',
    owner,
    title: title.trim(),
    detail: String(detail || '').trim(),
    severity: normSev(severity),
    domain,
    link,
    status: 'open',
    createdBy: by,
    createdAt: now,
    updatedAt: now,
    escalated: false,
  };
  state.items.push(item);
  // Who lost the crown rides on the response only — assigning it onto the item
  // would freeze a stale list into todos.json.
  const demoted = item.severity === 'p00' ? enforceSingleP00(state.items, item.id) : [];
  save(state);
  return { ...item, demoted };
}

export function updateTodo(id, { status, owner, severity, note, snoozeDays, by }) {
  const state = load();
  const t = state.items.find((x) => String(x.id) === String(id));
  if (!t) throw new Error(`unknown todo: ${id}`);
  const now = new Date().toISOString();
  let demoted = [];

  if (status) {
    if (!STATUSES.has(status)) throw new Error(`unknown status: ${status}`);
    // 'resolved' is reserved for the sync pass — a person marking something
    // finished is 'done', and the distinction is what keeps the two apart in
    // any later read of this file.
    if (status === 'resolved') throw new Error("use 'done'; 'resolved' is set by the health sync");
    t.status = status;
    if (status === 'claimed') { t.claimedBy = by; t.claimedAt = now; }
    if (status === 'done') { t.doneBy = by; t.doneAt = now; }
    if (status === 'open') { t.claimedBy = null; t.snoozeUntil = null; }
    if (status === 'snoozed') {
      const days = Math.min(30, Math.max(1, Number(snoozeDays) || 7));
      t.snoozeUntil = new Date(Date.now() + days * 86400e3).toISOString();
      t.snoozedBy = by;
    }
  }
  if (owner) {
    if (!personByUsername(owner)) throw new Error(`unknown owner: ${owner}`);
    t.owner = owner;
    t.reassignedBy = by;
  }
  if (severity) {
    t.severity = normSev(severity);
    // The response says who lost the crown, so the UI can explain the demotion
    // instead of the board just looking different. Response-only: assigning it
    // onto the item would persist a stale list into todos.json.
    if (t.severity === 'p00') demoted = enforceSingleP00(state.items, t.id);
  }
  if (note) t.notes = [...(t.notes || []), { by, at: now, text: String(note).slice(0, 2000) }];

  t.updatedAt = now;
  save(state);
  return { ...t, demoted };
}

export function deleteTodo(id) {
  const state = load();
  const before = state.items.length;
  // Auto todos are not deletable: the signal would just recreate one on the next
  // sync, and a row that reappears after being deleted reads as a bug. Snooze or
  // complete them instead.
  const t = state.items.find((x) => String(x.id) === String(id));
  if (t?.source === 'auto') throw new Error('auto todos cannot be deleted — snooze or complete it instead');
  state.items = state.items.filter((x) => String(x.id) !== String(id));
  save(state);
  return { deleted: before - state.items.length };
}

// Undo for a delete: reinsert the exact item the client was holding when it
// deleted. A re-POST of the visible fields would mint a new id (breaking #t<id>
// deep links) and drop notes/claim/history. The monotonic counter means the old
// id is still free; a fresh one is minted only on an actual collision.
export function restoreTodo(item) {
  if (!item?.title?.trim()) throw new Error('title is required');
  if (!personByUsername(item.owner)) throw new Error(`unknown owner: ${item.owner}`);
  const state = load();
  const t = { ...item, severity: normSev(item.severity) };
  delete t.demoted;
  if (!t.id || state.items.some((x) => String(x.id) === String(t.id))) t.id = nextId(state);
  // Keep the counter ahead of a restored id that outruns it (hand-edited file).
  const n = Number(String(t.id).slice(1)) || 0;
  if (n >= state.next_id) state.next_id = n + 1;
  state.items.push(t);
  save(state);
  return t;
}

// Compact form for the model's system prompt and the Overview strip.
export function todoSummary(username) {
  const mine = listTodos().filter((t) => t.owner === username && isLive(t));
  return {
    count: mine.length,
    top: mine
      .sort((a, b) => ({ p00: 0, p0: 1, p1: 2, p2: 3 }[a.severity] ?? 4) - ({ p00: 0, p0: 1, p1: 2, p2: 3 }[b.severity] ?? 4))
      .slice(0, 3)
      .map((t) => ({ id: t.id, title: t.title, severity: t.severity, status: t.status })),
  };
}
