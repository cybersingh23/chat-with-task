import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Customer program spec lives in spec/ on disk only (gitignored — see
// spec/README.md). The canon is embedded in every copilot/docgen system
// prompt; full docs are served on demand via the read_spec tool; the V5
// rubric is parsed for the UI's QC-spec view and spec://R# citations.
const specDir = path.join(config.projectRoot, 'spec');

export const SPEC_FILES = {
  v5_rubric: 'V5_RUBRIC.csv',
  nwr_checklist: 'NWR_CHECKLIST.md',
  qc_rubric_v2_legacy: 'QC_RUBRIC.md',
  gap_analysis: 'QC_GAP_ANALYSIS.md',
};

export const QUALITY_CANON = read('QUALITY_CANON.md');

export function readSpec(name) {
  const file = SPEC_FILES[name];
  if (!file) throw new Error(`unknown spec "${name}" — one of: ${Object.keys(SPEC_FILES).join(', ')}`);
  if (name === 'v5_rubric') {
    const dims = getRubric();
    if (!dims.length) return '(V5 rubric missing from spec/)';
    return dims
      .map((d) =>
        [`=== ${d.key} · ${d.category} — ${d.name}`,
          d.description ? `Auditor notes: ${d.description}` : null,
          ...d.options.map((o) => `  [${o.score === 2 ? '2 Fail' : o.score === 3 ? '3 Non-Fail' : '5 Pass'}] ${o.text}`),
        ].filter(Boolean).join('\n')
      )
      .join('\n\n');
  }
  return read(file);
}

function read(file) {
  try {
    return fs.readFileSync(path.join(specDir, file), 'utf8');
  } catch {
    return `(spec file ${file} missing from ${specDir})`;
  }
}

// ---- V5 rubric (platform CSV export) ----
// Row with a title starts a dimension; following rows carry its remaining
// answer options. Keys R1..Rn are assigned in file order and are the citation
// handles used by the copilot (spec://R12) and the UI anchors.
let rubricCache = null;

export function getRubric() {
  if (rubricCache) return rubricCache;
  let raw;
  try {
    raw = fs.readFileSync(path.join(specDir, 'V5_RUBRIC.csv'), 'utf8');
  } catch {
    return (rubricCache = []);
  }
  const rows = parseCsv(raw);
  const dims = [];
  let cur = null;
  for (const r of rows.slice(1)) {
    const [id, title, , questionDescription, , , , , , , optText, optScore, optJustify] = r;
    if (title) {
      const parts = title.split(' - ');
      cur = {
        key: `R${dims.length + 1}`,
        id,
        category: parts[0]?.trim() || 'Other',
        name: parts.slice(1).join(' — ').trim() || title,
        description: (questionDescription || '').replace(/^\.\s*/, '').replace(/\s*See the spec doc for examples\.?/g, '').replace(/\s*For all options except the last, apply (an|the) error categor(y|ies)\.?/g, '').trim(),
        options: [],
      };
      dims.push(cur);
    }
    if (cur && optText) {
      cur.options.push({
        score: Number(optScore) || null,
        text: optText.trim(),
        requiresJustification: optJustify === 'true',
      });
    }
  }
  for (const d of dims) d.options.sort((a, b) => (a.score || 9) - (b.score || 9));
  return (rubricCache = dims);
}

// Minimal RFC-4180 CSV parser (quoted fields, embedded newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
