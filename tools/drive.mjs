#!/usr/bin/env node
// Authenticated browser DRIVER for dev: logs in, runs your JS in the page, waits,
// captures, and reports console errors.
//
// tools/screenshot.mjs can only photograph the initial state of a page. That is
// enough for a chart, and useless for anything behind an interaction — which is
// how a panel shipped with its messages clipped and its markdown rendering as
// literal asterisks: the launcher button screenshotted fine and nobody opened it.
//
// Usage:
//   node tools/drive.mjs <url> <out.png> <scriptFile> [w] [h] [settleMs]
//
//   scriptFile   JS evaluated in the page after load. Return a value and it is
//                printed — measure geometry, count nodes, assert what rendered.
//   PRE_SCRIPT   optional JS injected BEFORE page scripts run
//                (Page.addScriptToEvaluateOnNewDocument) — stub fetch to see a
//                loading state, force a theme, seed localStorage.
//   PRE_WAIT     ms to wait after navigate before the script runs (default 3000).
//
// Example — open the Acey panel and check nothing overflows:
//   cat > /tmp/s.js <<'JS'
//   (async () => {
//     document.getElementById('acey-fab').click();
//     await new Promise(r => setTimeout(r, 1200));
//     const p = document.getElementById('acey-panel');
//     return { rect: p.getBoundingClientRect().toJSON() };
//   })()
//   JS
//   node tools/drive.mjs http://localhost:4100/team.html /tmp/out.png /tmp/s.js
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

const [url, out, scriptFile, width = '1680', height = '1050', settle = '3500'] = process.argv.slice(2);
const origin = new URL(url).origin;
const login = await fetch(`${origin}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin-cwt26' }),
});
if (!login.ok) throw new Error(`login failed: ${await login.text()}`);
const sid = login.headers.get('set-cookie').match(/cwt_sid=([a-f0-9]+)/)[1];

const port = 9334;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/cwt-drive-profile',
    `--window-size=${width},${height}`, 'about:blank'],
  { stdio: 'ignore' },
);
async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://localhost:${port}/json`)).json(); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('chrome debug port never came up');
}

try {
  const targets = await getTargets();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let msgId = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXCEPTION] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Network.setCookie', { name: 'cwt_sid', value: sid, url: origin });
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: Number(height), deviceScaleFactor: 1.5, mobile: false,
  });
  await send('Page.enable');
  if (process.env.PRE_SCRIPT && fs.existsSync(process.env.PRE_SCRIPT)) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(process.env.PRE_SCRIPT, 'utf8') });
  }
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, Number(process.env.PRE_WAIT ?? 3000)));

  if (scriptFile && fs.existsSync(scriptFile)) {
    const expr = fs.readFileSync(scriptFile, 'utf8');
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.error('SCRIPT ERROR:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    else if (r.result?.result?.value !== undefined) console.log('script ->', JSON.stringify(r.result.result.value).slice(0, 600));
  }
  await new Promise((r) => setTimeout(r, Number(settle)));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`wrote ${out}`);
  if (logs.length) console.log('console:\n' + logs.slice(0, 25).join('\n'));
} finally {
  chrome.kill();
  execFile('rm', ['-rf', '/tmp/cwt-drive-profile']);
}
process.exit(0);
