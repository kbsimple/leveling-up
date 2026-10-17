"""Adds rate details to the Temp Basal treatments tconnectsync uploads.

Each 5-minute basal delivery event records the profile rate, Control-IQ's
rate, and any user-set temp rate alongside the delivered rate, but tconnectsync
uploads only the delivered rate and a source label. These are added to each
treatment, in U/hr:

    profileRate     Scheduled rate from the active profile.
    algorithmRate   Control-IQ's rate.
    tempRate        The user's temp rate setting; absent when none is active.

The pump has no separate temp-rate start/stop events in Tandem Source, so temp
rate periods are derived from consecutive treatments that carry `tempRate`.
"""

from typing import Any

# LidBasalDelivery rate fields use this value for "not set".
_UNSET = 0xFFFF


def _units(milliunits: int) -> float:
    return round(milliunits / 1000, 3)


def basal_details(event: Any) -> dict:
    """Extra treatment fields for a LidBasalDelivery event (rates in milliunits/hr)."""
    details = {}
    for field, key in (("profileBasalRate", "profileRate"), ("algorithmRate", "algorithmRate"),
                       ("tempRate", "tempRate")):
        value = getattr(event, field, None)
        if value is not None and value != _UNSET:
            details[key] = _units(value)
    return details


def install() -> None:
    """Patches tconnectsync's basal conversion to add `basal_details` fields. Idempotent."""
    # pylint: disable=import-outside-toplevel
    from tconnectsync.eventparser import events
    from tconnectsync.sync.tandemsource.process_basal import ProcessBasal

    if getattr(ProcessBasal, "_leveling_up_details", False):
        return
    original = ProcessBasal.basal_to_nsentry

    def basal_to_nsentry(self, start, duration, event):
        entry = original(self, start, duration, event)
        if entry is not None and isinstance(event, events.LidBasalDelivery):
            entry.update(basal_details(event))
        return entry

    ProcessBasal.basal_to_nsentry = basal_to_nsentry
    ProcessBasal._leveling_up_details = True
