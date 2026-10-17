// Read-only Nightscout client. Uses the `token` query parameter; the site
// never needs the API secret.

import {
  latestTreatmentMs, parseBoluses, parseEntries, parsePebble, parsePumpState, parseSyncStatus,
  parseUploadHistory, type Bolus, type Glucose, type ProfileDoc, type PumpState, type PumpUpload,
  type Reading, type SyncStatus, type Treatment,
} from './model';
import type { Settings } from './storage';

/** The widest window any view offers; fetched once per refresh. */
export const MAX_WINDOW_HOURS = 24;

export class NightscoutError extends Error {}

export interface Data {
  fetchedMs: number;
  glucose: Glucose | null;
  readings: Reading[];
  treatments: Treatment[];
  profile: ProfileDoc | null;
  pumpDataMs: number | null;
  /** Freshness published by leveling-up's sync; null if none. */
  sync: SyncStatus | null;
  /** Distinct pump -> Tandem uploads in the window, oldest first. */
  uploads: PumpUpload[];
}

async function get(settings: Settings, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${settings.url}/${path}`);
  for (const [k, v] of Object.entries({ ...params, token: settings.token })) url.searchParams.set(k, v);
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new NightscoutError(`Can't reach ${new URL(settings.url).host}`);
  }
  if (resp.status === 401) throw new NightscoutError('Nightscout rejected the token (401)');
  if (!resp.ok) throw new NightscoutError(`Nightscout HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchData(settings: Settings, nowMs = Date.now()): Promise<Data> {
  const since = nowMs - MAX_WINDOW_HOURS * 3_600_000;
  const [pebble, entries, treatments, profiles, devicestatus] = await Promise.all([
    get(settings, 'pebble'),
    get(settings, 'api/v1/entries/sgv.json', { 'find[date][$gte]': String(since), count: '400' }),
    get(settings, 'api/v1/treatments.json', {
      'find[created_at][$gte]': new Date(since).toISOString(), count: '1500',
    }),
    get(settings, 'api/v1/profile.json', { count: '1' }),
    // One record per Tandem sync run (every 5-15 min), kept for 26h by the service.
    get(settings, 'api/v1/devicestatus.json', {
      'find[device]': 'leveling-up', 'find[created_at][$gte]': new Date(since).toISOString(), count: '400',
    }),
  ]);
  const list = Array.isArray(treatments) ? (treatments as Treatment[]) : [];
  return {
    fetchedMs: nowMs,
    glucose: parsePebble(pebble),
    readings: parseEntries(entries),
    treatments: list,
    profile: Array.isArray(profiles) && profiles.length ? (profiles[0] as ProfileDoc) : null,
    pumpDataMs: latestTreatmentMs(list, 'Temp Basal'),
    sync: parseSyncStatus(devicestatus),
    uploads: parseUploadHistory(devicestatus),
  };
}

export function bolusesIn(data: Data, hours: number): Bolus[] {
  return parseBoluses(data.treatments, data.fetchedMs, hours * 60);
}

export function pumpStateIn(data: Data, hours: number): PumpState {
  return parsePumpState(data.treatments, data.profile, data.fetchedMs, hours * 60);
}
