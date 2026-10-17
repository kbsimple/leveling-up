// Glucose line chart with bolus and Tandem lanes, drawn as inline SVG.
// Colors come from CSS custom properties (see style.css); tooltip text is set
// with textContent only.

import { ago, formatBolus, formatBolusDetail, formatClock } from './format';
import type { Bolus, PumpUpload, Reading } from './model';

export const TARGET_LOW = 70;
export const TARGET_HIGH = 180;

/** When Tandem data arrived, to explain gaps in pump data on the chart. */
export interface TandemTimeline {
  uploads: PumpUpload[];
  /** Newest pump event in Tandem; later pump data hasn't been uploaded yet. */
  newestEventMs: number | null;
  /** Last successful Tandem -> Nightscout sync. */
  syncedMs: number | null;
}

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 262;
const PAD = { top: 12, right: 12, bottom: 76, left: 34 };
const PLOT_BOTTOM = HEIGHT - PAD.bottom;
const BOLUS_Y = PLOT_BOTTOM + 16; // bolus marker lane
const TANDEM_Y = PLOT_BOTTOM + 36; // pump upload / Nightscout sync lane
const LABEL_Y = HEIGHT - 8; // x axis labels
/** Readings further apart than this are drawn as a gap. */
const GAP_MS = 15 * 60_000;
/** How close (in chart px) a tap must be to a lane marker. */
const HIT_PX = 14;

type Marker =
  | { lane: 'bolus'; cx: number; ms: number; bolus: Bolus }
  | { lane: 'tandem'; cx: number; ms: number; upload: PumpUpload }
  | { lane: 'tandem'; cx: number; ms: number; sync: true };

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number>, parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function tickStepHours(hours: number): number {
  if (hours <= 6) return 1;
  if (hours <= 12) return 2;
  return 4;
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}

/** Renders the chart into `host`, replacing its contents. */
export function renderGraph(
  host: HTMLElement, readings: Reading[], boluses: Bolus[], hours: number, nowMs: number,
  tandem: TandemTimeline | null,
): void {
  host.replaceChildren();
  const width = Math.max(280, Math.round(host.clientWidth || 360));
  const startMs = nowMs - hours * 3_600_000;
  const visible = readings.filter((r) => r.timeMs >= startMs);
  const maxMgdl = Math.max(300, ...visible.map((r) => r.mgdl + 10));
  const minMgdl = Math.min(40, ...visible.map((r) => r.mgdl - 10));
  const right = width - PAD.right;
  const x = (ms: number) => PAD.left + ((ms - startMs) / (nowMs - startMs)) * (right - PAD.left);
  const y = (mgdl: number) => PAD.top + ((maxMgdl - mgdl) / (maxMgdl - minMgdl)) * (PLOT_BOTTOM - PAD.top);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', height: HEIGHT, class: 'graph',
    role: 'img', 'aria-label': `Glucose over the last ${hours} hours, with boluses and Tandem uploads`,
  }, host);

  // Target range band and recessive grid.
  el('rect', {
    x: PAD.left, y: y(TARGET_HIGH), width: right - PAD.left,
    height: y(TARGET_LOW) - y(TARGET_HIGH), class: 'target-band',
  }, svg);
  for (const level of [TARGET_LOW, TARGET_HIGH, 250]) {
    if (level > maxMgdl) continue;
    el('line', { x1: PAD.left, x2: right, y1: y(level), y2: y(level), class: 'grid' }, svg);
    el('text', { x: PAD.left - 6, y: y(level) + 4, class: 'axis-label', 'text-anchor': 'end' }, svg)
      .textContent = String(level);
  }

  // Pump data not yet uploaded to Tandem: hatched from the newest pump event to now.
  const pendingFromMs = tandem?.newestEventMs != null && tandem.newestEventMs < nowMs
    ? Math.max(tandem.newestEventMs, startMs) : null;
  if (pendingFromMs !== null) {
    const pattern = el('pattern', {
      id: 'pending-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    }, el('defs', {}, svg));
    el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'pending-hatch-line' }, pattern);
    el('rect', {
      x: x(pendingFromMs), y: PAD.top, width: right - x(pendingFromMs), height: TANDEM_Y + 8 - PAD.top,
      fill: 'url(#pending-hatch)', class: 'pending',
    }, svg);
  }

  // Hour ticks on the x axis, aligned to clock hours.
  const step = tickStepHours(hours);
  const firstTick = Math.ceil(startMs / 3_600_000) * 3_600_000;
  for (let t = firstTick; t <= nowMs; t += 3_600_000) {
    if (new Date(t).getHours() % step !== 0) continue;
    el('line', { x1: x(t), x2: x(t), y1: PAD.top, y2: PLOT_BOTTOM, class: 'grid grid-v' }, svg);
    el('text', { x: x(t), y: LABEL_Y, class: 'axis-label', 'text-anchor': 'middle' }, svg)
      .textContent = formatClock(t).replace(':00', '');
  }
  el('line', { x1: PAD.left, x2: right, y1: PLOT_BOTTOM, y2: PLOT_BOTTOM, class: 'axis' }, svg);

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

  const markers: Marker[] = [];

  // Bolus lane: manual = triangle, automatic = circle (shape + color).
  for (const b of boluses.filter((b) => b.timeMs >= startMs)) {
    const cx = x(b.timeMs);
    markers.push({ lane: 'bolus', cx, ms: b.timeMs, bolus: b });
    if (b.automatic) {
      el('circle', { cx, cy: BOLUS_Y, r: 4.5, class: 'bolus-auto' }, svg);
    } else {
      const s = 6.5;
      el('path', { d: `M${cx},${BOLUS_Y - s}L${cx + s},${BOLUS_Y + s * 0.8}L${cx - s},${BOLUS_Y + s * 0.8}Z`, class: 'bolus-manual' }, svg);
    }
  }

  // Tandem lane: pump -> Tandem uploads (diamonds) and the last Nightscout sync (ring).
  for (const u of tandem?.uploads ?? []) {
    if (u.uploadedMs < startMs || u.uploadedMs > nowMs) continue;
    const cx = x(u.uploadedMs);
    markers.push({ lane: 'tandem', cx, ms: u.uploadedMs, upload: u });
    el('path', { d: diamond(cx, TANDEM_Y, 5.5), class: 'tandem-upload' }, svg);
  }
  if (tandem?.syncedMs != null && tandem.syncedMs >= startMs) {
    const cx = x(Math.min(tandem.syncedMs, nowMs));
    markers.push({ lane: 'tandem', cx, ms: tandem.syncedMs, sync: true });
    el('circle', { cx, cy: TANDEM_Y, r: 4.5, class: 'ns-sync' }, svg);
  }

  // Crosshair + tooltip layer.
  const crosshair = el('line', { y1: PAD.top, y2: TANDEM_Y + 8, class: 'crosshair', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 5, class: 'crosshair-dot', visibility: 'hidden' }, svg);
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.hidden = true;
  host.appendChild(tooltip);

  const hit = el('rect', { x: PAD.left, y: 0, width: right - PAD.left, height: HEIGHT, class: 'hit' }, svg);

  const lines = (strong: string, ...rest: string[]) => {
    tooltip.replaceChildren();
    const s = document.createElement('strong');
    s.textContent = strong;
    tooltip.append(s);
    for (const text of rest) {
      const span = document.createElement('span');
      span.textContent = text;
      tooltip.append(span);
    }
  };

  const show = (clientX: number, clientY: number) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * width;
    const py = ((clientY - box.top) / box.height) * HEIGHT;
    const ms = startMs + ((px - PAD.left) / (right - PAD.left)) * (nowMs - startMs);

    // Below the plot, taps pick the nearest marker in the lane under the pointer.
    let marker: Marker | null = null;
    if (py > PLOT_BOTTOM + 4) {
      const lane = py < (BOLUS_Y + TANDEM_Y) / 2 ? 'bolus' : 'tandem';
      marker = markers
        .filter((m) => m.lane === lane && Math.abs(m.cx - px) <= HIT_PX)
        .sort((a, b) => Math.abs(a.cx - px) - Math.abs(b.cx - px))[0] ?? null;
    }
    const nearest = marker ? null : visible.reduce<Reading | null>(
      (best, r) => (!best || Math.abs(r.timeMs - ms) < Math.abs(best.timeMs - ms) ? r : best), null);
    if (!marker && !nearest) return hide();

    const atMs = marker ? marker.ms : nearest!.timeMs;
    crosshair.setAttribute('x1', String(x(Math.min(atMs, nowMs))));
    crosshair.setAttribute('x2', String(x(Math.min(atMs, nowMs))));
    crosshair.setAttribute('visibility', 'visible');
    if (nearest) {
      dot.setAttribute('cx', String(x(nearest.timeMs)));
      dot.setAttribute('cy', String(y(nearest.mgdl)));
      dot.setAttribute('visibility', 'visible');
    } else {
      dot.setAttribute('visibility', 'hidden');
    }

    if (marker && 'bolus' in marker) {
      const b = marker.bolus;
      const detail = formatBolusDetail(b);
      lines(formatBolus(b), `${formatClock(b.timeMs)}${b.automatic ? '' : ' · manual'}`, ...(detail ? [detail] : []));
    } else if (marker && 'upload' in marker) {
      const u = marker.upload;
      lines('Pump → Tandem upload', `${formatClock(u.uploadedMs)} (${ago(u.uploadedMs, nowMs)})`,
        ...(u.newestEventMs !== null ? [`Pump data through ${formatClock(u.newestEventMs)}`] : []));
    } else if (marker) {
      lines('Synced to Nightscout', `${formatClock(marker.ms)} (${ago(marker.ms, nowMs)})`);
    } else {
      const pending = pendingFromMs !== null && nearest!.timeMs > pendingFromMs;
      lines(`${nearest!.mgdl} mg/dL`, formatClock(nearest!.timeMs),
        ...(pending ? ['Pump data not uploaded yet'] : []));
    }
    tooltip.hidden = false;
    const left = Math.min(Math.max((x(Math.min(atMs, nowMs)) / width) * box.width - tooltip.offsetWidth / 2, 0),
      box.width - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
  };
  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  hit.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY));
  hit.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
}
