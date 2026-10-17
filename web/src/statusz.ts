// /statusz: service identity (from the build) plus live checks run in this
// browser. Follows the Service Status layout used across kbsimple projects.

import './style.css';
import { BUILD } from './buildinfo';
import { loadSettings, type Settings } from './storage';

interface Check {
  ok: boolean;
  detail: string;
}

function storageCheck(): Check {
  try {
    const key = 'leveling-up.statusz-probe';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return { ok: true, detail: 'Available' };
  } catch {
    return { ok: false, detail: 'Unavailable (settings last for one visit)' };
  }
}

async function timed(url: string): Promise<{ resp: Response; ms: number }> {
  const start = performance.now();
  const resp = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  return { resp, ms: Math.round(performance.now() - start) };
}

/** Reachability and Nightscout version, then whether the token can read. */
async function nightscoutChecks(settings: Settings): Promise<{ reach: Check; auth: Check }> {
  const base = settings.url;
  const token = encodeURIComponent(settings.token);
  let reach: Check;
  try {
    const { resp, ms } = await timed(`${base}/api/v1/status.json?token=${token}`);
    const body = resp.ok ? await resp.json() as { version?: string } : null;
    reach = resp.ok
      ? { ok: true, detail: `Reachable — ${ms}ms · Nightscout ${body?.version ?? '?'}` }
      : { ok: false, detail: `HTTP ${resp.status} — ${ms}ms` };
  } catch {
    return {
      reach: { ok: false, detail: 'Unreachable' },
      auth: { ok: false, detail: 'Not checked' },
    };
  }
  try {
    const { resp } = await timed(`${base}/api/v1/verifyauth?token=${token}`);
    const body = await resp.json() as { message?: { canRead?: boolean; canWrite?: boolean } };
    const m = body.message ?? {};
    const auth: Check = !m.canRead
      ? { ok: false, detail: 'Token cannot read' }
      : m.canWrite
        ? { ok: false, detail: 'Token can WRITE; use a read-only token' }
        : { ok: true, detail: 'Read-only' };
    return { reach, auth };
  } catch {
    return { reach, auth: { ok: false, detail: 'Check failed' } };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function section(title: string, rows: [string, string | Check][]): HTMLElement {
  const card = el('section', 'card statusz');
  card.append(el('h2', 'statusz-title', title));
  const table = el('table');
  for (const [label, value] of rows) {
    const tr = el('tr');
    tr.append(el('th', '', label));
    const td = el('td');
    if (typeof value === 'string') {
      td.textContent = value;
    } else {
      const dot = el('span', `dot ${value.ok ? 'ok' : 'bad'}`);
      dot.setAttribute('aria-label', value.ok ? 'OK' : 'Error');
      td.append(dot, document.createTextNode(value.detail));
    }
    tr.append(td);
    table.append(tr);
  }
  card.append(table);
  return card;
}

async function render(root: HTMLElement): Promise<void> {
  const settings = loadSettings();
  const ok: Check = { ok: true, detail: 'ok' };
  const header = el('header', 'app-header');
  header.append(el('h1', '', 'Service Status'));
  const sub = el('p', 'muted small', 'No authentication required');

  const build = section('Identity', [
    ['service', BUILD.service],
    ['status', ok],
    ['version', BUILD.version],
    ['release date', BUILD.releaseDate],
    ['built', BUILD.builtAt],
    ['commit', `${BUILD.commitShort} (${BUILD.commit})`],
    ['branch', BUILD.branch],
    ['context', BUILD.context],
  ]);
  const runtime = section('Runtime (this browser)', [
    ['browser storage', storageCheck()],
    ['online', navigator.onLine ? { ok: true, detail: 'Yes' } : { ok: false, detail: 'No' }],
    ['color scheme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'],
    ['user agent', navigator.userAgent],
  ]);
  const nsRows: [string, string | Check][] = settings
    ? [['site', new URL(settings.url).host], ['reachability', 'Checking…'], ['token', 'Checking…']]
    : [['configured', { ok: false, detail: 'No Nightscout settings in this browser' }]];
  let nightscout = section('Nightscout', nsRows);
  const features = section('Features', Object.entries(BUILD.features)
    .map(([name, on]) => [name, on ? { ok: true, detail: 'enabled' } : { ok: false, detail: 'disabled' }]));
  const deps = section('Dependencies', Object.entries(BUILD.deps));
  const back = el('p', 'muted small center');
  const link = el('a', '', '← Dashboard');
  link.href = '../';
  back.append(link);

  root.replaceChildren(header, sub, build, nightscout, runtime, features, deps, back);

  if (settings) {
    const { reach, auth } = await nightscoutChecks(settings);
    const updated = section('Nightscout', [
      ['site', new URL(settings.url).host], ['reachability', reach], ['token', auth],
    ]);
    nightscout.replaceWith(updated);
    nightscout = updated;
  }
}

render(document.getElementById('app')!);
