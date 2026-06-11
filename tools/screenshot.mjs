#!/usr/bin/env node
// Authenticated screenshots for dev: logs in, injects the session cookie via
// CDP, navigates, captures. Usage:
//   node tools/screenshot.mjs <url> <out.png> [username] [password] [width] [height]
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

const [url, out, username = 'admin', password = 'admin-cwt26', width = '1680', height = '1050'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/screenshot.mjs <url> <out.png> [user] [pass] [w] [h]');
  process.exit(1);
}

const origin = new URL(url).origin;
const login = await fetch(`${origin}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login failed: ${await login.text()}`);
const sid = login.headers.get('set-cookie').match(/cwt_sid=([a-f0-9]+)/)[1];

const port = 9333;
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [`--headless`, `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/cwt-shot-profile`, `--window-size=${width},${height}`, 'about:blank'],
  { stdio: 'ignore' }
);
// wait for the debug port (Chrome can take a few seconds on cold start)
async function getTargets() {
  for (let i = 0; i < 30; i++) {
    try {
      return await (await fetch(`http://localhost:${port}/json`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('chrome debug port never came up');
}

try {
  const targets = await getTargets();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Network.enable');
  await send('Network.setCookie', { name: 'cwt_sid', value: sid, url: origin });
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: Number(height), deviceScaleFactor: 1.5, mobile: false,
  });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 3500)); // let module JS + fetches settle
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`wrote ${out}`);
} finally {
  chrome.kill();
  execFile('rm', ['-rf', '/tmp/cwt-shot-profile']);
}
process.exit(0);
