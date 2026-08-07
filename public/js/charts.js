// A very small SVG chart kit for the Overview page.
//
// There is no charting dependency in this repo and this doesn't add one. Every
// mark here follows the house data-viz rules, which are worth stating because
// they are why the code looks the way it does:
//
//   * Colour is assigned by JOB, not by taste. Review stages are an ORDERED
//     scale, so they get a single-hue ordinal ramp (--viz-stage-1..4) rather
//     than categorical hues. Status colours are reserved and never used as a
//     series. One series that is the point + the rest as context is "emphasis",
//     not a palette.
//   * Fills are CSS classes, never inline hex, so light/dark swap for free and
//     the ramp lives in one place (studio.css).
//   * Data-ends are rounded 4px and anchored to the baseline; stacked segments
//     and adjacent bars carry a 2px surface gap so they never bleed together.
//   * Text wears text tokens, never the series colour.
//   * Every chart gets a hover layer. A chart in a browser that can't be
//     interrogated is a picture of data, not a view of it.
//   * One axis. Two measures of different scale are two charts.

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// A column/bar whose value-end is rounded and whose baseline-end is square, so
// the mark reads as growing FROM the axis. `dir` says which way it grows.
function endRoundedPath(x, y, w, h, r, dir) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.5) return `M${x},${y + (dir === 'up' ? h : 0)}h${w}`;
  if (dir === 'up') {
    return `M${x},${y + h}V${y + rr}q0,-${rr} ${rr},-${rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}V${y + h}Z`;
  }
  // 'right' — horizontal bar growing from the left baseline
  const rw = Math.max(0, Math.min(r, h / 2, w));
  if (w <= 0.5) return `M${x},${y}v${h}`;
  return `M${x},${y}h${w - rw}q${rw},0 ${rw},${rw}v${h - 2 * rw}q0,${rw} -${rw},${rw}h-${w - rw}Z`;
}

// ---------------------------------------------------------------------------
// shared chrome: tooltip + resize-aware mounting
// ---------------------------------------------------------------------------

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function showTip(html, evt) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 12;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
const hideTip = () => { if (tip) tip.hidden = true; };

// Charts are laid out in real pixels rather than a scaled viewBox, so labels
// keep their intended size instead of stretching with the container.
// Returns a teardown. CALL IT before putting anything else in the same host.
//
// Both observers used to outlive the chart they were drawing. For a chart mounted
// once that was invisible, but a host that re-renders — the matchup chart behind
// the layer toggles — broke outright: replacing the chart with an empty-state
// message resized the host, the orphaned ResizeObserver woke up and drew the old
// chart straight back over it, and each pass leaked another observer pair.
export function mountChart(host, render) {
  if (!host) return () => {};
  teardown(host);

  let raf = 0;
  const draw = () => {
    const w = Math.max(280, Math.floor(host.clientWidth || host.getBoundingClientRect().width || 640));
    const node = render(w);
    host.replaceChildren(...(node ? [node] : []));
  };
  draw();

  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
  ro.observe(host);
  // Theme flips change the ramp, and the marks are classed so they repaint
  // themselves — but direct labels are placed against measured geometry, so a
  // redraw keeps them honest.
  const mo = new MutationObserver(draw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const stop = () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); };
  // Parked on the host so a later mountChart — or clearChart — can find it
  // without every caller having to hold the handle.
  host.__vizTeardown = stop;
  return stop;
}

function teardown(host) {
  if (host?.__vizTeardown) {
    host.__vizTeardown();
    delete host.__vizTeardown;
  }
}

// Replace a chart with arbitrary content, stopping its observers first.
export function clearChart(host, ...children) {
  if (!host) return;
  teardown(host);
  host.replaceChildren(...children.flat().filter((c) => c != null));
}

function emptyState(w, h, msg) {
  const g = s('svg', { class: 'viz', width: w, height: h, role: 'img', 'aria-label': msg });
  g.append(s('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', class: 'viz-empty' }, msg));
  return g;
}

// ---------------------------------------------------------------------------
// 1. Delivery volume vs target — columns over time, emphasis on the latest
// ---------------------------------------------------------------------------
// Job: change over time AND distance to a limit. Emphasis form: the most recent
// delivery is the one being judged, everything before it is context. The target
// is a reference RULE, not a series — drawing it as a line keeps the comparison
// on one axis.
export function deliveryColumns({ history, target }) {
  return (w) => {
    const data = [...history].reverse(); // oldest -> newest, reading order
    if (!data.length) return emptyState(w, 260, 'No delivery batches found');

    const h = 260;
    const pad = { t: 26, r: 16, b: 42, l: 44 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const max = Math.max(target, ...data.map((d) => d.tasks)) * 1.12;
    const y = (v) => pad.t + ih - (v / max) * ih;
    // 2px surface gap between adjacent columns
    const slot = iw / data.length;
    const bw = Math.max(6, Math.min(46, slot - 8));

    const svg = s('svg', { class: 'viz', width: w, height: h, role: 'img',
      'aria-label': `Delivery volume across ${data.length} deliveries against a target of ${target}` });

    // recessive gridlines + y axis
    const ticks = [0, target / 2, target].map(Math.round);
    for (const t of ticks) {
      svg.append(s('line', { class: 'viz-grid', x1: pad.l, x2: w - pad.r, y1: y(t), y2: y(t) }));
      svg.append(s('text', { class: 'viz-tick', x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmtInt(t)));
    }

    data.forEach((d, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2;
      const top = y(d.tasks);
      const isLast = i === data.length - 1;
      const met = d.tasks >= target;
      const cls = isLast ? (met ? 'viz-col viz-col--hit' : 'viz-col viz-col--miss') : 'viz-col viz-col--context';
      svg.append(s('path', { class: cls, d: endRoundedPath(x, top, bw, pad.t + ih - top, 4, 'up') }));

      // The hover target is a full-height band across the column's whole slot,
      // not the mark itself. A short column is only a few pixels tall, and at
      // narrow widths the mark narrows too — aiming at it would be a pinpoint
      // hit. The band covers the 2px gap and always clears the ~24px minimum.
      const hit = s('rect', {
        x: pad.l + i * slot, y: pad.t, width: slot, height: ih, fill: 'transparent',
      });
      const tipHtml = `<b>${d.date}</b> ${d.dayName} ${String(d.hour).padStart(2, '0')}:00 PT<br>`
        + `${fmtInt(d.tasks)} tasks · ${met ? 'met' : `${target - d.tasks} short of`} the ${target} target`;
      hit.addEventListener('pointerenter', (e) => showTip(tipHtml, e));
      hit.addEventListener('pointermove', (e) => showTip(tipHtml, e));
      hit.addEventListener('pointerleave', hideTip);
      svg.append(hit);

      // Selective direct labels: the latest, and the first, never every column.
      if (isLast || i === 0) {
        svg.append(s('text', { class: 'viz-datalabel', x: x + bw / 2, y: top - 7, 'text-anchor': 'middle' }, fmtInt(d.tasks)));
      }
      if (isLast || i === 0 || data.length <= 8 || i % 2 === 0) {
        svg.append(s('text', { class: 'viz-tick', x: x + bw / 2, y: h - pad.b + 16, 'text-anchor': 'middle' },
          d.date.slice(5).replace('-', '/')));
      }
    });

    // Target rule sits above the columns so it is never buried. Its label is
    // anchored LEFT: the newest column is on the right and is the one most
    // likely to reach the rule, so a right-anchored label collides with exactly
    // the data label that matters most.
    svg.append(s('line', { class: 'viz-rule', x1: pad.l, x2: w - pad.r, y1: y(target), y2: y(target) }));
    svg.append(s('text', { class: 'viz-rule-label', x: pad.l + 4, y: y(target) - 7 }, `target ${target}`));
    return svg;
  };
}

// ---------------------------------------------------------------------------
// 2. Queue readiness — horizontal funnel with a cumulative target marker
// ---------------------------------------------------------------------------
// Job: "is there enough, and how far back do we have to reach for it". Bars are
// ordered by pipeline position and read cumulatively from the finish line
// backwards, which is the order the question is actually asked in.
export function readinessFunnel({ stages, target }) {
  return (w) => {
    const rows = [...stages].reverse(); // Final first — nearest the finish line
    if (!rows.length) return emptyState(w, 200, 'No tasks in flight');

    const rowH = 40;
    const h = rows.length * rowH + 52;
    // Right pad carries "307 +246" — the running total plus its increment.
    const pad = { t: 12, r: 96, b: 30, l: 112 };
    const iw = w - pad.l - pad.r;
    // Scale on the cumulative total so the target marker lands on the same axis.
    let run = 0;
    const cum = rows.map((r) => (run += r.pending));
    const max = Math.max(target, run) * 1.04;
    const x = (v) => (v / max) * iw;

    const svg = s('svg', { class: 'viz', width: w, height: h, role: 'img',
      'aria-label': `Tasks pending by review level, cumulative, against a target of ${target}` });

    // Drawn in three passes so the z-order is right: marks, then the target
    // rule over them, then every label on top. A single pass put the rule
    // through the running-total label of whichever stage happened to land near
    // the target — which is precisely the row a reader is checking.
    const geom = rows.map((r, i) => {
      const yTop = pad.t + i * rowH;
      const reached = cum[i];
      return { r, i, yTop, barH: rowH - 14, reached, start: reached - r.pending };
    });

    for (const { r, yTop, barH, reached, start } of geom) {
      if (start > 0) {
        svg.append(s('rect', { class: 'viz-runup', x: pad.l, y: yTop, width: x(start), height: barH, rx: 3 }));
      }
      if (r.pending <= 0) continue; // a zero stage draws nothing, not a sliver
      const seg = s('path', {
        class: `viz-bar viz-stage--${r.key}`,
        d: endRoundedPath(pad.l + x(start) + 1, yTop, Math.max(0, x(r.pending) - 2), barH, 4, 'right'),
      });
      seg.addEventListener('pointerenter', (e) => showTip(
        `<b>${r.label}</b> — level${r.levels.length > 1 ? 's' : ''} ${r.levels.join(', ') || '—'}<br>`
        + `adds ${fmtInt(r.pending)} pending${r.stale ? ` · ${r.stale} stale` : ''}<br>`
        + `running total from the finish line: ${fmtInt(reached)}`, e));
      seg.addEventListener('pointermove', (e) => showTip(tooltip().innerHTML, e));
      seg.addEventListener('pointerleave', hideTip);
      svg.append(seg);
    }

    // the target marker — a rule across every row, labelled once
    const tx = pad.l + x(target);
    svg.append(s('line', { class: 'viz-rule', x1: tx, x2: tx, y1: pad.t - 6, y2: pad.t + rows.length * rowH - 6 }));
    svg.append(s('text', { class: 'viz-rule-label', x: tx, y: h - 12, 'text-anchor': 'middle' }, `${target} needed`));

    for (const { r, i, yTop, barH, reached } of geom) {
      // The stale count rides the row label rather than sitting in a gutter as a
      // bare dot: a lone marker with no header is a puzzle, and the count is the
      // part worth reading.
      const labelY = r.stale > 0 ? yTop + barH / 2 : yTop + barH / 2 + 4;
      svg.append(s('text', { class: 'viz-rowlabel', x: pad.l - 12, y: labelY, 'text-anchor': 'end' }, r.label));
      if (r.stale > 0) {
        svg.append(s('text', { class: 'viz-sublabel viz-sublabel--warn', x: pad.l - 12, y: labelY + 12, 'text-anchor': 'end' },
          `${r.stale} stale`));
      }

      // The bar's LENGTH is this stage's increment, but its END is the running
      // total — and the running total is what the target rule is compared
      // against, so that is the number that gets the bold label. The increment
      // follows in muted ink so both readings are available without a tooltip.
      const lx = pad.l + x(reached) + 8;
      const total = fmtInt(reached);
      // Labels carry a surface-coloured halo so the one sitting on the target
      // rule stays legible without moving it off its own data point.
      svg.append(s('text', { class: 'viz-datalabel viz-datalabel--halo', x: lx, y: yTop + barH / 2 + 4 }, total));
      // On the first row the increment IS the total, so the "+61" would just be
      // the same number twice.
      if (i > 0) {
        svg.append(s('text', { class: 'viz-sublabel viz-datalabel--halo', x: lx + total.length * 7.6 + 6, y: yTop + barH / 2 + 4 },
          `+${fmtInt(r.pending)}`));
      }
    }
    return svg;
  };
}

// ---------------------------------------------------------------------------
// 2b. Deliverable intake — daily arrivals into L12, with delivery markers
// ---------------------------------------------------------------------------
// Job: is the deliverable pool being fed fast enough, and where are we in the
// cycle. Emphasis form again: days since the last delivery are the ones being
// judged, everything before them is the pattern being judged against. Delivery
// dates get a rule so the pre-delivery ramp is visible rather than inferred.
export function intakeColumns({ days, deliveries, cycleStart }) {
  return (w) => {
    if (!days.length) return emptyState(w, 210, 'No level-12 arrivals in this window');
    const h = 210;
    const pad = { t: 24, r: 16, b: 40, l: 44 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const max = Math.max(...days.map((d) => d.entered)) * 1.15 || 1;
    const y = (v) => pad.t + ih - (v / max) * ih;
    const slot = iw / days.length;
    const bw = Math.max(4, Math.min(30, slot - 4));
    const delivered = new Set(deliveries || []);

    const svg = s('svg', { class: 'viz', width: w, height: h, role: 'img',
      'aria-label': `Tasks entering level 12 per day across ${days.length} days` });

    for (const t of [0, max / 2]) {
      svg.append(s('line', { class: 'viz-grid', x1: pad.l, x2: w - pad.r, y1: y(t), y2: y(t) }));
      svg.append(s('text', { class: 'viz-tick', x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmtInt(t)));
    }

    days.forEach((d, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2;
      const top = y(d.entered);
      const inCycle = cycleStart && d.day >= cycleStart;
      svg.append(s('path', {
        class: `viz-col ${inCycle ? 'viz-col--cycle' : 'viz-col--context'}`,
        d: endRoundedPath(x, top, bw, pad.t + ih - top, 4, 'up'),
      }));
      // Delivery days get a marker so the ramp into each one is legible.
      if (delivered.has(d.day)) {
        svg.append(s('line', { class: 'viz-rule', x1: x + bw / 2, x2: x + bw / 2, y1: pad.t - 8, y2: pad.t + ih }));
      }
      const hit = s('rect', { x: pad.l + i * slot, y: pad.t, width: slot, height: ih, fill: 'transparent' });
      const tip = `<b>${d.day}</b> ${d.dayName}<br>${fmtInt(d.entered)} entered L12`
        + `${delivered.has(d.day) ? '<br>delivery closed out this day' : ''}`
        + `${inCycle ? '<br>this cycle' : ''}`;
      hit.addEventListener('pointerenter', (e) => showTip(tip, e));
      hit.addEventListener('pointermove', (e) => showTip(tip, e));
      hit.addEventListener('pointerleave', hideTip);
      svg.append(hit);
      if (i === 0 || i === days.length - 1 || d.entered === Math.max(...days.map((z) => z.entered))) {
        svg.append(s('text', { class: 'viz-tick', x: x + bw / 2, y: h - pad.b + 16, 'text-anchor': 'middle' },
          d.day.slice(5).replace('-', '/')));
      }
    });
    return svg;
  };
}

// ---------------------------------------------------------------------------
// 3. Throughput — stacked area by review level, with a crosshair
// ---------------------------------------------------------------------------
// Job: trend + composition. Ordinal ramp because stages are ordered. The value
// is "tasks touched at each stage per day": a task worked at two stages in one
// day counts at both, so the stack total is activity, not a task count — the
// caption says so rather than letting the axis imply otherwise.
export function stackedArea({ days, stageKeys, stageLabels, series }) {
  return (w) => {
    if (!days.length) return emptyState(w, 240, 'No activity in this window');
    const h = 240;
    const pad = { t: 18, r: 16, b: 34, l: 44 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    const totals = days.map((_, i) => stageKeys.reduce((a, k) => a + (series[k]?.[i] || 0), 0));
    const max = Math.max(1, ...totals) * 1.1;
    const X = (i) => pad.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
    const Y = (v) => pad.t + ih - (v / max) * ih;

    const svg = s('svg', { class: 'viz', width: w, height: h, role: 'img',
      'aria-label': `Daily tasks touched per stage over ${days.length} days` });

    for (const t of [0, max / 2, max]) {
      svg.append(s('line', { class: 'viz-grid', x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t) }));
      svg.append(s('text', { class: 'viz-tick', x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, fmtInt(t)));
    }

    // Final is drawn first, so it sits on the baseline: the stage the reader is
    // actually chasing gets the axis-anchored band, which is the only one whose
    // thickness can be judged accurately. L-1 stacks on top of it.
    const order = [...stageKeys].reverse();
    const base = days.map(() => 0);
    for (const k of order) {
      const vals = series[k] || days.map(() => 0);
      const top = vals.map((v, i) => base[i] + v);
      const d = [
        ...top.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`),
        ...base.map((v, i) => `L${X(days.length - 1 - i)},${Y(base[days.length - 1 - i])}`).slice(1),
        'Z',
      ].join('');
      svg.append(s('path', { class: `viz-area viz-stage--${k}`, d }));
      for (let i = 0; i < base.length; i++) base[i] = top[i];
    }

    // x ticks — first, middle, last only
    for (const i of [0, Math.floor(days.length / 2), days.length - 1]) {
      svg.append(s('text', { class: 'viz-tick', x: X(i), y: h - 12, 'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle' },
        days[i].slice(5).replace('-', '/')));
    }

    // crosshair layer
    const cross = s('line', { class: 'viz-cross', x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, opacity: 0 });
    svg.append(cross);
    const hit = s('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const rel = e.clientX - rect.left - pad.l;
      const i = Math.max(0, Math.min(days.length - 1, Math.round((rel / iw) * (days.length - 1))));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
      const lines = stageKeys
        .map((k) => ({ k, v: series[k]?.[i] || 0 }))
        .filter((r) => r.v > 0).reverse()
        .map((r) => `<span class="viz-tip__sw viz-stage--${r.k}"></span>${stageLabels[r.k]} <b>${fmtInt(r.v)}</b>`)
        .join('<br>');
      showTip(`<b>${days[i]}</b><br>${lines || 'no activity'}<br><span class="viz-tip__tot">total ${fmtInt(totals[i])}</span>`, e);
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
    svg.append(hit);
    return svg;
  };
}

// ---------------------------------------------------------------------------
// 4. Horizontal bars — one measure, sorted, with a status accent
// ---------------------------------------------------------------------------
// Used twice, for two DIFFERENT measures (hours, and % rejected) as two separate
// charts. Deliberately not one chart with two axes.
// `accent`: 'status' colours by threshold; anything else uses one neutral hue and
// lets bar LENGTH carry the magnitude on its own. Colouring a magnitude chart by
// pipeline stage was tried and removed — it handed the largest bar the lightest
// step, so hue argued with length instead of adding to it.
// `labelWidth` sizes the row-label gutter. It has to be caller-controlled because
// the default 74px was set for "L-1"-style labels, and a long one — a model
// matchup like "anthropic/claude-opus-4-6 vs super_nova_ext" — is right-aligned
// into that gutter, so it ran to negative x and spilled outside the card (.viz is
// overflow:visible by design, so nothing clipped it).
export function hBars({ rows, valueKey, format = fmtInt, accent = 'neutral', threshold = null, note = null, labelWidth = 74 }) {
  return (w) => {
    if (!rows.length) return emptyState(w, 180, 'No data in this window');
    const rowH = 32;
    const h = rows.length * rowH + (note ? 34 : 14);
    // Never let the gutter eat the plot: cap it at 55% of the available width.
    const pad = { t: 6, r: 76, b: 8, l: Math.min(labelWidth, Math.floor(w * 0.55)) };
    const iw = w - pad.l - pad.r;
    const max = Math.max(...rows.map((r) => r[valueKey])) * 1.02 || 1;

    const svg = s('svg', { class: 'viz', width: w, height: h, role: 'img', 'aria-label': note || 'bar chart' });
    rows.forEach((r, i) => {
      const y = pad.t + i * rowH;
      const barH = rowH - 12;
      const v = r[valueKey];
      // A zero draws no mark at all. Clamping to a 1px sliver made "0%" look
      // like a small non-zero value, which is the one thing it isn't.
      const bw = v > 0 ? Math.max(2, (v / max) * iw) : 0;
      // Threshold turns a magnitude bar into a status read; below it the bar
      // stays on the neutral ramp so the colour means something when it changes.
      const over = threshold != null && v >= threshold;
      const cls = accent === 'status'
        ? `viz-bar ${over ? 'viz-bar--warn' : 'viz-bar--neutral'}`
        : 'viz-bar viz-bar--neutral';
      svg.append(s('text', { class: 'viz-rowlabel', x: pad.l - 12, y: y + barH / 2 + 4, 'text-anchor': 'end' }, r.label));
      if (bw > 0) {
        const bar = s('path', { class: cls, d: endRoundedPath(pad.l, y, bw, barH, 4, 'right') });
        bar.addEventListener('pointerenter', (e) => showTip(r.tip || `<b>${r.label}</b><br>${format(v)}`, e));
        bar.addEventListener('pointermove', (e) => showTip(tooltip().innerHTML, e));
        bar.addEventListener('pointerleave', hideTip);
        svg.append(bar);
      }
      svg.append(s('text', { class: 'viz-datalabel', x: pad.l + bw + 8, y: y + barH / 2 + 4 }, format(v)));
    });
    // Anchored to the left edge, not offset from the gutter — the old
    // `pad.l - 74 + 2` only landed at x=2 while the gutter was fixed at 74.
    if (note) svg.append(s('text', { class: 'viz-note', x: 2, y: h - 8 }, note));
    return svg;
  };
}

// A legend is always present for >= 2 series, so identity is never colour-alone.
export function legend(items) {
  const box = document.createElement('div');
  box.className = 'viz-legend';
  for (const it of items) {
    const row = document.createElement('span');
    row.className = 'viz-legend__item';
    const sw = document.createElement('span');
    sw.className = `viz-legend__sw viz-stage--${it.key}`;
    row.append(sw, document.createTextNode(it.label));
    box.append(row);
  }
  return box;
}
