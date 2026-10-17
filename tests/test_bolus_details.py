"""Tests for bolus calculator details, using values seen on a real pump."""

import types

import pytest

from leveling_up.bolus_details import bolus_details


def ns(**kwargs):
    return types.SimpleNamespace(**kwargs)


def completed(requested, delivered=None, status=3, bolus_id=1):
    return ns(bolusId=bolus_id, insulinRequested=requested,
              insulinDelivered=requested if delivered is None else delivered,
              completionStatusRaw=status)


def req1(bolus_type):
    return ns(bolusTypeRaw=bolus_type)


def req2(options, duration=0, declined=0):
    return ns(optionsRaw=options, duration=duration, declinedCorrectionRaw=declined)


def req3(food, correction, total):
    return ns(foodBolusSize=food, correctionBolusSize=correction, totalBolusSize=total)


def delivery(now, later=0):
    return ns(requestedNow=now, requestedLater=later)


def test_automatic_correction():
    details = bolus_details(completed(0.69438845), req1(2), req2(3), req3(0, 0.69438845, 0.69438845),
                            delivery(694))
    assert details == {
        "bolusId": 1,
        "automatic": True,
        "foodInsulin": 0,
        "correctionInsulin": 0.69,
        "suggestedInsulin": 0.69,
        "requestedInsulin": 0.69,
    }


def test_manual_carb_and_correction():
    details = bolus_details(completed(3.18), req1(3), req2(4), req3(2.81, 0.37, 3.18), delivery(3180))
    assert details["automatic"] is False
    assert (details["foodInsulin"], details["correctionInsulin"]) == (2.81, 0.37)
    assert details["suggestedInsulin"] == details["requestedInsulin"] == 3.18
    assert "extendedInsulin" not in details


def test_extended_bolus_requested_includes_later_portion():
    # Correction and half the carb portion now, the rest over 2 hours.
    details = bolus_details(completed(2.285), req1(3), req2(5, duration=120),
                            req3(4.33, 0.12, 4.4500003), delivery(2285, 2165))
    assert details["requestedInsulin"] == 4.45
    assert details["suggestedInsulin"] == 4.45
    assert details["extendedInsulin"] == pytest.approx(2.165, abs=0.01)
    assert details["extendedMinutes"] == 120


def test_user_changed_amount():
    details = bolus_details(completed(2.0), req1(3), req2(4), req3(2.35, 0, 2.35), delivery(2000))
    assert details["requestedInsulin"] - details["suggestedInsulin"] == pytest.approx(-0.35)


def test_stopped_early():
    details = bolus_details(completed(1.399343, delivered=0.795, status=1), req1(2), req2(3),
                            req3(0, 1.399343, 1.399343), delivery(1399))
    assert details["completion"] == "stopped by alarm"


def test_declined_correction():
    details = bolus_details(completed(1.76), req1(3), req2(4, declined=1), req3(1.76, 0, 1.76),
                            delivery(1760))
    assert details["declinedCorrection"] is True


def test_missing_request_events_falls_back_to_completion():
    details = bolus_details(completed(0.5), None, None, None, None)
    assert details == {"bolusId": 1, "automatic": False, "requestedInsulin": 0.5}
