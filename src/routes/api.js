import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  listWorkspace, taskMeta, listFiles, readTaskFile, readTrajectory,
  moveTask, taskDir, resolveSafe,
} from '../workspace.js';
import { ingestTask, findTaskSources } from '../ingest.js';
import { runAgentLoop } from '../llm.js';
import { TOOL_DEFS, makeExecutor } from '../tools.js';
import { generateDoc, taskContext, CITATION_RULES } from '../docgen.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

api.get('/workspace', wrap(async (req, res) => res.json(listWorkspace())));

api.get('/config', (req, res) =>
  res.json({ model: config.litellm.model, deliveryRoots: config.deliveryRoots, workspaceRoot: config.workspaceRoot })
);

api.post('/ingest', wrap(async (req, res) => {
  const { taskId, bucket } = req.body;
  res.json(ingestTask(String(taskId || '').trim(), bucket || 'UNSORTED'));
}));

api.get('/find/:taskId', wrap(async (req, res) => res.json({ sources: findTaskSources(req.params.taskId) })));

api.get('/task/:bucket/:id', wrap(async (req, res) => res.json(taskMeta(req.params.bucket, req.params.id))));

api.get('/task/:bucket/:id/files', wrap(async (req, res) => res.json(listFiles(req.params.bucket, req.params.id))));

api.get('/task/:bucket/:id/file', wrap(async (req, res) => {
  const f = readTaskFile(req.params.bucket, req.params.id, String(req.query.path || ''));
  if (f.kind === 'image') return res.sendFile(f.abs);
  res.json(f);
}));

api.get('/task/:bucket/:id/trajectory/:model', wrap(async (req, res) =>
  res.json(readTrajectory(req.params.bucket, req.params.id, req.params.model))
));

api.post('/task/:bucket/:id/move', wrap(async (req, res) => {
  moveTask(req.params.bucket, req.params.id, req.body.to);
  res.json({ ok: true, bucket: req.body.to });
}));

// --- doc generation (SSE so the UI can show tool activity live) ---
api.post('/task/:bucket/:id/docgen/:which', wrap(async (req, res) => {
  const { bucket, id, which } = req.params;
  if (!['review', 'remediation'].includes(which)) return res.status(400).json({ error: 'which must be review|remediation' });
  startSSE(res);
  try {
    const doc = await generateDoc(bucket, id, which, (e) => sendSSE(res, e));
    sendSSE(res, { type: 'done', doc });
  } catch (e) {
    sendSSE(res, { type: 'error', message: e.message });
  }
  res.end();
}));

// --- chat with task (SSE agent loop, history persisted in _chat.json) ---
const CHAT_PROMPT = `
You are the audit copilot for an ACC online A/B delivery task. A QM reviewer has claimed this
task and is auditing it with you. You have tools that read the task's files: rank.json, both
trajectories, snapshots, and ranking_proof. Help them verify claims, find flaws, judge fairness,
and plan remediation. Be precise and evidence-first: never assert something about a trajectory
without having read or searched it this conversation. Keep answers tight; quote evidence verbatim.
`.trim();

api.post('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const dir = taskDir(bucket, id);
  const history = loadChat(dir);
  const userMsg = { role: 'user', content: String(req.body.message || '').slice(0, 50_000) };
  if (!userMsg.content) return res.status(400).json({ error: 'message required' });

  const system = [CHAT_PROMPT, CITATION_RULES, taskContext(bucket, id)].join('\n\n');
  startSSE(res);
  try {
    const { messages } = await runAgentLoop({
      messages: [{ role: 'system', content: system }, ...history, userMsg],
      tools: TOOL_DEFS,
      executor: makeExecutor(bucket, id),
      onEvent: (e) => sendSSE(res, e),
      maxSteps: 15,
    });
    saveChat(dir, [...history, userMsg, ...messages]);
    sendSSE(res, { type: 'done' });
  } catch (e) {
    sendSSE(res, { type: 'error', message: e.message });
  }
  res.end();
}));

api.get('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const history = loadChat(taskDir(req.params.bucket, req.params.id));
  // Only what the UI renders: user text + assistant text + tool call markers.
  res.json(
    history
      .map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.role === 'assistant' && m.content) return { role: 'assistant', content: m.content };
        if (m.role === 'assistant' && m.tool_calls?.length)
          return { role: 'tools', tools: m.tool_calls.map((c) => c.function.name) };
        return null;
      })
      .filter(Boolean)
  );
}));

api.delete('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const p = path.join(taskDir(req.params.bucket, req.params.id), '_chat.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
}));

function loadChat(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '_chat.json'), 'utf8'));
  } catch {
    return [];
  }
}
function saveChat(dir, messages) {
  fs.writeFileSync(path.join(dir, '_chat.json'), JSON.stringify(messages, null, 2));
}

function startSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders?.();
}
function sendSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

api.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});
