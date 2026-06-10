// Shared helpers: API calls, SSE consumption, markdown with traj:// deep links.

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
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
    const label = isToken ? hrefOrToken.text : text;
    const m = /^traj:\/\/(model_[ab])\/(\d+)$/.exec(href || '');
    if (m) {
      const shown = label && label !== href ? label : `${m[1]}[${m[2]}]`;
      return `<a class="traj-link" href="#" data-traj-model="${m[1]}" data-traj-index="${m[2]}">${escapeHtml(shown)} </a>`;
    }
    return linkBase.call(this, hrefOrToken, title, text);
  };
  const html = marked.parse(md, { renderer, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-traj-model', 'data-traj-index'] });
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
