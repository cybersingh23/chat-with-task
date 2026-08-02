import { api, el, mount, renderAppHeader } from './common.js';
import { mountChart, deliveryColumns, readinessFunnel, stackedArea, hBars, legend } from './charts.js';

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
  renderQueues(brief);
  renderCharts(brief);
  renderFoot(brief);
  loadSummary({});
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
  mount($('ov-countdown'),
    chip('', c.isDeliveryDay ? 'delivery is today' : `days to ${c.deliveryWeekday}`, c.isDeliveryDay ? '—' : String(c.daysUntil)),
    p ? chip('', 'within reach', int(p.withinReach)) : null,
    p ? chip(p.gapToTarget > 0 ? 'ov-stat--warn' : 'ov-stat--ok', p.gapToTarget > 0 ? `short of ${b.target}` : `target ${b.target}`,
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

function renderQueues(b) {
  const sug = b.suggestions;
  if (!sug) return;
  const group = (title, hint, items, href) => el('div', { class: 'ov-queue' },
    el('div', { class: 'ov-queue__head' },
      el('h3', {}, title),
      el('span', { class: 'ov-queue__hint' }, hint)),
    el('ul', { class: 'ov-queue__list' },
      ...items.map((s) => el('li', { class: `ov-sug ov-sug--${s.severity}` },
        el('span', { class: 'ov-sug__dot', 'aria-hidden': 'true' }),
        el('div', {},
          s.href
            ? el('a', { class: 'ov-sug__text', href: (window.__base__ || '') + s.href }, s.text)
            : el('span', { class: 'ov-sug__text' }, s.text),
          el('span', { class: 'ov-sug__detail' }, s.detail))))));

  mount($('ov-queues'),
    group('Pipeline', 'upstream production', sug.pipeline),
    group('Your board', 'this app’s audit queue', sug.board));
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

function renderCharts(b) {
  if (!b.redash?.enabled) {
    for (const id of ['chart-deliveries', 'chart-funnel', 'chart-throughput', 'chart-cost', 'chart-rework']) {
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

  // 2 — readiness funnel
  if (b.pipeline?.stages?.length) {
    const p = b.pipeline;
    $('ov-funnel-sub').textContent = p.gapToTarget > 0
      ? `${int(p.withinReach)} of ${int(b.target)} within reach — ${int(p.gapToTarget)} must come from earlier stages.`
      : `${int(p.withinReach)} within reach of ${int(b.target)}. The target is covered.`;
    mountChart($('chart-funnel'), readinessFunnel({ stages: p.stages, target: b.target }));
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
