"""Builds the obfuscated Nightscout snapshot in fixtures/snapshot/.

Downloads the same 24-hour window the web app reads and lightly obfuscates it
so it can be committed to the public repo and replayed in tests:

* Every timestamp moves back by a whole number of days to a fixed date, so
  local time of day and the UTC offset are unchanged.
* Glucose values get seeded jitter of a few mg/dL.
* Nightscout ids, pump event ids and bolus ids are replaced with sequential
  ones; records that shared an id still share one.
* The profile keeps only the fields the apps read.

Insulin and carb amounts are kept so bolus details stay internally consistent.
The output is deterministic for a given download.
"""

import datetime
import json
import pathlib
import random
import zoneinfo
from typing import Any

from leveling_up.nightscout import NightscoutClient

DAY = datetime.timedelta(days=1)
# Fixed dates to shift onto; one per DST state so the UTC offset is unchanged.
_DST_ANCHOR = datetime.date(2026, 7, 1)
_STANDARD_ANCHOR = datetime.date(2026, 1, 15)
_JITTER_MGDL = 3
_SEED = 7
_PROFILE_FIELDS = ("basal", "timezone", "dia", "units", "target_low", "target_high")
_TANDEM_TIME_FIELDS = ("checkedAt", "syncedAt", "pumpUploadedAt", "newestEventAt")
FILES = ("pebble", "entries", "treatments", "profile", "devicestatus")


def download(client: NightscoutClient, now: datetime.datetime) -> dict[str, Any]:
    """Fetches the web app's 24-hour window (see web/src/nightscout.ts)."""
    since = now - DAY
    since_iso = since.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "pebble": client.get("pebble"),
        "entries": client.get("api/v1/entries/sgv.json",
                              params={"find[date][$gte]": int(since.timestamp() * 1000), "count": 400}),
        "treatments": client.get("api/v1/treatments.json",
                                 params={"find[created_at][$gte]": since_iso, "count": 1500}),
        "profile": client.get("api/v1/profile.json", params={"count": 1}),
        "devicestatus": client.get("api/v1/devicestatus.json", params={
            "find[device]": "leveling-up", "find[created_at][$gte]": since_iso, "count": 400}),
        "fetchedMs": int(now.timestamp() * 1000),
    }


def shift_days(fetched: datetime.datetime, tz: str) -> int:
    """Whole days between the fetch and the anchor date with the same DST state."""
    local = fetched.astimezone(zoneinfo.ZoneInfo(tz))
    anchor = _DST_ANCHOR if local.dst() else _STANDARD_ANCHOR
    return (local.date() - anchor).days


def shift_iso(value: str | None, delta: datetime.timedelta) -> str | None:
    """Moves an ISO 8601 time back by `delta`, keeping its offset and precision style."""
    if not value:
        return value
    dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00")) - delta
    if value.endswith("Z"):
        spec = "milliseconds" if "." in value else "seconds"
        return dt.astimezone(datetime.timezone.utc).isoformat(timespec=spec).replace("+00:00", "Z")
    return dt.isoformat()


class _Renumber:
    """Maps original ids to sequential ones, consistently."""

    def __init__(self, start: int, fmt: str = "{}") -> None:
        self._next = start
        self._fmt = fmt
        self._seen: dict[str, str] = {}

    def __call__(self, value: Any) -> str:
        key = str(value)
        if key not in self._seen:
            self._seen[key] = self._fmt.format(self._next)
            self._next += 1
        return self._seen[key]


def obfuscate(raw: dict[str, Any], tz: str = "America/Los_Angeles") -> dict[str, Any]:
    """Returns the snapshot files' contents for a `download` result."""
    fetched = datetime.datetime.fromtimestamp(raw["fetchedMs"] / 1000, datetime.timezone.utc)
    delta = shift_days(fetched, tz) * DAY
    delta_ms = int(delta.total_seconds() * 1000)
    rng = random.Random(_SEED)
    object_id = _Renumber(1, "{:024x}")
    pump_event = _Renumber(1000)
    bolus_id = _Renumber(100)

    def jitter(mgdl: int) -> int:
        return max(40, int(mgdl) + rng.randint(-_JITTER_MGDL, _JITTER_MGDL))

    entries = []
    for e in sorted(raw["entries"], key=lambda e: e["date"]):
        e = dict(e, _id=object_id(e["_id"]), sgv=jitter(e["sgv"]), date=e["date"] - delta_ms)
        for field in ("dateString", "sysTime"):
            if field in e:
                e[field] = shift_iso(e[field], delta)
        entries.append(e)
    entries.reverse()  # Nightscout order: newest first.
    sgv_at = {e["date"]: e["sgv"] for e in entries}

    pebble = json.loads(json.dumps(raw["pebble"]))
    for status in pebble.get("status", []):
        status["now"] -= delta_ms
    for bg in pebble.get("bgs", []):
        bg["datetime"] -= delta_ms
        if bg["datetime"] in sgv_at:
            bg["sgv"] = str(sgv_at[bg["datetime"]])
            older = [e for e in entries if e["date"] < bg["datetime"]]
            if older:
                bg["bgdelta"] = sgv_at[bg["datetime"]] - older[0]["sgv"]

    treatments = []
    for t in raw["treatments"]:
        t = dict(t, _id=object_id(t["_id"]), created_at=shift_iso(t["created_at"], delta))
        if "pump_event_id" in t:
            t["pump_event_id"] = ",".join(pump_event(p) for p in str(t["pump_event_id"]).split(",") if p)
        if "bolusId" in t:
            t["bolusId"] = int(bolus_id(t["bolusId"]))
        if t.get("glucose"):
            t["glucose"] = jitter(t["glucose"])
        treatments.append(t)

    profiles = []
    for p in raw["profile"]:
        store = p["store"][p["defaultProfile"]]
        profiles.append({
            "_id": object_id(p["_id"]),
            "defaultProfile": "Default",
            "created_at": shift_iso(p["created_at"], delta),
            "store": {"Default": {k: store[k] for k in _PROFILE_FIELDS if k in store}},
        })

    devicestatus = []
    for d in raw["devicestatus"]:
        d = json.loads(json.dumps(d))
        d["_id"] = object_id(d["_id"])
        d["created_at"] = shift_iso(d["created_at"], delta)
        tandem = d.get("levelingUp", {}).get("tandem", {})
        for field in _TANDEM_TIME_FIELDS:
            if field in tandem:
                tandem[field] = shift_iso(tandem[field], delta)
        devicestatus.append(d)

    return {
        "pebble": pebble,
        "entries": entries,
        "treatments": treatments,
        "profile": profiles,
        "devicestatus": devicestatus,
        "snapshot": {
            "fetchedAt": (fetched - delta).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "timezone": tz,
            "note": "Real Nightscout data, time-shifted, glucose-jittered and re-identified; "
                    "regenerate with `leveling-up snapshot-fixture`.",
        },
    }


def write(files: dict[str, Any], out_dir: pathlib.Path) -> None:
    """Writes each snapshot file as `<name>.json`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (out_dir / f"{name}.json").write_text(json.dumps(content, indent=1) + "\n")
