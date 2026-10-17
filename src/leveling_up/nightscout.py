"""Minimal Nightscout REST client."""

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
