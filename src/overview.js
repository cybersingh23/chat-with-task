import { config } from './config.js';
import { runRegistryQuery } from './redash_registry.js';
import { redashEnabled } from './redash.js';
import { listWorkspace } from './workspace.js';
import { chatCompletion } from './llm.js';

// The Overview page's data layer: one brief that answers "will we make Tuesday",
// and an LLM pass that turns the brief into prose.
//
// Everything time-related is computed in the DELIVERY timezone, not the server's
// and not the viewer's. The cadence is a property of the project, so a reviewer
// opening this from another continent should still be told it is delivery day
// when it is delivery day for the delivery.

const TZ = 'America/Los_Angeles';
const DELIVERY_WEEKDAY = 2;                 // Tuesday, 0 = Sunday
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The four stages the charts group review levels into. Six levels is more series
// than an ordinal ramp can separate legibly; these four are also the way the work
// is actually talked about. Levels absent from a batch simply contribute nothing.
export const STAGES = [
  { key: 'production',   label: 'Production',   levels: ['-1'],       hint: 'authoring the trajectory' },
  { key: 'early_review', label: 'Early review', levels: ['0', '1'],   hint: 'first and second pass' },
  { key: 'late_review',  label: 'Late review',  levels: ['4', '8', '10'], hint: 'QM layers' },
  { key: 'final',        label: 'Final',        levels: ['12'],       hint: 'ready to package' },
];

const STAGE_OF = new Map(STAGES.flatMap((s) => s.levels.map((l) => [l, s.key])));
export const stageOf = (level) => STAGE_OF.get(String(level)) || 'late_review';

// ---------------------------------------------------------------------------
// Delivery calendar
// ---------------------------------------------------------------------------

// Wall-clock parts in the delivery timezone. Intl is the only thing in Node that
// gets DST right without a dependency, so the whole calendar is derived from it
// rather than from date arithmetic on a UTC timestamp.
export function ptNow(at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  // hour12:false yields "24" at midnight in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday],
    label: `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${parts.minute} PT`,
  };
}

const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Where we are in the weekly rhythm. The phase drives the greeting; the LLM is
// told which phase it is rather than being asked to work out the date itself,
// because a model reasoning about "what day is it" is a reliable source of
// confident errors.
export function deliveryPhase(now = ptNow()) {
  const daysUntil = (DELIVERY_WEEKDAY - now.weekday + 7) % 7;
  const isDeliveryDay = daysUntil === 0;

  let phase, headline, tone;
  if (isDeliveryDay && now.hour < 12) {
    phase = 'delivery_morning';
    headline = 'Happy delivery day!';
    tone = 'Upbeat and energising. The batch ships tonight — celebrate that it is here, then get straight to what still has to land.';
  } else if (isDeliveryDay && now.hour < 17) {
    phase = 'delivery_afternoon';
    headline = 'Delivery day — final stretch.';
    tone = 'Focused and slightly urgent. Hours, not days. Lead with whatever is still short.';
  } else if (isDeliveryDay) {
    phase = 'delivery_evening';
    headline = 'Packaging window.';
    tone = 'Calm and procedural. The count is what it is now; talk about packaging and what carries to next week.';
  } else if (now.weekday === 3) {
    phase = 'recovery';
    headline = 'Post-delivery breather.';
    tone = 'Relaxed. Yesterday shipped. Look back at how it went before looking forward; no urgency today.';
  } else if (now.weekday === 4) {
    phase = 'rebuild';
    headline = 'Rebuilding the queue.';
    tone = 'Steady and constructive. Five days out. This is when the next batch is actually won or lost.';
  } else if (now.weekday === 5) {
    phase = 'friday';
    headline = 'Banking progress before the weekend.';
    tone = 'Pragmatic. Flag anything that would sit untouched for two days if it is not moved today.';
  } else if (now.weekday === 6 || now.weekday === 0) {
    phase = 'weekend';
    headline = 'Quiet weekend.';
    tone = 'Low-key and brief. Do not manufacture urgency; note what Monday will need to pick up.';
  } else {
    phase = 'eve';
    headline = 'One day out.';
    tone = 'Alert. Tomorrow is delivery day. Be specific about the gap and what can realistically close it today.';
  }

  return {
    phase,
    headline,
    tone,
    isDeliveryDay,
    daysUntil,
    nextDeliveryDate: addDays(now.date, daysUntil),
    deliveryWeekday: WEEKDAY_NAMES[DELIVERY_WEEKDAY],
  };
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

// One row per level -> the four stage buckets, preserving level detail inside.
function rollUpStages(levels) {
  return STAGES.map((s) => {
    const members = levels.filter((l) => stageOf(l.level) === s.key);
    return {
      key: s.key,
      label: s.label,
      hint: s.hint,
      pending: members.reduce((a, m) => a + m.pending, 0),
      stale: members.reduce((a, m) => a + m.stale, 0),
      levels: members.map((m) => m.level),
    };
  });
}

export async function buildBrief({ fresh = false, days = 30 } = {}) {
  const now = ptNow();
  const calendar = deliveryPhase(now);
  const board = boardSnapshot();

  if (!redashEnabled()) {
    return {
      now, calendar, board, redash: { enabled: false },
      pipeline: null, deliveries: null, economics: null, throughput: null,
    };
  }

  // Independent queries — run them together rather than serially. One failing
  // upstream shouldn't blank the whole page, so each is captured separately and
  // the renderer degrades per panel.
  const [deliveries, queue, economics, throughput] = await Promise.all([
    settle(() => runRegistryQuery('deliveries', {}, { fresh })),
    settle(() => runRegistryQuery('queue_state', {}, { fresh })),
    settle(() => runRegistryQuery('level_economics', { days }, { fresh })),
    settle(() => runRegistryQuery('throughput', { days }, { fresh })),
  ]);

  const levels = (queue.rows || []).map((r) => ({
    level: String(r.review_level),
    pending: num(r.pending),
    avgAgeDays: num(r.avg_age_days),
    oldestDays: num(r.oldest_days),
    stale: num(r.stale),
  }));
  const stages = rollUpStages(levels);
  const totalPending = levels.reduce((a, l) => a + l.pending, 0);

  // "Ready" is the pool that can plausibly reach packaging: the final level plus
  // the QM layer feeding it. Anything earlier needs a level transition first, so
  // counting it as ready would flatter the forecast.
  const readyNow = stages.find((s) => s.key === 'final')?.pending || 0;
  const nearlyReady = stages.find((s) => s.key === 'late_review')?.pending || 0;

  const history = (deliveries.rows || []).map((r) => ({
    date: String(r.delivered_on).slice(0, 10),
    dayName: r.day_name,
    hour: num(r.hour_pt),
    tasks: num(r.tasks),
  }));
  const last = history[0] || null;
  const recent = history.slice(0, 4);
  const trailingAvg = recent.length
    ? Math.round(recent.reduce((a, d) => a + d.tasks, 0) / recent.length)
    : 0;

  return {
    now,
    calendar,
    board,
    redash: { enabled: true },
    errors: pickErrors({ deliveries, queue, economics, throughput }),
    target: config.overview.targetVolume,
    deliveries: {
      history,
      last,
      trailingAvg,
      metTargetLast: last ? last.tasks >= config.overview.targetVolume : null,
    },
    pipeline: {
      levels,
      stages,
      totalPending,
      readyNow,
      nearlyReady,
      withinReach: readyNow + nearlyReady,
      gapToTarget: Math.max(0, config.overview.targetVolume - (readyNow + nearlyReady)),
      stale: {
        count: levels.reduce((a, l) => a + l.stale, 0),
        byLevel: levels.filter((l) => l.stale > 0).map((l) => ({ level: l.level, stale: l.stale, oldestDays: l.oldestDays })),
      },
    },
    economics: (economics.rows || []).map((r) => ({
      level: String(r.review_level),
      tasks: num(r.tasks),
      attempts: num(r.attempts),
      avgHours: num(r.avg_hours),
      medianHours: num(r.median_hours),
      totalHours: num(r.total_hours),
      activeHours: num(r.active_hours),
      pctRejected: num(r.pct_rejected),
    })),
    throughput: (throughput.rows || []).map((r) => ({
      day: String(r.day).slice(0, 10),
      level: String(r.review_level),
      tasks: num(r.tasks),
    })),
    windowDays: days,
  };
}

// Suggestions depend on the assembled brief, so they are attached after the fact
// rather than threaded through every branch above.
export async function briefWithSuggestions(opts) {
  const brief = await buildBrief(opts);
  return { ...brief, suggestions: buildSuggestions(brief) };
}

async function settle(fn) {
  try { return await fn(); } catch (e) { return { rows: [], error: e.message }; }
}

function pickErrors(map) {
  return Object.entries(map)
    .filter(([, v]) => v.error)
    .map(([k, v]) => ({ query: k, error: v.error }));
}

function boardSnapshot() {
  try {
    const ws = listWorkspace();
    const counts = Object.fromEntries(Object.entries(ws).map(([b, list]) => [b, list.length]));
    const claimed = Object.values(ws).flat().filter((t) => t.claimed_by).length;
    return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0), claimed };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

// Deliberately deterministic, and deliberately NOT the model's job.
//
// The prose above them is synthesis, which is what an LLM is good at. These are
// claims with numbers and links attached, which is what it is worst at — and
// they are the part someone will act on. Computing them here means they are
// exact, they are always present, and they survive the model being down.
//
// Kept to the few that carry an actual decision: a long list reads as noise and
// gets skipped, which is the same as not being there.
export function buildSuggestions(brief) {
  const pipeline = [];
  const board = [];
  const p = brief.pipeline;
  const c = brief.calendar;
  const target = brief.target;

  if (p) {
    if (p.gapToTarget > 0) {
      pipeline.push({
        severity: c.daysUntil <= 1 ? 'critical' : 'warn',
        text: `${p.gapToTarget} short of ${target} for ${c.isDeliveryDay ? 'today' : c.nextDeliveryDate}`,
        detail: `${p.readyNow} at final, ${p.nearlyReady} one layer back. The balance has to be promoted from earlier stages.`,
      });
    } else {
      pipeline.push({
        severity: 'ok',
        text: `${p.withinReach} within reach of the ${target} target`,
        detail: `${p.readyNow} already at final level. No promotion needed to make the number.`,
      });
    }

    if (p.stale.count > 0) {
      const worst = p.stale.byLevel.slice().sort((a, b) => b.oldestDays - a.oldestDays)[0];
      pipeline.push({
        severity: 'warn',
        text: `${p.stale.count} task${p.stale.count === 1 ? '' : 's'} stale past ${config.overview.staleDays} days`,
        detail: p.stale.byLevel.map((s) => `L${s.level}: ${s.stale}`).join(', ')
          + `. Oldest has sat ${worst.oldestDays} days at L${worst.level}.`,
      });
    }
  }

  // Rework: a level that rejects heavily is charging every earlier level twice.
  for (const e of brief.economics || []) {
    if (e.attempts >= 50 && e.pctRejected >= 100) {
      pipeline.push({
        severity: 'critical',
        text: `L${e.level} rejected every one of its ${fmtInt(e.attempts)} attempts`,
        detail: 'A 100% rejection rate is a gate behaving like a filter, not a review. Worth confirming it is configured as intended before planning capacity around it.',
      });
    } else if (e.attempts >= 50 && e.pctRejected >= 25) {
      pipeline.push({
        severity: 'warn',
        text: `L${e.level} is rejecting ${e.pctRejected}% of attempts`,
        detail: `${fmtInt(e.attempts)} attempts in the last ${brief.windowDays} days. Each rejection re-runs an earlier, more expensive level.`,
      });
    }
  }

  // Billable vs active divergence — the same "idle is total minus gen" split the
  // audit rules use. Only worth raising where the hours are material.
  const costly = (brief.economics || []).filter((e) => e.totalHours >= 100)
    .map((e) => ({ ...e, idleShare: e.totalHours ? 1 - e.activeHours / e.totalHours : 0 }))
    .sort((a, b) => b.totalHours - a.totalHours)[0];
  if (costly && costly.idleShare >= 0.5) {
    pipeline.push({
      severity: 'info',
      text: `L${costly.level} bills ${fmtInt(costly.totalHours)}h against ${fmtInt(costly.activeHours)}h active`,
      detail: `${Math.round(costly.idleShare * 100)}% of the billed clock is idle, and this level is the project's largest single cost.`,
    });
  }

  const b = brief.board;
  if (b) {
    if (b.UNSORTED > 0) {
      board.push({
        severity: c.daysUntil <= 1 ? 'warn' : 'info',
        text: `${b.UNSORTED} unsorted on the board`,
        detail: c.isDeliveryDay
          ? 'Delivery is today — anything unsorted will not be reflected in this batch.'
          : `${c.daysUntil} day${c.daysUntil === 1 ? '' : 's'} until ${c.nextDeliveryDate}.`,
        href: '/',
      });
    }
    if (b.HARD_FAIL > 0) {
      board.push({
        severity: 'warn',
        text: `${b.HARD_FAIL} hard fail${b.HARD_FAIL === 1 ? '' : 's'} awaiting remediation`,
        detail: 'A hard fail reshipped unchanged counts as failure-to-remediate on the next audit.',
        href: '/',
      });
    }
    if (b.total > 0 && b.claimed === 0) {
      board.push({
        severity: 'info',
        text: 'Nothing is claimed',
        detail: `All ${b.total} board tasks are unassigned, so no reviewer is currently on the hook for any of them.`,
        href: '/',
      });
    }
    if (!board.length) {
      board.push({ severity: 'ok', text: 'Board is clear', detail: 'Nothing unsorted and no outstanding hard fails.' });
    }
  }

  return { pipeline, board };
}

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

// ---------------------------------------------------------------------------
// AI synthesis
// ---------------------------------------------------------------------------

// A page view must not cost a model call. The summary is memoised against the
// brief's own shape — if the numbers that matter haven't moved, the cached prose
// is still true, so it is served regardless of age.
let cache = { key: null, at: 0, value: null };
const CACHE_TTL_MS = 30 * 60 * 1000;

// Bucketed on purpose. The pipeline is live, so an exact-value key changes every
// time a single task moves a level — which invalidated the cache between two
// page loads a minute apart and billed a fresh model call for prose that would
// have read identically. Rounding to 25 means the summary is regenerated when
// the picture actually changes, not when it jitters. Phase and date stay exact:
// crossing into delivery day must always re-write the copy.
const bucket = (n, step = 25) => (n === null || n === undefined ? null : Math.round(n / step) * step);

function cacheKey(brief) {
  const p = brief.pipeline;
  return JSON.stringify([
    brief.calendar.phase,
    brief.now.date,
    bucket(p?.totalPending), bucket(p?.readyNow), bucket(p?.nearlyReady),
    // Stale is small and individually meaningful, so it gets a tighter bucket.
    bucket(p?.stale.count, 5),
    brief.deliveries?.last?.date, brief.deliveries?.last?.tasks,
    bucket(brief.board?.UNSORTED, 10), bucket(brief.board?.HARD_FAIL, 5), bucket(brief.board?.SOFT_FAIL, 10),
  ]);
}

const SYSTEM = `You are Acey, the delivery lead's second pair of eyes on an ACC annotation pipeline.

You write the standing summary at the top of the Overview page. It is read every day, often
several times a day, by the person accountable for the weekly delivery. Your job is synthesis:
say what the numbers MEAN together, not what they are individually — the reader can see the
charts directly below you.

Voice: a sharp colleague who has already looked at everything. Direct, warm, unhurried. Never
corporate. Never a status-report template. No headings, no bullet characters in the prose, no
emoji. Short paragraphs.

Hard rules:
- Open with the exact headline you are given, verbatim, as the first sentence. Then continue.
- Three to five short paragraphs, the last of which is the single most useful thing to do next,
  written as prose. Never exceed five.
- Every number you cite must come from the brief. Never estimate, extrapolate or invent one.
- If something is genuinely fine, say so briefly and move on. Do not manufacture concern.
- Distinguish the two systems by name: the PIPELINE is upstream production; the BOARD is this
  app's own audit queue. Never blur an action between them.
- The reader knows the project. Do not explain what a review level is.`;

function buildPrompt(brief) {
  const p = brief.pipeline;
  const c = brief.calendar;
  const lines = [];

  lines.push(`RIGHT NOW: ${brief.now.label}`);
  lines.push(`PHASE: ${c.phase} — ${c.tone}`);
  lines.push(`HEADLINE TO OPEN WITH (verbatim): "${c.headline}"`);
  lines.push('');
  lines.push(`DELIVERY CADENCE: every ${c.deliveryWeekday}, target ${brief.target} tasks.`);
  lines.push(c.isDeliveryDay
    ? 'Today IS delivery day.'
    : `Next delivery: ${c.nextDeliveryDate}, ${c.daysUntil} day(s) away.`);

  if (brief.deliveries?.last) {
    const l = brief.deliveries.last;
    lines.push(`Last delivery: ${l.date} (${l.dayName}), ${l.tasks} tasks — ${l.tasks >= brief.target ? 'hit' : 'under'} the ${brief.target} target.`);
    // Dates here are the pipeline CLOSE-OUT, which trails the packaging run.
    // Without this the model has to guess why a Tuesday cadence shows Wednesday
    // dates, and a guess that happens to be right is still a guess.
    lines.push('Note: these dates are when the pipeline released the batch. Packaging happens the'
      + ' evening before, so a Wednesday close-out is the Tuesday delivery. Refer to deliveries by'
      + ' their delivery day, not the close-out date.');
    lines.push(`Trailing 4 deliveries average ${brief.deliveries.trailingAvg} tasks. Full history, newest first: ${brief.deliveries.history.map((h) => `${h.date}=${h.tasks}`).join(', ')}.`);
  }

  if (p) {
    lines.push('');
    lines.push(`PIPELINE (upstream, ${p.totalPending} tasks in flight):`);
    for (const s of p.stages) lines.push(`  ${s.label} (levels ${s.levels.join(', ') || 'none'}): ${s.pending} pending${s.stale ? `, ${s.stale} stale` : ''}`);
    lines.push(`  At the final level now: ${p.readyNow}. One layer back: ${p.nearlyReady}. Within reach: ${p.withinReach}.`);
    lines.push(p.gapToTarget > 0
      ? `  That is ${p.gapToTarget} SHORT of ${brief.target} — the rest must come from earlier stages.`
      : `  That covers the ${brief.target} target.`);
    if (p.stale.count) {
      lines.push(`  Stale (>7 days at current level): ${p.stale.count} — ${p.stale.byLevel.map((s) => `L${s.level}: ${s.stale} (oldest ${s.oldestDays}d)`).join('; ')}.`);
    }
  }

  if (brief.economics?.length) {
    lines.push('');
    lines.push(`LEVEL ECONOMICS (last ${brief.windowDays} days):`);
    for (const e of brief.economics) {
      lines.push(`  L${e.level}: ${e.attempts} attempts, ${e.avgHours}h avg, ${e.totalHours}h billed vs ${e.activeHours}h active, ${e.pctRejected}% rejected`);
    }
  }

  if (brief.board) {
    lines.push('');
    lines.push(`YOUR BOARD (this app's audit queue): ${brief.board.HARD_FAIL} hard, ${brief.board.SOFT_FAIL} soft, ${brief.board.PASS} pass, ${brief.board.UNSORTED} unsorted (${brief.board.total} total, ${brief.board.claimed} claimed).`);
  }

  lines.push('');
  lines.push('Write the summary now. Open with the headline verbatim, then three to five short paragraphs,');
  lines.push('ending with the single most useful thing to do next stated as prose.');
  return lines.join('\n');
}

export async function getSummary(brief, { refresh = false } = {}) {
  const key = cacheKey(brief);
  const fresh = cache.key === key && Date.now() - cache.at < CACHE_TTL_MS;
  if (!refresh && fresh && cache.value) return { ...cache.value, cached: true };

  if (!config.litellm.apiKey) {
    return { text: null, cached: false, error: 'LITELLM_API_KEY is not set' };
  }

  try {
    const msg = await chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(brief) },
      ],
      maxTokens: 4000,
    });
    const text = (typeof msg.content === 'string' ? msg.content : (msg.content || []).map((c) => c.text || '').join('')).trim();
    const value = { text, generatedAt: new Date().toISOString(), phase: brief.calendar.phase };
    cache = { key, at: Date.now(), value };
    return { ...value, cached: false };
  } catch (e) {
    // The deterministic headline still renders, so a model outage costs the
    // prose and nothing else.
    return { text: null, cached: false, error: e.message };
  }
}

export function clearSummaryCache() {
  cache = { key: null, at: 0, value: null };
  return true;
}
