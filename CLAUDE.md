# Lords Dashboard Backend — CLAUDE.md

## Project Overview
NestJS 11 + TypeORM + MySQL 8 REST API for the **Lords Regiment Dashboard** (Holdfast: Nations at War). It backs the Angular frontend: Discord OAuth2 sign-in → JWT, plus feature modules (members/roster, ranks & medals, events, gallery, applications, audit, settings) built on the normalized schema. Base URL `http://localhost:3000/api` (Swagger at `/api/docs`).

**Live in production at `https://lordsofholdfast.com` since 2026-07-20** (OVH VPS-1 + Cloudflare R2).

- `CONTRIBUTING.md` — the developer flow: local setup, testing (incl. the isolated e2e database), migrations, **the two-tier seeding rule**, cross-repo changes, and how code reaches production.
- `README.md` — tech stack, local setup (`npm run db:setup`, `start:dev`), auth flow, and route table.
- `SCHEMA.md` — the complete normalized (3NF) schema: 28 tables, enums, junctions, soft-deletes, the authorization matrix, and the auth/identity model.
- `docs/INFRASTRUCTURE.md` — what runs where, request/upload/deploy/backup paths, the credential inventory, and what survives `down -v`.
- `deploy/README.md` — the production runbook: deploy, roll back, restore, troubleshoot.

⚠️ **`seed:prod` runs on every production deploy.** Seeders are split into two tiers in `MainSeeder` — code-owned reference catalogs that refresh every time, and greenfield-only provisioning for anything an admin can edit. Adding a seeder means choosing a tier; the tests do not choose for you, and a tier-2 seeder will never run against the existing production database. See `CONTRIBUTING.md`.

## Companion Repository — Angular Frontend

This API is one half of a two-repo system. The **frontend that consumes it lives in a separate repository**. Keep API contracts (DTOs, the `GET /api/auth/me` shape, route paths) in sync with what that app expects — read it rather than guessing what the client needs.

| | |
|---|---|
| **Repo** | `lords-regiment-dashboard` |
| **Local path** | `../lords-regiment-dashboard` (abs: `/home/amitoj/Repositories/lords-regiment-dashboard`) |
| **Remote** | https://github.com/Amitoj02/lords-regiment-dashboard |
| **Stack** | Angular 19 (NgModule, `standalone: false`), Bootstrap 5.3, SCSS |
| **Dev server** | `http://localhost:4200` |

Key files to consult in the frontend repo:
- `src/app/core/models/` — TypeScript interfaces (`member`, `event`, `application`, `gallery`, `audit-log`) that mirror this API's response shapes.
- `src/app/core/services/` — **fully wired to this API**. All 13 services call `HttpClient` against `environment.apiBaseUrl` (the relative string `/api`, so the build is host-agnostic). The remaining `of(...)` calls are `catchError` fallbacks and one default storage policy, not stub data. Treat these as the authoritative statement of which endpoints and response shapes the client expects.
- `CLAUDE.md` — the frontend's own architecture, routing, and design-system notes.

The frontend's `AuthService` expects the `CurrentUser` projection from `GET /api/auth/me`; its OAuth callback route is `http://localhost:4200/auth/callback`. Both repos are grouped in the Blueframe workspace **`lords-dashboard`** — run `bf serve lords-dashboard` for combined project state and cross-repo drift.

<!-- blueframe:start -->
## Blueframe state protocol (managed — do not edit inside these markers)

This repo uses **Blueframe**. Its machine-readable project state lives in
`.blueframe/state.json` and is the single source of truth for task status.

**At the start of every session:** read `.blueframe/state.json`. Focus on
tasks with status `in_progress`, any open `questions`, pending `testPlan`
items, and `notesForNextSession`.

**Before ending any session,** reconcile `.blueframe/state.json`:
- Advance task `status` values to reflect what actually happened
  (`planned → in_progress → questionnaire → review → test → deploy_ready → deployed`;
  use `blocked`/`archived` as off-ramps). Work that has landed on the default
  branch is `deployed` (the Orbit Sun only absorbs `deployed` — don't leave
  merged work parked at `deploy_ready`).
- Add newly discovered work as new tasks. **Never reuse or collide task ids**
  (`T-####`); allocate the next unused number.
- Record anything you deliberately did NOT do in `skippedByClaude` (short
  plain-string notes — never objects).
- Update `testPlan` items and add `regressionRisk` entries (status `open`)
  for any shared code you touched.
- Re-check open `regressionRisk` entries: if new commits show a risk was
  addressed or retired, mark it `resolved` with `resolvedAt`, `resolvedBy`,
  and a short evidence `note`; otherwise leave it `open`. Link a fix task
  to the risk it retires via `resolvesRisk` (`"<taskId>#<riskIndex>"`).
- Set `lastSyncedCommit` to the current `git rev-parse HEAD` and
  `lastSyncedAt` to now.
- Write a concise `notesForNextSession` handoff to your future self.
- Append a `history` entry for each status change.

Give each task a Project-Manager hierarchy so the Orbit PM lens shows one
node per *feature*, not per task: `area` = module / bounded context (~3–8
per repo, never one repo-wide area; a monorepo package name is a fine
module), `feature` = the durable capability (reused across every task on it),
`subfeature` = a specific control. Cross-repo dependencies use
`"<repoKey>:T-####"` in `dependsOn`; bare ids are local to this repo.

Keep diffs **minimal** and preserve existing key order. Do not touch content
in CLAUDE.md outside these markers.
<!-- blueframe:end -->
