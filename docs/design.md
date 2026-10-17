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

1. Spike: pull Dexcom readings via pydexcom.
2. Spike: pull Tandem bolus data via tconnectsync.
3. Decide on storage (Nightscout vs. own) based on spike findings.
4. Prototype the widget.
