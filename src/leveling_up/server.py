"""Small HTTP control API for the running service.

Routes:
    GET  /status          Job and boost state.
    POST /boost           Boost Tandem polling; optional ?minutes=N.
    POST /boost/cancel    End the boost early.
    POST /sync/<job>      Run a job now (dexcom or tandem).
"""

import hmac
import http.server
import json
import logging
import socketserver
import threading
import urllib.parse
from typing import Any

from leveling_up.scheduler import Boost, Scheduler, _iso

logger = logging.getLogger(__name__)

TANDEM_JOB = "tandem"


class _HTTPServer(http.server.ThreadingHTTPServer):
    """Skips HTTPServer's reverse DNS lookup of the bind address, which can stall."""

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name, self.server_port = host, port


class ControlServer:
    """Serves the control API on a background thread."""

    def __init__(self, host: str, port: int, token: str, scheduler: Scheduler,
                 boost: Boost) -> None:
        self._scheduler = scheduler
        self._boost = boost
        self._token = token
        handler = self._make_handler()
        self._httpd = _HTTPServer((host, port), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def address(self) -> tuple[str, int]:
        return self._httpd.server_address[:2]

    def start(self) -> None:
        self._thread.start()
        logger.info("control API listening on %s:%d", *self.address)

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def status(self) -> dict:
        return {
            "jobs": self._scheduler.status(),
            "boost": {
                "active": self._boost.is_active(),
                "until": _iso(self._boost.active_until) if self._boost.is_active() else None,
            },
        }

    def boost(self, minutes: float | None) -> dict:
        self._boost.activate(None if minutes is None else minutes * 60)
        self._scheduler.trigger(TANDEM_JOB)
        return self.status()

    def _make_handler(self) -> type[http.server.BaseHTTPRequestHandler]:
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            """Routes control API requests."""

            def log_message(self, fmt: str, *args: Any) -> None:
                logger.debug("control: " + fmt, *args)

            def _send(self, code: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authorized(self) -> bool:
                if not server._token:
                    return True
                given = self.headers.get("Authorization", "")
                return hmac.compare_digest(given, f"Bearer {server._token}")

            def do_GET(self) -> None:  # pylint: disable=invalid-name
                if not self._authorized():
                    return self._send(401, {"error": "unauthorized"})
                if urllib.parse.urlparse(self.path).path == "/status":
                    return self._send(200, server.status())
                return self._send(404, {"error": "not found"})

            def do_POST(self) -> None:  # pylint: disable=invalid-name
                if not self._authorized():
                    return self._send(401, {"error": "unauthorized"})
                url = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(url.query)
                if url.path == "/boost":
                    try:
                        minutes = float(query["minutes"][0]) if "minutes" in query else None
                    except ValueError:
                        return self._send(400, {"error": "minutes must be a number"})
                    if minutes is not None and not 0 < minutes <= 240:
                        return self._send(400, {"error": "minutes must be in (0, 240]"})
                    return self._send(200, server.boost(minutes))
                if url.path == "/boost/cancel":
                    server._boost.cancel()
                    return self._send(200, server.status())
                if url.path.startswith("/sync/"):
                    job = url.path.removeprefix("/sync/")
                    try:
                        server._scheduler.trigger(job)
                    except KeyError:
                        return self._send(404, {"error": f"unknown job {job!r}"})
                    return self._send(200, server.status())
                return self._send(404, {"error": "not found"})

        return Handler
