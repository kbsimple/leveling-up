// Parsing of Nightscout data. The bolus logic mirrors the Android widget's
// Snapshot.kt; both are checked against fixtures/bolus-cases.json.

/** How far back the widget card lists boluses. */
export const BOLUS_WINDOW_MINUTES = 120;

/** Who tconnectsync records as the author of pump treatments. */
export const PUMP_ENTERED_BY = 'Pump (tconnectsync)';

export interface Glucose {
  mgdl: number;
  direction: string;
  delta: number | null;
  timeMs: number;
  iob: number | null;
}

/**
 * One bolus as shown. Calculator fields come from leveling-up's sync and are
 * null for older treatments. `insulin` is the requested total (now + extended);
 * `delivered` is what has been delivered so far.
 */
export interface Bolus {
  timeMs: number;
  insulin: number;
  carbs: number;
  automatic: boolean;
  delivered: number;
  food: number | null;
  correction: number | null;
  suggested: number | null;
  extended: number | null;
  extendedMinutes: number | null;
  declinedCorrection: boolean;
  completion: string | null;
}

export interface Reading {
  timeMs: number;
  mgdl: number;
}

/** A Nightscout treatment; only the fields we read. */
export type Treatment = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/** Treatment time in epoch ms, from `mills` or a zoned `created_at`; null if unparseable. */
export function treatmentTimeMs(t: Treatment): number | null {
  const mills = num(t.mills);
  if (mills !== null) return mills;
  const created = typeof t.created_at === 'string' ? t.created_at : '';
  if (!HAS_ZONE.test(created)) return null;
  const ms = Date.parse(created.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isNaN(ms) ? null : ms;
}

/** Parses Nightscout's `/pebble` response (current glucose, delta and IOB). */
export function parsePebble(json: unknown): Glucose | null {
  const bgs = (json as { bgs?: Record<string, unknown>[] } | null)?.bgs;
  if (!Array.isArray(bgs) || bgs.length === 0) return null;
  const bg = bgs[0];
  const mgdl = num(bg.sgv);
  const timeMs = num(bg.datetime);
  if (mgdl === null || timeMs === null) return null;
  const delta = num(bg.bgdelta);
  return {
    mgdl: Math.trunc(mgdl),
    direction: typeof bg.direction === 'string' ? bg.direction : '',
    delta: delta === null ? null : Math.trunc(delta),
    timeMs,
    iob: num(bg.iob),
  };
}

/**
 * Returns boluses and carb entries newer than the window, newest first.
 * Extended-portion treatments are folded into their parent (same `bolusId`).
 */
export function parseBoluses(
  treatments: Treatment[], nowMs: number, windowMinutes = BOLUS_WINDOW_MINUTES,
): Bolus[] {
  const cutoff = nowMs - windowMinutes * 60_000;
  const extendedDelivered = new Map<number, number>();
  for (const t of treatments) {
    const id = num(t.bolusId);
    if (t.extendedPortion === true && id !== null) {
      extendedDelivered.set(id, (extendedDelivered.get(id) ?? 0) + (num(t.insulin) ?? 0));
    }
  }
  const boluses: Bolus[] = [];
  for (const t of treatments) {
    if (t.extendedPortion === true) continue;
    const deliveredNow = num(t.insulin) ?? 0;
    const carbs = Math.trunc(num(t.carbs) ?? 0);
    const time = treatmentTimeMs(t);
    if (time === null || (deliveredNow <= 0 && carbs <= 0) || time < cutoff) continue;
    const id = num(t.bolusId);
    const delivered = deliveredNow + (id !== null ? extendedDelivered.get(id) ?? 0 : 0);
    boluses.push({
      timeMs: time,
      insulin: num(t.requestedInsulin) ?? delivered,
      carbs,
      automatic: typeof t.automatic === 'boolean'
        ? t.automatic
        : typeof t.notes === 'string' && t.notes.includes('Automatic'),
      delivered,
      food: num(t.foodInsulin),
      correction: num(t.correctionInsulin),
      suggested: num(t.suggestedInsulin),
      extended: num(t.extendedInsulin),
      extendedMinutes: num(t.extendedMinutes),
      declinedCorrection: t.declinedCorrection === true,
      completion: typeof t.completion === 'string' && t.completion !== '' ? t.completion : null,
    });
  }
  return boluses.sort((a, b) => b.timeMs - a.timeMs);
}

/** Time of the newest treatment of `eventType` (by the pump, if `pumpOnly`), or null. */
export function latestTreatmentMs(treatments: Treatment[], eventType: string, pumpOnly = true): number | null {
  let latest: number | null = null;
  for (const t of treatments) {
    if (t.eventType !== eventType || (pumpOnly && t.enteredBy !== PUMP_ENTERED_BY)) continue;
    const ms = treatmentTimeMs(t);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** Parses sgv entries into readings, oldest first. */
export function parseEntries(entries: unknown): Reading[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e: Record<string, unknown>) => ({ timeMs: num(e.date), mgdl: num(e.sgv) }))
    .filter((r): r is Reading => r.timeMs !== null && r.mgdl !== null && r.mgdl > 0)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export interface BasalSegment {
  rate: number;
  startMs: number;
  durationMinutes: number;
}

export interface PumpMode {
  kind: 'Sleep' | 'Exercise';
  startMs: number;
  endMs: number;
  /** True when the pump hadn't ended the mode as of its last upload. */
  open: boolean;
}

export interface Suspension {
  startMs: number;
  reason: string;
  resumedMs: number | null;
}

export interface PumpState {
  /** Newest temp basal, i.e. the rate as of the last pump upload. */
  basal: BasalSegment | null;
  /** Scheduled profile rate at the basal segment's time. */
  profileRate: number | null;
  /** Sleep/Exercise mode covering the last pump upload, if any. */
  mode: PumpMode | null;
  /** Suspensions in the window, newest first. */
  suspensions: Suspension[];
}

/** A Nightscout profile document; only the fields we read. */
export interface ProfileDoc {
  defaultProfile?: string;
  store?: Record<string, {
    timezone?: string;
    basal?: { timeAsSeconds?: number | string; value?: number | string }[];
  }>;
}

/** Seconds since local midnight of `timeMs` in `timeZone`. */
function secondsIntoDay(timeMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timeMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

/** The default profile's scheduled basal rate at `timeMs`, or null. */
export function scheduledBasal(profile: ProfileDoc | null, timeMs: number): number | null {
  const store = profile?.defaultProfile ? profile.store?.[profile.defaultProfile] : undefined;
  if (!store?.basal?.length) return null;
  const seconds = secondsIntoDay(timeMs, store.timezone || 'UTC');
  let rate: number | null = null;
  const schedule = store.basal
    .map((b) => ({ at: num(b.timeAsSeconds) ?? 0, value: num(b.value) }))
    .sort((a, b) => a.at - b.at);
  for (const segment of schedule) {
    if (segment.at <= seconds) rate = segment.value;
  }
  return rate;
}

/** Summarizes basal, Control-IQ mode and suspensions from treatments. */
export function parsePumpState(
  treatments: Treatment[], profile: ProfileDoc | null, nowMs: number, windowMinutes: number,
): PumpState {
  const cutoff = nowMs - windowMinutes * 60_000;
  const byTime = treatments
    .map((t) => ({ t, ms: treatmentTimeMs(t) }))
    .filter((x): x is { t: Treatment; ms: number } => x.ms !== null)
    .sort((a, b) => b.ms - a.ms);

  const basalEntry = byTime.find((x) => x.t.eventType === 'Temp Basal');
  const basal = basalEntry
    ? {
      rate: num(basalEntry.t.absolute) ?? num(basalEntry.t.rate) ?? 0,
      startMs: basalEntry.ms,
      durationMinutes: num(basalEntry.t.duration) ?? 0,
    }
    : null;
  const pumpAsOf = basal ? basal.startMs + basal.durationMinutes * 60_000 : nowMs;

  let mode: PumpMode | null = null;
  for (const { t, ms } of byTime) {
    if (t.eventType !== 'Sleep' && t.eventType !== 'Exercise') continue;
    const endMs = ms + (num(t.duration) ?? 0) * 60_000;
    const open = typeof t.reason === 'string' && t.reason.includes('Not Ended');
    if (open || endMs >= pumpAsOf - 60_000) {
      mode = { kind: t.eventType, startMs: ms, endMs, open };
    }
    break;
  }

  const resumes = byTime.filter((x) => x.t.eventType === 'Basal Resume').map((x) => x.ms);
  const suspensions = byTime
    .filter((x) => x.t.eventType === 'Basal Suspension' && x.ms >= cutoff)
    .map(({ t, ms }) => ({
      startMs: ms,
      reason: typeof t.reason === 'string' ? t.reason : '',
      resumedMs: resumes.filter((r) => r >= ms).sort((a, b) => a - b)[0] ?? null,
    }));

  return {
    basal,
    profileRate: basal ? scheduledBasal(profile, basal.startMs) : null,
    mode,
    suspensions,
  };
}

/** Data freshness published by leveling-up's sync (see sync_status.py). */
export interface SyncStatus {
  checkedMs: number;
  /** Last successful Tandem -> Nightscout sync. */
  syncedMs: number | null;
  /** Last pump -> Tandem cloud upload. */
  pumpUploadedMs: number | null;
  /** Newest pump event in Tandem. */
  newestEventMs: number | null;
  uploadClient: string | null;
  error: string | null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !HAS_ZONE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The newest leveling-up freshness record among devicestatus records, or null. */
export function parseSyncStatus(records: unknown): SyncStatus | null {
  if (!Array.isArray(records)) return null;
  let best: { ms: number; tandem: Record<string, unknown> } | null = null;
  for (const r of records as Record<string, unknown>[]) {
    const tandem = (r?.levelingUp as { tandem?: Record<string, unknown> } | undefined)?.tandem;
    const ms = isoMs(r?.created_at);
    if (!tandem || ms === null) continue;
    if (!best || ms > best.ms) best = { ms, tandem };
  }
  if (!best) return null;
  const t = best.tandem;
  return {
    checkedMs: isoMs(t.checkedAt) ?? best.ms,
    syncedMs: isoMs(t.syncedAt),
    pumpUploadedMs: isoMs(t.pumpUploadedAt),
    newestEventMs: isoMs(t.newestEventAt),
    uploadClient: typeof t.uploadClient === 'string' ? t.uploadClient : null,
    error: typeof t.error === 'string' && t.error ? t.error : null,
  };
}
