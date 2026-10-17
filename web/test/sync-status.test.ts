// Runs fixtures/sync-status-cases.json, which the Android widget's tests also run.
import { describe, expect, it } from 'vitest';

import fixtures from '../../fixtures/sync-status-cases.json';
import { formatSyncStatus } from '../src/format';
import { parseSyncStatus } from '../src/model';

interface Case {
  name: string;
  now: string;
  devicestatus: unknown[];
  expected: { text: string; stale: boolean } | null;
}

describe('shared sync status fixtures', () => {
  const cases = (fixtures as { cases: Case[] }).cases;

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const status = parseSyncStatus(c.devicestatus);
    expect(status === null ? null : formatSyncStatus(status, Date.parse(c.now))).toEqual(c.expected);
  });
});
