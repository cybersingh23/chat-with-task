import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Customer program spec, vendored under spec/. The canon is embedded in every
// copilot/docgen system prompt; the full docs are served on demand via the
// read_spec tool.
const specDir = path.join(config.projectRoot, 'spec');

export const SPEC_FILES = {
  qc_rubric: 'QC_RUBRIC.md',
  nwr_checklist: 'NWR_CHECKLIST.md',
  gap_analysis: 'QC_GAP_ANALYSIS.md',
};

export const QUALITY_CANON = read('QUALITY_CANON.md');

export function readSpec(name) {
  const file = SPEC_FILES[name];
  if (!file) throw new Error(`unknown spec "${name}" — one of: ${Object.keys(SPEC_FILES).join(', ')}`);
  return read(file);
}

function read(file) {
  try {
    return fs.readFileSync(path.join(specDir, file), 'utf8');
  } catch {
    return `(spec file ${file} missing from ${specDir})`;
  }
}
