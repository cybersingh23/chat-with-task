import { api, el, renderAppHeader } from './common.js';
import { initPipelinePanels } from './redash_panels.js';

const DIM_LABEL = {
  correctness: 'Correctness',
  agent_behaviour: 'Agent',
  communications: 'Comms',
  code_style: 'Code style',
};
const VERDICT_LABEL = {
  NO_ISSUES: 'No fixes', FIXES_MADE: 'Fixes made', GRAMMAR_ONLY: 'Grammar-only', SBQ: 'SBQ',
  SECOND_OPINION: '2nd opinion', none: 'Undecided',
};
const SEV_LABEL = { PASS: 'Pass', SOFT_FAIL: 'Soft fail', HARD_FAIL: 'Hard fail', UNSORTED: 'Unsorted' };
const STRENGTHS = ['strong', 'moderate', 'slight', 'unrated'];

let data = null;
let lbSort = { key: 'overall', dir: -1 };

function avatarHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
// Display name: drop the vendor path ("anthropic/…", "xai/…") and the "claude-" family
// prefix so the distinguishing part (opus-4-6, sonnet-4-6, grok-4.5) is what shows.
// Full raw name is kept in the title tooltip. Codenames pass through unchanged.
function displayModel(name) {
  let s = String(name);
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  return s.replace(/^claude-/, '');
}
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const sc = (x) => (x == null ? '—' : x.toFixed(2));
const scoreClass = (x) => (x == null ? '' : x >= 2.5 ? 'good' : x >= 1.8 ? 'mid' : 'bad');

function statCard(value, label) {
  return el('div', { class: 'stat-card glass' },
    el('div', { class: 'stat-value' }, String(value)),
    el('div', { class: 'stat-label' }, label));
}

function renderCards() {
  const decidedModels = data.leaderboard.length;
  document.getElementById('l12-cards').replaceChildren(
    statCard(data.total, 'Total tasks'),
    statCard(decidedModels, 'Models'),
    statCard(data.matchups.length, 'Matchups'),
    statCard(data.annotators.length, 'Annotators'),
    statCard(data.taskNames.length, 'Distinct task names'),
  );
}

// A labeled row of proportional segments (verdict / severity breakdown).
function breakdownCard(title, counts, order, labels, cls) {
  const total = order.reduce((s, k) => s + (counts[k] || 0), 0) || 1;
  const bar = el('div', { class: 'l12-bar' },
    ...order.filter((k) => counts[k]).map((k) =>
      el('div', { class: `l12-seg seg-${cls}-${k}`, style: `flex:${counts[k]}`, title: `${labels[k]}: ${counts[k]}` })));
  const legend = el('div', { class: 'l12-legend' },
    ...order.map((k) => el('span', { class: 'l12-legend-item' },
      el('span', { class: `l12-dot seg-${cls}-${k}` }),
      `${labels[k]} `, el('b', {}, String(counts[k] || 0)),
      el('span', { class: 'l12-legend-pct' }, ` ${Math.round((counts[k] || 0) / total * 100)}%`))));
  return el('div', { class: 'l12-move-card glass' }, el('h3', {}, title), bar, legend);
}

function renderMovement() {
  document.getElementById('l12-movement').replaceChildren(
    breakdownCard('Reviewer decisions', data.verdicts,
      ['NO_ISSUES', 'FIXES_MADE', 'GRAMMAR_ONLY', 'SBQ', 'SECOND_OPINION', 'none'], VERDICT_LABEL, 'v'),
    breakdownCard('Severity (eval buckets)', data.severity,
      ['PASS', 'SOFT_FAIL', 'HARD_FAIL', 'UNSORTED'], SEV_LABEL, 's'),
  );
}

// ---- leaderboard (sortable) ----
function sortVal(m, key) {
  if (key === 'name') return m.name;
  if (key === 'appearances') return m.appearances;
  if (key === 'winRate') return m.winRate ?? -1;
  if (key === 'overall') return m.overall ?? -1;
  return m.dims[key]?.avg ?? -1; // a dimension
}
function setSort(key) {
  if (lbSort.key === key) lbSort.dir *= -1;
  else lbSort = { key, dir: key === 'name' ? 1 : -1 };
  renderLeaderboard();
}
function th(label, key, extra) {
  const active = lbSort.key === key;
  return el('th', { class: `sortable${active ? ' sorted' : ''}${extra ? ' ' + extra : ''}`, onclick: () => setSort(key) },
    label, active ? el('span', { class: 'sort-caret' }, lbSort.dir < 0 ? ' ▾' : ' ▴') : '');
}
function scoreCell(cell) {
  const { avg, n } = cell;
  return el('td', { class: 'l12-score-cell' },
    el('span', { class: `l12-score ${scoreClass(avg)}` }, sc(avg)),
    avg == null ? '' : el('span', { class: 'l12-score-bar' }, el('span', { class: `fill ${scoreClass(avg)}`, style: `width:${(avg / 3) * 100}%` })),
    el('span', { class: 'l12-n' }, `n${n}`));
}
function renderLeaderboard() {
  const rows = [...data.leaderboard].sort((a, b) => {
    const va = sortVal(a, lbSort.key), vb = sortVal(b, lbSort.key);
    if (va < vb) return -1 * lbSort.dir;
    if (va > vb) return 1 * lbSort.dir;
    return 0;
  });
  const head = el('tr', {},
    el('th', { class: 'l12-rank-h' }, '#'),
    th('Model', 'name', 'l12-model-h'),
    th('Tasks', 'appearances'),
    th('Win rate', 'winRate'),
    ...data.dims.map((d) => th(DIM_LABEL[d] || d, d)),
    th('Overall', 'overall', 'l12-overall-h'),
  );
  const body = rows.map((m, i) =>
    el('tr', {},
      el('td', { class: 'l12-rank' }, String(i + 1)),
      el('td', { class: 'l12-model' },
        el('span', { class: 'mono', title: m.name }, displayModel(m.name))),
      el('td', {}, String(m.appearances)),
      el('td', {}, el('span', { class: `l12-win ${m.winRate >= 0.5 ? 'good' : m.winRate == null ? '' : 'bad'}` }, pct(m.winRate)),
        el('span', { class: 'l12-n' }, ` ${m.wins}-${m.losses}`)),
      ...data.dims.map((d) => scoreCell(m.dims[d])),
      el('td', { class: 'l12-overall' }, el('span', { class: `l12-score ${scoreClass(m.overall)}` }, sc(m.overall))),
    ));
  document.getElementById('l12-leaderboard').replaceChildren(head, ...body);
}

// ---- matchups ----
function strengthPills(p, align) {
  const items = STRENGTHS.filter((s) => p[s]);
  if (!items.length) return el('div', { class: `l12-spills ${align}` }, el('span', { class: 'l12-spill none' }, '—'));
  return el('div', { class: `l12-spills ${align}` },
    ...items.map((s) => el('span', { class: `l12-spill s-${s}`, title: `${p[s]} ${s} win${p[s] === 1 ? '' : 's'}` }, `${p[s]} ${s}`)));
}
function muChip(name, side) {
  return el('span', { class: `l12-mu-chip ${side}` },
    el('span', { class: 'mono l12-mu-name', title: name }, displayModel(name)));
}
function renderMatchups() {
  const wrap = document.getElementById('l12-matchups');
  if (!data.matchups.length) { wrap.replaceChildren(el('div', { class: 'l12-empty' }, 'No matchups in this scope.')); return; }
  wrap.replaceChildren(...data.matchups.map((mu) => {
    const x = mu.a, y = mu.b;
    const px = mu.perModel[x] || { wins: 0 }, py = mu.perModel[y] || { wins: 0 };
    const wx = px.wins || 0, wy = py.wins || 0;
    return el('div', { class: 'l12-matchup glass' },
      el('div', { class: 'l12-mu-head' }, muChip(x, 'left'),
        el('span', { class: 'l12-mu-total' }, `${mu.total} task${mu.total === 1 ? '' : 's'}`), muChip(y, 'right')),
      el('div', { class: 'l12-winbar' },
        el('div', { class: 'l12-winfill left', style: `flex:${wx || 0.001}`, title: `${x}: ${wx}` }, wx ? String(wx) : ''),
        el('div', { class: 'l12-winfill right', style: `flex:${wy || 0.001}`, title: `${y}: ${wy}` }, wy ? String(wy) : '')),
      el('div', { class: 'l12-mu-foot' },
        el('div', { class: 'l12-mu-col left' },
          el('span', { class: `l12-mu-pct ${wx >= wy ? 'lead' : ''}` }, pct(mu.total ? wx / mu.total : null)),
          strengthPills(px, 'left')),
        el('div', { class: 'l12-mu-col right' },
          el('span', { class: `l12-mu-pct ${wy > wx ? 'lead' : ''}` }, pct(mu.total ? wy / mu.total : null)),
          strengthPills(py, 'right'))),
    );
  }));
}

// ---- annotators + task names ----
function renderAnnotators() {
  const head = el('tr', {}, ...['Annotator ID', 'Tasks', 'No fixes', 'Fixes made', 'Grammar-only', 'SBQ', '2nd opinion'].map((h) => el('th', {}, h)));
  const body = data.annotators.map((a) =>
    el('tr', {},
      el('td', {}, el('span', { class: 'mono', title: a.id }, a.id)),
      el('td', {}, String(a.tasks)),
      el('td', {}, String(a.NO_ISSUES)),
      el('td', {}, String(a.FIXES_MADE)),
      el('td', {}, String(a.GRAMMAR_ONLY || 0)),
      el('td', {}, String(a.SBQ)),
      el('td', {}, String(a.SECOND_OPINION))));
  const t = document.getElementById('l12-annotators');
  t.replaceChildren(head, ...body);
  if (!body.length) t.append(el('tr', {}, el('td', { class: 'empty', colspan: '6' }, 'No annotator data in this scope.')));
}
function renderTaskNames() {
  const head = el('tr', {}, el('th', {}, 'Task name'), el('th', {}, 'Instances'));
  const body = data.taskNames.map((t) =>
    el('tr', {}, el('td', { class: 'l12-taskname' }, t.name), el('td', {}, String(t.count))));
  const el2 = document.getElementById('l12-tasknames');
  el2.replaceChildren(head, ...body);
  if (!body.length) el2.append(el('tr', {}, el('td', { class: 'empty', colspan: '2' }, 'No tasks in this scope.')));
}

async function loadScope(scope) {
  data = await api(`/l12?scope=${scope}`);
  renderCards();
  renderMovement();
  renderLeaderboard();
  renderMatchups();
  renderAnnotators();
  renderTaskNames();
}

// ---------- boot ----------
const me = await api('/me');
const scopeSel = el('select', { class: 'select', id: 'l12-scope-sel' },
  el('option', { value: 'completed' }, 'Completed (resolved, non-archived)'),
  el('option', { value: 'active' }, 'Active board (non-archived)'),
  el('option', { value: 'all' }, 'All tasks on disk'));
renderAppHeader({ active: 'l12', user: me, extras: [scopeSel] });

const sel = document.getElementById('l12-scope-sel');
const s0 = new URLSearchParams(location.search).get('scope');
if (s0 && ['completed', 'active', 'all'].includes(s0)) sel.value = s0;
sel.addEventListener('change', () => loadScope(sel.value));
await loadScope(sel.value);

// Redash panels load last and independently — a slow or unreachable Redash must
// never delay or break the disk-computed sections above.
initPipelinePanels().catch((e) => console.error('pipeline panels:', e));
