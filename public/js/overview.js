import { api, el, mount, renderAppHeader, avatar, personName } from './common.js';
import { mountChart, clearChart, deliveryColumns, intakeColumns, readinessFunnel, stackedArea, hBars, legend } from './charts.js';

// The Overview page.
//
// Load order matters here: the brief is cached Redash and comes back in about a
// second, the summary is a model call that can take much longer. They are
// fetched independently so the charts paint immediately and the prose lands
// when it lands, rather than the page sitting blank behind the LLM.

const STAGE_LABELS = {
  production: 'Production',
  early_review: 'Early review',
  late_review: 'Late review',
  final: 'Final',
};
const STAGE_ORDER = ['production', 'early_review', 'late_review', 'final'];
const LEVEL_STAGE = { '-1': 'production', 0: 'early_review', 1: 'early_review', 4: 'late_review', 8: 'late_review', 10: 'late_review', 12: 'final' };
const stageOf = (lvl) => LEVEL_STAGE[String(lvl)] || 'late_review';

const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const $ = (id) => document.getElementById(id);

let brief = null;

init();

async function init() {
  const user = await api('/me').catch(() => null);
  renderAppHeader({ active: 'overview', user });

  $('ov-regen').addEventListener('click', () => loadSummary({ refresh: true }));

  try {
    brief = await api('/overview/brief');
  } catch (e) {
    $('ov-headline').textContent = 'Could not load the brief';
    mount($('ov-prose'), el('p', { class: 'ov-error' }, e.message));
    $('ov-hero').setAttribute('aria-busy', 'false');
    return;
  }

  renderClock(brief);
  renderAssignments(brief);
  renderCharts(brief);
  renderFoot(brief);
  // Both are slower than the brief and independent of each other, so neither
  // blocks the page or the other.
  loadSummary({});
  loadInflight();
}

// ---------------------------------------------------------------------------
// hero
// ---------------------------------------------------------------------------

function renderClock(b) {
  const c = b.calendar;
  $('ov-headline').textContent = c.headline;
  $('ov-clock').textContent = b.now.label;

  const chip = (cls, label, value) =>
    el('div', { class: `ov-stat ${cls}` }, el('span', { class: 'ov-stat__v' }, value), el('span', { class: 'ov-stat__k' }, label));

  const p = b.pipeline;
  // The headline number is DELIVERABLE (L12), not a roll-up of upstream stages.
  // Reporting the sum as "within reach" made a 289-task shortfall read as 43.
  mount($('ov-countdown'),
    chip('', c.isDeliveryDay ? 'delivery is today' : `days to ${c.deliveryWeekday}`, c.isDeliveryDay ? '—' : String(c.daysUntil)),
    p ? chip('', `deliverable of ${int(b.target)}`, int(p.deliverable)) : null,
    p ? chip(p.gapToTarget > 0 ? 'ov-stat--warn' : 'ov-stat--ok',
      p.gapToTarget > 0 ? 'still to reach L12' : `target ${b.target}`,
      p.gapToTarget > 0 ? int(p.gapToTarget) : 'met') : null);
}

async function loadSummary({ refresh }) {
  const prose = $('ov-prose');
  const btn = $('ov-regen');
  btn.disabled = true;
  btn.textContent = refresh ? 'regenerating…' : 'regenerate';
  // On a refetch the previous synthesis is held at reduced opacity rather than
  // swapped for skeletons: the text is still true while the new one generates,
  // and replacing it would jump the layout by several lines for ~15 seconds.
  // The first load is the only case with nothing to hold, and it keeps its
  // skeletons from the markup.
  if (refresh) prose.classList.add('is-stale');
  try {
    const s = await api(`/overview/summary${refresh ? '?refresh=1' : ''}`);
    if (s.text) {
      // The headline is already the page's h1; the model repeats it verbatim as
      // its opening sentence, so strip that one duplicate rather than showing it
      // twice. Anything else it wrote is left exactly as written.
      const body = s.text.startsWith(s.headline) ? s.text.slice(s.headline.length).trim() : s.text;
      // Paragraphs as text nodes, not markdown. The synthesis is prose by
      // construction — the system prompt forbids headings, lists and emoji — so
      // there is nothing to parse, and this keeps model output off innerHTML
      // instead of trusting it with an HTML parser.
      mount(prose, ...body.split(/\n\s*\n/).map((para) => el('p', {}, para.trim())).filter((p) => p.textContent));
      $('ov-stamp').textContent = s.cached
        ? `synthesis cached${s.generatedAt ? ` · ${new Date(s.generatedAt).toLocaleString()}` : ''}`
        : `synthesis generated ${new Date(s.generatedAt || Date.now()).toLocaleTimeString()}`;
    } else {
      // The deterministic half of the page is unaffected, so say what's missing
      // and leave everything else standing.
      mount(prose, el('p', { class: 'ov-error' },
        `Synthesis unavailable — ${s.error || 'the model returned nothing'}. The numbers below are unaffected.`));
      $('ov-stamp').textContent = '';
    }
  } catch (e) {
    mount(prose, el('p', { class: 'ov-error' }, `Synthesis unavailable — ${e.message}. The numbers below are unaffected.`));
  } finally {
    prose.classList.remove('is-stale');
    btn.disabled = false;
    btn.textContent = 'regenerate';
    $('ov-hero').setAttribute('aria-busy', 'false');
  }
}

// Who does what. Every item carries the system it belongs to, so "chase this
// upstream" and "triage your own review list" can never be mistaken for each
// other — that separation was the point of splitting them in the first place.
const SYSTEM_LABEL = {
  board: 'Board', pipeline: 'Pipeline',
  decision: 'Decision', 'cross-functional': 'Cross-functional', direction: 'Direction',
};

function renderAssignments(b) {
  const a = b.assignments;
  if (!a) return;

  // Every card is identical — no accent tint, no separate row, no ordering
  // privilege beyond being first. The lead's items differ in KIND, and the tag on
  // each item already says so; styling the whole card differently made it read as
  // a management panel sitting above the team rather than one of five people.
  const card = (person) => el('article', { class: 'ov-person' },
    el('header', { class: 'ov-person__head' },
      avatar(person.name, { cls: 'ov-person__pic' }),
      el('h3', { class: 'ov-person__name' }, personName(person.name))),
    person.items.length
      ? el('ul', { class: 'ov-person__list' },
        ...person.items.map((it) => el('li', { class: 'ov-task' },
          el('span', { class: `ov-tag ov-tag--${it.system.replace(/[^a-z]/g, '')}` }, SYSTEM_LABEL[it.system] || it.system),
          el('span', { class: 'ov-task__text' }, it.text),
          el('span', { class: 'ov-task__detail' }, it.detail))))
      : el('p', { class: 'ov-person__clear' }, 'Nothing queued.'));

  // All five in one grid. This only works because the lead's items are now capped
  // at two, so no card is tall enough to strand the others on a second row — the
  // earlier version had a six-item lead column that did exactly that.
  mount($('ov-assign'),
    el('div', { class: 'ov-assign__head' },
      el('h2', {}, 'This week'),
      el('span', { class: 'ov-assign__hint' },
        'Split from live board and pipeline state — claim before you start. Rotates weekly.')),
    el('div', { class: 'ov-assign__grid' },
      ...[a.lead, ...a.reviewers].map((p) => card(p))));
}


// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

function renderCharts(b) {
  if (!b.redash?.enabled) {
    for (const id of ['chart-deliveries', 'chart-funnel', 'chart-intake', 'chart-throughput', 'chart-cost', 'chart-rework']) {
      mount($(id), el('p', { class: 'ov-error' }, 'Redash is not configured (REDASH_API_KEY unset).'));
    }
    return;
  }

  // 1 — delivery volume vs target
  if (b.deliveries?.history?.length) {
    const d = b.deliveries;
    $('ov-delivery-sub').textContent =
      `${d.history.length} batches. Last was ${int(d.last.tasks)} on ${d.last.date}; trailing four average ${int(d.trailingAvg)}.`;
    mountChart($('chart-deliveries'), deliveryColumns({ history: d.history, target: b.target }));
  }

  // 2 — supply funnel. Only the Final band is deliverable; the rest is supply
  // that still has to reach L12, and the caption says so rather than letting the
  // cumulative total imply the target is covered.
  if (b.pipeline?.stages?.length) {
    const p = b.pipeline;
    $('ov-funnel-sub').textContent =
      `${int(p.deliverable)} of ${int(b.target)} are deliverable now (L12) — ${p.progressPct}%. `
      + `${int(p.feeder)} sit at L10 and ${int(p.upstream)} further back; running totals below assume every one of them reaches L12 in time`
      + `${p.supplyShortfall > 0 ? `, which would still leave ${int(p.supplyShortfall)} short` : ''}.`;
    mountChart($('chart-funnel'), readinessFunnel({ stages: p.stages, target: b.target }));
  }

  // 2c — deliverable intake. The summary cites the cycle-to-date comparison, so
  // it needs to be visible somewhere rather than only asserted in prose.
  if (b.intake?.days?.length) {
    const ik = b.intake;
    const pace = ik.lastCycleToDate != null && ik.lastCycleToDate > 0
      ? ` That is ${Math.round((ik.thisCycle / ik.lastCycleToDate) * 100)}% of the ${int(ik.lastCycleToDate)} reached by the same point last cycle.`
      : '';
    $('ov-intake-sub').textContent =
      `Level 12 is the deliverable state. ${int(ik.thisCycle ?? 0)} have entered it since the last delivery `
      + `(${ik.lastDelivery}, ${ik.offsetDays} day${ik.offsetDays === 1 ? '' : 's'} ago).${pace}`;
    mountChart($('chart-intake'), intakeColumns({
      days: ik.days,
      deliveries: (b.deliveries?.history || []).map((d) => d.date),
      cycleStart: ik.lastDelivery,
    }));
  }

  // 3 — throughput, rolled up from level to stage
  if (b.throughput?.length) {
    const days = [...new Set(b.throughput.map((r) => r.day))].sort();
    const idx = new Map(days.map((d, i) => [d, i]));
    const series = Object.fromEntries(STAGE_ORDER.map((k) => [k, days.map(() => 0)]));
    for (const r of b.throughput) series[stageOf(r.level)][idx.get(r.day)] += r.tasks;
    mountChart($('chart-throughput'), stackedArea({ days, stageKeys: STAGE_ORDER, stageLabels: STAGE_LABELS, series }));
    mount($('chart-throughput-legend'), legend(STAGE_ORDER.map((k) => ({ key: k, label: STAGE_LABELS[k] }))));
  }

  // 4 & 5 — two measures, two charts, never one dual axis
  const ec = (b.economics || []).filter((e) => e.attempts > 0);
  if (ec.length) {
    const totalHours = ec.reduce((a, e) => a + e.totalHours, 0);
    const top = [...ec].sort((a, b2) => b2.totalHours - a.totalHours)[0];
    $('ov-cost-sub').textContent =
      `Last ${b.windowDays} days. L${top.level} is ${Math.round((top.totalHours / totalHours) * 100)}% of ${int(totalHours)} billed hours.`;
    mountChart($('chart-cost'), hBars({
      rows: [...ec].sort((a, b2) => b2.totalHours - a.totalHours).map((e) => ({
        label: `L${e.level}`,
        stageKey: stageOf(e.level),
        totalHours: e.totalHours,
        tip: `<b>L${e.level}</b> · ${STAGE_LABELS[stageOf(e.level)]}<br>`
          + `${int(e.totalHours)}h billed vs ${int(e.activeHours)}h active<br>`
          + `${int(e.attempts)} attempts · ${e.avgHours}h avg, ${e.medianHours}h median`,
      })),
      valueKey: 'totalHours',
      format: (v) => `${int(v)}h`,
      note: 'Hover a bar for billed-vs-active hours and the per-attempt average.',
    }));

    const rw = [...ec].sort((a, b2) => b2.pctRejected - a.pctRejected);
    const worst = rw[0];
    $('ov-rework-sub').textContent = worst.pctRejected > 0
      ? `Last ${b.windowDays} days. L${worst.level} is the highest at ${worst.pctRejected}%.`
      : `Last ${b.windowDays} days. Nothing is being sent back.`;
    mountChart($('chart-rework'), hBars({
      rows: rw.map((e) => ({
        label: `L${e.level}`,
        pctRejected: e.pctRejected,
        tip: `<b>L${e.level}</b><br>${e.pctRejected}% of ${int(e.attempts)} attempts rejected`,
      })),
      valueKey: 'pctRejected',
      format: (v) => `${v}%`,
      accent: 'status',
      threshold: 25,
      note: 'Amber at 25% and above — each rejection re-runs an earlier level.',
    }));
  }
}

// ---------------------------------------------------------------------------
// in-flight tasks + matchups, with layer toggles
// ---------------------------------------------------------------------------

// Fetched separately from the brief and filtered in memory, so toggling a layer
// is instant rather than a round trip. `selected` is the source of truth; every
// render reads it, nothing derives state from the DOM.
let inflight = null;
const selected = new Set();

async function loadInflight() {
  const host = $('chart-matchups');
  try {
    inflight = await api('/overview/inflight');
  } catch (e) {
    clearChart(host, el('p', { class: 'ov-error' }, `Could not load in-flight tasks — ${e.message}`));
    return;
  }
  if (!inflight.enabled) {
    clearChart(host, el('p', { class: 'ov-error' }, 'Redash is not configured (REDASH_API_KEY unset).'));
    return;
  }
  if (inflight.error) {
    clearChart(host, el('p', { class: 'ov-error' }, `Query failed — ${inflight.error}`));
    return;
  }
  // Every layer on by default: the question is "what is in flight", and starting
  // with a partial view would misrepresent the total.
  for (const l of inflight.levels) selected.add(l.level);
  renderLayerToggles();
  renderMatchups();
}

const LEVEL_LABEL = (lvl) => `L${lvl}`;

function renderLayerToggles() {
  const host = $('ov-layers');
  const chips = inflight.levels.map((l) => {
    const on = selected.has(l.level);
    const btn = el('button', {
      class: `ov-layer${on ? ' is-on' : ''}`, type: 'button',
      'aria-pressed': on ? 'true' : 'false',
      title: `${l.total} in flight at level ${l.level}, ${l.withMatchup} with a recorded matchup`,
    }, LEVEL_LABEL(l.level), el('span', { class: 'ov-layer__n' }, String(l.total)));
    btn.addEventListener('click', () => {
      if (selected.has(l.level)) selected.delete(l.level); else selected.add(l.level);
      renderLayerToggles();
      renderMatchups();
    });
    return btn;
  });

  // All/none is the only pair of shortcuts worth having with six layers.
  const all = el('button', { class: 'ov-layer ov-layer--act', type: 'button' }, 'all');
  all.addEventListener('click', () => {
    for (const l of inflight.levels) selected.add(l.level);
    renderLayerToggles(); renderMatchups();
  });
  const none = el('button', { class: 'ov-layer ov-layer--act', type: 'button' }, 'none');
  none.addEventListener('click', () => {
    selected.clear(); renderLayerToggles(); renderMatchups();
  });

  mount(host, ...chips, el('span', { class: 'ov-layers__sep' }), all, none);
}

function renderMatchups() {
  const rows = inflight.rows.filter((r) => selected.has(r.level));
  const known = rows.filter((r) => r.matchup).length;

  $('ov-mu-sub').textContent = selected.size === 0
    ? 'No layers selected.'
    : `${int(rows.length)} task${rows.length === 1 ? '' : 's'} in flight across `
      + `${selected.size} of ${inflight.levels.length} layers — ${int(known)} with a recorded matchup.`;

  // Recount per matchup over the FILTERED rows, so the bars answer the question
  // the toggles just asked rather than showing project-wide totals.
  const counts = new Map();
  for (const r of rows) {
    const k = r.matchup || '(not yet recorded)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bars = [...counts.entries()]
    .sort((a, b) => {
      const an = a[0] === '(not yet recorded)', bn = b[0] === '(not yet recorded)';
      if (an !== bn) return an ? 1 : -1;
      return b[1] - a[1];
    })
    .map(([matchup, n]) => ({
      label: matchup.replace(/\s+vs\s+/, ' vs '),
      count: n,
      tip: `<b>${matchup.replace(/\s+vs\s+/, ' vs ')}</b><br>${int(n)} of ${int(rows.length)} selected`
        + `<br>${Math.round((n / Math.max(1, rows.length)) * 100)}% of the current selection`,
    }));

  if (!bars.length) {
    // clearChart, not mount: the host may hold a live chart whose ResizeObserver
    // would otherwise redraw it over this message.
    clearChart($('chart-matchups'), el('p', { class: 'ov-mu-empty' }, 'Nothing in flight in the selected layers.'));
  } else {
    // Model names are long and vary, so the label gutter is sized from the
    // longest one actually present rather than left at the default.
    const longest = Math.max(...bars.map((b2) => b2.label.length));
    mountChart($('chart-matchups'), hBars({
      rows: bars, valueKey: 'count', format: (v) => int(v),
      labelWidth: Math.min(330, Math.max(90, Math.round(longest * 6.4) + 18)),
      note: 'Model names as recorded upstream. A pairing is order-normalised, so X vs Y and Y vs X count together.',
    }));
  }

  // Oldest first — that is the actionable order for anything in flight.
  const sorted = [...rows].sort((a, b) => b.ageDays - a.ageDays || a.level.localeCompare(b.level));
  const table = $('ov-mu-table');
  const head = el('tr', {},
    el('th', {}, 'Task'), el('th', {}, 'Level'), el('th', { class: 'ov-num' }, 'Age'), el('th', {}, 'Matchup'));
  mount(table,
    el('thead', {}, head),
    el('tbody', {}, ...sorted.slice(0, 400).map((r) => el('tr', {},
      el('td', { class: 'mono' }, r.taskId),
      el('td', {}, LEVEL_LABEL(r.level)),
      el('td', { class: 'ov-num' }, `${r.ageDays}d`),
      el('td', { class: r.matchup ? '' : 'ov-mu-none' },
        r.matchup ? r.matchup.replace(/\s+vs\s+/, '  vs  ') : 'not yet recorded')))));

  // Say so when the table is capped, rather than letting 400 look like all of it.
  $('ov-mu-foot').textContent = sorted.length > 400
    ? `Showing the 400 oldest of ${int(sorted.length)} selected tasks.`
    : (sorted.length ? `All ${int(sorted.length)} selected tasks shown, oldest first.` : '');
}

function renderFoot(b) {
  const base = window.__base__ || '';
  mount($('ov-foot'),
    document.createTextNode('Pipeline data via Redash · delivery clock anchored to America/Los_Angeles · '),
    // Every chart on this page is one of four registry queries, so the raw rows
    // behind it are readable as a table (and downloadable as CSV) on the Redash
    // page. That is the non-visual path to these numbers.
    el('a', { href: `${base}/redash.html` }, 'view the underlying rows as tables'),
    b.errors?.length
      ? el('span', { class: 'ov-error' },
        ` · ${b.errors.length} query error(s): ` + b.errors.map((e) => `${e.query} — ${e.error}`).join('; '))
      : null);
}
