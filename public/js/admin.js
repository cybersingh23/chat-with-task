import { api, el, cap } from '/js/common.js';

const KIND_LABEL = {
  chat: 'Copilot chat',
  'docgen:review': 'Generated review',
  'docgen:remediation': 'Generated remediation',
};

const fmtInt = (n) => (n || 0).toLocaleString();
const fmtCost = (n) => '$' + (n || 0).toFixed(2);
const fmtTime = (ts) => (ts ? ts.replace('T', ' ').slice(0, 16) + 'Z' : '');

let allEvents = [];
const searchInput = document.getElementById('activity-search');

async function boot() {
  const me = await api('/me'); // 401 → login
  if (me.role !== 'admin') { location.href = '/'; return; }
  document.getElementById('user-chip').hidden = false;
  document.getElementById('user-name').textContent = me.username;
  await load();
}

async function load() {
  const data = await api('/admin/usage?limit=2000');
  document.getElementById('rate-note').textContent =
    `cost @ $${data.rate.inPer1M}/$${data.rate.outPer1M} per 1M in/out tokens`;

  // summary cards
  const t = data.totals;
  document.getElementById('stat-cards').replaceChildren(
    statCard('Interactions', fmtInt(t.interactions)),
    statCard('Input tokens', fmtInt(t.prompt_tokens)),
    statCard('Output tokens', fmtInt(t.completion_tokens)),
    statCard('Est. cost', fmtCost(t.cost)),
  );

  // by-user table
  const ut = document.getElementById('user-table');
  ut.replaceChildren(
    row('th', ['User', 'Interactions', 'Input', 'Output', 'Est. cost']),
    ...data.byUser.map((u) => row('td', [
      cap(u.user), fmtInt(u.interactions), fmtInt(u.prompt_tokens), fmtInt(u.completion_tokens), fmtCost(u.cost),
    ])),
  );
  if (!data.byUser.length) ut.append(emptyRow('No copilot activity yet.'));

  allEvents = data.events;
  renderEvents();
}

function statCard(label, value) {
  return el('div', { class: 'stat-card glass' },
    el('div', { class: 'stat-value' }, value),
    el('div', { class: 'stat-label' }, label),
  );
}

function renderEvents() {
  const q = searchInput.value.trim().toLowerCase();
  const rows = allEvents.filter((e) =>
    !q || [e.user, e.taskId, e.text, e.kind].some((v) => (v || '').toLowerCase().includes(q))
  );
  const et = document.getElementById('event-table');
  et.replaceChildren(
    row('th', ['Time', 'User', 'Action', 'Task', 'Detail', 'Tokens (in/out)', 'Cost']),
    ...rows.map((e) =>
      el('tr', {},
        td(fmtTime(e.ts)),
        td(cap(e.user)),
        td(KIND_LABEL[e.kind] || e.kind),
        e.taskId
          ? el('td', {}, el('a', { class: 'mono task-link', href: taskHref(e.taskId), title: e.taskId }, e.taskId.slice(0, 10) + '…'))
          : td('—'),
        el('td', { class: 'detail', title: e.text || '' }, e.text || ''),
        td(`${fmtInt(e.prompt_tokens)} / ${fmtInt(e.completion_tokens)}`),
        td(fmtCost(e.cost)),
      )
    ),
  );
  if (!rows.length) et.append(emptyRow(q ? 'No match.' : 'No copilot activity yet.'));
}

// We only log the task id, not its bucket — link via a resolver page hop is
// overkill, so just deep-link by scanning buckets client-side isn't available
// here; link to the board filtered by the id instead.
function taskHref(taskId) {
  return `/?q=${encodeURIComponent(taskId)}`;
}

function row(cell, cells) {
  return el('tr', {}, ...cells.map((c) => el(cell, {}, c)));
}
function td(v) { return el('td', {}, v); }
function emptyRow(msg) {
  return el('tr', {}, el('td', { class: 'empty', colspan: '7' }, msg));
}

searchInput.addEventListener('input', renderEvents);
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login.html';
});

boot();
