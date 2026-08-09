import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { projectHealth } from './health.js';
import { TEAM, personByUsername } from './team.js';

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
// What a person still owes: anything not finished and not currently snoozed.
const isLive = (t) => t.status === 'open' || t.status === 'claimed'
  || (t.status === 'snoozed' && (!t.snoozeUntil || t.snoozeUntil <= new Date().toISOString()));

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_PATH, 'utf8'));
    return Array.isArray(raw?.items) ? raw : { items: [] };
  } catch {
    return { items: [] };
  }
}

function save(state) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(TODOS_PATH, JSON.stringify(state, null, 2));
  return state;
}

const nextId = (items) => `t${Math.max(0, ...items.map((t) => Number(String(t.id).slice(1)) || 0)) + 1}`;

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
        id: nextId(state.items), source: 'auto', signalId: s.id,
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

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
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

export function addTodo({ owner, title, detail = '', severity = 'medium', domain = null, link = null, by }) {
  if (!title?.trim()) throw new Error('title is required');
  if (!personByUsername(owner)) throw new Error(`unknown owner: ${owner}`);
  const state = load();
  const now = new Date().toISOString();
  const item = {
    id: nextId(state.items),
    source: 'manual',
    owner,
    title: title.trim(),
    detail: String(detail || '').trim(),
    severity,
    domain,
    link,
    status: 'open',
    createdBy: by,
    createdAt: now,
    updatedAt: now,
    escalated: false,
  };
  state.items.push(item);
  save(state);
  return item;
}

export function updateTodo(id, { status, owner, note, snoozeDays, by }) {
  const state = load();
  const t = state.items.find((x) => String(x.id) === String(id));
  if (!t) throw new Error(`unknown todo: ${id}`);
  const now = new Date().toISOString();

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
  if (note) t.notes = [...(t.notes || []), { by, at: now, text: String(note).slice(0, 2000) }];

  t.updatedAt = now;
  save(state);
  return t;
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

// Compact form for the model's system prompt and the Overview strip.
export function todoSummary(username) {
  const mine = listTodos().filter((t) => t.owner === username && isLive(t));
  return {
    count: mine.length,
    top: mine
      .sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] ?? 3) - ({ critical: 0, high: 1, medium: 2 }[b.severity] ?? 3))
      .slice(0, 3)
      .map((t) => ({ id: t.id, title: t.title, severity: t.severity, status: t.status })),
  };
}
