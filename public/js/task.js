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

async function buildSidebar() {
  const meta = await api(`/task/${bucket}/${taskId}`);
  const navDocs = document.getElementById('nav-docs');
  navDocs.replaceChildren();
  for (const d of DOCS) {
    const present = d.key === 'review' ? meta.hasReview : d.key === 'remediation' ? meta.hasRemediation : meta.hasAuditSeed;
    navDocs.append(
      el('button', { class: 'nav-item', onclick: (ev) => openDoc(d, ev.currentTarget) },
        d.label,
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
      if (['review.md', 'remediation.md', '_audit_seed.md', '_chat.json'].includes(name)) continue;
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

// ---------- boot ----------
await buildSidebar();
const params = new URLSearchParams(location.search);
if (params.get('traj')) {
  showTrajectory(params.get('traj'), params.has('msg') ? Number(params.get('msg')) : null);
} else {
  openDoc(DOCS[0], document.querySelector('#nav-docs .nav-item'));
}
await loadChat();
