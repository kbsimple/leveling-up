"""Service configuration, read from environment variables."""

import dataclasses
import os
from typing import Mapping


class ConfigError(ValueError):
    """Raised when required settings are missing or invalid."""


_REQUIRED = (
    "DEXCOM_USERNAME",
    "DEXCOM_PASSWORD",
    "TCONNECT_EMAIL",
    "TCONNECT_PASSWORD",
    "NS_URL",
    "NS_SECRET",
)


@dataclasses.dataclass(frozen=True)
class Config:
    """All settings for the sync service."""

    dexcom_username: str
    dexcom_password: str
    dexcom_region: str
    tconnect_email: str
    tconnect_password: str
    tconnect_region: str
    ns_url: str
    ns_secret: str
    timezone_name: str
    insulin_duration_hours: float
    dexcom_interval_minutes: float
    tandem_interval_minutes: float
    boost_interval_minutes: float
    boost_duration_minutes: float
    tandem_lookback_hours: float
    control_host: str
    control_port: int
    control_token: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Config":
        """Builds a Config from environment variables.

        Args:
            env: Mapping to read from; defaults to the process environment.

        Returns:
            The parsed Config.

        Raises:
            ConfigError: If required variables are missing or values are invalid.
        """
        missing = [name for name in _REQUIRED if not env.get(name)]
        if missing:
            raise ConfigError("missing required settings: " + ", ".join(missing))

        def number(name: str, default: str) -> float:
            raw = env.get(name) or default
            try:
                value = float(raw)
            except ValueError as e:
                raise ConfigError(f"{name} must be a number, got {raw!r}") from e
            if value <= 0:
                raise ConfigError(f"{name} must be positive, got {raw!r}")
            return value

        config = cls(
            dexcom_username=env["DEXCOM_USERNAME"],
            dexcom_password=env["DEXCOM_PASSWORD"],
            dexcom_region=env.get("DEXCOM_REGION") or "us",
            tconnect_email=env["TCONNECT_EMAIL"],
            tconnect_password=env["TCONNECT_PASSWORD"],
            tconnect_region=(env.get("TCONNECT_REGION") or "US").upper(),
            ns_url=env["NS_URL"].rstrip("/") + "/",
            ns_secret=env["NS_SECRET"],
            timezone_name=env.get("TIMEZONE_NAME") or "America/Los_Angeles",
            insulin_duration_hours=number("INSULIN_DURATION_HOURS", "5"),
            dexcom_interval_minutes=number("DEXCOM_INTERVAL_MINUTES", "5"),
            tandem_interval_minutes=number("TANDEM_INTERVAL_MINUTES", "15"),
            boost_interval_minutes=number("BOOST_INTERVAL_MINUTES", "5"),
            boost_duration_minutes=number("BOOST_DURATION_MINUTES", "30"),
            tandem_lookback_hours=number("TANDEM_LOOKBACK_HOURS", "24"),
            control_host=env.get("CONTROL_HOST") or "127.0.0.1",
            control_port=int(number("CONTROL_PORT", "8787")),
            control_token=env.get("CONTROL_TOKEN") or "",
        )
        if config.control_host not in ("127.0.0.1", "localhost", "::1") and not config.control_token:
            raise ConfigError("CONTROL_TOKEN is required when CONTROL_HOST is not loopback")
        return config
