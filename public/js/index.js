import { api, el } from '/js/common.js';

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
function assignee(name) {
  if (!name) {
    return el('span', { class: 'assignee none' },
      el('span', { class: 'avatar ghost' }), 'Unassigned');
  }
  return el('span', { class: 'assignee' },
    el('span', { class: 'avatar', style: `background: hsl(${avatarHue(name)} 52% 42%)` }, name[0].toUpperCase()),
    el('span', { class: 'assignee-name' }, name),
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
const searchInput = document.getElementById('task-search');

async function boot() {
  me = await api('/me'); // 401 redirects to login
  document.getElementById('user-chip').hidden = false;
  document.getElementById('user-name').textContent = me.username;
  document.getElementById('user-role').textContent = me.role;
  document.getElementById('ingest-section').hidden = me.role !== 'admin';
  const cfg = await api('/config');
  document.getElementById('config-meta').textContent = cfg.model;
  if (me.role === 'admin') refreshRubricStatus();
  await load();
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
  return el('a', {
    class: `ticket accent-${t.bucket}${seen ? ' seen' : ''}${lane === 'SECOND_OPINION' ? ' attention' : ''}`,
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
      seen ? el('span', { class: 'seen-mark', title: 'seen' }, '✓') : null,
      lane === 'SECOND_OPINION' ? el('span', { class: 'attention-mark', title: 'needs another reviewer' }, '⚠') : null,
    ),
    el('div', { class: 'tid' }, t.id),
    t.problem ? el('div', { class: 'prob' }, t.problem) : null,
    el('div', { class: 'ticket-foot' },
      assignee(t.claimedBy),
      t.verdict ? el('span', { class: `chip v-${t.verdict}` }, VERDICT_LABELS[t.verdict] || t.verdict) : null,
    ),
  );
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const tickets = allTickets().filter((t) =>
    (sevFilter === 'ALL' || t.bucket === sevFilter) &&
    (!q || t.id.toLowerCase().includes(q) || (t.problem || '').toLowerCase().includes(q))
  );
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

  const total = allTickets().length;
  document.getElementById('ws-summary').textContent =
    `${total} tasks · ` + LANES.map((l) => `${l.name.toLowerCase()} ${byLane.get(l.key).length}`).join(' · ');
  document.getElementById('search-count').textContent =
    q || sevFilter !== 'ALL' ? `${tickets.length} shown` : '';
}

searchInput.addEventListener('input', render);

document.getElementById('sev-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.sev-chip');
  if (!btn) return;
  sevFilter = btn.dataset.sev;
  document.querySelectorAll('.sev-chip').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

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
    const skipped = r.skipped_existing?.length ? ` · skipped ${r.skipped_existing.length} already-known task(s)` : '';
    statusEl.textContent = `done — sorted: ${counts}${skipped}`;
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

boot();
