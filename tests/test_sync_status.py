"""Tests for the freshness devicestatus record."""

import datetime

from leveling_up.sync_status import DEVICE, build_status, parse_pump_times

UTC = datetime.timezone.utc


def test_parse_pump_times_localizes_pump_clock():
    uploaded, newest = parse_pump_times(
        {"lastUploadDate": "2026-10-17T19:06:48Z", "maxDateOfEvents": "2026-10-17T12:06:31"},
        "America/Los_Angeles")
    assert uploaded == datetime.datetime(2026, 10, 17, 19, 6, 48, tzinfo=UTC)
    assert newest.isoformat() == "2026-10-17T12:06:31-07:00"


def test_parse_pump_times_missing():
    assert parse_pump_times({}, "America/Los_Angeles") == (None, None)


def test_build_status_shape():
    checked = datetime.datetime(2026, 10, 17, 19, 40, 0, tzinfo=UTC)
    status = build_status(
        checked_at=checked,
        synced_at=checked,
        pump_uploaded_at=datetime.datetime(2026, 10, 17, 19, 6, 48, tzinfo=UTC),
        newest_event_at=None,
        upload_client="mobile_mobi",
        error=None,
    )
    assert status == {
        "device": DEVICE,
        "created_at": "2026-10-17T19:40:00+00:00",
        "levelingUp": {"tandem": {
            "checkedAt": "2026-10-17T19:40:00+00:00",
            "syncedAt": "2026-10-17T19:40:00+00:00",
            "pumpUploadedAt": "2026-10-17T19:06:48+00:00",
            "newestEventAt": None,
            "uploadClient": "mobile_mobi",
        }},
    }


def test_build_status_records_error_and_keeps_last_success():
    checked = datetime.datetime(2026, 10, 17, 20, 0, 0, tzinfo=UTC)
    earlier = datetime.datetime(2026, 10, 17, 19, 45, 0, tzinfo=UTC)
    tandem = build_status(checked, earlier, None, None, None, "ApiException: 401")["levelingUp"]["tandem"]
    assert tandem["syncedAt"] == "2026-10-17T19:45:00+00:00"
    assert tandem["checkedAt"] == "2026-10-17T20:00:00+00:00"
    assert tandem["error"] == "ApiException: 401"
