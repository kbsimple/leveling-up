# Design Notes

## Goal

One glanceable Android widget showing blood glucose (Dexcom) together with
insulin dosing (Tandem t:slim), without juggling multiple apps.

## Candidate building blocks (to be evaluated)

| Source | Role |
| --- | --- |
| [pydexcom](https://github.com/gagebenne/pydexcom) | Read CGM values from Dexcom Share |
| [tconnectsync](https://github.com/jwoglom/tconnectsync) | Pull Tandem t:connect pump/bolus data (and Nightscout upload logic) |
| dexcomreadings | Reference for Dexcom reading handling |
| [Nightscout](https://nightscout.github.io/) | Possible shared store / API for combined data |

## Spike findings (2026-10-17)

### Dexcom Share via pydexcom 0.5.1
- Auth works with Share username/password (region `us`).
- 24h request returned 287 readings at 5-minute intervals; the API caps by
  `max_count` (288), so ~24h of history is the practical window.
- Newest reading was ~5 min old, which is normal CGM cadence, so near
  real-time. Polling every ~5 min is sufficient.
- Fields: `value`/`mg_dl`, `mmol_l`, `trend`, `trend_arrow`,
  `trend_description`, `trend_direction`, tz-aware `datetime`.

### Tandem Source via tconnectsync 3.0.3
- Library logs in to **Tandem Source** (not legacy t:connect). Login needed a
  working Tandem Source credential; first attempts returned 401
  `account/invalid_credentials`.
- Flow: `TConnectApi(...).tandemsource.get_pumper()` -> `pumps[0].assignmentId`
  -> `pump_events(device_id, min_date, max_date)` (28-day max window per call).
- 2 days yielded ~1800 events. Useful types:
  - `LidBolusCompleted`: `bolusId`, `insulinDelivered`, `insulinRequested`, `iob`
  - `LidBolusRequestedMsg1`: `bg`, `carbAmount`, `correctionBolusIncludedRaw`, `iob`
  - `LidBolusDelivery`: `deliveredTotal` and `correction` (milliunits)
  - `LidBasalDelivery`: `commandedRate`, `profileBasalRate`, `algorithmRate`
    (Control-IQ), `tempRate` (milliunits/hr)
  - `LidCgmDataG7`: `currentGlucoseDisplayValue` (the pump also records CGM)
- **Timestamp caveat:** `eventTimestamp` is pump-local wall-clock time that the
  library labels with a fixed offset (-04:00 here) regardless of the user's real
  timezone. Verified by matching Tandem CGM/BG values to Dexcom readings. Our
  ingest must reinterpret these as pump-local time in the correct zone.
- **Latency:** newest event was ~40 min old (real time). Tandem data arrives in
  batches when the pump syncs, so dosing info lags CGM by tens of minutes.

### Implications
- Dexcom is the real-time source for glucose; Tandem is the (delayed) source
  for insulin delivery. The widget should show glucose immediately and
  annotate boluses/basal as they arrive, with "as of" times per source.
- Poll Dexcom every ~5 min; Tandem every ~15 min is probably enough.
- Pump CGM data could backfill glucose gaps, but not needed initially.
- Both sources are unofficial APIs and can break; keep each behind an adapter.

## Decisions (2026-10-17)

- **Audience:** a small group sharing one set of credentials. No per-user accounts.
- **Dosing source:** Tandem cloud (Tandem Source). The pump uploads roughly every
  60 min; several requests close together appear to prompt an upload (to verify).
- **Widget contents:** at-a-glance recent state: current glucose + trend + delta
  + age, insulin on board, and boluses/carbs from the last 120 minutes.
  No graph.
- **Display only:** no alarms, never sends anything to the pump. Official apps
  remain the alarm system.
- **History:** hours only (ephemeral).
- **Storage:** the user's existing cloud Nightscout instance, if used, serves as
  ephemeral storage.
- **Hosting:** the sync service must be portable: runnable on-prem (the local
  host that runs openclaw) or in the cloud (Vultr account available).
  Containerize it.
- **Units/timezone:** mg/dL; America/Los_Angeles (pump clock may change when traveling).
- **Stack:** Python backend using pydexcom and tconnectsync (newer than system 3.9).
- **Later platforms (not immediate):** Wear OS, Chrome extension.

## Open questions

- **Widget app:** reuse an existing Nightscout client (leading candidate:
  GlucoDataHandler; alternative xDrip+) vs. a custom widget. User is gathering
  recommendations. Verify which fields (IOB, recent boluses) each can display.
- **Nightscout vs. own API:** write synced data into the existing Nightscout,
  or serve a small Nightscout-compatible API ourselves?
- **Upload nudging:** confirm whether repeated Tandem requests trigger a pump
  upload, and at what request rate it is safe and useful.
- **IOB:** use the pump's reported IOB (stale between uploads) or compute a
  decayed estimate from recent boluses?

## Next steps

1. ~~Spike: Dexcom~~ and ~~Spike: Tandem~~ (done, see findings).
2. Decide on storage (Nightscout vs. own) based on findings.
3. Prototype the widget.
