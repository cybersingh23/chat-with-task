import { api, el, mount, renderAppHeader, avatar } from './common.js';
import { mountAcey } from './acey.js';

// The Team page answers ONE question: what needs doing on ACC, and who owns it.
//
// It used to answer three, badly. The same eight items appeared as a health
// signal (evidence, no actions), again under "Escalated", and again inside a
// per-person column — so you read a problem, then scrolled past two more copies
// to find the actionable one. The severity tiles filtered nothing. Five ragged
// columns of unequal height made scanning impossible.
//
// Now: one card per item, grouped under its owner, carrying its own evidence and
// its own actions. Severity, escalation and ownership are FILTERS across the top
// rather than separate renderings of the same data — which is also what finally
// gives those counts a job.
//
// The evidence a health check produced (the value and the threshold it crossed)
// lives on the card, because a todo you cannot argue with is one people quietly
// stop doing. Nothing was lost by deleting the signals section; it moved.

const $ = (id) => document.getElementById(id);
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const SEV_RANK = { critical: 0, high: 1, medium: 2 };

let data = null;
let me = null;
let view = 'all';       // all | mine | escalated | critical | high | medium | closed

init();

async function init() {
  const user = await api('/me').catch(() => null);
  me = user?.username || null;
  renderAppHeader({ active: 'team', user });

  $('tm-refresh').addEventListener('click', () => load({ fresh: true }));
  $('tm-add').addEventListener('click', openAddForm);

  await load({});
}

async function load({ fresh }) {
  if (!data) showSkeleton();
  try {
    data = await api(`/team/board?${view === 'closed' ? 'closed=1&' : ''}${fresh ? 'fresh=1' : ''}`);
  } catch (e) {
    $('tm-sub').textContent = `Could not load the board — ${e.message}`;
    mount($('tm-filters'));
    mount($('tm-owners'), el('div', { class: 'tm-blank' },
      'The health checks could not run, so nothing below is current. This is not a clear board.'));
    return;
  }
  render();
}

// Every item, exactly once. people[].todos already contains the full set;
// `escalated` is the same objects flagged, not a second list.
const allItems = () => data.people.flatMap((p) => p.todos);

function matches(t) {
  if (view === 'all') return true;
  if (view === 'mine') return t.owner === me;
  if (view === 'escalated') return !!t.escalated;
  if (view === 'closed') return t.status === 'done' || t.status === 'resolved';
  return t.severity === view;
}

function render() {
  const items = allItems();
  const c = data.health.context;

  $('tm-sub').textContent = [
    `${int(c.deliverable ?? 0)} of ${int(c.target ?? 0)} deliverable for ${c.nextDelivery}`,
    `${c.daysUntilDelivery}d out`,
    `${int(c.totalPending ?? 0)} in flight`,
    c.blocked ? `${int(c.blocked)} blocked` : null,
  ].filter(Boolean).join(' · ');

  renderFilters(items);
  renderOwners(items.filter(matches));

  const ch = data.changes;
  $('tm-foot').textContent = ch
    ? `Auto items are created by a health check and close themselves when the signal clears `
      + `(${ch.created} new, ${ch.resolved} cleared, ${ch.reopened} recurred this sync). `
      + `Items you add by hand are never closed automatically. Checked ${new Date(data.health.generatedAt).toLocaleTimeString()}.`
    : '';
}

// ---------------------------------------------------------------------------
// Filters — the counts ARE the control
// ---------------------------------------------------------------------------

function renderFilters(items) {
  const open = items.filter((t) => t.status !== 'done' && t.status !== 'resolved');
  const defs = [
    { key: 'all', label: 'All', n: open.length },
    { key: 'mine', label: 'Mine', n: open.filter((t) => t.owner === me).length },
    { key: 'escalated', label: 'Escalated', n: open.filter((t) => t.escalated).length },
    { key: 'critical', label: 'Critical', n: open.filter((t) => t.severity === 'critical').length },
    { key: 'high', label: 'High', n: open.filter((t) => t.severity === 'high').length },
    { key: 'medium', label: 'Medium', n: open.filter((t) => t.severity === 'medium').length },
    { key: 'closed', label: 'Closed', n: null },
  ];

  mount($('tm-filters'), ...defs.map((d) => {
    const on = view === d.key;
    const b = el('button', {
      class: `tm-filter${on ? ' is-on' : ''}${d.key !== 'all' && d.key !== 'closed' && !d.n ? ' is-empty' : ''}`,
      type: 'button', 'aria-pressed': on ? 'true' : 'false',
    }, d.label, d.n === null ? null : el('span', { class: 'tm-filter__n' }, String(d.n)));
    b.addEventListener('click', () => {
      const wasClosed = view === 'closed';
      view = d.key;
      // Closed items are not fetched by default, so switching in or out of that
      // view needs a round trip; every other filter is in memory and instant.
      if (wasClosed || d.key === 'closed') load({});
      else render();
    });
    return b;
  }));
}

// ---------------------------------------------------------------------------
// The work, grouped by owner
// ---------------------------------------------------------------------------

function renderOwners(items) {
  if (!items.length) {
    return mount($('tm-owners'), el('div', { class: 'tm-blank' },
      view === 'all'
        ? 'No open work. Every health check is under its threshold.'
        : 'Nothing matches this filter.'));
  }

  const byOwner = new Map();
  for (const t of items) {
    if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
    byOwner.get(t.owner).push(t);
  }

  // Team order, so the page does not reshuffle as items move between people.
  // Owners with nothing in the current filter are dropped rather than shown as
  // empty cards — five ragged columns of "Nothing outstanding" was most of what
  // made the old page hard to read.
  mount($('tm-owners'), ...data.people
    .filter((p) => byOwner.has(p.username))
    .map((p) => ownerSection(p, sortWork(byOwner.get(p.username)))));
}

const sortWork = (list) => list.sort((a, b) =>
  (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3)
  || String(a.createdAt).localeCompare(String(b.createdAt)));

function ownerSection(p, todos) {
  return el('section', { class: `tm-owner${p.username === me ? ' is-me' : ''}` },
    el('header', { class: 'tm-owner__head' },
      avatar(p.username),
      el('div', { class: 'tm-owner__id' },
        el('h2', { class: 'tm-owner__name' }, p.name,
          p.username === me ? el('span', { class: 'tm-you' }, 'You') : null),
        el('p', { class: 'tm-owner__remit' }, p.blurb)),
      el('span', { class: 'tm-owner__n' }, `${todos.length} open`)),
    el('div', { class: 'tm-work' }, ...todos.map(card)));
}

function card(t) {
  const closed = t.status === 'done' || t.status === 'resolved';
  return el('article', { class: `tm-card tm-card--${t.severity}${closed ? ' is-closed' : ''}` },
    el('div', { class: 'tm-card__top' },
      el('span', { class: `tm-sev tm-sev--${t.severity}` }, t.severity),
      el('h3', { class: 'tm-card__title' }, t.title),
      t.escalated ? el('span', { class: 'tm-tag tm-tag--esc' }, 'Escalated') : null,
      t.source === 'manual' ? el('span', { class: 'tm-tag' }, 'Added by hand') : null),

    t.detail ? el('p', { class: 'tm-card__detail' }, t.detail) : null,

    // The number and the threshold it crossed, so the item can be argued with
    // rather than only obeyed.
    t.metric
      ? el('p', { class: 'tm-card__metric' },
        el('b', {}, `${int(t.metric.value)}${t.metric.unit === '%' ? '%' : ` ${t.metric.unit}`}`),
        ` · flags above ${int(t.metric.threshold)}${t.metric.unit === '%' ? '%' : ''}`,
        t.domain ? ` · ${t.domain.replace(/_/g, ' ')}` : '')
      : null,

    el('div', { class: 'tm-card__foot' },
      t.status !== 'open' && !closed ? el('span', { class: 'tm-state' }, stateLabel(t)) : null,
      closed ? el('span', { class: 'tm-state' }, stateLabel(t)) : null,
      t.recurrences ? el('span', { class: 'tm-state tm-state--warn' }, `Came back ${t.recurrences}×`) : null,
      t.link ? el('a', { class: 'tm-evidence', href: (window.__base__ || '') + t.link }, 'Evidence') : null,
      closed ? null : actions(t)));
}

function stateLabel(t) {
  if (t.status === 'claimed') return `Claimed by ${t.claimedBy || 'someone'}`;
  if (t.status === 'snoozed') return `Snoozed until ${String(t.snoozeUntil || '').slice(0, 10)}`;
  if (t.status === 'done') return `Done by ${t.doneBy || 'someone'}`;
  if (t.status === 'resolved') return 'Closed — the signal cleared';
  return '';
}

function actions(t) {
  const row = el('div', { class: 'tm-card__actions' });
  const patch = (body) => api(`/team/todos/${t.id}`, { method: 'PATCH', body });
  const btn = (label, fn, cls = '') => {
    const b = el('button', { class: `btn btn--ghost tm-btn ${cls}`, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); await load({}); } catch (e) { alert(e.message); b.disabled = false; }
    });
    return b;
  };

  row.append(t.status === 'claimed'
    ? btn('Release', () => patch({ status: 'open' }))
    : btn('Claim', () => patch({ status: 'claimed' })));
  row.append(btn('Done', () => patch({ status: 'done' })));
  if (t.status !== 'snoozed') row.append(btn('Snooze 7d', () => patch({ status: 'snoozed', snoozeDays: 7 })));

  // A select rather than four buttons: reassignment is the action most likely to
  // be wrong, so it should take a deliberate act.
  const sel = el('select', { class: 'select tm-reassign', 'aria-label': 'Reassign to' },
    el('option', { value: '' }, 'Reassign…'),
    ...data.people.map((p) => el('option', {
      value: p.username, ...(p.username === t.owner ? { disabled: true } : {}),
    }, p.name)));
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try { await patch({ owner: sel.value }); await load({}); } catch (e) { alert(e.message); }
  });
  row.append(sel);

  if (t.source === 'manual') row.append(btn('Delete', () => api(`/team/todos/${t.id}`, { method: 'DELETE' }), 'tm-btn--danger'));
  return row;
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function openAddForm() {
  if ($('tm-form')) return $('tm-form').querySelector('input').focus();

  const title = el('input', { class: 'input', placeholder: 'What needs doing', maxlength: '200' });
  const detail = el('input', { class: 'input', placeholder: 'Detail (optional)', maxlength: '1000' });
  const owner = el('select', { class: 'select', 'aria-label': 'Owner' },
    ...data.people.map((p) => el('option', { value: p.username, ...(p.username === me ? { selected: true } : {}) }, p.name)));
  const sev = el('select', { class: 'select', 'aria-label': 'Severity' },
    ...['high', 'medium', 'critical'].map((s) => el('option', { value: s }, s[0].toUpperCase() + s.slice(1))));

  const form = el('div', { class: 'tm-form', id: 'tm-form' },
    el('div', { class: 'tm-form__row' }, title, owner, sev),
    el('div', { class: 'tm-form__row' }, detail),
    el('div', { class: 'tm-form__row tm-form__row--end' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => form.remove() }, 'Cancel'),
      el('button', {
        class: 'btn btn--primary', type: 'button',
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
      }, 'Add todo')));

  mount($('tm-form-host'), form);
  title.focus();
}

// Matched to the real layout so the page does not jump when data lands.
function showSkeleton() {
  $('tm-sub').textContent = 'Checking project health…';
  mount($('tm-filters'), ...Array.from({ length: 5 }, () => el('div', { class: 'tm-filter tm-skel' })));
  mount($('tm-owners'), ...Array.from({ length: 3 }, () => el('section', { class: 'tm-owner tm-skel tm-skel--card' })));
}

mountAcey({ page: 'team' });
