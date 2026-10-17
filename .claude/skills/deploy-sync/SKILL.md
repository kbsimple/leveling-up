---
name: deploy-sync
description: Deploy or update the leveling-up sync service (Docker Compose) on an Ubuntu host over SSH — the on-prem server or a Vultr instance. Use when asked to deploy, redeploy, update, check, or roll back the sync service on a remote machine.
---

# Deploy the sync service

The same steps work for the on-prem Ubuntu server and Vultr. The only input
is the SSH target.

## Inputs

- `TARGET`: SSH destination, e.g. `user@onprem-host` or `root@vultr-ip`.
  Ask the user if not given. Check `docs/deployments.md` for known targets.
- `REMOTE_DIR`: defaults to `~/leveling-up`.

## Steps

1. **Pre-push gate.** Run `.venv/bin/python -m pytest --tb=short -q` locally.
   Stop if anything fails.

2. **Reachability.** `ssh -o BatchMode=yes TARGET 'uname -a && lsb_release -ds'`.
   If it fails, ask the user to set up key-based SSH; do not handle passwords.

3. **Docker.** `ssh TARGET 'docker compose version'`. If missing, tell the user
   and ask before installing. With approval, install Docker Engine from
   Docker's apt repository (https://docs.docker.com/engine/install/ubuntu/),
   then `sudo usermod -aG docker $USER` and reconnect.

4. **Copy code.** No GitHub credentials are needed on the host:
   ```
   rsync -az --delete --exclude .git --exclude '.venv*' --exclude .env \
     --exclude spikes --exclude '__pycache__' ./ TARGET:REMOTE_DIR/
   ```

5. **Secrets.** Never print `.env` contents.
   - If `REMOTE_DIR/.env` does not exist on the host, copy the local one with
     restrictive permissions:
     `scp .env TARGET:REMOTE_DIR/.env && ssh TARGET 'chmod 600 REMOTE_DIR/.env'`.
     Confirm with the user first; it contains credentials.
   - Ensure the remote `.env` has a non-empty `CONTROL_TOKEN` (required because
     the API listens on 0.0.0.0 inside the container). If missing, append one
     generated on the host:
     `ssh TARGET 'cd REMOTE_DIR && grep -q "^CONTROL_TOKEN=." .env || echo "CONTROL_TOKEN=$(openssl rand -hex 24)" >> .env'`.
     (An empty `CONTROL_TOKEN=` line from the template is overridden by the
     appended one because the last value wins.)

6. **Only one instance may run.** Two services syncing to the same Nightscout
   double the Tandem polling. Before starting, confirm with the user that no
   other instance (local laptop, the other host) is running, and stop it.

7. **Build and start.**
   `ssh TARGET 'cd REMOTE_DIR && docker compose up -d --build'`.

8. **Verify.**
   - `ssh TARGET 'cd REMOTE_DIR && docker compose logs --tail 50 sync'` shows
     `service started` and no tracebacks.
   - After ~1 minute: `ssh TARGET 'cd REMOTE_DIR && docker compose exec sync leveling-up status'`
     shows both jobs with `last_result` set and `last_error` null.

9. **Record** the target and date in `docs/deployments.md` (create if needed),
   commit, and push.

## Operating

- Boost Tandem polling (every 5 min for 30 min):
  `ssh TARGET 'cd REMOTE_DIR && docker compose exec sync leveling-up boost'`
  (`--minutes N` for a custom duration, `--cancel` to stop).
- Status: `... docker compose exec sync leveling-up status`.
- Logs: `... docker compose logs -f sync`.
- Stop: `... docker compose down` (keeps the data volume).

## Rollback

Re-run step 4 from the previous git commit (`git stash` or a worktree at that
commit), then step 7.
