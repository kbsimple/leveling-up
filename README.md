# leveling-up

A simple glucose widget, viewable primarily on Android phones, that blends
**Dexcom CGM readings** with **Tandem pump dosing data** in one place.

The sync service pulls Dexcom Share readings and Tandem Source pump data
(boluses, basal, pump events, profiles) into Nightscout. Widget apps read
Nightscout. See [docs/design.md](docs/design.md) for findings and decisions.

> Display only. This project never sends commands to the pump and is not an
> alarm system; keep using the official Dexcom and Tandem apps for alerts.

## Setup

Requires Python 3.12+.

```
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env   # fill in credentials; see Configuration below
```

## The `leveling-up` command

Installed into the virtualenv as `.venv/bin/leveling-up` (also runnable as
`python -m leveling_up`). Every command reads settings from `.env` in the
current directory or from the environment.

```
leveling-up [-v] <command> [options]
```

| Global option | Meaning |
| --- | --- |
| `-v`, `--verbose` | Debug logging, including every entry tconnectsync uploads |
| `-h`, `--help` | Show help (also works per command, e.g. `leveling-up boost -h`) |

### `run`

Runs the service: a scheduler plus a small HTTP control API. It runs until
stopped with Ctrl-C or SIGTERM.

```
leveling-up run
```

- Syncs Dexcom every `DEXCOM_INTERVAL_MINUTES` (default 5) and Tandem every
  `TANDEM_INTERVAL_MINUTES` (default 15). Both run once at startup.
- A failed sync is logged, shown in `status`, and retried at the next interval.
- The control API listens on `CONTROL_HOST:CONTROL_PORT` (default
  `127.0.0.1:8787`). The `boost` and `status` commands talk to it.

To run it in the background on macOS or Linux and stop it later:

```
nohup .venv/bin/leveling-up run >> logs/service.log 2>&1 & echo $! > logs/service.pid
kill $(cat logs/service.pid)
```

(`logs/` must exist; it is git-ignored.)

### `boost`

Asks the running service to poll Tandem more often for a while. Use it after a
bolus when you want dosing data to show up sooner.

```
leveling-up boost                # every BOOST_INTERVAL_MINUTES (5) for BOOST_DURATION_MINUTES (30)
leveling-up boost --minutes 60   # custom duration, up to 240
leveling-up boost --cancel       # end the boost early
```

- Starts a Tandem sync immediately, then switches back to the normal interval
  when the boost ends.
- Boosting again while one is running extends it; it never shortens it.
- Prints the service status as JSON.

### `status`

Shows the running service's state as JSON: each job's interval, next run, last
finish time, last result and last error, plus whether a boost is active.

```
leveling-up status
```

### `sync dexcom | sync tandem`

Runs a single sync pass in this process, without the running service. Useful
for testing or a one-off catch-up.

```
leveling-up sync dexcom   # upload Dexcom readings newer than Nightscout's latest (last 3 hours)
leveling-up sync tandem   # sync the last TANDEM_LOOKBACK_HOURS (24) of pump data
```

Both are safe to repeat; already-uploaded data is skipped.

### `cleanup-profiles`

Reduces Nightscout profiles to the current default profile and sets its DIA to
`INSULIN_DURATION_HOURS`. It deletes all older profile documents and the other
profile names in the current one.

```
leveling-up cleanup-profiles         # dry run: show what would change
leveling-up cleanup-profiles --yes   # apply
```

## Control API

The `boost` and `status` commands are thin clients for this API. Anything that
can reach the port can call it directly, e.g. a phone shortcut later. When
`CONTROL_TOKEN` is set, send `Authorization: Bearer <token>`.

| Method and path | Effect |
| --- | --- |
| `GET /status` | Job and boost state |
| `POST /boost[?minutes=N]` | Start or extend a boost and sync Tandem now |
| `POST /boost/cancel` | End the boost |
| `POST /sync/dexcom`, `POST /sync/tandem` | Run that job now |

```
curl -X POST http://127.0.0.1:8787/boost
```

## Configuration

Set in `.env` (see [.env.example](.env.example)) or the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEXCOM_USERNAME`, `DEXCOM_PASSWORD` | required | Dexcom Share account (the sharer, not a follower) |
| `DEXCOM_REGION` | `us` | `us`, `ous` or `jp` |
| `TCONNECT_EMAIL`, `TCONNECT_PASSWORD` | required | Tandem Source account |
| `TCONNECT_REGION` | `US` | `US` or `EU` |
| `NS_URL`, `NS_SECRET` | required | Nightscout URL and API secret |
| `TIMEZONE_NAME` | `America/Los_Angeles` | Pump clock's timezone |
| `INSULIN_DURATION_HOURS` | `5` | DIA written to the Nightscout profile (Control-IQ uses 5) |
| `DEXCOM_INTERVAL_MINUTES` | `5` | Dexcom polling interval |
| `TANDEM_INTERVAL_MINUTES` | `15` | Tandem polling interval |
| `BOOST_INTERVAL_MINUTES` | `5` | Tandem interval during a boost |
| `BOOST_DURATION_MINUTES` | `30` | Default boost length |
| `TANDEM_LOOKBACK_HOURS` | `24` | How far back each Tandem sync reads |
| `CONTROL_HOST` | `127.0.0.1` | Control API bind address |
| `CONTROL_PORT` | `8787` | Control API port |
| `CONTROL_TOKEN` | empty | Bearer token; required when `CONTROL_HOST` isn't loopback |

## Deploy (on-prem Ubuntu or Vultr)

Docker Compose, same on both hosts:

```
docker compose up -d --build                         # start or update
docker compose exec sync leveling-up status          # run any command inside
docker compose exec sync leveling-up boost
docker compose logs -f sync
docker compose down                                  # stop (keeps data volume)
```

The control port is published only on the host's `127.0.0.1`. Run only one
instance at a time against a given Nightscout. The `deploy-sync` skill
(`.claude/skills/deploy-sync/`) runs the full procedure over SSH.

## Tests

```
.venv/bin/python -m pytest --tb=short -q
```
