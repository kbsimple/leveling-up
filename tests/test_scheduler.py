"""Tests for the scheduler and boost mode."""

import pytest

from leveling_up.scheduler import Boost, Job, Scheduler


class FakeClock:

    def __init__(self, now: float = 1_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


def test_boost_uses_boosted_interval_until_expiry(clock):
    boost = Boost(normal_seconds=900, boosted_seconds=300, default_duration_seconds=1800,
                  clock=clock)
    assert boost.interval() == 900
    boost.activate()
    assert boost.is_active()
    assert boost.interval() == 300
    clock.now += 1799
    assert boost.interval() == 300
    clock.now += 1
    assert not boost.is_active()
    assert boost.interval() == 900


def test_boost_custom_duration_and_extension(clock):
    boost = Boost(900, 300, 1800, clock=clock)
    until = boost.activate(600)
    assert until == clock.now + 600
    # A longer re-activation extends; a shorter one never shortens.
    assert boost.activate(1200) == clock.now + 1200
    assert boost.activate(60) == clock.now + 1200


def test_boost_cancel(clock):
    boost = Boost(900, 300, 1800, clock=clock)
    boost.activate()
    boost.cancel()
    assert boost.interval() == 900


def test_jobs_run_on_their_intervals(clock):
    runs = []
    scheduler = Scheduler([
        Job("a", lambda: runs.append("a") or "ok", lambda: 300),
        Job("b", lambda: runs.append("b") or "ok", lambda: 900),
    ], clock=clock)
    scheduler.run_due()
    assert runs == ["a", "b"]
    clock.now += 300
    scheduler.run_due()
    assert runs == ["a", "b", "a"]
    clock.now += 600
    scheduler.run_due()
    assert runs == ["a", "b", "a", "a", "b"]


def test_trigger_makes_job_due_now(clock):
    runs = []
    scheduler = Scheduler([Job("t", lambda: runs.append(1) or "ok", lambda: 900)], clock=clock)
    scheduler.run_due()
    clock.now += 10
    scheduler.run_due()
    assert len(runs) == 1
    scheduler.trigger("t")
    assert scheduler.seconds_until_next() == 0
    scheduler.run_due()
    assert len(runs) == 2


def test_trigger_during_run_keeps_job_due(clock):
    scheduler = None

    def run() -> str:
        scheduler.trigger("t")
        return "ok"

    scheduler = Scheduler([Job("t", run, lambda: 900)], clock=clock)
    scheduler.run_due()
    assert scheduler.seconds_until_next() == 0


def test_failing_job_records_error_and_reschedules(clock):
    def boom() -> str:
        raise RuntimeError("nope")

    scheduler = Scheduler([Job("x", boom, lambda: 300)], clock=clock)
    scheduler.run_due()
    status = scheduler.status()["x"]
    assert status["last_error"] == "RuntimeError: nope"
    assert status["last_result"] is None
    assert scheduler.seconds_until_next() == 300


def test_boosted_tandem_job_switches_back_after_boost(clock):
    runs = []
    boost = Boost(900, 300, 1800, clock=clock)
    scheduler = Scheduler([Job("tandem", lambda: runs.append(clock.now) or "ok", boost.interval)],
                          clock=clock)
    start = clock.now
    boost.activate()
    for _ in range(200):
        scheduler.run_due()
        clock.now += 60
    offsets = [round(r - start) for r in runs]
    # Every 5 min during the 30-minute boost, then every 15 min.
    assert offsets[:7] == [0, 300, 600, 900, 1200, 1500, 1800]
    assert offsets[7] - offsets[6] == 900
