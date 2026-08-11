import { config } from './config.js';

// Redash client — the one place the app talks to redash.scale.com.
//
// Two ways to run something (the "hybrid" model, see src/redash_registry.js):
//   * runSaved(id, params)      — POST /api/queries/<id>/results, SQL lives in Redash
//   * runAdhoc(dsId, sql)       — POST /api/query_results, SQL lives in sql/redash/
// Both return the same normalized shape, so callers never care which was used.
//
// Redash runs queries asynchronously: the POST returns either a cached
// `query_result` outright or a `job` to poll until it resolves to a result id.
//
// The API key is server-side only — it is never sent to the browser, and every
// error message is scrubbed of it before it can reach a client or a log.

const JOB_PENDING = 1, JOB_STARTED = 2, JOB_SUCCESS = 3, JOB_FAILURE = 4, JOB_CANCELLED = 5;

// redash.scale.com sits behind a WAF that 403s requests without a browser-ish
// User-Agent (urllib/node defaults get blocked). Same header vendored
// pull_l10.py sends — without it every call here fails with a bare 403.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function redashEnabled() {
  return Boolean(config.redash.apiKey);
}

// Never let the key leak into an error string, a log line, or an API response.
function scrub(text) {
  const key = config.redash.apiKey;
  const s = String(text ?? '');
  return key ? s.split(key).join('<redacted>') : s;
}

export class RedashError extends Error {
  constructor(message, status = 502) {
    super(scrub(message));
    this.name = 'RedashError';
    this.status = status;
  }
}

async function request(path, { method = 'GET', body = null, timeoutMs } = {}) {
  if (!redashEnabled()) throw new RedashError('REDASH_API_KEY is not set', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? config.redash.requestTimeoutMs);
  let res;
  try {
    res = await fetch(config.redash.baseUrl + path, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: `Key ${config.redash.apiKey}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new RedashError(`Redash ${method} ${path} timed out`, 504);
    throw new RedashError(`Redash ${method} ${path} failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 403 here is almost always a key-scope problem rather than a bad request,
    // so say so — a query-scoped key cannot run ad-hoc SQL.
    const hint = res.status === 403
      ? ' (a query-scoped key cannot run ad-hoc SQL — this needs a Redash USER api key with access to the data source)'
      : '';
    throw new RedashError(
      `Redash ${method} ${path} → ${res.status} ${res.statusText}${hint}\n${detail.slice(0, 500)}`,
      res.status === 403 || res.status === 401 ? 502 : 502,
    );
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a Redash job until it resolves to a query_result_id (or fails).
async function awaitJob(jobId, deadline) {
  for (;;) {
    if (Date.now() > deadline) {
      // Best-effort: stop burning a Snowflake warehouse slot on a result nobody will read.
      request(`/api/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new RedashError(`Redash job ${jobId} did not finish in time`, 504);
    }
    await sleep(config.redash.pollIntervalMs);
    const job = (await request(`/api/jobs/${jobId}`)).job || {};
    if (job.status === JOB_SUCCESS) {
      if (!job.query_result_id) throw new RedashError(`Redash job ${jobId} succeeded with no result id`);
      return job.query_result_id;
    }
    if (job.status === JOB_FAILURE || job.status === JOB_CANCELLED) {
      throw new RedashError(`Redash query failed: ${job.error || `status=${job.status}`}`, 400);
    }
    if (job.status !== JOB_PENDING && job.status !== JOB_STARTED) {
      throw new RedashError(`Redash job ${jobId} in unexpected state ${job.status}`);
    }
  }
}

// Redash returns SCREAMING_CASE column names from Snowflake; lower-case them so
// callers can use stable snake_case keys regardless of how the SQL was written.
function normalize(queryResult) {
  const data = queryResult?.data || {};
  const columns = (data.columns || []).map((c) => ({
    name: String(c.name).toLowerCase(),
    type: c.type || null,
  }));
  const rows = (data.rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[String(k).toLowerCase()] = v;
    return out;
  });
  return {
    columns,
    rows,
    rowCount: rows.length,
    runtime: queryResult?.runtime ?? null,
    retrievedAt: queryResult?.retrieved_at ?? null,
    queryResultId: queryResult?.id ?? null,
  };
}

// Resolve a POST response that is either an inline cached result or a job to poll.
async function resolveResult(payload, deadline) {
  if (payload.query_result) return normalize(payload.query_result);
  const jobId = payload.job?.id;
  if (!jobId) throw new RedashError(`Unexpected Redash response: ${JSON.stringify(payload).slice(0, 300)}`);
  const resultId = await awaitJob(jobId, deadline);
  const full = await request(`/api/query_results/${resultId}.json`);
  return normalize(full.query_result);
}

// ---------------------------------------------------------------------------
// In-process cache + single-flight
//
// Redash's own `max_age` already serves cached results server-side, but each
// check is still a network round trip. Panels on the L12 page fire several
// queries at once and multiple reviewers load the same page, so we also memoize
// locally and collapse concurrent identical calls into one upstream request.
// ---------------------------------------------------------------------------

const cache = new Map();   // key -> { at, value }
const inflight = new Map(); // key -> Promise

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

// Bound the map so a long-lived process can't grow it without limit.
function cacheSet(key, value) {
  if (cache.size >= 200) {
    for (const k of [...cache.keys()].slice(0, 50)) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), value });
}

export function clearRedashCache() {
  const n = cache.size;
  cache.clear();
  return n;
}

// Run `fn`, deduping concurrent identical work and caching the result.
// fresh=true bypasses the read (but still populates for the next caller).
async function cached(key, ttlMs, fresh, fn) {
  if (!fresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
    const pending = inflight.get(key);
    if (pending) return { ...(await pending), cached: true };
  }
  const p = (async () => {
    const value = await fn();
    cacheSet(key, value);
    return value;
  })();
  // A fresh call must not clobber a live entry other callers already await;
  // it runs unregistered and only its own registration is cleaned up.
  if (!inflight.has(key)) inflight.set(key, p);
  try {
    return { ...(await p), cached: false };
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Run a published Redash query by id. Needs only view access to the data source.
export function runSaved(queryId, parameters = {}, opts = {}) {
  const key = `saved:${queryId}:${JSON.stringify(parameters)}`;
  const ttl = opts.ttlMs ?? config.redash.cacheTtlMs;
  return cached(key, ttl, !!opts.fresh, async () => {
    const deadline = Date.now() + (opts.timeoutMs ?? config.redash.queryTimeoutMs);
    const payload = await request(`/api/queries/${queryId}/results`, {
      method: 'POST',
      body: { parameters, max_age: opts.fresh ? 0 : Math.floor(ttl / 1000) },
    });
    return resolveResult(payload, deadline);
  });
}

// Run ad-hoc SQL against a data source. Needs a user key with execute rights.
export function runAdhoc(dataSourceId, sql, opts = {}) {
  const key = `adhoc:${dataSourceId}:${sql}`;
  const ttl = opts.ttlMs ?? config.redash.cacheTtlMs;
  return cached(key, ttl, !!opts.fresh, async () => {
    const deadline = Date.now() + (opts.timeoutMs ?? config.redash.queryTimeoutMs);
    const payload = await request('/api/query_results', {
      method: 'POST',
      body: {
        data_source_id: Number(dataSourceId),
        query: sql,
        max_age: opts.fresh ? 0 : Math.floor(ttl / 1000),
      },
    });
    return resolveResult(payload, deadline);
  });
}

export async function getQuery(id) {
  const q = await request(`/api/queries/${Number(id)}`);
  return {
    id: q.id,
    name: q.name,
    description: q.description || '',
    dataSourceId: q.data_source_id,
    isDraft: !!q.is_draft,
    updatedAt: q.updated_at,
    user: q.user?.name || null,
    // Parameter *definitions* only — enough for the browser to render inputs.
    parameters: (q.options?.parameters || []).map((p) => ({
      name: p.name,
      title: p.title || p.name,
      type: p.type || 'text',
      value: p.value ?? '',
      enumOptions: p.enumOptions ?? null,
    })),
    query: q.query || '',
  };
}

export async function searchQueries({ q = '', page = 1, pageSize = 25, mine = false } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(Math.min(100, pageSize)),
    order: '-updated_at',
  });
  if (q) params.set('q', q);
  const path = mine ? '/api/queries/my' : '/api/queries';
  const res = await request(`${path}?${params}`);
  return {
    count: res.count ?? 0,
    page: res.page ?? page,
    pageSize: res.page_size ?? pageSize,
    results: (res.results || []).map((x) => ({
      id: x.id,
      name: x.name,
      dataSourceId: x.data_source_id,
      isDraft: !!x.is_draft,
      updatedAt: x.updated_at,
      user: x.user?.name || null,
    })),
  };
}

export async function listDataSources() {
  const res = await request('/api/data_sources');
  return res.map((d) => ({ id: d.id, name: d.name, type: d.type }));
}

// Cheap connectivity/permission probe for the status endpoint.
export async function ping() {
  const s = await request('/api/session');
  return {
    user: s.user?.name || null,
    email: s.user?.email || null,
    version: s.client_config?.version || null,
    canExecute: (s.user?.permissions || []).includes('execute_query'),
  };
}

// A Redash deep link for "open this in Redash" affordances in the UI.
export function queryUrl(id) {
  return `${config.redash.baseUrl}/queries/${id}`;
}

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------
//
// Lives here rather than in the route so everything that can reach a data source
// goes through one gate — the admin SQL box, and the copilot's run_sql tool.
// Defence in depth: the box is admin-gated and the data source should be
// read-only anyway, but a typo'd DELETE shouldn't be able to reach Snowflake,
// and a model composing SQL shouldn't be the only thing standing between a
// prompt and a write.
//
// Comments and string literals are stripped before analysis so a keyword inside
// a quoted string ("-- drop table" in a comment, 'DELETE' as a value) doesn't
// false-trip the checks.
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|copy|call|execute|use|set)\b/i;

export function assertReadOnly(sql) {
  const original = String(sql).trim();

  // Analysis copy ONLY: comments and string literals are blanked so a keyword
  // written inside them can't trip the checks below. It is never executed —
  // running it would silently rewrite the user's string literals to ''.
  const stripped = original
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');

  // Reject stacked statements: anything after the first ; that isn't whitespace.
  const semi = stripped.indexOf(';');
  if (semi !== -1 && stripped.slice(semi + 1).trim()) {
    throw new RedashError('only a single statement is allowed', 400);
  }
  const body = (semi === -1 ? stripped : stripped.slice(0, semi)).trim();
  if (!/^(with|select)\b/i.test(body)) {
    throw new RedashError('only SELECT / WITH queries are allowed', 400);
  }
  const hit = FORBIDDEN.exec(body);
  if (hit) throw new RedashError(`statement keyword not allowed here: ${hit[1].toUpperCase()}`, 400);

  // Hand back the ORIGINAL text (minus a trailing semicolon), so literals and
  // comments survive into the query that actually runs.
  return original.replace(/;\s*$/, '');
}
