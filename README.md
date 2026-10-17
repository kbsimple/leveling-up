# leveling-up

A simple glucose widget, viewable primarily on Android phones, that blends
**Dexcom CGM readings** with **Tandem pump dosing data** in one place.

The sync service pulls Dexcom Share readings and Tandem Source pump data
(boluses, basal, pump events, profiles) into Nightscout. Widget apps read
Nightscout. See [docs/design.md](docs/design.md) for findings and decisions.

## Run locally

```
python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env   # fill in credentials
.venv/bin/leveling-up run
```

Dexcom syncs every 5 min, Tandem every 15 min.

## Commands

| Command | What it does |
| --- | --- |
| `leveling-up run` | Run the service (scheduler + control API on port 8787) |
| `leveling-up boost [--minutes N]` | Poll Tandem every 5 min for 30 min (or N) |
| `leveling-up boost --cancel` | End a boost early |
| `leveling-up status` | Show job state of the running service |
| `leveling-up sync dexcom\|tandem` | Run one sync pass now, in-process |
| `leveling-up cleanup-profiles [--yes]` | Keep only the default NS profile, set DIA |

## Deploy (on-prem Ubuntu or Vultr)

Docker Compose, same on both hosts: `docker compose up -d --build`. The
`deploy-sync` skill (`.claude/skills/deploy-sync/`) runs the full procedure
over SSH.

## Tests

```
.venv/bin/python -m pytest --tb=short -q
```
