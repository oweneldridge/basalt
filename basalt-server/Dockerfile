# syntax=docker/dockerfile:1
# Basalt web — multi-stage image: the built SPA + the axum server, sharing the
# basalt-core engine with the desktop app. Deliberately builds ONLY basalt-server
# + basalt-core (never the tauri `basalt` crate), so no webkit/system build deps.
# Build context = the repo root (see basalt-server/docker-compose.yml).

# ---- 1. build the web app → dist/ ----
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# vite build only — NOT `npm run build` (which also runs `tsc`, a dev-time
# typecheck gate that flags node:* imports in *.test.ts in this clean image).
# esbuild/vite strips types and bundles only the app; the typecheck is run
# separately in dev/CI.
RUN npx vite build

# ---- 2. build the server binary ----
FROM rust:1-slim AS server
WORKDIR /app
COPY basalt-core ./basalt-core
COPY basalt-server ./basalt-server
# A minimal 2-member workspace so cargo never resolves/builds src-tauri (which
# would pull tauri + its system deps). Deps fresh-resolve from the manifests.
RUN printf '[workspace]\nmembers = ["basalt-core", "basalt-server"]\nresolver = "2"\n' > Cargo.toml
RUN cargo build --release -p basalt-server

# ---- 3. slim runtime ----
FROM debian:bookworm-slim AS runtime
WORKDIR /app
COPY --from=server /app/target/release/basalt-server /usr/local/bin/basalt-server
COPY --from=web /app/dist /app/dist
# Vault is bind-mounted at /vault (see compose). Runs as root so writes to the
# host-owned bind mount always succeed; see DEPLOY.md to harden to non-root.
ENV BASALT_WEB_DIR=/app/dist \
    BASALT_VAULT=/vault \
    BASALT_PORT=8799 \
    BASALT_HOST=0.0.0.0
EXPOSE 8799
CMD ["basalt-server"]
