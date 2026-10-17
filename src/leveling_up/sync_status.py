"""Publishes data freshness to Nightscout as a devicestatus record.

Nothing in Nightscout otherwise records when the pump last uploaded to Tandem
or when Tandem data last reached Nightscout, so after every Tandem run the
service posts:

    {
      "device": "leveling-up",
      "created_at": <now>,
      "levelingUp": {
        "tandem": {
          "checkedAt":      when this sync attempt ran,
          "syncedAt":       last successful Tandem -> Nightscout sync,
          "pumpUploadedAt": last pump -> Tandem cloud upload (Tandem's lastUploadDate),
          "newestEventAt":  newest pump event in Tandem (pump clock, localized),
          "uploadClient":   what uploaded it (e.g. "mobile_mobi"),
          "error":          the failure, if this attempt failed
        }
      }
    }

The widget and web app read the newest record, and the web graph plots the
distinct pump uploads across the retained records; the field names are part of
that contract (see fixtures/sync-status-cases.json).
"""

import datetime
from typing import Optional
from zoneinfo import ZoneInfo

DEVICE = "leveling-up"
# How long records are kept; older ones are deleted after each post. Covers the
# web graph's widest (24h) window, which plots each pump upload.
RETENTION = datetime.timedelta(hours=26)


def _iso(value: Optional[datetime.datetime]) -> Optional[str]:
    return value.isoformat(timespec="seconds") if value else None


def parse_pump_times(pump: dict, timezone_name: str) -> tuple[Optional[datetime.datetime],
                                                               Optional[datetime.datetime]]:
    """Returns (pump uploaded at, newest event at) from a Tandem Source pump record.

    `lastUploadDate` is UTC ("...Z"). `maxDateOfEvents` is the pump's wall clock
    with no zone, so it is localized to the pump's timezone.
    """
    uploaded = None
    if raw := pump.get("lastUploadDate"):
        uploaded = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    newest = None
    if raw := pump.get("maxDateOfEvents"):
        parsed = datetime.datetime.fromisoformat(raw)
        newest = parsed if parsed.tzinfo else parsed.replace(tzinfo=ZoneInfo(timezone_name))
    return uploaded, newest


def build_status(checked_at: datetime.datetime, synced_at: Optional[datetime.datetime],
                 pump_uploaded_at: Optional[datetime.datetime],
                 newest_event_at: Optional[datetime.datetime], upload_client: Optional[str],
                 error: Optional[str]) -> dict:
    """Builds the devicestatus document described in the module docstring."""
    tandem = {
        "checkedAt": _iso(checked_at),
        "syncedAt": _iso(synced_at),
        "pumpUploadedAt": _iso(pump_uploaded_at),
        "newestEventAt": _iso(newest_event_at),
        "uploadClient": upload_client,
    }
    if error:
        tandem["error"] = error
    return {"device": DEVICE, "created_at": _iso(checked_at), "levelingUp": {"tandem": tandem}}
