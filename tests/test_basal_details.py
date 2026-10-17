"""Tests for basal rate details, using values seen on a real pump."""

import types

from leveling_up.basal_details import basal_details


def delivery(profile, algorithm, temp):
    return types.SimpleNamespace(profileBasalRate=profile, algorithmRate=algorithm, tempRate=temp)


def test_temp_rate_with_control_iq():
    # 25% temp rate while Control-IQ raised delivery well above it.
    assert basal_details(delivery(400, 1375, 100)) == {
        "profileRate": 0.4, "algorithmRate": 1.375, "tempRate": 0.1,
    }


def test_no_temp_rate():
    assert basal_details(delivery(425, 440, 0xFFFF)) == {"profileRate": 0.425, "algorithmRate": 0.44}


def test_missing_fields():
    assert basal_details(types.SimpleNamespace()) == {}
