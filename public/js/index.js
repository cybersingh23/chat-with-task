import { api, el, cap, startTour } from '/js/common.js';

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
  { key: 'REVIEW', name: 'In review', hint: 'Claimed and being audited.' },
  { key: 'SECOND_OPINION', name: 'Needs 2nd opinion', hint: 'Flagged for another reviewer.' },
  { key: 'RESOLVED', name: 'Resolved', hint: 'A decision has been recorded.' },
];

function laneOf(t) {
  if (t.verdict === 'SECOND_OPINION') return 'SECOND_OPINION';
  if (t.verdict && RESOLVED_VERDICTS.has(t.verdict)) return 'RESOLVED';
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
  if (laneOf(t) === target) return;
  const setVerdict = (v) => api(`/task/${bucket}/${id}/verdict`, { method: 'POST', body: { verdict: v } });
  try {
    if (target === 'SECOND_OPINION') {
      await setVerdict('SECOND_OPINION');
    } else if (target === 'RESOLVED') {
      const v = await pickResolution(x, y); // 3-way: which decision?
      if (!v) return;
      await setVerdict(v);
    } else if (target === 'REVIEW') {
      await setVerdict(null);
      if (!t.claimedBy) await api(`/task/${bucket}/${id}/claim`, { method: 'POST' });
    } else if (target === 'OPEN') {
      await setVerdict(null);
      if (t.claimedBy) await api(`/task/${bucket}/${id}/release`, { method: 'POST' }).catch((e) => toast(e.message));
    }
  } catch (e) {
    toast(e.message);
  }
  await load();
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
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
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
    href: `/task/${t.bucket}/${t.id}`,
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
  const byLane = new Map(LANES.map((l) => [l.key, []]));
  for (const t of tickets) byLane.get(laneOf(t)).push(t);

  const root = document.getElementById('lanes');
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
        ),
        items.length
          ? el('div', { class: 'lane-body' }, items.map(ticketCard))
          : el('div', { class: 'lane-empty' }, q || sevFilter !== 'ALL' ? 'No match.' : lane.hint),
      );
    })
  );

  const total = allTickets().filter((t) => !t.delivered && !t.tour).length;
  document.getElementById('ws-summary').textContent =
    `${total} tasks · ` + LANES.map((l) => `${l.name.toLowerCase()} ${byLane.get(l.key).length}`).join(' · ');
  document.getElementById('search-count').textContent =
    q || sevFilter !== 'ALL' ? `${tickets.length} shown` : '';
}

// Show/hide the delivered toggle based on how many tasks are soft-archived.
function updateDeliveredToggle() {
  const n = allTickets().filter((t) => t.delivered).length;
  const btn = document.getElementById('toggle-delivered');
  btn.hidden = n === 0;
  btn.textContent = showDelivered ? `Hide delivered (${n})` : `Show delivered (${n})`;
  btn.classList.toggle('on', showDelivered);
}
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
    const res = await fetch('/api/spec/rubric', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    status.textContent = `${data.dimensions} dimensions loaded`;
  } catch (err) {
    status.textContent = err.message;
  }
  e.target.value = '';
});


document.getElementById('export-csv').addEventListener('click', () => { location.href = '/api/export/all.csv'; });
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
  location.href = '/login.html';
});

// ---------- admin: delivery upload ----------
const statusEl = document.getElementById('upload-status');
const progressEl = document.getElementById('upload-progress');
const barEl = document.getElementById('upload-bar');
const dropZone = document.getElementById('drop-zone');

function uploadFormData(form) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
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
    if (r.ingested?.length === 1) location.href = `/task/${r.bucket}/${r.taskId}`;
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
    location.href = `/task/${r.bucket}/${r.taskId}`;
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
  location.href = `/task/${d.bucket}/${d.id}`;
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
