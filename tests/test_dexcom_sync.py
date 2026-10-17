"""Tests for the Dexcom -> Nightscout sync."""

import dataclasses
import datetime

import pytest

from leveling_up.dexcom_sync import DEVICE, DexcomSync, reading_to_entry

PDT = datetime.timezone(datetime.timedelta(hours=-7))


@dataclasses.dataclass
class FakeReading:
    mg_dl: int
    trend_direction: str
    datetime: datetime.datetime


def reading(minute: int, value: int = 120, direction: str = "Flat") -> FakeReading:
    return FakeReading(value, direction, datetime.datetime(2026, 10, 17, 10, minute, tzinfo=PDT))


class FakeDexcom:

    def __init__(self, readings, error=None):
        self.readings = readings
        self.error = error
        self.calls = []

    def get_glucose_readings(self, minutes, max_count):
        self.calls.append((minutes, max_count))
        if self.error:
            raise self.error
        return self.readings


class FakeNightscout:

    def __init__(self, latest_ms=0):
        self.latest_ms = latest_ms
        self.posted = []

    def latest_sgv_ms(self, device):
        assert device == DEVICE
        return self.latest_ms

    def post_entries(self, entries):
        self.posted.extend(entries)


def test_reading_to_entry():
    entry = reading_to_entry(reading(5, 194, "SingleUp"))
    assert entry == {
        "type": "sgv",
        "sgv": 194,
        "direction": "SingleUp",
        "date": int(datetime.datetime(2026, 10, 17, 17, 5, tzinfo=datetime.timezone.utc)
                    .timestamp() * 1000),
        "dateString": "2026-10-17T10:05:00-07:00",
        "device": DEVICE,
    }


@pytest.mark.parametrize("dexcom, nightscout", [
    ("None", "NONE"),
    ("NotComputable", "NOT COMPUTABLE"),
    ("RateOutOfRange", "RATE OUT OF RANGE"),
    ("DoubleDown", "DoubleDown"),
])
def test_direction_names(dexcom, nightscout):
    assert reading_to_entry(reading(0, direction=dexcom))["direction"] == nightscout


def test_uploads_only_newer_readings():
    readings = [reading(10), reading(5), reading(0)]
    ns = FakeNightscout(latest_ms=reading_to_entry(readings[1])["date"])
    summary = DexcomSync(lambda: FakeDexcom(readings), ns).run()
    assert [e["dateString"] for e in ns.posted] == ["2026-10-17T10:10:00-07:00"]
    assert summary == "fetched 3, uploaded 1"


def test_nothing_new_posts_nothing():
    readings = [reading(0)]
    ns = FakeNightscout(latest_ms=reading_to_entry(readings[0])["date"])
    assert DexcomSync(lambda: FakeDexcom(readings), ns).run() == "fetched 1, uploaded 0"
    assert ns.posted == []


def test_max_count_capped_at_288():
    dex = FakeDexcom([])
    DexcomSync(lambda: dex, FakeNightscout(), lookback_minutes=1440).run()
    assert dex.calls == [(1440, 288)]


def test_client_recreated_after_failure():
    clients = [FakeDexcom([], error=RuntimeError("session expired")), FakeDexcom([reading(0)])]
    sync = DexcomSync(lambda: clients.pop(0), FakeNightscout())
    with pytest.raises(RuntimeError):
        sync.run()
    assert sync.run() == "fetched 1, uploaded 1"
    assert clients == []
