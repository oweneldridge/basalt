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

## 3. Set the auth (and save it in Vaultwarden)

```sh
cd /opt/arrstack/basalt/basalt-server
printf 'BASALT_AUTH=owen:%s\n' "$(openssl rand -base64 18)" > .env
chmod 600 .env
cat .env            # copy the user:pass into Vaultwarden as "Basalt web (becspk)"
```

Auth is defense-in-depth behind Tailscale (the service is tailnet-only either
way). A malformed `BASALT_AUTH` (no `:`) makes the server refuse to start.

## 4. Build + run

```sh
docker compose up -d --build      # first build compiles axum/tokio (~a few min)
docker compose logs -f basalt-web # expect: "vault /vault on http://127.0.0.1:8799"
```

## 5. Expose it tailnet-only (mirrors SilverBullet's :10016)

```sh
sudo tailscale serve --bg --https=10017 http://127.0.0.1:10017
sudo tailscale serve status        # confirm the :10017 mapping
```

## 6. Open it

```
https://becspk.tailaeef0f.ts.net:10017
```

The browser prompts for the Basic-auth creds, then loads your vault — editable
from any browser on the tailnet. Set it to **Self-hosted** is not needed (this
is Basalt's own server, not Bitwarden).

## 7. When you're happy, retire SilverBullet

```sh
cd /opt/arrstack && docker compose stop silverbullet
sudo tailscale serve --https=10016 off
# (remove the silverbullet block from /opt/arrstack/docker-compose.yml later)
```

## Notes / troubleshooting

- **Vault mount**: `/opt/arrstack/silverbullet/space` is bind-mounted read-write
  at `/vault`. The container runs as root so writes to the host-owned dir always
  succeed. To run non-root, add `user: "<uid>:<gid>"` to the compose service,
  matching the owner of the space dir.
- **Same vault, two writers**: fine during transition (same model as
  SilverBullet + unison today). Basalt's atomic writes + "Changed on disk"
  conflict handling + the SSE watcher keep it safe; unison syncs to iCloud.
- **Big first load**: `read_vault` ships the whole vault once (gzipped ~5×). Over
  the tailnet that's a few seconds on first open; edits are instant after.
- **Update**: `git pull && docker compose up -d --build`.
- **The build pulls no Tauri/webkit deps** — it compiles only `basalt-server` +
  `basalt-core` via a minimal 2-member workspace in the Dockerfile.
