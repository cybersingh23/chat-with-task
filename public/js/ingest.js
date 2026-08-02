import { api } from './common.js';

// Delivery ingest: the drop-zone upload, QC-rubric CSV upload, ingest-by-task-id,
// and the severity-bucket bulk mover.
//
// These used to live on the board, above the lanes, where they cost the top of the
// screen for an action admins take a few times a delivery. They moved to the Admin
// console with the redesign; the code is unchanged, only its host page is.
//
// initIngest() is a no-op on a page without the markup, so it is safe to call from
// anywhere. onChange() runs after a successful ingest so the host can refresh.

export function initIngest({ onChange = () => {} } = {}) {
  const dropZone = document.getElementById('drop-zone');
  if (!dropZone) return;

  const statusEl = document.getElementById('upload-status');
  const progressEl = document.getElementById('upload-progress');
  const barEl = document.getElementById('upload-bar');
  const bucketOf = () => document.getElementById('upload-bucket').value;

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
    form.append('bucket', bucketOf());
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
      else onChange();
    } catch (e) {
      statusEl.textContent = e.message;
      progressEl.hidden = true;
    }
  }

  document.getElementById('pick-folder')?.addEventListener('click', () => document.getElementById('folder-input').click());
  document.getElementById('pick-zip')?.addEventListener('click', () => document.getElementById('zip-input').click());
  document.getElementById('folder-input')?.addEventListener('change', (e) => uploadFiles([...e.target.files]));
  document.getElementById('zip-input')?.addEventListener('change', (e) => uploadFiles([...e.target.files]));

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

  // ---- QC rubric CSV ----
  async function refreshRubricStatus() {
    const el = document.getElementById('rubric-status');
    if (!el) return;
    try {
      const { dimensions } = await api('/spec/rubric');
      el.textContent = dimensions.length ? `${dimensions.length} dimensions loaded` : 'not uploaded yet';
    } catch {
      el.textContent = 'unavailable';
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
      const res = await fetch((window.__base__ || '') + '/api/spec/rubric', {
        method: 'POST', headers: { 'content-type': 'text/csv' }, body: text,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload failed');
      status.textContent = `${data.dimensions} dimensions loaded`;
    } catch (err) {
      status.textContent = err.message;
    }
    e.target.value = '';
  });
  refreshRubricStatus();

  // ---- ingest by task id ----
  document.getElementById('claim-btn')?.addEventListener('click', async () => {
    const status = document.getElementById('claim-status');
    const taskId = document.getElementById('claim-input').value.trim();
    status.textContent = 'searching…';
    try {
      const r = await api('/ingest', { method: 'POST', body: { taskId, bucket: bucketOf() } });
      location.href = `${window.__base__ || ''}/task/${r.bucket}/${r.taskId}`;
    } catch (e) {
      status.textContent = e.message;
    }
  });

  // ---- severity-bucket bulk move (distinct from the board's LANE mover) ----
  const SEV_LABEL = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
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
      status.textContent = r.mode === 'delivered'
        ? `delivered ${r.delivered}${r.notFound?.length ? `, ${r.notFound.length} not found` : ''}`
        : `moved ${r.moved}${r.sameBucket ? `, ${r.sameBucket} already there` : ''}${r.notFound?.length ? `, ${r.notFound.length} not found` : ''}`;
      document.getElementById('bulk-ids').value = '';
      onChange();
    } catch (e) { status.textContent = e.message; }
  });
}
