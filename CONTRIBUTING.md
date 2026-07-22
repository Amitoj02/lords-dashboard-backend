# Contributing

How work actually gets done on the Lords Regiment Dashboard: where code is
written, how it is tested, how it reaches production, and the handful of traps
that will cost you an afternoon if nobody warns you.

- **What exists and where** → [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md)
- **How to operate production** → [`deploy/README.md`](deploy/README.md)
- **Database schema** → [`SCHEMA.md`](SCHEMA.md)

---

## Two repositories, one product

| | Repo | Stack | Dev server |
|---|---|---|---|
| **API** | `lords-dashboard-backend` (this one) | NestJS 11 · TypeORM · MySQL 8.4 | `http://localhost:3000/api` |
| **SPA** | `lords-regiment-dashboard` | Angular 19 (NgModule, `standalone: false`) · Bootstrap 5.3 | `http://localhost:4200` |

They are expected to sit **side by side**:

```
~/Repositories/
├── lords-dashboard-backend/
└── lords-regiment-dashboard/
```

The backend's `docker-compose.yml` builds the `web` service from
`context: ../lords-regiment-dashboard`, so that layout is load-bearing for local
Docker runs. (CI and production don't rely on it — both build from GHCR images.)

**The SPA is fully wired to the API.** Every one of its 13 services calls
`HttpClient` against `environment.apiBaseUrl`, which is the relative string
`/api`. Remaining `of(...)` calls are `catchError` fallbacks, not stubs. Treat
`src/app/core/services/` and `src/app/core/models/` in the frontend as the
authoritative statement of what the client expects from this API — read them
rather than guessing.

---

## Getting started

```bash
git clone <backend>  && cd lords-dashboard-backend
git clone <frontend> ../lords-regiment-dashboard

npm ci
docker compose up -d db minio minio-init    # MySQL + object storage
npm run db:setup                            # create → migrate → seed
npm run start:dev                           # http://localhost:3000/api
```

Swagger is at `/api/docs` in development (and gated off in production).

**No `.env` is needed for local development.** `docker-compose.yml` carries
throwaway, Joi-valid dev secrets so a fresh `docker compose up` boots with no
hand-editing. `.env.example` documents every variable and is the template for a
production deploy, not a prerequisite for running locally.

Discord is **mocked** by default. `DISCORD_MOCK` auto-enables whenever
`DISCORD_CLIENT_ID` is empty, so the whole sign-in → JWT → `/auth/me` flow works
with no real Discord application. Sign in as a specific persona with
`/api/auth/discord?as=owner` (full admin) or `?as=recruit` (non-member, lands on
`/apply`).

---

## The day-to-day loop

```bash
git checkout main && git pull
git checkout -b feat/short-description

# ... write code ...

npm run lint          # eslint --fix
npm run format        # prettier --write
npm test              # unit
npm run test:e2e      # e2e (see the isolated-DB note below)

git commit
git push -u origin feat/short-description
gh pr create
```

CI runs lint → build → `db:setup` → unit → e2e, plus a Docker image build of
both services. All of it must be green before merge.

### Branch naming

`feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + a short kebab description.

### Commits

Conventional-commit prefix with a scope, then **why**, not what — the diff
already says what. The repo's history is the reference; recent commits explain
the reasoning, the alternatives rejected, and how the change was verified.

```
fix(seed,deploy): stop seed:prod clobbering owner config on every redeploy
feat(applications): enforce allowMercenaries across the intake flow
```

---

## Testing

| Command | What it covers |
|---|---|
| `npm test` | Unit — services, guards, DTO validation, schedulers |
| `npm run test:e2e` | Full HTTP round-trips against a real MySQL |
| `npm run test:cov` | Coverage |

**Run the e2e suite against an isolated database.** The suites share one MySQL
database and mutate single-tenant rows (permission matrix, bot settings), so
they run serially (`maxWorkers: 1`) and will fight with your dev data:

```bash
docker compose exec -T db mysql -uroot -p<devpw> \
  -e "DROP DATABASE IF EXISTS lords_dashboard_e2e;
      CREATE DATABASE lords_dashboard_e2e
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=3307 \
    DB_DATABASE=lords_dashboard_e2e DB_USERNAME=root DB_PASSWORD=<devpw> \
    DISCORD_MOCK=true DISCORD_BOT_MOCK=true OWNER_DISCORD_ID= \
    npm run migration:run && npm run seed && npm run test:e2e
```

`OWNER_DISCORD_ID=` **must be empty** — a non-empty value makes the seeder treat
the database as a real deploy and start with setup *incomplete*, which fails
tests that expect to land on the dashboard.

Write tests that pin the *reason* a thing exists, not just its current output. A
test named "guards use `=== false`, not truthiness" survives a well-meaning
refactor; `expect(result).toBe(true)` does not.

---

## Database changes

The schema is owned by **migrations**. `synchronize` is hardcoded `false` and
must stay that way.

```bash
# after editing an entity
npm run migration:generate -- src/database/migrations/DescriptiveName
npm run migration:run
npm run migration:show
```

> ⚠️ The 18 original migrations were **squashed into a single
> `InitialSchema`**. Any database that ran the old ones has
> `typeorm_migrations` rows pointing at files that no longer exist — it must be
> **dropped and recreated, not migrated forward.** If you see migration errors on
> an old local database, that is why. Drop it.

Never edit a migration that has run anywhere. Write a new one.

### Seeding — read this before adding a seeder

`seed:prod` runs on **every production deploy**, chained after migrations by the
compose `migrate` one-shot. "Idempotent" is therefore not enough: re-applying a
hardcoded default to a row an admin has since edited is idempotent *and*
destructive. `MainSeeder` splits seeders into two tiers, and **you must decide
which tier a new seeder belongs in — the tests will not decide for you.**

| Tier | Runs | Use for | Helper |
|---|---|---|---|
| **1 — reference catalog** | every deploy | Code-owned lookup data with immutable keys, where the seed file *is* the source of truth (accent tones, audit actions) | `ensure()` |
| **2 — greenfield provisioning** | first boot only | Anything an admin can edit afterwards (regiment, settings, ranks, medals, bot settings, owner) | gated in `MainSeeder` |

Role permissions are the deliberate exception: tier 1, but insert-only per row
via `provision()`, keyed on the `(role, capability)` **enum** pair. Enum members
cannot be renamed by a user, so a capability added in a later release still gets
its default grant on an existing database while admin edits survive.

That trick is **not** safe for ranks or medals — their natural keys (`name`,
`title`) *are* user-editable, so a renamed rank would not be found and would be
re-created as a duplicate. Hence the greenfield gate for those.

**Consequence:** a tier-2 seeder will *never* run against the existing
production database. To change data on a live deployment, write a migration.

---

## Cross-repo changes

When a change touches both repos — a new endpoint the SPA consumes, a changed
DTO shape — **the two must ship together.** The SPA and API share a contract,
and a frontend deployed ahead of its backend is the breakage to avoid.

1. Branch in both repos, ideally with matching branch names.
2. Open both PRs and cross-link them in the descriptions.
3. Merge them together.
4. Deploy both images in one run (the deploy workflow takes both tags).

Where you can, make the frontend **degrade safely** if the backend field is
absent — treat a missing field as the permissive default. That turns a
deploy-order mistake from an outage into a cosmetic glitch.

---

## Getting to production

```
merge to main  →  Actions builds + pushes to GHCR   (nothing live changes)
manual run     →  Actions → "Deploy to production"  (backend repo)
                  api_tag + web_tag = commit shas, or `latest`
```

Deploys are **manual on purpose**. Merging is safe and cheap; putting images in
front of real people is a separate, deliberate act. (The intended gate was a
protected environment with required reviewers, but that needs GitHub Pro on a
private repo — `workflow_dispatch` buys the same guarantee for free.)

One workflow rolls **both** images, and it lives in the backend repo. The
frontend repo has no deploy workflow by design.

**Rollback** is the same workflow with the previous pair of tags. A failed
deploy is deliberately *not* auto-rolled-back: migrations have already run by the
time readiness fails, so reverting the image alone would leave an old binary on a
new schema. The script prints the rollback command and 60 lines of API logs
instead.

---

## Traps

Things that have actually cost time here.

**`docker compose restart` does not re-read `.env`.** Use `docker compose up -d`
after changing environment variables, or you will debug a value that was never
loaded.

**`npm run build` on the host may fail on a root-owned `dist/`** — a leftover
from a container bind-mount. Either `sudo rm -rf dist dist.root-owned`, or build
inside the container: `docker compose exec api npm run build`.

**The mock owner persona is not the seeded owner** when `OWNER_DISCORD_ID` is
set. The mock signs in as snowflake `100000000000000001`, but a real deploy binds
the Owner to the configured id. To test admin flows locally against such a
database, temporarily repoint `members.discord_identity_id` — and restore it
after.

**Two Discord switches, not one.** `DISCORD_BOT_MOCK=false` only makes the bot
*connect* (read-only). `botEnabled` — a database flag, default false, flippable
from the admin UI — controls whether anything is actually *enqueued*. The bot
writes nothing until both are set.

**The bot's `GuildMemberAdd` handler does not filter by guild.** If the bot is in
more than one guild, a join anywhere triggers onboarding against whatever
`DISCORD_GUILD_ID` is configured. Keep the bot in exactly one guild, or use a
separate Discord application for staging.

**Guard shape is load-bearing in the mercenary checks.** They read
`settings && settings.allowMercenaries === false`, never a truthiness check. A
settings object that *omits* the column must stay permissive; a truthiness check
would 403 every Mercenary submit/edit/approve regiment-wide. Four tests pin this.
Do not "simplify" them.

---

## Project state

This repo uses [**Blueframe**](https://github.com/Amitoj02/blueframe), an open-
source project-state tracker. Install it from that repository — you don't need it
to build or test this project, only to read and reconcile the task state below.

`.blueframe/state.json` is the machine-readable source of truth for task status,
open questions, test plans and regression risks.

- Read it at the start of a session — `in_progress` tasks, open `questions`,
  pending `testPlan` items, and `notesForNextSession`.
- Reconcile it before ending one: advance statuses, add newly discovered work
  with fresh task ids (never reuse a `T-####`), record what you deliberately
  skipped, and update `lastSyncedCommit`.
- Keep the file **ASCII-escaped** (`ensure_ascii`) or every em-dash line shows up
  as a spurious diff. `testPlan` status must be `pending`, `passed` or `failed`.

`bf serve lords-dashboard` gives combined state across both repos. The workspace
groups this repo with the SPA — see
[its CONTRIBUTING guide](https://github.com/Amitoj02/lords-regiment-dashboard/blob/main/CONTRIBUTING.md)
for the frontend half of the same flow.

The file is plain JSON, so you can read and edit it without installing anything;
`bf` is a convenience, not a gate. Full schema and CLI reference live in the
[Blueframe repository](https://github.com/Amitoj02/blueframe).
