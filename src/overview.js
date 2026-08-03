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
  const [deliveries, queue, economics, throughput, intake] = await Promise.all([
    settle(() => runRegistryQuery('deliveries', {}, { fresh })),
    settle(() => runRegistryQuery('queue_state', {}, { fresh })),
    settle(() => runRegistryQuery('level_economics', { days }, { fresh })),
    settle(() => runRegistryQuery('throughput', { days }, { fresh })),
    settle(() => runRegistryQuery('l12_intake', { days }, { fresh })),
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

  // DELIVERABLE = level 12, and nothing else.
  //
  // This was wrong before and it was the single biggest source of bad numbers on
  // the page. The earlier version added the L10 feeder to L12 and called the sum
  // "within reach", which turned a 289-task shortfall into a reported 43 — a
  // reassuring number with nothing behind it. A task at L10 is not deliverable;
  // it is supply that still has to REACH L12. Progress is measured off L12.
  //
  // Deliberately not called "promotion" anywhere user-facing: promotion already
  // means something else on the platform (worker tiers), so using it for a task
  // moving between review levels reads as the wrong concept entirely.
  const deliverable = levels.find((l) => l.level === '12')?.pending || 0;
  const feeder = levels.find((l) => l.level === '10')?.pending || 0;
  const upstream = levels.filter((l) => !['10', '12'].includes(l.level))
    .reduce((a, l) => a + l.pending, 0);

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
      deliverable,
      feeder,
      upstream,
      progressPct: Math.round((deliverable / config.overview.targetVolume) * 100),
      gapToTarget: Math.max(0, config.overview.targetVolume - deliverable),
      // Whether the target is even reachable from what exists: everything still
      // in flight, deliverable or not. Short here is a supply problem; short on
      // `deliverable` alone is a movement problem. They need different actions.
      supplyShortfall: Math.max(0, config.overview.targetVolume - totalPending),
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
    intake: intakeSeries(intake.rows || [], history, now),
    health: pipelineHealth({ levels, economics: economics.rows || [], throughput: throughput.rows || [], now }),
    windowDays: days,
  };
}

// Daily arrivals into the deliverable state, plus the only comparison that means
// anything: this cycle against the SAME POINT in the previous cycle. L12 fills in
// the last 72 hours before a delivery, so "61 deliverable" on a Sunday is not
// comparable to 350 — it is comparable to what Sunday looked like last week.
function intakeSeries(rows, history, now) {
  const days = rows.map((r) => ({
    day: String(r.day).slice(0, 10),
    dayName: r.day_name,
    entered: num(r.entered),
  }));
  const sinceInclusive = (from, to) => days
    .filter((d) => d.day >= from && d.day <= to)
    .reduce((a, d) => a + d.entered, 0);

  // Cycle boundaries are the delivery close-out dates, newest first.
  const dates = history.map((h) => h.date);
  const lastDelivery = dates[0] || null;
  const prevDelivery = dates[1] || null;

  // Day names come from the query, never inferred. Handing the model a bare
  // "2026-07-29" made it describe a Wednesday close-out as Friday's — the same
  // failure mode as asking it what day today is, just about a past date.
  const dayNameOf = (d) => history.find((h) => h.date === d)?.dayName || null;

  let thisCycle = null, lastCycleToDate = null, offsetDays = null;
  if (lastDelivery) {
    thisCycle = sinceInclusive(lastDelivery, now.date);
    offsetDays = Math.round((Date.parse(`${now.date}T00:00:00Z`) - Date.parse(`${lastDelivery}T00:00:00Z`)) / 86400e3);
    if (prevDelivery && offsetDays != null) {
      const end = new Date(Date.parse(`${prevDelivery}T00:00:00Z`) + offsetDays * 86400e3).toISOString().slice(0, 10);
      lastCycleToDate = sinceInclusive(prevDelivery, end);
    }
  }
  return {
    days, thisCycle, lastCycleToDate, offsetDays,
    lastDelivery, prevDelivery,
    lastDeliveryDay: dayNameOf(lastDelivery),
    prevDeliveryDay: dayNameOf(prevDelivery),
  };
}

// A few signals, each with a direction, so the summary can talk about pipeline
// HEALTH rather than only the delivery count. Everything here is derived from
// numbers already fetched — no extra queries.
function pipelineHealth({ levels, economics, throughput, now }) {
  const ec = economics.map((r) => ({
    level: String(r.review_level),
    attempts: num(r.attempts),
    avgHours: num(r.avg_hours),
    totalHours: num(r.total_hours),
    activeHours: num(r.active_hours),
    pctRejected: num(r.pct_rejected),
  }));

  // Throughput trend: last 7 days against the 7 before, on total activity.
  const byDay = {};
  for (const r of throughput) byDay[String(r.day).slice(0, 10)] = (byDay[String(r.day).slice(0, 10)] || 0) + num(r.tasks);
  const sorted = Object.keys(byDay).sort();
  const tail = (n, skip = 0) => sorted.slice(Math.max(0, sorted.length - n - skip), sorted.length - skip)
    .reduce((a, d) => a + byDay[d], 0);
  const last7 = tail(7);
  const prior7 = tail(7, 7);
  const trendPct = prior7 ? Math.round(((last7 - prior7) / prior7) * 100) : null;

  const rework = ec.filter((e) => e.attempts >= 50).sort((a, b) => b.pctRejected - a.pctRejected)[0] || null;
  const costliest = ec.filter((e) => e.totalHours >= 100).sort((a, b) => b.totalHours - a.totalHours)[0] || null;
  const stale = levels.reduce((a, l) => a + l.stale, 0);
  // The level holding the most work is where the queue is actually backed up.
  const bottleneck = [...levels].sort((a, b) => b.pending - a.pending)[0] || null;

  return {
    last7, prior7, trendPct,
    worstRework: rework ? { level: rework.level, pctRejected: rework.pctRejected, attempts: rework.attempts } : null,
    costliest: costliest
      ? { level: costliest.level, totalHours: costliest.totalHours, activeHours: costliest.activeHours,
          idlePct: costliest.totalHours ? Math.round((1 - costliest.activeHours / costliest.totalHours) * 100) : 0 }
      : null,
    stale,
    bottleneck: bottleneck ? { level: bottleneck.level, pending: bottleneck.pending, oldestDays: bottleneck.oldestDays } : null,
    asOf: now.label,
  };
}

// Suggestions depend on the assembled brief, so they are attached after the fact
// rather than threaded through every branch above.
export async function fullBrief(opts) {
  const brief = await buildBrief(opts);
  return { ...brief, assignments: buildAssignments(brief) };
}

async function settle(fn) {
  try { return await fn(); } catch (e) { return { rows: [], error: e.message }; }
}

function pickErrors(map) {
  return Object.entries(map)
    .filter(([, v]) => v.error)
    .map(([k, v]) => ({ query: k, error: v.error }));
}

// Counts alone can't produce a real action item — "triage 24 tasks" needs to know
// which 24 are actually unowned, and "remediate the hard fails" needs to know
// which ones are still missing their remediation doc. So the snapshot carries the
// work-shaped facts, not just bucket totals.
function boardSnapshot() {
  try {
    const ws = listWorkspace();
    const all = Object.values(ws).flat();
    const counts = Object.fromEntries(Object.entries(ws).map(([b, list]) => [b, list.length]));

    // taskMeta exposes claimedBy (camelCase); reading claimed_by here silently
    // made every task look unowned and reported "nothing is claimed" while five
    // tasks were in fact held.
    const owner = (t) => t.claimedBy || null;
    const byOwner = {};
    for (const t of all) {
      const who = owner(t);
      if (!who) continue;
      const e = (byOwner[who] ||= { count: 0, hardNoRemediation: 0 });
      e.count += 1;
      if (t.bucket === 'HARD_FAIL' && !t.hasRemediation) e.hardNoRemediation += 1;
    }

    const unsortedOpen = (ws.UNSORTED || []).filter((t) => !owner(t));
    const hardOpen = (ws.HARD_FAIL || []).filter((t) => !owner(t));
    return {
      ...counts,
      total: all.length,
      claimed: all.filter(owner).length,
      byOwner,
      unsortedOpen: unsortedOpen.length,
      // A hard fail with no remediation.md is the one that reships unchanged and
      // becomes a failure-to-remediate finding on the next audit.
      hardNoRemediation: hardOpen.filter((t) => !t.hasRemediation).length,
      grammarLane: all.filter((t) => t.inGrammarLane && !owner(t)).length,
      unauditedSoft: (ws.SOFT_FAIL || []).filter((t) => !owner(t) && !t.hasReview).length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-person action items
// ---------------------------------------------------------------------------

// Deterministic, and deliberately NOT the model's job. These name a person and a
// number, and being confidently wrong about either is worse than saying nothing.
// The prose above is synthesis, which is what an LLM is good at; this is a list of
// claims with owners attached, which is what it is worst at. Computing it here
// means it is exact, always present, and survives the model being down. The model
// is told these exist only so its prose does not duplicate them.
//
// Split, not duplicated: an even share means four people can work in parallel
// without two of them opening the same task. Remainders go to the people earliest
// in the rotation rather than all to one person.
function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// Rotate week to week so the same person doesn't inherit the same chore forever,
// but stay stable inside a week so the page doesn't reshuffle between loads.
function rotate(list, isoDate) {
  const week = Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / (7 * 86400e3));
  const k = ((week % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

export function buildAssignments(brief) {
  const b = brief.board;
  const p = brief.pipeline;
  const c = brief.calendar;
  const roster = rotate(config.overview.reviewers, c.nextDeliveryDate);
  const items = Object.fromEntries(roster.map((r) => [r, []]));
  const add = (who, system, text, detail) => items[who]?.push({ system, text, detail });

  // Claimed work, before any suggested split. A task someone already holds must
  // never be silently re-offered to somebody else, and — the case that actually
  // bit here — must never just vanish because its owner isn't a reviewer.
  const parked = [];
  if (b) {
    for (const [who, e] of Object.entries(b.byOwner || {})) {
      const risk = e.hardNoRemediation
        ? ` ${e.hardNoRemediation} of them ${e.hardNoRemediation === 1 ? 'is a hard fail with' : 'are hard fails with'} no remediation.md, which reships as a failure-to-remediate finding.`
        : '';
      if (items[who]) {
        add(who, 'board', `Finish the ${e.count} task${e.count === 1 ? '' : 's'} you have claimed`,
          `Already yours on the board.${risk}`);
      } else {
        // Held by the lead, or by someone outside the review team. Either way it
        // is the lead's to finish or hand off, so it surfaces there rather than
        // dropping out of the page entirely.
        parked.push({ who, ...e, risk });
      }
    }

    // Every per-task pool splits across the WHOLE roster. An earlier version sent
    // hard fails to just two people on a "highest stakes, fewest hands" theory,
    // which was only tolerable while the pool was small: at 29 outstanding it
    // handed two people 15 each and left a third reviewer with nothing to do.
    // This work parallelises per task, so there is no reason to concentrate it.
    const pools = [
      {
        n: b.hardNoRemediation,
        label: (n) => `Write remediation for ${n} hard fail${n === 1 ? '' : 's'}`,
        detail: `${b.hardNoRemediation} hard fails have no remediation.md. Reshipped unchanged, each becomes a failure-to-remediate finding — this is the highest-stakes queue on the board.`,
      },
      {
        n: b.unsortedOpen,
        label: (n) => `Triage ${n} of the ${b.unsortedOpen} unclaimed unsorted`,
        detail: 'Claim before you start so two of you do not open the same task.',
      },
      {
        // Computed but previously never assigned, so it was invisible work.
        n: b.unauditedSoft,
        label: (n) => `Review ${n} soft fail${n === 1 ? '' : 's'} with no review.md`,
        detail: `${b.unauditedSoft} soft fails are unclaimed and un-audited. Each needs a review doc before it can be resolved.`,
      },
    ];
    for (const pool of pools) {
      if (pool.n <= 0) continue;
      splitEvenly(pool.n, roster.length).forEach((n, i) => {
        if (n > 0) add(roster[i], 'board', pool.label(n), pool.detail);
      });
    }

    if (b.grammarLane > 0) {
      const who = roster[roster.length - 1];
      add(who, 'board', `Run grammar fixes on ${b.grammarLane} task${b.grammarLane === 1 ? '' : 's'}`,
        'Grammar-only tasks — everything else on them is already clean.');
    }
  }

  // Stale pipeline work goes to one owner: chasing the same four tasks in
  // parallel is how two people both wait for the other to do it.
  if (p?.stale?.count > 0) {
    const worst = p.stale.byLevel.slice().sort((a, b2) => b2.stale - a.stale)[0];
    add(roster[1 % roster.length], 'pipeline',
      `Chase the ${p.stale.count} stale task${p.stale.count === 1 ? '' : 's'} upstream`,
      `${p.stale.byLevel.map((s) => `L${s.level}: ${s.stale}`).join(', ')}. Biggest cluster is L${worst.level}. These sit in the layer feeding delivery.`);
  }

  const reviewers = roster.map((name) => ({ name, items: items[name] }));

  // ---- the lead: direction and cross-functional, never a share of the queue ----
  const lead = [];

  // The one exception to "no queue work for the lead": tasks already claimed by
  // them or by someone off the review roster. Not a share of the backlog — a
  // handoff decision, which is theirs to make.
  for (const q of parked) {
    const mine = q.who === config.overview.lead;
    lead.push({
      system: 'board',
      text: mine
        ? `${q.count} board task${q.count === 1 ? '' : 's'} still claimed by you`
        : `${q.count} task${q.count === 1 ? '' : 's'} claimed by ${q.who}, outside the review team`,
      detail: `${mine ? 'Finish or release so a reviewer can pick them up.' : 'No reviewer can claim these while they are held.'}${q.risk}`,
    });
  }

  if (p && p.gapToTarget > 0) {
    lead.push({
      system: 'decision',
      text: `Commit to ${brief.target} for ${c.isDeliveryDay ? 'today' : c.nextDeliveryDate} or reset it`,
      detail: `${p.deliverable} deliverable at L12 now, ${p.gapToTarget} short of ${brief.target}. `
        + `${p.feeder} are sitting at L10 and still have to reach L12`
        + `${p.supplyShortfall > 0 ? `, and even everything in flight is ${p.supplyShortfall} short` : ''}`
        + '. Cheaper decided early than discovered on delivery day.',
    });
  }
  for (const e of brief.economics || []) {
    if (e.attempts >= 50 && e.pctRejected >= 100) {
      lead.push({
        system: 'cross-functional',
        text: `Raise L${e.level} with the pipeline owners`,
        detail: `It rejected all ${fmtInt(e.attempts)} of its attempts in ${brief.windowDays} days. Nobody on this team can fix a gate's configuration, and every capacity plan behind it is wrong until someone does.`,
      });
    }
  }
  const costly = (brief.economics || []).filter((e) => e.totalHours >= 100)
    .map((e) => ({ ...e, idle: e.totalHours ? 1 - e.activeHours / e.totalHours : 0 }))
    .sort((a, b2) => b2.totalHours - a.totalHours)[0];
  if (costly && costly.idle >= 0.5) {
    lead.push({
      system: 'cross-functional',
      text: `Take the L${costly.level} billed-vs-active gap to whoever owns cost`,
      detail: `${fmtInt(costly.totalHours)}h billed against ${fmtInt(costly.activeHours)}h active — ${Math.round(costly.idle * 100)}% idle on the project's largest line item.`,
    });
  }
  if (brief.deliveries?.trailingAvg && brief.deliveries.trailingAvg < brief.target) {
    lead.push({
      system: 'direction',
      text: `Set expectations against the trailing average, not the last result`,
      detail: `Four-delivery average is ${brief.deliveries.trailingAvg} against a ${brief.target} target. One batch hitting ${brief.target} is not yet a capacity change, and planning as though it is will keep producing near-misses.`,
    });
  }
  if (!lead.length) {
    lead.push({ system: 'direction', text: 'Nothing needs escalating', detail: 'Target is covered, no gate is misbehaving and cost is proportionate.' });
  }

  // Capped, and ranked before capping. Handing the lead every escalation-shaped
  // item turned their card into a six-entry backlog, which is the opposite of
  // useful for someone whose job is picking what matters. Two is enough to act on
  // this week; the underlying signals are all still on the charts.
  const RANK = { board: 0, decision: 1, 'cross-functional': 2, direction: 3 };
  const leadTop = lead
    .slice()
    .sort((a, b2) => (RANK[a.system] ?? 9) - (RANK[b2.system] ?? 9))
    .slice(0, 2);

  return {
    lead: { name: config.overview.lead, items: leadTop },
    reviewers,
  };
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
    bucket(p?.totalPending), bucket(p?.deliverable, 10), bucket(p?.feeder),
    // Stale is small and individually meaningful, so it gets a tighter bucket.
    bucket(p?.stale.count, 5),
    brief.deliveries?.last?.date, brief.deliveries?.last?.tasks,
    bucket(brief.board?.UNSORTED, 10), bucket(brief.board?.HARD_FAIL, 5), bucket(brief.board?.SOFT_FAIL, 10),
  ]);
}

const SYSTEM = `You are Acey, the delivery lead's second pair of eyes on an ACC annotation pipeline.

You write the short standing summary at the top of the Overview page, read several times a day
by the person accountable for the weekly delivery. Your job is the READ: what the numbers mean
together, and what it implies. The charts below you show the numbers; per-person action items
are generated separately and listed under you.

Cover BOTH of these, in this order:
  1. Delivery progress — how much is actually deliverable against the target, read against where
     the cycle normally is at this point rather than against the target alone.
  2. Pipeline HEALTH — throughput trend, where the queue is backed up, rework, aging. One or two
     signals, whichever are actually moving. Not a list of everything.
Then close with what to do AT THIS MOMENT — the actions should fit the day and hour you are given.
Sunday afternoon and Tuesday 10am deserve different advice from the same numbers.

BREVITY IS THE POINT. Three short paragraphs, under 110 words in total. A reader should get the
whole picture in about twenty seconds. Shorter is better every time.

Voice: a sharp colleague who has already looked at everything and respects your time. Warm but
economical. No headings, no bullets, no emoji.

Hard rules:
- Open with the exact headline you are given, verbatim, as the first sentence. Then continue.
- Under 110 words after the headline. Three short paragraphs.
- Every number you cite must come from the brief. Never estimate or invent one. Cite only the
  three or four numbers that carry the point; the charts have the rest.
- LEVEL 12 IS THE ONLY DELIVERABLE STATE. Never add upstream levels to it and call the sum ready
  or within reach — a task at L10 is supply, not progress. If you mean the whole in-flight pool,
  say "in flight".
- VOCABULARY: never say "promote", "promoted" or "promotion" about a task moving between review
  levels. On this platform promotion means something else entirely (worker tiers), so it reads as
  the wrong concept. Say a task "reaches L12", "moves to L12", or "moves up a level".
- Do NOT assign work or name people. That is handled below you and duplicating it wastes lines.
- Where both systems come up, name them so they can't be confused: "the pipeline" is upstream
  production, "the board" is this app's audit queue. Write them in normal prose capitalisation —
  never shout them as PIPELINE and BOARD.
- The reader knows the project. Never explain what a review level is.

Cut, specifically:
- Scene-setting and mood ("nothing is on fire", "in the way a weekend should be").
- Meta-commentary on your own points ("worth saying plainly", "one thing worth flagging",
  "the whole story", "no action needed").
- Restating a number you already gave in different words.
- Any sentence that would still be true next week. If it is not about THIS week, cut it.`;

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
    // Spelled out with the actual timeline, because "the evening before" was
    // read as "the evening before Tuesday" and produced advice about packaging on
    // Monday. Packaging is ON delivery day; the close-out lands the next morning.
    lines.push(`Note on these dates: they are when the PIPELINE closed the batch out, which is the`
      + ` morning AFTER packaging. Packaging happens on delivery day itself, in the evening —`
      + ` e.g. packaged Tue 2026-07-28 23:48, closed out Wed 2026-07-29 10:00. So the next`
      + ` packaging window is the evening of ${c.isDeliveryDay ? 'today' : c.nextDeliveryDate},`
      + ` a ${c.deliveryWeekday}. Never describe packaging as happening the day before delivery.`);
    lines.push(`Trailing 4 deliveries average ${brief.deliveries.trailingAvg} tasks. Full history, newest first: ${brief.deliveries.history.map((h) => `${h.date}=${h.tasks}`).join(', ')}.`);
  }

  if (p) {
    lines.push('');
    lines.push(`PIPELINE (upstream, ${p.totalPending} tasks in flight):`);
    for (const s of p.stages) lines.push(`  ${s.label} (levels ${s.levels.join(', ') || 'none'}): ${s.pending} pending${s.stale ? `, ${s.stale} stale` : ''}`);
    lines.push(`  DELIVERABLE NOW (at L12): ${p.deliverable} of ${brief.target} — ${p.progressPct}%. L12 is the deliverable state;`);
    lines.push(`  nothing upstream counts until it reaches L12. Feeder at L10: ${p.feeder}. Deeper upstream: ${p.upstream}.`);
    lines.push(p.gapToTarget > 0
      ? `  That is ${p.gapToTarget} SHORT of ${brief.target} — the rest must come from earlier stages.`
      : `  That covers the ${brief.target} target.`);
    if (p.stale.count) {
      lines.push(`  Stale (>7 days at current level): ${p.stale.count} — ${p.stale.byLevel.map((s) => `L${s.level}: ${s.stale} (oldest ${s.oldestDays}d)`).join('; ')}.`);
    }
  }

  // Cycle-position context. Without it, "61 deliverable against 350" reads as a
  // catastrophe on a Sunday when it is roughly the normal shape of a Sunday.
  const ik = brief.intake;
  if (ik?.thisCycle != null) {
    lines.push('');
    lines.push('DELIVERABLE INTAKE (how fast work reaches L12):');
    lines.push(`  Since the last delivery (${ik.lastDelivery}${ik.lastDeliveryDay ? `, a ${ik.lastDeliveryDay}` : ''}, ${ik.offsetDays} day(s) ago): ${ik.thisCycle} tasks entered L12.`);
    if (ik.lastCycleToDate != null) {
      lines.push(`  Same point in the previous cycle (from ${ik.prevDelivery}${ik.prevDeliveryDay ? `, a ${ik.prevDeliveryDay}` : ''}): ${ik.lastCycleToDate}. That is the fair comparison, NOT the target.`);
    }
    // Every date in this brief carries its weekday. Do not work one out.
    lines.push('  Use the day names given here verbatim; never infer a weekday from a date yourself.');
    const recent = ik.days.slice(-6).map((d) => `${d.day}(${d.dayName})=${d.entered}`).join(', ');
    if (recent) lines.push(`  Recent daily intake: ${recent}.`);
    lines.push('  L12 fills late: for the 350 batch, 80% arrived in the final three days and 135 on delivery day itself.');
  }

  const h = brief.health;
  if (h) {
    lines.push('');
    lines.push('PIPELINE HEALTH:');
    if (h.trendPct != null) lines.push(`  Activity last 7 days ${h.last7} vs ${h.prior7} the week before (${h.trendPct >= 0 ? '+' : ''}${h.trendPct}%).`);
    if (h.bottleneck) lines.push(`  Most work queued at L${h.bottleneck.level}: ${h.bottleneck.pending} pending, oldest ${h.bottleneck.oldestDays} days.`);
    if (h.worstRework) lines.push(`  Highest rework: L${h.worstRework.level} rejecting ${h.worstRework.pctRejected}% of ${h.worstRework.attempts} attempts.`);
    if (h.costliest) lines.push(`  Largest cost: L${h.costliest.level}, ${h.costliest.totalHours}h billed vs ${h.costliest.activeHours}h active (${h.costliest.idlePct}% idle).`);
    if (h.stale) lines.push(`  Stale past ${config.overview.staleDays} days: ${h.stale}.`);
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
  lines.push('Per-person action items are generated separately and shown directly below your summary,');
  lines.push('so do not assign work or name anyone.');
  lines.push('');
  lines.push('Write the summary now. Open with the headline verbatim, then THREE short paragraphs under 110');
  lines.push('words total: delivery progress against where the cycle normally is, one or two health signals');
  lines.push(`that are actually moving, and what to do right now given it is ${brief.now.label}.`);
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
