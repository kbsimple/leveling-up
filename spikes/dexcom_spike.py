"""Spike: what does Dexcom Share (via pydexcom) give us?

Run: .venv/bin/python spikes/dexcom_spike.py
"""
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from pydexcom import Dexcom

load_dotenv()

dex = Dexcom(
    username=os.environ["DEXCOM_USERNAME"],
    password=os.environ["DEXCOM_PASSWORD"],
    region=os.environ.get("DEXCOM_REGION", "us"),
)

readings = dex.get_glucose_readings(minutes=1440, max_count=288)
print(f"readings returned: {len(readings)} (requested up to 288 / 24h)")
if readings:
  newest, oldest = readings[0], readings[-1]
  now = datetime.now(timezone.utc)
  print(f"newest: {newest.value} mg/dL {newest.trend_description} at {newest.datetime}")
  print(f"oldest: {oldest.value} mg/dL at {oldest.datetime}")
  print(f"lag of newest reading: {now - newest.datetime.astimezone(timezone.utc)}")
  if len(readings) > 1:
    gap = readings[0].datetime - readings[1].datetime
    print(f"interval between last two readings: {gap}")
  print("attributes:", [a for a in dir(newest) if not a.startswith("_")])
