import { api, el } from '/js/common.js';

const ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];
const EMPTY_HINTS = {
  HARD_FAIL: 'No hard fails claimed.',
  SOFT_FAIL: 'No soft fails claimed.',
  PASS: 'Nothing verified yet.',
  UNSORTED: 'Upload a task to start.',
};

async function load() {
  const [ws, cfg] = await Promise.all([api('/workspace'), api('/config')]);
  document.getElementById('config-meta').textContent = cfg.model;
  const root = document.getElementById('buckets');
  root.replaceChildren();
  for (const bucket of ORDER) {
    const tasks = ws[bucket] || [];
    root.append(
      el('section', { class: `bucket accent-${bucket}` },
        el('div', { class: 'bucket-head' },
          el('span', { class: 'bucket-name' }, bucket.replace('_', ' ')),
          el('span', { class: 'bucket-count' }, String(tasks.length)),
        ),
        tasks.length
          ? tasks.map((t) =>
              el('a', { class: `task-card accent-${bucket}`, href: `/task/${bucket}/${t.id}` },
                el('div', { class: 'tid' }, t.id),
                t.problem ? el('div', { class: 'prob' }, t.problem) : null,
                el('div', { class: 'pills' },
                  pill('review', t.hasReview),
                  pill('remediation', t.hasRemediation),
                  pill('seed', t.hasAuditSeed),
                  pill('chat', t.hasChat),
                ),
              )
            )
          : el('div', { class: 'bucket-empty' }, EMPTY_HINTS[bucket]),
      )
    );
  }
}

function pill(label, on) {
  return el('span', { class: `pill ${on ? 'on' : ''}` }, `${on ? '✓' : '·'} ${label}`);
}

// ---------- folder / zip upload ----------
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
    // webkitRelativePath keeps the folder structure; plain files (zip) use the name.
    form.append('files', f, f.webkitRelativePath || f.name);
    total += f.size;
  }
  statusEl.textContent = `uploading ${files.length} file(s), ${(total / 1e6).toFixed(1)} MB…`;
  progressEl.hidden = false;
  barEl.style.width = '0%';
  try {
    const r = await uploadFormData(form);
    statusEl.textContent = `done — ${r.taskId} (${r.files} files${r.seeded ? ', audit seed attached' : ''})`;
    location.href = `/task/${r.bucket}/${r.taskId}`;
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
  const files = await collectDropped(e.dataTransfer);
  uploadFiles(files);
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

// ---------- secondary: claim by id ----------
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

load();
