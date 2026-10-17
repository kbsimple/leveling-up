"""Tests for the control API."""

import pytest
import requests

from leveling_up.scheduler import Boost, Job, Scheduler
from leveling_up.server import ControlServer


@pytest.fixture
def make_server():
    servers = []

    def make(token=""):
        boost = Boost(900, 300, 1800)
        scheduler = Scheduler([
            Job("dexcom", lambda: "ok", lambda: 300),
            Job("tandem", lambda: "ok", boost.interval),
        ])
        scheduler.run_due()
        server = ControlServer("127.0.0.1", 0, token, scheduler, boost)
        server.start()
        servers.append(server)
        host, port = server.address
        return f"http://{host}:{port}", scheduler, boost

    yield make
    for server in servers:
        server.stop()


def test_status(make_server):
    url, _, _ = make_server()
    body = requests.get(url + "/status", timeout=5).json()
    assert body["boost"] == {"active": False, "until": None}
    assert body["jobs"]["tandem"]["interval_minutes"] == 15
    assert body["jobs"]["dexcom"]["last_result"] == "ok"


def test_boost_activates_and_triggers_tandem(make_server):
    url, scheduler, boost = make_server()
    body = requests.post(url + "/boost?minutes=10", timeout=5).json()
    assert body["boost"]["active"]
    assert body["jobs"]["tandem"]["interval_minutes"] == 5
    assert scheduler.seconds_until_next() == 0
    requests.post(url + "/boost/cancel", timeout=5)
    assert not boost.is_active()


def test_boost_rejects_bad_minutes(make_server):
    url, _, _ = make_server()
    assert requests.post(url + "/boost?minutes=abc", timeout=5).status_code == 400
    assert requests.post(url + "/boost?minutes=999", timeout=5).status_code == 400


def test_sync_trigger(make_server):
    url, scheduler, _ = make_server()
    assert requests.post(url + "/sync/dexcom", timeout=5).status_code == 200
    assert scheduler.seconds_until_next() == 0
    assert requests.post(url + "/sync/nope", timeout=5).status_code == 404


def test_token_required_when_configured(make_server):
    url, _, _ = make_server(token="secret")
    assert requests.get(url + "/status", timeout=5).status_code == 401
    headers = {"Authorization": "Bearer secret"}
    assert requests.get(url + "/status", headers=headers, timeout=5).status_code == 200
