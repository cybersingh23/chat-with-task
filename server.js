import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './src/config.js';
import { ensureWorkspace } from './src/workspace.js';
import { api } from './src/routes/api.js';
import { sessionUser } from './src/auth.js';

ensureWorkspace();

const app = express();

// liveness probe for container orchestration — no auth
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', api);

// Resolve the tunnel proxy base path from env or request header, validated
// against an allowlist to prevent header-injection / reflected XSS.
const SAFE_PREFIX_RE = /^\/[A-Za-z0-9/_-]*$/;
function resolvePrefix(req) {
  const raw = process.env.BASE_PATH || req.headers['x-forwarded-prefix'] || '';
  return SAFE_PREFIX_RE.test(raw) ? raw : '';
}

// Pages require a session; assets and the login page stay public.
app.use((req, res, next) => {
  const isPage = req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/task/');
  if (isPage && req.path !== '/login.html' && !sessionUser(req)) {
    return res.redirect(resolvePrefix(req) + '/login.html');
  }
  next();
});

// Inject <base> + window.__base__ into an HTML string so tunnel-proxied
// absolute paths resolve correctly when served behind a path-prefix proxy.
function injectBase(html, req) {
  const prefix = resolvePrefix(req);
  if (!prefix) return html;
  const escaped = prefix.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jsEscaped = prefix.replace(/[\\"]/g, '\\$&');
  // Rewrite absolute paths BEFORE injecting so the injected base tag isn't also rewritten.
  // Special-case href="/" → href="./" (bare root must resolve to base, not current page).
  html = html.replace(/href="\/"/g, 'href="./"');
  html = html.replace(/((?:href|src|action)=")\//g, '$1');
  html = html.replace(/from '\/([^']+)'/g, "from './$1'");
  html = html.replace('<head>',
    `<head>\n  <base href="${escaped}/">\n  <script>window.__base__="${jsEscaped}"</script>`);
  return html;
}

const publicRoot = path.join(config.projectRoot, 'public');

function sendHtml(req, res, filePath) {
  // Path-traversal guard: resolved path must stay under public/
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(publicRoot + path.sep) && resolved !== publicRoot) {
    return res.status(400).send('Bad request');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectBase(fs.readFileSync(resolved, 'utf8'), req));
}

// '/' maps to index.html via express.static but bypasses the *.html route — handle it explicitly
app.get('/', (req, res) =>
  sendHtml(req, res, path.join(publicRoot, 'index.html'))
);

app.get('*.html', (req, res, next) => {
  const filePath = path.join(publicRoot, req.path);
  if (!fs.existsSync(filePath)) return next();
  sendHtml(req, res, filePath);
});

app.use(express.static(publicRoot));

app.get('/task/:bucket/:id', (req, res) =>
  sendHtml(req, res, path.join(publicRoot, 'task.html'))
);

app.listen(config.port, () => {
  console.log(`chat-with-task on http://localhost:${config.port}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`delivery roots: ${config.deliveryRoots.join(', ')}`);
  console.log(`model: ${config.litellm.model} via ${config.litellm.baseURL}`);
});
