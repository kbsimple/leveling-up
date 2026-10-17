"""Adds bolus calculator details to the Nightscout treatments tconnectsync uploads.

tconnectsync uploads only the delivered amount, carbs and BG. The pump also
records the carb/correction split, the suggested and requested amounts, any
extended portion and whether delivery was cut short. These are added to each
treatment as extra fields:

    bolusId             Pump bolus id; also on the extended-portion entry.
    automatic           True for Control-IQ boluses.
    foodInsulin         Units the calculator attributed to carbs.
    correctionInsulin   Units attributed to correction (may be negative).
    suggestedInsulin    Calculator total (food + correction).
    requestedInsulin    What was actually requested, now + extended.
    extendedInsulin     Extended (later) portion requested, if any.
    extendedMinutes     Extended duration, if any.
    declinedCorrection  True if the user declined the suggested correction.
    completion          Why delivery stopped early; absent when completed.

`insulin` stays the amount delivered at bolus time, as tconnectsync sets it.
"""

from typing import Any, Optional

# LidBolusRequestedMsg2.optionsRaw values for Control-IQ boluses.
_AUTOMATIC_OPTIONS = (3, 6)  # Automatic Bolus, Eating Soon Automatic Bolus
# LidBolusRequestedMsg1.bolusTypeRaw for Control-IQ corrections.
_AUTOMATIC_CORRECTION_TYPE = 2
_COMPLETED = 3
_COMPLETION_NAMES = {
    0: "user aborted",
    1: "stopped by alarm",
    2: "stopped by malfunction",
    5: "rejected",
    6: "aborted by Control-IQ",
}


def _units(value: float) -> float:
    return round(value, 2)


def bolus_details(completed: Any, request1: Optional[Any], request2: Optional[Any],
                  request3: Optional[Any], delivery: Optional[Any]) -> dict:
    """Builds the extra treatment fields for one bolus from its pump events.

    Args:
        completed: LidBolusCompleted.
        request1: LidBolusRequestedMsg1 (bolus type), if present.
        request2: LidBolusRequestedMsg2 (options, override, duration), if present.
        request3: LidBolusRequestedMsg3 (food/correction/total sizes), if present.
        delivery: LidBolusDelivery (requested now/later, milliunits), if present.
    """
    details: dict = {"bolusId": completed.bolusId}
    details["automatic"] = bool(
        (request2 is not None and request2.optionsRaw in _AUTOMATIC_OPTIONS)
        or (request1 is not None and request1.bolusTypeRaw == _AUTOMATIC_CORRECTION_TYPE))

    if request3 is not None:
        details["foodInsulin"] = _units(request3.foodBolusSize)
        details["correctionInsulin"] = _units(request3.correctionBolusSize)
        details["suggestedInsulin"] = _units(request3.totalBolusSize)

    if delivery is not None:
        details["requestedInsulin"] = _units((delivery.requestedNow + delivery.requestedLater) / 1000)
        if delivery.requestedLater:
            details["extendedInsulin"] = _units(delivery.requestedLater / 1000)
            if request2 is not None and request2.duration:
                details["extendedMinutes"] = request2.duration
    else:
        details["requestedInsulin"] = _units(completed.insulinRequested)

    if request2 is not None and request2.declinedCorrectionRaw == 1:
        details["declinedCorrection"] = True

    if completed.completionStatusRaw != _COMPLETED:
        details["completion"] = _COMPLETION_NAMES.get(
            completed.completionStatusRaw, f"status {completed.completionStatusRaw}")
    return details


def install() -> None:
    """Patches tconnectsync's bolus processing to add `bolus_details` fields.

    Idempotent. Must run after tconnectsync's environment is configured.
    """
    # pylint: disable=import-outside-toplevel
    from tconnectsync.domain.tandemsource.event_class import EventClass
    from tconnectsync.eventparser import events
    from tconnectsync.sync.tandemsource.process_bolus import ProcessBolus

    if getattr(ProcessBolus, "_leveling_up_details", False):
        return

    # Route delivery events (requested now/later) to the bolus processor too.
    EventClass.BOLUS.add(events.LidBolusDelivery)

    original_process = ProcessBolus.process
    original_bolus = ProcessBolus.bolus_to_nsentry
    original_bolex = ProcessBolus.bolex_to_nsentry

    def process(self, events_in, time_start, time_end):
        events_in = list(events_in)
        self._leveling_up_deliveries = {
            e.bolusId: e for e in events_in if isinstance(e, events.LidBolusDelivery)}
        return original_process(self, events_in, time_start, time_end)

    def bolus_to_nsentry(self, completed, bolusRequested1, bolusRequested2, bolusRequested3):
        entry = original_bolus(self, completed, bolusRequested1, bolusRequested2, bolusRequested3)
        delivery = getattr(self, "_leveling_up_deliveries", {}).get(completed.bolusId)
        entry.update(bolus_details(completed, bolusRequested1, bolusRequested2, bolusRequested3,
                                   delivery))
        return entry

    def bolex_to_nsentry(self, bolexCompleted):
        entry = original_bolex(self, bolexCompleted)
        entry.update({"bolusId": bolexCompleted.bolusId, "extendedPortion": True})
        return entry

    ProcessBolus.process = process
    ProcessBolus.bolus_to_nsentry = bolus_to_nsentry
    ProcessBolus.bolex_to_nsentry = bolex_to_nsentry
    ProcessBolus._leveling_up_details = True
