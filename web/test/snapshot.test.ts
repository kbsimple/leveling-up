// Replays the obfuscated real-data snapshot in fixtures/snapshot/ through the
// same fetch and parsing code the site uses. Widget-facing expectations live in
// expected.json, which the Android tests also check.

import { afterEach, describe, expect, it, vi } from 'vitest';

import devicestatus from '../../fixtures/snapshot/devicestatus.json';
import entries from '../../fixtures/snapshot/entries.json';
import expected from '../../fixtures/snapshot/expected.json';
import pebble from '../../fixtures/snapshot/pebble.json';
import profile from '../../fixtures/snapshot/profile.json';
import snapshot from '../../fixtures/snapshot/snapshot.json';
import treatmentsJson from '../../fixtures/snapshot/treatments.json';
import { formatBolus, formatBolusDetail, formatSyncStatus } from '../src/format';
import { modePeriods, parseBasalSpans, parseBoluses, tempPeriods, treatmentTimeMs, type Treatment } from '../src/model';
import { bolusesIn, fetchData, pumpStateIn, type Data } from '../src/nightscout';

const fetchedMs = Date.parse(snapshot.fetchedAt);
const treatments = treatmentsJson as Treatment[];
const files: Record<string, unknown> = { pebble, entries, treatments, profile, devicestatus };
const iso = (ms: number) => new Date(ms).toISOString();

/** Serves the snapshot files for the site's Nightscout requests. */
async function fetchSnapshot(): Promise<Data> {
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const { pathname } = new URL(String(input));
    const name = pathname === '/pebble' ? 'pebble'
      : pathname.includes('/entries') ? 'entries'
        : pathname.includes('/treatments') ? 'treatments'
          : pathname.includes('/profile') ? 'profile' : 'devicestatus';
    return new Response(JSON.stringify(files[name]), { status: 200 });
  });
  return fetchData({ url: 'https://ns.example', token: 'read-token' }, fetchedMs);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('snapshot: widget parity', () => {
  it('reads current glucose and IOB', async () => {
    const data = await fetchSnapshot();
    expect(data.glucose).toMatchObject(expected.glucose);
  });

  for (const view of expected.views) {
    it(view.name, () => {
      const now = Date.parse(view.now);
      // Replaying an earlier moment: only treatments recorded by then.
      const known = treatments.filter((t) => treatmentTimeMs(t)! <= now);
      const lines = parseBoluses(known, now, view.windowMinutes)
        .map((b) => ({ line1: formatBolus(b), line2: formatBolusDetail(b) }));
      expect(lines).toEqual(view.boluses);
    });
  }

  it('summarizes freshness', async () => {
    const data = await fetchSnapshot();
    const view = expected.views.find((v) => v.sync)!;
    expect(formatSyncStatus(data.sync!, Date.parse(view.now))).toEqual(view.sync);
  });
});

describe('snapshot: site', () => {
  it('loads every collection', async () => {
    const data = await fetchSnapshot();
    expect(data.readings).toHaveLength(286);
    expect(data.readings[0].timeMs).toBeLessThan(data.readings.at(-1)!.timeMs);
    expect(data.treatments).toHaveLength(304);
    expect(data.uploads).toHaveLength(9);
    expect(data.sync).toMatchObject({ uploadClient: 'mobile_mobi' });
    expect(bolusesIn(data, 24)).toHaveLength(12);
  });

  it('finds the two overnight temp rates', () => {
    const periods = tempPeriods(parseBasalSpans(treatments)).map((p) => ({
      start: iso(p.startMs), end: iso(p.endMs), rate: p.rate, percent: p.percent, open: p.open,
    }));
    expect(periods).toEqual([
      { start: '2026-07-01T05:55:42.000Z', end: '2026-07-01T06:15:43.000Z', rate: 0.85, percent: 200, open: false },
      { start: '2026-07-01T07:35:48.000Z', end: '2026-07-01T08:50:53.000Z', rate: 0.1, percent: 25, open: false },
    ]);
  });

  it('finds sleep and exercise periods', () => {
    const spans = parseBasalSpans(treatments);
    const periods = modePeriods(treatments, spans.at(-1)!.endMs).map((p) => ({
      kind: p.kind, start: iso(p.startMs), end: iso(p.endMs), open: p.open, detail: p.detail,
    }));
    expect(periods).toEqual([
      { kind: 'Sleep', start: '2026-07-01T07:32:17.000Z', end: '2026-07-01T13:31:30.000Z', open: false, detail: 'manual' },
      { kind: 'Exercise', start: '2026-07-01T16:26:52.000Z', end: '2026-07-01T19:56:34.000Z', open: false, detail: '' },
      { kind: 'Exercise', start: '2026-07-01T20:08:00.000Z', end: '2026-07-02T00:47:53.000Z', open: false, detail: '' },
    ]);
  });

  it('reports the pump state as of the last upload', async () => {
    const state = pumpStateIn(await fetchSnapshot(), 24);
    expect(state.basal).toMatchObject({ rate: 0.6 });
    expect(state.mode).toBeNull();
    expect(state.suspensions).toEqual([]);
  });
});
