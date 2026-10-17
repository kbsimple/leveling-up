"""Syncs Tandem Source pump data to Nightscout using tconnectsync.

tconnectsync reads its settings from environment variables at import time, so
`configure_tconnectsync_env` must run before this module's lazy imports.
"""

import datetime
import logging
import os
from typing import Any, Callable, Optional

import arrow

from leveling_up import bolus_details, sync_status
from leveling_up.config import Config
from leveling_up.nightscout import NightscoutClient

logger = logging.getLogger(__name__)

# tconnectsync's IOB feature produces nothing for Tandem Source; Nightscout
# computes IOB from the uploaded boluses and the profile's DIA instead.
FEATURES = ("BASAL", "BOLUS", "PUMP_EVENTS", "PROFILES")


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
            self._refresh_pump_times()
            time_start = time_end.shift(hours=-self._lookback_hours)
            added, last_event_id = self._process_cls(
                self._tconnect, self._nightscout, self._device, pretend=False,
                secret=self._secret, features=list(FEATURES)).process(time_start, time_end)
            self._synced_at = time_end.datetime
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            raise
        finally:
            self._publish_status(time_end.datetime, error)
        summary = f"uploaded {added}, last event {last_event_id}"
        logger.info("tandem: %s", summary)
        return summary

    def _refresh_pump_times(self) -> None:
        # ChooseDevice returns the pump record itself; match on its id.
        device_id = (self._device.get("assignmentId") if isinstance(self._device, dict)
                     else self._device)
        pumps = self._tconnect.tandemsource.get_pumper().get("pumps", [])
        pump = next((p for p in pumps if p.get("assignmentId") == device_id), None)
        if pump is None:
            return
        self._pump_uploaded_at, self._newest_event_at = sync_status.parse_pump_times(pump, self._tz)
        self._upload_client = pump.get("lastUploadClientType")

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
