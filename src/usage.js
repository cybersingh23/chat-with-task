import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Append-only interaction log in the writable data volume. One JSON line per
// LLM interaction (copilot chat turn or a docgen run), with the user attached,
// token counts from the LiteLLM response, and a cost estimate.
const USAGE_PATH = path.join(config.dataDir, 'usage.jsonl');

// Cost is an estimate at a configurable rate ($ per 1M tokens). Tokens are the
// ground truth from the API; rate defaults to Opus-tier pricing.
export function rate() {
  return {
    inPer1M: Number(process.env.PRICE_INPUT_PER_1M ?? 15),
    outPer1M: Number(process.env.PRICE_OUTPUT_PER_1M ?? 75),
  };
}

export function costOf(promptTokens, completionTokens) {
  const r = rate();
  return (promptTokens / 1e6) * r.inPer1M + (completionTokens / 1e6) * r.outPer1M;
}

export function recordUsage({ user, taskId, kind, model, usage, text }) {
  const pt = usage?.prompt_tokens || 0;
  const ct = usage?.completion_tokens || 0;
  if (!pt && !ct && !text) return; // nothing happened
  const line = {
    ts: new Date().toISOString(),
    user: user || 'unknown',
    taskId: taskId || null,
    kind: kind || 'chat',
    model: model || null,
    prompt_tokens: pt,
    completion_tokens: ct,
    cost: Number(costOf(pt, ct).toFixed(6)),
  };
  if (text) line.text = String(text).slice(0, 500);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(USAGE_PATH, JSON.stringify(line) + '\n');
}

// Aggregate for the admin dashboard: per-user and per-day rollups + recent log.
export function readUsage(limit = 500) {
  let events = [];
  try {
    events = fs.readFileSync(USAGE_PATH, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return { events: [], byUser: [], byDay: [], totals: blank(), rate: rate() };
  }
  const totals = blank();
  const userMap = new Map();
  const dayMap = new Map();
  for (const e of events) {
    add(totals, e);
    if (!userMap.has(e.user)) userMap.set(e.user, { user: e.user, ...blank() });
    add(userMap.get(e.user), e);
    const day = (e.ts || '').slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, { day, ...blank() });
    add(dayMap.get(day), e);
  }
  const byUser = [...userMap.values()].sort((a, b) => b.cost - a.cost);
  const byDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  return { events: events.slice(-limit).reverse(), byUser, byDay, totals, rate: rate() };
}

function blank() {
  return { interactions: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 };
}
function add(acc, e) {
  acc.interactions += 1;
  acc.prompt_tokens += e.prompt_tokens || 0;
  acc.completion_tokens += e.completion_tokens || 0;
  acc.cost += e.cost || 0;
}
