// Who owns what on ACC, and therefore who a given problem belongs to.
//
// This replaces the round-robin in buildAssignments(), which rotated chores
// evenly across four people every week on the assumption that they were
// interchangeable. They are not: Gilberto runs quality policy, Christian runs
// throughput and pay, Ernesto runs tooling and QC, Nishchay runs the attempter
// cohort. Handing Ernesto a promotions decision because it was his turn produces
// a list nobody acts on, which is worse than no list.
//
// So routing is by DOMAIN. Every health signal declares the domain it belongs to
// and lands with the person who owns that domain. Anything with no owner, or
// flagged as cross-cutting, escalates rather than being assigned to whoever is
// next in a rotation.

export const ESCALATION = 'pavit';

export const TEAM = [
  {
    username: 'gilberto',
    name: 'Gilberto Leon',
    remit: 'Quality',
    // Domains are the routing key. Everything a check can emit maps to exactly
    // one of these, across the whole team.
    domains: ['quality', 'promotions', 'guidelines', 'courses', 'quality_dashboard'],
    blurb: 'Promotions and demotions, guidelines, courses, the quality dashboard.',
  },
  {
    username: 'nishchay',
    name: 'Nishchay Sharma',
    remit: 'Attempter cohort',
    domains: ['onsites', 'superattempters', 'cohort_growth'],
    blurb: 'Onsites (29 active, 13 superattempters). Owns the superattempter cohort.',
  },
  {
    username: 'christian',
    name: 'Christian Rojas',
    remit: 'Throughput',
    domains: ['throughput', 'missions', 'win_rate', 'audits', 'team_management', 'pay_efficiency'],
    blurb: 'Making sure we have TP. Missions, win rate, audits, team management, pay efficiency.',
  },
  {
    username: 'ernesto',
    name: 'Ernesto Lozano de la Parra',
    remit: 'Tooling & QC',
    domains: ['community', 'tooling', 'linters', 'redash', 'qc', 'dashboards'],
    blurb: 'Community management, linters, scripts and Redash, QC, dashboards and metric tracking.',
  },
  {
    username: ESCALATION,
    name: 'Pavit Singh',
    remit: 'Evals & escalation',
    // `evals` is the one domain that routes here directly: tasks sitting at L10
    // with no eval on the Audit Studio board can only be moved by an eval pass,
    // and that pass is Pavit's. Everything else still arrives only by
    // escalation — cross-cutting, above a single owner's line, or unowned.
    domains: ['evals'],
    blurb: 'Runs the eval passes that move L10 work onto the board, plus high-leverage and cross-domain calls.',
  },
];

const OWNER_OF = new Map();
for (const person of TEAM) for (const d of person.domains) OWNER_OF.set(d, person.username);

export const ALL_DOMAINS = [...OWNER_OF.keys()];

export function personByUsername(username) {
  return TEAM.find((p) => p.username === username) || null;
}

// Route a signal to a person.
//
// `escalate` on a signal means the owner still sees it — it is their domain —
// but it ALSO surfaces on the escalation list, because the call is bigger than
// the domain. A signal with an unknown domain escalates outright rather than
// being dropped or guessed at: an unroutable problem is itself a finding.
export function routeSignal(signal) {
  const owner = OWNER_OF.get(signal.domain) || null;
  return {
    owner: owner || ESCALATION,
    escalated: !owner || !!signal.escalate,
    unrouted: !owner,
  };
}

// A compact description of the team for the model's system prompt, so Acey can
// answer "who should look at this" without a tool call and without inventing an
// org chart.
export function teamBrief() {
  return TEAM.map((p) => `${p.name} (${p.username}) — ${p.remit}: ${p.blurb}`
    + (p.domains.length ? ` [domains: ${p.domains.join(', ')}]` : ' [escalation target]'))
    .join('\n');
}
