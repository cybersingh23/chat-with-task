import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { laneSnapshot, applySnapshot } from './state.js';
import { httpError } from './workspace.js';

// Append-only journal of every lane change, so any of them can be reverted.
//
// Each record carries the BEFORE and AFTER state of each task it touched, rather
// than just "the previous lane". That is what makes undo correct for a selection
// whose members started in different states (a bulk move from "any lane" is the
// normal case) — a single previous-lane value could not rebuild verdict +
// claimed_by + grammar_lane per task.
//
// On disk, not an in-memory stack: this server restarts often, several reviewers
// share one board, and the file doubles as a who-did-what history. Same shape and
// home as DATA_DIR/usage.jsonl.
//
// An undo is journaled as its own record pointing at what it reverted, so the log
// stays strictly append-only and undoing an undo is a redo for free.
const LOG = () => path.join(config.dataDir, 'actions.jsonl');
const READ_TAIL = 400; // records parsed for listing/lookup — plenty for a session

function append(rec) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(LOG(), JSON.stringify(rec) + '\n');
  return rec;
}

function readAll() {
  let raw;
  try { raw = fs.readFileSync(LOG(), 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean).slice(-READ_TAIL);
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* skip a torn line rather than 500 */ }
  }
  return out;
}

function newId() {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// items: [{bucket, id, before:{...}, after:{...}}]
export function recordAction({ by, kind, label, items, undoes = null }) {
  if (!items?.length) return null;
  return append({ id: newId(), at: new Date().toISOString(), by, kind, label, undoes, items });
}

// Newest first, each annotated with whether a later record already reverted it.
export function listActions(limit = 12) {
  const all = readAll();
  const undone = new Set(all.map((a) => a.undoes).filter(Boolean));
  return all
    .slice()
    .reverse()
    .filter((a) => a.kind !== 'undo')
    .slice(0, limit)
    .map((a) => ({
      id: a.id, at: a.at, by: a.by, kind: a.kind, label: a.label,
      count: a.items.length, undone: undone.has(a.id),
    }));
}

// Revert an action by writing each item's `before` back.
//
// A task whose current state no longer matches what we recorded as `after` was
// changed by someone else since; we skip it and report it rather than silently
// overwriting a newer decision.
export function undoAction(id, username) {
  const all = readAll();
  const act = all.find((a) => a.id === id);
  if (!act) throw httpError(404, `no such action ${id} (only the last ${READ_TAIL} are kept)`);
  if (all.some((a) => a.undoes === id)) throw httpError(409, 'that action was already undone');

  const same = (a, b) => a.verdict === b.verdict && a.claimed_by === b.claimed_by && a.grammar_lane === b.grammar_lane;
  const items = [], skipped = [];
  for (const it of act.items) {
    let cur;
    try { cur = laneSnapshot(it.bucket, it.id); } catch { skipped.push({ id: it.id, why: 'task is gone' }); continue; }
    if (!same(cur, it.after)) { skipped.push({ id: it.id, why: 'changed since' }); continue; }
    applySnapshot(it.bucket, it.id, it.before, username);
    items.push({ bucket: it.bucket, id: it.id, before: cur, after: it.before });
  }
  if (items.length) {
    append({
      id: newId(), at: new Date().toISOString(), by: username, kind: 'undo',
      label: `undo · ${act.label}`, undoes: id, items,
    });
  }
  return { undone: items.length, skipped, label: act.label };
}
