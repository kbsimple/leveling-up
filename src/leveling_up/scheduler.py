"""Runs sync jobs on intervals, with a temporary Tandem boost mode."""

import dataclasses
import datetime
import logging
import threading
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)

Clock = Callable[[], float]


class Boost:
    """Temporarily shortens a job's interval.

    While active (until `active_until`), `interval` returns the boosted value;
    afterwards it returns the normal one.
    """

    def __init__(self, normal_seconds: float, boosted_seconds: float,
                 default_duration_seconds: float, clock: Clock = time.time) -> None:
        self._normal = normal_seconds
        self._boosted = boosted_seconds
        self._default_duration = default_duration_seconds
        self._clock = clock
        self.active_until = 0.0

    def activate(self, duration_seconds: Optional[float] = None) -> float:
        """Starts (or extends) the boost and returns when it ends (epoch seconds)."""
        duration = self._default_duration if duration_seconds is None else duration_seconds
        self.active_until = max(self.active_until, self._clock() + duration)
        return self.active_until

    def cancel(self) -> None:
        self.active_until = 0.0

    def is_active(self) -> bool:
        return self._clock() < self.active_until

    def interval(self) -> float:
        return self._boosted if self.is_active() else self._normal


@dataclasses.dataclass
class Job:
    """A named periodic task."""

    name: str
    run: Callable[[], str]
    interval: Callable[[], float]
    next_run: float = 0.0
    triggered: bool = False
    last_started: Optional[float] = None
    last_finished: Optional[float] = None
    last_result: Optional[str] = None
    last_error: Optional[str] = None


def _iso(ts: Optional[float]) -> Optional[str]:
    if not ts:
        return None
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).astimezone().isoformat(
        timespec="seconds")


class Scheduler:
    """Runs due jobs one at a time; other threads may trigger jobs early."""

    def __init__(self, jobs: list[Job], clock: Clock = time.time) -> None:
        self._jobs = {job.name: job for job in jobs}
        self._clock = clock
        self._lock = threading.Lock()
        self._wake = threading.Event()

    def trigger(self, name: str) -> None:
        """Makes `name` due immediately."""
        with self._lock:
            self._jobs[name].next_run = 0.0
            self._jobs[name].triggered = True
        self._wake.set()

    def run_due(self) -> None:
        """Runs every job whose next run time has passed."""
        for job in self._jobs.values():
            with self._lock:
                if self._clock() < job.next_run:
                    continue
                job.last_started = self._clock()
                job.triggered = False
            try:
                result, error = job.run(), None
            except Exception as e:  # pylint: disable=broad-except
                logger.exception("job %s failed", job.name)
                result, error = None, f"{type(e).__name__}: {e}"
            with self._lock:
                job.last_finished = self._clock()
                job.last_result, job.last_error = result, error
                # A trigger that arrived mid-run keeps the job due.
                job.next_run = 0.0 if job.triggered else self._clock() + job.interval()

    def seconds_until_next(self) -> float:
        with self._lock:
            soonest = min(job.next_run for job in self._jobs.values())
        return max(0.0, soonest - self._clock())

    def wake(self) -> None:
        """Interrupts the wait between runs (e.g. so `run_forever` sees a stop)."""
        self._wake.set()

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.run_due()
            if stop.is_set():
                break
            self._wake.wait(timeout=min(self.seconds_until_next(), 60.0))
            self._wake.clear()

    def status(self) -> dict:
        with self._lock:
            return {
                name: {
                    "next_run": "now" if job.triggered else _iso(job.next_run),
                    "interval_minutes": round(job.interval() / 60, 2),
                    "last_finished": _iso(job.last_finished),
                    "last_result": job.last_result,
                    "last_error": job.last_error,
                }
                for name, job in self._jobs.items()
            }
