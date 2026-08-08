import { api, el, mount } from './common.js';
import { renderMarkdown } from './md.js';

// Acey outside a task: the program analyst, reachable from every page.
//
// This is the SAME component as the docked panel on the task page, floated into
// a popover. It reuses that panel's markup and classes wholesale — .acey,
// .acey__head, .acey__body, .acey__status, .acey__composer, .acey__intro,
// .acey__suggest, .chat-msg, .bubble, .msg-who — and the launcher is the
// existing .acey-fab mascot. Only the shell is new (.acey--pop), plus the SQL
// disclosure, which the task copilot has no equivalent of.
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

  const fab = el('button', {
    class: 'acey-fab', id: 'acey-fab', type: 'button',
    title: 'Ask Acey', 'aria-label': 'Ask Acey',
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) toggle(false); });

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
    if (!h.messages?.length) return showEmpty();
    body.classList.remove('is-empty');
    mount(body);
    // Queries replay in place, so reopening keeps the evidence beside the answer
    // it produced rather than leaving a bare number behind.
    for (const m of h.messages) {
      body.append(m.role === 'sql' ? sqlBlock(m) : turn(m.role, m.content));
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
}
