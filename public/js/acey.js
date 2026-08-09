import { api, el, mount } from './common.js';
import { renderMarkdown } from './md.js';

// Acey outside a task: the program analyst, reachable from every page.
//
// This is the SAME component as the docked panel on the task page, floated into
// a popover. It reuses that panel's markup and classes wholesale — .acey,
// .acey__head, .acey__body, .acey__status, .acey__composer, .acey__intro,
// .acey__suggest, .chat-msg, .bubble, .msg-who — and the launcher is the
// .acey-fab mascot, fixed bottom-right on EVERY page, task page included. Only
// the shell is new (.acey--pop), plus the SQL disclosure, which the task
// copilot has no equivalent of.
//
// The first version invented a parallel design: its own pill launcher with a
// blue "A" monogram, its own message blocks, its own composer. It also named its
// launcher .acey-fab, colliding with the mascot button — it overrode height and
// padding but not width, so the button stayed 52px wide and "Ask Acey" wrapped
// onto two lines inside it. Both problems have the same root: building a second
// design language for a component that already had one.
//
// What is genuinely different here is the SQL. Acey writes queries on this
// surface, so every one it runs is shown in the transcript — a number without
// its query is an assertion.

const LS_OPEN = 'acey.open';
const MASCOT = '/copilot.png';

export function mountAcey({ page } = {}) {
  if (document.getElementById('acey-pop')) return;

  const body = el('div', { class: 'acey__body is-empty' });
  const status = el('div', { class: 'acey__status' });
  const text = el('textarea', { placeholder: 'Ask about the pipeline, quality, cost, people…' });
  const sendBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Send');

  // The launcher is the round mascot, fixed bottom-right — the SAME access
  // point on every page, task page included (user decision 2026-08-08, after a
  // one-day experiment with a header pill proved the two-places version
  // confusing). It hides while the panel is open, because the panel occupies
  // its corner; ⌘K/Ctrl+K and the panel's ✕ are the other half of the toggle.
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
  const fab = el('button', {
    class: 'acey-fab', id: 'acey-fab', type: 'button',
    title: `Ask Acey (${isMac ? '\u2318' : 'Ctrl+'}K)`, 'aria-label': 'Ask Acey',
  }, el('img', { src: MASCOT, alt: '' }));

  const panel = el('aside', { class: 'acey acey--pop', id: 'acey-pop', hidden: true },
    el('div', { class: 'acey__head' },
      el('img', { src: MASCOT, alt: '' }),
      el('b', {}, 'Acey'),
      el('span', { class: 'acey__scope' }, page || 'program'),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn--ghost acey__clear', type: 'button',
        onclick: async () => { await api('/acey/history', { method: 'DELETE' }).catch(() => {}); showEmpty(); },
      }, 'Clear'),
      el('button', {
        class: 'btn btn--ghost acey__hide', type: 'button', title: 'hide Acey', 'aria-label': 'Hide Acey',
        onclick: () => toggle(false),
      }, '✕')),
    body,
    status,
    el('div', { class: 'acey__composer' }, text, sendBtn));

  document.body.append(panel, fab);

  let busy = false;

  fab.addEventListener('click', () => toggle(true));
  sendBtn.addEventListener('click', () => send());
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  text.addEventListener('input', grow);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) return toggle(false);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle(panel.hidden);
    }
  });

  // The composer textarea is a fixed 34px in the docked panel; here it grows with
  // the question, since program questions run longer than "is this a hard fail".
  function grow() {
    text.style.height = '34px';
    text.style.height = `${Math.min(120, text.scrollHeight)}px`;
  }

  function toggle(open) {
    panel.hidden = !open;
    fab.hidden = open;
    try { localStorage.setItem(LS_OPEN, open ? '1' : '0'); } catch { /* private mode */ }
    if (open) {
      text.focus();
      if (!body.childElementCount) restore();
    }
  }

  async function restore() {
    const h = await api('/acey/history').catch(() => ({ messages: [] }));
    // A question can arrive while this fetch is in flight — ask() injects and
    // sends immediately on open. A live conversation always beats the replay:
    // wiping it with the empty state was a race that ate the injected turn.
    if (body.querySelector('.chat-msg')) return;
    if (!h.messages?.length) return showEmpty();
    body.classList.remove('is-empty');
    mount(body);
    // Queries replay in place, so reopening keeps the evidence beside the answer
    // it produced rather than leaving a bare number behind. Action offers replay
    // too — the owner detection runs server-side on the stored transcript.
    let lastQ = '';
    for (const m of h.messages) {
      if (m.role === 'user') lastQ = m.content;
      body.append(m.role === 'sql' ? sqlBlock(m) : turn(m.role, m.content));
      if (m.role === 'assistant' && m.owners?.length) body.append(actionRow(m.owners, lastQ, m.content));
    }
    scroll();
  }

  async function showEmpty() {
    const { suggestions } = await api('/acey/suggestions').catch(() => ({ suggestions: [] }));
    body.classList.add('is-empty');
    mount(body,
      el('p', { class: 'acey__intro' },
        'Ask about the program — pipeline, quality, cost, people. If no saved query answers it, '
        + 'I write one and show you the SQL.'),
      el('div', { class: 'acey__suggest' }, ...(suggestions || []).map((s) => {
        const b = el('button', { type: 'button' }, s);
        b.addEventListener('click', () => { text.value = s; grow(); send(); });
        return b;
      })));
  }

  // Same stamp as the task panel: the mascot and a name label, so the column
  // reads as someone answering rather than as log output.
  function stamp() {
    return el('div', { class: 'msg-who' },
      el('img', { class: 'msg-avatar', src: MASCOT, alt: '' }),
      el('span', {}, 'Acey'));
  }

  function turn(role, content) {
    const bubble = role === 'assistant'
      ? el('div', { class: 'bubble md' }, ...renderMarkdown(content))
      : el('div', { class: 'bubble' }, content);
    return el('div', { class: `chat-msg ${role}` },
      role === 'user' ? el('div', { class: 'who' }, 'you') : stamp(),
      bubble);
  }

  const scroll = () => { body.scrollTop = body.scrollHeight; };

  function setStatus(label) {
    mount(status, label ? el('span', {}, el('i', { class: 'acey__dot' }), label) : null);
  }

  async function send() {
    const q = text.value.trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    text.value = '';
    grow();
    if (body.classList.contains('is-empty')) { body.classList.remove('is-empty'); mount(body); }
    body.append(turn('user', q));
    setStatus('thinking');
    scroll();

    let answer = null;
    let owners = [];
    try {
      await stream(q, (e) => {
        if (e.type === 'tool') {
          if (e.name !== 'run_sql') setStatus(TOOL_LABEL[e.name] || e.name);
        } else if (e.type === 'sql') {
          body.append(sqlBlock(e));
          setStatus('running the query');
        } else if (e.type === 'assistant' && e.final) {
          answer = e.content;
        } else if (e.type === 'assistant') {
          setStatus(e.content.replace(/\s+/g, ' ').slice(0, 64));
        } else if (e.type === 'actions') {
          owners = e.owners || [];
        } else if (e.type === 'truncated') {
          answer = `${answer || ''}\n\n_Stopped at the step limit — ask again to continue._`;
        } else if (e.type === 'error') {
          answer = `**Something went wrong.** ${e.message}`;
        }
        scroll();
      });
    } catch (e) {
      answer = `**Something went wrong.** ${e.message}`;
    }

    setStatus('');
    body.append(turn('assistant', answer || 'No answer came back.'));
    if (answer && owners.length) body.append(actionRow(owners, q, answer));
    scroll();
    busy = false;
    sendBtn.disabled = false;
    text.focus();
  }

  const TOOL_LABEL = {
    list_queries: 'checking the query library',
    read_query: 'reading an existing query',
    redash_query: 'running a saved query',
  };

  // The answer named an owner, so offer to put it on their queue.
  //
  // Three-step flow, one party per step: the model ROUTES (these buttons exist
  // because the answer named someone), the model DRAFTS (clicking an offer
  // fetches a title/detail the human can read), and the human AUTHORIZES —
  // nothing lands on a teammate's queue until they have seen the exact wording,
  // edited it if they want, and pressed Add. The first version created the todo
  // straight from the click, sight unseen, which is how junk lands on boards.
  let ROSTER = null;
  const roster = async () => {
    if (!ROSTER) ROSTER = (await api('/team/roster').catch(() => ({ team: [] }))).team || [];
    return ROSTER;
  };

  function actionRow(owners, question, answer) {
    const row = el('div', { class: 'acey__actions' });

    const offers = () => mount(row, ...owners.map((o) => {
      const btn = el('button', { class: 'btn btn--ghost', type: 'button' }, `Add as action item · ${o.name}`);
      btn.addEventListener('click', () => openDraft(o));
      return btn;
    }));

    async function openDraft(o) {
      mount(row, el('div', { class: 'acey-draft acey-draft--busy' },
        el('span', { class: 'acey__dot' }), ` Acey is drafting an item for ${o.name}…`));
      const [team, r] = await Promise.all([
        roster(),
        api('/acey/action/draft', { method: 'POST', body: { owner: o.username, question, answer } })
          .catch((e) => ({ error: e.message })),
      ]);
      if (r.error) {
        mount(row, el('span', { class: 'acey__action-err' }, `Draft failed — ${r.error}. `));
        return setTimeout(offers, 1800);
      }
      form(o, team, r.draft);
    }

    // The draft renders as the CARD it will become — title-weight title, muted
    // detail — with the text quietly editable in place (dashed underline on
    // hover, accent on focus), not as a form with framed fields. Spellcheck is
    // off: contributor handles and metric strings light up as errors otherwise.
    function form(o, team, d) {
      const title = el('input', {
        class: 'acey-draft__title', maxlength: '140', value: d.title,
        spellcheck: 'false', 'aria-label': 'Title',
      });
      const detail = el('textarea', {
        class: 'acey-draft__detail', maxlength: '600',
        spellcheck: 'false', 'aria-label': 'Detail',
      }, d.detail);
      const grow = () => {
        detail.style.height = 'auto';
        detail.style.height = `${Math.min(170, detail.scrollHeight)}px`;
      };
      detail.addEventListener('input', grow);
      requestAnimationFrame(grow);

      const owner = el('select', { class: 'select', 'aria-label': 'Owner' },
        ...(team.length ? team : [{ username: o.username, name: o.name }]).map((t) =>
          el('option', { value: t.username, ...(t.username === o.username ? { selected: true } : {}) }, t.name)));
      const sev = el('select', { class: 'select', 'aria-label': 'Severity' },
        ...['medium', 'high', 'critical'].map((x) =>
          el('option', { value: x, ...(x === d.severity ? { selected: true } : {}) }, x[0].toUpperCase() + x.slice(1))));

      const add = el('button', { class: 'btn btn--primary', type: 'button' }, 'Add to board');
      add.addEventListener('click', async () => {
        add.disabled = true;
        add.textContent = 'Adding…';
        try {
          const { todo } = await api('/acey/action', {
            method: 'POST',
            body: { owner: owner.value, title: title.value, detail: detail.value, severity: sev.value },
          });
          success(todo, owner.selectedOptions[0].textContent.split(' ')[0]);
        } catch (e) {
          add.disabled = false;
          add.textContent = 'Add to board';
          alert(e.message);
        }
      });

      mount(row, el('div', { class: 'acey-draft' },
        el('div', { class: 'acey-draft__meta' },
          el('span', { class: 'acey-draft__tag' }, 'Draft'),
          owner, sev,
          el('span', { class: 'acey-draft__hint' }, 'Edit anything — nothing lands until you add it')),
        title,
        detail,
        el('div', { class: 'acey-draft__foot' },
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: offers }, 'Cancel'),
          add)));
      title.focus();
    }

    // The confirmation keeps an exit: Undo deletes the todo (manual items are
    // deletable) and puts the offers back, so a misfire costs two clicks.
    function success(todo, name) {
      const undo = el('button', { class: 'acey-linkbtn', type: 'button' }, 'Undo');
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try { await api(`/team/todos/${todo.id}`, { method: 'DELETE' }); offers(); }
        catch (e) { undo.disabled = false; alert(e.message); }
      });
      mount(row, el('div', { class: 'acey__action-done' },
        `✓ Added to ${name}'s queue — `,
        el('a', { href: `${window.__base__ || ''}/team.html#${todo.id}`, title: todo.title },
          todo.title.length > 56 ? `${todo.title.slice(0, 56)}…` : todo.title),
        ' · ', undo));
    }

    offers();
    return row;
  }

  function sqlBlock(e) {
    const copy = el('button', { class: 'acey__sql-copy', type: 'button' }, 'Copy');
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(e.sql);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    });
    return el('details', { class: 'acey__sql' },
      el('summary', {},
        el('span', { class: 'acey__sql-tag' }, 'SQL'),
        el('span', { class: 'acey__sql-why' }, e.purpose || 'query')),
      el('pre', {}, e.sql),
      el('div', { class: 'acey__sql-foot' }, copy));
  }

  // Manual SSE read: EventSource cannot POST, and the question goes in a body.
  async function stream(message, onEvent) {
    const base = window.__base__ || '';
    const res = await fetch(`${base}/api/acey/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const c of chunks) {
        const line = c.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* partial frame */ }
      }
    }
  }

  try { if (localStorage.getItem(LS_OPEN) === '1') toggle(true); } catch { /* private mode */ }

  // Other surfaces hand Acey a question: the Team board's "Ask Acey" evidence
  // fallback opens the panel and sends it, so the answer arrives already in
  // conversation instead of the user re-typing the card into the composer.
  const ask = (q) => {
    toggle(true);
    text.value = String(q || '');
    grow();
    send();
  };
  window.__acey = { ask, open: () => toggle(true) };
  return window.__acey;
}
