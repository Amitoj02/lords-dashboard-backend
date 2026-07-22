# Lords Dashboard — Backend API

REST API for the **Lords Regiment Dashboard** (a _Holdfast: Nations at War_ regiment management
dashboard). Built with **NestJS 11 + TypeORM + MySQL**, it backs the
[`lords-regiment-dashboard`](../lords-regiment-dashboard) Angular frontend.

**Live at [lordsofholdfast.com](https://lordsofholdfast.com) since 2026-07-20.** All feature modules
(members/roster, ranks & medals, events, gallery, applications, audit, settings) are built and wired,
and the Angular frontend consumes every one of them. The Quartermaster Discord bot — role sync,
join onboarding and channel announcements — is implemented in-process and ships behind two
independent switches (`DISCORD_BOT_MOCK` and the `botEnabled` database flag), so it stays dormant
until deliberately enabled.

### Documentation

| | |
|---|---|
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | **Start here.** Developer flow: local setup, testing, migrations, seeding rules, how code reaches production |
| [`SCHEMA.md`](./SCHEMA.md) | The complete normalized schema — 28 tables, enums, the authorization matrix, auth model |
| [`docs/INFRASTRUCTURE.md`](./docs/INFRASTRUCTURE.md) | What runs where, request/upload/deploy/backup paths, credential inventory |
| [`deploy/README.md`](./deploy/README.md) | Production runbook — deploy, roll back, restore, troubleshoot |
| [`project-plan/PRODUCTION_OVH_R2_PLAN.md`](./project-plan/PRODUCTION_OVH_R2_PLAN.md) | Why the production architecture is shaped the way it is |

## Tech stack

- **NestJS 11** (modular architecture, DI, guards, pipes, interceptors, filters)
- **TypeORM 0.3** + **mysql2**, snake_case naming strategy, migrations + seeders
- **MySQL 8** (runs as the `db` service in Docker Compose — no host database needed)
- **Passport JWT** + **Discord OAuth2** (authorization-code flow, with a swap-ready in-process mock)
- **class-validator / class-transformer**, **Swagger / OpenAPI**, **Joi** env validation
- **Jest** + **Supertest** (unit + e2e)
- **Docker Compose** — one unified stack (api + MySQL 8 + Angular web) with dev/prod image parity
- AES-256-GCM column encryption for Discord tokens & event passwords

## Prerequisites

- **Docker + Docker Compose** — that's it. No host Node or MySQL required.
- (Only if running the API on the host instead: Node `>=20`, npm `>=10`, and a reachable MySQL 8.)

## Getting started (Docker — recommended)

The whole product runs from one compose file in this repo. It builds the Angular
frontend from the sibling `../lords-regiment-dashboard` checkout.

```bash
docker compose up --build            # api + MySQL 8 + web, hot-reloading
docker compose exec api npm run db:setup   # first run only: create -> migrate -> seed
```

- Web (SPA): <http://localhost:4200>  ·  API: proxied at <http://localhost:4200/api>
- Swagger: <http://localhost:4200/api/docs>  ·  MySQL (host tools): `127.0.0.1:3307`

Discord is **mocked** out of the box (`DISCORD_MOCK=true`), so sign-in works with
no Discord app — click *Continue with Discord* and you are signed in as the seeded
Owner. See _Discord OAuth_ below to go live.

Run any tooling in the container: `docker compose exec api npm test`,
`docker compose exec api npm run lint`, `docker compose exec api npm run migration:run`.

### Running the API on the host (optional)

```bash
npm install
cp .env.example .env          # set DB_HOST=127.0.0.1, DB_PORT=3307 (the compose db)
docker compose up -d db       # or any reachable MySQL 8
npm run db:setup && npm run start:dev
```

`db:setup` is shorthand for `db:create && migration:run && seed`. All three are idempotent.

### Configuring Discord OAuth (going live)

Sign-in works immediately via the mock. To use a real Discord application:

1. Create an application at <https://discord.com/developers/applications>.
2. Under **OAuth2 → Redirects**, add your callback (dev: `http://localhost:4200/api/auth/discord/callback`;
   prod: `https://<your-domain>/api/auth/discord/callback`).
3. Set `DISCORD_MOCK=false` and copy the **Client ID** / **Client Secret** into your env
   (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`). No code changes are needed — the mock and the
   real client share one interface (`DiscordOAuthService`).
4. Optionally set `DISCORD_GUILD_ID` to your regiment's Discord server to record guild membership.
5. Generate secrets:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY (64 hex)
   ```

### Production

`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` builds slim images,
runs a one-shot migrate+seed init container (compiled JS, no ts-node), serves the SPA via nginx and
reverse-proxies `/api`. See [`project-plan/DEPLOY.md`](./project-plan/DEPLOY.md) for the full runbook.

## Authentication flow

`discord_identities` is the account record; a `members` row (roster) is created when a user applies,
**not** on every sign-in — so casual logins never pollute the roster.

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| GET | `/api/auth/discord` | public | Redirect to Discord with a CSRF `state` cookie |
| GET | `/api/auth/discord/callback` | public | Exchange code, upsert identity (+ link member), issue JWT |
| GET | `/api/auth/me` | JWT | The `CurrentUser` projection the frontend expects |
| POST | `/api/auth/logout` | JWT | Clear the session cookie |

The JWT is returned both as an `access_token` cookie and on the success-redirect query string for the
SPA handoff. Every route is guarded by a global `JwtAuthGuard`; `@Public()` opts routes out.

### Public presentation, legal documents and bulk role sync

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| GET | `/api/regiment` | public | Regiment profile **+ the `presentation` slice** (landing/login banners, quotes, overlay densities) |
| GET | `/api/regiment/documents` | public | Terms, privacy and community guidelines as Markdown; `body: null` = never edited |
| GET/PATCH | `/api/settings/presentation` | `manage_regiment_details` | Read/write the presentation slice; banners are submitted as storage **keys** |
| GET | `/api/settings/documents` | `manage_regiment_details` | The three documents plus who last saved each |
| PUT | `/api/settings/documents/:slug` | `manage_regiment_details` | Replace one document (`terms` \| `privacy` \| `guidelines`) |
| GET | `/api/discord/relink/:batchId` | `edit_ranks_medals` | Live progress / terminal summary of a bulk Discord role re-link |
| POST | `/api/discord/relink/:batchId/cancel` | `edit_ranks_medals` | Stop further expansion; already-applied members stay, run reports as partial |

The two anonymous routes exist *because* their consumers are logged-out surfaces: the sign-in page and
the legal pages are reached before authentication, so they cannot read anything behind a capability
gate. `manage_regiment_details` (T-0145) is a **publishing** right, deliberately separate from
`manage_settings` — see [`SCHEMA.md`](SCHEMA.md#role_permissions-authorization-matrix--source-of-truth).

Legal documents are stored as **Markdown and are not sanitised server-side**: the SPA renders them
through a strict escape-first renderer, which is the security boundary. Do not add a second,
divergent sanitiser here.

## NPM scripts

| Script | Purpose |
| ------ | ------- |
| `start:dev` | Run with watch mode |
| `build` / `start:prod` | Compile to `dist/` and run |
| `db:create` | Create the database if absent |
| `migration:generate -- src/database/migrations/<Name>` | Generate a migration from entity changes |
| `migration:run` / `migration:revert` | Apply / roll back migrations |
| `seed` | Run the idempotent seeders |
| `db:setup` | create + migrate + seed |
| `test` / `test:cov` | Unit tests (Jest) |
| `test:e2e` | End-to-end tests (Supertest) |
| `lint` / `format` | ESLint (`--fix`) / Prettier |

## Project structure

```
src/
├── main.ts, app.module.ts        # bootstrap + root module
├── config/                       # typed config + Joi env validation
├── common/                       # filters, interceptors, enums, crypto, dto
├── database/                     # data-source, migrations, seeds, scripts
├── auth/                         # Discord OAuth, JWT strategy, guards, decorators
├── regiments/ ranks/ medals/ members/ authz/
├── events/ gallery/ applications/ audit/ notifications/ discord/
                                  # entities for the full schema (see SCHEMA.md)
└── health/                       # liveness + DB probe
```

## Database

The complete, normalized (3NF) schema — 28 tables, enums, junctions, soft-deletes, the
authorization matrix and the auth/identity model — is documented in [`SCHEMA.md`](./SCHEMA.md).
Schema changes are made by editing entities and generating a migration; `synchronize` is always off.

## Testing

```bash
npm test          # unit (services, guards, strategy, crypto)
npm run test:e2e  # full Discord sign-in flow against the DB with a mocked Discord API
```

The e2e suite drives the real OAuth handshake (mocking only Discord's HTTP), proving a new sign-in
persists an encrypted identity record and a returning sign-in resolves the linked member.

## Roadmap

- Feature modules: members/roster, ranks & medals, events (+ RSVP, password reveal), gallery
  (+ moderation), applications (+ approve/decline/hold), audit log, settings, regiment stats.
- Capability-based authorization from the seeded `role_permissions` matrix.
- Dockerization (the app, MySQL, and the frontend as composable containers).
