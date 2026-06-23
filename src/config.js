import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so we don't need a dotenv dependency.
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export const BUCKETS = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];

export const config = {
  port: Number(process.env.PORT || 4100),
  projectRoot,
  workspaceRoot: path.resolve(projectRoot, expandHome(process.env.WORKSPACE_ROOT || './workspace')),
  // spec/ (customer docs, not in git) and data/ (users.json) — overridable so
  // containers can mount them as volumes
  specDir: path.resolve(projectRoot, expandHome(process.env.SPEC_DIR || './spec')),
  dataDir: path.resolve(projectRoot, expandHome(process.env.DATA_DIR || './data')),
  deliveryRoots: (process.env.DELIVERY_ROOTS || '~/Downloads')
    .split(':')
    .map((p) => path.resolve(expandHome(p.trim())))
    .filter(Boolean),
  litellm: {
    baseURL: (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/+$/, ''),
    apiKey: process.env.LITELLM_API_KEY,
    model: process.env.LITELLM_MODEL || 'claude-opus-4-6',
  },
  // Daily pull of every task at a review level (default L10) into UNSORTED.
  // Needs REDASH_API_KEY in the environment (read by tools/get_tasks/pull_l10.py).
  l10: {
    enabled: process.env.L10_PULL_ENABLED !== 'false',
    tz: process.env.L10_PULL_TZ || 'America/Los_Angeles',
    hour: Number(process.env.L10_PULL_HOUR ?? 18),
    minute: Number(process.env.L10_PULL_MINUTE ?? 0),
    reviewLevel: Number(process.env.L10_REVIEW_LEVEL ?? 10),
    status: process.env.L10_STATUS || 'pending',
    limit: Number(process.env.L10_PULL_LIMIT ?? 0), // 0 = no cap
  },
};
