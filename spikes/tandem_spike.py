"""Spike: what does Tandem Source (via tconnectsync) give us?

Run: .venv/bin/python spikes/tandem_spike.py
"""
import collections
import os

import arrow
from dotenv import load_dotenv

load_dotenv()
os.environ.setdefault("TCONNECT_REGION", "US")

from tconnectsync.api import TConnectApi

api = TConnectApi(os.environ["TCONNECT_EMAIL"], os.environ["TCONNECT_PASSWORD"],
                  os.environ.get("TCONNECT_REGION", "US"))
src = api.tandemsource

pumper = src.get_pumper()
pumps = pumper.get("pumps", [])
print(f"pumps on account: {len(pumps)}")
if not pumps:
  raise SystemExit("no pumps found")
device_id = pumps[0]["assignmentId"]

end = arrow.now()
start = end.shift(days=-2)
events = list(src.pump_events(device_id, start.format("YYYY-MM-DD"),
                              end.format("YYYY-MM-DD")))
print(f"events in last 2 days: {len(events)}")

counts = collections.Counter(type(e).__name__ for e in events)
for name, n in counts.most_common():
  print(f"  {name}: {n}")

latest = max(events, key=lambda e: e.eventTimestamp, default=None)
if latest:
  print(f"newest event: {type(latest).__name__} at {latest.eventTimestamp}")
  print(f"lag of newest event: {arrow.now() - latest.eventTimestamp}")
