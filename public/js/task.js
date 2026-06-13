import { api, apiSSE, renderMarkdown, el, fmtTime, cap } from '/js/common.js';

const [, , bucket, taskId] = location.pathname.split('/');
const SEV_LABEL = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
document.getElementById('task-id').textContent = taskId;
const sevChip = document.getElementById('sev-chip');
sevChip.textContent = (SEV_LABEL[bucket] || bucket) + ' ▾';
sevChip.className = `sev-badge-btn ${bucket}`;

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
  navDocs.append(
    el('button', { class: 'nav-item', onclick: (ev) => { setActive(ev.currentTarget); showChecklist(); } },
      el('span', {}, 'Checklist'),
    )
  );

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
async function showTaskDef() {
  hideTrajToolbar();
  viewerTitle.textContent = `task definition${taskDef.missing ? '' : ` (${taskDef.source})`}`;
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set('taskdef', { label: 'Task definition', reopen: () => { setActive(findDocNav('Task definition')); showTaskDef(); } });
  const presence = taskDef.missing || !taskDef.milestones.length ? null : await milestonePresence();
  mountView('taskdef', () => buildTaskDefView(presence), { refresh: true });
}

// Per-milestone string-match presence in each model's user turns. Reuses the
// token-overlap scorer the Locate buttons use; deliberately rough (a literal
// string check that misses paraphrases — hence the caveat in the UI).
async function milestonePresence() {
  const turns = {};
  for (const m of ['model_a', 'model_b']) {
    try {
      const t = await loadTrajectory(m);
      turns[m] = t.messages.filter((x) => x.role === 'user')
        .map((x) => x.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' '));
    } catch { turns[m] = null; } // missing/stub trajectory
  }
  const out = {};
  for (const ms of taskDef.milestones) {
    const toks = tokenize(ms.prompt);
    out[ms.id] = {};
    for (const m of ['model_a', 'model_b']) {
      if (turns[m] == null) { out[ms.id][m] = null; continue; }
      out[ms.id][m] = turns[m].some((tx) => score(toks, tokenize(tx)) >= 0.5);
    }
  }
  return out;
}

// One worded status chip summarizing presence across both trajectories.
function presenceChip(a, b) {
  if (a == null && b == null) return el('span', { class: 'pres-chip unknown', title: 'no trajectory to check' }, 'No trajectory');
  if (a && b) return el('span', { class: 'pres-chip yes', title: 'string-matched in both A and B' }, 'Found in A & B');
  if (!a && !b) return el('span', { class: 'pres-chip no', title: 'no string match in A or B' }, 'Not found');
  return el('span', { class: 'pres-chip partial', title: 'string-matched in only one side' }, a ? 'In A only' : 'In B only');
}

function buildTaskDefView(presence) {
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
    el('h2', {}, `Milestones (${taskDef.milestones.length})`),
    el('p', { class: 'hint-line' },
      'The annotator must enter each milestone prompt (paraphrase counts) in order, in both trajectories. ',
      'Present / not-present is a rough string match against the user turns (A and B) — it can miss paraphrases, so if a milestone reads "not found" but you believe it is there, ask the copilot to confirm. ',
      '"Locate" jumps to the closest user turn — navigation, not a coverage verdict.'),
    taskDef.milestones.map((m, i) =>
      el('div', { class: 'milestone' },
        el('div', { class: 'milestone-head' },
          el('span', { class: 'chip milestone-id' }, m.id),
          el('span', { class: 'milestone-title' }, m.title || `Milestone ${i + 1}`),
          el('span', { class: 'spacer' }),
          presence ? presenceChip(presence[m.id]?.model_a, presence[m.id]?.model_b) : null,
          el('button', { onclick: () => locateMilestone('model_a', m) }, 'Locate in A'),
          el('button', { onclick: () => locateMilestone('model_b', m) }, 'Locate in B'),
          el('button', { onclick: () => askCopilotAboutMilestone(m) }, 'Ask copilot'),
        ),
        el('div', { class: 'milestone-prompt' }, m.prompt),
      )
    ),
    taskDef.user_persona
      ? [el('h2', {}, 'User persona'), el('div', { class: 'callout' }, taskDef.user_persona)]
      : null,
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

// ---------- checklist (adjudicate review findings → decision) ----------
const CHECK_VERDS = [
  ['NO_ISSUES', 'No Issues'],
  ['FIXES_MADE', 'Fixes made'],
  ['SBQ', 'SBQ'],
  ['SECOND_OPINION', 'Second Opinion Needed'],
];

function parseFindings(md) {
  const out = [];
  const re = /^###\s*\[(HARD|SOFT|INFO)\]\s*(F\d+)\s*[—–-]+\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(md))) out.push({ sev: m[1], id: m[2], title: m[3] });
  return out;
}

// Jump from a checklist row to its finding in the Review doc.
async function gotoFinding(fid) {
  const reviewDoc = DOCS.find((d) => d.key === 'review');
  await openDoc(reviewDoc, findDocNav('Review'));
  setTimeout(() => {
    const node = document.getElementById(`finding-${fid}`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  }, 60);
}

async function showChecklist() {
  hideTrajToolbar();
  viewerTitle.textContent = 'Checklist';
  document.querySelector('.viewer-head .regen')?.remove();
  viewReopeners.set('checklist', { label: 'Checklist', reopen: () => { setActive(findDocNav('Checklist')); showChecklist(); } });
  let reviewText = '';
  try { reviewText = (await api(`/task/${bucket}/${taskId}/file?path=review.md`)).text; } catch { /* no review yet */ }
  const state = await api(`/task/${bucket}/${taskId}/state`);
  mountView('checklist', () => buildChecklistView(parseFindings(reviewText), state.checklist || {}, state.verdict), { refresh: true });
}

function buildChecklistView(findings, checks, verdict) {
  const container = el('div', { class: 'checklist' });
  container.append(el('h1', {}, 'Checklist'));
  if (!findings.length) {
    container.append(el('p', { class: 'hint-line' },
      'No findings yet — generate the Review and its findings will populate this checklist.'));
    return container;
  }
  container.append(el('p', { class: 'hint-line' },
    'Adjudicate each review finding — mark it Done (fixed / verified) or Over-flag (not a real issue) — then record the decision below.'));

  const local = { ...checks };
  const statusOf = (id) => local[id]?.status || 'open';
  const summary = el('div', { class: 'check-summary' });
  const suggestion = el('div', { class: 'check-suggestion' });

  function recompute() {
    const c = { open: 0, done: 0, overflag: 0, hardOpen: 0 };
    for (const f of findings) {
      const s = statusOf(f.id);
      c[s]++;
      if (s === 'open' && f.sev === 'HARD') c.hardOpen++;
    }
    summary.replaceChildren(
      el('span', {}, `${findings.length} findings`), sep(),
      el('span', { class: 'c-done' }, `${c.done} done`), sep(),
      el('span', { class: 'c-overflag' }, `${c.overflag} over-flagged`), sep(),
      el('span', { class: c.open ? 'c-open' : '' }, `${c.open} open`),
    );
    suggestion.textContent =
      c.open === 0
        ? (c.overflag === findings.length ? 'Everything over-flagged → likely No Issues.' : 'All findings addressed → likely Fixes made or No Issues.')
        : c.hardOpen
          ? `${c.hardOpen} HARD finding(s) still open → likely SBQ, or send for a second opinion.`
          : `${c.open} finding(s) still open.`;
  }
  const sep = () => el('span', { class: 'dot-sep' }, '·');

  async function onSet(id, status) {
    await api(`/task/${bucket}/${taskId}/checklist`, { method: 'POST', body: { key: id, status } });
    if (status) local[id] = { status }; else delete local[id];
    recompute();
  }

  const list = el('div', { class: 'check-list' });
  for (const f of findings) list.append(checkRow(f, statusOf, onSet));
  container.append(list);

  const verdictBtns = CHECK_VERDS.map(([k, label]) =>
    el('button', {
      class: `vbtn v-${k}${verdict === k ? ' active' : ''}`, 'data-v': k,
      onclick: async () => {
        await api(`/task/${bucket}/${taskId}/verdict`, { method: 'POST', body: { verdict: k } });
        verdictSelect.value = k;
        verdictSelect.className = `verdict-select set v-${k}`;
        refreshState();
        container.querySelectorAll('.check-verdicts .vbtn').forEach((b) => b.classList.toggle('active', b.dataset.v === k));
      },
    }, label)
  );
  container.append(
    el('div', { class: 'check-panel' },
      el('h2', {}, 'Decision'),
      summary,
      el('p', { class: 'check-suggestion-wrap' }, suggestion),
      el('div', { class: 'check-verdicts' }, ...verdictBtns),
    )
  );
  recompute();
  return container;
}

function checkRow(f, statusOf, onSet) {
  const row = el('div', {},
    el('span', { class: `sev sev-${f.sev}` }, f.sev),
    el('button', { class: 'check-title', title: 'view this finding in the Review', onclick: () => gotoFinding(f.id) }, `${f.id} — ${f.title}`),
    el('span', { class: 'check-actions' }),
  );
  const actions = row.querySelector('.check-actions');
  const apply = () => {
    const s = statusOf(f.id);
    row.className = `check-row s-${s}`;
    actions.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === s));
  };
  for (const [s, label] of [['done', '✓ Done'], ['overflag', '⚑ Over-flag']]) {
    actions.append(el('button', {
      'data-s': s,
      onclick: async () => { await onSet(f.id, statusOf(f.id) === s ? '' : s); apply(); },
    }, label));
  }
  apply();
  return row;
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
  if (focusIndex != null) jumpToMessage(model, focusIndex);
}

function jumpToMessage(model, index) {
  const node = document.getElementById(`msg-${model}-${index}`);
  if (!node) return;
  node.closest('.turn-body')?.classList.add('open');
  node.closest('.turn-group')?.querySelector('.turn-header .arrow')?.classList.add('open');
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2500);
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
// Severity reclassify lives on the badge itself (click → small menu), so the
// header stays uncluttered.
sevChip.addEventListener('click', () => {
  const r = sevChip.getBoundingClientRect();
  const SEVS = [['HARD_FAIL', 'Hard'], ['SOFT_FAIL', 'Soft'], ['PASS', 'Pass'], ['UNSORTED', 'Unsorted']];
  const menu = el('div', { class: 'pop-menu glass' },
    el('div', { class: 'pop-menu-title' }, 'Severity'),
    ...SEVS.map(([k, label]) =>
      el('button', {
        class: k === bucket ? 'current' : '',
        onclick: async () => {
          menu.remove();
          if (k === bucket) return;
          await api(`/task/${bucket}/${taskId}/move`, { method: 'POST', body: { to: k } });
          location.href = `/task/${k}/${taskId}`;
        },
      }, label + (k === bucket ? '  ✓' : '')),
    ),
  );
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  document.body.append(menu);
  const away = (e) => { if (!menu.contains(e.target) && e.target !== sevChip) { menu.remove(); document.removeEventListener('mousedown', away); } };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
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
  verdictSelect.className = 'verdict-select' + (s.verdict ? ` set v-${s.verdict}` : '');
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
