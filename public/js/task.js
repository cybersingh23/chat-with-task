import { api, apiSSE, renderMarkdown, el, fmtTime } from '/js/common.js';

const [, , bucket, taskId] = location.pathname.split('/');
document.getElementById('task-id').textContent = taskId;
const chip = document.getElementById('bucket-chip');
chip.textContent = bucket;
chip.className = `chip ${bucket}`;

const viewerBody = document.getElementById('viewer-body');
const viewerTitle = document.getElementById('viewer-title');
const trajCache = {};
let activeNav = null;

// ---------- global traj:// deep-link delegation ----------
// Any element with data-traj-model/index (markdown links, chat citations)
// opens the trajectory viewer at that message.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-traj-model]');
  if (!a) return;
  e.preventDefault();
  showTrajectory(a.dataset.trajModel, Number(a.dataset.trajIndex));
});

// ---------- sidebar ----------
const DOCS = [
  { key: 'review', label: 'Review', file: 'review.md' },
  { key: 'remediation', label: 'Remediation', file: 'remediation.md' },
  { key: 'seed', label: 'Audit seed', file: '_audit_seed.md' },
];

let taskDef = null;
let hasReview = false;

async function buildSidebar() {
  const meta = await api(`/task/${bucket}/${taskId}`);
  hasReview = meta.hasReview;
  taskDef ||= await api(`/task/${bucket}/${taskId}/taskdef`);
  const navDocs = document.getElementById('nav-docs');
  navDocs.replaceChildren();

  navDocs.append(
    el('button', { class: 'nav-item', onclick: (ev) => { setActive(ev.currentTarget); showTaskDef(); } },
      el('span', {}, el('span', { class: `status-dot ${taskDef.missing ? '' : 'on'}` }, '●'), ' Task definition'),
      el('span', { class: 'missing' }, taskDef.missing ? 'missing' : `${taskDef.milestones.length} milestones`),
    )
  );

  for (const d of DOCS) {
    const present = d.key === 'review' ? meta.hasReview : d.key === 'remediation' ? meta.hasRemediation : meta.hasAuditSeed;
    navDocs.append(
      el('button', { class: 'nav-item', onclick: (ev) => openDoc(d, ev.currentTarget) },
        el('span', {}, el('span', { class: `status-dot ${present ? 'on' : ''}` }, '●'), ` ${d.label}`),
        present ? null : el('span', { class: 'missing' }, d.key === 'seed' ? 'none' : 'generate'),
      )
    );
  }

  const navTrajs = document.getElementById('nav-trajs');
  navTrajs.replaceChildren(
    el('button', { class: 'nav-item', onclick: (ev) => { setActive(ev.currentTarget); showTrajectory('model_a'); } }, 'model_a'),
    el('button', { class: 'nav-item', onclick: (ev) => { setActive(ev.currentTarget); showTrajectory('model_b'); } }, 'model_b'),
  );

  const tree = await api(`/task/${bucket}/${taskId}/files`);
  const navFiles = document.getElementById('nav-files');
  navFiles.replaceChildren();
  const addEntries = (entries, depth) => {
    for (const entry of entries) {
      if (entry.dir) { addEntries(entry.children, depth + 1); continue; }
      const name = entry.path;
      if (['review.md', 'remediation.md', '_audit_seed.md', '_chat.json', '_studio.json'].includes(name)) continue;
      if (/^trajectories\//.test(name)) continue;
      navFiles.append(
        el('button', { class: 'nav-item', title: name, onclick: (ev) => { setActive(ev.currentTarget); showFile(name); } },
          name.length > 34 ? '…' + name.slice(-33) : name)
      );
    }
  };
  addEntries(tree, 0);
}

function setActive(node) {
  activeNav?.classList.remove('active');
  activeNav = node;
  node?.classList.add('active');
}

// ---------- viewers ----------
async function openDoc(doc, navNode) {
  setActive(navNode);
  viewerTitle.textContent = doc.file;
  try {
    const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(doc.file)}`);
    viewerBody.replaceChildren(el('div', { class: 'md' }));
    viewerBody.firstChild.innerHTML = renderMarkdown(f.text);
    if (doc.key !== 'seed') addRegenButton(doc);
  } catch {
    viewerBody.replaceChildren(
      el('p', {}, doc.key === 'seed'
        ? 'No _audit_seed.md — this task was claimed from a delivery without /acc audit artifacts.'
        : `No ${doc.file} yet.`),
    );
    if (doc.key !== 'seed') addRegenButton(doc);
  }
}

function addRegenButton(doc) {
  const head = document.querySelector('.viewer-head');
  head.querySelector('.regen')?.remove();
  head.append(
    el('button', {
      class: 'regen',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const progress = el('div', { class: 'tool-line' }, 'starting…');
        viewerBody.prepend(progress);
        try {
          await apiSSE(`/task/${bucket}/${taskId}/docgen/${doc.key}`, {}, (m) => {
            if (m.type === 'tool') progress.textContent = `⚙ ${m.name} ${JSON.stringify(m.args)}`;
            if (m.type === 'error') progress.textContent = `error: ${m.message}`;
            if (m.type === 'done') {
              viewerBody.replaceChildren(el('div', { class: 'md' }));
              viewerBody.firstChild.innerHTML = renderMarkdown(m.doc);
              buildSidebar();
            }
          });
        } catch (e) {
          progress.textContent = `error: ${e.message}`;
        }
        btn.disabled = false;
      },
    }, `Generate ${doc.key}.md`)
  );
}

// ---------- task definition / milestones ----------
function showTaskDef() {
  viewerTitle.textContent = `task definition${taskDef.missing ? '' : ` (${taskDef.source})`}`;
  document.querySelector('.viewer-head .regen')?.remove();
  if (taskDef.missing) {
    viewerBody.replaceChildren(
      el('div', { class: 'callout info' },
        'No task definition shipped with this task (no embedded rank.json "task" object, no source_task/task.json). ',
        'Informational only per customer policy 2026-06-09 — never a finding.'),
    );
    return;
  }
  viewerBody.replaceChildren(
    el('div', { class: 'taskdef' },
      el('h1', {}, taskDef.title || 'Task definition'),
      el('div', { class: 'def-chips' },
        taskDef.category ? el('span', { class: 'chip' }, taskDef.category) : null,
        taskDef.difficulty ? el('span', { class: `chip diff-${taskDef.difficulty}` }, taskDef.difficulty) : null,
        taskDef.language ? el('span', { class: 'chip' }, taskDef.language) : null,
      ),
      taskDef.user_persona
        ? el('div', { class: 'callout' }, el('strong', {}, 'User persona — '), taskDef.user_persona)
        : null,
      el('h2', {}, `Milestones (${taskDef.milestones.length})`),
      el('p', { class: 'hint-line' },
        'The annotator must enter each milestone prompt (paraphrase counts) in order, in both trajectories. ',
        '“Locate” jumps to the closest user turn — it is navigation, not a coverage verdict.'),
      taskDef.milestones.map((m, i) =>
        el('div', { class: 'milestone' },
          el('div', { class: 'milestone-head' },
            el('span', { class: 'chip milestone-id' }, m.id),
            el('span', { class: 'milestone-title' }, m.title || `Milestone ${i + 1}`),
            el('span', { class: 'spacer' }),
            el('button', { onclick: () => locateMilestone('model_a', m) }, 'Locate in A'),
            el('button', { onclick: () => locateMilestone('model_b', m) }, 'Locate in B'),
            el('button', { onclick: () => askCopilotAboutMilestone(m) }, 'Ask copilot'),
          ),
          el('div', { class: 'milestone-prompt' }, m.prompt),
        )
      ),
      taskDef.guardrails.length
        ? [el('h2', {}, 'Guardrails'), el('ul', {}, taskDef.guardrails.map((g) => el('li', {}, g)))]
        : null,
    )
  );
}

// Jump to the user turn that best lexically matches the milestone prompt.
// Deliberately framed as navigation: fuzzy matching cannot prove a milestone
// was or wasn't entered.
async function locateMilestone(model, milestone) {
  if (!trajCache[model]) trajCache[model] = await api(`/task/${bucket}/${taskId}/trajectory/${model}`);
  const tokens = tokenize(milestone.prompt);
  let best = null;
  for (const m of trajCache[model].messages) {
    if (m.role !== 'user') continue;
    const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    const overlap = score(tokens, tokenize(text));
    if (!best || overlap > best.overlap) best = { index: m.index, overlap };
  }
  if (!best) {
    alert(`${model} has no user turns — likely a stub trajectory.`);
    return;
  }
  setActive(null);
  showTrajectory(model, best.index);
}

function tokenize(s) {
  return new Set(String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
}
function score(a, b) {
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return a.size ? hit / a.size : 0;
}

function askCopilotAboutMilestone(m) {
  chatText.value = `Check milestone ${m.id} ("${m.title || m.prompt.slice(0, 80)}") in both trajectories: was its intent entered by the annotator (paraphrase counts) or done proactively by the model? Cite the matching user turns with traj:// links, or quote evidence it is genuinely absent.`;
  chatText.focus();
}

async function showTrajectory(model, focusIndex = null) {
  viewerTitle.textContent = `trajectories/trajectory_${model}.json`;
  document.querySelector('.viewer-head .regen')?.remove();
  if (!trajCache[model]) {
    viewerBody.replaceChildren(el('p', { class: 'mono' }, `loading ${model}…`));
    trajCache[model] = await api(`/task/${bucket}/${taskId}/trajectory/${model}`);
  }
  const traj = trajCache[model];
  viewerBody.replaceChildren(
    ...traj.messages.map((m) =>
      el('div', { class: `traj-msg role-${m.role}`, id: `msg-${model}-${m.index}` },
        el('div', { class: 'traj-msg-head' },
          el('span', { class: 'role' }, `${model}[${m.index}] ${m.role}`),
          el('span', { class: 'time' }, fmtTime(m.created)),
          el('button', {
            class: 'copy', title: 'copy traj:// link for use in chat/docs',
            onclick: () => navigator.clipboard.writeText(`traj://${model}/${m.index}`),
          }, 'copy link'),
        ),
        m.parts.map((p) => {
          if (p.type === 'text') return el('div', { class: 'traj-part text' }, p.text);
          if (p.type === 'reasoning') return el('div', { class: 'traj-part reasoning' }, p.text);
          return el('div', { class: 'traj-part' },
            el('details', {},
              el('summary', {}, `⚙ ${p.tool} ${p.title || ''} [${p.status}]`),
              el('pre', {}, `input: ${p.input}\n\noutput: ${p.output}`),
            )
          );
        }),
      )
    )
  );
  if (focusIndex != null) {
    const node = document.getElementById(`msg-${model}-${focusIndex}`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  }
}

async function showFile(relPath) {
  viewerTitle.textContent = relPath;
  document.querySelector('.viewer-head .regen')?.remove();
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(relPath)) {
    viewerBody.replaceChildren(
      el('img', { class: 'proof', src: `/api/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}` })
    );
    return;
  }
  const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}`);
  if (relPath.endsWith('.md')) {
    viewerBody.replaceChildren(el('div', { class: 'md' }));
    viewerBody.firstChild.innerHTML = renderMarkdown(f.text);
  } else if (relPath.endsWith('.json')) {
    let pretty = f.text;
    try { pretty = JSON.stringify(JSON.parse(f.text), null, 2); } catch { /* show raw */ }
    viewerBody.replaceChildren(el('pre', { class: 'raw' }, pretty));
  } else {
    viewerBody.replaceChildren(el('pre', { class: 'raw' }, f.text));
  }
  if (f.truncated) viewerBody.prepend(el('p', { class: 'mono' }, '[file clipped at 200k chars]'));
}

// ---------- chat ----------
const chatLog = document.getElementById('chat-log');
const chatText = document.getElementById('chat-text');
const chatStatus = document.getElementById('chat-status');

function appendChat(role, content) {
  const bubble = el('div', { class: `bubble${role === 'assistant' ? ' md' : ''}` });
  if (role === 'assistant') bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  chatLog.append(
    el('div', { class: `chat-msg ${role}` },
      el('div', { class: 'who' }, role === 'user' ? 'reviewer' : 'copilot'),
      bubble,
    )
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendToolLine(text) {
  chatLog.append(el('div', { class: 'tool-line' }, text));
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadChat() {
  const history = await api(`/task/${bucket}/${taskId}/chat`);
  chatLog.replaceChildren();
  for (const m of history) {
    if (m.role === 'tools') appendToolLine(`⚙ ${m.tools.join(', ')}`);
    else appendChat(m.role, m.content);
  }
}

async function send() {
  const message = chatText.value.trim();
  if (!message) return;
  chatText.value = '';
  appendChat('user', message);
  document.getElementById('chat-send').disabled = true;
  chatStatus.textContent = 'thinking…';
  chatStatus.classList.remove('error-line');
  try {
    await apiSSE(`/task/${bucket}/${taskId}/chat`, { message }, (m) => {
      if (m.type === 'tool') {
        appendToolLine(`⚙ ${m.name} ${JSON.stringify(m.args).slice(0, 120)}`);
        chatStatus.textContent = `running ${m.name}…`;
      }
      if (m.type === 'assistant') { appendChat('assistant', m.content); chatStatus.textContent = ''; }
      if (m.type === 'error') { chatStatus.textContent = m.message; chatStatus.classList.add('error-line'); }
      if (m.type === 'done') chatStatus.textContent = '';
    });
  } catch (e) {
    chatStatus.textContent = e.message;
    chatStatus.classList.add('error-line');
  }
  document.getElementById('chat-send').disabled = false;
}

document.getElementById('chat-send').addEventListener('click', send);
chatText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('clear-chat').addEventListener('click', async () => {
  await api(`/task/${bucket}/${taskId}/chat`, { method: 'DELETE' });
  chatLog.replaceChildren();
});

document.getElementById('move-select').addEventListener('change', async (e) => {
  const to = e.target.value;
  if (!to || to === bucket) return;
  await api(`/task/${bucket}/${taskId}/move`, { method: 'POST', body: { to } });
  location.href = `/task/${to}/${taskId}`;
});

// ---------- claim / verdict ----------
const claimBtn = document.getElementById('claim-btn');
const claimChip = document.getElementById('claim-chip');
const verdictSelect = document.getElementById('verdict-select');

async function refreshState() {
  const s = await api(`/task/${bucket}/${taskId}/state`);
  const mine = s.claimed_by === me.username;
  claimChip.hidden = !s.claimed_by;
  claimChip.textContent = s.claimed_by ? (mine ? 'claimed by you' : `claimed by ${s.claimed_by}`) : '';
  claimBtn.hidden = false;
  claimBtn.textContent = s.claimed_by ? (mine || me.role === 'admin' ? 'Release' : 'Claimed') : 'Claim task';
  claimBtn.disabled = Boolean(s.claimed_by) && !mine && me.role !== 'admin';
  claimBtn.classList.toggle('primary', !s.claimed_by);
  verdictSelect.value = s.verdict || '';
}

claimBtn.addEventListener('click', async () => {
  const s = await api(`/task/${bucket}/${taskId}/state`);
  const action = s.claimed_by ? 'release' : 'claim';
  try {
    await api(`/task/${bucket}/${taskId}/${action}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  refreshState();
});

verdictSelect.addEventListener('change', async () => {
  const v = verdictSelect.value;
  if (!v) return;
  await api(`/task/${bucket}/${taskId}/verdict`, {
    method: 'POST',
    body: { verdict: v === '__clear' ? null : v },
  });
  refreshState();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------- boot ----------
const me = await api('/me'); // 401 redirects to login
document.getElementById('user-chip').hidden = false;
document.getElementById('user-name').textContent = me.username;
await refreshState();
setInterval(refreshState, 10_000); // reflect other reviewers' claims live
await buildSidebar();
const params = new URLSearchParams(location.search);
if (params.get('traj')) {
  showTrajectory(params.get('traj'), params.has('msg') ? Number(params.get('msg')) : null);
} else if (!hasReview && !taskDef.missing) {
  // fresh task: lead with the task definition so milestones are front and center
  setActive(document.querySelector('#nav-docs .nav-item'));
  showTaskDef();
} else {
  openDoc(DOCS[0], document.querySelectorAll('#nav-docs .nav-item')[1]);
}
await loadChat();
