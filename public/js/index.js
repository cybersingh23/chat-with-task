import { api, el, cap, startTour } from './common.js';

const ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];
const VERDICT_LABELS = {
  NO_ISSUES: 'No Issues',
  FIXES_MADE: 'Fixes made',
  SBQ: 'SBQ',
  SECOND_OPINION: 'Second Opinion Needed',
};
const SEV_LABEL = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
// Workflow lanes — derived from claim + decision state. A decision marks a
// ticket "seen" (Resolved), except Second Opinion which stays in its own lane.
const RESOLVED_VERDICTS = new Set(['NO_ISSUES', 'FIXES_MADE', 'SBQ']);
const LANES = [
  { key: 'OPEN', name: 'Open', hint: 'Unclaimed, no decision yet.' },
  {
    key: 'GRAMMAR',
    name: 'Grammar Fixes',
    hint: 'Tasks whose only fail is spelling/grammar (R23/R24). Drop a task here when everything else is fixed.',
  },
  { key: 'REVIEW', name: 'In review', hint: 'Claimed and being audited.' },
  { key: 'SECOND_OPINION', name: 'Needs 2nd opinion', hint: 'Flagged for another reviewer.' },
  { key: 'RESOLVED', name: 'Resolved', hint: 'A decision has been recorded.' },
];

// Grammar Fixes sits ahead of the claim check on purpose: these are bulk-fixed
// locally rather than claimed one at a time, so claiming one doesn't pull it out
// of the lane. Recording a verdict does.
function laneOf(t) {
  if (t.verdict === 'SECOND_OPINION') return 'SECOND_OPINION';
  if (t.verdict && RESOLVED_VERDICTS.has(t.verdict)) return 'RESOLVED';
  if (t.inGrammarLane) return 'GRAMMAR';
  if (t.claimedBy) return 'REVIEW';
  return 'OPEN';
}

// Assignee avatar: a colored initial (deterministic per name) + the name.
// Unclaimed shows a dashed placeholder.
function avatarHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
// Claim straight from the board without opening the task (opening = view only).
// stopPropagation/preventDefault so the click doesn't follow the card link.
function claimAction(t) {
  return el('span', {
    class: 'card-claim', role: 'button', title: 'assign this task to you',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await api(`/task/${t.bucket}/${t.id}/claim`, { method: 'POST' }); }
      catch (err) { toast(err.message); }
      load();
    },
  }, el('span', { class: 'avatar ghost' }), 'Claim');
}

function assignee(name) {
  if (!name) {
    return el('span', { class: 'assignee none' },
      el('span', { class: 'avatar ghost' }), 'Unassigned');
  }
  return el('span', { class: 'assignee' },
    el('span', { class: 'avatar', style: `background: hsl(${avatarHue(name)} 52% 42%)` }, name[0].toUpperCase()),
    el('span', { class: 'assignee-name' }, cap(name)),
  );
}

// ---------- drag-and-drop between lanes = workflow transition ----------
let dragging = null;

async function applyLaneChange(t, target, x, y) {
  const { bucket, id } = t;
  const from = laneOf(t);
  if (from === target) return;
  // Decide the resulting state first (RESOLVED asks which decision).
  let verdict = null, claim = null;
  if (target === 'SECOND_OPINION') verdict = 'SECOND_OPINION';
  else if (target === 'RESOLVED') { verdict = await pickResolution(x, y); if (!verdict) return; }
  else if (target === 'REVIEW') { verdict = null; claim = 'claim'; }
  else if (target === 'OPEN') { verdict = null; claim = t.claimedBy ? 'release' : null; }

  // Optimistically update the card in place + render once — no full refetch, no flash/jump.
  // The server derives the same state from the target lane; this is just the preview.
  const orig = (currentWs[bucket] || []).find((x2) => x2.id === id);
  if (orig) {
    orig.verdict = verdict;
    if (claim === 'claim') orig.claimedBy = me?.username || orig.claimedBy;
    if (claim === 'release') orig.claimedBy = null;
    if (target === 'GRAMMAR') { orig.grammarLane = 'in'; orig.inGrammarLane = true; }
    else if (from === 'GRAMMAR') { orig.grammarLane = orig.grammarOnly ? 'out' : null; orig.inGrammarLane = false; }
  }
  render();

  // One journaled call: the server works out verdict + claim + grammar override
  // from the destination lane, so the drag is a single undoable action.
  try {
    const r = await api(`/task/${bucket}/${id}/lane`, { method: 'POST', body: { lane: target, verdict } });
    refreshBulkCount();
    refreshActions();
    if (r.action) toast(`Moved to ${LANES.find((l) => l.key === target)?.name || target}.`, { label: 'Undo', run: () => undo(r.action.id) });
  } catch (e) {
    toast(e.message);
    await load();
  }
}

// Bulk-complete the whole Grammar Fixes lane: these get fixed locally in one pass,
// so the lane needs one action rather than 27 individual decisions.
async function completeGrammarLane(items) {
  if (!items.length) return;
  if (!confirm(`Mark ${items.length} grammar-fix task${items.length === 1 ? '' : 's'} as Fixes made?\n\nThey move to Resolved. Undo from Recent actions.`)) return;
  for (const t of items) {
    const orig = (currentWs[t.bucket] || []).find((x) => x.id === t.id);
    if (orig) orig.verdict = 'FIXES_MADE';
  }
  render();
  try {
    const r = await api('/bulk/lane', {
      method: 'POST',
      body: { fromLane: 'GRAMMAR', toLane: 'RESOLVED', verdict: 'FIXES_MADE' },
    });
    await load();
    if (r.action) toast(`${r.moved} task${r.moved === 1 ? '' : 's'} marked Fixes made.`, { label: 'Undo', run: () => undo(r.action.id) });
  } catch (e) {
    toast(e.message);
    await load();
  }
}

// Resolved is a 3-way decision — ask which one at the drop point.
function pickResolution(x, y) {
  return new Promise((resolve) => {
    const choose = (v) => { cleanup(); resolve(v); };
    const menu = el('div', { class: 'drop-menu glass' },
      el('div', { class: 'drop-menu-title' }, 'Mark resolved as'),
      el('button', { onclick: () => choose('NO_ISSUES') }, 'No Issues'),
      el('button', { onclick: () => choose('FIXES_MADE') }, 'Fixes made'),
      el('button', { onclick: () => choose('SBQ') }, 'SBQ'),
      el('button', { class: 'cancel', onclick: () => choose(null) }, 'Cancel'),
    );
    menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
    document.body.append(menu);
    const onAway = (e) => { if (!menu.contains(e.target)) choose(null); };
    function cleanup() { menu.remove(); document.removeEventListener('mousedown', onAway); }
    setTimeout(() => document.addEventListener('mousedown', onAway), 0);
  });
}

let toastTimer;
// action: optional { label, run } — renders an inline button (used for Undo), and
// holds the toast open longer so there's time to reach it.
function toast(msg, action = null) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
  t.replaceChildren(
    el('span', {}, msg),
    action
      ? el('button', {
        class: 'toast-action',
        onclick: () => { t.classList.remove('show'); action.run(); },
      }, action.label)
      : null,
  );
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 9000 : 3200);
}

let me = null;
let currentWs = {};
let sevFilter = 'ALL';
let showDelivered = false; // delivered tasks are soft-archived: hidden from the board for everyone
const searchInput = document.getElementById('task-search');

async function boot() {
  me = await api('/me'); // 401 redirects to login
  document.getElementById('user-chip').hidden = false;
  document.getElementById('user-name').textContent = me.username;
  document.getElementById('user-role').textContent = me.role;
  document.getElementById('ingest-section').hidden = me.role !== 'admin';
  document.getElementById('admin-link').hidden = me.role !== 'admin';
  document.getElementById('clear-board').hidden = me.role !== 'admin';
  document.getElementById('gen-all').hidden = me.role !== 'admin';
  if (me.role === 'admin') pollGenStatus(); // reflect any in-flight batch on load
  if (me.role === 'admin') refreshRubricStatus();
  const q = new URLSearchParams(location.search).get('q');
  if (q) searchInput.value = q;
  await load();
  moveSlider();
  setInterval(load, 8000); // live claim/verdict status from other reviewers
}

async function load() {
  currentWs = await api('/workspace');
  render();
}

// Flatten the workspace into tickets carrying their bucket (= severity).
function allTickets() {
  const out = [];
  for (const bucket of ORDER) for (const t of currentWs[bucket] || []) out.push({ ...t, bucket });
  return out;
}

function ticketCard(t) {
  const lane = laneOf(t);
  const seen = lane === 'RESOLVED';
  const card = el('a', {
    class: `ticket accent-${t.bucket}${seen ? ' seen' : ''}${lane === 'SECOND_OPINION' ? ' attention' : ''}${t.delivered ? ' delivered' : ''}${t.tour ? ' tour-card' : ''}`,
    href: `${window.__base__ || ''}/task/${t.bucket}/${t.id}`,
    draggable: 'true',
    ondragstart: (e) => {
      dragging = t;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id); // Firefox needs data set
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => { dragging = null; e.currentTarget.classList.remove('dragging'); },
  },
    el('div', { class: 'ticket-top' },
      el('span', { class: `sev-tag accent-${t.bucket}` }, SEV_LABEL[t.bucket]),
      t.tour ? el('span', { class: 'tour-tag', title: 'temporary tour sandbox — deleted when the tour ends' }, 'sandbox') : null,
      seen ? el('span', { class: 'seen-mark', title: 'seen' }, '✓') : null,
      lane === 'SECOND_OPINION' ? el('span', { class: 'attention-mark', title: 'needs another reviewer' }, '⚠') : null,
      t.delivered ? el('span', { class: 'delivered-mark', title: `delivered${t.deliveredAt ? ' ' + t.deliveredAt.slice(0, 10) : ''}` }, 'delivered') : null,
    ),
    el('div', { class: 'tid' }, t.id),
    t.problem ? el('div', { class: 'prob' }, t.problem) : null,
    lane === 'SECOND_OPINION' && t.verdictNote
      ? el('div', { class: 'card-why', title: t.verdictNote }, el('span', { class: 'card-why-tag' }, 'Why'), t.verdictNote)
      : null,
    el('div', { class: 'ticket-foot' },
      t.claimedBy ? assignee(t.claimedBy) : claimAction(t),
      t.grammar
        ? el('span', {
          class: 'chip grammar-chip',
          title: t.grammarOnly
            ? `Spelling/Grammar is the only fail (${(t.qcDims || []).join(', ')}) — auto-routed to Grammar Fixes`
            : `Spelling/Grammar flagged, but not the only fail — also ${(t.otherDims || []).join(', ')}`,
        }, '✎ Spelling/Grammar')
        : null,
      lane === 'GRAMMAR' && t.grammarLane === 'in'
        ? el('span', { class: 'chip manual-chip', title: 'moved here by hand, not auto-detected' }, 'moved in')
        : null,
      t.verdict ? el('span', { class: `chip v-${t.verdict}` }, VERDICT_LABELS[t.verdict] || t.verdict) : null,
    ),
  );
  if (t.tour) card.id = 'tour-dummy-card';
  return card;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const tickets = allTickets().filter((t) =>
    (!t.tour || t.tourOwner === me?.username) && // sandbox tasks show only to their owner
    (showDelivered || !t.delivered) &&
    (sevFilter === 'ALL' || t.bucket === sevFilter) &&
    (!q || t.id.toLowerCase().includes(q) || (t.problem || '').toLowerCase().includes(q))
  );
  updateDeliveredToggle();
  updateArchiveBtn();
  const byLane = new Map(LANES.map((l) => [l.key, []]));
  for (const t of tickets) byLane.get(laneOf(t)).push(t);

  const root = document.getElementById('lanes');
  // Preserve each lane's scroll position across the 8s auto-refresh (and any re-render),
  // so scrolling down into a lane doesn't snap back to the top.
  const prevScroll = {};
  root.querySelectorAll('.lane').forEach((l) => {
    const k = (l.className.match(/lane-([A-Z_]+)/) || [])[1];
    const b = l.querySelector('.lane-body');
    if (k && b) prevScroll[k] = b.scrollTop;
  });
  root.replaceChildren(
    ...LANES.map((lane) => {
      const items = byLane.get(lane.key);
      return el('section', {
        class: `lane lane-${lane.key}`,
        ondragover: (e) => {
          if (!dragging || laneOf(dragging) === lane.key) return;
          e.preventDefault();
          e.currentTarget.classList.add('drop-target');
        },
        ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-target'); },
        ondrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('drop-target');
          if (dragging) applyLaneChange(dragging, lane.key, e.clientX, e.clientY);
        },
      },
        el('div', { class: 'lane-head' },
          el('span', { class: 'lane-name' }, lane.name),
          el('span', { class: 'lane-count' }, String(items.length)),
          lane.key === 'GRAMMAR' && items.length
            ? el('button', {
              class: 'lane-action', title: 'Mark every task in this lane as Fixes made',
              onclick: (e) => { e.preventDefault(); completeGrammarLane(items); },
            }, 'Mark all fixed')
            : null,
        ),
        items.length
          ? el('div', { class: 'lane-body' }, items.map(ticketCard))
          : el('div', { class: 'lane-empty' }, q || sevFilter !== 'ALL' ? 'No match.' : lane.hint),
      );
    })
  );
  // restore the per-lane scroll captured above
  root.querySelectorAll('.lane').forEach((l) => {
    const k = (l.className.match(/lane-([A-Z_]+)/) || [])[1];
    const b = l.querySelector('.lane-body');
    if (k && b && prevScroll[k]) b.scrollTop = prevScroll[k];
  });

  const total = allTickets().filter((t) => !t.delivered && !t.tour).length;
  document.getElementById('ws-summary').textContent =
    `${total} tasks · ` + LANES.map((l) => `${l.name.toLowerCase()} ${byLane.get(l.key).length}`).join(' · ');
  document.getElementById('search-count').textContent =
    q || sevFilter !== 'ALL' ? `${tickets.length} shown` : '';
  refreshBulkCount();
}

// Show/hide the delivered toggle based on how many tasks are soft-archived.
function updateDeliveredToggle() {
  const n = allTickets().filter((t) => t.delivered).length;
  const btn = document.getElementById('toggle-delivered');
  btn.hidden = n === 0;
  btn.textContent = showDelivered ? `Hide delivered (${n})` : `Show delivered (${n})`;
  btn.classList.toggle('on', showDelivered);
}

// "Completed" = the Resolved workflow lane (any recorded decision), independent of
// severity — archiving sorts by completion status, NOT by Pass/Fail.
function completedTasks() {
  return allTickets().filter((t) => !t.tour && !t.delivered && t.verdict && RESOLVED_VERDICTS.has(t.verdict));
}
function updateArchiveBtn() {
  const btn = document.getElementById('archive-completed');
  if (!btn) return;
  const n = completedTasks().length;
  btn.hidden = me?.role !== 'admin' || n === 0; // admin-only; nothing completed → nothing to archive
  btn.textContent = `📦 Archive completed (${n})`;
}
async function archiveCompleted() {
  const status = document.getElementById('bv-status');
  const done = completedTasks();
  if (!done.length) return;
  if (!confirm(`Archive ${done.length} completed task${done.length === 1 ? '' : 's'} — everything in the Resolved lane, any severity? They leave the board but stay searchable in the Archive, and a restorable backup zip is built.`)) return;
  status.textContent = 'archiving…';
  try {
    const r = await api('/admin/deliver', { method: 'POST', body: { taskIds: done.map((t) => t.id) } });
    await load();
    status.textContent = `archived ${r.delivered}`;
    setTimeout(() => { status.textContent = ''; }, 2600);
  } catch (e) { status.textContent = e.message; }
}
document.getElementById('archive-completed')?.addEventListener('click', archiveCompleted);
document.getElementById('toggle-delivered').addEventListener('click', () => {
  showDelivered = !showDelivered;
  render();
});

searchInput.addEventListener('input', render);

const sevSlider = document.getElementById('sev-slider');
function moveSlider() {
  const active = document.querySelector('.sev-chip.active');
  if (!active) return;
  sevSlider.style.left = `${active.offsetLeft}px`;
  sevSlider.style.width = `${active.offsetWidth}px`;
}
document.getElementById('sev-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.sev-chip');
  if (!btn) return;
  sevFilter = btn.dataset.sev;
  document.querySelectorAll('.sev-chip').forEach((b) => b.classList.toggle('active', b === btn));
  moveSlider();
  render();
});
window.addEventListener('resize', moveSlider);

// ---------- admin: QC rubric upload ----------
async function refreshRubricStatus() {
  try {
    const { dimensions } = await api('/spec/rubric');
    const n = dimensions.length;
    document.getElementById('rubric-status').textContent = n ? `${n} dimensions loaded` : 'not uploaded yet';
  } catch {
    document.getElementById('rubric-status').textContent = 'unavailable';
  }
}

document.getElementById('rubric-upload-btn')?.addEventListener('click', () => document.getElementById('rubric-input').click());
document.getElementById('rubric-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('rubric-status');
  status.textContent = 'uploading…';
  try {
    const text = await file.text();
    const res = await fetch((window.__base__ || '') + '/api/spec/rubric', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    status.textContent = `${data.dimensions} dimensions loaded`;
  } catch (err) {
    status.textContent = err.message;
  }
  e.target.value = '';
});


document.getElementById('export-csv').addEventListener('click', () => { location.href = (window.__base__ || '') + '/api/export/all.csv'; });

// ---------- bulk lane move: {severity, source lane} → any lane ----------
const bvSev = document.getElementById('bv-sev');
const bvFrom = document.getElementById('bv-from');
const bvTo = document.getElementById('bv-to');
const bvCount = document.getElementById('bv-count');

// "RESOLVED:FIXES_MADE" → the lane plus the verdict that lane needs.
function bulkTarget() {
  const [lane, verdict = null] = (bvTo?.value || '').split(':');
  return { lane, verdict };
}

// Which tasks the current selection would actually move. Mirrors the server's
// selectTasks + "skip anything already there", so the count matches what happens.
function bulkMatches() {
  const sev = bvSev?.value || 'ALL';
  const from = bvFrom?.value || 'ANY';
  const { lane: to } = bulkTarget();
  // Reopen isn't a lane — it clears the verdict, so the no-op test is "has no verdict".
  const noop = (t) => (to === 'REOPEN' ? !t.verdict : laneOf(t) === to);
  return allTickets().filter((t) =>
    !t.tour && !t.delivered &&
    (sev === 'ALL' || t.bucket === sev) &&
    (from === 'ANY' || laneOf(t) === from) &&
    !noop(t)
  );
}

function refreshBulkCount() {
  if (!bvCount) return;
  const n = bulkMatches().length;
  bvCount.textContent = String(n);
  bvCount.classList.toggle('zero', n === 0);
  const apply = document.getElementById('bv-apply');
  if (apply) apply.disabled = n === 0;
}
[bvSev, bvFrom, bvTo].forEach((s) => s?.addEventListener('change', refreshBulkCount));

document.getElementById('bv-apply')?.addEventListener('click', async () => {
  const status = document.getElementById('bv-status');
  const { lane, verdict } = bulkTarget();
  const matches = bulkMatches();
  const toLabel = bvTo.selectedOptions[0].textContent.trim();
  const fromLabel = bvFrom.selectedOptions[0].textContent.trim().toLowerCase();
  const sevLabel = bvSev.value === 'ALL' ? '' : `${bvSev.selectedOptions[0].textContent.trim()} `;
  if (!matches.length) { status.textContent = 'nothing to move'; setTimeout(() => { status.textContent = ''; }, 2600); return; }
  if (!confirm(`Move ${matches.length} ${sevLabel}task${matches.length === 1 ? '' : 's'} in ${fromLabel} → “${toLabel}”?\n\nThis changes the lane for everyone. Undo from Recent actions.`)) return;
  status.textContent = 'moving…';
  try {
    const r = await api('/bulk/lane', {
      method: 'POST',
      body: { severity: bvSev.value, fromLane: bvFrom.value, toLane: lane, verdict },
    });
    status.textContent = `moved ${r.moved}`;
    await load();
    if (r.action) toast(`Moved ${r.moved} task${r.moved === 1 ? '' : 's'}.`, { label: 'Undo', run: () => undo(r.action.id) });
    setTimeout(() => { status.textContent = ''; }, 2600);
  } catch (e) { status.textContent = e.message; }
});

// ---------- action journal: recent actions + undo ----------
async function undo(id) {
  try {
    const r = await api(`/actions/${id}/undo`, { method: 'POST' });
    await load();
    const skipped = r.skipped?.length
      ? ` · ${r.skipped.length} skipped (changed since)`
      : '';
    toast(`Reverted ${r.undone} task${r.undone === 1 ? '' : 's'}${skipped}.`);
  } catch (e) { toast(e.message); }
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

async function refreshActions() {
  const body = document.getElementById('acts-body');
  if (!body || !document.getElementById('acts')?.open) return;
  let actions;
  try { ({ actions } = await api('/actions?limit=12')); } catch { return; }
  body.replaceChildren(
    ...(actions.length
      ? actions.map((a) => el('div', { class: `act${a.undone ? ' is-undone' : ''}` },
        el('span', { class: 'act-when' }, ago(a.at)),
        el('span', { class: 'act-who' }, cap(a.by)),
        el('span', { class: 'act-label' }, a.label),
        a.undone
          ? el('span', { class: 'act-undone' }, 'undone')
          : el('button', { class: 'act-undo', onclick: () => undo(a.id) }, 'Undo'),
      ))
      : [el('div', { class: 'act-empty' }, 'No lane changes yet.')])
  );
}
document.getElementById('acts')?.addEventListener('toggle', refreshActions);
// generate review+remediation for every task missing them, as background jobs
let genPoll = null;
document.getElementById('gen-all').addEventListener('click', async () => {
  if (!confirm('Generate review + remediation for every task that is missing them? This runs in the background and can take a while / use significant tokens on large batches.')) return;
  const r = await api('/admin/gendocs', { method: 'POST', body: { onlyMissing: true } });
  document.getElementById('search-count').textContent = `queued ${r.queued} task(s) for doc generation…`;
  pollGenStatus();
});
async function pollGenStatus() {
  clearInterval(genPoll); genPoll = null;
  const sc = document.getElementById('search-count');
  const tick = async () => {
    let s;
    try { s = await api('/admin/gendocs/status'); } catch { return; }
    if (!s.busy) {
      clearInterval(genPoll); genPoll = null;
      const done = s.counts.done || 0, err = s.counts.error || 0;
      if (done || err) { sc.textContent = `doc generation done · ${done} ok${err ? ` · ${err} failed` : ''}`; await load(); }
      return;
    }
    sc.textContent = `generating docs · running ${s.active} · queued ${s.queued}`;
  };
  await tick();
  if (!genPoll) genPoll = setInterval(tick, 4000);
}

document.getElementById('clear-board').addEventListener('click', async () => {
  const total = ORDER.reduce((n, b) => n + (currentWs[b]?.length || 0), 0);
  if (!confirm(`Clear all ${total} task uploads from the board? This cannot be undone (claims, decisions, and generated docs are removed). Use this to start a fresh delivery cycle.`)) return;
  const { cleared } = await api('/admin/clear', { method: 'POST' });
  await load();
  document.getElementById('search-count').textContent = `cleared ${cleared}`;
});
// ---------- admin: bulk move ----------
document.getElementById('bulk-move-btn')?.addEventListener('click', async () => {
  const ids = document.getElementById('bulk-ids').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const fromBucket = document.getElementById('bulk-from').value;
  const toSel = document.getElementById('bulk-to').value;
  const status = document.getElementById('bulk-status');
  if (!ids.length && !fromBucket) { status.textContent = 'paste IDs or pick a source bucket'; return; }
  const body = {};
  if (ids.length) body.taskIds = ids;
  if (fromBucket) body.fromBucket = fromBucket;
  if (toSel === '__delivered') body.delivered = true; else body.to = toSel;

  const src = [fromBucket ? `all ${SEV_LABEL[fromBucket]}` : null, ids.length ? `${ids.length} pasted ID(s)` : null].filter(Boolean).join(' + ');
  const dest = toSel === '__delivered' ? 'delivered (hidden from board)' : SEV_LABEL[toSel];
  if (!confirm(`Move ${src} → ${dest}?`)) return;

  status.textContent = 'moving…';
  try {
    const r = await api('/admin/bulk-move', { method: 'POST', body });
    if (r.mode === 'delivered') {
      status.textContent = `delivered ${r.delivered}${r.notFound?.length ? `, ${r.notFound.length} not found` : ''}`;
    } else {
      status.textContent = `moved ${r.moved}${r.sameBucket ? `, ${r.sameBucket} already there` : ''}${r.notFound?.length ? `, ${r.notFound.length} not found` : ''}`;
    }
    document.getElementById('bulk-ids').value = '';
    await load();
  } catch (e) { status.textContent = e.message; }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = (window.__base__ || '') + '/login.html';
});

// ---------- admin: delivery upload ----------
const statusEl = document.getElementById('upload-status');
const progressEl = document.getElementById('upload-progress');
const barEl = document.getElementById('upload-bar');
const dropZone = document.getElementById('drop-zone');

function uploadFormData(form) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', (window.__base__ || '') + '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) barEl.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        xhr.status < 400 ? resolve(data) : reject(new Error(data.error || `upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.send(form);
  });
}

async function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  form.append('bucket', document.getElementById('upload-bucket').value);
  let total = 0;
  for (const f of files) {
    form.append('files', f, f.webkitRelativePath || f.name);
    total += f.size;
  }
  statusEl.textContent = `uploading ${files.length} file(s), ${(total / 1e6).toFixed(1)} MB…`;
  progressEl.hidden = false;
  barEl.style.width = '0%';
  try {
    const r = await uploadFormData(form);
    const counts = Object.entries(r.counts || {}).map(([b, n]) => `${b} ${n}`).join(', ') || 'none';
    const replaced = r.replaced?.length ? ` · replaced ${r.replaced.length} existing` : '';
    const reopened = r.reopened?.length ? ` · reopened ${r.reopened.length} for re-audit` : '';
    statusEl.textContent = `done — sorted: ${counts}${replaced}${reopened}`;
    progressEl.hidden = true;
    if (r.ingested?.length === 1) location.href = `${window.__base__ || ''}/task/${r.bucket}/${r.taskId}`;
    else load();
  } catch (e) {
    statusEl.textContent = e.message;
    progressEl.hidden = true;
  }
}

document.getElementById('pick-folder').addEventListener('click', () => document.getElementById('folder-input').click());
document.getElementById('pick-zip').addEventListener('click', () => document.getElementById('zip-input').click());
document.getElementById('folder-input').addEventListener('change', (e) => uploadFiles([...e.target.files]));
document.getElementById('zip-input').addEventListener('change', (e) => uploadFiles([...e.target.files]));

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  uploadFiles(await collectDropped(e.dataTransfer));
});

// Dropped folders need the webkitGetAsEntry tree walk to recover relative paths.
async function collectDropped(dt) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push(new File([file], file.name, { type: file.type }));
      Object.defineProperty(out[out.length - 1], 'webkitRelativePath', { value: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  for (const entry of entries) await walk(entry, '');
  return out;
}

// ---------- admin: ingest by id ----------
document.getElementById('claim-btn').addEventListener('click', async () => {
  const status = document.getElementById('claim-status');
  const taskId = document.getElementById('claim-input').value.trim();
  const bucket = document.getElementById('upload-bucket').value;
  status.textContent = 'searching…';
  try {
    const r = await api('/ingest', { method: 'POST', body: { taskId, bucket } });
    location.href = `${window.__base__ || ''}/task/${r.bucket}/${r.taskId}`;
  } catch (e) {
    status.textContent = e.message;
  }
});

// ---------- guided tour (interactive, on a disposable sandbox task) ----------
function tourTask() { try { return JSON.parse(sessionStorage.getItem('cwt_tour_task') || 'null'); } catch { return null; } }
function postTourLog(entry) { api('/tour/log', { method: 'POST', body: entry }).catch(() => {}); }
function endTourCleanup() {
  sessionStorage.removeItem('cwt_tour_task');
  api('/tour/end', { method: 'POST' }).catch(() => {});
  load();
}
// Best-effort cleanup if they close the tab mid-tour.
window.addEventListener('beforeunload', () => {
  if (sessionStorage.getItem('cwt_tour_task') && !sessionStorage.getItem('cwt_tour_resume')) {
    navigator.sendBeacon?.('/api/tour/end');
  }
});

function openTaskForTour() {
  const d = tourTask();
  if (!d) return false;
  sessionStorage.setItem('cwt_tour_resume', '1'); // task page resumes the same tour
  location.href = `${window.__base__ || ''}/task/${d.bucket}/${d.id}`;
  return true; // intercept: navigating (don't run onExit cleanup)
}

const BOARD_TOUR = [
  { title: 'Welcome to ACC Audit Studio 👋', body: 'A hands-on tour — you\'ll actually try things on a private sandbox task (marked "sandbox"). Nothing you do here is real; it\'s deleted when the tour ends. Use Next / Back or ← →, Esc to leave.' },
  { selector: '.board-controls', title: 'Find & filter tasks', body: 'Search by task ID or problem text, and filter by severity — Hard, Soft, or Pass. Invaluable when a delivery drops hundreds of tasks at once.' },
  { selector: '.lanes', title: 'Your workflow board', body: 'Every task sits in a lane that reflects its state: Open → In review → (Needs 2nd opinion) → Resolved. It\'s the shared source of truth for who\'s doing what.' },
  { selector: '#tour-dummy-card', pin: 'top', title: 'Try it: drag & drop 🖱️', body: 'The drag IS the action — no forms. Grab your highlighted "sandbox" card (in the Soft column) and drag it into another lane: drop in Resolved to pick a decision, "Needs 2nd opinion" to flag it, or "In review" to claim it. Go ahead — I\'ll wait.',
    try: { action: 'drag_drop', hint: 'Waiting for you to drag the sandbox card into another lane…', verify: verifyDragged } },
  { selector: '.lane-SECOND_OPINION', title: 'Second opinions, with the "why"', body: 'Tasks flagged for another reviewer land here — and the key issue the first reviewer wrote shows right on the card, so whoever picks it up knows the crux instantly.' },
  { selector: '#drop-zone', title: 'Upload a delivery', body: 'Admins: drop a tasks .zip or a <task_id> folder. Tasks auto-sort into Hard / Soft / Pass, and re-uploading a task that was SBQ or Fixes-made reopens it for re-audit so nothing silently ships twice.' },
  { selector: '#bulk-move', title: 'Bulk move', body: 'Admins: paste a list of task IDs and/or move an entire bucket in one shot — to another bucket, or straight to "delivered".' },
  { selector: '#export-csv', title: 'Export', body: 'Pull the whole board as CSV; each lane also exports just its task IDs.' },
  { title: 'Now the fun part — the task itself', body: 'The board is the map; the task page is where you actually audit: trajectories, the annotator\'s grading, and an AI copilot. Let me open your sandbox task and keep going.', nextLabel: 'Open the task ▸', onNext: openTaskForTour },
];

async function verifyDragged() {
  const d = tourTask();
  if (!d) return false;
  try { const s = await api(`/task/${d.bucket}/${d.id}/state`); return !!(s.verdict || s.claimed_by); }
  catch { return false; }
}

async function startBoardTour() {
  let dummy = null;
  try { dummy = await api('/tour/start', { method: 'POST' }); } catch { /* run read-only if sandbox fails */ }
  if (dummy) sessionStorage.setItem('cwt_tour_task', JSON.stringify(dummy));
  await load(); // surface the sandbox card
  startTour(BOARD_TOUR, { onExit: endTourCleanup, onLog: postTourLog });
}
document.getElementById('tour-btn')?.addEventListener('click', startBoardTour);

boot();
