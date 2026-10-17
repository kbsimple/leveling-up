// UI: setup screen and the main view. All Nightscout-derived text is set with
// textContent.

import {
  arrow, formatAge, formatBolus, formatBolusDetail, formatClock, formatDelta, formatDuration,
  formatIob, formatRate, formatSyncStatus, isStale,
} from './format';
import { renderGraph, TARGET_HIGH, TARGET_LOW } from './graph';
import { BOLUS_WINDOW_MINUTES, type Bolus } from './model';
import { bolusesIn, fetchData, NightscoutError, pumpStateIn, type Data } from './nightscout';
import {
  forgetSettings, loadPref, loadSettings, normalizeUrl, savePref, saveSettings, type Settings,
} from './storage';

const REFRESH_MS = 60_000;
const GRAPH_HOURS = [3, 6, 12, 24];
const LIST_HOURS = [2, 6, 24];

type Children = (Node | string | null | false)[];

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: Children
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const c of children) if (c) node.append(c);
  return node;
}

export class App {
  private settings: Settings | null = loadSettings();
  private data: Data | null = null;
  private error: string | null = null;
  private loading = false;
  private view: 'setup' | 'main' = 'setup';
  private timer: number | undefined;
  private graphHours = loadPref('graphHours', 6);
  private listHours = loadPref('listHours', 6);

  constructor(private readonly root: HTMLElement) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh();
    });
    window.addEventListener('resize', () => this.renderGraphOnly());
  }

  start(): void {
    if (this.settings) {
      this.renderMain();
      this.refresh();
    } else {
      this.renderSetup();
    }
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), REFRESH_MS);
  }

  private async refresh(): Promise<void> {
    if (!this.settings || this.loading) return;
    this.loading = true;
    this.renderStatus();
    try {
      this.data = await fetchData(this.settings);
      this.error = null;
    } catch (e) {
      this.error = e instanceof NightscoutError ? e.message : `Refresh failed: ${String(e)}`;
    } finally {
      this.loading = false;
      this.schedule();
    }
    if (this.view === 'main') this.renderMain();
  }

  // ---- Setup ----

  private renderSetup(message = ''): void {
    this.view = 'setup';
    window.clearTimeout(this.timer);
    const url = h('input', {
      type: 'url', id: 'ns-url', placeholder: 'https://your-site.example.com',
      value: this.settings?.url ?? '', required: true,
    });
    const token = h('input', {
      type: 'password', id: 'ns-token', placeholder: 'e.g. widget-1a2b3c4d…', autocomplete: 'off',
      value: this.settings?.token ?? '', required: true,
    });
    const status = h('p', { class: 'form-status', role: 'status' }, message);
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Save and connect');
    const form = h('form', { class: 'card setup' },
      h('h2', {}, 'Connect to Nightscout'),
      h('label', { htmlFor: 'ns-url' }, 'Nightscout URL'),
      url,
      h('label', { htmlFor: 'ns-token' }, 'Read-only access token'),
      token,
      h('p', { class: 'hint' },
        'Create one in Nightscout under Admin Tools → Subjects with the "readable" role. ',
        h('strong', {}, 'Don\'t use your API secret'),
        ': it allows writing, and this page keeps the token in this browser\'s storage.'),
      submit,
      status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const candidate = { url: normalizeUrl(url.value), token: token.value.trim() };
      submit.disabled = true;
      status.textContent = 'Testing…';
      try {
        const data = await fetchData(candidate);
        const persisted = saveSettings(candidate);
        this.settings = candidate;
        this.data = data;
        this.error = null;
        this.renderMain(persisted ? null : 'Browser storage is unavailable; settings last for this visit only.');
        this.schedule();
      } catch (err) {
        status.textContent = err instanceof NightscoutError ? err.message : `Couldn't connect: ${String(err)}`;
        submit.disabled = false;
      }
    });
    this.root.replaceChildren(this.header(false), form);
  }

  // ---- Main view ----

  private header(withControls: boolean): HTMLElement {
    const status = h('span', { class: 'status', id: 'status', role: 'status' });
    const controls = withControls
      ? h('div', { class: 'header-actions' },
        status,
        h('button', { class: 'icon', title: 'Refresh', ariaLabel: 'Refresh', onclick: () => this.refresh() }, '⟳'),
        h('button', { class: 'icon', title: 'Settings', ariaLabel: 'Settings', onclick: () => this.renderSettings() }, '⚙'))
      : null;
    return h('header', { class: 'app-header' }, h('h1', {}, 'Leveling Up'), controls);
  }

  private renderStatus(): void {
    const status = document.getElementById('status');
    if (!status || this.view !== 'main') return;
    if (this.loading) status.textContent = 'Updating…';
    else if (this.data) status.textContent = `Updated ${formatClock(this.data.fetchedMs)}`;
    else status.textContent = '';
  }

  private renderSettings(): void {
    const forget = h('button', { type: 'button', class: 'danger' }, 'Forget these settings');
    forget.addEventListener('click', () => {
      forgetSettings();
      this.settings = null;
      this.data = null;
      this.renderSetup('Settings removed from this browser.');
    });
    this.renderSetup();
    this.root.querySelector('form')?.append(
      h('p', { class: 'hint' }, `Connected to ${this.settings ? new URL(this.settings.url).host : '—'}.`),
      forget,
      h('button', { type: 'button', onclick: () => this.renderMain() }, 'Back'));
    if (this.data) this.schedule();
  }

  private renderMain(notice: string | null = null): void {
    this.view = 'main';
    const data = this.data;
    const parts: Children = [this.header(true)];
    if (notice) parts.push(h('p', { class: 'banner' }, notice));
    if (this.error) parts.push(h('p', { class: 'banner error', role: 'alert' }, this.error));
    if (!data) {
      parts.push(h('p', { class: 'card muted' }, this.loading ? 'Loading…' : 'No data yet.'));
      this.root.replaceChildren(...parts.filter((p): p is Node | string => !!p));
      this.renderStatus();
      return;
    }
    parts.push(this.widgetCard(data), this.graphSection(), this.bolusSection(data), this.pumpSection(data),
      h('p', { class: 'app-footer small' }, h('a', { href: './statusz/' }, 'Status')));
    this.root.replaceChildren(...parts.filter((p): p is Node | string => !!p));
    this.renderStatus();
    this.renderGraphOnly();
  }

  /** Mirrors the Android widget. */
  private widgetCard(data: Data): HTMLElement {
    const now = data.fetchedMs;
    const g = data.glucose;
    const card = h('section', { class: 'card widget', ariaLabel: 'Now' });
    if (g) {
      const stale = isStale(g, now);
      card.append(
        h('div', { class: 'bg-row' },
          h('span', { class: `bg${stale ? ' stale' : ''}` }, `${g.mgdl} ${arrow(g.direction)}`),
          h('span', { class: 'bg-meta' }, `${formatDelta(g.delta)}  ${formatAge(g.timeMs, now)}`)),
        h('div', { class: 'iob' }, formatIob(g.iob)));
    } else {
      card.append(h('div', { class: 'iob' }, 'No glucose data'));
    }
    const boluses = bolusesIn(data, BOLUS_WINDOW_MINUTES / 60);
    card.append(boluses.length
      ? this.bolusList(boluses)
      : h('p', { class: 'muted small' }, 'No boluses in last 2h'));
    card.append(this.freshnessLine(data));
    return card;
  }

  /** Pump -> Tandem and Tandem -> Nightscout freshness; mirrors the widget footer. */
  private freshnessLine(data: Data): HTMLElement {
    if (!data.sync) {
      return h('p', { class: 'muted small' },
        data.pumpDataMs ? `Pump data ${formatAge(data.pumpDataMs, data.fetchedMs)} old` : 'No pump data');
    }
    const { text, stale } = formatSyncStatus(data.sync, data.fetchedMs);
    return h('p', { class: `small freshness${stale ? ' stale' : ''}` }, stale ? `⚠ ${text}` : text);
  }

  private bolusList(boluses: Bolus[]): HTMLElement {
    return h('ul', { class: 'boluses' }, ...boluses.map((b) => {
      const detail = formatBolusDetail(b);
      return h('li', { class: b.automatic ? 'auto' : 'manual' },
        h('span', { class: 'marker', ariaHidden: 'true' }),
        h('span', { class: 'time' }, formatClock(b.timeMs)),
        h('span', { class: 'line1' }, formatBolus(b)),
        detail ? h('span', { class: 'line2' }, detail) : null);
    }));
  }

  private segmented(name: string, options: number[], current: number, onPick: (v: number) => void): HTMLElement {
    return h('div', { class: 'segmented', role: 'group', ariaLabel: name },
      ...options.map((v) => h('button', {
        type: 'button', className: v === current ? 'on' : '', ariaPressed: String(v === current),
        onclick: () => onPick(v),
      }, `${v}h`)));
  }

  private graphSection(): HTMLElement {
    return h('section', { class: 'card' },
      h('div', { class: 'section-head' },
        h('h2', {}, 'Glucose'),
        this.segmented('Graph range', GRAPH_HOURS, this.graphHours, (v) => {
          this.graphHours = v;
          savePref('graphHours', v);
          this.renderMain();
        })),
      h('div', { class: 'graph-host', id: 'graph' }),
      h('div', { class: 'legend' },
        h('span', { class: 'key key-line' }, 'Glucose'),
        h('span', { class: 'key key-manual' }, 'Manual bolus'),
        h('span', { class: 'key key-auto' }, 'Auto bolus'),
        h('span', { class: 'key key-band' }, `Target ${TARGET_LOW}–${TARGET_HIGH}`),
        h('span', { class: 'key key-upload' }, 'Pump → Tandem upload'),
        h('span', { class: 'key key-sync' }, 'Nightscout sync'),
        h('span', { class: 'key key-pending' }, 'Not uploaded yet')));
  }

  private renderGraphOnly(): void {
    const host = document.getElementById('graph');
    if (!host || !this.data) return;
    const sync = this.data.sync;
    renderGraph(host, this.data.readings, bolusesIn(this.data, this.graphHours), this.graphHours,
      this.data.fetchedMs, sync || this.data.uploads.length
        ? { uploads: this.data.uploads, newestEventMs: sync?.newestEventMs ?? null, syncedMs: sync?.syncedMs ?? null }
        : null);
  }

  private bolusSection(data: Data): HTMLElement {
    const boluses = bolusesIn(data, this.listHours);
    const insulin = boluses.reduce((sum, b) => sum + b.delivered, 0);
    const carbs = boluses.reduce((sum, b) => sum + b.carbs, 0);
    return h('section', { class: 'card' },
      h('div', { class: 'section-head' },
        h('h2', {}, 'Boluses'),
        this.segmented('Bolus range', LIST_HOURS, this.listHours, (v) => {
          this.listHours = v;
          savePref('listHours', v);
          this.renderMain();
        })),
      boluses.length
        ? h('p', { class: 'muted small' },
          `${boluses.length} entries · ${insulin.toFixed(1)}U delivered · ${carbs}g carbs`)
        : null,
      boluses.length ? this.bolusList(boluses) : h('p', { class: 'muted' }, `None in the last ${this.listHours}h.`));
  }

  private pumpSection(data: Data): HTMLElement {
    const state = pumpStateIn(data, 24);
    const rows: [string, Children][] = [];

    if (state.basal) {
      const profile = state.profileRate !== null && Math.abs(state.profileRate - state.basal.rate) >= 0.001
        ? ` · profile ${parseFloat(state.profileRate.toFixed(3))}`
        : '';
      rows.push(['Basal', [h('strong', {}, formatRate(state.basal.rate)), `${profile} · as of ${formatClock(state.basal.startMs)}`]]);
    } else {
      rows.push(['Basal', ['No data']]);
    }

    const m = state.mode;
    rows.push(['Control-IQ', [m
      ? (m.open ? `${m.kind} since ${formatClock(m.startMs)}` : `${m.kind} ${formatClock(m.startMs)}–${formatClock(m.endMs)}`)
      : 'Normal']]);

    state.suspensions.forEach((s, i) => {
      const length = s.resumedMs ? `for ${formatDuration((s.resumedMs - s.startMs) / 60_000)}` : 'not resumed';
      rows.push([i === 0 ? 'Suspended' : '', [`${dayPrefix(s.startMs, data.fetchedMs)}${formatClock(s.startMs)} ${length}${suspensionReason(s.reason)}`]]);
    });

    return h('section', { class: 'card' }, h('h2', {}, 'Basal & Control-IQ'),
      h('dl', { class: 'facts' }, ...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, ...value)])));
  }
}

/** " · alarm" for pump reason codes we can name; empty otherwise. */
function suspensionReason(reason: string): string {
  const known: Record<string, string> = { TerminatedByAlarm: 'alarm', UserSuspended: 'by user' };
  const text = known[reason] ?? reason;
  return text ? ` · ${text}` : '';
}

/** "Yesterday " for times on the previous local day; empty for today. */
function dayPrefix(timeMs: number, nowMs: number): string {
  const day = (ms: number) => new Date(ms).toDateString();
  return day(timeMs) === day(nowMs) ? '' : 'Yesterday ';
}
