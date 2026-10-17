"""Spike: upload recent Dexcom Share readings to Nightscout as sgv entries.

Only readings newer than the latest entry from this uploader are posted, so it
is safe to run repeatedly.

Run: .venv/bin/python spikes/dexcom_to_nightscout.py [--minutes 180]
"""
import argparse
import hashlib
import os

import requests
from dotenv import load_dotenv
from pydexcom import Dexcom

DEVICE = "leveling-up (dexcom-share)"

# pydexcom uses Dexcom's direction names; Nightscout spells a few differently.
_DIRECTION_FIXUPS = {
    "None": "NONE",
    "NotComputable": "NOT COMPUTABLE",
    "RateOutOfRange": "RATE OUT OF RANGE",
}

load_dotenv()

parser = argparse.ArgumentParser()
parser.add_argument("--minutes", type=int, default=180)
args = parser.parse_args()

ns_url = os.environ["NS_URL"].rstrip("/") + "/"
headers = {"api-secret": hashlib.sha1(os.environ["NS_SECRET"].encode()).hexdigest()}

latest = requests.get(
    ns_url + "api/v1/entries/sgv.json",
    params={"count": 1, "find[device]": DEVICE},
    headers=headers,
    timeout=30,
)
latest.raise_for_status()
latest_ms = latest.json()[0]["date"] if latest.json() else 0

dex = Dexcom(
    username=os.environ["DEXCOM_USERNAME"],
    password=os.environ["DEXCOM_PASSWORD"],
    region=os.environ.get("DEXCOM_REGION", "us"),
)
readings = dex.get_glucose_readings(minutes=args.minutes, max_count=min(288, args.minutes // 5 + 1))

entries = []
for r in readings:
  date_ms = int(r.datetime.timestamp() * 1000)
  if date_ms <= latest_ms:
    continue
  entries.append({
      "type": "sgv",
      "sgv": r.mg_dl,
      "direction": _DIRECTION_FIXUPS.get(r.trend_direction, r.trend_direction),
      "date": date_ms,
      "dateString": r.datetime.isoformat(),
      "device": DEVICE,
  })

if entries:
  resp = requests.post(ns_url + "api/v1/entries", json=entries, headers=headers, timeout=30)
  resp.raise_for_status()
print(f"fetched {len(readings)} readings, uploaded {len(entries)} new")
