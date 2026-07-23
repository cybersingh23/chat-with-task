// Shared helpers: API calls, SSE consumption, markdown with traj:// deep links.

// Liquid-glass refraction: an SVG turbulence+displacement filter referenced by
// backdrop-filter on .glass panels. Chrome renders the refraction; Safari/FF
// fall back to the plain blur (they ignore url() filters in backdrop-filter).
// Injected once per page; only distorts the blurred backdrop, never the panel's
// own content, so text stays crisp.
(function injectGlassFilter() {
  if (typeof document === 'undefined' || document.getElementById('cwt-glass-svg')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'cwt-glass-svg';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  svg.innerHTML =
    '<filter id="liquid-glass" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="2" seed="7" result="n"/>' +
    '<feGaussianBlur in="n" stdDeviation="1.2" result="nb"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="nb" scale="22" xChannelSelector="R" yChannelSelector="G"/>' +
    '</filter>';
  (document.body || document.documentElement).appendChild(svg);
})();

export async function api(path, opts = {}) {
  const base = window.__base__ || '';
  const res = await fetch(`${base}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
    location.href = `${base}/login.html`;
    throw new Error('login required');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// POST that returns SSE; calls onEvent for each data: line.
export async function apiSSE(path, body, onEvent) {
  const res = await fetch(`${window.__base__ || ''}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// rank.json field paths the CB-responses locator understands, as written in
// docs/copilot text (leading slash, e.g. /ranking_rationale or
// /results/blue_tower/grading/correctness).
const RANK_FIELD_RE = /^\/(?:ranking_rationale|preference_rating|problem_statement|optional_clarification_comments|optional_other_comments|results\/[^/\s]+(?:\/(?:summary|rank|model_assignment|grading|failure_modes)(?:\/[^/\s]+){0,2})?)$/;

// Markdown -> sanitized HTML. traj://model_a/12 links become "Show in
// trajectory" buttons; clicks are delegated via the data-traj attributes.
export function renderMarkdown(md) {
  const renderer = new marked.Renderer();

  // Give finding headings (### [HARD] F1 — …) an id so the checklist can deep-link to them.
  const headingBase = renderer.heading;
  renderer.heading = function (textOrToken, level, raw) {
    const isToken = typeof textOrToken === 'object' && textOrToken !== null;
    const lvl = isToken ? textOrToken.depth : level;
    const rawText = isToken ? textOrToken.text : (raw || '');
    const m = lvl === 3 && /\b(F\d{1,3})\b/.exec(rawText);
    if (m) {
      const inner = isToken ? this.parser.parseInline(textOrToken.tokens) : textOrToken;
      return `<h3 id="finding-${m[1]}">${inner}</h3>\n`;
    }
    return headingBase.call(this, textOrToken, level, raw);
  };

  const linkBase = renderer.link;
  // marked v12 calls link(href, title, text); v13+ passes a token object.
  renderer.link = function (hrefOrToken, title, text) {
    const isToken = typeof hrefOrToken === 'object' && hrefOrToken !== null;
    const href = isToken ? hrefOrToken.href : hrefOrToken;
    // marked <13 (the old signature) passes `text` already HTML-escaped, so it
    // must NOT be escaped again — that double-escape is what turned "hello"
    // into &quot;hello&quot;. marked >=13 passes a token whose `.text` is raw,
    // so that branch DOES need escaping. The fallback labels are plain ASCII.
    const explicit = isToken ? hrefOrToken.text : text;
    const labelHtml = isToken ? escapeHtml(hrefOrToken.text || '') : text;
    const hasLabel = explicit && explicit !== href;
    // traj://model_a/12  — jump to a message; optional ?q=<phrase> highlights an
    // exact word/phrase inside that message instead of flashing the whole block.
    const m = /^traj:\/\/(model_[ab])\/(\d+)(?:\?q=(.*))?$/.exec(href || '');
    if (m) {
      const phrase = m[3] ? decodeURIComponent(m[3]) : '';
      const shown = hasLabel ? labelHtml : `${m[1]}[${m[2]}]`;
      const pAttr = phrase ? ` data-traj-phrase="${escapeHtml(phrase)}"` : '';
      return `<a class="traj-link" href="#" data-traj-model="${m[1]}" data-traj-index="${m[2]}"${pAttr}>${shown} </a>`;
    }
    // cb://model_a?q=<phrase>  — point at a word/phrase in a model's responses
    // without a known message index; the phrase is searched across that model's
    // response text and highlighted where found.
    const c = /^cb:\/\/(model_[ab])(?:\?q=(.*))?$/.exec(href || '');
    if (c) {
      const phrase = c[2] ? decodeURIComponent(c[2]) : '';
      const shown = hasLabel ? labelHtml : `${c[1] === 'model_a' ? 'Model A' : 'Model B'} responses`;
      const pAttr = phrase ? ` data-cb-phrase="${escapeHtml(phrase)}"` : '';
      return `<a class="cb-link" href="#" data-cb-model="${c[1]}"${pAttr}>${shown}</a>`;
    }
    const s = /^spec:\/\/(R\d{1,2})$/.exec(href || '');
    if (s) {
      const shown = hasLabel ? labelHtml : escapeHtml(s[1]);
      return `<a class="spec-link" href="#" data-spec-key="${s[1]}">${shown}</a>`;
    }
    return linkBase.call(this, hrefOrToken, title, text);
  };

  // ```alerts fences -> big glaring-issue banner ("NONE" suppresses it).
  const codeBase = renderer.code;
  renderer.code = function (codeOrToken, infostring, escaped) {
    const isToken = typeof codeOrToken === 'object' && codeOrToken !== null;
    const lang = (isToken ? codeOrToken.lang : infostring) || '';
    const body = isToken ? codeOrToken.text : codeOrToken;
    if (lang.trim() === 'autoqc') {
      const lines = String(body).split('\n').map((l) => l.trim()).filter((l) => l && l.toUpperCase() !== 'NONE');
      if (!lines.length) return '';
      const items = lines.map((line) => {
        const m = /^(R\d{1,2})\s*[—–\-:·]\s*(.+)$/.exec(line);
        if (m) {
          return `<div class="autoqc-item"><a class="spec-link" href="#" data-spec-key="${m[1]}">${m[1]}</a><span class="autoqc-text">${escapeHtml(m[2])}</span></div>`;
        }
        return `<div class="autoqc-item"><span class="autoqc-text">${escapeHtml(line)}</span></div>`;
      });
      return `<div class="autoqc-panel"><div class="autoqc-head">Auto-QC read · ${lines.length} flagged</div>${items.join('')}</div>`;
    }
    if (lang.trim() === 'alerts') {
      const lines = String(body).split('\n').map((l) => l.trim()).filter((l) => l && l.toUpperCase() !== 'NONE');
      if (!lines.length) return '';
      const items = lines.map((line) => {
        const l = sentenceCaseIfShouting(line);
        const dash = l.indexOf(' — ');
        const title = dash === -1 ? l : l.slice(0, dash);
        const detail = dash === -1 ? '' : l.slice(dash + 3);
        return `<div class="alert-item"><div class="alert-title">${escapeHtml(title)}</div>${
          detail ? `<div class="alert-detail">${escapeHtml(detail)}</div>` : ''
        }</div>`;
      });
      return `<div class="alert-banner"><div class="alert-head">Critical issues</div>${items.join('')}</div>`;
    }
    return codeBase.call(this, codeOrToken, infostring, escaped);
  };

  // Inline `/rank.json field paths` -> clickable chips that jump to that field
  // in the CB responses view (parallel to traj:// / spec://). Field paths carry
  // no HTML-escapable chars, so testing works whether the arg is raw or escaped.
  const codespanBase = renderer.codespan;
  renderer.codespan = function (codeOrToken, ...rest) {
    const isToken = typeof codeOrToken === 'object' && codeOrToken !== null;
    const text = String(isToken ? (codeOrToken.text || '') : codeOrToken);
    if (RANK_FIELD_RE.test(text)) {
      return `<a class="cb-field-link" href="#" data-cb-field-path="${text}">${text}</a>`;
    }
    return codespanBase.call(this, codeOrToken, ...rest);
  };

  let html = marked.parse(md, { renderer, gfm: true, breaks: false });
  // [HARD]/[SOFT]/[INFO] tags in finding headings -> severity badges.
  html = html.replace(/\[(HARD|SOFT|INFO)\]/g, (_, sev) => `<span class="sev sev-${sev}">${sev}</span>`);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-traj-model', 'data-traj-index', 'data-traj-phrase', 'data-cb-model', 'data-cb-phrase', 'data-cb-field-path', 'data-spec-key', 'id'] });
}

// Legacy docs shipped all-caps alert lines; tame them to sentence case.
function sentenceCaseIfShouting(line) {
  const letters = line.replace(/[^a-zA-Z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.7) return line;
  const lower = line.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function fmtTime(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';
}

// ---------- guided tour ----------
// startTour([{ selector?, title, body, nextLabel?, onNext?, onShow? }]) — a
// spotlight-overlay walkthrough. Steps whose target is missing/hidden are skipped
// (e.g. admin-only controls), so one step list serves every role. A step with no
// selector is a centered card. onNext() returning true intercepts advance (used
// to navigate pages mid-tour); onShow() runs after the step renders. The tooltip
// is always clamped inside the viewport (picks below/above/right/left by room),
// so it never crops. Next/Back or ← →, Esc to exit.
export function startTour(steps, opts = {}) {
  const isVisible = (e) => e && e.offsetWidth > 0 && e.offsetHeight > 0;
  const valid = steps.filter((s) => !s.selector || isVisible(document.querySelector(s.selector)));
  if (!valid.length) return;
  document.querySelector('.tour-overlay')?.remove();

  let i = 0, poll = null, done = false, exited = false;
  const hole = el('div', { class: 'tour-hole' });
  const tip = el('div', { class: 'tour-tip glass' });
  const overlay = el('div', { class: 'tour-overlay' }, hole, tip);
  document.body.append(overlay);

  const clearPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  const cleanup = () => { clearPoll(); window.removeEventListener('resize', place); window.removeEventListener('keydown', onKey); };
  // Leaving a "try" step it wasn't completed = a logged miss.
  const logLeave = () => { const s = valid[i]; if (s && s.try && !done) opts.onLog?.({ step: s.title, action: s.try.action, success: false }); };
  const end = () => { if (exited) return; exited = true; logLeave(); cleanup(); overlay.remove(); opts.onExit?.(); };
  const advance = () => { logLeave(); clearPoll(); if (i >= valid.length - 1) return end(); i++; render(); };
  const back = () => { logLeave(); clearPoll(); if (i > 0) { i--; render(); } };
  function onKey(e) {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') advance();
    else if (e.key === 'ArrowLeft') back();
  }

  function place() {
    const s = valid[i];
    const target = s.selector ? document.querySelector(s.selector) : null;
    const margin = 12, gap = 14;
    const tipW = tip.offsetWidth || 320;
    const tipH = tip.offsetHeight || 170;
    const clampL = (x) => Math.max(margin, Math.min(x, window.innerWidth - tipW - margin));
    const clampT = (y) => Math.max(margin, Math.min(y, window.innerHeight - tipH - margin));
    tip.style.bottom = '';
    if (isVisible(target)) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = target.getBoundingClientRect();
      const pad = 6;
      hole.style.display = 'block';
      hole.style.left = `${r.left - pad}px`;
      hole.style.top = `${r.top - pad}px`;
      hole.style.width = `${r.width + pad * 2}px`;
      hole.style.height = `${r.height + pad * 2}px`;
      // pin: 'top' keeps the tip up top (e.g. so a long draggable board stays visible)
      if (s.pin === 'top') {
        tip.style.left = `${clampL(window.innerWidth / 2 - tipW / 2)}px`;
        tip.style.top = `${margin + 4}px`;
        return;
      }
      const space = { below: window.innerHeight - r.bottom, above: r.top, right: window.innerWidth - r.right, left: r.left };
      let left, top;
      if (space.below >= tipH + gap) { top = r.bottom + gap; left = r.left; }
      else if (space.above >= tipH + gap) { top = r.top - gap - tipH; left = r.left; }
      else if (space.right >= tipW + gap) { left = r.right + gap; top = r.top; }
      else if (space.left >= tipW + gap) { left = r.left - gap - tipW; top = r.top; }
      else { top = r.bottom + gap; left = r.left; } // clamped below as a last resort
      tip.style.left = `${clampL(left)}px`;
      tip.style.top = `${clampT(top)}px`;
    } else {
      hole.style.display = 'none';
      tip.style.left = `${clampL(window.innerWidth / 2 - tipW / 2)}px`;
      tip.style.top = `${clampT(window.innerHeight / 2 - tipH / 2)}px`;
    }
  }

  function render() {
    const s = valid[i];
    done = false;
    clearPoll();
    const status = s.try ? el('div', { class: 'tour-status' }, s.try.hint || 'Try it — I\'ll wait…') : null;
    const primaryBtn = el('button', {
      class: 'primary',
      onclick: () => { if (s.onNext && s.onNext() === true) return; advance(); },
    }, s.nextLabel || (i === valid.length - 1 ? 'Done' : (s.try ? 'Skip step' : 'Next')));

    tip.replaceChildren(
      el('div', { class: 'tour-step-count' }, `${i + 1} / ${valid.length}`),
      el('div', { class: 'tour-title' }, s.title),
      el('div', { class: 'tour-body' }, s.body),
      status,
      el('div', { class: 'tour-actions' },
        el('button', { class: 'tour-skip', onclick: end }, 'Skip tour'),
        el('div', { class: 'tour-nav' },
          i > 0 ? el('button', { onclick: back }, 'Back') : null,
          primaryBtn,
        ),
      ),
    );
    place(); // measure + position after content is in the DOM
    if (s.onShow) s.onShow();

    // interactive "try" step: poll until the user completes the action
    if (s.try) {
      let busy = false;
      poll = setInterval(async () => {
        if (busy || done) return;
        busy = true;
        let ok = false;
        try { ok = await s.try.verify(); } catch { /* keep waiting */ }
        busy = false;
        if (ok && !done) {
          done = true;
          clearPoll();
          opts.onLog?.({ step: s.title, action: s.try.action, success: true });
          status.className = 'tour-status ok';
          status.textContent = '✓ Nice — you did it!';
          primaryBtn.textContent = i === valid.length - 1 ? 'Done' : 'Continue ▸';
          primaryBtn.classList.add('ok');
        }
      }, 600);
    }
  }
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey);
  render();
}
