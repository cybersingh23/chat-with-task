import fs from 'node:fs';
import path from 'node:path';
import { listFilesIn, readFileIn, readTrajectoryIn, resolveSafe, taskDir } from './workspace.js';
import { readSpec, SPEC_FILES } from './spec.js';
import { redashEnabled } from './redash.js';
import { REGISTRY, runRegistryQuery } from './redash_registry.js';

// Tools the audit copilot can call against the claimed task's folder.
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every file in the task folder (rank.json, trajectories, snapshots, ranking_proof, docs).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the task folder by relative path (e.g. "rank.json", "ranking_proof/a_proof_justification.txt"). Large files are paged: pass offset (line) and limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: '0-based start line' },
          limit: { type: 'integer', description: 'max lines, default 400' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Literal substring search across the task files (like grep -rn). Use this to verify every specific claim from rank.json against the trajectories. Returns file, line number, and the matching line. For trajectory hits the JSON is one line, so prefer read_trajectory to inspect context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'literal substring (case-sensitive unless ignore_case)' },
          ignore_case: { type: 'boolean' },
          path: { type: 'string', description: 'restrict to a subpath, e.g. "trajectories"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_spec',
      description:
        'Read the full text of a customer program spec document when you need exact wording beyond the embedded canon: v11_rubric (AUTHORITATIVE QC rubric — 25 dimensions R1-R25 with 2=Fail / 3-4=Non-Fail / 5=Pass bands), nwr_checklist (the 29 ONL-* check codes + customer report format), gap_analysis (evidence base: canonical fabrication/fairness cases), qc_rubric_v2_legacy (superseded prose rubric, background only).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: Object.keys(SPEC_FILES) },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_trajectory',
      description:
        'Read normalized trajectory messages for model_a or model_b. Each message has an index N — cite it as traj://<model>/<N> so the reviewer gets a "Show in trajectory" button. Returns role, text parts, and tool calls (clipped). Page with start/count.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: ['model_a', 'model_b'] },
          start: { type: 'integer', description: 'first message index, default 0' },
          count: { type: 'integer', description: 'messages to return, default 20' },
          user_turns_only: { type: 'boolean', description: 'only user messages (fast way to enumerate all prompts)' },
        },
        required: ['model'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redash_query',
      description:
        'Run a curated live query against Redash (Snowflake) for UPSTREAM PIPELINE facts that are not in the task folder: which review levels this task passed through, who worked it at each level and on which team, how many hours each level took, and where the task sits right now. ' +
        'Task-scoped queries default to THIS task, so task_ids is usually unnecessary. ' +
        'Use it for questions about pipeline position, reviewer/annotator identity, worker team, handling time, or project-wide layer counts. ' +
        'It CANNOT see trajectories, rank.json, or anything the annotator wrote — those live in the task files, so keep using read_file/search/read_trajectory for audit evidence. ' +
        'Treat every number it returns as pipeline metadata, never as evidence about model behaviour.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            enum: Object.keys(REGISTRY),
            description: Object.entries(REGISTRY)
              .map(([k, v]) => `${k}: ${v.description}`)
              .join(' | '),
          },
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional 24-hex task ids. Task-scoped queries default to the current task.',
          },
          days: { type: 'integer', description: 'Trailing window for project_aht / throughput (default 30).' },
        },
        required: ['query'],
      },
    },
  },
];

export function makeExecutor(bucket, id) {
  return makeExecutorForDir(taskDir(bucket, id));
}

// Tool executor scoped to an absolute task directory (used by the app via
// makeExecutor, and by the offline doc generator over a delivery folder).
export function makeExecutorForDir(dir) {
  return async (name, args) => {
    switch (name) {
      case 'list_files':
        return renderTree(listFilesIn(dir));
      case 'read_file': {
        const f = readFileIn(dir, args.path);
        if (f.kind === 'image') return `[binary image: ${args.path} — view it in the Files panel]`;
        const lines = f.text.split('\n');
        const offset = Math.max(0, args.offset || 0);
        const limit = Math.min(2000, args.limit || 400);
        const slice = lines.slice(offset, offset + limit);
        const head = `[${args.path} — lines ${offset}-${offset + slice.length} of ${lines.length}${f.truncated ? ', file clipped at 200k chars' : ''}]`;
        return head + '\n' + slice.join('\n');
      }
      case 'search':
        return searchTask(dir, args);
      case 'read_spec':
        return readSpec(args.name);
      case 'read_trajectory': {
        const traj = readTrajectoryIn(dir, args.model);
        let msgs = traj.messages;
        if (args.user_turns_only) msgs = msgs.filter((m) => m.role === 'user');
        const start = Math.max(0, args.start || 0);
        const count = Math.min(60, args.count || 20);
        const page = args.user_turns_only ? msgs.slice(start, start + count) : msgs.filter((m) => m.index >= start).slice(0, count);
        const lines = [`[trajectory ${args.model}: ${traj.count} messages total${args.user_turns_only ? `, ${msgs.length} user turns` : ''}]`];
        for (const m of page) lines.push(renderMessage(args.model, m));
        return lines.join('\n');
      }
      case 'redash_query':
        return runRedashTool(dir, args);
      default:
        return `ERROR: unknown tool ${name}`;
    }
  };
}

// The task folder is named for the task id in both the workspace and a delivery
// folder, so the copilot never has to be told which task it is looking at.
const TASK_ID_RE = /^[0-9a-f]{24}$/;

async function runRedashTool(dir, args = {}) {
  if (!redashEnabled()) return 'ERROR: Redash is not configured on this server (REDASH_API_KEY unset).';
  const name = String(args.query || '');
  const entry = REGISTRY[name];
  if (!entry) return `ERROR: unknown query ${JSON.stringify(name)}. Available: ${Object.keys(REGISTRY).join(', ')}`;

  const params = {};
  if (entry.params?.task_ids) {
    const supplied = Array.isArray(args.task_ids) ? args.task_ids.filter(Boolean) : [];
    const self = path.basename(dir);
    const ids = supplied.length ? supplied : (TASK_ID_RE.test(self) ? [self] : []);
    if (!ids.length) return 'ERROR: this query needs task_ids and the current folder is not a task id.';
    params.task_ids = ids;
  }
  if (entry.params?.days && args.days) params.days = args.days;

  try {
    const out = await runRegistryQuery(name, params);
    if (!out.rowCount) return `[redash ${name}] 0 rows.`;
    return `[redash ${name} — ${out.rowCount} row(s)${out.cached ? ', cached' : ''}]\n` + asTable(out);
  } catch (e) {
    return `ERROR running ${name}: ${e.message}`;
  }
}

// Compact fixed-width table — far cheaper in tokens than JSON, and the model
// reads columns more reliably than nested objects.
function asTable(out, maxRows = 60) {
  const cols = out.columns.map((c) => c.name);
  const cell = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').slice(0, 60));
  const rows = out.rows.slice(0, maxRows).map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length), 1));
  const line = (parts) => parts.map((p, i) => p.padEnd(widths[i])).join('  ').trimEnd();
  const body = [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
  if (out.rowCount > maxRows) body.push(`… ${out.rowCount - maxRows} more row(s)`);
  return body.join('\n');
}

function renderMessage(model, m) {
  const out = [`--- ${model}[${m.index}] ${m.role} (traj://${model}/${m.index}) ---`];
  for (const p of m.parts) {
    if (p.type === 'text') out.push(p.text.slice(0, 4000));
    else if (p.type === 'reasoning') out.push(`<reasoning>${p.text.slice(0, 1000)}</reasoning>`);
    else out.push(`<tool ${p.tool} status=${p.status} title="${p.title}">input=${p.input.slice(0, 600)} output=${p.output.slice(0, 1200)}</tool>`);
  }
  return out.join('\n');
}

function renderTree(entries, indent = '') {
  const lines = [];
  for (const e of entries) {
    lines.push(`${indent}${e.path}${e.dir ? '/' : ` (${e.size} bytes)`}`);
    if (e.dir) lines.push(renderTree(e.children, indent));
  }
  return lines.join('\n');
}

const SEARCHABLE = /\.(json|txt|md|log|py|js|ts|java|rs|go|c|cpp|h|html|css|sh|yaml|yml|toml|xml|csv)$/i;

function searchTask(dir, { pattern, ignore_case = false, path: sub }) {
  if (!pattern) return 'ERROR: pattern required';
  const root = resolveSafe(dir, sub || '.');
  const needle = ignore_case ? pattern.toLowerCase() : pattern;
  const hits = [];
  const walk = (d) => {
    if (hits.length >= 200) return;
    for (const name of fs.readdirSync(d)) {
      if (name === '.DS_Store') continue;
      const abs = path.join(d, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (SEARCHABLE.test(name) && st.size < 50_000_000) {
        const text = fs.readFileSync(abs, 'utf8');
        const hay = ignore_case ? text.toLowerCase() : text;
        if (!hay.includes(needle)) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          const l = ignore_case ? lines[i].toLowerCase() : lines[i];
          let col = l.indexOf(needle);
          while (col !== -1 && hits.length < 200) {
            const rel = path.relative(dir, abs);
            const ctx = lines[i].slice(Math.max(0, col - 120), col + needle.length + 120);
            hits.push(`${rel}:${i + 1}: …${ctx}…`);
            col = l.indexOf(needle, col + 1);
          }
        }
      }
    }
  };
  walk(root);
  if (!hits.length) return `0 hits for ${JSON.stringify(pattern)}`;
  return `${hits.length} hit(s) for ${JSON.stringify(pattern)}${hits.length >= 200 ? ' (capped at 200)' : ''}\n` + hits.join('\n');
}
