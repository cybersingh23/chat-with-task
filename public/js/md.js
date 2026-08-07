import { el } from './common.js';

// A deliberately small markdown renderer that builds DOM NODES, never HTML.
//
// The model's answers use emphasis, inline code and short lists — that is what
// the prompt asks for — so rendering them as raw text puts literal `**` and
// backticks in front of the reader. But this is model output, and the rest of
// this app is careful to keep model output off innerHTML (see the Overview
// synthesis, which builds text nodes for exactly this reason). So: parse to
// nodes, and anything unrecognised stays plain text.
//
// Supported, because it is what actually shows up:
//   **bold**            emphasis on the number or the name that matters
//   `code`              query names, columns, level ids
//   _italic_
//   - bullets           short lists of findings
//   1. numbered
//   blank line          paragraph break
// Everything else — including any HTML in the text — is inert.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;

function inline(text) {
  const out = [];
  for (const part of String(text).split(INLINE)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push(el('strong', {}, part.slice(2, -2)));
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(el('code', {}, part.slice(1, -1)));
    } else if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      out.push(el('em', {}, part.slice(1, -1)));
    } else {
      out.push(document.createTextNode(part));
    }
  }
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  let list = null;      // { type: 'ul' | 'ol', items: [] }

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(el('p', {}, ...inline(para.join(' '))));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(el(list.type, {}, ...list.items.map((t) => el('li', {}, ...inline(t)))));
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const b = BULLET.exec(line);
    const n = !b && NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const type = b ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((b || n)[1]);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();

  // An answer that parsed to nothing still has to show something.
  if (!blocks.length && String(text || '').trim()) blocks.push(el('p', {}, String(text)));
  return blocks;
}
