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

// Pages require a session; assets and the login page stay public.
app.use((req, res, next) => {
  const isPage = req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/task/');
  if (isPage && req.path !== '/login.html' && !sessionUser(req)) {
    const prefix = req.headers['x-forwarded-prefix'] || '';
    return res.redirect(prefix + '/login.html');
  }
  next();
});

// Inject <base> + window.__base__ into an HTML string so tunnel-proxied
// absolute paths resolve correctly when served behind a path-prefix proxy.
function injectBase(html, req) {
  const prefix = process.env.BASE_PATH || req.headers['x-forwarded-prefix'] || '';
  if (!prefix) return html;
  // Rewrite absolute paths BEFORE injecting so the injected base tag isn't also rewritten
  html = html.replace(/((?:href|src|action)=")\//g, '$1');
  html = html.replace(/from '\/([^']+)'/g, "from './$1'");
  html = html.replace('<head>',
    `<head>\n  <base href="${prefix}/">\n  <script>window.__base__="${prefix}"</script>`);
  return html;
}

function sendHtml(req, res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.type('html').send(injectBase(fs.readFileSync(filePath, 'utf8'), req));
}

// '/' maps to index.html via express.static but bypasses the *.html route — handle it explicitly
app.get('/', (req, res) =>
  sendHtml(req, res, path.join(config.projectRoot, 'public', 'index.html'))
);

app.get('*.html', (req, res, next) => {
  const filePath = path.join(config.projectRoot, 'public', req.path);
  if (!fs.existsSync(filePath)) return next();
  sendHtml(req, res, filePath);
});

app.use(express.static(path.join(config.projectRoot, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

app.get('/task/:bucket/:id', (req, res) =>
  sendHtml(req, res, path.join(config.projectRoot, 'public', 'task.html'))
);

app.listen(config.port, () => {
  console.log(`chat-with-task on http://localhost:${config.port}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`delivery roots: ${config.deliveryRoots.join(', ')}`);
  console.log(`model: ${config.litellm.model} via ${config.litellm.baseURL}`);
});
