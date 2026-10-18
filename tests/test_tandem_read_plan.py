"""Tests for incremental Tandem Source reads."""

import datetime
import zoneinfo

import arrow
import pytest

from leveling_up import tandem_sync
from leveling_up.tandem_sync import FULL_PASS_EVERY, OVERLAP, ReadPlan, TandemSync, plan_read

TZ = "America/Los_Angeles"
LA = zoneinfo.ZoneInfo(TZ)
NOW = datetime.datetime(2026, 10, 18, 9, 0, tzinfo=LA)
LOOKBACK = datetime.timedelta(hours=24)


def at(hour, minute=0):
    return datetime.datetime(2026, 10, 18, hour, minute, tzinfo=LA)


def test_first_run_reads_full_lookback():
    assert plan_read(NOW, at(8, 13), None, None, LOOKBACK) == ReadPlan(NOW - LOOKBACK, full=True)


def test_skips_when_tandem_has_nothing_new():
    assert plan_read(NOW, at(8, 13), at(8, 13), at(7), LOOKBACK) == ReadPlan(None, full=False)


def test_reads_from_last_processed_event_minus_overlap():
    plan = plan_read(NOW, at(8, 58), at(8, 13), at(7), LOOKBACK)
    assert plan == ReadPlan(at(8, 13) - OVERLAP, full=False)


def test_overlap_never_reaches_past_the_lookback():
    plan = plan_read(NOW, at(8, 58), NOW - LOOKBACK, at(7), LOOKBACK)
    assert plan.start == NOW - LOOKBACK


def test_full_pass_when_due_even_without_new_data():
    plan = plan_read(NOW, at(8, 13), at(8, 13), NOW - FULL_PASS_EVERY, LOOKBACK)
    assert plan == ReadPlan(NOW - LOOKBACK, full=True)


def test_full_read_when_pump_record_unavailable():
    assert plan_read(NOW, None, at(8, 13), at(7), LOOKBACK).full


class FakeTandemSource:
    def __init__(self):
        self.newest = "2026-10-18T08:13:00"

    def get_pumper(self):
        return {"pumps": [{"assignmentId": "pump-1", "maxDateOfEvents": self.newest,
                           "lastUploadDate": "2026-10-18T15:14:00Z"}]}


class FakeProcess:
    windows = []

    def __init__(self, *args, **kwargs):
        pass

    def process(self, start, end):
        FakeProcess.windows.append((start, end))
        return 0, 42


@pytest.fixture(name="sync")
def fixture_sync(monkeypatch):
    """A TandemSync wired to fakes, skipping tconnectsync setup."""
    sync = TandemSync.__new__(TandemSync)
    source = FakeTandemSource()
    sync._tconnect = type("Api", (), {"tandemsource": source})()
    sync._nightscout = sync._secret = None
    sync._device = {"assignmentId": "pump-1"}
    sync._process_cls = FakeProcess
    sync._tz = TZ
    sync._lookback_hours = 24
    sync._synced_at = sync._pump_uploaded_at = sync._newest_event_at = sync._upload_client = None
    sync._processed_event_at = sync._last_full_at = None
    sync.published = []
    monkeypatch.setattr(sync, "_publish_status", lambda checked, error: sync.published.append(error),
                        raising=False)
    FakeProcess.windows = []
    clock = {"now": NOW}
    monkeypatch.setattr(tandem_sync.arrow, "now", lambda tz: arrow.get(clock["now"]).to(tz))
    sync.source, sync.clock = source, clock
    return sync


def test_run_skips_then_reads_incrementally(sync):
    assert sync.run() == "uploaded 0, last event 42 (full)"
    assert FakeProcess.windows[-1][0].datetime == NOW - LOOKBACK

    sync.clock["now"] = NOW + datetime.timedelta(minutes=15)
    assert sync.run() == "skipped: no new pump data since 8:13 AM"
    assert len(FakeProcess.windows) == 1
    assert sync._synced_at == NOW + datetime.timedelta(minutes=15)

    sync.source.newest = "2026-10-18T09:10:00"
    sync.clock["now"] = NOW + datetime.timedelta(minutes=30)
    assert sync.run() == "uploaded 0, last event 42 (from 2:13 AM)"
    assert FakeProcess.windows[-1][0].datetime == at(8, 13) - OVERLAP
    assert sync._processed_event_at == at(9, 10)
    assert sync.published == [None, None, None]


def test_failed_read_is_retried_from_the_same_point(sync, monkeypatch):
    sync.run()

    def boom(self, start, end):
        raise RuntimeError("tandem down")

    sync.source.newest = "2026-10-18T09:10:00"
    sync.clock["now"] = NOW + datetime.timedelta(minutes=15)
    with monkeypatch.context() as m:
        m.setattr(FakeProcess, "process", boom)
        with pytest.raises(RuntimeError):
            sync.run()
    assert sync._processed_event_at == at(8, 13)
    assert sync.published[-1] == "RuntimeError: tandem down"
    assert sync.run().endswith("(from 2:13 AM)")
