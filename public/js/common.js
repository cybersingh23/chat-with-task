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
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
    location.href = '/login.html';
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
  const res = await fetch(`/api${path}`, {
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

// Markdown -> sanitized HTML. traj://model_a/12 links become "Show in
// trajectory" buttons; clicks are delegated via the data-traj attributes.
export function renderMarkdown(md) {
  const renderer = new marked.Renderer();
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
    const m = /^traj:\/\/(model_[ab])\/(\d+)$/.exec(href || '');
    if (m) {
      const shown = hasLabel ? labelHtml : `${m[1]}[${m[2]}]`;
      return `<a class="traj-link" href="#" data-traj-model="${m[1]}" data-traj-index="${m[2]}">${shown} </a>`;
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

  let html = marked.parse(md, { renderer, gfm: true, breaks: false });
  // [HARD]/[SOFT]/[INFO] tags in finding headings -> severity badges.
  html = html.replace(/\[(HARD|SOFT|INFO)\]/g, (_, sev) => `<span class="sev sev-${sev}">${sev}</span>`);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-traj-model', 'data-traj-index', 'data-spec-key'] });
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
