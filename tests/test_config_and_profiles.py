"""Tests for configuration, profile pruning, and the DIA override."""

import pytest

from leveling_up.config import Config, ConfigError
from leveling_up.nightscout import prune_profile_doc
from leveling_up.tandem_sync import with_dia_override

BASE_ENV = {
    "DEXCOM_USERNAME": "u",
    "DEXCOM_PASSWORD": "p",
    "TCONNECT_EMAIL": "e@example.com",
    "TCONNECT_PASSWORD": "p",
    "NS_URL": "https://ns.example.com",
    "NS_SECRET": "s",
}


def test_config_defaults():
    config = Config.from_env(BASE_ENV)
    assert config.ns_url == "https://ns.example.com/"
    assert config.dexcom_interval_minutes == 5
    assert config.tandem_interval_minutes == 15
    assert config.boost_interval_minutes == 5
    assert config.boost_duration_minutes == 30
    assert config.insulin_duration_hours == 5
    assert config.timezone_name == "America/Los_Angeles"
    assert config.control_host == "127.0.0.1"


def test_config_missing_required():
    env = dict(BASE_ENV)
    del env["NS_SECRET"]
    with pytest.raises(ConfigError, match="NS_SECRET"):
        Config.from_env(env)


def test_config_rejects_bad_number():
    with pytest.raises(ConfigError, match="TANDEM_INTERVAL_MINUTES"):
        Config.from_env({**BASE_ENV, "TANDEM_INTERVAL_MINUTES": "soon"})


def test_config_requires_token_when_exposed():
    with pytest.raises(ConfigError, match="CONTROL_TOKEN"):
        Config.from_env({**BASE_ENV, "CONTROL_HOST": "0.0.0.0"})
    config = Config.from_env({**BASE_ENV, "CONTROL_HOST": "0.0.0.0", "CONTROL_TOKEN": "t"})
    assert config.control_token == "t"


def test_prune_profile_doc_keeps_default_and_sets_dia():
    doc = {
        "_id": "abc",
        "defaultProfile": "frog",
        "store": {"frog": {"dia": "3.0", "basal": [1]}, "old": {"dia": "3.0"}},
        "units": "mg/dl",
    }
    pruned = prune_profile_doc(doc, 5)
    assert pruned == {
        "_id": "abc",
        "defaultProfile": "frog",
        "store": {"frog": {"dia": "5", "basal": [1]}},
        "units": "mg/dl",
    }
    assert doc["store"]["frog"]["dia"] == "3.0"  # input not mutated


def test_prune_profile_doc_missing_default():
    with pytest.raises(ValueError):
        prune_profile_doc({"defaultProfile": "x", "store": {}}, 5)


def test_dia_override():
    convert = with_dia_override(lambda profile, settings: {"dia": "3.0", "name": profile}, 5)
    assert convert("frog", None) == {"dia": "5", "name": "frog"}
