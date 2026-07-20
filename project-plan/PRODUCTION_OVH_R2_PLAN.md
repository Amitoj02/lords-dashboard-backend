# Production Hosting Plan — OVHcloud VPS-1 + Cloudflare R2

**Target:** `https://lordsofholdfast.com` — Angular SPA + NestJS API + MySQL + the Quartermaster Discord bot, on one OVH VPS, with media on Cloudflare R2 and Cloudflare in front for DNS/CDN/TLS.

**Status:** supersedes `DEPLOY.md` (which targeted DigitalOcean + MinIO). Pairs with `DISCORD_GOLIVE.md`, which needs two corrections noted in Phase 6.

---

## Context

Everything code-side is already built. `docker-compose.prod.yml` runs `db → migrate → api → web`; the `migrate` one-shot uses compiled JS and gates the API via `service_completed_successfully`; the mock→real Discord seam is verified against a test guild (T-0033); the SPA is fully wired to the API (all 13 services call `HttpClient` — the "coming soon" guards were retired in T-0026). Blueframe T-0032 has been `blocked` since 2026-07-11 purely on *"needs the real droplet + a Discord production app."*

So this is **not a build. It is a migration of hosting target plus a hardening pass.** Three things genuinely change:

1. **MinIO → Cloudflare R2.** The bucket bootstrap (`mc anonymous set download`) has no R2 equivalent, and three env vars are wired wrong for a non-MinIO backend.
2. **DigitalOcean → OVH.** Different constraints: no HTTP/3, port 25 blocked, stateless edge firewall, host-lottery CPU.
3. **Build-on-box → GitHub Actions + GHCR.** An Angular production build is a real OOM risk on 4 GB alongside a live MySQL.

Two documentation facts to correct along the way: the backend `CLAUDE.md` and the frontend `README.md` both still claim the frontend is stubbed. It isn't.

---

## Target architecture

```
                    Cloudflare (free plan, orange cloud)
                    DNS · CDN · TLS · WAF · DDoS
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
  lordsofholdfast.com    cdn.lordsofholdfast.com    (R2 S3 endpoint,
   → OVH VPS (A record)   → R2 bucket (custom        grey/direct — used
        │                    domain binding)          only for presigning)
        │
   ┌────▼─────────────────────────────────────┐
   │ OVH VPS-1 · Debian 13 · 2 vCore / 4 GB   │
   │                                          │
   │  caddy :80/:443  ── only published ports │
   │    ├── /api/*  → api:3000                │
   │    └── /*      → SPA static files        │
   │                                          │
   │  api:3000   (NestJS + discord.js bot)    │
   │  db:3306    (MySQL 8.4, internal only)   │
   │  migrate    (one-shot, gates api)        │
   └──────────────────────────────────────────┘
```

**Key decisions and why:**

| Decision | Rationale |
|---|---|
| **Single origin** — SPA and `/api` on one hostname | The SPA's `apiBaseUrl` is the relative string `/api`, so the build is host-agnostic. No CORS, no SameSite problems, and the OAuth callback lands same-site. Do not split onto `api.` — it would break the current auth model for no gain. |
| **Caddy replaces the `web` nginx container as the edge** | Automatic Let's Encrypt with ARI (matters — LE is moving to 45-day certs), one-line SPA fallback, and it becomes the *only* container publishing ports. Keep the existing `nginx.conf` logic as reference; Caddy serves `dist/` directly. |
| **Cloudflare Full (strict), Let's Encrypt at origin** | Flexible sends origin traffic in plaintext *and* infinite-loops against Caddy's auto-redirect. Origin CA certs (15-yr) break the moment you grey-cloud during an incident — exactly when you'd need to. |
| **Bot stays in the API process, pinned to 1 replica** | Splitting it is the architecturally correct answer but is out of scope for go-live. The constraint must be *documented and enforced*, not implicit — see Phase 1.6. |
| **GitHub Actions → GHCR → pull** | Angular CLI spawns multiple V8 isolates; reported peaks of 3.3 GB. Building on a 4 GB box next to a live MySQL is the top self-inflicted outage risk. |
| **MySQL 8.4, not 8.0 or MariaDB** | `mysql:8.0` hit EOL 21 April 2026 — no more security patches. MariaDB is no longer a drop-in (`utf8mb4_0900_ai_ci` is MySQL-only; JSON differs) and would mean regenerating all 19 migrations. |

---

## Cost

| Item | Monthly |
|---|---|
| OVH VPS-1 (2 vCore / 4 GB / 40 GB NVMe, 12-mo prepaid) | $4.54 |
| OVH Automatic Backup Premium (7 rolling days) | $1.40 |
| `lordsofholdfast.com` (already owned) | ~$0.87 |
| Cloudflare Free — DNS, CDN, TLS, WAF | $0 |
| Cloudflare R2 (media + DB backups) | $0.00–0.20 |
| GitHub Actions, Better Stack free, Discord webhook | $0 |
| **Total** | **≈ $6.81–7.01** |

Your ~$1.35/mo R2 estimate is about 10× too high — it implies ~90 GB billable. R2 gives 10 GB-month free, then $0.015/GB, and **egress is $0 at any volume**. Realistically this project sits inside the free tier.

To hit exactly $6, drop Backup Premium ($5.41). I'd keep it: the free OVH backup is *one* copy with 24-hour retention, and it's the only thing giving whole-box history.

> ⚠️ **Do not take the 12-month commitment on day one.** A 12/24-month OVH term can only be cancelled by paying out the remaining balance. Start month-to-month, validate the box for a month (including the CPU lottery below), then commit.

---

## Phase 0 — Decisions before spending money (human)

- [ ] **Pick the OVH regional entity — this is irreversible-ish.** `ovhcloud.com/en-ca` (Beauharnois, Montreal) or `us.ovhcloud.com` (Vint Hill VA / Hillsboro OR). Entities have separate account systems; you cannot move a service between them. Given NA-weighted membership, **Beauharnois (BHS)** is the default pick.
- [ ] **Avoid Local Zones.** Local Zone VPS loses the Docker preinstall image, automated backups, additional IPs, and monitoring. Check this in the configurator before ordering.
- [ ] **Read the month-to-month price in the configurator.** Headline $4.54 is the 12-month prepaid rate. Secondary sources suggest ~+14% for no-commitment, unverified.
- [ ] **Order early.** OVH runs risk-triggered KYC. If flagged, the order goes to *"Awaiting documents"* — you get ~48 hours to supply passport + proof of address, and resolution can take days (one public thread documents 11). **Never plan a same-day cutover that depends on OVH provisioning.**
- [ ] Payment: Visa / Mastercard / Maestro, PayPal, or prepaid account. *Not* Amex, not Diners, not wire.

---

## Phase 1 — Code changes (my end, before any server exists)

### 1.1 R2 storage migration — the highest-risk change

**Good news first:** `@aws-sdk/s3-request-presigner` sets `applyChecksum: false` by default, so the presigned-PUT path is *structurally immune* to the CRC32 checksum bug that broke R2/MinIO/B2 in SDK 3.729+. The browser upload flow needs no change. Set the defensive flags anyway — they cost nothing and keep local MinIO dev and prod R2 on one code path.

`src/storage/storage.service.ts` (~line 191):

```ts
this.s3 = new S3Client({
  endpoint: this.cfg.endpoint,
  region: this.cfg.region,
  forcePathStyle: this.cfg.forcePathStyle,
  credentials: { accessKeyId: ..., secretAccessKey: ... },
  requestChecksumCalculation: 'WHEN_REQUIRED',   // ADD
  responseChecksumValidation: 'WHEN_REQUIRED',   // ADD
});
```

**Three env-var traps that will silently produce broken images:**

1. `docker-compose.yml` wires `S3_ACCESS_KEY_ID: ${MINIO_ROOT_USER:-minioadmin}` and `S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}`. **Setting `S3_ACCESS_KEY_ID` in a prod `.env` has no effect.** Fix: override both explicitly in `docker-compose.prod.yml`.
2. `S3_PUBLIC_BASE_URL` defaults to `{endpoint}/{bucket}` — the *signing* endpoint, which is not publicly readable on R2. Leaving it unset yields dead URLs for every avatar, banner, rank icon, medal, and gallery item. **Must be set explicitly.**
3. `S3_REGION` defaults to `us-east-1`. R2 requires the literal string `auto`.

Production values:

```bash
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=lords-media
S3_PUBLIC_BASE_URL=https://cdn.lordsofholdfast.com
S3_FORCE_PATH_STYLE=true          # optional on R2; keeps URL shape identical to MinIO
S3_ACCESS_KEY_ID=<R2 token id>
S3_SECRET_ACCESS_KEY=<R2 token secret>
```

**Presigned URLs work only against `r2.cloudflarestorage.com`, never a custom domain.** The repo's config already splits `endpoint` (signing) from `publicBaseUrl` (serving) — that split is exactly what R2 needs, so this is a values-only change.

Also: delete `minio` and `minio-init` from the prod path entirely, and keep the API's R2 token scoped to **Object Read & Write on one bucket** — it needs read access, not just write, because `assertIconWithinDimensions` does a ranged `GetObject` to parse PNG/WebP headers.

### 1.2 Compose restructure

- `db`: `mysql:8.0` → **`mysql:8.4`**. Note `mysql_native_password` is disabled by default in 8.4; `mysql2` uses `caching_sha2_password` natively so the driver is fine.
- Add `./mysql/conf.d/tuning.cnf` — the two numbers that matter on 4 GB: `innodb_buffer_pool_size = 512M` and **`temptable_max_ram = 64M`** (the 8.4 default has a 1 GB *floor*, a quarter of your RAM). Plus `performance_schema = OFF`, `max_connections = 60`, `skip_name_resolve = ON`.
- **Remove the world-open port publish.** `docker-compose.prod.yml` currently does `ports: ["${WEB_HTTP_PORT:-8080}:80"]` on all interfaces, and **ufw cannot block it** — Docker's DNAT happens in the `nat` table before ufw's chains. Only Caddy publishes, on 80/443.
- Add `caddy` service with persistent `caddy_data` volume (holds certs — losing it re-issues on every deploy and hits Let's Encrypt's 5-duplicate-certs-per-7-days limit).
- Per-container memory limits: `db: 1g`, `api: 512m`, `caddy: 128m`. **Do not set `NODE_OPTIONS=--max-old-space-size`** — Node has been cgroup-aware since v12.7.0 and V8 already defaults to `clamp(limit/2, 256MB, 2GB)`. Raising it to "70–75% of the limit" (common advice) *increases* OOM risk.
- ~~Split `migrate` from `seed`, or guard the seed~~ **DONE, and it was worse than described.** `seed:prod` runs on every `up`, and *every* seeder used a merge-upsert — not just the `setupComplete` flag. A second deploy would also have overwritten the regiment name/mission/accent, **unlinked every rank and medal from its real Discord role** (`linked: false`), flipped `botEnabled` back off, reset the whole permission matrix, and nulled the Owner's Discord profile, `joinedAt` and `lastSeenAt`. Nothing would have failed loudly; the configuration would simply have reverted.

  Fixed by splitting the seeders into two tiers: code-owned reference catalogs (accent tones, audit actions) still refresh every deploy, while everything the admin owns is gated on a greenfield database. Role permissions provision row-by-row on the immutable `(role, capability)` enum pair, so a capability added in a later release still gets its default grant without touching admin edits. Verified end-to-end against MySQL 8.4; 8 unit tests pin the split.

### 1.3 Reverse proxy

Caddyfile serving the SPA with history fallback and proxying `/api` to the container by service name. Critical details:

- **No `443/udp`, no HTTP/3.** OVH drops QUIC at the network edge regardless of firewall config. Configure HTTP/2 only.
- `handle` blocks are mutually exclusive, so `/api/*` never falls through to the SPA fallback.
- `index.html` gets `Cache-Control: no-store`; hashed assets get `immutable`. Getting this wrong is the single most common SPA-behind-CDN bug — a cached `index.html` referencing deleted chunks gives a white screen after every deploy.
- CSP allowlist derived from the actual frontend code:
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` — `'unsafe-inline'` is an **infrastructure** limitation of static hosting (no per-request nonce), not an Angular limitation. Angular has supported `ngCspNonce`/`CSP_NONCE` since v16. Record it as such.
  - `font-src 'self' data: https://fonts.gstatic.com`
  - `img-src 'self' data: blob: https://cdn.lordsofholdfast.com https://i.ytimg.com https://cdn.discordapp.com`
  - `media-src 'self' https://cdn.lordsofholdfast.com`
  - `connect-src 'self' https://<ACCOUNT_ID>.r2.cloudflarestorage.com` ← **the presigned PUT target, not the CDN domain**
  - `frame-src https://www.youtube-nocookie.com https://www.youtube.com https://medal.tv`

### 1.4 Trust proxy — currently missing, breaks rate limiting

`main.ts` has a global `ThrottlerGuard` at 120 req/min/IP but no `trust proxy`. Behind Cloudflare → Caddy, **every request appears to come from the proxy**, so all users share one bucket. Fix by overriding the tracker (sidesteps hop-counting entirely):

```ts
protected async getTracker(req: Record<string, any>): Promise<string> {
  return req.headers['cf-connecting-ip'] ?? req.ip;
}
```

Never use `trust proxy: true` — it lets any client forge the IP your logs, bans, and limits use.

### 1.5 Other security fixes

- **Gate `/api/docs`.** Swagger is currently served unconditionally, including in production.
- **`/api/health` returns 200 even when the DB is down** — the compose healthcheck can't detect a DB outage. Split into `/health/live` (no deps, for Docker) and `/health/ready` (DB + Discord gateway, for the external monitor).
- ~~**Stop connecting as `root`.**~~ **DONE.** `mysql/init/01-app-users.sh` creates `lords_app` (DML only, used by the long-lived API) and `lords_migrate` (DDL, used only by the one-shot that exits before the API starts) on first boot. 13 behavioural checks confirm the boundary: `lords_app` is denied `CREATE`, `DROP`, `GRANT`, `mysql.user` and every other schema.

  Two traps worth recording. First, the script is **sourced**, not executed, by the mysql entrypoint — so a bare `set -euo pipefail` applies to the entrypoint's own shell, and `set -u` kills `docker_process_sql` (which tests `"$1"` with no args) at line 248. Init aborted there, MySQL started perfectly healthy, and *the accounts were silently absent*. Second, `docker-entrypoint-initdb.d` runs **only when the data directory is empty**, so changing `APP_DB_PASSWORD` in `.env` later does nothing to MySQL — rotation needs an explicit `ALTER USER`. Both are documented in `deploy/README.md`.
- `dist/` and `dist.root-owned/` are root-owned in the working tree and will break host-side builds. Irrelevant once CI builds images. **Still present** — removing them needs local root, so it is left for a human (`sudo rm -rf dist dist.root-owned`).

### 1.6 Bot single-instance guard

`RealDiscordGateway` is `onModuleInit` inside the API process. **Two API replicas = two gateway connections on one token = duplicate `GuildMemberAdd` → duplicate welcome DMs and role grants to real members.** Nothing currently enforces or documents the 1-replica constraint. Minimum viable guards:

- Loud comment in `docker-compose.prod.yml` explaining why replicas must stay at 1.
- **Stop-then-start deploys, not rolling** — rolling creates the same overlap transiently on *every* deploy. `client.destroy()` on SIGTERM is already wired; verify the orchestrator waits for it (`stop_grace_period`).
- Optional but cheap: `SELECT GET_LOCK('lords_bot', 0)` before `client.login()` so a second instance refuses to connect.

### 1.7 Outbox worker — retry classification

`discord-sync.worker.ts:355` retries **every** failure with no error-type discrimination, so a permanent 403 (mispositioned bot role) burns all 5 attempts pointlessly.

I checked the actual exposure: `BATCH_SIZE=20` per `TICK_MS=3000` caps throughput at ~6.7 req/s, and the backoff ladder is 5s/30s/2m/10m/30m. Worst realistic case — 576 jobs all 403ing — is ~2,880 invalid requests spread over 30+ minutes, comfortably under Discord's 10,000-per-10-minutes IP-ban threshold. **So this is not the emergency it looks like**, but treating permanent 4xx (`50013`, `50001`, `10007`, `10011`) as terminal-on-first-failure is a small change worth making before the first mass sync.

---

## Phase 2 — Accounts and DNS (human)

### 2.1 Cloudflare
- [ ] Create account, add `lordsofholdfast.com`.
- [ ] **Disable DNSSEC at the current registrar first**, then change nameservers to Cloudflare's. Changing NS with DNSSEC still active makes the domain unreachable. Re-enable inside Cloudflare once the zone shows Active. Don't mix old and new nameservers — that prevents activation.
- [ ] SSL/TLS mode → **Full (strict)**. Enable Always Use HTTPS, Automatic HTTPS Rewrites, Min TLS 1.2, **Authenticated Origin Pulls**.
- [ ] **Leave Bot Fight Mode OFF.** It runs outside the Ruleset Engine and *cannot* be skipped by WAF rules — it will challenge your API and OAuth POSTs with no free fix.
- [ ] Turn **off** Rocket Loader and Auto Minify (they mangle Angular bundles).
- [ ] Cache Rules: hashed assets → cache 1 month; `/` and `/index.html` → **bypass**; `/api/*` → bypass.

### 2.2 R2
- [ ] Create bucket `lords-media` and a second bucket `lords-backups`.
- [ ] Enable public access on `lords-media` → **connect custom domain `cdn.lordsofholdfast.com`**. Do *not* use the `r2.dev` subdomain — Cloudflare documents it as rate-limited and development-only.
- [ ] CORS policy on `lords-media` — **mandatory** for browser presigned PUTs, which fail without it even though the URL is valid:
  ```json
  [{ "AllowedOrigins": ["https://lordsofholdfast.com"],
     "AllowedMethods": ["GET","PUT"],
     "AllowedHeaders": ["content-type"],
     "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
  ```
- [ ] Create an **Object Read & Write** API token scoped to `lords-media`; a separate one for `lords-backups`. **The Secret Access Key is shown exactly once.** New keys can take up to a minute to propagate globally.

### 2.3 DNS records
| Name | Type | Value | Proxy |
|---|---|---|---|
| `lordsofholdfast.com` | A | VPS IPv4 | 🟠 Proxied |
| `www` | CNAME | `lordsofholdfast.com` | 🟠 Proxied |
| `cdn` | — | (created automatically by the R2 custom-domain binding) | 🟠 |

Optional: pre-renew the `.com` before **1 November 2026** to lock the current wholesale rate — Verisign raises it to $10.97 that day, and you can renew up to ~9 years ahead.

---

## Phase 3 — Server build (human, ~45 min)

Order VPS-1 with **Debian 13**, then:

1. **Benchmark immediately and be willing to re-roll.** OVH's CPU is a host lottery: Geekbench 6 single-core spans ~700–1600 on *identical* SKUs. The "Intel Haswell" string is a QEMU mask, not the silicon, and the reported clock is meaningless. If you land badly, destroy and recreate to re-roll the host.
2. `adduser deploy`, add to `sudo`, copy SSH keys, **verify login from a second terminal before locking root out**.
3. SSH hardening drop-in at `/etc/ssh/sshd_config.d/99-hardening.conf`: `PermitRootLogin no`, `PasswordAuthentication no`, `MaxAuthTries 3`, `AllowUsers deploy`. (Skip the port change — it's log hygiene, not a control. If you do it anyway, pick a port **below 1024**; 2222 is unprivileged and any local user could bind it if sshd stops.)
4. `ufw`: default deny in, allow 22/80/443 **tcp only**. Then verify **from off-box**: `nmap -Pn -p- <ip>` should show only 22/80/443.
5. Docker from the official repo (deb822 `.sources` format now, not `.list`). **Set log rotation in `/etc/docker/daemon.json`** — json-file defaults to *unlimited* and rotation only happens when both `max-size` and `max-file` are set. Values must be quoted strings. This is the classic 40 GB disk-filler.
6. 2 GB swapfile, `vm.swappiness=10`.
7. `unattended-upgrades` with `Automatic-Reboot "true"` at 04:30. Safe only because every service has `restart: unless-stopped` — **verify that's true after the compose restructure.**
8. **`apt install qemu-guest-agent`** — without it OVH's snapshots are crash-consistent, which matters for MySQL.
9. **OVH Edge Network Firewall: either author rules carefully or leave it empty.** It's stateless, IPv4-only, 20 rules max, and is **force-enabled during a detected DDoS and cannot be disabled until the attack ends**. Rules that omit established/return TCP will break legitimate traffic exactly when you can't turn them off. It also doesn't see intra-OVH traffic — keep ufw regardless.
10. ~~`install -m 0600 -o deploy` the `.env`.~~ **DONE — automated as `deploy/bootstrap.sh`**, which is idempotent and re-runnable. It syncs the helper scripts to `~/bin`, installs rclone without root, generates all five secrets on the box with `openssl rand` (hex throughout, including `JWT_SECRET` — the DB passwords get interpolated into single-quoted SQL literals by the initdb script, where base64's `/` and `+` are fine but a quote or backslash would not be, so hex sidesteps the whole question), writes a 0600 `.env`, installs the systemd user units, and reports exactly which values still need a human.

    It deliberately re-checks for `‹REQUIRED›` markers **separately from** `docker compose config`: compose only asserts that a `${VAR:?}` is non-empty, and placeholder text is non-empty, so a `.env` full of placeholders passes `compose config` and then fails at runtime as an invalid Discord client or a 401 from R2.

---

## Phase 4 — CI/CD (my end + your secrets)

Both repos are **private**, so GHCR images are private and the VPS needs a token to pull.

- Backend workflow: build `--target prod` → push `ghcr.io/amitoj02/lords-api:<sha>` + `:latest`.
- Frontend repo gets its own workflow → `ghcr.io/amitoj02/lords-web:<sha>`. This removes the `context: ../lords-regiment-dashboard` relative path, which works locally but not on a server checkout.
- Prod compose references **images, not build contexts**.
- Deploy job SSHes in and runs `pull` + `up -d --wait`.

**You provide, as GitHub Environment secrets on a protected `production` environment:** `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `GHCR_TOKEN` (a PAT with `read:packages`).

> ⚠️ **Corrected at execution time.** A protected environment with *required reviewers* is not available on a **private repo on the GitHub Free plan** — the API rejects it with `Failed to create the environment protection rule. Please ensure the billing plan supports the required reviewers protection rule.` The `production` environment itself works fine and still scopes the secrets; only the approval gate is paywalled.
>
> The gate is instead a **`workflow_dispatch`-only deploy workflow**, which gives the same guarantee for free: merging publishes an image (touching nothing live), and production changes only when a human runs the workflow. `GHCR_TOKEN` turned out not to be needed as a CI secret either — the box holds its own `docker login ghcr.io` credential, and CI never pulls.
>
> One workflow rolls **both** images and lives in the backend repo, which also discharges the lockstep requirement below by construction rather than by discipline.

Lock the deploy key down so a stolen CI credential can't get a shell:

```
command="/usr/local/bin/lords-deploy",no-agent-forwarding,no-port-forwarding,no-pty ssh-ed25519 AAAA... github-actions
```

**Cross-repo coupling:** frontend T-0062 carries an open regression risk — the ranks/medals wiring, decision DM, and audit diff consume backend endpoints that must ship together. Deploy both repos in lockstep for the first release.

---

## Phase 5 — First deploy and smoke test

Backups **before** the bot goes anywhere near the live guild:

- `mysqldump --single-transaction --quick` → zstd → rclone to `r2:lords-backups`, on a systemd timer (better logging and `Persistent=true` beats cron).
- Fail loudly on a suspiciously small dump — that's how you catch an auth failure that still exits 0.
- **Run the restore drill once and record the wall-clock time.** That number is your RTO. A backup you have not restored is a hypothesis.
- Better Stack free (10 monitors/heartbeats combined) → point a **heartbeat** at the backup timer, so you're alerted when the job *doesn't* run. Alerts into a `#ops-alerts` Discord webhook.

Go-live gate:
- [ ] `https://lordsofholdfast.com` serves the SPA; `/api/health` returns `ok`.
- [ ] Real Discord sign-in → back as the `OWNER_DISCORD_ID` account.
- [ ] Roster loads; award a medal round-trips.
- [ ] **Upload an avatar** — this exercises presign → CORS → PUT → `cdn.` serving in one shot. The most likely thing to break.
- [ ] Deploy twice in a row and hard-refresh — catches the cached-`index.html` white-screen bug.

---

## Phase 6 — Discord bot into the 576-member guild

**You're admin, not owner** — so two steps need the server owner, and the social rollout needs officer buy-in *before* the bot exists.

### 6.1 Good news on the paperwork

As of **10 June 2026** the privileged-intent review threshold moved from 100 servers to **10,000 unique reachable users**. At 576 you're ~5% of it. App verification is a separate thing, triggered at 100 *servers*. **A single-guild 576-member bot needs neither** — toggle SERVER MEMBERS INTENT in the portal and go.

### 6.2 Two corrections to `DISCORD_GOLIVE.md`

1. **`permissions=268437504` omits `VIEW_CHANNEL` (1024).** Should be **`268438528`**. But — and this is the part that matters — **bumping the integer does *not* fix `50001 Missing Access` on a private channel.** Channel overwrites are applied *after* guild-level base permissions and supersede them. The actual fix is a **channel-level permission overwrite** granting the bot's role View Channel + Send Messages on each routed channel. This repo routes to enlistment, audit-log, and event-announcement channels — in a regiment server those are typically staff-only, so this *will* bite.
2. **Exclude managed roles from the sync mapping.** Booster roles, bot roles, and integration roles can never be assigned by a bot — regardless of position, even if the bot owns the guild. Filter proactively on `role.managed === true`; don't branch on error `50028`, which is only verified for the delete path and doubles as a generic "invalid role."

### 6.3 Rollout ladder — order matters

1. **Staging guild first.** Private test guild, replicate the role ladder by name and position, run the full sync. Free, and catches hierarchy bugs before any of the 576 see anything. Also test: whether `MANAGE_ROLES` works with "Require 2FA for moderation actions" enabled, and whether re-inviting with a bigger integer updates permissions in place.
2. **Invite to production with `permissions=0`.** A read-only role-sync bot genuinely needs zero permission bits — reading members is granted by the *intent*, not a permission. Let it connect, read, and compute diffs while writing nothing. Run for days. Compare `membersVisible` against 576.
3. **Confine it.** Create `#bot-lab`; deny the bot's role View Channel at the category level everywhere else.
4. **Position the role** directly beneath the owner/admin role, above all mapped rank roles. Verify `botRolePosition` exceeds every mapped role — and **alert on it**, don't just display it. Any admin who later creates a role above the bot silently breaks sync for it.
5. **Grant `MANAGE_ROLES` (268435456).** Run **dry-run first** — compute and log the diff without executing, and have a human read it. Then a capped real run on **3–5 volunteers across different ranks**.
6. **Widen gradually**, watching the audit log live.
7. **Only then** re-invite at `268438528` *and* add the channel-level overwrites.

**Keep `applyBanRoleOnBan` OFF** through the entire rollout. It's already owner-gated and double-checked at enqueue and drain time — good design, leave it alone.

### 6.4 Design constraint the plan must respect

On VPS restart the bot does a **fresh IDENTIFY, not a resume** — `session_id` was in memory. **Every event during downtime is permanently lost.** With unattended-upgrades auto-rebooting at 04:30, this is routine, not hypothetical: a member who joins during a reboot never fires `GuildMemberAdd` and never gets their join role.

**→ The sync must be reconciliation-based, with events as an optimization.** A periodic full-convergence pass catches what event handlers structurally cannot.

Related: `large_threshold` maxes at 250, so a 576-member guild **never** gets its full roster from `GUILD_CREATE`. Use `guild.members.fetch()` (gateway opcode 8) — one chunk, zero REST budget. Set an explicit `time` option and validate IDs as snowflakes first; a malformed non-snowflake in `members.fetch({ user: [...] })` *hangs until timeout* instead of erroring.

### 6.5 Social rollout (you're admin, not owner)

- **Brief the owner and officer staff privately, with the exact permission list, before the invite exists.** A new bot appearing unannounced with Manage Roles and a role dragged above the officer corps reads as a permissions grab or a compromise.
- **Announce before, not after.** Members seeing unexplained role changes will assume they were demoted.
- Lead with the negatives — they're what people actually want to hear, and with MessageContent and Presences disabled they're verifiably true: *"It cannot read your messages, cannot see your online status, cannot kick or ban."*
- Publicize the kill switch: `botEnabled` is already default-off and flippable from the admin UI. Say so publicly.
- **Never loop DMs over the roster.** `sendDirectMessage` exists; a bulk loop is functionally a spam campaign and Trust & Safety terminates apps for it. Keep DMs to single user-initiated events only.
- Set `X-Audit-Log-Reason` (1–512 chars) on every write. Audit entries **cannot be deleted or backdated** — you can't clean up after a bad sync. Tagging is the difference between "the bot spammed the log" and "the bot annotated the log."
- **Owner-only steps:** enabling "Require 2FA for moderation actions" in Server Settings, and enabling 2FA on the *application owner's* Discord account (2FA-gated actions fail with `60003`, sometimes misreported as "Privilege is too low").

---

## Phase 7 — Legal (a weekend, not a quarter)

You're a data controller for Discord IDs, usernames, avatars, in-game names, and application answers. OVH and Cloudflare are processors; Discord is the identity source.

- [ ] Privacy policy covering the Art. 13 items, **naming Cloudflare + OVH + Discord**. Link from the login button, the application form, and the Discord Developer Portal.
- [ ] **Working "Delete my account" button.** Discord's Developer ToS requires an *easily accessible* user-facing deletion mechanism — not just a policy paragraph. It satisfies GDPR Art. 17 simultaneously.
- [ ] Concrete retention periods **enforced by a scheduled job**: active members = duration of membership; ex-members anonymised 30–90 days after leaving; rejected applications 6–12 months; audit logs 12 months. A stated policy you don't execute is worse than none.
- [ ] Monitored `privacy@lordsofholdfast.com` alias (Cloudflare Email Routing, free). Commit to a one-month response.
- [ ] One-page processing register (table in the repo), scoped to the caught processing.
- [ ] **Drop the Discord `email` scope** unless you actually need it — it's arguably unnecessary collection under data minimisation, and there's no password reset to support.
- [ ] **No cookie banner needed** — a strictly-necessary first-party auth session cookie is exempt. Keep it that way: no analytics cookies, no embedded trackers.

**Email:** don't send from the box. OVH blocks port 25 by default on VPS, and UCEPROTECT Level 3 lists OVH's entire ASN — your IP can be blocklisted through no fault of your own. Discord webhooks cover announcements; a monitored alias covers the legal path. If you ever need programmatic sending, use Resend.

---

## Open questions to resolve at execution time

| # | Question | When |
|---|---|---|
| O1 | Month-to-month VPS-1 price (configurator wouldn't load for research) | Before ordering |
| O2 | Is Cloudflare's Customer DPA in force for a **free** account? You're about to name them as a processor | Before publishing the policy |
| O3 | Does OVH's DPA auto-apply to a low-cost VPS account? | Same |
| O4 | Does R2 need an active paid subscription to use the free tier? | Before promising $0 |
| ~~O5~~ | ~~Does `deploy.resources.limits.memory` apply under plain `docker compose up`?~~ **RESOLVED — yes.** Verified on the box (Compose v5.3.1): `docker inspect --format '{{.HostConfig.Memory}}' lords-db-1` → `1073741824`, and the container's own `/sys/fs/cgroup/memory.max` agrees. No `mem_limit` fallback needed. | ✅ |
| O6 | Effective `heap_size_limit` in the api container — cgroup detection can fail | Before prod traffic |
| O7 | Does R2 accept `STREAMING-UNSIGNED-PAYLOAD-TRAILER`? One scratch-bucket test. Mitigated by buffering image bodies + `WHEN_REQUIRED` | Before migrating |
| O8 | Does Cloudflare Free allow 3 Cache Rules? | Phase 2 |
| O9 | Live Cloudflare IP ranges for trusted-proxy config — pull from `cloudflare.com/ips-v4`, refresh monthly | Phase 3 |
| O10 | Does re-inviting with a bigger permissions integer update in place? The whole phased ladder depends on it | Staging guild |
| O11 | Is `MANAGE_ROLES` gated by "Require 2FA for moderation actions"? If yes, role sync fails entirely in a 2FA guild | Staging guild |
| O12 | Read the Discord Developer ToS + Policy **in a browser** — they 403 automated fetches, so all policy claims here are from search extracts | Before drafting the policy |

**Resolved during planning:** `synchronize: false` is hardcoded (`data-source.options.ts:27`) ✅ · outbox 4xx retries are bounded well under the IP-ban threshold ✅ · presigned PUTs are immune to the SDK checksum bug ✅ · no Discord verification or intent application needed at 576 members ✅

---

## Execution order

1. Phase 1 code changes on a branch, both repos, e2e green locally
2. Phase 0 decisions → **order the VPS early** (KYC risk) → benchmark, re-roll if bad
3. Phase 2 Cloudflare + R2 (independent of the VPS — do it in parallel)
4. Phase 3 server build
5. Phase 4 CI/CD, first image push
6. Phase 5 deploy + smoke test + **restore drill**
7. Phase 7 legal pages (must be live before public sign-in)
8. Phase 6 Discord — staging guild, then the 7-step ladder into production

Phases 1–5 are reversible. Phase 6 step 5 (first real role write) is the first irreversible action against 576 real people — everything before it is rehearsal.
