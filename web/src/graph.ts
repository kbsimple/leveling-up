// Glucose line chart with bolus, basal and Tandem lanes, drawn as inline SVG.
// Basal has its own panel and scale rather than a second axis on the glucose plot.
// Colors come from CSS custom properties (see style.css); tooltip text is set
// with textContent only.

import { ago, formatBolus, formatBolusDetail, formatClock, formatRate } from './format';
import { spanAt, type BasalSpan, type Bolus, type PumpUpload, type Reading } from './model';

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

/** Delivered basal and the profile schedule, for the basal panel. */
export interface BasalTimeline {
  delivered: BasalSpan[];
  profile: BasalSpan[];
}

const SVG = 'http://www.w3.org/2000/svg';
const PAD = { top: 12, right: 12, left: 34 };
const PLOT_BOTTOM = 186; // glucose plot
const BOLUS_Y = PLOT_BOTTOM + 16; // bolus marker lane
const BASAL_TOP = PLOT_BOTTOM + 30; // basal panel
const BASAL_BOTTOM = BASAL_TOP + 44;
const TANDEM_Y = BASAL_BOTTOM + 16; // pump upload / Nightscout sync lane
const LABEL_Y = TANDEM_Y + 26; // x axis labels
const HEIGHT = LABEL_Y + 8;
/** Smallest top of the basal scale, in U/hr. */
const MIN_BASAL_MAX = 1;
/** Readings further apart than this are drawn as a gap. */
const GAP_MS = 15 * 60_000;
/** How close (in chart px) a tap must be to a lane marker. */
const HIT_PX = 14;

/** Document-level listeners per chart host, so re-renders don't pile them up. */
const listeners = new WeakMap<HTMLElement, AbortController>();

type Lane = 'plot' | 'bolus' | 'basal' | 'tandem';

/** Which horizontal band a chart y coordinate falls in. */
function laneAt(py: number): Lane {
  if (py <= PLOT_BOTTOM + 4) return 'plot';
  if (py < BASAL_TOP - 3) return 'bolus';
  if (py <= BASAL_BOTTOM + 5) return 'basal';
  return 'tandem';
}

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
  tandem: TandemTimeline | null, basal: BasalTimeline,
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
    role: 'img', 'aria-label': `Glucose over the last ${hours} hours, with boluses, basal and Tandem uploads`,
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

  // Basal panel: delivered rate as a stepped area, profile schedule as a dashed step line.
  const inWindow = (sp: BasalSpan) => sp.endMs > startMs && sp.startMs < nowMs;
  const delivered = basal.delivered.filter(inWindow);
  const profile = basal.profile.filter(inWindow);
  const basalMax = Math.max(MIN_BASAL_MAX, ...[...delivered, ...profile].map((sp) => Math.ceil(sp.rate * 2) / 2));
  const by = (rate: number) => BASAL_BOTTOM - (rate / basalMax) * (BASAL_BOTTOM - BASAL_TOP);
  const clampX = (ms: number) => x(Math.min(Math.max(ms, startMs), nowMs));
  el('line', { x1: PAD.left, x2: right, y1: BASAL_BOTTOM, y2: BASAL_BOTTOM, class: 'axis' }, svg);
  el('line', { x1: PAD.left, x2: right, y1: BASAL_TOP, y2: BASAL_TOP, class: 'grid' }, svg);
  el('text', { x: PAD.left - 6, y: BASAL_TOP + 4, class: 'axis-label', 'text-anchor': 'end' }, svg)
    .textContent = String(basalMax);
  el('text', { x: PAD.left - 6, y: BASAL_BOTTOM, class: 'axis-label', 'text-anchor': 'end' }, svg)
    .textContent = '0';
  const area = delivered
    .map((sp) => `M${clampX(sp.startMs).toFixed(1)},${BASAL_BOTTOM}V${by(sp.rate).toFixed(1)}H${clampX(sp.endMs).toFixed(1)}V${BASAL_BOTTOM}Z`)
    .join('');
  if (area) el('path', { d: area, class: 'basal-area' }, svg);
  let edge = '';
  let profileLine = '';
  for (const [i, sp] of delivered.entries()) {
    const join = i > 0 && delivered[i - 1].endMs === sp.startMs ? 'V' : `M${clampX(sp.startMs).toFixed(1)},`;
    edge += `${join}${by(sp.rate).toFixed(1)}H${clampX(sp.endMs).toFixed(1)}`;
  }
  for (const [i, sp] of profile.entries()) {
    const join = i > 0 && profile[i - 1].endMs === sp.startMs ? 'V' : `M${clampX(sp.startMs).toFixed(1)},`;
    profileLine += `${join}${by(sp.rate).toFixed(1)}H${clampX(sp.endMs).toFixed(1)}`;
  }
  if (edge) el('path', { d: edge, class: 'basal-edge' }, svg);
  if (profileLine) el('path', { d: profileLine, class: 'basal-profile' }, svg);

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

  /** "Profile 0.65 U/hr · 37% below" for a delivered rate at `atMs`. */
  const profileNote = (atMs: number, rate: number): string => {
    const p = spanAt(profile, atMs);
    if (!p) return 'No profile rate';
    if (p.rate === 0 || Math.abs(rate - p.rate) < 0.001) return `Profile ${formatRate(p.rate)}`;
    const pct = Math.round(((rate - p.rate) / p.rate) * 100);
    return `Profile ${formatRate(p.rate)} · ${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'}`;
  };

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

  // Key of the target currently shown, and of a target just dismissed (so the
  // pointer jitter that follows a dismissing tap doesn't re-show it).
  let shownKey: string | null = null;
  let dismissedKey: string | null = null;

  /** Shows details for the target under the pointer; `toggle` (a tap/click) hides them if already shown. */
  const show = (clientX: number, clientY: number, toggle: boolean) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * width;
    const py = ((clientY - box.top) / box.height) * HEIGHT;
    const ms = startMs + ((px - PAD.left) / (right - PAD.left)) * (nowMs - startMs);

    // Below the plot, taps pick the nearest marker in the lane under the pointer;
    // in the basal panel they read the rate at that time.
    const lane = laneAt(py);
    let marker: Marker | null = null;
    if (lane === 'bolus' || lane === 'tandem') {
      marker = markers
        .filter((m) => m.lane === lane && Math.abs(m.cx - px) <= HIT_PX)
        .sort((a, b) => Math.abs(a.cx - px) - Math.abs(b.cx - px))[0] ?? null;
    }
    const basalSpan = lane === 'basal' ? spanAt(delivered, Math.min(ms, nowMs - 1)) : null;
    const nearest = marker || basalSpan ? null : visible.reduce<Reading | null>(
      (best, r) => (!best || Math.abs(r.timeMs - ms) < Math.abs(best.timeMs - ms) ? r : best), null);
    if (!marker && !basalSpan && !nearest) return hide();

    const key = marker ? `${marker.lane}:${marker.ms}`
      : basalSpan ? `basal:${basalSpan.startMs}` : `glucose:${nearest!.timeMs}`;
    if (toggle && !tooltip.hidden && key === shownKey) {
      hide();
      dismissedKey = key;
      return;
    }
    if (!toggle && key === dismissedKey) return;
    dismissedKey = null;
    shownKey = key;

    const atMs = marker ? marker.ms : basalSpan ? Math.min(Math.max(ms, startMs), nowMs) : nearest!.timeMs;
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
    } else if (basalSpan) {
      lines(`Basal ${formatRate(basalSpan.rate)}`,
        `${formatClock(basalSpan.startMs)}–${formatClock(basalSpan.endMs)}`, profileNote(basalSpan.startMs, basalSpan.rate));
    } else {
      const pending = pendingFromMs !== null && nearest!.timeMs > pendingFromMs;
      const at = spanAt(delivered, nearest!.timeMs);
      lines(`${nearest!.mgdl} mg/dL`, formatClock(nearest!.timeMs),
        ...(at ? [`Basal ${formatRate(at.rate)}`] : []),
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
    shownKey = null;
  };

  // Listeners outside the chart are replaced on every render.
  listeners.get(host)?.abort();
  const controller = new AbortController();
  listeners.set(host, controller);
  const { signal } = controller;

  hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY, false), { signal });
  hit.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY, true), { signal });
  hit.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      hide();
      dismissedKey = null;
    }
  }, { signal });
  // A tap anywhere outside the chart, or Escape, dismisses the details.
  document.addEventListener('pointerdown', (e) => {
    if (!svg.contains(e.target as Node)) hide();
  }, { signal });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  }, { signal });
}
