# Production Deploy Runbook (T-0032)

MVP go-live for the Lords Regiment Dashboard: the unified `api + db + web` prod
compose behind a TLS reverse proxy. Target (per questionnaire T-0028): a
**DigitalOcean** droplet, MySQL inside the compose stack, domain
**lordsofholdfast.com**.

> This is the one step Claude cannot execute for you — it needs your DigitalOcean
> droplet and a real Discord application. Everything it depends on (images,
> compiled migrate/seed, zero-config env, mock→real Discord seam) is built and
> verified. Follow the steps below and the smoke test at the end proves go-live.

## 0. Prerequisites
- A DigitalOcean droplet (Ubuntu 22.04+, ≥2 GB RAM) with Docker + Compose.
- DNS: `lordsofholdfast.com` (and `www`) → the droplet's IP.
- A Discord **production** application (see §3).

## 1. Get both repos on the host (sibling layout)
The web image builds from `../lords-regiment-dashboard`, so both repos must sit
side by side:
```bash
git clone https://github.com/Amitoj02/lords-dashboard-backend.git
git clone https://github.com/Amitoj02/lords-regiment-dashboard.git
cd lords-dashboard-backend
```

## 2. Create the host `.env` (consumed by docker-compose.prod.yml)
```bash
cp .env.example .env    # then edit — set REAL secrets:
```
- `DB_PASSWORD` — a strong MySQL root password.
- `JWT_SECRET` — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ENCRYPTION_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (64 hex)
- `WEB_ORIGIN=https://lordsofholdfast.com`
- `DISCORD_MOCK=false`
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — from the Discord app (§3).
- `OWNER_DISCORD_ID` — the real regiment owner's Discord user id (claims the
  Owner account on first boot). The seeded Owner's display name defaults to
  "Admin"; the Owner renames themselves in-app after signing in (profile edit).

## 3. Discord production app
1. <https://discord.com/developers/applications> → your app → OAuth2.
2. Add redirect: `https://lordsofholdfast.com/api/auth/discord/callback`.
3. Copy Client ID + Client Secret into `.env`.
4. (Bot milestone only — not MVP) enable the GUILD_MEMBERS privileged intent.

## 4. TLS reverse proxy
The `web` (nginx) container listens on `WEB_HTTP_PORT` (default 8080) and serves
the SPA + proxies `/api`. Terminate TLS in front of it with Caddy (simplest —
auto-TLS):
```
# /etc/caddy/Caddyfile
lordsofholdfast.com, www.lordsofholdfast.com {
    reverse_proxy localhost:8080
}
```
(Or Traefik + Let's Encrypt if preferred.)

## 5. Launch
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
This: builds slim images → runs the one-shot `migrate` init (compiled JS, no
ts-node: `migration:run:prod && seed:prod`) → starts `api` (waits for migrate) →
starts `web`. The `db` volume `db-data` persists MySQL.

## 6. Smoke test (go-live gate)
- `https://lordsofholdfast.com` serves the SPA; `…/api/health` returns `status: ok`.
- Click **Continue with Discord** → real Discord consent → back to the dashboard
  as the Owner (the `OWNER_DISCORD_ID` account).
- Roster loads; an admin action (e.g. award a medal) round-trips.
- Deferred surfaces (events/gallery/audit/settings) show "coming soon", never stub data.

## 7. Backups
`db-data` is a named volume. Schedule `docker compose exec db mysqldump -uroot
-p"$DB_PASSWORD" lords_dashboard > backup-$(date +%F).sql` (cron).

## Rollback
`docker compose -f docker-compose.yml -f docker-compose.prod.yml down` keeps the
`db-data` volume; re-`up` the previous image tag. Migrations are forward-only —
use `npm run migration:revert` inside a one-off container only if you must.
