import { api, apiSSE, renderMarkdown, el, fmtTime, cap } from '/js/common.js';

const [, , bucket, taskId] = location.pathname.split('/');
const SEV_LABEL = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
document.getElementById('task-id').textContent = taskId;
const sevChip = document.getElementById('sev-chip');
sevChip.textContent = SEV_LABEL[bucket] || bucket;
sevChip.className = `chip sev-badge ${bucket}`;

const viewerEl = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
const viewerTitle = document.getElementById('viewer-title');
const trajToolbar = document.getElementById('traj-toolbar');
const trajCache = {};
let activeNav = null;

// ---------- view cache: every view keeps its DOM + scroll position ----------
// Switching between review.md, the trajectory, and files swaps live nodes in
// and out, so scroll position AND expanded/collapsed turn state persist.
const viewCache = new Map(); // key -> { node, scrollTop }
let currentViewKey = null;

// Back navigation (pinned ‹ in the viewer header, labelled with where it
// goes): each view registers how to reopen itself + a display label;
// switching views pushes the previous one onto the stack.
const viewReopeners = new Map(); // key -> { reopen: () => void, label: string }
const navStack = [];
let suppressHistory = false;
const backBtn = document.getElementById('back-btn');

function updateBackBtn() {
  const top = navStack[navStack.length - 1];
  backBtn.hidden = !top;
  if (top) backBtn.textContent = `‹ Back to ${top.label}`;
}

backBtn.addEventListener('click', () => {
  const prev = navStack.pop();
  if (!prev) return;
  suppressHistory = true;
  Promise.resolve(prev.reopen()).finally(() => { suppressHistory = false; });
  updateBackBtn();
});

function saveCurrentScroll() {
  if (currentViewKey && viewCache.has(currentViewKey)) {
    viewCache.get(currentViewKey).scrollTop = viewerEl.scrollTop;
  }
}

function mountView(key, build, { refresh = false } = {}) {
  saveCurrentScroll();
  if (currentViewKey && currentViewKey !== key && !suppressHistory && viewReopeners.has(currentViewKey)) {
    navStack.push(viewReopeners.get(currentViewKey));
    if (navStack.length > 20) navStack.shift();
  }
  updateBackBtn();
  if (refresh) viewCache.delete(key);
  let entry = viewCache.get(key);
  if (!entry) {
    entry = { node: build(), scrollTop: 0 };
    viewCache.set(key, entry);
  }
  viewerBody.replaceChildren(entry.node);
  currentViewKey = key;
  viewerEl.scrollTop = entry.scrollTop;
  return entry;
}

// ---------- global traj:// + spec:// deep-link delegation ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-traj-model]');
  if (t) {
    e.preventDefault();
    showTrajectory(t.dataset.trajModel, Number(t.dataset.trajIndex));
    return;
  }
  const s = e.target.closest('[data-spec-key]');
  if (s) {
    e.preventDefault();
    showQcSpec(s.dataset.specKey);
  }
});

// ---------- sidebar ----------
// _audit_seed.md is intentionally NOT listed here: it stays on disk and is fed
// to the copilot/docgen as grounding, but is not surfaced as a reviewer tab.
const DOCS = [
  { key: 'review', label: 'Review', file: 'review.md' },
  { key: 'remediation', label: 'Remediation', file: 'remediation.md' },
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
      el('span', {}, 'Task definition'),
      el('span', { class: 'missing' }, taskDef.missing ? 'missing' : `${taskDef.milestones.length} milestones`),
    ),
    el('button', { class: 'nav-item', onclick: (ev) => { setActive(ev.currentTarget); showQcSpec(); } },
      el('span', {}, 'QC spec'),
      el('span', { class: 'missing' }, 'V5'),
    ),
  );

  for (const d of DOCS) {
    const present = d.key === 'review' ? meta.hasReview : meta.hasRemediation;
    navDocs.append(
      el('button', { class: 'nav-item', onclick: (ev) => openDoc(d, ev.currentTarget) },
        el('span', {}, d.label),
        present ? null : el('span', { class: 'missing' }, 'generate'),
      )
    );
  }

  const navTrajs = document.getElementById('nav-trajs');
  navTrajs.replaceChildren(
    ...['model_a', 'model_b'].map((m) =>
      el('button', { class: 'traj-launch', id: `traj-launch-${m}`, onclick: () => { setActive(null); showTrajectory(m); } },
        el('span', { class: `traj-launch-name traj-${m}` }, m === 'model_a' ? 'Model A' : 'Model B'),
        el('span', { class: 'traj-launch-meta', id: `traj-meta-${m}` }, '· · ·'),
      )
    )
  );
  for (const m of ['model_a', 'model_b']) {
    loadTrajectory(m)
      .then((t) => {
        const users = t.messages.filter((x) => x.role === 'user').length;
        document.getElementById(`traj-meta-${m}`).textContent = `${t.count} msgs · ${users} prompts`;
      })
      .catch(() => { document.getElementById(`traj-meta-${m}`).textContent = 'unavailable'; });
  }

  const tree = await api(`/task/${bucket}/${taskId}/files`);
  const navFiles = document.getElementById('nav-files');
  navFiles.replaceChildren();
  const addEntries = (entries) => {
    for (const entry of entries) {
      if (entry.dir) { addEntries(entry.children); continue; }
      const name = entry.path;
      if (['review.md', 'remediation.md', '_audit_seed.md', '_chat.json', '_studio.json'].includes(name)) continue;
      if (/^trajectories\//.test(name)) continue;
      navFiles.append(
        el('button', { class: 'nav-item', title: name, onclick: (ev) => { setActive(ev.currentTarget); showFile(name); } },
          name.length > 34 ? '…' + name.slice(-33) : name)
      );
    }
  };
  addEntries(tree);
}

function setActive(node) {
  activeNav?.classList.remove('active');
  activeNav = node;
  node?.classList.add('active');
}

function findDocNav(label) {
  return [...document.querySelectorAll('#nav-docs .nav-item')].find((b) => b.textContent.includes(label)) || null;
}

function loadTrajectory(model) {
  trajCache[model] ||= api(`/task/${bucket}/${taskId}/trajectory/${model}`);
  return trajCache[model];
}

function hideTrajToolbar() {
  trajToolbar.hidden = true;
  document.getElementById('traj-launch-model_a')?.classList.remove('active');
  document.getElementById('traj-launch-model_b')?.classList.remove('active');
}

// ---------- documents ----------
async function openDoc(doc, navNode, { refresh = false } = {}) {
  setActive(navNode);
  hideTrajToolbar();
  viewerTitle.textContent = doc.file;
  viewReopeners.set(`doc:${doc.key}`, { label: doc.label, reopen: () => openDoc(doc, findDocNav(doc.label)) });
  if (refresh || !viewCache.has(`doc:${doc.key}`)) {
    let content;
    try {
      const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(doc.file)}`);
      content = el('div', { class: 'md' });
      content.innerHTML = renderMarkdown(f.text);
    } catch {
      content = el('p', { class: 'hint-line' }, `No ${doc.file} yet — generate it from the button above.`);
    }
    mountView(`doc:${doc.key}`, () => content, { refresh: true });
  } else {
    mountView(`doc:${doc.key}`, () => null);
  }
  addRegenButton(doc);
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
              openDoc(doc, activeNav, { refresh: true });
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
  hideTrajToolbar();
  viewerTitle.textContent = `task definition${taskDef.missing ? '' : ` (${taskDef.source})`}`;
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set('taskdef', { label: 'Task definition', reopen: () => { setActive(findDocNav('Task definition')); showTaskDef(); } });
  mountView('taskdef', buildTaskDefView);
}

function buildTaskDefView() {
  if (taskDef.missing) {
    return el('div', { class: 'callout info' },
      'No task definition shipped with this task (no embedded rank.json "task" object, no source_task/task.json). ',
      'Informational only per customer policy 2026-06-09 — never a finding.');
  }
  return el('div', { class: 'taskdef' },
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
      '"Locate" jumps to the closest user turn — it is navigation, not a coverage verdict.'),
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
  );
}

async function locateMilestone(model, milestone) {
  const traj = await loadTrajectory(model);
  const tokens = tokenize(milestone.prompt);
  let best = null;
  for (const m of traj.messages) {
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
  setChatCollapsed(false);
  chatText.value = `Check milestone ${m.id} ("${m.title || m.prompt.slice(0, 80)}") in both trajectories: was its intent entered by the annotator (paraphrase counts) or done proactively by the model? Cite the matching user turns with traj:// links, or quote evidence it is genuinely absent.`;
  chatText.focus();
}

// ---------- QC spec (V5 rubric) ----------
let rubricPromise = null;

async function showQcSpec(focusKey = null) {
  hideTrajToolbar();
  viewerTitle.textContent = 'QC spec — V5 rubric';
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set('qcspec', { label: 'QC spec', reopen: () => { setActive(findDocNav('QC spec')); showQcSpec(); } });
  rubricPromise ||= api('/spec/rubric');
  const { dimensions } = await rubricPromise;
  mountView('qcspec', () => buildQcSpecView(dimensions));
  if (focusKey) {
    setActive(findDocNav('QC spec'));
    const node = document.getElementById(`spec-${focusKey}`);
    if (node) {
      node.scrollIntoView({ behavior: 'instant', block: 'start' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  }
}

function buildQcSpecView(dimensions) {
  if (!dimensions.length) {
    return el('div', { class: 'callout info' },
      'The QC rubric hasn\'t been uploaded yet. An admin can add it from the home page (QC rubric · Upload CSV).');
  }
  // category -> group -> [variants]; sibling failure modes share one header
  const byCategory = new Map();
  for (const d of dimensions) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, new Map());
    const groups = byCategory.get(d.category);
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  const SCORE = {
    2: { label: 'Fail', cls: 'fail' },
    3: { label: 'Non-fail', cls: 'nonfail' },
    5: { label: 'Pass', cls: 'pass' },
  };

  const card = (d, showVariant) =>
    el('div', { class: 'spec-card', id: `spec-${d.key}` },
      el('div', { class: 'spec-card-head' },
        el('span', { class: 'spec-key' }, d.key),
        showVariant ? el('span', { class: 'spec-variant' }, d.variant || d.group) : null,
      ),
      el('div', { class: 'spec-bands' },
        d.options.map((o) => {
          const s = SCORE[o.score] || { label: String(o.score), cls: '' };
          return el('div', { class: `spec-band-row ${s.cls}` },
            el('span', { class: 'spec-band-tag' }, `${o.score} · ${s.label}`),
            el('span', { class: 'spec-band-text' }, o.text),
          );
        }),
      ),
    );

  return el('div', { class: 'qcspec' },
    el('h1', {}, 'QC spec'),
    el('p', { class: 'hint-line' },
      `V5 rubric · ${dimensions.length} failure modes across ${byCategory.size} categories. `,
      'Cited as R-keys throughout reviews, remediations, and the copilot — click any citation to land on its card.'),
    ...[...byCategory.entries()].flatMap(([category, groups]) => [
      el('h2', { class: 'spec-cat' }, category),
      [...groups.entries()].map(([group, dims]) => {
        const desc = dims.find((d) => d.description)?.description || '';
        const multi = dims.length > 1;
        return el('section', { class: 'spec-group' },
          el('div', { class: 'spec-group-head' },
            el('h3', {}, group),
            !multi && dims[0].variant ? el('span', { class: 'spec-group-variant' }, dims[0].variant) : null,
          ),
          desc ? el('p', { class: 'spec-group-desc' }, desc) : null,
          el('div', { class: 'spec-grid' }, dims.map((d) => card(d, multi))),
        );
      }),
    ]),
  );
}

// ---------- trajectory viewer (prompt-grouped, matching trajectory-viewer-v2) ----------
const TOOL_COLORS = {
  bash: 'blue', read: 'green', edit: 'amber', apply_patch: 'orange',
  write: 'cyan', grep: 'purple', glob: 'purple', task: 'stone', agent: 'pink', question: 'pink',
};

function groupTurns(messages) {
  const groups = [];
  let cur = null;
  for (const m of messages) {
    if (m.role === 'user') {
      cur = { user: m, assistants: [] };
      groups.push(cur);
    } else if (cur) {
      cur.assistants.push(m);
    } else {
      cur = { user: null, assistants: [m] };
      groups.push(cur);
    }
  }
  return groups;
}

function userText(m) {
  return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

async function showTrajectory(model, focusIndex = null) {
  setActive(null); // single highlight: the launcher below is the only active marker
  viewerTitle.textContent = `Trajectory viewer — trajectory_${model}.json`;
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set(`traj:${model}`, {
    label: model === 'model_a' ? 'Model A' : 'Model B',
    reopen: () => showTrajectory(model),
  });
  const traj = await loadTrajectory(model);

  document.getElementById('traj-launch-model_a')?.classList.toggle('active', model === 'model_a');
  document.getElementById('traj-launch-model_b')?.classList.toggle('active', model === 'model_b');
  trajToolbar.hidden = false;
  document.getElementById('traj-tabs').replaceChildren(
    ...['model_a', 'model_b'].map((m) =>
      el('button', {
        class: `traj-tab traj-${m} ${m === model ? 'active' : ''}`,
        onclick: () => showTrajectory(m),
      }, m === 'model_a' ? 'Model A' : 'Model B')
    )
  );

  mountView(`traj:${model}`, () =>
    el('div', { class: 'convo' }, ...groupTurns(traj.messages).map((g, gi) => renderTurnGroup(model, g, gi)))
  );

  // An explicit citation jump overrides the remembered scroll position.
  if (focusIndex != null) {
    const node = document.getElementById(`msg-${model}-${focusIndex}`);
    if (node) {
      node.closest('.turn-body')?.classList.add('open');
      node.closest('.turn-group')?.querySelector('.turn-header .arrow')?.classList.add('open');
      node.scrollIntoView({ behavior: 'instant', block: 'start' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  }
}

function renderTurnGroup(model, g, gi) {
  const preview = g.user ? userText(g.user).slice(0, 130) : '(assistant continues)';
  const body = el('div', { class: 'turn-body open' });

  if (g.user) {
    body.append(
      el('div', { class: 'msg-user', id: `msg-${model}-${g.user.index}` },
        el('div', { class: 'msg-user-label' },
          'User',
          el('span', { class: 'msg-idx' }, ` · ${model}[${g.user.index}] · ${fmtTime(g.user.created)}`),
          copyLinkBtn(model, g.user.index),
        ),
        el('div', { class: 'msg-user-text' }, userText(g.user)),
      )
    );
  }
  for (const a of g.assistants) {
    const blocks = [];
    for (const p of a.parts) {
      if (p.type === 'text' && p.text.trim()) blocks.push(el('div', { class: 'asst-text' }, p.text));
      else if (p.type === 'reasoning' && p.text.trim()) blocks.push(el('div', { class: 'asst-text reasoning' }, p.text));
      else if (p.type === 'tool') blocks.push(renderToolBlock(p));
    }
    if (!blocks.length) blocks.push(el('div', { class: 'empty-resp' }, '(no response content)'));
    body.append(
      el('div', { class: 'msg-asst', id: `msg-${model}-${a.index}` },
        el('div', { class: 'step-header' },
          'Assistant',
          el('span', { class: 'msg-idx' }, ` · ${model}[${a.index}]`),
          copyLinkBtn(model, a.index),
        ),
        blocks,
      )
    );
  }

  const arrow = el('span', { class: 'arrow open' }, '▶');
  const header = el('div', {
    class: 'turn-header',
    onclick: () => {
      body.classList.toggle('open');
      arrow.classList.toggle('open');
    },
  },
    arrow,
    el('span', { class: 'turn-num' }, g.user ? `Prompt ${gi + 1}` : 'Preamble'),
    el('span', { class: 'turn-preview' }, preview),
  );
  return el('div', { class: 'turn-group' }, header, body);
}

function copyLinkBtn(model, index) {
  return el('button', {
    class: 'copy-link', title: 'copy traj:// link for use in chat/docs',
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(`traj://${model}/${index}`);
      const btn = e.currentTarget;
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'link'; }, 1200);
    },
  }, 'link');
}

function renderToolBlock(p) {
  const color = TOOL_COLORS[p.tool] || 'default';
  const body = el('div', { class: 'tool-body' },
    el('div', { class: 'codeblock' }, `${p.input}`),
    el('div', { class: 'codeblock out' }, p.output || '(no output)'),
  );
  const arrow = el('span', { class: 'arrow' }, '▶');
  return el('div', { class: `tool-block tbl-${color}` },
    el('div', {
      class: 'tool-header',
      onclick: () => { body.classList.toggle('open'); arrow.classList.toggle('open'); },
    },
      arrow,
      el('span', { class: `tool-badge tb-${color}` }, p.tool),
      el('span', { class: 'tool-title' }, p.title || ''),
      el('span', { class: 'tool-dur' }, p.status),
    ),
    body,
  );
}

let allCollapsed = false;
document.getElementById('collapse-all').addEventListener('click', (e) => {
  allCollapsed = !allCollapsed;
  viewerBody.querySelectorAll('.turn-body').forEach((b) => b.classList.toggle('open', !allCollapsed));
  viewerBody.querySelectorAll('.turn-header .arrow').forEach((a) => a.classList.toggle('open', !allCollapsed));
  e.currentTarget.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
});

// ---------- files ----------
async function showFile(relPath) {
  hideTrajToolbar();
  viewerTitle.textContent = relPath;
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set(`file:${relPath}`, {
    label: relPath.split('/').pop(),
    reopen: () => {
      setActive([...document.querySelectorAll('#nav-files .nav-item')].find((b) => b.title === relPath) || null);
      showFile(relPath);
    },
  });
  if (viewCache.has(`file:${relPath}`)) {
    mountView(`file:${relPath}`, () => null);
    return;
  }
  let content;
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(relPath)) {
    content = el('img', { class: 'proof', src: `/api/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}` });
  } else {
    const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}`);
    if (relPath.endsWith('.md')) {
      content = el('div', { class: 'md' });
      content.innerHTML = renderMarkdown(f.text);
    } else if (relPath.endsWith('.json')) {
      let pretty = f.text;
      try { pretty = JSON.stringify(JSON.parse(f.text), null, 2); } catch { /* show raw */ }
      content = el('pre', { class: 'raw' }, pretty);
    } else {
      content = el('pre', { class: 'raw' }, f.text);
    }
    if (f.truncated) content = el('div', {}, el('p', { class: 'hint-line' }, '[file clipped at 200k chars]'), content);
  }
  mountView(`file:${relPath}`, () => content);
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
  chatText.style.height = '38px';
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
// single-line input that grows only when the draft does
chatText.addEventListener('input', () => {
  chatText.style.height = '38px';
  chatText.style.height = Math.min(132, chatText.scrollHeight) + 'px';
});
document.getElementById('clear-chat').addEventListener('click', async () => {
  await api(`/task/${bucket}/${taskId}/chat`, { method: 'DELETE' });
  chatLog.replaceChildren();
});

// ---------- claim / decision / severity ----------
const moveSelect = document.getElementById('move-select');
moveSelect.value = bucket; // reflects current severity
moveSelect.addEventListener('change', async (e) => {
  const to = e.target.value;
  if (!to || to === bucket) return;
  await api(`/task/${bucket}/${taskId}/move`, { method: 'POST', body: { to } });
  location.href = `/task/${to}/${taskId}`;
});

const claimBtn = document.getElementById('claim-btn');
const claimWho = document.getElementById('claim-who');
const verdictSelect = document.getElementById('verdict-select');
let claimedBy = null;
function avatarHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

async function refreshState() {
  const s = await api(`/task/${bucket}/${taskId}/state`);
  claimedBy = s.claimed_by || null;
  const mine = s.claimed_by === me.username;
  if (!s.claimed_by) {
    claimWho.className = 'claim-who unclaimed';
    claimWho.replaceChildren(el('span', { class: 'avatar ghost' }), 'Unclaimed');
    claimBtn.hidden = false;
    claimBtn.disabled = false;
    claimBtn.textContent = 'Claim';
    claimBtn.className = 'primary';
  } else {
    claimWho.className = 'claim-who claimed';
    claimWho.replaceChildren(
      el('span', { class: 'avatar', style: `background: hsl(${avatarHue(s.claimed_by)} 52% 42%)` }, s.claimed_by[0].toUpperCase()),
      mine ? 'Claimed by you' : `Claimed by ${cap(s.claimed_by)}`,
    );
    const canRelease = mine || me.role === 'admin';
    claimBtn.hidden = !canRelease;
    claimBtn.disabled = false;
    claimBtn.textContent = 'Release';
    claimBtn.className = '';
  }
  verdictSelect.value = s.verdict || '';
}

claimBtn.addEventListener('click', async () => {
  const action = claimedBy ? 'release' : 'claim';
  try {
    await api(`/task/${bucket}/${taskId}/${action}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  refreshState();
});

// '' clears the decision; any value sets it
verdictSelect.addEventListener('change', async () => {
  await api(`/task/${bucket}/${taskId}/verdict`, {
    method: 'POST',
    body: { verdict: verdictSelect.value || null },
  });
  refreshState();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---------- resizable / collapsible chat panel ----------
const layout = document.querySelector('.task-layout');
const resizer = document.getElementById('chat-resizer');
const expandChatBtn = document.getElementById('expand-chat');
const MIN_CHAT = 300, MAX_CHAT = 720, COLLAPSE_AT = 200;

function setChatWidth(px) {
  layout.style.setProperty('--chat-w', `${Math.min(MAX_CHAT, Math.max(MIN_CHAT, px))}px`);
}
function setChatCollapsed(collapsed) {
  layout.classList.toggle('chat-collapsed', collapsed);
  expandChatBtn.hidden = !collapsed;
  localStorage.setItem('cwt_chat_collapsed', collapsed ? '1' : '');
}

const savedW = Number(localStorage.getItem('cwt_chat_w'));
if (savedW) setChatWidth(savedW);
if (localStorage.getItem('cwt_chat_collapsed')) setChatCollapsed(true);

resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  const onMove = (ev) => {
    const w = window.innerWidth - ev.clientX - 20; // 20px page padding
    if (w < COLLAPSE_AT) {
      setChatCollapsed(true);
    } else {
      setChatCollapsed(false);
      setChatWidth(w);
    }
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    const w = parseInt(layout.style.getPropertyValue('--chat-w')) || 400;
    localStorage.setItem('cwt_chat_w', String(w));
    resizer.removeEventListener('pointermove', onMove);
    resizer.removeEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onUp);
});
resizer.addEventListener('dblclick', () => setChatCollapsed(true));
document.getElementById('collapse-chat').addEventListener('click', () => setChatCollapsed(true));
expandChatBtn.addEventListener('click', () => setChatCollapsed(false));

// ---------- boot ----------
const me = await api('/me'); // 401 redirects to login
document.getElementById('user-chip').hidden = false;
document.getElementById('user-name').textContent = me.username;
await refreshState();
setInterval(refreshState, 10_000);
await buildSidebar();
const params = new URLSearchParams(location.search);
if (params.get('traj')) {
  showTrajectory(params.get('traj'), params.has('msg') ? Number(params.get('msg')) : null);
} else if (!hasReview && !taskDef.missing) {
  setActive(document.querySelector('#nav-docs .nav-item'));
  showTaskDef();
} else {
  openDoc(DOCS[0], findDocNav('Review'));
}
await loadChat();
