import { describe, expect, it } from 'vitest';

import {
  formatAge, formatDelta, formatDuration, formatIob, formatRate, isStale, u,
} from '../src/format';
import {
  latestTreatmentMs, parseBasalSpans, parseEntries, parsePebble, parsePumpState, parseUploadHistory,
  profileSpans, scheduledBasal, spanAt,
  treatmentTimeMs,
  type ProfileDoc,
} from '../src/model';
import { normalizeUrl } from '../src/storage';

const ms = (iso: string) => Date.parse(iso);

const PROFILE: ProfileDoc = {
  defaultProfile: 'frog',
  store: {
    frog: {
      timezone: 'America/Los_Angeles',
      basal: [
        { timeAsSeconds: 0, value: 0.4 },
        { timeAsSeconds: 7200, value: 0.35 },
        { timeAsSeconds: 32400, value: 0.7 },
        { timeAsSeconds: 43200, value: 0.65 },
      ],
    },
  },
};

describe('parsePebble', () => {
  it('reads glucose, delta and IOB', () => {
    const json = {
      bgs: [{ sgv: '121', direction: 'SingleDown', datetime: 1792260622255, bgdelta: -12, iob: '0.47' }],
    };
    expect(parsePebble(json)).toEqual({
      mgdl: 121, direction: 'SingleDown', delta: -12, timeMs: 1792260622255, iob: 0.47,
    });
  });

  it('handles missing data', () => {
    expect(parsePebble({ bgs: [{ sgv: '89', datetime: 1, bgdelta: '4.0' }] }))
      .toEqual({ mgdl: 89, direction: '', delta: 4, timeMs: 1, iob: null });
    expect(parsePebble({ bgs: [] })).toBeNull();
    expect(parsePebble({})).toBeNull();
    expect(parsePebble(null)).toBeNull();
  });
});

describe('treatmentTimeMs', () => {
  it('requires a timezone so times are never guessed', () => {
    expect(treatmentTimeMs({ created_at: '2026-10-17T18:01:27.000Z' })).toBe(ms('2026-10-17T18:01:27Z'));
    expect(treatmentTimeMs({ created_at: '2026-10-17 11:00:00-07:00' })).toBe(ms('2026-10-17T18:00:00Z'));
    expect(treatmentTimeMs({ created_at: '2026-10-17T11:00:00' })).toBeNull();
    expect(treatmentTimeMs({ mills: 5 })).toBe(5);
  });
});

describe('parseEntries', () => {
  it('sorts oldest first and drops bad rows', () => {
    expect(parseEntries([{ date: 2, sgv: 120 }, { date: 1, sgv: 100 }, { date: 3 }, { date: 4, sgv: 0 }]))
      .toEqual([{ timeMs: 1, mgdl: 100 }, { timeMs: 2, mgdl: 120 }]);
    expect(parseEntries('nope')).toEqual([]);
  });
});

describe('basal and pump state', () => {
  it('looks up the scheduled rate in the profile timezone', () => {
    // 01:00 and 10:00 Los Angeles (PDT, UTC-7).
    expect(scheduledBasal(PROFILE, ms('2026-10-17T08:00:00Z'))).toBe(0.4);
    expect(scheduledBasal(PROFILE, ms('2026-10-17T17:00:00Z'))).toBe(0.7);
    expect(scheduledBasal(null, 0)).toBeNull();
  });

  it('summarizes basal, mode and suspensions', () => {
    const now = ms('2026-10-17T19:00:00Z');
    const treatments = [
      { eventType: 'Temp Basal', created_at: '2026-10-17T18:01:27.000Z', absolute: 0.41, duration: 3.4 },
      { eventType: 'Temp Basal', created_at: '2026-10-17T17:56:28.000Z', absolute: 0.52, duration: 5 },
      { eventType: 'Exercise', created_at: '2026-10-17T16:26:52.000Z', duration: 97.9, reason: 'Exercise - Not Ended' },
      { eventType: 'Sleep', created_at: '2026-10-17T07:32:17.000Z', duration: 359.2, reason: 'Sleep (Manual)' },
      { eventType: 'Basal Suspension', created_at: '2026-10-16T22:06:01.000Z', reason: 'TerminatedByAlarm' },
      { eventType: 'Basal Resume', created_at: '2026-10-16T22:06:38.000Z', reason: 'Basal resumed' },
    ];
    const state = parsePumpState(treatments, PROFILE, now, 24 * 60);
    expect(state.basal).toEqual({ rate: 0.41, startMs: ms('2026-10-17T18:01:27Z'), durationMinutes: 3.4 });
    expect(state.profileRate).toBe(0.7);
    expect(state.mode).toMatchObject({ kind: 'Exercise', open: true });
    expect(state.suspensions).toEqual([{
      startMs: ms('2026-10-16T22:06:01Z'), reason: 'TerminatedByAlarm', resumedMs: ms('2026-10-16T22:06:38Z'),
    }]);
  });

  it('reports no mode once the last one ended before the pump data', () => {
    const treatments = [
      { eventType: 'Temp Basal', created_at: '2026-10-17T18:00:00Z', absolute: 0.5, duration: 5 },
      { eventType: 'Sleep', created_at: '2026-10-17T07:32:17Z', duration: 359.2, reason: 'Sleep (Manual)' },
    ];
    expect(parsePumpState(treatments, PROFILE, ms('2026-10-17T19:00:00Z'), 1440).mode).toBeNull();
  });

  it('finds the newest pump treatment of a type', () => {
    const treatments = [
      { eventType: 'Temp Basal', created_at: '2026-10-17T18:01:27Z', enteredBy: 'Pump (tconnectsync)' },
      { eventType: 'Temp Basal', created_at: '2026-10-17T19:00:00Z', enteredBy: 'someone else' },
    ];
    expect(latestTreatmentMs(treatments, 'Temp Basal')).toBe(ms('2026-10-17T18:01:27Z'));
    expect(latestTreatmentMs([], 'Temp Basal')).toBeNull();
  });
});

describe('formatting', () => {
  it('rounds half up to tenths like the widget', () => {
    expect(u(0.35000000000000009)).toBe('0.4');
    expect(u(2.35)).toBe('2.4');
    expect(u(0.795)).toBe('0.8');
    expect(u(-0.04)).toBe('0.0');
  });

  it('formats small values', () => {
    expect(formatDelta(4)).toBe('+4');
    expect(formatDelta(-12)).toBe('-12');
    expect(formatDelta(null)).toBe('');
    expect(formatAge(10_000_000 - 7 * 60_000, 10_000_000)).toBe('7m');
    expect(formatAge(10_000_000 - 125 * 60_000, 10_000_000)).toBe('2h 5m');
    expect(formatAge(10_000_000 + 60_000, 10_000_000)).toBe('now');
    expect(formatDuration(97.9)).toBe('1h 38m');
    expect(formatIob(1.54)).toBe('IOB 1.5U');
    expect(formatIob(null)).toBe('IOB --');
    expect(formatRate(0.4)).toBe('0.4 U/hr');
    expect(formatRate(0.275)).toBe('0.275 U/hr');
  });

  it('marks stale glucose', () => {
    const now = 100 * 60_000;
    const g = { mgdl: 100, direction: 'Flat', delta: 0, iob: null };
    expect(isStale({ ...g, timeMs: now - 5 * 60_000 }, now)).toBe(false);
    expect(isStale({ ...g, timeMs: now - 13 * 60_000 }, now)).toBe(true);
  });
});

describe('normalizeUrl', () => {
  it('adds https and trims slashes', () => {
    expect(normalizeUrl(' example.com/ ')).toBe('https://example.com');
    expect(normalizeUrl('http://x.test//')).toBe('http://x.test');
  });
});

describe('parseUploadHistory', () => {
  it('collapses repeated uploads and keeps the furthest data point', () => {
    const rec = (created: string, uploaded: string | null, newest: string | null) => ({
      device: 'leveling-up', created_at: created,
      levelingUp: { tandem: { pumpUploadedAt: uploaded, newestEventAt: newest } },
    });
    expect(parseUploadHistory([
      rec('2026-10-17T19:46:00Z', '2026-10-17T19:06:48+00:00', '2026-10-17T12:06:31-07:00'),
      rec('2026-10-17T19:31:00Z', '2026-10-17T19:06:48+00:00', null),
      rec('2026-10-17T19:00:00Z', '2026-10-17T18:05:00+00:00', '2026-10-17T11:04:00-07:00'),
      rec('2026-10-17T18:45:00Z', null, null),
      { device: 'openaps://x', created_at: '2026-10-17T19:00:00Z' },
    ])).toEqual([
      { uploadedMs: ms('2026-10-17T18:05:00Z'), newestEventMs: ms('2026-10-17T18:04:00Z') },
      { uploadedMs: ms('2026-10-17T19:06:48Z'), newestEventMs: ms('2026-10-17T19:06:31Z') },
    ]);
    expect(parseUploadHistory(null)).toEqual([]);
  });
});

describe('basal spans', () => {
  it('ends each span at its duration or the next start', () => {
    const spans = parseBasalSpans([
      { eventType: 'Temp Basal', created_at: '2026-10-17T18:05:00Z', absolute: 0.41, duration: 10 },
      { eventType: 'Temp Basal', created_at: '2026-10-17T18:00:00Z', absolute: 0.52, duration: 5 },
      { eventType: 'Temp Basal', created_at: '2026-10-17T17:50:00Z', absolute: 0, duration: 30 },
      { eventType: 'Combo Bolus', created_at: '2026-10-17T17:55:00Z', insulin: 1 },
    ]);
    expect(spans).toEqual([
      { startMs: ms('2026-10-17T17:50:00Z'), endMs: ms('2026-10-17T18:00:00Z'), rate: 0 },
      { startMs: ms('2026-10-17T18:00:00Z'), endMs: ms('2026-10-17T18:05:00Z'), rate: 0.52 },
      { startMs: ms('2026-10-17T18:05:00Z'), endMs: ms('2026-10-17T18:15:00Z'), rate: 0.41 },
    ]);
    expect(spanAt(spans, ms('2026-10-17T18:07:00Z'))?.rate).toBe(0.41);
    expect(spanAt(spans, ms('2026-10-17T18:20:00Z'))).toBeNull();
  });

  it('turns the profile schedule into merged spans in its timezone', () => {
    // 01:30–03:00 Los Angeles: 0.4 until 02:00, then 0.35.
    expect(profileSpans(PROFILE, ms('2026-10-17T08:30:00Z'), ms('2026-10-17T10:00:00Z'))).toEqual([
      { startMs: ms('2026-10-17T08:30:00Z'), endMs: ms('2026-10-17T09:00:00Z'), rate: 0.4 },
      { startMs: ms('2026-10-17T09:00:00Z'), endMs: ms('2026-10-17T10:00:00Z'), rate: 0.35 },
    ]);
    expect(profileSpans(null, 0, 3_600_000)).toEqual([]);
  });
});
