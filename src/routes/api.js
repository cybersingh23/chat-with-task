import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  listWorkspace, taskMeta, listFiles, readTaskFile, readTrajectory,
  readTaskDef, readRank, moveTask, findTaskBucket, taskDir, resolveSafe, deleteTask, clearWorkspace,
} from '../workspace.js';
import { BUCKETS } from '../config.js';
import { ingestTask, findTaskSources } from '../ingest.js';
import { handleUpload } from '../upload.js';
import { verifyLogin, createSession, destroySession, requireAuth, requireAdmin } from '../auth.js';
import { claimTask, releaseTask, setVerdict, setVerdictNote, setChecklistItem, getState, VERDICTS } from '../state.js';
import { runAgentLoop } from '../llm.js';
import { TOOL_DEFS, makeExecutor } from '../tools.js';
import { generateDoc, taskContext, CITATION_RULES } from '../docgen.js';
import { QUALITY_CANON, getRubric, saveRubricCsv } from '../spec.js';
import { recordUsage, readUsage, usageCsv } from '../usage.js';
import { enqueueDocs, jobSummary, statusFor } from '../jobs.js';
import { startPull, pullStatus, currentDownload } from '../l10.js';
import { markDelivered, markUndelivered, deliverStatus, currentBackup } from '../deliver.js';
import { createDummyTask, removeTourTasks, logTour } from '../tour.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- auth (the only routes that don't require a session) ----
api.post('/login', wrap(async (req, res) => {
  const user = verifyLogin(String(req.body.username || ''), String(req.body.password || ''));
  if (!user) return res.status(401).json({ error: 'invalid username or password' });
  const sid = createSession(user);
  res.setHeader('set-cookie', `cwt_sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
  res.json(user);
}));

api.post('/logout', requireAuth, wrap(async (req, res) => {
  destroySession(req.sid);
  res.setHeader('set-cookie', 'cwt_sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

api.use(requireAuth);

api.get('/me', (req, res) => res.json(req.user));

// --- guided tour sandbox: a disposable dummy task the user can act on ---
api.post('/tour/start', wrap(async (req, res) => res.json(createDummyTask(req.user.username))));
api.post('/tour/end', wrap(async (req, res) => res.json({ removed: removeTourTasks(req.user.username) })));
api.post('/tour/log', wrap(async (req, res) => {
  logTour({ user: req.user.username, at: new Date().toISOString(), step: req.body?.step, action: req.body?.action, success: !!req.body?.success });
  res.json({ ok: true });
}));

api.get('/spec/rubric', (req, res) => res.json({ dimensions: getRubric() }));

// admin: copilot/docgen activity, token usage, and cost
api.get('/admin/usage', requireAdmin, wrap(async (req, res) =>
  res.json(readUsage(Math.min(2000, Number(req.query.limit) || 500)))
));

api.get('/admin/usage.csv', requireAdmin, wrap(async (req, res) => {
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="copilot_usage.csv"');
  res.send(usageCsv());
}));

// admin uploads the QC rubric CSV once (raw text body); everyone reads it
api.post('/spec/rubric', requireAdmin, express.text({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  const dims = saveRubricCsv(String(req.body || ''));
  res.json({ ok: true, dimensions: dims.length });
}));

api.get('/workspace', wrap(async (req, res) => res.json(listWorkspace())));

api.get('/config', (req, res) =>
  res.json({ model: config.litellm.model, deliveryRoots: config.deliveryRoots, workspaceRoot: config.workspaceRoot })
);

api.post('/ingest', requireAdmin, wrap(async (req, res) => {
  const { taskId, bucket } = req.body;
  res.json(ingestTask(String(taskId || '').trim(), bucket || 'UNSORTED'));
}));

api.get('/find/:taskId', wrap(async (req, res) => res.json({ sources: findTaskSources(req.params.taskId) })));

// multipart folder/zip upload — admin only, must NOT go through express.json
api.post('/upload', requireAdmin, handleUpload);

api.get('/task/:bucket/:id/taskdef', wrap(async (req, res) => res.json(readTaskDef(req.params.bucket, req.params.id))));

api.get('/task/:bucket/:id/rank', wrap(async (req, res) => res.json(readRank(req.params.bucket, req.params.id))));

// ---- claim / verdict / export ----
api.post('/task/:bucket/:id/claim', wrap(async (req, res) =>
  res.json(claimTask(req.params.bucket, req.params.id, req.user.username))
));

api.post('/task/:bucket/:id/release', wrap(async (req, res) =>
  res.json(releaseTask(req.params.bucket, req.params.id, req.user.username, req.user.role === 'admin'))
));

api.post('/task/:bucket/:id/verdict', wrap(async (req, res) =>
  res.json(setVerdict(req.params.bucket, req.params.id, req.body.verdict ?? null, req.user.username))
));

// the "key issue" note behind a Second Opinion verdict
api.post('/task/:bucket/:id/verdict-note', wrap(async (req, res) =>
  res.json(setVerdictNote(req.params.bucket, req.params.id, req.body.note ?? '', req.user.username))
));

api.get('/task/:bucket/:id/state', wrap(async (req, res) => res.json(getState(req.params.bucket, req.params.id))));

api.post('/task/:bucket/:id/checklist', wrap(async (req, res) =>
  res.json(setChecklistItem(req.params.bucket, req.params.id, String(req.body.key || ''), req.body.status || '', req.user.username))
));

// One task_id per line for a bucket column, or ?verdict=SBQ for a verdict group.
api.get('/export/ids/:bucket', wrap(async (req, res) => {
  const ws = listWorkspace();
  let tasks = ws[req.params.bucket];
  if (!tasks) return res.status(400).json({ error: `unknown bucket ${req.params.bucket}` });
  tasks = tasks.filter((t) => !t.tour);
  if (req.query.verdict) tasks = tasks.filter((t) => t.verdict === req.query.verdict);
  res.setHeader('content-type', 'text/plain');
  res.setHeader('content-disposition', `attachment; filename="${req.params.bucket}${req.query.verdict ? '_' + req.query.verdict : ''}_task_ids.txt"`);
  res.send(tasks.map((t) => t.id).join('\n') + (tasks.length ? '\n' : ''));
}));

api.get('/export/all.csv', wrap(async (req, res) => {
  const ws = listWorkspace();
  const lines = ['task_id,bucket,verdict,claimed_by,has_review,has_remediation'];
  for (const [bucket, tasks] of Object.entries(ws)) {
    for (const t of tasks) {
      if (t.tour) continue;
      lines.push([t.id, bucket, t.verdict || '', t.claimedBy || '', t.hasReview, t.hasRemediation].join(','));
    }
  }
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="workspace_export.csv"');
  res.send(lines.join('\n') + '\n');
}));

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

// admin: delete one task, or clear the whole board (fresh delivery cycle)
api.delete('/task/:bucket/:id', requireAdmin, wrap(async (req, res) => {
  deleteTask(req.params.bucket, req.params.id);
  res.json({ ok: true });
}));

api.post('/admin/clear', requireAdmin, wrap(async (req, res) => {
  res.json({ cleared: clearWorkspace() });
}));

// --- L10 pull: fetch tasks from Redash into a downloadable zip (admin only) ---
// Fire-and-forget (the pull downloads trajectories and can run for minutes); the
// admin UI polls /admin/pull-l10/status, then GETs /download when a zip is ready.
// body: { mode: 'l10' | 'ids', taskIds?: string[] }
api.post('/admin/pull-l10', requireAdmin, wrap(async (req, res) => {
  const mode = req.body?.mode === 'ids' ? 'ids' : 'l10';
  const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.map(String) : [];
  if (mode === 'ids' && !taskIds.length) return res.status(400).json({ error: 'taskIds required for mode=ids' });
  res.json(startPull({ mode, taskIds, user: req.user.username }));
}));

api.get('/admin/pull-l10/status', requireAdmin, wrap(async (req, res) => res.json(pullStatus())));

api.get('/admin/pull-l10/download', requireAdmin, wrap(async (req, res) => {
  const dl = currentDownload();
  if (!dl) return res.status(404).json({ error: 'no pull available to download yet' });
  res.download(dl.abs, dl.name);
}));

// --- deliver: soft-archive tasks (hide from board) + build a restorable backup ---
const taskIdList = (body) => (Array.isArray(body?.taskIds) ? body.taskIds : [])
  .map((s) => String(s).trim()).filter(Boolean);

api.post('/admin/deliver', requireAdmin, wrap(async (req, res) => {
  const ids = taskIdList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'taskIds required' });
  res.json(await markDelivered(ids, req.user.username));
}));

api.post('/admin/undeliver', requireAdmin, wrap(async (req, res) => {
  const ids = taskIdList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'taskIds required' });
  res.json(markUndelivered(ids, req.user.username));
}));

// bulk-move: relocate many tasks at once. Source = an explicit taskIds list
// AND/OR every task in fromBucket. Destination = a target bucket, or mark them
// delivered. (admin only)
api.post('/admin/bulk-move', requireAdmin, wrap(async (req, res) => {
  const ids = new Set(taskIdList(req.body));
  if (req.body?.fromBucket) {
    const ws = listWorkspace();
    const list = ws[req.body.fromBucket];
    if (!list) return res.status(400).json({ error: `unknown bucket ${req.body.fromBucket}` });
    for (const t of list) if (!t.tour) ids.add(t.id);
  }
  const targetIds = [...ids];
  if (!targetIds.length) return res.status(400).json({ error: 'provide taskIds and/or fromBucket' });

  if (req.body?.delivered) return res.json({ mode: 'delivered', ...(await markDelivered(targetIds, req.user.username)) });

  const to = req.body?.to;
  if (!BUCKETS.includes(to)) return res.status(400).json({ error: `to must be one of ${BUCKETS.join(', ')}` });
  const moved = [], sameBucket = [], notFound = [];
  for (const id of targetIds) {
    const from = findTaskBucket(id);
    if (!from) { notFound.push(id); continue; }
    if (from === to) { sameBucket.push(id); continue; }
    try { moveTask(from, id, to); moved.push(id); } catch { notFound.push(id); }
  }
  res.json({ mode: 'move', to, moved: moved.length, sameBucket: sameBucket.length, notFound, movedIds: moved });
}));

api.get('/admin/deliver/status', requireAdmin, wrap(async (req, res) => res.json(deliverStatus())));

api.get('/admin/deliver/download', requireAdmin, wrap(async (req, res) => {
  const bk = currentBackup();
  if (!bk) return res.status(404).json({ error: 'no delivery backup available yet' });
  res.download(bk.abs, bk.name);
}));

// --- doc generation (SSE so the UI can show tool activity live) ---
// Doc generation runs as a background job (survives the client navigating away).
api.post('/task/:bucket/:id/docgen/:which', requireAdmin, wrap(async (req, res) => {
  const { bucket, id, which } = req.params;
  if (!['review', 'remediation'].includes(which)) return res.status(400).json({ error: 'which must be review|remediation' });
  res.json(enqueueDocs(bucket, id, [which], req.user.username));
}));

// generate docs for EVERY task at once (admin). onlyMissing (default true) skips
// tasks that already have the doc; pass {onlyMissing:false} to regenerate all.
api.post('/admin/gendocs', requireAdmin, wrap(async (req, res) => {
  const onlyMissing = req.body?.onlyMissing !== false;
  const ws = listWorkspace();
  let queued = 0, tasks = 0;
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const whichList = [];
      if (!onlyMissing || !t.hasReview) whichList.push('review');
      if (!onlyMissing || !t.hasRemediation) whichList.push('remediation');
      if (!whichList.length) continue;
      tasks++;
      if (enqueueDocs(bucket, t.id, whichList, req.user.username).queued) queued++;
    }
  }
  res.json({ queued, tasks });
}));

api.get('/admin/gendocs/status', requireAdmin, wrap(async (req, res) => res.json(jobSummary())));

api.get('/task/:bucket/:id/docstatus', wrap(async (req, res) => res.json(statusFor(req.params.bucket, req.params.id))));

// --- chat with task (SSE agent loop, history persisted in _chat.json) ---
const CHAT_PROMPT = `
You are the ACC quality SME embedded in a QM reviewer's audit session. You know the customer
program spec cold (the quality canon below; full texts via read_spec) and you have tools over
this task's files. The reviewer already has a verbose review.md and remediation.md — you are NOT
another source of prose. You are the source of truth they consult for specific questions.

Answer discipline (strict):
- Lead with the answer/verdict in one sentence. No preamble, no restating the question, no
  recapping what the review already says.
- Then exactly what supports it, in this shape:
  **Where:** the precise location — rank.json field path, traj:// citation, or file.
  **Evidence:** the quoted text / search hit count. Verbatim quotes, trimmed hard.
  **Rule:** the spec basis when severity or policy is involved — cite the sub-dimension or
  check code (e.g. "QC 4.2 [Fail - Fabricated or False Claim]", "ONL-GC-07").
- Default to under 120 words. Go longer ONLY when the reviewer asks for depth or the question
  is genuinely multi-part. One question, one answer — no unsolicited adjacent observations
  unless they change the verdict (then one line, marked "Also:").
- Never assert anything about a trajectory you haven't read or searched in this conversation.
  If you can't verify, say "unverified" and what you'd need.
- When judging severity, give the bucket (HARD / SOFT / INFO) and the one rule that decides it.
  When the reviewer asks "what should I look for", give a checklist of concrete searches/places
  ordered by expected yield, not an essay.
`.trim();

api.post('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const dir = taskDir(bucket, id);
  const history = loadChat(dir);
  const userMsg = { role: 'user', content: String(req.body.message || '').slice(0, 50_000) };
  if (!userMsg.content) return res.status(400).json({ error: 'message required' });

  const system = [CHAT_PROMPT, QUALITY_CANON, CITATION_RULES, taskContext(bucket, id)].join('\n\n');
  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  const onUsage = (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; };
  startSSE(res);
  try {
    const { messages } = await runAgentLoop({
      messages: [{ role: 'system', content: system }, ...history, userMsg],
      tools: TOOL_DEFS,
      executor: makeExecutor(bucket, id),
      onEvent: (e) => sendSSE(res, e),
      maxSteps: 50,
      onUsage,
    });
    saveChat(dir, [...history, userMsg, ...messages]);
    sendSSE(res, { type: 'done' });
  } catch (e) {
    sendSSE(res, { type: 'error', message: e.message });
  } finally {
    recordUsage({ user: req.user.username, taskId: id, kind: 'chat', model: config.litellm.model, usage: acc, text: userMsg.content });
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
