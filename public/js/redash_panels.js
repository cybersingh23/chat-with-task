import { api, el, mount } from './common.js';

// Live-pipeline panels for the L12 Stats page.
//
// Everything else on that page is computed from what's on disk — i.e. only the
// tasks that were uploaded to the board. These panels come from Redash, so they
// describe the upstream ACC pipeline as a whole, and cross-join it against the
// board's local verdicts.
//
// They load AFTER the disk-computed sections and never block them: a Snowflake
// round trip is seconds, and Redash being down must not take the page with it.

const SEV_LABEL = { PASS: 'Pass', SOFT_FAIL: 'Soft fail', HARD_FAIL: 'Hard fail', UNSORTED: 'Unsorted' };
const BUCKET_ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];

const num = (n) => (n == null ? '—' : Number(n).toLocaleString());

function stamp(res) {
  if (!res?.retrievedAt) return '';
  const t = new Date(res.retrievedAt);
  return `${res.cached ? 'cached · ' : ''}${t.toLocaleTimeString()}`;
}

function note(text, cls = '') {
  return el('div', { class: `rd-note ${cls}` }, text);
}

// ---------------------------------------------------------------------------
// Level ladder — how much work is sitting at each layer right now
// ---------------------------------------------------------------------------

function renderLadder(host, ov) {
  const max = Math.max(1, ...ov.levels.map((l) => l.total));
  const rows = ov.levels.map((l) => {
    const pendPct = (l.pending / max) * 100;
    const otherPct = (l.other / max) * 100;
    return el('div', { class: 'rd-lvl' },
      el('div', { class: 'rd-lvl-name' }, l.label),
      el('div', { class: 'rd-lvl-bar', title: `${l.pending} pending · ${l.other} not pending` },
        l.pending ? el('div', { class: 'rd-seg pending', style: `width:${pendPct}%` }) : null,
        l.other ? el('div', { class: 'rd-seg other', style: `width:${otherPct}%` }) : null),
      el('div', { class: 'rd-lvl-pending' }, l.pending ? el('b', {}, num(l.pending)) : el('span', { class: 'dim' }, '0')),
      el('div', { class: 'rd-lvl-meta' },
        l.hours ? `${num(l.hours)} h` : el('span', { class: 'dim' }, '—'),
        l.avgHours ? el('span', { class: 'rd-avg' }, ` · ${l.avgHours} h/attempt`) : null),
    );
  });

  host.replaceChildren(
    el('div', { class: 'rd-lvl-head' },
      el('div', {}, 'Review level'), el('div', {}, ''), el('div', {}, 'Pending'), el('div', {}, `Worked (${ov.days}d)`)),
    ...rows,
    note(`${num(ov.pending)} tasks pending across all layers · ${num(ov.totalHours)} hours worked in the last ${ov.days} days.`),
  );
}

// ---------------------------------------------------------------------------
// Board × pipeline — where the tasks YOU audited actually sit upstream
// ---------------------------------------------------------------------------

function renderBoardMatrix(table, board) {
  const levels = board.levels;
  const head = el('tr', {},
    el('th', {}, 'Board bucket'),
    el('th', {}, 'On board'),
    ...levels.map((l) => el('th', { class: 'rd-num' }, `L${l}`)),
    el('th', { class: 'rd-num' }, 'Not found'),
  );

  const body = BUCKET_ORDER.filter((b) => board.buckets[b]).map((b) => {
    const v = board.buckets[b];
    return el('tr', {},
      el('td', {}, el('span', { class: `rd-sev sev-${b}` }, SEV_LABEL[b] || b)),
      el('td', {}, num(v.total)),
      ...levels.map((l) => el('td', { class: 'rd-num' },
        v.levels[l] ? String(v.levels[l]) : el('span', { class: 'dim' }, '·'))),
      el('td', { class: 'rd-num' },
        v.total - v.matched ? String(v.total - v.matched) : el('span', { class: 'dim' }, '·')),
    );
  });

  table.replaceChildren(head, ...body);
  if (!body.length) table.append(el('tr', {}, el('td', { class: 'empty', colspan: String(levels.length + 3) }, 'No tasks on the board.')));
}

// Status split, so "at L12" isn't silently read as "finished" — a node can be
// pending, completed or canceled at the same level and they mean different things.
function renderStatusSplit(host, board) {
  const totals = {};
  for (const r of board.rows) {
    if (!r.status) continue;
    totals[r.status] = (totals[r.status] || 0) + 1;
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  mount(host,
    entries.map(([status, n]) => el('span', { class: 'rd-chip' }, el('b', {}, num(n)), ` ${status}`)),
    board.unmatched
      ? el('span', { class: 'rd-chip warn' }, el('b', {}, num(board.unmatched)), ' not in pipeline')
      : null);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function initPipelinePanels({ days = 30 } = {}) {
  const section = document.getElementById('rd-section');
  if (!section) return;

  const status = await api('/redash/status').catch(() => ({ enabled: false }));
  if (!status.enabled || status.connected === false) {
    section.hidden = false;
    document.getElementById('rd-ladder').replaceChildren(
      note(status.enabled
        ? `Redash is configured but not reachable: ${status.error || 'unknown error'}`
        : 'Redash is not configured on this server (REDASH_API_KEY unset).', 'warn'));
    return;
  }

  section.hidden = false;
  const ladder = document.getElementById('rd-ladder');
  const table = document.getElementById('rd-board');
  const split = document.getElementById('rd-split');
  const stampEl = document.getElementById('rd-stamp');

  async function load(fresh = false) {
    ladder.replaceChildren(note('Loading pipeline from Redash…'));
    split.replaceChildren();
    const q = fresh ? '&fresh=1' : '';
    const [ov, board] = await Promise.all([
      api(`/redash/overview?days=${days}${q}`).catch((e) => ({ error: e.message })),
      api(`/redash/board?scope=all${q}`).catch((e) => ({ error: e.message })),
    ]);

    if (ov.error) ladder.replaceChildren(note(`Pipeline query failed: ${ov.error}`, 'warn'));
    else renderLadder(ladder, ov);

    if (board.error) {
      table.replaceChildren(el('tr', {}, el('td', { class: 'empty' }, `Board join failed: ${board.error}`)));
    } else {
      renderBoardMatrix(table, board);
      renderStatusSplit(split, board);
    }
    stampEl.textContent = stamp(ov.error ? board : ov);
  }

  document.getElementById('rd-refresh')?.addEventListener('click', () => load(true));
  await load(false);
}
