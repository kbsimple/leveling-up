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

## Open questions

- **Storage:** Is Nightscout the system of record, or a write-through cache
  (load from sources, write opportunistically)? Or a lighter own store?
- **Sync service:** Where does the poller run (home server, cloud function,
  Android foreground service)? Dexcom Share and t:connect both need credentials
  and have rate/latency limits.
- **Widget delivery:** Native Android app widget, or reuse an existing
  Nightscout-compatible widget (e.g. xDrip+/Juggluco-style clients) pointed at
  our combined API?
- **Data model:** Unified timeline of glucose readings, boluses, basal, carbs.
- **Security/privacy:** Health data and credentials; keep the repo private and
  secrets out of git.

## Next steps

1. ~~Spike: Dexcom~~ and ~~Spike: Tandem~~ (done, see findings).
2. Decide on storage (Nightscout vs. own) based on findings.
3. Prototype the widget.
