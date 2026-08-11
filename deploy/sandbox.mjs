#!/usr/bin/env node
/**
 * Deploy chat-with-task to a Scale sandbox VM.
 *
 * Usage:
 *   cd deploy && npm install   # first time only
 *   node sandbox.mjs           # creates a new sandbox and deploys
 *
 * Prerequisites:
 *   - Cloudflare WARP connected (resolves sandbox.ml-serving-internal.scale.com)
 *   - Node.js 18+ on your local machine
 *
 * Settings come from the repo's own gitignored .env (the same file the app reads
 * locally), or from the environment, which wins. Rotating a key in .env is therefore
 * all it takes for the next deploy to carry the new one — and the key never has to
 * live in the repo. The .env file itself is NOT shipped: the values are injected as
 * real environment variables at start, so no secret lands on the sandbox disk (which
 * also hosts a web terminal).
 *
 * Each deploy also generates its own credentials — basic auth on the web terminal
 * and a random suffix for the app's seeded logins — printed once, in the final
 * banner on this console. Nothing that answers on the public tunnel domain ships
 * with a committed default.
 *
 * Environment variables:
 *   LITELLM_API_KEY     LiteLLM proxy key  (REQUIRED — from ../.env or the environment)
 *   LITELLM_BASE_URL    LiteLLM proxy URL  (default: https://litellm-proxy.ml.scale.com/v1)
 *   LITELLM_MODEL       Model to use       (default: claude-opus-5)
 *   REDASH_API_KEY      Redash USER key    (optional — without it every Redash surface
 *                                           reads "not configured"; a query-scoped key
 *                                           403s on the registry's ad-hoc SQL)
 *   REDASH_ANALYTICS_DATA_SOURCE_ID        (default: 22 — ACC pipeline tables)
 *   ACC_PROJECT_ID      Project to describe (default: 69979ab5a4b6d80af7b7d1c8)
 *   SANDBOX_INCLUDE_BOARD  "true" ships workspace/ + data/ (default: off — the sandbox
 *                                           starts with an empty board and seeded logins)
 *   SANDBOX_TIMEOUT     TTL in seconds     (default: 1209600 = 14 days)
 *   SANDBOX_CPU         CPU cores          (default: 4)
 *   SANDBOX_MEMORY      Memory in MiB      (default: 8192)
 *   SANDBOX_PROJECT_ID  Billing project ID (default: 682bdbff5ed4cd9b2516cc6a)
 */

import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// ── Config ─────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REPO_NAME = basename(REPO_ROOT);

if (!existsSync(resolve(REPO_ROOT, 'server.js'))) {
  console.error('✗ Cannot find server.js — run this script from the deploy/ directory inside the repo.');
  process.exit(1);
}

const CONTROL_PLANE_URL = 'https://sandbox.ml-serving-internal.scale.com';
const TTYD_PORT = 8080;
const APP_PORT = 4100;
const INTERNAL_DOMAIN = 'sandbox.internal.scale.com';
const PUBLIC_DOMAIN = 'beta.sandbox.outlier.ai';
const IMAGE = '084828598639.dkr.ecr.us-west-2.amazonaws.com/containerdisk/validator-ubuntu:22.04-v5';

const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT) || 14 * 24 * 60 * 60;
const CPU = Number(process.env.SANDBOX_CPU) || 4;
const MEMORY = Number(process.env.SANDBOX_MEMORY) || 8192;
const PROJECT_ID = process.env.SANDBOX_PROJECT_ID || '682bdbff5ed4cd9b2516cc6a';

// Ship the local board (workspace/ + data/) to the sandbox. Off by default: it is
// real customer task data going to a shared host, and it dominates the upload.
// A fresh deploy comes up with an empty board and re-seeded logins, which is what
// you want for a demo or a review of the UI itself.
const INCLUDE_BOARD = process.env.SANDBOX_INCLUDE_BOARD === 'true';

// Read the repo's gitignored .env, the same file the app itself reads, so a deploy
// carries whatever key is working locally. A real environment variable still wins.
// Nothing here is committed: the previous hardcoded default was a live credential in
// the repo, and it had already been revoked, so every deploy shipped a dead key.
function readDotEnv() {
  const out = {};
  const p = resolve(REPO_ROOT, '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const dotEnv = readDotEnv();
const fromEnv = (k, fallback) => process.env[k] || dotEnv[k] || fallback;

// Per-deploy credentials. The tunnel URLs are public, so nothing listening on them
// can use a committed default: the web terminal gets basic auth, and the app's
// seeded logins get a random suffix (src/auth.js reads CWT_SEED_SUFFIX). Both are
// printed once, in the local banner at the end — they exist nowhere else.
const TTYD_PASS = randomBytes(12).toString('base64url');
const SEED_SUFFIX = randomBytes(6).toString('hex');

// Keys with no value are dropped before the env string is built, so an unset
// optional var stays unset in the sandbox rather than arriving as "undefined".
const APP_ENV = {
  LITELLM_API_KEY:  fromEnv('LITELLM_API_KEY'),
  LITELLM_BASE_URL: fromEnv('LITELLM_BASE_URL', 'https://litellm-proxy.ml.scale.com/v1'),
  LITELLM_MODEL:    fromEnv('LITELLM_MODEL', 'claude-opus-5'),
  // Without these three, every Redash surface in a deployed sandbox — the L12
  // live panels, the per-task Pipeline tab, the copilot's redash_query tool and
  // /redash.html — renders "not configured". The two non-key vars mirror the
  // defaults in src/config.js; they're forwarded so a .env override travels too.
  REDASH_API_KEY:                  fromEnv('REDASH_API_KEY'),
  REDASH_ANALYTICS_DATA_SOURCE_ID: fromEnv('REDASH_ANALYTICS_DATA_SOURCE_ID', '22'),
  ACC_PROJECT_ID:                  fromEnv('ACC_PROJECT_ID', '69979ab5a4b6d80af7b7d1c8'),
  // Random per deploy — see the credentials block above. Harmless when the board
  // ships: data/users.json already exists, so nothing re-seeds.
  CWT_SEED_SUFFIX: SEED_SUFFIX,
  PORT: String(APP_PORT),
};

if (!APP_ENV.LITELLM_API_KEY) {
  console.error('✗ No LITELLM_API_KEY found in ../.env or the environment.');
  console.error('  The copilot will not work without it. Set it in the repo\'s .env (gitignored) and re-run.');
  process.exit(1);
}

// Not fatal — the rest of the app is fine without it, but the whole Redash half
// of the product goes dark, and that is worth saying out loud before a deploy.
if (!APP_ENV.REDASH_API_KEY) {
  console.warn('⚠ No REDASH_API_KEY found in ../.env or the environment.');
  console.warn('  The deploy will boot, but every Redash surface will read "not configured".');
}

// Say which one you're getting — an unexpectedly empty board is otherwise a
// confusing thing to land on, and an unexpectedly full one is a data leak.
if (INCLUDE_BOARD) {
  console.warn('⚠ SANDBOX_INCLUDE_BOARD=true — shipping workspace/ and data/ to the sandbox.');
  console.warn('  That is real customer task data on a shared host, and a much slower upload.');
} else {
  console.log('  Board excluded (workspace/, data/). The sandbox starts empty; logins re-seed');
  console.log('  with a random per-deploy suffix — printed in the banner at the end. Set');
  console.log('  SANDBOX_INCLUDE_BOARD=true to ship yours.');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rewriteUrl = (url) => (url || '').replace(INTERNAL_DOMAIN, PUBLIC_DOMAIN);

function exec(sandboxId, script, timeoutMs = 300_000) {
  const url = CONTROL_PLANE_URL.replace('https://', 'wss://') + `/api/sandbox/${sandboxId}/exec`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let stdout = '', stderr = '', settled = false;
    function settle(fn) { if (!settled) { settled = true; clearTimeout(timer); fn(); } }
    const timer = setTimeout(() => { ws.terminate(); settle(() => reject(new Error(`Exec timed out after ${timeoutMs / 1000}s`))); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'exec', command: 'bash', args: ['-c', script] })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'stdout') { stdout += msg.data; process.stdout.write(msg.data); }
      else if (msg.type === 'stderr') stderr += msg.data;
      else if (msg.type === 'exit') { ws.close(); if (msg.code !== 0) settle(() => reject(new Error(`Exit ${msg.code}:\n${stderr.slice(0, 1000)}`))); }
      else if (msg.type === 'error') { ws.close(); settle(() => reject(new Error(`Exec error: ${msg.message}`))); }
    });
    ws.on('close', () => settle(() => resolve(stdout)));
    ws.on('error', (err) => settle(() => reject(err)));
  });
}

// ── Steps ──────────────────────────────────────────────────────────────────────

async function createSandbox() {
  console.log('[1/6] Creating sandbox...');
  const res = await fetch(`${CONTROL_PLANE_URL}/api/sandbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: IMAGE, sandbox_type: 'vm', cpu: CPU, memory: MEMORY, disk_size: '50Gi',
      timeout: TIMEOUT, exposed_ports: [TTYD_PORT, APP_PORT],
      name: 'chat-with-task', team: 'frontier-data', customer: 'OTS', product: 'CAEV',
      project_id: PROJECT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
  const { sandbox_id } = await res.json();
  console.log(`    Sandbox ID: ${sandbox_id}`);
  return sandbox_id;
}

async function waitForReady(sandboxId) {
  console.log('[2/6] Waiting for VM to boot (up to 10 min)...');
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/sandbox/${sandboxId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'Running' && data.tunnel_urls) { console.log('    Running'); return data.tunnel_urls; }
      process.stdout.write(`\r    Status: ${data.status}...   `);
    }
    await sleep(5000);
  }
  throw new Error('Timed out waiting for sandbox');
}

async function waitForCloudInit(sandboxId) {
  console.log('[3/6] Waiting for cloud-init...');
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const out = await exec(sandboxId, 'test -f /var/lib/cloud/instance/boot-finished && echo done || echo waiting', 15_000);
      if (out.trim() === 'done') { console.log('    Done'); return; }
    } catch { /* exec may not be ready yet */ }
    await sleep(5000);
  }
  console.log('    Timed out, proceeding anyway...');
}

async function setupTtyd(sandboxId) {
  console.log('[4/6] Starting ttyd...');
  // Basic auth (-c): the tunnel URL is public, and an open -W ttyd is a writable
  // shell for anyone who has it — on a box whose environment holds the API keys.
  // TTYD_PASS is base64url, so it needs no escaping inside the single quotes.
  await exec(sandboxId,
    `pkill -9 ttyd 2>/dev/null || true; sleep 1; ` +
    `nohup ttyd -p ${TTYD_PORT} -W -t enableZmodem=true -c 'cwt:${TTYD_PASS}' bash > /tmp/ttyd.log 2>&1 & sleep 2`);
  const check = await exec(sandboxId, `ss -tlnp | grep :${TTYD_PORT} || echo NOT_LISTENING`);
  if (check.includes('NOT_LISTENING')) throw new Error('ttyd failed to start');
  console.log('    ttyd running (zmodem enabled, basic auth)');
}

async function installAndDeploy(sandboxId) {
  console.log('[5/6] Installing Node.js + deploying code...');

  // Install Node.js 22
  await exec(sandboxId, [
    'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>&1',
    'sudo apt-get install -y --no-install-recommends nodejs 2>&1',
  ].join(' && '), 5 * 60 * 1000);
  const ver = await exec(sandboxId, 'node --version', 10_000);
  console.log(`    Node.js ${ver.trim()}`);

  // Create tarball from the repo. Beyond .git and node_modules:
  //   .env      — it held both live keys, and the deploy also exposes a web
  //               terminal, so the file was a second copy of the secret sitting
  //               on a reachable disk. The keys now travel in APP_ENV instead.
  //   workspace/, data/ — the operator's local board (~900MB of real customer
  //               tasks) and their action/usage logs. Shipping them made the
  //               tarball ~177MB, which is ~4,000 sequential 60KB exec
  //               round-trips, and put customer data on a shared sandbox.
  // spec/ still ships: getRubric() falls back to spec/V11_RUBRIC.csv, which is
  // how a boardless deploy still knows the rubric.
  const excludes = ['.git', 'node_modules', 'deploy/node_modules', '.env'];
  if (!INCLUDE_BOARD) excludes.push('workspace', 'data');

  const tarball = '/tmp/cwt-deploy.tar.gz';
  const excludeArgs = excludes.map((e) => `--exclude="${REPO_NAME}/${e}"`).join(' ');
  execSync(`tar czf ${tarball} ${excludeArgs} -C "${resolve(REPO_ROOT, '..')}" "${REPO_NAME}"`);
  const b64 = readFileSync(tarball).toString('base64');
  console.log(`    Tarball: ${Math.round(b64.length * 3 / 4 / 1024)}KB`);

  // Upload in 60KB chunks (kernel arg-list limit)
  await exec(sandboxId, 'rm -f /tmp/app.b64; touch /tmp/app.b64');
  const CHUNK = 60_000;
  const totalChunks = Math.ceil(b64.length / CHUNK);
  for (let i = 0; i < b64.length; i += CHUNK) {
    await exec(sandboxId, `printf '%s' '${b64.slice(i, i + CHUNK)}' >> /tmp/app.b64`);
    process.stdout.write(`\r    Uploading chunk ${Math.ceil((i + CHUNK) / CHUNK)}/${totalChunks}`);
  }
  console.log('');

  // Extract and install
  await exec(sandboxId, [
    'base64 -d /tmp/app.b64 > /tmp/app.tar.gz',
    'mkdir -p /home/sandbox/app',
    'tar xzf /tmp/app.tar.gz -C /home/sandbox/app --strip-components=1',
    'rm -f /tmp/app.b64 /tmp/app.tar.gz',
  ].join(' && '));
  console.log('    Code deployed');

  console.log('    Running npm ci...');
  await exec(sandboxId, 'cd /home/sandbox/app && npm ci --omit=dev', 3 * 60 * 1000);
  console.log('    Dependencies installed');
}

async function startApp(sandboxId) {
  console.log('[6/6] Starting app...');
  // Single-quote so nothing in a key is expanded by the remote shell, and drop
  // unset optionals so they don't arrive as the string "undefined".
  const envStr = Object.entries(APP_ENV)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  // setsid detaches from the exec session; fire-and-forget with a short timeout
  exec(sandboxId, `cd /home/sandbox/app && env ${envStr} setsid nohup node server.js < /dev/null > /tmp/app.log 2>&1 &`, 8_000).catch(() => {});
  await sleep(5000);
  const check = await exec(sandboxId, `ss -tlnp | grep :${APP_PORT} && echo OK || echo FAIL`, 10_000);
  if (check.includes('FAIL')) {
    const log = await exec(sandboxId, 'cat /tmp/app.log', 10_000).catch(() => '');
    throw new Error(`App failed to start:\n${log}`);
  }
  console.log(`    Listening on port ${APP_PORT}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Connectivity check
  try {
    const h = await fetch(`${CONTROL_PLANE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error();
  } catch {
    console.error('✗ Cannot reach sandbox.ml-serving-internal.scale.com');
    console.error('  Make sure Cloudflare WARP is connected (check the WARP icon in your menu bar).');
    process.exit(1);
  }

  const sandboxId = await createSandbox();
  const tunnelUrls = await waitForReady(sandboxId);
  await waitForCloudInit(sandboxId);
  await setupTtyd(sandboxId);
  await installAndDeploy(sandboxId);
  await startApp(sandboxId);

  const appUrl  = rewriteUrl(tunnelUrls[APP_PORT]  ?? tunnelUrls[String(APP_PORT)]);
  const ttydUrl = rewriteUrl(tunnelUrls[TTYD_PORT] ?? tunnelUrls[String(TTYD_PORT)]);
  const days = Math.round(TIMEOUT / 86400);

  // With the board shipped, data/users.json arrives as-is and the seed suffix
  // never applies — say so rather than print a login that won't work.
  const appLogin = INCLUDE_BOARD
    ? 'as in your shipped data/users.json'
    : `admin / admin-${SEED_SUFFIX}   (reviewers: <name>-${SEED_SUFFIX})`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    DEPLOYMENT COMPLETE                      ║
╠══════════════════════════════════════════════════════════════╣
  Sandbox ID : ${sandboxId}
  App URL    : ${appUrl}
  Terminal   : ${ttydUrl}
  Expires    : ${days} days from now
╠══════════════════════════════════════════════════════════════╣
  App login  : ${appLogin}
  Shell auth : cwt / ${TTYD_PASS}
  Credentials are random per deploy and printed only here — save them.
  Upload files via terminal: open Terminal URL → run rz
╚══════════════════════════════════════════════════════════════╝`);
}

main().catch((err) => { console.error('\n✗ Error:', err.message); process.exit(1); });
