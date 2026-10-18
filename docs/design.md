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

### Nightscout sync spike (2026-10-17)
- Target: the user's existing Nightscout Pro instance (v15.0.8, mg/dL). It was
  empty, with no Dexcom bridge enabled. It briefly returned Nightscout Pro's
  "503 Reloading" page during a rebuild.
- **Tandem -> NS:** stock `tconnectsync --features BOLUS IOB BASAL` with
  `TIMEZONE_NAME=America/Los_Angeles` (fixes the -04:00 timestamp issue).
  A 1-day sync uploaded 21 boluses (`Combo Bolus`, with carbs and BG), 420
  `Temp Basal` and 1 `Basal Suspension` treatments. It took ~2 min, mostly the
  basal uploads. 
  The IOB feature produced no devicestatus in tconnectsync 3.0.3.
- **Dexcom -> NS:** `spikes/dexcom_to_nightscout.py` (pydexcom) posts `sgv`
  entries tagged `device=leveling-up (dexcom-share)` and only uploads readings
  newer than its last one, so reruns are no-ops.
- **Result:** NS `/pebble` (the endpoint widget apps commonly read) returns
  glucose, direction, delta, IOB and COB. IOB/COB are computed by Nightscout
  from the uploaded treatments, not reported by the pump. With no NS profile,
  these use defaults and may differ from the pump's IOB.
- **Profiles:** the NS default profile was stale. `--features PROFILES` with
  `NIGHTSCOUT_PROFILE_UPLOAD_MODE=replace` updated the latest NS profile doc
  in place: added the pump's active profile (`frog`, 16 basal segments,
  DIA 3.0) and made it the default. Older profile entries remain in the
  store. Include PROFILES in the regular sync so NS tracks pump changes.

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

## Sync service (2026-10-17)

- Python package `leveling_up` (`src/`), run as `leveling-up run`: a scheduler
  (Dexcom every 5 min, Tandem every 15 min) plus a small control API.
- **Boost mode:** `leveling-up boost` polls Tandem every 5 min for 30 min,
  starting immediately; `--minutes N` and `--cancel` supported.
- **Tandem:** calls tconnectsync's `ProcessTimeRange` directly with a
  timezone-aware window. tconnectsync's own CLI passes a naive `now`, which
  arrow reads as UTC, giving the in-progress basal a negative duration.
  Features: BASAL, BOLUS, PUMP_EVENTS, PROFILES (profile upload in replace mode).
- **IOB:** the pump reports IOB only inside bolus events, so it goes stale
  between boluses and uploads. We use Nightscout's estimate, computed from the
  uploaded boluses and the profile.
- **DIA:** Control-IQ always uses 5 hours, but the pump profile says 3, so the
  service overrides DIA (`INSULIN_DURATION_HOURS`) when converting pump
  profiles, which keeps tconnectsync's profile comparison stable.
- **Bolus details:** tconnectsync uploads only delivered insulin, carbs and BG.
  `bolus_details.py` adds the pump calculator's carb/correction split, the
  suggested vs. requested amount, the extended portion, automatic vs. manual,
  declined correction and early-stop reason to each bolus treatment (see the
  module docstring for field names). Existing boluses from the last 3 days were
  re-uploaded with these fields. Observed: automatic boluses are always pure
  correction; extended boluses deliver the correction plus part of the carb
  portion now.
- Old Nightscout profiles were deleted (`cleanup-profiles`); only `frog` remains.
- **Incremental Tandem reads (2026-10-18):** a full 24h pass downloaded
  ~333 KB every 15 minutes (~31 MB/day), almost all of it unchanged history.
  The pump-logs endpoint only takes whole local days (`startDate` 00:00 to
  `endDate` 23:59:59), so narrowing the time range alone can't get below one
  day. Each run now reads the pump record first and skips the history when
  `maxDateOfEvents` hasn't moved (tconnectsync's own autoupdate uses the same
  signal). With new data, it reads from the last processed event minus a 6h
  overlap, which rebuilds extended boluses, mode stops and the straddling
  basal record whole. A full lookback runs at startup and every 24h. Boost uses
  the same logic. Expected: ~3 MB/day. State is in memory only.
- **Deployment:** one Docker Compose setup for both the on-prem Ubuntu server
  and Vultr; see the `deploy-sync` skill. Only one instance may run at a time.

## Web companion (2026-10-17)

- Static TypeScript/Vite site on GitHub Pages; the browser calls Nightscout
  directly (Nightscout sends `Access-Control-Allow-Origin: *`). Credentials
  (URL + read-only token) live in the viewer's browser storage only.
- Widget-parity card on top, then glucose graph (3/6/12/24h, 70–180 band,
  bolus markers: orange triangle = manual, aqua circle = automatic), bolus
  history (2/6/24h) and basal/Control-IQ (rate vs profile, Sleep/Exercise,
  suspensions).
- `fixtures/bolus-cases.json` is the single source of truth for bolus wording;
  Kotlin and TypeScript tests both run it. Both round units to tenths half-up
  before formatting so Java and JavaScript agree.
- `/statusz/` follows the kbsimple Service Status layout (Identity, live
  checks, Runtime, Features, Dependencies); `/statusz.json` carries the build
  identity.

## Data freshness (2026-10-17)

Tandem data can lag up to ~60 minutes, so two times are published and shown:

1. **Pump → Tandem cloud:** Tandem Source's `lastUploadDate` (and
   `maxDateOfEvents`, the newest pump event) from the pumper endpoint.
   tconnectsync reads but doesn't store these.
2. **Tandem → Nightscout:** when the service last synced successfully.

After every Tandem run (success or failure) the service posts a Nightscout
devicestatus record (`device: leveling-up`, fields under `levelingUp.tandem`;
see `src/leveling_up/sync_status.py`) and keeps only the newest 12. Read-only
tokens can read it. The widget footer and the site show one line, e.g.
"Pump upload 40m ago · synced just now", marked as a warning when the pump
upload is over 75 minutes old, the last sync over 35 minutes old, or the sync is
failing. `fixtures/sync-status-cases.json` keeps the widget and site identical.
The site's basal section and `/statusz/` show the individual times.

The site's glucose graph has a Tandem lane under the bolus lane: a diamond
per distinct pump → Tandem upload, a ring at the last Nightscout sync, and a
hatched band from the newest pump event to now ("not uploaded yet"), so
missing boluses/basal at the right edge are explained on the chart. Records
are kept for 26 hours (pruned by age) so the 24h view has upload history.

A basal panel sits between the bolus and Tandem lanes with its own U/hr scale
(never a second axis on the glucose plot): delivered rate from Temp Basal
treatments as a stepped area, the profile schedule as a dashed step line.
Tapping it shows the rate, its time span, and the difference from profile;
the glucose readout also lists the basal rate at that time.

**Temp rates:** Tandem Source has no temp-rate start/stop events, but every
5-minute basal delivery event carries the temp rate setting (`tempRate`,
65535 = none) next to the profile and Control-IQ rates. `basal_details.py`
adds `profileRate`, `algorithmRate` and `tempRate` (U/hr) to each Temp Basal
treatment; the last 3 days were re-uploaded. The web app merges consecutive
temp-rate steps into periods (percentage = temp ÷ profile; the planned
duration isn't recorded, so the actual span is shown) and draws a labeled bar
above the basal panel plus a texture on those steps. The basal card lists
temp rates from the last 24 hours.

**Sleep and Exercise modes:** tconnectsync already uploads Control-IQ activity
changes (`LidAaUserModeChange`, part of the PUMP_EVENTS feature) as `Sleep` /
`Exercise` treatments with a duration and a reason such as "Sleep (Manual)" or
"Exercise (Timed) (Stopped by timer)". A mode still on at sync time is uploaded
with its length so far and "... - Not Ended"; tconnectsync replaces it once
the stop event arrives. The web app extends such an open period to the newest
pump data and, if both records for one start exist, keeps the ended one. Each
mode gets a bar in its own row above the temp-rate row (sleep = palette slot 5,
magenta; exercise = slot 6, green; validated with slots 1–4 in both themes)
and a faint tint behind the basal panel. The basal card lists the current mode
and earlier periods from the last 24 hours.

## Open questions

- **Widget app:** reuse an existing Nightscout client (leading candidate:
  GlucoDataHandler; alternative xDrip+) vs. a custom widget. User is gathering
  recommendations. Verify which fields (IOB, recent boluses) each can display.
- **Nightscout vs. own API:** write synced data into the existing Nightscout,
  or serve a small Nightscout-compatible API ourselves?
- **Upload nudging:** confirm whether repeated Tandem requests trigger a pump
  upload, and at what request rate it is safe and useful.

## Next steps

1. ~~Spike: Dexcom~~ and ~~Spike: Tandem~~ (done, see findings).
2. Decide on storage (Nightscout vs. own) based on findings.
3. Prototype the widget.
