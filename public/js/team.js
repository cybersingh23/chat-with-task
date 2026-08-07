import { api, el, mount, renderAppHeader, avatar } from './common.js';
import { mountAcey } from './acey.js';

// The Team page: project health, and what each person owes because of it.
//
// The health signals come first and the todos below are derived from them, so
// the page reads as evidence → instruction rather than a list of orders with the
// reasoning hidden behind a tooltip. Every auto todo shows the number that
// triggered it and the threshold it crossed, because a todo you cannot argue
// with is one people quietly stop doing.

const SEV_ORDER = ['critical', 'high', 'medium'];
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const $ = (id) => document.getElementById(id);

let data = null;
let showClosed = false;
let me = null;

init();

async function init() {
  const user = await api('/me').catch(() => null);
  me = user?.username || null;
  renderAppHeader({ active: 'team', user });

  $('tm-refresh').addEventListener('click', () => load({ fresh: true }));
  $('tm-closed').addEventListener('change', (e) => { showClosed = e.target.checked; load({}); });
  $('tm-add').addEventListener('click', openAddForm);

  await load({});
}

async function load({ fresh }) {
  // The board runs a full health sync — several Redash round trips, ~10s cold.
  // Showing one line of text above two empty section headers for that long reads
  // as a broken page, so the shape of the answer goes up immediately and fills in.
  $('tm-sub').textContent = 'Checking project health…';
  if (!data) showSkeleton();

  try {
    data = await api(`/team/board?${showClosed ? 'closed=1&' : ''}${fresh ? 'fresh=1' : ''}`);
  } catch (e) {
    $('tm-sub').textContent = `Could not load the team board — ${e.message}`;
    mount($('tm-health'), el('div', { class: 'tm-clear' },
      'The health checks could not run, so nothing below is current. This is not a clear board.'));
    mount($('tm-esc'));
    mount($('tm-people'));
    return;
  }
  render();
}

// Skeletons matched to the real layout — one health block and five owner cards —
// so the page does not jump when the data lands.
function showSkeleton() {
  mount($('tm-health'),
    el('div', { class: 'tm-tiles' }, ...Array.from({ length: 4 }, () =>
      el('div', { class: 'tm-tile tm-skel' }))),
    el('div', { class: 'tm-signals' }, ...Array.from({ length: 4 }, () =>
      el('div', { class: 'tm-sig tm-skel tm-skel--row' }))));
  mount($('tm-esc'), el('div', { class: 'tm-todo tm-skel tm-skel--row' }));
  mount($('tm-people'), ...Array.from({ length: 5 }, () =>
    el('section', { class: 'tm-person tm-skel tm-skel--card' })));
}

function render() {
  const h = data.health;
  const c = h.context;
  const parts = [
    `${int(c.deliverable ?? 0)} of ${int(c.target ?? 0)} deliverable for ${c.nextDelivery} (${c.daysUntilDelivery}d away)`,
    `${int(c.totalPending ?? 0)} in flight`,
    c.blocked ? `${int(c.blocked)} blocked` : null,
    `${h.counts.high + h.counts.critical} signal(s) needing attention`,
  ].filter(Boolean);
  $('tm-sub').textContent = parts.join(' · ');

  renderHealth(h);
  renderEscalated();
  renderPeople();

  const ch = data.changes;
  $('tm-foot').textContent = ch
    ? `Auto todos reconciled: ${ch.created} created, ${ch.resolved} closed by the signal clearing, ${ch.reopened} recurred. `
      + `Manual todos are never auto-closed. Generated ${new Date(h.generatedAt).toLocaleTimeString()}.`
    : '';
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function renderHealth(h) {
  if (!h.signals.length) {
    return mount($('tm-health'), el('div', { class: 'tm-clear' },
      'No health signal is firing. Every check passed its threshold — that is a real result, not a missing panel.'));
  }
  const tiles = SEV_ORDER.map((sev) => {
    const n = h.counts[sev] || 0;
    return el('div', { class: `tm-tile tm-tile--${sev}${n ? '' : ' is-zero'}` },
      el('div', { class: 'tm-tile__n' }, String(n)),
      el('div', { class: 'tm-tile__l' }, sev));
  });
  mount($('tm-health'),
    el('div', { class: 'tm-tiles' }, ...tiles,
      el('div', { class: 'tm-tile tm-tile--esc' },
        el('div', { class: 'tm-tile__n' }, String(h.counts.escalated || 0)),
        el('div', { class: 'tm-tile__l' }, 'escalated'))),
    el('div', { class: 'tm-signals' }, ...h.signals.map(signalRow)));
}

function signalRow(s) {
  return el('div', { class: `tm-sig tm-sig--${s.severity}` },
    el('div', { class: 'tm-sig__head' },
      el('span', { class: `tm-sev tm-sev--${s.severity}` }, s.severity),
      el('span', { class: 'tm-sig__title' }, s.title),
      s.escalated ? el('span', { class: 'tm-esc-chip' }, 'escalated') : null,
      el('span', { class: 'tm-sig__owner' }, `→ ${s.owner}`)),
    el('div', { class: 'tm-sig__detail' }, s.detail),
    // The threshold is shown next to the value so the signal can be argued with
    // rather than just obeyed.
    s.metric
      ? el('div', { class: 'tm-sig__metric' },
        `${int(s.metric.value)}${s.metric.unit === '%' ? '%' : ` ${s.metric.unit}`}`,
        el('span', { class: 'dim' }, ` · fires above ${int(s.metric.threshold)}${s.metric.unit === '%' ? '%' : ''} · domain ${s.domain}`))
      : null);
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

function renderEscalated() {
  const host = $('tm-esc');
  if (!data.escalated.length) {
    return mount(host, el('p', { class: 'tm-empty' }, 'Nothing escalated. Owners are handling their domains.'));
  }
  mount(host, ...data.escalated.map((t) => todoCard(t, { showOwner: true })));
}

function renderPeople() {
  mount($('tm-people'), ...data.people.map((p) => el('section', { class: `tm-person${p.username === me ? ' is-me' : ''}` },
    el('header', { class: 'tm-person__head' },
      avatar(p.username),
      el('div', {},
        el('div', { class: 'tm-person__name' }, p.name,
          p.username === me ? el('span', { class: 'tm-you' }, 'you') : null),
        el('div', { class: 'tm-person__remit' }, p.remit)),
      el('div', { class: 'tm-person__n' }, p.live ? `${p.live} open` : el('span', { class: 'dim' }, 'clear'))),
    el('p', { class: 'tm-person__blurb' }, p.blurb),
    p.todos.length
      ? el('div', { class: 'tm-list' }, ...p.todos.map((t) => todoCard(t, {})))
      : el('p', { class: 'tm-empty' }, p.username === 'pavit'
        ? 'Nothing routed here. Escalations appear above — the owner keeps the work.'
        : 'Nothing outstanding.'))));
}

function todoCard(t, { showOwner }) {
  const closed = t.status === 'done' || t.status === 'resolved';
  const card = el('article', { class: `tm-todo tm-todo--${t.severity}${closed ? ' is-closed' : ''}` },
    el('div', { class: 'tm-todo__head' },
      el('span', { class: `tm-sev tm-sev--${t.severity}` }, t.severity),
      el('span', { class: 'tm-todo__title' }, t.title),
      showOwner ? el('span', { class: 'tm-sig__owner' }, `→ ${t.owner}`) : null),
    t.detail ? el('p', { class: 'tm-todo__detail' }, t.detail) : null,
    el('div', { class: 'tm-todo__meta' },
      el('span', { class: `tm-src tm-src--${t.source}` }, t.source),
      t.status !== 'open' ? el('span', { class: 'tm-status' }, statusLabel(t)) : null,
      // A signal that came back is a different problem from one that never left.
      t.recurrences ? el('span', { class: 'tm-recur' }, `recurred ${t.recurrences}×`) : null,
      t.link ? el('a', { class: 'tm-link', href: (window.__base__ || '') + t.link }, 'evidence') : null));

  if (!closed) card.append(actions(t));
  return card;
}

function statusLabel(t) {
  if (t.status === 'claimed') return `claimed by ${t.claimedBy || '?'}`;
  if (t.status === 'snoozed') return `snoozed to ${String(t.snoozeUntil || '').slice(0, 10)}`;
  if (t.status === 'done') return `done by ${t.doneBy || '?'}`;
  if (t.status === 'resolved') return 'closed — signal cleared';
  return t.status;
}

function actions(t) {
  const row = el('div', { class: 'tm-todo__actions' });
  const btn = (label, fn, cls = '') => {
    const b = el('button', { class: `btn btn--ghost tm-btn ${cls}`, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); await load({}); } catch (e) { alert(e.message); b.disabled = false; }
    });
    return b;
  };
  const patch = (body) => api(`/team/todos/${t.id}`, { method: 'PATCH', body });

  if (t.status !== 'claimed') row.append(btn('claim', () => patch({ status: 'claimed' })));
  if (t.status === 'claimed') row.append(btn('release', () => patch({ status: 'open' })));
  row.append(btn('done', () => patch({ status: 'done' })));
  if (t.status !== 'snoozed') row.append(btn('snooze 7d', () => patch({ status: 'snoozed', snoozeDays: 7 })));

  // Reassignment is one select rather than four buttons: the list is short but
  // it is the action most likely to be wrong, so it should take a deliberate act.
  const sel = el('select', { class: 'select tm-reassign' },
    el('option', { value: '' }, 'reassign…'),
    ...data.people.map((p) => el('option', { value: p.username, ...(p.username === t.owner ? { disabled: true } : {}) }, p.name)));
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try { await patch({ owner: sel.value }); await load({}); } catch (e) { alert(e.message); }
  });
  row.append(sel);

  if (t.source === 'manual') row.append(btn('delete', () => api(`/team/todos/${t.id}`, { method: 'DELETE' }), 'tm-btn--danger'));
  return row;
}

// ---------------------------------------------------------------------------
// Manual todo
// ---------------------------------------------------------------------------

function openAddForm() {
  const host = $('tm-health');
  if (document.getElementById('tm-form')) return;

  const owner = el('select', { class: 'select' },
    ...data.people.map((p) => el('option', { value: p.username, ...(p.username === me ? { selected: true } : {}) }, p.name)));
  const sev = el('select', { class: 'select' },
    ...['high', 'medium', 'critical'].map((s) => el('option', { value: s }, s)));
  const title = el('input', { class: 'input', placeholder: 'What needs doing', maxlength: '200' });
  const detail = el('input', { class: 'input', placeholder: 'Detail (optional)', maxlength: '1000' });

  const form = el('div', { class: 'tm-form', id: 'tm-form' },
    el('div', { class: 'tm-form__row' }, title, owner, sev),
    el('div', { class: 'tm-form__row' }, detail),
    el('div', { class: 'tm-form__row tm-form__row--end' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => form.remove() }, 'cancel'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          if (!title.value.trim()) return title.focus();
          try {
            await api('/team/todos', {
              method: 'POST',
              body: { owner: owner.value, title: title.value, detail: detail.value, severity: sev.value },
            });
            form.remove();
            await load({});
          } catch (e) { alert(e.message); }
        },
      }, 'add')));

  host.prepend(form);
  title.focus();
}


// Acey is available from every page, not just inside a task.
mountAcey({ page: 'team' });
