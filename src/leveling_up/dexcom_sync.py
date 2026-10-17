"""Uploads Dexcom Share readings to Nightscout as sgv entries."""

import logging
from typing import Any, Callable, Optional

from leveling_up.nightscout import NightscoutClient

logger = logging.getLogger(__name__)

DEVICE = "leveling-up (dexcom-share)"

# Dexcom Share caps a request at 288 readings (24h at 5-minute intervals).
_MAX_COUNT = 288

# pydexcom uses Dexcom's direction names; Nightscout spells a few differently.
_DIRECTION_FIXUPS = {
    "None": "NONE",
    "NotComputable": "NOT COMPUTABLE",
    "RateOutOfRange": "RATE OUT OF RANGE",
}


def reading_to_entry(reading: Any) -> dict:
    """Converts a pydexcom GlucoseReading to a Nightscout sgv entry."""
    return {
        "type": "sgv",
        "sgv": reading.mg_dl,
        "direction": _DIRECTION_FIXUPS.get(reading.trend_direction, reading.trend_direction),
        "date": int(reading.datetime.timestamp() * 1000),
        "dateString": reading.datetime.isoformat(),
        "device": DEVICE,
    }


class DexcomSync:
    """Fetches recent readings and uploads those newer than Nightscout's latest."""

    def __init__(self, dexcom_factory: Callable[[], Any], nightscout: NightscoutClient,
                 lookback_minutes: int = 180) -> None:
        self._dexcom_factory = dexcom_factory
        self._dexcom: Optional[Any] = None
        self._nightscout = nightscout
        self._lookback_minutes = lookback_minutes

    def run(self) -> str:
        """Runs one sync pass and returns a short summary."""
        if self._dexcom is None:
            self._dexcom = self._dexcom_factory()
        try:
            readings = self._dexcom.get_glucose_readings(
                minutes=self._lookback_minutes,
                max_count=min(_MAX_COUNT, self._lookback_minutes // 5 + 1))
        except Exception:
            # Force a fresh login next time in case the session went bad.
            self._dexcom = None
            raise

        latest_ms = self._nightscout.latest_sgv_ms(DEVICE)
        entries = [e for e in map(reading_to_entry, readings) if e["date"] > latest_ms]
        if entries:
            self._nightscout.post_entries(entries)
        summary = f"fetched {len(readings)}, uploaded {len(entries)}"
        logger.info("dexcom: %s", summary)
        return summary
