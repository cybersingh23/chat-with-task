import fs from 'node:fs';
import path from 'node:path';
import { listFilesIn, readFileIn, readTrajectoryIn, resolveSafe, taskDir } from './workspace.js';
import { readSpec, SPEC_FILES } from './spec.js';

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
      default:
        return `ERROR: unknown tool ${name}`;
    }
  };
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
