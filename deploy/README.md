# Production runbook

Operating the Lords Regiment Dashboard on the OVH VPS. Companion to
[`project-plan/PRODUCTION_OVH_R2_PLAN.md`](../project-plan/PRODUCTION_OVH_R2_PLAN.md),
which explains *why* the architecture is what it is; this file is *how to run it*.

**Host:** OVH VPS-1 · Debian 13 · 2 vCore / 4 GB / 40 GB
**Access:** `ssh ovh-lords` (user `deploy`; root login and passwords are disabled)

The origin's IP is deliberately not written down in this repository. It lives in
the operator's `~/.ssh/config` under the `ovh-lords` host, and in the
`DEPLOY_HOST` secret of the `production` environment. This is hygiene, not
secrecy — anyone sweeping IPv4 can match the origin's TLS certificate back to
the domain — but there is no reason to publish it beside the account name and
the directory layout. Direct access is refused at the TLS layer anyway; see
[Authenticated Origin Pulls](#authenticated-origin-pulls-lda-h3).

---

## What is where

```
/home/deploy/
├── lords/                       the whole stack
│   ├── .env                     0600 — every secret. Never leaves the box.
│   ├── backup.env               0600 — backup tuning + heartbeat URL
│   ├── docker-compose.yml       base (shared with dev)
│   ├── docker-compose.prod.yml  prod overlay: GHCR images, limits, caddy
│   ├── Caddyfile                TLS, CSP, SPA/API routing
│   ├── mysql/conf.d/tuning.cnf  MySQL sized for a shared 4 GB box
│   ├── mysql/init/              first-boot creation of the two DB accounts
│   └── deploy/                  this directory, synced from the repo
├── bin/
│   ├── lords-deploy             ← the CI key's forced command
│   ├── lords-backup             ← run by the systemd timer
│   ├── lords-restore-drill
│   └── rclone
└── .config/
    ├── rclone/rclone.conf       0600 — R2 backup credentials
    └── systemd/user/            lords-backup.{service,timer}
```

Nothing here needs root. The `deploy` account owns the docker socket, and
`loginctl enable-linger deploy` lets its systemd user timers run with nobody
logged in. The only root-owned parts of the box are the Phase 3 basics —
docker, ufw, sshd, swap, unattended-upgrades, qemu-guest-agent.

---

## Before the first deploy

Eight values in `~/lords/.env` are placeholders. Everything else — including all
five secrets — was generated on the box by `bootstrap.sh` and is already real.

```bash
ssh ovh-lords
nano ~/lords/.env          # or vi
```

| Variable | Where it comes from |
|---|---|
| `ACME_EMAIL` | A mailbox you read. Let's Encrypt expiry notices. |
| `DISCORD_CLIENT_ID` | Discord Developer Portal → your app → OAuth2 |
| `DISCORD_CLIENT_SECRET` | Same page. Shown once. |
| `DISCORD_GUILD_ID` | Right-click the server → Copy Server ID (needs Developer Mode) |
| `OWNER_DISCORD_ID` | Your own Discord user id — claims you as Owner on first boot |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` | R2 → API token, **Object Read & Write**, scoped to `lords-media` |
| `S3_SECRET_ACCESS_KEY` | Same token. Shown exactly once. |

Then, still on the box:

```bash
# GHCR is private because both repos are. PAT needs read:packages.
echo '<PAT>' | docker login ghcr.io -u Amitoj02 --password-stdin

# Backup credentials — a DIFFERENT R2 token, scoped to lords-backups.
nano ~/.config/rclone/rclone.conf
rclone lsd r2:                       # should list the buckets
systemctl --user enable --now lords-backup.timer
```

And in Cloudflare DNS:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | the origin IPv4 (`DEPLOY_HOST`) | 🟠 Proxied |
| CNAME | `www` | `lordsofholdfast.com` | 🟠 Proxied |

Re-run `./deploy/bootstrap.sh` any time — it is idempotent and will tell you what
is still missing. It never overwrites `.env`, `backup.env` or `rclone.conf`.

> **Do not set `DISCORD_BOT_MOCK=false` yet.** Go live with the web app first.
> The bot's rollout into the 576-member guild is the plan's Phase 6, and its step
> 5 is the first irreversible action against real people.

---

## Deploying

Merging to `main` in either repo builds and publishes an image to GHCR. **That
changes nothing live.** Rolling it out is a deliberate manual act:

**GitHub → `lords-dashboard-backend` → Actions → "Deploy to production" → Run workflow**

Give it an `api_tag` and a `web_tag` (a commit sha from each repo, or `latest`).
One workflow rolls both, because the SPA and API share a contract and a frontend
deployed ahead of its backend is exactly the breakage to avoid.

> The intended gate was a protected environment with required reviewers, but that
> rule needs GitHub Pro on a private repo. `workflow_dispatch` buys the same
> guarantee for free: production only changes when a human clicks Run.

By hand, if CI is unavailable:

```bash
ssh ovh-lords
cd ~/lords
sed -i 's|^API_IMAGE_TAG=.*|API_IMAGE_TAG=<sha>|' .env
sed -i 's|^WEB_IMAGE_TAG=.*|WEB_IMAGE_TAG=<sha>|' .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### What a deploy actually does

1. `flock` — two deploys can never interleave.
2. Pins the tags into `.env`, so a reboot or a later manual `up -d` brings back
   the same images instead of drifting to `:latest`.
3. Pulls, then `up -d` — **stop-then-start, never rolling**. The Discord gateway
   runs in-process in the API, so two overlapping API containers would mean two
   gateway connections on one bot token, and duplicate role grants and welcome
   DMs to real members. `stop_grace_period: 30s` gives discord.js time to
   `destroy()` cleanly.
4. `migrate` runs first as a one-shot and the API waits for it to exit 0, so two
   processes can never be mid-migration at once.
5. Polls `/api/health/ready` from inside the container for up to 5 minutes.

### Rollback

Re-run the deploy workflow with the previous pair of tags.

**A failed deploy is deliberately not auto-rolled-back.** Migrations have already
run by the time readiness fails, and they are not reversible here — silently
reverting the image would leave an old binary against a new schema, which is
usually worse than staying down. The script prints the exact rollback command and
the last 60 lines of API logs; a human decides.

---

## Edge config is hand-synced (T-0215)

`lords-deploy` pins image tags, pulls and restarts. **It never writes the
`Caddyfile`, either compose file, or `.env`** — its allowlist contains no command
that could, which is the entire point of the forced command. Those files live
under `~/lords/` and are hand-synced.

So rolling T-0215 out through the deploy workflow ships the new `/api/seo/*` and
`/api/sitemap.xml` endpoints and **changes nothing a crawler can see.** The
crawler rewrite, the `/sitemap.xml` route and the www→apex 301 are all edge
config. Until someone SSHes in, Googlebot keeps receiving the same empty
`<app-root></app-root>` for every profile on the roster, and `/sitemap.xml` keeps
falling through to the SPA and returning `index.html` at 200 `text/html`.

Do the steps in this order. Step 1 before step 2 is not a preference: the caddy
service now declares `APEX_HOST: ${APEX_HOST:?…}`, so with the variable unset
compose **refuses to start caddy at all** — and caddy is the only container that
publishes ports, so the site goes dark rather than degrading. This is by far the
most likely way to break this rollout.

**1 — `APEX_HOST` into `.env`, first.**

```bash
ssh ovh-lords
cd ~/lords
grep -q '^APEX_HOST=' .env || printf 'APEX_HOST=lordsofholdfast.com\n' >> .env
```

Bare host: no scheme, no trailing slash, no `www.`. It is the redirect *target*,
which is why it cannot simply be `SITE_ADDRESS` — that stays the comma-joined
pair, because the certificate still has to cover both names.

**2 — sync BOTH files**, from a checkout at the tag you just deployed:

```bash
scp Caddyfile docker-compose.prod.yml ovh-lords:~/lords/
```

The compose file is not optional here. A container sees only the variables its
service block lists, so a Caddyfile-only sync leaves `{$APEX_HOST}` expanding to
empty — `@www host www.` then matches nothing and the redirect silently never
fires. www keeps serving a full duplicate of the site and there is no error
anywhere to tell you.

**3 — validate, then reload.** Both checks, in this order: `config` proves every
variable resolves, `validate` proves the Caddyfile itself adapts.

```bash
ssh ovh-lords && cd ~/lords
docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
  --entrypoint caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy
```

Only caddy is recreated, so this costs no API restart — no gateway reconnect, no
paused outbox.

**4 — verify.** Five checks, and the last is the one people skip:

```bash
GB='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
DB='Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'

# Real server-rendered HTML, not the empty shell.
curl -sS -A "$GB" https://lordsofholdfast.com/roster      | grep -c '<app-root'      # 0
curl -sS -A "$GB" https://lordsofholdfast.com/u/@<handle> | grep -o '<title>[^<]*'   # the member's name

# Every page the matcher now covers has a shell behind it (T-0293). A path
# listed in the Caddyfile with no route under /api/seo/* returns a JSON 404,
# which an unfurler renders as a broken preview — so this loop is what proves
# the API tag and the edge config are in step.
for p in /home /roster /events /gallery; do
  printf '%-10s ' "$p"
  curl -sS -A "$DB" "https://lordsofholdfast.com$p" | grep -o '<title>[^<]*'
done

# The sitemap is generated, and must not arrive as text/html.
curl -sSI https://lordsofholdfast.com/sitemap.xml | grep -i '^content-type'          # application/xml

# One canonical hostname.
curl -sSI https://www.lordsofholdfast.com/roster | grep -iE '^(HTTP/|location:)'     # 301 → apex

# ⚠️ AND humans must still get the app. A matcher that is too broad serves the
# crawler shell to everyone, and that looks perfectly fine until you read it.
# Check the paths the matcher GREW into, not just the one that was there before.
curl -sS https://lordsofholdfast.com/roster  | grep -c '<app-root'                   # 1
curl -sS https://lordsofholdfast.com/home    | grep -c '<app-root'                   # 1
curl -sS https://lordsofholdfast.com/gallery | grep -c '<app-root'                   # 1
```

A 404 on the profile check is not necessarily a failure. `/api/seo/u/:handle`
returns **honest status codes** — that is most of why it exists — and 404 is what
an Applicant, or a pending, banned, suspended or never-named member is supposed
to produce. Pick a handle you can already see signed-out. `/api/seo/events/:id`
behaves the same way. `/api/seo/gallery/:id` deliberately does NOT: it always
answers 200 with a `noindex` generic card, because a Discord unfurl of a 404
body renders as a broken preview rather than as "this one is gone".

**⚠️ `/` is deliberately NOT in the matcher, and putting it there is not a
one-line change.** It renders the same landing page as `/home`, but it is the one
path a Cloudflare Cache Rule covers — and Cloudflare honours `Vary` for
`Accept-Encoding` and nothing else. A UA-varying `/` therefore ends up with the
crawler document in the edge cache, served to every human who opens the front
page. `/home` is what `/` redirects to and what both surfaces declare canonical,
so nothing is lost by leaving the root alone. Change the Cloudflare rule first if
this ever has to move.

To see what a share really looks like before announcing it, paste the URL into
Discord's own tool at `https://discord.com/developers/embed-debugger?url=…`
(sign-in required). Discord caches an unfurl for roughly 30 minutes with no
purge, so append a throwaway query string when re-testing a URL you have already
pasted somewhere.

**5 — roll back** by restoring the previous pair of files. Nothing else moves.

```bash
scp <previous>/Caddyfile <previous>/docker-compose.prod.yml ovh-lords:~/lords/
ssh ovh-lords 'cd ~/lords && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy'
```

Leave `APEX_HOST` in `.env` afterwards — the old Caddyfile and compose file
simply never read it. Removing it while the new pair is live is what breaks.

### Sequence the crawl before you invite it

The public endpoints are throttled at 60–120 requests/minute, and the throttler
still keys on `req.ip` — which, behind Cloudflare, is always Caddy. **The whole
internet therefore shares one bucket, signed-in members included.** Nothing has
noticed because nothing crawls the site yet, and a Googlebot pass over a few
hundred profiles is precisely the traffic shape that drains that bucket and
starts 429ing real people mid-session.

So, before the sitemap goes anywhere near Search Console:

1. Enable [Authenticated Origin Pulls](#authenticated-origin-pulls-lda-h3) — the
   full procedure, including the ordering that avoids 520s, is below.
2. Set `TRUST_CF_CONNECTING_IP=true` in `.env` and `up -d api`, so the throttler
   keys on the real client address and a crawler gets a bucket of its own.
3. **Then** submit `https://lordsofholdfast.com/sitemap.xml`.

Step 2 is only sound after step 1: without AOP anyone can reach the origin
directly and forge `Cf-Connecting-Ip`, which converts a shared rate limit into no
rate limit at all.

---

## Backups

Nightly at 03:30 UTC (before the 04:30 unattended-upgrades reboot window), to
`r2:lords-backups`, keeping 30 days.

```bash
systemctl --user list-timers lords-backup.timer
systemctl --user start lords-backup.service      # run one now
journalctl --user -u lords-backup.service -n 50
rclone ls r2:lords-backups
```

The script refuses to upload a dump that is below an absolute size floor, or more
than 50% smaller than the largest stored backup, and it verifies the archive
decompresses and ends with mysqldump's completion marker. This matters because a
mysqldump auth failure exits non-zero *while still writing a short, perfectly
valid archive* — the kind of backup that looks fine for months and restores to
nothing.

Point a **Better Stack heartbeat** at `BACKUP_HEARTBEAT_URL` in `backup.env`. It
is pinged only on success, so the monitor alerts on its absence — which is the
only way to catch the timer silently not running at all.

> ### The seven nights nothing was backed up
>
> From go-live (2026-07-20) to 2026-07-27 **every run failed and the bucket stayed
> empty.** `rclone` lives in `~/bin`, and a systemd *user* unit inherits
> `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` — which does not
> include it. An interactive login shell does, because Debian's `~/.profile`
> prepends `~/bin`. So `rclone ls r2:lords-backups` typed by hand worked perfectly
> while the identical command under the timer was never found at all.
>
> Two things turned that into a week of silence rather than a first-night alarm:
> `|| fail "rclone upload failed"` reported bash's exit 127 as an upload error, so
> the log accused the network instead of the PATH; and `BACKUP_HEARTBEAT_URL` was
> blank, so nothing was watching for the success ping that never came.
>
> Both scripts now resolve rclone by absolute path and preflight the bucket
> *before* the dump, and the unit sets `Environment=PATH=%h/bin:...`. **Set the
> heartbeat** — the code fix closes this instance, the monitor is what catches the
> next one. The tell, if you ever see it again: the failure arrives less than a
> millisecond after `uploading`, far too fast for a network round-trip.

### Restore drill

```bash
~/bin/lords-restore-drill
```

Restores the newest backup into a scratch schema, diffs table and row counts
against live, drops the scratch schema, and prints the wall-clock time. **That
number is your RTO — record it.** Safe against production: it never writes to
`lords_dashboard`.

Run it once now, and again after any MySQL upgrade. A backup you have not
restored is a hypothesis.

**Last drill: 2026-07-27 — 31/31 tables, every row count exact, RTO 1–2s** on a
107 KB dump. That drill is also what caught `audit_logs` sitting in the row-count
list under a name the schema has never used (`audit_log_entries`), silently
skipped on every previous run. A stale name in that list now prints a `?` line
instead of passing over in silence.

### Real restore

```bash
ssh ovh-lords && cd ~/lords
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api
rclone copyto r2:lords-backups/<object> /tmp/restore.sql.zst
zstdcat /tmp/restore.sql.zst | docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml exec -T -e MYSQL_PWD="$(grep ^DB_PASSWORD= .env | cut -d= -f2-)" \
  db mysql -u root lords_dashboard
docker compose -f docker-compose.yml -f docker-compose.prod.yml start api
```

---

## Database accounts

Nothing that serves traffic connects as root.

| Account | Privileges | Used by |
|---|---|---|
| `lords_app` | `SELECT, INSERT, UPDATE, DELETE` on `lords_dashboard` | the long-lived API |
| `lords_migrate` | `ALL` on `lords_dashboard` | the one-shot `migrate`, which exits before the API starts |
| `root` | everything | healthcheck and `mysqldump` only |

An RCE in the API process therefore cannot `DROP` a table, read `mysql.user`, or
`GRANT` itself anything.

> ⚠️ These are created by `mysql/init/01-app-users.sh`, which MySQL runs **only
> when the data directory is empty** — the very first boot. Editing
> `APP_DB_PASSWORD` in `.env` afterwards does *not* change MySQL, and the API
> will simply fail to authenticate. To rotate:
>
> ```sql
> ALTER USER 'lords_app'@'%' IDENTIFIED BY '<new>';
> ```
> then update `.env` and `up -d`.

---

## Health and troubleshooting

```bash
ssh ovh-lords 'cd ~/lords && docker compose -f docker-compose.yml -f docker-compose.prod.yml ps'
ssh ovh-lords 'cd ~/lords && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api'
```

- `/api/health/live` — process is up. What Docker's healthcheck uses. No
  dependencies, so a DB blip cannot trigger a restart storm.
- `/api/health/ready` — DB and Discord gateway reachable. **This is what the
  external uptime monitor should watch.**

| Symptom | Look at |
|---|---|
| TLS fails / cert not issued | DNS A record present and Proxied? Cloudflare SSL mode **Full (strict)**? Port 80 reachable? |
| Images 404 or don't load | `S3_PUBLIC_BASE_URL` must be `https://cdn.lordsofholdfast.com`, **not** the R2 endpoint |
| Uploads fail in the browser | R2 CORS policy on `lords-media`, and `connect-src` in the Caddyfile must list the **signing** endpoint, not the CDN domain |
| White screen after deploy | Cached `index.html`. Caddy sends `no-store`; check the Cloudflare Cache Rule bypasses `/` and `/index.html` |
| Everyone shares one rate limit | The throttler reads `cf-connecting-ip`; check Caddy's `trusted_proxies` list is current (`cloudflare.com/ips-v4`) |
| API can't reach the DB | `APP_DB_PASSWORD` changed after first boot — see the rotation note above |

### Memory

4 GB total, and MySQL is deliberately kept small (512 MB buffer pool,
`temptable_max_ram` capped at 64 MB — the 8.4 default has a **1 GB floor**) so
the API is the safe survivor under pressure. Limits: `db 1g`, `api 512m`,
`caddy 128m`.

Do **not** add `NODE_OPTIONS=--max-old-space-size`. Node has been cgroup-aware
since v12.7.0 and V8 already defaults old-space to `clamp(limit/2, 256MB, 2GB)`.
Raising it to the commonly-advised 70–75% leaves too little for non-heap RSS and
makes OOM-kills *more* likely.

```bash
ssh ovh-lords 'docker stats --no-stream'
```

---

## The CI deploy key

The GitHub Actions key is bound to a forced command:

```
command="/home/deploy/bin/lords-deploy",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,restrict ssh-ed25519 AAAA... github-actions@lords-deploy
```

`$SSH_ORIGINAL_COMMAND` is **parsed against an allowlist, never executed**. A
stolen CI credential can roll images and nothing else — no shell, no `.env`, no
database. Verified: arbitrary commands, `.env` reads, shell requests, docker
escapes, command injection via the tag, and path traversal in the tag are all
rejected.

Accepted commands: `deploy api|web|both <tag...>`, `status`. Tags must match
`^([0-9a-f]{7,40}|latest)$`.

---

## Authenticated Origin Pulls (LDA-H3)

Locks the origin so it will only answer TLS handshakes that carry Cloudflare's
origin-pull client certificate — i.e. only Cloudflare can reach it. This is what
makes trusting `Cf-Connecting-Ip` for rate limiting sound (`TRUST_CF_CONNECTING_IP`),
because a client can no longer bypass Cloudflare to hit the origin directly and
forge that header.

It is an **opt-in overlay**: the committed Caddyfile ends the site block with
`import /etc/caddy/aop/*.caddy`, and compose mounts `./caddy/aop` there. That
directory ships **empty** (a non-matching glob is a no-op in Caddy), so a clone
serves normally. AOP turns on only when the box drops two files into it.

**⚠️ Order matters — get it backwards and every request 520s:**

1. **Cloudflare first.** Enable zone-level AOP so Cloudflare actually presents its
   client cert: dashboard → SSL/TLS → Origin Server → *Authenticated Origin Pulls*
   → on. (Or the API: `PUT /zones/<zone_id>/origin_tls_client_auth/settings`
   with `{"enabled": true}`.) On its own this is harmless — the origin ignores the
   cert until step 2. Verify Cloudflare is presenting it before proceeding
   (`mode request` + `caddy` debug log shows a client cert on the CF request).
2. **Origin second.** On the box, put Cloudflare's origin-pull CA and a client-auth
   snippet into `~/lords/caddy/aop/` (both git-ignored there), then recreate caddy:

   ```bash
   cd ~/lords && mkdir -p caddy/aop
   # Cloudflare's origin-pull CA (developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem):
   mv cloudflare-origin-pull-ca.pem caddy/aop/
   cat > caddy/aop/client-auth.caddy <<'SNIP'
   tls {
       client_auth {
           mode require_and_verify
           trust_pool file /etc/caddy/aop/cloudflare-origin-pull-ca.pem
       }
   }
   SNIP
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy
   ```

3. **Verify.** Through Cloudflare must still work; direct-to-origin must now be
   refused at the TLS layer:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://lordsofholdfast.com/api/health/live   # 200
   curl -sS --resolve lordsofholdfast.com:443:127.0.0.1 https://lordsofholdfast.com/api/health/live   # TLS handshake failure
   ```

4. Only once that passes, set `TRUST_CF_CONNECTING_IP=true` in `.env` and
   `up -d api`.

**Roll back** by emptying the overlay — `rm ~/lords/caddy/aop/client-auth.caddy`
and `up -d caddy`. Zone-level AOP uses Cloudflare's shared cert (CN
`origin-pull.cloudflare.net`), so this proves a request came via *some* Cloudflare
zone, not specifically ours — enough to close the direct-origin bypass. ACME
renewal is unaffected: it runs over HTTP-01 on `:80`, not the `:443` client-auth
policy.

---

## Rotating secrets

| Secret | Effect | How |
|---|---|---|
| `JWT_SECRET` | Everyone signs in again. Annoying, not destructive. | Edit `.env`, `up -d` |
| `APP_DB_PASSWORD` | See the `ALTER USER` note above — `.env` alone is not enough | SQL, then `.env`, then `up -d` |
| R2 tokens | Create the new token first; keys take up to a minute to propagate | R2 dashboard, then `.env` |
| `ENCRYPTION_KEY` | **ONE-WAY DOOR — see below** | Don't |

`ENCRYPTION_KEY` has no key id or version in the transformer, so there is no way
to decrypt existing ciphertext with a new key. Rotating it makes every stored
Discord refresh token and event password permanently unreadable. Back the current
value up somewhere you will still have in a year. Making this rotatable is
tracked as an open regression risk (T-0002#0).
