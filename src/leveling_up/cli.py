"""Command-line entry point.

Commands:
    run                 Run the scheduler and control API (the service).
    sync dexcom|tandem  Run one sync pass in this process.
    boost [--minutes N] Ask the running service to poll Tandem more often.
    boost --cancel      End a boost early.
    status              Show the running service's job state.
    cleanup-profiles    Keep only the default Nightscout profile, with DIA set.
"""

import argparse
import json
import logging
import os
import signal
import sys
import threading
from typing import Optional

import requests
from dotenv import load_dotenv

from leveling_up.config import Config, ConfigError
from leveling_up.nightscout import NightscoutClient, prune_profile_doc

logger = logging.getLogger("leveling_up")


def _dexcom_sync(config: Config, nightscout: NightscoutClient):
    # pylint: disable=import-outside-toplevel
    from pydexcom import Dexcom

    from leveling_up.dexcom_sync import DexcomSync

    def factory() -> Dexcom:
        return Dexcom(username=config.dexcom_username, password=config.dexcom_password,
                      region=config.dexcom_region)
    return DexcomSync(factory, nightscout)


def _tandem_sync(config: Config):
    from leveling_up.tandem_sync import TandemSync  # pylint: disable=import-outside-toplevel
    return TandemSync(config)


def _run(config: Config) -> int:
    # pylint: disable=import-outside-toplevel
    from leveling_up.scheduler import Boost, Job, Scheduler
    from leveling_up.server import TANDEM_JOB, ControlServer

    nightscout = NightscoutClient(config.ns_url, config.ns_secret)
    dexcom = _dexcom_sync(config, nightscout)
    tandem = _tandem_sync(config)
    boost = Boost(normal_seconds=config.tandem_interval_minutes * 60,
                  boosted_seconds=config.boost_interval_minutes * 60,
                  default_duration_seconds=config.boost_duration_minutes * 60)
    scheduler = Scheduler([
        Job("dexcom", dexcom.run, lambda: config.dexcom_interval_minutes * 60),
        Job(TANDEM_JOB, tandem.run, boost.interval),
    ])
    server = ControlServer(config.control_host, config.control_port, config.control_token,
                           scheduler, boost)
    server.start()

    stop = threading.Event()

    def on_signal(*_) -> None:
        stop.set()
        scheduler.wake()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, on_signal)
    logger.info("service started: dexcom every %g min, tandem every %g min (boost %g min for %g min)",
                config.dexcom_interval_minutes, config.tandem_interval_minutes,
                config.boost_interval_minutes, config.boost_duration_minutes)
    scheduler.run_forever(stop)
    server.stop()
    logger.info("service stopped")
    return 0


def _control_request(method: str, path: str) -> dict:
    host = os.environ.get("CONTROL_HOST") or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    port = os.environ.get("CONTROL_PORT") or "8787"
    headers = {}
    if token := os.environ.get("CONTROL_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.request(method, f"http://{host}:{port}{path}", headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _cleanup_profiles(config: Config, yes: bool) -> int:
    nightscout = NightscoutClient(config.ns_url, config.ns_secret)
    docs = nightscout.profiles()
    if not docs:
        print("no profiles in Nightscout")
        return 0
    newest, older = docs[0], docs[1:]
    pruned = prune_profile_doc(newest, config.insulin_duration_hours)
    dropped = sorted(set(newest.get("store", {})) - set(pruned["store"]))
    print(f"keep: {pruned['defaultProfile']!r} (dia={pruned['store'][pruned['defaultProfile']]['dia']})")
    print(f"drop from current document: {dropped or 'none'}")
    print(f"delete older documents: {len(older)}")
    if not yes:
        print("dry run; pass --yes to apply")
        return 0
    nightscout.put_profile(pruned)
    for doc in older:
        nightscout.delete_profile(doc["_id"])
    print("done")
    return 0


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="leveling-up", description=__doc__.splitlines()[0])
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    sync = sub.add_parser("sync")
    sync.add_argument("source", choices=["dexcom", "tandem"])
    boost = sub.add_parser("boost")
    boost.add_argument("--minutes", type=float)
    boost.add_argument("--cancel", action="store_true")
    sub.add_parser("status")
    cleanup = sub.add_parser("cleanup-profiles")
    cleanup.add_argument("--yes", action="store_true", help="apply changes (default: dry run)")
    args = parser.parse_args(argv)

    load_dotenv()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not args.verbose:
        # tconnectsync logs every uploaded entry at INFO.
        logging.getLogger("tconnectsync").setLevel(logging.WARNING)

    if args.command in ("boost", "status"):
        if args.command == "status":
            result = _control_request("GET", "/status")
        elif args.cancel:
            result = _control_request("POST", "/boost/cancel")
        else:
            query = f"?minutes={args.minutes:g}" if args.minutes else ""
            result = _control_request("POST", "/boost" + query)
        print(json.dumps(result, indent=2))
        return

    try:
        config = Config.from_env()
    except ConfigError as e:
        sys.exit(f"config error: {e}")

    if args.command == "run":
        sys.exit(_run(config))
    if args.command == "sync":
        if args.source == "dexcom":
            nightscout = NightscoutClient(config.ns_url, config.ns_secret)
            print(_dexcom_sync(config, nightscout).run())
        else:
            print(_tandem_sync(config).run())
        return
    if args.command == "cleanup-profiles":
        sys.exit(_cleanup_profiles(config, args.yes))
