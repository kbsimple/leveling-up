"""Tests for the obfuscated Nightscout snapshot builder."""

import datetime

from leveling_up.fixture_snapshot import obfuscate, shift_days, shift_iso

UTC = datetime.timezone.utc
TZ = "America/Los_Angeles"
# 2026-10-18T01:00Z is 6 PM PDT on Oct 17.
FETCHED_MS = int(datetime.datetime(2026, 10, 18, 1, 0, tzinfo=UTC).timestamp() * 1000)
DAY_MS = 86_400_000


def _raw():
    return {
        "fetchedMs": FETCHED_MS,
        "pebble": {"status": [{"now": FETCHED_MS}],
                   "bgs": [{"sgv": "150", "datetime": FETCHED_MS - 60_000, "bgdelta": 5, "iob": "0.4"}]},
        "entries": [
            {"_id": "a" * 24, "date": FETCHED_MS - 60_000, "sgv": 150,
             "dateString": "2026-10-18T00:59:00.000Z", "sysTime": "2026-10-18T00:59:00.000Z"},
            {"_id": "b" * 24, "date": FETCHED_MS - 360_000, "sgv": 145,
             "dateString": "2026-10-18T00:54:00.000Z", "sysTime": "2026-10-18T00:54:00.000Z"},
        ],
        "treatments": [
            {"_id": "c" * 24, "eventType": "Combo Bolus", "created_at": "2026-10-17T20:00:00.000Z",
             "bolusId": 5551, "pump_event_id": "2897000,2897005", "glucose": 180, "insulin": 2},
            {"_id": "d" * 24, "eventType": "Combo Bolus", "created_at": "2026-10-17T20:00:00.000Z",
             "bolusId": 5551, "extendedPortion": True, "pump_event_id": "2897005", "insulin": 1},
        ],
        "profile": [{"_id": "e" * 24, "defaultProfile": "frog", "created_at": "2025-12-30T18:43:23.161Z",
                     "store": {"frog": {"basal": [{"timeAsSeconds": 0, "value": 0.6}], "timezone": TZ,
                                        "dia": 5, "carbratio": [{"value": 9}], "sens": [{"value": 40}]}}}],
        "devicestatus": [{"_id": "f" * 24, "device": "leveling-up", "created_at": "2026-10-18T00:55:00.000Z",
                          "levelingUp": {"tandem": {"checkedAt": "2026-10-17T17:55:00-07:00",
                                                    "pumpUploadedAt": "2026-10-18T00:40:00+00:00",
                                                    "newestEventAt": None}}}],
    }


def test_shift_days_keeps_dst_state():
    summer = datetime.datetime(2026, 10, 18, 1, 0, tzinfo=UTC)  # Oct 17 PDT -> Jul 1
    winter = datetime.datetime(2026, 12, 2, 1, 0, tzinfo=UTC)   # Dec 1 PST -> Jan 15
    assert shift_days(summer, TZ) == 108
    assert shift_days(winter, TZ) == 320


def test_shift_iso_keeps_style():
    delta = datetime.timedelta(days=2)
    assert shift_iso("2026-10-18T00:59:00.000Z", delta) == "2026-10-16T00:59:00.000Z"
    assert shift_iso("2026-10-18T00:59:00Z", delta) == "2026-10-16T00:59:00Z"
    assert shift_iso("2026-10-17T17:55:00-07:00", delta) == "2026-10-15T17:55:00-07:00"
    assert shift_iso(None, delta) is None


def test_obfuscate_shifts_times_to_anchor_date():
    files = obfuscate(_raw(), TZ)
    assert files["snapshot"]["fetchedAt"] == "2026-07-02T01:00:00.000Z"
    shift = 108 * DAY_MS
    assert files["pebble"]["status"][0]["now"] == FETCHED_MS - shift
    assert files["entries"][0]["date"] == FETCHED_MS - 60_000 - shift
    assert files["entries"][0]["dateString"] == "2026-07-02T00:59:00.000Z"
    assert files["treatments"][0]["created_at"] == "2026-07-01T20:00:00.000Z"
    tandem = files["devicestatus"][0]["levelingUp"]["tandem"]
    assert tandem == {"checkedAt": "2026-07-01T17:55:00-07:00",
                      "pumpUploadedAt": "2026-07-02T00:40:00+00:00", "newestEventAt": None}


def test_obfuscate_replaces_ids_consistently():
    files = obfuscate(_raw(), TZ)
    combo, extended = files["treatments"]
    assert combo["bolusId"] == extended["bolusId"] == 100
    assert combo["pump_event_id"] == "1000,1001"
    assert extended["pump_event_id"] == "1001"
    ids = [r["_id"] for name in ("entries", "treatments", "profile", "devicestatus") for r in files[name]]
    assert len(set(ids)) == len(ids)
    assert not any(i in ids for i in ("a" * 24, "c" * 24, "e" * 24))


def test_obfuscate_jitters_glucose_and_keeps_pebble_consistent():
    files = obfuscate(_raw(), TZ)
    newest, older = files["entries"]
    assert abs(newest["sgv"] - 150) <= 3 and abs(older["sgv"] - 145) <= 3
    bg = files["pebble"]["bgs"][0]
    assert bg["sgv"] == str(newest["sgv"])
    assert bg["bgdelta"] == newest["sgv"] - older["sgv"]
    assert files["treatments"][0]["insulin"] == 2
    assert obfuscate(_raw(), TZ) == files  # deterministic


def test_obfuscate_keeps_only_profile_fields_the_apps_read():
    profile = obfuscate(_raw(), TZ)["profile"][0]
    assert profile["defaultProfile"] == "Default"
    assert profile["store"] == {"Default": {"basal": [{"timeAsSeconds": 0, "value": 0.6}], "timezone": TZ, "dia": 5}}
