import { api, el, mount } from './common.js';

// Contributor-quality panels for the L12 Stats page.
//
// The rest of that page grades MODELS from what we audited. This grades the
// PEOPLE, using the pipeline's own QMS ratings and send-back rates rather than
// our verdicts — so a drop in incoming quality shows up here before it reaches
// the board as a wave of hard fails.
//
// Loads after everything disk-computed and never blocks it.

const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const score = (n) => (n == null ? '—' : Number(n).toFixed(2));
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

// Same 1–5 banding the QC action list thresholds are built on.
const qClass = (n) => (n == null ? '' : n >= 4 ? 'good' : n >= 3.6 ? 'mid' : 'bad');

function note(text, cls = '') {
  return el('div', { class: `rd-note ${cls}` }, text);
}

function emptyRow(cols, text) {
  return el('tr', {}, el('td', { class: 'empty', colspan: String(cols) }, text));
}

// Say when a table is truncated. A capped list that doesn't admit it reads as
// the whole set, which is how "everyone is fine" gets reported from a view that
// only ever showed the first forty rows.
function capNote(id, shown, total, unit) {
  const host = document.getElementById(id);
  if (!host) return;
  host.textContent = total > shown
    ? `Showing ${shown} of ${num(total)} ${unit}. The full list is on the Redash page.`
    : (total ? `All ${num(total)} ${unit} shown.` : '');
}

// ---------------------------------------------------------------------------
// Tier mix — the shape of the contributor population
// ---------------------------------------------------------------------------

// The two tiers that carry a hard instruction, and the one that only means
// "not enough evidence yet" — kept apart so the headline is not dominated by
// newcomers who have done nothing wrong.
const HOT = new Set(['attempter_disable', 'reviewer_demote']);
const NEW = new Set(['new_attempter', 'new_reviewer']);
const countIn = (q, set) => q.mix.filter((m) => set.has(m.tierKey)).reduce((a, m) => a + m.count, 0);
const hot = (q) => countIn(q, HOT);
const newcomers = (q) => countIn(q, NEW);

function renderMix(host, q) {
  if (!q.mix.length) return mount(host, note('No contributors in this window.'));
  const max = Math.max(1, ...q.mix.map((m) => m.count));

  mount(host,
    ...q.mix.map((m) => el('div', { class: 'rd-lvl' },
      el('div', { class: 'rd-lvl-name q-tier-name' }, m.tier),
      el('div', { class: 'rd-lvl-bar', title: `${m.count} contributor(s)` },
        el('div', { class: `rd-seg ${m.actionable ? 'q-seg-act' : 'q-seg-ok'}`, style: `width:${(m.count / max) * 100}%` })),
      el('div', { class: 'rd-lvl-pending' }, el('b', {}, num(m.count))),
      el('div', { class: 'rd-lvl-meta' },
        m.actionable ? el('span', { class: 'q-flag' }, 'needs action') : el('span', { class: 'dim' }, 'steady')))),
    // "Needs action" covers everything that is not already in a steady state,
    // which on these thresholds is most of the population — 190 of 212 at the
    // time of writing, largely people who simply have too few ratings yet. Lead
    // with the tiers that carry a hard instruction instead, or the headline
    // number reads as an emergency every single week.
    note(`${num(hot(q))} contributor(s) to disable or demote · ${num(newcomers(q))} awaiting enough samples · `
      + `${num(q.totals.contributors)} active in the last ${q.days} days. `
      + 'Tiers and thresholds match the ops QC list.'));
}

// ---------------------------------------------------------------------------
// Who to act on
// ---------------------------------------------------------------------------

function renderActions(table, q) {
  const head = el('tr', {},
    el('th', {}, 'Contributor'), el('th', {}, 'Role'),
    el('th', { class: 'rd-num' }, 'Quality'), el('th', { class: 'rd-num' }, 'Poor %'),
    el('th', { class: 'rd-num' }, 'Sent back'), el('th', { class: 'rd-num' }, 'Samples'),
    el('th', { class: 'rd-num' }, 'Wasted h'), el('th', {}, 'Recommended action'));

  const rows = q.actions.slice(0, 40).map((p) => el('tr', {},
    el('td', { class: 'q-who', title: p.team || '' },
      p.email, p.isInternal ? el('span', { class: 'q-int' }, 'internal') : null),
    el('td', {}, p.role),
    el('td', { class: `rd-num ${qClass(p.qms)}` }, score(p.qms)),
    el('td', { class: 'rd-num' }, pct(p.pdr)),
    el('td', { class: 'rd-num' }, pct(p.sbqPct)),
    el('td', { class: 'rd-num' }, num(p.samples)),
    // Hours the project paid for work that was thrown away. The QMS score says
    // the work was poor; this says what the poor work cost.
    el('td', { class: 'rd-num' }, p.uselessHours ? `${Math.round(p.uselessHours)}h` : el('span', { class: 'dim' }, '·')),
    el('td', {}, el('span', { class: `q-act q-act--${p.urgency <= 2 ? 'hot' : p.urgency <= 4 ? 'warn' : 'cool'}` }, p.action))));

  table.replaceChildren(head, ...(rows.length ? rows : [emptyRow(8, 'Nobody currently needs an action.')]));
  capNote('q-actions-foot', rows.length, q.actions.length, 'contributors with an action');
}

// ---------------------------------------------------------------------------
// Who is sliding — the early warning
// ---------------------------------------------------------------------------

const TREND_LABEL = {
  quality_dropped: 'Quality dropped',
  more_poor_ratings: 'More poor ratings',
  fell_below_trusted: 'Fell below trusted level',
};

function renderSlipping(table, q) {
  const head = el('tr', {},
    el('th', {}, 'Contributor'),
    el('th', { class: 'rd-num' }, 'Prior'), el('th', { class: 'rd-num' }, 'Now'),
    el('th', { class: 'rd-num' }, 'Change'), el('th', { class: 'rd-num' }, 'Poor % change'),
    el('th', { class: 'rd-num' }, 'Samples'), el('th', {}, 'Signal'));

  const rows = q.slipping.slice(0, 30).map((r) => el('tr', {},
    el('td', { class: 'q-who' }, r.email),
    el('td', { class: 'rd-num' }, score(r.qmsPrior)),
    el('td', { class: `rd-num ${qClass(r.qmsThis)}` }, score(r.qmsThis)),
    el('td', { class: 'rd-num bad' }, r.qmsChange == null ? '—' : r.qmsChange.toFixed(2)),
    el('td', { class: 'rd-num' }, r.pdrChangePp == null ? '—' : `${r.pdrChangePp > 0 ? '+' : ''}${r.pdrChangePp}pp`),
    // A two-sample "drop" is noise. Showing the counts stops the table being
    // read as a ranking when half of it rests on one or two ratings.
    el('td', { class: 'rd-num dim' }, `${num(r.nPrior)} → ${num(r.nThis)}`),
    el('td', {}, TREND_LABEL[r.trend] || r.trend)));

  table.replaceChildren(head, ...(rows.length ? rows : [emptyRow(7, 'No contributor slipped this window.')]));
  capNote('q-slipping-foot', rows.length, q.slipping.length, 'contributors slipping');
}

// ---------------------------------------------------------------------------
// Reviewer scorecard — including how hard each one grades
// ---------------------------------------------------------------------------

// Below this many grades awarded, an average is not a standard — it is a couple
// of tasks that happened to be good or bad.
const MIN_SCORES_FOR_CALIBRATION = 20;

function renderReviewers(table, q) {
  const head = el('tr', {},
    el('th', {}, 'Reviewer'), el('th', { class: 'rd-num' }, 'Reviews'),
    el('th', { class: 'rd-num' }, 'Sent back'), el('th', { class: 'rd-num' }, 'h/review'),
    el('th', { class: 'rd-num' }, 'Avg grade given'), el('th', { class: 'rd-num' }, 'vs project'),
    el('th', {}, 'Status'));

  const rows = q.reviewers.slice(0, 40).map((r) => {
    // Half a point off the project mean, in either direction, is a calibration
    // conversation: it is the difference between a 3 and a soft fail.
    //
    // But only once there is enough of a sample to mean anything. Without the
    // floor a reviewer who has graded once at 4.85 shows +1.10 and gets flagged
    // alongside someone 1.28 low across 57 reviews, which is the more serious
    // finding by far — and the flag stops meaning anything if both wear it.
    const off = r.calibrationDelta != null
      && r.scoresGiven >= MIN_SCORES_FOR_CALIBRATION
      && Math.abs(r.calibrationDelta) >= 0.5;
    return el('tr', {},
      el('td', { class: 'q-who', title: r.email }, r.name || r.email),
      el('td', { class: 'rd-num' }, num(r.reviews)),
      el('td', { class: 'rd-num' }, `${num(r.sbqIssued)} · ${pct(r.sbqPct)}`),
      el('td', { class: 'rd-num' }, r.avgHoursPerReview == null ? '—' : r.avgHoursPerReview.toFixed(2)),
      // Show the count behind the average, so a +1.10 on one review reads as the
      // one review it is rather than as a standard.
      el('td', { class: 'rd-num' }, score(r.avgScoreGiven),
        el('span', { class: 'dim' }, ` /${num(r.scoresGiven)}`)),
      el('td', { class: `rd-num ${off ? 'q-off' : 'dim'}` },
        r.calibrationDelta == null ? '—' : `${r.calibrationDelta > 0 ? '+' : ''}${r.calibrationDelta.toFixed(2)}`),
      el('td', {},
        r.hasTrustedTag ? el('span', { class: 'rd-chip' }, 'trusted') : null,
        r.hasReviewerTag && !r.hasTrustedTag ? el('span', { class: 'rd-chip' }, 'reviewer') : null,
        off ? el('span', { class: 'rd-chip warn' }, 'off calibration') : null));
  });

  table.replaceChildren(head, ...(rows.length ? rows : [emptyRow(7, 'No completed reviews in this window.')]));
  capNote('q-reviewers-foot', rows.length, q.reviewers.length, 'reviewers');
  const foot = document.getElementById('q-reviewers-foot');
  if (foot && rows.length) {
    foot.textContent += ` "vs project" is this reviewer's average grade minus the project's (${score(q.reviewers[0]?.projectMean)});`
      + ` flagged at ±0.50 once they have graded ${MIN_SCORES_FOR_CALIBRATION}+ times.`;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function initQualityPanels({ days = 30, windowDays = 7 } = {}) {
  const section = document.getElementById('q-section');
  if (!section) return;

  const mix = document.getElementById('q-mix');
  const actions = document.getElementById('q-actions');
  const slipping = document.getElementById('q-slipping');
  const reviewers = document.getElementById('q-reviewers');
  const stampEl = document.getElementById('q-stamp');

  async function load(fresh = false) {
    section.hidden = false;
    mount(mix, note('Loading contributor quality from Redash…'));

    let q;
    try {
      q = await api(`/redash/quality?days=${days}&windowDays=${windowDays}${fresh ? '&fresh=1' : ''}`);
    } catch (e) {
      return mount(mix, note(`Quality query failed: ${e.message}`, 'warn'));
    }
    if (!q.enabled) return mount(mix, note('Redash is not configured on this server (REDASH_API_KEY unset).', 'warn'));

    renderMix(mix, q);
    renderActions(actions, q);
    renderSlipping(slipping, q);
    renderReviewers(reviewers, q);

    // Partial failure is normal — one of the three can time out while the others
    // return. Say which, rather than showing an empty table as if it were a zero.
    if (q.errors.length) {
      mix.append(note(q.errors.map((e) => `${e.query} — ${e.error}`).join('; '), 'warn'));
    }
    stampEl.textContent = `${q.totals.contributors} contributors · ${q.days}d window · `
      + `${q.windowDays}d trend · ${new Date(q.generatedAt).toLocaleTimeString()}`;
  }

  document.getElementById('q-refresh')?.addEventListener('click', () => load(true));
  await load(false);
}
