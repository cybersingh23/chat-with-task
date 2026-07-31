import { api, el, mount } from './common.js';

// In-app Redash browser: run the curated registry, search/run any saved Redash
// query, and (admin only) run read-only ad-hoc SQL — without leaving the studio.
// The API key never reaches this page; every call goes through /api/redash/*.

let me = null;
let lastResult = null;
let lastLabel = 'redash';

const fmtCell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function setPane(tab) {
  for (const b of document.querySelectorAll('#rq-tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of ['curated', 'browse', 'sql']) document.getElementById(`pane-${p}`).hidden = p !== tab;
}

// ---------- results ----------

function renderResult(res, label) {
  lastResult = res;
  lastLabel = label;
  const out = document.getElementById('rq-out');
  const table = document.getElementById('rq-table');
  out.hidden = false;

  document.getElementById('rq-out-meta').textContent =
    `${res.rowCount} row${res.rowCount === 1 ? '' : 's'}` +
    (res.runtime ? ` · ${res.runtime.toFixed(1)}s` : '') +
    (res.cached ? ' · cached' : '') +
    (res.retrievedAt ? ` · ${new Date(res.retrievedAt).toLocaleTimeString()}` : '');

  if (!res.rowCount) {
    table.replaceChildren(el('tr', {}, el('td', { class: 'empty' }, 'No rows.')));
    return;
  }
  const cols = res.columns.map((c) => c.name);
  const head = el('tr', {}, ...cols.map((c) => el('th', {}, c)));
  // Cap the DOM at 500 rows; CSV export still gets everything returned.
  const rows = res.rows.slice(0, 500).map((r) =>
    el('tr', {}, ...cols.map((c) => el('td', { title: fmtCell(r[c]) }, fmtCell(r[c]).slice(0, 300)))));
  table.replaceChildren(head, ...rows);
  if (res.rowCount > 500) {
    table.append(el('tr', {}, el('td', { class: 'empty', colspan: String(cols.length) },
      `showing first 500 of ${res.rowCount} rows — download the CSV for all of them`)));
  }
}

function toCsv(res) {
  const cols = res.columns.map((c) => c.name);
  const esc = (v) => {
    const s = fmtCell(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...res.rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

document.getElementById('rq-csv').addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([toCsv(lastResult)], { type: 'text/csv' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `${lastLabel.replace(/[^\w.-]+/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:]/g, '-')}.csv`,
  });
  document.body.append(a);
  a.click();
  a.remove();
});

async function run(label, fn) {
  const out = document.getElementById('rq-out');
  out.hidden = false;
  document.getElementById('rq-out-meta').textContent = 'running…';
  document.getElementById('rq-table').replaceChildren(el('tr', {}, el('td', { class: 'empty' }, 'Querying Redash…')));
  try {
    renderResult(await fn(), label);
  } catch (e) {
    document.getElementById('rq-out-meta').textContent = 'failed';
    document.getElementById('rq-table').replaceChildren(el('tr', {}, el('td', { class: 'empty' }, e.message)));
  }
}

// ---------- curated registry ----------

async function loadRegistry() {
  const { queries } = await api('/redash/registry');
  const host = document.getElementById('rq-registry');
  host.replaceChildren(...queries.map((q) => {
    const inputs = new Map();
    const fields = q.params.map((p) => {
      const input = el('input', {
        class: 'mono', type: 'text',
        placeholder: p.type === 'taskIdList' ? '24-hex task ids, comma/space separated' : String(p.default ?? p.type),
        value: p.default != null && p.type !== 'taskIdList' ? String(p.default) : '',
      });
      inputs.set(p.name, input);
      return el('label', { class: 'rq-field' },
        el('span', {}, p.name + (p.required ? ' *' : '')), input);
    });
    return el('div', { class: 'rq-card glass' },
      el('div', { class: 'rq-card-head' },
        el('div', { class: 'rq-card-name' }, q.label),
        el('span', { class: 'rq-card-src mono' }, q.source)),
      el('div', { class: 'rq-card-desc' }, q.description),
      ...fields,
      el('div', { class: 'rq-card-actions' },
        el('button', {
          class: 'primary',
          onclick: () => {
            const params = {};
            for (const [k, input] of inputs) if (input.value.trim()) params[k] = input.value.trim();
            run(q.name, () => api(`/redash/run/${q.name}`, { method: 'POST', body: { params } }));
          },
        }, 'Run')));
  }));
}

// ---------- browse Redash ----------

async function search(page = 1) {
  const q = document.getElementById('rq-search').value.trim();
  const mine = document.getElementById('rq-mine').checked ? '&mine=1' : '';
  const table = document.getElementById('rq-results');
  table.replaceChildren(el('tr', {}, el('td', { class: 'empty' }, 'Searching…')));
  try {
    const res = await api(`/redash/search?q=${encodeURIComponent(q)}&page=${page}${mine}`);
    const head = el('tr', {}, ...['ID', 'Name', 'Owner', 'Updated', ''].map((h) => el('th', {}, h)));
    const rows = res.results.map((r) =>
      el('tr', {},
        el('td', { class: 'mono' }, String(r.id)),
        el('td', {}, r.name || '(untitled)', r.isDraft ? el('span', { class: 'rq-draft' }, 'draft') : null),
        el('td', { class: 'rq-dim' }, r.user || '—'),
        el('td', { class: 'rq-dim' }, (r.updatedAt || '').slice(0, 10)),
        el('td', {}, el('button', { class: 'quiet', onclick: () => openQuery(r.id) }, 'Open'))));
    table.replaceChildren(head, ...rows);
    if (!rows.length) table.append(el('tr', {}, el('td', { class: 'empty', colspan: '5' }, 'No queries matched.')));

    const pages = Math.ceil(res.count / res.pageSize);
    mount(document.getElementById('rq-pager'),
      el('span', { class: 'rq-dim' }, `${res.count.toLocaleString()} queries · page ${res.page} of ${pages.toLocaleString()}`),
      res.page > 1 ? el('button', { class: 'quiet', onclick: () => search(res.page - 1) }, '‹ prev') : null,
      res.page < pages ? el('button', { class: 'quiet', onclick: () => search(res.page + 1) }, 'next ›') : null,
    );
  } catch (e) {
    table.replaceChildren(el('tr', {}, el('td', { class: 'empty' }, e.message)));
  }
}

async function openQuery(id) {
  const detail = document.getElementById('rq-detail');
  detail.hidden = false;
  document.getElementById('rq-detail-title').textContent = `Query ${id}`;
  const body = document.getElementById('rq-detail-body');
  body.replaceChildren(el('div', { class: 'rq-dim' }, 'Loading…'));
  try {
    const q = await api(`/redash/query/${id}`);
    document.getElementById('rq-detail-title').textContent = q.name || `Query ${id}`;
    const inputs = new Map();
    const fields = q.parameters.map((p) => {
      const input = el('input', { class: 'mono', type: 'text', value: p.value ?? '' });
      inputs.set(p.name, input);
      return el('label', { class: 'rq-field' }, el('span', {}, p.title || p.name), input);
    });
    body.replaceChildren(
      el('div', { class: 'rq-meta' },
        el('span', { class: 'mono' }, `#${q.id}`),
        el('span', {}, `data source ${q.dataSourceId}`),
        q.user ? el('span', {}, q.user) : null,
        q.isDraft ? el('span', { class: 'rq-draft' }, 'draft') : null,
        el('a', { href: q.url, target: '_blank', class: 'rq-open' }, 'open in Redash ↗')),
      ...fields,
      el('div', { class: 'rq-card-actions' },
        el('button', {
          class: 'primary',
          onclick: () => {
            const parameters = {};
            for (const [k, input] of inputs) parameters[k] = input.value;
            run(q.name || `query_${id}`, () => api(`/redash/query/${id}/run`, { method: 'POST', body: { parameters } }));
          },
        }, 'Run')),
      el('pre', { class: 'rq-sqlview mono' }, q.query || ''),
    );
  } catch (e) {
    body.replaceChildren(el('div', { class: 'rq-dim' }, e.message));
  }
}

// ---------- ad-hoc SQL (admin) ----------

async function initSqlPane() {
  document.getElementById('rq-tab-sql').hidden = false;
  const sel = document.getElementById('rq-ds');
  try {
    const { dataSources } = await api('/redash/data-sources');
    const status = await api('/redash/status');
    sel.replaceChildren(...dataSources.map((d) =>
      el('option', { value: String(d.id), ...(d.id === status.dataSourceId ? { selected: 'selected' } : {}) },
        `${d.id} · ${d.name}`)));
  } catch {
    sel.replaceChildren(el('option', { value: '' }, 'could not load data sources'));
  }
  document.getElementById('rq-run-sql').addEventListener('click', () => {
    const sql = document.getElementById('rq-sql').value.trim();
    if (!sql) return;
    run('adhoc', () => api('/redash/adhoc', { method: 'POST', body: { sql, dataSourceId: Number(sel.value) } }));
  });
}

// ---------- boot ----------

me = await api('/me');
document.getElementById('user-chip').hidden = false;
document.getElementById('user-name').textContent = me.username;
const avatar = document.getElementById('user-avatar');
avatar.textContent = (me.username[0] || '?').toUpperCase();
let hue = 0;
for (const c of me.username) hue = (hue * 31 + c.charCodeAt(0)) % 360;
avatar.style.background = `hsl(${hue} 52% 42%)`;
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = (window.__base__ || '') + '/login.html';
});

document.getElementById('rq-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setPane(b.dataset.tab);
});
document.getElementById('rq-search-btn').addEventListener('click', () => search(1));
document.getElementById('rq-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(1); });

const status = await api('/redash/status').catch(() => ({ enabled: false }));
const conn = document.getElementById('rq-conn');
if (!status.enabled) conn.replaceChildren(el('span', { class: 'rq-bad' }, 'Redash not configured'));
else if (status.connected === false) conn.replaceChildren(el('span', { class: 'rq-bad' }, 'Redash unreachable'));
else {
  conn.replaceChildren(el('span', { class: 'rq-ok' }, `connected as ${status.user || '?'}`));
  await loadRegistry();
  if (me.role === 'admin' && status.adhocAllowed) await initSqlPane();
}
