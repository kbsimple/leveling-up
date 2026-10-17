// Glucose line chart with a bolus marker lane, drawn as inline SVG.
// Colors come from CSS custom properties (see style.css); tooltip text is set
// with textContent only.

import { formatBolus, formatBolusDetail, formatClock } from './format';
import type { Bolus, Reading } from './model';

export const TARGET_LOW = 70;
export const TARGET_HIGH = 180;

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 54, left: 34 };
const LANE_Y = HEIGHT - PAD.bottom + 16; // bolus marker lane, just under the plot
const LABEL_Y = HEIGHT - 10; // x axis labels, under the lane
/** Readings further apart than this are drawn as a gap. */
const GAP_MS = 15 * 60_000;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number>, parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function tickStepHours(hours: number): number {
  if (hours <= 3) return 1;
  if (hours <= 6) return 1;
  if (hours <= 12) return 2;
  return 4;
}

/** Renders the chart into `host`, replacing its contents. */
export function renderGraph(
  host: HTMLElement, readings: Reading[], boluses: Bolus[], hours: number, nowMs: number,
): void {
  host.replaceChildren();
  const width = Math.max(280, Math.round(host.clientWidth || 360));
  const startMs = nowMs - hours * 3_600_000;
  const visible = readings.filter((r) => r.timeMs >= startMs);
  const maxMgdl = Math.max(300, ...visible.map((r) => r.mgdl + 10));
  const minMgdl = Math.min(40, ...visible.map((r) => r.mgdl - 10));
  const plotBottom = HEIGHT - PAD.bottom;
  const x = (ms: number) => PAD.left + ((ms - startMs) / (nowMs - startMs)) * (width - PAD.left - PAD.right);
  const y = (mgdl: number) => PAD.top + ((maxMgdl - mgdl) / (maxMgdl - minMgdl)) * (plotBottom - PAD.top);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', height: HEIGHT, class: 'graph',
    role: 'img', 'aria-label': `Glucose over the last ${hours} hours, with boluses`,
  }, host);

  // Target range band and recessive grid.
  el('rect', {
    x: PAD.left, y: y(TARGET_HIGH), width: width - PAD.left - PAD.right,
    height: y(TARGET_LOW) - y(TARGET_HIGH), class: 'target-band',
  }, svg);
  for (const level of [TARGET_LOW, TARGET_HIGH, 250]) {
    if (level > maxMgdl) continue;
    el('line', { x1: PAD.left, x2: width - PAD.right, y1: y(level), y2: y(level), class: 'grid' }, svg);
    el('text', { x: PAD.left - 6, y: y(level) + 4, class: 'axis-label', 'text-anchor': 'end' }, svg)
      .textContent = String(level);
  }

  // Hour ticks on the x axis, aligned to clock hours.
  const step = tickStepHours(hours) * 3_600_000;
  const firstTick = Math.ceil(startMs / 3_600_000) * 3_600_000;
  for (let t = firstTick; t <= nowMs; t += 3_600_000) {
    const hour = new Date(t).getHours();
    if ((hour * 3_600_000) % step !== 0) continue;
    el('line', { x1: x(t), x2: x(t), y1: PAD.top, y2: plotBottom, class: 'grid grid-v' }, svg);
    el('text', { x: x(t), y: LABEL_Y, class: 'axis-label', 'text-anchor': 'middle' }, svg)
      .textContent = formatClock(t).replace(':00', '');
  }
  el('line', { x1: PAD.left, x2: width - PAD.right, y1: plotBottom, y2: plotBottom, class: 'axis' }, svg);

  // Glucose line, broken at gaps.
  let d = '';
  let prev: Reading | null = null;
  for (const r of visible) {
    d += `${prev && r.timeMs - prev.timeMs <= GAP_MS ? 'L' : 'M'}${x(r.timeMs).toFixed(1)},${y(r.mgdl).toFixed(1)}`;
    prev = r;
  }
  if (d) el('path', { d, class: 'glucose-line' }, svg);
  const last = visible[visible.length - 1];
  if (last) el('circle', { cx: x(last.timeMs), cy: y(last.mgdl), r: 4, class: 'glucose-last' }, svg);

  // Bolus lane: manual = triangle, automatic = circle (shape + color).
  const markers: { bolus: Bolus; cx: number }[] = [];
  for (const b of boluses.filter((b) => b.timeMs >= startMs)) {
    const cx = x(b.timeMs);
    markers.push({ bolus: b, cx });
    if (b.automatic) {
      el('circle', { cx, cy: LANE_Y, r: 4.5, class: 'bolus-auto' }, svg);
    } else {
      const s = 6.5;
      el('path', { d: `M${cx},${LANE_Y - s}L${cx + s},${LANE_Y + s * 0.8}L${cx - s},${LANE_Y + s * 0.8}Z`, class: 'bolus-manual' }, svg);
    }
  }

  // Crosshair + tooltip layer.
  const crosshair = el('line', { y1: PAD.top, y2: LANE_Y + 8, class: 'crosshair', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 5, class: 'crosshair-dot', visibility: 'hidden' }, svg);
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.hidden = true;
  host.appendChild(tooltip);

  const hit = el('rect', {
    x: PAD.left, y: 0, width: width - PAD.left - PAD.right, height: HEIGHT, class: 'hit',
  }, svg);

  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * width;
    const ms = startMs + ((px - PAD.left) / (width - PAD.left - PAD.right)) * (nowMs - startMs);
    const nearest = visible.reduce<Reading | null>(
      (best, r) => (!best || Math.abs(r.timeMs - ms) < Math.abs(best.timeMs - ms) ? r : best), null);
    const nearBolus = markers
      .filter((m) => Math.abs(m.cx - px) <= 12)
      .sort((a, b) => Math.abs(a.cx - px) - Math.abs(b.cx - px))[0]?.bolus ?? null;
    if (!nearest && !nearBolus) return hide();
    const atMs = nearBolus?.timeMs ?? nearest!.timeMs;
    crosshair.setAttribute('x1', String(x(atMs)));
    crosshair.setAttribute('x2', String(x(atMs)));
    crosshair.setAttribute('visibility', 'visible');
    if (nearest && !nearBolus) {
      dot.setAttribute('cx', String(x(nearest.timeMs)));
      dot.setAttribute('cy', String(y(nearest.mgdl)));
      dot.setAttribute('visibility', 'visible');
    } else {
      dot.setAttribute('visibility', 'hidden');
    }

    tooltip.replaceChildren();
    const strong = document.createElement('strong');
    const sub = document.createElement('span');
    if (nearBolus) {
      strong.textContent = formatBolus(nearBolus);
      sub.textContent = `${formatClock(nearBolus.timeMs)}${nearBolus.automatic ? '' : ' · manual'}`;
      tooltip.append(strong, sub);
      const detail = formatBolusDetail(nearBolus);
      if (detail) {
        const extra = document.createElement('span');
        extra.textContent = detail;
        tooltip.append(extra);
      }
    } else {
      strong.textContent = `${nearest!.mgdl} mg/dL`;
      sub.textContent = formatClock(nearest!.timeMs);
      tooltip.append(strong, sub);
    }
    tooltip.hidden = false;
    const left = Math.min(Math.max((x(atMs) / width) * box.width - tooltip.offsetWidth / 2, 0),
      box.width - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
  };
  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
}
