// Display formatting. The bolus wording mirrors the Android widget's Format.kt;
// both are checked against fixtures/bolus-cases.json.

import type { Bolus, Glucose, SyncStatus } from './model';

/** Glucose older than this is shown as stale. */
export const STALE_GLUCOSE_MINUTES = 12;

/** Differences below this many units are rounding, not a user edit. */
const EDIT_THRESHOLD_UNITS = 0.05;

const ARROWS: Record<string, string> = {
  DoubleUp: '⇈',
  SingleUp: '↑',
  FortyFiveUp: '↗',
  Flat: '→',
  FortyFiveDown: '↘',
  SingleDown: '↓',
  DoubleDown: '⇊',
};

export function arrow(direction: string): string {
  return ARROWS[direction] ?? '';
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '';
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** "now", "7m", "2h 5m". */
export function formatAge(thenMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.trunc((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.trunc(minutes / 60)}h ${minutes % 60}m`;
}

/** Units to one decimal, rounding to tenths first (half up) to match the widget. */
export function u(units: number): string {
  return (Math.round(units * 10) / 10).toFixed(1);
}

/** First line for a bolus: "4.8U · 65g", "0.7U · auto", "18g". */
export function formatBolus(bolus: Bolus): string {
  return [
    bolus.insulin > 0 ? `${u(bolus.insulin)}U` : null,
    bolus.carbs > 0 ? `${bolus.carbs}g` : null,
    bolus.automatic ? 'auto' : null,
  ].filter((p) => p !== null).join(' · ');
}

/**
 * Second line for a bolus, or null when the first line says it all.
 *
 * Avoids repeating what's implied: automatic boluses are always pure
 * correction, and grams on the first line already mark a carb bolus, so the
 * carb/correction split is shown only when both parts are present.
 */
export function formatBolusDetail(bolus: Bolus): string | null {
  const parts: string[] = [];
  const food = bolus.food ?? 0;
  const correction = bolus.correction ?? 0;
  if (!bolus.automatic) {
    if (food > 0 && correction !== 0) {
      parts.push(`${u(food)} carb ${correction > 0 ? '+' : '−'} ${u(Math.abs(correction))} corr`);
    } else if (food === 0 && correction > 0 && bolus.carbs === 0) {
      parts.push('correction');
    }
    if (bolus.declinedCorrection) parts.push('corr declined');
  }
  if (bolus.suggested !== null) {
    const diff = bolus.insulin - bolus.suggested;
    if (Math.abs(diff) >= EDIT_THRESHOLD_UNITS) {
      parts.push(`edited ${diff > 0 ? '+' : '−'}${u(Math.abs(diff))} from ${u(bolus.suggested)}`);
    }
  }
  if (bolus.extended !== null && bolus.extended > 0) {
    const over = bolus.extendedMinutes !== null ? formatDuration(bolus.extendedMinutes) : 'time';
    parts.push(`${u(bolus.extended)}U over ${over}`);
  }
  if (bolus.completion !== null) parts.push(`${u(bolus.delivered)}U delivered, ${bolus.completion}`);
  return parts.length ? parts.join(' · ') : null;
}

/** "45m", "2h", "1h 30m". */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${Math.trunc(m / 60)}h ${m % 60}m`;
}

export function formatIob(iob: number | null): string {
  return iob === null ? 'IOB --' : `IOB ${u(iob)}U`;
}

export function isStale(glucose: Glucose, nowMs: number): boolean {
  return nowMs - glucose.timeMs > STALE_GLUCOSE_MINUTES * 60_000;
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Local clock time, e.g. "9:05 AM" (format follows the browser's locale). */
export function formatClock(timeMs: number): string {
  return CLOCK.format(new Date(timeMs));
}

/** "0.4 U/hr", "0.275 U/hr": up to three decimals, no trailing zeros. */
export function formatRate(rate: number): string {
  return `${parseFloat(rate.toFixed(3))} U/hr`;
}

/** Pump uploads to Tandem roughly hourly; later than this is a warning. */
export const STALE_PUMP_UPLOAD_MINUTES = 75;
/** The service syncs Tandem every 15 minutes; later than this is a warning. */
export const STALE_SYNC_MINUTES = 35;

/** "just now", "7m ago", "2h 5m ago". */
export function ago(thenMs: number, nowMs: number): string {
  const age = formatAge(thenMs, nowMs);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/**
 * One freshness line, e.g. "Pump upload 40m ago · synced 2m ago", and whether
 * it should be shown as a warning. Checked against fixtures/sync-status-cases.json.
 */
export function formatSyncStatus(status: SyncStatus, nowMs: number): { text: string; stale: boolean } {
  const pump = status.pumpUploadedMs === null ? 'Pump upload unknown' : `Pump upload ${ago(status.pumpUploadedMs, nowMs)}`;
  let sync: string;
  if (status.error) {
    sync = status.syncedMs === null ? 'sync failing, never ok' : `sync failing, last ok ${ago(status.syncedMs, nowMs)}`;
  } else {
    sync = status.syncedMs === null ? 'not synced yet' : `synced ${ago(status.syncedMs, nowMs)}`;
  }
  const older = (ms: number | null, minutes: number) => ms === null || nowMs - ms > minutes * 60_000;
  const stale = status.error !== null
    || older(status.pumpUploadedMs, STALE_PUMP_UPLOAD_MINUTES)
    || older(status.syncedMs, STALE_SYNC_MINUTES);
  return { text: `${pump} · ${sync}`, stale };
}
