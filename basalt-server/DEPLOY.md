# Deploying Basalt web on Spectre

`basalt-server` serves the vault (the same unison-synced SilverBullet space) at a
tailnet-only URL, using the same `basalt-core` engine as the desktop app. It can
run **side by side** with SilverBullet during the transition — both edit the same
space, and unison carries changes to iCloud — then SilverBullet retires.

## 1. Push the branch (from the Mac)

```sh
git push -u origin basalt-web
```

## 2. Get the code on Spectre

```sh
ssh owen@192.168.50.180
git clone -b basalt-web https://github.com/oweneldridge/basalt /opt/arrstack/basalt
# later updates: cd /opt/arrstack/basalt && git pull
```

## 3. Sign-in

On Spectre the sign-in is Authelia (since 2026-10-05): a Caddy site on
`127.0.0.1:9104` runs the `authelia` forward-auth snippet for the `admins`
group, sends `Host: localhost` upstream, uses `flush_interval -1` so the
`/api/events` stream isn't buffered, and proxies to `127.0.0.1:10019`. Tailscale
Serve's `:10019` points at `:9104`, not at the container. So `BASALT_AUTH` must
stay unset there: setting it adds the browser's Basic-auth prompt on top, which
password managers can't fill.

Without a proxy, Basic auth is the option:

```sh
cd /opt/arrstack/basalt/basalt-server
printf 'BASALT_AUTH=owen:%s\n' "$(openssl rand -base64 18)" > .env
chmod 600 .env
```

Empty or unset `BASALT_AUTH` means no Basic auth; a malformed value (no `:`)
makes the server refuse to start.

With Basic auth off, the server only answers requests addressed to `localhost`,
`127.0.0.1` or `::1`, which stops a DNS-rebinding page from reaching it. To serve
another name without it, list the name in `BASALT_ALLOWED_HOSTS`
(comma-separated). Never point Tailscale Serve straight at the container with
Basic auth off: anyone on the tailnet could then reach the vault.

## 4. Build + run

```sh
docker compose up -d --build      # first build compiles axum/tokio (~a few min)
docker compose logs -f basalt-web # expect: "vault /vault on http://127.0.0.1:8799"
```

## 5. Expose it tailnet-only (mirrors SilverBullet's :10016)

```sh
# through the Authelia gate on Spectre (see 3); straight to 10019 only with Basic auth on
sudo tailscale serve --bg --https=10019 http://127.0.0.1:9104
sudo tailscale serve status        # confirm the :10019 mapping
```

## 6. Open it

```
https://becspk.tailaeef0f.ts.net:10019
```

Authelia's sign-in page comes up (a password manager can fill it), then your
vault loads, editable from any browser on the tailnet.

## 7. When you're happy, retire SilverBullet

```sh
cd /opt/arrstack && docker compose stop silverbullet
sudo tailscale serve --https=10016 off
# (remove the silverbullet block from /opt/arrstack/docker-compose.yml later)
```

## Notes / troubleshooting

- **Vault mount**: `/opt/arrstack/silverbullet/space` is bind-mounted read-write
  at `/vault`. The container runs as `BASALT_UID:BASALT_GID` (1000:1000 unless
  set in `.env`), which must match the owner of the space dir. Run as root, it
  hands new files and folders to root, and a sync tool running as the owner
  (unison) can't read a root-owned 0600 note. Before a deploy,
  `find <space> ! -user <owner>` should print nothing.
- **Same vault, two writers**: fine during transition (same model as
  SilverBullet + unison today). Basalt's atomic writes + "Changed on disk"
  conflict handling + the SSE watcher keep it safe; unison syncs to iCloud.
- **Big first load**: `read_vault` ships the whole vault once (gzipped ~5×). Over
  the tailnet that's a few seconds on first open; edits are instant after.
- **Update**: build on the Mac rather than on Spectre, which is short on memory.
  See "Updating from the Mac" below.
- **The build pulls no Tauri/webkit deps** — it compiles only `basalt-server` +
  `basalt-core` via a minimal 2-member workspace in the Dockerfile.

## Updating from the Mac

Spectre runs low on RAM, so build the image on the Mac and load it there. The
load moves `:latest`, so snapshot the vault and tag the running image first.

```sh
# On Spectre
tar -C /opt/arrstack/silverbullet -czf /mnt/backup/basalt-snapshots/space-$(date +%Y-%m-%d-%H%M).tar.gz space
docker tag basalt-server-basalt-web:latest basalt-server-basalt-web:rollback-$(date +%Y-%m-%d)

# On the Mac, from the repo root
docker buildx build --builder desktop-linux --platform linux/amd64 \
  -f basalt-server/Dockerfile \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD) \
  -t basalt-server-basalt-web:latest --load .
docker save basalt-server-basalt-web:latest | gzip -1 | ssh becspk 'gunzip | docker load'

# On Spectre (the compose file there is its own copy: updates never replace it)
cd /opt/arrstack/basalt/basalt-server && docker compose up -d --no-build basalt-web
```

To roll back, tag the rollback image as `:latest` again and run the same
`docker compose up -d --no-build basalt-web`. Check the result read-only: the
vault folder syncs into the real vault.
