# Single-container hosting checkpoint

Run one SquadWaddle container on a machine that is already approved to stay on. It runs the signed HTTP server as the non-root `node` user. A named local volume holds SQLite. The Docker restart policy brings the container back when the engine starts, unless an operator stopped it. A stopped host or engine still takes the service offline. Use one container and one writer per volume. [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)

## Build and check the local runtime

```sh
docker build -t squadwaddle:pilot .
docker volume create squadwaddle-pilot-data
docker run -d --name squadwaddle-pilot --restart unless-stopped \
  --env-file "$HOME/.config/squadwaddle/pilot.env" \
  --publish 127.0.0.1:3148:3000 \
  --mount type=volume,src=squadwaddle-pilot-data,dst=/data \
  squadwaddle:pilot
curl --fail http://127.0.0.1:3148/health
docker inspect --format '{{.State.Health.Status}}' squadwaddle-pilot
```

Keep the runtime environment file outside the project and readable only by the operator. Supply `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `PILOT_GUILD_ID`, and `PILOT_CHANNEL_ID`. For a first smoke test, use generated fictional values and set `PILOT_PUBLISH_ENABLED=no`. The server needs no bot token. Keep the image’s `HOST`, `PORT`, and `DB_PATH` defaults. Restrict access to the Docker engine because administrators can inspect runtime settings and the volume.

The build context allows only the Docker files, package metadata, and the named server source files. The image uses the official Node 24.22.3 base and the server has no dependency install step. A new named volume gets the image’s writable `/data/squadwaddle` directory through Docker’s default initialization. [Official Node image](https://hub.docker.com/_/node) · [Docker build context](https://docs.docker.com/build/concepts/context/) · [Docker volumes](https://docs.docker.com/engine/storage/volumes/)

Expect `{"ok":true}` and a healthy status after Docker’s first check. Restart the container and repeat the health check. The returned health status establishes local HTTP availability. An authorized Discord pilot would separately need an existing trusted HTTPS proxy on the host forwarding `POST /interactions` to loopback without rewriting the body or signature headers. Keep the exact test scope and voice off.

## Stop, back up, and restore

Stop the app cleanly before copying its SQLite file. Use a new, private directory for each backup. The named volume stays available when the container stops or is removed.

```sh
docker stop --time 15 squadwaddle-pilot
backup_dir=$(mktemp -d)
docker cp squadwaddle-pilot:/data/squadwaddle/sessions.sqlite "$backup_dir/sessions.sqlite"
chmod 600 "$backup_dir/sessions.sqlite"
```

The copy assumes the stock SQLite settings and a clean server stop. If shutdown fails or SQLite sidecar files remain, preserve the volume and take a consistent SQLite backup before replacing anything. To rehearse restore, choose a fresh volume and use the stopped instance’s backup. The original volume remains intact.

```sh
docker volume create squadwaddle-pilot-restored
docker run --rm -i --network none \
  --mount type=volume,src=squadwaddle-pilot-restored,dst=/data squadwaddle:pilot \
  sh -ec 'umask 077; test ! -e /data/squadwaddle/sessions.sqlite; cat > /data/squadwaddle/sessions.sqlite' \
  < "$backup_dir/sessions.sqlite"
docker run --rm --network none \
  --mount type=volume,src=squadwaddle-pilot-restored,dst=/data,readonly squadwaddle:pilot \
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/data/squadwaddle/sessions.sqlite", { readOnly: true }); const result = db.prepare("PRAGMA integrity_check").get(); db.close(); if (result.integrity_check !== "ok") process.exit(1); console.log("SQLite integrity check passed");'
```

After a successful check, start a new container with the restored volume and an unused name. Check health and a signed fictional lookup before changing a route. To roll back, stop that container and use the prior image and untouched volume. Keep older images and backups isolated if a schema cutover changes profile privacy.

## Verification status

On Node 24.22.3, the allowlisted source files ran the image’s server command locally. Loopback health, a signed fictional draft, graceful stop, restart persistence, SQLite integrity, and lookup from a restored copy passed. The local Docker engine was unavailable. Image build, container health status, and named-volume ownership and restore still need a Docker run.
