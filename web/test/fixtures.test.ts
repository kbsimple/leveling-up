// Runs fixtures/bolus-cases.json, which the Android widget's tests also run.
import { describe, expect, it } from 'vitest';

import fixtures from '../../fixtures/bolus-cases.json';
import { formatBolus, formatBolusDetail } from '../src/format';
import { parseBoluses, type Treatment } from '../src/model';

interface Case {
  name: string;
  now: string;
  treatments: Treatment[];
  expected: { line1: string; line2: string | null }[];
}

describe('shared bolus fixtures', () => {
  const cases = (fixtures as { cases: Case[] }).cases;

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const lines = parseBoluses(c.treatments, Date.parse(c.now)).map((b) => ({
      line1: formatBolus(b),
      line2: formatBolusDetail(b),
    }));
    expect(lines).toEqual(c.expected);
  });
});
