"""Tests for the freshness devicestatus record."""

import datetime
import types

from leveling_up.nightscout import NightscoutClient
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


class FakeSession:
    """Records requests made by NightscoutClient."""

    def __init__(self, records):
        self.headers = {}
        self.records = records
        self.deleted = []

    def request(self, method, url, timeout, **kwargs):
        resp = types.SimpleNamespace(raise_for_status=lambda: None, content=b"x")
        if method == "GET":
            resp.json = lambda: self.records
        else:
            self.deleted.append(url.rsplit("/", 1)[1])
            resp.json = lambda: None
        return resp


def test_prune_devicestatus_by_age_keeps_newest_and_other_devices():
    session = FakeSession([
        {"_id": "new", "device": DEVICE, "created_at": "2026-10-17T19:00:00.000Z"},
        {"_id": "old1", "device": DEVICE, "created_at": "2026-10-16T10:00:00.000Z"},
        {"_id": "recent", "device": DEVICE, "created_at": "2026-10-17T01:00:00.000Z"},
        {"_id": "other", "device": "openaps://x", "created_at": "2026-10-01T00:00:00.000Z"},
    ])
    client = NightscoutClient("https://ns.example", "s", session=session)
    cutoff = datetime.datetime(2026, 10, 16, 17, 0, tzinfo=UTC)
    assert client.prune_devicestatus(DEVICE, cutoff) == 1
    assert session.deleted == ["old1"]


def test_prune_devicestatus_never_deletes_the_only_record():
    session = FakeSession([{"_id": "only", "device": DEVICE, "created_at": "2026-01-01T00:00:00.000Z"}])
    client = NightscoutClient("https://ns.example", "s", session=session)
    assert client.prune_devicestatus(DEVICE, datetime.datetime(2026, 10, 17, tzinfo=UTC)) == 0
