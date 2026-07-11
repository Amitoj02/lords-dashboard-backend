# Lords Dashboard — Prioritized Roadmap (MVP-first, Docker-first)

> Re-prioritization of `PLAN.md` into shippable tiers, produced via `/bf-plan` on **2026-07-11**.
> The **machine-readable source of truth is `.blueframe/state.json`** in each repo; this file is the
> human-readable view. Task ids without a repo prefix are backend (`lords-dashboard-backend`);
> frontend ids are marked **FE** (`lords-regiment-dashboard`).

## Owner decisions (locked)

1. **MVP = the core dashboard.** The Discord **bot is deferred** to a post-MVP milestone.
2. **One unified `docker-compose`** lives in the **backend repo** and runs `api` + MySQL 8 `db` +
   `web` (the Angular app, built via context `../lords-regiment-dashboard`).
3. **Fully-containerized dev with dev/prod image parity** — a base `docker-compose.yml` +
   `docker-compose.override.yml` (dev: bind mounts, hot reload) + `docker-compose.prod.yml`
   (prod: built images). **XAMPP / local MySQL is removed entirely.** Host only needs Docker.

## Tiers (build strictly in this order)

### ⬛ TIER 0 — Docker-first foundation + shared plumbing *(MVP gate)*
The entry point: nothing else runs until the container stack and the cross-cutting guards exist.

| Task | Repo | What |
|------|------|------|
| **T-0009** | backend | Unified Docker Compose stack (api + MySQL 8 + web), multi-stage Dockerfile, dev override + prod compose, healthcheck-gated startup |
| **T-0030** | backend | Containerized DB bootstrap — `db` service + `db:setup` run inside the api container |
| **T-0031** | backend | Fully-containerized dev workflow — devcontainer + hot reload, all commands via `compose exec` |
| **T-0029** | backend | Purge XAMPP / local MySQL from `.env.example`, README, CLAUDE.md |
| **T-0006** | backend | CapabilitiesGuard + `@RequireCapability()` (reads `role_permissions`) **+ expose the caller's capabilities on `/auth/me`** so the UI gates correctly |
| **T-0007** | backend | Shared AuditService + interceptor (every mutation writes an `audit_log_entries` row) |
| **T-0008** | backend | CI on containers (lint → unit → e2e on a MySQL service → build the image) |
| **T-0013** FE | frontend | Docker-aware `environment.ts` + `proxy.conf` (SPA is same-origin with the api) |
| **T-0022** FE | frontend | Frontend Docker container (dev `ng serve` / prod nginx) — the `web` image T-0009 builds |

### 🟦 TIER 1 — MVP feature core
The minimum product: sign in, see the roster, run the recruitment loop, manage members.

| Task | Repo | What |
|------|------|------|
| **T-0010** | backend | MembersModule — roster + admin actions (rank/role/medal/suspend/ban) + GDPR |
| **T-0011** | backend | RanksModule — CRUD + reorder *(seed the canonical ladder — needs T-0026 Q1)* |
| **T-0012** | backend | MedalsModule — CRUD *(award-once vs repeatable — needs T-0026 Q2)* |
| **T-0013** | backend | Regiment profile + landing stats endpoints |
| **T-0014** | backend | ApplicationsModule — public intake → approve/decline/hold → promote to member |
| **T-0011** FE | frontend | Wire core MVP HTTP services (members / applications / ranks / medals / regiment) |
| **T-0012** FE | frontend | Real Discord OAuth2 → JWT (login, `/auth/callback`, interceptor, `/auth/me`) |
| **T-0023** FE | frontend | Member admin-action modal (rank/role/medal/suspend/ban/unban), gated by the `/auth/me` capabilities |
| **T-0026** FE | frontend | Guard the not-yet-wired surfaces (events/gallery/audit/settings) so the MVP ships **no stub data** |

*Gating questionnaires — now wired as hard blockers: backend **T-0026** blocks **T-0011/T-0012**
(rank ladder, medals); backend **T-0028** blocks **T-0013/T-0014** (recruitment-off, landing stats);
frontend **T-0015** + **T-0016** block **T-0011/T-0012** (model-shape, integration sequencing).*

### 🟩 TIER 2 — MVP GO-LIVE ⭐
| Task | Repo | What |
|------|------|------|
| **T-0032** | backend | Deploy the unified **prod** compose (TLS/reverse-proxy, secrets, DB volume + backup, smoke test) |

**→ The MVP ships here: real Discord sign-in, roster, and the apply→approve→member loop, live in Docker.**

### 🟨 TIER 3 — Post-MVP features
| Task | Repo | What |
|------|------|------|
| **T-0015** | backend | EventsModule — CRUD + RSVP + attendees + audited password reveal |
| **T-0016** | backend | GalleryModule — submit + moderation + likes |
| **T-0017** | backend | AuditModule — read-only ledger + CSV export |
| **T-0018** | backend | NotificationsModule — field dispatches |
| **T-0019** | backend | SettingsModule — config + permissions matrix editor + hazardous ops |
| **T-0025** FE | frontend | Wire remaining HTTP services (events / gallery / audit / notifications / settings) |
| **T-0017** FE | frontend | Admin settings panes + announcement composer + invite-Mercenary |
| **T-0014** FE | frontend | Unit/component test coverage |

### 🟧 TIER 4 — Discord bot milestone *(deferred from MVP)*
| Task | Repo | What |
|------|------|------|
| **T-0020** | backend | Bot foundation — `discord.js` in-process + new migration (`discord_bot_settings`, `discord_sync_jobs`) |
| **T-0021** | backend | Bot core sync engine (outbox) + control API |
| **T-0022** | backend | Bot onboarding automation + slash commands |
| **T-0024** FE | frontend | Discord bot admin UI (bot-status + Discord settings panes → `/discord` endpoints) |

*Gating questionnaire: backend **T-0027** (channel routing, join role, reaction-roles, ban↔sync, announce toggle).*

### 🟥 TIER 5 — Hardening & full go-live
| Task | Repo | What |
|------|------|------|
| **T-0025** | backend | Security review + cross-stack E2E (incl. bot) + re-deploy the prod compose with the bot enabled |

*Gating questionnaire: backend **T-0028** (recruitment-off behavior, trusted gallery, invite flow, hosting target, data migration).*

## Cross-repo dependency spine

- backend **T-0009** (unified compose) builds frontend **T-0022** (the `web` image).
- backend **T-0032** (MVP deploy) depends on frontend **T-0011 / T-0012 / T-0013 / T-0022 / T-0023**.
- backend **T-0025** (hardening) depends on frontend **T-0017 / T-0024 / T-0025** + the bot tasks.
- frontend **T-0011** (core HTTP) depends on backend **T-0010 / T-0011 / T-0012 / T-0013 / T-0014**.

## Already shipped (not re-planned)

- **Backend:** project skeleton, common infra + AES-256-GCM crypto, the full 28-table 3NF data model
  (entities + initial migration + 7 seeders), Discord OAuth2 + JWT auth (unit + e2e), health module.
- **Frontend:** scaffold, design system, shared component library, stub service layer, all
  public/onboarding/member/admin screens (stub-driven), responsive/mobile, dev tooling + CI,
  account-deletion (GDPR self-service), accessibility pass.

## Plan-integrity pass (folded into the tasks)

A 3-critic adversarial review (MVP-completeness · Docker/XAMPP · cross-repo) hardened the plan before
it was frozen. Resolved in-task:

- **Prod DB has a real migrate/seed path** — the slim prod image can't run the `ts-node`-based
  `db:setup`, so **T-0030** now owns a compiled-JS, `ts-node`-free migrate/seed run as a one-shot init
  service (api `depends_on: service_completed_successfully`).
- **`docker compose up` boots zero-config** — Joi requires a 64-hex `ENCRYPTION_KEY`; **T-0029** now
  provisions Joi-valid throwaway dev secrets and rewrites *all* env (auth/redirect/CORS/cookie) for the
  same-origin proxied topology, not just the DB block.
- **The MVP smoke test can actually pass** — Discord **production** OAuth config (portal redirect URI +
  prod env) moved from post-MVP T-0025 into **T-0032**.
- **No stub data at go-live** — new **FE T-0026** guards the deferred surfaces; **T-0032** verifies it.
- **Capability-gating is real** — **T-0006** exposes the caller's capabilities on `/auth/me`; **FE
  T-0023** gates on that array (not coarse role).
- **The `web` image builds off-machine** — **T-0008** (CI) and **T-0032** (deploy host) now check
  out/clone both repos so the sibling `../lords-regiment-dashboard` build context resolves.
- **Decisions gate the right work** — questionnaires **T-0026/T-0028** (backend) and **T-0016**
  (frontend) are now hard blockers on their MVP consumers.
