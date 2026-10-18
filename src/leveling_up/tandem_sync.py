"""Syncs Tandem Source pump data to Nightscout using tconnectsync.

tconnectsync reads its settings from environment variables at import time, so
`configure_tconnectsync_env` must run before this module's lazy imports.

Reads are incremental. Tandem Source serves pump history only in whole local
days, so each run first checks the pump record's newest event (8 KB) and skips
the history download (~150 KB per day of history) when nothing new arrived.
Otherwise it reads from the last processed event minus `OVERLAP`, and the full
lookback after a restart and every `FULL_PASS_EVERY` as a safety net.
"""

import dataclasses
import datetime
import logging
import os
from typing import Any, Callable, Optional

import arrow

from leveling_up import basal_details, bolus_details, sync_status
from leveling_up.config import Config
from leveling_up.nightscout import NightscoutClient

logger = logging.getLogger(__name__)

# tconnectsync's IOB feature produces nothing for Tandem Source; Nightscout
# computes IOB from the uploaded boluses and the profile's DIA instead.
FEATURES = ("BASAL", "BOLUS", "PUMP_EVENTS", "PROFILES")

# Re-read this much before the last processed event, so records completed by a
# later event are rebuilt whole: extended boluses (up to 2h), Sleep/Exercise
# stops, and the basal record running into the next one.
OVERLAP = datetime.timedelta(hours=6)
# Re-read the full lookback this often, in case an incremental read missed something.
FULL_PASS_EVERY = datetime.timedelta(hours=24)


@dataclasses.dataclass(frozen=True)
class ReadPlan:
    """What one sync run reads from Tandem Source."""

    # Start of the window to read; None to skip reading history.
    start: Optional[datetime.datetime]
    full: bool


def plan_read(now: datetime.datetime, newest_event: Optional[datetime.datetime],
              processed_event: Optional[datetime.datetime], last_full: Optional[datetime.datetime],
              lookback: datetime.timedelta) -> ReadPlan:
    """Decides how much pump history a run must read.

    Args:
        now: This run's time.
        newest_event: Newest pump event in Tandem Source, per the pump record
            just read; None if it couldn't be read.
        processed_event: `newest_event` as of the last successful read.
        last_full: When the last full-lookback read succeeded.
        lookback: The full lookback window.

    Returns:
        A full read when there's no prior state, the newest event is unknown,
        or a full pass is due; a skip when Tandem has nothing newer than what
        was processed; otherwise a read from `processed_event - OVERLAP`.
    """
    full_start = now - lookback
    if (newest_event is None or processed_event is None or last_full is None
            or now - last_full >= FULL_PASS_EVERY):
        return ReadPlan(full_start, full=True)
    if newest_event <= processed_event:
        return ReadPlan(None, full=False)
    return ReadPlan(max(full_start, processed_event - OVERLAP), full=False)


def configure_tconnectsync_env(config: Config) -> None:
    """Exports the settings tconnectsync reads from the environment."""
    os.environ.update({
        "TCONNECT_EMAIL": config.tconnect_email,
        "TCONNECT_PASSWORD": config.tconnect_password,
        "TCONNECT_REGION": config.tconnect_region,
        "NS_URL": config.ns_url,
        "NS_SECRET": config.ns_secret,
        "TIMEZONE_NAME": config.timezone_name,
        # Update the current profile document in place instead of adding a new
        # document on every pump profile change.
        "NIGHTSCOUT_PROFILE_UPLOAD_MODE": "replace",
    })


def with_dia_override(profile_store: Callable[..., dict], insulin_duration_hours: float
                      ) -> Callable[..., dict]:
    """Wraps tconnectsync's pump-to-Nightscout profile conversion to force DIA.

    Control-IQ always uses a 5-hour insulin duration regardless of the pump
    profile's setting, so the pump's value would understate IOB. Overriding at
    conversion time keeps tconnectsync's pump/Nightscout comparison stable.
    """
    def wrapped(*args: Any, **kwargs: Any) -> dict:
        store = profile_store(*args, **kwargs)
        store["dia"] = f"{insulin_duration_hours:g}"
        return store
    return wrapped


class TandemSync:
    """Runs tconnectsync's time-range processing for the recent lookback window."""

    def __init__(self, config: Config) -> None:
        configure_tconnectsync_env(config)
        # pylint: disable=import-outside-toplevel
        from tconnectsync import secret
        from tconnectsync.api import TConnectApi
        from tconnectsync.nightscout import NightscoutApi
        from tconnectsync.parser.nightscout import NightscoutEntry
        from tconnectsync.sync.tandemsource.choose_device import ChooseDevice
        from tconnectsync.sync.tandemsource.process import ProcessTimeRange

        if secret.TIMEZONE_NAME != config.timezone_name:
            raise RuntimeError(
                "tconnectsync was imported before its environment was configured "
                f"(TIMEZONE_NAME={secret.TIMEZONE_NAME!r})")

        if not getattr(NightscoutEntry, "_leveling_up_dia", False):
            NightscoutEntry.tandemsource_profile_store = staticmethod(with_dia_override(
                NightscoutEntry.tandemsource_profile_store, config.insulin_duration_hours))
            NightscoutEntry._leveling_up_dia = True
        bolus_details.install()
        basal_details.install()

        self._secret = secret
        self._process_cls = ProcessTimeRange
        self._tz = config.timezone_name
        self._lookback_hours = config.tandem_lookback_hours
        self._tconnect = TConnectApi(config.tconnect_email, config.tconnect_password,
                                     config.tconnect_region)
        self._nightscout = NightscoutApi(config.ns_url, config.ns_secret)
        self._status_client = NightscoutClient(config.ns_url, config.ns_secret)
        self._choose_device = lambda: ChooseDevice(secret, self._tconnect).choose()
        self._device = None
        # Freshness state published after every run (see sync_status.py).
        self._synced_at: Optional[datetime.datetime] = None
        self._pump_uploaded_at: Optional[datetime.datetime] = None
        self._newest_event_at: Optional[datetime.datetime] = None
        self._upload_client: Optional[str] = None
        # Incremental read state (see plan_read).
        self._processed_event_at: Optional[datetime.datetime] = None
        self._last_full_at: Optional[datetime.datetime] = None

    def run(self) -> str:
        """Runs one sync pass, publishes freshness, and returns a short summary."""
        # Must be timezone-aware: tconnectsync's own CLI passes a naive local
        # time, which arrow treats as UTC and yields negative basal durations.
        time_end = arrow.now(self._tz)
        error = None
        try:
            if self._device is None:
                self._device = self._choose_device()
            # Read pump upload times before processing so they never claim
            # data newer than what this run pulled.
            newest_event = self._refresh_pump_times()
            plan = plan_read(time_end.datetime, newest_event, self._processed_event_at,
                             self._last_full_at, datetime.timedelta(hours=self._lookback_hours))
            if plan.start is None:
                summary = f"skipped: no new pump data since {arrow.get(newest_event):h:mm A}"
            else:
                time_start = arrow.get(plan.start).to(self._tz)
                added, last_event_id = self._process_cls(
                    self._tconnect, self._nightscout, self._device, pretend=False,
                    secret=self._secret, features=list(FEATURES)).process(time_start, time_end)
                self._processed_event_at = newest_event
                if plan.full:
                    self._last_full_at = time_end.datetime
                window = "full" if plan.full else f"from {time_start:h:mm A}"
                summary = f"uploaded {added}, last event {last_event_id} ({window})"
            self._synced_at = time_end.datetime
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            raise
        finally:
            self._publish_status(time_end.datetime, error)
        logger.info("tandem: %s", summary)
        return summary

    def _refresh_pump_times(self) -> Optional[datetime.datetime]:
        """Reads the pump record; returns its newest event time, or None if unavailable.

        The freshness fields keep their last known values when the pump isn't found.
        """
        # ChooseDevice returns the pump record itself; match on its id.
        device_id = (self._device.get("assignmentId") if isinstance(self._device, dict)
                     else self._device)
        pumps = self._tconnect.tandemsource.get_pumper().get("pumps", [])
        pump = next((p for p in pumps if p.get("assignmentId") == device_id), None)
        if pump is None:
            return None
        self._pump_uploaded_at, self._newest_event_at = sync_status.parse_pump_times(pump, self._tz)
        self._upload_client = pump.get("lastUploadClientType")
        return self._newest_event_at

    def _publish_status(self, checked_at: datetime.datetime, error: Optional[str]) -> None:
        status = sync_status.build_status(checked_at, self._synced_at, self._pump_uploaded_at,
                                          self._newest_event_at, self._upload_client, error)
        try:
            self._status_client.post_devicestatus(status)
            self._status_client.prune_devicestatus(
                sync_status.DEVICE, checked_at - sync_status.RETENTION)
        except Exception:  # pylint: disable=broad-except
            # Freshness is informational; never fail the sync over it.
            logger.warning("could not publish sync status", exc_info=True)
