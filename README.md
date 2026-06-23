# Lords Dashboard — Backend API

REST API for the **Lords Regiment Dashboard** (a _Holdfast: Nations at War_ regiment management
dashboard). Built with **NestJS 11 + TypeORM + MySQL**, it backs the
[`lords-regiment-dashboard`](../lords-regiment-dashboard) Angular frontend.

> First milestone: project skeleton, the full normalized database schema (see [`SCHEMA.md`](./SCHEMA.md)),
> and **Sign in with Discord**. Feature modules (members, events, gallery, applications, audit,
> settings) are scaffolded in the schema and built on top of this foundation. The Discord _bot_ is out
> of scope — only its reported status is modelled.

## Tech stack

- **NestJS 11** (modular architecture, DI, guards, pipes, interceptors, filters)
- **TypeORM 0.3** + **mysql2**, snake_case naming strategy, migrations + seeders
- **MySQL 8** (XAMPP, `localhost:3306`)
- **Passport JWT** + **Discord OAuth2** (authorization-code flow)
- **class-validator / class-transformer**, **Swagger / OpenAPI**, **Joi** env validation
- **Jest** + **Supertest** (unit + e2e)
- AES-256-GCM column encryption for Discord tokens & event passwords

## Prerequisites

- Node `>=20` (developed on 24), npm `>=10`
- MySQL running on `localhost:3306` (XAMPP is fine; default `root` / empty password)

## Getting started

```bash
npm install
cp .env.example .env          # then fill in the Discord OAuth values
npm run db:setup              # create database -> run migrations -> seed
npm run start:dev             # http://localhost:3000/api  (Swagger at /api/docs)
```

`db:setup` is shorthand for `db:create && migration:run && seed`. All three are idempotent.

### Configuring Discord OAuth

1. Create an application at <https://discord.com/developers/applications>.
2. Under **OAuth2 → Redirects**, add `http://localhost:3000/api/auth/discord/callback`.
3. Copy the **Client ID** and **Client Secret** into `.env`
   (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`).
4. Optionally set `DISCORD_GUILD_ID` to your regiment's Discord server to record guild membership.
5. Generate secrets:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY (64 hex)
   ```

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
