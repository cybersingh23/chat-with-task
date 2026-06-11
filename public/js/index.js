import { api, el } from '/js/common.js';

const ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];
const EMPTY_HINTS = {
  HARD_FAIL: 'No hard fails.',
  SOFT_FAIL: 'No soft fails.',
  PASS: 'Nothing in pass.',
  UNSORTED: 'Nothing unsorted.',
};
const VERDICT_LABELS = {
  NO_ISSUES: 'No issues',
  SBQ: 'SBQ',
  FIXES_IN_PROGRESS: 'Fixes in progress',
  SECOND_OPINION: 'Second opinion',
};

let me = null;

async function boot() {
  me = await api('/me'); // 401 redirects to login
  document.getElementById('user-chip').hidden = false;
  document.getElementById('user-name').textContent = me.username;
  document.getElementById('user-role').textContent = me.role;
  document.getElementById('ingest-section').hidden = me.role !== 'admin';
  const cfg = await api('/config');
  document.getElementById('config-meta').textContent = cfg.model;
  await load();
  setInterval(load, 8000); // live claim/verdict status from other reviewers
}

async function load() {
  const ws = await api('/workspace');
  const root = document.getElementById('buckets');
  const total = ORDER.reduce((n, b) => n + (ws[b]?.length || 0), 0);
  document.getElementById('ws-summary').textContent =
    `${total} tasks · ` + ORDER.map((b) => `${b.replace('_FAIL', '').toLowerCase()} ${ws[b]?.length || 0}`).join(' · ');
  root.replaceChildren();
  for (const bucket of ORDER) {
    const tasks = ws[bucket] || [];
    root.append(
      el('section', { class: `bucket accent-${bucket}` },
        el('div', { class: 'bucket-head' },
          el('span', { class: 'bucket-name' }, bucket.replace('_', ' ')),
          el('span', { class: 'bucket-count' }, String(tasks.length)),
          el('button', {
            class: 'bucket-dl', title: 'download task_id list for this column',
            onclick: () => { location.href = `/api/export/ids/${bucket}`; },
          }, 'ids ↓'),
        ),
        tasks.length
          ? tasks.map((t) =>
              el('a', { class: `task-card accent-${bucket}`, href: `/task/${bucket}/${t.id}` },
                el('div', { class: 'tid' }, t.id),
                t.problem ? el('div', { class: 'prob' }, t.problem) : null,
                el('div', { class: 'pills' },
                  t.claimedBy ? el('span', { class: 'chip claimed' }, t.claimedBy) : null,
                  t.verdict ? el('span', { class: `chip v-${t.verdict}` }, VERDICT_LABELS[t.verdict] || t.verdict) : null,
                  docmark('review', t.hasReview),
                  docmark('remediation', t.hasRemediation),
                ),
              )
            )
          : el('div', { class: 'bucket-empty' }, EMPTY_HINTS[bucket]),
      )
    );
  }
}

function docmark(label, on) {
  return el('span', { class: `docmark ${on ? 'on' : ''}`, title: on ? `${label}.md generated` : `no ${label}.md yet` }, label);
}

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
