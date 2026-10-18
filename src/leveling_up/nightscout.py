"""Minimal Nightscout REST client."""

import datetime
import hashlib
from typing import Any, Optional

import requests

_TIMEOUT_SECONDS = 30


class NightscoutClient:
    """Talks to the Nightscout v1 API using the API secret."""

    def __init__(self, url: str, secret: str, session: Optional[requests.Session] = None) -> None:
        self._url = url.rstrip("/") + "/"
        self._session = session or requests.Session()
        self._session.headers["api-secret"] = hashlib.sha1(secret.encode()).hexdigest()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = self._session.request(method, self._url + path, timeout=_TIMEOUT_SECONDS, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        """GETs `path` (relative to the site root) and returns the decoded JSON."""
        return self._request("GET", path, params=params)

    def latest_sgv_ms(self, device: str) -> int:
        """Returns the epoch-ms date of the newest sgv entry from `device`, or 0."""
        entries = self._request(
            "GET", "api/v1/entries/sgv.json", params={"count": 1, "find[device]": device})
        return entries[0]["date"] if entries else 0

    def post_entries(self, entries: list[dict]) -> None:
        self._request("POST", "api/v1/entries", json=entries)

    def profiles(self) -> list[dict]:
        """Returns all profile documents, newest first."""
        return self._request("GET", "api/v1/profile.json", params={"count": 1000})

    def put_profile(self, profile: dict) -> None:
        self._request("PUT", "api/v1/profile", json=profile)

    def delete_profile(self, profile_id: str) -> None:
        self._request("DELETE", f"api/v1/profile/{profile_id}")

    def post_devicestatus(self, status: dict) -> None:
        self._request("POST", "api/v1/devicestatus", json=status)

    def prune_devicestatus(self, device: str, older_than: datetime.datetime) -> int:
        """Deletes `device`'s devicestatus records created before `older_than`.

        The newest record is always kept. Returns the number deleted.
        """
        records = self._request(
            "GET", "api/v1/devicestatus.json", params={"count": 1000, "find[device]": device})
        mine = [r for r in records if r.get("device") == device and r.get("created_at")]
        mine.sort(key=lambda r: r["created_at"], reverse=True)
        stale = [r for r in mine[1:] if _parse_time(r["created_at"]) < older_than]
        for record in stale:
            self._request("DELETE", f"api/v1/devicestatus/{record['_id']}")
        return len(stale)


def _parse_time(value: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def prune_profile_doc(doc: dict, insulin_duration_hours: float) -> dict:
    """Returns a copy of a profile document keeping only its default profile.

    The kept profile's DIA is set to `insulin_duration_hours`. Nightscout requires
    top-level profile fields to be strings, so DIA is stored as a string.

    Raises:
        ValueError: If the document's default profile is not in its store.
    """
    default = doc.get("defaultProfile")
    store = doc.get("store", {})
    if default not in store:
        raise ValueError(f"default profile {default!r} not found in store")
    kept = dict(store[default], dia=f"{insulin_duration_hours:g}")
    pruned = {k: v for k, v in doc.items() if k != "store"}
    pruned["store"] = {default: kept}
    return pruned
