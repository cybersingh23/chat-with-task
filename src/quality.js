import { runRegistryQuery } from './redash_registry.js';
import { redashEnabled } from './redash.js';

// The contributor-quality layer for the L12 Stats page.
//
// Everything else the app knows about quality is OUR judgement: the board's
// Hard/Soft/Pass verdicts on tasks we audited. This is the pipeline's own
// judgement of the people who produced that work — QMS ratings, send-back rates
// and the tiers ops actually acts on — so the two can finally be read side by
// side. It answers "is the work arriving worse than it was", which no
// disk-computed number on that page can.
//
// Three registry queries, run together and rolled up here rather than in the
// browser: the tier mix and the action list are two views of ONE population, and
// deriving them separately client-side is exactly how the source dashboard ended
// up with two charts describing different denominators.

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

// Only these carry an instruction. The two steady-state tiers are healthy and
// are counted in the mix but never listed as work.
const ACTIONABLE = new Set([
  'attempter_disable', 'reviewer_demote', 'attempter_untrusted',
  'reviewer_untrusted', 'attempter_promote', 'new_attempter', 'new_reviewer',
]);

async function settle(fn) {
  try { return await fn(); } catch (e) { return { rows: [], error: e.message }; }
}

export async function qualitySnapshot({ fresh = false, days = 30, windowDays = 7, level = 0 } = {}) {
  if (!redashEnabled()) return { enabled: false };

  const [quality, trend, reviewers] = await Promise.all([
    settle(() => runRegistryQuery('contributor_quality', { days }, { fresh })),
    settle(() => runRegistryQuery('quality_trend', { window_days: windowDays }, { fresh })),
    settle(() => runRegistryQuery('reviewer_scorecard', { level, days }, { fresh })),
  ]);

  const people = (quality.rows || []).map((r) => ({
    email: r.email,
    team: r.team,
    role: r.role,
    isInternal: !!r.is_internal,
    attempts: num(r.attempts),
    hours: num(r.hours),
    uselessHours: num(r.useless_hours),
    uselessPct: num(r.useless_pct),
    samples: num(r.qms_samples),
    qms: r.qms_score == null ? null : Number(r.qms_score),
    pdr: r.pdr == null ? null : Number(r.pdr),
    sbqPct: r.sbq_pct == null ? null : Number(r.sbq_pct),
    tierKey: r.tier_key,
    tier: r.tier,
    action: r.ops_action,
    needsAction: !!r.needs_action,
    urgency: num(r.urgency),
    lastActive: r.last_active_pt || null,
  }));

  // Tier mix over the SAME rows the action list is drawn from, so the two can
  // never disagree about how many people are on the project.
  const mix = new Map();
  for (const p of people) {
    const e = mix.get(p.tierKey) || { tierKey: p.tierKey, tier: p.tier, count: 0, actionable: ACTIONABLE.has(p.tierKey) };
    e.count += 1;
    mix.set(p.tierKey, e);
  }

  const trendRows = (trend.rows || []).map((r) => ({
    email: r.email,
    nPrior: num(r.n_prior),
    nThis: num(r.n_this),
    qmsPrior: r.qms_prior == null ? null : Number(r.qms_prior),
    qmsThis: r.qms_this == null ? null : Number(r.qms_this),
    qmsChange: r.qms_change == null ? null : Number(r.qms_change),
    pdrChangePp: r.pdr_change_pp == null ? null : Number(r.pdr_change_pp),
    trend: r.trend,
    urgency: num(r.urgency),
  }));

  const reviewerRows = (reviewers.rows || []).map((r) => ({
    email: r.email,
    name: r.name,
    team: r.team,
    reviews: num(r.reviews),
    sbqIssued: num(r.sbq_issued),
    sbqPct: r.sbq_pct == null ? null : Number(r.sbq_pct),
    avgHoursPerReview: r.avg_hours_per_review == null ? null : Number(r.avg_hours_per_review),
    scoresGiven: num(r.scores_given),
    avgScoreGiven: r.avg_score_given == null ? null : Number(r.avg_score_given),
    projectMean: r.project_mean_score_given == null ? null : Number(r.project_mean_score_given),
    // How far this reviewer's average grade sits from the project's. Two
    // reviewers can have identical throughput and send-back rates and still be
    // grading to different standards, and that difference propagates into every
    // verdict downstream of them.
    calibrationDelta: r.calibration_delta == null ? null : Number(r.calibration_delta),
    hasTrustedTag: !!r.has_trusted_tag,
    hasReviewerTag: !!r.has_reviewer_tag,
    lastActive: r.last_active_pt || null,
  }));

  return {
    enabled: true,
    days,
    windowDays,
    level,
    people,
    // Urgency is assigned in SQL so the ordering is the same wherever it is read.
    actions: people.filter((p) => p.needsAction).sort((a, b) => a.urgency - b.urgency || (a.qms ?? 9) - (b.qms ?? 9)),
    mix: [...mix.values()].sort((a, b) => b.count - a.count),
    slipping: trendRows.filter((r) => r.urgency <= 3),
    trend: trendRows,
    reviewers: reviewerRows,
    totals: {
      contributors: people.length,
      needingAction: people.filter((p) => p.needsAction).length,
      slipping: trendRows.filter((r) => r.urgency <= 3).length,
      reviewers: reviewerRows.length,
    },
    errors: [
      quality.error ? { query: 'contributor_quality', error: quality.error } : null,
      trend.error ? { query: 'quality_trend', error: trend.error } : null,
      reviewers.error ? { query: 'reviewer_scorecard', error: reviewers.error } : null,
    ].filter(Boolean),
    generatedAt: new Date().toISOString(),
  };
}
